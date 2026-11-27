"use strict";
/**
 * MemSearch：给 M-Harness 的长期记忆。
 *   · 记忆就是 Markdown 文件（<数据目录>/memory/YYYY-MM-DD.md），人能直接读、改、同步；
 *   · 可以再挂几个你自己的笔记目录（只读），一起检索；
 *   · 检索用 BM25 关键词排序（中文按二字词切分），纯 Node、离线、不需要向量库。
 * 思路来自 zilliztech/memsearch（"Markdown 是事实来源，索引可随时重建"）；它的向量检索 / Milvus 部分这里没有。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { serve, dataDir, settings } = require("./rpc.cjs");

const ID = "memsearch";
const VERSION = require("../manifest.json").version;
const store = settings();
const memDir = () => {
  const d = path.join(dataDir(), "memory");
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const LIMITS = { files: 1500, fileBytes: 1024 * 1024, totalBytes: 30 * 1024 * 1024, textMax: 20000, results: 50 };
const EXT = /\.(md|markdown|txt)$/i;
const SKIP_DIR = /^(\.git|node_modules|\.venv|dist|build|\.next|target)$/;

// ───────── 分词与 BM25 ─────────

function tokenize(s) {
  const out = [];
  const text = String(s || "").toLowerCase();
  for (const w of text.match(/[a-z0-9_]+/g) || []) if (w.length > 1 || /\d/.test(w)) out.push(w);
  for (const run of text.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) || []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

class Index {
  constructor(docs) {
    this.docs = docs;
    this.tf = [];
    this.len = [];
    this.df = new Map();
    for (const d of docs) {
      const toks = tokenize(`${d.title} ${d.tags.join(" ")} ${d.text}`);
      const m = new Map();
      for (const t of toks) m.set(t, (m.get(t) || 0) + 1);
      this.tf.push(m);
      this.len.push(toks.length || 1);
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avg = this.len.reduce((a, b) => a + b, 0) / (docs.length || 1) || 1;
  }

  search(query, limit) {
    const q = [...new Set(tokenize(query))];
    if (!q.length) return [];
    const N = this.docs.length;
    const k1 = 1.4, b = 0.75;
    const scored = [];
    for (let i = 0; i < N; i++) {
      let score = 0;
      for (const t of q) {
        const f = this.tf[i].get(t);
        if (!f) continue;
        const df = this.df.get(t);
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * this.len[i]) / this.avg));
      }
      if (score > 0) scored.push({ i, score });
    }
    scored.sort((a, c) => c.score - a.score);
    return scored.slice(0, limit).map(x => ({ doc: this.docs[x.i], score: x.score, terms: q }));
  }
}

// ───────── 记忆文件 ─────────

const HEAD = /^## (\d{2}:\d{2})(?: · (.*?))? <!--mem:([A-Za-z0-9]+)-->\s*$/;

function parseMemoryFile(file) {
  const date = path.basename(file, ".md");
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    let text = cur.lines.join("\n").replace(/\s+$/, "");
    let tags = [];
    const m = /^tags:[ \t]*(.*)\n?/.exec(text);
    if (m) {
      tags = m[1].split(/[,，]/).map(s => s.trim()).filter(Boolean);
      text = text.slice(m[0].length).replace(/^\n+/, "");
    }
    out.push({ id: cur.id, kind: "memory", date, time: cur.time, title: cur.title || "", tags, text, source: "记忆", file });
    cur = null;
  };
  let content = "";
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of content.split(/\r?\n/)) {
    const h = HEAD.exec(line);
    if (h) {
      flush();
      cur = { time: h[1], title: h[2] || "", id: h[3], lines: [] };
    } else if (cur) cur.lines.push(line);
  }
  flush();
  return out;
}

function memoryFiles() {
  return fs.readdirSync(memDir()).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
}

function allMemories() {
  const out = [];
  for (const f of memoryFiles()) out.push(...parseMemoryFile(path.join(memDir(), f)));
  return out;
}

const newId = () => "m" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
const pad = n => String(n).padStart(2, "0");

function addMemory({ text, title, tags }) {
  const body = String(text || "").trim();
  if (!body) throw new Error("记忆内容不能为空");
  if (body.length > LIMITS.textMax) throw new Error(`一条记忆最多 ${LIMITS.textMax} 个字符`);
  const now = new Date();
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const id = newId();
  const t = String(title || "").replace(/[\r\n]+/g, " ").replace(/<!--|-->/g, "").trim().slice(0, 120);
  const tg = (Array.isArray(tags) ? tags : String(tags || "").split(/[,，]/)).map(s => String(s).trim().replace(/[\r\n]/g, " ")).filter(Boolean).slice(0, 12);
  // 正文里如果有会被误认成记忆标题的行，缩进一下，避免破坏文件结构
  const safe = body.replace(/^## (\d{2}:\d{2}.*<!--mem:)/gm, " ## $1");
  const block = `## ${pad(now.getHours())}:${pad(now.getMinutes())}${t ? ` · ${t}` : ""} <!--mem:${id}-->\n${tg.length || /^tags:/i.test(safe) ? `tags: ${tg.join(", ")}\n` : ""}${safe}\n\n`;
  const file = path.join(memDir(), `${date}.md`);
  fs.appendFileSync(file, block);
  cache.sig = "";
  return { id, date, title: t, tags: tg };
}

function deleteMemory(id) {
  if (!/^[A-Za-z0-9]+$/.test(String(id || ""))) throw new Error("id 不合法");
  for (const f of memoryFiles()) {
    const file = path.join(memDir(), f);
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/);
    const at = lines.findIndex(l => HEAD.exec(l)?.[3] === id);
    if (at < 0) continue;
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i++) if (HEAD.test(lines[i])) { end = i; break; }
    lines.splice(at, end - at);
    const rest = lines.join("\n").trim();
    if (rest) fs.writeFileSync(file, rest + "\n\n");
    else fs.unlinkSync(file);
    cache.sig = "";
    return true;
  }
  return false;
}

// ───────── 外部笔记目录（只读） ─────────

function walk(root, limit) {
  const out = [];
  let total = 0;
  const go = dir => {
    if (out.length >= limit.files) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (out.length >= limit.files) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIR.test(e.name) && !e.name.startsWith(".")) go(p);
      } else if (e.isFile() && EXT.test(e.name)) {
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (st.size > limit.fileBytes || total + st.size > limit.totalBytes) continue;
        total += st.size;
        out.push({ p, st });
      }
    }
  };
  go(root);
  return out;
}

function chunkMarkdown(file, content, root) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  const chunks = [];
  let title = path.basename(file).replace(EXT, "");
  let buf = [];
  const push = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (text.length < 8) return;
    for (let i = 0; i < text.length; i += 1600) {
      const part = text.slice(i, i + 1600);
      chunks.push({ id: "s" + crypto.createHash("sha1").update(`${file}\n${title}\n${i}`).digest("hex").slice(0, 12), kind: "note", date: "", time: "", title, tags: [], text: part, source: rel, file });
    }
  };
  for (const line of content.split(/\r?\n/)) {
    const h = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (h) {
      push();
      title = h[2];
    } else buf.push(line);
  }
  push();
  return chunks;
}

const cache = { sig: "", index: null, files: 0, notes: 0 };

function signature(sources) {
  const parts = [];
  for (const f of memoryFiles()) {
    const st = fs.statSync(path.join(memDir(), f));
    parts.push(`${f}:${st.size}:${st.mtimeMs}`);
  }
  for (const s of sources) {
    for (const x of walk(s, LIMITS)) parts.push(`${x.p}:${x.st.size}:${x.st.mtimeMs}`);
  }
  return crypto.createHash("sha1").update(parts.join("\n") + "|" + sources.join("|")).digest("hex");
}

function ensureIndex() {
  const sources = (store.get().sources || []).filter(s => fs.existsSync(s));
  const sig = signature(sources);
  if (cache.index && cache.sig === sig) return cache.index;
  const docs = allMemories();
  let files = 0;
  for (const root of sources) {
    for (const x of walk(root, LIMITS)) {
      try {
        docs.push(...chunkMarkdown(x.p, fs.readFileSync(x.p, "utf8"), root));
        files++;
      } catch {
        /* 读不了的文件跳过 */
      }
    }
  }
  cache.index = new Index(docs);
  cache.sig = sig;
  cache.files = files;
  cache.notes = docs.filter(d => d.kind === "note").length;
  return cache.index;
}

