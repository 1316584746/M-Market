"use strict";
/**
 * 洞察引擎：把 M-Harness 的 trace（每次运行一个 jsonl）解析成「会话档案」，再按时间范围汇总出
 * 洞察页（KPI、7 天用量、热力图、技能 / 工具 / 命令排行、上下文构成、会话卡片）和单个会话的 Context 详情。
 * 提供上下文洞察总览与单个会话的 Context 详情；M-Harness 的 trace 里没有的数据（缓存命中、推理、子 Agent 等）一律返回 null / 0，不编造。
 * 只读，不改任何文件。
 */
const fs = require("node:fs");
const path = require("node:path");

const pad = n => String(n).padStart(2, "0");
const dayOf = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const addDays = (day, n) => {
  const [y, m, d] = day.split("-").map(Number);
  return dayOf(new Date(y, m - 1, d + n).getTime());
};

// ───────── 价格（美元 / 百万 token；用户可在设置里覆盖，没匹配到就不算成本） ─────────

const PRICES = [
  [/deepseek-(reasoner|r1)/i, 0.55, 2.19],
  [/deepseek/i, 0.27, 1.1],
  [/gpt-5/i, 1.25, 10],
  [/gpt-4\.1-mini/i, 0.4, 1.6],
  [/gpt-4\.1/i, 2, 8],
  [/gpt-4o-mini/i, 0.15, 0.6],
  [/gpt-4o/i, 2.5, 10],
  [/o3-mini|o4-mini/i, 1.1, 4.4],
  [/claude.*opus/i, 15, 75],
  [/claude.*haiku/i, 1, 5],
  [/claude/i, 3, 15],
  [/composer/i, 1.25, 10],
  [/gemini.*flash/i, 0.3, 2.5],
  [/gemini/i, 1.25, 10],
  [/qwen.*max/i, 1.6, 6.4],
  [/qwen/i, 0.4, 1.2],
];

const KIND_AGENT = new Set(["cli", "cursor-sdk"]);
// cli 类 Agent 预设背后用的模型（只用来查单价；实际模型由 Agent 自己决定，可在插件设置里覆盖单价）
const CLI_MODELS = { codex: "gpt-5-codex", "claude-code": "claude-sonnet-4", "cursor-cli": "composer-2" };
const CATS = ["system", "tools", "user", "injected", "skill", "toolcalls", "reasoning", "answers"];
const emptyComp = () => Object.fromEntries(CATS.map(k => [k, 0]));
const addComp = (a, b, k = 1) => {
  for (const c of CATS) a[c] += (b[c] || 0) * k;
  return a;
};
const sumComp = c => CATS.reduce((n, k) => n + (c[k] || 0), 0);

