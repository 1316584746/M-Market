import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { after, describe, it } from "node:test";
import { launch, ROOT, tmpdir } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { Store } = require(path.join(ROOT, "plugins/agent-teams/bin/state.cjs"));

const running = [];
const servers = [];
after(() => {
  running.forEach(p => p.stop());
  servers.forEach(s => s.close());
});

const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("等待超时");
    await new Promise(r => setTimeout(r, 40));
  }
};
const json = r => JSON.parse(r.text);

// ───────── 假的 OpenAI 兼容接口：按脚本回复，并记下收到的每个请求 ─────────

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
      const info = { who, taskId: /任务 (t\d+)：/.exec(first)?.[1], attemptId: /attemptId：(\w+)/.exec(first)?.[1], first, step: body.messages.filter(m => m.role === "tool").length, body, tools: (body.tools || []).map(t => t.function.name) };
      requests.push(info);
      Promise.resolve(script(info)).then(out => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: out.content ?? null, ...(out.calls ? { tool_calls: out.calls } : {}) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
      });
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

/** 默认剧本：先读 hello.txt，再 update_task 完成，最后说一句话 */
const defaultScript = i => {
  if (i.step === 0) return { calls: [callOf("read_file", { path: "hello.txt" })] };
  if (i.step === 1) return { calls: [callOf("agent_teams_update_task", { taskId: i.taskId, status: "completed", output: `${i.who} 完成 ${i.taskId}：${i.body.messages.at(-1).content.trim()}` })] };
  return { content: "完成" };
};

async function setup(script = defaultScript) {
  const home = tmpdir("at-home");
  const ws = tmpdir("at-ws");
  fs.writeFileSync(path.join(ws, "hello.txt"), "你好，团队");
  const llm = await mockLLM(script);
  const p = launch("agent-teams", { home });
  running.push(p);
  await p.call("at/settings/set", { workspace: ws, route: { provider: "mock", model: "mock-1", baseURL: llm.url, apiKey: "sk-test-key" } });
  return { p, ws, llm, home };
}

const PLAN = {
  name: "demo",
  description: "演示",
  members: [{ name: "alice", role: "researcher" }, { name: "bob", role: "engineer" }],
  tasks: [
    { ref: "read", subject: "读文件", assignee: "alice" },
    { subject: "总结", assignee: "bob", dependencies: ["read"] },
  ],
};

