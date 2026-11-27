"use strict";
/**
 * 14 个协调工具，名字和原项目一致。队长（调用插件工具的 AI）拿到全部；成员只拿 MEMBER_TOOL_NAMES 里的 4 个。
 * 每个定义是 { name, description, inputSchema, readOnly, run({ store, who, teamId, args }) }，
 * 身份（who）由调用方绑定，模型自己填不了——成员不能冒充队长。
 */
const { CAPTAIN, isTerminal } = require("./state.cjs");

const TEAM_TOOL_NAMES = [
  "agent_teams_create", "agent_teams_approve", "agent_teams_edit_plan",
  "agent_teams_add_member", "agent_teams_remove_member", "agent_teams_create_task",
  "agent_teams_reassign_task", "agent_teams_claim_task", "agent_teams_update_task",
  "agent_teams_amend_task",
  "agent_teams_send_message", "agent_teams_status", "agent_teams_resume", "agent_teams_delete",
];
const MEMBER_TOOL_NAMES = ["agent_teams_claim_task", "agent_teams_update_task", "agent_teams_send_message", "agent_teams_status"];

const S = d => ({ type: "string", description: d });
const TEAM = { teamId: S("团队 id；只有一个团队时可省略") };
const MEMBER_PROPS = {
  name: S("成员名（字母 / 数字 / _ . -，最长 40）"),
  role: S("角色，例如 researcher / engineer / reviewer"),
  prompt: S("这个成员每次执行任务时额外遵守的提示词"),
  provider: S("可选：指定 M-Harness 里的提供方名（type 为 openai / openai-compat）"),
  model: S("可选：指定模型名"),
  toolPolicy: { type: "string", enum: ["full", "readonly"], description: "readonly = 只能读，不能写文件和执行命令" },
};
const LIST = d => ({ type: "array", items: { type: "string" }, description: d });
/** 质量门合同（可选）：带 kind 的任务完成时要交证据，不合格不让 completed */
const CONTRACT_PROPS = {
  kind: { type: "string", enum: ["work", "requirements", "implementation", "verification", "review", "repair", "integration"], description: "任务类型；不填 = work（普通任务，没有质量门）。implementation / repair 要 objective + in_scope + acceptance；verification 要 verify；review 要 reviewed_task（评审哪个任务）" },
  objective: S("这个任务要达成什么"),
  in_scope: LIST("允许改的路径：目录（src/）、文件、通配（docs/**/*.md）；写文件时就会被拦"),
  out_of_scope: LIST("禁止改的路径"),
  acceptance: LIST("验收标准，完成时要逐条交代结果"),
  verify: LIST("要跑的验证命令，完成时要交代每条的结果"),
  deliverables: LIST("交付物"),
  non_goals: LIST("明确不做的事"),
  coverage_of: LIST("这个任务覆盖了哪几条用户目标（对应团队的 goal_items）"),
  reviewed_task: S("评审哪个任务（kind=review）：任务 id / ref / 标题"),
};
const EVIDENCE_PROPS = {
  verdict: { type: "string", enum: ["pass", "needs_revision", "reject"], description: "review / requirements 任务的结论。不是 pass 时 status 要用 failed，并带 findings" },
  findings: { type: "array", items: { type: "object", properties: { id: S("稳定编号，如 SEC-001"), severity: { type: "string", enum: ["low", "medium", "high", "blocker"] }, file: S("文件"), line: { type: "integer" }, problem: S("问题"), required_fix: S("必须怎么改") }, required: ["severity", "problem"] }, description: "评审发现的问题" },
  changed_paths: LIST("implementation / repair 完成时改过的文件（相对工作区）"),
  acceptance_results: { type: "array", items: { type: "object", properties: { criterion: S("验收标准原文"), status: { type: "string", enum: ["passed", "failed"] }, evidence: S("依据") }, required: ["criterion", "status"] }, description: "逐条验收结果" },
  commands_run: { type: "array", items: { type: "object", properties: { command: S("命令原文"), status: { type: "string", enum: ["passed", "failed"] }, exit_code: { type: "integer" }, evidence: S("输出摘要") }, required: ["command", "status"] }, description: "跑过的验证命令结果" },
};
const TASK_PROPS = {
  subject: S("任务标题"),
  description: S("要做什么、做到什么程度"),
  assignee: S("指派给哪个成员；不填 = 谁空闲谁领"),
  dependencies: { type: "array", items: { type: "string" }, description: "依赖的任务：任务 id（t1）、同一份计划里的 ref 或标题" },
  ref: S("计划里给这个任务起的短名，供别的任务在 dependencies 里引用"),
  ...CONTRACT_PROPS,
};

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…（已截断，用 task_id 取全文）` : s);

const CONTRACT_FIELDS = ["kind", "round", "objective", "inScope", "outOfScope", "acceptance", "verify", "deliverables", "nonGoals", "coverageOf", "reviewedTaskId", "sourceTaskId", "sourceFindingIds", "verdict", "findings", "changedPaths", "acceptanceResults", "commandsRun", "supersededBy", "forced"];
function contractOf(k) {
  const o = {};
  for (const f of CONTRACT_FIELDS) if (k[f] !== undefined) o[f] = k[f];
  return o;
}

function taskView(k, full) {
  return { id: k.id, subject: k.subject, status: k.status, assignee: k.assignee, dependencies: k.dependencies, attempt: k.attempt, attemptId: k.attemptId, description: k.description, output: full ? k.output : clip(k.output, 1500), revisions: k.revisions?.length, ...(full ? {} : {}), ...contractOf(k, full) };
}

const sig = (store, t, who) => `${t.tasks.map(k => `${k.id}:${k.status}:${k.attempt}`).join("|")}#${store.unread(t, who).length}#${t.phase}#${t.halted ? 1 : 0}`;

