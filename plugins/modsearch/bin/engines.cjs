"use strict";
/**
 * 引擎：firecrawl、keenable、youcom、tavily、exa 走各自的 HTTP API，local 是内置的直连抓取。
 * 移植自 liustack/modsearch（MIT）的 providers/*。没有移植 Antigravity CLI 和 Grok Build：它们要拉起外部命令行并登录。
 * 每个引擎：{ name, roles, requirement, isAvailable(settings, env, role), execute(request) → { result, meta } }
 */
const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");
const { assertCloudDisclosable, assertSafeRemoteTarget, normalizeFetchUrl } = require("./net.cjs");
const { extractLinks, extractVisibleTextFromHtml, normalizeWhitespace } = require("./html.cjs");

/** 一份文档最多留多少字符；每个抓取引擎都截到这个上限 */
const MAX_DOCUMENT_CHARS = 500_000;

// ───────── 小工具 ─────────

function splitApiKeys(value) {
  if (typeof value !== "string") return [];
  return value.split(",").map(k => k.trim()).filter(Boolean);
}

/** 认证、限流、配额这类和所选 key 绑定的失败：换下一把 key 再试 */
class ApiKeyFailureError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApiKeyFailureError";
  }
}

const QUOTA_PATTERNS = [
  /\bquota\b/i,
  /\bpayment required\b/i,
  /\b(?:out of|insufficient|not enough)\s+(?:account\s+)?(?:balance|credits?)\b/i,
  /\b(?:balance|credits?)\s+(?:is\s+)?(?:insufficient|exhausted|depleted|empty|too low|used up)\b/i,
  /\b(?:credit|usage)\s+(?:limit|cap)\s+(?:reached|exceeded)\b/i,
];
const isQuotaFailureMessage = m => QUOTA_PATTERNS.some(p => p.test(m));

const TOKEN_SHAPES = [
  /\b(?:sk|rk|pk|xox[a-z])-[A-Za-z0-9_-]{12,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
  /\b(?:bearer|authorization)\b[=:\s]+"?[A-Za-z0-9._~+/-]{12,}"?/gi,
  /\b(?:token|api[-_]?key)\b\s*[=:]\s*"?[A-Za-z0-9._~+/-]{12,}"?/gi,
];

/** 错误文本里最容易带出凭据：先精确替换已知密钥，再按形状兜底，最后遮掉 URL 里的用户名密码 */
function redactSecrets(text, known = []) {
  let out = String(text ?? "");
  for (const s of known) if (s && String(s).length >= 6) out = out.split(String(s)).join("[redacted]");
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, "[redacted]");
  out = out.replace(/\b[a-z][a-z0-9+.-]*:[^ ]*@[^ ]*/gi, token => {
    try {
      const u = new URL(token);
      return u.username || u.password ? `${u.protocol}//[redacted]@${u.host}${u.pathname}${u.search}${u.hash}` : token;
    } catch {
      return token.replace(/^([a-z][a-z0-9+.-]*:[\\/]{2,4})[^\s/?#]*@/i, "$1[redacted]@");
    }
  });
  return out;
}

const SPENT_ALLOWANCE_MIN_SECONDS = 60;

function retryAfterSeconds(response, now = Date.now()) {
  const raw = (response.headers.get("retry-after") || "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - now) / 1000));
}

/** "Resets in 23h48m52s"，冷却层按这个写法读出恢复时间 */
function resetClause(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `Resets in ${h > 0 ? `${h}h` : ""}${m}m${seconds % 60}s`;
}

function resolveEndpoint(baseURL, defaultBase, pathname) {
  const base = String(baseURL || "").trim() || defaultBase;
  if (!/^https?:\/\//i.test(base)) throw new Error(`Invalid engine baseURL "${redactSecrets(base)}". Use a full http(s) URL, e.g. https://api.example.com`);
  return `${base.replace(/\/+$/, "")}${pathname}`;
}

const safeHostname = url => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

/** 一次 API 请求，整个响应体在同一个期限内读完。超时读作 `<label> timed out after <ms> ms.` */
async function requestText(label, url, init, signal, timeoutMs, secrets) {
  const fail = e =>
    signal.aborted
      ? new Error(`${label} timed out after ${timeoutMs} ms.`)
      : new Error(`${label} request failed: ${redactSecrets(e && e.cause ? `${e.message} (${e.cause.code || e.cause.message || e.cause})` : e instanceof Error ? e.message : String(e), secrets)}`);
  let response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (e) {
    throw fail(e);
  }
  try {
    return { response, text: await response.text() };
  } catch (e) {
    if (!response.ok && !signal.aborted) return { response, text: "" };
    throw fail(e);
  }
}

const requireQuery = o => {
  if (!o.query) throw new Error("Search mode requires a query.");
};

const mechanical = (name, items, query) => (items.length ? `${name} returned ${items.length} ranked result(s) for "${query}". Read items for the sources.` : "");

function searchOutput(name, items, query, startedAt, usage, summary) {
  return {
    result: {
      summary: summary ?? mechanical(name, items, query),
      items,
      uncertainty: items.length === 0 ? ["No results found for this query."] : [],
      warnings: summary === undefined ? [`${name} returns ranked results without an LLM summary, so the summary is mechanical: read items directly for the evidence.`] : [],
    },
    meta: { durationSeconds: (Date.now() - startedAt) / 1000, usage },
  };
}

function markdownLinks(markdown) {
  const out = [];
  const seen = new Set();
  for (const m of markdown.matchAll(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)/gi)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ text: (m[1].trim() || m[2]).slice(0, 100), url: m[2] });
    if (out.length >= 20) break;
  }
  return out;
}

/** 页面骨架：去掉标题后只剩链接、没有正文，多半是浏览器端渲染的内容没出来 */
function looksLikeClientRenderedShell(markdown) {
  let links = 0;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim().replace(/^[-*+]\s+/, "");
    if (/^#{1,6}(?:\s|$)/.test(line)) continue;
    const rest = line.replace(/\[([^\]]+)\](?:\([^)]*\))?/g, () => {
      links += 1;
      return "";
    });
    if (!/^[\s|]*$/.test(rest)) return false;
  }
  return links >= 1;
}

