import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { launch, tmpdir } from "./helpers.mjs";

const running = [];
after(() => running.forEach(p => p.stop()));

// 插件进程里没法起假的 api.deepseek.com，所以用 --require 预加载一个假 fetch：按地址返回罐头数据，并把「地址 + 授权头」记下来
const stub = path.join(tmpdir("ci-bal-stub"), "stub-fetch.cjs");
const logFile = path.join(path.dirname(stub), "calls.jsonl");
fs.writeFileSync(stub, `
const fs = require("fs");
const ANSWERS = {
  "https://api.deepseek.com/user/balance": { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.50", granted_balance: "2.50", topped_up_balance: "10.00" }] },
  "https://api.moonshot.cn/v1/users/me/balance": { code: 0, status: true, data: { available_balance: 49.58, voucher_balance: 46.58, cash_balance: 3 } },
  "https://api.siliconflow.cn/v1/user/info": { code: 20000, data: { balance: "1.5", chargeBalance: "8.5", totalBalance: "10" } },
  "https://openrouter.ai/api/v1/credits": { data: { total_credits: 20, total_usage: 7.25 } },
};
globalThis.fetch = async (url, opts) => {
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ url: String(url), auth: (opts && opts.headers && opts.headers.authorization) || "" }) + "\\n");
  const a = ANSWERS[String(url)];
  if (!a) return new Response("nope", { status: 404 });
  return new Response(JSON.stringify(a), { status: 200, headers: { "content-type": "application/json" } });
};
`);
const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
const reset = () => fs.rmSync(logFile, { force: true });

function start(config, traces) {
  const home = tmpdir("ci-bal");
  fs.writeFileSync(path.join(home, "harness.config.json"), JSON.stringify({ traceDir: ".traces", ...config }));
  fs.mkdirSync(path.join(home, ".traces"));
  for (const [name, provider] of Object.entries(traces || {})) {
    fs.writeFileSync(path.join(home, ".traces", `${name}.jsonl`), JSON.stringify({ ts: Date.now(), runId: name, event: { type: "run_start", runId: name, provider, input: "x" } }) + "\n");
  }
  const p = launch("context-insight", { home, env: { NODE_OPTIONS: `--require ${JSON.stringify(stub.replace(/\\/g, "/"))}` } });
  running.push(p);
  reset();
  return p;
}

const providers = {
  cursor: { type: "cursor-sdk", model: "grok-4.7", apiKey: "key_CURSOR" },
  deepseek: { type: "openai-compat", baseURL: "https://api.deepseek.com", apiKey: "sk-DS", model: "deepseek-chat" },
  kimi: { type: "openai-compat", baseURL: "https://api.moonshot.cn/v1", apiKey: "sk-KIMI", model: "kimi" },
  sf: { type: "openai-compat", baseURL: "https://api.siliconflow.cn/v1", apiKey: "sk-SF", model: "qwen" },
  or: { type: "openai-compat", baseURL: "https://openrouter.ai/api/v1", apiKey: "sk-OR", model: "x" },
  zhipu: { type: "openai-compat", baseURL: "https://api.z.ai/api/anthropic", apiKey: "sk-ZP", model: "glm" },
  claude: { type: "anthropic", apiKey: "sk-ant", model: "claude" },
  codex: { type: "cli" },
  nokey: { type: "openai-compat", baseURL: "https://api.deepseek.com", apiKey: "${CI_BAL_NO_SUCH_ENV}", model: "m" },
};

