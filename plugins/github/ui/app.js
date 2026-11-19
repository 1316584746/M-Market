(function () {
  "use strict";
  var api = window.dbxPlugin;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var view = $("view");

  // ───────── 中英文 ─────────
  // 界面文字都以中文原文作为 key，英文译文在 i18n.js；t("第 {0} 页", n) 用 {0} {1} 占位。
  // 注意：往 innerHTML 里拼的参数要先 esc()，t() 本身不转义。
  var EN = window.GH_EN || {};
  var lsGet = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var lsSet = function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 存不了就只在本次有效 */ } };
  var hostLocale = String((api && api.locale) || (navigator.language || "zh")).toLowerCase();
  var lang = lsGet("gh.lang") || (/^zh/.test(hostLocale) ? "zh" : "en");
  if (lang !== "en") lang = "zh";
  function t(zh) {
    var s = lang === "en" && EN[zh] != null ? EN[zh] : zh;
    if (arguments.length > 1) { var a = arguments; s = s.replace(/\{(\d)\}/g, function (_, i) { return a[+i + 1]; }); }
    return s;
  }
  var rpc = function (m, p, ms) { p = p || {}; p.lang = lang; return api.invoke(m, p, { timeoutMs: ms || 90000 }); };

  var S = { me: null, repo: null, tab: "code", ref: "", seq: 0, view: "login", apiBase: "", redo: null };

  // ───────── 通用 ─────────
  var toastTimer;
  function toast(msg, isErr) {
    var el = $("toast");
    el.textContent = msg; el.className = "toast" + (isErr ? " err" : ""); el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, isErr ? 7000 : 2800);
  }
  function fail(e) { toast(e && e.message ? e.message : String(e), true); }
  function ago(iso) {
    if (!iso) return "";
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return t("刚刚");
    if (s < 3600) return t("{0} 分钟前", Math.floor(s / 60));
    if (s < 86400) return t("{0} 小时前", Math.floor(s / 3600));
    if (s < 86400 * 30) return t("{0} 天前", Math.floor(s / 86400));
    return new Date(iso).toISOString().slice(0, 10);
  }
  function avatar(u) { return u && u.avatar ? '<img src="' + esc(u.avatar) + (u.avatar.indexOf("?") > 0 ? "&" : "?") + 's=40" alt="" onerror="this.remove()" />' : ""; }
  function labels(ls) { return (ls || []).map(function (l) { return '<span class="lbl"' + (l.color ? ' style="border:1px solid #' + esc(String(l.color).replace(/[^0-9a-fA-F]/g, "")) + '"' : "") + ">" + esc(l.name) + "</span>"; }).join("");  }
  function loading() { return '<div class="dbx-hint pad">' + esc(t("加载中…")) + "</div>"; }
  function errBox(e) { return '<div class="pad warn">' + esc(e && e.message ? e.message : e) + "</div>"; }
  function empty(zh) { return '<div class="empty">' + esc(t(zh)) + "</div>"; }
  function linkBox(url) { return url ? '<div class="dbx-hint" style="margin:6px 0">' + esc(t("链接（点一下全选，复制到浏览器打开）")) + '<input class="dbx-input" readonly value="' + esc(url) + '" onfocus="this.select()" /></div>' : ""; }
  function each(root, sel, fn) { Array.prototype.forEach.call(root.querySelectorAll(sel), fn); }

  // 小图标（描边，跟随文字颜色）
  var ICONS = {
    folder: '<path d="M1.5 3.5h4l1.5 1.5h7.5v7.5h-13z"/>',
    star: '<path d="M8 1.6l2 4.2 4.6.6-3.4 3.2.9 4.5L8 11.7 3.9 14.1l.9-4.5L1.4 6.4 6 5.8z"/>',
    issue: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/>',
    pr: '<circle cx="4" cy="3.6" r="1.7"/><circle cx="4" cy="12.4" r="1.7"/><circle cx="12" cy="12.4" r="1.7"/><path d="M4 5.3v5.4M12 10.7V7a2 2 0 0 0-2-2H8.5"/><path d="M10 3.4L8.4 5 10 6.6"/>',
    bell: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z"/><path d="M6.5 14h3"/>',
    code: '<path d="M5 4L1.5 8 5 12M11 4l3.5 4L11 12"/>',
    play: '<circle cx="8" cy="8" r="6"/><path d="M6.6 5.6l3.6 2.4-3.6 2.4z" fill="currentColor"/>',
    tag: '<path d="M2 2h6l6 6-6 6-6-6z"/><circle cx="5.2" cy="5.2" r="1" fill="currentColor"/>',
    branch: '<circle cx="4" cy="3.4" r="1.7"/><circle cx="4" cy="12.6" r="1.7"/><circle cx="12" cy="5.4" r="1.7"/><path d="M4 5.1v5.8M12 7.1c0 2.4-3 2.2-6.4 4"/>',
    search: '<circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5L14 14"/>',
    lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2"/>',
    refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/>',
    compass: '<circle cx="8" cy="8" r="6.2"/><path d="M10.9 5.1L9.2 9.2 5.1 10.9 6.8 6.8z"/>',
  };
  function ic(name) { return '<svg class="ic" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>"; }

  // 仓库名首字母的彩色小方块（同名同色）
  function tile(name, big) {
    var s = String(name || "?"), h = 0, i;
    for (i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    var m = /[A-Za-z0-9\u4e00-\u9fa5]/.exec(s);
    return '<span class="tile' + (big ? " big" : "") + '" style="--h:' + h + '">' + esc((m ? m[0] : "?").toUpperCase()) + "</span>";
  }

  function openDialog(html) { $("dlg").innerHTML = html; $("modal").hidden = false; return $("dlg"); }
  function closeDialog() { $("modal").hidden = true; $("dlg").innerHTML = ""; }
  $("modal").addEventListener("mousedown", function (e) { if (e.target === $("modal")) closeDialog(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDialog(); });

  /** 弹出确认框；ok() 返回 Promise，成功后关框 */
  function confirmBox(title, msg, okLabel, danger, ok) {
    var d = openDialog("<h3>" + esc(title) + '</h3><div class="txt">' + esc(msg) + '</div><div class="foot"><button class="dbx-btn" data-x="no">' + esc(t("取消")) + '</button><button class="dbx-btn ' + (danger ? "dbx-btn--danger" : "dbx-btn--primary") + '" data-x="ok">' + esc(okLabel) + "</button></div>");
    d.querySelector('[data-x="no"]').onclick = closeDialog;
    d.querySelector('[data-x="ok"]').onclick = function () {
      var b = this; b.disabled = true;
      new Promise(function (res) { res(ok()); }).then(closeDialog).catch(function (e) { b.disabled = false; fail(e); });
    };
  }

  /** 弹出表单：fields = [{ id, label, type: text|area|select|check, value, options, placeholder }]；ok(values) 返回 Promise；label / placeholder 传已翻译的文字 */
  function formBox(title, fields, okLabel, ok, note) {
    var h = "<h3>" + esc(title) + '</h3><div class="form">';
    fields.forEach(function (f) {
      var lab = '<label class="dbx-label" for="f-' + f.id + '">' + esc(f.label) + "</label>";
      if (f.type === "area") h += "<div>" + lab + '<textarea class="dbx-textarea" id="f-' + f.id + '" rows="' + (f.rows || 6) + '" placeholder="' + esc(f.placeholder || "") + '"></textarea></div>';
      else if (f.type === "select") h += "<div>" + lab + '<select class="dbx-select" id="f-' + f.id + '">' + (f.options || []).map(function (o) { return '<option value="' + esc(o.value) + '">' + esc(o.label) + "</option>"; }).join("") + "</select></div>";
      else if (f.type === "check") h += '<label class="r"><input type="checkbox" id="f-' + f.id + '" /> ' + esc(f.label) + "</label>";
      else h += "<div>" + lab + '<input class="dbx-input" id="f-' + f.id + '" type="' + (f.type === "password" ? "password" : "text") + '" placeholder="' + esc(f.placeholder || "") + '" /></div>';
    });
    h += "</div>" + (note ? '<p class="dbx-hint">' + note + "</p>" : "") + '<div class="foot"><button class="dbx-btn" data-x="no">' + esc(t("取消")) + '</button><button class="dbx-btn dbx-btn--primary" data-x="ok">' + esc(okLabel) + "</button></div>";
    var d = openDialog(h);
    fields.forEach(function (f) {
      var el = $("f-" + f.id);
      if (f.type === "check") el.checked = !!f.value; else if (f.value != null) el.value = f.value;
    });
    var first = $("f-" + fields[0].id); if (first && first.focus) first.focus();
    d.querySelector('[data-x="no"]').onclick = closeDialog;
    d.querySelector('[data-x="ok"]').onclick = function () {
      var b = this, vals = {};
      fields.forEach(function (f) { var el = $("f-" + f.id); vals[f.id] = f.type === "check" ? el.checked : el.value; });
      b.disabled = true;
      new Promise(function (res) { res(ok(vals)); }).then(closeDialog).catch(function (e) { b.disabled = false; fail(e); });
    };
  }

  function pager(page, hasNext) {
    if (page <= 1 && !hasNext) return "";
    return '<div class="pager"><button class="dbx-btn" data-pg="' + (page - 1) + '"' + (page <= 1 ? " disabled" : "") + ">" + esc(t("上一页")) + '</button><span class="dbx-hint">' + esc(t("第 {0} 页", page)) + '</span><button class="dbx-btn" data-pg="' + (page + 1) + '"' + (hasNext ? "" : " disabled") + ">" + esc(t("下一页")) + "</button></div>";
  }
  function bindPager(root, fn) { each(root, "[data-pg]", function (b) { b.onclick = function () { fn(+b.getAttribute("data-pg")); }; }); }

  // ───────── 外壳：顶栏、左侧导航、语言切换 ─────────
  function hostOf(base) { try { var h = new URL(base).hostname; return h === "api.github.com" ? "github.com" : h; } catch (e) { return ""; } }
  function renderWho() {
    $("who").innerHTML = S.me ? (S.apiBase ? '<span class="chip host" title="' + esc(S.apiBase) + '">' + esc(hostOf(S.apiBase)) + "</span>" : "") + avatar(S.me) + "<span>" + esc(S.me.login) + '</span><button class="dbx-btn" id="b-settings">' + esc(t("设置")) + "</button>" : "";
    if (S.me) $("b-settings").onclick = openSettings;
  }
  var VIEW_TITLE = { repos: "仓库", issues: "Issues", pulls: "Pull Requests", notifs: "通知", explore: "探索" };
  function renderCrumb(extra) {
    var h;
    if (S.repo) {
      h = '<a id="c-home">' + esc(t("仓库")) + '</a> / <a id="c-repo">' + esc(S.repo.full) + "</a>";
      if (extra) h += " / " + esc(extra);
    } else {
      h = esc(t(VIEW_TITLE[S.view] || ""));
    }
    $("crumb").innerHTML = h;
    if (S.repo) {
      $("c-home").onclick = function () { navTo("repos"); };
      $("c-repo").onclick = function () { setTab(S.tab); };
    }
  }
  var REPO_NAV = [["code", "代码", "code"], ["issues", "Issues", "issue"], ["pulls", "Pull Requests", "pr"], ["actions", "Actions", "play"], ["releases", "Releases", "tag"], ["branches", "分支", "branch"]];
  function paintSide() {
    var side = $("sidebar");
    var item = function (key, icon, label, on) { return '<a class="nv' + (on ? " on" : "") + '" role="button" tabindex="0" data-nav="' + key + '">' + ic(icon) + "<span>" + esc(t(label)) + "</span></a>"; };
    var h = "";
    if (S.repo) {
      h += '<a class="nv back" role="button" tabindex="0" data-nav="repos">← ' + esc(t("全部仓库")) + "</a>";
      h += '<div class="sb-repo">' + tile(S.repo.name, true) + '<div class="sb-repo-t"><b title="' + esc(S.repo.full) + '">' + esc(S.repo.name) + "</b><span>" + esc(S.repo.owner || "") + "</span></div></div>";
      h += REPO_NAV.map(function (n) { return item("tab:" + n[0], n[2], n[1], S.tab === n[0]); }).join("");
    } else {
      h += '<div class="sb-acct">' + tile("GitHub", true) + "<b>" + esc(S.me ? S.me.login : "GitHub") + "</b></div>";
      h += '<div class="sb-search">' + ic("search") + '<input id="sb-q" class="dbx-input" placeholder="' + esc(t("搜索或跳转到…")) + '" /></div>';
      h += '<div class="sb-h">' + esc(t("仓库")) + "</div>";
      h += item("repos", "folder", "全部仓库", S.view === "repos" && repoQ.scope !== "starred");
      h += item("starred", "star", "已加星标", S.view === "repos" && repoQ.scope === "starred");
      h += '<div class="sb-h">' + esc(t("你的工作")) + "</div>";
      h += item("issues", "issue", "Issues", S.view === "issues");
      h += item("pulls", "pr", "Pull Requests", S.view === "pulls");
      h += item("notifs", "bell", "通知", S.view === "notifs");
      h += '<div class="sb-h">' + esc(t("发现")) + "</div>";
      h += item("explore", "compass", "探索", S.view === "explore");
    }
    side.innerHTML = h;
    each(side, "[data-nav]", function (a) {
      var go = function () {
        var k = a.getAttribute("data-nav");
        if (k.indexOf("tab:") === 0) setTab(k.slice(4));
        else if (k === "starred") { repoQ.scope = "starred"; repoQ.page = 1; repoQ.search = false; repoQ.q = ""; navTo("repos"); }
        else if (k === "repos") { repoQ.scope = "all"; repoQ.page = 1; repoQ.search = false; navTo("repos"); }
        else navTo(k);
      };
      a.onclick = go;
      a.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    });
    var q = $("sb-q");
    if (q) q.onkeydown = function (e) {
      if (e.key !== "Enter") return;
      var v = q.value.trim(); if (!v) return;
      if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) return openRepo(v);
      repoQ.q = v; repoQ.search = false; repoQ.scope = "all"; repoQ.page = 1; navTo("repos");
    };
  }
  function paintLang() {
    each($("lang"), "[data-l]", function (b) { b.classList.toggle("on", b.getAttribute("data-l") === lang); });
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    $("brandName").textContent = t("GitHub 管理台");
    document.title = t("GitHub 管理台");
  }
  function setLang(l) {
    if (l === lang) return;
    lang = l; lsSet("gh.lang", l);
    api.invoke("gh/setLang", { lang: l }, { timeoutMs: 8000 }).catch(function () { /* 存不了不影响界面 */ });
    paintLang(); renderWho(); paintSide();
    if (S.view === "login") return renderLogin(S.loginMsg);
    renderCrumb();
    if (S.redo) S.redo();
  }
  each($("lang"), "[data-l]", function (b) { b.onclick = function () { setLang(b.getAttribute("data-l")); }; });
  paintLang();
  view.innerHTML = loading();

  /** 切到一个全局页面：repos / issues / pulls / notifs */
  function navTo(v) {
    S.repo = null; S.view = v; S.seq++;
    document.body.classList.remove("no-side");
    ({ repos: showRepos, issues: function () { showWork("issues"); }, pulls: function () { showWork("pulls"); }, notifs: showNotifs, explore: showExplore })[v]();
  }

  // ───────── 登录 / 设置 ─────────
  function renderLogin(msg) {
    S.me = null; S.repo = null; S.view = "login"; S.loginMsg = msg; S.redo = null;
    document.body.classList.add("no-side");
    renderWho(); $("crumb").innerHTML = "";
    view.innerHTML = '<div class="box login"><h2>' + esc(t("连接 GitHub")) + "</h2><p class=\"dbx-hint\">" + t("填一个个人访问令牌（PAT）。仓库读写要 <b>repo</b> 权限，改工作流文件和触发 Actions 要 <b>workflow</b>，看通知要 <b>notifications</b>。细粒度令牌请给对应仓库勾上 Contents、Issues、Pull requests、Actions 的读写。令牌只保存在这个插件自己的数据目录里，不会发给界面或 AI。") + "</p>" +
      (msg ? '<p class="warn">' + esc(msg) + "</p>" : "") +
      '<div class="form"><div><label class="dbx-label">' + esc(t("令牌")) + '</label><input class="dbx-input" id="l-token" type="password" placeholder="ghp_… / github_pat_…" /></div>' +
      '<details><summary class="dbx-hint">' + esc(t("企业版 / 自定义 API 地址（可选）")) + '</summary><input class="dbx-input" id="l-base" placeholder="https://github.example.com/api/v3" /></details>' +
      '<div><button class="dbx-btn dbx-btn--primary" id="l-go">' + esc(t("连接")) + "</button></div></div></div>";
    $("l-go").onclick = function () {
      var b = this; b.disabled = true;
      rpc("gh/login", { token: $("l-token").value, apiBase: $("l-base").value }).then(function (r) { S.me = r.user; S.apiBase = r.apiBase; start(); }).catch(function (e) { b.disabled = false; fail(e); });
    };
  }
  function openSettings() {
    rpc("gh/status").then(function (st) {
      var d = openDialog("<h3>" + esc(t("设置")) + "</h3><p>" + t("已登录为 <b>{0}</b>", esc(S.me.login)) + '　<span class="dbx-hint">' + esc(st.apiBase) + '</span></p><div class="form"><div><label class="dbx-label">' + esc(t("换一个令牌（留空不改）")) + '</label><input class="dbx-input" id="s-token" type="password" /></div></div><div class="foot"><button class="dbx-btn dbx-btn--danger" data-x="out">' + esc(t("退出登录并删除令牌")) + '</button><span style="flex:1"></span><button class="dbx-btn" data-x="no">' + esc(t("关闭")) + '</button><button class="dbx-btn dbx-btn--primary" data-x="ok">' + esc(t("保存")) + "</button></div>");
      d.querySelector('[data-x="no"]').onclick = closeDialog;
      d.querySelector('[data-x="out"]').onclick = function () { rpc("gh/logout").then(function () { closeDialog(); renderLogin(); }).catch(fail); };
      d.querySelector('[data-x="ok"]').onclick = function () {
        var tk = $("s-token").value; if (!tk) return closeDialog();
        rpc("gh/login", { token: tk }).then(function (r) { S.me = r.user; renderWho(); paintSide(); closeDialog(); toast(t("已更新令牌")); }).catch(fail);
      };
    }).catch(fail);
  }

  // ───────── 仓库列表 ─────────
  var repoQ = { q: "", search: false, page: 1, scope: "all", sort: "pushed", dir: "desc" };
  var SCOPES = [["all", "我的"], ["starred", "已加星标"], ["owned", "个人"], ["archived", "已归档"]];
  var SORTS = [["pushed", "最近活跃"], ["name", "名称"], ["stars", "星标数"], ["created", "创建时间"]];
  function showRepos() {
    S.view = "repos"; S.repo = null; S.redo = showRepos;
    renderCrumb(); paintSide();
    view.innerHTML = '<div class="page-h"><h1>' + esc(t("仓库")) + '</h1><span class="count" id="r-count"></span><span class="grow"></span><button class="dbx-btn dbx-btn--primary" id="r-new">' + esc(t("新建仓库")) + "</button></div>" +
      '<div class="tabs" id="r-tabs">' + SCOPES.map(function (s) { return '<div class="tab' + (!repoQ.search && repoQ.scope === s[0] ? " on" : "") + '" role="button" tabindex="0" data-scope="' + s[0] + '">' + esc(t(s[1])) + "</div>"; }).join("") + "</div>" +
      '<div class="bar"><div class="sinput">' + ic("search") + '<input class="dbx-input" id="r-q" placeholder="' + esc(t("按名称或描述筛选；输入关键词后点「搜索 GitHub」查全站")) + '" /></div><button class="dbx-btn" id="r-search">' + esc(t("搜索 GitHub")) + '</button><select class="dbx-select" id="r-sort">' + SORTS.map(function (s) { return '<option value="' + s[0] + '">' + esc(t(s[1])) + "</option>"; }).join("") + '</select><button class="dbx-btn" id="r-dir" title="' + esc(t("切换排序方向")) + '">' + (repoQ.dir === "asc" ? "↑" : "↓") + '</button><button class="dbx-btn" id="r-refresh">' + ic("refresh") + " " + esc(t("刷新")) + '</button></div><div id="r-list">' + loading() + "</div>";
    $("r-q").value = repoQ.q; $("r-sort").value = repoQ.sort;
    var tm;
    $("r-q").oninput = function () { clearTimeout(tm); tm = setTimeout(function () { repoQ.q = $("r-q").value.trim(); repoQ.search = false; repoQ.page = 1; loadRepos(); }, 250); };
    $("r-search").onclick = function () { repoQ.q = $("r-q").value.trim(); if (!repoQ.q) return; repoQ.search = true; repoQ.page = 1; paintScopeTabs(); loadRepos(); };
    $("r-sort").onchange = function () { repoQ.sort = $("r-sort").value; repoQ.dir = repoQ.sort === "name" ? "asc" : "desc"; $("r-dir").textContent = repoQ.dir === "asc" ? "↑" : "↓"; repoQ.page = 1; loadRepos(); };
    $("r-dir").onclick = function () { repoQ.dir = repoQ.dir === "asc" ? "desc" : "asc"; this.textContent = repoQ.dir === "asc" ? "↑" : "↓"; repoQ.page = 1; loadRepos(); };
    $("r-refresh").onclick = loadRepos;
    each($("r-tabs"), "[data-scope]", function (el) { el.onclick = function () { repoQ.scope = el.getAttribute("data-scope"); repoQ.search = false; repoQ.page = 1; paintScopeTabs(); paintSide(); loadRepos(); }; });
    $("r-new").onclick = function () {
      formBox(t("新建仓库"), [{ id: "name", label: t("仓库名") }, { id: "desc", label: t("描述（可选）") }, { id: "priv", label: t("私有仓库"), type: "check", value: true }, { id: "init", label: t("初始化 README"), type: "check", value: true }], t("创建"), function (v) {
        return rpc("gh/createRepo", { name: v.name, description: v.desc, private: v.priv, autoInit: v.init }).then(function (r) { toast(t("已创建 {0}", r.full)); openRepo(r.full); });
      });
    };
    loadRepos();
  }
  function paintScopeTabs() { each($("r-tabs"), "[data-scope]", function (el) { el.classList.toggle("on", !repoQ.search && el.getAttribute("data-scope") === repoQ.scope); }); }
  // 星标 / fork / Issue 数：点一下直接看对应的内容，不用先进仓库
  // 星标数本身就是「加星标 / 取消星标」按钮（亮 = 已加）；who=true 时多一个「谁加了星标」入口
  function statBtns(stars, forks, issues, who) {
    var b = function (k, icon, n, tip, extra) { return '<span class="st" role="button" tabindex="0" data-stat="' + k + '" title="' + esc(tip) + '"' + (extra || "") + ">" + ic(icon) + '<span class="n">' + n + "</span></span>"; };
    return b("star", "star", stars, t("加星标 / 取消星标")) + (who ? '<span class="st" role="button" tabindex="0" data-stat="stargazers" title="' + esc(t("看谁加了星标")) + '">' + esc(t("谁加了星标")) + "</span>" : "") + b("forks", "branch", forks, t("看 fork 列表")) + b("issues", "issue", issues, t("打开 Issues"));
  }
  function bindStats(root, fullOf) {
    each(root, "[data-stat]", function (s) {
      var go = function (e) { e.stopPropagation(); e.preventDefault(); openStat(fullOf(s), s.getAttribute("data-stat"), s); };
      s.onclick = go;
      s.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") go(e); };
    });
  }
  // 查这一批仓库有没有加过星标，把星标图标点亮
  function syncStars(root, fullOf, fulls) {
    if (!fulls.length) return;
    rpc("gh/starState", { repos: fulls }).then(function (r) {
      each(root, '[data-stat="star"]', function (s) {
        var v = r.starred[fullOf(s)];
        if (typeof v === "boolean") { s.classList.toggle("on", v); s.setAttribute("data-known", "1"); }
      });
    }).catch(function () { /* 查不到就算了：点一下时由后端按真实状态翻转 */ });
  }
  function toggleStar(full, el) {
    if (el.getAttribute("data-busy")) return;
    el.setAttribute("data-busy", "1");
    var was = el.classList.contains("on"), known = !!el.getAttribute("data-known");
    var args = { repo: full }; if (known) args.on = !was;
    rpc("gh/star", args).then(function (r) {
      var n = el.querySelector(".n"), num = Number(n.textContent) || 0;
      if (!known || r.starred !== was) num += r.starred ? 1 : -1;
      n.textContent = Math.max(0, num);
      el.classList.toggle("on", r.starred); el.setAttribute("data-known", "1");
      if (S.repo && S.repo.full === full) S.repo.stars = Math.max(0, num);
      toast(r.starred ? t("已加星标 {0}", full) : t("已取消星标 {0}", full));
    }).catch(fail).then(function () { el.removeAttribute("data-busy"); });
  }
  function openStat(full, kind, el) {
    if (kind === "issues") return openRepoAt(full, "issues");
    if (kind === "star") return toggleStar(full, el);
    var star = kind === "stargazers";
    var draw = function (page) {
      var title = star ? t("加星标的人 · {0}", full) : t("Fork 列表 · {0}", full);
      var d = openDialog("<h3>" + esc(title) + "</h3>" + loading());
      rpc(star ? "gh/stargazers" : "gh/forks", { repo: full, page: page }).then(function (r) {
        var rows = r.items.map(function (x) {
          return star
            ? '<div class="li"><div class="main"><div class="t">' + avatar(x) + " " + esc(x.login) + "</div></div></div>"
            : '<div class="li click" role="button" tabindex="0" data-fork="' + esc(x.full) + '">' + tile(x.name) + '<div class="main"><div class="t">' + esc(x.full) + '</div><div class="m">' + esc(x.description || "") + '</div></div><div class="side">' + ic("star") + (x.stars || 0) + "</div></div>";
        }).join("");
        d.innerHTML = "<h3>" + esc(title) + "</h3>" + (rows ? '<div class="list">' + rows + "</div>" + pager(page, r.hasNext) : empty(star ? "还没有人加星标" : "还没有 fork")) + '<div class="foot"><button class="dbx-btn" data-x="no">' + esc(t("关闭")) + "</button></div>";
        d.querySelector('[data-x="no"]').onclick = closeDialog;
        bindPager(d, draw);
        each(d, "[data-fork]", function (el) { el.onclick = function () { var f = el.getAttribute("data-fork"); closeDialog(); openRepo(f); }; });
      }).catch(function (e) { d.innerHTML = "<h3>" + esc(title) + "</h3>" + errBox(e) + '<div class="foot"><button class="dbx-btn" data-x="no">' + esc(t("关闭")) + "</button></div>"; d.querySelector('[data-x="no"]').onclick = closeDialog; });
    };
    draw(1);
  }
  function repoRow(x) {
    var parts = x.full.split("/");
    return '<div class="rp click" role="button" tabindex="0" data-repo="' + esc(x.full) + '">' + tile(x.name, true) +
      '<div class="rp-m"><div class="rp-t"><span class="own">' + esc(parts[0]) + " / </span><b>" + esc(parts[1] || x.name) + "</b>" + (x.private ? ' <span class="lk" title="' + esc(t("私有")) + '">' + ic("lock") + "</span>" : "") + (x.fork ? ' <span class="lbl">fork</span>' : "") + (x.archived ? ' <span class="lbl">' + esc(t("已归档")) + "</span>" : "") + "</div>" +
      '<div class="rp-d">' + esc(x.description || "") + "</div></div>" +
      '<div class="rp-r"><div class="stats">' + (x.language ? '<span class="lang-tag">' + esc(x.language) + "</span>" : "") + statBtns(x.stars || 0, x.forks || 0, x.issues || 0) + '</div><div class="when">' + esc(t("更新于 {0}", ago(x.updated))) + "</div></div></div>";
  }
  function loadRepos() {
    var seq = ++S.seq;
    var box = $("r-list"); if (!box) return;
    box.innerHTML = loading();
    rpc("gh/repos", repoQ).then(function (r) {
      if (seq !== S.seq) return;
      $("r-count").textContent = t("{0} 个仓库", r.items.length + (r.hasNext ? "+" : ""));
      if (!r.items.length) { box.innerHTML = empty("没有仓库"); return; }
      box.innerHTML = '<div class="list rplist">' + r.items.map(repoRow).join("") + "</div>" + pager(r.page, r.hasNext);
      each(box, "[data-repo]", function (el) {
        var go = function () { openRepo(el.getAttribute("data-repo")); };
        el.onclick = go; el.onkeydown = function (e) { if (e.key === "Enter" && e.target === el) go(); };
      });
      var ofRow = function (s) { return s.closest("[data-repo]").getAttribute("data-repo"); };
      bindStats(box, ofRow);
      if (repoQ.scope === "starred" && !repoQ.search) each(box, '[data-stat="star"]', function (s) { s.classList.add("on"); s.setAttribute("data-known", "1"); });
      else syncStars(box, ofRow, r.items.map(function (x) { return x.full; }));
      bindPager(box, function (p) { repoQ.page = p; loadRepos(); });
    }).catch(function (e) { if (seq === S.seq) box.innerHTML = errBox(e); });
  }

  // ───────── 我的 Issue / PR、通知（跨仓库） ─────────
  var workQ = { issues: { filter: "assigned", state: "open", page: 1 }, pulls: { filter: "created", state: "open", page: 1 } };
  var WORK_FILTERS = { issues: [["assigned", "指派给我"], ["created", "我创建的"], ["mentioned", "提到我"]], pulls: [["created", "我创建的"], ["review", "等我评审"], ["assigned", "指派给我"], ["mentioned", "提到我"]] };
  function showWork(kind) {
    S.view = kind; S.repo = null; S.redo = function () { showWork(kind); };
    var q = workQ[kind];
    renderCrumb(); paintSide();
    view.innerHTML = '<div class="page-h"><h1>' + esc(kind === "issues" ? "Issues" : "Pull Requests") + '</h1><span class="count" id="w-count"></span></div><div class="tabs">' +
      WORK_FILTERS[kind].map(function (f) { return '<div class="tab' + (q.filter === f[0] ? " on" : "") + '" role="button" tabindex="0" data-f="' + f[0] + '">' + esc(t(f[1])) + "</div>"; }).join("") + '</div><div class="bar"><select class="dbx-select" id="w-state"><option value="open">' + esc(t("打开的")) + '</option><option value="closed">' + esc(kind === "pulls" ? t("已关闭 / 已合并") : t("已关闭")) + '</option><option value="all">' + esc(t("全部")) + '</option></select><span class="grow"></span><button class="dbx-btn" id="w-refresh">' + ic("refresh") + " " + esc(t("刷新")) + '</button></div><div id="w-list">' + loading() + "</div>";
    $("w-state").value = q.state;
    each(view, "[data-f]", function (el) { el.onclick = function () { q.filter = el.getAttribute("data-f"); q.page = 1; showWork(kind); }; });
    $("w-state").onchange = function () { q.state = $("w-state").value; q.page = 1; loadWork(kind); };
    $("w-refresh").onclick = function () { loadWork(kind); };
    loadWork(kind);
  }
  function loadWork(kind) {
    var seq = ++S.seq, q = workQ[kind], box = $("w-list"); if (!box) return;
    box.innerHTML = loading();
    rpc("gh/myWork", { kind: kind, filter: q.filter, state: q.state, page: q.page }).then(function (r) {
      if (seq !== S.seq) return;
      $("w-count").textContent = t("共 {0} 条", r.total);
      box.innerHTML = r.items.length ? '<div class="list">' + r.items.map(function (i) {
        return '<div class="li click" role="button" tabindex="0" data-repo="' + esc(i.repo) + '" data-n="' + i.number + '"><span class="dot ' + i.state + '"></span><div class="main"><div class="t">' + (i.draft ? '<span class="lbl">' + esc(t("草稿")) + "</span> " : "") + esc(i.title) + '</div><div class="m">' + esc(i.repo) + " #" + i.number + " · " + esc(i.user && i.user.login) + " · " + esc(ago(i.updated)) + " " + labels(i.labels) + '</div></div><div class="side">' + (i.comments ? "💬 " + i.comments : "") + "</div></div>";
      }).join("") + "</div>" + pager(q.page, r.hasNext) : empty("没有符合条件的内容");
      each(box, "[data-n]", function (el) { el.onclick = function () { openRepoAt(el.getAttribute("data-repo"), kind, +el.getAttribute("data-n")); }; });
      bindPager(box, function (p) { q.page = p; loadWork(kind); });
    }).catch(function (e) { if (seq === S.seq) box.innerHTML = errBox(e); });
  }

  var notifQ = { all: false, page: 1 };
  var REASONS = { assign: "指派给你", author: "你创建的", comment: "有新评论", mention: "提到了你", review_requested: "请你评审", subscribed: "你关注的", state_change: "状态变化", ci_activity: "CI 动态", team_mention: "提到了你的团队", security_alert: "安全告警" };
  function reasonText(r) { return REASONS[r] ? t(REASONS[r]) : r; }
  function showNotifs() {
    S.view = "notifs"; S.repo = null; S.redo = showNotifs;
    renderCrumb(); paintSide();
    view.innerHTML = '<div class="page-h"><h1>' + esc(t("通知")) + '</h1><span class="grow"></span><button class="dbx-btn" id="n-read">' + esc(t("全部标为已读")) + '</button></div><div class="bar"><select class="dbx-select" id="n-all"><option value="0">' + esc(t("未读")) + '</option><option value="1">' + esc(t("全部")) + '</option></select><span class="grow"></span><button class="dbx-btn" id="n-refresh">' + ic("refresh") + " " + esc(t("刷新")) + '</button></div><div id="n-list">' + loading() + "</div>";
    $("n-all").value = notifQ.all ? "1" : "0";
    $("n-all").onchange = function () { notifQ.all = $("n-all").value === "1"; notifQ.page = 1; loadNotifs(); };
    $("n-refresh").onclick = loadNotifs;
    $("n-read").onclick = function () { rpc("gh/markRead").then(function () { toast(t("已全部标为已读")); loadNotifs(); }).catch(fail); };
    loadNotifs();
  }
  function loadNotifs() {
    var seq = ++S.seq, box = $("n-list"); if (!box) return;
    box.innerHTML = loading();
    rpc("gh/notifications", notifQ).then(function (r) {
      if (seq !== S.seq) return;
      if (r.unsupported) { box.innerHTML = '<div class="note">' + esc(r.unsupported) + "</div>"; return; }
      box.innerHTML = r.items.length ? '<div class="list">' + r.items.map(function (n, idx) {
        return '<div class="li click" role="button" tabindex="0" data-i="' + idx + '"><span class="dot ' + (n.unread ? "open" : "") + '"></span><div class="main"><div class="t">' + esc(n.title) + '</div><div class="m">' + esc(n.repo) + (n.number ? " #" + n.number : "") + " · " + esc(n.type) + " · " + esc(reasonText(n.reason)) + " · " + esc(ago(n.updated)) + "</div></div></div>";
      }).join("") + "</div>" + pager(notifQ.page, r.hasNext) : empty("没有通知");
      each(box, "[data-i]", function (el) {
        el.onclick = function () {
          var n = r.items[+el.getAttribute("data-i")];
          if (n.unread) rpc("gh/markRead", { id: n.id }).catch(function () {});
          if (n.number && n.type === "Issue") openRepoAt(n.repo, "issues", n.number);
          else if (n.number && n.type === "PullRequest") openRepoAt(n.repo, "pulls", n.number);
          else openRepo(n.repo);
        };
      });
      bindPager(box, function (p) { notifQ.page = p; loadNotifs(); });
    }).catch(function (e) { if (seq === S.seq) box.innerHTML = errBox(e); });
  }

  // ───────── 探索（GitHub 的 Explore：看热门 / 新晋项目） ─────────
  var exploreQ = { period: "week", language: "", topic: "", page: 1 };
  var PERIODS = [["day", "今天"], ["week", "本周"], ["month", "本月"], ["all", "经典"]];
  var LANGS = ["JavaScript", "TypeScript", "Python", "Go", "Rust", "Java", "C++", "C#", "Swift", "Kotlin", "PHP", "Ruby", "Shell", "HTML"];
  var TOPICS = ["ai", "llm", "agent", "cli", "web", "game", "devops", "database", "security", "mobile", "machine-learning", "react", "vue", "docker"];
  function showExplore() {
    S.view = "explore"; S.repo = null; S.redo = showExplore;
    renderCrumb(); paintSide();
    view.innerHTML = '<div class="page-h"><h1>' + esc(t("探索")) + '</h1><span class="grow"></span></div>' +
      '<div class="note">' + esc(t("GitHub 没有官方的趋势接口：「今天 / 本周 / 本月」是这段时间内新建、按星标排序的仓库，「经典」是星标 5000 以上的老牌项目。")) + "</div>" +
      '<div class="tabs" id="x-tabs">' + PERIODS.map(function (p) { return '<div class="tab' + (exploreQ.period === p[0] ? " on" : "") + '" role="button" tabindex="0" data-p="' + p[0] + '">' + esc(t(p[1])) + "</div>"; }).join("") + "</div>" +
      '<div class="bar"><select class="dbx-select" id="x-lang"><option value="">' + esc(t("任意语言")) + "</option>" + LANGS.map(function (l) { return '<option value="' + esc(l) + '">' + esc(l) + "</option>"; }).join("") + '</select><span class="grow"></span><button class="dbx-btn" id="x-refresh">' + ic("refresh") + " " + esc(t("刷新")) + "</button></div>" +
      '<div class="chips2" id="x-topics">' + TOPICS.map(function (tp) { return '<span class="tp' + (exploreQ.topic === tp ? " on" : "") + '" role="button" tabindex="0" data-tp="' + esc(tp) + '">' + esc(tp) + "</span>"; }).join("") + '</div><div id="x-list">' + loading() + "</div>";
    $("x-lang").value = exploreQ.language;
    each($("x-tabs"), "[data-p]", function (el) { el.onclick = function () { exploreQ.period = el.getAttribute("data-p"); exploreQ.page = 1; showExplore(); }; });
    $("x-lang").onchange = function () { exploreQ.language = $("x-lang").value; exploreQ.page = 1; loadExplore(); };
    each($("x-topics"), "[data-tp]", function (el) {
      el.onclick = function () { var v = el.getAttribute("data-tp"); exploreQ.topic = exploreQ.topic === v ? "" : v; exploreQ.page = 1; showExplore(); };
    });
    $("x-refresh").onclick = loadExplore;
    loadExplore();
  }
  function loadExplore() {
    var seq = ++S.seq, box = $("x-list"); if (!box) return;
    box.innerHTML = loading();
    rpc("gh/explore", exploreQ).then(function (r) {
      if (seq !== S.seq) return;
      if (!r.items.length) { box.innerHTML = empty("没有符合条件的仓库"); return; }
      box.innerHTML = '<div class="list rplist">' + r.items.map(repoRow).join("") + "</div>" + pager(r.page, r.hasNext);
      each(box, "[data-repo]", function (el) {
        var go = function () { openRepo(el.getAttribute("data-repo")); };
        el.onclick = go; el.onkeydown = function (e) { if (e.key === "Enter" && e.target === el) go(); };
      });
      var ofRow = function (s) { return s.closest("[data-repo]").getAttribute("data-repo"); };
      bindStats(box, ofRow);
      syncStars(box, ofRow, r.items.map(function (x) { return x.full; }));
      bindPager(box, function (p) { exploreQ.page = p; loadExplore(); });
    }).catch(function (e) { if (seq === S.seq) box.innerHTML = errBox(e); });
  }

  // ───────── 仓库页 ─────────
  function openRepo(full) { openRepoAt(full); }
  /** 打开仓库；kind / n 给了就直接跳到那个 Issue / PR */
  function openRepoAt(full, kind, n) {
    S.seq++; view.innerHTML = loading(); S.view = "repo";
    rpc("gh/repo", { repo: full }).then(function (r) {
      S.repo = r; S.ref = r.branch; S.tab = kind || "code"; S.path = "";
      renderRepoShell(n);
    }).catch(function (e) { S.repo = null; S.view = "repos"; S.redo = showRepos; renderCrumb(); paintSide(); view.innerHTML = errBox(e); });
  }
  function renderRepoShell(openN) {
    var r = S.repo;
    S.view = "repo"; S.redo = function () { renderRepoShell(); };
    renderCrumb(); paintSide();
    view.innerHTML = '<div class="repo-h">' + tile(r.name, true) + '<div class="repo-ht"><h1>' + esc(r.full) + (r.private ? ' <span class="lk" title="' + esc(t("私有")) + '">' + ic("lock") + "</span>" : "") + '</h1><div class="dbx-hint">' + esc(r.description || t("（没有描述）")) + '</div></div><div class="stats">' + statBtns(r.stars, r.forks, r.issues, true) + '</div></div><div class="dbx-hint repo-meta">' + esc(t("默认分支 {0}", r.branch)) + (r.permissions && !r.permissions.push ? ' · <span class="warn">' + esc(t("只读权限")) + "</span>" : "") + '</div><div id="tab-body"></div>';
    bindStats(view.querySelector(".repo-h"), function () { return r.full; });
    syncStars(view.querySelector(".repo-h"), function () { return r.full; }, [r.full]);
    if (openN && (S.tab === "issues" || S.tab === "issue")) { S.tab = "issues"; paintSide(); return showIssue(openN); }
    if (openN && (S.tab === "pulls" || S.tab === "pull")) { S.tab = "pulls"; paintSide(); return showPull(openN); }
    setTab(S.tab);
  }
  function setTab(tb) {
    S.tab = tb; S.redo = function () { setTab(tb); };
    if (!$("tab-body")) return renderRepoShell();
    renderCrumb(); paintSide();
    var body = $("tab-body");
    body.innerHTML = loading();
    ({ code: tabCode, issues: tabIssues, pulls: tabPulls, actions: tabActions, releases: tabReleases, branches: tabBranches })[tb](body);
  }
  var branchOptions = function (sel) { return S.repo.branches.map(function (b) { return '<option value="' + esc(b.name) + '"' + (b.name === sel ? " selected" : "") + ">" + esc(b.name) + "</option>"; }).join(""); };
  var branchChoices = function () { return S.repo.branches.map(function (b) { return { value: b.name, label: b.name }; }); };
  var R = function () { return S.repo.full; };

  // ───────── 代码 ─────────
  function tabCode(body, path) {
    if (path != null) S.path = path;
    var seq = ++S.seq;
    body.innerHTML = loading();
    rpc("gh/contents", { repo: R(), path: S.path, ref: S.ref }).then(function (r) {
      if (seq !== S.seq) return;
      var parts = S.path ? S.path.split("/") : [];
      var bc = '<a data-p="">' + esc(S.repo.name) + "</a>" + parts.map(function (p, i) { return ' / <a data-p="' + esc(parts.slice(0, i + 1).join("/")) + '">' + esc(p) + "</a>"; }).join("");
      var head = '<div class="bar"><select class="dbx-select" id="br">' + branchOptions(S.ref) + '</select><div class="crumb2">' + bc + "</div>" + (r.type === "dir" ? '<button class="dbx-btn" id="newfile">' + esc(t("新建文件")) + "</button>" : "") + "</div>";
      if (r.type === "dir") {
        body.innerHTML = head + '<div class="list">' + (r.items.length ? r.items.map(function (f) {
          return '<div class="li click" role="button" tabindex="0" data-open="' + esc(f.path) + '" data-type="' + f.type + '"><div class="main">' + (f.type === "dir" ? "📁 " : "📄 ") + esc(f.name) + '</div><div class="side">' + (f.type === "file" ? (f.size < 1024 ? f.size + " B" : (f.size / 1024).toFixed(1) + " KB") : "") + "</div></div>";
        }).join("") : empty("空目录")) + "</div>";
      } else if (r.type === "file") {
        if (r.tooLarge || r.binary) body.innerHTML = head + '<div class="box dbx-hint">' + esc(r.binary ? t("这是二进制文件，不能在这里查看") : t("文件超过 1 MB，不能在这里查看 / 编辑")) + esc(t("（{0} 字节）", r.size)) + "</div>";
        else body.innerHTML = head + '<textarea class="dbx-textarea editor" id="ed" spellcheck="false"></textarea><div class="bar" style="margin-top:8px"><button class="dbx-btn dbx-btn--primary" id="save">' + esc(t("提交修改")) + '</button><button class="dbx-btn dbx-btn--danger" id="del">' + esc(t("删除文件")) + '</button><span class="dbx-hint">' + esc(t("{0} 字节 · 提交到分支 {1}", r.size, S.ref)) + "</span></div>" + linkBox(r.url);
        if ($("ed")) $("ed").value = r.text;
      } else {
        body.innerHTML = head + '<div class="box dbx-hint">' + esc(t("这是一个 {0}，这里不能打开", r.type)) + "</div>";
      }
      each(body, "[data-p]", function (a) { a.style.cursor = "pointer"; a.onclick = function () { tabCode(body, a.getAttribute("data-p")); }; });
      each(body, "[data-open]", function (el) { el.onclick = function () { tabCode(body, el.getAttribute("data-open")); }; });
      $("br").onchange = function () { S.ref = $("br").value; S.path = ""; tabCode(body); };
      var parent = function (p) { return p.replace(/\/[^/]*$/, "").replace(/^[^/]*$/, ""); };
      if ($("newfile")) $("newfile").onclick = function () {
        formBox(t("新建文件"), [{ id: "path", label: t("文件路径"), value: S.path ? S.path + "/" : "", placeholder: "docs/readme.md" }, { id: "content", label: t("内容"), type: "area", rows: 10 }, { id: "msg", label: t("提交说明"), value: "Create file" }], t("提交"), function (v) {
          return rpc("gh/putFile", { repo: R(), path: v.path, content: v.content, message: v.msg, branch: S.ref }).then(function (x) { toast(t("已提交 {0}", x.commit)); tabCode(body, parent(v.path)); });
        }, t("会直接提交到分支 <b>{0}</b>。", esc(S.ref)));
      };
      if ($("save")) $("save").onclick = function () {
        formBox(t("提交修改：{0}", r.path), [{ id: "msg", label: t("提交说明"), value: "Update " + r.name }], t("提交"), function (v) {
          return rpc("gh/putFile", { repo: R(), path: r.path, content: $("ed").value, message: v.msg, branch: S.ref, sha: r.sha }).then(function (x) { toast(t("已提交 {0}", x.commit)); tabCode(body); });
        }, t("会直接提交到分支 <b>{0}</b>。", esc(S.ref)) + (S.ref === S.repo.branch ? esc(t("（默认分支）")) : ""));
      };
      if ($("del")) $("del").onclick = function () {
        formBox(t("删除文件：{0}", r.path), [{ id: "msg", label: t("提交说明"), value: "Delete " + r.name }], t("删除"), function (v) {
          return rpc("gh/deleteFile", { repo: R(), path: r.path, sha: r.sha, message: v.msg, branch: S.ref }).then(function () { toast(t("已删除")); tabCode(body, parent(r.path)); });
        }, t("会在分支 <b>{0}</b> 上提交一次删除（历史里还能找回）。", esc(S.ref)));
      };
    }).catch(function (e) { if (seq === S.seq) body.innerHTML = errBox(e); });
  }

  // ───────── Issues ─────────
  var issueQ = { state: "open", q: "", page: 1 };
  function tabIssues(body) {
    body.innerHTML = '<div class="bar"><select class="dbx-select" id="i-state"><option value="open">' + esc(t("打开的")) + '</option><option value="closed">' + esc(t("已关闭")) + '</option><option value="all">' + esc(t("全部")) + '</option></select><div class="sinput">' + ic("search") + '<input class="dbx-input" id="i-q" placeholder="' + esc(t("搜索 Issue")) + '" /></div><button class="dbx-btn dbx-btn--primary" id="i-new">' + esc(t("新建 Issue")) + '</button></div><div id="i-list">' + loading() + "</div>";
    $("i-state").value = issueQ.state; $("i-q").value = issueQ.q;
    $("i-state").onchange = function () { issueQ.state = $("i-state").value; issueQ.page = 1; loadIssues(); };
    var tm; $("i-q").oninput = function () { clearTimeout(tm); tm = setTimeout(function () { issueQ.q = $("i-q").value.trim(); issueQ.page = 1; loadIssues(); }, 300); };
    $("i-new").onclick = function () {
      formBox(t("新建 Issue"), [{ id: "title", label: t("标题") }, { id: "body", label: t("内容"), type: "area", rows: 8 }, { id: "labels", label: t("标签（逗号分隔，可选）") }], t("创建"), function (v) {
        return rpc("gh/createIssue", { repo: R(), title: v.title, body: v.body, labels: v.labels.split(",").map(function (s) { return s.trim(); }).filter(Boolean) }).then(function (i) { toast(t("已创建 #{0}", i.number)); showIssue(i.number); });
      });
    };
    loadIssues();
  }
  function loadIssues() {
    var seq = ++S.seq; var box = $("i-list"); if (!box) return; box.innerHTML = loading();
    rpc("gh/issues", { repo: R(), state: issueQ.state, q: issueQ.q, page: issueQ.page }).then(function (r) {
      if (seq !== S.seq) return;
      box.innerHTML = r.items.length ? '<div class="list">' + r.items.map(function (i) {
        return '<div class="li click" role="button" tabindex="0" data-n="' + i.number + '"><span class="dot ' + i.state + '"></span><div class="main"><div class="t">' + esc(i.title) + '</div><div class="m">#' + i.number + " · " + esc(i.user && i.user.login) + " · " + esc(ago(i.updated)) + " " + labels(i.labels) + '</div></div><div class="side">' + (i.comments ? "💬 " + i.comments : "") + "</div></div>";
      }).join("") + "</div>" + pager(issueQ.page, r.hasNext) : empty("没有符合条件的 Issue");
      each(box, "[data-n]", function (el) { el.onclick = function () { showIssue(+el.getAttribute("data-n")); }; });
      bindPager(box, function (p) { issueQ.page = p; loadIssues(); });
    }).catch(function (e) { if (seq === S.seq) box.innerHTML = errBox(e); });
  }
  function commentsHtml(list) {
    return (list || []).map(function (c) { return '<div class="box"><div class="hd">' + avatar(c.user) + "<b>" + esc(c.user && c.user.login) + "</b> " + esc(ago(c.created)) + '</div><div class="txt">' + esc(c.body) + "</div></div>"; }).join("");
  }
  var stateText = function (s) { return s === "open" ? t("打开") : s === "merged" ? t("已合并") : t("已关闭"); };
  function showIssue(n) {
    var body = $("tab-body"); if (!body) return; body.innerHTML = loading(); S.redo = function () { showIssue(n); };
    renderCrumb("Issue #" + n);
    rpc("gh/issue", { repo: R(), number: n }).then(function (i) {
      body.innerHTML = '<div class="bar"><button class="dbx-btn" id="back">← ' + esc(t("返回列表")) + "</button></div><h2>" + esc(i.title) + ' <span class="dbx-hint">#' + i.number + '</span></h2><div style="margin-bottom:8px"><span class="badge ' + i.state + '">' + esc(stateText(i.state)) + "</span> " + esc(i.user && i.user.login) + " · " + esc(ago(i.created)) + " " + labels(i.labels) + "</div>" +
        '<div class="box"><div class="txt">' + esc(i.body || t("（没有内容）")) + "</div></div>" + commentsHtml(i.commentList) + linkBox(i.url) +
        "<h3>" + esc(t("添加评论")) + '</h3><textarea class="dbx-textarea" id="cm" rows="4"></textarea><div class="bar" style="margin-top:8px"><button class="dbx-btn dbx-btn--primary" id="cm-go">' + esc(t("评论")) + '</button><button class="dbx-btn" id="toggle">' + esc(i.state === "open" ? t("关闭 Issue") : t("重新打开")) + '</button><button class="dbx-btn" id="edit">' + esc(t("编辑")) + "</button></div>";
      $("back").onclick = function () { setTab("issues"); };
      $("cm-go").onclick = function () { rpc("gh/comment", { repo: R(), number: n, body: $("cm").value }).then(function () { toast(t("已评论")); showIssue(n); }).catch(fail); };
      $("toggle").onclick = function () { rpc("gh/updateIssue", { repo: R(), number: n, state: i.state === "open" ? "closed" : "open" }).then(function () { toast(t("已更新")); showIssue(n); }).catch(fail); };
      $("edit").onclick = function () {
        formBox(t("编辑 Issue #{0}", n), [{ id: "title", label: t("标题"), value: i.title }, { id: "body", label: t("内容"), type: "area", rows: 8, value: i.body }], t("保存"), function (v) {
          return rpc("gh/updateIssue", { repo: R(), number: n, title: v.title, body: v.body }).then(function () { toast(t("已保存")); showIssue(n); });
        });
      };
    }).catch(function (e) { body.innerHTML = errBox(e); });
  }

  // ───────── Pull Requests ─────────
  var pullQ = { state: "open", page: 1 };
  function tabPulls(body) {
    body.innerHTML = '<div class="bar"><select class="dbx-select" id="p-state"><option value="open">' + esc(t("打开的")) + '</option><option value="closed">' + esc(t("已关闭 / 已合并")) + '</option><option value="all">' + esc(t("全部")) + '</option></select><span class="grow"></span><button class="dbx-btn dbx-btn--primary" id="p-new">' + esc(t("新建 Pull Request")) + '</button></div><div id="p-list">' + loading() + "</div>";
    $("p-state").value = pullQ.state;
    $("p-state").onchange = function () { pullQ.state = $("p-state").value; pullQ.page = 1; loadPulls(); };
    $("p-new").onclick = function () {
      var other = S.repo.branches.filter(function (b) { return b.name !== S.repo.branch; })[0];
      formBox(t("新建 Pull Request"), [
        { id: "head", label: t("源分支（要合并的）"), type: "select", options: branchChoices(), value: other ? other.name : S.repo.branch },
        { id: "base", label: t("目标分支"), type: "select", options: branchChoices(), value: S.repo.branch },
        { id: "title", label: t("标题") }, { id: "body", label: t("说明"), type: "area", rows: 6 }, { id: "draft", label: t("作为草稿"), type: "check" }], t("创建"), function (v) {
        return rpc("gh/createPull", { repo: R(), head: v.head, base: v.base, title: v.title, body: v.body, draft: v.draft }).then(function (p) { toast(t("已创建 #{0}", p.number)); showPull(p.number); });
      }, esc(t("跨仓库的 PR 请到 GitHub 网页上创建。")));
    };
    loadPulls();
  }
  function loadPulls() {
    var seq = ++S.seq; var box = $("p-list"); if (!box) return; box.innerHTML = loading();
    rpc("gh/pulls", { repo: R(), state: pullQ.state, page: pullQ.page }).then(function (r) {
      if (seq !== S.seq) return;
      box.innerHTML = r.items.length ? '<div class="list">' + r.items.map(function (p) {
        return '<div class="li click" role="button" tabindex="0" data-n="' + p.number + '"><span class="dot ' + p.state + '"></span><div class="main"><div class="t">' + (p.draft ? '<span class="lbl">' + esc(t("草稿")) + "</span> " : "") + esc(p.title) + '</div><div class="m">#' + p.number + " · " + esc(p.user && p.user.login) + " · " + esc(p.head) + " → " + esc(p.base) + " · " + esc(ago(p.updated)) + " " + labels(p.labels) + "</div></div></div>";
      }).join("") + "</div>" + pager(pullQ.page, r.hasNext) : empty("没有符合条件的 Pull Request");
      each(box, "[data-n]", function (el) { el.onclick = function () { showPull(+el.getAttribute("data-n")); }; });
      bindPager(box, function (p) { pullQ.page = p; loadPulls(); });
    }).catch(function (e) { if (seq === S.seq) box.innerHTML = errBox(e); });
  }
  function diffHtml(patch) {
    if (!patch) return '<span class="dbx-hint">' + esc(t("（没有文本 diff：二进制文件或改动太大）")) + "</span>";
    return patch.split("\n").map(function (l) { var c = l[0] === "+" ? "a" : l[0] === "-" ? "d" : l[0] === "@" ? "h" : ""; return '<span class="' + c + '">' + esc(l) + " </span>"; }).join("");
  }
  var REVIEW = { APPROVED: "批准了", CHANGES_REQUESTED: "要求修改", COMMENTED: "评论了", DISMISSED: "（已撤销）" };
  function showPull(n) {
    var body = $("tab-body"); if (!body) return; body.innerHTML = loading(); S.redo = function () { showPull(n); };
    renderCrumb("PR #" + n);
    rpc("gh/pull", { repo: R(), number: n }, 120000).then(function (p) {
      var canAct = p.state === "open";
      body.innerHTML = '<div class="bar"><button class="dbx-btn" id="back">← ' + esc(t("返回列表")) + "</button></div><h2>" + esc(p.title) + ' <span class="dbx-hint">#' + p.number + '</span></h2><div style="margin-bottom:8px"><span class="badge ' + p.state + '">' + esc(stateText(p.state)) + "</span> " + (p.draft ? '<span class="lbl">' + esc(t("草稿")) + "</span> " : "") + t("{0} 想把 <b>{1}</b> 合并到 <b>{2}</b>", esc(p.user && p.user.login), esc(p.head), esc(p.base)) + " · +" + (p.additions || 0) + " −" + (p.deletions || 0) + " · " + esc(t("{0} 个文件", p.changedFiles || 0)) + " " + labels(p.labels) + "</div>" +
        (canAct && p.mergeableState ? '<div class="dbx-hint" style="margin-bottom:8px">' + esc(t("合并状态：")) + esc(p.mergeable === false ? t("有冲突，需要先解决") : p.mergeableState) + "</div>" : "") +
        '<div class="box"><div class="txt">' + esc(p.body || t("（没有说明）")) + "</div></div>" +
        "<h3>" + esc(t("改动的文件（{0}）", p.files.length)) + "</h3>" + p.files.map(function (f) { return '<details class="file"><summary><span>' + esc(f.name) + '</span><span class="dbx-hint">' + esc(f.status) + ' <span class="ok">+' + f.additions + '</span> <span class="warn">−' + f.deletions + '</span></span></summary><pre class="code">' + diffHtml(f.patch) + "</pre></details>"; }).join("") +
        (p.reviews.length ? "<h3>" + esc(t("评审")) + "</h3>" + p.reviews.map(function (r) { return '<div class="box"><div class="hd">' + avatar(r.user) + "<b>" + esc(r.user && r.user.login) + "</b> " + esc(REVIEW[r.state] ? t(REVIEW[r.state]) : r.state) + "</div>" + (r.body ? '<div class="txt">' + esc(r.body) + "</div>" : "") + "</div>"; }).join("") : "") +
        (p.commentList.length ? "<h3>" + esc(t("评论列表")) + "</h3>" + commentsHtml(p.commentList) : "") + linkBox(p.url) +
        "<h3>" + esc(t("添加评论")) + '</h3><textarea class="dbx-textarea" id="cm" rows="4"></textarea><div class="bar" style="margin-top:8px"><button class="dbx-btn dbx-btn--primary" id="cm-go">' + esc(t("评论")) + "</button>" +
        (canAct ? '<button class="dbx-btn" id="review">' + esc(t("评审…")) + '</button><button class="dbx-btn dbx-btn--primary" id="merge"' + (p.draft || p.mergeable === false ? " disabled" : "") + ' title="' + esc(p.draft ? t("草稿不能合并") : p.mergeable === false ? t("有冲突") : "") + '">' + esc(t("合并…")) + '</button><button class="dbx-btn" id="toggle">' + esc(t("关闭 PR")) + "</button>" : (p.state === "closed" ? '<button class="dbx-btn" id="toggle">' + esc(t("重新打开")) + "</button>" : "")) + "</div>";
      $("back").onclick = function () { setTab("pulls"); };
      $("cm-go").onclick = function () { rpc("gh/comment", { repo: R(), number: n, body: $("cm").value }).then(function () { toast(t("已评论")); showPull(n); }).catch(fail); };
      if ($("toggle")) $("toggle").onclick = function () { rpc("gh/updatePull", { repo: R(), number: n, state: p.state === "open" ? "closed" : "open" }).then(function () { toast(t("已更新")); showPull(n); }).catch(fail); };
      if ($("review")) $("review").onclick = function () {
        formBox(t("评审 #{0}", n), [{ id: "event", label: t("结论"), type: "select", options: [{ value: "COMMENT", label: t("只评论") }, { value: "APPROVE", label: t("批准") }, { value: "REQUEST_CHANGES", label: t("要求修改") }] }, { id: "body", label: t("说明"), type: "area", rows: 5 }], t("提交评审"), function (v) {
          return rpc("gh/reviewPull", { repo: R(), number: n, event: v.event, body: v.body }).then(function () { toast(t("已提交评审")); showPull(n); });
        }, esc(t("不能评审自己创建的 PR（GitHub 的限制）。")));
      };
      if ($("merge")) $("merge").onclick = function () {
        formBox(t("合并 #{0}", n), [{ id: "method", label: t("合并方式"), type: "select", options: [{ value: "merge", label: t("合并提交（merge）") }, { value: "squash", label: t("压缩合并（squash）") }, { value: "rebase", label: t("变基合并（rebase）") }] }, { id: "title", label: t("提交标题（可选）") }], t("合并"), function (v) {
          return rpc("gh/mergePull", { repo: R(), number: n, method: v.method, title: v.title }).then(function (r) { toast(r.merged ? t("已合并 {0}", r.sha || "") : r.message || t("没有合并")); showPull(n); });
        }, t("会修改 <b>{0}</b> 分支，不能撤销（只能再提交一次回滚）。", esc(p.base)));
      };
    }).catch(function (e) { body.innerHTML = errBox(e); });
  }

  // ───────── Actions ─────────
  var runQ = { page: 1, branch: "" };
  var RUN_CLS = function (r) { return r.status !== "completed" ? "progress" : r.conclusion === "success" ? "success" : r.conclusion === "failure" || r.conclusion === "timed_out" ? "failure" : ""; };
  var RUN_ZH = { queued: "排队中", in_progress: "运行中", waiting: "等待中", success: "成功", failure: "失败", cancelled: "已取消", skipped: "已跳过", timed_out: "超时", neutral: "中性", action_required: "需要操作" };
  var runWord = function (k) { return RUN_ZH[k] ? t(RUN_ZH[k]) : k; };
  var runText = function (r) { var k = r.status === "completed" ? r.conclusion : r.status; return runWord(k) || r.conclusion || r.status; };
  function tabActions(body) {
    body.innerHTML = '<div class="bar"><select class="dbx-select" id="a-br"><option value="">' + esc(t("全部分支")) + "</option>" + branchOptions(runQ.branch) + '</select><span class="grow"></span><button class="dbx-btn" id="a-refresh">' + esc(t("刷新")) + '</button><button class="dbx-btn dbx-btn--primary" id="a-go">' + esc(t("触发工作流…")) + '</button></div><div id="a-list">' + loading() + "</div>";
    $("a-br").value = runQ.branch;
    $("a-br").onchange = function () { runQ.branch = $("a-br").value; runQ.page = 1; loadRuns(); };
    $("a-refresh").onclick = loadRuns;
    $("a-go").onclick = function () {
      rpc("gh/workflows", { repo: R() }).then(function (w) {
        if (!w.items.length) return toast(t("这个仓库还没有工作流"), true);
        formBox(t("触发工作流"), [{ id: "wf", label: t("工作流"), type: "select", options: w.items.map(function (x) { return { value: String(x.id), label: x.name + "（" + x.path.replace(".github/workflows/", "") + "）" }; }) }, { id: "ref", label: t("运行分支"), type: "select", options: branchChoices(), value: S.repo.branch }, { id: "inputs", label: t("输入参数（JSON，可选）"), type: "area", rows: 3, placeholder: '{"name":"value"}' }], t("触发"), function (v) {
          var inputs; if (v.inputs.trim()) { try { inputs = JSON.parse(v.inputs); } catch (e) { throw new Error(t("输入参数不是合法 JSON")); } }
          return rpc("gh/dispatch", { repo: R(), workflow: v.wf, ref: v.ref, inputs: inputs }).then(function () { toast(t("已触发，稍后刷新看结果")); setTimeout(loadRuns, 2500); });
        }, t("只有声明了 <code>workflow_dispatch</code> 的工作流才能手动触发。"));
      }).catch(fail);
    };
    loadRuns();
  }
  function loadRuns() {
    var seq = ++S.seq; var box = $("a-list"); if (!box) return; box.innerHTML = loading();
    rpc("gh/runs", { repo: R(), branch: runQ.branch, page: runQ.page }).then(function (r) {
      if (seq !== S.seq) return;
      box.innerHTML = r.items.length ? '<div class="list">' + r.items.map(function (x) {
        var live = x.status !== "completed";
        return '<div class="li"><span class="dot ' + RUN_CLS(x) + '"></span><div class="main"><div class="t">' + esc(x.title || x.name) + '</div><div class="m">' + esc(x.name) + " #" + x.number + " · " + esc(x.branch) + " · " + esc(x.sha) + " · " + esc(x.event) + " · " + esc(x.actor) + " · " + esc(ago(x.created)) + '</div><div class="jobs" id="jobs-' + x.id + '"></div></div><div class="side"><div>' + esc(runText(x)) + '</div><button class="dbx-btn dbx-btn--ghost" data-job="' + x.id + '">' + esc(t("任务")) + "</button>" + (live ? '<button class="dbx-btn dbx-btn--ghost" data-cancel="' + x.id + '">' + esc(t("取消")) + "</button>" : '<button class="dbx-btn dbx-btn--ghost" data-rerun="' + x.id + '">' + esc(t("重跑")) + "</button>" + (RUN_CLS(x) === "failure" ? '<button class="dbx-btn dbx-btn--ghost" data-rerunf="' + x.id + '">' + esc(t("只重跑失败的")) + "</button>" : "")) + "</div></div>";
      }).join("") + "</div>" + pager(runQ.page, r.hasNext) : empty("还没有运行记录");
      bindPager(box, function (p) { runQ.page = p; loadRuns(); });
      each(box, "[data-job]", function (b) { b.onclick = function () {
        var id = b.getAttribute("data-job"), el = $("jobs-" + id);
        if (el.innerHTML) { el.innerHTML = ""; return; }
        el.innerHTML = '<span class="dbx-hint">' + esc(t("加载中…")) + "</span>";
        rpc("gh/runJobs", { repo: R(), id: +id }).then(function (j) {
          el.innerHTML = j.items.map(function (job) { return '<details class="file"><summary><span>' + esc(job.name) + '</span><span class="dbx-hint">' + esc(runWord(job.conclusion || job.status) || job.conclusion || job.status) + '</span></summary><div style="padding:6px 10px">' + job.steps.map(function (s) { return '<div class="dbx-hint">' + (s.conclusion === "success" ? "✓" : s.conclusion === "failure" ? "✗" : s.status === "completed" ? "–" : "…") + " " + esc(s.name) + "</div>"; }).join("") + "</div></details>"; }).join("") || '<span class="dbx-hint">' + esc(t("没有任务")) + "</span>";
        }).catch(function (e) { el.innerHTML = '<span class="warn">' + esc(e.message) + "</span>"; });
      }; });
      var act = function (sel, method, extra, msg) { each(box, sel, function (b) { b.onclick = function () {
        var p = { repo: R(), id: +b.getAttribute(sel.replace(/[\[\]]/g, "")) }; for (var k in extra) p[k] = extra[k];
        b.disabled = true; rpc(method, p).then(function () { toast(msg); setTimeout(loadRuns, 1500); }).catch(function (e) { b.disabled = false; fail(e); });
      }; }); };
      act("[data-rerun]", "gh/rerun", {}, t("已重新运行"));
      act("[data-rerunf]", "gh/rerun", { failedOnly: true }, t("已重跑失败的任务"));
      act("[data-cancel]", "gh/cancelRun", {}, t("已请求取消"));
    }).catch(function (e) { if (seq === S.seq) box.innerHTML = errBox(e); });
  }

  // ───────── Releases ─────────
  var relPage = 1;
  function tabReleases(body) {
    body.innerHTML = '<div class="bar"><span class="grow"></span><button class="dbx-btn dbx-btn--primary" id="rl-new">' + esc(t("创建 Release")) + '</button></div><div id="rl-list">' + loading() + "</div>";
    $("rl-new").onclick = function () {
      formBox(t("创建 Release"), [{ id: "tag", label: t("标签（不存在会自动创建）"), placeholder: "v1.0.0" }, { id: "target", label: t("标签指向的分支（标签不存在时用）"), type: "select", options: branchChoices(), value: S.repo.branch }, { id: "name", label: t("标题（可选）") }, { id: "body", label: t("说明"), type: "area", rows: 6 }, { id: "gen", label: t("自动生成发布说明"), type: "check" }, { id: "draft", label: t("草稿（先不公开）"), type: "check" }, { id: "pre", label: t("标记为预发布"), type: "check" }], t("创建"), function (v) {
        return rpc("gh/createRelease", { repo: R(), tag: v.tag, target: v.target, name: v.name, body: v.body, generateNotes: v.gen, draft: v.draft, prerelease: v.pre }).then(function () { toast(t("已创建")); loadReleases(); });
      });
    };
    loadReleases();
  }
  function loadReleases() {
    var seq = ++S.seq; var box = $("rl-list"); if (!box) return; box.innerHTML = loading();
    rpc("gh/releases", { repo: R(), page: relPage }).then(function (r) {
      if (seq !== S.seq) return;
      box.innerHTML = r.items.length ? r.items.map(function (x) {
        return '<div class="box"><div class="hd"><b style="color:var(--color-foreground)">' + esc(x.name || x.tag) + '</b><span class="lbl">' + esc(x.tag) + "</span>" + (x.draft ? '<span class="lbl">' + esc(t("草稿")) + "</span>" : "") + (x.prerelease ? '<span class="lbl">' + esc(t("预发布")) + "</span>" : "") + "<span>" + esc(x.author) + " · " + esc(ago(x.published || x.created)) + '</span><span class="grow"></span><button class="dbx-btn dbx-btn--ghost dbx-btn--danger" data-del="' + x.id + '" data-tag="' + esc(x.tag) + '">' + esc(t("删除")) + "</button></div>" + (x.body ? '<div class="txt">' + esc(x.body) + "</div>" : "") + (x.assets.length ? '<div class="dbx-hint" style="margin-top:4px">' + esc(t("附件：")) + x.assets.map(function (a) { return esc(t("{0}（{1} KB，下载 {2} 次）", a.name, (a.size / 1024).toFixed(0), a.downloads)); }).join(esc(t("、"))) + "</div>" : "") + "</div>";
      }).join("") + pager(relPage, r.hasNext) : empty("还没有 Release");
      bindPager(box, function (p) { relPage = p; loadReleases(); });
      each(box, "[data-del]", function (b) { b.onclick = function () {
        confirmBox(t("删除 Release「{0}」？", b.getAttribute("data-tag")), t("只删除 Release 本身，标签和代码不会被删。"), t("删除"), true, function () { return rpc("gh/deleteRelease", { repo: R(), id: +b.getAttribute("data-del") }).then(function () { toast(t("已删除")); loadReleases(); }); });
      }; });
    }).catch(function (e) { if (seq === S.seq) box.innerHTML = errBox(e); });
  }

  // ───────── 分支 ─────────
  function tabBranches(body) {
    rpc("gh/branches", { repo: R() }).then(function (r) {
      S.repo.branches = r.items;
      body.innerHTML = '<div class="bar"><span class="grow"></span><button class="dbx-btn dbx-btn--primary" id="b-new">' + esc(t("新建分支")) + '</button></div><div class="list">' + r.items.map(function (b) {
        var isDef = b.name === S.repo.branch;
        return '<div class="li"><div class="main"><div class="t">' + esc(b.name) + (isDef ? ' <span class="lbl">' + esc(t("默认")) + "</span>" : "") + (b.protected ? ' <span class="lbl">' + esc(t("受保护")) + "</span>" : "") + '</div><div class="m">' + esc(b.sha) + '</div></div><div class="side">' + (isDef || b.protected ? "" : '<button class="dbx-btn dbx-btn--ghost dbx-btn--danger" data-del="' + esc(b.name) + '">' + esc(t("删除")) + "</button>") + "</div></div>";
      }).join("") + "</div>";
      $("b-new").onclick = function () {
        formBox(t("新建分支"), [{ id: "name", label: t("分支名") }, { id: "from", label: t("从哪个分支创建"), type: "select", options: branchChoices(), value: S.repo.branch }], t("创建"), function (v) {
          return rpc("gh/createBranch", { repo: R(), name: v.name, from: v.from }).then(function () { toast(t("已创建 {0}", v.name)); tabBranches(body); });
        });
      };
      each(body, "[data-del]", function (b) { b.onclick = function () {
        confirmBox(t("删除分支「{0}」？", b.getAttribute("data-del")), t("分支上还没合并的提交会找不回来（除非别处有引用）。"), t("删除分支"), true, function () { return rpc("gh/deleteBranch", { repo: R(), name: b.getAttribute("data-del") }).then(function () { toast(t("已删除")); tabBranches(body); }); });
      }; });
    }).catch(function (e) { body.innerHTML = errBox(e); });
  }

  // ───────── 启动 ─────────
  function start() {
    renderWho();
    repoQ.page = 1;
    navTo("repos");
  }
  api.ready.then(function () {
    rpc("gh/status").then(function (st) {
      S.apiBase = st.apiBase || "";
      if (st.lang && !lsGet("gh.lang") && st.lang !== lang) { lang = st.lang; lsSet("gh.lang", lang); paintLang(); }
      if (!st.hasToken) return renderLogin();
      if (st.error) return renderLogin(st.error);
      S.me = st.user; start();
    }).catch(function (e) { view.innerHTML = errBox(e); });
  });
})();
