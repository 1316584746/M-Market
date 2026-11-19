"use strict";
/**
 * 插件市场后台：多来源目录聚合、搜索筛选、安装更新卸载、收藏分组备注、备份还原（文件 / WebDAV / 私有 Gist）。
 * 安装的做法：下载 .dbxp → 核对目录里的 sha256 → 安全解压 → 放进 M-Harness 的 plugins 目录（和 M-Harness 自己装的完全一样）。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { serve, dataDir, settings, harnessHome } = require("./rpc.cjs");
const { parseCatalog, cmpVer } = require("./catalog.cjs");
const { installBuffer, scanInstalled, uninstall, sha256, MAX_PACKAGE } = require("./dbxp.cjs");

const VERSION = require("../manifest.json").version;
const LANG = process.env.MARKET_LANG || "zh-CN";
const TTL_MS = 30 * 60 * 1000;
const MAX_CATALOG = 40 * 1024 * 1024;

const DEFAULT_SOURCES = [
  { id: "m-market", name: "M-Market", url: "https://raw.githubusercontent.com/1316584746/M-Market/HEAD/catalog/index.json", enabled: true },
  { id: "dsh-hub", name: "社区插件索引", url: "https://dshbazaar.io/api/index.json", enabled: true },
  { id: "awesome-dsh", name: "社区精选（较大）", url: "https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json", enabled: false },
  { id: "dbx", name: "DBX 官方目录", url: "https://dl.dbxio.com/catalog/index.json", enabled: false },
];
/** 安装包只允许来自：目录自己所在的主机，或这几个常见的托管站 */
const COMMON_HOSTS = ["raw.githubusercontent.com", "github.com", "objects.githubusercontent.com", "cdn.jsdelivr.net", "dl.dbxio.com"];

const cfg = settings("settings.json");
const userStore = settings("user.json");
const GITHUB_API = () => (process.env.MARKET_GITHUB_API || "https://api.github.com").replace(/\/$/, "");

// ───────── 小工具 ─────────

const isLocal = u => u.protocol === "http:" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
function parseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error("地址不合法");
  }
  if (u.protocol !== "https:" && !isLocal(u)) throw new Error("只支持 https 地址");
  return u;
}

function pluginsRoot() {
  if (process.env.HARNESS_PLUGINS_DIR) return process.env.HARNESS_PLUGINS_DIR;
  return path.join(harnessHome(), "plugins");
}

async function http(url, { method = "GET", headers = {}, body, timeoutMs = 60000, max = MAX_CATALOG } = {}) {
  if (typeof fetch !== "function") throw new Error("当前运行环境不支持网络请求");
  const res = await fetch(url, { method, headers: { "user-agent": "m-market-plugin/" + VERSION, ...headers }, body, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > max) throw new Error("文件太大，已拒绝");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error("文件太大，已拒绝");
  return { status: res.status, ok: res.ok, buf };
}
const text = b => b.toString("utf8").replace(/^\uFEFF/, "");

// ───────── 来源与目录缓存 ─────────

/** 没存过来源时用的默认来源（MARKET_DEFAULT_SOURCES 是给测试 / 内网部署用的覆盖项） */
function defaultSources() {
  try {
    const o = JSON.parse(process.env.MARKET_DEFAULT_SOURCES || "null");
    if (Array.isArray(o) && o.length) return o;
  } catch {
    /* 用内置的 */
  }
  return DEFAULT_SOURCES;
}

function getSources() {
  const s = cfg.get().sources;
  if (!Array.isArray(s) || !s.length) return defaultSources().map(x => ({ ...x }));
  const out = [];
  const ids = new Set();
  for (const x of s) {
    if (!x || typeof x.url !== "string" || !x.url) continue;
    let id = String(x.id || "").replace(/[^\w.-]/g, "").slice(0, 40) || crypto.createHash("sha1").update(x.url).digest("hex").slice(0, 8);
    while (ids.has(id)) id += "x";
    ids.add(id);
    out.push({ id, name: String(x.name || x.url).slice(0, 60), url: x.url, enabled: x.enabled !== false });
  }
  return out;
}

const CACHE_V = 2; // 条目字段变了就加一，旧缓存自动作废
const mem = new Map(); // url -> { at, entries }
const cacheFile = url => path.join(dataDir(), "cache-" + crypto.createHash("sha1").update(url).digest("hex").slice(0, 16) + ".json");

function readDisk(url) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(url), "utf8"));
    if (j && j.v === CACHE_V && Array.isArray(j.entries)) return j;
  } catch {
    /* 没有缓存 */
  }
  return null;
}