// ───────── Firecrawl ─────────

const FIRECRAWL_BASE = "https://api.firecrawl.dev";
const clampTimeout = ms => Math.min(Math.max(ms, 1_000), 300_000);

function keylessWait(text, response) {
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON 就只看响应头 */
  }
  const fromBody = typeof body.retry_after_seconds === "number" && body.retry_after_seconds > 0 ? Math.round(body.retry_after_seconds) : null;
  const wait = fromBody ?? retryAfterSeconds(response);
  if (wait === null) return null;
  return body.reason === "credits" || wait >= SPENT_ALLOWANCE_MIN_SECONDS ? wait : null;
}

function firecrawlEnsureOk(response, text, apiKey, secrets) {
  if (response.ok) return;
  const detail = redactSecrets(text.trim(), secrets);
  const message = `firecrawl returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ""}`;
  if (response.status >= 500) throw new Error(message);
  if (response.status === 402 || isQuotaFailureMessage(detail)) throw new ApiKeyFailureError(`firecrawl is out of credits: ${detail || `HTTP ${response.status}`}. Add credit or set your own key at https://firecrawl.dev, or use another engine.`);
  if (response.status === 401 || response.status === 403) {
    if (!apiKey) {
      // Firecrawl 会拒绝它认为是 VPN / 代理出口的匿名请求；等也没用，要换办法
      if (/VPN or proxy/i.test(detail)) throw new Error(`firecrawl does not allow keyless use from a proxy or VPN exit IP. Set a free firecrawl key in the settings, or use keenable or youcom. (${detail})`);
      throw new Error(`firecrawl rejected the keyless request (${response.status}). Anonymous access may be unavailable or rate-limited. Set your own firecrawl key in the settings${detail ? ` (${detail})` : ""}`);
    }
    throw new ApiKeyFailureError(`firecrawl rejected the API key (${response.status}). Fix it in the settings${detail ? ` (${detail})` : ""}`);
  }
  if (apiKey && response.status === 429) throw new ApiKeyFailureError(message);
  if (!apiKey && response.status === 429) {
    const wait = keylessWait(text, response);
    if (wait !== null) throw new Error(`firecrawl's keyless allowance for this IP is used up. ${resetClause(wait)}. Set a free firecrawl key in the settings, or use keenable or youcom.`);
  }
  throw new Error(message);
}

async function firecrawlPost(url, apiKey, secrets, body, signal, timeoutMs) {
  // 没有 key 就走匿名额度：不带 Authorization 头
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const { response, text } = await requestText("firecrawl", url, { method: "POST", headers, body: JSON.stringify(body) }, signal, timeoutMs, secrets);
  firecrawlEnsureOk(response, text, apiKey, secrets);
  return JSON.parse(text);
}

