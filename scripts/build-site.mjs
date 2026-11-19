#!/usr/bin/env node
// 生成对外网站（纯静态，可放 GitHub Pages）：site-dist/
//   node scripts/build-site.mjs                 只含本仓库的官方插件
//   node scripts/build-site.mjs --aggregate     再抓上游的社区插件索引，合并成一份可搜索的目录（每日 CI 用）
//   --upstream <url>  可重复；不给就用默认的社区插件索引
// 环境变量 SITE_URL：网站的公开地址（写进 sitemap），默认 https://1316584746.github.io/M-Market
// 上游抓不到时不会让构建失败：那一家跳过并在日志里说明；全部抓不到也只剩官方插件。
//
// 页面：中文在根目录，英文在 en/。每个语言都有：首页（搜索）、安装页、隐私页、每个插件一页、404。
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { parseCatalog } = require(path.join(ROOT, "plugins", "market", "bin", "catalog.cjs"));

export const DEFAULT_UPSTREAMS = [{ name: "dsh-hub", url: "https://dshbazaar.io/api/index.json" }];
export const CATALOG_URL = "https://raw.githubusercontent.com/1316584746/M-Market/HEAD/catalog/index.json";
const REPO = "https://github.com/1316584746/M-Market";
const clip = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const web = u => (/^https?:\/\//i.test(u || "") ? u : "");
const slugOf = e => `${e.kind}-${String(e.id).replace(/[^A-Za-z0-9._-]+/g, "_")}`;

/** 把若干来源合成一份目录。own 是本仓库的 DBX 目录 JSON；upstreams 是 [{ name, json }]。lang：zh-CN 或 en */
export function buildCatalog(own, upstreams = [], now = new Date(), lang = "zh-CN") {
  const out = [];
  const seen = new Set();
  const slugs = new Set();
  const add = (entries, official) => {
    for (const e of entries) {
      const uid = `${e.kind}:${e.id}`;
      if (seen.has(uid)) continue;
      seen.add(uid);
      let slug = slugOf(e);
      for (let n = 2; slugs.has(slug.toLowerCase()); n++) slug = `${slugOf(e)}-${n}`;
      slugs.add(slug.toLowerCase());
      const file = e.install?.url ? path.posix.basename(new URL(e.install.url, "http://x").pathname) : "";
      out.push({
        id: e.id,
        slug,
        name: e.name,
        kind: e.kind,
        official: official || undefined,
        author: e.author,
        description: e.description || "",
        category: e.category,
        tags: (e.tags || []).slice(0, 8),
        version: e.version,
        license: e.license,
        stars: e.stars,
        updated: e.updated,
        icon: web(e.icon) || undefined,
        repo: e.repo,
        homepage: e.homepage,
        permissions: official ? e.permissions || [] : undefined,
        sha256: official ? e.install?.sha256 : undefined,
        download: official && file ? `packages/${file}` : undefined,
      });
    }
  };
  add(parseCatalog(own, "M-Market", lang), true);
  const problems = [];
  for (const u of upstreams) {
    try {
      add(parseCatalog(u.json, u.name, lang), false);
    } catch (e) {
      problems.push(`${u.name}：${e.message}`);
    }
  }
  return { generatedAt: now.toISOString(), plugins: JSON.parse(JSON.stringify(out)), problems };
}

/** 列表页用的精简版：去掉详情页才要的字段，简介截短 */
export const slim = p => ({ id: p.id, slug: p.slug, name: p.name, kind: p.kind, official: p.official, author: p.author, description: clip(p.description, 200), category: p.category, tags: (p.tags || []).slice(0, 4), version: p.version, stars: p.stars, updated: p.updated, icon: p.icon });

// ───────── 文案 ─────────

const T = {
  zh: {
    htmlLang: "zh-CN",
    brand: "M-Market",
    tagline: "M-Harness 的插件市场",
    title: "M-Market 插件市场",
    desc: "M-Harness 的插件市场：官方 DBX 插件加上社区插件索引，可搜索、可筛选。",
    nav: { home: "插件", install: "安装", privacy: "隐私", source: "源码" },
    heroSub: "发现社区为 M-Harness 打造的能力",
    search: "搜索：名称、作者、标签…",
    kinds: ["全部类型", "DBX（M-Harness 可一键安装）", "社区（仅浏览）"],
    allCats: "全部分类",
    sorts: ["按星标", "按最近更新", "按名称"],
    loading: "加载中…",
    count: (n, o) => `共收录 ${n} 个插件（官方 ${o} 个）`,
    pageInfo: (p, ps, n) => `第 ${p} / ${ps} 页，共 ${n} 个`,
    total: n => `共 ${n} 个`,
    prev: "上一页",
    next: "下一页",
    none: "没有符合条件的插件",
    noDesc: "（没有简介）",
    official: "官方",
    communityTag: "社区",
    generated: d => `目录生成于 ${d}。`,
    failed: "目录加载失败：",
    details: "详情",
    download: "下载安装包",
    repo: "仓库",
    homepage: "主页",
    footer: "「社区」条目来自社区索引，仅供浏览，装之前请自己看一眼源码。",
    sw: "English",
    // 详情页
    back: "← 返回插件列表",
    by: "作者",
    version: "版本",
    license: "许可证",
    updated: "更新于",
    stars: "星标",
    category: "分类",
    installH: "怎么安装",
    installDbx: "在 M-Harness 里打开「插件市场」插件，搜索它，点「安装」。安装前会显示它申请的权限。",
    installDbxSite: "还没有插件市场？先看",
    installPage: "安装页",
    installDsh: "这是社区索引里的插件，M-Market 的市场只能浏览它。请到 M-Harness 自带的「插件中心」安装，装之前请自己看一眼源码。",
    permsH: "申请的权限",
    noPerms: "没有声明权限",
    checksum: "安装包 sha256",
    discussH: "讨论",
    discuss: "讨论和问题在它的 GitHub 仓库里：",
    // 安装页
    installTitle: "安装 M-Market",
    installIntro: "M-Harness 里的插件市场就是一个插件。装上它，其它插件都可以在里面搜索和安装。",
    steps: [
      "M-Harness 首次启动时已经预置了 M-Market 仓库：打开「插件」页，找到「插件市场」，点安装。",
      "没有预置的话：「设置 → 插件仓库」里添加下面这个目录地址，再回到「插件」页安装。",
      "第一次运行带后台程序的插件时，M-Harness 会让你确认信任；插件换了版本要重新确认。",
      "装好后打开「插件市场」：搜索、看详情、安装或更新，装好的插件在「已安装」标签页里管理。",
    ],
    catalogUrl: "目录地址",
    reqH: "要求",
    req: "M-Harness 要带「按脚本启动后台程序」的支持。更早的版本只能启动原生可执行文件，这些插件在那样的版本上装得上但跑不起来。",
    diffH: "已知限制",
    diff: [
      "评论：插件窗口里没法嵌入评论区，只给出该插件 GitHub 仓库的讨论链接。",
      "社区索引里的插件只能浏览，不能在这里安装。",
      "没有下载量统计、兼容性筛选、热禁用 / 启用、后台更新提醒。",
    ],
    // 隐私页
    privacyTitle: "隐私",
    privacy: [
      ["网站", "这是个纯静态网站，没有统计脚本、没有 Cookie，也不收集你的任何信息。部分插件卡片的头像图片来自 github.com，浏览器会因此访问 GitHub。"],
      ["插件市场（M-Harness 里的插件）", "它只会访问：你在「备份与来源」里设置的目录地址（默认是 raw.githubusercontent.com 上的本仓库目录和社区插件索引站点 dshbazaar.io）、下载安装包的站点、GitHub（头像、README 里的截图）。**不会**向 M-Market 的作者上报任何使用数据。"],
      ["保存在本机的东西", "收藏、分组、备注和来源列表存在插件自己的数据目录里。如果你配置了 WebDAV 或私有 Gist 同步，备份会上传到你自己指定的地方；WebDAV 密码和 GitHub 令牌以明文存在插件数据目录，备份文件里不含它们。"],
      ["导出日志", "只在你点「导出日志」时生成，路径和令牌已遮掉，不会自动发送到任何地方。"],
      ["GitHub 插件", "它用你填的个人访问令牌直接调用 GitHub API，请求只发往 api.github.com（和你设置的 GitHub 企业版地址）。令牌以明文存在插件数据目录。"],
    ],
    notFound: "页面不存在",
    notFoundSub: "回到插件列表看看吧。",
  },
  en: {
    htmlLang: "en",
    brand: "M-Market",
    tagline: "Plugin market for M-Harness",
    title: "M-Market Plugin Market",
    desc: "The plugin market for M-Harness: official DBX plugins plus the community plugin index, searchable and filterable.",
    nav: { home: "Plugins", install: "Install", privacy: "Privacy", source: "Source" },
    heroSub: "Discover what the community builds for M-Harness",
    search: "Search: name, author, tag…",
    kinds: ["All types", "DBX (one-click install in M-Harness)", "Community (browse only)"],
    allCats: "All categories",
    sorts: ["By stars", "By recent update", "By name"],
    loading: "Loading…",
    count: (n, o) => `${n} plugins listed (${o} official)`,
    pageInfo: (p, ps, n) => `Page ${p} / ${ps}, ${n} total`,
    total: n => `${n} total`,
    prev: "Previous",
    next: "Next",
    none: "No matching plugins",
    noDesc: "(no description)",
    official: "Official",
    communityTag: "Community",
    generated: d => `Catalog generated ${d}.`,
    failed: "Failed to load the catalog: ",
    details: "Details",
    download: "Download package",
    repo: "Repository",
    homepage: "Homepage",
    footer: "\"Community\" entries come from a community index and are browse-only; read the source before you install.",
    sw: "中文",
    back: "← Back to plugins",
    by: "Author",
    version: "Version",
    license: "License",
    updated: "Updated",
    stars: "Stars",
    category: "Category",
    installH: "How to install",
    installDbx: "In M-Harness, open the Plugin Market plugin, search for it and click Install. The permissions it asks for are shown first.",
    installDbxSite: "No Plugin Market yet? See the",
    installPage: "install page",
    installDsh: "This is a plugin from the community index; the M-Market market can only browse it. Install it from M-Harness's own plugin center, and read the source first.",
    permsH: "Permissions it asks for",
    noPerms: "No permissions declared",
    checksum: "Package sha256",
    discussH: "Discussion",
    discuss: "Discussion and issues live in its GitHub repository: ",
    installTitle: "Install M-Market",
    installIntro: "The plugin market inside M-Harness is just a plugin. Install it and you can search and install the rest from there.",
    steps: [
      "M-Harness ships with the M-Market repository preset: open the Plugins page, find Plugin Market, click Install.",
      "If it is not preset: add the catalog URL below under Settings → Plugin repositories, then install from the Plugins page.",
      "The first time a plugin with a backend process runs, M-Harness asks you to trust it; a new version asks again.",
      "Open Plugin Market: search, read details, install or update; installed plugins are managed in the Installed tab.",
    ],
    catalogUrl: "Catalog URL",
    reqH: "Requirement",
    req: "An M-Harness build that can start script backends. Older builds can only launch native executables: these plugins install there but will not run.",
    diffH: "Known limitations",
    diff: [
      "Comments: a plugin window cannot embed a comment section; it only gives the repository's discussion links.",
      "Plugins from the community index are browse-only; they cannot be installed here.",
      "No download statistics, compatibility filter, hot disable / enable or background update reminders.",
    ],
    privacyTitle: "Privacy",
    privacy: [
      ["This website", "A purely static site: no analytics, no cookies, nothing collected. Some plugin cards load avatar images from github.com, so your browser contacts GitHub for those."],
      ["Plugin Market (inside M-Harness)", "It only contacts: the catalog URLs you configure under \"Backup & sources\" (by default this repository's catalog on raw.githubusercontent.com and the community plugin index site dshbazaar.io), the host a package is downloaded from, and GitHub (avatars, README screenshots). It **never** reports usage data to M-Market's authors."],
      ["What stays on your machine", "Favorites, groups, notes and the source list live in the plugin's own data directory. If you configure WebDAV or private Gist sync, backups go to the place you choose; the WebDAV password and GitHub token are stored in plain text in the plugin data directory, and backup files never contain them."],
      ["Export log", "Only generated when you click Export log; paths and tokens are masked, and nothing is sent automatically."],
      ["GitHub plugin", "It calls the GitHub API with the personal access token you enter; requests only go to api.github.com (and a GitHub Enterprise URL if you set one). The token is stored in plain text in the plugin data directory."],
    ],
    notFound: "Page not found",
    notFoundSub: "Try the plugin list.",
  },
};

// ───────── 页面外壳 ─────────

const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

/** root：当前页面到站点根目录的相对前缀（"" / "../" / "../../"）；lang：zh / en；rel：本页相对语言根目录的路径，用于「切换语言」 */
function layout({ lang, root, rel, title, desc, body, extraHead = "", script = "" }) {
  const t = T[lang];
  const base = lang === "en" ? root + "en/" : root; // 本语言的根
  const other = lang === "en" ? root : root + "en/";
  const nav = [[t.nav.home, base + "index.html"], [t.nav.install, base + "install.html"], [t.nav.privacy, base + "privacy.html"]].map(([l, h]) => `<a href="${h}">${esc(l)}</a>`).join("");
  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<link rel="icon" href="${root}logo.svg" />
<link rel="stylesheet" href="${root}style.css" />
${extraHead}</head>
<body>
<div class="top"><div class="wrap topin"><a class="brand" href="${base}index.html"><img src="${root}logo.svg" alt="" width="28" height="28" /> ${esc(t.brand)}</a><nav>${nav}<a href="${REPO}" rel="noopener">${esc(t.nav.source)}</a><a class="sw" href="${other}${rel}">${esc(t.sw)}</a></nav></div></div>
${body}
<footer class="wrap hint">${esc(t.footer)} <a href="${REPO}" rel="noopener">GitHub</a></footer>
${script}</body>
</html>
`;
}

export function renderIndex(lang, now) {
  const t = T[lang];
  const root = lang === "en" ? "../" : "";
  const cfg = { lang, data: root + (lang === "en" ? "catalog.en.json" : "catalog.json"), t: { loading: t.loading, none: t.none, noDesc: t.noDesc, official: t.official, community: t.communityTag, details: t.details, prev: t.prev, next: t.next, failed: t.failed } };
  // 带函数的文案不能直接序列化：页面里用占位符模板
  cfg.t.count = lang === "en" ? "{n} plugins listed ({o} official)" : "共收录 {n} 个插件（官方 {o} 个）";
  cfg.t.pageInfo = lang === "en" ? "Page {p} / {ps}, {n} total" : "第 {p} / {ps} 页，共 {n} 个";
  cfg.t.total = lang === "en" ? "{n} total" : "共 {n} 个";
  cfg.t.generated = lang === "en" ? "Catalog generated {d}." : "目录生成于 {d}。";
  const body = `<header class="wrap hero"><h1>${esc(t.brand)} <small>${esc(t.tagline)}</small></h1><p class="sub">${esc(t.heroSub)}</p><p id="meta" class="hint">${esc(t.loading)}</p></header>
<section class="wrap bar">
<input id="q" type="search" placeholder="${esc(t.search)}" autofocus />
<select id="kind"><option value="">${esc(t.kinds[0])}</option><option value="dbx">${esc(t.kinds[1])}</option><option value="dsh">${esc(t.kinds[2])}</option></select>
<select id="cat"><option value="">${esc(t.allCats)}</option></select>
<select id="sort"><option value="stars">${esc(t.sorts[0])}</option><option value="updated">${esc(t.sorts[1])}</option><option value="name">${esc(t.sorts[2])}</option></select>
</section>
<main class="wrap" id="grid"></main>
<nav class="wrap pager" id="pager"></nav>
<p class="wrap hint" id="updated"></p>`;
  return layout({ lang, root, rel: "index.html", title: t.title, desc: t.desc, body, script: `<script>window.SITE=${JSON.stringify(cfg).replace(/</g, "\\u003c")};</script>\n<script src="${root}app.js"></script>\n` });
}

export function renderInstall(lang) {
  const t = T[lang];
  const root = lang === "en" ? "../" : "";
  const body = `<main class="wrap doc"><h1>${esc(t.installTitle)}</h1><p>${esc(t.installIntro)}</p>
<ol>${t.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>
<h2>${esc(t.catalogUrl)}</h2><input class="url" readonly value="${esc(CATALOG_URL)}" onfocus="this.select()" />
<h2>${esc(t.reqH)}</h2><p>${esc(t.req)}</p>
<h2>${esc(t.diffH)}</h2><ul>${t.diff.map(s => `<li>${esc(s)}</li>`).join("")}</ul></main>`;
  return layout({ lang, root, rel: "install.html", title: `${t.installTitle} · ${t.brand}`, desc: t.installIntro, body });
}

export function renderPrivacy(lang) {
  const t = T[lang];
  const root = lang === "en" ? "../" : "";
  const body = `<main class="wrap doc"><h1>${esc(t.privacyTitle)}</h1>${t.privacy.map(([h, p]) => `<h2>${esc(h)}</h2><p>${md(p)}</p>`).join("")}</main>`;
  return layout({ lang, root, rel: "privacy.html", title: `${t.privacyTitle} · ${t.brand}`, desc: t.privacy[0][1], body });
}

export function renderNotFound(lang) {
  const t = T[lang];
  const root = lang === "en" ? "../" : "";
  return layout({ lang, root, rel: "index.html", title: `${t.notFound} · ${t.brand}`, desc: t.notFoundSub, body: `<main class="wrap doc"><h1>${esc(t.notFound)}</h1><p>${esc(t.notFoundSub)} <a href="${root}${lang === "en" ? "en/" : ""}index.html">${esc(t.nav.home)}</a></p></main>` });
}

export function renderPlugin(lang, p) {
  const t = T[lang];
  const root = lang === "en" ? "../../" : "../";
  const base = lang === "en" ? root + "en/" : root;
  const gh = /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(p.repo || "");
  const meta = [[t.by, p.author], [t.version, p.version && "v" + p.version], [t.license, p.license], [t.updated, p.updated], [t.stars, p.stars != null && p.stars.toLocaleString("en-US")], [t.category, p.category]].filter(([, v]) => v);
  const links = [];
  if (p.download) links.push(`<a href="${root}${esc(p.download)}">${esc(t.download)}</a>`);
  if (web(p.repo)) links.push(`<a href="${esc(p.repo)}" rel="noopener">${esc(t.repo)}</a>`);
  if (web(p.homepage) && p.homepage !== p.repo) links.push(`<a href="${esc(p.homepage)}" rel="noopener">${esc(t.homepage)}</a>`);
  const install = p.kind === "dbx"
    ? `<p>${esc(t.installDbx)} ${esc(t.installDbxSite)} <a href="${base}install.html">${esc(t.installPage)}</a>.</p>` +
      `<h3>${esc(t.permsH)}</h3><p>${p.permissions && p.permissions.length ? p.permissions.map(x => `<code>${esc(x)}</code>`).join(" ") : `<span class="hint">${esc(t.noPerms)}</span>`}</p>` +
      (p.sha256 ? `<h3>${esc(t.checksum)}</h3><p><code class="sha">${esc(p.sha256)}</code></p>` : "")
    : `<p>${esc(t.installDsh)}</p>`;
  const body = `<main class="wrap doc"><p><a href="${base}index.html">${esc(t.back)}</a></p>
<div class="phead">${p.icon ? `<img class="pico" src="${esc(p.icon)}" alt="" width="56" height="56" referrerpolicy="no-referrer" />` : ""}<div><h1>${esc(p.name)}</h1><p class="hint">${meta.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(" · ")}</p></div></div>
<p>${p.official ? `<span class="tag">${esc(t.official)}</span> ` : ""}<span class="tag kind">${p.kind === "dbx" ? "DBX" : t.communityTag}</span> ${(p.tags || []).map(x => `<span class="tag">${esc(x)}</span>`).join(" ")}</p>
<p class="desc">${esc(p.description || t.noDesc)}</p>
<p class="links">${links.join(" · ")}</p>
<h2>${esc(t.installH)}</h2>${install}
${gh ? `<h2>${esc(t.discussH)}</h2><p>${esc(t.discuss)}<a href="${esc(p.repo)}/discussions" rel="noopener">Discussions</a> · <a href="${esc(p.repo)}/issues" rel="noopener">Issues</a></p>` : ""}</main>`;
  return layout({ lang, root, rel: `plugin/${p.slug}.html`, title: `${p.name} · ${t.brand}`, desc: clip(p.description, 160) || t.desc, body });
}

export function renderSitemap(siteUrl, plugins) {
  const u = siteUrl.replace(/\/$/, "");
  const pages = ["", "install.html", "privacy.html", "en/", "en/install.html", "en/privacy.html", ...plugins.flatMap(p => [`plugin/${p.slug}.html`, `en/plugin/${p.slug}.html`])];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map(p => `<url><loc>${esc(`${u}/${encodeURI(p)}`)}</loc></url>`).join("\n")}\n</urlset>\n`;
}

// ───────── 主流程 ─────────

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000), headers: { "user-agent": "m-market-site" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse((await res.text()).replace(/^\uFEFF/, ""));
}

const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

async function main() {
  const args = process.argv.slice(2);
  const aggregate = args.includes("--aggregate");
  const urls = args.flatMap((a, i) => (a === "--upstream" && args[i + 1] ? [args[i + 1]] : []));
  const ups = urls.length ? urls.map((u, i) => ({ name: `upstream-${i + 1}`, url: u })) : DEFAULT_UPSTREAMS;
  const siteUrl = process.env.SITE_URL || "https://1316584746.github.io/M-Market";

  const own = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog", "index.json"), "utf8"));
  const upstreams = [];
  if (aggregate) {
    for (const u of ups) {
      try {
        upstreams.push({ name: u.name, json: await fetchJson(u.url) });
        console.log(`已抓取 ${u.name}`);
      } catch (e) {
        console.warn(`跳过 ${u.name}（${u.url}）：${e.message}`);
      }
    }
  }
  const now = new Date();
  const zh = buildCatalog(own, upstreams, now, "zh-CN");
  const en = buildCatalog(own, upstreams, now, "en");
  zh.problems.forEach(p => console.warn("跳过：" + p));

  const dist = path.join(ROOT, "site-dist");
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, "site"))) fs.copyFileSync(path.join(ROOT, "site", f), path.join(dist, f));
  fs.copyFileSync(path.join(ROOT, "assets", "logo.svg"), path.join(dist, "logo.svg"));
  fs.mkdirSync(path.join(dist, "packages"), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, "packages"))) if (f.endsWith(".dbxp")) fs.copyFileSync(path.join(ROOT, "packages", f), path.join(dist, "packages", f));
  // 本仓库的 DBX 目录也放一份：别人可以把这个地址加成插件来源
  write(path.join(dist, "catalog", "index.json"), fs.readFileSync(path.join(ROOT, "catalog", "index.json")));

  write(path.join(dist, "catalog.json"), JSON.stringify({ generatedAt: zh.generatedAt, plugins: zh.plugins.map(slim) }));
  write(path.join(dist, "catalog.en.json"), JSON.stringify({ generatedAt: en.generatedAt, plugins: en.plugins.map(slim) }));
  for (const [lang, cat, dir] of [["zh", zh, ""], ["en", en, "en/"]]) {
    write(path.join(dist, dir, "index.html"), renderIndex(lang, now));
    write(path.join(dist, dir, "install.html"), renderInstall(lang));
    write(path.join(dist, dir, "privacy.html"), renderPrivacy(lang));
    write(path.join(dist, dir, "404.html"), renderNotFound(lang));
    for (const p of cat.plugins) write(path.join(dist, dir, "plugin", `${p.slug}.html`), renderPlugin(lang, p));
  }
  write(path.join(dist, "sitemap.xml"), renderSitemap(siteUrl, zh.plugins));
  write(path.join(dist, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${siteUrl.replace(/\/$/, "")}/sitemap.xml\n`);
  write(path.join(dist, ".nojekyll"), "");
  const official = zh.plugins.filter(p => p.official).length;
  console.log(`site-dist/ 已生成：${zh.plugins.length} 个插件（官方 ${official}，社区 ${zh.plugins.length - official}），中英文各 ${zh.plugins.length + 4} 页`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
