"use strict";
/**
 * 质量门（quality gates）：纯规则，不碰文件、不碰模型，状态层（state.cjs）和调度层调用它。
 * 思路和名字来自 dsh-agent-teams 的质量门：任务有「合同」（目标 / 范围 / 验收 / 验证命令），
 * 完成时要交「证据」（改了哪些路径 / 每条验收的结果 / 跑过的命令 / 评审结论），不合格就不让 completed；
 * 评审没通过会自动生成「修复 + 复审」任务，直到通过或达到上限后升级给队长。
 *
 * 和原项目的差别：原项目拿不到宿主的写入权，只能在完成时审计「声称改了什么」；这里写文件的工具是插件自己的，
 * 所以写入时就按合同的 in_scope / out_of_scope 拦，并且记下真实写过的路径，完成时和成员声称的合并后再审。
 * run_command 里的命令可能改文件但看不见，这一点审计不到。
 */

const KINDS = ["work", "requirements", "implementation", "verification", "review", "repair", "integration"];
const WRITE_KINDS = ["implementation", "repair"];
const VERDICTS = ["pass", "needs_revision", "reject"];
const SEVERITIES = ["low", "medium", "high", "blocker"];
const DEFAULT_POLICY = { maxRepairAttempts: 2 };

const DEFAULT_REVIEW_ACCEPTANCE = ["最新的实现满足用户目标", "没有未解决的 blocker / high 问题"];

const s = (v, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : v == null ? "" : String(v).trim().slice(0, max));
const arr = v => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const strs = (v, n = 1000, cap = 50) => arr(v).map(x => s(x, n)).filter(Boolean).slice(0, cap);
const pick = (o, ...names) => {
  for (const n of names) if (o && o[n] !== undefined) return o[n];
  return undefined;
};
const norm = p => String(p ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
const fold = t => String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const kindOf = k => (k && k.kind) || "work";
const isQuality = k => kindOf(k) !== "work";

// ───────── 合同 ─────────

/** 把工具参数（snake_case 或 camelCase 都行）整理成任务上的合同字段；没写的字段不出现 */
function normalizeContract(raw) {
  const out = {};
  const kind = raw?.kind !== undefined ? s(raw.kind, 40) : "";
  if (kind) {
    if (!KINDS.includes(kind)) throw new Error(`kind 只能是 ${KINDS.join(" / ")}`);
    if (kind !== "work") out.kind = kind;
  }
  const put = (name, v) => {
    if (v !== undefined) out[name] = v;
  };
  const objective = pick(raw, "objective");
  if (objective !== undefined) put("objective", s(objective, 4000) || undefined);
  const list = (name, ...aliases) => {
    const v = pick(raw, name, ...aliases);
    if (v !== undefined) put(name, strs(v));
  };
  list("inScope", "in_scope");
  list("outOfScope", "out_of_scope");
  list("acceptance");
  list("verify");
  list("deliverables");
  list("nonGoals", "non_goals");
  list("coverageOf", "coverage_of");
  const round = pick(raw, "round");
  if (round !== undefined && Number.isFinite(Number(round))) put("round", Math.max(1, Math.min(Number(round), 50)));
  return out;
}

/** 建任务时的合同检查（任务已经带上规整后的字段，reviewedTaskId 已经解析成任务 id） */
function validateContract(k, tasks) {
  const kind = kindOf(k);
  if (kind === "work") return;
  const need = (cond, msg) => {
    if (!cond) throw new Error(`「${k.subject}」（${kind}）${msg}`);
  };
  if (WRITE_KINDS.includes(kind)) {
    need(k.objective, "需要 objective（这次要达成什么）");
    need(k.inScope?.length, "需要 in_scope（允许改哪些路径，如 src/、docs/*.md）");
    need(k.acceptance?.length, "需要 acceptance（验收标准，至少一条）");
  } else if (kind === "verification") {
    need(k.verify?.length, "需要 verify（要跑的验证命令，至少一条）");
  } else if (kind === "review") {
    need(k.reviewedTaskId, "需要 reviewed_task（评审哪个任务；也可以让它依赖一个 implementation / repair 任务）");
    const r = tasks.find(x => x.id === k.reviewedTaskId);
    need(r, `评审的任务 ${k.reviewedTaskId} 不存在`);
    need(r.id !== k.id, "不能评审自己");
  } else if (kind === "requirements") {
    need(k.objective || k.description, "需要 objective（要澄清什么）");
  }
}

/** 评审任务默认的验收标准 / 目标 / 评审对象（建任务时补） */
function defaultsFor(k, tasks) {
  const kind = kindOf(k);
  if (kind === "review") {
    if (!k.acceptance || !k.acceptance.length) k.acceptance = [...DEFAULT_REVIEW_ACCEPTANCE];
    if (!k.objective) k.objective = "评审最新的实现是否满足用户目标";
    if (!k.reviewedTaskId) {
      const dep = (k.dependencies || []).map(d => tasks.find(x => x.id === d)).find(x => x && WRITE_KINDS.includes(kindOf(x)));
      if (dep) k.reviewedTaskId = dep.id;
    }
    if (!k.round) k.round = 1;
  }
}

// ───────── 路径审计 ─────────

function matches(rel, pattern) {
  let pat = norm(pattern);
  if (!pat) return false;
  if (pat.endsWith("/**")) {
    const base = pat.slice(0, -3);
    return !base || rel === base || rel.startsWith(`${base}/`);
  }
  if (!/[*?]/.test(pat)) {
    const base = pat.replace(/\/+$/, "");
    return rel === base || rel.startsWith(`${base}/`);
  }
  const re = pat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0001/g, "(?:.*/)?");
  return new RegExp(`^${re}$`).test(rel);
}