function normalizeLinks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    let url;
    let text;
    if (typeof entry === "string") {
      url = entry;
      text = entry;
    } else if (entry && typeof entry === "object") {
      url = typeof entry.url === "string" ? entry.url : undefined;
      text = typeof entry.text === "string" && entry.text ? entry.text : url;
    }
    if (!url || !/^https?:/i.test(url)) continue;
    out.push({ text: (text ?? url).slice(0, 100), url });
    if (out.length >= 20) break;
  }
  return out;
}

async function firecrawlSearch(o) {
  requireQuery(o);
  const keys = splitApiKeys(o.settings.apiKey);
  const apiKey = keys[0] ?? null;
  const secrets = [...new Set([...keys, ...(o.apiKeySecrets || [])])];
  const startedAt = Date.now();
  const data = await firecrawlPost(resolveEndpoint(o.settings.baseURL, FIRECRAWL_BASE, "/v2/search"), apiKey, secrets, { query: o.query, limit: o.maxResults ?? 10, sources: ["web"], timeout: clampTimeout(o.timeoutMs) }, AbortSignal.timeout(o.timeoutMs), o.timeoutMs);
  const items = ((data.data && data.data.web) || []).map(r => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.description ?? "", source: r.url ? safeHostname(r.url) : undefined }));
  return searchOutput("Firecrawl", items, o.query, startedAt, { resultCount: items.length, creditsUsed: data.creditsUsed ?? null });
}

async function firecrawlFetch(o) {
  if (!o.url) throw new Error("Fetch mode requires a URL.");
  const keys = splitApiKeys(o.settings.apiKey);
  const apiKey = keys[0] ?? null;
  const secrets = [...new Set([...keys, ...(o.apiKeySecrets || [])])];
  const target = normalizeFetchUrl(o.url);
  const deadline = AbortSignal.timeout(o.timeoutMs);
  await assertCloudDisclosable("firecrawl", target, deadline, o.timeoutMs);
  const startedAt = Date.now();
  const data = await firecrawlPost(
    resolveEndpoint(o.settings.baseURL, FIRECRAWL_BASE, "/v2/scrape"),
    apiKey,
    secrets,
    // 每次都抓新的、不留痕：maxAge 0 只是不读它的多日缓存，storeInCache false 不让这页被写进它的缓存和索引；
    // skipTlsVerification 上游默认 true，这里明确关回去
    { url: target.toString(), formats: ["markdown", "links"], onlyMainContent: true, maxAge: 0, storeInCache: false, skipTlsVerification: false, timeout: clampTimeout(o.timeoutMs) },
    deadline,
    o.timeoutMs,
  );
  const meta = (data.data && data.data.metadata) || {};
  const status = meta.statusCode;
  if (typeof status === "number" && (status < 200 || status >= 300)) throw new Error(`firecrawl fetched ${target.toString()} but the page returned ${status}.`);
  const raw = (data.data && data.data.markdown) || "";
  const truncated = raw.length > MAX_DOCUMENT_CHARS;
  const content = truncated ? raw.slice(0, MAX_DOCUMENT_CHARS) : raw;
  const uncertainty = [];
  if (content.length < 200) {
    uncertainty.push(looksLikeClientRenderedShell(content) ? "The page content is likely generated by browser-side JavaScript, but this fetch captured only the page shell. Missing content does not mean the page itself is empty." : "Very little content came back from Firecrawl, so the page may be genuinely sparse.");
  }
  const warnings = ["Fetched through Firecrawl in the cloud, which runs JavaScript. The content is Firecrawl markdown extraction, not the raw page as served."];
  if (truncated) warnings.push(`Content truncated at ${MAX_DOCUMENT_CHARS} characters.`);
  return {
    result: { summary: meta.title || meta.description || `${target.toString()} (Firecrawl scrape${typeof status === "number" ? `, ${status}` : ""})`, content, links: normalizeLinks(data.data && data.data.links), uncertainty, warnings },
    meta: { durationSeconds: (Date.now() - startedAt) / 1000, usage: { statusCode: status ?? null } },
  };
}

const keylessFetchOn = s => s.keylessFetch === undefined || s.keylessFetch === true;

const firecrawl = {
  name: "firecrawl",
  roles: ["search", "fetch"],
  requirement: "nothing: search and public-page fetch work keyless (free, no signup). Opt out of cloud fetch with the keyless-fetch switch",
  // 匿名抓取默认开，只有明确关掉才关；任何畸形值都按「关」处理，宁可退回本地也不在拿不准时把 URL 发到云端。配了 key 一律可用
  isAvailable: (s, env, role) => role === "search" || splitApiKeys(s.apiKey).length > 0 || splitApiKeys(env.FIRECRAWL_API_KEY).length > 0 || keylessFetchOn(s),
  execute: o => (o.mode === "fetch" ? firecrawlFetch(o) : firecrawlSearch(o)),
};

