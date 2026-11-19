"use strict";
/**
 * 目录解析：把几种来源统一成一种条目。
 *   - DBX 目录（catalog/index.json：{ plugins: [{ id, versions: [{ artifacts }] }] }），可以直接安装
 *   - 社区插件索引（format 1：{ plugins: [{ name, versions: [{ source }] }] }），这里只浏览，安装要到 M-Harness 自己的插件中心
 */

const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
const str = v => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const web = v => (str(v) && /^https?:\/\//i.test(v) ? v.trim() : undefined);

function parseVer(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v ?? "").trim());
  return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split(".") : [] } : null;
}

/** 比较版本号：a>b 返回正数；解析不了的当作最小（保证不会误报「有更新」） */
function cmpVer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (+p !== +q) return +p - +q;
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const localized = (v, lang) => {
  if (!isObj(v)) return str(v);
  const short = lang.split("-")[0];
  return str(v[lang]) ?? str(v[short]) ?? str(v.zh) ?? str(v.en) ?? Object.values(v).map(str).find(Boolean);
};

const THEME_RE = /(^|[^a-z])(theme|skin|themes|skins)([^a-z]|$)|主题|皮肤|配色/i;
const isTheme = (...parts) => parts.some(p => typeof p === "string" && THEME_RE.test(p));

const isoDay = x => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 10) : undefined);
const unixDay = ts => (typeof ts === "number" && ts > 0 ? new Date(ts * 1000).toISOString().slice(0, 10) : undefined);

function target(platform = process.platform, arch = process.arch) {
  return `${platform === "win32" ? "windows" : platform}-${arch}`;
}

/** DBX 目录 */
function parseDbx(json, sourceName, lang = "zh-CN") {
  const list = isObj(json) && Array.isArray(json.plugins) ? json.plugins : null;
  if (!list) throw new Error("这个目录里没有 plugins 列表，不是 DBX 格式");
  const tg = target();
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const id = str(raw.id);
    const nameRaw = str(raw.name);
    if (!id || !nameRaw || !/^[A-Za-z0-9._/-]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const loc = isObj(raw.localizations) && isObj(raw.localizations[lang]) ? raw.localizations[lang] : {};
    const versions = Array.isArray(raw.versions) ? raw.versions.filter(isObj) : [];
    const latest = str(raw.latestVersion);
    const ver = versions.find(v => v.version === latest) ?? versions[0];
    const arts = Array.isArray(ver?.artifacts) ? ver.artifacts.filter(isObj) : [];
    const art = arts.find(a => a.target === tg) ?? arts.find(a => a.target === "universal");
    const source = web(raw.source);
    out.push({
      key: `${sourceName}:${id}`,
      id,
      name: str(loc.name) ?? nameRaw,
      kind: "dbx",
      author: str(raw.publisher),
      description: str(loc.description) ?? str(raw.description) ?? "",
      tags: Array.isArray(raw.tags) ? raw.tags.filter(t => typeof t === "string").slice(0, 8) : [],
      category: undefined,
      theme: isTheme(...(Array.isArray(raw.tags) ? raw.tags : []), str(loc.name) ?? nameRaw),
      screenshots: Array.isArray(raw.screenshots) ? raw.screenshots.map(web).filter(u => u && u.startsWith("https://")).slice(0, 6) : [],
      version: str(ver?.version) ?? latest,
      license: str(raw.license),
      updated: isoDay(ver?.releasedAt),
      stars: typeof raw.stars === "number" ? raw.stars : undefined,
      icon: web(raw.icon),
      homepage: web(raw.homepage),
      repo: source?.replace(/\/tree\/.*$/, ""),
      source: sourceName,
      permissions: Array.isArray(raw.permissions) ? raw.permissions.filter(p => typeof p === "string") : [],
      install: art && str(art.url) ? { url: str(art.url), sha256: str(art.sha256), size: typeof art.size === "number" ? art.size : undefined } : undefined,
      noInstallReason: art && str(art.url) ? undefined : "没有适合当前系统的安装包",
    });
  }
  return out;
}

/** 社区插件索引（format 1）：每个插件取最高的正式版 */
function parseDsh(json, sourceName, lang = "zh") {
  const list = isObj(json) && Array.isArray(json.plugins) ? json.plugins : null;
  if (!list) throw new Error("这个目录里没有 plugins 列表，不是社区插件索引");
  const cats = isObj(json.metadata?.categories) ? json.metadata.categories : {};
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const name = str(raw.name);
    if (!name || seen.has(name)) continue;
    const versions = Array.isArray(raw.versions) ? raw.versions.filter(v => isObj(v) && str(v.version)) : [];
    if (!versions.length) continue;
    const stable = versions.filter(v => !parseVer(v.version)?.pre.length);
    const best = (stable.length ? stable : versions).slice().sort((a, b) => cmpVer(a.version, b.version)).pop();
    seen.add(name);
    const meta = isObj(raw.metadata) ? raw.metadata : {};
    const catId = str(meta.category);
    const catTitle = catId ? localized(cats[catId]?.title, lang) ?? catId : undefined;
    const labels = Array.isArray(meta.labels) ? meta.labels : [];
    const kw = Array.isArray(meta.keywords) ? meta.keywords.filter(t => typeof t === "string" && !/^(dsh|dsh-plugin|deepseek-harness)$/.test(t)) : [];
    const repoUrl = isObj(raw.repository) ? str(raw.repository.url) : str(raw.repository);
    const title = localized(raw.title, lang);
    out.push({
      key: `${sourceName}:${name}`,
      id: name,
      name: title && title !== name ? title : name,
      kind: "dsh",
      author: isObj(raw.author) ? str(raw.author.name) : str(raw.author),
      description: localized(raw.description, lang) ?? "",
      tags: [...(labels.includes("unconfirmed") ? ["未验证"] : []), ...kw].slice(0, 8),
      category: catTitle,
      theme: isTheme(...(Array.isArray(meta.keywords) ? meta.keywords : []), name),
      screenshots: [],
      version: best.version,
      license: str(raw.license),
      updated: unixDay(best.publishTimestamp) ?? unixDay(meta.sortKeys?.updated),
      stars: typeof meta.sortKeys?.stars === "number" ? meta.sortKeys.stars : undefined,
      icon: web(raw.icon),
      homepage: web(raw.homepage),
      repo: repoUrl && /^https?:\/\//.test(repoUrl) ? repoUrl.replace(/\.git$/, "") : undefined,
      source: sourceName,
      permissions: [],
      install: undefined,
      noInstallReason: "这是社区索引里的插件：请到 M-Harness 的「插件中心」里安装",
    });
  }
  return out;
}

/** 自动识别格式 */
function parseCatalog(json, sourceName, lang) {
  const list = isObj(json) && Array.isArray(json.plugins) ? json.plugins : null;
  if (!list) throw new Error("目录格式不对：里面没有 plugins 列表，请确认地址指向目录 JSON 文件本身");
  const first = list.find(isObj);
  if (first && "versions" in first && "name" in first && !("id" in first)) return parseDsh(json, sourceName, lang === "zh-CN" ? "zh" : lang);
  return parseDbx(json, sourceName, lang);
}

module.exports = { parseCatalog, parseDbx, parseDsh, cmpVer, parseVer, target };