describe("agent-teams：状态与协议（纯逻辑）", () => {
  const mk = () => new Store(tmpdir("at-store"));
  const team = (s, extra = {}) => s.create({ name: "t", members: [{ name: "a" }, { name: "b" }], tasks: [{ subject: "一" }, { subject: "二", dependencies: [1] }], autoApprove: true, ...extra });

  it("依赖按序号 / ref / 标题解析，成环和不存在的依赖被拒", () => {
    const s = mk();
    const t = s.create({ name: "x", members: [{ name: "a" }], tasks: [{ ref: "r", subject: "A" }, { subject: "B", dependencies: ["r"] }, { subject: "C", dependencies: ["A", 2] }] });
    assert.deepEqual(t.tasks.map(k => k.dependencies), [[], ["t1"], ["t1", "t2"]]);
    assert.throws(() => s.create({ name: "y", members: [{ name: "a" }], tasks: [{ subject: "A", dependencies: ["B"] }, { subject: "B", dependencies: ["A"] }] }), /成环/);
    assert.throws(() => s.create({ name: "z", members: [{ name: "a" }], tasks: [{ subject: "A", dependencies: ["不存在"] }] }), /找不到依赖/);
    assert.throws(() => s.create({ name: "w", members: [{ name: "a" }], tasks: [{ subject: "A", assignee: "ghost" }] }), /不存在的成员/);
    assert.throws(() => s.create({ name: "v", members: [{ name: "captain" }] }), /不能叫/);
  });

  it("先待批准：没批准不能领任务，批准后依赖没完成的任务领不到", () => {
    const s = mk();
    const t = team(s, { autoApprove: false });
    assert.equal(t.phase, "staged");
    assert.throws(() => s.claimTask(t.id, "a"), /还没批准/);
    s.approve(t.id);
    assert.throws(() => s.claimTask(t.id, "b", "t2"), /还在等依赖/);
    const k = s.claimTask(t.id, "a");
    assert.equal(k.id, "t1");
    assert.equal(k.status, "claimed");
    assert.throws(() => s.claimTask(t.id, "a"), /还有没完成的任务/);
  });

  it("attemptId 校验：改派 / 修订 / 移除成员后旧尝试立刻失效", () => {
    const s = mk();
    const t = team(s);
    const k1 = s.claimTask(t.id, "a", "t1");
    const stale = k1.attemptId;
    const revoked = [];
    s.on("revoke", e => revoked.push(e));
    s.reassignTask(t.id, "t1", "b");
    assert.deepEqual(revoked.map(e => [e.member, e.taskId, e.reason]), [["a", "t1", "reassign"]]);
    assert.throws(() => s.updateTask(t.id, "a", { taskId: "t1", attemptId: stale, status: "completed", output: "x" }), /不属于你/);
    const k2 = s.claimTask(t.id, "b", "t1");
    assert.notEqual(k2.attemptId, stale);
    assert.throws(() => s.updateTask(t.id, "b", { taskId: "t1", attemptId: stale, status: "completed", output: "x" }), /已失效/);
    s.amendTask(t.id, "t1", { reason: "范围变了", description: "新的说明" });
    assert.equal(revoked.at(-1).reason, "amend");
    assert.throws(() => s.updateTask(t.id, "b", { taskId: "t1", attemptId: k2.attemptId, status: "completed", output: "x" }), /已失效/);
    assert.equal(s.task(t, "t1").revisions[0].previous.description, undefined);
    assert.throws(() => s.amendTask(t.id, "t1", { description: "没写原因" }), /reason/);
    const k3 = s.claimTask(t.id, "b", "t1");
    s.removeMember(t.id, "b");
    assert.equal(revoked.at(-1).reason, "member_removed");
    assert.equal(s.task(t, "t1").assignee, undefined);
    assert.equal(s.task(t, "t1").status, "pending");
    assert.throws(() => s.updateTask(t.id, "b", { taskId: "t1", attemptId: k3.attemptId, status: "completed", output: "x" }), /没有成员 b|不属于你/);
  });

  it("完成要写 output；依赖完成后后继任务才可领；队长可取消，终态不能再改", () => {
    const s = mk();
    const t = team(s);
    const k = s.claimTask(t.id, "a", "t1");
    assert.throws(() => s.updateTask(t.id, "a", { taskId: "t1", attemptId: k.attemptId, status: "completed" }), /output/);
    s.updateTask(t.id, "a", { taskId: "t1", attemptId: k.attemptId, status: "in_progress" });
    s.updateTask(t.id, "a", { taskId: "t1", attemptId: k.attemptId, status: "completed", output: "好了" });
    assert.equal(s.task(t, "t1").attemptId, undefined, "终态后 attemptId 清掉");
    assert.throws(() => s.updateTask(t.id, "a", { taskId: "t1", attemptId: k.attemptId, status: "failed", output: "x" }), /不能再改/);
    assert.equal(s.claimTask(t.id, "b").id, "t2");
    s.updateTask(t.id, "captain", { taskId: "t2", status: "cancelled", output: "不做了" });
    assert.equal(s.progress(t).finished, true);
    assert.deepEqual(s.blockedBy(t, s.task(t, "t2")), []);
  });

  it("依赖失败：后继任务标出被卡住，不会被领走", () => {
    const s = mk();
    const t = team(s);
    const k = s.claimTask(t.id, "a", "t1");
    s.updateTask(t.id, "a", { taskId: "t1", attemptId: k.attemptId, status: "failed", output: "崩了" });
    assert.deepEqual(s.summary(t).tasks[1].blockedBy, ["t1"]);
    assert.equal(s.summary(t).tasks[1].ready, false);
    assert.throws(() => s.claimTask(t.id, "b"), /没有可领的任务/);
  });

  it("暂停取消未完成任务，恢复后回到待办；信箱按收件人投递，读过不再出现", () => {
    const s = mk();
    const t = team(s);
    const k = s.claimTask(t.id, "a", "t1");
    s.halt(t.id);
    assert.deepEqual(t.tasks.map(x => x.status), ["cancelled", "cancelled"]);
    assert.throws(() => s.updateTask(t.id, "a", { taskId: "t1", attemptId: k.attemptId, status: "completed", output: "x" }), /不能再改/);
    s.resume(t.id);
    assert.deepEqual(t.tasks.map(x => x.status), ["pending", "pending"]);
    s.sendMessage(t.id, "a", "b", "你好");
    s.sendMessage(t.id, "user", "captain", "进度？");
    assert.equal(s.unread(t, "b").length, 1);
    assert.equal(s.takeUnread(t.id, "b")[0].content, "你好");
    assert.equal(s.takeUnread(t.id, "b").length, 0);
    assert.equal(s.unread(t, "captain").length, 1);
    assert.throws(() => s.sendMessage(t.id, "a", "ghost", "?"), /没有成员/);
  });

  it("冷恢复：重启后进行中的任务退回待办并作废旧尝试；团队文件重启后还在", () => {
    const dir = tmpdir("at-store");
    const s = new Store(dir);
    const t = team(s);
    const k = s.claimTask(t.id, "a", "t1");
    s.setMemberStatus(t, "a", "working");
    const s2 = new Store(dir);
    const t2 = s2.get(t.id);
    assert.equal(t2.tasks[0].status, "pending");
    assert.equal(t2.tasks[0].attempt, k.attempt + 1);
    assert.equal(t2.tasks[0].attemptId, undefined);
    assert.equal(t2.members[0].status, "idle");
  });
});

