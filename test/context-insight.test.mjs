import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { ROOT, launch, tmpdir } from "./helpers.mjs";

const running = [];
const start = o => {
  const p = launch("context-insight", o);
  running.push(p);
  return p;
};
after(() => running.forEach(p => p.stop()));

const DAY = 86400000;
const now = Date.now();
const ev = (runId, ts, event) => JSON.stringify({ ts, runId, event });

const home = tmpdir("ci2");
fs.writeFileSync(
  path.join(home, "harness.config.json"),
  JSON.stringify({ traceDir: ".traces", limits: { contextTokens: 8000 }, providers: { ds: { type: "openai", model: "deepseek-chat" }, cur: { type: "cursor-sdk", model: "composer" } } }),
);
const traces = path.join(home, ".traces");
fs.mkdirSync(traces);

// 会话 A：今天，deepseek，读文件 + 调技能 + 命令（成功 / 失败）+ 被拦截 + 压缩
{
  const t0 = now - 60000;
  const sys = { role: "system", content: "你是助手" };
  const usr = { role: "user", content: "帮我重构登录模块" };
  const calls = [
    { id: "1", name: "use_skill", args: { name: "refactor" } },
    { id: "2", name: "read_file", args: { path: "src/login.ts" } },
    { id: "3", name: "run_command", args: { command: "npm test" } },
  ];
  const asst = { role: "assistant", content: "", toolCalls: calls };
  const lines = [
    ev("a", t0, { type: "run_start", runId: "a", provider: "ds", input: "帮我重构登录模块" }),
    ev("a", t0 + 1, { type: "model_call", step: 1, messages: [sys, usr] }),
    ev("a", t0 + 2, { type: "model_reply", step: 1, ms: 700, tokens: 1100, reply: { message: asst, toolCalls: calls, usage: { input: 1000, output: 100, total: 1100 } } }),
    ev("a", t0 + 3, { type: "tool_call", step: 1, name: "use_skill", args: { name: "refactor" } }),
    ev("a", t0 + 4, { type: "tool_result", step: 1, name: "use_skill", output: "# 重构技能\n".repeat(50), ms: 3 }),
    ev("a", t0 + 5, { type: "tool_call", step: 1, name: "read_file", args: { path: "src/login.ts" } }),
    ev("a", t0 + 6, { type: "tool_result", step: 1, name: "read_file", output: "x".repeat(4000), ms: 10 }),
    ev("a", t0 + 7, { type: "tool_call", step: 1, name: "run_command", args: { command: "npm test" } }),
    ev("a", t0 + 8, { type: "tool_result", step: 1, name: "run_command", output: "exit=1\nFAIL", ms: 900 }),
    ev("a", t0 + 9, { type: "tool_blocked", step: 1, name: "run_command", reason: "rm -rf 被拦截" }),
    ev("a", t0 + 10, { type: "context_trim", before: 5000, after: 2000, dropped: 4 }),
    ev("a", t0 + 11, {
      type: "model_call",
      step: 2,
      messages: [sys, usr, asst, { role: "tool", content: "# 重构技能\n".repeat(50), toolCallId: "1" }, { role: "tool", content: "x".repeat(4000), toolCallId: "2" }, { role: "tool", content: "exit=1\nFAIL", toolCallId: "3" }],
    }),
    ev("a", t0 + 12, { type: "model_reply", step: 2, ms: 600, tokens: 2700, reply: { message: { role: "assistant", content: "已完成重构" }, usage: { input: 2500, output: 200, total: 2700 } } }),
    ev("a", t0 + 13, { type: "done", reason: "final", text: "已完成重构" }),
  ];
  fs.writeFileSync(path.join(traces, "20260101-120000-aaaa.jsonl"), lines.join("\n") + "\n");
}
// 会话 B：3 天前，没有用量字段（走估算）
{
  const t0 = now - 3 * DAY;
  const lines = [
    ev("b", t0, { type: "run_start", runId: "b", provider: "ds", input: "写个周报" }),
    ev("b", t0 + 1, { type: "model_call", step: 1, messages: [{ role: "system", content: "s" }, { role: "user", content: "写个周报" }] }),
    ev("b", t0 + 2, { type: "model_reply", step: 1, ms: 300, tokens: 50, reply: { message: { role: "assistant", content: "好的，这是周报……" } } }),
    ev("b", t0 + 3, { type: "done", reason: "final", text: "ok" }),
  ];
  fs.writeFileSync(path.join(traces, "20260102-120000-bbbb.jsonl"), lines.join("\n") + "\n");
}
// 会话 C：今天，外部 Agent，只有进度事件
{
  const t0 = now - 30000;
  const lines = [
    ev("c", t0, { type: "run_start", runId: "c", provider: "cur", input: "agent task" }),
    ev("c", t0 + 1, { type: "agent_progress", kind: "thinking", line: "分析中" }),
    ev("c", t0 + 2, { type: "agent_progress", kind: "tool", line: "read a.ts" }),
    ev("c", t0 + 3, { type: "done", reason: "final", text: "ok" }),
  ];
  fs.writeFileSync(path.join(traces, "20260103-120000-cccc.jsonl"), lines.join("\n") + "\n");
}
// 让 A 最新、B 最旧
fs.utimesSync(path.join(traces, "20260102-120000-bbbb.jsonl"), new Date(now - 3 * DAY), new Date(now - 3 * DAY));

