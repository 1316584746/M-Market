"use strict";
/**
 * 上下文洞察：读 M-Harness 的 trace（<家目录>/.traces/*.jsonl），统计每次运行的 token 走势、
 * 上下文构成（system / user / assistant / tool）、压缩事件和各工具的输出体量。
 * 只读，不改任何文件。这里是为 M-Harness 的 trace 格式编写的精简版。
 */
const fs = require("node:fs");
const path = require("node:path");
const { serve, settings, harnessHome, harnessConfig } = require("./rpc.cjs");

const ID = "context-insight";
const VERSION = require("../manifest.json").version;
const MAX_FILE = 192 * 1024 * 1024;
const store = settings();
const { createInsight } = require("./insight.cjs");

// ───────── 估算 ─────────

const CJK = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/g;
/** 粗估 token：中日韩字符约 1 个字 1 个 token，其余约 4 个字符 1 个 token（和 M-Harness 自己的粗估同一量级） */
function est(s) {
  if (!s) return 0;
  const str = String(s);
  const cjk = (str.match(CJK) || []).length;
  return cjk + Math.ceil((str.length - cjk) / 4);
}
const msgTokens = m => est(m.content) + (Array.isArray(m.toolCalls) ? est(JSON.stringify(m.toolCalls)) : 0) + 4;

// ───────── trace 位置 ─────────

function traceDirs() {
  const home = harnessHome();
  const cfg = harnessConfig(home);
  const out = [];
  const add = (p, why) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!out.some(x => x.dir === abs)) out.push({ dir: abs, why, exists: fs.existsSync(abs) });
  };
  const s = store.get();
  if (s.traceDir) add(s.traceDir, "手动指定");
  if (typeof cfg.traceDir === "string") add(path.resolve(home, cfg.traceDir), "harness.config.json 的 traceDir");
  add(path.join(home, ".traces"), "家目录下的 .traces");
  if (typeof cfg.workspace === "string") add(path.join(path.resolve(home, cfg.workspace), ".traces"), "工作区下的 .traces");
  return { home, dirs: out, active: (out.find(x => x.exists) || out[0] || {}).dir || "" };
}

const safeName = n => /^[A-Za-z0-9._-]+$/.test(n) && !n.includes("..");

function fileOf(name) {
  const { active } = traceDirs();
  if (!active) throw new Error("没有找到 trace 目录");
  const n = String(name || "").replace(/\.jsonl$/, "");
  if (!safeName(n)) throw new Error("trace 名字不合法");
  const f = path.join(active, `${n}.jsonl`);
  if (!fs.existsSync(f)) throw new Error("找不到这个 trace");
  return f;
}

