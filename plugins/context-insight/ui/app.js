(function () {
  "use strict";
  const api = window.dbxPlugin;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const view = $("view");

  // ───────── 中英文 ─────────
  // 界面文字都写成 t("中文原文")，英文译文在 i18n.js；t("第 {0} 步", n) 用 {0} {1} 占位。
  // 注意：往 innerHTML 里拼的参数要先 esc()，t() 本身不转义。
  const EN = window.CI_EN || {};
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 存不了就只在本次有效 */ } };
  const hostLocale = String((api && api.locale) || navigator.language || "zh").toLowerCase();
  let lang = lsGet("ci.lang") || (/^zh/.test(hostLocale) ? "zh" : "en");
  if (lang !== "en") lang = "zh";
  function t(zh) {
    let s = lang === "en" && EN[zh] != null ? EN[zh] : zh;
    if (arguments.length > 1) { const a = arguments; s = s.replace(/\{(\d)\}/g, (_, i) => a[+i + 1]); }
    return s;
  }
  const rpc = (m, p, ms) => api.invoke(m, p || {}, { timeoutMs: ms || 120000 });

  // ───────── 常量 ─────────
  const CATS = [
    ["system", "系统提示词", "#8b5cf6"],
    ["tools", "工具定义", "#06b6d4"],
    ["user", "用户消息", "#3b82f6"],
    ["injected", "注入内容", "#ec4899"],
    ["skill", "技能注入", "#f97316"],
    ["toolcalls", "工具调用", "#f59e0b"],
    ["reasoning", "模型思考", "#a855f7"],
    ["answers", "模型回复", "#10b981"],
  ];
  const PALETTE = ["#f97316", "#10b981", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#f59e0b", "#6366f1"];
  const CAT_NA = { tools: 1, injected: 1, reasoning: 1 };
  const REASON = { final: "完成", max_steps: "达到步数上限", error: "出错", aborted: "已中止", cancelled: "已取消" };

  const SESS_STEP = 12;
  const S = {
    sessOpen: lsGet("ci.sessOpen") !== "0", sessMax: SESS_STEP, grpShut: new Set(),
    tab: "insights", range: "7", from: "", to: "", day: "", heat: "tokens", bal: null, q: "", sort: "recent", group: "none", skill: "", tool: "", command: "",
    ov: null, sessions: null, follow: true, name: "", detail: null, fleet: null, seq: 0, prefs: null,
  };

  // ───────── 格式化 ─────────
  const fmt = n => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)); };
  // 成本内部按美元算；设置里选了人民币就按汇率折算
  const cur = () => { const p = S.prefs || {}; return p.currency === "cny" ? { sy: "¥", fx: Number(p.fx) > 0 ? Number(p.fx) : 7.2 } : { sy: "$", fx: 1 }; };
  const money = c => { if (c == null) return "—"; const u = cur(), v = c * u.fx; return v === 0 ? u.sy + "0" : v < 0.01 ? "<" + u.sy + "0.01" : u.sy + v.toFixed(v < 1 ? 3 : 2); };
  const axisMoney = v => { const u = cur(), x = v * u.fx; return u.sy + (x >= 100 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2)); };
  const p2 = n => String(n).padStart(2, "0");
  const when = ts => { if (!ts) return ""; const d = new Date(ts); return p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes()); };
  const dur = ms => { ms = Number(ms) || 0; if (ms < 1000) return ms + "ms"; const s = ms / 1000; if (s < 60) return s.toFixed(1) + "s"; const m = Math.floor(s / 60); if (m < 60) return m + "m" + p2(Math.round(s % 60)) + "s"; return Math.floor(m / 60) + "h" + p2(m % 60) + "m"; };
  const pct = (v, all) => all ? Math.round((v / all) * 100) + "%" : "0%";
  const sum = c => CATS.reduce((n, k) => n + (c ? c[k[0]] || 0 : 0), 0);
  const catLabel = k => t(CATS.find(c => c[0] === k)[1]);
  const none = () => '<span class="na">' + esc(t("暂无数据")) + "</span>";

  let toastTimer;
  function toast(msg, isErr) {
    const el = $("toast");
    el.textContent = msg; el.className = "toast" + (isErr ? " err" : ""); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 5000 : 2200);
  }
  const errText = e => t(String((e && e.message) || e || ""));
  const fail = e => '<div class="pad warn">' + esc(errText(e)) + "</div>";
  const empty = (msg, sub) => '<div class="empty"><div class="e-t">' + esc(msg) + "</div>" + (sub ? '<div class="e-s">' + esc(sub) + "</div>" : "") + "</div>";

  // ───────── 图形部件 ─────────
  function stack(comp, h) {
    const all = sum(comp);
    if (!all) return '<div class="stack" style="height:' + (h || 8) + 'px"></div>';
    return '<div class="stack" style="height:' + (h || 8) + 'px">' + CATS.map(c => {
      const v = comp[c[0]] || 0;
      return v > 0 ? '<i style="width:' + (v / all) * 100 + "%;background:" + c[2] + '" title="' + esc(t(c[1]) + " " + fmt(v) + " (" + pct(v, all) + ")") + '"></i>' : "";
    }).join("") + "</div>";
  }
  function legend(comp) {
    const all = sum(comp);
    return '<div class="legend">' + CATS.map(c => {
      const v = comp[c[0]] || 0;
      return '<span class="' + (v ? "" : "dim") + '"><i style="background:' + c[2] + '"></i>' + esc(t(c[1])) + (all && v ? " " + pct(v, all) : "") + "</span>";
    }).join("") + "</div>";
  }
  function tile(label, value, sub, ph) {
    return '<div class="tile' + (ph ? " ph" : "") + '"><div class="k">' + esc(label) + '</div><div class="v">' + esc(value) + "</div>" + (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div>";
  }
  // 环形图：segs = [{v, c}]，中间两行文字
  function donut(segs, big, small) {
    const R = 52, C = 2 * Math.PI * R, all = segs.reduce((n, s) => n + s.v, 0);
    let g = '<svg class="donut" viewBox="0 0 140 140"><circle cx="70" cy="70" r="' + R + '" fill="none" stroke="currentColor" opacity=".1" stroke-width="16"/>';
    if (all > 0) {
      let off = 0;
      segs.forEach(s => {
        if (s.v <= 0) return;
        const len = (s.v / all) * C;
        g += '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + s.c + '" stroke-width="16" stroke-dasharray="' + Math.max(0, len - (segs.length > 1 ? 1.5 : 0)) + " " + C + '" stroke-dashoffset="' + -off + '" transform="rotate(-90 70 70)"/>';
        off += len;
      });
    }
    return g + '<text x="70" y="68" text-anchor="middle" class="d-big">' + esc(big) + '</text><text x="70" y="86" text-anchor="middle" class="d-sm">' + esc(small) + "</text></svg>";
  }
  const lrow = (c, name, pctText, sub, dimmed) => '<div class="lrow' + (dimmed ? " dim" : "") + '"><i style="background:' + c + '"></i><span class="ln">' + esc(name) + '</span><b>' + esc(pctText) + '</b><span class="ls">' + esc(sub) + "</span></div>";
  const box = (title, body, cls, right) => '<section class="box ' + (cls || "") + '"><h3><span>' + esc(title) + "</span>" + (right || "") + "</h3>" + body + "</section>";
  const kv = (k, v) => '<div class="kv"><span>' + esc(k) + "</span><b>" + v + "</b></div>";

  // 取一个好看的坐标轴上限：1 / 2 / 2.5 / 5 / 10 × 10^k
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  // 双轴图：左轴 Token（蓝柱），右轴成本（绿柱，没有单价就不画）
  function weekChart(week, priced) {
    const W = 560, H = 210, L = 46, R = priced ? 46 : 10, B = 26, T = 12, n = week.length;
    const maxT = niceMax(Math.max(0, ...week.map(w => w.tokens))), maxC = niceMax(Math.max(0, ...week.map(w => w.cost || 0)));
    const slot = (W - L - R) / n, bw = Math.min(26, (slot - 8) / (priced ? 2 : 1));
    const y = (v, m) => T + (H - T - B) * (1 - v / m);
    let g = '<svg class="chart" viewBox="0 0 ' + W + " " + H + '">';
    for (let i = 0; i <= 4; i++) {
      const f = i / 4, yy = y(maxT * f, maxT);
      g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="currentColor" opacity="' + (i ? ".1" : ".25") + '"/><text x="' + (L - 6) + '" y="' + (yy + 3) + '" text-anchor="end">' + fmt(maxT * f) + "</text>";
      if (priced) g += '<text x="' + (W - R + 6) + '" y="' + (yy + 3) + '" text-anchor="start" class="rt">' + esc(axisMoney(maxC * f)) + "</text>";
    }
    week.forEach((w, i) => {
      const x0 = L + i * slot + (slot - bw * (priced ? 2 : 1)) / 2, on = S.day === w.day;
      const ht = Math.max(w.tokens ? 2 : 0, (H - T - B) * (w.tokens / maxT)), hc = Math.max(w.cost ? 2 : 0, (H - T - B) * ((w.cost || 0) / maxC));
      g += '<g class="bar' + (on ? " on" : "") + '" data-day="' + w.day + '"><title>' + esc(w.day + " · " + fmt(w.tokens) + " token" + (priced ? " · " + money(w.cost || 0) : "") + (w.sessions ? " · " + t("{0} 个会话", w.sessions) : "")) + "</title>" +
        '<rect class="hit" x="' + (L + i * slot) + '" y="' + T + '" width="' + slot + '" height="' + (H - T - B) + '" fill="transparent"/>' +
        '<rect class="bt" x="' + x0 + '" y="' + (H - B - ht) + '" width="' + bw + '" height="' + ht + '" rx="2"/>' +
        (priced ? '<rect class="bc" x="' + (x0 + bw) + '" y="' + (H - B - hc) + '" width="' + bw + '" height="' + hc + '" rx="2"/>' : "") +
        '<text x="' + (L + i * slot + slot / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + w.day.slice(5) + "</text></g>";
    });
    return g + "</svg>" + '<div class="legend"><span><i style="background:#3b82f6"></i>Token</span>' + (priced ? '<span><i style="background:#10b981"></i>' + esc(t("估算成本")) + "</span>" : "") + "</div>";
  }

  const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function heatmap(heat, mode) {
    const val = x => (mode === "sessions" ? x.sessions : x.tokens);
    const max = Math.max(1, ...heat.map(val));
    const cols = Math.ceil(heat.length / 7);
    let months = "", last = -1;
    for (let c = 0; c < cols; c++) {
      const first = heat[c * 7];
      if (!first) continue;
      const m = Number(first.day.slice(5, 7)) - 1;
      if (m !== last) { months += '<span style="grid-column:' + (c + 1) + '">' + (lang === "en" ? MONTHS_EN[m] : t("{0}月", m + 1)) + "</span>"; last = m; }
    }
    let h = '<div class="hmonths" style="grid-template-columns:repeat(' + cols + ',1fr)">' + months + "</div>";
    h += '<div class="heat" style="grid-template-columns:repeat(' + cols + ',1fr)">';
    for (let c = 0; c < cols; c++) for (let r = 0; r < 7; r++) {
      const x = heat[c * 7 + r];
      if (!x) continue;
      const v = val(x), lv = v ? Math.min(4, Math.ceil((v / max) * 4)) : 0;
      h += '<i class="l' + lv + (S.day === x.day ? " on" : "") + '" data-day="' + x.day + '" style="grid-column:' + (c + 1) + ";grid-row:" + (r + 1) + '" title="' + esc(x.day + " · " + t("{0} 个会话", x.sessions) + " · " + fmt(x.tokens) + " token") + '"></i>';
    }
    return h + "</div>" + '<div class="hlegend dim">' + esc(t("少")) + ' <i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> ' + esc(t("多")) + "</div>";
  }

  function rankTable(rows, kind, sel, emptyMsg) {
    if (!rows.length) return '<div class="dbx-hint">' + esc(emptyMsg) + "</div>";
    const max = Math.max(...rows.map(r => r.count));
    return '<div class="rank">' + rows.map((r, i) => {
      const c = PALETTE[i % PALETTE.length];
      return '<div class="rk' + (sel === r.name ? " on" : "") + '" data-k="' + kind + '" data-v="' + esc(r.name) + '" title="' + esc(r.name) + '"><div class="rt1"><i style="background:' + c + '"></i><span class="rn">' + esc(r.label || r.name) + '</span><b>×' + r.count + '</b></div><div class="rb"><i style="width:' + Math.max(3, (r.count / max) * 100) + "%;background:" + c + '"></i></div></div>';
    }).join("") + "</div>";
  }

  // ───────── 洞察页 ─────────
  function rangeLabel(o) {
    if (o.day) return o.day;
    if (o.range === "custom") return o.from + " → " + o.to;
    if (o.range === "all") return t("全部记录");
    return o.range === "today" ? t("今天") : t("最近 {0} 天", o.range);
  }

  function sessionCard(s) {
    const ctxPct = S.ov.contextLimit && s.ctx ? Math.round((s.ctx / S.ov.contextLimit) * 100) : null;
    const bad = s.reason && s.reason !== "final";
    return '<div class="scard" data-n="' + esc(s.name) + '">' +
      '<div class="s-t">' + esc(s.input || s.name) + "</div>" +
      '<div class="s-m">' + esc(s.provider || "?") + (s.model ? " · " + esc(s.model) : "") + " · " + esc(when(s.lastActive)) + (s.agent ? ' <span class="badge">Agent</span>' : "") + (s.agentEstimate ? ' <span class="badge" title="' + esc(t("Agent 不回传 token 用量：按提示词和过程文本估算，偏低")) + '">' + esc(t("估算")) + "</span>" : "") + "</div>" +
      '<div class="s-n"><span><b>' + fmt(s.tokens) + "</b> token</span><span>" + esc(money(s.cost)) + "</span><span>" + esc(t("{0} 步", s.steps)) + "</span><span>" + esc(t("{0} 次工具", s.tools)) + "</span></div>" +
      stack(s.comp, 6) +
      '<div class="s-c"><span>' + esc(t("上下文")) + " " + (s.ctx ? fmt(s.ctx) + (s.ctxEstimated ? "~" : "") + (ctxPct != null ? " · " + ctxPct + "%" : "") : "—") + "</span>" +
      (s.reason ? '<span class="' + (bad ? "warn" : "ok") + '">' + esc(t(REASON[s.reason] || s.reason)) + "</span>" : '<span class="dim">' + esc(t("未结束")) + "</span>") + "</div></div>";
  }

  function balanceChip(b) {
    if (!b || b.enabled === false) return "";
    const who = b.label || b.provider || "";
    // 当前提供方没有「用 key 查余额」的接口（Cursor / OpenAI / Anthropic 等）：给一个灰色小标签说明，不是报错
    if (b.unsupported) return '<button type="button" class="chip bal dim" id="bal" title="' + esc(b.reason + "\n" + t("点击刷新")) + '">' + esc(b.provider + " · " + t("无余额接口")) + "</button>";
    if (!b.available) return b.failed ? '<button type="button" class="chip bal err" id="bal" title="' + esc(b.reason) + '">' + esc(t("{0} 余额查询失败", who)) + "</button>" : "";
    const main = b.balances.find(x => x.currency === "CNY") || b.balances[0];
    const sy = main.currency === "CNY" ? "¥" : main.currency === "USD" ? "$" : main.currency + " ";
    const tip = b.balances.map(x => x.currency + " " + t("充值 {0} · 赠金 {1}", x.toppedUp.toFixed(2), x.granted.toFixed(2))).join("\n") + "\n" + t("点击刷新");
    return '<button type="button" class="chip bal' + (b.usable ? "" : " err") + '" id="bal" title="' + esc((b.provider ? b.provider + "\n" : "") + tip) + '">' + esc(who) + " " + esc(t("余额")) + " " + sy + main.total.toFixed(2) + "</button>";
  }

  function viewInsights() {
    const o = S.ov;
    if (!o) return '<div class="dbx-hint pad">' + esc(t("加载中…")) + "</div>";
    const k = o.kpi, tm = o.timing || {};
    const filters = [["day", S.day, t("日期")], ["skill", S.skill, t("技能")], ["tool", S.tool, t("工具")], ["command", S.command, t("命令")]].filter(f => f[1]);
    const presetOn = r => !S.day && !S.from && S.range === r;
    let h = '<div class="ihead"><div class="il"><button type="button" class="ghost" id="pset">⚙ ' + esc(t("插件设置")) + '</button><span id="balSlot">' + balanceChip(S.bal) + "</span></div>" +
      '<div class="ir"><input type="date" id="dFrom" value="' + esc(o.from) + '" max="' + esc(o.today) + '" /><span class="dim">→</span><input type="date" id="dTo" value="' + esc(o.to) + '" max="' + esc(o.today) + '" />' +
      '<div class="seg" id="rangeSeg">' + [["today", t("今天")], ["7", t("近 7 天")], ["30", t("近 30 天")], ["all", t("全部")]].map(r =>
        '<button type="button" data-r="' + r[0] + '" class="' + (presetOn(r[0]) ? "on" : "") + '">' + esc(r[1]) + "</button>").join("") + "</div></div></div>";
    if (filters.length) h += '<div class="chips">' + esc(t("筛选")) + "：" + filters.map(f => '<span class="chip" data-clear="' + f[0] + '">' + esc(f[2] + " " + f[1]) + " ×</span>").join("") + "</div>";

    // 上排：6 个指标 + 双轴用量图
    const costSub = k.cost == null ? esc(t("没有匹配的单价")) : esc(t("{0} 个会话已计价", k.pricedSessions || 0)) + (k.agentSessions ? "<br>" + esc(t("含 {0} 个外部 Agent 会话（按过程文本估算，偏低）", k.agentSessions)) : "");
    h += '<div class="grid2 top2"><div class="tiles">' +
      tile(t("全部会话"), fmt(k.sessions), k.agentSessions ? esc(t("其中外部 Agent {0} 个", k.agentSessions)) : esc(rangeLabel(o))) +
      tile(t("累计 Token"), fmt(k.tokens), esc(t("输入 {0} / 输出 {1}", fmt(k.input), fmt(k.output)))) +
      tile(t("估算成本"), money(k.cost), costSub) +
      tile(t("缓存命中率"), "—", esc(t("M-Harness 的 trace 不记录缓存命中")), true) +
      tile(t("模型调用"), fmt(k.steps), esc(t("{0} 次运行", k.turns)) + (tm.modelMs ? "<br>" + esc(t("累计 {0}", dur(tm.modelMs))) : "")) +
      tile(t("工具执行"), fmt(k.toolExec), (tm.toolMs ? esc(t("累计 {0}", dur(tm.toolMs))) + "<br>" : "") + esc(t("MCP {0} · 插件 {1} · 技能 {2}", k.mcpCalls || 0, k.pluginCalls || 0, k.skillUses || 0))) + "</div>" +
      box(t("Token 和成本"), weekChart(o.week, o.anyPrice), "", '<span class="dim">' + esc(t("点柱子按天筛选")) + "</span>") + "</div>";

    // 中排：Token 统计 + 耗时统计
    const all = sum(o.comp);
    const tokenBody = '<div class="dn"><div class="dn-c">' + donut(CATS.map(c => ({ v: o.comp[c[0]] || 0, c: c[2] })), fmt(all), t("总 Token")) + '</div><div class="dn-l two">' +
      CATS.map(c => { const v = o.comp[c[0]] || 0; return lrow(c[2], t(c[1]), v ? pct(v, all) : "—", v ? "≈" + fmt(v) : "", !v); }).join("") + "</div></div>" +
      '<div class="dbx-hint">' + esc(t("按计费 token 汇总：每次模型调用都会重新带上之前的上下文。")) + "</div>";
    const totalMs = k.activeMs || 0;
    const timeBody = totalMs > 0
      ? '<div class="dn"><div class="dn-c">' + donut([{ v: tm.modelMs, c: "#3b82f6" }, { v: tm.toolMs, c: "#f59e0b" }, { v: tm.overheadMs, c: "#94a3b8" }], dur(totalMs), t("活跃时长")) + '</div><div class="dn-l">' +
        lrow("#3b82f6", t("模型调用"), pct(tm.modelMs, totalMs), dur(tm.modelMs) + " · " + t("{0} 次", tm.modelCalls)) +
        lrow("#f59e0b", t("工具调用"), pct(tm.toolMs, totalMs), dur(tm.toolMs) + " · " + t("{0} 次", tm.toolCalls)) +
        lrow("#94a3b8", t("其他开销"), pct(tm.overheadMs, totalMs), dur(tm.overheadMs)) +
        '<div class="speed"><span class="dim">' + esc(t("输出速度")) + "</span> <b>" + (tm.speed ? tm.speed.toFixed(1) + " tok/s" : "—") + "</b></div></div></div>" +
        '<div class="dbx-hint">' + esc(t("模型调用没有再拆成等待 / 思考 / 回复：M-Harness 的 trace 没有流式时间戳。输出速度只统计有真实 token 用量的调用。")) + "</div>"
      : none();
    h += '<div class="grid2">' + box(t("Token 统计"), tokenBody) + box(t("耗时统计"), timeBody) + "</div>";

    // 下排：活跃度 / 技能加载 / 工具调用 / 命令执行，再加 MCP / 插件工具
    const tt = o.totals || {};
    const sumTxt = (x, a, b) => '<span class="dim">' + esc(a(x ? x.n : 0) + " · " + b(x ? x.count : 0)) + "</span>";
    const heatSeg = '<div class="seg sm" id="heatSeg">' + [["sessions", t("会话")], ["tokens", t("Token 消耗")]].map(m => '<button type="button" data-h="' + m[0] + '" class="' + (S.heat === m[0] ? "on" : "") + '">' + esc(m[1]) + "</button>").join("") + "</div>";
    h += '<div class="grid-rank">' +
      box(t("活跃度"), heatmap(o.heat, S.heat), "", heatSeg) +
      box(t("技能加载"), rankTable(o.skills, "skill", S.skill, t("这段时间没有调用技能（use_skill 或读取 SKILL.md）。")), "", sumTxt(tt.skills, n => t("{0} 个技能", n), n => t("{0} 次加载", n))) +
      box(t("工具调用"), rankTable(o.tools, "tool", S.tool, t("这段时间没有工具调用。")), "", sumTxt(tt.tools, n => t("{0} 个工具", n), n => t("{0} 次", n))) +
      box(t("命令执行"), rankTable(o.commands, "command", S.command, t("这段时间没有执行命令（run_command）。")), "", sumTxt(tt.commands, n => t("{0} 个程序", n), n => t("{0} 次", n))) + "</div>";
    h += '<div class="grid2">' +
      box(t("MCP 调用"), rankTable(o.mcp || [], "tool", S.tool, t("这段时间没有调用 MCP 工具（mcp__服务__工具）。")), "", sumTxt(tt.mcp, n => t("{0} 个工具", n), n => t("{0} 次", n))) +
      box(t("插件工具"), rankTable(o.plugins || [], "tool", S.tool, t("这段时间没有调用插件工具（plugin__插件__工具）。")), "", sumTxt(tt.plugins, n => t("{0} 个工具", n), n => t("{0} 次", n))) + "</div>";

    // 会话列表
    // 会话很多：整块能折叠（记住上次的状态），默认只铺开前 SESS_STEP 张，其余点「显示更多」；按提供方分组时每组也能单独折叠
    const open = S.sessOpen;
    const shown = o.sessions.slice(0, S.sessMax);
    h += '<div class="sechead"><button type="button" class="fold" id="sessFold" aria-expanded="' + open + '" title="' + esc(open ? t("折叠会话列表") : t("展开会话列表")) + '">' + (open ? "▾" : "▸") + '</button><h2 class="sec" id="sessTitle">' + esc(t("会话")) + ' <span class="badge">' + o.total + "</span>" + (o.total > o.sessions.length ? ' <span class="dim">' + esc(t("仅显示前 {0} 个", o.sessions.length)) + "</span>" : "") + "</h2>" +
      (open
        ? '<input id="q" class="search" type="search" placeholder="' + esc(t("搜索会话：内容 / 模型 / 名字")) + '" value="' + esc(S.q) + '" />' +
          '<select id="group"><option value="none">' + esc(t("不分组")) + '</option><option value="provider">' + esc(t("按提供方分组")) + "</option></select>" +
          '<div class="seg" id="sortSeg">' + [["recent", t("最近更新")], ["tokens", t("Token 总用量")], ["context", t("当前上下文")]].map(s =>
            '<button type="button" data-s="' + s[0] + '" class="' + (S.sort === s[0] ? "on" : "") + '">' + esc(s[1]) + "</button>").join("") + "</div>"
        : '<span class="dim sp">' + esc(t("已折叠")) + "</span>") + "</div>";
    if (!open) return h;
    if (!o.sessions.length) h += empty(t("这段时间没有会话"), t("在 M-Harness 里跑一次任务，这里就会出现；目录不对可以到设置里修改 trace 目录。"));
    else {
      if (S.group === "provider") {
        const groups = new Map();
        shown.forEach(s => { const g = (s.provider || "?") + (s.model ? " · " + s.model : ""); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); });
        groups.forEach((list, g) => {
          const shut = S.grpShut.has(g);
          h += '<h4 class="grp"><button type="button" class="fold sm" data-grp="' + esc(g) + '" aria-expanded="' + !shut + '">' + (shut ? "▸" : "▾") + "</button> " + esc(g) + ' <span class="dim">' + list.length + "</span></h4>" + (shut ? "" : '<div class="cards">' + list.map(sessionCard).join("") + "</div>");
        });
      } else h += '<div class="cards">' + shown.map(sessionCard).join("") + "</div>";
      const rest = o.sessions.length - shown.length;
      if (rest > 0 || S.sessMax > SESS_STEP) {
        h += '<div class="more">' + (rest > 0 ? '<button type="button" id="sessMore">' + esc(t("显示更多（还有 {0} 个）", rest)) + "</button>" : "") + (S.sessMax > SESS_STEP ? '<button type="button" id="sessLess">' + esc(t("收起到前 {0} 个", SESS_STEP)) + "</button>" : "") + "</div>";
      }
    }
    return h;
  }

  function bindInsights() {
    view.querySelectorAll("#rangeSeg [data-r]").forEach(b => { b.onclick = () => { S.range = b.getAttribute("data-r"); S.day = ""; S.from = S.to = ""; rpc("prefs/set", { range: S.range }).then(p => { S.prefs = p; }).catch(() => {}); loadOverview(); }; });
    const dFrom = $("dFrom"), dTo = $("dTo");
    const pickDates = () => {
      const a = dFrom.value, b = dTo.value;
      if (!a && !b) return;
      S.from = a || b; S.to = b || a; S.day = ""; loadOverview();
    };
    if (dFrom) dFrom.onchange = pickDates;
    if (dTo) dTo.onchange = pickDates;
    view.querySelectorAll("[data-day]").forEach(b => { b.onclick = () => { const d = b.getAttribute("data-day"); S.day = S.day === d ? "" : d; loadOverview(); }; });
    view.querySelectorAll("[data-clear]").forEach(b => { b.onclick = () => { S[b.getAttribute("data-clear")] = ""; loadOverview(); }; });
    view.querySelectorAll(".rk").forEach(b => { b.onclick = () => { const kd = b.getAttribute("data-k"), v = b.getAttribute("data-v"); S[kd] = S[kd] === v ? "" : v; loadOverview(); }; });
    view.querySelectorAll(".scard").forEach(b => { b.onclick = () => openSession(b.getAttribute("data-n")); });
    view.querySelectorAll("#heatSeg [data-h]").forEach(b => { b.onclick = () => { S.heat = b.getAttribute("data-h"); paint(); }; });
    view.querySelectorAll("#sortSeg [data-s]").forEach(b => { b.onclick = () => { S.sort = b.getAttribute("data-s"); loadOverview(); }; });
    const fold = () => { S.sessOpen = !S.sessOpen; lsSet("ci.sessOpen", S.sessOpen ? "1" : "0"); paint(); };
    if ($("sessFold")) $("sessFold").onclick = fold;
    if ($("sessTitle")) $("sessTitle").onclick = fold;
    if ($("sessMore")) $("sessMore").onclick = () => { S.sessMax += SESS_STEP * 2; paint(); };
    if ($("sessLess")) $("sessLess").onclick = () => { S.sessMax = SESS_STEP; paint(); };
    view.querySelectorAll("[data-grp]").forEach(b => { b.onclick = () => { const g = b.getAttribute("data-grp"); if (S.grpShut.has(g)) S.grpShut.delete(g); else S.grpShut.add(g); paint(); }; });
    const pset = $("pset"), group = $("group"), q = $("q");
    if (pset) pset.onclick = openSettings;
    bindBalance();
    if (group) { group.value = S.group; group.onchange = () => { S.group = group.value; paint(); }; }
    if (q) {
      let timer;
      q.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { S.q = q.value.trim(); loadOverview(true); }, 280); };
    }
  }

  function bindBalance() { const b = $("bal"); if (b) b.onclick = () => loadBalance(true); }
  // 余额只更新页头那一小块，不重绘整页（免得打断搜索输入）
  function loadBalance(force) {
    return rpc("balance/get", { force: !!force }, 15000).then(b => {
      S.bal = b;
      const slot = $("balSlot");
      if (slot) { slot.innerHTML = balanceChip(b); bindBalance(); }
    }).catch(() => {});
  }

  function loadOverview(keepFocus) {
    const seq = ++S.seq;
    S.sessMax = SESS_STEP; // 换了范围 / 筛选 / 搜索 / 排序，会话列表回到只显示前几张
    const p = { range: S.range, day: S.day, q: S.q, sort: S.sort, skill: S.skill, tool: S.tool, command: S.command };
    if (!S.day && S.from && S.to) { p.from = S.from; p.to = S.to; }
    return rpc("insights/overview", p).then(o => {
      if (seq !== S.seq) return;
      S.ov = o; paint();
      if (keepFocus && $("q")) { const q = $("q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }).catch(e => { if (seq === S.seq) view.innerHTML = fail(e); });
  }

  // ───────── Context 详情 ─────────
  // 分步视图在 ctxview.js 里：这里只负责「选哪个会话、什么时候取数据」
  const CX = window.CIContext.create({ t, esc, fmt, dur, when, pct, money, donut, box, none, empty, rpc, S, lrow, niceMax, CATS, CAT_NA, REASON, openSession });

  function openSession(name) {
    if (name !== S.name) { S.detail = null; CX.reset(); }
    S.name = name; S.tab = "context";
    // 手动选了一个会话：只有选的正好是最新的才继续「跟着最新对话走」
    S.follow = !!(S.sessions && S.sessions.length && S.sessions[0].name === name);
    paintTabs(); paint();
    if (!S.sessions) loadSessions();
    loadDetail();
  }

  function loadDetail() {
    if (!S.name) return Promise.resolve();
    const name = S.name;
    return rpc("session/get", { name }).then(d => {
      if (name !== S.name) return;
      S.detail = d;
      paint();
    }).catch(e => { if (name === S.name) view.innerHTML = fail(e); });
  }

  function loadSessions() {
    return rpc("session/list", { limit: 200 }).then(r => {
      S.sessions = r;
      // 默认看最新的对话（也就是你当前在用的那个）
      if (r.length && (!S.name || S.follow)) {
        if (S.name !== r[0].name) { S.detail = null; CX.reset(); }
        S.name = r[0].name;
      }
      if (S.tab !== "context") return;
      paint();
      if (S.name && !S.detail) loadDetail();
    }).catch(e => { S.sessions = []; if (S.tab === "context") view.innerHTML = fail(e); });
  }

  function miniTable(head, rows) {
    if (!rows.length) return "";
    return '<table class="tbl"><thead><tr>' + head.map(x => "<th>" + esc(x) + "</th>").join("") + "</tr></thead><tbody>" + rows.map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("") + "</tbody></table>";
  }

  function viewContext() {
    if (!S.sessions) return '<div class="dbx-hint pad">' + esc(t("加载中…")) + "</div>";
    if (!S.sessions.length) return empty(t("没有找到 trace 记录"), t("在 M-Harness 里跑一次任务，这里就会出现；目录不对可以到设置里修改 trace 目录。"));
    if (!S.detail) return '<div class="dbx-hint pad">' + esc(t("分析中…")) + "</div>";
    return CX.view(S.detail);
  }
  function bindContext() { if (S.detail) CX.bind(); }

  // ───────── Fleet ─────────
  function viewFleet() {
    const f = S.fleet;
    if (!f) return '<div class="dbx-hint pad">' + esc(t("加载中…")) + "</div>";
    const subs = [];
    f.list.forEach(d => ((d.ctx && d.ctx.subagents) || []).forEach(x => subs.push({ ...x, session: d.input || d.name, name: d.name })));
    subs.sort((a, b) => b.ts - a.ts);
    const subBody = subs.length
      ? '<div class="cx-evs">' + subs.slice(0, 30).map(x => '<div class="cx-ev fl" data-n="' + esc(x.name) + '"><span class="cx-tag" style="--c:#6366f1">' + esc(x.type || "task") + '</span><span class="el" title="' + esc(x.desc) + '">' + esc(x.desc || "—") + '</span><span class="ep">' + esc(t("第 {0} 轮", x.turn) + " · " + t("第 {0} 步", x.step)) + '</span><span class="ed">' + esc(x.ms ? dur(x.ms) : "—") + '</span><span class="et">' + esc(when(x.ts)) + "</span></div>").join("") + "</div>"
      : empty(t("暂无数据"), t("最近的外部 Agent 对话里没有调用子 Agent（task 工具）。"));
    let h = '<div class="grid2">' +
      box(t("子 Agent 任务"), subBody) +
      box(t("外部 Agent 会话"), f.list.length
        ? '<div class="dbx-hint">' + esc(t("使用 cli / cursor-sdk 提供方的会话，只有进度事件，没有真实 token 用量；费用按提示词和过程文本估算（偏低）。")) + "</div>"
        : '<div class="dbx-hint">' + esc(t("最近没有使用外部 Agent 提供方（cli / cursor-sdk）的会话。")) + "</div>") + "</div>";
    if (f.list.length) {
      h += '<div class="cards">' + f.list.map(d => {
        const c = d.fleet.counts, keys = Object.keys(c);
        return '<div class="scard fl" data-n="' + esc(d.name) + '"><div class="s-t">' + esc(d.input || d.name) + '</div><div class="s-m">' + esc(d.provider) + " · " + esc(when(d.startedAt)) + "</div>" +
          '<div class="s-n">' + (keys.length ? keys.map(k => "<span>" + esc(k) + " <b>" + c[k] + "</b></span>").join("") : "<span>" + esc(t("没有进度事件")) + "</span>") + "</div>" +
          '<div class="fl-l">' + d.fleet.last.slice(0, 4).map(l => '<div><span class="dim">' + esc(l.kind) + "</span> " + esc(l.line) + "</div>").join("") + "</div></div>";
      }).join("") + "</div>";
    }
    return h;
  }
  function loadFleet() {
    S.fleet = null; paint();
    return rpc("insights/overview", { range: "30", sort: "recent" }).then(o => {
      const agents = o.sessions.filter(s => s.agent).slice(0, 8);
      return Promise.all(agents.map(s => rpc("session/get", { name: s.name }).catch(() => null))).then(list => { S.fleet = { list: list.filter(Boolean) }; if (S.tab === "fleet") paint(); });
    }).catch(e => { S.fleet = { list: [] }; if (S.tab === "fleet") view.innerHTML = fail(e); });
  }

  // ───────── 设置 ─────────
  function openSettings() {
    $("dlg").innerHTML = '<div class="dbx-hint pad">' + esc(t("加载中…")) + "</div>"; $("modal").hidden = false;
    Promise.all([rpc("prefs/get"), rpc("env/info")]).then(r => { S.prefs = r[0]; renderSettings(r[0], r[1]); }).catch(e => { $("dlg").innerHTML = fail(e) + '<div class="dlg-f"><button type="button" id="dx">' + esc(t("关闭")) + "</button></div>"; $("dx").onclick = closeModal; });
  }
  const closeModal = () => { $("modal").hidden = true; };
  function priceRow(p) {
    return '<div class="prow"><input class="pm" placeholder="' + esc(t("模型名（正则，如 deepseek-chat）")) + '" value="' + esc(p.match) + '" /><input class="pi" type="number" step="any" min="0" placeholder="in" value="' + esc(p.in) + '" /><input class="po" type="number" step="any" min="0" placeholder="out" value="' + esc(p.out) + '" /><button type="button" class="pd" title="' + esc(t("删除")) + '">×</button></div>';
  }
  function renderSettings(p, env) {
    const opt = (v, cur, label) => '<option value="' + v + '"' + (v === cur ? " selected" : "") + ">" + esc(label) + "</option>";
    $("dlg").innerHTML = '<h3>' + esc(t("设置")) + "</h3>" +
      '<div class="frow"><label>' + esc(t("默认时间范围")) + '</label><select id="sRange">' + opt("today", p.range, t("今天")) + opt("7", p.range, t("7 天")) + opt("30", p.range, t("30 天")) + opt("all", p.range, t("全部")) + "</select></div>" +
      '<div class="frow" style="grid-template-columns:120px 1fr 90px"><label>' + esc(t("成本货币")) + '</label><select id="sCur">' + opt("usd", p.currency, "USD ($)") + opt("cny", p.currency, "CNY (¥)") + '</select><input id="sFx" type="number" step="any" min="0.1" title="' + esc(t("汇率：1 美元 = ? 人民币")) + '" value="' + esc(p.fx) + '" /></div>' +
      '<div class="frow col"><label class="chk"><input type="checkbox" id="sBal"' + (p.balance !== false ? " checked" : "") + " /> " + esc(t("在页头显示当前提供方的余额")) + '</label><div class="dim">' + esc(t("查的是当前在用的提供方（最近一次运行用的，没有就是默认提供方）。只有 DeepSeek / Moonshot / SiliconFlow / OpenRouter 有用 key 查余额的接口：会把该提供方的 key 发给它自己的接口（只发这一个地址，key 不会显示在界面里）。Cursor、OpenAI、Anthropic、智谱、命令行 Agent 没有这种接口，不会联网。取消勾选就完全不联网。")) + "</div></div>" +
      '<div class="frow col"><label class="chk"><input type="checkbox" id="sMerge"' + (p.merge !== false ? " checked" : "") + " /> " + esc(t("把续接的运行合成一个对话")) + '</label><div class="dim">' + esc(t("Cursor 对话每发一句话是一次运行；续接上一轮的运行会按时间先后并进同一个提供方最近的对话。两个对话交替使用时可能归错，取消勾选就每次运行单独成一个会话。")) + "</div></div>" +
      '<div class="frow"><label>' + esc(t("默认排序")) + '</label><select id="sSort">' + opt("recent", p.sort, t("按最近活跃")) + opt("tokens", p.sort, t("按 Token 用量")) + opt("context", p.sort, t("按上下文大小")) + "</select></div>" +
      '<div class="frow"><label>' + esc(t("会话分组")) + '</label><select id="sGroup">' + opt("none", p.group, t("不分组")) + opt("provider", p.group, t("按提供方分组")) + "</select></div>" +
      '<div class="frow col"><label>' + esc(t("trace 目录")) + '</label><input id="sDir" placeholder="' + esc(env.active || "") + '" value="' + esc(env.override || "") + '" /><div class="dim">' + esc(t("当前：{0}（留空 = 自动查找）", env.active || t("没有找到 trace 目录"))) + "</div></div>" +
      '<div class="frow col"><label>' + esc(t("成本单价（美元 / 百万 token）")) + '</label><div class="dim">' + esc(t("自定义的优先于内置；模型名按正则匹配，不区分大小写。不联网拉取价格。")) + '</div><div id="prices">' + (p.prices || []).map(priceRow).join("") + '</div><button type="button" id="addPrice" class="ghost">+ ' + esc(t("添加单价")) + "</button>" +
      "<details><summary>" + esc(t("内置单价表")) + "</summary>" + miniTable([t("模型"), "in", "out"], p.builtin.map(b => ["<code>" + esc(b.match) + "</code>", b.in, b.out])) + "</details></div>" +
      '<div class="dlg-f"><button type="button" id="sCancel" class="ghost">' + esc(t("取消")) + '</button><button type="button" id="sSave">' + esc(t("保存")) + "</button></div>";
    const bindDel = () => $("prices").querySelectorAll(".pd").forEach(b => { b.onclick = () => b.parentNode.remove(); });
    bindDel();
    $("addPrice").onclick = () => { $("prices").insertAdjacentHTML("beforeend", priceRow({ match: "", in: "", out: "" })); bindDel(); };
    $("sCancel").onclick = closeModal;
    $("sSave").onclick = () => {
      const prices = [...$("prices").querySelectorAll(".prow")].map(r => ({ match: r.querySelector(".pm").value.trim(), in: Number(r.querySelector(".pi").value) || 0, out: Number(r.querySelector(".po").value) || 0 })).filter(x => x.match);
      const dir = $("sDir").value.trim();
      rpc("env/setTraceDir", { dir }).then(() => rpc("prefs/set", { range: $("sRange").value, sort: $("sSort").value, group: $("sGroup").value, currency: $("sCur").value, fx: Number($("sFx").value) || 7.2, balance: $("sBal").checked, merge: $("sMerge").checked, prices })).then(r => {
        S.prefs = r; S.range = r.range; S.sort = r.sort; S.group = r.group; S.day = ""; S.from = S.to = ""; closeModal(); toast(t("已保存"));
        refresh();
        if (S.tab === "insights") loadBalance(true);
      }).catch(e => toast(errText(e), true));
    };
  }

  // ───────── 框架 ─────────
  function paintTabs() {
    $("tabs").querySelectorAll("[data-tab]").forEach(b => {
      const k = b.getAttribute("data-tab");
      b.textContent = k === "insights" ? t("洞察") : k === "context" ? "Context" : "Fleet";
      b.classList.toggle("on", k === S.tab);
    });
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    $("brandName").textContent = t("上下文洞察");
    $("lang").querySelectorAll("[data-l]").forEach(b => b.classList.toggle("on", b.getAttribute("data-l") === lang));
    $("refresh").title = t("刷新"); $("settings").title = t("设置");
  }
  function paint() {
    const keepScroll = view.scrollTop;
    if (S.tab === "insights") { view.innerHTML = viewInsights(); bindInsights(); }
    else if (S.tab === "context") { view.innerHTML = viewContext(); bindContext(); }
    else { view.innerHTML = viewFleet(); view.querySelectorAll(".fl").forEach(b => { b.onclick = () => openSession(b.getAttribute("data-n")); }); }
    view.scrollTop = keepScroll;
  }
  function refresh() {
    if (S.tab === "insights") return loadOverview();
    if (S.tab === "context") { S.detail = null; return loadSessions(); }
    return loadFleet();
  }
  function setTab(k) {
    S.tab = k; paintTabs();
    if (k === "insights") { if (S.ov) paint(); loadOverview(); }
    else if (k === "context") { paint(); loadSessions(); }
    else loadFleet();
  }
  function setLang(l) {
    if (l === lang) return;
    lang = l; lsSet("ci.lang", l);
    rpc("prefs/set", { lang: l }, 8000).catch(() => {});
    paintTabs(); paint();
    if (!$("modal").hidden) openSettings();
  }

  $("tabs").querySelectorAll("[data-tab]").forEach(b => { b.onclick = () => setTab(b.getAttribute("data-tab")); });
  $("lang").querySelectorAll("[data-l]").forEach(b => { b.onclick = () => setLang(b.getAttribute("data-l")); });
  $("refresh").onclick = refresh;
  $("settings").onclick = openSettings;
  $("modal").addEventListener("click", e => { if (e.target === $("modal")) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

  paintTabs();
  rpc("prefs/get").then(p => { S.prefs = p; S.range = p.range; S.sort = p.sort; S.group = p.group; }).catch(() => {}).then(() => { loadOverview().then(() => loadBalance()); });
})();
