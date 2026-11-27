"use strict";
/**
 * 成员用的模型调用：按 M-Harness 的规则请求 OpenAI 兼容的 /chat/completions，或 Anthropic 的 /v1/messages。
 * 提供方从 M-Harness 的 harness.config.json 里读（type 为 openai-compat / anthropic 的能用，cli / cursor-sdk 不行），
 * 也可以在插件设置里写死一条路由（协议按地址判断）。key 只用来发请求，不会返回给界面，错误信息里会把它抹掉。
 * 对外统一成 OpenAI 的消息 / 工具格式，Anthropic 的转换都在这个文件里。
 */
const { harnessConfig, harnessHome } = require("./rpc.cjs");

const expandEnv = v => (typeof v === "string" ? v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, k) => process.env[k] ?? "") : "");
const USABLE = new Set(["openai-compat", "anthropic"]);

// ───────── 地址识别（和 M-Harness 的 endpoint.ts 同一套规则） ─────────

/** 去掉粘贴时多带的接口路径、查询串和结尾斜杠 */
function cleanBase(raw) {
  let s = String(raw ?? "").trim();
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  s = s.replace(/\/(v1\/)?(chat\/completions|messages|models|completions)$/i, (_, v) => (v ? "/v1" : ""));
  return s.replace(/\/+$/, "");
}

/** 只在地址能明确判断协议时返回 */
function detectProtocol(baseURL) {
  let u;
  try {
    u = new URL(cleanBase(baseURL));
  } catch {
    return undefined;
  }
  const segs = u.pathname.toLowerCase().split("/").filter(Boolean);
  if (/^api\.anthropic\.com$/i.test(u.hostname) || segs.includes("anthropic")) return "anthropic";
  if (segs.includes("paas") || segs.includes("compatible-mode") || segs[segs.length - 1] === "openai") return "openai-compat";
  return undefined;
}

function normalizeEndpoint(type, baseURL) {
  const want = type === "anthropic" ? "anthropic" : "openai-compat";
  let base = cleanBase(baseURL);
  const real = base ? detectProtocol(base) ?? want : want;
  if (real === "anthropic") {
    if (!base) base = "https://api.anthropic.com";
    base = base.replace(/\/v1$/i, "");
  } else if (!base) base = "";
  return { protocol: real, baseURL: base };
}

// ───────── 提供方 ─────────

function providers() {
  const cfg = harnessConfig(harnessHome());
  const out = [];
  for (const [name, p] of Object.entries(cfg.providers || {})) {
    if (!p || !USABLE.has(p.type)) continue;
    const ep = normalizeEndpoint(p.type, expandEnv(p.baseURL));
    if (!ep.baseURL) continue;
    out.push({
      name,
      protocol: ep.protocol,
      baseURL: ep.baseURL,
      apiKey: expandEnv(p.apiKey).trim(),
      model: String(expandEnv(p.model) || "").trim(),
      temperature: typeof p.temperature === "number" ? p.temperature : undefined,
      extraBody: p.extraBody && typeof p.extraBody === "object" ? p.extraBody : undefined,
      maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : undefined,
    });
  }
  return { list: out, defaultName: cfg.defaultProvider };
}

/** M-Harness 配置里的全部提供方（含 cursor-sdk / 命令行 Agent），带「成员能不能用、为什么不能、key 缺在哪」 */
function describeProviders() {
  const cfg = harnessConfig(harnessHome());
  const items = [];
  for (const [name, p] of Object.entries(cfg.providers || {})) {
    if (!p) continue;
    const env = (/\$\{([A-Z0-9_]+)\}/i.exec(String(p.apiKey || "")) || [])[1] || "";
    const apiKey = expandEnv(p.apiKey).trim();
    const it = { name, type: String(p.type || ""), model: String(expandEnv(p.model) || p.preset || "").trim(), usable: false, reason: "", hasKey: !!apiKey, keyEnv: !apiKey ? env : "", baseURL: "", protocol: "" };
    if (USABLE.has(p.type)) {
      const ep = normalizeEndpoint(p.type, expandEnv(p.baseURL));
      it.baseURL = ep.baseURL;
      it.protocol = ep.protocol;
      if (ep.baseURL) it.usable = true;
      else it.reason = "没有 baseURL";
    } else if (p.type === "cursor-sdk") it.reason = "Cursor 自带一套工具循环，不是模型接口，成员（插件自己跑的模型循环）没法用它";
    else if (p.type === "cli") it.reason = "命令行 Agent 不是模型接口，成员没法用它";
    else it.reason = "这种提供方成员用不了";
    items.push(it);
  }
  return { items, defaultName: cfg.defaultProvider || "" };
}

/**
 * 找一条能用的路由。优先级：成员自己指定的 provider / model > 插件设置里写死的路由 > 插件设置里选的提供方 > M-Harness 的默认提供方 > 第一个能用的。
 * 不能用的提供方（cursor-sdk、命令行 Agent）不会被选中。
 */
