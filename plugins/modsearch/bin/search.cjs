"use strict";
/**
 * 路由 + 故障转移 + 配额冷却 + 页面窗口。移植自 liustack/modsearch（MIT）的 router.ts、cooldown.ts、search.ts。
 * 选哪个引擎、按什么顺序、哪把 key，全部在这里决定，别处不挑引擎。
 */
const fs = require("node:fs");
const path = require("node:path");
const E = require("./engines.cjs");
const { canonicalEngineName, splitApiKeys, redactSecrets, isApiKeyFailure } = E;

const ENV_KEYS = { firecrawl: "FIRECRAWL_API_KEY", keenable: "KEENABLE_API_KEY", tavily: "TAVILY_API_KEY", exa: "EXA_API_KEY" };
const MAX_CONTENT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;

// ───────── 配置 ─────────

/** 一个引擎的有效设置：设置里的值优先，没填 key 就退回环境变量 */
function engineSettings(name, config, env = process.env) {
  const own = (config.engines && config.engines[canonicalEngineName(name)]) || {};
  const s = { ...own };
  if (!splitApiKeys(s.apiKey).length) {
    const v = ENV_KEYS[canonicalEngineName(name)] && env[ENV_KEYS[canonicalEngineName(name)]];
    if (v && String(v).trim()) s.apiKey = String(v).trim();
  }
  return s;
}

const cooldownEnabled = config => config.cooldown !== false;

/** 某个角色首选的引擎。抓取先看 fetchEngine，再看 engine（那个引擎能抓才算） */
function preferredEngine(config, role) {
  const pick = (v, field) => (typeof v === "string" && v.trim() ? { name: v.trim(), field } : null);
  if (role === "fetch") return pick(config.fetchEngine, "fetchEngine") || pick(config.engine, "engine");
  if (role === "search") return pick(config.engine, "engine");
  return null;
}

// ───────── 冷却状态 ─────────

const DEFAULT_COOLDOWN_MS = 45 * 60 * 1000;
const MONTHLY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const KEY_SUFFIX = /^(.*)::key:(\d+)$/;

const stateKey = (engine, keyIndex) => (keyIndex === undefined ? canonicalEngineName(engine) : `${canonicalEngineName(engine)}::key:${keyIndex}`);

function parseStateKey(k) {
  const m = KEY_SUFFIX.exec(k);
  return m ? { engine: canonicalEngineName(m[1]), keyIndex: Number.parseInt(m[2], 10) } : { engine: canonicalEngineName(k) };
}

const emptyState = () => ({ engineCooldowns: {} });

function laterEntry(existing, incoming) {
  if (!existing) return incoming;
  const a = Date.parse(existing.until);
  const b = Date.parse(incoming.until);
  return Number.isFinite(a) && a > b ? existing : incoming;
}

function loadState(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, "utf8");
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.engineCooldowns !== "object" || !parsed.engineCooldowns) return emptyState();
    const clean = {};
    for (const [k, e] of Object.entries(parsed.engineCooldowns)) {
      if (e && typeof e === "object" && typeof e.until === "string") {
        const t = parseStateKey(k);
        const key = stateKey(t.engine, t.keyIndex);
        const n = { until: e.until, reason: typeof e.reason === "string" ? e.reason : "", observedAt: typeof e.observedAt === "string" ? e.observedAt : "" };
        clean[key] = clean[key] ? laterEntry(clean[key], n) : n;
      }
    }
    return { engineCooldowns: clean };
  } catch {
    return emptyState();
  }
}

