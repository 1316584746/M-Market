#!/usr/bin/env node
// 本地调试插件界面：不需要 M-Harness，在普通浏览器里打开插件的 ui/，后台用真实的 bin/backend.cjs。
//   node scripts/dev-ui.mjs github [端口]    GitHub（接一个假的 GitHub API，令牌见终端输出）
//   node scripts/dev-ui.mjs <插件id> [端口]  其它插件
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { launch, ROOT } from "../test/helpers.mjs";
import { TOKEN, startMockGithub } from "../test/mock-github.mjs";
import { seedTraces } from "../test/mock-traces.mjs";

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
// DEV_HOME=某个真实的 M-Harness 数据目录：直接看真实 trace（不会造假数据）
const home = process.env.DEV_HOME || fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "mm-dev-"));
const plugins = path.join(home, "plugins");
fs.mkdirSync(plugins, { recursive: true });
env.HARNESS_PLUGINS_DIR = plugins;

if (id === "github") {
  const mock = await startMockGithub();
  env.GITHUB_API_URL = mock.base;
  cleanups.push(mock.close);
  console.log(`假 GitHub API：${mock.base}\n登录用的令牌：${TOKEN}`);
}

if (id === "context-insight" && !process.env.DEV_HOME) console.log(`假 trace：${seedTraces(home)}`);

const plug = launch(id, { home, env });
await plug.init();

if (id === "agent-teams") {
  // 假模型 + 一个跑到「等待确认」的团队 + 一个待批准的团队，方便看界面
  const ws = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "mm-dev-ws-"));
  fs.writeFileSync(path.join(ws, "hello.txt"), "你好，团队");
  const call = (name, args) => ({ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } });
  const llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", d => (raw += d));
    req.on("end", () => {
      const b = JSON.parse(raw);
      const who = /成员 ([\p{L}\p{N}_.-]+)/u.exec(b.messages[0].content)?.[1];
      const first = b.messages.find(m => m.role === "user")?.content || "";
      const taskId = /任务 (t\d+)：/.exec(first)?.[1];
      const step = b.messages.filter(m => m.role === "tool").length;
      let msg;
      const upd = a => ({ tool_calls: [call("agent_teams_update_task", { taskId, ...a })] });
      if (first.includes("质量门：implementation") || first.includes("质量门：repair")) {
        if (step === 0) msg = { tool_calls: [call("write_file", { path: "lib/parse.js", content: first.includes("repair") ? "// v2 带校验\n" : "// v1\n" })] };
        else if (step === 1) msg = upd({ status: "completed", output: "已写入 lib/parse.js", changed_paths: ["lib/parse.js"], acceptance_results: [{ criterion: "能解析空输入", status: "passed", evidence: "手工读过文件" }, ...(first.includes("repair") ? [{ criterion: "修复 F1：空输入要报错", status: "passed" }] : [])], commands_run: [{ command: "node --test", status: "passed", exit_code: 0 }] });
      } else if (first.includes("质量门：review")) {
        if (step === 0) msg = upd({ status: "failed", output: "校验还是不够", verdict: "needs_revision", findings: [{ id: first.includes("第 2 轮") ? "F2" : "F1", severity: "high", file: "lib/parse.js", line: 1, problem: "没有处理空输入", required_fix: "空输入要报错" }] });
      } else if (who === "bob" && step === 0) msg = { tool_calls: [call("write_file", { path: "summary.md", content: "# 总结\n模块分析结果……" })] };
      else if (step === 0) msg = { tool_calls: [call("read_file", { path: "hello.txt" })] };
      else if (step === 1 && who === "alice") msg = { tool_calls: [call("agent_teams_update_task", { taskId, status: "completed", output: "读完了：入口在 src/index.ts，共 3 个模块，依赖关系清晰。" })] };
      else msg = { content: "完成" };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: msg.content ?? null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) } }], usage: { prompt_tokens: 1800, completion_tokens: 240 } }));
    });
  });
  await new Promise(r => llm.listen(0, "127.0.0.1", r));
  cleanups.push(() => llm.close());
  await plug.call("at/settings/set", { workspace: ws, route: { provider: "mock", model: "mock-1", baseURL: `http://127.0.0.1:${llm.address().port}`, apiKey: "sk-demo" } });
  await plug.tool("agent_teams_create", {
    name: "代码分析", description: "把 src 目录里的模块分析一遍并出评审意见",
    members: [{ name: "alice", role: "researcher", toolPolicy: "readonly" }, { name: "bob", role: "engineer" }, { name: "carol", role: "reviewer", toolPolicy: "readonly" }],
    tasks: [{ ref: "read", subject: "读代码", assignee: "alice", description: "读 hello.txt 并总结" }, { ref: "sum", subject: "写总结", assignee: "bob", dependencies: ["read"] }, { ref: "rev", subject: "评审", assignee: "carol", dependencies: ["sum"] }, { subject: "整理交付物", dependencies: ["rev"] }],
    auto_approve: true,
  });
  await plug.tool("agent_teams_create", { name: "发布准备", description: "准备下一个版本的发布", members: [{ name: "dev" }, { name: "qa", role: "tester" }], tasks: [{ ref: "a", subject: "冻结版本" }, { subject: "回归测试", assignee: "qa", dependencies: ["a"] }] });
  await plug.tool("agent_teams_create", {
    name: "质量门演示", description: "实现 → 评审不过 → 自动修复 → 复审仍不过 → 升级给队长",
    members: [{ name: "alice", role: "engineer" }, { name: "bob", role: "reviewer" }],
    goal_items: ["解析器能处理空输入"], max_repair_attempts: 1,
    tasks: [
      { ref: "impl", subject: "实现解析器", kind: "implementation", assignee: "alice", objective: "写 lib/parse.js", in_scope: ["lib/"], out_of_scope: ["lib/vendor/"], acceptance: ["能解析空输入"], verify: ["node --test"], coverage_of: ["解析器能处理空输入"] },
      { subject: "评审解析器", kind: "review", assignee: "bob", dependencies: ["impl"] },
    ],
    auto_approve: true,
  });
  await plug.call("at/allow-all", { id: "质量门演示", on: true });
  await plug.call("at/send", { id: "代码分析", to: "captain", content: "总结里请带上风险点" });
  console.log(`agent-teams 演示数据就绪，工作区：${ws}`);
}

