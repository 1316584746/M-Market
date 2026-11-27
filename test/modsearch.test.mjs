import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { ROOT, launch } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const net = require(`${ROOT}/plugins/modsearch/bin/net.cjs`);
const html = require(`${ROOT}/plugins/modsearch/bin/html.cjs`);
const search = require(`${ROOT}/plugins/modsearch/bin/search.cjs`);

const KEY_A = "tvly-key-AAAAAAAAAAAA";
const KEY_B = "tvly-key-BBBBBBBBBBBB";

let server;
let base = "";
let hits = {};
let fcMode = "ok";
const seenHeaders = {};

const PAGE = `<!doctype html><html><head><title>Docs &amp; Guide</title><style>.x{color:red}</style><script>var secret=1</script></head><body>
<nav>menu</nav>${Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i} of the guide: it explains how the thing works in plain words.</p>`).join("\n")}
<a href="/next?a=1&amp;b=2">Next page</a> <a href="javascript:alert(1)">bad</a> <a href="#top">top</a></body></html>`;

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    hits[u.pathname] = (hits[u.pathname] || 0) + 1;
    seenHeaders[u.pathname] = req.headers;
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const send = (code, obj, headers = {}) => {
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
      };
      if (u.pathname === "/__reset") {
        hits = {};
        fcMode = u.searchParams.get("fc") || "ok";
        return send(204, "");
      }
      if (u.pathname === "/page") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(PAGE);
      }
      if (u.pathname === "/fc/v2/search") {
        if (fcMode === "quota") return send(402, { error: "Payment required: out of credits" });
        return send(200, { data: { web: [{ title: "Firecrawl hit", url: "https://example.com/fc", description: "from firecrawl" }] }, creditsUsed: 1 });
      }
      if (u.pathname === "/fc/v2/scrape") return send(200, { data: { markdown: "# Cloud page\n\nbody ".repeat(30), metadata: { title: "Cloud", statusCode: 200 }, links: ["https://example.com/a"] } });
      if (u.pathname === "/kn/v1/search/public") return send(200, { results: [{ title: "Keenable hit", url: "https://example.com/kn", snippet: "from keenable" }], mode: "public" });
      if (u.pathname === "/yc/v1/agents/search") return send(200, { results: { web: [{ title: "You hit", url: "https://example.com/yc", snippets: ["from you"] }] } });
      if (u.pathname === "/tv/search") {
        const auth = req.headers.authorization || "";
        if (auth === `Bearer ${KEY_A}`) return send(401, { detail: "Unauthorized " + KEY_A });
        if (auth === `Bearer ${KEY_B}`) return send(200, { answer: "tavily says hi", results: [{ title: "Tavily hit", url: "https://example.com/tv", content: "from tavily" }] });
        return send(401, {});
      }
      send(404, { error: "nope" });
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const running = [];
after(() => running.forEach(p => p.stop()));
const BLANK_ENV = { FIRECRAWL_API_KEY: "", KEENABLE_API_KEY: "", TAVILY_API_KEY: "", EXA_API_KEY: "" };
async function start() {
  const p = launch("modsearch", { env: BLANK_ENV });
  running.push(p);
  await p.init();
  return p;
}
const reset = (fc = "ok") => fetch(`${base}/__reset?fc=${fc}`);
const mocks = () => ({
  firecrawl: { baseURL: `${base}/fc` },
  keenable: { baseURL: `${base}/kn` },
  youcom: { baseURL: `${base}/yc` },
  tavily: { baseURL: `${base}/tv` },
});

describe("modsearch 单元：内网防护", () => {
  it("私有、回环、保留地址都算内网；公网不算", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2001:db8::1"]) {
      assert.equal(net.isPrivateIpAddress(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(net.isPrivateIpAddress(ip), false, ip);
  });
  it("主机名黑名单和协议、凭据检查", () => {
    assert.throws(() => net.normalizeFetchUrl("ftp://example.com"), /http\/https/);
    assert.throws(() => net.normalizeFetchUrl("https://user:pw@example.com"), /credentials/);
    assert.throws(() => net.normalizeFetchUrl(""), /required/);
    assert.equal(net.isBlockedHostname("localhost"), true);
    assert.equal(net.isBlockedHostname("a.localhost"), true);
    assert.equal(net.isBlockedHostname("metadata.google.internal"), true);
    assert.equal(net.isBlockedHostname("example.com"), false);
  });
  it("没开内网开关时字面内网地址直接拒绝，开了才放行", async () => {
    await assert.rejects(net.assertSafeRemoteTarget(new URL("http://127.0.0.1:1/x"), false), /Blocked private network target/);
    await assert.rejects(net.assertSafeRemoteTarget(new URL("http://169.254.169.254/latest"), false), /Blocked private network target/);
    const ok = await net.assertSafeRemoteTarget(new URL("http://127.0.0.1:1/x"), true);
    assert.equal(ok.address, "127.0.0.1");
  });
  it("云端抓取引擎不会收到内网地址", async () => {
    await assert.rejects(net.assertCloudDisclosable("firecrawl", new URL("http://10.0.0.5/admin"), AbortSignal.timeout(5000), 5000), /does not fetch the private or reserved target/);
    await assert.rejects(net.assertCloudDisclosable("keenable", new URL("http://printer.local/"), AbortSignal.timeout(5000), 5000), /does not fetch/);
  });
});

describe("modsearch 单元：HTML 提取与冷却分类", () => {
  it("去掉脚本样式导航之外的标记，解码实体，只取绝对链接", () => {
    const { title, text } = html.extractVisibleTextFromHtml(PAGE);
    assert.equal(title, "Docs & Guide");
    assert.ok(text.includes("Paragraph 3 of the guide"));
    assert.ok(!text.includes("secret"));
    assert.ok(!text.includes("color:red"));
    const links = html.extractLinks(PAGE, "https://example.com/docs/");
    assert.deepEqual(links, [{ text: "Next page", url: "https://example.com/next?a=1&b=2" }]);
  });
  it("畸形的大页面不会卡死", () => {
    const t0 = Date.now();
    html.extractVisibleTextFromHtml(`<div>${"<script ".repeat(40000)}`);
    html.extractVisibleTextFromHtml(`<div>${"<style><script></style".repeat(20000)}`);
    html.extractVisibleTextFromHtml(`<p>${"&#x110000;&amp&#xD800;".repeat(40000)}`);
    assert.ok(Date.now() - t0 < 3000);
  });
  it("配额错误才冷却；限流只是瞬时；带 Resets in 的按它算", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    assert.equal(search.classifyQuota(new Error("429 too many requests"), now), null);
    assert.equal(search.classifyQuota(new Error("timed out"), now), null);
    assert.equal(search.classifyQuota(new Error("out of credits"), now).getTime() - now.getTime(), 45 * 60_000);
    assert.equal(search.classifyQuota(new Error("tavily is out of monthly quota (HTTP 432)"), now).getTime() - now.getTime(), 24 * 3600_000);
    assert.equal(search.classifyQuota(new Error("keyless allowance is used up. Resets in 1h2m3s."), now).getTime() - now.getTime(), (3600 + 120 + 3) * 1000);
  });
  it("X 类问题识别保守", () => {
    assert.equal(search.isXQuery("what did he tweet yesterday"), true);
    assert.equal(search.isXQuery("他在推特上说了什么"), true);
    assert.equal(search.isXQuery("how to install xterm"), false);
  });
});

describe("modsearch", { concurrency: 1 }, () => {
  it("什么都没配：路线是三个免注册搜索 + 三个读网页，没有泄露任何 key", async () => {
    const p = await start();
    const st = await p.call("ms/status");
    assert.deepEqual(st.routes.search.chain, ["firecrawl", "keenable", "youcom"]);
    assert.deepEqual(st.routes.fetch.chain, ["firecrawl", "keenable", "local"]);
    const tav = st.engines.find(e => e.name === "tavily");
    assert.equal(tav.searchReady, false);
    const doc = await p.tool("modsearch_doctor");
    assert.match(doc.text, /search: firecrawl → keenable → youcom/);
  });

  it("保存校验：未知引擎、坏地址会被拒；key 不回传，可以清除", async () => {
    const p = await start();
    await assert.rejects(p.call("ms/save", { engine: "bing" }), /未知的引擎/);
    await assert.rejects(p.call("ms/save", { engines: { exa: { baseURL: "ftp://x" } } }), /http/);
    const st = await p.call("ms/save", { engines: { tavily: { apiKey: `${KEY_A}, ${KEY_B}` } } });
    const tav = st.engines.find(e => e.name === "tavily");
    assert.equal(tav.keyCount, 2);
    assert.equal(tav.searchReady, true);
    assert.ok(!JSON.stringify(st).includes(KEY_A) && !JSON.stringify(st).includes(KEY_B));
    const cleared = await p.call("ms/save", { engines: { tavily: { apiKey: "" } } });
    assert.equal(cleared.engines.find(e => e.name === "tavily").keyCount, 0);
  });

  it("web_search：免 key 走 Firecrawl，不带 Authorization，结果带链接", async () => {
    await reset();
    const p = await start();
    await p.call("ms/save", { engines: mocks() });
    const r = await p.tool("web_search", { query: "hello" });
    assert.equal(r.isError, false);
    assert.match(r.text, /Firecrawl hit/);
    assert.match(r.text, /https:\/\/example\.com\/fc/);
    assert.match(r.text, /engine: firecrawl/);
    assert.equal(seenHeaders["/fc/v2/search"].authorization, undefined);
  });

  it("配额用完就换引擎，并记住冷却，下一次直接先用别的", async () => {
    await reset("quota");
    const p = await start();
    await p.call("ms/save", { engines: mocks() });
    const first = await p.tool("web_search", { query: "hello" });
    assert.match(first.text, /Keenable hit/);
    assert.match(first.text, /Fell back to keenable after: firecrawl/);
    assert.match(first.text, /cooling until/);
    assert.equal(hits["/fc/v2/search"], 1);
    const st = await p.call("ms/status");
    assert.ok(st.engines.find(e => e.name === "firecrawl").cooling);
    assert.equal(st.routes.search.chain[0], "keenable");
    const second = await p.tool("web_search", { query: "again" });
    assert.match(second.text, /engine: keenable/);
    assert.equal(hits["/fc/v2/search"], 1, "冷却期间不应再打 Firecrawl");
    const after2 = await p.call("ms/clear-cooldown", { engine: "firecrawl" });
    assert.equal(after2.engines.find(e => e.name === "firecrawl").cooling, null);
  });

  it("关掉冷却后每次都先试首选引擎", async () => {
    await reset("quota");
    const p = await start();
    await p.call("ms/save", { engines: mocks(), cooldown: false });
    await p.tool("web_search", { query: "a" });
    await p.tool("web_search", { query: "b" });
    assert.equal(hits["/fc/v2/search"], 2);
  });

  it("多 key 轮换：第一把被拒就换第二把，错误里不出现 key", async () => {
    await reset();
    const p = await start();
    await p.call("ms/save", { engine: "tavily", engines: { ...mocks(), tavily: { ...mocks().tavily, apiKey: `${KEY_A},${KEY_B}` } } });
    const r = await p.tool("web_search", { query: "rotate" });
    assert.equal(r.isError, false);
    assert.match(r.text, /Tavily hit/);
    assert.match(r.text, /tavily says hi/);
    assert.match(r.text, /Rotated to tavily API key 2/);
    assert.ok(!r.text.includes(KEY_A) && !r.text.includes(KEY_B), r.text);
  });

  it("显式指定引擎是硬指定：做不到就报错，不换别的", async () => {
    await reset();
    const p = await start();
    await p.call("ms/save", { engines: mocks() });
    const bad = await p.call("ms/test-search", { query: "x", engine: "local" }).catch(e => e);
    assert.ok(bad instanceof Error);
    assert.match(bad.message, /cannot search/);
    assert.equal(hits["/fc/v2/search"], undefined);
    const one = await p.call("ms/test-search", { query: "x", engine: "youcom" });
    assert.equal(one.entry.engine, "youcom");
    assert.match(one.text, /You hit/);
  });

  it("x_search：没有 X 引擎，用网页代答并明说是二手", async () => {
    await reset();
    const p = await start();
    await p.call("ms/save", { engines: mocks() });
    const r = await p.tool("x_search", { query: "what did they tweet" });
    assert.match(r.text, /X was unreachable/);
    assert.match(r.text, /Firecrawl hit/);
  });

  it("read_page 本地抓取：分段、翻页用缓存、提取链接", async () => {
    await reset();
    const p = await start();
    await p.call("ms/save", { fetchEngine: "local", allowPrivateNetwork: true, engines: mocks() });
    const a = await p.tool("read_page", { url: `${base}/page`, max_length: 500 });
    assert.equal(a.isError, false);
    assert.match(a.text, /Docs & Guide/);
    assert.match(a.text, /Paragraph 0 of the guide/);
    assert.match(a.text, /Showing characters 0 to 500 of \d+/);
    assert.match(a.text, /start_index 500/);
    assert.match(a.text, /Next page — http:\/\/127\.0\.0\.1:\d+\/next\?a=1&b=2/);
    assert.match(a.text, /Private network protection was disabled/);
    const b = await p.tool("read_page", { url: `${base}/page`, start_index: 500, max_length: 500 });
    assert.match(b.text, /From the copy of this page read/);
    assert.ok(!b.text.includes("Paragraph 0 of the guide"));
    assert.equal(hits["/page"], 1, "翻页不应重新抓取");
    const past = await p.tool("read_page", { url: `${base}/page`, start_index: 999999 });
    assert.match(past.text, /past the end of the page/);
    const badNum = await p.tool("read_page", { url: `${base}/page`, max_length: 0 });
    assert.equal(badNum.isError, true);
  });

  it("read_page 默认拦内网，且不会把内网地址交给云端引擎", async () => {
    await reset();
    const p = await start();
    await p.call("ms/save", { fetchEngine: "local", engines: mocks() });
    const r = await p.tool("read_page", { url: `${base}/page` });
    assert.equal(r.isError, true);
    assert.match(r.text, /Blocked private network target/);
    assert.match(r.text, /does not fetch the private or reserved target/);
    assert.equal(hits["/page"], undefined);
    assert.equal(hits["/fc/v2/scrape"], undefined);
    const bad = await p.tool("read_page", { url: "file:///etc/passwd" });
    assert.equal(bad.isError, true);
  });

  it("read_page 云端抓取（公网地址）走 Firecrawl 并标明是云端提取", async () => {
    await reset();
    const p = await start();
    await p.call("ms/save", { engines: mocks() });
    // 用公网域名的字面 IP 避免 DNS：1.1.1.1 不是内网，Firecrawl 是 mock，所以不会真的访问它
    const r = await p.tool("read_page", { url: "http://1.1.1.1/doc" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Cloud page/);
    assert.match(r.text, /Fetched through Firecrawl in the cloud/);
    assert.equal(hits["/fc/v2/scrape"], 1);
  });

  it("关掉云端读网页后只剩本地直连", async () => {
    const p = await start();
    const st = await p.call("ms/save", { engines: { firecrawl: { keylessFetch: false }, keenable: { keylessFetch: false } } });
    assert.deepEqual(st.routes.fetch.chain, ["local"]);
  });

  it("工具参数校验", async () => {
    const p = await start();
    assert.equal((await p.tool("web_search", { query: "  " })).isError, true);
    assert.equal((await p.tool("read_page", {})).isError, true);
  });
});

