"use strict";
/**
 * Better Sidebar（精简版）：给 M-Harness 的文件树、文本查看 / 编辑、搜索和 Git 状态 / diff。
 * 所有路径都限制在「工作区根目录」之内（含符号链接检查）；Git 只做只读查询加暂存 / 取消暂存。
 * 产品形态参考 DSH-better-sidebar（MIT）；这里是针对 M-Harness 插件宿主重写的精简版，没有终端、侧边对话、子代理页。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { serve, settings, harnessHome, harnessConfig } = require("./rpc.cjs");

const ID = "better-sidebar";
const VERSION = require("../manifest.json").version;
const store = settings();
const LIM = { list: 3000, read: 2 * 1024 * 1024, grepFile: 512 * 1024, grepFiles: 5000, grepHits: 200, nameHits: 200, walk: 30000, diff: 400 * 1024 };
const HEAVY = /^(node_modules|\.git|dist|build|out|target|\.next|\.venv|__pycache__|\.traces|\.idea|\.vscode-test)$/;

// ───────── 工作区根 ─────────

function candidates() {
  const home = harnessHome();
  const cfg = harnessConfig(home);
  const out = [];
  const add = (p, why) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory() && !out.some(x => x.path === abs)) out.push({ path: abs, why });
  };
  for (const r of store.get().recent || []) add(r, "最近使用");
  if (typeof cfg.workspace === "string") add(path.resolve(home, cfg.workspace), "M-Harness 的工作区");
  add(home, "M-Harness 家目录");
  add(os.homedir(), "用户目录");
  return out;
}

function root() {
  const s = store.get();
  if (s.root && fs.existsSync(s.root)) return s.root;
  const c = candidates()[0];
  return c ? c.path : "";
}

function wsInfo() {
  return { root: root(), candidates: candidates() };
}

function setRoot(p) {
  const abs = path.resolve(String(p || "").trim());
  if (!p || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error("这个目录不存在");
  const recent = [abs, ...(store.get().recent || []).filter(x => x !== abs)].slice(0, 8);
  store.set({ root: abs, recent });
  return wsInfo();
}

const inside = (base, p) => {
  const b = path.resolve(base);
  const f = path.resolve(p);
  return f === b || f.startsWith(b + path.sep);
};

/** 相对路径 → 根目录内的绝对路径；跑出根目录（含符号链接）就报错 */
function resolveIn(rel, mustExist = true) {
  const base = root();
  if (!base) throw new Error("还没有选择工作区目录");
  const r = String(rel || "").replace(/\\/g, "/");
  if (r.includes("\0") || path.isAbsolute(r)) throw new Error("路径不合法");
  const abs = path.resolve(base, r);
  if (!inside(base, abs)) throw new Error("路径超出了工作区");
  const realBase = fs.realpathSync(base);
  if (fs.existsSync(abs)) {
    if (!inside(realBase, fs.realpathSync(abs))) throw new Error("路径通过符号链接指向了工作区外面");
  } else {
    if (mustExist) throw new Error("文件不存在");
    // 新文件：它所在的目录必须在根目录里
    const parent = path.dirname(abs);
    if (!fs.existsSync(parent) || !inside(realBase, fs.realpathSync(parent))) throw new Error("目录不在工作区里");
  }
  return abs;
}

const relOf = abs => path.relative(root(), abs).split(path.sep).join("/");

// ───────── 文件 ─────────

function list(dir) {
  const abs = resolveIn(dir || "");
  if (!fs.statSync(abs).isDirectory()) throw new Error("不是目录");
  const ents = fs.readdirSync(abs, { withFileTypes: true }).filter(e => e.name !== ".git");
  const out = [];
  for (const e of ents.slice(0, LIM.list)) {
    let st = null;
    try {
      st = fs.statSync(path.join(abs, e.name));
    } catch {
      /* 断开的符号链接 */
    }
    out.push({ name: e.name, dir: st ? st.isDirectory() : e.isDirectory(), size: st && !st.isDirectory() ? st.size : 0, mtime: st ? st.mtimeMs : 0, link: e.isSymbolicLink() || undefined });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, "zh-CN", { numeric: true }) : a.dir ? -1 : 1));
  return { dir: dir || "", entries: out, truncated: ents.length > LIM.list };
}