if (id === "better-sidebar") {
  // 一个带分支和合并的演示仓库，用来看 Git Graph / Markdown 预览 / 语法高亮 / 命令面板
  const { execFileSync } = await import("node:child_process");
  const ws = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "mm-dev-repo-"));
  const g = (...a) => execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...a], { cwd: ws, stdio: "pipe" });
  const commit = (msg, files = {}) => {
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(ws, f), c);
    g("add", "-A");
    g("commit", "-m", msg);
  };
  g("init", "-q", "-b", "main");
  commit("初始化项目", { "README.md": "# 演示项目\n\n这是一个**演示**仓库，用来看 `Markdown` 预览。\n\n- 第一项\n- 第二项\n  - 嵌套项\n\n| 名称 | 说明 |\n| --- | --- |\n| a | 第一个 |\n| b | 第二个 |\n\n```js\nconsole.log(1)\n```\n\n[M-Market](https://github.com/1316584746/M-Market)\n", "app.js": "// 入口\nconst x = 42;\nfunction hello(name) {\n  return `你好，${name}`; // 打招呼\n}\nconsole.log(hello(\"world\"), x);\n", "data.json": '{\n  "name": "demo",\n  "count": 3,\n  "ok": true\n}\n' });
  commit("加上登录", { "login.js": "export const login = () => true;\n" });
  g("checkout", "-q", "-b", "feature/search");
  commit("搜索：第一版", { "search.js": "export const search = q => q;\n" });
  g("checkout", "-q", "main");
  commit("修复登录的小问题", { "login.js": "export const login = () => false;\n" });
  g("checkout", "-q", "-b", "feature/ui");
  commit("界面：骨架", { "ui.css": "body { margin: 0; color: #333; }\n" });
  g("checkout", "-q", "feature/search");
  commit("搜索：支持高亮", { "search.js": "export const search = q => q.trim();\n" });
  g("checkout", "-q", "main");
  g("merge", "-q", "--no-ff", "-m", "合并 feature/search", "feature/search");
  g("checkout", "-q", "feature/ui");
  commit("界面：配色", { "ui.css": "body { margin: 0; color: #111; }\n" });
  g("checkout", "-q", "main");
  g("merge", "-q", "--no-ff", "-m", "合并 feature/ui", "feature/ui");
  g("tag", "v0.1.0");
  fs.writeFileSync(path.join(ws, "app.js"), fs.readFileSync(path.join(ws, "app.js"), "utf8") + "// 未提交的改动\n");
  await plug.call("ws/set", { path: ws });
  console.log(`better-sidebar 演示仓库：${ws}`);
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
