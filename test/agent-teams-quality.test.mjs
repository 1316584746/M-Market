import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { after, describe, it } from "node:test";
import { launch, ROOT, tmpdir } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { Store } = require(path.join(ROOT, "plugins/agent-teams/bin/state.cjs"));
const Q = require(path.join(ROOT, "plugins/agent-teams/bin/quality.cjs"));

const running = [];
const servers = [];
after(() => {
  running.forEach(p => p.stop());
  servers.forEach(s => s.close());
});
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("等待超时");
    await new Promise(r => setTimeout(r, 40));
  }
};
const json = r => JSON.parse(r.text);

const mk = () => new Store(tmpdir("at-q"));
const IMPL = { ref: "impl", subject: "实现", kind: "implementation", assignee: "a", objective: "写功能", in_scope: ["src/", "docs/*.md"], out_of_scope: ["src/vendor/"], acceptance: ["功能可用", "有文档"], verify: ["npm test"] };
const PASS = { status: "completed", output: "好了" };
const evidence = { changed_paths: ["src/a.js"], acceptance_results: [{ criterion: "功能可用", status: "passed" }, { criterion: "有文档", status: "passed" }], commands_run: [{ command: "npm test", status: "passed", exit_code: 0 }] };

/** 建一个运行中的团队，a 实现、b 评审、c 是备用 */
function team(s, tasks, extra = {}) {
  return s.create({ name: "q", members: [{ name: "a" }, { name: "b" }, { name: "c" }], tasks, autoApprove: true, ...extra });
}
const finish = (s, t, who, taskId, upd, ctx) => {
  const k = s.claimTask(t.id, who, taskId);
  return s.updateTask(t.id, who, { taskId, attemptId: k.attemptId, ...upd }, ctx);
};

describe("agent-teams 质量门：合同和路径", () => {
  it("写类任务缺合同被拒；评审默认评审它依赖的实现；verification 要有命令", () => {
    const s = mk();
    assert.throws(() => team(s, [{ subject: "x", kind: "implementation", assignee: "a" }]), /objective/);
    assert.throws(() => team(s, [{ subject: "x", kind: "implementation", objective: "o", in_scope: ["src/"] }]), /acceptance/);
    assert.throws(() => team(s, [{ subject: "v", kind: "verification" }]), /verify/);
    assert.throws(() => team(s, [{ subject: "r", kind: "review" }]), /reviewed_task/);
    assert.throws(() => team(s, [{ subject: "x", kind: "神奇" }]), /kind 只能是/);
    const t = team(s, [IMPL, { subject: "评审", kind: "review", assignee: "b", dependencies: ["impl"] }, { subject: "评审2", kind: "review", reviewed_task: "impl" }]);
    const [impl, r1, r2] = t.tasks;
    assert.equal(r1.reviewedTaskId, impl.id, "依赖了实现任务就默认评审它");
    assert.deepEqual(r1.acceptance, Q.DEFAULT_REVIEW_ACCEPTANCE || r1.acceptance);
    assert.ok(r1.acceptance.length === 2 && r1.round === 1);
    assert.equal(r2.reviewedTaskId, impl.id);
    assert.ok(r2.dependencies.includes(impl.id), "reviewed_task 自动成为依赖，评审一定在实现之后");
  });

  it("路径匹配：目录、通配、禁止优先、非法路径", () => {
    const k = { inScope: ["src/", "docs/*.md", "pkg/**", "**/*.test.js"], outOfScope: ["src/vendor/"] };
    const c = p => Q.classifyPath(p, k);
    assert.equal(c("src/a/b.js"), "in_scope");
    assert.equal(c("./src\\a.js"), "in_scope", "反斜杠和 ./ 会被规整");
    assert.equal(c("src/vendor/x.js"), "out_of_scope", "禁止优先于允许");
    assert.equal(c("docs/readme.md"), "in_scope");
    assert.equal(c("docs/a/readme.md"), "undeclared", "* 不跨目录");
    assert.equal(c("pkg/deep/er/x"), "in_scope");
    assert.equal(c("lib/x.test.js"), "in_scope");
    assert.equal(c("srcx/a.js"), "undeclared", "目录前缀要按目录边界匹配");
    assert.equal(c("../etc/passwd"), "illegal");
    assert.equal(c("/etc/passwd"), "illegal");
    assert.equal(c("C:/x"), "illegal");
    assert.match(Q.writeViolation({ kind: "implementation", inScope: ["src/"] }, "other/a.js"), /不在这个任务合同的 in_scope/);
    assert.equal(Q.writeViolation({ kind: "implementation", inScope: ["src/"] }, "src/a.js"), null);
    assert.equal(Q.writeViolation({ kind: "work" }, "any.js"), null, "普通任务不拦");
  });
});