describe("context-insight 0.2：洞察总览", () => {
  it("今天：只包含今天有调用的会话，KPI 与成本正确", async () => {
    const p = start({ home });
    const o = await p.call("insights/overview", { range: "today" });
    assert.equal(o.kpi.sessions, 2, "A 和外部 Agent C");
    // 外部 Agent C 没有真实用量，按提示词 + 过程文本估算（单独验证），这里在 A 的真实用量上叠加它
    const ag = (await p.call("session/get", { name: "20260103-120000-cccc" })).stats;
    assert.ok(ag.billed > 0 && ag.billed < 100, "Agent 估算的是一小段文本");
    assert.equal(o.kpi.tokens, 3800 + ag.billed);
    assert.equal(o.kpi.input, 3500 + ag.input);
    assert.equal(o.kpi.output, 300 + ag.output);
    assert.equal(o.kpi.steps, 3);
    assert.equal(o.kpi.agentSessions, 1);
    assert.equal(o.kpi.toolExec, 3);
    assert.equal(o.kpi.cacheHit, null);
    // A 用 deepseek-chat：0.27 / 1.10；C 是 cursor-sdk（composer）：1.25 / 10 美元每百万
    assert.ok(Math.abs(o.kpi.cost - ((3500 * 0.27 + 300 * 1.1) + (ag.input * 1.25 + ag.output * 10)) / 1e6) < 1e-9);
    assert.equal(o.week.length, 7);
    assert.equal(o.week[6].tokens, 3800 + ag.billed);
    assert.ok(o.heat.length >= 50 && o.heat.length <= 56);
    assert.equal(o.contextLimit, 8000);
  });

  it("排行：技能 / 工具 / 命令", async () => {
    const p = start({ home });
    const o = await p.call("insights/overview", { range: "today" });
    assert.equal(o.skills[0].name, "refactor");
    assert.deepEqual(new Set(o.tools.map(x => x.name)), new Set(["use_skill", "read_file", "run_command"]));
    assert.ok(o.commands.some(c => c.name === "npm"));
    assert.ok(o.comp.skill > 0 && o.comp.toolcalls > 0 && o.comp.system > 0 && o.comp.answers > 0);
    // 外部 Agent 的 thinking 进度行按估算计入 reasoning（夹具里有 1 个 cursor-sdk 会话）
    assert.ok(o.comp.reasoning > 0);
  });

  it("7 天范围包含估算的会话；30 天一致", async () => {
    const p = start({ home });
    const o = await p.call("insights/overview", { range: "7" });
    assert.equal(o.kpi.sessions, 3);
    const b = o.sessions.find(s => s.input === "写个周报");
    assert.ok(b && b.tokens > 0 && b.ctxEstimated);
    assert.equal((await p.call("insights/overview", { range: "30" })).kpi.sessions, 3);
  });

  it("筛选：按工具 / 技能 / 命令 / 搜索 / 按天", async () => {
    const p = start({ home });
    assert.equal((await p.call("insights/overview", { range: "7", tool: "read_file" })).kpi.sessions, 1);
    assert.equal((await p.call("insights/overview", { range: "7", skill: "refactor" })).sessions[0].input, "帮我重构登录模块");
    assert.equal((await p.call("insights/overview", { range: "7", command: "npm" })).kpi.sessions, 1);
    assert.equal((await p.call("insights/overview", { range: "7", q: "周报" })).kpi.sessions, 1);
    assert.equal((await p.call("insights/overview", { range: "7", q: "不存在的词zzz" })).kpi.sessions, 0);
    const d = new Date(now - 3 * DAY);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const o = await p.call("insights/overview", { day });
    assert.equal(o.kpi.sessions, 1);
    assert.equal(o.range, "day");
  });

  it("排序：按 Token 用量", async () => {
    const p = start({ home });
    const o = await p.call("insights/overview", { range: "7", sort: "tokens" });
    assert.ok(o.sessions[0].tokens >= o.sessions[1].tokens);
  });
});

