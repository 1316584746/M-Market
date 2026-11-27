"use strict";
/**
 * modsearch：联网搜索 + 网页读取。移植自 liustack/modsearch（MIT，Leon Liu）。
 * AI 工具：web_search / x_search / read_page / modsearch_doctor；界面方法：ms/*。
 */
const path = require("node:path");
const { serve, settings: openSettings, dataDir } = require("./rpc.cjs");
const E = require("./engines.cjs");
const S = require("./search.cjs");

const VERSION = require("../manifest.json").version;
const store = () => openSettings("settings.json");
const statePath = () => path.join(dataDir(), "state.json");

const ENGINE_LABEL = { firecrawl: "Firecrawl", keenable: "Keenable", youcom: "You.com", tavily: "Tavily", exa: "Exa", local: "local" };
const KEYED = ["firecrawl", "keenable", "tavily", "exa"];

const POOLS = {
  firecrawl: "无需注册即可用（按 IP 的免费额度）；配自己的免费 key 额度更大",
  keenable: "无需注册（每个 IP 每小时 1,000 次）；免费 key 每月 100,000 次",
  youcom: "无需注册（每个 IP 每天 100 次），只能搜索",
  tavily: "需要 key（免费档每月 1,000 积分），只能搜索",
  exa: "需要 key（每月 10 美元免费额度，约 1,400 次搜索），只能搜索",
  local: "内置直连抓取，不需要任何配置，只能读网页",
};

// ───────── 证据渲染（给模型看的文本） ─────────

function renderSearch(entry) {
  const lines = [];
  if (entry.status === "degraded") lines.push(`[X was unreachable; a ${entry.source} search answered second-hand. Treat as indirect evidence.]`);
  lines.push(entry.summary || "");
  const items = entry.items || [];
  if (items.length) {
    lines.push("", "Results:");
    items.forEach((it, i) => {
      lines.push(`${i + 1}. ${it.title}${it.published_at ? ` (${it.published_at})` : ""} — ${it.url}`);
      if (it.snippet) lines.push(`   ${it.snippet}`);
    });
  }
  if ((entry.uncertainty || []).length) lines.push("", `Uncertain: ${entry.uncertainty.join("; ")}`);
  if ((entry.warnings || []).length) lines.push("", `Warnings: ${entry.warnings.join("; ")}`);
  lines.push("", `(engine: ${entry.engine})`);
  return lines.join("\n");
}

function renderFetch(v) {
  const lines = [v.summary || ""];
  const content = typeof v.content === "string" ? v.content.trim() : "";
  if (content) lines.push("", "Content:", content);
  const links = Array.isArray(v.links) ? v.links.slice(0, 20) : [];
  if (links.length) {
    lines.push("", "Links:");
    for (const l of links) lines.push(`- ${l.text} — ${l.url}`);
  }
  if ((v.uncertainty || []).length) lines.push("", `Uncertain: ${v.uncertainty.join("; ")}`);
  if ((v.warnings || []).length) lines.push("", `Warnings: ${v.warnings.join("; ")}`);
  if (v.contentRange) lines.push("", `(characters ${v.contentRange.start}-${v.contentRange.end} of ${v.contentRange.total}; engine: ${v.engine})`);
  return lines.join("\n");
}

// ───────── 页面缓存：读过的页面 5 分钟内翻页不再重新抓取，最多 64 页，只在进程内 ─────────

const PAGE_TTL = 5 * 60_000;
const PAGE_MAX = 64;
const pages = new Map();
const pageGet = key => {
  const kept = pages.get(key);
  if (!kept) return undefined;
  if (Date.now() - kept.at > PAGE_TTL) {
    pages.delete(key);
    return undefined;
  }
  return kept;
};
const pageSet = (key, entry) => {
  pages.delete(key);
  pages.set(key, { entry, at: Date.now() });
  while (pages.size > PAGE_MAX) pages.delete(pages.keys().next().value);
};

const READ_WINDOW = 20_000;
const READ_WINDOW_MAX = 100_000;

function windowNumber(value, name, minimum) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < minimum) throw new Error(`${name} must be a whole number of at least ${minimum}.`);
  return n;
}

// ───────── 运行 ─────────

const cfg = () => store().get();

async function doSearch({ query, maxResults, engine, sources, timeoutMs = 40_000, deadlineMs = 55_000 }) {
  const out = await S.runSearch({ query, engine, sources, maxResults, timeoutMs, deadlineMs, config: cfg(), statePath: statePath() });
  return out.results[0];
}