/** 等团队有新进展（任务状态变化 / 有新消息）或超时；队长靠它代替「被推送」 */
function waitChange(store, teamId, who, seconds) {
  const t = store.get(teamId);
  const start = sig(store, t, who);
  const ms = Math.min(Math.max(Number(seconds) || 0, 0), 50) * 1000;
  if (!ms) return Promise.resolve(false);
  return new Promise(resolve => {
    const done = v => {
      clearTimeout(timer);
      store.off("changed", on);
      resolve(v);
    };
    const on = () => {
      if (store.teams.has(teamId) && sig(store, store.get(teamId), who) !== start) done(true);
    };
    const timer = setTimeout(() => done(false), ms);
    store.on("changed", on);
  });
}

const defs = [
  {
    name: "agent_teams_create",
    description: "创建一个团队（你就是队长）：给出目标、成员和带依赖的任务。默认只是「待批准」的方案，不会开始干活；把方案讲给用户，用户同意后（在插件页面点「批准并运行」，或告诉你同意）再调用 agent_teams_approve。auto_approve=true 才会立刻运行。",
    inputSchema: {
      type: "object",
      properties: {
        name: S("团队名"),
        description: S("团队目标"),
        members: { type: "array", items: { type: "object", properties: MEMBER_PROPS, required: ["name"] } },
        tasks: { type: "array", items: { type: "object", properties: TASK_PROPS, required: ["subject"] } },
        auto_approve: { type: "boolean", description: "用户已经明确同意时才用" },
        goal_items: LIST("用户目标清单：每一条都应该被某个任务的 coverage_of 覆盖，没覆盖就不能算可交付"),
        max_repair_attempts: { type: "integer", description: "评审没通过时自动修复的最多轮数，默认 2；超过就升级给队长" },
      },
      required: ["name"],
    },
    run({ store, args }) {
      const t = store.create({ ...args, autoApprove: args.auto_approve === true });
      return { created: store.summary(t, CAPTAIN), next: t.phase === "staged" ? "方案已创建，还没开始。请把成员和任务讲给用户，用户同意后调用 agent_teams_approve。" : "团队已开始运行。用 agent_teams_status（可带 wait_seconds）等进展。" };
    },
  },
  {
    name: "agent_teams_approve",
    description: "批准待批准的方案并开始运行：每个成员会自动领取轮到自己的任务。只在用户同意后调用。",
    inputSchema: { type: "object", properties: { ...TEAM } },
    run({ store, args }) {
      const t = store.approve(store.resolve(args.teamId).id);
      return { approved: store.summary(t, CAPTAIN), next: "已开始运行。用 agent_teams_status（可带 wait_seconds）等进展。" };
    },
  },
  {
    name: "agent_teams_edit_plan",
    description: "待批准阶段整体修改方案（说明、成员、任务，传哪项改哪项，任务会整体重建）。用户提了修改意见时用它改同一份草稿。已运行的团队请用 add_member / create_task / amend_task。",
    inputSchema: { type: "object", properties: { ...TEAM, description: S("团队目标"), members: { type: "array", items: { type: "object", properties: MEMBER_PROPS, required: ["name"] } }, tasks: { type: "array", items: { type: "object", properties: TASK_PROPS, required: ["subject"] } }, goal_items: LIST("用户目标清单"), max_repair_attempts: { type: "integer" } } },
    run({ store, args }) {
      const { teamId, ...plan } = args;
      return store.summary(store.editPlan(store.resolve(teamId).id, plan), CAPTAIN);
    },
  },
  {
    name: "agent_teams_add_member",
    description: "加一个成员（运行中也可以）。",
    inputSchema: { type: "object", properties: { ...TEAM, ...MEMBER_PROPS }, required: ["name"] },
    run({ store, args }) {
      const { teamId, ...m } = args;
      const t = store.resolve(teamId);
      store.addMember(t.id, m);
      return store.summary(t, CAPTAIN);
    },
  },
  {
    name: "agent_teams_remove_member",
    description: "移除一个成员：他手上没做完的任务退回待办并变成未指派。",
    inputSchema: { type: "object", properties: { ...TEAM, name: S("成员名") }, required: ["name"] },
    run({ store, args }) {
      const t = store.resolve(args.teamId);
      store.removeMember(t.id, args.name);
      return store.summary(t, CAPTAIN);
    },
  },
  {
    name: "agent_teams_create_task",
    description: "追加一个任务，可以依赖已有任务；依赖没完成前不会被领取。",
    inputSchema: { type: "object", properties: { ...TEAM, ...TASK_PROPS }, required: ["subject"] },
    run({ store, args }) {
      const { teamId, ...raw } = args;
      const t = store.resolve(teamId);
      return taskView(store.createTask(t.id, raw), true);
    },
  },
  {
    name: "agent_teams_reassign_task",
    description: "改派任务（assignee 留空 = 改成未指派）。正在执行的尝试会被作废，旧成员的进度不再被接受。",
    inputSchema: { type: "object", properties: { ...TEAM, taskId: S("任务 id"), assignee: S("新的负责人") }, required: ["taskId"] },
    run({ store, args }) {
      const t = store.resolve(args.teamId);
      return taskView(store.reassignTask(t.id, args.taskId, args.assignee), true);
    },
  },
  {
    name: "agent_teams_claim_task",
    description: "领取一个任务。不传 taskId 就领第一个轮到自己、依赖都已完成的任务。成功后返回 attemptId，更新任务时要带上。",
    inputSchema: { type: "object", properties: { ...TEAM, taskId: S("任务 id；可省略") } },
    run({ store, who, teamId, args }) {
      const t = store.resolve(teamId || args.teamId);
      return taskView(store.claimTask(t.id, who, args.taskId), true);
    },
  },
  {
    name: "agent_teams_update_task",
    description: "更新自己任务的状态：in_progress / completed / failed。完成或失败必须在 output 里写结果（会原样交给队长）。任务带 kind（质量门）时还要交证据：implementation / repair 要 changed_paths、acceptance_results、commands_run；verification 要 commands_run；review / requirements 要 verdict（不是 pass 时用 failed 并带 findings）；证据不合格会被拒绝，按提示补齐再交。attemptId 来自 claim_task；任务被改派、重试或暂停后旧的 attemptId 会失效。队长还可以用它取消（cancelled）或退回（pending）任务。",
    inputSchema: { type: "object", properties: { ...TEAM, taskId: S("任务 id"), attemptId: S("claim_task 返回的 attemptId（队长不用）"), status: { type: "string", enum: ["pending", "in_progress", "completed", "failed", "cancelled"] }, output: S("结果或失败原因"), ...EVIDENCE_PROPS }, required: ["taskId", "status"] },
    run({ store, who, teamId, args, ctx }) {
      const t = store.resolve(teamId || args.teamId);
      return taskView(store.updateTask(t.id, who, args, ctx), true);
    },
  },
  {
    name: "agent_teams_amend_task",
    description: "队长修订任务的合同（标题、说明、目标、验收、验证、依赖），必须写 reason；正在执行的尝试会被作废重来，旧值留在修订记录里。",
    inputSchema: { type: "object", properties: { ...TEAM, taskId: S("任务 id"), reason: S("旧合同为什么不对"), subject: S("新标题"), description: S("新说明"), objective: S("新目标"), acceptance: { type: "array", items: { type: "string" } }, verify: { type: "array", items: { type: "string" } }, dependencies: { type: "array", items: { type: "string" } }, in_scope: LIST("允许改的路径"), out_of_scope: LIST("禁止改的路径"), deliverables: LIST("交付物"), non_goals: LIST("不做的事"), coverage_of: LIST("覆盖的用户目标") }, required: ["taskId", "reason"] },
    run({ store, args }) {
      const { teamId, taskId, ...patch } = args;
      const t = store.resolve(teamId);
      return taskView(store.amendTask(t.id, taskId, patch), true);
    },
  },
  {
    name: "agent_teams_send_message",
    description: "给队友或队长发消息（to 填成员名或 captain）。消息会唤醒空闲的收件人。",
    inputSchema: { type: "object", properties: { ...TEAM, to: S("成员名或 captain"), content: S("消息内容") }, required: ["to", "content"] },
    run({ store, who, teamId, args }) {
      const t = store.resolve(teamId || args.teamId);
      const m = store.sendMessage(t.id, who, args.to, args.content);
      return { sent: m.id, to: m.to };
    },
  },
  {
    name: "agent_teams_status",
    description: "看团队进展：成员在忙什么、每个任务的状态，并取走发给你的未读消息。队长靠它拿成员的结果：可以带 wait_seconds（最多 50）等有新进展再返回；task_id 取某个任务的完整 output。",
    readOnly: true,
    inputSchema: { type: "object", properties: { ...TEAM, wait_seconds: { type: "integer", description: "没有新进展时最多等多少秒" }, task_id: S("只取这个任务（含完整 output）") } },
    async run({ store, who, teamId, args }) {
      const t0 = store.resolve(teamId || args.teamId);
      if (args.wait_seconds) await waitChange(store, t0.id, who, args.wait_seconds);
      const t = store.get(t0.id);
      const messages = store.takeUnread(t.id, who).map(m => ({ from: m.from, content: m.content, taskId: m.taskId }));
      if (args.task_id) return { task: taskView(store.task(t, args.task_id), true), messages };
      const s = store.summary(t, who);
      s.tasks = s.tasks.map(k => ({ ...k, output: clip(k.output, 1500) }));
      const hints = [];
      if (t.phase === "staged") hints.push("方案还没批准，成员不会干活。");
      if (t.halted) hints.push("团队已被用户暂停（resume 可继续）。");
      if (s.progress.finished) hints.push("所有任务都已结束：请汇总每个任务的结果交给用户。");
      const q = s.quality;
      if (q) {
        if (q.state === "deliverable") hints.push("质量门全部通过，可以向用户交付。");
        else if (q.state === "blocked") hints.push(`所有任务都结束了，但质量门还不能放行：${q.blockers.join("；")}`);
        for (const e of q.escalations) hints.push(`质量门升级（${e.taskId}）：${e.reason}`);
        for (const w of q.warnings) hints.push(w);
      }
      for (const k of t.tasks) if (store.blockedBy(t, k).length && !isTerminal(k)) hints.push(`任务 ${k.id} 依赖的任务失败或被取消了，需要你改派、修订或取消。`);
      return { team: s, messages, hints };
    },
  },
  {
    name: "agent_teams_resume",
    description: "恢复被用户暂停的团队：暂停时被取消的任务回到待办，成员继续自动领任务。",
    inputSchema: { type: "object", properties: { ...TEAM } },
    run({ store, args }) {
      return store.summary(store.resume(store.resolve(args.teamId).id), CAPTAIN);
    },
  },
  {
    name: "agent_teams_delete",
    description: "结束并归档团队（完整的成员和任务记录会保留在「已归档」里）。",
    inputSchema: { type: "object", properties: { ...TEAM } },
    run({ store, args }) {
      const t = store.archive(store.resolve(args.teamId).id);
      return { archived: t.id };
    },
  },
];