describe("context-insight 0.2：会话详情", () => {
  const name = "20260101-120000-aaaa";
  it("Context 详情：构成 / 走势 / 事件 / 命令 / 文件 / 成本", async () => {
    const p = start({ home });
    const d = await p.call("session/get", { name });
    assert.equal(d.model, "deepseek-chat");
    assert.equal(d.stats.steps, 2);
    assert.equal(d.stats.billed, 3800);
    assert.equal(d.stats.trims, 1);
    assert.equal(d.stats.files.read, 1);
    assert.equal(d.current.tokens, 2500);
    assert.equal(Math.round(d.current.pct), Math.round((2500 / 8000) * 100));
    assert.equal(d.trend.length, 2);
    assert.equal(d.trend[1].trimmed, true);
    assert.equal(d.trend[0].trimmed, false);
    assert.equal(d.skills[0].name, "refactor");
    const npm = d.commands.programs.find(x => x.program === "npm");
    assert.equal(npm.count, 1);
    assert.equal(npm.fails, 1);
    assert.equal(d.commands.runs.find(r => r.program === "npm").exit, 1);
    assert.ok(d.events.some(e => e.type === "blocked"));
    assert.equal(d.files[0].path, "src/login.ts");
    assert.ok(d.stats.cost > 0);
    // 构成按真实用量缩放：各类之和 ≈ 计费 token
    const sum = Object.values(d.tokens.comp).reduce((n, v) => n + v, 0);
    assert.ok(Math.abs(sum - 3800) < 5, `构成之和 ${sum} 应接近 3800`);
    assert.equal(d.tokens.cacheHit, null);
  });

  it("外部 Agent：进度事件进 fleet", async () => {
    const p = start({ home });
    const d = await p.call("session/get", { name: "20260103-120000-cccc" });
    assert.equal(d.agent, true);
    assert.equal(d.fleet.counts.thinking, 1);
    assert.equal(d.fleet.last[0].kind, "tool");
    // 外部 Agent 不回传用量：按提示词 + 过程文本估算，单价取设置里这个提供方的模型（cursor-sdk 的 composer）
    assert.equal(d.agentEstimate, true);
    assert.equal(d.model, "composer");
    assert.deepEqual([d.price.in, d.price.out], [1.25, 10]);
    assert.ok(d.stats.input > 0 && d.stats.output > 0);
    assert.equal(d.stats.billed, d.stats.input + d.stats.output);
    assert.ok(Math.abs(d.stats.cost - (d.stats.input * 1.25 + d.stats.output * 10) / 1e6) < 1e-12);
    assert.equal(d.stats.estimated, true);
  });

  it("某一步的消息带类别", async () => {
    const p = start({ home });
    const m = await p.call("session/messages", { name, step: 2 });
    assert.equal(m.length, 6);
    assert.equal(m[0].cat, "system");
    assert.equal(m[3].cat, "skill");
    assert.equal(m[4].cat, "toolcalls");
    assert.equal(m[4].tool, "read_file");
  });

  it("拒绝越出目录", async () => {
    const p = start({ home });
    await assert.rejects(p.call("session/get", { name: "../harness.config" }), /不合法/);
  });
});