// ───────── Keenable ─────────

const KEENABLE_BASE = "https://api.keenable.ai";
const KEENABLE_TITLE = "modsearch";

const keenableHeaders = apiKey => {
  const h = { "content-type": "application/json" };
  if (apiKey) h["x-api-key"] = apiKey;
  else h["x-keenable-title"] = KEENABLE_TITLE; // 匿名请求要用它标明调用方
  return h;
};

function keenableIsKeyRefusal(text) {
  let code;
  try {
    code = JSON.parse(text).code;
  } catch {
    return true;
  }
  return typeof code !== "string" || /key|auth/i.test(code);
}

function keenableEnsureOk(response, text, apiKey, secrets) {
  if (response.ok) return;
  const detail = redactSecrets(text.trim(), secrets);
  const message = `keenable returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ""}`;
  if (response.status >= 500) throw new Error(message);
  if (!apiKey) {
    // 匿名池是同一个 IP 上所有人共用的，429 不是用户配置的问题
    if (response.status === 429) {
      const wait = retryAfterSeconds(response);
      const when = wait !== null && wait >= SPENT_ALLOWANCE_MIN_SECONDS ? `. ${resetClause(wait)}.` : " for the hour (1,000 requests).";
      throw new Error(`keenable's keyless pool for this IP is used up${when} Set a free keenable key for your own quota (100,000 requests/month, https://app.keenable.ai)`);
    }
    throw new Error(message);
  }
  if (response.status === 402 || isQuotaFailureMessage(detail)) throw new ApiKeyFailureError(`keenable is out of credits (HTTP ${response.status}).${detail ? ` ${detail}` : ""} Buy credits at https://app.keenable.ai/console, wait for the monthly reset, or use another engine.`);
  if (response.status === 429) throw new ApiKeyFailureError(message);
  if (response.status === 401 || (response.status === 403 && keenableIsKeyRefusal(text))) throw new ApiKeyFailureError(`keenable rejected the API key (${response.status}). Fix it in the settings${detail ? ` (${detail})` : ""}`);
  throw new Error(message);
}

async function keenableSearch(o) {
  requireQuery(o);
  const keys = splitApiKeys(o.settings.apiKey);
  const apiKey = keys[0] ?? null;
  const secrets = [...new Set([...keys, ...(o.apiKeySecrets || [])]), o.settings.baseURL];
  const max = Math.min(o.maxResults ?? 10, 50);
  const startedAt = Date.now();
  const { response, text } = await requestText("keenable", resolveEndpoint(o.settings.baseURL, KEENABLE_BASE, apiKey ? "/v1/search" : "/v1/search/public"), { method: "POST", headers: keenableHeaders(apiKey), body: JSON.stringify({ query: o.query, max_results: max }) }, AbortSignal.timeout(o.timeoutMs), o.timeoutMs, secrets);
  keenableEnsureOk(response, text, apiKey, secrets);
  const data = JSON.parse(text);
  const items = (data.results || []).map(r => {
    const it = { title: r.title ?? "", url: r.url ?? "", snippet: r.snippet || r.description || "", source: r.url ? safeHostname(r.url) : undefined };
    if (r.published_at) it.published_at = r.published_at;
    return it;
  });
  return searchOutput("Keenable", items, o.query, startedAt, { resultCount: items.length, mode: data.mode ?? null });
}