describe("agent-teams 质量门：完成时要交证据", () => {
  it("实现任务：逐项被拦，补齐后才能 completed；真实写过的路径也要审", () => {
    const s = mk();
    const t = team(s, [IMPL]);
    const k = s.claimTask(t.id, "a", "t1");
    const up = (extra, ctx) => s.updateTask(t.id, "a", { taskId: "t1", attemptId: k.attemptId, ...PASS, ...extra }, ctx);
    assert.throws(() => up({}), /changed_paths/);
    assert.throws(() => up({ changed_paths: ["src/vendor/x.js"] }), /超出了合同范围.*out_of_scope/);
    assert.throws(() => up({ changed_paths: ["other/x.js"] }), /不在 in_scope 里/);
    assert.throws(() => up({ changed_paths: ["src/a.js"] }), /逐条交代验收结果.*功能可用.*有文档/);
    assert.throws(() => up({ changed_paths: ["src/a.js"], acceptance_results: evidence.acceptance_results }), /commands_run.*npm test/);
    assert.throws(() => up({ ...evidence, commands_run: [{ command: "npm test", status: "failed" }] }), /没通过.*npm test/);
    assert.throws(() => up({ ...evidence, acceptance_results: [{ criterion: "功能可用", status: "failed" }, { criterion: "有文档", status: "passed" }] }), /没通过.*功能可用/);
    s.recordWrite(t.id, "t1", k.attempt, "secret/leak.txt");
    assert.throws(() => up(evidence), /secret\/leak\.txt/, "插件自己的写文件工具写过的路径，成员少报也会被审出来");
    assert.equal(s.task(t, "t1").status, "claimed", "被拒绝后任务还是进行中，成员可以改好再交");
    const k2 = s.get(t.id);
    k2.tasks[0].writes = ["src/a.js"];
    const done = up(evidence);
    assert.equal(done.status, "completed");
    assert.deepEqual(done.changedPaths, ["src/a.js"]);
    assert.equal(done.acceptanceResults.length, 2);
    assert.equal(done.commandsRun[0].command, "npm test");
  });

  it("验收项可以按序号对应，命令按包含关系对应", () => {
    const s = mk();
    const t = team(s, [IMPL]);
    const done = finish(s, t, "a", "t1", { ...PASS, changed_paths: ["src/a.js"], acceptance_results: [{ criterion: "#1", status: "passed" }, { criterion: "有文档（README 已更新）", status: "passed" }], commands_run: [{ command: "cd app && npm test -- --ci", status: "passed" }] });
    assert.equal(done.status, "completed");
  });

  it("评审：verdict 必填；pass 要逐条验收且没有 blocker/high；不通过要用 failed 并带 findings", () => {
    const s = mk();
    const t = team(s, [IMPL, { subject: "评审", kind: "review", assignee: "b", dependencies: ["impl"] }]);
    finish(s, t, "a", "t1", { ...PASS, ...evidence });
    const k = s.claimTask(t.id, "b", "t2");
    const up = extra => s.updateTask(t.id, "b", { taskId: "t2", attemptId: k.attemptId, status: "completed", output: "看过了", ...extra });
    assert.throws(() => up({}), /必须带 verdict/);
    assert.throws(() => up({ verdict: "pass" }), /逐条给出验收结果/);
    const all = [{ criterion: "最新的实现满足用户目标", status: "passed" }, { criterion: "没有未解决的 blocker / high 问题", status: "passed" }];
    assert.throws(() => up({ verdict: "pass", acceptance_results: all, findings: [{ id: "S1", severity: "blocker", problem: "有洞", required_fix: "补上" }] }), /不能 verdict=pass/);
    assert.throws(() => up({ verdict: "needs_revision", findings: [{ severity: "high", problem: "x", required_fix: "y" }] }), /不能 completed/);
    assert.throws(() => up({ verdict: "sort-of" }), /verdict 只能是/);
    assert.throws(() => s.updateTask(t.id, "b", { taskId: "t2", attemptId: k.attemptId, status: "failed", output: "不行", verdict: "needs_revision" }), /必须带 findings/);
    const ok = up({ verdict: "pass", acceptance_results: all });
    assert.equal(ok.verdict, "pass");
    assert.equal(ok.reviewedAttempt, 1, "记下评审的是实现的第几次尝试");
  });

  it("评审 / 验证 / 需求类任务没法用「最后一句话」蒙混过关：没证据就是失败", () => {
    const s = mk();
    const t = team(s, [IMPL]);
    assert.throws(() => finish(s, t, "a", "t1", { ...PASS, changed_paths: ["src/a.js"] }), /逐条交代/);
    assert.equal(s.task(t, "t1").status, "claimed");
  });
});