function read(rel) {
  const abs = resolveIn(rel);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error("不是文件");
  if (st.size > LIM.read) return { path: rel, size: st.size, tooLarge: true, mtime: st.mtimeMs };
  const buf = fs.readFileSync(abs);
  const head = buf.subarray(0, 8000);
  if (head.includes(0)) return { path: rel, size: st.size, binary: true, mtime: st.mtimeMs };
  let text = buf.toString("utf8");
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  const eol = crlf > lf ? "crlf" : "lf";
  return { path: rel, size: st.size, mtime: st.mtimeMs, content: eol === "crlf" ? text.replace(/\r\n/g, "\n") : text, eol, bom };
}

function write({ path: rel, content, eol, bom, expectMtime }) {
  const abs = resolveIn(rel, false);
  if (fs.existsSync(abs)) {
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error("不是文件");
    if (typeof expectMtime === "number" && Math.abs(st.mtimeMs - expectMtime) > 1) throw new Error("文件在你打开之后被别的程序改过了，先「重新加载」再保存，避免覆盖对方的修改");
  }
  let text = String(content ?? "");
  if (eol === "crlf") text = text.replace(/\r?\n/g, "\r\n");
  fs.writeFileSync(abs, (bom ? "\ufeff" : "") + text, "utf8");
  return { mtime: fs.statSync(abs).mtimeMs, size: Buffer.byteLength(text) };
}

function create({ path: rel, dir }) {
  const abs = resolveIn(rel, false);
  if (fs.existsSync(abs)) throw new Error("已经存在同名文件或目录");
  if (dir) fs.mkdirSync(abs);
  else fs.writeFileSync(abs, "");
  return { path: relOf(abs) };
}

function walkFiles(onFile, limit = LIM.walk) {
  const base = root();
  let n = 0;
  const go = dir => {
    if (n >= limit) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (n >= limit) return;
      if (HEAVY.test(e.name)) continue;
      const p = path.join(dir, e.name);
      n++;
      if (e.isDirectory()) go(p);
      else if (e.isFile() && onFile(p) === false) {
        n = limit;
        return;
      }
    }
  };
  go(base);
  return n >= limit;
}

function findNames(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { hits: [], truncated: false };
  const hits = [];
  const cut = walkFiles(p => {
    const rel = relOf(p);
    if (rel.toLowerCase().includes(q)) hits.push(rel);
    return hits.length < LIM.nameHits;
  });
  return { hits, truncated: cut || hits.length >= LIM.nameHits };
}

function grep(query) {
  const q = String(query || "");
  if (q.length < 2) throw new Error("至少输入 2 个字符");
  const low = q.toLowerCase();
  const hits = [];
  let files = 0;
  const cut = walkFiles(p => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return true;
    }
    if (st.size > LIM.grepFile) return true;
    if (++files > LIM.grepFiles) return false;
    let buf;
    try {
      buf = fs.readFileSync(p);
    } catch {
      return true;
    }
    if (buf.subarray(0, 4000).includes(0)) return true;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(low)) {
        hits.push({ path: relOf(p), line: i + 1, text: lines[i].trim().slice(0, 200) });
        if (hits.length >= LIM.grepHits) return false;
      }
    }
    return true;
  });
  return { hits, truncated: cut || files > LIM.grepFiles || hits.length >= LIM.grepHits };
}

// ───────── Git ─────────

