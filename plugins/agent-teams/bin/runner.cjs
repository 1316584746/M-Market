"use strict";
/**
 * 成员的一轮执行：用成员的路由跑「模型 → 工具 → 模型」的循环，直到任务收尾、没有工具调用、被中止或步数用完。
 * 调度器已经替成员领好了任务（attemptId 在提示词里），成员完成时调用 agent_teams_update_task。
 */
const { chat, resolveRoute } = require("./llm.cjs");
const { fileTools } = require("./memtools.cjs");
const { memberTools } = require("./tools.cjs");
const { isTerminal } = require("./state.cjs");
const { writeViolation } = require("./quality.cjs");

const MAX_RESULT = 12000;

function systemPrompt(team, member, teammates) {
  return [
    `你是团队「${team.name}」的成员 ${member.name}${member.role ? `（角色：${member.role}）` : ""}。`,
    team.description ? `团队目标：${team.description}` : "",
    `队友：${teammates.length ? teammates.map(m => `${m.name}${m.role ? `（${m.role}）` : ""}`).join("、") : "（没有其他成员）"}。队长（captain）负责统筹并向用户汇报。`,
    "",
    "工作方式：",
    "1. 你的任务由系统分配并已替你领取，任务编号和 attemptId 写在下面的消息里。先用工具把事情真正做完（读文件、搜索、必要时写文件或执行命令），不要只给计划。",
    "2. 做完后必须调用 agent_teams_update_task：status=completed，并在 output 里写清结果（会原样交给队长）；做不下去就 status=failed 并写明原因。",
    "3. 需要队友配合或有重要发现时用 agent_teams_send_message；不要等回复，继续做你自己的部分。",
    "4. 只做分配给你的任务，不要改派、不要替别人做。写文件和执行命令需要用户确认，被拒绝就换办法或如实汇报。",
    member.toolPolicy === "readonly" ? "5. 你是只读成员：没有写文件和执行命令的工具。" : "",
    member.executionPrompt ? `\n额外要求：\n${member.executionPrompt}` : "",
  ].filter(Boolean).join("\n");
}

const FILE_CALLS = "acceptance_results 每条验收标准一项 { criterion: 标准原文, status: passed|failed, evidence }，commands_run 每条验证命令一项 { command: 命令原文, status: passed|failed, exit_code }";
const KIND_GUIDE = {
  implementation: `只能改 in_scope 里的路径（写别处会被直接拦下）。做完先真的跑一遍验证命令，再 agent_teams_update_task status=completed，并带上 changed_paths（改过的文件）、${FILE_CALLS}。任何一项没通过都不要 completed：修好再交，实在做不到就 status=failed 说明原因。证据不合格会被拒绝，按提示补齐。`,
  repair: `这是按评审意见做的修复：只处理下面列出的问题，不要顺手改别的。只能改 in_scope 里的路径。做完先跑一遍验证命令，再 agent_teams_update_task status=completed，并带上 changed_paths、${FILE_CALLS}（验收标准就是「修复各条问题」）。`,
  verification: `你只负责验证，不要改任何文件（写文件会被拦下）。运行要运行的验证命令，用 commands_run 如实回报每条结果；全部通过才能 completed。有失败就 status=failed，写明哪条失败和输出摘要。`,
  review: `你是评审，不要改任何文件（写文件会被拦下）。对照验收标准，检查依赖任务的结果和工作区里的实际内容，不要只信对方的自述。通过：status=completed，verdict=pass，并用 acceptance_results 逐条给结果。不通过：status=failed，verdict=needs_revision（方向本身有问题用 reject），findings 里每条写 severity（low/medium/high/blocker）、problem、required_fix（可带 file、line）。存在 blocker / high 问题时不能给 pass。`,
  requirements: `你负责澄清需求，不要改任何文件。把目标、范围、验收标准、未决问题写进 output。需求可以进入实现：status=completed，verdict=pass。还有重大缺口：status=failed，verdict=needs_revision，并用 findings 列出缺什么。`,
  integration: `汇总各任务的结果并运行验证命令，用 commands_run 如实回报；全部通过才能 completed，在 output 里给出交付说明。`,
};

function taskPrompt(team, task) {
  const lines = [`任务 ${task.id}：${task.subject}`, `attemptId：${task.attemptId}`];
  if (task.description) lines.push("", task.description);
  if (task.objective) lines.push("", `目标：${task.objective}`);
  if (task.inScope?.length) lines.push("", "允许改的范围（in_scope）：", ...task.inScope.map(x => `- ${x}`));
  if (task.outOfScope?.length) lines.push("", "禁止改的范围（out_of_scope）：", ...task.outOfScope.map(x => `- ${x}`));
  if (task.acceptance?.length) lines.push("", "验收标准：", ...task.acceptance.map((x, i) => `${i + 1}. ${x}`));
  if (task.verify?.length) lines.push("", task.kind === "verification" || task.kind === "integration" ? "要运行的验证命令：" : "验证方式（完成前要真的跑一遍）：", ...task.verify.map(x => `- ${x}`));
  if (task.deliverables?.length) lines.push("", "交付物：", ...task.deliverables.map(x => `- ${x}`));
  if (task.nonGoals?.length) lines.push("", "明确不做：", ...task.nonGoals.map(x => `- ${x}`));
  const guide = KIND_GUIDE[task.kind];
  if (guide) lines.push("", `【质量门：${task.kind}${task.round ? `，第 ${task.round} 轮` : ""}】${guide}`);
  const deps = task.dependencies.map(id => team.tasks.find(k => k.id === id)).filter(Boolean);
  if (deps.length) lines.push("", "依赖任务的结果：", ...deps.map(d => `- ${d.id} ${d.subject}（${d.assignee || "?"}）：${(d.output || "（无输出）").slice(0, 3000)}`));
  return lines.join("\n");
}