/** 队长用：插件工具列表（给 rpc.serve） */
function captainTools(store) {
  return defs.map(d => ({ name: d.name, description: d.description, inputSchema: d.inputSchema, readOnly: !!d.readOnly, run: args => d.run({ store, who: CAPTAIN, args: args || {} }) }));
}

/** 成员用：OpenAI 工具格式 + 执行函数；teamId 固定，attemptId 缺省时用成员手上任务的 */
function memberTools(store, teamId, who, extra = {}) {
  return defs
    .filter(d => MEMBER_TOOL_NAMES.includes(d.name))
    .map(d => ({
      name: d.name,
      description: d.description,
      parameters: { ...d.inputSchema, properties: Object.fromEntries(Object.entries(d.inputSchema.properties).filter(([k]) => k !== "teamId")) },
      async run(args) {
        const a = { ...(args || {}) };
        if (d.name === "agent_teams_update_task" && !a.attemptId) {
          const t = store.get(teamId);
          const k = t.tasks.find(x => x.id === a.taskId);
          if (k && k.assignee === who && k.attemptId) a.attemptId = k.attemptId;
        }
        return d.run({ store, who, teamId, args: a, ctx: { writes: extra.writes ? extra.writes() : [] } });
      },
    }));
}

module.exports = { TEAM_TOOL_NAMES, MEMBER_TOOL_NAMES, captainTools, memberTools, taskView, waitChange };