/** 取一个来源的条目：缓存没过期就用缓存；联网失败就退回旧缓存（并报告错误） */
async function loadSource(src, force) {
  const hit = mem.get(src.url) ?? readDisk(src.url);
  if (hit && !force && Date.now() - hit.at < TTL_MS) {
    mem.set(src.url, hit);
    return { entries: hit.entries, at: hit.at };
  }
  try {
    const u = parseUrl(src.url);
    const r = await http(u.toString());
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    let json;
    try {
      json = JSON.parse(text(r.buf));
    } catch {
      throw new Error("返回的内容不是 JSON（地址要指向目录文件本身）");
    }
    const entries = parseCatalog(json, src.id, LANG).map(e => ({ ...e, sourceName: src.name, sourceHost: u.host }));
    const rec = { v: CACHE_V, at: Date.now(), entries };
    mem.set(src.url, rec);
    try {
      fs.writeFileSync(cacheFile(src.url), JSON.stringify(rec));
    } catch {
      /* 缓存写不了不影响使用 */
    }
    return { entries, at: rec.at };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    if (hit) return { entries: hit.entries, at: hit.at, error: `${err}（显示的是 ${new Date(hit.at).toLocaleString()} 的缓存）` };
    return { entries: [], error: err };
  }
}

async function loadAll(force) {
  const sources = getSources();
  const errors = [];
  const entries = [];
  const status = [];
  await Promise.all(
    sources.map(async s => {
      if (!s.enabled) return status.push({ ...s, count: 0 });
      const r = await loadSource(s, force);
      if (r.error) errors.push({ source: s.name, error: r.error });
      entries.push(...r.entries.map(e => ({ ...e, _order: sources.indexOf(s) })));
      status.push({ ...s, count: r.entries.length, at: r.at, error: r.error });
    }),
  );
  entries.sort((a, b) => a._order - b._order);
  return { entries, errors, sources: sources.map(s => status.find(x => x.id === s.id) ?? s) };
}

// ───────── 用户数据：收藏 / 分组 / 备注 ─────────

const uidOf = e => `${e.kind}:${e.id}`;
function user() {
  const u = userStore.get();
  return {
    favorites: Array.isArray(u.favorites) ? u.favorites.filter(x => typeof x === "string") : [],
    hidden: Array.isArray(u.hidden) ? u.hidden.filter(x => typeof x === "string") : [],
    groups: u.groups && typeof u.groups === "object" && !Array.isArray(u.groups) ? Object.fromEntries(Object.entries(u.groups).map(([k, v]) => [k, Array.isArray(v) ? v.filter(x => typeof x === "string") : []])) : {},
    notes: u.notes && typeof u.notes === "object" && !Array.isArray(u.notes) ? Object.fromEntries(Object.entries(u.notes).filter(([, v]) => typeof v === "string")) : {},
  };
}
const saveUser = u => userStore.set({ favorites: u.favorites, hidden: u.hidden ?? [], groups: u.groups, notes: u.notes });
const checkUid = uid => {
  if (typeof uid !== "string" || !/^(dbx|dsh):.{1,200}$/.test(uid)) throw new Error("插件标识不合法");
  return uid;
};
const checkGroup = n => {
  const s = String(n ?? "").trim();
  if (!s || s.length > 40 || s === "__proto__") throw new Error("分组名要 1～40 个字符");
  return s;
};

// ───────── 列表 / 搜索 ─────────

function score(e, terms) {
  let s = 0;
  const name = e.name.toLowerCase();
  const id = e.id.toLowerCase();
  for (const t of terms) {
    if (name === t || id === t) s += 100;
    else if (name.startsWith(t) || id.startsWith(t)) s += 40;
    else if (name.includes(t) || id.includes(t)) s += 20;
    else s += 1;
  }
  return s;
}

