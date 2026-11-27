"use strict";
/**
 * billion-context 管理器：安装 / 启动 / 停止 ranxianglei/billion-context 的代理（命令 bili），
 * 查看运行状态，并把 M-Harness 里每个模型提供方的 baseURL 换算成「走代理」的地址。
 *
 * 本插件不包含 billion-context 的代码，只调用用户机器上装好的 `bili` 命令。
 * billion-context 的许可证（MIT + 产品界面出处标注）要求在使用它的产品界面上标明出处，见界面底部和 NOTICE.md。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const { serve, settings, harnessHome, harnessConfig } = require("./rpc.cjs");

const ID = "billion-context";
const VERSION = require("../manifest.json").version;
const store = settings();
const WIN = process.platform === "win32";
const DEFAULT_PORT = 8787;

const portOf = () => {
  const p = Number(store.get().port);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
};

// ───────── 找 bili ─────────

/** 候选可执行文件：PATH 里的 bili，以及 README 推荐的用户级安装位置 */
function biliCandidates() {
  const h = os.homedir();
  const c = ["bili"];
  if (WIN) {
    c.push(path.join(process.env.APPDATA || path.join(h, "AppData", "Roaming"), "npm", "bili.cmd"));
  } else {
    c.push(path.join(h, ".local", "bin", "bili"), "/usr/local/bin/bili", "/opt/homebrew/bin/bili");
  }
  return c;
}

/** Windows 下走 shell 时命令不会自动加引号，路径里有空格（用户名带空格很常见）会在空格处断掉 */
const shellQuote = c => (WIN && /\s/.test(c) && !/^".*"$/.test(c) ? `"${c}"` : c);

/** 运行 bili（Windows 的 .cmd 需要 shell；参数都是固定的，不拼接用户输入） */
function runBili(cmd, args, timeout = 15000) {
  return spawnSync(shellQuote(cmd), args, { encoding: "utf8", timeout, shell: WIN, windowsHide: true });
}

function findBili() {
  for (const c of biliCandidates()) {
    if (c !== "bili" && !fs.existsSync(c)) continue;
    const r = runBili(c, ["--version"]);
    if (r.status === 0 && /\d+\.\d+/.test(`${r.stdout}`)) return { cmd: c, version: String(r.stdout).trim().split(/\r?\n/).pop() };
  }
  return null;
}

// ───────── 后台任务（安装 / 运行）和日志 ─────────

const logs = [];
const log = s => {
  for (const line of String(s).split(/\r?\n/)) if (line.trim()) logs.push(`${new Date().toTimeString().slice(0, 8)} ${line}`);
  if (logs.length > 400) logs.splice(0, logs.length - 400);
};

let proc = null; // 我们启动的 bili
let installing = null;

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGTERM");
  } catch {
    /* 已经退出 */
  }
}

function ping(port, pathname = "/__bili/health", timeout = 1500) {
  return new Promise(resolve => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout }, res => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", d => (b += d.length < 65536 ? d : ""));
      res.on("end", () => {
        let json;
        try {
          json = JSON.parse(b);
        } catch {
          /* 不是 JSON */
        }
        resolve({ up: res.statusCode === 200, json });
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ up: false }));
  });
}

async function status() {
  const port = portOf();
  const found = findBili();
  const h = await ping(port);
  return {
    platform: process.platform,
    installed: !!found,
    version: found?.version || "",
    command: found?.cmd || "",
    port,
    running: h.up,
    health: h.json || null,
    managed: !!proc && proc.exitCode === null,
    installing: !!installing,
    origin: `http://localhost:${port}`,
  };
}

async function install() {
  if (installing) throw new Error("正在安装中");
  const args = ["install", "-g", "billion-context"];
  if (!WIN) args.push(`--prefix=${path.join(os.homedir(), ".local")}`);
  log(`$ npm ${args.join(" ")}`);
  const child = spawn("npm", args, { shell: WIN, windowsHide: true });
  installing = child;
  child.stdout.on("data", d => log(d));
  child.stderr.on("data", d => log(d));
  child.on("error", e => {
    log(`安装失败：${e.message}`);
    installing = null;
  });
  child.on("exit", code => {
    log(code === 0 ? "安装完成" : `安装失败（退出码 ${code}）。检查是否已装 Node.js / npm，网络是否通畅`);
    installing = null;
  });
  return { started: true };
}

async function start() {
  if (proc && proc.exitCode === null) return status();
  const port = portOf();
  if ((await ping(port)).up) throw new Error(`端口 ${port} 上已经有一个 billion-context 在运行（不是由本插件启动的），可以直接使用`);
  const found = findBili();
  if (!found) throw new Error("没有找到 bili 命令，请先点「安装」");
  log(`$ ${found.cmd} --port ${port}`);
  const child = spawn(shellQuote(found.cmd), ["--port", String(port)], { shell: WIN, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  proc = child;
  child.stdout.on("data", d => log(d));
  child.stderr.on("data", d => log(d));
  child.on("error", e => log(`启动失败：${e.message}`));
  child.on("exit", (code, sig) => {
    log(`bili 已退出（${sig || `退出码 ${code}`}）`);
    if (proc === child) proc = null;
  });
  // 等它起来（最多 12 秒）
  for (let i = 0; i < 24; i++) {
    if (child.exitCode !== null) throw new Error(`bili 启动后立刻退出了，看下面的日志（可能端口被占用）`);
    if ((await ping(port)).up) return status();
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("bili 启动超时（12 秒内没有响应），看下面的日志");
}

async function stop() {
  if (proc) {
    killTree(proc);
    proc = null;
  }
  return status();
}

// ───────── M-Harness 的模型提供方 → 代理地址 ─────────

const DEFAULT_BASE = { anthropic: "https://api.anthropic.com", "openai-compat": "https://api.openai.com/v1" };

function providers() {
  const home = harnessHome();
  const cfg = harnessConfig(home);
  const origin = `http://localhost:${portOf()}`;
  const prefix = `${origin}/bili/`;
  const out = [];
  for (const [name, c] of Object.entries(cfg.providers || {})) {
    if (!c || (c.type !== "anthropic" && c.type !== "openai-compat")) continue; // cli / cursor-sdk 这类外部 Agent 不走这里
    const base = (typeof c.baseURL === "string" && c.baseURL.trim()) || DEFAULT_BASE[c.type] || "";
    const proxied = base.startsWith(prefix);
    const original = proxied ? base.slice(prefix.length) : base;
    out.push({ name, type: c.type, model: c.model || "", isDefault: cfg.defaultProvider === name, baseURL: base, original, proxied, proxyURL: proxied ? base : `${prefix}${original}`, defaulted: !(typeof c.baseURL === "string" && c.baseURL.trim()) });
  }
  return { home, configFound: fs.existsSync(path.join(home, "harness.config.json")), origin, items: out };
}

serve({
  id: ID,
  version: VERSION,
  methods: {
    "bili/status": async () => status(),
    "bili/install": async () => install(),
    "bili/start": async () => start(),
    "bili/stop": async () => stop(),
    "bili/stats": async () => (await ping(portOf(), "/__bili/stats", 3000)).json || null,
    "bili/logs": async () => ({ lines: logs.slice(-200) }),
    "bili/setPort": async p => {
      const n = Number(p.port);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error("端口要在 1024–65535 之间");
      if (proc && proc.exitCode === null) throw new Error("请先停止，再修改端口");
      store.set({ port: n });
      return status();
    },
    "providers/list": async () => providers(),
  },
});

// 宿主结束时带走我们启动的代理，不留孤儿进程
process.on("exit", () => killTree(proc));