describe("context-insight 0.2：设置与价格", () => {
  it("自定义单价覆盖内置；非法正则被忽略；偏好持久化", async () => {
    const h = tmpdir("ci3");
    fs.cpSync(home, h, { recursive: true });
    const p = start({ home: h });
    let r = await p.call("prefs/set", { range: "30", sort: "tokens", group: "provider", lang: "en", prices: [{ match: "deepseek", in: 1, out: 2 }, { match: "(", in: 9, out: 9 }, { match: "", in: 1, out: 1 }] });
    assert.equal(r.range, "30");
    assert.equal(r.prices.length, 2, "空名字被丢弃，坏正则保留但不生效");
    const g = await p.call("prefs/get");
    assert.equal(g.lang, "en");
    assert.equal(g.sort, "tokens");
    assert.ok(g.builtin.length > 5);
    const d = await p.call("session/get", { name: "20260101-120000-aaaa" });
    assert.equal(d.price.custom, true);
    assert.ok(Math.abs(d.stats.cost - (3500 * 1 + 300 * 2) / 1e6) < 1e-9);
    const o = await p.call("insights/overview", {});
    assert.equal(o.range, "30", "没传 range 时用保存的默认值");
    r = await p.call("prefs/set", { range: "bogus" });
    assert.equal(r.range, "7");
  });

  it("AI 工具：context_overview / context_stats 含成本与技能", async () => {
    const p = start({ home });
    const o = await p.tool("context_overview", { range: "7" });
    assert.match(o.text, /3 个会话/);
    assert.match(o.text, /read_file/);
    assert.match(o.text, /refactor/);
    const s = await p.tool("context_stats", { run: "20260101-120000-aaaa" });
    assert.match(s.text, /估算成本/);
    assert.match(s.text, /npm×1（失败 1）/);
  });
});

describe("context-insight 0.2：界面", () => {
  const ui = path.join(ROOT, "plugins", "context-insight", "ui");
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/).map(l => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/ .*$/, "")).join("\n");
  const CJK = /[\u3000-\u9fff]/;

  it("中文原文都在英文词典里，占位符一致，且没有漏网的中文", () => {
    const dict = new Function("window", fs.readFileSync(path.join(ui, "i18n.js"), "utf8") + ";return window.CI_EN;")({});
    let src = strip(fs.readFileSync(path.join(ui, "app.js"), "utf8"));
    const keys = new Set();
    src = src.replace(/\bt\("((?:[^"\\\n]|\\.)*)"/g, (m, k) => (keys.add(k), 't("'));
    src = src.replace(/\["\w+", "([^"]+)", "#/g, (m, k) => (keys.add(k), '["x", "#'));
    src = src.replace(/\b\w+: "([^"]*[\u3000-\u9fff][^"]*)"/g, (m, k) => (keys.add(k), 'x: "'));
    const stray = src.split("\n").filter(l => CJK.test(l));
    assert.deepEqual(stray, [], "还有没走 t() 的中文");
    const missing = [...keys].filter(k => CJK.test(k) && dict[k] == null);
    assert.deepEqual(missing, [], "英文词典缺这些词条");
    const ph = s => (s.match(/\{\d\}/g) || []).sort().join();
    for (const k of keys) if (dict[k] != null) assert.equal(ph(dict[k]), ph(k), `占位符不一致：${k}`);
    // 后端会抛出的错误信息也要有译文
    for (const k of ["没有找到 trace 目录", "trace 名字不合法", "找不到这个 trace", "这个目录不存在"]) assert.ok(dict[k], k);
  });

  it("入口页引用的文件都在", () => {
    const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
    for (const f of ["style.css", "i18n.js", "app.js"]) {
      assert.ok(html.includes(f), f);
      assert.ok(fs.existsSync(path.join(ui, f)), f);
    }
  });
});

