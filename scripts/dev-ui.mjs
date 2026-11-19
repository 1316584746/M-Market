#!/usr/bin/env node
// 本地调试插件界面：不需要 M-Harness，在普通浏览器里打开插件的 ui/，后台用真实的 bin/backend.cjs。
//   node scripts/dev-ui.mjs market [端口]    市场（来源：本仓库的目录 + 假的第二个来源）
//   node scripts/dev-ui.mjs github [端口]    GitHub（接一个假的 GitHub API，令牌见终端输出）
//   node scripts/dev-ui.mjs <插件id> [端口]  其它插件
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { launch, ROOT } from "../test/helpers.mjs";
import { TOKEN, startMockGithub } from "../test/mock-github.mjs";

const id = process.argv[2];
if (!id) {
  console.error("用法：node scripts/dev-ui.mjs <插件id> [端口]");
  process.exit(1);
}
const port = Number(process.argv[3]) || 5179;

const KIT = `:root{--color-background:#fff;--color-foreground:#1c1c21;--color-card:#fff;--color-border:#e4e4e9;--color-input:#d2d2d9;--color-primary:#2f6fed;--color-primary-foreground:#fff;--color-muted:#f1f1f4;--color-muted-foreground:#6b6b76;--color-accent:#e8f0fe;--color-destructive:#d23f4a;--color-ring:#2f6fed}
:root[data-dbx-theme=dark]{--color-background:#181818;--color-foreground:#e6e6e6;--color-card:#1e1e1e;--color-border:#2e2e2e;--color-input:#404040;--color-primary:#5b9bff;--color-primary-foreground:#fff;--color-muted:#262626;--color-muted-foreground:#9a9aa3;--color-accent:#1d2d4a;--color-destructive:#f0707a;--color-ring:#5b9bff}
.dbx-card{border:1px solid var(--color-border);background:var(--color-card);border-radius:8px;padding:12px}
.dbx-btn{border:1px solid var(--color-border);background:var(--color-card);color:var(--color-foreground);border-radius:6px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
.dbx-btn:hover{background:var(--color-muted)}
.dbx-btn:disabled{opacity:.5;cursor:default}
.dbx-btn--primary{background:var(--color-primary);border-color:var(--color-primary);color:var(--color-primary-foreground)}
.dbx-btn--danger{color:var(--color-destructive);border-color:var(--color-destructive)}
.dbx-btn--ghost{border-color:transparent;background:transparent}
.dbx-label{display:block;font-size:12px;color:var(--color-muted-foreground);margin-bottom:4px}
.dbx-input,.dbx-select,.dbx-textarea{width:100%;box-sizing:border-box;border:1px solid var(--color-input);background:var(--color-background);color:var(--color-foreground);border-radius:6px;padding:5px 8px;font:inherit;font-size:13px}
.dbx-hint{font-size:12px;color:var(--color-muted-foreground)}
.dbx-badge{display:inline-block;border-radius:999px;background:var(--color-muted);color:var(--color-muted-foreground);padding:1px 8px;font-size:11px}
.dbx-link{color:var(--color-primary);cursor:pointer}`;

const SHIM = `<style>${KIT}</style><script>(function(){
  var theme = location.search.indexOf("dark") >= 0 ? "dark" : "light";
  document.documentElement.setAttribute("data-dbx-theme", theme);
  var call = function (method, params) {
    return fetch("/__rpc", { method: "POST", body: JSON.stringify({ method: method, params: params || {} }) }).then(function (r) { return r.json(); }).then(function (j) { if (j.error) throw new Error(j.error); return j.result; });
  };
  window.dbxPlugin = { ready: Promise.resolve({}), invoke: function (m, p) { return call(m, p); }, request: call, locale: "zh-CN", theme: { appearance: theme, tokens: {} }, capabilities: {}, onContext: function () {}, onEvent: function () {} };
})();</script>`;

const cleanups = [];
const env = {};
const home = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "mm-dev-"));
const plugins = path.join(home, "plugins");
fs.mkdirSync(plugins, { recursive: true });
env.HARNESS_PLUGINS_DIR = plugins;

if (id === "github") {
  const mock = await startMockGithub();
  env.GITHUB_API_URL = mock.base;
  cleanups.push(mock.close);
  console.log(`假 GitHub API：${mock.base}\n登录用的令牌：${TOKEN}`);
}

const plug = launch(id, { home, env });
await plug.init();

if (id === "market") {
  // 本仓库的目录：把安装包地址改成本机，这样「安装」真的能走完
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog", "index.json"), "utf8"));
  const srv = http.createServer((req, res) => {
    if (req.url === "/catalog/index.json") {
      const c = JSON.parse(JSON.stringify(catalog));
      for (const p of c.plugins) for (const v of p.versions) for (const a of v.artifacts) a.url = `http://127.0.0.1:${port + 1}/pkg/${path.basename(a.url)}`;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(c));
    }
    const m = /^\/pkg\/([\w.-]+\.dbxp)$/.exec(req.url);
    if (m && fs.existsSync(path.join(ROOT, "packages", m[1]))) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(fs.readFileSync(path.join(ROOT, "packages", m[1])));
    }
    res.writeHead(404).end();
  });
  await new Promise(r => srv.listen(port + 1, "127.0.0.1", r));
  cleanups.push(() => srv.close());
  await plug.call("market/saveSettings", {
    sources: [
      { id: "local", name: "本仓库目录", url: `http://127.0.0.1:${port + 1}/catalog/index.json`, enabled: true },
      { id: "dsh-hub", name: "DSH 插件市场", url: "https://dshbazaar.io/api/index.json", enabled: true },
    ],
  });
}

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const uiRoot = path.join(ROOT, "plugins", id, "ui");
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname === "/__rpc") {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", async () => {
      res.writeHead(200, { "content-type": "application/json" });
      try {
        const { method, params } = JSON.parse(Buffer.concat(chunks).toString());
        res.end(JSON.stringify({ result: await plug.call(method, params) }));
      } catch (e) {
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const file = path.resolve(uiRoot, rel);
  if (!file.startsWith(uiRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end("not found");
  let data = fs.readFileSync(file);
  if (file.endsWith(".html")) data = Buffer.from(data.toString("utf8").replace(/<head[^>]*>/i, m => m + SHIM));
  res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(data);
});
server.listen(port, "127.0.0.1", () => console.log(`界面：http://127.0.0.1:${port}/   （加 ?dark 看深色）`));

const bye = () => {
  plug.stop();
  cleanups.forEach(f => f());
  server.close();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