async function doRead({ url, query, startIndex, maxLength, engine, timeoutMs = 60_000, deadlineMs = 90_000 }) {
  const key = `${url}\n${query || ""}\n${engine || ""}`;
  let kept = pageGet(key);
  const notes = [];
  let entry;
  if (kept) {
    entry = kept.entry;
    notes.push(`From the copy of this page read ${Math.round((Date.now() - kept.at) / 1000)} seconds ago.`);
  } else {
    // 一次取回整份文档，后面每个窗口都不用再请求
    const out = await S.runSearch({ url, prompt: query, engine, timeoutMs, deadlineMs, startIndex: 0, maxLength: E.MAX_DOCUMENT_CHARS, config: cfg(), statePath: statePath() });
    entry = out.results[0];
    pageSet(key, entry);
  }
  const full = typeof entry.content === "string" ? entry.content : "";
  const total = full.length;
  const si = startIndex ?? 0;
  const ml = Math.min(maxLength ?? READ_WINDOW, READ_WINDOW_MAX);
  const start = Math.min(si, total);
  const end = Math.min(total, start + ml);
  if (si >= total && total > 0) notes.push(`start_index ${si} is past the end of the page, which has ${total} characters.`);
  else if (end < total) notes.push(`Showing characters ${start} to ${end} of ${total}. Call read_page again with start_index ${end} to read on.`);
  const warnings = (entry.warnings || []).filter(w => !/^Showing characters \d+ to \d+ of \d+\./.test(w));
  return {
    summary: entry.summary,
    content: full.slice(start, end),
    contentRange: { start, end, total },
    ...(Array.isArray(entry.links) ? { links: entry.links } : {}),
    uncertainty: entry.uncertainty || [],
    warnings: [...warnings, ...notes],
    engine: entry.engine,
    attempts: entry.attempts,
  };
}

// ───────── 状态 / 诊断 ─────────

const mask = key => (key.length <= 8 ? "••••" : `••••${key.slice(-4)}`);

function status() {
  const config = cfg();
  const env = process.env;
  const now = new Date();
  const state = S.loadState(statePath());
  const engines = E.allEngines().map(e => {
    const own = (config.engines && config.engines[e.name]) || {};
    const eff = S.engineSettings(e.name, config, env);
    const keys = E.splitApiKeys(eff.apiKey);
    const fromEnv = !E.splitApiKeys(own.apiKey).length && keys.length > 0;
    const cooling = S.coolingEngineEntry(state, e.name, keys.length, now);
    return {
      name: e.name,
      label: ENGINE_LABEL[e.name] || e.name,
      roles: e.roles,
      requirement: e.requirement,
      pool: POOLS[e.name] || "",
      keyed: KEYED.includes(e.name),
      keyless: e.name === "firecrawl" || e.name === "keenable" || e.name === "youcom" || e.name === "local",
      enabled: eff.enabled !== false,
      baseURL: own.baseURL || "",
      keylessFetch: own.keylessFetch !== false,
      keyCount: keys.length,
      keyHints: keys.map(mask),
      keyFromEnv: fromEnv,
      searchReady: e.roles.includes("search") && e.isAvailable(eff, env, "search"),
      fetchReady: e.roles.includes("fetch") && e.isAvailable(eff, env, "fetch"),
      cooling: cooling ? { until: cooling.until, reason: cooling.reason.split("\n")[0].slice(0, 160) } : null,
      keyCooling: keys.map((_k, i) => {
        const c = S.coolingEngineEntry(state, e.name, 0, now) || state.engineCooldowns[`${e.name}::key:${i}`];
        return c && Date.parse(c.until) > now.getTime() ? c.until : null;
      }),
    };
  });
  const route = role => {
    const { chain, notes } = S.planRole(role, config, undefined, env, config.cooldown !== false ? { state, now } : undefined);
    return { chain: chain.map(c => c.name), notes };
  };
  return {
    version: VERSION,
    settings: { engine: config.engine || "", fetchEngine: config.fetchEngine || "", allowPrivateNetwork: config.allowPrivateNetwork === true, cooldown: config.cooldown !== false },
    engines,
    routes: { search: route("search"), fetch: route("fetch") },
  };
}