function resolveRoute(settings, want = {}) {
  const { list, defaultName } = providers();
  const fixed = settings?.route && settings.route.baseURL ? settings.route : null;
  let base;
  if (want.provider) {
    base = list.find(p => p.name === want.provider);
    if (!base) throw new Error(`成员指定的提供方「${want.provider}」不可用：只支持 M-Harness 里 type 为 openai-compat / anthropic 的提供方（cursor-sdk / 命令行 Agent 不行）`);
  } else if (fixed) {
    const ep = normalizeEndpoint(fixed.type, String(fixed.baseURL));
    base = { name: fixed.provider || "custom", protocol: ep.protocol, baseURL: ep.baseURL, apiKey: String(fixed.apiKey || ""), model: String(fixed.model || "") };
  } else if (settings?.provider && list.some(p => p.name === settings.provider)) {
    base = list.find(p => p.name === settings.provider);
  } else {
    base = list.find(p => p.name === defaultName && p.apiKey) || list.find(p => p.apiKey) || list.find(p => p.name === defaultName) || list[0];
  }
  if (!base) throw new Error("没有可用的模型提供方：成员需要 M-Harness 里 type 为 openai-compat / anthropic 的提供方（cursor-sdk / 命令行 Agent 不行），或在插件设置里填一条路由");
  const model = want.model || base.model || fixed?.model;
  if (!model) throw new Error(`提供方「${base.name}」没有配置模型名，请在成员里指定 model`);
  if (!base.baseURL) throw new Error(`提供方「${base.name}」没有 baseURL`);
  if (!base.apiKey) throw new Error(`提供方「${base.name}」没有可用的 key（配置里的环境变量没解出来？可以在插件设置里直接填）`);
  return {
    provider: base.name,
    protocol: base.protocol || "openai-compat",
    model,
    baseURL: base.baseURL,
    apiKey: base.apiKey,
    temperature: base.temperature,
    extraBody: base.extraBody,
    maxTokens: base.maxTokens,
  };
}

// ───────── 请求 ─────────

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("已取消"));
    }, { once: true });
  });

const safeJson = s => {
  try {
    const v = s ? JSON.parse(s) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

/** OpenAI 格式的消息 → Anthropic（system 单独放；连续同角色合并；tool 结果并进 user） */
function toAnthropic(messages, tools) {
  const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ type: "text", text: String(m.content ?? "") }]);
    else if (m.role === "assistant") {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: String(m.content) });
      for (const c of m.tool_calls || []) blocks.push({ type: "tool_use", id: c.id, name: c.function?.name, input: safeJson(c.function?.arguments) });
      if (blocks.length) push("assistant", blocks);
    } else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content ?? "") }]);
  }
  return {
    system,
    messages: out,
    tools: (tools || []).map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters || { type: "object", properties: {} } })),
  };
}

function buildRequest(route, messages, tools) {
  if (route.protocol === "anthropic") {
    const a = toAnthropic(messages, tools);
    const official = /^https?:\/\/api\.anthropic\.com$/i.test(route.baseURL);
    const body = { model: route.model, max_tokens: route.maxTokens || 4096, messages: a.messages };
    if (a.system) body.system = a.system;
    if (a.tools.length) body.tools = a.tools;
    if (route.temperature !== undefined) body.temperature = route.temperature;
    return {
      url: `${route.baseURL}/v1/messages`,
      // 官方只认 x-api-key；各家的 Anthropic 兼容地址有的认 x-api-key、有的认 Bearer，两个都带
      headers: { "content-type": "application/json", "x-api-key": route.apiKey, "anthropic-version": "2023-06-01", ...(official ? {} : { authorization: `Bearer ${route.apiKey}` }) },
      body,
    };
  }
  const body = { ...(route.extraBody || {}), model: route.model, messages };
  if (route.temperature !== undefined) body.temperature = route.temperature;
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return { url: `${route.baseURL}/chat/completions`, headers: { "content-type": "application/json", authorization: `Bearer ${route.apiKey}` }, body };
}

function parseReply(route, j) {
  if (route.protocol === "anthropic") {
    const blocks = Array.isArray(j.content) ? j.content : [];
    const text = blocks.filter(b => b.type === "text").map(b => b.text).join("");
    const calls = blocks.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    if (!blocks.length) throw new Error("模型接口没有返回 content");
    const message = { role: "assistant", content: text || null };
    if (calls.length) message.tool_calls = calls;
    return { message, usage: { input: j.usage?.input_tokens || 0, output: j.usage?.output_tokens || 0 } };
  }
  const msg = j.choices?.[0]?.message;
  if (!msg) throw new Error("模型接口没有返回 message");
  return { message: msg, usage: { input: j.usage?.prompt_tokens || 0, output: j.usage?.completion_tokens || 0 } };
}

/** 一次对话：messages 是 OpenAI 格式，tools 是 [{type:"function",function:{...}}]。返回 { message(OpenAI 格式), usage } */
async function chat({ route, messages, tools, signal, timeoutMs = 180000, retryDelays = [1000, 3000] }) {
  const redact = s => String(s).split(route.apiKey).join("***");
  const req = buildRequest(route, messages, tools);
  let lastErr;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    if (signal?.aborted) throw new Error("已取消");
    try {
      const res = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = redact((await res.text().catch(() => "")).slice(0, 300));
        const err = new Error(`模型接口返回 HTTP ${res.status}：${text}`);
        err.retry = res.status === 429 || res.status >= 500;
        throw err;
      }
      return parseReply(route, await res.json());
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw new Error("已取消");
      const retry = e.retry ?? /fetch failed|ECONNRESET|ETIMEDOUT|timeout/i.test(String(e.message));
      if (!retry || attempt >= retryDelays.length) break;
      await sleep(retryDelays[attempt], signal);
    }
  }
  throw new Error(redact(lastErr?.message || String(lastErr)));
}

module.exports = { providers, describeProviders, resolveRoute, chat, cleanBase, detectProtocol, normalizeEndpoint, toAnthropic };