async function list(p = {}) {
  const { entries, errors, sources } = await loadAll(p.refresh === true);
  const installed = scanInstalled(pluginsRoot(), cmpVer);
  const u = user();
  const fav = new Set(u.favorites);
  const hid = new Set(u.hidden);
  const groupsOf = new Map();
  for (const [g, ids] of Object.entries(u.groups)) for (const id of ids) groupsOf.set(id, [...(groupsOf.get(id) ?? []), g]);

  const view = ["all", "installed", "favorites", "updates", "hidden"].includes(p.view) ? p.view : "all";
  const terms = String(p.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const decorate = e => {
    const uid = uidOf(e);
    const local = e.kind === "dbx" ? installed[e.id] : undefined;
    return {
      uid,
      key: e.key,
      id: e.id,
      name: e.name,
      kind: e.kind,
      author: e.author,
      description: e.description,
      tags: e.tags,
      category: e.category,
      version: e.version,
      license: e.license,
      updated: e.updated,
      stars: e.stars,
      icon: e.icon,
      theme: !!e.theme,
      screenshots: e.screenshots ?? [],
      homepage: e.homepage,
      repo: e.repo,
      source: e.source,
      sourceName: e.sourceName,
      permissions: e.permissions,
      installable: !!(e.install && e.install.sha256),
      noInstallReason: e.install ? (e.install.sha256 ? undefined : "目录里没有这个插件的校验值，为了安全不安装") : e.noInstallReason,
      installed: local ? local.version : null,
      update: !!local && !!e.version && cmpVer(e.version, local.version) > 0,
      favorite: fav.has(uid),
      hidden: hid.has(uid),
      groups: groupsOf.get(uid) ?? [],
      note: u.notes[uid] ?? "",
    };
  };

  // 先去重：同一个插件出现在多个来源，只留靠前的来源（排序在前）
  const seen = new Set();
  let items = [];
  for (const e of entries) {
    const uid = uidOf(e);
    if (seen.has(uid) && !p.source) continue;
    seen.add(uid);
    items.push(decorate(e));
  }

  const items0 = items.slice();
  const plain = view === "all" && !terms.length && !p.category && !p.tag && !p.group && !p.source && !p.kind && p.theme !== true;
  const recent = plain && !(Number(p.page) > 1) ? items.filter(x => x.updated && !x.hidden).sort((a, b) => b.updated.localeCompare(a.updated) || (b.stars ?? -1) - (a.stars ?? -1)).slice(0, 12) : [];

  // 屏蔽的插件：只在「已屏蔽」里出现；已装的不受影响（屏蔽只是不想再看到它）
  if (view === "hidden") items = items.filter(x => x.hidden);
  else if (view === "all") items = items.filter(x => !x.hidden || x.installed);
  if (p.theme === true) items = items.filter(x => x.theme);
  if (view === "installed") items = items.filter(x => x.installed);
  else if (view === "favorites") items = items.filter(x => x.favorite);
  else if (view === "updates") items = items.filter(x => x.update);
  if (p.source) items = items.filter(x => x.source === p.source);
  if (p.kind === "dbx" || p.kind === "dsh") items = items.filter(x => x.kind === p.kind);
  if (p.group) items = items.filter(x => x.groups.includes(String(p.group)));
  if (terms.length) items = items.filter(x => terms.every(t => `${x.name}\n${x.id}\n${x.description}\n${x.author ?? ""}\n${x.category ?? ""}\n${x.tags.join(" ")}\n${x.note}`.toLowerCase().includes(t)));

  // 分类 / 标签的计数：基于上面的结果（还没按分类 / 标签过滤）
  const catCount = new Map();
  const tagCount = new Map();
  for (const x of items) {
    if (x.category) catCount.set(x.category, (catCount.get(x.category) ?? 0) + 1);
    for (const t of x.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  }
  const top = m => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40).map(([name, count]) => ({ name, count }));
  const catTotal = items.length;
  if (p.category) items = items.filter(x => x.category === p.category);
  if (p.tag) items = items.filter(x => x.tags.includes(String(p.tag)));

  const sort = ["stars", "updated", "name", "relevance"].includes(p.sort) ? p.sort : terms.length ? "relevance" : "stars";
  const byName = (a, b) => a.name.localeCompare(b.name, "zh-CN");
  if (sort === "stars") items.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || (b.updated ?? "").localeCompare(a.updated ?? "") || byName(a, b));
  else if (sort === "updated") items.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || byName(a, b));
  else if (sort === "name") items.sort(byName);
  else items.sort((a, b) => score({ name: b.name, id: b.id }, terms) - score({ name: a.name, id: a.id }, terms) || (b.stars ?? -1) - (a.stars ?? -1));

  const pageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 30));
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(p.page) || 1));
  return {
    total,
    page,
    pages,
    items: items.slice((page - 1) * pageSize, page * pageSize),
    categories: top(catCount),
    catTotal,
    recent,
    tags: top(tagCount),
    groups: Object.entries(u.groups).map(([name, ids]) => ({ name, count: ids.length })),
    counts: { favorites: u.favorites.length, hidden: u.hidden.length, installed: Object.keys(installed).length, updates: items0.filter(x => x.update).length },
    sources,
    errors,
  };
}

