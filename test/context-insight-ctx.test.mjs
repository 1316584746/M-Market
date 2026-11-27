import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { launch, tmpdir } from "./helpers.mjs";

const running = [];
after(() => running.forEach(p => p.stop()));

const ev = (runId, ts, event) => JSON.stringify({ ts, runId, event });
const now = Date.now();

// ───────── 外部 Agent（Cursor）：两次运行，第二次「沿用上一轮」──────────
const cur = tmpdir("ci-ctx-cursor");
fs.writeFileSync(path.join(cur, "harness.config.json"), JSON.stringify({ traceDir: ".traces", providers: { cur: { type: "cursor-sdk", apiKey: "x" } } }));
fs.mkdirSync(path.join(cur, ".traces"));
{
  const t = now - 600000;
  const P = (id, ts, kind, line) => ev(id, ts, { type: "agent_progress", kind, line });
  fs.writeFileSync(path.join(cur, ".traces", "r1.jsonl"), [
    ev("r1", t, { type: "run_start", runId: "r1", provider: "cur", input: "查一下日志" }),
    P("r1", t + 100, "status", "正在创建 Cursor Agent（模型 composer-2）"),
    P("r1", t + 200, "status", "开始运行"),
    P("r1", t + 1200, "thinking", "先看看日志在哪"),
    P("r1", t + 1500, "thinking", "应该在项目根目录"),
    P("r1", t + 2000, "tool", '🔧 read {"path":"E:\\\\proj\\\\app.log"}'),
    P("r1", t + 2300, "tool", '   ✓ read → {"status":"success","value":{"content":"boom"}}'),
    P("r1", t + 3000, "text", "找到了，再跑一下测试"),
    P("r1", t + 3500, "tool", '🔧 shell {"command":"npm test","workingDirectory":"E:\\\\proj"}'),
    P("r1", t + 5500, "tool", '   ✓ shell → {"status":"success","value":{"exitCode":1,"stdout":"fail"}}'),
    P("r1", t + 5600, "tool", '🔧 task {"description":"并行查依赖","subagent_type":"explore","prompt":"看 package.json"}'),
    P("r1", t + 7600, "tool", '   ✓ task → {"status":"success","value":{"text":"done"}}'),
    P("r1", t + 8000, "text", "测试挂了，原因是依赖"),
    ev("r1", t + 8100, { type: "done", reason: "final", text: "测试挂了，原因是依赖" }),
  ].join("\n") + "\n");
  const u = t + 60000;
  fs.writeFileSync(path.join(cur, ".traces", "r2.jsonl"), [
    ev("r2", u, { type: "run_start", runId: "r2", provider: "cur", input: "那怎么修" }),
    P("r2", u + 100, "status", "沿用上一轮的 Cursor 会话"),
    P("r2", u + 200, "status", "开始运行"),
    P("r2", u + 900, "text", "升级依赖就行"),
    ev("r2", u + 1000, { type: "done", reason: "final", text: "升级依赖就行" }),
  ].join("\n") + "\n");
}

// ───────── 模型 trace：压缩事件、两步 ──────────
const mdl = tmpdir("ci-ctx-model");
fs.writeFileSync(path.join(mdl, "harness.config.json"), JSON.stringify({ traceDir: ".traces", limits: { contextTokens: 8000 }, providers: { ds: { type: "openai", model: "deepseek-chat" } } }));
fs.mkdirSync(path.join(mdl, ".traces"));
{
  const t = now - 300000;
  const sys = { role: "system", content: "你是助手。" + "规则".repeat(50) };
  const usr = { role: "user", content: "读一下 a.txt" };
  const call = { id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } };
  fs.writeFileSync(path.join(mdl, ".traces", "m1.jsonl"), [
    ev("m1", t, { type: "run_start", runId: "m1", provider: "ds", input: "读一下 a.txt" }),
    ev("m1", t + 10, { type: "model_call", step: 1, messages: [sys, usr] }),
    ev("m1", t + 800, { type: "model_reply", step: 1, ms: 700, reply: { message: { role: "assistant", content: "", tool_calls: [call] }, usage: { input: 400, output: 20, total: 420 } } }),
    ev("m1", t + 810, { type: "tool_call", step: 1, name: "read_file", args: { path: "a.txt" } }),
    ev("m1", t + 900, { type: "tool_result", step: 1, name: "read_file", output: "文件内容".repeat(30), ms: 80 }),
    ev("m1", t + 910, { type: "context_trim", before: 900, after: 600, dropped: 2 }),
    ev("m1", t + 920, { type: "model_call", step: 2, messages: [sys, usr, { role: "assistant", content: "", tool_calls: [call] }, { role: "tool", tool_call_id: "c1", content: "文件内容".repeat(30) }] }),
    ev("m1", t + 1500, { type: "model_reply", step: 2, ms: 500, reply: { message: { role: "assistant", content: "内容是…" }, usage: { input: 700, output: 30, total: 730 } } }),
    ev("m1", t + 1510, { type: "done", reason: "final", text: "内容是…" }),
  ].join("\n") + "\n");
}

