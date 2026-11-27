"use strict";
/**
 * 成员自己的文件 / 命令工具。这些不经过 M-Harness 的审批，所以由插件自己把关：
 *   - 读：直接放行，但只能读工作区里的文件；
 *   - 写文件、跑命令：先过 ask()（界面里点确认；团队开了「全部允许」才免确认）；
 *   - toolPolicy 为 readonly 的成员根本拿不到写和执行工具。
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_READ = 200 * 1024;
const MAX_OUT = 20 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", ".next", "__pycache__"]);

/** 解析成工作区内的绝对路径；跳出工作区（含符号链接）直接报错 */
function safePath(workspace, p) {
  const root = fs.realpathSync(workspace);
  const abs = path.resolve(root, String(p || "."));
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = fs.realpathSync(probe);
  const rel = path.relative(root, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`路径不在工作区内：${p}`);
  return abs;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…（已截断，共 ${s.length} 字符）` : s);

function walk(dir, visit, limit = { n: 2000 }) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (limit.n <= 0) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, visit, limit);
    } else if (e.isFile()) {
      limit.n--;
      visit(full);
    }
  }
}

function runCommand(command, cwd, signal, timeoutMs = 120000) {
  return new Promise(resolve => {
    const win = process.platform === "win32";
    // Windows：cmd /s /c "命令" 要原样传，不能让 Node 再转义一遍引号
    const child = win
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${command}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true })
      : spawn("sh", ["-c", command], { cwd });
    let out = "";
    let timedOut = false;
    const add = d => {
      if (out.length < MAX_OUT * 2) out += d;
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const kill = () => {
      try {
        if (win) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
        else child.kill("SIGKILL");
      } catch {
        /* 已经退出 */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", e => {
      clearTimeout(timer);
      resolve(`无法启动命令：${e.message}`);
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve(`${clip(out, MAX_OUT)}\n[exit ${timedOut ? "timeout" : code}]`);
    });
  });
}

/** ask(kind, detail) => Promise<boolean>；返回要交给模型的工具定义 */
/** guard(rel) 返回拒绝原因就拦住这次写入；onWrite(rel) 在写成功后记一笔（质量门审计用） */
function fileTools({ workspace, ask, policy, guard, onWrite }) {
  const tools = [
    {
      name: "read_file",
      description: "读工作区里的一个文本文件。可用 offset / limit 按行分段读。",
      parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", description: "从第几行开始（从 1 起）" }, limit: { type: "integer", description: "最多读多少行" } }, required: ["path"] },
      async run({ path: p, offset, limit }) {
        const f = safePath(workspace, p);
        const st = fs.statSync(f);
        if (!st.isFile()) throw new Error(`不是文件：${p}`);
        if (st.size > 5 * 1024 * 1024) throw new Error(`文件太大（${st.size} 字节），请用 search_text 或分段读`);
        let text = fs.readFileSync(f, "utf8");
        if (offset || limit) {
          const lines = text.split("\n");
          const from = Math.max(1, Number(offset) || 1) - 1;
          text = lines.slice(from, limit ? from + Number(limit) : undefined).join("\n");
        }
        return clip(text, MAX_READ);
      },
    },
    {
      name: "list_dir",
      description: "列出工作区里一个目录的内容（目录以 / 结尾）。",
      parameters: { type: "object", properties: { path: { type: "string", description: "默认工作区根目录" } } },
      async run({ path: p }) {
        const d = safePath(workspace, p || ".");
        const ents = fs.readdirSync(d, { withFileTypes: true }).slice(0, 300);
        return ents.map(e => e.name + (e.isDirectory() ? "/" : "")).join("\n") || "（空目录）";
      },
    },
    {
      name: "search_text",
      description: "在工作区里按正则（或普通文本）搜索，返回「文件:行号: 内容」，最多 50 条。",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "只搜这个子目录" } }, required: ["pattern"] },
      async run({ pattern, path: p }) {
        let re;
        try {
          re = new RegExp(String(pattern), "i");
        } catch {
          re = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        }
        const root = fs.realpathSync(workspace);
        const hits = [];
        walk(safePath(workspace, p || "."), file => {
          if (hits.length >= 50) return;
          try {
            if (fs.statSync(file).size > 1024 * 1024) return;
            const lines = fs.readFileSync(file, "utf8").split("\n");
            for (let i = 0; i < lines.length && hits.length < 50; i++) if (re.test(lines[i])) hits.push(`${path.relative(root, file).split(path.sep).join("/")}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          } catch {
            /* 读不了的文件跳过 */
          }
        });
        return hits.join("\n") || "没有匹配";
      },
    },
  ];
  if (policy === "readonly") return tools;
  tools.push(
    {
      name: "write_file",
      description: "写（覆盖）工作区里的一个文件，目录不存在会创建。需要用户确认。",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      async run({ path: p, content }, ctx) {
        const f = safePath(workspace, p);
        const text = String(content ?? "");
        const rel = path.relative(fs.realpathSync(workspace), f).split(path.sep).join("/");
        const why = guard ? guard(rel) : null;
        if (why) throw new Error(why);
        if (!(await ask("write", { path: p, bytes: Buffer.byteLength(text), preview: text.slice(0, 400) }, ctx))) return "用户拒绝了这次写入。";
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, text);
        if (onWrite) onWrite(rel);
        return `已写入 ${p}（${Buffer.byteLength(text)} 字节）`;
      },
    },
    {
      name: "run_command",
      description: "在工作区里执行一条命令（Windows 用 cmd，其它用 sh），2 分钟超时。需要用户确认。",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      async run({ command }, ctx) {
        const cmd = String(command || "").trim();
        if (!cmd) throw new Error("command 不能为空");
        if (!(await ask("exec", { command: cmd }, ctx))) return "用户拒绝了这条命令。";
        return runCommand(cmd, fs.realpathSync(workspace), ctx?.signal);
      },
    },
  );
  return tools;
}

module.exports = { fileTools, safePath, runCommand };
