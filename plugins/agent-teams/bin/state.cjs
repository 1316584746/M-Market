"use strict";
/**
 * AgentTeams 的团队状态：一个团队 = 一个目录里的 team.json。
 *
 * 数据模型沿用原项目（dsh-agent-teams）：队长是隐含的（调用工具的那个 AI），成员是持久的，
 * 任务有状态、依赖和「尝试代次」（attempt / attemptId），信箱按收件人投递，团队先「待批准（staged）」再「运行（running）」。
 * 这里全部是纯逻辑，不碰模型也不碰文件系统以外的东西，方便测试；调度和成员的模型循环在 scheduler / runner。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const quality = require("./quality.cjs");

const CAPTAIN = "captain";
const USER = "user";
const SYSTEM = "system";
const EVIDENCE_FIELDS = ["verdict", "findings", "acceptanceResults", "commandsRun", "changedPaths"];
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const STATUSES = ["pending", "claimed", "in_progress", "completed", "failed", "cancelled"];
const MAX_MESSAGES = 2000;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,39}$/u;

class TeamError extends Error {}
const fail = m => {
  throw new TeamError(m);
};
const now = () => Date.now();
const rid = n => crypto.randomBytes(n).toString("hex");
const slug = s => String(s || "").trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "team";
const str = (v, max = 20000) => (typeof v === "string" ? v.slice(0, max) : v == null ? "" : String(v).slice(0, max));
const list = v => (Array.isArray(v) ? v : []);

const isTerminal = t => TERMINAL.has(t.status);

class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.teams = new Map();
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  // ───────── 持久化 ─────────

  file(id) {
    return path.join(this.dir, id, "team.json");
  }

  load() {
    for (const e of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        const t = JSON.parse(fs.readFileSync(this.file(e.name), "utf8"));
        if (t && t.id === e.name) {
          this.recover(t);
          this.teams.set(t.id, t);
        }
      } catch {
        /* 坏文件跳过，不让一个团队拖垮整个插件 */
      }
    }
  }

  /** 冷恢复：重启后没有任何运行中的成员，进行中的任务退回待办（作废旧尝试），成员置为空闲 */
  recover(t) {
    for (const m of t.members) if (m.status === "working") m.status = "idle";
    for (const k of t.tasks) {
      if (k.status === "claimed" || k.status === "in_progress") {
        k.status = "pending";
        k.attempt = (k.attempt || 0) + 1;
        delete k.attemptId;
        k.updatedAt = now();
      }
    }
  }

  save(t) {
    const f = this.file(t.id);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t, null, 2));
    fs.renameSync(tmp, f);
  }

  touch(t, event) {
    this.save(t);
    this.emit("changed", { teamId: t.id, event });
  }

  // ───────── 查询 ─────────

  all({ archived = false } = {}) {
    return [...this.teams.values()].filter(t => !!t.archivedAt === archived).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) {
    const t = this.teams.get(String(id || ""));
    if (!t) fail(`没有这个团队：${id}`);
    return t;
  }

  /** 工具没传 teamId 时：只有一个在用的团队就用它 */
  resolve(id) {
    if (id) return this.get(id);
    const live = this.all();
    if (live.length === 1) return live[0];
    if (!live.length) fail("还没有团队，先用 agent_teams_create 创建");
    fail(`有多个团队，请传 teamId：${live.map(t => t.id).join("、")}`);
  }

  member(t, name, { active = true } = {}) {
    const m = t.members.find(x => x.name === name);
    if (!m || (active && m.status === "removed")) fail(`团队里没有成员 ${name}`);
    return m;
  }

  task(t, id) {
    const k = t.tasks.find(x => x.id === id);
    if (!k) fail(`没有任务 ${id}`);
    return k;
  }

  activeMembers(t) {
    return t.members.filter(m => m.status !== "removed");
  }

  /** 依赖都已完成 */
  depsDone(t, k) {
    return k.dependencies.every(d => t.tasks.find(x => x.id === d)?.status === "completed");
  }

  /** 依赖里有已失败 / 已取消的：这个任务永远等不到，要队长处理 */
  blockedBy(t, k) {
    return k.dependencies.filter(d => {
      const s = t.tasks.find(x => x.id === d)?.status;
      return s === "failed" || s === "cancelled";
    });
  }

  ready(t, k) {
    return k.status === "pending" && !k.reassigning && this.depsDone(t, k);
  }

  // ───────── 计划校验 ─────────

  /** 依赖可以写任务 id（t1）、本次计划里的 ref / 标题、或序号（从 1 开始） */
  resolveDeps(raw, inputs, idOf, selfIndex) {
    const out = [];
    for (const d of list(raw)) {
      let id;
      if (typeof d === "number") id = idOf[d - 1];
      else {
        const s = String(d).trim();
        const byRef = inputs.findIndex(x => x && x.ref && String(x.ref) === s);
        const bySubject = inputs.findIndex(x => x && String(x.subject).trim() === s);
        id = idOf.includes(s) ? s : byRef >= 0 ? idOf[byRef] : bySubject >= 0 ? idOf[bySubject] : undefined;
      }
      if (!id) fail(`找不到依赖的任务：${d}`);
      if (id === idOf[selfIndex]) fail(`任务不能依赖它自己：${d}`);
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /** 用户目标清单（质量门的 coverage 用）：每条应该被至少一个任务的 coverage_of 覆盖 */
  goalItems(input) {
    const v = input?.goal_items ?? input?.goalItems;
    return v === undefined ? undefined : list(v).map(x => str(x, 500).trim()).filter(Boolean).slice(0, 50);
  }

  policy(input) {
    const n = Number(input?.max_repair_attempts ?? input?.maxRepairAttempts);
    return Number.isFinite(n) && n >= 0 ? { maxRepairAttempts: Math.min(Math.floor(n), 10) } : undefined;
  }

  assertAcyclic(tasks) {
    const byId = new Map(tasks.map(k => [k.id, k]));
    const state = new Map();
    const visit = id => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) fail(`任务依赖成环，涉及 ${id}`);
      state.set(id, 1);
      for (const d of byId.get(id)?.dependencies || []) visit(d);
      state.set(id, 2);
    };
    for (const k of tasks) visit(k.id);
  }

  normalizeMember(raw, existing) {
    const name = str(raw?.name, 80).trim();
    if (!NAME_RE.test(name)) fail(`成员名不合法（字母 / 数字 / _ . -，最长 40）：${name}`);
    if (name.toLowerCase() === CAPTAIN || name.toLowerCase() === USER) fail(`成员名不能叫 ${name}`);
    const base = existing || { name, joinedAt: now(), status: "idle", usage: { input: 0, output: 0, calls: 0 } };
    return {
      ...base,
      role: raw?.role !== undefined ? str(raw.role, 200) : base.role,
      executionPrompt: raw?.prompt !== undefined || raw?.executionPrompt !== undefined ? str(raw.prompt ?? raw.executionPrompt, 8000) : base.executionPrompt,
      provider: raw?.provider !== undefined ? str(raw.provider, 80) || undefined : base.provider,
      model: raw?.model !== undefined ? str(raw.model, 120) || undefined : base.model,
      toolPolicy: raw?.toolPolicy === "readonly" || raw?.toolPolicy === "full" ? raw.toolPolicy : base.toolPolicy,
    };
  }

  buildTasks(inputs, memberNames, startSeq = 0, existingTasks = []) {
    const idOf = inputs.map((_, i) => `t${startSeq + i + 1}`);
    const known = new Set([...existingTasks.map(k => k.id), ...idOf]);
    const tasks = inputs.map((raw, i) => {
      const subject = str(raw?.subject, 200).trim();
      if (!subject) fail(`第 ${i + 1} 个任务缺少 subject`);
      const assignee = raw?.assignee ? str(raw.assignee, 80) : undefined;
      if (assignee && assignee !== CAPTAIN && !memberNames.has(assignee)) fail(`任务「${subject}」指派给了不存在的成员 ${assignee}`);
      const resolved = [];
      for (const d of list(raw?.dependencies)) {
        const s = typeof d === "string" ? d.trim() : "";
        const old = s && (existingTasks.find(k => k.id === s) || existingTasks.find(k => k.subject === s));
        if (old) resolved.push(old.id);
        else resolved.push(...this.resolveDeps([d], inputs, idOf, i));
      }
      for (const d of resolved) if (!known.has(d)) fail(`找不到依赖的任务：${d}`);
      // 评审哪个任务：任务 id / 同一份计划里的 ref、标题或序号
      const rv = raw?.reviewed_task ?? raw?.reviewedTask ?? raw?.reviewedTaskId;
      let reviewedTaskId;
      if (rv !== undefined && rv !== null && rv !== "") {
        const sv = String(rv).trim();
        const old = typeof rv === "number" ? undefined : existingTasks.find(k => k.id === sv) || existingTasks.find(k => k.subject === sv);
        reviewedTaskId = old ? old.id : this.resolveDeps([rv], inputs, idOf, i)[0];
        if (reviewedTaskId && !resolved.includes(reviewedTaskId)) resolved.push(reviewedTaskId);
      }
      const ids = list(raw?.sourceFindingIds).map(x => str(x, 40));
      const t0 = now();
      return {
        id: idOf[i],
        subject,
        description: raw?.description !== undefined ? str(raw.description, 20000) : undefined,
        status: "pending",
        assignee,
        dependencies: [...new Set(resolved)],
        ...quality.normalizeContract(raw),
        reviewedTaskId,
        sourceTaskId: raw?.sourceTaskId ? str(raw.sourceTaskId, 40) : undefined,
        rootId: raw?.rootId ? str(raw.rootId, 40) : undefined,
        sourceFindingIds: ids.length ? ids : undefined,
        attempt: 0,
        createdAt: t0,
        updatedAt: t0,
      };
    });
    // 质量门：补默认值，再检查合同（评审要有评审对象、写类任务要有范围和验收……）
    const all = [...existingTasks, ...tasks];
    for (const k of tasks) {
      quality.defaultsFor(k, all);
      try {
        quality.validateContract(k, all);
      } catch (e) {
        fail(e.message);
      }
    }
    return tasks;
  }

  // ───────── 团队生命周期 ─────────

  create(input) {
    const name = str(input?.name, 120).trim();
    if (!name) fail("团队需要名字（name）");
    let id = slug(name);
    if (this.teams.has(id)) {
      const base = id;
      let n = 2;
      while (this.teams.has(`${base}-${n}`)) n++;
      id = `${base}-${n}`;
    }
    const members = [];
    for (const raw of list(input?.members)) {
      const m = this.normalizeMember(raw);
      if (members.some(x => x.name === m.name)) fail(`成员名重复：${m.name}`);
      members.push(m);
    }
    const tasks = this.buildTasks(list(input?.tasks), new Set(members.map(m => m.name)));
    this.assertAcyclic(tasks);
    const t = {
      id,
      name,
      description: input?.description ? str(input.description, 4000) : undefined,
      createdAt: now(),
      members,
      tasks,
      taskSeq: tasks.length,
      messages: [],
      phase: input?.autoApprove ? "running" : "staged",
      planReviewState: input?.autoApprove ? undefined : "awaiting_review",
      approvedAt: input?.autoApprove ? now() : undefined,
      allowAll: false,
      goalItems: this.goalItems(input),
      qualityPolicy: this.policy(input),
    };
    this.teams.set(id, t);
    this.touch(t, "create");
    return t;
  }

  approve(id) {
    const t = this.get(id);
    if (t.phase !== "staged") fail("这个团队已经在运行了");
    if (!this.activeMembers(t).length) fail("还没有成员，先添加成员再批准");
    t.phase = "running";
    t.planReviewState = undefined;
    t.approvedAt = now();
    this.touch(t, "approve");
    return t;
  }

  /** 待批准时整体改方案：成员、任务、说明。同名成员保留原来的用量等记录 */
  editPlan(id, plan) {
    const t = this.get(id);
    if (t.phase !== "staged") fail("只有待批准的方案可以整体修改；运行中请用 add_member / create_task / amend_task");
    if (plan?.description !== undefined) t.description = str(plan.description, 4000) || undefined;
    if (plan?.goal_items !== undefined || plan?.goalItems !== undefined) t.goalItems = this.goalItems(plan);
    if (plan?.max_repair_attempts !== undefined || plan?.maxRepairAttempts !== undefined) t.qualityPolicy = this.policy(plan);
    if (plan?.members !== undefined) {
      const next = [];
      for (const raw of list(plan.members)) {
        const old = t.members.find(m => m.name === str(raw?.name, 80).trim());
        const m = this.normalizeMember(raw, old);
        if (next.some(x => x.name === m.name)) fail(`成员名重复：${m.name}`);
        next.push(m);
      }
      t.members = next;
    }
    if (plan?.tasks !== undefined) {
      const tasks = this.buildTasks(list(plan.tasks), new Set(t.members.map(m => m.name)));
      this.assertAcyclic(tasks);
      t.tasks = tasks;
      t.taskSeq = tasks.length;
    } else {
      // 只改了成员：指派给已删除成员的任务回到未指派
      const names = new Set(t.members.map(m => m.name));
      for (const k of t.tasks) if (k.assignee && k.assignee !== CAPTAIN && !names.has(k.assignee)) k.assignee = undefined;
    }
    t.planReviewState = "awaiting_review";
    this.touch(t, "edit_plan");
    return t;
  }

  halt(id) {
    const t = this.get(id);
    if (t.halted) return t;
    t.halted = true;
    t.haltedAt = now();
    for (const k of t.tasks) {
      if (isTerminal(k)) continue;
      this.revoke(t, k, "halt");
      k.status = "cancelled";
      k.haltCancelled = true;
      k.updatedAt = now();
    }
    this.touch(t, "halt");
    return t;
  }

  resume(id) {
    const t = this.get(id);
    t.halted = false;
    t.haltedAt = undefined;
    t.escalated = false;
    this.resolveEscalations(t);
    for (const k of t.tasks) {
      if (k.haltCancelled) {
        k.status = "pending";
        delete k.haltCancelled;
        k.updatedAt = now();
      }
    }
    this.touch(t, "resume");
    return t;
  }

  archive(id) {
    const t = this.get(id);
    for (const k of t.tasks) if (!isTerminal(k)) this.revoke(t, k, "archive");
    t.archivedAt = now();
    this.touch(t, "archive");
    return t;
  }

  /** 永久删除（界面里的「删除归档」）；archive 才是工具里的「删除」 */
  destroy(id) {
    const t = this.get(id);
    this.emit("destroyed", { teamId: t.id });
    this.teams.delete(t.id);
    fs.rmSync(path.join(this.dir, t.id), { recursive: true, force: true });
    this.emit("changed", { teamId: t.id, event: "destroy" });
  }

  setAllowAll(id, on) {
    const t = this.get(id);
    t.allowAll = !!on;
    this.touch(t, "allow_all");
    return t;
  }

  // ───────── 成员 ─────────

  addMember(id, raw) {
    const t = this.get(id);
    const name = str(raw?.name, 80).trim();
    const old = t.members.find(m => m.name === name);
    if (old && old.status !== "removed") fail(`成员名重复：${name}`);
    const m = this.normalizeMember(raw, old ? { ...old, status: "idle" } : undefined);
    if (old) Object.assign(old, m);
    else t.members.push(m);
    this.touch(t, "add_member");
    return old || m;
  }

  removeMember(id, name) {
    const t = this.get(id);
    const m = this.member(t, name);
    m.status = "removed";
    m.removedAt = now();
    for (const k of t.tasks) {
      if (k.assignee === name && !isTerminal(k)) {
        this.revoke(t, k, "member_removed");
        k.status = "pending";
        k.assignee = undefined;
        k.updatedAt = now();
      }
    }
    this.touch(t, "remove_member");
    return m;
  }

  setMemberStatus(t, name, status) {
    const m = t.members.find(x => x.name === name);
    if (m && m.status !== "removed") {
      m.status = status;
      this.save(t);
    }
  }

  addUsage(t, name, usage) {
    const m = t.members.find(x => x.name === name);
    if (!m) return;
    m.usage ||= { input: 0, output: 0, calls: 0 };
    m.usage.input += usage?.input || 0;
    m.usage.output += usage?.output || 0;
    m.usage.calls += 1;
    this.save(t);
  }

  // ───────── 任务 ─────────

  /** 作废当前尝试：代次 +1，旧的 attemptId 立刻失效，并通知在跑的成员中止 */
  revoke(t, k, reason) {
    const owner = k.assignee;
    const hadAttempt = k.status === "claimed" || k.status === "in_progress";
    if (hadAttempt) {
      k.attempt = (k.attempt || 0) + 1;
      delete k.attemptId;
      k.status = "pending";
    }
    if (owner && hadAttempt) this.emit("revoke", { teamId: t.id, taskId: k.id, member: owner, reason });
  }

  createTask(id, raw) {
    const t = this.get(id);
    if (t.halted) fail("团队已暂停，先 resume");
    const names = new Set(this.activeMembers(t).map(m => m.name));
    const [k] = this.buildTasks([raw], names, t.taskSeq, t.tasks);
    this.assertAcyclic([...t.tasks, k]);
    t.taskSeq += 1;
    t.tasks.push(k);
    this.resolveEscalations(t);
    this.touch(t, "create_task");
    return k;
  }

  /** 成员的写文件工具写成功后记一笔：这次尝试里真实改过哪些路径（尝试已经换代就不记） */
  recordWrite(id, taskId, attempt, rel) {
    const t = this.get(id);
    const k = t.tasks.find(x => x.id === taskId);
    if (!k || (k.attempt || 0) !== attempt || isTerminal(k)) return;
    const list2 = (k.writes ||= []);
    if (!list2.includes(rel) && list2.length < 500) {
      list2.push(rel);
      this.save(t);
    }
  }

  /** 队长（或用户）出手了：之前「自动修复停下来等人决定」的事算已经有人接手 */
  resolveEscalations(t) {
    for (const e of t.escalations || []) if (!e.resolved) e.resolved = now();
  }

  /** 评审没通过后的自动处理：修复 + 复审，或者升级给队长 */
  followUp(t, review) {
    const plan = quality.planFollowUp(t, review, { ...quality.DEFAULT_POLICY, ...(t.qualityPolicy || {}) });
    if (!plan) return;
    if (plan.escalate) {
      (t.escalations ||= []).push({ id: rid(3), taskId: review.id, reason: plan.escalate, at: now() });
      this.say(t, CAPTAIN, `【质量门升级】${plan.escalate}。自动修复循环已停止，请决定：改合同（amend_task）、建新任务（create_task）、改派，或告诉用户。`);
      return;
    }
    const names = new Set(this.activeMembers(t).map(m => m.name));
    for (const x of [plan.repair, plan.review]) if (x.assignee && !names.has(x.assignee)) x.assignee = undefined;
    let rp, rv;
    try {
      [rp, rv] = this.buildTasks([plan.repair, { ...plan.review, dependencies: [1], reviewed_task: 1 }], names, t.taskSeq, t.tasks);
    } catch (e) {
      (t.escalations ||= []).push({ id: rid(3), taskId: review.id, reason: `评审 ${review.id} 没通过，但没法自动生成修复任务：${e.message}`, at: now() });
      this.say(t, CAPTAIN, `【质量门升级】评审 ${review.id} 没通过，但没法自动生成修复任务（${e.message}）。请自己创建修复任务。`);
      return;
    }
    t.taskSeq += 2;
    t.tasks.push(rp, rv);
    review.supersededBy = rv.id;
    const rewired = [];
    for (const x of t.tasks) {
      if (isTerminal(x) || x.id === rv.id || x.id === rp.id || !x.dependencies.includes(review.id)) continue;
      x.dependencies = [...new Set(x.dependencies.map(d => (d === review.id ? rv.id : d)))];
      rewired.push(x.id);
    }
    this.say(t, CAPTAIN, `【质量门】评审 ${review.id} 没通过：已自动创建修复任务 ${rp.id}（${rp.assignee || "谁空闲谁领"}）和复审任务 ${rv.id}${rewired.length ? `；原来等 ${review.id} 的 ${rewired.join("、")} 改为等 ${rv.id}` : ""}。`);
  }

  /** 系统消息（不属于任何成员）：目前只发给队长 */
  say(t, to, content) {
    t.messages.push({ id: rid(4), from: SYSTEM, to, content: str(content, 20000), ts: now() });
    if (t.messages.length > MAX_MESSAGES) t.messages.splice(0, t.messages.length - MAX_MESSAGES);
  }

  reassignTask(id, taskId, assignee) {
    const t = this.get(id);
    const k = this.task(t, taskId);
    if (isTerminal(k)) fail(`任务 ${taskId} 已经是 ${k.status}，不能改派`);
    const to = assignee ? str(assignee, 80) : undefined;
    if (to && to !== CAPTAIN) this.member(t, to);
    this.revoke(t, k, "reassign");
    k.assignee = to;
    k.updatedAt = now();
    this.touch(t, "reassign_task");
    return k;
  }

  /** 成员 / 队长领任务。不传 taskId 就领第一个轮到自己的 */
  claimTask(id, who, taskId) {
    const t = this.get(id);
    if (t.phase !== "running") fail("团队还没批准，不能领任务");
    if (t.halted) fail("团队已暂停");
    if (who !== CAPTAIN) this.member(t, who);
    if (t.tasks.some(k => k.assignee === who && (k.status === "claimed" || k.status === "in_progress"))) fail("你手上还有没完成的任务，先 update_task 收尾");
    let k;
    if (taskId) {
      k = this.task(t, taskId);
      if (k.status !== "pending") fail(`任务 ${taskId} 现在是 ${k.status}，不能领`);
      if (k.assignee && k.assignee !== who) fail(`任务 ${taskId} 已指派给 ${k.assignee}`);
      if (!this.depsDone(t, k)) fail(`任务 ${taskId} 还在等依赖：${k.dependencies.filter(d => this.task(t, d).status !== "completed").join("、")}`);
      if (k.reassigning) fail(`任务 ${taskId} 正在交接`);
    } else {
      const mine = t.tasks.filter(x => this.ready(t, x));
      k = mine.find(x => x.assignee === who) || mine.find(x => !x.assignee);
      if (!k) fail("现在没有可领的任务（依赖未完成或都已有人）");
    }
    k.status = "claimed";
    k.assignee = who;
    k.attempt = (k.attempt || 0) + 1;
    k.attemptId = rid(4);
    for (const f of [...EVIDENCE_FIELDS, "writes"]) delete k[f]; // 上一次尝试留下的证据不算数
    k.updatedAt = now();
    this.touch(t, "claim_task");
    return k;
  }

  /**
   * args: { taskId, attemptId, status, output, verdict?, findings?, changed_paths?, acceptance_results?, commands_run? }
   * ctx.writes：这次尝试里插件的写文件工具真实写过的路径（质量门审计用）
   */
  updateTask(id, who, args, ctx = {}) {
    const { taskId, attemptId, status, output } = args;
    const t = this.get(id);
    const k = this.task(t, String(taskId || ""));
    if (!STATUSES.includes(status)) fail(`status 只能是 ${STATUSES.join(" / ")}`);
    if (isTerminal(k)) fail(`任务 ${k.id} 已经是 ${k.status}，不能再改`);
    if (who === CAPTAIN) {
      // 队长可以收尾、取消、退回，不需要 attemptId
      if (status === "claimed" || status === "in_progress") fail("队长不能把任务置为进行中，请用 claim_task");
      if (status === "pending" || status === "cancelled") this.revoke(t, k, "captain_update");
    } else {
      if (k.assignee !== who) fail(`任务 ${k.id} 不属于你`);
      if (!k.attemptId || attemptId !== k.attemptId) fail(`attemptId 已失效（任务被改派、重试或暂停过），请重新 claim_task：${k.id}`);
      if (status === "pending" || status === "claimed" || status === "cancelled") fail("成员只能把任务置为 in_progress / completed / failed");
      if (status === "in_progress" && k.status === "in_progress") fail("任务已经在进行中");
    }
    const text = output !== undefined ? str(output, 40000) : undefined;
    if ((status === "completed" || status === "failed") && !text && !k.output) fail("完成或失败时请在 output 里写结果（或失败原因）");
    // 质量门：成员提交带合同的任务时要交证据，不合格就不让过（队长手动收尾不受限，但会留下标记）
    let evidence = {};
    if (who === CAPTAIN) {
      if (status === "completed" && quality.isQuality(k)) k.forced = true;
    } else if (quality.isQuality(k) && (status === "completed" || status === "failed" || status === "in_progress")) {
      try {
        evidence = quality.checkCompletion(k, args, [...(k.writes || []), ...(ctx.writes || [])]).evidence;
      } catch (e) {
        fail(e.message);
      }
    }
    k.status = status;
    if (text !== undefined) k.output = text;
    Object.assign(k, evidence);
    if (isTerminal(k)) {
      delete k.attemptId;
      k.finishedAt = now();
      if (status === "completed" && quality.kindOf(k) === "review") {
        const r = t.tasks.find(x => x.id === k.reviewedTaskId);
        if (r) k.reviewedAttempt = r.attempt || 0;
      }
    }
    k.updatedAt = now();
    if (who === CAPTAIN) this.resolveEscalations(t);
    if (status === "failed" && who !== CAPTAIN) this.followUp(t, k);
    this.touch(t, "update_task");
    return k;
  }

  /** 队长改任务合同；正在执行的任务会被作废重来，原因和旧值留在 revisions 里 */
  amendTask(id, taskId, patch) {
    const t = this.get(id);
    const k = this.task(t, taskId);
    if (isTerminal(k)) fail(`任务 ${taskId} 已经是 ${k.status}，不能修订`);
    const reason = str(patch?.reason, 2000).trim();
    if (!reason) fail("修订任务需要写 reason（旧合同为什么不对）");
    const fields = {};
    const prev = {};
    const set = (name, val) => {
      prev[name] = k[name];
      fields[name] = val;
    };
    if (patch.subject !== undefined) set("subject", str(patch.subject, 200).trim() || fail("subject 不能为空"));
    if (patch.description !== undefined) set("description", str(patch.description, 20000));
    let contract;
    try {
      contract = quality.normalizeContract({ ...patch, kind: undefined });
    } catch (e) {
      fail(e.message);
    }
    for (const name of ["objective", "acceptance", "verify", "inScope", "outOfScope", "deliverables", "nonGoals", "coverageOf"]) if (name in contract) set(name, contract[name]);
    if (patch.dependencies !== undefined) {
      const deps = [];
      for (const d of list(patch.dependencies)) {
        const s = String(d).trim();
        const hit = t.tasks.find(x => x.id === s) || t.tasks.find(x => x.subject === s);
        if (!hit) fail(`找不到依赖的任务：${d}`);
        if (hit.id === k.id) fail("任务不能依赖它自己");
        if (!deps.includes(hit.id)) deps.push(hit.id);
      }
      set("dependencies", deps);
    }
    const changed = Object.keys(fields);
    if (!changed.length) fail("没有要修订的字段");
    const before = { dependencies: k.dependencies };
    Object.assign(k, fields);
    try {
      this.assertAcyclic(t.tasks);
      quality.validateContract(k, t.tasks);
    } catch (e) {
      for (const name of changed) {
        if (prev[name] === undefined) delete k[name];
        else k[name] = prev[name];
      }
      k.dependencies = before.dependencies;
      throw e;
    }
    (k.revisions ||= []).push({ at: now(), by: CAPTAIN, reason, fields: changed, previous: prev });
    this.revoke(t, k, "amend");
    this.resolveEscalations(t);
    k.updatedAt = now();
    this.touch(t, "amend_task");
    return k;
  }

  // ───────── 信箱 ─────────

  sendMessage(id, from, to, content, extra = {}) {
    const t = this.get(id);
    const text = str(content, 20000).trim();
    if (!text) fail("消息内容不能为空");
    const dest = str(to, 80);
    if (dest !== CAPTAIN && dest !== USER) this.member(t, dest);
    if (from !== CAPTAIN && from !== USER) this.member(t, from);
    if (dest === from) fail("不能给自己发消息");
    const msg = { id: rid(4), from, to: dest, content: text, ts: now(), taskId: extra.taskId, attemptId: extra.attemptId };
    t.messages.push(msg);
    if (t.messages.length > MAX_MESSAGES) t.messages.splice(0, t.messages.length - MAX_MESSAGES);
    this.touch(t, "message");
    return msg;
  }

  unread(t, who) {
    return t.messages.filter(m => m.to === who && !m.readAt);
  }

  /** 取走未读（标已读）；「user」不会被标记，由界面自己看 */
  takeUnread(id, who) {
    const t = this.get(id);
    const msgs = this.unread(t, who);
    if (msgs.length && who !== USER) {
      const ts = now();
      for (const m of msgs) m.readAt = ts;
      this.touch(t, "read");
    }
    return msgs;
  }

  // ───────── 汇总 ─────────

  progress(t) {
    const total = t.tasks.length;
    const count = s => t.tasks.filter(k => k.status === s).length;
    const done = count("completed");
    return { total, done, failed: count("failed"), cancelled: count("cancelled"), inProgress: count("claimed") + count("in_progress"), pending: count("pending"), finished: total > 0 && t.tasks.every(isTerminal) };
  }

  /** 队长和成员都看这份：团队、成员、任务、未读数 */
  summary(t, who) {
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      phase: t.phase,
      planReviewState: t.planReviewState,
      halted: !!t.halted,
      archived: !!t.archivedAt,
      progress: this.progress(t),
      members: t.members.filter(m => m.status !== "removed").map(m => ({
        name: m.name,
        role: m.role,
        status: m.status,
        model: m.model,
        provider: m.provider,
        toolPolicy: m.toolPolicy,
        currentTask: t.tasks.find(k => k.assignee === m.name && (k.status === "claimed" || k.status === "in_progress"))?.id,
        usage: m.usage,
        spawnError: m.spawnError,
      })),
      tasks: t.tasks.map(k => ({
        id: k.id,
        subject: k.subject,
        status: k.status,
        assignee: k.assignee,
        dependencies: k.dependencies,
        blockedBy: this.blockedBy(t, k),
        ready: this.ready(t, k),
        attempt: k.attempt,
        output: k.output,
        revisions: k.revisions ? k.revisions.length : undefined,
        ...this.contractView(k),
      })),
      goalItems: t.goalItems && t.goalItems.length ? t.goalItems : undefined,
      quality: quality.qualitySummary(t) || undefined,
      unreadFor: who ? this.unread(t, who).length : undefined,
    };
  }

  /** 任务上和质量门有关的字段（合同 + 证据）；没有的不出现 */
  contractView(k) {
    const o = {};
    for (const f of ["kind", "round", "objective", "inScope", "outOfScope", "acceptance", "verify", "deliverables", "nonGoals", "coverageOf", "reviewedTaskId", "sourceTaskId", "sourceFindingIds", "verdict", "findings", "changedPaths", "acceptanceResults", "commandsRun", "supersededBy", "forced"]) if (k[f] !== undefined) o[f] = k[f];
    return o;
  }
}

module.exports = { Store, TeamError, CAPTAIN, USER, SYSTEM, TERMINAL, STATUSES, isTerminal, slug };