function git(args, { allowFail = false, input } = {}) {
  return new Promise((resolve, reject) => {
    const cwd = root();
    if (!cwd) return reject(new Error("还没有选择工作区目录"));
    const child = execFile("git", ["-c", "core.quotepath=false", ...args], { cwd, timeout: 20000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } }, (err, stdout, stderr) => {
      if (err && !allowFail) {
        if (err.code === "ENOENT") return reject(new Error("没有找到 git 命令，请先安装 Git"));
        return reject(new Error((stderr || err.message || "git 出错").trim().slice(0, 400)));
      }
      resolve(String(stdout));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function isRepo() {
  try {
    return (await git(["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch (e) {
    if (/没有找到 git/.test(e.message)) throw e;
    return false;
  }
}

async function gitStatus() {
  if (!(await isRepo())) return { isRepo: false, files: [] };
  const out = await git(["status", "--porcelain=v1", "-b", "-z", "-uall"]);
  const parts = out.split("\0");
  let branch = "";
  let upstream = "";
  let ahead = 0;
  let behind = 0;
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    if (s.startsWith("## ")) {
      const m = /^## (?:No commits yet on |Initial commit on )?([^.\s]+(?:\.[^.\s]+)*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(s);
      branch = m ? m[1] : s.slice(3);
      upstream = (m && m[2]) || "";
      const ab = (m && m[3]) || "";
      ahead = Number((/ahead (\d+)/.exec(ab) || [])[1] || 0);
      behind = Number((/behind (\d+)/.exec(ab) || [])[1] || 0);
      continue;
    }
    const x = s[0];
    const y = s[1];
    const p = s.slice(3);
    let from;
    if (x === "R" || x === "C") from = parts[++i];
    files.push({ path: p, from, x, y, staged: x !== " " && x !== "?", changed: y !== " " && y !== "?", untracked: x === "?" });
  }
  return { isRepo: true, branch, upstream, ahead, behind, files };
}

async function gitDiff({ path: rel, staged }) {
  const abs = resolveIn(rel, false);
  const st = await gitStatus();
  const f = st.files.find(x => x.path === rel);
  if (f && f.untracked) {
    const r = read(rel);
    if (r.binary || r.tooLarge) return { text: `（${r.binary ? "二进制" : "过大的"}新文件，不显示内容）` };
    const lines = r.content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return { text: `new file: ${rel}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map(l => "+" + l).join("\n") };
  }
  void abs;
  const out = await git(["diff", ...(staged ? ["--cached"] : []), "--no-color", "--", rel]);
  return { text: out.length > LIM.diff ? out.slice(0, LIM.diff) + "\n…（diff 太长，已截断）" : out || "（没有差异）" };
}

async function gitLog(limit) {
  if (!(await isRepo())) return [];
  const n = Math.max(1, Math.min(Number(limit) || 30, 200));
  let out = "";
  try {
    out = await git(["log", `-n${n}`, "--date=short", "--pretty=format:%h%x1f%an%x1f%ad%x1f%s"]);
  } catch {
    return []; // 还没有任何提交
  }
  return out.split("\n").filter(Boolean).map(l => {
    const [hash, author, date, subject] = l.split("\x1f");
    return { hash, author, date, subject };
  });
}

async function gitStage(paths, on) {
  const list = (Array.isArray(paths) ? paths : []).map(String);
  if (!list.length) return gitStatus();
  for (const p of list) resolveIn(p, false);
  if (on) await git(["add", "--", ...list]);
  else {
    try {
      await git(["reset", "-q", "HEAD", "--", ...list]);
    } catch {
      await git(["rm", "--cached", "-q", "-r", "--", ...list]); // 还没有任何提交时 reset 不能用
    }
  }
  return gitStatus();
}

serve({
  id: ID,
  version: VERSION,
  methods: {
    "ws/get": async () => wsInfo(),
    "ws/set": async p => setRoot(p.path),
    "fs/list": async p => list(p.dir),
    "fs/read": async p => read(p.path),
    "fs/write": async p => write(p),
    "fs/create": async p => create(p),
    "fs/find": async p => findNames(p.query),
    "fs/grep": async p => grep(p.query),
    "git/status": async () => gitStatus(),
    "git/diff": async p => gitDiff(p),
    "git/log": async p => gitLog(p.limit),
    "git/stage": async p => gitStage(p.paths, true),
    "git/unstage": async p => gitStage(p.paths, false),
  },
});