/** 读最新的磁盘状态、套上改动、临时文件 + 改名写回，并发写不会互相覆盖 */
function updateOnDisk(statePath, mutate) {
  const merged = loadState(statePath);
  const before = JSON.stringify(merged);
  mutate(merged);
  if (JSON.stringify(merged) === before) return merged;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = path.join(path.dirname(statePath), `.state.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
  fs.renameSync(tmp, statePath);
  return merged;
}

function coolingEntry(state, engine, now, keyIndex) {
  const active = k => {
    const e = state.engineCooldowns[k];
    if (!e) return undefined;
    const until = Date.parse(e.until);
    return Number.isFinite(until) && until > now.getTime() ? e : undefined;
  };
  const e = active(stateKey(engine, keyIndex));
  if (e || keyIndex === undefined) return e;
  return active(stateKey(engine)); // 没按 key 分之前写的状态对所有 key 生效
}

/** 配置的全部 key 都在冷却时，返回代表性的那条 */
function coolingEngineEntry(state, engine, keyCount, now) {
  if (keyCount <= 0) return coolingEntry(state, engine, now);
  let rep;
  for (let i = 0; i < keyCount; i += 1) {
    const e = coolingEntry(state, engine, now, i);
    if (!e) return undefined;
    rep = laterEntry(rep, e);
  }
  return rep;
}

function parseResetDuration(message) {
  const m = /Resets? in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i.exec(message);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000;
}

/** 值得记住的是配额类失败。每秒级的限流是瞬时的，返回 null，不碰状态 */
function classifyQuota(error, now) {
  const message = error instanceof Error ? error.message : String(error);
  const looksRateLimited = /rate.?limit|too many requests|\b429\b/i.test(message);
  const monthly = /\bhttp 43[23]\b/i.test(message);
  const looksQuota = monthly || /quota|out of credit|insufficient (?:balance|credit)|credits? (?:exhausted|used up)|balance|Resets? in/i.test(message);
  if (!looksQuota || (looksRateLimited && !looksQuota)) return null;
  const reset = parseResetDuration(message);
  return new Date(now.getTime() + (reset ?? (monthly ? MONTHLY_COOLDOWN_MS : DEFAULT_COOLDOWN_MS)));
}

function buildCooldown(config, statePath, now = new Date()) {
  if (!cooldownEnabled(config)) return undefined;
  const state = loadState(statePath);
  const warnings = [];
  const persistNote = e => warnings.push(`Cooldown state could not be saved (${e instanceof Error ? e.message : String(e)}); failover still works, but the next run will rediscover this quota wall.`);
  return {
    state,
    now,
    warnings,
    record(engine, error, keyIndex) {
      const until = classifyQuota(error, now);
      if (!until) return null;
      // 先遮再截断：切口落在密钥中间会让精确匹配漏掉它
      const reason = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300);
      const entry = { until: until.toISOString(), reason, observedAt: now.toISOString() };
      const key = stateKey(engine, keyIndex);
      try {
        const merged = updateOnDisk(statePath, d => {
          d.engineCooldowns[key] = laterEntry(d.engineCooldowns[key], entry);
        });
        state.engineCooldowns[key] = merged.engineCooldowns[key];
        return merged.engineCooldowns[key];
      } catch (e) {
        state.engineCooldowns[key] = entry;
        persistNote(e);
        return entry;
      }
    },
    clear(engine, keyIndex) {
      const keys = keyIndex === undefined ? [stateKey(engine)] : [stateKey(engine, keyIndex), stateKey(engine)];
      for (const k of keys) delete state.engineCooldowns[k];
      try {
        updateOnDisk(statePath, d => {
          for (const k of keys) delete d.engineCooldowns[k];
        });
      } catch (e) {
        persistNote(e);
      }
    },
  };
}

// ───────── 路由 ─────────

const X_PATTERNS = [/twitter/i, /\btweets?\b/i, /\btweeted\b/i, /\bx\.com\b/i, /\bon\s+x\b/i, /\bx\s+(?:post|posts|thread|threads|user|users|search|reply|replies|timeline)\b/i, /推特/, /推文/, /发推/, /在\s*[Xx]\s*上/, /[Xx]\s*(?:平台|帖子)/];
const isXQuery = q => {
  const t = String(q || "").trim();
  return t.length > 0 && X_PATTERNS.some(p => p.test(t));
};
const X_DEGRADE_NOTE = "X itself was not reachable here (this plugin has no X-capable engine), so this came from the public web, which cannot see inside X.";
const SOURCE_ROLE = { web: "search", x: "social" };

/**
 * 一个角色的引擎链。显式 engine 是硬指定：链里只有它，不追加别的引擎，也没有 local 兜底，做不了就明说失败；
 * 设置里的 engine 只是偏好，后面还跟着角色默认顺序和抓取兜底。
 */
function planRole(role, config, requestedEngine, env, cooldown) {
  const notes = [];
  const settingsFor = n => engineSettings(n, config, env);
  const enabled = e => settingsFor(e.name).enabled !== false;
  const usable = e => e.isAvailable(settingsFor(e.name), env, role);
  const chain = [];
  const add = e => {
    if (e && !chain.includes(e)) chain.push(e);
  };

  const explicit = String(requestedEngine || "").trim();
  if (explicit) {
    const e = E.findEngine(explicit);
    if (!e) notes.push(`Unknown engine "${explicit}". Drop the engine argument to let modsearch pick one that works, or name a known engine: ${E.listEngines().join(", ")}.`);
    else if (!e.roles.includes(role)) notes.push(`The ${e.name} engine cannot ${role} (an explicit engine is forced with no fallback). Drop the engine argument to let modsearch pick one that can. ${e.name} handles: ${e.roles.join(", ")}.`);
    else add(e);
    return { chain, notes };
  }

  const pref = preferredEngine(config, role);
  if (pref) {
    const e = E.findEngine(pref.name);
    if (!e) notes.push(`Unknown engine "${pref.name}" (${pref.field} in the settings), so modsearch chose one that works.`);
    else if (pref.field === "fetchEngine" && !e.roles.includes(role)) notes.push(`The configured fetchEngine ${e.name} cannot fetch pages, so modsearch chose one that can.`);
    else if (e.roles.includes(role)) {
      if (!enabled(e)) notes.push(`The configured ${e.name} preference is disabled by its enabled switch, so modsearch skipped it.`);
      else add(e); // 用户自己的选择：缺 key 时要大声失败，而不是悄悄跳过
    }
  }
  for (const name of E.ROLE_PREFERENCE[role]) {
    const e = E.findEngine(name);
    if (enabled(e) && usable(e)) add(e);
  }
  if (role === "fetch") {
    const floor = E.findEngine(E.FETCH_FLOOR);
    if (enabled(floor)) add(floor);
  }

  // 冷却只重排：在冷却的引擎挪到后面，但仍在链里，别的都失败时还会走到它
  if (cooldown) {
    const active = [];
    const cooling = [];
    for (const e of chain) {
      const keyCount = splitApiKeys(settingsFor(e.name).apiKey).length;
      const entry = coolingEngineEntry(cooldown.state, e.name, keyCount, cooldown.now);
      if (entry) {
        cooling.push(e);
        const reason = entry.reason.split("\n")[0].slice(0, 140);
        notes.push(`The ${e.name} engine is cooling until ${entry.until}, so it moves to the back of the fallback chain.${reason ? ` Reason: ${reason}` : ""}`);
      } else active.push(e);
    }
    return { chain: [...active, ...cooling], notes };
  }
  return { chain, notes };
}

function planRun({ mode, query, config, requestedEngine, sources, env, cooldown }) {
  if (mode === "fetch") {
    const { chain, notes } = planRole("fetch", config, requestedEngine, env, cooldown);
    return [{ source: "web", engine: chain[0], fallbacks: chain.slice(1), notes }];
  }
  const list = sources || [isXQuery(query) ? "x" : "web"];
  const webRequested = list.includes("web");
  return list.flatMap(source => {
    const { chain, notes } = planRole(SOURCE_ROLE[source], config, requestedEngine, env, cooldown);
    if (source === "x") {
      // 没有任何 X 引擎：退到网页搜索，并明说它是二手证据
      const web = planRole("search", config, requestedEngine, env, cooldown);
      const social = chain.filter(e => e.roles.includes("social"));
      if (social.length === 0) {
        if (webRequested) return [{ source: "x", fallbacks: [], notes: [...notes, X_DEGRADE_NOTE], unavailable: true }];
        return [{ source: "x", engine: web.chain[0], fallbacks: web.chain.slice(1), notes: [...notes, X_DEGRADE_NOTE] }];
      }
      return [{ source: "x", engine: social[0], fallbacks: [...social.slice(1), ...web.chain], degradeNote: X_DEGRADE_NOTE, notes }];
    }
    return [{ source, engine: chain[0], fallbacks: chain.slice(1), notes }];
  });
}

// ───────── 运行 ─────────

class SourceRunError extends Error {
  constructor(message, attempts) {
    super(message);
    this.name = "SourceRunError";
    this.attempts = attempts;
  }
}

function noEngineMessage(role) {
  const options = E.allEngines().filter(e => e.roles.includes(role)).map(e => `  - ${e.name}: ${e.requirement}`).join("\n");
  const job = role === "fetch" ? "fetch a page" : role === "social" ? "search X" : "search the web";
  return `No engine on this machine can ${job}. Any one of these enables it:\n${options}`;
}

function engineSpend(usage) {
  const s = {};
  if (usage && typeof usage.costDollars === "number") s.cost = usage.costDollars;
  if (usage && typeof usage.creditsUsed === "number") s.credits = usage.creditsUsed;
  return s;
}

function contentWindow(content, startIndex = 0, maxLength = MAX_CONTENT_CHARS) {
  const total = content.length;
  if (startIndex >= total && total > 0) return { content: "", range: { start: total, end: total, total }, note: `start_index ${startIndex} is past the end of the page, which has ${total} characters.` };
  const start = Math.min(startIndex, total);
  const end = Math.min(total, start + maxLength);
  return { content: content.slice(start, end), range: { start, end, total }, ...(end < total ? { note: `Showing characters ${start} to ${end} of ${total}. Run again with start_index ${end} to read on.` } : {}) };
}

/** 一次尝试的预算：引擎自己的超时，且不超过整次运行剩下的时间；预算用完返回 null */
function attemptBudget(timeoutMs, deadline) {
  if (!deadline) return { engineTimeoutMs: timeoutMs, killAfterMs: timeoutMs + 30_000 };
  const remaining = Math.floor(deadline.at - Date.now());
  if (remaining <= 0) return null;
  return { engineTimeoutMs: Math.min(timeoutMs, remaining), killAfterMs: Math.min(timeoutMs + 5_000, remaining) };
}

async function withinTime(name, work, ms) {
  let timer;
  const overrun = new Promise((_r, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} engine timed out after ${ms} ms.`)), ms);
  });
  try {
    return await Promise.race([work, overrun]);
  } finally {
    clearTimeout(timer);
  }
}

