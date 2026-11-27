"use strict";
/**
 * Better Sidebar（精简版）：给 M-Harness 的文件树、文本查看 / 编辑、搜索和 Git 状态 / diff。
 * 文件路径都限制在「工作区根目录」之内（含符号链接检查）；Git 只做只读查询加暂存 / 取消暂存，外加 Git Graph。
 * 另有一个没有 PTY 的简易命令执行（term/*）：一条命令一个子进程，不限制在工作区内，和你自己开终端一样。
 * 这里是针对 M-Harness 插件宿主重写的版本，没有侧边对话、子代理页。
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
  let b = path.resolve(base);
  let f = path.resolve(p);
  // 盘符根（E:\）自己就以分隔符结尾，再拼一个分隔符会变成 E:\\，子目录全被当成越界
  if (process.platform === "win32") {
    b = b.toLowerCase();
    f = f.toLowerCase();
  }
  if (f === b) return true;
  const prefix = b.endsWith(path.sep) ? b : b + path.sep;
  return f.startsWith(prefix);
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

// ───────── Git Graph ─────────

/** 所有分支的提交（按时间排，子在前、父在后），界面按 parents 算分叉和合并的连线 */
async function gitGraph(limit) {
  if (!(await isRepo())) return { isRepo: false, commits: [] };
  const n = Math.max(10, Math.min(Number(limit) || 200, 1000));
  let out = "";
  try {
    out = await git(["log", "--all", "--date-order", `-n${n}`, "--date=format:%Y-%m-%d %H:%M", "--pretty=format:%H%x1f%P%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%D"]);
  } catch {
    return { isRepo: true, commits: [] }; // 还没有任何提交
  }
  const commits = out.split("\n").filter(Boolean).map(l => {
    const [hash, parents, short, author, date, subject, refs] = l.split("\x1f");
    return { hash, parents: parents ? parents.split(" ") : [], short, author, date, subject, refs: refs ? refs.split(", ").map(s => s.trim()).filter(Boolean) : [] };
  });
  return { isRepo: true, commits };
}

/** 一个提交的详情：说明 + 改了哪些文件 + 这次提交的 diff（太长截断）。合并提交对比的是第一个父提交，也就是「合进来了什么」 */
async function gitShow(hash) {
  if (!/^[0-9a-f]{4,40}$/i.test(String(hash || ""))) throw new Error("提交号不合法");
  const head = await git(["show", "-s", "--date=format:%Y-%m-%d %H:%M", "--format=%H%x1f%an <%ae>%x1f%ad%x1f%B", hash]);
  const [full, author, date, ...rest] = head.split("\x1f");
  const files = (await git(["show", "-m", "--first-parent", "--name-status", "--format=", hash])).split("\n").filter(Boolean).map(l => {
    const [status, ...p] = l.split("\t");
    return { status: status[0], path: p[p.length - 1], from: p.length > 1 ? p[0] : undefined };
  });
  const diff = await git(["show", "-m", "--first-parent", "--no-color", "--format=", "--patch", hash]);
  return { hash: full, author, date, message: rest.join("\x1f").trim(), files, diff: diff.length > LIM.diff ? diff.slice(0, LIM.diff) + "\n…（diff 太长，已截断）" : diff };
}

// ───────── 命令执行（没有 PTY 的简易终端） ─────────
// 一条命令一个子进程，输出轮询取；运行中可以往它的 stdin 写一行，也可以停掉。
// `cd 目录` 在这里只改后面命令的工作目录。拿不到真正的终端，所以 vim、top 这类全屏程序不能用。

const { spawn, spawnSync } = require("node:child_process");
/** Windows 控制台命令（dir、echo 等）按系统的 OEM 代码页输出，Node / git 等是 UTF-8：先严格按 UTF-8 解，解不了再按 OEM 解 */
let oem = null;
function oemDecoder() {
  if (oem) return oem;
  let label = "utf-8";
  if (process.platform === "win32") {
    try {
      const r = spawnSync("cmd.exe", ["/d", "/c", "chcp"], { windowsHide: true, timeout: 3000 });
      const cp = Number(/(\d+)\s*$/.exec(r.stdout.toString("latin1").trim())?.[1]);
      label = { 936: "gbk", 950: "big5", 932: "shift_jis", 949: "euc-kr", 65001: "utf-8" }[cp] || "windows-1252";
    } catch {
      /* 取不到就按 UTF-8 */
    }
  }
  try {
    oem = new TextDecoder(label);
  } catch {
    oem = new TextDecoder("utf-8");
  }
  return oem;
}
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const decodeChunk = buf => {
  try {
    return strictUtf8.decode(buf);
  } catch {
    return oemDecoder().decode(buf);
  }
};