describe("agent-teams 质量门：评审没通过 → 自动修复 + 复审", () => {
  const reviewFail = { status: "failed", output: "有问题", verdict: "needs_revision", findings: [{ id: "F1", severity: "high", file: "src/a.js", line: 3, problem: "缺少校验", required_fix: "加参数校验" }, { id: "F2", severity: "low", problem: "命名", required_fix: "改名" }] };
  const reviewPass = { status: "completed", output: "通过", verdict: "pass", acceptance_results: [{ criterion: "最新的实现满足用户目标", status: "passed" }, { criterion: "没有未解决的 blocker / high 问题", status: "passed" }] };
  const plan = () => [IMPL, { ref: "rev", subject: "评审", kind: "review", assignee: "b", dependencies: ["impl"] }, { subject: "集成", kind: "integration", assignee: "c", dependencies: ["rev"], verify: ["npm run build"] }];

  it("生成修复和复审，下游改等复审，原评审标记为已被接替；通过后可交付", () => {
    const s = mk();
    const t = team(s, plan(), { goal_items: ["功能可用"] });
    finish(s, t, "a", "t1", { ...PASS, ...evidence });
    assert.equal(s.summary(t).quality.state, "running");
    finish(s, t, "b", "t2", reviewFail);
    const [impl, rev1, integ, repair, rev2] = t.tasks;
    assert.equal(t.tasks.length, 5);
    assert.equal(repair.kind, "repair");
    assert.equal(repair.assignee, "a", "修复交给原来的实现者");
    assert.equal(repair.sourceTaskId, impl.id);
    assert.deepEqual(repair.inScope, ["src/", "docs/*.md"]);
    assert.deepEqual(repair.acceptance, ["修复 F1：加参数校验"], "low 级别的问题不进修复范围");
    assert.deepEqual(repair.verify, ["npm test"]);
    assert.match(repair.description, /F1.*src\/a\.js:3.*缺少校验.*加参数校验/s);
    assert.equal(rev2.kind, "review");
    assert.equal(rev2.round, 2);
    assert.equal(rev2.assignee, "b");
    assert.equal(rev2.reviewedTaskId, repair.id);
    assert.deepEqual(rev2.dependencies, [repair.id]);
    assert.equal(rev1.supersededBy, rev2.id);
    assert.deepEqual(integ.dependencies, [rev2.id], "原来等评审的集成任务改为等复审");
    assert.ok(s.get(t.id).messages.some(m => m.from === "system" && m.to === "captain" && /已自动创建修复任务/.test(m.content)));
    // 修复 → 复审通过 → 集成
    finish(s, t, "a", repair.id, { ...PASS, changed_paths: ["src/a.js"], acceptance_results: [{ criterion: "修复 F1：加参数校验", status: "passed" }], commands_run: evidence.commands_run });
    finish(s, t, "b", rev2.id, reviewPass);
    const q0 = s.summary(t).quality;
    assert.equal(q0.state, "running", "集成任务还没做");
    finish(s, t, "c", integ.id, { ...PASS, commands_run: [{ command: "npm run build", status: "passed" }] });
    const q = s.summary(t).quality;
    assert.equal(q.state, "blocked", "目标「功能可用」没有任何任务覆盖，不能算可交付");
    assert.match(q.blockers.join(), /功能可用.*没有任务覆盖/);
    s.createTask(t.id, { subject: "覆盖说明", kind: "work", coverage_of: ["功能可用"] });
    const k = s.claimTask(t.id, "c");
    s.updateTask(t.id, "c", { taskId: k.id, attemptId: k.attemptId, status: "completed", output: "ok" });
    assert.equal(s.summary(t).quality.state, "deliverable");
    assert.equal(s.summary(t).quality.coverage[0].status, "passed");
  });

  it("超过自动修复上限、reject、被评审任务没合同：升级给队长，队长出手后解除", () => {
    const s = mk();
    const t = team(s, plan(), { max_repair_attempts: 1 });
    finish(s, t, "a", "t1", { ...PASS, ...evidence });
    finish(s, t, "b", "t2", reviewFail);
    const [, , , repair, rev2] = t.tasks;
    finish(s, t, "a", repair.id, { ...PASS, changed_paths: ["src/a.js"], acceptance_results: [{ criterion: "修复 F1：加参数校验", status: "passed" }], commands_run: evidence.commands_run });
    finish(s, t, "b", rev2.id, reviewFail);
    assert.equal(t.tasks.length, 5, "已经修过 1 轮，不再自动创建");
    assert.equal(t.escalations.length, 1);
    assert.match(t.escalations[0].reason, /自动修复 1 轮仍没通过/);
    const q = s.summary(t).quality;
    assert.equal(q.state, "escalated");
    assert.ok(s.get(t.id).messages.some(m => /质量门升级/.test(m.content)));
    s.createTask(t.id, { subject: "队长亲自处理", assignee: "c" });
    assert.equal(s.summary(t).quality.escalations.length, 0);
    assert.notEqual(s.summary(t).quality.state, "escalated");

    const s2 = mk();
    const t2 = team(s2, plan());
    finish(s2, t2, "a", "t1", { ...PASS, ...evidence });
    finish(s2, t2, "b", "t2", { status: "failed", output: "方向不对", verdict: "reject" });
    assert.equal(t2.tasks.length, 3);
    assert.match(t2.escalations[0].reason, /reject/);

    const s3 = mk();
    const t3 = team(s3, [{ subject: "普通实现", assignee: "a" }, { subject: "评审", kind: "review", assignee: "b", reviewed_task: 1 }]);
    finish(s3, t3, "a", "t1", { ...PASS });
    finish(s3, t3, "b", "t2", reviewFail);
    assert.match(t3.escalations[0].reason, /没有 in_scope 合同/);
  });

  it("评审通过之后实现又被重做：给出「评审已过期」的提醒；队长手动收尾带标记", () => {
    const s = mk();
    const t = team(s, plan().slice(0, 2));
    finish(s, t, "a", "t1", { ...PASS, ...evidence });
    finish(s, t, "b", "t2", reviewPass);
    assert.equal(s.summary(t).quality.warnings.length, 0);
    s.get(t.id).tasks[0].attempt += 1; // 模拟之后又被改派重做
    assert.match(s.summary(t).quality.warnings[0], /旧版本/);
    const s2 = mk();
    const t2 = team(s2, [IMPL]);
    const forced = s2.updateTask(t2.id, "captain", { taskId: "t1", status: "completed", output: "我看过了，直接收尾" });
    assert.equal(forced.forced, true);
  });

  it("失败且没有被接替的任务会挡住交付；质量门没用上的团队没有 quality 字段", () => {
    const s = mk();
    const t = team(s, [IMPL]);
    finish(s, t, "a", "t1", { status: "failed", output: "做不出来" });
    const q = s.summary(t).quality;
    assert.equal(q.state, "blocked");
    assert.match(q.blockers[0], /t1.*失败/);
    const plain = team(mk(), [{ subject: "x" }]);
    assert.equal(mk().summary(plain).quality, undefined);
  });
});

