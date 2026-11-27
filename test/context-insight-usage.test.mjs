import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { launch, tmpdir } from "./helpers.mjs";

const running = [];
after(() => running.forEach(p => p.stop()));

const now = Date.now();
const ev = (runId, ts, event) => JSON.stringify({ ts, runId, event });
const prog = (runId, ts, line, kind = "tool") => ev(runId, ts, { type: "agent_progress", kind, line });

const home = tmpdir("ci-usage");
fs.writeFileSync(path.join(home, "harness.config.json"), JSON.stringify({ traceDir: ".traces", providers: { ds: { type: "openai", model: "deepseek-chat" }, cur: { type: "cursor-sdk", model: "composer" } } }));
const traces = path.join(home, ".traces");
fs.mkdirSync(traces);

// 会话 A：M-Harness 自带 loop，调 MCP / 插件工具 / use_skill / 读 SKILL.md
{
  const t = now - 60000;
  const msgs = [{ role: "system", content: "s" }, { role: "user", content: "查一下" }];
  const lines = [ev("a", t, { type: "run_start", runId: "a", provider: "ds", input: "查一下" }), ev("a", t + 1, { type: "model_call", step: 1, messages: msgs })];
  const call = (n, name, args, out = "ok") => {
    lines.push(ev("a", t + n, { type: "tool_call", step: 1, name, args }));
    lines.push(ev("a", t + n + 1, { type: "tool_result", step: 1, name, output: out, ms: 5 }));
  };
  call(2, "mcp__gitlab__list_projects", {});
  call(4, "mcp__gitlab__list_projects", {});
  call(6, "mcp__feishu__fetch_doc", {});
  call(8, "plugin__github__github_repos", {});
  call(10, "use_skill", { name: "refactor" });
  call(12, "read_file", { path: "C:/skills/code-review/SKILL.md" });
  call(14, "read_file", { path: "src/a.ts" });
  lines.push(ev("a", t + 20, { type: "done", reason: "final", text: "好" }));
  fs.writeFileSync(path.join(traces, "a.jsonl"), lines.join("\n") + "\n");
}

// 会话 B：外部 Agent（cursor-sdk），工具只出现在进度行里
{
  const t = now - 30000;
  const lines = [
    ev("b", t, { type: "run_start", runId: "b", provider: "cur", input: "用技能" }),
    prog("b", t + 1, '🔧 read {"path":"C:\\\\Users\\\\x\\\\skills\\\\lark-doc\\\\SKILL.md"}'),
    prog("b", t + 2, '   ✓ read → {"status":"success"}'),
    prog("b", t + 3, '🔧 mcp {"server":"dbx","toolName":"dbx_list_tables"}'),
    prog("b", t + 4, '   ✓ mcp → {"status":"success"}'),
    prog("b", t + 5, "🔧 mcp__feishu__fetch_doc {}"),
    prog("b", t + 6, "   ✓ mcp__feishu__fetch_doc → ok"),
    prog("b", t + 7, '🔧 shell {"command":"git status"}'),
    prog("b", t + 8, '   ✓ shell → {"status":"success","value":{"exitCode":0}}'),
    ev("b", t + 9, { type: "done", reason: "final", text: "好" }),
  ];
  fs.writeFileSync(path.join(traces, "b.jsonl"), lines.join("\n") + "\n");
}

describe("context-insight：技能 / MCP / 插件工具统计", () => {
  it("总览把 MCP、插件工具、技能分开统计", async () => {
    const p = launch("context-insight", { home });
    running.push(p);
    const o = await p.call("insights/overview", { range: "today" });
    const m = Object.fromEntries(o.mcp.map(x => [x.name, x]));
    assert.equal(m["mcp__gitlab__list_projects"].count, 2);
    assert.equal(m["mcp__gitlab__list_projects"].label, "gitlab / list_projects");
    assert.equal(m["mcp__feishu__fetch_doc"].count, 2, "内置 loop 和外部 Agent 的同名 MCP 调用合并");
    assert.equal(m["mcp__dbx__dbx_list_tables"].count, 1, "外部 Agent 的统一 mcp 工具折算成 mcp__服务__工具");
    assert.deepEqual(o.plugins.map(x => x.name), ["plugin__github__github_repos"]);
    assert.equal(o.kpi.mcpCalls, 5);
    assert.equal(o.kpi.pluginCalls, 1);
    const sk = Object.fromEntries(o.skills.map(x => [x.name, x.count]));
    assert.deepEqual(sk, { refactor: 1, "code-review": 1, "lark-doc": 1 }, "use_skill 和读 SKILL.md 都算技能");
    assert.equal(o.kpi.skillUses, 3);
    // 工具榜仍包含它们，点开可以按工具筛选会话
    assert.ok(o.tools.some(x => x.name === "mcp__gitlab__list_projects"));
    assert.equal((await p.call("insights/overview", { range: "today", tool: "mcp__dbx__dbx_list_tables" })).kpi.sessions, 1);
    assert.equal((await p.call("insights/overview", { range: "today", skill: "lark-doc" })).kpi.sessions, 1);
  });
});
