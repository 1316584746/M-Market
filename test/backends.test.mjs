import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { ROOT, launch, tmpdir } from "./helpers.mjs";

const running = [];
const start = async (id, o) => {
  const p = launch(id, o);
  running.push(p);
  return p;
};
after(() => running.forEach(p => p.stop()));

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("握手", () => {
  for (const id of ["context-insight", "memsearch", "billion-context", "better-sidebar", "grafana"]) {
    it(`${id}：返回协议版本 1 和自己的 id`, async () => {
      const p = await start(id);
      const r = await p.init();
      assert.equal(r.protocolVersion, 1);
      assert.equal(r.plugin.id, id);
    });
  }
});

describe("context-insight", () => {
  const home = tmpdir("ci");
  fs.writeFileSync(path.join(home, "harness.config.json"), JSON.stringify({ traceDir: ".traces", providers: {} }));
  const traces = path.join(home, ".traces");
  fs.mkdirSync(traces);
  const ev = (ts, event) => JSON.stringify({ ts, runId: "r1", event });
  fs.writeFileSync(
    path.join(traces, "20260101-120000-abcd.jsonl"),
    [
      ev(1000, { type: "run_start", runId: "r1", provider: "deepseek", input: "帮我重构登录模块" }),
      ev(1001, { type: "model_call", step: 1, messages: [{ role: "system", content: "你是助手" }, { role: "user", content: "帮我重构登录模块" }] }),
      ev(1002, { type: "model_reply", step: 1, ms: 800, tokens: 120, reply: { message: { role: "assistant", content: "" }, toolCalls: [{ id: "1", name: "read_file", args: { path: "a.ts" } }], usage: { input: 100, output: 20, total: 120 } } }),
      ev(1003, { type: "tool_call", step: 1, name: "read_file", args: { path: "a.ts" } }),
      ev(1004, { type: "tool_result", step: 1, name: "read_file", output: "x".repeat(4000), ms: 12 }),
      ev(1005, { type: "context_trim", before: 5000, after: 2000, dropped: 6 }),
      ev(1006, { type: "model_call", step: 2, messages: [{ role: "system", content: "你是助手" }, { role: "user", content: "帮我重构登录模块" }, { role: "tool", content: "x".repeat(4000), toolCallId: "1" }] }),
      ev(1007, { type: "model_reply", step: 2, ms: 900, tokens: 1300, reply: { message: { role: "assistant", content: "完成" }, usage: { input: 1200, output: 100, total: 1300 } } }),
      ev(1008, { type: "done", reason: "final", text: "完成" }),
    ].join("\n") + "\n",
  );

  it("找到家目录里的 trace 并列出", async () => {
    const p = await start("context-insight", { home });
    const list = await p.call("runs/list");
    assert.equal(list.length, 1);
    assert.equal(list[0].steps, 2);
    assert.equal(list[0].tokens, 1420);
    assert.equal(list[0].trims, 1);
    assert.equal(list[0].provider, "deepseek");
  });

  it("分析：token、构成、压缩、工具", async () => {
    const p = await start("context-insight", { home });
    const run = await p.call("runs/get", { name: "20260101-120000-abcd" });
    assert.equal(run.totals.calls, 2);
    assert.equal(run.totals.peakPrompt, 1200);
    assert.equal(run.totals.estimated, false);
    assert.equal(run.trims[0].afterStep, 1);
    assert.equal(run.tools[0].name, "read_file");
    assert.ok(run.steps[1].comp.tool > run.steps[1].comp.user, "第 2 步 tool 输出应该是最大头");
    const msgs = await p.call("runs/messages", { name: "20260101-120000-abcd", step: 2 });
    assert.equal(msgs.length, 3);
  });

  it("外部 Agent 的工具进度算作工具调用", async () => {
    const home = tmpdir("ci-agent");
    fs.writeFileSync(path.join(home, "harness.config.json"), JSON.stringify({ traceDir: ".traces", providers: { cursor: { type: "cursor-sdk", model: "grok-4.7" } } }));
    const traces = path.join(home, ".traces");
    fs.mkdirSync(traces);
    const now = Date.now();
    const ev = (ts, event) => JSON.stringify({ ts, runId: "a1", event });
    fs.writeFileSync(
      path.join(traces, "20261124-180000-agent.jsonl"),
      [
        ev(now, { type: "run_start", provider: "cursor", input: "改一下侧边栏" }),
        ev(now + 1, { type: "agent_progress", kind: "tool", line: '🔧 read {"path":"E:\\\\M-Market\\\\README.md"}' }),
        ev(now + 2, { type: "agent_progress", kind: "tool", line: '   ✓ read → {"status":"success","value":{"content":"hello"}}' }),
        ev(now + 3, { type: "agent_progress", kind: "tool", line: '🔧 shell {"command":"node scripts/pack.mjs","workingDirectory":"E:\\\\M-Market"}' }),
        ev(now + 4, { type: "agent_progress", kind: "tool", line: '   ✓ shell → {"status":"success","value":{"exitCode":0,"stdout":"ok"}}' }),
        ev(now + 5, { type: "agent_progress", kind: "thinking", line: "先看代码" }),
        ev(now + 6, { type: "done", reason: "final", text: "好了" }),
      ].join("\n") + "\n",
    );
    const p = await start("context-insight", { home });
    const list = await p.call("runs/list");
    assert.equal(list[0].tools, 2);
    const ov = await p.call("insights/overview", { range: "today" });
    assert.equal(ov.kpi.toolExec, 2);
    assert.equal(ov.sessions[0].tools, 2);
    assert.deepEqual(ov.tools.map(t => t.name).sort(), ["read", "shell"]);
    assert.equal(ov.commands[0].name, "node");
    assert.ok(ov.comp.toolcalls > 0);
    const d = await p.call("session/get", { name: "20261124-180000-agent" });
    assert.equal(d.stats.toolCalls, 2);
    assert.deepEqual(d.tools.map(t => t.name).sort(), ["read", "shell"]);
  });

  it("拒绝越出 trace 目录的名字", async () => {
    const p = await start("context-insight", { home });
    await assert.rejects(p.call("runs/get", { name: "../harness.config" }), /不合法/);
  });

  it("AI 工具：列表与统计", async () => {
    const p = await start("context-insight", { home });
    const r = await p.tool("context_stats", {});
    assert.match(r.text, /2 次模型调用/);
    assert.match(r.text, /压缩/);
    const l = await p.tool("context_runs", {});
    assert.match(l.text, /deepseek/);
  });
});