async function findEntry(ref) {
  const { entries } = await loadAll(false);
  const r = String(ref ?? "");
  return entries.find(e => e.key === r) ?? entries.find(e => uidOf(e) === r) ?? entries.find(e => e.id === r && e.kind === "dbx") ?? entries.find(e => e.id === r);
}

// ───────── 安装 / 卸载 ─────────

async function install(ref) {
  const e = await findEntry(ref);
  if (!e) throw new Error("目录里找不到这个插件，先点「刷新」");
  if (e.kind !== "dbx") throw new Error(e.noInstallReason || "这个插件不能在这里安装");
  if (!e.install?.url) throw new Error(e.noInstallReason || "没有适合当前系统的安装包");
  if (!/^[0-9a-f]{64}$/i.test(e.install.sha256 ?? "")) throw new Error("目录里没有这个插件的校验值，为了安全不安装");
  const u = parseUrl(e.install.url);
  if (!isLocal(u) && !/\.dbxp$/i.test(u.pathname)) throw new Error("安装包地址要以 .dbxp 结尾");
  if (!isLocal(u) && u.host !== e.sourceHost && !COMMON_HOSTS.includes(u.host)) throw new Error(`安装包来自 ${u.host}，不是目录所在的站点，也不在常见托管站里，已拒绝`);
  const r = await http(u.toString(), { timeoutMs: 180000, max: MAX_PACKAGE });
  if (!r.ok) throw new Error(`下载失败（HTTP ${r.status}）`);
  if (e.install.size && r.buf.length !== e.install.size) throw new Error(`下载的安装包大小不对（应为 ${e.install.size}，实际 ${r.buf.length}）`);
  if (sha256(r.buf) !== e.install.sha256.toLowerCase()) throw new Error("安装包校验失败（sha256 和目录里的不一致），已丢弃");
  const done = installBuffer(r.buf, pluginsRoot(), { id: e.id, version: e.version });
  return { ...done, message: done.backend ? `${done.name} ${done.version} 已安装。它带本机程序，第一次打开时 M-Harness 会让你确认信任。` : `${done.name} ${done.version} 已安装。` };
}

// 一键更新：把所有「有新版本」的已装插件逐个装一遍。一个失败不影响其他；市场自己正在运行，跳过（单独更新）。
async function updateAll() {
  const r = await list({ view: "updates", pageSize: 100 });
  const updated = [];
  const failed = [];
  const skipped = [];
  for (const x of r.items) {
    if (x.id === process.env.DBX_PLUGIN_ID) { skipped.push({ id: x.id, name: x.name, reason: "市场自己正在运行，请单独更新它" }); continue; }
    if (!x.installable) { skipped.push({ id: x.id, name: x.name, reason: x.noInstallReason || "不能在这里安装" }); continue; }
    try {
      await install(x.key);
      updated.push({ id: x.id, name: x.name, from: x.installed, to: x.version });
    } catch (e) {
      failed.push({ id: x.id, name: x.name, error: String(e?.message ?? e) });
    }
  }
  return { updated, failed, skipped, message: `已更新 ${updated.length} 个${failed.length ? `，${failed.length} 个失败` : ""}${skipped.length ? `，${skipped.length} 个跳过` : ""}` };
}

async function remove(id) {
  if (id === process.env.DBX_PLUGIN_ID) throw new Error("不能在市场里卸载市场自己（它正在运行）");
  const ok = uninstall(String(id), pluginsRoot());
  return { removed: ok };
}

// ───────── 截图（从插件仓库的 README 里找图，只信 GitHub 托管的图） ─────────

const SHOT_TTL = 7 * 24 * 3600 * 1000;
const SHOT_HOSTS = ["raw.githubusercontent.com", "github.com", "user-images.githubusercontent.com", "private-user-images.githubusercontent.com"];
const BADGE_RE = /(shields\.io|badge|badgen|travis-ci|codecov|coveralls|github\.com\/[^/]+\/[^/]+\/(actions|workflows)\/|\.svg(\?|$)|img\.shields|star-history|contrib\.rocks|visitor)/i;
const shotsMem = new Map();