describe("context-insight 0.4：分步上下文", () => {
  it("外部 Agent：续接的运行合成一个对话，按步拆开，带文件 / 命令 / 子 Agent", async () => {
    const p = launch("context-insight", { home: cur });
    running.push(p);
    const list = await p.call("session/list", {});
    assert.equal(list.length, 1, "沿用上一轮的运行并进同一个对话");
    assert.equal(list[0].turns, 2);
    const d = await p.call("session/get", { name: list[0].name });
    const c = d.ctx;
    assert.equal(c.agent, true);
    assert.equal(c.turns.length, 2);
    assert.ok(c.steps.length >= 3, "第一轮的读文件 / 命令 / 子 Agent 各一步，第二轮一步");
    assert.deepEqual([...new Set(c.steps.map(s => s.turn))], [1, 2]);
    // 窗口构成累计增长，增量等于相邻两步的差
    for (let i = 1; i < c.steps.length; i++) {
      const sum = o => Object.values(o).reduce((n, v) => n + v, 0);
      assert.ok(sum(c.steps[i].comp) >= sum(c.steps[i - 1].comp), "累计不会变小");
    }
    assert.ok(c.steps.every(s => s.estimated), "外部 Agent 的数字都是估算");
    assert.equal(c.files.length, 1);
    assert.equal(c.files[0].read, 1);
    assert.match(c.files[0].path, /app\.log$/);
    assert.equal(c.commands.runs.length, 1);
    assert.equal(c.commands.runs[0].program, "npm");
    assert.equal(c.commands.runs[0].exit, 1);
    assert.equal(c.commands.runs[0].ms, 2000);
    assert.equal(c.subagents.length, 1);
    assert.equal(c.subagents[0].type, "explore");
    assert.match(c.subagents[0].desc, /并行查依赖/);
    assert.equal(c.subagents[0].ms, 2000);
    assert.ok(c.summary.timing.tools >= 4000, "工具执行时间来自 ✓ 行的时间戳");
    assert.ok(c.summary.timing.ttft > 0 && c.summary.timing.reasoning > 0);
    assert.equal(d.turns, 2);
    assert.equal(d.runs.length, 2);
  });

  it("设置里关掉合并：每次运行单独一个会话", async () => {
    const h = tmpdir("ci-ctx-nomerge");
    fs.cpSync(cur, h, { recursive: true });
    const p = launch("context-insight", { home: h });
    running.push(p);
    await p.call("prefs/set", { merge: false });
    const list = await p.call("session/list", {});
    assert.equal(list.length, 2);
    assert.ok(list.every(r => r.turns === 1));
  });

  it("session/items：重建某一步的上下文条目，累计 / 增量", async () => {
    const p = launch("context-insight", { home: cur });
    running.push(p);
    const [s] = await p.call("session/list", {});
    const d = await p.call("session/get", { name: s.name });
    const last = d.ctx.steps[d.ctx.steps.length - 1].n;
    const all = await p.call("session/items", { name: s.name, step: last, mode: "total" });
    const cats = new Set(all.items.map(i => i.cat));
    assert.ok(cats.has("user") && cats.has("assistant") && cats.has("results"));
    assert.ok(all.items.every(i => i.tokens >= 0 && typeof i.pos === "number"));
    const delta = await p.call("session/items", { name: s.name, step: last, mode: "delta" });
    assert.ok(delta.items.length < all.items.length, "增量只有这一步新增的");
    await assert.rejects(() => p.call("session/items", { name: "../x", step: 1, mode: "total" }));
  });

  it("模型 trace：真实用量、压缩事件、条目来自 model_call 的消息", async () => {
    const p = launch("context-insight", { home: mdl });
    running.push(p);
    const [s] = await p.call("session/list", {});
    const d = await p.call("session/get", { name: s.name });
    const c = d.ctx;
    assert.equal(c.agent, false);
    assert.equal(c.window, 8000);
    assert.equal(c.steps.length, 2);
    assert.equal(c.steps[0].actual.prompt, 400, "有真实用量就用真实值");
    assert.equal(c.steps[1].actual.prompt, 700);
    assert.ok(c.steps[1].comp.results > 0 && c.steps[1].delta.results > 0, "第二步新增了工具结果");
    assert.ok(c.events.some(e => e.type === "trim" && e.before === 900 && e.after === 600 && e.dropped === 2));
    assert.equal(c.summary.events.trim, 1);
    const it = await p.call("session/items", { name: s.name, step: 2, mode: "total" });
    assert.ok(it.items.some(i => i.cat === "system"), "模型 trace 里有系统提示词");
    assert.ok(it.items.some(i => i.cat === "results" && i.isNew), "这一步新增的工具结果带 isNew");
    assert.ok(it.items.some(i => i.cat === "user" && /a\.txt/.test(i.text)));
  });
});