function readLines(file) {
  const st = fs.statSync(file);
  if (st.size > MAX_FILE) throw new Error(`trace 文件太大（${Math.round(st.size / 1048576)} MB），已跳过`);
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

// ───────── 列表（轻量：不解析 model_call 的大行） ─────────

function summarize(file) {
  const st = fs.statSync(file);
  const sum = { name: path.basename(file, ".jsonl"), mtime: st.mtimeMs, size: st.size, provider: "", input: "", reason: "", steps: 0, tokens: 0, trims: 0, tools: 0 };
  let lines;
  try {
    lines = readLines(file);
  } catch (e) {
    sum.error = e.message;
    return sum;
  }
  for (const l of lines) {
    if (l.includes('"type":"model_call"')) continue;
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    const e = j.event || {};
    if (e.type === "run_start") {
      sum.provider = e.provider || "";
      sum.input = String(e.input || "").slice(0, 160);
      sum.startedAt = j.ts;
    } else if (e.type === "model_reply") {
      sum.steps++;
      sum.tokens += e.reply?.usage?.total ?? e.tokens ?? 0;
    } else if (e.type === "context_trim") sum.trims++;
    else if (e.type === "tool_call") sum.tools++;
    else if (e.type === "agent_progress" && e.kind === "tool" && String(e.line || "").trim().startsWith("🔧")) sum.tools++;
    else if (e.type === "done") sum.reason = e.reason || "";
  }
  return sum;
}

function listRuns(limit = 60) {
  const { active } = traceDirs();
  if (!active || !fs.existsSync(active)) return [];
  return fs
    .readdirSync(active)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => ({ f, m: fs.statSync(path.join(active, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, Math.max(1, Math.min(limit, 300)))
    .map(x => summarize(path.join(active, x.f)));
}

// ───────── 单次运行的完整分析 ─────────

function analyze(file) {
  const lines = readLines(file);
  const run = { name: path.basename(file, ".jsonl"), provider: "", input: "", reason: "", error: "", startedAt: 0, endedAt: 0, steps: [], trims: [], tools: [], totals: {} };
  const steps = new Map();
  const tools = new Map();
  const outs = [];
  let cur = 0;
  const stepOf = n => {
    if (!steps.has(n)) steps.set(n, { step: n, promptTokens: 0, promptEstimated: true, outputTokens: 0, totalTokens: 0, ms: 0, msgCount: 0, comp: { system: 0, user: 0, assistant: 0, tool: 0 } });
    return steps.get(n);
  };
  for (const l of lines) {
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    const e = j.event || {};
    run.startedAt ||= j.ts;
    run.endedAt = j.ts || run.endedAt;
    switch (e.type) {
      case "run_start":
        run.provider = e.provider || "";
        run.input = String(e.input || "").slice(0, 400);
        break;
      case "model_call": {
        cur = e.step;
        const s = stepOf(e.step);
        const msgs = Array.isArray(e.messages) ? e.messages : [];
        s.msgCount = msgs.length;
        let sumEst = 0;
        for (const m of msgs) {
          const t = msgTokens(m);
          sumEst += t;
          if (s.comp[m.role] !== undefined) s.comp[m.role] += t;
        }
        s.promptTokens = sumEst;
        break;
      }
      case "model_reply": {
        const s = stepOf(e.step);
        const u = e.reply?.usage;
        if (u && typeof u.input === "number") {
          s.promptTokens = u.input;
          s.promptEstimated = false;
          s.outputTokens = u.output ?? 0;
          s.totalTokens = u.total ?? u.input + (u.output ?? 0);
        } else {
          s.outputTokens = est(e.reply?.message?.content) + est(JSON.stringify(e.reply?.toolCalls || []));
          s.totalTokens = e.tokens || s.promptTokens + s.outputTokens;
        }
        s.ms = e.ms || 0;
        break;
      }
      case "context_trim":
        run.trims.push({ afterStep: cur, before: e.before, after: e.after, dropped: e.dropped });
        break;
      case "tool_result": {
        const t = tools.get(e.name) || { name: e.name, count: 0, outChars: 0, outTokens: 0, ms: 0, maxTokens: 0 };
        const tk = est(e.output);
        t.count++;
        t.outChars += String(e.output || "").length;
        t.outTokens += tk;
        t.ms += e.ms || 0;
        t.maxTokens = Math.max(t.maxTokens, tk);
        tools.set(e.name, t);
        outs.push({ step: e.step, name: e.name, tokens: tk });
        break;
      }
      case "done":
        run.reason = e.reason || "";
        run.error = e.error || "";
        break;
      default:
    }
  }
  run.steps = [...steps.values()].sort((a, b) => a.step - b.step);
  run.tools = [...tools.values()].map(t => ({ ...t, avgMs: t.count ? Math.round(t.ms / t.count) : 0 })).sort((a, b) => b.outTokens - a.outTokens);
  const sum = k => run.steps.reduce((n, s) => n + s[k], 0);
  run.totals = {
    calls: run.steps.length,
    promptTokens: sum("promptTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
    peakPrompt: run.steps.reduce((n, s) => Math.max(n, s.promptTokens), 0),
    toolCalls: run.tools.reduce((n, t) => n + t.count, 0),
    trims: run.trims.length,
    estimated: run.steps.some(s => s.promptEstimated),
  };
  run.topOutputs = outs.sort((a, b) => b.tokens - a.tokens).slice(0, 8);
  return run;
}

/** 某一步发给模型的消息（预览，用来看「这一步到底带了什么」） */
function stepMessages(file, step, limit = 200) {
  for (const l of readLines(file)) {
    if (!l.includes('"type":"model_call"')) continue;
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    if (j.event?.step !== step) continue;
    return (j.event.messages || []).slice(0, limit).map((m, i) => ({ i, role: m.role, tokens: msgTokens(m), tool: m.toolCalls ? m.toolCalls.map(c => c.name).join(", ") : undefined, text: String(m.content || "").slice(0, 600) }));
  }
  return [];
}

const insight = createInsight({
  est,
  readLines,
  store,
  config: () => harnessConfig(harnessHome()),
  listFiles() {
    const { active } = traceDirs();
    if (!active || !fs.existsSync(active)) return [];
    return fs
      .readdirSync(active)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => ({ f: path.join(active, f), m: fs.statSync(path.join(active, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .map(x => x.f);
  },
});

const PREF_KEYS = {
  lang: v => (v === "en" ? "en" : "zh"),
  range: v => (["today", "7", "30", "all"].includes(String(v)) ? String(v) : "7"),
  // 成本内部一律按美元算；选人民币就按这个汇率折算显示
  currency: v => (v === "cny" ? "cny" : "usd"),
  fx: v => (Number(v) >= 0.1 && Number(v) <= 100 ? Number(v) : 7.2),
  balance: v => v !== false,
  sort: v => (["recent", "tokens", "context"].includes(v) ? v : "recent"),
  group: v => (v === "provider" ? "provider" : "none"),
  prices: v => (Array.isArray(v) ? v.filter(x => x && String(x.match || "").trim()).slice(0, 40).map(x => ({ match: String(x.match).trim(), in: Number(x.in) || 0, out: Number(x.out) || 0 })) : []),
};
const prefs = () => {
  const s = store.get();
  const out = {};
  for (const [k, f] of Object.entries(PREF_KEYS)) out[k] = f(s[k]);
  return out;
};

const fmtTok = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)));
const fmtCost = c => (c == null ? "—" : c < 0.01 ? "<$0.01" : "$" + c.toFixed(2));

// ───────── DeepSeek 余额 ─────────
// 只在 M-Harness 配置里有指向 https://api.deepseek.com 的提供方、且能解出 key 时才查，key 只发给这个地址，也不会返回给界面。
// 查一次缓存 5 分钟；设置里可以关掉。

const expandEnv = v => (typeof v === "string" ? v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, k) => process.env[k] ?? "") : "");
let balanceCache = { at: 0, value: null };

async function deepseekBalance(force) {
  if (store.get().balance === false) return { enabled: false };
  if (!force && balanceCache.value && Date.now() - balanceCache.at < 5 * 60_000) return balanceCache.value;
  const cfg = harnessConfig(harnessHome());
  const prov = Object.values(cfg.providers || {}).find(p => p && /^https:\/\/api\.deepseek\.com(\/|$)/i.test(String(p.baseURL || "")) && expandEnv(p.apiKey).trim());
  let value;
  if (!prov) value = { enabled: true, available: false, reason: "没有找到可用的 DeepSeek 提供方或 key" };
  else {
    try {
      const res = await fetch("https://api.deepseek.com/user/balance", { headers: { accept: "application/json", authorization: `Bearer ${expandEnv(prov.apiKey).trim()}` }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const infos = Array.isArray(j.balance_infos) ? j.balance_infos : [];
      const balances = infos.map(b => ({ currency: String(b.currency || ""), total: Number(b.total_balance) || 0, granted: Number(b.granted_balance) || 0, toppedUp: Number(b.topped_up_balance) || 0 })).filter(b => b.currency);
      value = balances.length ? { enabled: true, available: true, usable: j.is_available === true, balances } : { enabled: true, available: false, reason: "返回里没有余额信息" };
    } catch (e) {
      value = { enabled: true, available: false, failed: true, reason: `查询失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
  balanceCache = { at: Date.now(), value };
  return value;
}

// ───────── 给 AI 的文字报告 ─────────

function report(run) {
  const t = run.totals;
  const L = [];
  L.push(`运行 ${run.name}（${run.provider || "?"}）：${run.reason || "未结束"}`);
  L.push(`共 ${t.calls} 次模型调用，累计 ${t.totalTokens} token（输入 ${t.promptTokens} / 输出 ${t.outputTokens}${t.estimated ? "，部分为估算" : ""}），单次最大输入 ${t.peakPrompt}`);
  L.push(`工具调用 ${t.toolCalls} 次，上下文压缩 ${t.trims} 次`);
  const last = run.steps[run.steps.length - 1];
  if (last) {
    const c = last.comp;
    const all = c.system + c.user + c.assistant + c.tool || 1;
    const pct = v => `${Math.round((v / all) * 100)}%`;
    L.push(`最后一步上下文构成：system ${pct(c.system)}、user ${pct(c.user)}、assistant ${pct(c.assistant)}、tool ${pct(c.tool)}`);
  }
  for (const tr of run.trims) L.push(`第 ${tr.afterStep} 步后压缩：${tr.before} → ${tr.after} token，丢弃 ${tr.dropped} 条`);
  if (run.tools.length) L.push("占用最大的工具输出：" + run.tools.slice(0, 5).map(x => `${x.name}（${x.count} 次，约 ${x.outTokens} token）`).join("；"));
  return L.join("\n");
}

// ───────── 对外 ─────────

const info = () => {
  const d = traceDirs();
  return { home: d.home, dirs: d.dirs, active: d.active, override: store.get().traceDir || "" };
};

serve({
  id: ID,
  version: VERSION,
  methods: {
    "env/info": async () => info(),
    "env/setTraceDir": async p => {
      const dir = String(p.dir || "").trim();
      if (dir && !fs.existsSync(dir)) throw new Error("这个目录不存在");
      store.set({ traceDir: dir });
      return info();
    },
    "runs/list": async p => listRuns(Number(p.limit) || 60),
    "runs/get": async p => analyze(fileOf(p.name)),
    "runs/messages": async p => stepMessages(fileOf(p.name), Number(p.step), Number(p.limit) || 200),
    // 洞察页 / Context 详情
    "insights/overview": async p => insight.overview(p || {}),
    "balance/get": async p => deepseekBalance(!!(p && p.force)),
    "session/get": async p => insight.detail(fileOf(p.name)),
    "session/messages": async p => insight.messages(fileOf(p.name), Number(p.step)),
    "prefs/get": async () => ({ ...prefs(), prices: store.get().prices || [], builtin: insight.PRICES.map(x => ({ match: x[0].source, in: x[1], out: x[2] })) }),
    "prefs/set": async p => {
      const patch = {};
      for (const [k, f] of Object.entries(PREF_KEYS)) if (p && k in p) patch[k] = f(p[k]);
      store.set(patch);
      return { ...prefs(), prices: store.get().prices || [] };
    },
  },
  tools: [
    {
      name: "context_overview",
      description: "洞察总览：最近一段时间（today / 7 / 30 天）的会话数、token 用量与成本估算、最常用的技能 / 工具 / 命令、上下文构成。",
      readOnly: true,
      inputSchema: { type: "object", properties: { range: { type: "string", description: "today / 7 / 30 / all，默认 7" } } },
      run: async a => {
        const o = insight.overview({ range: a.range });
        const k = o.kpi;
        if (!k.sessions) return "这段时间没有 trace 记录。";
        const L = [`${o.range === "today" ? "今天" : o.range === "all" ? "全部记录" : "最近 " + o.range + " 天"}：${k.sessions} 个会话、${k.steps} 次模型调用、${k.toolExec} 次工具执行；累计 ${fmtTok(k.tokens)} token（输入 ${fmtTok(k.input)} / 输出 ${fmtTok(k.output)}），估算成本 ${fmtCost(k.cost)}`];
        const all = Object.values(o.comp).reduce((n, v) => n + v, 0) || 1;
        L.push("上下文构成：" + insight.CATS.map(c => `${c} ${Math.round((o.comp[c] / all) * 100)}%`).join("、"));
        if (o.tools.length) L.push("常用工具：" + o.tools.slice(0, 6).map(x => `${x.name}×${x.count}`).join("、"));
        if (o.skills.length) L.push("常用技能：" + o.skills.slice(0, 6).map(x => `${x.name}×${x.count}`).join("、"));
        if (o.commands.length) L.push("常用命令：" + o.commands.slice(0, 6).map(x => `${x.name}×${x.count}`).join("、"));
        return L.join("\n");
      },
    },
    {
      name: "context_runs",
      description: "列出最近的运行记录（trace）：名字、模型、步数、累计 token、压缩次数。想看某次运行的上下文情况，先用它找到名字。",
      readOnly: true,
      inputSchema: { type: "object", properties: { limit: { type: "number", description: "最多几条，默认 10" } } },
      run: async a => {
        const rs = listRuns(Math.min(Number(a.limit) || 10, 50));
        if (!rs.length) return "没有找到 trace 记录。";
        return rs.map(r => `${r.name} · ${r.provider || "?"} · ${r.steps} 步 · ${r.tokens} token · 压缩 ${r.trims} 次 · ${r.reason || "未结束"} · ${r.input.slice(0, 40)}`).join("\n");
      },
    },
    {
      name: "context_stats",
      description: "分析一次运行的上下文：token 走势、构成（system/user/assistant/tool）、压缩事件、占用最大的工具输出。run 缺省取最近一次。",
      readOnly: true,
      inputSchema: { type: "object", properties: { run: { type: "string", description: "运行名字（context_runs 里的），缺省 = 最近一次" } } },
      run: async a => {
        let name = String(a.run || "").trim();
        if (!name || name === "latest") {
          const r = listRuns(1)[0];
          if (!r) throw new Error("没有找到 trace 记录");
          name = r.name;
        }
        const f = fileOf(name);
        const d = insight.detail(f);
        const extra = [];
        if (d.stats.cost != null) extra.push(`估算成本 ${fmtCost(d.stats.cost)}（按 ${d.model || "?"} 单价）`);
        if (d.skills.length) extra.push("使用的技能：" + d.skills.map(x => `${x.name}×${x.count}`).join("、"));
        if (d.commands.programs.length) extra.push("执行的命令：" + d.commands.programs.slice(0, 6).map(x => `${x.program}×${x.count}${x.fails ? `（失败 ${x.fails}）` : ""}`).join("、"));
        return [report(analyze(f)), ...extra].join("\n");
      },
    },
  ],
});
