import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { launch, tmpdir } from "./helpers.mjs";

const running = [];
after(() => running.forEach(p => p.stop()));

const ev = (runId, ts, event) => JSON.stringify({ ts, runId, event });
const ymd = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

const home = tmpdir("ci-timing");
fs.writeFileSync(path.join(home, "harness.config.json"), JSON.stringify({
  traceDir: ".traces",
  providers: {
    ds: { type: "openai", model: "deepseek-chat" },
    // 指向 DeepSeek，但 key 来自一个不存在的环境变量：解不出 key，就不该发请求
    dsk: { type: "openai-compat", baseURL: "https://api.deepseek.com", apiKey: "${CI_TEST_NO_SUCH_ENV_KEY}", model: "deepseek-chat" },
  },
}));
const traces = path.join(home, ".traces");
fs.mkdirSync(traces);

const now = Date.now();
// 一次运行：模型 800ms、工具 450ms，事件之间的空档：100 + 100 + 100（+ 一个 10 分钟的空档，只算 2 分钟）
{
  const t = now - 700000;
  const lines = [
    ev("a", t, { type: "run_start", runId: "a", provider: "ds", input: "测耗时" }),
    ev("a", t + 100, { type: "model_call", step: 1, messages: [{ role: "system", content: "s" }, { role: "user", content: "测耗时" }] }),
    ev("a", t + 1000, { type: "model_reply", step: 1, ms: 800, tokens: 1200, reply: { message: { role: "assistant", content: "" }, usage: { input: 1000, output: 200, total: 1200 } } }),
    ev("a", t + 1100, { type: "tool_call", step: 1, name: "read_file", args: { path: "a.txt" } }),
    ev("a", t + 1600, { type: "tool_result", step: 1, name: "read_file", output: "x", ms: 450 }),
    ev("a", t + 1600 + 600000, { type: "model_call", step: 2, messages: [{ role: "system", content: "s" }, { role: "user", content: "测耗时" }] }),
    ev("a", t + 601900, { type: "model_reply", step: 2, ms: 300, tokens: 1530, reply: { message: { role: "assistant", content: "好" }, usage: { input: 1500, output: 30, total: 1530 } } }),
    ev("a", t + 602000, { type: "done", reason: "final", text: "好" }),
  ];
  fs.writeFileSync(path.join(traces, "a.jsonl"), lines.join("\n") + "\n");
}

describe("context-insight 0.3：耗时、范围、余额", () => {
  it("耗时拆成模型 / 工具 / 其他开销，输出速度只算有真实用量的调用", async () => {
    const p = launch("context-insight", { home });
    running.push(p);
    const o = await p.call("insights/overview", { range: "all" });
    assert.equal(o.timing.modelMs, 1100);
    assert.equal(o.timing.toolMs, 450);
    assert.equal(o.timing.modelCalls, 2);
    assert.equal(o.timing.toolCalls, 1);
    assert.equal(o.timing.overheadMs, 100 + 100 + 120000 + 100, "单个空档最多算 2 分钟，模型 / 工具本身的时间不重复算");
    assert.equal(o.kpi.activeMs, 1100 + 450 + o.timing.overheadMs);
    assert.ok(Math.abs(o.timing.speed - 230 / 1.1) < 0.01, "输出 230 token / 1.1 秒");
    assert.equal(o.kpi.pricedSessions, 1);
    assert.deepEqual(o.totals.tools, { n: 1, count: 1 });
    assert.deepEqual(o.totals.skills, { n: 0, count: 0 });
    assert.equal(o.heat.reduce((n, h) => n + h.sessions, 0), 1, "热力图每天带会话数");
  });

  it("范围：全部 / 自定义起止", async () => {
    const p = launch("context-insight", { home });
    running.push(p);
    const all = await p.call("insights/overview", { range: "all" });
    assert.equal(all.kpi.sessions, 1);
    assert.equal(all.earliest, ymd(now - 700000));
    assert.equal(all.days[0], all.earliest);
    assert.equal(all.days[all.days.length - 1], all.today);

    const from = ymd(now - 3 * 86400000), to = ymd(now);
    const c = await p.call("insights/overview", { range: "7", from, to });
    assert.equal(c.range, "custom");
    assert.equal(c.from, from);
    assert.equal(c.to, to);
    assert.equal(c.kpi.sessions, 1);

    const old = await p.call("insights/overview", { range: "7", from: "2020-01-05", to: "2020-01-01" });
    assert.equal(old.from, "2020-01-01", "起止反了会自动对调");
    assert.equal(old.kpi.sessions, 0);
    assert.equal(old.kpi.tokens, 0);

    const d = await p.call("insights/overview", { range: "7", day: ymd(now), from: "2020-01-01", to: "2020-01-02" });
    assert.equal(d.range, "day", "单日筛选优先于起止");
    assert.deepEqual(d.days, [ymd(now)]);
  });

  it("偏好：货币、汇率、余额开关，非法值回到默认", async () => {
    const p = launch("context-insight", { home });
    running.push(p);
    const d0 = await p.call("prefs/get");
    assert.equal(d0.currency, "usd");
    assert.equal(d0.fx, 7.2);
    assert.equal(d0.balance, true);
    const r = await p.call("prefs/set", { currency: "cny", fx: 7.1, balance: false, range: "all" });
    assert.deepEqual([r.currency, r.fx, r.balance, r.range], ["cny", 7.1, false, "all"]);
    const bad = await p.call("prefs/set", { currency: "eur", fx: -3, balance: "x", range: "999" });
    assert.deepEqual([bad.currency, bad.fx, bad.balance, bad.range], ["usd", 7.2, true, "7"]);
  });

  it("余额：当前提供方（最近一次运行用的 ds，type=openai）没有余额接口，说明原因、不联网；关掉开关就是未启用", async () => {
    const p = launch("context-insight", { home });
    running.push(p);
    const b = await p.call("balance/get", { force: true });
    assert.equal(b.enabled, true);
    assert.equal(b.available, false);
    assert.equal(b.unsupported, true);
    assert.equal(b.provider, "ds");
    assert.match(b.reason, /OpenAI.*没有提供/);
    assert.ok(!JSON.stringify(b).includes("CI_TEST_NO_SUCH_ENV_KEY"), "不把配置里的 key 引用带回界面");
    await p.call("prefs/set", { balance: false });
    assert.deepEqual(await p.call("balance/get", { force: true }), { enabled: false });
  });

  it("清单声明了联网权限（只用于查余额）", () => {
    const m = JSON.parse(fs.readFileSync(new URL("../plugins/context-insight/manifest.json", import.meta.url), "utf8"));
    assert.ok(m.permissions.includes("net.connect:https"));
  });
});