/** 按行解码：整行到齐再解，避免多字节字符被切开；没有换行的提示符 200ms 后也会放出来 */
function pipeDecoded(stream, add) {
  let pend = Buffer.alloc(0);
  let timer = null;
  const flush = () => {
    if (pend.length) add(decodeChunk(pend));
    pend = Buffer.alloc(0);
  };
  stream.on("data", d => {
    clearTimeout(timer);
    pend = Buffer.concat([pend, d]);
    const nl = pend.lastIndexOf(0x0a);
    if (nl >= 0) {
      add(decodeChunk(pend.subarray(0, nl + 1)));
      pend = pend.subarray(nl + 1);
    }
    if (pend.length > 65536) flush();
    else if (pend.length) timer = setTimeout(flush, 200);
  });
  stream.on("end", () => {
    clearTimeout(timer);
    flush();
  });
}

const JOBS = new Map();
let jobSeq = 0;
let termCwd = "";
const TERM = { buf: 512 * 1024, keep: 12, max: 4 };

const killTree = job => {
  if (!job.child || job.done) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(job.child.pid), "/T", "/F"], { windowsHide: true });
    else job.child.kill("SIGTERM");
  } catch {
    /* 已经退出 */
  }
};

function cwdNow() {
  if (termCwd && fs.existsSync(termCwd)) return termCwd;
  return root() || os.homedir();
}

function termStart(command) {
  const cmd = String(command || "").trim();
  if (!cmd) throw new Error("命令不能为空");
  if (cmd.length > 4000) throw new Error("命令太长");
  const cd = /^cd(?:\s+(?:\/d\s+)?(.*))?$/i.exec(cmd);
  if (cd && !/[&|;<>]/.test(cmd)) {
    const raw = (cd[1] || "").trim().replace(/^"(.*)"$/, "$1");
    const next = raw ? path.resolve(cwdNow(), raw === "~" ? os.homedir() : raw) : root() || os.homedir();
    if (!fs.existsSync(next) || !fs.statSync(next).isDirectory()) throw new Error(`目录不存在：${next}`);
    termCwd = next;
    return { id: 0, cwd: next, cd: true };
  }
  if ([...JOBS.values()].filter(j => !j.done).length >= TERM.max) throw new Error(`最多同时运行 ${TERM.max} 条命令，先停掉几条`);
  const cwd = cwdNow();
  const env = { ...process.env, TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0" };
  const win = process.platform === "win32";
  const child = win
    ? spawn("cmd.exe", ["/d", "/s", "/c", `"${cmd}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
    : spawn("/bin/sh", ["-c", cmd], { cwd, env, detached: false });
  const job = { id: ++jobSeq, command: cmd, cwd, child, out: "", dropped: 0, done: false, code: null, signal: null, startedAt: Date.now() };
  JOBS.set(job.id, job);
  const add = s => {
    job.out += s;
    if (job.out.length > TERM.buf) {
      const cut = job.out.length - TERM.buf;
      job.out = job.out.slice(cut);
      job.dropped += cut;
    }
  };
  pipeDecoded(child.stdout, add);
  pipeDecoded(child.stderr, add);
  child.on("error", e => {
    add(`\n启动失败：${e.message}\n`);
    job.done = true;
  });
  child.on("close", (code, signal) => {
    job.done = true;
    job.code = code;
    job.signal = signal;
    job.endedAt = Date.now();
  });
  // 只留最近几条已结束的
  const finished = [...JOBS.values()].filter(j => j.done);
  for (const j of finished.slice(0, Math.max(0, finished.length - TERM.keep))) JOBS.delete(j.id);
  return { id: job.id, cwd };
}

function termPoll(id, since) {
  const job = JOBS.get(Number(id));
  if (!job) throw new Error("没有这条命令（可能已经被清理）");
  const from = Math.max(0, Number(since) || 0);
  const total = job.dropped + job.out.length;
  const text = job.out.slice(Math.max(0, from - job.dropped));
  return { id: job.id, text, next: total, done: job.done, code: job.code, signal: job.signal, ms: (job.endedAt || Date.now()) - job.startedAt };
}

function termInput(id, line) {
  const job = JOBS.get(Number(id));
  if (!job || job.done) throw new Error("命令已经结束");
  job.child.stdin.write(String(line ?? "") + (process.platform === "win32" ? "\r\n" : "\n"));
  return { ok: true };
}

function termKill(id) {
  const job = JOBS.get(Number(id));
  if (job) killTree(job);
  return { ok: !!job };
}

process.on("exit", () => JOBS.forEach(killTree));

serve({
  id: ID,
  version: VERSION,
  methods: {
    "git/graph": async p => gitGraph(p.limit),
    "git/show": async p => gitShow(p.hash),
    "term/start": async p => termStart(p.command),
    "term/poll": async p => termPoll(p.id, p.since),
    "term/input": async p => termInput(p.id, p.line),
    "term/kill": async p => termKill(p.id),
    "term/cwd": async () => ({ cwd: cwdNow() }),
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