describe("context-insight：外部 Agent 的费用跟设置里的提供方走", () => {
  const h = tmpdir("ci-agents");
  fs.writeFileSync(
    path.join(h, "harness.config.json"),
    JSON.stringify({
      traceDir: ".traces",
      providers: {
        sdk: { type: "cursor-sdk", apiKey: "x" }, // 没填 model：和 M-Harness 一样按 composer-2
        codex: { type: "cli", preset: "codex" },
        cc: { type: "cli", preset: "claude-code" },
        mine: { type: "cli", command: "/usr/bin/my-claude-wrapper" },
        odd: { type: "cli", command: "foo" }, // 认不出背后的模型：不编造单价
      },
    }),
  );
  const dir = path.join(h, ".traces");
  fs.mkdirSync(dir);
  const t0 = Date.now() - 20000;
  const run = (id, provider, lines) =>
    fs.writeFileSync(path.join(dir, `20260105-00000${id}-${id}${id}${id}${id}.jsonl`), [ev(id, t0, { type: "run_start", runId: id, provider, input: "整理一下这个仓库的目录结构" }), ...lines, ev(id, t0 + 50, { type: "done", reason: "final", text: "整理完了，共移动 3 个文件" })].join("\n") + "\n");
  const prog = (id, kind, line, n) => ev(id, t0 + n, { type: "agent_progress", kind, line });
  run("1", "sdk", [prog("1", "text", "我先看看目录", 1), prog("1", "status", "Cursor 已开始运行", 2)]);
  run("2", "codex", [prog("2", "tool", "🔧 shell ls", 1)]);
  run("3", "cc", [prog("3", "thinking", "想一想", 1)]);
  run("4", "mine", [prog("4", "text", "好", 1)]);
  run("5", "odd", [prog("5", "text", "好", 1)]);

  it("按提供方对应的模型取单价：cursor-sdk 默认 composer-2，cli 按预设 / 命令名", async () => {
    const p = start({ home: h });
    const m = {};
    for (const [n, name] of [["sdk", "20260105-000001-1111"], ["codex", "20260105-000002-2222"], ["cc", "20260105-000003-3333"], ["mine", "20260105-000004-4444"], ["odd", "20260105-000005-5555"]]) {
      const d = await p.call("session/get", { name });
      m[n] = d;
      assert.equal(d.agent, true, n);
      assert.equal(d.agentEstimate, true, n);
    }
    assert.equal(m.sdk.model, "composer-2");
    assert.deepEqual([m.sdk.price.in, m.sdk.price.out], [1.25, 10]);
    assert.match(m.codex.model, /gpt-5/);
    assert.deepEqual([m.codex.price.in, m.codex.price.out], [1.25, 10]);
    assert.match(m.cc.model, /claude/);
    assert.deepEqual([m.cc.price.in, m.cc.price.out], [3, 15]);
    assert.match(m.mine.model, /claude/, "命令名里带 claude");
    assert.equal(m.odd.price, null, "认不出模型就不算费用");
    assert.equal(m.odd.stats.cost, null);
  });

  it("估算口径：输入 = 提示词；输出 = 回复 / 思考 / 工具文本，状态行不算；过程里已有回复时不重复算最终回复", async () => {
    const p = start({ home: h });
    const sdk = (await p.call("session/get", { name: "20260105-000001-1111" })).stats;
    const codex = (await p.call("session/get", { name: "20260105-000002-2222" })).stats;
    // sdk：过程里有 text 行 → 最终回复不再叠加；codex：只有 tool 行 → 最终回复要算上
    assert.ok(codex.output > 0 && sdk.output > 0);
    const noStatus = (await p.call("session/get", { name: "20260105-000001-1111" })).fleet.counts;
    assert.deepEqual(noStatus, { text: 1, status: 1 });
    assert.ok(sdk.input === codex.input && sdk.input > 0, "同一段提示词，输入估算一致");
  });
});
