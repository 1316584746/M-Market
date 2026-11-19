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
    ["injected", "注入上下文", "#ec4899"],
    ["skill", "技能", "#f97316"],
    ["toolcalls", "工具调用与结果", "#f59e0b"],
    ["reasoning", "推理", "#14b8a6"],
    ["answers", "回答", "#10b981"],
  ];
  const CAT_NA = { tools: 1, injected: 1, reasoning: 1 };
  const REASON = { final: "完成", max_steps: "达到步数上限", error: "出错", aborted: "已中止", cancelled: "已取消" };

  const S = {
    tab: "insights", range: "7", day: "", q: "", sort: "recent", group: "none", skill: "", tool: "", command: "",
    ov: null, runs: null, name: "", detail: null, step: null, msgs: null, fleet: null, seq: 0, prefs: null,
  };

  // ───────── 格式化 ─────────
  const fmt = n => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)); };
  const money = c => c == null ? "—" : c === 0 ? "$0" : c < 0.01 ? "<$0.01" : "$" + c.toFixed(c < 1 ? 3 : 2);
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
    return '<div class="tile' + (ph ? " ph" : "") + '"><div class="v">' + esc(value) + '</div><div class="k">' + esc(label) + "</div>" + (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div>";
  }
  const box = (title, body, cls, right) => '<section class="box ' + (cls || "") + '"><h3><span>' + esc(title) + "</span>" + (right || "") + "</h3>" + body + "</section>";
  const kv = (k, v) => '<div class="kv"><span>' + esc(k) + "</span><b>" + v + "</b></div>";

  function weekChart(week) {
    const W = 420, H = 150, L = 6, B = 22, T = 14, n = week.length;
    const max = Math.max(1, ...week.map(w => w.tokens));
    const slot = (W - L * 2) / n, bw = Math.min(40, slot - 10);
    let g = '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">';
    g += '<line x1="' + L + '" x2="' + (W - L) + '" y1="' + (H - B) + '" y2="' + (H - B) + '" stroke="currentColor" opacity=".15"/>';
    week.forEach((w, i) => {
      const h = Math.max(w.tokens ? 2 : 0, (H - B - T) * (w.tokens / max));
      const x = L + i * slot + (slot - bw) / 2;
      const on = S.day === w.day;
      g += '<g class="bar' + (on ? " on" : "") + '" data-day="' + w.day + '"><rect x="' + x + '" y="' + (H - B - h) + '" width="' + bw + '" height="' + h + '" rx="3"><title>' + esc(w.day + " · " + fmt(w.tokens) + " token" + (w.cost ? " · " + money(w.cost) : "")) + "</title></rect>";
      if (w.tokens) g += '<text x="' + (x + bw / 2) + '" y="' + (H - B - h - 3) + '" text-anchor="middle">' + fmt(w.tokens) + "</text>";
      g += '<text x="' + (x + bw / 2) + '" y="' + (H - 7) + '" text-anchor="middle">' + w.day.slice(5) + "</text></g>";
    });
    return g + "</svg>";
  }

  function heatmap(heat) {
    const max = Math.max(1, ...heat.map(h => h.tokens));
    const cols = Math.ceil(heat.length / 7);
    let h = '<div class="heat" style="grid-template-columns:repeat(' + cols + ',22px)">';
    for (let c = 0; c < cols; c++) for (let r = 0; r < 7; r++) {
      const x = heat[c * 7 + r];
      if (!x) { h += "<i></i>"; continue; }
      const lv = x.tokens ? Math.min(4, Math.ceil((x.tokens / max) * 4)) : 0;
      h += '<i class="l' + lv + (S.day === x.day ? " on" : "") + '" data-day="' + x.day + '" style="grid-column:' + (c + 1) + ";grid-row:" + (r + 1) + '" title="' + esc(x.day + " · " + fmt(x.tokens) + " token") + '"></i>';
    }
    return h + "</div>";
  }

  function rankTable(rows, kind, sel, emptyMsg) {
    if (!rows.length) return '<div class="dbx-hint">' + esc(emptyMsg) + "</div>";
    const max = Math.max(...rows.map(r => r.count));
    return '<div class="rank">' + rows.slice(0, 12).map(r =>
      '<div class="rk' + (sel === r.name ? " on" : "") + '" data-k="' + kind + '" data-v="' + esc(r.name) + '" title="' + esc(r.name) + '"><span class="rn">' + esc(r.name) + '</span><span class="rb"><i style="width:' + (r.count / max) * 100 + '%"></i></span><b>' + r.count + "</b></div>"
    ).join("") + "</div>";
  }

  // ───────── 洞察页 ─────────
  function rangeLabel(o) {
    if (o.day) return o.day;
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

  function viewInsights() {
    const o = S.ov;
    if (!o) return '<div class="dbx-hint pad">' + esc(t("加载中…")) + "</div>";
    const k = o.kpi;
    const filters = [["day", S.day, t("日期")], ["skill", S.skill, t("技能")], ["tool", S.tool, t("工具")], ["command", S.command, t("命令")]].filter(f => f[1]);
    let h = '<div class="toolbar"><div class="seg" id="rangeSeg">' + [["today", t("今天")], ["7", t("7 天")], ["30", t("30 天")]].map(r =>
      '<button type="button" data-r="' + r[0] + '" class="' + (!S.day && S.range === r[0] ? "on" : "") + '">' + esc(r[1]) + "</button>").join("") + "</div>" +
      '<input id="q" class="search" type="search" placeholder="' + esc(t("搜索会话：内容 / 模型 / 名字")) + '" value="' + esc(S.q) + '" />' +
      '<select id="sort"><option value="recent">' + esc(t("按最近活跃")) + '</option><option value="tokens">' + esc(t("按 Token 用量")) + '</option><option value="context">' + esc(t("按上下文大小")) + "</option></select>" +
      '<select id="group"><option value="none">' + esc(t("不分组")) + '</option><option value="provider">' + esc(t("按提供方分组")) + "</option></select></div>";
    if (filters.length) h += '<div class="chips">' + esc(t("筛选")) + "：" + filters.map(f => '<span class="chip" data-clear="' + f[0] + '">' + esc(f[2] + " " + f[1]) + " ×</span>").join("") + "</div>";

    h += '<div class="tiles">' +
      tile(t("会话"), fmt(k.sessions), esc(rangeLabel(o))) +
      tile(t("累计 Token"), fmt(k.tokens), esc(t("输入 {0} / 输出 {1}", fmt(k.input), fmt(k.output)))) +
      tile(t("估算成本"), money(k.cost), k.cost == null ? esc(t("没有匹配的单价")) : esc(t("按设置里各提供方的模型计价")) + (k.agentSessions ? "<br>" + esc(t("含 {0} 个外部 Agent 会话（按过程文本估算，偏低）", k.agentSessions)) : "")) +
      tile(t("缓存命中率"), "—", none(), true) +
      tile(t("模型调用"), fmt(k.steps), esc(t("{0} 次运行", k.turns))) +
      tile(t("工具执行"), fmt(k.toolExec), esc(t("活跃 {0}", dur(k.activeMs)))) + "</div>";

    h += '<div class="grid2">' +
      box(t("最近 7 天用量"), weekChart(o.week), "", '<span class="dim">' + esc(t("点柱子按天筛选")) + "</span>") +
      box(t("近 8 周热力图"), heatmap(o.heat) + '<div class="hlegend dim">' + esc(t("少")) + " <i class=\"l0\"></i><i class=\"l1\"></i><i class=\"l2\"></i><i class=\"l3\"></i><i class=\"l4\"></i> " + esc(t("多")) + "</div>") + "</div>";

    h += box(t("上下文构成"), stack(o.comp, 14) + legend(o.comp) + '<div class="dbx-hint">' + esc(t("按计费 token 汇总：每次模型调用都会重新带上之前的上下文。")) + "</div>");

    h += '<div class="grid3">' +
      box(t("技能"), rankTable(o.skills, "skill", S.skill, t("这段时间没有调用技能（use_skill）。"))) +
      box(t("工具"), rankTable(o.tools, "tool", S.tool, t("这段时间没有工具调用。"))) +
      box(t("命令"), rankTable(o.commands, "command", S.command, t("这段时间没有执行命令（run_command）。"))) + "</div>";

    h += '<h2 class="sec">' + esc(t("会话")) + ' <span class="dim">' + esc(t("{0} 个", o.total)) + (o.total > o.sessions.length ? " · " + esc(t("仅显示前 {0} 个", o.sessions.length)) : "") + "</span></h2>";
    if (!o.sessions.length) h += empty(t("这段时间没有会话"), t("在 M-Harness 里跑一次任务，这里就会出现；目录不对可以到设置里修改 trace 目录。"));
    else if (S.group === "provider") {
      const groups = new Map();
      o.sessions.forEach(s => { const g = (s.provider || "?") + (s.model ? " · " + s.model : ""); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); });
      groups.forEach((list, g) => { h += '<h4 class="grp">' + esc(g) + ' <span class="dim">' + list.length + '</span></h4><div class="cards">' + list.map(sessionCard).join("") + "</div>"; });
    } else h += '<div class="cards">' + o.sessions.map(sessionCard).join("") + "</div>";
    return h;
  }

  function bindInsights() {
    view.querySelectorAll("#rangeSeg [data-r]").forEach(b => { b.onclick = () => { S.range = b.getAttribute("data-r"); S.day = ""; rpc("prefs/set", { range: S.range }).catch(() => {}); loadOverview(); }; });
    view.querySelectorAll("[data-day]").forEach(b => { b.onclick = () => { const d = b.getAttribute("data-day"); S.day = S.day === d ? "" : d; loadOverview(); }; });
    view.querySelectorAll("[data-clear]").forEach(b => { b.onclick = () => { S[b.getAttribute("data-clear")] = ""; loadOverview(); }; });
    view.querySelectorAll(".rk").forEach(b => { b.onclick = () => { const kd = b.getAttribute("data-k"), v = b.getAttribute("data-v"); S[kd] = S[kd] === v ? "" : v; loadOverview(); }; });
    view.querySelectorAll(".scard").forEach(b => { b.onclick = () => openSession(b.getAttribute("data-n")); });
    const sort = $("sort"), group = $("group"), q = $("q");
    if (sort) { sort.value = S.sort; sort.onchange = () => { S.sort = sort.value; loadOverview(); }; }
    if (group) { group.value = S.group; group.onchange = () => { S.group = group.value; paint(); }; }
    if (q) {
      let timer;
      q.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { S.q = q.value.trim(); loadOverview(true); }, 280); };
    }
  }

  function loadOverview(keepFocus) {
    const seq = ++S.seq;
    return rpc("insights/overview", { range: S.range, day: S.day, q: S.q, sort: S.sort, skill: S.skill, tool: S.tool, command: S.command }).then(o => {
      if (seq !== S.seq) return;
      S.ov = o; paint();
      if (keepFocus && $("q")) { const q = $("q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }).catch(e => { if (seq === S.seq) view.innerHTML = fail(e); });
  }

  // ───────── Context 详情 ─────────
  function openSession(name) {
    S.name = name; S.detail = null; S.step = null; S.msgs = null; S.tab = "context";
    paintTabs(); paint();
    loadDetail();
  }

  function loadDetail() {
    if (!S.name) return Promise.resolve();
    const name = S.name;
    return rpc("session/get", { name }).then(d => {
      if (name !== S.name) return;
      S.detail = d;
      S.step = d.trend.length ? d.trend[d.trend.length - 1].step : null;
      paint();
      loadMsgs();
    }).catch(e => { if (name === S.name) view.innerHTML = fail(e); });
  }

  function loadMsgs() {
    if (!S.name || S.step == null) { S.msgs = []; return Promise.resolve(); }
    const name = S.name, step = S.step;
    S.msgs = null; paintMsgs();
    return rpc("session/messages", { name, step }).then(m => { if (name === S.name && step === S.step) { S.msgs = m; paintMsgs(); } }).catch(e => { if (name === S.name && step === S.step) { S.msgs = []; $("msgs").innerHTML = fail(e); } });
  }

  function trendChart(d) {
    const tr = d.trend;
    if (!tr.length) return '<div class="dbx-hint">' + esc(t("这次运行没有模型调用记录。")) + "</div>";
    const W = Math.max(720, tr.length * 26 + 60), H = 190, L = 44, B = 22, T = 14;
    const peak = Math.max(1, ...tr.map(s => s.prompt + s.output));
    const showLimit = d.contextLimit && peak >= d.contextLimit * 0.4;
    const max = showLimit ? Math.max(peak, d.contextLimit) : peak * 1.1;
    const slot = (W - L - 10) / tr.length, bw = Math.min(30, slot - 4);
    const y = v => T + (H - T - B) * (1 - v / max);
    let g = '<div class="scroll"><svg class="chart" viewBox="0 0 ' + W + " " + H + '" style="min-width:' + Math.min(W, 960) + 'px">';
    [0, 0.5, 1].forEach(f => { g += '<line x1="' + L + '" x2="' + (W - 6) + '" y1="' + y(max * f) + '" y2="' + y(max * f) + '" stroke="currentColor" opacity=".12"/><text x="' + (L - 4) + '" y="' + (y(max * f) + 3) + '" text-anchor="end">' + fmt(max * f) + "</text>"; });
    if (showLimit) g += '<line x1="' + L + '" x2="' + (W - 6) + '" y1="' + y(d.contextLimit) + '" y2="' + y(d.contextLimit) + '" stroke="#ef4444" stroke-dasharray="4 3" opacity=".7"/><text x="' + (W - 8) + '" y="' + (y(d.contextLimit) - 3) + '" text-anchor="end" fill="#ef4444">' + esc(t("上限 {0}", fmt(d.contextLimit))) + "</text>";
    tr.forEach((s, i) => {
      const x = L + i * slot + (slot - bw) / 2;
      const yp = y(s.prompt), yt = y(s.prompt + s.output);
      g += '<g class="sbar' + (S.step === s.step ? " on" : "") + '" data-step="' + s.step + '"><title>' + esc(t("第 {0} 步", s.step) + " · " + t("输入 {0} / 输出 {1}", fmt(s.prompt), fmt(s.output)) + " · " + dur(s.ms) + (s.estimated ? " · " + t("估算") : "")) + "</title>" +
        '<rect class="hit" x="' + (x - 2) + '" y="' + T + '" width="' + (bw + 4) + '" height="' + (H - T - B) + '" fill="transparent"/>' +
        '<rect x="' + x + '" y="' + yp + '" width="' + bw + '" height="' + Math.max(1, H - B - yp) + '" fill="#3b82f6" opacity="' + (s.estimated ? 0.55 : 1) + '"/>' +
        '<rect x="' + x + '" y="' + yt + '" width="' + bw + '" height="' + Math.max(0, yp - yt) + '" fill="#10b981"/>' +
        (s.trimmed ? '<path d="M' + (x + bw / 2) + " " + (T - 10) + "l5 8h-10z" + '" fill="#f59e0b"><title>' + esc(t("这一步之前发生过压缩")) + "</title></path>" : "") +
        '<text x="' + (x + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + s.step + "</text></g>";
    });
    return g + "</svg></div>" + '<div class="legend"><span><i style="background:#3b82f6"></i>' + esc(t("输入（上下文）")) + '</span><span><i style="background:#10b981"></i>' + esc(t("输出")) + '</span><span><i style="background:#f59e0b"></i>' + esc(t("压缩")) + "</span></div>";
  }

  function eventRow(e) {
    const at = '<span class="dim">' + esc(when(e.ts)) + "</span> ";
    if (e.type === "trim") return at + '<span class="ev trim">' + esc(t("压缩")) + "</span> " + esc(t("第 {0} 步后：{1} → {2} token，丢弃 {3} 条", e.step, fmt(e.before), fmt(e.after), e.dropped));
    if (e.type === "blocked") return at + '<span class="ev bad">' + esc(t("拦截")) + "</span> " + esc(e.name || "") + " " + '<span class="dim">' + esc(e.reason || "") + "</span>";
    if (e.type === "approval") return at + '<span class="ev ' + (e.approved ? "ok" : "bad") + '">' + esc(e.approved ? t("已批准") : t("已拒绝")) + "</span> " + esc(e.name || "");
    if (e.type === "done") return at + '<span class="ev ' + (e.reason === "final" ? "ok" : "bad") + '">' + esc(t("结束")) + "</span> " + esc(t(REASON[e.reason] || e.reason || "")) + (e.error ? ' <span class="warn">' + esc(e.error) + "</span>" : "");
    return at + '<span class="ev">' + esc(t("开始")) + "</span>";
  }

  function miniTable(head, rows) {
    if (!rows.length) return "";
    return '<table class="tbl"><thead><tr>' + head.map(x => "<th>" + esc(x) + "</th>").join("") + "</tr></thead><tbody>" + rows.map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("") + "</tbody></table>";
  }

  function viewContext() {
    const sel = '<div class="toolbar"><select id="runSel" class="grow">' +
      (S.runs || []).map(r => '<option value="' + esc(r.name) + '"' + (r.name === S.name ? " selected" : "") + ">" + esc(when(r.startedAt || r.mtime) + " · " + (r.provider || "?") + " · " + (r.input || r.name).slice(0, 50)) + "</option>").join("") + "</select></div>";
    if (!S.runs) return '<div class="dbx-hint pad">' + esc(t("加载中…")) + "</div>";
    if (!S.runs.length) return empty(t("没有找到 trace 记录"), t("在 M-Harness 里跑一次任务，这里就会出现；目录不对可以到设置里修改 trace 目录。"));
    if (!S.detail) return sel + '<div class="dbx-hint pad">' + esc(t("分析中…")) + "</div>";
    const d = S.detail, st = d.stats, tk = d.tokens, tm = d.timing, cur = d.current;
    const bad = d.reason && d.reason !== "final";
    let h = sel + '<div class="head"><div class="h-t">' + esc(d.input || d.name) + '</div><div class="h-m">' + esc(d.provider || "?") + (d.model ? " · " + esc(d.model) : "") + (d.agent ? ' <span class="badge">Agent</span>' : "") + " · " + esc(when(d.startedAt)) + " · " + (d.reason ? '<span class="' + (bad ? "warn" : "ok") + '">' + esc(t(REASON[d.reason] || d.reason)) + "</span>" : esc(t("未结束"))) + (d.skipped ? ' · <span class="warn">' + esc(d.skipped) + "</span>" : "") + "</div></div>";
    h += '<div class="cgrid">';

    // 1 当前上下文
    h += box(t("当前上下文"), cur
      ? '<div class="big">' + fmt(cur.tokens) + (cur.estimated ? "~" : "") + ' <small>token</small></div>' +
        (cur.pct != null ? '<div class="gauge"><i style="width:' + Math.min(100, cur.pct) + "%;background:" + (cur.pct > 85 ? "#ef4444" : cur.pct > 60 ? "#f59e0b" : "#10b981") + '"></i></div><div class="dim">' + esc(t("占上限 {0}（{1}）", Math.round(cur.pct) + "%", fmt(d.contextLimit))) + "</div>" : '<div class="dim">' + esc(t("未配置上下文上限")) + "</div>") +
        stack(cur.comp, 8) + kv(t("消息数"), cur.msgCount)
      : '<div class="dbx-hint">' + esc(t("没有模型调用记录。")) + "</div>");

    // 2 Token 用量
    h += box(t("Token 用量"),
      '<div class="big">' + fmt(tk.billed) + " <small>" + esc(t("计费")) + "</small></div>" +
      kv(t("输入"), fmt(st.input)) + kv(t("输出"), fmt(st.output)) + kv(t("模型调用"), st.steps) + kv(t("单次最大输入"), fmt(st.peakPrompt)) +
      kv(t("缓存命中率"), none()) + (st.estimated ? '<div class="dim">' + esc(t("部分步骤没有真实用量，已按字数估算。")) + "</div>" : ""));

    // 3 成本
    h += box(t("成本估算"), st.cost != null
      ? '<div class="big">' + esc(money(st.cost)) + "</div>" + kv(t("模型"), esc(d.model)) + kv(t("输入单价"), "$" + d.price.in + " / 1M") + kv(t("输出单价"), "$" + d.price.out + " / 1M") + (d.price.custom ? '<div class="dim">' + esc(t("使用你在设置里自定义的单价。")) + "</div>" : "") + (d.agentEstimate ? '<div class="dim">' + esc(t("这是外部 Agent：它不把 token 用量回传给 M-Harness，这里按你发给它的提示词和它的过程输出估算，不含它内部反复读取上下文的开销，实际花费通常更高。")) + "</div>" : "")
      : '<div class="big">—</div><div class="dim">' + esc(d.model ? t("没有匹配到「{0}」的单价，可以在设置里添加。", d.model) : t("没有从配置里找到这个提供方的模型名，无法估算成本。")) + "</div>");

    // 4 耗时
    const wall = Math.max(tm.wallMs, 1);
    h += box(t("耗时"),
      '<div class="big">' + esc(dur(tm.wallMs)) + "</div>" +
      [[t("模型"), tm.modelMs, "#3b82f6"], [t("工具"), tm.toolMs, "#f59e0b"], [t("其它"), tm.overheadMs, "#94a3b8"]].map(r => '<div class="trow"><span>' + esc(r[0]) + '</span><span class="rb"><i style="width:' + Math.min(100, (r[1] / wall) * 100) + "%;background:" + r[2] + '"></i></span><b>' + esc(dur(r[1])) + "</b></div>").join(""));

    // 5 构成
    const comp = tk.comp, all = sum(comp);
    h += box(t("上下文构成"), stack(comp, 10) + '<table class="tbl"><tbody>' + CATS.map(c => {
      const v = comp[c[0]] || 0;
      return '<tr><td><i class="dot" style="background:' + c[2] + '"></i>' + esc(t(c[1])) + "</td><td class=\"r\">" + (CAT_NA[c[0]] && !v ? '<span class="na" title="' + esc(t("M-Harness 的 trace 里没有这项数据")) + '">—</span>' : fmt(v)) + '</td><td class="r dim">' + (CAT_NA[c[0]] && !v ? "" : pct(v, all)) + "</td></tr>";
    }).join("") + "</tbody></table>", "span2");

    // 6 走势（占两列）
    h += box(t("Token 走势"), trendChart(d), "span2", '<span class="dim">' + esc(t("点柱子查看这一步带了什么")) + "</span>");

    // 7 压缩与事件
    h += box(t("压缩与事件"), (d.events.filter(e => e.type !== "start").length
      ? '<div class="evs">' + d.events.filter(e => e.type !== "start").slice(-30).reverse().map(e => '<div class="evr">' + eventRow(e) + "</div>").join("") + "</div>"
      : '<div class="dbx-hint">' + esc(t("没有压缩、拦截或审批事件。")) + "</div>"), "", '<span class="dim">' + esc(t("压缩 {0} 次", st.trims)) + "</span>");

    // 8 工具与技能
    h += box(t("工具与技能"),
      (d.tools.length ? miniTable([t("工具"), t("次数"), t("耗时"), t("输出")], d.tools.slice(0, 12).map(x => [esc(x.name), x.count, esc(dur(x.ms)), "~" + fmt(x.outTokens)])) : '<div class="dbx-hint">' + esc(t("没有工具调用。")) + "</div>") +
      '<h5>' + esc(t("技能")) + "</h5>" +
      (d.skills.length ? d.skills.map(x => '<span class="tag">' + esc(x.name) + " ×" + x.count + "</span>").join("") : '<div class="dbx-hint">' + esc(t("没有调用技能。")) + "</div>"));

    // 9 命令与文件
    h += box(t("命令与文件"),
      '<h5>' + esc(t("命令")) + "</h5>" +
      (d.commands.programs.length ? d.commands.programs.slice(0, 8).map(x => '<span class="tag' + (x.fails ? " bad" : "") + '">' + esc(x.program) + " ×" + x.count + (x.fails ? " · " + esc(t("失败 {0}", x.fails)) : "") + "</span>").join("") : '<div class="dbx-hint">' + esc(t("没有执行命令。")) + "</div>") +
      (d.commands.runs.length ? '<div class="cmds">' + d.commands.runs.slice(0, 6).map(r => '<div class="cmd' + (r.blocked || r.timedOut || (r.exit != null && r.exit !== 0) ? " bad" : "") + '"><code>' + esc(r.command || t("（被拦截）")) + '</code><span class="dim">' + (r.blocked ? esc(t("拦截")) : r.timedOut ? esc(t("超时")) : r.exit == null ? "" : "exit " + r.exit) + "</span></div>").join("") + "</div>" : "") +
      '<h5>' + esc(t("文件")) + ' <span class="dim">' + esc(t("读 {0} · 写 {1} · 列目录 {2}", st.files.read, st.files.write, st.files.list)) + "</span></h5>" +
      (d.files.length ? '<div class="files">' + d.files.slice(0, 8).map(f => '<div class="file"><code title="' + esc(f.path) + '">' + esc(f.path) + '</code><span class="dim">' + (f.read ? "R" + f.read + " " : "") + (f.write ? "W" + f.write + " " : "") + (f.list ? "L" + f.list : "") + "</span></div>").join("") + "</div>" : '<div class="dbx-hint">' + esc(t("没有文件读写。")) + "</div>"), "span2");

    h += "</div>";
    h += '<h2 class="sec">' + (S.step == null ? esc(t("上下文内容")) : esc(t("第 {0} 步发给模型的内容", S.step))) + "</h2><div id=\"msgs\"></div>";
    return h;
  }

  function msgsHtml() {
    if (S.msgs == null) return '<div class="dbx-hint pad">' + esc(t("加载中…")) + "</div>";
    if (!S.msgs.length) return '<div class="dbx-hint pad">' + esc(t("没有这一步的消息记录。")) + "</div>";
    const colors = Object.fromEntries(CATS.map(c => [c[0], c[2]]));
    return '<div class="msgs">' + S.msgs.map(m =>
      '<details class="msg"><summary><i class="dot" style="background:' + colors[m.cat] + '"></i><span class="mr">' + esc(m.role) + (m.tool ? " · " + esc(m.tool) : "") + '</span><span class="mc dim">' + esc(catLabel(m.cat)) + '</span><span class="mt">~' + fmt(m.tokens) + '</span><span class="mp">' + esc(m.text.slice(0, 120).replace(/\s+/g, " ")) + "</span></summary><pre>" + esc(m.text) + (m.truncated ? "\n…" + esc(t("（已截断）")) : "") + "</pre></details>").join("") + "</div>";
  }
  function paintMsgs() { const el = $("msgs"); if (el) el.innerHTML = msgsHtml(); }

  function bindContext() {
    const sel = $("runSel");
    if (sel) sel.onchange = () => openSession(sel.value);
    view.querySelectorAll(".sbar").forEach(b => { b.onclick = () => { S.step = Number(b.getAttribute("data-step")); view.querySelectorAll(".sbar").forEach(x => x.classList.toggle("on", x === b)); const h = view.querySelector("h2.sec:last-of-type"); if (h) h.textContent = t("第 {0} 步发给模型的内容", S.step); loadMsgs(); }; });
    paintMsgs();
  }

  function loadRuns() {
    return rpc("runs/list", { limit: 80 }).then(r => {
      S.runs = r;
      if (!S.name && r.length) S.name = r[0].name;
      if (S.tab === "context") { paint(); if (S.name && !S.detail) loadDetail(); }
    }).catch(e => { S.runs = []; view.innerHTML = fail(e); });
  }

  // ───────── Fleet ─────────
  function viewFleet() {
    const f = S.fleet;
    if (!f) return '<div class="dbx-hint pad">' + esc(t("加载中…")) + "</div>";
    let h = '<div class="grid2">' +
      box(t("子 Agent 实时卡片"), empty(t("暂无数据"), t("M-Harness 的 trace 不记录子 Agent / 并行任务，这里先占位，保持布局完整。"))) +
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
      '<div class="frow"><label>' + esc(t("默认时间范围")) + '</label><select id="sRange">' + opt("today", p.range, t("今天")) + opt("7", p.range, t("7 天")) + opt("30", p.range, t("30 天")) + "</select></div>" +
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
      rpc("env/setTraceDir", { dir }).then(() => rpc("prefs/set", { range: $("sRange").value, sort: $("sSort").value, group: $("sGroup").value, prices })).then(r => {
        S.range = r.range; S.sort = r.sort; S.group = r.group; S.day = ""; closeModal(); toast(t("已保存"));
        refresh();
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
    if (S.tab === "context") { S.detail = null; return loadRuns().then(() => (S.name ? loadDetail() : null)); }
    return loadFleet();
  }
  function setTab(k) {
    S.tab = k; paintTabs();
    if (k === "insights") { if (S.ov) paint(); loadOverview(); }
    else if (k === "context") { paint(); loadRuns().then(() => { if (S.name && !S.detail) loadDetail(); }); }
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
  rpc("prefs/get").then(p => { S.prefs = p; S.range = p.range; S.sort = p.sort; S.group = p.group; }).catch(() => {}).then(loadOverview);
})();