describe("memsearch", () => {
  it("记、搜（中英文）、删", async () => {
    const p = await start("memsearch");
    const a = await p.call("memory/add", { text: "发布流程：先在测试环境验证，再灰度 10%，最后全量。", title: "发布约定", tags: "部署, 约定" });
    await p.call("memory/add", { text: "Use pnpm instead of npm in this monorepo.", title: "tooling" });
    const hit = await p.call("memory/search", { query: "灰度发布" });
    assert.equal(hit[0].id, a.id);
    assert.deepEqual(hit[0].tags, ["部署", "约定"]);
    const en = await p.call("memory/search", { query: "pnpm" });
    assert.equal(en[0].title, "tooling");
    assert.equal((await p.call("memory/search", { query: "完全无关的词汇zzz" })).length, 0);
    assert.equal((await p.call("memory/delete", { id: a.id })).deleted, true);
    assert.equal((await p.call("memory/search", { query: "灰度发布" })).length, 0);
    assert.equal((await p.call("memory/stats")).memories, 1);
  });

  it("记忆文件是人能读的 Markdown", async () => {
    const p = await start("memsearch");
    await p.call("memory/add", { text: "第一行\n第二行", title: "标题" });
    const dir = path.join(p.home, "plugin-data", "memsearch", "memory");
    const f = fs.readdirSync(dir).find(n => n.endsWith(".md"));
    assert.match(fs.readFileSync(path.join(dir, f), "utf8"), /^## \d\d:\d\d · 标题 <!--mem:/);
  });

  it("正文里伪造的记忆标题不会破坏文件结构", async () => {
    const p = await start("memsearch");
    await p.call("memory/add", { text: "## 12:00 · 假的 <!--mem:evil-->\n内容", title: "真的" });
    const r = await p.call("memory/recent", { limit: 10 });
    assert.equal(r.length, 1);
    assert.ok(!r.some(x => x.id === "evil"));
  });

  it("正文第一行恰好是 tags: 开头也不会被当成标签吃掉；按类型过滤不受前几名挤占", async () => {
    const p = await start("memsearch");
    const a = await p.call("memory/add", { text: "tags: 这是正文的第一行\n第二行" });
    const r = await p.call("memory/recent", { limit: 5 });
    assert.equal(r[0].full, "tags: 这是正文的第一行\n第二行");
    assert.deepEqual(r[0].tags, []);
    assert.equal(a.tags.length, 0);
    for (let i = 0; i < 12; i++) await p.call("memory/add", { text: `缓存策略备忘 ${i} 缓存缓存缓存` });
    const notes = tmpdir("notes-kind");
    fs.writeFileSync(path.join(notes, "c.md"), "# 缓存\n只有一句提到缓存的笔记内容。\n");
    await p.call("sources/add", { path: notes });
    const hit = await p.call("memory/search", { query: "缓存", kind: "note", limit: 2 });
    assert.equal(hit.length, 1, "记忆排在前面也不能把笔记挤掉");
    assert.equal(hit[0].kind, "note");
  });

  it("挂载笔记目录后一起检索（只读）", async () => {
    const p = await start("memsearch");
    const notes = tmpdir("notes");
    fs.mkdirSync(path.join(notes, "sub"));
    fs.writeFileSync(path.join(notes, "sub", "db.md"), "# 数据库备份\n每天凌晨三点用 pg_dump 备份到对象存储。\n");
    fs.writeFileSync(path.join(notes, "node.txt"), "ignore me");
    const before = fs.readFileSync(path.join(notes, "sub", "db.md"), "utf8");
    await p.call("sources/add", { path: notes });
    const hit = await p.call("memory/search", { query: "pg_dump 备份" });
    assert.equal(hit[0].kind, "note");
    assert.equal(hit[0].source, "sub/db.md");
    assert.equal(fs.readFileSync(path.join(notes, "sub", "db.md"), "utf8"), before);
    await assert.rejects(p.call("sources/add", { path: path.join(notes, "nope") }), /不存在/);
  });

  it("AI 工具：只读 / 写入标注正确，调用可用", async () => {
    const p = await start("memsearch");
    const tools = (await p.call("mcp/tools")).tools;
    const ro = Object.fromEntries(tools.map(t => [t.name, t.annotations.readOnlyHint]));
    assert.deepEqual(ro, { memory_search: true, memory_recent: true, memory_add: false });
    assert.match((await p.tool("memory_add", { text: "用户喜欢简洁的回答", title: "偏好" })).text, /已记下/);
    assert.match((await p.tool("memory_search", { query: "简洁" })).text, /偏好/);
    assert.equal((await p.tool("memory_add", { text: "  " })).isError, true);
  });
});

describe("better-sidebar", () => {
  it("文件：列目录、读、写（保留 CRLF）、越界拒绝", async () => {
    const ws = tmpdir("ws");
    fs.mkdirSync(path.join(ws, "src"));
    fs.writeFileSync(path.join(ws, "src", "a.txt"), "one\r\ntwo\r\n");
    fs.writeFileSync(path.join(ws, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    fs.writeFileSync(path.join(tmpdir("outside"), "secret.txt"), "x");
    const p = await start("better-sidebar");
    await p.call("ws/set", { path: ws });
    const l = await p.call("fs/list", { dir: "" });
    assert.deepEqual(l.entries.map(e => e.name), ["src", "bin.dat"]);
    const r = await p.call("fs/read", { path: "src/a.txt" });
    assert.equal(r.content, "one\ntwo\n");
    assert.equal(r.eol, "crlf");
    assert.equal((await p.call("fs/read", { path: "bin.dat" })).binary, true);
    await p.call("fs/write", { path: "src/a.txt", content: "one\ntwo\nthree\n", eol: "crlf", expectMtime: r.mtime });
    assert.equal(fs.readFileSync(path.join(ws, "src", "a.txt"), "utf8"), "one\r\ntwo\r\nthree\r\n");
    await assert.rejects(p.call("fs/read", { path: "../x" }), /超出/);
    await assert.rejects(p.call("fs/write", { path: "../evil.txt", content: "x" }), /超出/);
    await assert.rejects(p.call("fs/read", { path: "C:/Windows/win.ini" }), /不合法/);
    // 外部改动过：带旧 mtime 保存要被拒
    fs.utimesSync(path.join(ws, "src", "a.txt"), new Date(), new Date(Date.now() + 5000));
    await assert.rejects(p.call("fs/write", { path: "src/a.txt", content: "z", expectMtime: r.mtime }), /改过/);
    await p.call("fs/create", { path: "src/new.md" });
    assert.ok(fs.existsSync(path.join(ws, "src", "new.md")));
  });

  it("盘符根目录下的子目录仍在工作区内", async t => {
    if (process.platform !== "win32") return t.skip("只在 Windows 上有盘符根");
    const root = (process.env.SystemDrive || "C:") + "\\";
    const p = await start("better-sidebar");
    await p.call("ws/set", { path: root });
    const l = await p.call("fs/list", { dir: "" });
    assert.ok(l.entries.some(e => e.dir));
    let opened = false;
    for (const e of l.entries) {
      if (!e.dir) continue;
      try {
        await p.call("fs/list", { dir: e.name });
        opened = true;
        break;
      } catch (err) {
        if (/超出了工作区/.test(String(err && err.message))) throw err;
      }
    }
    assert.equal(opened, true);
    await assert.rejects(p.call("fs/read", { path: "C:/Windows/win.ini" }), /不合法/);
  });

  it("搜索：文件名和内容", async () => {
    const ws = tmpdir("ws");
    fs.mkdirSync(path.join(ws, "node_modules"));
    fs.writeFileSync(path.join(ws, "node_modules", "skip.js"), "needle");
    fs.writeFileSync(path.join(ws, "readme.md"), "hello\nthe needle is here\n");
    const p = await start("better-sidebar");
    await p.call("ws/set", { path: ws });
    assert.deepEqual((await p.call("fs/find", { query: "READ" })).hits, ["readme.md"]);
    const g = await p.call("fs/grep", { query: "needle" });
    assert.deepEqual(g.hits.map(h => `${h.path}:${h.line}`), ["readme.md:2"]);
  });

  it("符号链接不能指到工作区外", async t => {
    const ws = tmpdir("ws");
    const out = tmpdir("out");
    fs.writeFileSync(path.join(out, "s.txt"), "secret");
    try {
      fs.symlinkSync(out, path.join(ws, "link"), "junction");
    } catch {
      return t.skip("这个系统不能建符号链接");
    }
    const p = await start("better-sidebar");
    await p.call("ws/set", { path: ws });
    await assert.rejects(p.call("fs/read", { path: "link/s.txt" }), /符号链接/);
  });

  it("Git：状态、diff、暂存、日志", async t => {
    if (!hasGit) return t.skip("没有 git");
    const ws = tmpdir("repo");
    const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: ws, stdio: "pipe" });
    g("init", "-q");
    fs.writeFileSync(path.join(ws, "a.txt"), "1\n2\n");
    g("add", "."); g("commit", "-qm", "第一次提交");
    fs.writeFileSync(path.join(ws, "a.txt"), "1\n2\n3\n");
    fs.writeFileSync(path.join(ws, "new.txt"), "n\n");
    const p = await start("better-sidebar");
    await p.call("ws/set", { path: ws });
    const st = await p.call("git/status");
    assert.equal(st.isRepo, true);
    assert.ok(st.branch);
    assert.deepEqual(st.files.map(f => f.path).sort(), ["a.txt", "new.txt"]);
    assert.equal(st.files.find(f => f.path === "new.txt").untracked, true);
    assert.match((await p.call("git/diff", { path: "a.txt" })).text, /\+3/);
    assert.match((await p.call("git/diff", { path: "new.txt" })).text, /\+n/);
    const staged = await p.call("git/stage", { paths: ["a.txt"] });
    assert.equal(staged.files.find(f => f.path === "a.txt").staged, true);
    assert.match((await p.call("git/diff", { path: "a.txt", staged: true })).text, /\+3/);
    const un = await p.call("git/unstage", { paths: ["a.txt"] });
    assert.equal(un.files.find(f => f.path === "a.txt").staged, false);
    const log = await p.call("git/log", { limit: 5 });
    assert.equal(log[0].subject, "第一次提交");
  });

  it("非 Git 目录：isRepo=false，不报错", async t => {
    if (!hasGit) return t.skip("没有 git");
    const ws = tmpdir("plain");
    const p = await start("better-sidebar");
    await p.call("ws/set", { path: ws });
    assert.equal((await p.call("git/status")).isRepo, false);
  });
});

describe("billion-context", () => {
  it("读 M-Harness 的模型提供方，换算代理地址，且不泄露 apiKey", async () => {
    const home = tmpdir("bc");
    fs.writeFileSync(
      path.join(home, "harness.config.json"),
      JSON.stringify({
        defaultProvider: "ds",
        providers: {
          ds: { type: "openai-compat", baseURL: "https://api.deepseek.com/v1", apiKey: "sk-SECRET", model: "deepseek-chat" },
          claude: { type: "anthropic", apiKey: "sk-ant-SECRET", model: "claude" },
          codex: { type: "cli", preset: "codex" },
        },
      }),
    );
    const p = await start("billion-context", { home });
    const r = await p.call("providers/list");
    const raw = JSON.stringify(r);
    assert.ok(!raw.includes("SECRET"));
    assert.deepEqual(r.items.map(x => x.name), ["ds", "claude"]);
    assert.equal(r.items[0].proxyURL, "http://localhost:8787/bili/https://api.deepseek.com/v1");
    assert.equal(r.items[1].proxyURL, "http://localhost:8787/bili/https://api.anthropic.com");
    assert.equal(r.items[1].defaulted, true);
    assert.equal(r.items[0].isDefault, true);
  });

  it("已经走代理的提供方能还原出原地址", async () => {
    const home = tmpdir("bc2");
    fs.writeFileSync(path.join(home, "harness.config.json"), JSON.stringify({ providers: { a: { type: "openai-compat", baseURL: "http://localhost:8787/bili/https://x.test/v1", model: "m" } } }));
    const p = await start("billion-context", { home });
    const a = (await p.call("providers/list")).items[0];
    assert.equal(a.proxied, true);
    assert.equal(a.original, "https://x.test/v1");
  });

  it("状态可读（没装 / 没跑也不报错），端口校验", async () => {
    const p = await start("billion-context");
    const s = await p.call("bili/status");
    assert.equal(typeof s.installed, "boolean");
    assert.equal(s.port, 8787);
    await assert.rejects(p.call("bili/setPort", { port: 80 }), /1024/);
    assert.equal((await p.call("bili/setPort", { port: 18999 })).port, 18999);
  });

  it("bili 装在带空格的路径里（用户名带空格）也找得到并能启动", { skip: process.platform !== "win32" }, async () => {
    const roaming = path.join(tmpdir("bc-sp"), "Doe John", "Roaming");
    fs.mkdirSync(path.join(roaming, "npm"), { recursive: true });
    fs.writeFileSync(path.join(roaming, "npm", "bili.cmd"), "@echo off\r\necho 9.8.7\r\n");
    const p = await start("billion-context", { env: { APPDATA: roaming } });
    const s = await p.call("bili/status");
    assert.equal(s.installed, true);
    assert.equal(s.version, "9.8.7");
  });

  it("界面里带有出处标注", () => {
    const html = fs.readFileSync(path.join(p0(), "billion-context", "ui", "index.html"), "utf8");
    assert.match(html, /github\.com\/ranxianglei\/billion-context/);
    assert.match(html, /acp-kernel/);
  });
});

function p0() {
  return path.join(ROOT, "plugins");
}
