(function () {
  "use strict";
  var api = window.dbxPlugin;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var call = function (m, p, t) { return api.invoke(m, p || {}, { timeoutMs: t || 60000 }); };
  var timer = null;

  function err(e) { $("err").textContent = e ? (e.message || String(e)) : ""; }

  function renderStatus(s) {
    var dot = s.running ? "on" : "off";
    var line = '<span class="dot ' + dot + '"></span>' + (s.running ? "代理运行中" : "代理未运行") + " · " + (s.installed ? "已安装 " + esc(s.version) : "未安装 billion-context");
    if (s.running) line += " · 监听 " + esc(s.origin) + (s.managed ? "（由本插件启动）" : "（外部启动）");
    if (s.installing) line += " · 正在安装…";
    $("status").innerHTML = line;
    $("install").hidden = s.installed || s.installing;
    $("start").hidden = !s.installed || s.running;
    $("stop").hidden = !s.managed;
    $("port").value = s.port;
    $("port-box").hidden = s.managed;
  }

  function refresh() {
    return call("bili/status").then(renderStatus).catch(err);
  }

  function renderLogs() {
    call("bili/logs").then(function (r) {
      $("log").textContent = r.lines.length ? r.lines.join("\n") : "（还没有日志）";
      $("log").scrollTop = $("log").scrollHeight;
    }).catch(function () {});
  }

  function loadProviders() {
    call("providers/list").then(function (r) {
      if (!r.configFound) { $("providers").innerHTML = '<span class="dbx-hint">没有读到 M-Harness 的配置文件（' + esc(r.home) + "）。</span>"; return; }
      if (!r.items.length) { $("providers").innerHTML = '<span class="dbx-hint">配置里还没有 OpenAI 兼容 / Anthropic 类型的模型提供方。</span>'; return; }
      $("providers").innerHTML = r.items.map(function (p) {
        return '<div class="prov"><div class="h"><span class="n">' + esc(p.name) + '</span><span class="dbx-badge">' + esc(p.type) + "</span>" + (p.model ? '<span class="dbx-hint">' + esc(p.model) + "</span>" : "") + (p.isDefault ? '<span class="dbx-badge">默认</span>' : "") + (p.proxied ? '<span class="dbx-badge">已走代理</span>' : "") + "</div>" +
          '<div class="dbx-hint">原地址' + (p.defaulted ? "（未填写，按官方默认）" : "") + "：" + esc(p.original) + "</div>" +
          '<div class="dbx-hint">走代理的地址（选中复制）：</div><input class="dbx-input" readonly value="' + esc(p.proxyURL) + '" onfocus="this.select()" /></div>';
      }).join("");
    }).catch(function (e) { $("providers").innerHTML = '<span class="warn">' + esc(e.message || e) + "</span>"; });
  }

  function act(name, btn) {
    err("");
    btn.disabled = true;
    call(name, {}, 120000).then(function () { return refresh(); }).catch(err).then(function () { btn.disabled = false; renderLogs(); loadProviders(); });
  }

  $("install").addEventListener("click", function () { act("bili/install", $("install")); });
  $("start").addEventListener("click", function () { act("bili/start", $("start")); });
  $("stop").addEventListener("click", function () { act("bili/stop", $("stop")); });
  $("refresh").addEventListener("click", function () { err(""); refresh(); renderLogs(); loadProviders(); });
  $("setport").addEventListener("click", function () {
    err("");
    call("bili/setPort", { port: $("port").value }).then(function (s) { renderStatus(s); loadProviders(); }).catch(err);
  });

  api.ready.then(function () {
    refresh(); renderLogs(); loadProviders();
    timer = setInterval(function () { refresh(); renderLogs(); }, 3000);
  });
})();