describe("context-insight：余额跟着当前提供方走", () => {
  it("默认提供方是 Cursor：没有余额接口，说明原因，key 不会发到任何地方", async () => {
    const p = start({ defaultProvider: "cursor", providers });
    const b = await p.call("balance/get", { force: true });
    assert.equal(b.enabled, true);
    assert.equal(b.unsupported, true);
    assert.equal(b.provider, "cursor");
    assert.match(b.reason, /Cursor.*没有提供/);
    assert.equal(b.available, false);
    assert.deepEqual(calls(), [], "没有发起任何网络请求");
    assert.ok(!JSON.stringify(b).includes("key_CURSOR"));
  });

  it("最近一次运行用的是谁就查谁，而不是写死 DeepSeek", async () => {
    const p = start({ defaultProvider: "cursor", providers }, { run1: "deepseek" });
    const b = await p.call("balance/get", { force: true });
    assert.equal(b.provider, "deepseek");
    assert.equal(b.available, true);
    assert.deepEqual(b.balances, [{ currency: "CNY", total: 12.5, granted: 2.5, toppedUp: 10 }]);
    assert.deepEqual(calls(), [{ url: "https://api.deepseek.com/user/balance", auth: "Bearer sk-DS" }]);
  });

  it("Moonshot / SiliconFlow / OpenRouter：各自的接口和币种", async () => {
    for (const [name, url, key, want] of [
      ["kimi", "https://api.moonshot.cn/v1/users/me/balance", "sk-KIMI", { currency: "CNY", total: 49.58, granted: 46.58, toppedUp: 3 }],
      ["sf", "https://api.siliconflow.cn/v1/user/info", "sk-SF", { currency: "CNY", total: 10, granted: 1.5, toppedUp: 8.5 }],
      ["or", "https://openrouter.ai/api/v1/credits", "sk-OR", { currency: "USD", total: 12.75, granted: 0, toppedUp: 20 }],
    ]) {
      const p = start({ defaultProvider: name, providers });
      const b = await p.call("balance/get", { force: true });
      assert.equal(b.available, true, name);
      assert.equal(b.usable, true, name);
      assert.deepEqual(b.balances, [want], name);
      assert.deepEqual(calls(), [{ url, auth: `Bearer ${key}` }], name);
    }
  });

  it("智谱 / Anthropic / 命令行 Agent：说明没有余额接口，不联网", async () => {
    for (const [name, re] of [["zhipu", /没有公开的余额接口/], ["claude", /Anthropic/], ["codex", /命令行/]]) {
      const p = start({ defaultProvider: name, providers });
      const b = await p.call("balance/get", { force: true });
      assert.equal(b.unsupported, true, name);
      assert.match(b.reason, re, name);
      assert.deepEqual(calls(), [], name);
    }
  });

  it("key 解不出来：提示没有可用的 key，不联网；没有任何提供方：提示找不到；关开关：未启用", async () => {
    let p = start({ defaultProvider: "nokey", providers });
    let b = await p.call("balance/get", { force: true });
    assert.equal(b.available, false);
    assert.match(b.reason, /没有可用的 key/);
    assert.ok(!JSON.stringify(b).includes("CI_BAL_NO_SUCH_ENV"));
    assert.deepEqual(calls(), []);
    p = start({ providers: {} });
    b = await p.call("balance/get", { force: true });
    assert.match(b.reason, /没有找到当前使用的提供方/);
    p = start({ defaultProvider: "deepseek", providers });
    await p.call("prefs/set", { balance: false });
    assert.deepEqual(await p.call("balance/get", { force: true }), { enabled: false });
    assert.deepEqual(calls(), []);
  });

  it("接口出错：报查询失败，错误信息里不带 key；结果缓存 5 分钟，force 才重查", async () => {
    // 假 fetch 里没有 SiliconFlow .com 的罐头，会回 404
    const q = start({ defaultProvider: "sfcom", providers: { sfcom: { type: "openai-compat", baseURL: "https://api.siliconflow.com/v1", apiKey: "sk-SECRET-1", model: "m" } } });
    const b = await q.call("balance/get", { force: true });
    assert.equal(b.failed, true);
    assert.match(b.reason, /HTTP 404/);
    assert.ok(!JSON.stringify(b).includes("sk-SECRET-1"));
    await q.call("balance/get", {});
    assert.equal(calls().length, 1, "5 分钟内不重复请求");
    await q.call("balance/get", { force: true });
    assert.equal(calls().length, 2);
  });
});