async function keenableFetch(o) {
  if (!o.url) throw new Error("Fetch mode requires a URL.");
  const keys = splitApiKeys(o.settings.apiKey);
  const apiKey = keys[0] ?? null;
  const secrets = [...new Set([...keys, ...(o.apiKeySecrets || [])]), o.settings.baseURL];
  const target = normalizeFetchUrl(o.url);
  const deadline = AbortSignal.timeout(o.timeoutMs);
  await assertCloudDisclosable("keenable", target, deadline, o.timeoutMs);
  // 带了提问就让它的模型只抽取那一部分，content 是答案而不是整页
  const warnings = [];
  const focus = [o.query && o.query.trim(), o.extraPrompt && o.extraPrompt.trim()].filter(Boolean).join("\n");
  let prompt;
  if (focus.length > 2000) warnings.push("The focus is longer than Keenable's 2000-character prompt limit, so the whole page was returned instead of an extract.");
  else if (focus) prompt = focus;
  const params = new URLSearchParams({ url: target.toString(), max_chars: String(MAX_DOCUMENT_CHARS), live: "true" });
  if (prompt) params.set("prompt", prompt);
  const startedAt = Date.now();
  const { response, text } = await requestText("keenable", `${resolveEndpoint(o.settings.baseURL, KEENABLE_BASE, apiKey ? "/v1/fetch" : "/v1/fetch/public")}?${params.toString()}`, { method: "GET", headers: keenableHeaders(apiKey) }, deadline, o.timeoutMs, secrets);
  keenableEnsureOk(response, text, apiKey, secrets);
  const data = JSON.parse(text);
  const raw = data.content ?? "";
  const content = raw.slice(0, MAX_DOCUMENT_CHARS);
  const truncated = data.truncated === true || raw.length > MAX_DOCUMENT_CHARS;
  const finalUrl = data.url || target.toString();
  warnings.unshift(prompt ? `Content is Keenable's model extract for the focus "${prompt}", not the page text. Fetch without a focus for the full page.` : "Fetched through Keenable's cloud reader. The content is its markdown extraction, not the raw page as served.");
  if (truncated) warnings.push(`Content truncated at ${MAX_DOCUMENT_CHARS} characters.`);
  const uncertainty = [];
  if (!prompt && content.length < 200) uncertainty.push("Very little content came back from Keenable. The page may be sparse, or built by browser-side JavaScript the reader did not run.");
  return {
    result: { summary: data.title || finalUrl, content, links: prompt ? [] : markdownLinks(content), uncertainty, warnings },
    meta: { durationSeconds: (Date.now() - startedAt) / 1000, usage: { url: finalUrl, totalChars: data.total_chars ?? null, publishedAt: data.published_at ?? null } },
  };
}

const keenable = {
  name: "keenable",
  roles: ["search", "fetch"],
  requirement: "nothing: search and public-page fetch work keyless (1,000 requests/hour per IP, no signup). A free key lifts the hourly cap (100,000 requests/month)",
  isAvailable: (s, env, role) => role === "search" || splitApiKeys(s.apiKey).length > 0 || splitApiKeys(env.KEENABLE_API_KEY).length > 0 || keylessFetchOn(s),
  execute: o => (o.mode === "fetch" ? keenableFetch(o) : keenableSearch(o)),
};

// ───────── You.com ─────────

const YOUCOM_ENDPOINT = "https://api.you.com/v1/agents/search";

async function youcomSearch(o) {
  if (o.mode === "fetch") throw new Error("The youcom engine does not support page fetch. It searches only.");
  requireQuery(o);
  const max = Math.min(o.maxResults ?? 10, 50);
  const startedAt = Date.now();
  // 匿名端点；baseURL 只用于自建网关或测试
  const url = new URL(o.settings.baseURL ? resolveEndpoint(o.settings.baseURL, YOUCOM_ENDPOINT, "/v1/agents/search") : YOUCOM_ENDPOINT);
  url.searchParams.set("query", o.query);
  url.searchParams.set("count", String(max));
  const { response, text } = await requestText("youcom", url.toString(), { method: "GET", headers: { accept: "application/json" } }, AbortSignal.timeout(o.timeoutMs), o.timeoutMs, []);
  if (!response.ok) {
    const detail = text.trim();
    // 匿名池按 IP 共享、每天重置，下次运行自然会换引擎，不进配额冷却
    if (response.status === 429) throw new Error("youcom's keyless allowance for this IP is used up for the day (100 searches). Search continues with the next engine.");
    throw new Error(`youcom returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ""}`);
  }
  const data = JSON.parse(text);
  const items = ((data.results && data.results.web) || []).map(r => {
    const it = { title: r.title ?? "", url: r.url ?? "", snippet: (r.snippets && r.snippets[0]) || r.description || "", source: r.url ? safeHostname(r.url) : undefined };
    if (r.page_age) it.published_at = r.page_age;
    return it;
  });
  return searchOutput("You.com", items, o.query, startedAt, { resultCount: items.length });
}

const youcom = {
  name: "youcom",
  roles: ["search"],
  requirement: "nothing: search works keyless (100 searches/day per IP, no signup)",
  isAvailable: () => true,
  execute: youcomSearch,
};

// ───────── Tavily ─────────

const TAVILY_BASE = "https://api.tavily.com";