function createInsight({ est, readLines, listFiles, store, config }) {
  // ───────── 价格 / 模型 ─────────
  const priceOf = model => {
    if (!model) return null;
    for (const o of store.get().prices || []) {
      try {
        if (o && o.match && new RegExp(o.match, "i").test(model)) return { in: Number(o.in) || 0, out: Number(o.out) || 0, custom: true };
      } catch {
        /* 用户写坏的正则直接跳过 */
      }
    }
    const hit = PRICES.find(p => p[0].test(model));
    return hit ? { in: hit[1], out: hit[2] } : null;
  };
  const costOf = (price, i, o) => (price ? (i * price.in + o * price.out) / 1e6 : null);
  // 设置里的提供方 → 计价用的模型名。规则和 M-Harness 自己一致：模型类取配置的 model；
  // cursor-sdk 没填 model 时用 composer-2；cli 类的 Agent 没有「模型」字段，按预设（或命令名）对应到它背后的模型。
  const providerOf = (cfg, id) => {
    const p = cfg.providers?.[id];
    if (!p) return { model: "", agent: false };
    const agent = KIND_AGENT.has(p.type);
    let model = typeof p.model === "string" ? p.model : "";
    if (!model && p.type === "cursor-sdk") model = "composer-2";
    if (!model && p.type === "cli") {
      const key = String(p.preset || "") || (/codex/i.test(p.command || "") ? "codex" : /claude/i.test(p.command || "") ? "claude-code" : /cursor|agent/i.test(p.command || "") ? "cursor-cli" : "");
      model = CLI_MODELS[key] || "";
    }
    if (!model) model = String(p.preset || "");
    return { model, agent };
  };

  // ───────── 单个 trace → 会话档案（按文件修改时间缓存） ─────────
  function compose(msgs) {
    const c = emptyComp();
    const callName = new Map();
    for (const m of msgs) if (Array.isArray(m.toolCalls)) for (const tc of m.toolCalls) callName.set(tc.id, tc.name);
    for (const m of msgs) {
      const t = est(m.content) + 4;
      if (m.role === "system") c.system += t;
      else if (m.role === "user") c.user += t;
      else if (m.role === "assistant") {
        const hasCalls = Array.isArray(m.toolCalls) && m.toolCalls.length > 0;
        if (m.content || !hasCalls) c.answers += t;
        else c.toolcalls += 4;
        if (hasCalls) c.toolcalls += est(JSON.stringify(m.toolCalls));
      } else if (m.role === "tool") {
        if (callName.get(m.toolCallId) === "use_skill") c.skill += t;
        else c.toolcalls += t;
      }
    }
    return c;
  }

  const programOf = cmd => {
    const first = String(cmd || "").trim().replace(/^(sudo|env|cmd\s*\/c|powershell(\.exe)?\s+-command)\s+/i, "").split(/\s+/)[0] || "";
    const base = first.replace(/^["']|["']$/g, "").split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, "");
    return (base || "?").toLowerCase();
  };

  function build(file, st) {
    const p = {
      name: path.basename(file, ".jsonl"),
      mtime: st.mtimeMs,
      size: st.size,
      provider: "",
      input: "",
      startedAt: 0,
      endedAt: 0,
      reason: "",
      error: "",
      steps: [],
      toolEv: [],
      skillEv: [],
      cmdEv: [],
      fileEv: [],
      events: [],
      progress: { counts: {}, last: [] },
      // 外部 Agent（cli / cursor-sdk）不会把 token 用量写进 trace，只能按提示词和过程文本粗估
      agent: { inTok: 0, outTok: 0, textLines: 0, doneTok: 0 },
      userMsgs: 0,
      skipped: "",
    };
    let lines;
    try {
      lines = readLines(file);
    } catch (e) {
      p.skipped = e.message;
      return p;
    }
    const steps = new Map();
    const pending = new Map();
    let cur = 0;
    const stepOf = n => {
      if (!steps.has(n)) steps.set(n, { step: n, ts: 0, day: "", prompt: 0, output: 0, total: 0, ms: 0, estimated: true, ctx: 0, msgCount: 0, comp: emptyComp(), billed: emptyComp() });
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
      const ts = j.ts || 0;
      p.startedAt ||= ts;
      p.endedAt = ts || p.endedAt;
      switch (e.type) {
        case "run_start":
          p.provider = e.provider || "";
          p.input = String(e.input || "").slice(0, 400);
          p.agent.inTok = est(e.input);
          p.events.push({ ts, type: "start" });
          break;
        case "model_call": {
          cur = e.step;
          const s = stepOf(e.step);
          const msgs = Array.isArray(e.messages) ? e.messages : [];
          s.ts = ts;
          s.day = dayOf(ts);
          s.msgCount = msgs.length;
          s.comp = compose(msgs);
          s.ctx = sumComp(s.comp);
          p.userMsgs = msgs.filter(m => m.role === "user").length;
          break;
        }
        case "model_reply": {
          const s = stepOf(e.step);
          const u = e.reply?.usage;
          const callsTok = est(JSON.stringify(e.reply?.toolCalls || []));
          const ansTok = est(e.reply?.message?.content);
          s.ms = e.ms || 0;
          const estIn = sumComp(s.comp);
          if (u && typeof u.input === "number") {
            s.estimated = false;
            s.prompt = u.input;
            s.output = u.output ?? 0;
            s.total = u.total ?? s.prompt + s.output;
            s.ctx = u.input;
            const k = estIn ? u.input / estIn : 0;
            addComp(s.billed, s.comp, k);
            const outEst = (e.reply?.toolCalls?.length ? callsTok : 0) + ansTok || 1;
            s.billed.toolcalls += s.output * ((e.reply?.toolCalls?.length ? callsTok : 0) / outEst);
            s.billed.answers += s.output * (ansTok / outEst);
          } else {
            s.estimated = true;
            s.prompt = estIn;
            s.output = (e.reply?.toolCalls?.length ? callsTok : 0) + ansTok;
            s.total = e.tokens || s.prompt + s.output;
            addComp(s.billed, s.comp);
            s.billed.toolcalls += e.reply?.toolCalls?.length ? callsTok : 0;
            s.billed.answers += ansTok;
          }
          break;
        }
        case "tool_call": {
          const q = pending.get(e.step) || [];
          q.push({ name: e.name, args: e.args, ts });
          pending.set(e.step, q);
          if (e.name === "use_skill" && e.args && typeof e.args.name === "string") p.skillEv.push({ ts, name: e.args.name, step: e.step });
          if ((e.name === "read_file" || e.name === "write_file" || e.name === "list_dir") && e.args) {
            p.fileEv.push({ ts, step: e.step, kind: e.name === "read_file" ? "read" : e.name === "write_file" ? "write" : "list", path: String(e.args.path ?? ".") });
          }
          break;
        }
        case "tool_result": {
          const q = pending.get(e.step) || [];
          const i = q.findIndex(x => x.name === e.name);
          const call = i >= 0 ? q.splice(i, 1)[0] : { args: null };
          p.toolEv.push({ ts, name: e.name, ms: e.ms || 0, out: est(e.output), step: e.step });
          if (e.name === "run_command") {
            const command = String(call.args?.command ?? "");
            const m = /^(\[超时已终止\]\s*)?exit=(-?\d+|null)/.exec(String(e.output || ""));
            p.cmdEv.push({ ts, step: e.step, command: command.slice(0, 300), program: programOf(command), exit: m ? (m[2] === "null" ? null : Number(m[2])) : null, timedOut: !!(m && m[1]), ms: e.ms || 0 });
          }
          break;
        }
        case "tool_blocked": {
          p.events.push({ ts, type: "blocked", step: e.step, name: e.name, reason: String(e.reason || "").slice(0, 200) });
          if (e.name === "run_command") p.cmdEv.push({ ts, step: e.step, command: "", program: "?", exit: null, blocked: true, ms: 0 });
          break;
        }
        case "approval":
          p.events.push({ ts, type: "approval", step: e.step, name: e.name, approved: !!e.approved });
          break;
        case "context_trim":
          p.events.push({ ts, type: "trim", step: cur, before: e.before, after: e.after, dropped: e.dropped });
          break;
        case "agent_progress": {
          const k = e.kind || "text";
          p.progress.counts[k] = (p.progress.counts[k] || 0) + 1;
          // 状态行是界面提示、错误行不是模型输出，都不算 token
          if (k === "text" || k === "thinking" || k === "tool") p.agent.outTok += est(e.line);
          if (k === "text") p.agent.textLines++;
          p.progress.last.push({ ts, kind: k, line: String(e.line || "").slice(0, 200) });
          if (p.progress.last.length > 30) p.progress.last.shift();
          break;
        }
        case "done":
          p.reason = e.reason || "";
          p.error = e.error || "";
          p.agent.doneTok = est(e.text);
          p.events.push({ ts, type: "done", reason: p.reason, error: p.error });
          break;
        default:
      }
    }
    p.steps = [...steps.values()].filter(s => s.ts).sort((a, b) => a.step - b.step);
    // 外部 Agent 会话：没有模型调用记录，就合成一步「估算用量」，这样总览、7 天图、成本都能照常算。
    // 输入 = 你发给它的提示词；输出 = 它的回复 / 思考 / 工具过程文本（最终回复和过程里的回复重复时只算一次）。
    // 它内部反复读上下文的开销看不到，所以这是下限。
    if (!p.steps.length && Object.keys(p.progress.counts).length) {
      const a = p.agent;
      const out = a.outTok + (a.textLines ? 0 : a.doneTok);
      const ts = p.endedAt || p.startedAt || st.mtimeMs;
      if (a.inTok + out > 0) {
        p.steps.push({ step: 1, ts, day: dayOf(ts), prompt: a.inTok, output: out, total: a.inTok + out, ms: Math.max(0, (p.endedAt || 0) - (p.startedAt || 0)), estimated: true, agentEstimate: true, ctx: 0, msgCount: 0, comp: emptyComp(), billed: emptyComp() });
      }
    }
    return p;
  }

  const cache = new Map();
  function profileOf(file) {
    const st = fs.statSync(file);
    const c = cache.get(file);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.p;
    const p = build(file, st);
    cache.set(file, { mtime: st.mtimeMs, size: st.size, p });
    return p;
  }
  /** 最近的 trace 档案（最多 400 个），顺带清掉已经不存在的缓存 */
  function allProfiles(limit = 400) {
    const files = listFiles().slice(0, limit);
    const keep = new Set(files);
    for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k);
    return files.map(profileOf);
  }

  // ───────── 汇总 ─────────

  const stepCost = (price, s) => costOf(price, s.prompt, s.output);

  /** 某个会话在日期集合里的用量 */
  function usageIn(p, price, days) {
    const u = { steps: 0, input: 0, output: 0, tokens: 0, cost: price ? 0 : null, comp: emptyComp(), ms: 0 };
    for (const s of p.steps) {
      if (days && !days.has(s.day)) continue;
      u.steps++;
      u.input += s.prompt;
      u.output += s.output;
      u.tokens += s.total || s.prompt + s.output;
      u.ms += s.ms;
      addComp(u.comp, s.billed);
      if (price) u.cost += stepCost(price, s);
    }
    return u;
  }
  const inDays = (ts, days) => !days || days.has(dayOf(ts));

  function rangeDays(range, day) {
    const today = dayOf(Date.now());
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) return { list: [day], set: new Set([day]), today };
    const n = range === "today" ? 1 : range === "30" ? 30 : 7;
    const list = Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));
    return { list, set: new Set(list), today };
  }

  const bump = (map, key, ts, extra) => {
    const x = map.get(key) || { name: key, count: 0, last: 0, ...(extra || {}) };
    x.count++;
    x.last = Math.max(x.last, ts);
    map.set(key, x);
    return x;
  };

  function overview(o = {}) {
    const cfg = config();
    const { list, set, today } = rangeDays(String(o.range || store.get().range || "7"), o.day);
    const profiles = allProfiles();
    const kpi = { sessions: 0, tokens: 0, input: 0, output: 0, cost: 0, priced: false, cacheHit: null, turns: 0, steps: 0, toolExec: 0, activeMs: 0, agentSessions: 0 };
    const skills = new Map();
    const tools = new Map();
    const commands = new Map();
    const comp = emptyComp();
    const cards = [];
    const sortKey = ["recent", "tokens", "context"].includes(o.sort) ? o.sort : store.get().sort || "recent";
    const q = String(o.q || "").trim().toLowerCase();

    const week = Array.from({ length: 7 }, (_, i) => ({ day: addDays(today, i - 6), tokens: 0, cost: 0, sessions: 0 }));
    const weekIdx = new Map(week.map((w, i) => [w.day, i]));
    // 热力图：最近 8 周（周一开头），每天的 token
    const dow = (new Date().getDay() + 6) % 7;
    const heatStart = addDays(today, -(dow + 49));
    const heat = Array.from({ length: 56 }, (_, i) => ({ day: addDays(heatStart, i), tokens: 0 })).filter(h => h.day <= today);
    const heatIdx = new Map(heat.map((h, i) => [h.day, i]));
    let anyPrice = false;

    for (const p of profiles) {
      const { model, agent } = providerOf(cfg, p.provider);
      const price = priceOf(model);
      if (price) anyPrice = true;
      // 热力图 / 7 天图：用全部会话（不受筛选影响）
      for (const s of p.steps) {
        const hi = heatIdx.get(s.day);
        if (hi !== undefined) heat[hi].tokens += s.total || s.prompt + s.output;
        const wi = weekIdx.get(s.day);
        if (wi !== undefined) {
          week[wi].tokens += s.total || s.prompt + s.output;
          if (price) week[wi].cost += stepCost(price, s);
        }
      }
      for (const d of new Set(p.steps.map(s => s.day))) {
        const wi = weekIdx.get(d);
        if (wi !== undefined) week[wi].sessions++;
      }
      const active = p.steps.some(s => set.has(s.day)) || (!p.steps.length && inDays(p.startedAt, set));
      if (!active) continue;

      const u = usageIn(p, price, set);
      const tEv = p.toolEv.filter(e => inDays(e.ts, set));
      const sEv = p.skillEv.filter(e => inDays(e.ts, set));
      const cEv = p.cmdEv.filter(e => inDays(e.ts, set));
      // 点技能 / 工具 / 命令筛选会话
      if (o.skill && !sEv.some(e => e.name === o.skill)) continue;
      if (o.tool && !tEv.some(e => e.name === o.tool)) continue;
      if (o.command && !cEv.some(e => e.program === o.command)) continue;
      const last = p.steps[p.steps.length - 1];
      const text = `${p.name} ${p.input} ${p.provider} ${model}`.toLowerCase();
      const matchQ = !q || text.includes(q);

      // 汇总（卡片之外的区块按筛选后的会话算）
      if (matchQ) {
        kpi.sessions++;
        kpi.tokens += u.tokens;
        kpi.input += u.input;
        kpi.output += u.output;
        if (u.cost != null) {
          kpi.cost += u.cost;
          kpi.priced = true;
        }
        if (p.steps.some(s => s.agentEstimate)) kpi.agentSessions++;
        kpi.turns += 1;
        kpi.steps += u.steps;
        kpi.toolExec += tEv.length;
        kpi.activeMs += u.ms + tEv.reduce((n, e) => n + e.ms, 0);
        addComp(comp, u.comp);
        for (const e of sEv) bump(skills, e.name, e.ts);
        for (const e of tEv) bump(tools, e.name, e.ts);
        for (const e of cEv) bump(commands, e.program, e.ts);
      }
      if (!matchQ) continue;
      const lastComp = last ? last.comp : emptyComp();
      cards.push({
        name: p.name,
        provider: p.provider,
        model,
        agent,
        agentEstimate: p.steps.some(s => s.agentEstimate),
        input: p.input.slice(0, 160),
        startedAt: p.startedAt,
        lastActive: p.endedAt || p.mtime,
        reason: p.reason,
        steps: u.steps,
        tokens: u.tokens,
        cost: u.cost,
        ctx: last ? last.ctx : 0,
        ctxEstimated: last ? last.estimated : true,
        comp: lastComp,
        tools: tEv.length,
        skipped: p.skipped,
      });
    }
    cards.sort((a, b) => (sortKey === "tokens" ? b.tokens - a.tokens : sortKey === "context" ? b.ctx - a.ctx : b.lastActive - a.lastActive));
    const rank = m => [...m.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, 30);
    return {
      range: o.day ? "day" : String(o.range || store.get().range || "7"),
      day: o.day || "",
      days: list,
      today,
      kpi: { ...kpi, cost: kpi.priced ? kpi.cost : null, priced: undefined },
      week,
      heat,
      skills: rank(skills),
      tools: rank(tools),
      commands: rank(commands),
      comp,
      sessions: cards.slice(0, 200),
      total: cards.length,
      anyPrice,
      contextLimit: cfg.limits?.contextTokens || 0,
    };
  }

  // ───────── 单个会话（Context 详情） ─────────

  function detail(file) {
    const cfg = config();
    const p = profileOf(file);
    const { model, agent } = providerOf(cfg, p.provider);
    const price = priceOf(model);
    const u = usageIn(p, price, null);
    const last = p.steps[p.steps.length - 1];
    const limit = cfg.limits?.contextTokens || 0;
    const toolMs = p.toolEv.reduce((n, e) => n + e.ms, 0);
    const wall = Math.max(0, (p.endedAt || 0) - (p.startedAt || 0));
    const toolMap = new Map();
    for (const e of p.toolEv) {
      const t = toolMap.get(e.name) || { name: e.name, count: 0, ms: 0, outTokens: 0, last: 0 };
      t.count++;
      t.ms += e.ms;
      t.outTokens += e.out;
      t.last = Math.max(t.last, e.ts);
      toolMap.set(e.name, t);
    }
    const skills = new Map();
    for (const e of p.skillEv) bump(skills, e.name, e.ts);
    const files = new Map();
    for (const e of p.fileEv) {
      const f = files.get(e.path) || { path: e.path, read: 0, write: 0, list: 0, last: 0 };
      f[e.kind]++;
      f.last = Math.max(f.last, e.ts);
      files.set(e.path, f);
    }
    const progs = new Map();
    for (const c of p.cmdEv) {
      const x = progs.get(c.program) || { program: c.program, count: 0, fails: 0, last: 0 };
      x.count++;
      if (c.blocked || c.timedOut || (c.exit != null && c.exit !== 0)) x.fails++;
      x.last = Math.max(x.last, c.ts);
      progs.set(c.program, x);
    }
    const count = k => p.fileEv.filter(f => f.kind === k).length;
    return {
      name: p.name,
      provider: p.provider,
      model,
      agent,
      agentEstimate: p.steps.some(s => s.agentEstimate),
      input: p.input,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      reason: p.reason,
      error: p.error,
      skipped: p.skipped,
      price,
      contextLimit: limit,
      stats: {
        turns: 1,
        steps: u.steps,
        userInputs: p.userMsgs,
        toolCalls: p.toolEv.length,
        input: u.input,
        output: u.output,
        billed: u.tokens,
        cost: u.cost,
        estimated: p.steps.some(s => s.estimated),
        peakPrompt: p.steps.reduce((n, s) => Math.max(n, s.ctx), 0),
        trims: p.events.filter(e => e.type === "trim").length,
        files: { read: count("read"), write: count("write"), list: count("list") },
      },
      tokens: { billed: u.tokens, comp: u.comp, cacheHit: null },
      timing: { wallMs: wall, modelMs: u.ms, toolMs, overheadMs: Math.max(0, wall - u.ms - toolMs) },
      current: last ? { tokens: last.ctx, pct: limit ? (last.ctx / limit) * 100 : null, estimated: last.estimated, comp: last.comp, msgCount: last.msgCount } : null,
      trend: p.steps.map(s => ({ step: s.step, ts: s.ts, prompt: s.prompt, output: s.output, total: s.total, ms: s.ms, estimated: s.estimated, cost: stepCost(price, s), trimmed: p.events.some(e => e.type === "trim" && e.step === s.step - 1) })),
      events: p.events.slice(-200),
      files: [...files.values()].sort((a, b) => b.last - a.last).slice(0, 100),
      commands: { programs: [...progs.values()].sort((a, b) => b.count - a.count), runs: p.cmdEv.slice(-60).reverse() },
      tools: [...toolMap.values()].sort((a, b) => b.count - a.count),
      skills: [...skills.values()].sort((a, b) => b.count - a.count),
      fleet: { provider: p.provider, agent, counts: p.progress.counts, last: p.progress.last.slice(-12).reverse() },
    };
  }

  /** 某一步发给模型的消息：每条带构成类别、估算 token、完整文本（截断到 6000 字符） */
  function messages(file, step) {
    for (const l of readLines(file)) {
      if (!l.includes('"type":"model_call"')) continue;
      let j;
      try {
        j = JSON.parse(l);
      } catch {
        continue;
      }
      if (j.event?.step !== step) continue;
      const msgs = j.event.messages || [];
      const callName = new Map();
      for (const m of msgs) if (Array.isArray(m.toolCalls)) for (const tc of m.toolCalls) callName.set(tc.id, tc.name);
      return msgs.slice(0, 400).map((m, i) => {
        const tool = Array.isArray(m.toolCalls) ? m.toolCalls.map(c => c.name).join(", ") : m.role === "tool" ? callName.get(m.toolCallId) : undefined;
        const cat = m.role === "system" ? "system" : m.role === "user" ? "user" : m.role === "assistant" ? (!m.content && tool ? "toolcalls" : "answers") : tool === "use_skill" ? "skill" : "toolcalls";
        const raw = String(m.content || "") + (Array.isArray(m.toolCalls) ? "\n" + JSON.stringify(m.toolCalls) : "");
        return { i, role: m.role, cat, tool, tokens: est(m.content) + (Array.isArray(m.toolCalls) ? est(JSON.stringify(m.toolCalls)) : 0) + 4, text: raw.slice(0, 6000), truncated: raw.length > 6000 };
      });
    }
    return [];
  }

  return { overview, detail, messages, priceOf, providerOf, profileOf, allProfiles, PRICES, CATS };
}

module.exports = { createInsight, CATS, dayOf };