/** in_scope / out_of_scope / undeclared（没被 in_scope 覆盖）/ illegal（绝对路径、..、空） */
function classifyPath(p, k) {
  const rel = norm(p);
  if (!rel || /^\//.test(rel) || /^[A-Za-z]:/.test(rel) || rel.split("/").includes("..") || rel.includes("\0")) return "illegal";
  if ((k.outOfScope || []).some(x => matches(rel, x))) return "out_of_scope";
  if ((k.inScope || []).some(x => matches(rel, x))) return "in_scope";
  return "undeclared";
}

/** 写入时的拦截：返回 null = 放行，否则是拒绝原因。只管带合同的写类任务 */
function writeViolation(k, rel) {
  if (!k || !WRITE_KINDS.includes(kindOf(k)) || !k.inScope?.length) return null;
  const c = classifyPath(rel, k);
  if (c === "in_scope") return null;
  const why = { out_of_scope: "在这个任务合同的 out_of_scope 里", undeclared: "不在这个任务合同的 in_scope 里", illegal: "路径不合法" }[c];
  return `不能写 ${rel}：${why}。合同允许的范围：${k.inScope.join("、")}${k.outOfScope?.length ? `；禁止：${k.outOfScope.join("、")}` : ""}。要改范围请 send_message 给队长。`;
}

// ───────── 完成时的证据 ─────────

function normFindings(raw) {
  return arr(raw).map((f, i) => {
    const o = typeof f === "string" ? { problem: f } : f || {};
    const severity = s(o.severity, 20).toLowerCase();
    return {
      id: s(o.id, 40) || `F-${i + 1}`,
      severity: SEVERITIES.includes(severity) ? severity : "medium",
      file: o.file ? s(o.file, 500) : undefined,
      line: Number.isFinite(Number(o.line)) && o.line !== "" && o.line != null ? Number(o.line) : undefined,
      problem: s(o.problem, 2000),
      requiredFix: s(pick(o, "requiredFix", "required_fix", "fix"), 2000),
      resolved: o.resolved === true ? true : undefined,
    };
  });
}

function normResults(raw, key) {
  return arr(raw).map(r => {
    const o = typeof r === "string" ? { [key]: r, status: "passed" } : r || {};
    const status = s(o.status, 20).toLowerCase() === "passed" || o.passed === true ? "passed" : "failed";
    const res = { [key]: s(o[key] ?? o.criterion ?? o.command, 1000), status, evidence: o.evidence ? s(o.evidence, 2000) : undefined };
    if (key === "command" && o.exit_code !== undefined) res.exitCode = Number(o.exit_code);
    if (key === "command" && o.exitCode !== undefined) res.exitCode = Number(o.exitCode);
    return res;
  });
}

const covers = (results, key, text, index) => {
  const want = fold(text);
  return results.find(r => {
    const got = fold(r[key]);
    if (!got) return false;
    if (got === want || got.includes(want) || want.includes(got)) return true;
    const m = key === "criterion" ? /^#?(\d+)\b/.exec(got) : null;
    return !!m && Number(m[1]) === index + 1;
  });
};

/**
 * 成员提交 completed / failed 时的检查与整理。
 *   k 任务；upd 成员给的 { status, output, verdict, findings, changed_paths, acceptance_results, commands_run }；writes 这次尝试里真实写过的路径
 * 返回 { evidence }（要写回任务的字段）；不合格抛 Error（任务保持进行中，成员改好再交）
 */
function checkCompletion(k, upd, writes = []) {
  const kind = kindOf(k);
  const status = upd.status;
  const evidence = {};
  const verdict = upd.verdict !== undefined ? s(upd.verdict, 20).toLowerCase() : undefined;
  if (verdict !== undefined && !VERDICTS.includes(verdict)) throw new Error(`verdict 只能是 ${VERDICTS.join(" / ")}`);
  const findings = upd.findings !== undefined ? normFindings(upd.findings) : undefined;
  const results = normResults(pick(upd, "acceptanceResults", "acceptance_results"), "criterion");
  const commands = normResults(pick(upd, "commandsRun", "commands_run"), "command");
  const claimed = strs(pick(upd, "changedPaths", "changed_paths"), 500, 200).map(norm);
  const changed = [...new Set([...claimed, ...writes.map(norm)])];

  if (verdict !== undefined) evidence.verdict = verdict;
  if (findings !== undefined) evidence.findings = findings;
  if (results.length) evidence.acceptanceResults = results;
  if (commands.length) evidence.commandsRun = commands;
  if (changed.length) evidence.changedPaths = changed;

  if (status === "in_progress" || kind === "work") return { evidence };

  const asReview = kind === "review" || kind === "requirements";
  if (asReview) {
    if (!verdict) {
      if (status === "failed") return { evidence }; // 没法评审（比如读不到被评审的内容）：直接失败，写明原因
      throw new Error(`${kind} 任务提交时必须带 verdict（pass / needs_revision / reject）`);
    }
    if (verdict !== "pass") {
      if (status === "completed") throw new Error(`verdict=${verdict} 的${kind === "review" ? "评审" : "需求澄清"}不能 completed：请用 status=failed 提交 verdict 和 findings，队长会据此修复或重新规划`);
      if (verdict === "needs_revision" && !(findings || []).some(f => f.problem && f.requiredFix)) throw new Error("needs_revision 必须带 findings（每条要有 severity、problem、required_fix）");
    } else {
      if (status === "failed") throw new Error("verdict=pass 的任务不能 failed；真的没法评审请去掉 verdict 说明原因");
      const open = (findings || []).filter(f => !f.resolved && (f.severity === "blocker" || f.severity === "high"));
      if (open.length) throw new Error(`还有未解决的 ${open.map(f => `${f.id}(${f.severity})`).join("、")}，不能 verdict=pass`);
      const missing = (k.acceptance || []).filter((a, i) => !covers(results, "criterion", a, i));
      if (missing.length) throw new Error(`评审要逐条给出验收结果（acceptance_results）。缺少：${missing.map(m => `「${m}」`).join("；")}`);
      const bad = results.filter(r => r.status === "failed");
      if (bad.length) throw new Error(`有验收项没通过（${bad.map(r => r.criterion).join("；")}），不能 verdict=pass`);
    }
    return { evidence };
  }

  // 实现 / 修复 / 验证 / 集成：completed 要有证据；failed 不挡
  if (status === "failed") return { evidence };
  if (WRITE_KINDS.includes(kind)) {
    if (!changed.length) throw new Error(`${kind} 任务完成时必须报告 changed_paths（改过的文件）。确实没有要改的就用 status=failed 写明原因`);
    const bad = changed.map(p => [p, classifyPath(p, k)]).filter(([, c]) => c !== "in_scope");
    if (bad.length) throw new Error(`改动超出了合同范围：${bad.map(([p, c]) => `${p}（${{ out_of_scope: "out_of_scope", undeclared: "不在 in_scope 里", illegal: "路径不合法" }[c]}）`).join("；")}。允许：${(k.inScope || []).join("、")}`);
    const miss = (k.acceptance || []).filter((a, i) => !covers(results, "criterion", a, i));
    if (miss.length) throw new Error(`请用 acceptance_results 逐条交代验收结果。缺少：${miss.map(m => `「${m}」`).join("；")}`);
  }
  if (WRITE_KINDS.includes(kind) || kind === "verification" || kind === "integration") {
    const miss = (k.verify || []).filter((c, i) => !covers(commands, "command", c, i));
    if (miss.length) throw new Error(`请用 commands_run 交代这些验证命令的结果（先真的跑一遍）：${miss.map(m => `「${m}」`).join("；")}`);
    const failedCmd = commands.filter(c => c.status === "failed");
    const failedAcc = results.filter(r => r.status === "failed");
    if (failedCmd.length || failedAcc.length) throw new Error(`有没通过的${failedAcc.length ? `验收项（${failedAcc.map(r => r.criterion).join("；")}）` : ""}${failedCmd.length ? `命令（${failedCmd.map(c => c.command).join("；")}）` : ""}，不能 completed：修好再交，或者 status=failed 说明原因`);
  }
  return { evidence };
}

// ───────── 评审没通过：自动修复 + 复审 ─────────

const findingLine = f => `- ${f.id}［${f.severity}］${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}${f.problem}${f.requiredFix ? ` → 修法：${f.requiredFix}` : ""}`;

/**
 * 一个评审（review / requirements）以 needs_revision / reject 结束后，决定接下来做什么。
 * 返回 { escalate: "原因" } 或 { repair: 任务输入, review: 任务输入, rewire: [受影响任务 id] }
 */
function planFollowUp(team, review, policy = {}) {
  const maxRepair = Number(policy.maxRepairAttempts ?? DEFAULT_POLICY.maxRepairAttempts);
  const kind = kindOf(review);
  if (review.status !== "failed" || (kind !== "review" && kind !== "requirements")) return null;
  if (review.verdict === "reject") return { escalate: `评审 ${review.id} 给出 reject：方向本身有问题，需要队长或用户重新决定` };
  if (review.verdict !== "needs_revision") return null;
  if (kind === "requirements") return { escalate: `需求澄清 ${review.id} 没通过：请队长根据 findings 调整需求后重新安排` };
  const reviewed = team.tasks.find(x => x.id === review.reviewedTaskId);
  if (!reviewed) return { escalate: `评审 ${review.id} 找不到被评审的任务，没法自动修复` };
  const root = reviewed.kind === "repair" ? team.tasks.find(x => x.id === reviewed.rootId) || reviewed : reviewed;
  if (!(root.inScope || []).length) return { escalate: `被评审的任务「${root.subject}」没有 in_scope 合同，没法自动生成修复任务` };
  const done = team.tasks.filter(x => kindOf(x) === "repair" && x.rootId === root.id).length;
  if (done >= maxRepair) return { escalate: `「${root.subject}」已经自动修复 ${done} 轮仍没通过评审（上限 ${maxRepair}）：需要队长或用户介入` };
  const must = (review.findings || []).filter(f => f.severity !== "low" && !f.resolved);
  if (!must.length) return { escalate: `评审 ${review.id} 没通过，但没有需要修的 findings（只有 low 或已解决）：请队长判断` };
  const round = done + 1;
  const owner = reviewed.assignee;
  const repair = {
    subject: `修复「${root.subject}」（第 ${round} 轮）`,
    description: `评审 ${review.id} 没通过，按下面的意见修复，不要改合同以外的东西：\n${must.map(findingLine).join("\n")}\n\n评审说明：${review.output || "（无）"}`,
    kind: "repair",
    assignee: owner && owner !== "captain" ? owner : root.assignee,
    objective: `按评审意见修复：${root.objective || root.subject}`,
    inScope: [...(root.inScope || [])],
    outOfScope: [...(root.outOfScope || [])],
    acceptance: must.map(f => `修复 ${f.id}：${f.requiredFix || f.problem}`),
    verify: [...(root.verify || [])],
    coverageOf: [...(root.coverageOf || [])],
    sourceTaskId: reviewed.id,
    rootId: root.id,
    sourceFindingIds: must.map(f => f.id),
    round,
  };
  const again = {
    subject: `复审「${root.subject}」（第 ${(review.round || 1) + 1} 轮）`,
    description: `上一轮评审 ${review.id} 的问题已由修复任务处理，请对照 findings 复核，并检查有没有引入新问题。`,
    kind: "review",
    assignee: review.assignee,
    objective: review.objective,
    acceptance: [...(review.acceptance || [])],
    coverageOf: [...(review.coverageOf || [])],
    sourceTaskId: review.id,
    sourceFindingIds: must.map(f => f.id),
    round: (review.round || 1) + 1,
  };
  return { repair, review: again };
}

// ───────── 汇总：能不能交付 ─────────

const isTerm = k => k.status === "completed" || k.status === "failed" || k.status === "cancelled";

/** 失败任务是否已经被后续的修复 / 复审接替，并且接替链最终是完成的 */
function superseded(team, k, seen = new Set()) {
  if (!k.supersededBy || seen.has(k.id)) return false;
  seen.add(k.id);
  const next = team.tasks.find(x => x.id === k.supersededBy);
  if (!next) return false;
  if (next.status === "completed") return true;
  if (next.status === "failed") return superseded(team, next, seen);
  return false;
}

function coverageRows(team) {
  const items = new Set((team.goalItems || []).map(x => String(x)));
  for (const k of team.tasks) for (const c of k.coverageOf || []) items.add(c);
  return [...items].map(item => {
    const ts = team.tasks.filter(k => (k.coverageOf || []).includes(item) && k.status !== "cancelled");
    if (!ts.length) return { goal_item: item, task_ids: [], status: "missing" };
    const open = ts.filter(k => !(k.status === "completed" || superseded(team, k)));
    const blocked = open.some(k => k.status === "failed");
    return { goal_item: item, task_ids: ts.map(k => k.id), status: blocked ? "blocked" : open.length ? "in_progress" : "passed" };
  });
}

/** 没用质量门（没有任何带 kind 的任务，也没有目标清单）时返回 null */
function qualitySummary(team) {
  const qs = team.tasks.filter(isQuality);
  const hasGoals = (team.goalItems || []).length > 0;
  if (!qs.length && !hasGoals) return null;
  const warnings = [];
  const blockers = [];
  for (const k of qs) {
    if (kindOf(k) === "review" && k.status === "completed" && k.reviewedTaskId) {
      const r = team.tasks.find(x => x.id === k.reviewedTaskId);
      if (r && k.reviewedAttempt !== undefined && (r.attempt || 0) !== k.reviewedAttempt) warnings.push(`评审 ${k.id} 针对的是 ${r.id} 的旧版本（它之后又被重做过），需要重新评审`);
    }
    const next = k.supersededBy && team.tasks.find(x => x.id === k.supersededBy && x.status !== "cancelled");
    if (k.status === "failed" && !next && !superseded(team, k)) blockers.push(`任务 ${k.id}「${k.subject}」失败了`);
  }
  for (const k of qs) {
    if (k.status === "completed" && kindOf(k) === "review") {
      const open = (k.findings || []).filter(f => !f.resolved && (f.severity === "blocker" || f.severity === "high"));
      if (open.length) blockers.push(`评审 ${k.id} 还有未解决的 ${open.map(f => f.id).join("、")}`);
    }
  }
  const coverage = coverageRows(team);
  for (const r of coverage) if (r.status === "missing" || r.status === "blocked") blockers.push(`目标「${r.goal_item}」${r.status === "missing" ? "没有任务覆盖" : "对应的任务失败了"}`);
  const escalations = (team.escalations || []).filter(e => !e.resolved);
  const finished = team.tasks.length > 0 && team.tasks.every(isTerm);
  let state;
  if (escalations.length) state = "escalated";
  else if (team.halted) state = "halted";
  else if (!finished) state = "running";
  else state = blockers.length ? "blocked" : "deliverable";
  const summary = {
    running: "质量门进行中",
    halted: "团队已暂停",
    escalated: `自动修复已停下，需要队长 / 用户决定（${escalations.length} 件）`,
    blocked: `所有任务都结束了，但还不能交付：${blockers.length} 个问题`,
    deliverable: "所有质量门都通过，可以交付",
  }[state];
  return { state, deliverable: state === "deliverable", summary, blockers: finished ? blockers : [], warnings, coverage, escalations };
}

module.exports = { KINDS, WRITE_KINDS, VERDICTS, SEVERITIES, DEFAULT_POLICY, kindOf, isQuality, normalizeContract, validateContract, defaultsFor, matches, classifyPath, writeViolation, checkCompletion, planFollowUp, qualitySummary, coverageRows, superseded, normFindings };