async function tavilySearch(o) {
  if (o.mode === "fetch") throw new Error("The tavily engine does not support page fetch. It searches only.");
  requireQuery(o);
  const keys = splitApiKeys(o.settings.apiKey);
  const apiKey = keys[0];
  const secrets = [...new Set([...keys, ...(o.apiKeySecrets || [])])];
  if (!apiKey) throw new Error("The tavily engine needs an API key. Set TAVILY_API_KEY, or fill it in the settings (free tier: 1,000 credits/month at https://app.tavily.com)");
  const startedAt = Date.now();
  const all = [...secrets, o.settings.baseURL];
  const { response, text } = await requestText("tavily", resolveEndpoint(o.settings.baseURL, TAVILY_BASE, "/search"), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ query: o.query, search_depth: "basic", include_answer: true, max_results: o.maxResults ?? 8 }) }, AbortSignal.timeout(o.timeoutMs), o.timeoutMs, all);
  if (!response.ok) {
    const detail = redactSecrets(text.trim(), all);
    const message = `tavily returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ""}`;
    if (response.status >= 500) throw new Error(message);
    // 432 / 433 是套餐或按量上限用完：把状态码带进消息，冷却层按「月度配额」一类处理，挡一天
    if (response.status === 432 || response.status === 433) throw new ApiKeyFailureError(`tavily is out of monthly quota (HTTP ${response.status}).${detail ? ` ${detail}` : ""} Add credit at https://app.tavily.com, or search with another engine.`);
    if (response.status === 401 || response.status === 403 || response.status === 429 || isQuotaFailureMessage(detail)) throw new ApiKeyFailureError(message);
    throw new Error(message);
  }
  const data = JSON.parse(text);
  const items = (data.results || []).map(r => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "", source: r.url ? safeHostname(r.url) : undefined }));
  const summary = data.answer ?? items.map(i => i.snippet).filter(Boolean).join(" ");
  return searchOutput("Tavily", items, o.query, startedAt, { resultCount: items.length }, summary);
}

const tavily = {
  name: "tavily",
  roles: ["search"],
  requirement: "set a Tavily key (free tier: 1,000 credits/month, no card)",
  isAvailable: (s, env) => splitApiKeys(s.apiKey).length > 0 || splitApiKeys(env.TAVILY_API_KEY).length > 0,
  execute: tavilySearch,
};

// ───────── Exa ─────────

const EXA_BASE = "https://api.exa.ai";

async function exaSearch(o) {
  if (o.mode === "fetch") throw new Error("The exa engine does not support page fetch. It searches only.");
  requireQuery(o);
  const keys = splitApiKeys(o.settings.apiKey);
  const apiKey = keys[0];
  const secrets = [...new Set([...keys, ...(o.apiKeySecrets || [])])];
  if (!apiKey) throw new Error("The exa engine needs an API key. Set EXA_API_KEY, or fill it in the settings ($10/month recurring free credit, ~1,400 searches, no card at https://exa.ai)");
  const startedAt = Date.now();
  const all = [...secrets, o.settings.baseURL];
  const { response, text } = await requestText("exa", resolveEndpoint(o.settings.baseURL, EXA_BASE, "/search"), { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey }, body: JSON.stringify({ query: o.query, numResults: o.maxResults ?? 10, contents: { highlights: true } }) }, AbortSignal.timeout(o.timeoutMs), o.timeoutMs, all);
  if (!response.ok) {
    const detail = redactSecrets(text.trim(), all);
    if (response.status >= 500) throw new Error(`exa returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ""}`);
    // 余额用完是配额错误，不是 key 坏了：Exa 可能在多种状态码下返回，先看文本
    if (isQuotaFailureMessage(detail)) throw new ApiKeyFailureError(`exa is out of credits: ${detail || `HTTP ${response.status}`}. Add credit at https://exa.ai, or search with another engine.`);
    if (response.status === 401 || response.status === 403 || response.status === 429) throw new ApiKeyFailureError(`exa rejected the API key (${response.status}). Fix it in the settings${detail ? ` (${detail})` : ""}`);
    throw new Error(`exa returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ""}`);
  }
  const data = JSON.parse(text);
  const items = (data.results || []).map(r => {
    const it = { title: r.title ?? "", url: r.url ?? "", snippet: (r.highlights && r.highlights[0]) ?? "", source: r.url ? safeHostname(r.url) : undefined };
    if (r.publishedDate) it.published_at = r.publishedDate;
    return it;
  });
  return searchOutput("Exa", items, o.query, startedAt, { resultCount: items.length, costDollars: (data.costDollars && data.costDollars.total) ?? null });
}

