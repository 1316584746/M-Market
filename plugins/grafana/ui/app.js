(function () {
  "use strict";
  var api = window.dbxPlugin;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var call = function (m, p) { return api.invoke(m, p || {}, { timeoutMs: 30000 }); };
  var S = { tab: "home", status: null, query: "", detail: null, seq: 0, mode: "" };

  var STATE = { active: "触发中", alerting: "触发中", pending: "待定", suppressed: "已抑制", paused: "已暂停", ok: "正常", no_data: "无数据" };
  function stateText(s) { return STATE[s] || s || "未知"; }
  function stateClass(s) { return s === "active" || s === "alerting" ? "bad" : s === "pending" || s === "no_data" ? "warn" : ""; }

  function paintChip() {
    var s = S.status;
    var el = $("chip");
    if (!s || !s.hasToken) { el.textContent = "未连接"; el.className = "chip"; return; }
    if (!s.connected) { el.textContent = "连接失败"; el.className = "chip"; el.title = s.error || ""; return; }
    el.textContent = s.org || "已连接";
    el.className = "chip ok";
    el.title = (s.version ? "Grafana " + s.version + " · " : "") + (s.url || "");
  }

  function needConn() {
    $("view").innerHTML = '<div class="empty">还没有连接 Grafana。<button class="dbx-btn" data-act="goto-conn" type="button">去连接</button></div>';
  }

  var EYE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';
  // 带「显示 / 隐藏」眼睛的密码框
  function pw(id, placeholder) {
    return '<span class="pw"><input class="dbx-input" id="' + id + '" type="password" placeholder="' + esc(placeholder) + '" autocomplete="off" /><button type="button" class="eye" data-act="eye" data-for="' + id + '" title="显示 / 隐藏" aria-label="显示 / 隐藏">' + EYE + "</button></span>";
  }

  function renderConn() {
    var st = S.status || {};
    var saved = !!st.hasToken;
    var mode = S.mode || (saved && st.authMode) || "token";
    var url = S.status && S.status.url ? S.status.url : "";
    var err = S.status && S.status.error ? S.status.error : "";
    $("view").innerHTML =
      '<h2>连接</h2>' +
      '<div class="form">' +
      '<label>Grafana 地址<input class="dbx-input" id="url" placeholder="https://your-org.grafana.net" value="' + esc(url) + '" /></label>' +
      '<div class="seg" id="mode"><button type="button" data-act="mode" data-mode="token" class="' + (mode === "token" ? "on" : "") + '">服务账号令牌</button><button type="button" data-act="mode" data-mode="basic" class="' + (mode === "basic" ? "on" : "") + '">账号 + 密码</button></div>' +
      (mode === "token"
        ? '<label>服务账号令牌' + pw("token", saved && st.authMode === "token" ? "已保存。要更换就重新粘贴" : "glsa_…") + "</label>"
        : '<label>账号<input class="dbx-input" id="username" placeholder="登录 Grafana 用的账号" value="' + esc(st.authMode === "basic" ? st.username || "" : "") + '" autocomplete="off" /></label>' +
          '<label>密码' + pw("password", saved && st.authMode === "basic" ? "已保存。要更换就重新输入" : "登录 Grafana 用的密码") + "</label>") +
      '<div class="row"><button class="dbx-btn dbx-btn--primary" data-act="connect" type="button">连接</button>' +
      (saved ? '<button class="dbx-btn" data-act="disconnect" type="button">断开</button>' : "") +
      '<span class="warn" id="connerr">' + esc(err) + "</span></div>" +
      (mode === "token"
        ? '<p class="hint">在 Grafana 里：Administration → Users and access → Service accounts，新建一个 Viewer 角色的令牌。本插件只读，不会改告警或仪表盘。令牌明文存在本机插件数据目录，不会发回界面。</p>'
        : '<p class="hint">没有权限建令牌时，可以用平时登录 Grafana 的账号和密码（本地账号或 LDAP 账号）。插件只读，不会改告警或仪表盘；账号密码明文存在本机插件数据目录，不会发回界面。如果你们是公司单点登录（OAuth / SSO）、没有单独的 Grafana 密码，这种方式用不了，需要找管理员要一个服务账号令牌。密码填错会被 Grafana 记一次失败登录，连错几次可能被暂时锁定，请确认后再点连接。</p>') +
      '<p class="hint">公网地址请用 https。本机和局域网（例如 http://127.0.0.1:3000）可以用 http。Grafana 如果挂在子路径下，把子路径也写上。</p>' +
      "</div>";
  }

  function renderHome() {
    var s = S.status || {};
    var n = S.seq;
    $("view").innerHTML =
      '<div class="cards">' +
      '<div class="card"><div class="k">组织</div><div class="v">' + esc(s.org || "—") + "</div></div>" +
      '<div class="card"><div class="k">版本</div><div class="v">' + esc(s.version || "—") + "</div></div>" +
      '<div class="card"><div class="k">数据库</div><div class="v">' + esc(s.database || "—") + "</div></div>" +
      '<div class="card"><div class="k">告警</div><div class="v" id="acount">…</div></div>' +
      "</div>" +
      '<h2>最近注释</h2><div id="notes"><span class="hint">加载中…</span></div>';
    call("gf/alerts").then(function (r) {
      if (n !== S.seq || S.tab !== "home") return;
      var firing = (r.items || []).filter(function (a) { return a.state === "active" || a.state === "alerting"; }).length;
      $("acount").textContent = firing ? firing + " 条触发中" : "没有触发";
    }).catch(function (e) { if (n === S.seq && $("acount")) $("acount").textContent = e.message || String(e); });
    call("gf/annotations").then(function (r) {
      if (n !== S.seq || S.tab !== "home") return;
      var items = r.items || [];
      $("notes").innerHTML = items.length ? '<div class="list">' + items.map(function (a) {
        var when = a.time ? new Date(a.time).toLocaleString() : "";
        return '<div class="li"><div class="main"><div class="t">' + esc(a.text || "（无内容）") + '</div><div class="s">' + esc(when) + (a.dashboardUID ? " · " + esc(a.dashboardUID) : "") + "</div></div></div>";
      }).join("") + "</div>" : '<div class="empty">没有注释。</div>';
    }).catch(function (e) { if (n === S.seq && $("notes")) $("notes").innerHTML = '<div class="warn">' + esc(e.message || String(e)) + "</div>"; });
  }

  function renderAlerts() {
    var n = S.seq;
    $("view").innerHTML = '<h2>告警</h2><div id="alist"><span class="hint">加载中…</span></div>';
    call("gf/alerts").then(function (r) {
      if (n !== S.seq || S.tab !== "alerts") return;
      var items = r.items || [];
      $("alist").innerHTML = items.length ? '<div class="list">' + items.map(function (a) {
        return '<div class="li"><span class="badge ' + stateClass(a.state) + '">' + esc(stateText(a.state)) + '</span><div class="main"><div class="t">' + esc(a.name) + "</div>" +
          '<div class="s">' + esc([a.folder, a.summary, a.startsAt].filter(Boolean).join(" · ")) + "</div></div></div>";
      }).join("") + "</div>" : '<div class="empty">当前没有告警。</div>';
    }).catch(function (e) { if (n === S.seq && $("alist")) $("alist").innerHTML = '<div class="warn">' + esc(e.message || String(e)) + "</div>"; });
  }

  function renderDash() {
    if (S.detail) {
      var d = S.detail;
      $("view").innerHTML =
        '<button class="dbx-btn back" data-act="back" type="button">返回列表</button>' +
        "<h2>" + esc(d.title) + "</h2>" +
        '<p class="hint">' + esc(d.folder || "无文件夹") + "</p>" +
        '<p class="url">' + esc(d.url) + "</p>" +
        (d.panels.length ? '<div class="list">' + d.panels.map(function (p) {
          return '<div class="li"><span class="badge">' + esc(p.type || "panel") + '</span><div class="main"><div class="t">' + esc(p.title) + "</div></div></div>";
        }).join("") + "</div>" : '<div class="empty">这个仪表盘没有面板。</div>');
      return;
    }
    $("view").innerHTML =
      '<h2>仪表盘</h2>' +
      '<div class="row" style="margin-bottom:8px"><input class="dbx-input" id="q" placeholder="按标题搜索" value="' + esc(S.query) + '" /><button class="dbx-btn" data-act="search" type="button">搜索</button></div>' +
      '<div id="dlist"><span class="hint">加载中…</span></div>';
    var n = S.seq;
    call("gf/dashboards", { query: S.query }).then(function (r) {
      if (n !== S.seq || S.tab !== "dash" || S.detail) return;
      var items = r.items || [];
      $("dlist").innerHTML = items.length ? '<div class="list">' + items.map(function (d) {
        return '<div class="li click" data-act="open-dash" data-uid="' + esc(d.uid) + '"><div class="main"><div class="t">' + esc(d.title) + "</div>" +
          '<div class="s">' + esc(d.folder || "无文件夹") + (d.tags.length ? " · " + esc(d.tags.join(", ")) : "") + "</div></div></div>";
      }).join("") + "</div>" : '<div class="empty">没有匹配的仪表盘。</div>';
    }).catch(function (e) { if (n === S.seq && $("dlist")) $("dlist").innerHTML = '<div class="warn">' + esc(e.message || String(e)) + "</div>"; });
  }

  function render() {
    S.seq++;
    paintChip();
    Array.prototype.forEach.call($("tabs").querySelectorAll("button"), function (b) { b.classList.toggle("on", b.getAttribute("data-t") === S.tab); });
    if (S.tab === "conn") return renderConn();
    if (!S.status || !S.status.connected) return needConn();
    if (S.tab === "alerts") return renderAlerts();
    if (S.tab === "dash") return renderDash();
    return renderHome();
  }

  function reload() {
    return call("gf/status").then(function (s) { S.status = s; render(); }).catch(function (e) {
      S.status = { connected: false, hasToken: false, error: e.message || String(e) };
      render();
    });
  }

  $("tabs").addEventListener("click", function (e) {
    var t = e.target.getAttribute && e.target.getAttribute("data-t");
    if (!t) return;
    S.tab = t;
    if (t !== "dash") S.detail = null;
    render();
  });
  $("refresh").addEventListener("click", function () { S.detail = null; reload(); });
  $("view").addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-act]");
    if (!el) return;
    var act = el.getAttribute("data-act");
    if (act === "goto-conn") { S.tab = "conn"; render(); }
    else if (act === "connect") doConnect();
    else if (act === "eye") {
      var inp = $(el.getAttribute("data-for"));
      if (inp) {
        var show = inp.type === "password";
        inp.type = show ? "text" : "password";
        el.innerHTML = show ? EYE_OFF : EYE;
        inp.focus();
      }
    }
    else if (act === "mode") { S.mode = el.getAttribute("data-mode"); renderConn(); }
    else if (act === "disconnect") doDisconnect();
    else if (act === "search") doSearch();
    else if (act === "back") { S.detail = null; render(); }
    else if (act === "open-dash") openDash(el.getAttribute("data-uid"));
  });
  $("view").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    if (e.target.id === "q") doSearch();
    if (e.target.id === "url" || e.target.id === "token" || e.target.id === "username" || e.target.id === "password") doConnect();
  });

  function doConnect() {
    var url = $("url") ? $("url").value.trim() : "";
    var p = { url: url };
    if ($("username")) { p.username = $("username").value.trim(); p.password = $("password").value; }
    else if ($("token")) p.token = $("token").value.trim();
    call("gf/connect", p).then(function (s) {
      S.status = s;
      S.tab = "home";
      S.detail = null;
      render();
    }).catch(function (e) { var box = $("connerr"); if (box) box.textContent = e.message || String(e); });
  }
  function doDisconnect() {
    call("gf/disconnect").then(function (s) { S.status = s; S.detail = null; S.tab = "conn"; render(); }).catch(function (e) { var box = $("connerr"); if (box) box.textContent = e.message || String(e); });
  }
  function doSearch() {
    S.query = $("q") ? $("q").value.trim() : "";
    S.detail = null;
    render();
  }
  function openDash(uid) {
    var n = ++S.seq;
    $("view").innerHTML = '<span class="hint">加载中…</span>';
    call("gf/dashboard", { uid: uid }).then(function (d) {
      if (n !== S.seq) return;
      S.detail = d;
      S.tab = "dash";
      render();
    }).catch(function (e) { if (n === S.seq) $("view").innerHTML = '<div class="warn">' + esc(e.message || String(e)) + "</div>"; });
  }

  api.ready.then(reload);
})();
