(function () {
  "use strict";
  var api = window.dbxPlugin;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var call = function (m, p, ms) { return api.invoke(m, p || {}, { timeoutMs: ms || 30000 }); };
  var S = { tab: "home", st: null, mode: "search", q: "", url: "", engine: "", out: null, busy: false, msg: "" };

  function when(iso) { try { return new Date(iso).toLocaleString(); } catch (e) { return iso; } }

  function paintChip() {
    var el = $("chip");
    var st = S.st;
    if (!st) { el.textContent = "加载中"; el.className = "chip"; return; }
    var chain = st.routes.search.chain;
    el.textContent = chain.length ? "搜索 " + chain[0] : "无可用搜索引擎";
    el.className = "chip ok";
    el.title = "v" + st.version;
  }

  function chain(r, cooling) {
    if (!r.chain.length) return '<span class="warn">没有可用引擎</span>';
    return r.chain.map(function (n, i) {
      var c = cooling[n] ? " cool" : "";
      return '<span class="pill' + (i === 0 ? " first" : "") + c + '"' + (cooling[n] ? ' title="冷却到 ' + esc(when(cooling[n])) + '"' : "") + ">" + esc(n) + "</span>";
    }).join('<span class="arrow">→</span>');
  }

  function engineCard(e, editable) {
    var roles = e.roles.map(function (r) { return r === "search" ? "搜索" : "读网页"; }).join(" · ");
    var ready = [];
    if (e.roles.indexOf("search") >= 0) ready.push(e.searchReady ? '<span class="badge good">可搜索</span>' : '<span class="badge warn">搜索未就绪</span>');
    if (e.roles.indexOf("fetch") >= 0) ready.push(e.fetchReady ? '<span class="badge good">可读网页</span>' : '<span class="badge warn">读网页未开</span>');
    var h = '<div class="card" data-e="' + esc(e.name) + '"><div class="h"><span class="n">' + esc(e.label) + "</span>" + ready.join("") + "</div>" +
      '<div class="s">' + esc(roles) + " · " + esc(e.pool) + "</div>";
    if (e.cooling) h += '<div class="s warn">配额冷却到 ' + esc(when(e.cooling.until)) + (e.cooling.reason ? "：" + esc(e.cooling.reason) : "") + ' <button class="dbx-btn" data-act="uncool" data-e="' + esc(e.name) + '" type="button">解除</button></div>';
    if (!editable) {
      if (e.keyed) h += '<div class="s">' + (e.keyCount ? "已配置 " + e.keyCount + " 个 key" + (e.keyFromEnv ? "（来自环境变量）" : "") : "未配置 key") + "</div>";
      return h + "</div>";
    }
    h += '<label class="sw"><input type="checkbox" data-f="enabled"' + (e.enabled ? " checked" : "") + " />参与自动选择</label>";
    if (e.name === "firecrawl" || e.name === "keenable") h += '<label class="sw"><input type="checkbox" data-f="keylessFetch"' + (e.keylessFetch ? " checked" : "") + " />没有 key 时也允许云端读网页（会把网址发给该服务）</label>";
    if (e.keyed) {
      var ph = e.keyCount ? "已保存 " + e.keyCount + " 个（" + e.keyHints.join("、") + "）" + (e.keyFromEnv ? "，来自环境变量" : "") + "。要替换就重新粘贴" : (e.keyless ? "可不填，免 key 也能用" : "必填：粘贴 key");
      h += '<label class="f">API key（多个用英文逗号分隔，限额时自动换下一个）<input class="dbx-input" data-f="apiKey" type="password" autocomplete="off" placeholder="' + esc(ph) + '" /></label>';
      if (e.keyCount && !e.keyFromEnv) h += '<div><button class="dbx-btn" data-act="clearkey" data-e="' + esc(e.name) + '" type="button">清除已保存的 key</button></div>';
    }
    if (e.name !== "local") h += '<label class="f">自定义接口地址（可不填）<input class="dbx-input" data-f="baseURL" placeholder="默认官方地址" value="' + esc(e.baseURL) + '" /></label>';
    return h + "</div>";
  }

  function coolingMap(st) {
    var m = {};
    st.engines.forEach(function (e) { if (e.cooling) m[e.name] = e.cooling.until; });
    return m;
  }

  function renderHome() {
    var st = S.st;
    var cm = coolingMap(st);
    var notes = st.routes.search.notes.concat(st.routes.fetch.notes);
    $("view").innerHTML =
      "<h2>当前路线</h2>" +
      '<div class="route"><span class="lbl">搜索</span>' + chain(st.routes.search, cm) + "</div>" +
      '<div class="route"><span class="lbl">读网页</span>' + chain(st.routes.fetch, cm) + "</div>" +
      '<p class="hint">按顺序尝试，前一个失败（超时、限额、被拒）就换下一个。在冷却的引擎排到最后，其余都失败时才会用到。' + (st.settings.allowPrivateNetwork ? ' <span class="warn">当前允许访问内网地址。</span>' : "") + "</p>" +
      (notes.length ? '<p class="hint">' + notes.map(esc).join("<br>") + "</p>" : "") +
      "<h2>引擎</h2>" +
      '<div class="cards">' + st.engines.map(function (e) { return engineCard(e, false); }).join("") + "</div>" +
      '<p class="hint" style="margin-top:12px">什么都不配也能用：Firecrawl、Keenable、You.com 都有免注册的免费额度，读网页用本地直连兜底。想要更大额度，去「引擎」里填自己的 key。AI 要用这些工具，需要在 M-Harness 的插件页允许这个插件被 AI 使用。</p>';
  }

  function opt(v, label, cur) { return '<option value="' + esc(v) + '"' + (cur === v ? " selected" : "") + ">" + esc(label) + "</option>"; }

  function renderEngines() {
    var st = S.st;
    var se = st.engines.filter(function (e) { return e.roles.indexOf("search") >= 0; });
    var fe = st.engines.filter(function (e) { return e.roles.indexOf("fetch") >= 0; });
    $("view").innerHTML =
      '<div class="panel form"><div class="grid2">' +
      '<label class="f">首选搜索引擎<select class="dbx-input" id="pref-engine">' + opt("", "自动（按默认顺序）", st.settings.engine) + se.map(function (e) { return opt(e.name, e.label, st.settings.engine); }).join("") + "</select></label>" +
      '<label class="f">首选读网页引擎<select class="dbx-input" id="pref-fetch">' + opt("", "自动（按默认顺序）", st.settings.fetchEngine) + fe.map(function (e) { return opt(e.name, e.label, st.settings.fetchEngine); }).join("") + "</select></label></div>" +
      '<p class="hint">首选只是偏好：它失败了仍会按默认顺序换别的引擎。</p>' +
      '<label class="sw"><input type="checkbox" id="cooldown"' + (st.settings.cooldown ? " checked" : "") + " />配额冷却：某个引擎（或某把 key）额度用完后，记住恢复时间，先用别的</label>" +
      '<label class="sw"><input type="checkbox" id="private"' + (st.settings.allowPrivateNetwork ? " checked" : "") + " />允许访问内网地址（默认拦截，只在你确认需要时才开）</label>" +
      '<p class="hint">如果你的 VPN、代理或 hosts 加速器把公网域名指到了 127.0.0.1 等保留地址，读网页会被当成内网拦掉，这时才需要打开。</p>' +
      "</div>" +
      '<div class="cards" id="ecards">' + st.engines.map(function (e) { return engineCard(e, true); }).join("") + "</div>" +
      '<div class="row" style="margin-top:12px"><button class="dbx-btn dbx-btn--primary" data-act="save" type="button">保存</button><span id="savemsg" class="hint">' + esc(S.msg) + "</span></div>" +
      '<p class="hint">key 明文只存在本机插件数据目录，不会发回界面，也不会写进日志和错误信息。</p>';
  }

  function collect() {
    var engines = {};
    Array.prototype.forEach.call(document.querySelectorAll("#ecards .card"), function (card) {
      var name = card.getAttribute("data-e");
      var p = {};
      Array.prototype.forEach.call(card.querySelectorAll("[data-f]"), function (inp) {
        var f = inp.getAttribute("data-f");
        if (inp.type === "checkbox") p[f] = inp.checked;
        else if (f === "apiKey") { if (inp.value.trim()) p.apiKey = inp.value.trim(); }
        else p[f] = inp.value.trim();
      });
      engines[name] = p;
    });
    return { engine: $("pref-engine").value, fetchEngine: $("pref-fetch").value, cooldown: $("cooldown").checked, allowPrivateNetwork: $("private").checked, engines: engines };
  }

  function doSave() {
    var box = $("savemsg");
    if (box) box.textContent = "保存中…";
    call("ms/save", collect()).then(function (st) {
      S.st = st;
      S.msg = "已保存";
      paintChip();
      renderEngines();
    }).catch(function (e) { var b = $("savemsg"); if (b) { b.className = "warn"; b.textContent = e.message || String(e); } });
  }

  function renderTry() {
    var st = S.st;
    var opts = st.engines.filter(function (e) { return e.roles.indexOf(S.mode === "search" ? "search" : "fetch") >= 0; });
    $("view").innerHTML =
      '<div class="row" style="margin-bottom:8px">' +
      '<button class="dbx-btn' + (S.mode === "search" ? " dbx-btn--primary" : "") + '" data-act="mode-search" type="button">搜索</button>' +
      '<button class="dbx-btn' + (S.mode === "fetch" ? " dbx-btn--primary" : "") + '" data-act="mode-fetch" type="button">读网页</button></div>' +
      '<div class="row">' +
      (S.mode === "search"
        ? '<input class="dbx-input" id="q" style="flex:1;min-width:220px" placeholder="要搜索的内容" value="' + esc(S.q) + '" />'
        : '<input class="dbx-input" id="u" style="flex:1;min-width:220px" placeholder="https://…" value="' + esc(S.url) + '" />') +
      '<select class="dbx-input" id="eng" style="width:auto">' + opt("", "自动选择", S.engine) + opts.map(function (e) { return opt(e.name, "只用 " + e.label, S.engine); }).join("") + "</select>" +
      '<button class="dbx-btn dbx-btn--primary" data-act="run" type="button"' + (S.busy ? " disabled" : "") + ">" + (S.busy ? "运行中…" : "运行") + "</button></div>" +
      '<p class="hint">指定引擎时是硬指定：它失败就直接报错，不会悄悄换别的引擎花别人的额度。读网页只显示前 1,500 个字符。</p>' +
      '<div id="tryout">' + tryOut() + "</div>";
  }

  function tryOut() {
    var o = S.out;
    if (!o) return "";
    if (o.error) return '<div class="warn" style="white-space:pre-wrap">' + esc(o.error) + "</div>";
    var at = (o.entry.attempts || []).map(function (a) {
      return '<div>' + (a.ok ? '<span class="ok">✓</span>' : '<span class="warn">✗</span>') + " " + esc(a.engine) + (a.keyIndex !== undefined ? " (key " + (a.keyIndex + 1) + ")" : "") +
        (a.durationSeconds != null ? " · " + a.durationSeconds.toFixed(1) + "s" : "") + (a.credits != null ? " · " + a.credits + " 积分" : "") + (a.error ? ' <span class="hint">' + esc(String(a.error).slice(0, 200)) + "</span>" : "") + "</div>";
    }).join("");
    return '<div class="attempts">' + at + '</div><pre class="out">' + esc(o.text) + "</pre>";
  }

  function doRun() {
    if (S.busy) return;
    S.engine = $("eng").value;
    var isSearch = S.mode === "search";
    if (isSearch) S.q = $("q").value.trim(); else S.url = $("u").value.trim();
    S.busy = true;
    S.out = null;
    renderTry();
    var p = isSearch ? call("ms/test-search", { query: S.q, engine: S.engine }, 60000) : call("ms/test-fetch", { url: S.url, engine: S.engine }, 80000);
    p.then(function (r) { S.out = r; if (r.status) { S.st = r.status; paintChip(); } }).catch(function (e) { S.out = { error: e.message || String(e) }; }).then(function () { S.busy = false; if (S.tab === "try") renderTry(); });
  }

  function render() {
    paintChip();
    Array.prototype.forEach.call($("tabs").querySelectorAll("button"), function (b) { b.classList.toggle("on", b.getAttribute("data-t") === S.tab); });
    if (!S.st) { $("view").innerHTML = '<span class="hint">加载中…</span>'; return; }
    if (S.tab === "engines") return renderEngines();
    if (S.tab === "try") return renderTry();
    return renderHome();
  }

  function reload() {
    return call("ms/status").then(function (s) { S.st = s; render(); }).catch(function (e) {
      $("view").innerHTML = '<div class="warn">' + esc(e.message || String(e)) + "</div>";
    });
  }

  $("tabs").addEventListener("click", function (e) {
    var t = e.target.getAttribute && e.target.getAttribute("data-t");
    if (!t) return;
    S.tab = t;
    S.msg = "";
    render();
  });
  $("refresh").addEventListener("click", function () { S.msg = ""; reload(); });
  $("view").addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-act]");
    if (!el) return;
    var act = el.getAttribute("data-act");
    if (act === "save") doSave();
    else if (act === "run") doRun();
    else if (act === "mode-search") { S.mode = "search"; S.engine = ""; S.out = null; renderTry(); }
    else if (act === "mode-fetch") { S.mode = "fetch"; S.engine = ""; S.out = null; renderTry(); }
    else if (act === "uncool") call("ms/clear-cooldown", { engine: el.getAttribute("data-e") }).then(function (s) { S.st = s; render(); }).catch(function () {});
    else if (act === "clearkey") call("ms/save", { engines: (function () { var o = {}; o[el.getAttribute("data-e")] = { apiKey: "" }; return o; })() }).then(function (s) { S.st = s; render(); }).catch(function () {});
  });
  $("view").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.target.id === "q" || e.target.id === "u")) doRun();
  });

  api.ready.then(reload);
})();