function doctorText() {
  const st = status();
  const lines = [`modsearch ${st.version}`, ""];
  lines.push(`search: ${st.routes.search.chain.join(" → ") || "(none)"}`);
  lines.push(`fetch:  ${st.routes.fetch.chain.join(" → ") || "(none)"}`);
  for (const n of [...st.routes.search.notes, ...st.routes.fetch.notes]) lines.push(`  note: ${n}`);
  lines.push("", "engines:");
  for (const e of st.engines) {
    const bits = [e.enabled ? "enabled" : "disabled"];
    if (e.keyCount) bits.push(`${e.keyCount} key${e.keyCount > 1 ? "s" : ""}${e.keyFromEnv ? " (from environment)" : ""}`);
    else if (e.keyed) bits.push("no key");
    if (e.roles.includes("search")) bits.push(e.searchReady ? "search ready" : "search not ready");
    if (e.roles.includes("fetch")) bits.push(e.fetchReady ? "fetch ready" : "fetch not ready");
    if (e.cooling) bits.push(`cooling until ${e.cooling.until}`);
    lines.push(`  - ${e.name}: ${bits.join(", ")}`);
  }
  lines.push("", `private network access: ${st.settings.allowPrivateNetwork ? "ALLOWED" : "blocked"}`, `quota cooldown: ${st.settings.cooldown ? "on" : "off"}`);
  return lines.join("\n");
}

// ───────── 保存设置 ─────────

const ENGINE_NAMES = E.allEngines().map(e => e.name);

function save(params = {}) {
  const cur = cfg();
  const next = { ...cur };
  for (const k of ["engine", "fetchEngine"]) {
    if (params[k] !== undefined) {
      const v = String(params[k] || "").trim();
      if (v && !E.findEngine(v)) throw new Error(`未知的引擎：${v}。可选：${ENGINE_NAMES.join("、")}`);
      if (v) next[k] = E.canonicalEngineName(v);
      else delete next[k];
    }
  }
  if (params.allowPrivateNetwork !== undefined) next.allowPrivateNetwork = params.allowPrivateNetwork === true;
  if (params.cooldown !== undefined) next.cooldown = params.cooldown !== false;
  if (params.engines && typeof params.engines === "object") {
    const engines = { ...(cur.engines || {}) };
    for (const [rawName, patch] of Object.entries(params.engines)) {
      const e = E.findEngine(rawName);
      if (!e || !patch || typeof patch !== "object") continue;
      const own = { ...(engines[e.name] || {}) };
      // apiKey 缺省 = 不改；空字符串 = 清除。界面从不拿到明文
      if (patch.apiKey !== undefined) {
        const keys = E.splitApiKeys(String(patch.apiKey));
        if (keys.length) own.apiKey = keys.join(",");
        else delete own.apiKey;
      }
      if (patch.baseURL !== undefined) {
        const b = String(patch.baseURL || "").trim();
        if (b && !/^https?:\/\//i.test(b)) throw new Error(`${e.name} 的接口地址必须以 http:// 或 https:// 开头`);
        if (b) own.baseURL = b;
        else delete own.baseURL;
      }
      if (patch.enabled !== undefined) {
        if (patch.enabled === false) own.enabled = false;
        else delete own.enabled;
      }
      if (patch.keylessFetch !== undefined) {
        if (patch.keylessFetch === false) own.keylessFetch = false;
        else delete own.keylessFetch;
      }
      if (Object.keys(own).length) engines[e.name] = own;
      else delete engines[e.name];
    }
    next.engines = engines;
  }
  // set() 是浅合并：被删掉的键要显式写成 undefined 才会从文件里消失（JSON 序列化会丢掉它）
  const patch = {};
  for (const k of new Set([...Object.keys(cur), ...Object.keys(next)])) patch[k] = next[k];
  store().set(patch);
  return status();
}

// ───────── 工具与方法 ─────────

const n = (v, d) => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.min(Math.floor(x), 50) : d;
};