function snippet(text, terms, width = 220) {
  const low = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const from = Math.max(0, (at < 0 ? 0 : at) - 40);
  const s = text.slice(from, from + width).replace(/\s+/g, " ");
  return (from > 0 ? "…" : "") + s + (from + width < text.length ? "…" : "");
}

function search({ query, limit, kind }) {
  const idx = ensureIndex();
  const n = Math.max(1, Math.min(Number(limit) || 8, LIMITS.results));
  let hits = idx.search(query, kind === "memory" || kind === "note" ? Infinity : n * 3);
  if (kind === "memory" || kind === "note") hits = hits.filter(h => h.doc.kind === kind);
  return hits.slice(0, n).map(h => ({
    id: h.doc.id,
    kind: h.doc.kind,
    score: Math.round(h.score * 100) / 100,
    title: h.doc.title,
    tags: h.doc.tags,
    date: h.doc.date,
    time: h.doc.time,
    source: h.doc.source,
    text: snippet(h.doc.text, h.terms),
    full: h.doc.kind === "memory" ? h.doc.text : undefined,
  }));
}

function recent(limit) {
  const all = allMemories().reverse();
  const n = Math.max(1, Math.min(Number(limit) || 20, 200));
  return all.slice(0, n).map(m => ({ id: m.id, kind: "memory", title: m.title, tags: m.tags, date: m.date, time: m.time, source: m.source, text: m.text.slice(0, 400), full: m.text }));
}