async function runOneSource(plan, ctx) {
  const { mode, query, url, timeoutMs, deadline, config, env, options } = ctx;
  if (plan.unavailable) {
    return { source: plan.source, requestedSource: plan.source, engine: null, status: "unavailable", summary: "", items: [], uncertainty: [], warnings: plan.notes, attempts: [], durationSeconds: null };
  }
  const candidates = [plan.engine, ...plan.fallbacks].filter(Boolean);
  if (candidates.length === 0) {
    const base = noEngineMessage(SOURCE_ROLE[plan.source] === "social" ? "social" : mode);
    throw new SourceRunError(plan.notes.length ? `${plan.notes.join(" ")}\n${base}` : base, []);
  }

  const controller = options.cooldown;
  const failures = [];
  const attempts = [];
  const allowPrivateNetwork = options.allowPrivateNetwork === true || config.allowPrivateNetwork === true;
  const cooldownNotes = [];

  for (const engine of candidates) {
    const failuresBefore = failures.length;
    const settings = engineSettings(engine.name, config, env);
    const apiKeys = splitApiKeys(settings.apiKey);
    const configured = apiKeys.length ? apiKeys.map((apiKey, keyIndex) => ({ apiKey, keyIndex })) : [{ apiKey: undefined, keyIndex: undefined }];
    // 没在冷却的 key 先用，冷却中的排后面
    const keyRuns = controller
      ? [...configured.filter(r => r.keyIndex === undefined || !coolingEntry(controller.state, engine.name, controller.now, r.keyIndex)), ...configured.filter(r => r.keyIndex !== undefined && coolingEntry(controller.state, engine.name, controller.now, r.keyIndex))]
      : configured;

    let output;
    let startedOk = 0;
    let okKeyIndex;
    for (let i = 0; i < keyRuns.length; i += 1) {
      const run = keyRuns[i];
      const budget = attemptBudget(timeoutMs, deadline);
      if (!budget) {
        const message = `skipped: the run deadline of ${deadline && deadline.ms} ms was used up before it could start.`;
        failures.push(`${engine.name}: ${message}`);
        attempts.push({ engine: engine.name, ok: false, error: message, durationSeconds: null });
        break;
      }
      const startedAt = Date.now();
      try {
        output = await withinTime(engine.name, engine.execute({ mode, query, url, maxResults: options.maxResults, extraPrompt: options.prompt, timeoutMs: budget.engineTimeoutMs, settings: { ...settings, apiKey: run.apiKey }, apiKeySecrets: apiKeys, allowPrivateNetwork }), budget.killAfterMs);
        startedOk = startedAt;
        okKeyIndex = run.keyIndex;
        break;
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error), apiKeys);
        const keyLabel = apiKeys.length > 1 ? ` (API key ${Number(run.keyIndex) + 1})` : "";
        failures.push(`${engine.name}${keyLabel}: ${message}`);
        attempts.push({ engine: engine.name, ...(apiKeys.length > 1 ? { keyIndex: run.keyIndex } : {}), ok: false, error: message, durationSeconds: (Date.now() - startedAt) / 1000 });
        if (controller) {
          const entry = controller.record(engine.name, error, run.keyIndex);
          if (entry) cooldownNotes.push(`The ${engine.name} engine${run.keyIndex === undefined ? "" : ` API key ${run.keyIndex + 1}`} hit a lasting limit (quota or region) and is now cooling until ${entry.until}.`);
        }
        if (i + 1 < keyRuns.length && isApiKeyFailure(error)) continue;
        break;
      }
    }
    if (!output) continue;

    const durationSeconds = (Date.now() - startedOk) / 1000;
    attempts.push({ engine: engine.name, ...(apiKeys.length > 1 ? { keyIndex: okKeyIndex } : {}), ok: true, durationSeconds, ...engineSpend(output.meta && output.meta.usage) });
    if (controller) controller.clear(engine.name, okKeyIndex);

    const warnings = [...plan.notes, ...cooldownNotes, ...(controller ? controller.warnings : [])];
    if (failures.length > 0) {
      const rotated = failuresBefore === 0 && okKeyIndex !== undefined;
      warnings.push(rotated ? `Rotated to ${engine.name} API key ${okKeyIndex + 1} after: ${failures.join(" | ")}` : `Fell back to ${engine.name} after: ${failures.join(" | ")}`);
      if (plan.degradeNote && !engine.roles.includes("social")) warnings.push(plan.degradeNote);
    }

    const requestedSource = plan.source;
    let actualSource = plan.source;
    let status = "ok";
    if (plan.source === "x" && !engine.roles.includes("social")) {
      actualSource = "web";
      status = "degraded";
    }

    const body = output.result && typeof output.result === "object" ? { ...output.result } : { result: output.result };
    const engineWarnings = Array.isArray(body.warnings) ? body.warnings.filter(l => typeof l === "string") : [];
    // 路由事实和 warnings / attempts 通道由这里盖章，引擎同名的键一律丢掉，防止它改写谁回答了或伪造路由警告
    for (const k of ["source", "requestedSource", "engine", "model", "status", "durationSeconds", "warnings", "attempts", "contentRange"]) delete body[k];

    const windowWarnings = [];
    if (mode === "fetch" && typeof body.content === "string") {
      const w = contentWindow(body.content, options.startIndex, options.maxLength);
      body.content = w.content;
      body.contentRange = w.range;
      if (w.note) windowWarnings.push(w.note);
    }
    return { ...body, source: actualSource, requestedSource, engine: engine.name, status, warnings: [...warnings, ...engineWarnings, ...windowWarnings], attempts, durationSeconds };
  }
  throw new SourceRunError(`Every engine for the ${plan.source} source failed.\n${failures.map(l => `  - ${l}`).join("\n")}`, attempts);
}