describe("agent-teams：工具和成员执行（假模型）", () => {
  it("14 个工具的名字和原项目一致，队长工具不带成员身份参数", async () => {
    const { p } = await setup();
    const { tools } = await p.call("mcp/tools");
    assert.deepEqual(tools.map(t => t.name), [
      "agent_teams_create", "agent_teams_approve", "agent_teams_edit_plan", "agent_teams_add_member", "agent_teams_remove_member", "agent_teams_create_task",
      "agent_teams_reassign_task", "agent_teams_claim_task", "agent_teams_update_task", "agent_teams_amend_task", "agent_teams_send_message", "agent_teams_status",
      "agent_teams_resume", "agent_teams_delete",
    ]);
    assert.equal(tools.find(t => t.name === "agent_teams_status").annotations.readOnlyHint, true);
  });

  it("创建只是待批准的方案，不会开工；批准后成员按依赖顺序干完，结果交给队长", async () => {
    const { p, llm } = await setup();
    const created = json(await p.tool("agent_teams_create", PLAN));
    assert.equal(created.created.phase, "staged");
    await new Promise(r => setTimeout(r, 300));
    assert.equal(llm.requests.length, 0, "没批准就不调模型");
    assert.match(created.next, /agent_teams_approve/);

    json(await p.tool("agent_teams_approve", {}));
    const st = await until(async () => {
      const s = json(await p.tool("agent_teams_status", { wait_seconds: 2 }));
      return s.team.progress.finished ? s : null;
    });
    assert.deepEqual(st.team.tasks.map(k => k.status), ["completed", "completed"]);
    assert.match(st.team.tasks[0].output, /alice 完成 t1：你好，团队/);
    assert.match(st.team.tasks[1].output, /bob 完成 t2/);
    assert.ok(st.hints.some(h => /汇总/.test(h)));
    // bob 的任务提示词里带着依赖任务 t1 的结果
    const bobFirst = llm.requests.find(r => r.who === "bob" && r.step === 0).first;
    assert.match(bobFirst, /依赖任务的结果/);
    assert.match(bobFirst, /alice 完成 t1/);
    // 成员用的是假接口给的路由，并记了用量
    const team = await p.call("at/get", { id: "demo" });
    assert.ok(team.members.every(m => m.usage.calls === 2 && m.usage.input === 200 && m.usage.output === 40), "读文件 + 提交结果两次调用，任务收尾后这一轮就结束");
    assert.ok(llm.requests.every(r => r.body.model === "mock-1"));
    assert.ok(team.activity.alice.some(a => a.kind === "tool" && /read_file/.test(a.text)));
  });

  it("成员只拿到 4 个协调工具 + 文件工具；readonly 成员没有写和执行", async () => {
    const { p, llm } = await setup();
    await p.tool("agent_teams_create", { ...PLAN, members: [{ name: "alice", toolPolicy: "readonly" }, { name: "bob" }], auto_approve: true });
    await until(() => llm.requests.some(r => r.who === "alice") && llm.requests.some(r => r.who === "bob"));
    const a = llm.requests.find(r => r.who === "alice").tools;
    const b = llm.requests.find(r => r.who === "bob").tools;
    assert.ok(!a.includes("write_file") && !a.includes("run_command"));
    assert.ok(a.includes("read_file") && a.includes("agent_teams_update_task"));
    assert.ok(b.includes("write_file") && b.includes("run_command"));
    assert.ok(!a.includes("agent_teams_create") && !a.includes("agent_teams_approve") && !a.includes("agent_teams_reassign_task"), "成员拿不到队长工具");
  });

  it("写文件要先确认：拒绝则没写，允许才写；路径不能跳出工作区", async () => {
    let denied = true;
    const { p, ws } = await setup(i => {
      if (i.step === 0) return { calls: [callOf("write_file", { path: "out/a.txt", content: "hi" })] };
      if (i.step === 1) return { calls: [callOf("read_file", { path: "../secret.txt" }, "c2")] };
      if (i.step === 2) return { calls: [callOf("agent_teams_update_task", { taskId: i.taskId, status: "completed", output: `写入结果：${i.body.messages.filter(m => m.role === "tool")[0].content}｜越界：${i.body.messages.filter(m => m.role === "tool")[1].content}` })] };
      return { content: "完成" };
    });
    await p.tool("agent_teams_create", { name: "w", members: [{ name: "a" }], tasks: [{ subject: "写文件" }], auto_approve: true });
    const ap = await until(async () => (await p.call("at/get", { id: "w" })).approvals[0]);
    assert.equal(ap.kind, "write");
    assert.equal(ap.detail.path, "out/a.txt");
    await p.call("at/approval", { id: ap.id, allow: !denied });
    const st = await until(async () => {
      const s = json(await p.tool("agent_teams_status", { wait_seconds: 2 }));
      return s.team.progress.finished ? s : null;
    });
    assert.match(st.team.tasks[0].output, /用户拒绝了这次写入/);
    assert.match(st.team.tasks[0].output, /路径不在工作区内/);
    assert.equal(fs.existsSync(path.join(ws, "out", "a.txt")), false);

    // 同一个成员再来一个任务，这次允许
    denied = false;
    await p.tool("agent_teams_create_task", { teamId: "w", subject: "再写一次" });
    const ap2 = await until(async () => (await p.call("at/get", { id: "w" })).approvals[0]);
    await p.call("at/approval", { id: ap2.id, allow: true });
    await until(() => fs.existsSync(path.join(ws, "out", "a.txt")));
    assert.equal(fs.readFileSync(path.join(ws, "out", "a.txt"), "utf8"), "hi");
  });

  it("「全部允许」免确认：命令直接执行", async () => {
    const { p } = await setup(i => {
      if (i.step === 0) return { calls: [callOf("run_command", { command: "node -e \"process.stdout.write('ran')\"" })] };
      if (i.step === 1) return { calls: [callOf("agent_teams_update_task", { taskId: i.taskId, status: "completed", output: `${i.who} 做完 ${i.body.messages.at(-1).content.trim()}` })] };
      return { content: "完成" };
    });
    await p.tool("agent_teams_create", { name: "g", members: [{ name: "slow" }], tasks: [{ subject: "跑命令" }] });
    await p.call("at/allow-all", { id: "g", on: true });
    await p.tool("agent_teams_approve", {});
    const st = await until(async () => {
      const s = json(await p.tool("agent_teams_status", { wait_seconds: 2 }));
      return s.team.progress.finished ? s : null;
    });
    assert.match(st.team.tasks[0].output, /slow 做完 ran/, "没有确认弹窗也执行了命令");
    assert.equal((await p.call("at/get", { id: "g" })).approvals.length, 0);
  });

  it("改派时在跑的成员被中止，旧尝试作废，新负责人接着做", async () => {
    let release;
    const gate = new Promise(r => (release = r));
    const { p, llm } = await setup(i => {
      if (i.who === "slow") return gate.then(() => ({ content: "太迟了" }));
      return defaultScript(i);
    });
    await p.tool("agent_teams_create", { name: "ra", members: [{ name: "slow" }, { name: "fast" }], tasks: [{ subject: "活", assignee: "slow" }], auto_approve: true });
    await until(() => llm.requests.some(r => r.who === "slow"));
    assert.equal((await p.call("at/get", { id: "ra" })).members.find(m => m.name === "slow").status, "working");
    await p.tool("agent_teams_reassign_task", { taskId: "t1", assignee: "fast" });
    const st = await until(async () => {
      const s = json(await p.tool("agent_teams_status", { wait_seconds: 2 }));
      return s.team.progress.finished ? s : null;
    });
    assert.equal(st.team.tasks[0].assignee, "fast");
    assert.match(st.team.tasks[0].output, /fast 完成 t1/);
    assert.ok(st.team.tasks[0].attempt >= 3, "slow 的尝试 + 改派 + fast 的尝试，代次一路递增");
    assert.equal((await p.call("at/get", { id: "ra" })).members.find(m => m.name === "slow").status, "idle", "被中止的成员回到空闲");
    release();
    await new Promise(r => setTimeout(r, 200));
    assert.equal((await p.call("at/get", { id: "ra" })).tasks[0].status, "completed", "slow 迟到的回复不会改动结果");
  });

  it("未指派的任务谁空闲谁领；暂停后不再调度，恢复后继续", async () => {
    const { p, llm } = await setup();
    await p.tool("agent_teams_create", { name: "h", members: [{ name: "a" }], tasks: [{ subject: "一" }] });
    await p.call("at/halt", { id: "h" });
    await p.tool("agent_teams_approve", { teamId: "h" });
    await new Promise(r => setTimeout(r, 400));
    assert.equal(llm.requests.length, 0, "暂停中不调度");
    const resumed = json(await p.tool("agent_teams_resume", { teamId: "h" }));
    assert.equal(resumed.halted, false);
    const st = await until(async () => {
      const s = json(await p.tool("agent_teams_status", { teamId: "h", wait_seconds: 2 }));
      return s.team.progress.finished ? s : null;
    });
    assert.equal(st.team.tasks[0].assignee, "a");
    assert.equal(st.team.tasks[0].status, "completed");
  });

  it("模型接口出错：任务标失败并写明原因；key 不会出现在错误里", async () => {
    const { p } = await setup(() => ({ content: undefined, calls: undefined }));
    // 把接口指到一个必然 401 的地址：直接改成关掉的端口
    await p.call("at/settings/set", { route: { provider: "dead", model: "m", baseURL: "http://127.0.0.1:9", apiKey: "sk-secret-123" } });
    await p.tool("agent_teams_create", { name: "e", members: [{ name: "a" }], tasks: [{ subject: "一" }], auto_approve: true });
    const t = await until(async () => {
      const s = await p.call("at/get", { id: "e" });
      return s.tasks[0].status === "failed" ? s : null;
    }, 20000);
    assert.match(t.tasks[0].output, /执行出错/);
    assert.ok(!JSON.stringify(t).includes("sk-secret-123"));
    assert.ok(!JSON.stringify(await p.call("at/settings")).includes("sk-secret-123"), "设置接口不回传 key");
    assert.equal((await p.call("at/settings")).route.hasKey, true);
  });

  it("成员没调用 update_task：按最后一次回复代交；一句话都没有就算失败", async () => {
    const { p } = await setup(i => (i.who === "talker" ? { content: "我直接说结果：42" } : { content: "" }));
    await p.tool("agent_teams_create", { name: "f", members: [{ name: "talker" }, { name: "mute" }], tasks: [{ subject: "说", assignee: "talker" }, { subject: "哑", assignee: "mute" }], auto_approve: true });
    const t = await until(async () => {
      const s = await p.call("at/get", { id: "f" });
      return s.progress.finished ? s : null;
    });
    assert.equal(t.tasks[0].status, "completed");
    assert.match(t.tasks[0].output, /我直接说结果：42/);
    assert.equal(t.tasks[1].status, "failed");
    assert.match(t.tasks[1].output, /没有产出/);
  });

  it("成员之间发消息会唤醒空闲的收件人；用户的消息队长在 status 里取走", async () => {
    const { p, llm } = await setup(i => {
      if (i.who === "sender" && i.step === 0) return { calls: [callOf("agent_teams_send_message", { to: "listener", content: "先别动手，等我的结果" })] };
      if (i.who === "sender" && i.step === 1) return { calls: [callOf("agent_teams_update_task", { taskId: i.taskId, status: "completed", output: "发完了" }, "c2")] };
      if (i.who === "listener") return { content: "收到" };
      return { content: "完成" };
    });
    await p.tool("agent_teams_create", { name: "m", members: [{ name: "sender" }, { name: "listener" }], tasks: [{ subject: "发消息", assignee: "sender" }], auto_approve: true });
    await until(() => llm.requests.some(r => r.who === "listener" && /先别动手/.test(r.first)));
    await p.call("at/send", { id: "m", to: "captain", content: "进度怎么样？" });
    const s = json(await p.tool("agent_teams_status", { wait_seconds: 1 }));
    assert.deepEqual(s.messages.map(m => [m.from, m.content]), [["user", "进度怎么样？"]]);
    const again = json(await p.tool("agent_teams_status", {}));
    assert.deepEqual(again.messages, [], "读过的消息不会重复出现");
  });

  it("重启后团队还在：进行中的任务作废旧尝试，重新调度并做完", async () => {
    let hang = true;
    const { p, home } = await setup(i => (hang ? new Promise(() => {}) : defaultScript(i)));
    await p.tool("agent_teams_create", { name: "r", members: [{ name: "a" }], tasks: [{ subject: "一" }], auto_approve: true });
    await until(async () => (await p.call("at/get", { id: "r" })).tasks[0].status === "claimed");
    p.stop();
    hang = false;
    const p2 = launch("agent-teams", { home });
    running.push(p2);
    const t = await until(async () => {
      const s = await p2.call("at/get", { id: "r" });
      return s.progress.finished ? s : null;
    });
    assert.equal(t.tasks[0].status, "completed");
    assert.equal(t.tasks[0].attempt, 3, "第一次尝试 → 重启作废 → 第二次尝试");
  });

  it("归档后可恢复，永久删除后团队目录消失", async () => {
    const { p, home } = await setup();
    await p.tool("agent_teams_create", { name: "d", members: [{ name: "a" }] });
    await p.tool("agent_teams_delete", { teamId: "d" });
    const l = await p.call("at/list");
    assert.equal(l.teams.length, 0);
    assert.equal(l.archived[0].id, "d");
    await p.call("at/restore", { id: "d" });
    assert.equal((await p.call("at/list")).teams.length, 1);
    await p.call("at/delete", { id: "d" });
    assert.equal(fs.existsSync(path.join(home, "plugin-data", "agent-teams", "teams", "d")), false);
  });

  it("待批准阶段可整体改方案，运行中不行；多个团队不传 teamId 会提示", async () => {
    const { p } = await setup();
    await p.tool("agent_teams_create", { name: "e1", members: [{ name: "a" }], tasks: [{ subject: "一" }] });
    const edited = json(await p.tool("agent_teams_edit_plan", { members: [{ name: "a" }, { name: "b" }], tasks: [{ subject: "新一", assignee: "b" }] }));
    assert.deepEqual(edited.members.map(m => m.name), ["a", "b"]);
    assert.equal(edited.tasks[0].subject, "新一");
    await p.tool("agent_teams_create", { name: "e2", members: [{ name: "a" }] });
    const r = await p.tool("agent_teams_status", {});
    assert.equal(r.isError, true);
    assert.match(r.text, /多个团队/);
    await p.call("at/halt", { id: "e1" });
    await p.tool("agent_teams_approve", { teamId: "e1" });
    const r2 = await p.tool("agent_teams_edit_plan", { teamId: "e1", description: "x" });
    assert.equal(r2.isError, true);
    assert.match(r2.text, /只有待批准/);
  });
});
