import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { after, describe, it } from "node:test";
import { launch, tmpdir, unpack } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const running = [];
const servers = [];
after(() => {
  running.forEach(p => p.stop());
  servers.forEach(s => s.close());
});

// 从打好的包里加载 llm.cjs（它依赖打包时复制进去的 rpc.cjs）
const llmDir = path.join(tmpdir("at-llm"), "agent-teams");
unpack("agent-teams", llmDir);
const llm = require(path.join(llmDir, "bin", "llm.cjs"));

const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("等待超时");
    await new Promise(r => setTimeout(r, 40));
  }
};

/** 一个同时能充当 OpenAI 兼容和 Anthropic 的假接口，记下每个请求 */
async function mockServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", d => (raw += d));
    req.on("end", () => {
      const rec = { url: req.url, headers: req.headers, body: JSON.parse(raw || "{}") };
      seen.push(rec);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(handler(rec)));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

describe("agent-teams：模型地址和协议", () => {
  it("粘贴的接口路径会被去掉，带 /anthropic 的地址走 Anthropic 协议", () => {
    assert.equal(llm.cleanBase("https://api.deepseek.com/chat/completions/"), "https://api.deepseek.com");
    assert.equal(llm.cleanBase("https://x.com/v1/chat/completions?a=1"), "https://x.com/v1");
    assert.equal(llm.cleanBase("https://x.com/v1/messages"), "https://x.com/v1");
    assert.equal(llm.detectProtocol("https://api.deepseek.com/anthropic"), "anthropic");
    assert.equal(llm.detectProtocol("https://api.anthropic.com"), "anthropic");
    assert.equal(llm.detectProtocol("https://open.bigmodel.cn/api/paas/v4"), "openai-compat");
    assert.equal(llm.detectProtocol("https://api.openai.com/v1"), undefined);
    assert.deepEqual(llm.normalizeEndpoint("anthropic", ""), { protocol: "anthropic", baseURL: "https://api.anthropic.com" });
    assert.deepEqual(llm.normalizeEndpoint("openai-compat", "https://x.com/anthropic/v1"), { protocol: "anthropic", baseURL: "https://x.com/anthropic" });
  });

  it("OpenAI 格式的消息转成 Anthropic：system 单独放，工具调用和结果成对，同角色合并", () => {
    const a = llm.toAnthropic(
      [
        { role: "system", content: "你是 a" },
        { role: "user", content: "开始" },
        { role: "assistant", content: "先看看", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }, { id: "c2", type: "function", function: { name: "list_dir", arguments: "坏的" } }] },
        { role: "tool", tool_call_id: "c1", content: "内容" },
        { role: "tool", tool_call_id: "c2", content: "目录" },
        { role: "user", content: "新消息" },
      ],
      [{ type: "function", function: { name: "read_file", description: "读", parameters: { type: "object", properties: {} } } }],
    );
    assert.equal(a.system, "你是 a");
    assert.deepEqual(a.messages.map(m => m.role), ["user", "assistant", "user"]);
    assert.deepEqual(a.messages[1].content.map(b => b.type), ["text", "tool_use", "tool_use"]);
    assert.deepEqual(a.messages[1].content[1].input, { path: "x" });
    assert.deepEqual(a.messages[1].content[2].input, {}, "坏 JSON 不会让转换崩掉");
    assert.deepEqual(a.messages[2].content.map(b => b.type), ["tool_result", "tool_result", "text"]);
    assert.equal(a.tools[0].input_schema.type, "object");
  });

  it("chat：OpenAI 协议带上 temperature / extraBody，Anthropic 协议请求 /v1/messages 并翻回 OpenAI 格式", async () => {
    const oa = await mockServer(() => ({ choices: [{ message: { role: "assistant", content: "好" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    const r1 = await llm.chat({
      route: { protocol: "openai-compat", baseURL: oa.url, apiKey: "k1", model: "m", temperature: 0.3, extraBody: { thinking: { type: "disabled" } } },
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    assert.equal(r1.message.content, "好");
    assert.deepEqual(r1.usage, { input: 7, output: 3 });
    assert.equal(oa.seen[0].url, "/chat/completions");
    assert.equal(oa.seen[0].body.temperature, 0.3);
    assert.deepEqual(oa.seen[0].body.thinking, { type: "disabled" });
    assert.equal(oa.seen[0].headers.authorization, "Bearer k1");

    const an = await mockServer(() => ({ content: [{ type: "text", text: "我来读" }, { type: "tool_use", id: "tu1", name: "read_file", input: { path: "a.txt" } }], usage: { input_tokens: 11, output_tokens: 5 } }));
    const r2 = await llm.chat({
      route: { protocol: "anthropic", baseURL: an.url, apiKey: "k2", model: "claude-x" },
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read_file", description: "读", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    });
    assert.equal(an.seen[0].url, "/v1/messages");
    assert.equal(an.seen[0].headers["x-api-key"], "k2");
    assert.equal(an.seen[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(an.seen[0].headers.authorization, "Bearer k2", "非官方地址两种头都带");
    assert.equal(an.seen[0].body.system, "sys");
    assert.equal(an.seen[0].body.max_tokens, 4096);
    assert.equal(r2.message.content, "我来读");
    assert.equal(r2.message.tool_calls[0].id, "tu1");
    assert.deepEqual(JSON.parse(r2.message.tool_calls[0].function.arguments), { path: "a.txt" });
    assert.deepEqual(r2.usage, { input: 11, output: 5 });
  });

  it("读 harness.config.json：默认提供方是 cursor-sdk 时挑能用的；anthropic 提供方真的能当成员跑完任务", async () => {
    const home = tmpdir("at-cfg");
    const ws = tmpdir("at-cfg-ws");
    fs.writeFileSync(path.join(ws, "a.txt"), "内容 A");
    // 假的 Anthropic：第一轮调 read_file，第二轮 update_task，第三轮说话
    const an = await mockServer(rec => {
      const results = rec.body.messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(b => b.type === "tool_result");
      const first = rec.body.messages[0].content[0].text;
      const taskId = /任务 (t\d+)：/.exec(first)?.[1];
      const attemptId = /attemptId：(\w+)/.exec(first)?.[1];
      if (results.length === 0) return { content: [{ type: "tool_use", id: "u1", name: "read_file", input: { path: "a.txt" } }], usage: { input_tokens: 10, output_tokens: 2 } };
      if (results.length === 1) return { content: [{ type: "tool_use", id: "u2", name: "agent_teams_update_task", input: { taskId, attemptId, status: "completed", output: `读到：${results[0].content}` } }], usage: { input_tokens: 10, output_tokens: 2 } };
      return { content: [{ type: "text", text: "完成" }], usage: { input_tokens: 10, output_tokens: 1 } };
    });
    fs.writeFileSync(
      path.join(home, "harness.config.json"),
      JSON.stringify({
        defaultProvider: "cursor",
        providers: { cursor: { type: "cursor-sdk", apiKey: "x" }, codex: { type: "cli" }, claude: { type: "anthropic", apiKey: "sk-ant-test", model: "claude-x", baseURL: an.url } },
      }),
    );
    const p = launch("agent-teams", { home });
    running.push(p);
    await p.call("at/settings/set", { workspace: ws });
    const info = await p.call("at/settings");
    assert.deepEqual(info.providers.map(x => [x.name, x.protocol, x.hasKey]), [["claude", "anthropic", true]]);

    await p.tool("agent_teams_create", { name: "claude-team", members: [{ name: "alice" }], tasks: [{ subject: "读 a.txt", assignee: "alice" }] });
    await p.tool("agent_teams_approve", { teamId: "claude-team" });
    const team = await until(async () => {
      const t = await p.call("at/get", { id: "claude-team" });
      return t.tasks[0].status === "completed" ? t : null;
    });
    assert.match(team.tasks[0].output, /读到：.*内容 A/);
    assert.equal(an.seen.length, 2, "任务收尾后这一轮就结束");
    assert.ok(team.members[0].usage.input === 20, "用量按 Anthropic 的字段记下来");
    assert.ok(!JSON.stringify(info).includes("sk-ant-test"), "key 不返回给界面");
  });
});