const tools = [
  {
    name: "web_search",
    description:
      "Search the public web through modsearch and return ranked results (title, URL, snippet) with an uncertainty list. It tries several engines in order (Firecrawl, Keenable, You.com keyless; Tavily, Exa with a key) and fails over on quota or errors, so it works with no setup. Use it for current information, documentation lookups and anything you are unsure about. Follow up with read_page to read a result in full.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        max_results: { type: "number", description: "Maximum number of result items (default 8)" },
      },
      required: ["query"],
    },
    readOnly: true,
    async run(args) {
      if (typeof args?.query !== "string" || !args.query.trim()) throw new Error('web_search needs a non-empty string "query".');
      return renderSearch(await doSearch({ query: args.query, maxResults: n(args.max_results, 8), sources: ["web"] }));
    },
  },
  {
    name: "x_search",
    description:
      "Search X (Twitter) posts. This build has no X-capable engine, so the question is answered from the public web and marked degraded: the result says plainly that it is second-hand evidence which cannot see inside X. Use for questions about posts, threads or accounts on X.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for on X (accounts, topics, time bounds in plain words)" },
        max_results: { type: "number", description: "Maximum number of result items (default 8)" },
      },
      required: ["query"],
    },
    readOnly: true,
    async run(args) {
      if (typeof args?.query !== "string" || !args.query.trim()) throw new Error('x_search needs a non-empty string "query".');
      return renderSearch(await doSearch({ query: args.query, maxResults: n(args.max_results, 8), sources: ["x"] }));
    },
  },
  {
    name: "read_page",
    description:
      'Read one web page and return its extracted content, outgoing links, uncertainty and operational warnings. Use it when you need the full text of a page (for example a search result), or when a page is rendered by JavaScript and a plain fetch returns an empty shell. Pass "query" to focus a cloud reader on one question. Long pages come back 20,000 characters at a time: contentRange says where this part sits, and a warning names the start_index to pass for the next part. Paging a page read in the last five minutes reuses that copy instead of reading it again. Private-network URLs are blocked.',
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to read" },
        query: { type: "string", description: 'Optional question to focus the reading on (e.g. "what are the rate limits")' },
        start_index: { type: "number", description: "Character to start the returned content at (default 0). Pass the value a previous call named to read on." },
        max_length: { type: "number", description: `Characters of content to return (default ${READ_WINDOW}, at most ${READ_WINDOW_MAX})` },
      },
      required: ["url"],
    },
    readOnly: true,
    async run(args) {
      if (typeof args?.url !== "string" || !/^https?:\/\//i.test(args.url.trim())) throw new Error('read_page needs an http(s) "url".');
      const startIndex = windowNumber(args.start_index, "start_index", 0);
      const maxLength = windowNumber(args.max_length, "max_length", 1);
      const query = typeof args.query === "string" && args.query.trim() ? args.query : undefined;
      return renderFetch(await doRead({ url: args.url.trim(), query, startIndex, maxLength }));
    },
  },
  {
    name: "modsearch_doctor",
    description: "Show which engines modsearch would use right now for search and page reading, which keys are set (never the keys themselves), and which engines are cooling after a quota error.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    async run() {
      return doctorText();
    },
  },
];

const methods = {
  "ms/status": () => status(),
  "ms/save": params => save(params),
  "ms/doctor": () => ({ text: doctorText() }),
  async "ms/test-search"({ query, engine } = {}) {
    if (!String(query || "").trim()) throw new Error("请输入要搜索的内容");
    const e = await doSearch({ query: String(query), maxResults: 5, engine: engine || undefined, sources: ["web"], timeoutMs: 30_000, deadlineMs: 45_000 });
    return { entry: e, text: renderSearch(e), status: status() };
  },
  async "ms/test-fetch"({ url, engine } = {}) {
    if (!/^https?:\/\//i.test(String(url || "").trim())) throw new Error("请输入以 http:// 或 https:// 开头的网址");
    const out = await S.runSearch({ url: String(url).trim(), engine: engine || undefined, timeoutMs: 40_000, deadlineMs: 60_000, maxLength: 1_500, config: cfg(), statePath: statePath() });
    const e = out.results[0];
    return { entry: { ...e, links: (e.links || []).slice(0, 5) }, text: renderFetch({ ...e, links: (e.links || []).slice(0, 5) }), status: status() };
  },
  "ms/clear-cooldown"({ engine } = {}) {
    const fs = require("node:fs");
    const p = statePath();
    if (!engine) {
      fs.rmSync(p, { force: true });
    } else {
      const state = S.loadState(p);
      const name = E.canonicalEngineName(engine);
      for (const k of Object.keys(state.engineCooldowns)) if (k === name || k.startsWith(`${name}::key:`)) delete state.engineCooldowns[k];
      fs.writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`);
    }
    return status();
  },
};

serve({ id: "modsearch", version: VERSION, methods, tools });