/** 从 README 文本里取图片地址，转成绝对地址，丢掉徽章和不在白名单里的主机；最多 6 张 */
function readmeImages(md, owner, repo, branch = "HEAD") {
  const found = [];
  const re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(md)) && found.length < 40) found.push(m[1] || m[2]);
  const out = [];
  for (let raw of found) {
    raw = raw.trim();
    let u;
    try {
      if (/^https?:\/\//i.test(raw)) u = new URL(raw);
      else if (raw.startsWith("//")) u = new URL("https:" + raw);
      else u = new URL(raw.replace(/^\.?\//, ""), `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/`);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" || !SHOT_HOSTS.includes(u.hostname)) continue;
    // github.com/<o>/<r>/blob/... 是网页，换成 raw 地址；其它 github.com 路径只放行上传的附件和 raw
    if (u.hostname === "github.com") {
      const bm = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(u.pathname);
      if (bm) u = new URL(`https://raw.githubusercontent.com/${bm[1]}/${bm[2]}/${bm[3]}`);
      else if (!u.pathname.startsWith("/user-attachments/")) continue;
    }
    const s = u.toString();
    if (BADGE_RE.test(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= 6) break;
  }
  return out;
}

async function screenshots(ref) {
  const e = await findEntry(ref);
  if (!e) throw new Error("目录里找不到这个插件");
  if (e.screenshots?.length) return { images: e.screenshots, from: "catalog" };
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(e.repo || "");
  if (!m) return { images: [], from: "none" };
  const key = `${m[1]}/${m[2]}`.toLowerCase();
  const file = path.join(dataDir(), "shots-" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 16) + ".json");
  let hit = shotsMem.get(key);
  if (!hit) {
    try {
      hit = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* 没有缓存 */
    }
  }
  if (hit && Array.isArray(hit.images) && Date.now() - hit.at < SHOT_TTL) return { images: hit.images, from: "cache" };
  const base = process.env.MARKET_RAW_BASE || "https://raw.githubusercontent.com";
  let images = [];
  for (const name of ["README.md", "readme.md", "README.MD"]) {
    const r = await http(`${base}/${m[1]}/${m[2]}/HEAD/${name}`, { timeoutMs: 15000, max: 1024 * 1024 }).catch(() => null);
    if (r && r.ok) {
      images = readmeImages(text(r.buf), m[1], m[2]);
      break;
    }
  }
  const rec = { at: Date.now(), images };
  shotsMem.set(key, rec);
  try {
    fs.writeFileSync(file, JSON.stringify(rec));
  } catch {
    /* 缓存写不了不影响使用 */
  }
  return { images, from: "readme" };
}

// ───────── 诊断日志（给反馈问题用：路径和密钥都会遮掉，不会发到任何地方） ─────────

async function diagnostics() {
  const home = harnessHome();
  const rep = (s, from, to) => (from && from.length > 2 ? s.split(from).join(to) : s);
  const mask = s => rep(rep(String(s ?? ""), home, "<M-Harness 目录>"), require("node:os").homedir(), "~").replace(/(ghp_|github_pat_|gho_)[A-Za-z0-9_]+/g, "$1***");
  const installed = scanInstalled(pluginsRoot(), cmpVer);
  const sources = getSources();
  const lines = [`插件市场 ${VERSION}`, `时间：${new Date().toISOString()}`, `系统：${process.platform} ${process.arch}，Node ${process.version}`, `插件目录：${pluginsRoot()}`, "", "已安装的插件："];
  const ids = Object.keys(installed);
  if (!ids.length) lines.push("  （无）");
  for (const id of ids) lines.push(`  ${id} ${installed[id].version}`);
  lines.push("", "目录来源：");
  const status = (await loadAll(false)).sources;
  for (const s of sources) {
    const st = status.find(x => x.id === s.id) || {};
    lines.push(`  ${s.enabled ? "[开]" : "[关]"} ${s.name} ${s.url}  ${s.enabled ? `${st.count ?? 0} 个${st.at ? "，缓存于 " + new Date(st.at).toLocaleString() : ""}${st.error ? "，错误：" + st.error : ""}` : ""}`);
  }
  const u = user();
  lines.push("", `收藏 ${u.favorites.length} 个，分组 ${Object.keys(u.groups).length} 个，备注 ${Object.keys(u.notes).length} 条`);
  return { text: mask(lines.join("\n")) };
}

// ───────── 备份 / 还原 ─────────

function exportBackup() {
  return { format: "m-market-backup", version: 1, exportedAt: new Date().toISOString(), sources: getSources(), user: user() };
}

function importBackup(data, mode) {
  if (!data || typeof data !== "object" || data.format !== "m-market-backup") throw new Error("这不是 M-Market 的备份文件");
  const incoming = data.user && typeof data.user === "object" ? data.user : {};
  const inFav = Array.isArray(incoming.favorites) ? incoming.favorites.filter(x => typeof x === "string" && /^(dbx|dsh):/.test(x)).slice(0, 5000) : [];
  const inGroups = {};
  if (incoming.groups && typeof incoming.groups === "object") {
    for (const [k, v] of Object.entries(incoming.groups).slice(0, 200)) {
      const n = String(k).trim().slice(0, 40);
      if (n && n !== "__proto__" && Array.isArray(v)) inGroups[n] = v.filter(x => typeof x === "string" && /^(dbx|dsh):/.test(x)).slice(0, 5000);
    }
  }
  const inNotes = {};
  if (incoming.notes && typeof incoming.notes === "object") {
    for (const [k, v] of Object.entries(incoming.notes).slice(0, 5000)) if (typeof v === "string" && /^(dbx|dsh):/.test(k) && k !== "__proto__") inNotes[k] = v.slice(0, 2000);
  }
  const inHidden = Array.isArray(incoming.hidden) ? incoming.hidden.filter(x => typeof x === "string" && /^(dbx|dsh):/.test(x)).slice(0, 5000) : [];
  const cur = mode === "replace" ? { favorites: [], hidden: [], groups: {}, notes: {} } : user();
  const merged = {
    favorites: [...new Set([...cur.favorites, ...inFav])],
    hidden: [...new Set([...cur.hidden, ...inHidden])],
    groups: { ...cur.groups },
    notes: { ...cur.notes, ...inNotes },
  };
  for (const [g, ids] of Object.entries(inGroups)) merged.groups[g] = [...new Set([...(merged.groups[g] ?? []), ...ids])];
  saveUser(merged);
  let sources = 0;
  if (Array.isArray(data.sources) && data.sources.length) {
    const have = getSources();
    const incomingSources = data.sources.filter(s => s && typeof s.url === "string" && /^https?:\/\//.test(s.url)).slice(0, 30);
    const next = mode === "replace" ? [] : have;
    for (const s of incomingSources) if (!next.some(x => x.url === s.url)) next.push({ id: s.id, name: s.name, url: s.url, enabled: s.enabled !== false });
    sources = incomingSources.length;
    if (next.length) cfg.set({ sources: next });
  }
  return { favorites: merged.favorites.length, groups: Object.keys(merged.groups).length, notes: Object.keys(merged.notes).length, sources };
}

const davUrl = () => {
  const w = cfg.get().webdav || {};
  if (!w.url) throw new Error("还没有填 WebDAV 地址");
  const base = parseUrl(w.url);
  const file = (w.file || "m-market-backup.json").replace(/^\/+/, "");
  if (/\.\.|[\\]/.test(file)) throw new Error("文件名不合法");
  base.pathname = base.pathname.replace(/\/$/, "") + "/" + file.split("/").map(encodeURIComponent).join("/");
  return base.toString();
};
const davHeaders = () => {
  const w = cfg.get().webdav || {};
  return w.user ? { authorization: "Basic " + Buffer.from(`${w.user}:${w.password || ""}`).toString("base64") } : {};
};

async function gh(pathname, { method = "GET", body } = {}) {
  const g = cfg.get().gist || {};
  if (!g.token) throw new Error("还没有填 GitHub 令牌（需要 gist 权限）");
  const r = await http(GITHUB_API() + pathname, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { authorization: `Bearer ${g.token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" },
  });
  if (!r.ok) {
    let m = "";
    try {
      m = JSON.parse(text(r.buf)).message;
    } catch {
      /* 非 JSON */
    }
    throw new Error(`GitHub 返回 ${r.status}${m ? "：" + m : ""}${r.status === 401 || r.status === 403 ? "（检查令牌是否有 gist 权限）" : ""}`);
  }
  return JSON.parse(text(r.buf));
}

const BACKUP_FILE = "m-market-backup.json";

async function cloud(action) {
  const out = JSON.stringify(exportBackup(), null, 2);
  if (action === "webdavPush") {
    const r = await http(davUrl(), { method: "PUT", body: out, headers: { ...davHeaders(), "content-type": "application/json" }, max: 4 * 1024 * 1024 });
    if (!(r.ok || r.status === 201 || r.status === 204)) throw new Error(`WebDAV 上传失败（HTTP ${r.status}）`);
    return { message: "已上传到 WebDAV" };
  }
  if (action === "webdavPull") {
    const r = await http(davUrl(), { headers: davHeaders(), max: 4 * 1024 * 1024 });
    if (r.status === 404) throw new Error("WebDAV 上还没有备份文件");
    if (!r.ok) throw new Error(`WebDAV 下载失败（HTTP ${r.status}）`);
    return { restored: importBackup(JSON.parse(text(r.buf)), "merge"), message: "已从 WebDAV 合并还原" };
  }
  if (action === "gistPush") {
    const g = cfg.get().gist || {};
    const files = { [BACKUP_FILE]: { content: out } };
    const res = g.gistId ? await gh(`/gists/${encodeURIComponent(g.gistId)}`, { method: "PATCH", body: { files } }) : await gh("/gists", { method: "POST", body: { description: "M-Market backup", public: false, files } });
    if (res.id && res.id !== g.gistId) cfg.set({ gist: { ...g, gistId: res.id } });
    return { message: "已同步到私有 Gist", gistId: res.id };
  }
  if (action === "gistPull") {
    const g = cfg.get().gist || {};
    if (!g.gistId) throw new Error("还没有 Gist，先上传一次");
    const res = await gh(`/gists/${encodeURIComponent(g.gistId)}`);
    const f = res.files?.[BACKUP_FILE];
    if (!f) throw new Error("这个 Gist 里没有备份文件");
    let content = f.content;
    if (f.truncated && f.raw_url) content = text((await http(parseUrl(f.raw_url).toString(), { max: 4 * 1024 * 1024 })).buf);
    return { restored: importBackup(JSON.parse(content), "merge"), message: "已从私有 Gist 合并还原" };
  }
  throw new Error("未知操作");
}

// ───────── 设置（密码 / 令牌不回传界面） ─────────

function publicSettings() {
  const c = cfg.get();
  const w = c.webdav || {};
  const g = c.gist || {};
  return {
    version: VERSION,
    sources: getSources(),
    defaults: defaultSources(),
    webdav: { url: w.url || "", user: w.user || "", file: w.file || "", hasPassword: !!w.password },
    gist: { gistId: g.gistId || "", hasToken: !!g.token },
    pluginsDir: pluginsRoot(),
  };
}

function saveSettings(p = {}) {
  const patch = {};
  if (Array.isArray(p.sources)) {
    const next = [];
    for (const s of p.sources.slice(0, 30)) {
      if (!s || typeof s.url !== "string") continue;
      parseUrl(s.url);
      next.push({ id: s.id, name: s.name, url: s.url.trim(), enabled: s.enabled !== false });
    }
    if (!next.length) throw new Error("至少要保留一个来源");
    patch.sources = next;
  }
  const cur = cfg.get();
  if (p.webdav && typeof p.webdav === "object") {
    const w = { ...(cur.webdav || {}) };
    if (typeof p.webdav.url === "string") {
      if (p.webdav.url.trim()) parseUrl(p.webdav.url);
      w.url = p.webdav.url.trim();
    }
    if (typeof p.webdav.user === "string") w.user = p.webdav.user.trim();
    if (typeof p.webdav.file === "string") w.file = p.webdav.file.trim();
    if (typeof p.webdav.password === "string" && p.webdav.password) w.password = p.webdav.password;
    patch.webdav = w;
  }
  if (p.gist && typeof p.gist === "object") {
    const g = { ...(cur.gist || {}) };
    if (typeof p.gist.token === "string" && p.gist.token.trim()) g.token = p.gist.token.trim();
    if (typeof p.gist.gistId === "string") g.gistId = p.gist.gistId.trim();
    if (p.gist.clearToken === true) delete g.token;
    patch.gist = g;
  }
  cfg.set(patch);
  return publicSettings();
}

// ───────── 对外：界面方法 + AI 工具 ─────────

const brief = x => ({ id: x.id, name: x.name, kind: x.kind, version: x.version, installed: x.installed, update: x.update, stars: x.stars, author: x.author, description: (x.description || "").slice(0, 160), installable: x.installable });

const methods = {
  "market/list": p => list(p),
  "market/install": async p => install(p?.key ?? p?.uid ?? p?.id),
  "market/uninstall": p => remove(p?.id),
  "market/updateAll": async () => updateAll(),
  "user/hide": async p => {
    const uid = checkUid(p?.uid);
    const u = user();
    u.hidden = u.hidden.filter(x => x !== uid);
    if (p?.on !== false) u.hidden.unshift(uid);
    saveUser(u);
    return { hidden: p?.on !== false };
  },
  "market/screenshots": async p => screenshots(p?.key ?? p?.uid),
  "market/diagnostics": async () => diagnostics(),
  "market/settings": async () => publicSettings(),
  "market/saveSettings": async p => saveSettings(p),
  "user/favorite": async p => {
    const uid = checkUid(p?.uid);
    const u = user();
    u.favorites = u.favorites.filter(x => x !== uid);
    if (p?.on !== false) u.favorites.unshift(uid);
    saveUser(u);
    return { favorite: p?.on !== false };
  },
  "user/note": async p => {
    const uid = checkUid(p?.uid);
    const u = user();
    const t = String(p?.text ?? "").slice(0, 2000);
    if (t.trim()) u.notes[uid] = t;
    else delete u.notes[uid];
    saveUser(u);
    return { note: u.notes[uid] ?? "" };
  },
  "user/groupSet": async p => {
    const uid = checkUid(p?.uid);
    const g = checkGroup(p?.group);
    const u = user();
    const ids = new Set(u.groups[g] ?? []);
    if (p?.on === false) ids.delete(uid);
    else ids.add(uid);
    u.groups[g] = [...ids];
    saveUser(u);
    return { groups: Object.keys(u.groups) };
  },
  "user/groupCreate": async p => {
    const g = checkGroup(p?.name);
    const u = user();
    if (!u.groups[g]) u.groups[g] = [];
    saveUser(u);
    return { groups: Object.keys(u.groups) };
  },
  "user/groupRename": async p => {
    const from = checkGroup(p?.from);
    const to = checkGroup(p?.to);
    const u = user();
    if (!u.groups[from]) throw new Error("没有这个分组");
    if (u.groups[to] && to !== from) throw new Error("已经有同名分组");
    u.groups[to] = u.groups[from];
    if (to !== from) delete u.groups[from];
    saveUser(u);
    return { groups: Object.keys(u.groups) };
  },
  "user/groupDelete": async p => {
    const g = checkGroup(p?.name);
    const u = user();
    delete u.groups[g];
    saveUser(u);
    return { groups: Object.keys(u.groups) };
  },
  "backup/export": async () => exportBackup(),
  "backup/import": async p => importBackup(p?.data, p?.mode === "replace" ? "replace" : "merge"),
  "backup/cloud": async p => cloud(String(p?.action ?? "")),
};

const tools = [
  {
    name: "market_search",
    description: "在插件市场目录里搜索插件。返回名称、版本、是否已装、是否有更新、能不能直接安装。",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "关键词，空格分隔，全部命中" }, kind: { type: "string", enum: ["dbx", "dsh"], description: "只看某类插件" }, limit: { type: "number", description: "最多返回几个，默认 10，最多 30" } },
    },
    async run(a) {
      const r = await list({ q: a.query, kind: a.kind, pageSize: Math.min(30, Number(a.limit) || 10) });
      return { total: r.total, items: r.items.map(brief), errors: r.errors };
    },
  },
  {
    name: "market_installed",
    description: "列出已安装的 DBX 插件，以及其中哪些有更新。",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    async run() {
      const r = await list({ view: "installed", pageSize: 100 });
      const local = scanInstalled(pluginsRoot(), cmpVer);
      return { total: Object.keys(local).length, plugins: Object.entries(local).map(([id, v]) => ({ id, name: v.name, version: v.version, update: r.items.find(x => x.id === id)?.update ?? false })) };
    },
  },
  {
    name: "market_install",
    description: "安装或更新一个 DBX 插件（会下载并校验安装包）。只在用户明确要求时调用；社区索引里的非 DBX 插件不能用它安装。",
    readOnly: false,
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string", description: "插件 id（来自 market_search）" } } },
    run: a => install(a.id),
  },
];

serve({ id: "market", version: VERSION, methods, tools });