/**
 * options: { query?, url?, engine?, sources?: ["web"|"x"], timeoutMs?, deadlineMs?, maxResults?, prompt?, startIndex?, maxLength?,
 *            allowPrivateNetwork?, config, env?, statePath? }
 */
async function runSearch(options) {
  const startedAt = Date.now();
  const query = (options.query || "").trim() || undefined;
  const url = (options.url || "").trim() || undefined;
  if (url && !/^https?:\/\//i.test(url)) throw new Error(`Fetch URL must start with http:// or https://, got: ${url}`);
  if (!query && !url) throw new Error("Provide a search query or a URL to fetch.");
  const mode = url ? "fetch" : "search";
  const config = options.config || {};
  const env = options.env || process.env;
  const cooldown = options.statePath ? buildCooldown(config, options.statePath) : undefined;
  const plans = planRun({ mode, query, config, requestedEngine: options.engine, sources: options.sources, env, cooldown });
  const deadline = options.deadlineMs === undefined ? undefined : { at: startedAt + options.deadlineMs, ms: options.deadlineMs };
  const ctx = { mode, query, url, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, deadline, config, env, options: { ...options, cooldown } };
  const results = await Promise.all(
    plans.map(plan =>
      runOneSource(plan, ctx).catch(error => {
        if (plans.length === 1) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return { source: plan.source, requestedSource: plan.source, engine: null, status: "unavailable", summary: "", items: [], uncertainty: [], warnings: [message], attempts: error instanceof SourceRunError ? error.attempts : [], durationSeconds: null };
      }),
    ),
  );
  return { mode, query: query ?? null, url: url ?? null, results, meta: { generatedAt: new Date().toISOString(), durationSeconds: (Date.now() - startedAt) / 1000 } };
}

module.exports = { runSearch, planRole, planRun, engineSettings, loadState, coolingEngineEntry, classifyQuota, isXQuery, MAX_CONTENT_CHARS, DEFAULT_TIMEOUT_MS };