const exa = {
  name: "exa",
  roles: ["search"],
  requirement: "set an Exa key ($10/month recurring free credit, ~1,400 searches, no card)",
  isAvailable: (s, env) => splitApiKeys(s.apiKey).length > 0 || splitApiKeys(env.EXA_API_KEY).length > 0,
  execute: exaSearch,
};

// ───────── local：直连抓取（无 LLM、无浏览器、无 key、无配额） ─────────

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 4;
const USER_AGENT = "modsearch (+https://github.com/liustack/modsearch)";
const isRedirect = s => s === 301 || s === 302 || s === 303 || s === 307 || s === 308;

function isTextLike(ct) {
  const n = ct.trim().toLowerCase();
  if (!n || n.startsWith("text/")) return true;
  return n.includes("json") || n.includes("xml") || n.includes("html") || n.includes("javascript") || n.includes("x-www-form-urlencoded");
}

function decodeBody(buf, ct) {
  const m = /charset=([^;]+)/i.exec(ct);
  const charset = m ? m[1].trim().toLowerCase().replace(/^"|"$/g, "") : "utf-8";
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** 一跳请求：socket 的 DNS 查询被钉死在检查过的那个 IP，Host 头和 TLS SNI 仍是原主机名 */
function requestOnce(url, pinned, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const onAbort = () => req.destroy(Object.assign(new Error(`Request timed out after ${timeoutMs} ms.`), { code: "ETIMEDOUT_DEADLINE" }));
    const req = lib.request(
      url,
      {
        method: "GET",
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/json,text/plain,application/xml,text/xml;q=0.9,*/*;q=0.5", "accept-encoding": "gzip, deflate, br" },
        lookup: (_host, opts, cb) => {
          if (opts && opts.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        },
        agent: false,
      },
      res => {
        const chunks = [];
        let total = 0;
        const len = Number.parseInt(res.headers["content-length"] || "", 10);
        if (Number.isFinite(len) && len > MAX_BYTES && !res.headers["content-encoding"]) {
          res.destroy();
          reject(new Error(`Response body exceeds max size ${MAX_BYTES} bytes.`));
          return;
        }
        res.on("data", c => {
          total += c.length;
          if (total > MAX_BYTES) {
            res.destroy();
            reject(new Error(`Response body exceeds max size ${MAX_BYTES} bytes.`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          signal.removeEventListener("abort", onAbort);
          let body = Buffer.concat(chunks);
          const enc = String(res.headers["content-encoding"] || "").toLowerCase();
          try {
            if (enc.includes("gzip")) body = zlib.gunzipSync(body, { maxOutputLength: MAX_BYTES * 4 });
            else if (enc.includes("br")) body = zlib.brotliDecompressSync(body, { maxOutputLength: MAX_BYTES * 4 });
            else if (enc.includes("deflate")) body = zlib.inflateSync(body, { maxOutputLength: MAX_BYTES * 4 });
          } catch {
            reject(new Error("Response body could not be decompressed."));
            return;
          }
          resolve({ status: res.statusCode || 0, statusText: res.statusMessage || "", headers: res.headers, body });
        });
        res.on("error", e => reject(e));
      },
    );
    req.on("error", e => {
      signal.removeEventListener("abort", onAbort);
      if (e && e.code === "ETIMEDOUT_DEADLINE") reject(e);
      else if (signal.aborted) reject(new Error(`Request timed out after ${timeoutMs} ms.`));
      else reject(new Error(`Request failed for ${url.toString()}: ${e && e.code ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e)}`));
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

async function runFetch({ url, timeoutMs = 20_000, maxChars = MAX_DOCUMENT_CHARS, allowPrivateNetwork = false }) {
  const requestUrl = normalizeFetchUrl(url);
  let current = requestUrl;
  const redirectChain = [];
  const deadline = AbortSignal.timeout(timeoutMs);
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    // 每一跳都先检查，再把 socket 钉在通过检查的 IP 上
    let pinned;
    try {
      pinned = await assertSafeRemoteTarget(current, allowPrivateNetwork, deadline);
    } catch (e) {
      if (deadline.aborted) throw new Error(`Request timed out after ${timeoutMs} ms.`);
      throw e;
    }
    const res = await requestOnce(current, pinned, deadline, timeoutMs);
    if (isRedirect(res.status)) {
      const loc = res.headers.location;
      if (!loc) throw new Error(`Redirect response (${res.status}) missing location header.`);
      if (i === MAX_REDIRECTS) throw new Error(`Too many redirects. Max redirects: ${MAX_REDIRECTS}.`);
      redirectChain.push(current.toString());
      current = new URL(loc, current);
      continue;
    }
    const ct = String(res.headers["content-type"] || "");
    if (!isTextLike(ct)) throw new Error(`Unsupported content-type: ${ct || "unknown"}. Only text-like content is allowed.`);
    const decoded = decodeBody(res.body, ct);
    const norm = ct.split(";")[0].trim().toLowerCase();
    const isHtml = norm.includes("html") || norm.includes("xhtml");
    const ex = isHtml ? extractVisibleTextFromHtml(decoded) : { title: null, text: normalizeWhitespace(decoded) };
    const truncated = ex.text.length > maxChars;
    return {
      rawHtml: isHtml ? decoded : undefined,
      finalUrl: current.toString(),
      status: res.status,
      statusText: res.statusText,
      title: ex.title,
      text: truncated ? ex.text.slice(0, maxChars) : ex.text,
      meta: { bytes: res.body.length, truncated, redirectChain, maxChars },
    };
  }
  throw new Error("Failed to fetch target URL.");
}

async function localFetch(o) {
  if (o.mode !== "fetch" || !o.url) throw new Error("The local engine does not support search. It fetches one page at a time.");
  const startedAt = Date.now();
  const allowPrivate = o.allowPrivateNetwork === true;
  const r = await runFetch({ url: o.url, timeoutMs: Math.min(o.timeoutMs, 60_000), allowPrivateNetwork: allowPrivate });
  const warnings = ["Fetched directly by the local engine with no LLM synthesis: this is the page text as served, not a restructured summary."];
  if (r.meta.truncated) warnings.push(`Content truncated at ${r.meta.maxChars} characters.`);
  if (r.meta.redirectChain.length) warnings.push(`Followed ${r.meta.redirectChain.length} redirect(s) to ${r.finalUrl}.`);
  if (o.extraPrompt || o.query) warnings.push("This engine cannot narrow the page to a focus. The full text is here, so pick out the relevant parts yourself.");
  if (allowPrivate) warnings.push("Private network protection was disabled for this fetch, so the URL was trusted as given.");
  const uncertainty = [];
  if (r.text.length < 200) uncertainty.push("Very little text came back. The page is probably rendered by JavaScript, which this engine does not run.");
  return {
    result: { summary: `${r.title ?? r.finalUrl} (local fetch, ${r.status} ${r.statusText})`, content: r.text, links: r.rawHtml ? extractLinks(r.rawHtml, r.finalUrl) : [], uncertainty, warnings },
    meta: { durationSeconds: (Date.now() - startedAt) / 1000, usage: { bytes: r.meta.bytes, redirects: r.meta.redirectChain.length } },
  };
}

const local = {
  name: "local",
  roles: ["fetch"],
  requirement: "nothing, it always works",
  isAvailable: () => true,
  execute: localFetch,
};

// ───────── 注册表 ─────────

const ENGINES = { firecrawl, keenable, youcom, tavily, exa, local };
const ALIASES = { http: "local", direct: "local" };

function findEngine(name) {
  const key = String(name || "").trim().toLowerCase();
  const canon = Object.hasOwn(ALIASES, key) ? ALIASES[key] : key;
  return Object.hasOwn(ENGINES, canon) ? ENGINES[canon] : undefined;
}
const allEngines = () => Object.values(ENGINES);
const listEngines = () => allEngines().map(e => e.name);
const enginesForRole = role => allEngines().filter(e => e.roles.includes(role));
const canonicalEngineName = name => {
  const e = findEngine(name);
  return e ? e.name : String(name || "").trim().toLowerCase();
};

/**
 * 每个角色的引擎优先级，最好的在前，再按可用性过滤。
 * Firecrawl 打头：它的匿名额度在什么都没配的机器上也能用；Keenable 是第二个匿名引擎；You.com 是最小的第三个匿名池；
 * Tavily、Exa 是要 key 的备用。抓取以 local 兜底。
 */
const ROLE_PREFERENCE = {
  search: ["firecrawl", "keenable", "youcom", "tavily", "exa"],
  fetch: ["firecrawl", "keenable", "local"],
  social: [],
};
const FETCH_FLOOR = "local";

module.exports = {
  ApiKeyFailureError,
  MAX_DOCUMENT_CHARS,
  ROLE_PREFERENCE,
  FETCH_FLOOR,
  allEngines,
  canonicalEngineName,
  enginesForRole,
  findEngine,
  listEngines,
  redactSecrets,
  splitApiKeys,
  isApiKeyFailure: e => e instanceof ApiKeyFailureError,
  looksLikeClientRenderedShell,
};
