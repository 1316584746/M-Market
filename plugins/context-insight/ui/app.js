(function () {
  "use strict";
  var api = window.dbxPlugin;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var fmt = function (n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)); };
  var COLORS = { system: "#8b5cf6", user: "#3b82f6", assistant: "#10b981", tool: "#f59e0b" };
  var LABEL = { system: "system", user: "user", assistant: "assistant", tool: "tool 输出" };
  var state = { runs: [], current: null, run: null, step: null };

  function call(method, params) { return api.invoke(method, params || {}, { timeoutMs: 120000 }); }
  function fail(e) { return '<div class="pad warn">' + esc(e && e.message ? e.message : e) + "</div>"; }

  function when(ts) {
    if (!ts) return "";
    var d = new Date(ts), p = function (n) { return String(n).padStart(2, "0"); };
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function loadEnv() {
    return call("env/info").then(function (e) {
      $("dir").textContent = e.active || "（没有找到 trace 目录）";
      $("dir").title = e.active + (e.dirs && e.dirs.length ? "\n候选：\n" + e.dirs.map(function (d) { return (d.exists ? "✓ " : "✗ ") + d.dir + "（" + d.why + "）"; }).join("\n") : "");
    });
  }

  function loadRuns() {
    $("runs").innerHTML = '<div class="dbx-hint pad">加载中…</div>';
    return Promise.all([loadEnv(), call("runs/list", { limit: 80 })]).then(function (r) {
      state.runs = r[1];
      $("count").textContent = state.runs.length ? state.runs.length + " 次运行" : "";
      renderRuns();
    }).catch(function (e) { $("runs").innerHTML = fail(e); });
  }

  function renderRuns() {
    if (!state.runs.length) {
      $("runs").innerHTML = '<div class="dbx-hint pad">没有找到 trace 记录。<br>在 M-Harness 里跑一次任务，这里就会出现；目录不对可以点右上角「修改目录」。</div>';
      return;
    }
    $("runs").innerHTML = state.runs.map(function (r) {
      return '<div class="run' + (r.name === state.current ? " on" : "") + '" data-n="' + esc(r.name) + '">' +
        '<div class="n">' + esc(r.input || r.name) + "</div>" +
        '<div class="i">' + esc(r.provider || "?") + " · " + esc(when(r.startedAt || r.mtime)) + "</div>" +
        '<div class="m"><span>' + r.steps + " 步</span><span>" + fmt(r.tokens) + " token</span>" + (r.trims ? "<span>压缩 " + r.trims + "</span>" : "") + (r.reason && r.reason !== "final" ? '<span class="warn">' + esc(r.reason) + "</span>" : "") + "</div></div>";
    }).join("");
    Array.prototype.forEach.call($("runs").querySelectorAll(".run"), function (el) {
      el.addEventListener("click", function () { open(el.getAttribute("data-n")); });
    });
  }

  function open(name) {
    state.current = name; state.step = null;
    renderRuns();
    $("detail").innerHTML = '<div class="dbx-hint pad">分析中…</div>';
    call("runs/get", { name: name }).then(function (run) { state.run = run; renderDetail(); }).catch(function (e) { $("detail").innerHTML = fail(e); });
  }

  function card(v, k) { return '<div class="card"><div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + "</div></div>"; }

  function chart(run) {
    var steps = run.steps; if (!steps.length) return '<div class="dbx-hint">这次运行没有模型调用记录。</div>';
    var W = Math.max(480, steps.length * 22 + 60), H = 200, L = 44, B = 22, T = 8;
    var max = Math.max.apply(null, steps.map(function (s) { return s.promptTokens; }).concat([1]));
    var bw = Math.min(28, (W - L - 10) / steps.length - 3);
    var x = function (i) { return L + i * ((W - L - 10) / steps.length) + 1.5; };
    var y = function (v) { return T + (H - T - B) * (1 - v / max); };
    var g = '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" style="min-width:' + Math.min(W, 900) + 'px">';
    [0, 0.5, 1].forEach(function (f) {
      g += '<line x1="' + L + '" x2="' + (W - 6) + '" y1="' + y(max * f) + '" y2="' + y(max * f) + '" stroke="currentColor" opacity=".12"/>';
      g += '<text x="' + (L - 4) + '" y="' + (y(max * f) + 3) + '" text-anchor="end">' + fmt(max * f) + "</text>";
    });
    steps.forEach(function (s, i) {
      var sum = s.comp.system + s.comp.user + s.comp.assistant + s.comp.tool || 1;
      var top = s.promptTokens, acc = 0;
      ["system", "user", "assistant", "tool"].forEach(function (k) {
        var h = (s.comp[k] / sum) * top; if (h <= 0) return;
        var y0 = y(acc + h), hh = y(acc) - y0; acc += h;
        g += '<rect class="bar" data-i="' + i + '" x="' + x(i) + '" y="' + y0 + '" width="' + bw + '" height="' + Math.max(0.5, hh) + '" fill="' + COLORS[k] + '"' + (state.step === s.step ? ' stroke="currentColor"' : "") + "><title>第 " + s.step + " 步 · " + k + " ≈ " + fmt(s.comp[k]) + "（输入 " + fmt(s.promptTokens) + (s.promptEstimated ? "，估算" : "") + "）</title></rect>";
      });
      if (steps.length <= 40 || i % Math.ceil(steps.length / 20) === 0) g += '<text x="' + (x(i) + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + s.step + "</text>";
    });
    run.trims.forEach(function (t) {
      var idx = steps.findIndex(function (s) { return s.step === t.afterStep; });
      if (idx < 0) return;
      var xx = x(idx) + bw + 1.5;
      g += '<line x1="' + xx + '" x2="' + xx + '" y1="' + T + '" y2="' + (H - B) + '" stroke="#ef4444" stroke-dasharray="3 2"><title>第 ' + t.afterStep + " 步后压缩：" + fmt(t.before) + " → " + fmt(t.after) + "，丢弃 " + t.dropped + " 条</title></line>";
    });
    return g + "</svg>";
  }

  function renderDetail() {
    var run = state.run, t = run.totals;
    var h = '<div class="cards">' +
      card(fmt(t.totalTokens), "累计 token" + (t.estimated ? "（含估算）" : "")) +
      card(t.calls, "模型调用") +
      card(fmt(t.peakPrompt), "单次最大输入") +
      card(t.toolCalls, "工具调用") +
      card(t.trims, "上下文压缩") +
      card(run.reason || "未结束", "结束原因") + "</div>";
    h += '<div class="dbx-hint" style="margin-bottom:6px">' + esc(run.input) + "</div>";
    h += '<h3>每一步发给模型的上下文（点柱子看这一步带了什么；红色虚线 = 发生了压缩）</h3>';
    h += '<div class="legend">' + Object.keys(COLORS).map(function (k) { return '<span><i style="background:' + COLORS[k] + '"></i>' + LABEL[k] + "</span>"; }).join("") + "</div>";
    h += '<div style="overflow-x:auto">' + chart(run) + "</div>";
    h += '<div id="stepbox"></div>';
    if (run.trims.length) {
      h += "<h3>压缩事件</h3><table class='dbx-table'><tr><th>发生在</th><th>压缩前</th><th>压缩后</th><th>丢弃条数</th></tr>" + run.trims.map(function (x) { return "<tr><td>第 " + x.afterStep + " 步后</td><td>" + fmt(x.before) + "</td><td>" + fmt(x.after) + "</td><td>" + x.dropped + "</td></tr>"; }).join("") + "</table>";
    }
    if (run.tools.length) {
      h += "<h3>工具输出占用（按 token 排序）</h3><table class='dbx-table'><tr><th>工具</th><th>次数</th><th>输出合计</th><th>单次最大</th><th>平均耗时</th></tr>" + run.tools.map(function (x) { return "<tr><td>" + esc(x.name) + "</td><td>" + x.count + "</td><td>≈ " + fmt(x.outTokens) + "</td><td>≈ " + fmt(x.maxTokens) + "</td><td>" + x.avgMs + " ms</td></tr>"; }).join("") + "</table>";
    }
    h += '<p class="dbx-hint">token 数：模型返回了用量就用真实值，否则按「中文 1 字 ≈ 1 token、其他 4 字符 ≈ 1 token」估算。构成按各角色消息的估算量折算到真实输入量上。</p>';
    $("detail").innerHTML = h;
    Array.prototype.forEach.call($("detail").querySelectorAll("rect.bar"), function (el) {
      el.addEventListener("click", function () { pick(run.steps[Number(el.getAttribute("data-i"))].step); });
    });
    if (state.step != null) pick(state.step, true);
  }

  function pick(step, keep) {
    state.step = step;
    if (!keep) renderDetail();
    var box = $("stepbox"); if (!box) return;
    box.innerHTML = '<h3>第 ' + step + ' 步的消息</h3><div class="dbx-hint">加载中…</div>';
    call("runs/messages", { name: state.current, step: step }).then(function (ms) {
      box.innerHTML = '<h3>第 ' + step + " 步的消息（" + ms.length + " 条）</h3><div class='msgs'>" + ms.map(function (m) {
        return '<div class="msg"><span style="color:' + (COLORS[m.role] || "inherit") + '">' + esc(m.role) + (m.tool ? "<br><span class='dbx-hint'>" + esc(m.tool) + "</span>" : "") + '</span><span class="dbx-hint">≈ ' + fmt(m.tokens) + '</span><span class="t">' + esc(m.text) + "</span></div>";
      }).join("") + "</div>";
    }).catch(function (e) { box.innerHTML = fail(e); });
  }

  $("refresh").addEventListener("click", function () { loadRuns(); });
  // 插件界面跑在不带 allow-modals 的沙箱里，alert / prompt 都不能用，所以目录输入做成页面里的一行
  $("chdir").addEventListener("click", function () { $("editdir").hidden = !$("editdir").hidden; $("direrr").textContent = ""; $("dirin").focus(); });
  $("dircancel").addEventListener("click", function () { $("editdir").hidden = true; });
  $("dirok").addEventListener("click", function () {
    call("env/setTraceDir", { dir: $("dirin").value.trim() }).then(function () { $("editdir").hidden = true; return loadRuns(); }).catch(function (e) { $("direrr").textContent = e.message || String(e); });
  });

  api.ready.then(loadRuns);
})();