function stats() {
  ensureIndex();
  const sources = store.get().sources || [];
  const mem = memoryFiles().length ? allMemories().length : 0;
  return { memories: mem, days: memoryFiles().length, notes: cache.notes, noteFiles: cache.files, sources: sources.map(s => ({ path: s, exists: fs.existsSync(s) })), dir: memDir() };
}

const fmtHit = h => `[${h.kind === "memory" ? `记忆 ${h.date} ${h.time}` : `笔记 ${h.source}`}]${h.title ? ` ${h.title}` : ""}${h.tags && h.tags.length ? `（${h.tags.join(", ")}）` : ""}\n${h.full ? h.full.slice(0, 1200) : h.text}`;

serve({
  id: ID,
  version: VERSION,
  methods: {
    "memory/add": async p => addMemory(p),
    "memory/search": async p => search(p),
    "memory/recent": async p => recent(p.limit),
    "memory/delete": async p => ({ deleted: deleteMemory(p.id) }),
    "memory/stats": async () => stats(),
    "sources/add": async p => {
      const dir = path.resolve(String(p.path || "").trim());
      if (!p.path || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error("这个目录不存在");
      const cur = store.get().sources || [];
      if (!cur.includes(dir)) store.set({ sources: [...cur, dir].slice(0, 20) });
      cache.sig = "";
      return stats();
    },
    "sources/remove": async p => {
      store.set({ sources: (store.get().sources || []).filter(s => s !== p.path) });
      cache.sig = "";
      return stats();
    },
  },
  tools: [
    {
      name: "memory_search",
      description: "在长期记忆（和用户挂载的笔记目录）里检索。开始处理有历史背景的任务前先查一次；用关键词，而不是整句话。",
      readOnly: true,
      inputSchema: { type: "object", properties: { query: { type: "string", description: "检索关键词" }, limit: { type: "number", description: "最多返回几条，默认 5" } }, required: ["query"] },
      run: async a => {
        const hits = search({ query: a.query, limit: a.limit || 5 });
        return hits.length ? hits.map(fmtHit).join("\n\n---\n\n") : "没有找到相关记忆。";
      },
    },
    {
      name: "memory_recent",
      description: "列出最近记下的几条记忆，用来快速了解之前做过什么。",
      readOnly: true,
      inputSchema: { type: "object", properties: { limit: { type: "number", description: "几条，默认 5" } } },
      run: async a => {
        const r = recent(a.limit || 5);
        return r.length ? r.map(fmtHit).join("\n\n---\n\n") : "还没有任何记忆。";
      },
    },
    {
      name: "memory_add",
      description: "把值得长期保留的结论、决定、用户偏好记成一条记忆。只记以后还会用到的事实，不要记流水账。",
      readOnly: false,
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "记忆正文（Markdown）" }, title: { type: "string", description: "一句话标题" }, tags: { type: "array", items: { type: "string" }, description: "标签" } },
        required: ["text"],
      },
      run: async a => {
        const r = addMemory(a);
        return `已记下（${r.date}，id ${r.id}）`;
      },
    },
  ],
});
