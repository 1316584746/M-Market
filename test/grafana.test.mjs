import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { launch } from "./helpers.mjs";

const TOKEN = "glsa_test_token_value_ok";
const USER = "alice";
const PASS = "s3cret-pw!";
const B64 = Buffer.from(`${USER}:${PASS}`).toString("base64");
let mode = "ok";
let server;
let base = "";

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/__mode") {
      mode = u.searchParams.get("m") || "ok";
      res.writeHead(204).end();
      return;
    }
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const p = u.pathname.startsWith("/grafana/") ? u.pathname.slice("/grafana".length) : u.pathname;
    if (mode === "redirect" && p === "/api/org") {
      res.writeHead(302, { location: "http://127.0.0.1:9/steal?token=" + TOKEN });
      res.end();
      return;
    }
    if (mode === "gateway") {
      res.writeHead(403, { "content-type": "text/html", server: "nginx/1.20.1" });
      res.end("<html><head><title>403 Forbidden</title></head><body>nginx</body></html>");
      return;
    }
    if (p === "/api/health") return send(200, { database: "ok", version: "11.2.0" });
    const okAuth = [`Bearer ${TOKEN}`, `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`];
    if (!okAuth.includes(req.headers.authorization || "")) return send(401, { message: "Unauthorized " + (req.headers.authorization || "") });
    if (p === "/api/org") return send(200, { id: 1, name: "Main Org" });
    if (p === "/api/search") {
      const q = (u.searchParams.get("query") || "").toLowerCase();
      const items = [
        { uid: "abc", title: "CPU", url: "/d/abc/cpu", folderTitle: "Infra", tags: ["host"], type: "dash-db" },
        { uid: "mem", title: "Memory", url: "/d/mem/memory", folderTitle: "Infra", tags: [], type: "dash-db" },
      ].filter(x => !q || x.title.toLowerCase().includes(q));
      return send(200, items);
    }
    if (p === "/api/dashboards/uid/abc") {
      return send(200, {
        dashboard: { title: "CPU", uid: "abc", panels: [{ title: "Usage", type: "timeseries" }, { title: "系统", type: "row", panels: [{ title: "Load", type: "stat" }] }] },
        meta: { folderTitle: "Infra", url: "/d/abc/cpu" },
      });
    }
    if (p === "/api/alertmanager/grafana/api/v2/alerts") {
      if (mode === "legacy") return send(404, { message: "Not found" });
      return send(200, [{ labels: { alertname: "HighCPU", grafana_folder: "Infra" }, annotations: { summary: "cpu > 90" }, startsAt: "2026-01-01T00:00:00Z", status: { state: "active" } }]);
    }
    if (p === "/api/alerts") return send(200, [{ name: "Disk", state: "alerting", newStateDate: "2026-01-02" }]);
    if (p === "/api/annotations") return send(200, [{ time: 1700000000000, text: "deployed v2", dashboardUID: "abc" }]);
    send(404, { message: "not found" });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const running = [];
after(() => running.forEach(p => p.stop()));
async function start() {
  const p = launch("grafana");
  running.push(p);
  await p.init();
  return p;
}
const setMode = m => fetch(base + "/__mode?m=" + m);