const fmtMessages = msgs => msgs.map(m => `[来自 ${m.from}${m.taskId ? `，关于 ${m.taskId}` : ""}] ${m.content}`).join("\n");

/**
 * 跑一轮。返回 { steps, text }。出错或被中止时抛出（调度器负责收尾）。
 *   ctx: { store, team, member, task | null, settings, signal, log, ask }
 */
async function runTurn(ctx) {
  const { store, team, member, task, settings, signal, log, ask } = ctx;
  const route = resolveRoute(settings, { provider: member.provider, model: member.model });
  const teammates = store.activeMembers(team).filter(m => m.name !== member.name);
  const defsTeam = memberTools(store, team.id, member.name);
  // 质量门：带合同的任务写文件时按 in_scope / out_of_scope 拦；评审 / 验证 / 需求类任务根本不让写。真实写过的路径记到任务上，完成时审计
  const live = () => (task ? team.tasks.find(x => x.id === task.id && x.attempt === task.attempt && x.assignee === member.name) : undefined);
  const guard = rel => {
    const k = live();
    if (!k) return null;
    if (k.kind === "review" || k.kind === "requirements" || k.kind === "verification") return `这是 ${k.kind} 任务，不能写文件。需要改动请 send_message 给队长。`;
    return writeViolation(k, rel);
  };
  const defsFile = fileTools({ workspace: ctx.workspace, ask, policy: member.toolPolicy, guard, onWrite: rel => task && store.recordWrite(team.id, task.id, task.attempt, rel) });
  const all = [...defsFile, ...defsTeam];
  const byName = new Map(all.map(t => [t.name, t]));
  const toolSpecs = all.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

  const messages = [{ role: "system", content: systemPrompt(team, member, teammates) }];
  const unread = store.takeUnread(team.id, member.name);
  const head = [];
  if (task) head.push(taskPrompt(team, task));
  if (unread.length) head.push(`新消息：\n${fmtMessages(unread)}`);
  if (!head.length) head.push("没有新的任务或消息。");
  messages.push({ role: "user", content: head.join("\n\n") });
  log("status", task ? `开始 ${task.id}：${task.subject}（${route.provider} / ${route.model}）` : `处理消息（${route.provider} / ${route.model}）`);

  const maxSteps = Math.max(1, Math.min(Number(settings.maxSteps) || 30, 100));
  let text = "";
  let steps = 0;
  const finished = () => {
    if (!task) return false;
    const k = team.tasks.find(x => x.id === task.id);
    return !k || isTerminal(k) || k.attempt !== task.attempt || k.assignee !== member.name;
  };

  for (; steps < maxSteps; steps++) {
    if (signal.aborted) throw new Error("已取消");
    const res = await chat({ route, messages, tools: toolSpecs, signal, retryDelays: settings.retryDelays });
    store.addUsage(team, member.name, res.usage);
    const msg = res.message;
    messages.push({ role: "assistant", content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (msg.content) {
      text = String(msg.content);
      log("text", text);
    }
    if (!msg.tool_calls?.length) break;
    for (const call of msg.tool_calls) {
      const name = call.function?.name;
      const tool = byName.get(name);
      let args = {};
      let out;
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        out = "错误：参数不是合法的 JSON";
      }
      log("tool", `${name} ${JSON.stringify(args).slice(0, 300)}`);
      if (out === undefined) {
        if (!tool) out = `错误：没有这个工具 ${name}`;
        else {
          try {
            const r = await tool.run(args, { signal, member: member.name, teamId: team.id });
            out = typeof r === "string" ? r : JSON.stringify(r);
          } catch (e) {
            if (signal.aborted) throw new Error("已取消");
            out = `错误：${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }
      out = out.length > MAX_RESULT ? `${out.slice(0, MAX_RESULT)}\n…（已截断）` : out;
      log("result", out.slice(0, 600));
      messages.push({ role: "tool", tool_call_id: call.id, content: out });
    }
    if (finished()) break;
    // 新消息在两步之间递给成员
    const more = store.takeUnread(team.id, member.name);
    if (more.length) messages.push({ role: "user", content: `新消息：\n${fmtMessages(more)}` });
  }
  return { steps, text };
}

/** 一轮结束后的收尾：成员没调用 update_task 时，用最后一段回复代交；一段话都没有就算失败 */
function settle(store, team, member, task, outcome) {
  if (!task) return;
  const k = team.tasks.find(x => x.id === task.id);
  if (!k || isTerminal(k) || k.attempt !== task.attempt || k.assignee !== member.name || !k.attemptId) return;
  const base = { taskId: k.id, attemptId: k.attemptId };
  try {
    if (outcome.error) store.updateTask(team.id, member.name, { ...base, status: "failed", output: `执行出错：${outcome.error}` });
    else if (outcome.text) {
      try {
        store.updateTask(team.id, member.name, { ...base, status: "completed", output: `${outcome.text}\n\n（成员没有调用 agent_teams_update_task，按最后一次回复自动提交）` });
      } catch (e) {
        // 带质量门的任务没交证据，不能凭一句话算完成：记为失败并写明差在哪，队长可以改派或修订合同
        if (!k.kind || k.kind === "work") throw e;
        store.updateTask(team.id, member.name, { ...base, status: "failed", output: `成员没有按质量门提交证据，任务不能算完成：${e.message}\n\n成员最后的回复：\n${outcome.text}` });
      }
    } else store.updateTask(team.id, member.name, { ...base, status: "failed", output: "成员结束了这一轮，但没有产出任何结果" });
  } catch {
    /* 被改派 / 暂停的瞬间已经失效，忽略 */
  }
}

module.exports = { runTurn, settle, systemPrompt, taskPrompt };