// ───────── 端到端：假模型按剧本跑完「实现 → 评审不过 → 自动修复 → 复审通过」 ─────────

const callOf = (name, args, id = "c1") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

async function mockLLM(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", d => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const who = /成员 ([\p{L}\p{N}_.-]+)/u.exec(body.messages[0].content)?.[1];
      const first = body.messages.find(m => m.role === "user")?.content || "";
      const info = {
        who,
        first,
        taskId: /任务 (t\d+)：/.exec(first)?.[1],
        attemptId: /attemptId：(\w+)/.exec(first)?.[1],
        step: body.messages.filter(m => m.role === "tool").length,
        lastTool: [...body.messages].reverse().find(m => m.role === "tool")?.content || "",
      };
      requests.push(info);
      const out = script(info);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: out.content ?? null, ...(out.calls ? { tool_calls: out.calls } : {}) } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

describe("agent-teams 质量门：端到端（假模型）", () => {
  it("写文件按合同拦；证据不合格被退回；评审不过自动修复并复审，最后可交付", async () => {
    const home = tmpdir("at-q-home");
    const ws = tmpdir("at-q-ws");
    const step = (i, kind) => i.first.includes(`质量门：${kind}`);
    const llm = await mockLLM(i => {
      const upd = args => ({ calls: [callOf("agent_teams_update_task", { taskId: i.taskId, ...args })] });
      if (i.who === "alice" && step(i, "implementation")) {
        if (i.step === 0) return { calls: [callOf("write_file", { path: "src/out.txt", content: "v1" })] };
        if (i.step === 1) return { calls: [callOf("write_file", { path: "secret/x.txt", content: "no" })] };
        if (i.step === 2) return upd({ status: "completed", output: "写好了", changed_paths: ["src/out.txt"] });
        if (i.step === 3) return upd({ status: "completed", output: "写好了", changed_paths: ["src/out.txt"], acceptance_results: [{ criterion: "文件存在", status: "passed", evidence: "write_file 成功" }] });
      }
      if (i.who === "alice" && step(i, "repair")) {
        if (i.step === 0) return { calls: [callOf("write_file", { path: "src/out.txt", content: "v2 带校验" })] };
        if (i.step === 1) return upd({ status: "completed", output: "补了校验", acceptance_results: [{ criterion: "修复 F1：补内容", status: "passed" }] });
      }
      if (i.who === "bob" && step(i, "review")) {
        const round2 = i.first.includes("第 2 轮");
        if (i.step === 0 && !round2) return upd({ status: "failed", output: "内容太少", verdict: "needs_revision", findings: [{ id: "F1", severity: "high", file: "src/out.txt", problem: "只有 v1", required_fix: "补内容" }] });
        if (i.step === 0 && round2) return upd({ status: "completed", output: "复审通过", verdict: "pass", acceptance_results: [{ criterion: "最新的实现满足用户目标", status: "passed" }, { criterion: "没有未解决的 blocker / high 问题", status: "passed" }] });
      }
      return { content: "完成" };
    });
    const p = launch("agent-teams", { home });
    running.push(p);
    await p.call("at/settings/set", { workspace: ws, route: { provider: "mock", model: "m", baseURL: llm.url, apiKey: "sk-q" } });
    await p.call("at/allow-all", { id: "gate", on: true }).catch(() => {});
    const c = json(await p.tool("agent_teams_create", {
      name: "gate",
      members: [{ name: "alice" }, { name: "bob" }],
      goal_items: ["产出文件"],
      tasks: [
        { ref: "impl", subject: "写文件", kind: "implementation", assignee: "alice", objective: "写 src/out.txt", in_scope: ["src/"], acceptance: ["文件存在"], coverage_of: ["产出文件"] },
        { subject: "评审", kind: "review", assignee: "bob", dependencies: ["impl"], coverage_of: ["产出文件"] },
      ],
    }));
    assert.equal(c.created.tasks[1].reviewedTaskId, "t1");
    await p.call("at/allow-all", { id: "gate", on: true });
    await p.tool("agent_teams_approve", { teamId: "gate" });

    const done = await until(async () => {
      const t = await p.call("at/get", { id: "gate" });
      return t.quality?.state === "deliverable" ? t : null;
    });
    assert.equal(done.tasks.length, 4, "实现 + 评审(失败) + 修复 + 复审");
    const byKind = k => done.tasks.filter(t => t.kind === k);
    assert.equal(byKind("repair")[0].status, "completed");
    assert.equal(byKind("review").map(t => t.status).join(), "failed,completed");
    assert.equal(done.tasks[1].verdict, "needs_revision");
    assert.equal(done.quality.coverage[0].status, "passed");
    // 越界写入被拦下（文件没有落地），模型看到了原因；证据缺失被退回，模型看到了要补什么
    assert.equal(fs.existsSync(path.join(ws, "secret", "x.txt")), false);
    assert.equal(fs.readFileSync(path.join(ws, "src", "out.txt"), "utf8"), "v2 带校验");
    const a = llm.requests.filter(r => r.who === "alice" && r.first.includes("质量门：implementation"));
    assert.match(a.find(r => r.step === 2).lastTool, /不在这个任务合同的 in_scope/);
    assert.match(a.find(r => r.step === 3).lastTool, /逐条交代验收结果/);
    // 评审任务拿不到写权限，写也会被拦：直接问 guard
    assert.deepEqual(done.tasks[0].changedPaths, ["src/out.txt"]);
  });
});