describe("grafana", { concurrency: 1 }, () => {
  it("没连接时说清楚；坏地址和坏令牌不保存；好令牌不回传", async () => {
    const p = await start();
    const st = await p.call("gf/status");
    assert.equal(st.hasToken, false);
    assert.equal(st.connected, false);
    await assert.rejects(p.call("gf/dashboards", {}), /还没有连接/);
    await assert.rejects(p.call("gf/connect", { url: "http://example.com", token: TOKEN }), /https/);
    await assert.rejects(p.call("gf/connect", { url: "http://169.254.169.254", token: TOKEN }), /https/);
    await assert.rejects(p.call("gf/connect", { url: "http://user:pw@127.0.0.1:9", token: TOKEN }), /地址里/);
    await assert.rejects(p.call("gf/connect", { url: base, token: "short" }), /格式/);
    await assert.rejects(p.call("gf/connect", { url: base, token: "glsa_wrong_token_value" }), e => {
      assert.match(e.message, /令牌无效/);
      assert.equal(e.message.includes("glsa_wrong"), false);
      return true;
    });
    assert.equal((await p.call("gf/status")).hasToken, false);
    await setMode("redirect");
    await assert.rejects(p.call("gf/connect", { url: base, token: TOKEN }), e => {
      assert.match(e.message, /重定向/);
      assert.equal(e.message.includes(TOKEN), false);
      return true;
    });
    assert.equal((await p.call("gf/status")).hasToken, false);
    await setMode("ok");
    const ok = await p.call("gf/connect", { url: base + "/", token: TOKEN });
    assert.equal(ok.org, "Main Org");
    assert.equal(ok.version, "11.2.0");
    assert.equal(ok.database, "ok");
    assert.equal(ok.url, base);
    assert.ok(!JSON.stringify(ok).includes(TOKEN));
    const again = await p.call("gf/connect", { url: base, token: "" });
    assert.equal(again.org, "Main Org");
  });

  it("子路径、搜索、面板、告警回退、注释，工具结果不含令牌", async () => {
    const p = await start();
    await setMode("ok");
    await p.call("gf/connect", { url: base + "/grafana", token: TOKEN });
    const list = await p.call("gf/dashboards", { query: "cpu" });
    assert.deepEqual(list.items.map(d => d.uid), ["abc"]);
    assert.equal(list.items[0].folder, "Infra");
    assert.equal(list.items[0].url, base + "/grafana/d/abc");
    const one = await p.call("gf/dashboard", { uid: "abc" });
    assert.deepEqual(one.panels.map(x => x.title), ["Usage", "Load"]);
    await assert.rejects(p.call("gf/dashboard", { uid: "../x" }), /不合法/);
    const alerts = await p.call("gf/alerts");
    assert.equal(alerts.items[0].name, "HighCPU");
    assert.equal(alerts.items[0].state, "active");
    await setMode("legacy");
    const old = await p.call("gf/alerts");
    assert.equal(old.items[0].name, "Disk");
    assert.equal(old.items[0].state, "alerting");
    const notes = await p.call("gf/annotations");
    assert.equal(notes.items[0].text, "deployed v2");
    const text = await p.tool("grafana_dashboard", { uid: "abc" });
    assert.match(text.text, /Usage/);
    assert.equal(text.isError, false);
    assert.ok(!text.text.includes(TOKEN));
    const tools = await p.call("mcp/tools");
    assert.deepEqual(tools.tools.map(t => t.name), ["grafana_status", "grafana_alerts", "grafana_dashboards", "grafana_dashboard"]);
    assert.ok(tools.tools.every(t => t.annotations.readOnlyHint === true));
    await p.call("gf/disconnect");
    assert.equal((await p.call("gf/status")).hasToken, false);
  });

  it("没有令牌时用账号 + 密码（HTTP Basic）：能连、能查、密码不回传；填错的不保存且报错不带密码", async () => {
    const p = await start();
    await setMode("ok");
    await assert.rejects(p.call("gf/connect", { url: base, username: USER, password: "wrong-password" }), e => {
      assert.match(e.message, /账号或密码不对/);
      assert.ok(!e.message.includes("wrong-password") && !e.message.includes(PASS) && !e.message.includes(B64));
      return true;
    });
    assert.equal((await p.call("gf/status")).hasToken, false, "验证失败不保存");
    await assert.rejects(p.call("gf/connect", { url: base, username: "a:b", password: PASS }), /账号格式/);
    await assert.rejects(p.call("gf/connect", { url: base, username: USER, password: "" }), /密码格式/);
    await assert.rejects(p.call("gf/connect", { url: base }), /令牌，或者账号和密码/);
    await assert.rejects(p.call("gf/connect", { url: "http://example.com", username: USER, password: PASS }), /https/, "公网地址不能用 http 发密码");
    const ok = await p.call("gf/connect", { url: base, username: USER, password: PASS });
    assert.equal(ok.org, "Main Org");
    assert.equal(ok.authMode, "basic");
    assert.equal(ok.username, USER);
    assert.ok(!JSON.stringify(ok).includes(PASS));
    const st = await p.call("gf/status");
    assert.equal(st.connected, true);
    assert.equal(st.authMode, "basic");
    assert.ok(!JSON.stringify(st).includes(PASS) && !JSON.stringify(st).includes(B64));
    // 账号没变、密码留空：沿用已保存的密码
    assert.equal((await p.call("gf/connect", { url: base, username: USER, password: "" })).org, "Main Org");
    // 后续查询都带着 Basic 凭据
    assert.deepEqual((await p.call("gf/dashboards", { query: "cpu" })).items.map(d => d.uid), ["abc"]);
    assert.equal((await p.call("gf/alerts")).items[0].name, "HighCPU");
    const t = await p.tool("grafana_status", {});
    assert.match(t.text, /已连接/);
    assert.ok(!t.text.includes(PASS) && !t.text.includes(B64));
    // 换成令牌：账号密码被清掉；断开：全部清掉
    const tok = await p.call("gf/connect", { url: base, token: TOKEN });
    assert.equal(tok.authMode, "token");
    assert.equal(tok.username, "");
    await p.call("gf/connect", { url: base, username: USER, password: PASS });
    await p.call("gf/disconnect");
    const gone = await p.call("gf/status");
    assert.equal(gone.hasToken, false);
    await assert.rejects(p.call("gf/dashboards", {}), /还没有连接/);
  });

  it("地址里粘贴了仪表盘 / 文件夹 / 告警页面：只取 Grafana 的根地址（子路径保留）", async () => {
    const p = await start();
    for (const [pasted, want] of [
      [base + "/dashboards/f/dfvpl7wfhawhsd/", base],
      [base + "/d/abc/cpu?orgId=1&from=now-6h", base],
      [base + "/alerting/list", base],
      [base + "/grafana/d/abc/cpu", base + "/grafana"],
      [base + "/grafana/dashboards", base + "/grafana"],
      [base + "/grafana", base + "/grafana"],
    ]) {
      const s = await p.call("gf/connect", { url: pasted, token: TOKEN });
      assert.equal(s.url, want, pasted);
      assert.equal(s.org, "Main Org", pasted);
    }
  });

  it("前面的网关返回 HTML（如 nginx 403）：报错里带状态码、页面标题和原因，不再只说「不是 JSON」", async () => {
    const p = await start();
    await setMode("gateway");
    try {
      await assert.rejects(p.call("gf/connect", { url: base, username: USER, password: PASS }), e => {
        assert.match(e.message, /不是 JSON/);
        assert.match(e.message, /HTTP 403/);
        assert.match(e.message, /403 Forbidden/);
        assert.match(e.message, /nginx/);
        assert.match(e.message, /内网或 VPN/);
        assert.ok(!e.message.includes(PASS));
        return true;
      });
    } finally {
      await setMode("ok");
    }
  });

  it("本机 http 以外的回环地址会去连，而不是被当成公网拒掉", async () => {
    const p = await start();
    await assert.rejects(p.call("gf/connect", { url: "http://[::1]:9", token: TOKEN }), /连不上|超时/);
  });
});
