// Context 页：单个会话的分步上下文视图（统计、Token、耗时、当前上下文、时间线、上下文浏览器、事件、文件、命令）。
// 由 app.js 在启动时 create(kit) 接上：kit 里是 t / esc / fmt 这些公共函数和页面状态 S。
(function () {
  "use strict";
  // 窗口构成的七类（和上下文环形图一致）：[id, 中文, 颜色]
  const WC = [
    ["system", "系统提示词", "#6366f1"],
    ["tools", "工具定义", "#f59e0b"],
    ["user", "用户消息", "#22c55e"],
    ["injected", "注入内容", "#a855f7"],
    ["skill", "技能注入", "#f97316"],
    ["assistant", "助手消息", "#3b82f6"],
    ["results", "工具结果", "#14b8a6"],
  ];
  // 耗时拆分
  const TM = [
    ["ttft", "首字等待", "#6366f1"],
    ["reasoning", "思考", "#a855f7"],
    ["answers", "回复", "#ec4899"],
    ["args", "工具参数", "#f59e0b"],
    ["tools", "工具执行", "#14b8a6"],
    ["model", "模型调用", "#3b82f6"],
    ["overhead", "开销", "#94a3b8"],
  ];
  // 事件类型：[id, 中文, 颜色, 图标字符]
  const EV = [
    ["trim", "压缩", "#ef4444", "✂"],
    ["skill", "技能", "#f97316", "★"],
    ["blocked", "拦截", "#dc2626", "⊘"],
    ["approval", "审批", "#22c55e", "✔"],
    ["error", "错误", "#ef4444", "!"],
    ["warn", "警告", "#f59e0b", "!"],
  ];
  // 工具来源 / 种类的配色
  const PAL = ["#f97316", "#10b981", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#f59e0b", "#6366f1"];
  // 模型类 trace 里没有的数据（外部 Agent 里这几项也看不到）
  const NA = { system: 1, tools: 1, injected: 1 };

  const sumW = c => WC.reduce((n, k) => n + ((c && c[k[0]]) || 0), 0);

  window.CIContext = {
    create(kit) {
      const { t, esc, fmt, dur, when, pct, money, donut, box, none, empty, rpc, S, lrow, niceMax, CATS } = kit;
      const clock = ts => {
        if (!ts) return "";
        const d = new Date(ts);
        const p = n => String(n).padStart(2, "0");
        return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
      };
      // 这几类在 trace 里没有记录（外部 Agent 里系统提示词也看不到）
      const isNA = (id, v) => !v && (id === "tools" || id === "injected" || (id === "system" && C().agent));
      const wcolor = id => WC.find(c => c[0] === id)[2];
      const signed = n => (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(n));
      const approx = (n, est) => (est ? "≈" : "") + fmt(n);

      const X = {};
      function reset() {
        Object.assign(X, {
          sel: null, gran: "step", mode: "total", fit: false, curve: true,
          brStep: "live", brMode: "total", brDna: false, brQ: "", brSort: "order", brKind: "", brOpen: new Set(["assistant", "results"]), brItem: new Set(), brMore: {}, brData: null, brKey: "", brLoading: false,
          evOff: new Set(), evMax: 30, fileOp: "", fileQ: "", fileOpen: null, fileMax: 20, cmdProg: "", cmdBad: false, cmdOpen: null, cmdMax: 15,
        });
      }
      reset();

      const D = () => S.detail;
      const C = () => S.detail.ctx;

      // ───────── 小部件 ─────────
      function wstack(comp, h, base) {
        const all = base || sumW(comp);
        if (!all) return '<div class="stack" style="height:' + (h || 8) + 'px"></div>';
        return '<div class="stack" style="height:' + (h || 8) + 'px">' + WC.map(c => {
          const v = Math.max(0, (comp && comp[c[0]]) || 0);
          return v > 0 ? '<i style="width:' + (v / all) * 100 + "%;background:" + c[2] + '" title="' + esc(t(c[1]) + " " + fmt(v) + " (" + pct(v, all) + ")") + '"></i>' : "";
        }).join("") + "</div>";
      }
      function wlegend(comp, est) {
        const all = sumW(comp);
        return '<div class="cx-leg">' + WC.map(c => {
          const v = (comp && comp[c[0]]) || 0;
          const na = isNA(c[0], v);
          return '<div class="cx-lg' + (v ? "" : " dim") + '"><i style="background:' + c[2] + '"></i><span class="n">' + esc(t(c[1])) + '</span><span class="v">' + (na ? '<span title="' + esc(t("M-Harness 的 trace 里没有这项数据")) + '">—</span>' : v ? approx(v, est) : "—") + '</span><span class="p">' + (v && all ? pct(v, all) : "") + "</span></div>";
        }).join("") + "</div>";
      }
      const chip = (label, val, color, extra) => '<span class="cx-chip"' + (extra ? " " + extra : "") + ">" + (color ? '<i style="background:' + color + '"></i>' : "") + esc(label) + (val != null ? " <b>" + esc(val) + "</b>" : "") + "</span>";
      const tag = (txt, color) => '<span class="cx-tag" style="--c:' + color + '">' + esc(txt) + "</span>";

      // ───────── 头部：会话选择 ─────────
      function head(d) {
        const bad = d.reason && d.reason !== "final";
        const list = S.sessions || [];
        const sel = '<select id="runSel" class="grow">' + (list.some(r => r.name === S.name) ? "" : '<option value="' + esc(S.name) + '" selected>' + esc(d.input || S.name) + "</option>") + list.map(r => '<option value="' + esc(r.name) + '"' + (r.name === S.name ? " selected" : "") + ">" + esc(when(r.lastActive || r.startedAt) + " · " + (r.provider || "?") + (r.turns > 1 ? " · " + t("{0} 轮", r.turns) : "") + " · " + (r.input || r.name).slice(0, 50)) + "</option>").join("") + "</select>";
        let h = '<div class="toolbar">' + sel + "</div>";
        h += '<div class="head"><div class="h-t">' + esc(d.input || d.name) + '</div><div class="h-m">' + esc(d.provider || "?") + (d.model ? " · " + esc(d.model) : "") + (d.agent ? ' <span class="badge">Agent</span>' : "") + " · " + esc(t("{0} 轮", d.turns || 1)) + " · " + esc(when(d.startedAt)) + " · " + (d.reason ? '<span class="' + (bad ? "warn" : "ok") + '">' + esc(t(kit.REASON[d.reason] || d.reason)) + "</span>" : esc(t("未结束"))) + (d.skipped ? ' · <span class="warn">' + esc(d.skipped) + "</span>" : "") + "</div>";
        if ((d.runs || []).length > 1) h += '<div class="dbx-hint">' + esc(t("{0} 次运行合成一个对话：续接的运行按时间先后归到同一个提供方最近的对话（设置里可以关掉合并）。", d.runs.length)) + "</div>";
        if (C().agent) h += '<div class="dbx-hint">' + esc(t("外部 Agent 不回传 token 用量，也看不到它内部的系统提示词和工具定义：这里的数字是按你能看到的内容（提示词、模型输出、工具结果）估算的累计值，只是下限。")) + "</div>";
        return h + "</div>";
      }

      // ───────── 统计 ─────────
      function statsCard(d) {
        const c = C(), sm = c.summary, ev = sm.events, ops = sm.ops;
        const tile = (k, v, sub) => '<div class="cx-tile"><div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + "</div>" + (sub ? '<div class="s">' + esc(sub) + "</div>" : "") + "</div>";
        const evSum = '<div class="cx-tile wide"><div class="k">' + esc(t("上下文事件")) + '</div><div class="evsum">' +
          EV.filter(e => e[0] !== "warn").map(e => '<span style="color:' + e[2] + '">' + esc(t(e[1])) + " <b>" + (e[0] === "error" ? ev.error + ev.warn : ev[e[0]]) + "</b></span>").join('<i class="sl">/</i>') + "</div></div>";
        const subs = c.subagents || [];
        const ioTotal = c.userInputs + ops.read + ops.write + ops.search;
        let toolChips = c.tools.slice(0, 6).map((x, i) => chip(x.name, x.count, PAL[i % PAL.length])).join("");
        if (c.tools.length > 6) toolChips += '<span class="cx-more">' + esc(t("另 {0} 种", c.tools.length - 6)) + "</span>";
        const prog = c.commands.programs;
        let cmdChips = prog.slice(0, 4).map((x, i) => chip(x.program, x.count, PAL[(i + 3) % PAL.length])).join("");
        if (prog.length > 4) cmdChips += '<span class="cx-more">' + esc(t("另 {0} 个", prog.length - 4)) + "</span>";
        const sec = (title, total, body) => '<div class="cx-sec"><div class="cx-sh"><span>' + esc(title) + "</span><b>" + esc(total) + '</b></div><div class="cx-chips">' + (body || '<span class="dim">' + esc(t("暂无")) + "</span>") + "</div></div>";
        const st = d.stats;
        let h = '<div class="cx-tiles">' + tile(t("轮次"), c.turns.length) + tile(t("步骤"), c.steps.length) + tile(t("技能加载"), ev.skill) + tile(t("回复"), sm.answers) + evSum + "</div>";
        h += '<div class="cx-secs">' +
          sec(t("输入 / 输出"), ioTotal, chip(t("用户"), c.userInputs, "#22c55e") + chip(t("读取"), ops.read, "#3b82f6") + chip(t("写入"), ops.write, "#f59e0b") + chip(t("搜索"), ops.search, "#a855f7")) +
          sec(t("工具调用"), sm.toolCalls, toolChips) +
          sec(t("命令执行"), c.commands.runs.length, cmdChips) +
          '<div class="cx-sec"><div class="cx-sh"><span>' + esc(t("花费")) + "</span><b>" + esc(st.cost != null ? money(st.cost) : "—") + '</b></div><div class="cx-kvs">' +
            '<div><span>' + esc(t("当前会话")) + "</span><b>" + (st.estimated ? "≈" : "") + fmt(d.tokens.billed) + " token</b></div>" +
            '<div><span>' + esc(t("子 Agent")) + "</span><b>" + (subs.length ? esc(t("{0} 个", subs.length)) : "—") + "</b></div></div></div>" +
        "</div>";
        return box(t("上下文统计"), h, "cx-card");
      }

      // ───────── Token 统计 ─────────
      function tokenCard(d) {
        const comp = d.tokens.comp, all = CATS.reduce((n, k) => n + (comp[k[0]] || 0), 0);
        const body = '<div class="dn"><div class="dn-c">' + donut(CATS.map(c => ({ v: comp[c[0]] || 0, c: c[2] })), fmt(all), t("总 Token")) + '</div><div class="dn-l two">' +
          CATS.map(c => { const v = comp[c[0]] || 0, na = kit.CAT_NA[c[0]] && !v; return lrow(c[2], t(c[1]), v ? pct(v, all) : "—", v ? "≈" + fmt(v) : "", !v && !na); }).join("") + "</div></div>" +
          '<div class="dbx-hint">' + esc(d.stats.estimated ? t("按计费 token 汇总（含估算）：每次模型调用都会重新带上之前的上下文。") : t("按计费 token 汇总：每次模型调用都会重新带上之前的上下文。")) + "</div>";
        return box(t("Token 统计"), body, "cx-card", '<span class="dim">' + esc(t("缓存命中率")) + " —</span>");
      }

      // ───────── 耗时统计 ─────────
      function timingCard() {
        const c = C(), tm = c.summary.timing, total = TM.reduce((n, k) => n + (tm[k[0]] || 0), 0);
        if (!total) return box(t("耗时统计"), none(), "cx-card");
        const rows = TM.filter(k => tm[k[0]] > 0);
        let body = '<div class="dn"><div class="dn-c">' + donut(rows.map(k => ({ v: tm[k[0]], c: k[2] })), dur(total), t("活跃时长")) + '</div><div class="dn-l two">' +
          rows.map(k => lrow(k[2], t(k[1]), pct(tm[k[0]], total), dur(tm[k[0]]))).join("") + "</div></div>";
        // 时间条：按步骤先后，每步里各段耗时依次排开
        const segs = [];
        for (const s of c.steps) for (const k of TM) { const v = s.timing[k[0]] || 0; if (v > 0 && v >= total / 4000) { const last = segs[segs.length - 1]; if (last && last.c === k[2]) last.v += v; else segs.push({ v, c: k[2], k: k[1] }); } }
        body += '<div class="cx-strip">' + segs.map(g => '<i style="flex:' + g.v + ";background:" + g.c + '" title="' + esc(t(g.k) + " " + dur(g.v)) + '"></i>').join("") + "</div>";
        body += '<div class="cx-axis"><span>0</span><span>' + esc(dur(total / 2)) + "</span><span>" + esc(dur(total)) + "</span></div>";
        body += '<div class="dbx-hint">' + esc(c.agent ? t("按外部 Agent 的流式进度行的时间戳拆分：首字等待、思考、回复、工具参数、工具执行。") : t("模型调用没有再拆成等待 / 思考 / 回复：M-Harness 的 trace 没有流式时间戳。")) + "</div>";
        const tps = c.summary.tps;
        return box(t("耗时统计"), body, "cx-card", '<span class="dim">' + (tps ? (c.summary.tpsEstimated ? "≈" : "") + tps.toFixed(0) + " tok/s" : "") + "</span>");
      }

      // ───────── 当前上下文 ─────────
      function currentCard(d) {
        const c = C(), live = c.live, total = sumW(live), win = c.agent ? 0 : c.window || 0; // 外部 Agent 自己管上下文窗口，这里没法按上限算占比
        const est = c.agent || c.steps.every(s => s.estimated);
        const base = Math.max(win, total) || total;
        const used = win ? (total / win) * 100 : null;
        const big = '<div class="cx-big">' + esc(approx(total, est)) + (win ? ' <small>/ ' + esc(fmt(win)) + " tokens</small>" : " <small>tokens</small>") + (used != null ? '<span class="cx-used">' + esc(t("占上下文 {0}", used.toFixed(1) + "%")) + "</span>" : "") + "</div>";
        const bar = wstack(live, 12, base);
        return box(t("当前上下文"), big + bar + wlegend(live, est) + (c.agent ? '<div class="dbx-hint">' + esc(t("只含你能看到的内容；系统提示词和工具定义在外部 Agent 里看不到。")) + "</div>" : !win ? '<div class="dbx-hint">' + esc(t("没有配置上下文上限（harness.config.json 的 limits.contextTokens）。")) + "</div>" : ""), "cx-card", '<span class="dim">' + esc((d.provider || "") + (d.model ? " · " + d.model : "")) + "</span>");
      }

      // ───────── 时间线 ─────────
      function series() {
        const c = C();
        if (X.gran === "step") return c.steps.map(s => ({ n: s.n, turn: s.turn, steps: [s], comp: s.comp, delta: s.delta, ms: s.ms, flags: s.flags, est: s.estimated }));
        const groups = [];
        let prev = null;
        for (const turn of c.turns) {
          const ss = c.steps.filter(s => s.turn === turn.n);
          if (!ss.length) continue;
          const last = ss[ss.length - 1];
          const delta = {};
          for (const k of WC) delta[k[0]] = (last.comp[k[0]] || 0) - (prev ? prev[k[0]] || 0 : 0);
          groups.push({ n: ss[0].n, turn: turn.n, steps: ss, comp: last.comp, delta, ms: ss.reduce((n, s) => n + s.ms, 0), flags: ss.flatMap(s => s.flags), est: ss.some(s => s.estimated) });
          prev = last.comp;
        }
        return groups;
      }
      const FLAG_ORDER = ["trim", "error", "blocked", "skill", "approval", "warn"];
      function timelineCard() {
        const c = C(), sr = series();
        if (!sr.length) return box(t("上下文时间线"), none(), "cx-card");
        const delta = X.mode === "delta";
        const L = 50, R = X.curve ? 46 : 12, T = 30, B = 38, H = 250;
        const slot = X.fit ? Math.max(3, (900 - L - R) / sr.length) : Math.max(18, Math.min(34, 900 / sr.length));
        const W = X.fit ? 900 : Math.max(600, L + R + slot * sr.length);
        const stackOf = s => WC.map(k => [k, delta ? s.delta[k[0]] || 0 : s.comp[k[0]] || 0]);
        const maxPos = Math.max(1, ...sr.map(s => stackOf(s).reduce((n, x) => n + Math.max(0, x[1]), 0)));
        const maxNeg = delta ? Math.max(0, ...sr.map(s => -stackOf(s).reduce((n, x) => n + Math.min(0, x[1]), 0))) : 0;
        const top = niceMax(maxPos), bot = maxNeg ? niceMax(maxNeg) : 0;
        const y = v => T + (H - T - B) * (1 - (v + bot) / (top + bot));
        const maxMs = Math.max(1, ...sr.map(s => s.ms));
        const msTop = niceMax(maxMs / 1000) * 1000;
        const yMs = v => T + (H - T - B) * (1 - v / msTop);
        const bw = Math.max(2, Math.min(26, slot - (X.fit ? 1 : 5)));
        let g = '<svg class="chart cx-tl" viewBox="0 0 ' + W + " " + H + '" ' + (X.fit ? 'style="width:100%"' : 'style="width:' + W + 'px;max-width:none"') + ">";
        for (let i = 0; i <= 4; i++) {
          const v = -bot + ((top + bot) * i) / 4;
          g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="currentColor" opacity="' + (Math.abs(v) < 1e-9 ? ".3" : ".1") + '"/><text x="' + (L - 6) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + (v < 0 ? "−" : "") + fmt(Math.abs(v)) + "</text>";
          if (X.curve) g += '<text x="' + (W - R + 6) + '" y="' + (yMs((msTop * i) / 4) + 3) + '" class="rt">' + esc(dur((msTop * i) / 4)) + "</text>";
        }
        const cur = X.sel;
        sr.forEach((s, i) => {
          const x = L + i * slot + (slot - bw) / 2;
          const on = cur != null && s.steps.some(q => q.n === cur);
          let up = 0, dn = 0, rects = "";
          for (const [k, v] of stackOf(s)) {
            if (!v) continue;
            if (v > 0) { const y1 = y(up + v), y0 = y(up); rects += '<rect x="' + x + '" y="' + y1 + '" width="' + bw + '" height="' + Math.max(0.5, y0 - y1) + '" fill="' + k[2] + '"/>'; up += v; }
            else { const y0 = y(-dn), y1 = y(-dn + v); rects += '<rect x="' + x + '" y="' + y0 + '" width="' + bw + '" height="' + Math.max(0.5, y1 - y0) + '" fill="' + k[2] + '" opacity=".85"/>'; dn -= v; }
          }
          const tip = (X.gran === "turn" ? t("第 {0} 轮", s.turn) : t("第 {0} 轮", s.turn) + " · " + t("第 {0} 步", s.n)) + " · " + t("输入 {0}", approx(delta ? Math.abs(sumW(s.delta)) : sumW(s.comp), s.est)) + " · " + dur(s.ms);
          g += '<g class="sbar' + (on ? " on" : "") + '" data-i="' + i + '"><title>' + esc(tip) + '</title><rect class="hit" x="' + (L + i * slot) + '" y="' + T + '" width="' + slot + '" height="' + (H - T - B) + '" fill="transparent"/>' + (on ? '<rect x="' + (L + i * slot) + '" y="' + T + '" width="' + slot + '" height="' + (H - T - B) + '" fill="currentColor" opacity=".07"/>' : "") + rects + "</g>";
          // 事件旗标：同一根柱上优先画最重要的一种
          const fl = FLAG_ORDER.find(f => s.flags.some(q => q.type === f));
          if (fl) {
            const e = EV.find(q => q[0] === fl), cx = x + bw / 2;
            const names = [...new Set(s.flags.map(q => t(EV.find(z => z[0] === q.type)[1]) + (q.label ? " · " + q.label : "")))].slice(0, 4).join("\n");
            g += '<g class="flag" data-i="' + i + '"><title>' + esc(names) + '</title><line x1="' + cx + '" x2="' + cx + '" y1="' + (T - 8) + '" y2="' + (H - B) + '" stroke="' + e[2] + '" stroke-dasharray="3 3" opacity=".55"/><circle cx="' + cx + '" cy="' + (T - 15) + '" r="7" fill="' + e[2] + '"/><text x="' + cx + '" y="' + (T - 11.5) + '" text-anchor="middle" class="fg">' + e[3] + "</text></g>";
          }
        });
        if (X.curve && sr.length > 1) g += '<polyline fill="none" stroke="#94a3b8" stroke-width="1.6" points="' + sr.map((s, i) => (L + i * slot + slot / 2) + "," + yMs(s.ms)).join(" ") + '"/>';
        // 横轴：步骤号 + 回合带
        const every = Math.max(1, Math.ceil(sr.length / Math.max(6, Math.floor((W - L - R) / 30))));
        sr.forEach((s, i) => { if (i % every === 0) g += '<text x="' + (L + i * slot + slot / 2) + '" y="' + (H - B + 14) + '" text-anchor="middle">' + (X.gran === "turn" ? s.turn : s.n) + "</text>"; });
        if (X.gran === "step") {
          const bands = [];
          sr.forEach((s, i) => { const b = bands[bands.length - 1]; if (b && b.turn === s.turn) b.to = i; else bands.push({ turn: s.turn, from: i, to: i }); });
          bands.forEach((b, k) => { g += '<g class="band" data-i="' + b.from + '"><rect x="' + (L + b.from * slot + 1) + '" y="' + (H - B + 20) + '" width="' + Math.max(2, (b.to - b.from + 1) * slot - 2) + '" height="14" rx="3" fill="currentColor" opacity="' + (k % 2 ? ".1" : ".18") + '"/><text x="' + (L + ((b.from + b.to + 1) / 2) * slot) + '" y="' + (H - B + 31) + '" text-anchor="middle" class="bt">' + b.turn + "</text></g>"; });
        }
        g += "</svg>";
        const seg = (id, a, b, cur) => '<div class="seg sm" id="' + id + '">' + [a, b].map(x => '<button type="button" data-v="' + x[0] + '" class="' + (cur === x[0] ? "on" : "") + '">' + esc(x[1]) + "</button>").join("") + "</div>";
        const right = '<div class="cx-ctl">' +
          '<label class="chk sm"><input type="checkbox" id="tlCurve"' + (X.curve ? " checked" : "") + " /> " + esc(t("耗时曲线")) + "</label>" +
          seg("tlFit", ["scroll", t("滚动")], ["fit", t("总览")], X.fit ? "fit" : "scroll") +
          seg("tlGran", ["step", t("步")], ["turn", t("轮")], X.gran) +
          seg("tlMode", ["total", t("累计")], ["delta", t("增量")], X.mode) + "</div>";
        let leg = '<div class="legend">' + WC.map(k => '<span><i style="background:' + k[2] + '"></i>' + esc(t(k[1])) + "</span>").join("") + EV.filter(e => e[0] !== "approval").map(e => '<span><i class="fgi" style="background:' + e[2] + '">' + e[3] + "</i>" + esc(t(e[1])) + "</span>").join("") + "</div>";
        return box(t("上下文时间线"), '<div class="scroll">' + g + "</div>" + leg + '<div id="cx-stepdetail">' + stepDetail(sr) + "</div>", "cx-card", right);
      }
      function stepDetail(sr) {
        const c = C();
        const cur = X.sel != null ? X.sel : c.steps[c.steps.length - 1].n;
        const s = c.steps.find(q => q.n === cur) || c.steps[c.steps.length - 1];
        const inTurn = c.steps.filter(q => q.turn === s.turn);
        const idx = inTurn.findIndex(q => q.n === s.n) + 1;
        const b = s.brief || { in: [], calls: [] };
        const chips = (s.actual
          ? chip(t("实际输入"), fmt(s.actual.prompt)) + chip(t("输出"), fmt(s.actual.output)) + chip(t("缓存"), "—")
          : chip(t("估算输入"), "≈" + fmt(s.prompt)) + chip(t("输出"), "≈" + fmt(s.output))) + chip(t("耗时"), dur(s.ms)) + (s.cost != null ? chip(t("成本"), money(s.cost)) : "");
        const row = (k, body) => '<div class="cx-brow"><span class="k">' + esc(k) + '</span><div class="b">' + body + "</div></div>";
        const callChip = x => '<span class="cx-call' + (x.ok === false ? " bad" : "") + '"><b>' + esc(x.tool) + "</b>" + (x.preview ? " " + esc(x.preview) : "") + "</span>";
        const inBody = b.in.length ? b.in.map(callChip).join("") + (b.inMore ? '<span class="cx-more">+' + b.inMore + "</span>" : "") : '<span class="dim">—</span>';
        const respBody = (b.resp ? '<span class="cx-resp">' + (b.respKind === "thinking" ? '<em>' + esc(t("思考")) + "</em> " : "") + esc(b.resp) + "</span>" : "") + (b.calls && b.calls.length ? b.calls.map(callChip).join("") + (b.callsMore ? '<span class="cx-more">+' + b.callsMore + "</span>" : "") : "") || '<span class="dim">—</span>';
        return '<div class="cx-sd"><div class="cx-sdh"><b>' + esc(t("第 {0} 轮", s.turn) + " · " + t("第 {0} / {1} 步", idx, inTurn.length)) + '</b><span class="dim">' + esc(clock(s.ts)) + "</span></div>" +
          '<div class="cx-chips">' + chips + "</div>" +
          row(t("用户"), esc(b.user || "")) + row(t("输入"), inBody) + row(t("回复"), respBody) +
          wstack(s.comp, 10) + wlegend(s.comp, s.estimated) + "</div>";
      }

      // ───────── 上下文浏览器 ─────────
      const lastN = () => C().steps[C().steps.length - 1].n;
      const brStepN = () => (X.brStep === "live" ? lastN() : Number(X.brStep));
      function loadBrowser() {
        const n = brStepN(), mode = X.brMode;
        const key = S.name + "|" + n + "|" + mode;
        if (X.brKey === key && X.brData) return;
        X.brKey = key; X.brData = null; X.brLoading = true;
        paintPart("cx-br", browserCard);
        rpc("session/items", { name: S.name, step: n, mode }).then(r => {
          if (X.brKey !== key) return;
          X.brData = r; X.brLoading = false; paintPart("cx-br", browserCard);
        }).catch(e => { if (X.brKey === key) { X.brData = { items: [], error: String((e && e.message) || e) }; X.brLoading = false; paintPart("cx-br", browserCard); } });
      }
      function itemHtml(it, dna) {
        const open = X.brItem.has(it.cat + ":" + it.id);
        const pre = String(it.text || "").replace(/\s+/g, " ").slice(0, 110);
        const src = it.source ? '<span class="cx-src">' + esc(it.source) + "</span>" : "";
        const st = it.ok === false ? '<span class="cx-ok bad">' + esc(t("失败")) + "</span>" : it.kind === "result" ? '<span class="cx-ok">OK</span>' : "";
        return '<div class="bi' + (open ? " open" : "") + (it.isNew && X.brMode === "total" ? " new" : "") + '"><button type="button" class="bi-h" data-it="' + esc(it.cat + ":" + it.id) + '"><span class="bi-p">#' + it.pos + "</span>" +
          (dna ? '<i class="dot" style="background:' + wcolor(it.cat) + '"></i>' : "") +
          '<b class="bi-n">' + esc(it.kind === "thinking" ? t("思考") : it.kind === "answer" ? t("回复") : it.kind === "user" ? t("用户消息") : it.title) + "</b>" + src + st + '<span class="bi-pre">' + esc(pre) + '</span><span class="bi-t">≈' + fmt(it.tokens) + "</span></button>" +
          (open ? '<pre class="bi-x">' + esc(it.text || "") + (it.truncated ? "\n…" + esc(t("（已截断）")) : "") + "</pre>" : "") + "</div>";
      }
      function browserCard() {
        const c = C();
        const n = brStepN();
        const data = X.brData;
        const stepOpts = '<option value="live"' + (X.brStep === "live" ? " selected" : "") + ">" + esc(t("当前（下一次请求）")) + "</option>" + c.steps.slice().reverse().map(s => '<option value="' + s.n + '"' + (String(X.brStep) === String(s.n) ? " selected" : "") + ">" + esc(t("第 {0} 轮", s.turn) + " · " + t("第 {0} 步", s.n)) + "</option>").join("");
        const seg = (id, a, b, cur) => '<div class="seg sm" id="' + id + '">' + [a, b].map(x => '<button type="button" data-v="' + x[0] + '" class="' + (cur === x[0] ? "on" : "") + '">' + esc(x[1]) + "</button>").join("") + "</div>";
        const step = c.steps.find(s => s.n === n);
        const right = '<div class="cx-ctl"><button type="button" class="seg1' + (X.brDna ? " on" : "") + '" id="brDna">' + esc(t("DNA 模式")) + "</button></div>";
        let h = '<div class="cx-brbar"><select id="brStep">' + stepOpts + '</select><div class="seg sm" id="brNav"><button type="button" data-d="step">' + esc(t("上一步")) + '</button><button type="button" data-d="turn">' + esc(t("上一轮")) + "</button></div>" + seg("brMode", ["total", t("累计")], ["delta", t("增量")], X.brMode) + "</div>";
        if (!data) return box(t("上下文浏览器"), h + '<div class="dbx-hint pad">' + esc(t("加载中…")) + "</div>", "cx-card", right);
        if (data.error) return box(t("上下文浏览器"), h + '<div class="pad warn">' + esc(data.error) + "</div>", "cx-card", right);
        const items = data.items || [];
        const q = X.brQ.trim().toLowerCase();
        const hit = it => !q || (it.title + " " + it.text + " " + it.source).toLowerCase().includes(q);
        const byCat = {};
        for (const k of WC) byCat[k[0]] = [];
        for (const it of items) (byCat[it.cat] || (byCat[it.cat] = [])).push(it);
        const comp = {};
        for (const k of WC) comp[k[0]] = byCat[k[0]].reduce((s, it) => s + it.tokens, 0);
        const total = sumW(comp);
        const est = data.estimated !== false;
        h += '<div class="cx-brsum"><b>' + esc(X.brStep === "live" ? t("当前 · 下一次请求") : t("第 {0} 轮", step ? step.turn : "") + " · " + t("第 {0} 步", n)) + "</b><span class=\"dim\">" + esc(t("共 {0} 项", items.length)) + " · " + (X.brMode === "delta" ? esc(t("这一步新增")) : "") + " " + esc(approx(total, est)) + (step && step.actual ? " · " + esc(t("实际输入 {0}", fmt(step.actual.prompt))) : "") + "</span></div>";
        h += wstack(comp, 10);
        h += '<div class="cx-brtool"><input id="brQ" type="search" placeholder="' + esc(t("搜索内容 / 工具名")) + '" value="' + esc(X.brQ) + '" />' + seg("brSort", ["order", t("按顺序")], ["size", t("按大小")], X.brSort) + "</div>";
        const sortf = list => (X.brSort === "size" ? list.slice().sort((a, b) => b.tokens - a.tokens) : list);
        if (X.brDna) {
          const flat = sortf(items.filter(hit).slice().reverse());
          const lim = X.brMore.dna || 80;
          h += '<div class="bi-list">' + (flat.length ? flat.slice(0, lim).map(it => itemHtml(it, true)).join("") : '<div class="dbx-hint pad">' + esc(t("没有匹配的内容")) + "</div>") + "</div>";
          if (flat.length > lim) h += '<div class="more"><button type="button" data-more="dna">' + esc(t("显示更多（还有 {0} 项）", flat.length - lim)) + "</button></div>";
          return box(t("上下文浏览器"), h, "cx-card", right);
        }
        h += '<div class="cx-cats">';
        for (const k of WC) {
          const list = byCat[k[0]];
          const tok = comp[k[0]];
          const open = X.brOpen.has(k[0]);
          const newN = list.filter(it => it.isNew).length;
          const newTok = list.filter(it => it.isNew).reduce((s, it) => s + it.tokens, 0);
          const na = isNA(k[0], list.length);
          h += '<div class="cx-cat' + (open ? " open" : "") + '"><button type="button" class="cx-ch" data-cat="' + k[0] + '"><i class="car">' + (open ? "▾" : "▸") + '</i><i class="dot" style="background:' + k[2] + '"></i><span class="cn">' + esc(t(k[1])) + '</span><span class="cc">' + (na ? "—" : esc(t("{0} 项", list.length))) + "</span>" +
            (X.brMode === "total" && newN && data.items.length > newN ? '<span class="cx-plus" title="' + esc(t("相对上一步新增")) + '">+' + newN + "</span>" : "") +
            (X.brMode === "total" && newTok && data.items.length > newN ? '<span class="cx-plus tok">+' + fmt(newTok) + "</span>" : "") +
            '<span class="ct">' + (na ? "—" : "≈" + fmt(tok)) + '</span><span class="cp">' + (total && tok ? pct(tok, total) : "") + "</span></button>";
          if (open) {
            let shown = list.filter(hit);
            if (k[0] === "assistant") {
              const cnt = kind => list.filter(it => it.kind === kind && hit(it)).length;
              h += '<div class="cx-kinds">' + [["thinking", t("思考")], ["tools", t("工具")], ["answer", t("回复")]].map(kd => '<button type="button" class="cx-kind' + (X.brKind === kd[0] ? " on" : "") + '" data-kind="' + kd[0] + '">' + esc(kd[1]) + " <b>" + cnt(kd[0]) + "</b></button>").join("") + "</div>";
              if (X.brKind) shown = shown.filter(it => it.kind === X.brKind);
            }
            shown = sortf(shown);
            const lim = X.brMore[k[0]] || 40;
            h += '<div class="bi-list">' + (shown.length ? shown.slice(0, lim).map(it => itemHtml(it, false)).join("") : '<div class="dbx-hint pad">' + esc(na ? t("这类内容在 trace 里没有记录。") : t("没有匹配的内容")) + "</div>") + "</div>";
            if (shown.length > lim) h += '<div class="more"><button type="button" data-more="' + k[0] + '">' + esc(t("显示更多（还有 {0} 项）", shown.length - lim)) + "</button></div>";
          }
          h += "</div>";
        }
        h += "</div>";
        if (c.agent) h += '<div class="dbx-hint">' + esc(t("外部 Agent 的内容按你能看到的部分重建：用户消息、模型思考 / 回复、工具调用及结果。")) + "</div>";
        return box(t("上下文浏览器"), h, "cx-card", right);
      }

      // ───────── 事件 ─────────
      function eventsCard() {
        const c = C();
        const all = c.events.filter(e => e.type !== "start");
        const counts = {};
        for (const e of all) counts[e.type] = (counts[e.type] || 0) + 1;
        const chips = '<div class="cx-evf">' + EV.filter(e => counts[e[0]] || e[0] !== "warn").map(e => '<button type="button" class="cx-evb' + (X.evOff.has(e[0]) ? " off" : "") + '" data-ev="' + e[0] + '" style="--c:' + e[2] + '">' + esc(t(e[1])) + " " + (counts[e[0]] || 0) + "</button>").join("") + "</div>";
        const list = all.filter(e => !X.evOff.has(e.type)).slice().reverse();
        const lim = X.evMax;
        const body = list.length
          ? '<div class="cx-evs">' + list.slice(0, lim).map(e => {
            const m = EV.find(z => z[0] === e.type) || EV[4];
            const lbl = e.type === "trim" ? t("{0} → {1} token，丢弃 {2} 条", fmt(e.before), fmt(e.after), e.dropped) : e.type === "approval" ? (e.approved ? t("已批准") : t("已拒绝")) + " " + (e.label || "").replace(/^(approved|denied)\s*/, "") : e.label;
            return '<div class="cx-ev"><i class="ei" style="background:' + m[2] + '">' + m[3] + "</i>" + tag(t(m[1]), m[2]) + '<span class="el" title="' + esc(e.label || "") + '">' + esc(lbl || "") + '</span><span class="ep">' + esc(e.turn ? t("第 {0} 轮", e.turn) + (e.step ? " · " + t("第 {0} 步", e.step) : "") : "") + "</span>" + (e.delta != null ? '<span class="ed ' + (e.delta < 0 ? "neg" : "pos") + '">' + esc(signed(e.delta)) + "</span>" : "") + '<span class="et">' + esc(clock(e.ts)) + "</span></div>";
          }).join("") + "</div>" + (list.length > lim ? '<div class="more"><button type="button" data-evmore="1">' + esc(t("显示更多（还有 {0} 条）", list.length - lim)) + "</button></div>" : "")
          : '<div class="dbx-hint pad">' + esc(t("没有压缩、拦截、技能加载或错误事件。")) + "</div>";
        return box(t("上下文事件"), chips + body, "cx-card");
      }

      // ───────── 文件活动 ─────────
      const shortPath = p => (p.length > 64 ? p.slice(0, 22) + "…" + p.slice(-38) : p);
      function filesCard() {
        const c = C();
        const all = c.files;
        const tot = { read: 0, write: 0, search: 0 };
        for (const f of all) for (const k of Object.keys(tot)) tot[k] += f[k];
        const OPS = [["", t("全部"), all.length], ["read", t("读取"), tot.read], ["write", t("写入"), tot.write], ["search", t("搜索"), tot.search]];
        const q = X.fileQ.trim().toLowerCase();
        const list = all.filter(f => (!X.fileOp || f[X.fileOp] > 0) && (!q || f.path.toLowerCase().includes(q)));
        let h = '<div class="cx-evf">' + OPS.map(o => '<button type="button" class="cx-evb' + (X.fileOp === o[0] ? "" : " off") + '" data-fop="' + o[0] + '" style="--c:#3b82f6">' + esc(o[1]) + " " + o[2] + "</button>").join("") + '<input id="fileQ" type="search" class="mini" placeholder="' + esc(t("筛选路径")) + '" value="' + esc(X.fileQ) + '" /></div>';
        if (!all.length) return box(t("文件活动"), h + '<div class="dbx-hint pad">' + esc(t("没有文件读写或搜索。")) + "</div>", "cx-card");
        const lim = X.fileMax;
        h += '<div class="cx-files">' + list.slice(0, lim).map(f => {
          const open = X.fileOpen === f.path;
          return '<div class="cx-file' + (open ? " open" : "") + '"><button type="button" class="cf-h" data-fp="' + esc(f.path) + '"><code title="' + esc(f.path) + '">' + esc(shortPath(f.path)) + "</code>" + (f.read ? '<span class="op r">R ' + f.read + "</span>" : "") + (f.write ? '<span class="op w">W ' + f.write + "</span>" : "") + (f.search ? '<span class="op s">S ' + f.search + "</span>" : "") + '<span class="dim">' + esc(clock(f.last)) + "</span></button>" +
            (open ? '<div class="cf-x">' + f.hits.map(x => '<div><span class="op ' + x.op[0] + '">' + esc(x.op) + "</span> " + esc(t("第 {0} 轮", x.turn) + " · " + t("第 {0} 步", x.step)) + " · " + esc(x.tool) + ' <span class="dim">' + esc(clock(x.ts)) + "</span></div>").join("") + "</div>" : "") + "</div>";
        }).join("") + "</div>";
        if (list.length > lim) h += '<div class="more"><button type="button" data-fmore="1">' + esc(t("显示更多（还有 {0} 个）", list.length - lim)) + "</button></div>";
        return box(t("文件活动"), h, "cx-card", '<span class="dim">' + esc(t("{0} 个文件", all.length)) + "</span>");
      }

      // ───────── 命令执行 ─────────
      function cmdCard() {
        const c = C(), runs = c.commands.runs, progs = c.commands.programs;
        const bad = r => r.blocked || r.timedOut || (r.exit != null && r.exit !== 0);
        const fails = runs.filter(bad).length;
        let h = '<div class="cx-evf">' + '<button type="button" class="cx-evb' + (!X.cmdProg && !X.cmdBad ? "" : " off") + '" data-cprog="" style="--c:#3b82f6">' + esc(t("全部")) + " " + runs.length + "</button>" +
          (fails ? '<button type="button" class="cx-evb' + (X.cmdBad ? "" : " off") + '" data-cbad="1" style="--c:#ef4444">' + esc(t("失败")) + " " + fails + "</button>" : "") +
          progs.slice(0, 8).map((p, i) => '<button type="button" class="cx-evb' + (X.cmdProg === p.program ? "" : " off") + '" data-cprog="' + esc(p.program) + '" style="--c:' + PAL[i % PAL.length] + '">' + esc(p.program) + " " + p.count + "</button>").join("") + "</div>";
        if (!runs.length) return box(t("命令执行"), h + '<div class="dbx-hint pad">' + esc(t("没有执行命令。")) + "</div>", "cx-card");
        const list = runs.filter(r => (!X.cmdProg || r.program === X.cmdProg) && (!X.cmdBad || bad(r)));
        const lim = X.cmdMax;
        h += '<div class="cx-cmds">' + list.slice(0, lim).map((r, i) => {
          const open = X.cmdOpen === r.ts + ":" + i;
          const st = r.blocked ? t("拦截") : r.timedOut ? t("超时") : r.exit == null ? "" : "exit " + r.exit;
          return '<div class="cx-cmd' + (bad(r) ? " bad" : "") + (open ? " open" : "") + '"><button type="button" class="cc-h" data-cc="' + esc(r.ts + ":" + i) + '"><i class="dot" style="background:' + (bad(r) ? "#ef4444" : "#22c55e") + '"></i><b>' + esc(r.program) + "</b><code>" + esc((r.command || t("（被拦截）")).slice(0, 140)) + '</code><span class="dim">' + esc(st) + (r.ms ? " · " + esc(dur(r.ms)) : "") + "</span></button>" +
            (open ? '<pre class="bi-x">' + esc(r.command || "") + "</pre><div class=\"dim cc-m\">" + esc(t("第 {0} 轮", r.turn) + " · " + t("第 {0} 步", r.step) + " · " + clock(r.ts)) + "</div>" : "") + "</div>";
        }).join("") + "</div>";
        if (list.length > lim) h += '<div class="more"><button type="button" data-cmore="1">' + esc(t("显示更多（还有 {0} 条）", list.length - lim)) + "</button></div>";
        return box(t("命令执行"), h, "cx-card", '<span class="dim">' + esc(t("{0} 条 · 失败 {1}", runs.length, fails)) + "</span>");
      }

      // ───────── 整页 ─────────
      function view(d) {
        const c = d.ctx;
        if (!c.steps.length) return head(d) + empty(t("这个会话没有可分析的步骤"), t("没有模型调用，也没有外部 Agent 的进度记录。"));
        return head(d) + '<div class="cx-cols"><div class="cx-col">' + statsCard(d) + tokenCard(d) + currentCard(d) + '<div id="cx-tl">' + timelineCard() + "</div></div>" +
          '<div class="cx-col">' + timingCard() + '<div id="cx-br">' + browserCard() + "</div></div></div>" +
          '<div class="cx-bottom"><div id="cx-ev">' + eventsCard() + '</div><div id="cx-files">' + filesCard() + '</div><div id="cx-cmd">' + cmdCard() + "</div></div>";
      }

      function paintPart(id, fn) {
        const el = document.getElementById(id);
        if (!el || !S.detail || S.tab !== "context") return;
        const sc = el.querySelector(".scroll");
        const keep = sc ? sc.scrollLeft : 0;
        el.innerHTML = fn();
        const sc2 = el.querySelector(".scroll");
        if (sc2) sc2.scrollLeft = keep;
        bindPart(id);
      }
      const q = (root, sel) => Array.prototype.slice.call(root.querySelectorAll(sel));
      function segBind(id, fn) {
        const el = document.getElementById(id);
        if (el) q(el, "[data-v]").forEach(b => { b.onclick = () => fn(b.getAttribute("data-v")); });
      }
      function bindPart(id) {
        const root = document.getElementById(id);
        if (!root) return;
        if (id === "cx-tl") {
          const sr = series();
          q(root, ".sbar,.flag,.band").forEach(b => { b.onclick = () => { const s = sr[Number(b.getAttribute("data-i"))]; if (!s) return; X.sel = s.steps[s.steps.length - 1].n; X.brStep = String(s.steps[s.steps.length - 1].n); paintPart("cx-tl", timelineCard); loadBrowserSoon(); }; });
          const cv = document.getElementById("tlCurve");
          if (cv) cv.onchange = () => { X.curve = cv.checked; paintPart("cx-tl", timelineCard); };
          segBind("tlFit", v => { X.fit = v === "fit"; paintPart("cx-tl", timelineCard); });
          segBind("tlGran", v => { X.gran = v; paintPart("cx-tl", timelineCard); });
          segBind("tlMode", v => { X.mode = v; paintPart("cx-tl", timelineCard); });
        } else if (id === "cx-br") {
          const stp = document.getElementById("brStep");
          if (stp) stp.onchange = () => { X.brStep = stp.value; if (stp.value !== "live") X.sel = Number(stp.value); else X.sel = null; paintPart("cx-tl", timelineCard); loadBrowser(); };
          segBind("brMode", v => { X.brMode = v; loadBrowser(); });
          segBind("brSort", v => { X.brSort = v; paintPart("cx-br", browserCard); });
          const nav = document.getElementById("brNav");
          if (nav) q(nav, "[data-d]").forEach(b => { b.onclick = () => navStep(b.getAttribute("data-d")); });
          const dna = document.getElementById("brDna");
          if (dna) dna.onclick = () => { X.brDna = !X.brDna; paintPart("cx-br", browserCard); };
          const bq = document.getElementById("brQ");
          if (bq) { bq.oninput = () => { X.brQ = bq.value; X.brMore = {}; paintPart("cx-br", browserCard); const n = document.getElementById("brQ"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }; }
          q(root, "[data-cat]").forEach(b => { b.onclick = () => { const k = b.getAttribute("data-cat"); if (X.brOpen.has(k)) X.brOpen.delete(k); else X.brOpen.add(k); paintPart("cx-br", browserCard); }; });
          q(root, "[data-kind]").forEach(b => { b.onclick = () => { const k = b.getAttribute("data-kind"); X.brKind = X.brKind === k ? "" : k; paintPart("cx-br", browserCard); }; });
          q(root, "[data-it]").forEach(b => { b.onclick = () => { const k = b.getAttribute("data-it"); if (X.brItem.has(k)) X.brItem.delete(k); else X.brItem.add(k); paintPart("cx-br", browserCard); }; });
          q(root, "[data-more]").forEach(b => { b.onclick = () => { const k = b.getAttribute("data-more"); X.brMore[k] = (X.brMore[k] || (k === "dna" ? 80 : 40)) + 60; paintPart("cx-br", browserCard); }; });
        } else if (id === "cx-ev") {
          q(root, "[data-ev]").forEach(b => { b.onclick = () => { const k = b.getAttribute("data-ev"); if (X.evOff.has(k)) X.evOff.delete(k); else X.evOff.add(k); paintPart("cx-ev", eventsCard); }; });
          q(root, "[data-evmore]").forEach(b => { b.onclick = () => { X.evMax += 40; paintPart("cx-ev", eventsCard); }; });
        } else if (id === "cx-files") {
          q(root, "[data-fop]").forEach(b => { b.onclick = () => { X.fileOp = b.getAttribute("data-fop"); X.fileMax = 20; paintPart("cx-files", filesCard); }; });
          q(root, "[data-fp]").forEach(b => { b.onclick = () => { const p = b.getAttribute("data-fp"); X.fileOpen = X.fileOpen === p ? null : p; paintPart("cx-files", filesCard); }; });
          q(root, "[data-fmore]").forEach(b => { b.onclick = () => { X.fileMax += 30; paintPart("cx-files", filesCard); }; });
          const fq = document.getElementById("fileQ");
          if (fq) fq.oninput = () => { X.fileQ = fq.value; X.fileMax = 20; paintPart("cx-files", filesCard); const n = document.getElementById("fileQ"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } };
        } else if (id === "cx-cmd") {
          q(root, "[data-cprog]").forEach(b => { b.onclick = () => { const p = b.getAttribute("data-cprog"); X.cmdProg = X.cmdProg === p ? "" : p; X.cmdBad = false; X.cmdMax = 15; paintPart("cx-cmd", cmdCard); }; });
          q(root, "[data-cbad]").forEach(b => { b.onclick = () => { X.cmdBad = !X.cmdBad; X.cmdProg = ""; X.cmdMax = 15; paintPart("cx-cmd", cmdCard); }; });
          q(root, "[data-cc]").forEach(b => { b.onclick = () => { const k = b.getAttribute("data-cc"); X.cmdOpen = X.cmdOpen === k ? null : k; paintPart("cx-cmd", cmdCard); }; });
          q(root, "[data-cmore]").forEach(b => { b.onclick = () => { X.cmdMax += 30; paintPart("cx-cmd", cmdCard); }; });
        }
      }
      let softTimer;
      function loadBrowserSoon() { clearTimeout(softTimer); softTimer = setTimeout(loadBrowser, 120); }
      function navStep(kind) {
        const c = C(), n = brStepN();
        const s = c.steps.find(x => x.n === n) || c.steps[c.steps.length - 1];
        let target;
        if (kind === "turn") {
          const prev = c.steps.filter(x => x.turn < s.turn);
          target = prev.length ? prev[prev.length - 1] : null;
        } else target = c.steps.find(x => x.n === s.n - 1) || null;
        if (!target) return;
        X.brStep = String(target.n); X.sel = target.n;
        paintPart("cx-tl", timelineCard); loadBrowser();
      }

      function bind() {
        ["cx-tl", "cx-br", "cx-ev", "cx-files", "cx-cmd"].forEach(bindPart);
        const sel = document.getElementById("runSel");
        if (sel) sel.onchange = () => kit.openSession(sel.value);
        loadBrowser();
      }

      return { view, bind, reset };
    },
  };
})();
