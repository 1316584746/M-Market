(function () {
  "use strict";
  var api = window.dbxPlugin;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var rpc = function (m, p, t) { return api.invoke(m, p || {}, { timeoutMs: t || 90000 }); };
  var view = $("view");

  var S = { me: null, repo: null, tab: "code", ref: "", seq: 0 };

  // ───────── 通用 ─────────
  var toastTimer;
  function toast(msg, isErr) {
    var t = $("toast");
    t.textContent = msg; t.className = "toast" + (isErr ? " err" : ""); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isErr ? 7000 : 2800);
  }
  function fail(e) { toast(e && e.message ? e.message : String(e), true); }
  function ago(iso) {
    if (!iso) return "";
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "刚刚";
    if (s < 3600) return Math.floor(s / 60) + " 分钟前";
    if (s < 86400) return Math.floor(s / 3600) + " 小时前";
    if (s < 86400 * 30) return Math.floor(s / 86400) + " 天前";
    return new Date(iso).toISOString().slice(0, 10);
  }
  function avatar(u) { return u && u.avatar ? '<img src="' + esc(u.avatar) + '&s=40" alt="" onerror="this.remove()" />' : ""; }
  function labels(ls) { return (ls || []).map(function (l) { return '<span class="lbl"' + (l.color ? ' style="border:1px solid #' + esc(String(l.color).replace(/[^0-9a-fA-F]/g, "")) + '"' : "") + ">" + esc(l.name) + "</span>"; }).join(""); }
  function loading() { return '<div class="dbx-hint pad">加载中…</div>'; }
  function errBox(e) { return '<div class="pad warn">' + esc(e && e.message ? e.message : e) + "</div>"; }
  function linkBox(url) { return url ? '<div class="dbx-hint" style="margin:6px 0">链接（点一下全选，复制到浏览器打开）<input class="dbx-input" readonly value="' + esc(url) + '" onfocus="this.select()" /></div>' : ""; }

  function openDialog(html) { $("dlg").innerHTML = html; $("modal").hidden = false; return $("dlg"); }
  function closeDialog() { $("modal").hidden = true; $("dlg").innerHTML = ""; }
  $("modal").addEventListener("mousedown", function (e) { if (e.target === $("modal")) closeDialog(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDialog(); });

  /** 弹出确认框；ok() 返回 Promise，成功后关框 */
  function confirmBox(title, msg, okLabel, danger, ok) {
    var d = openDialog("<h3>" + esc(title) + '</h3><div class="txt">' + esc(msg) + '</div><div class="foot"><button class="dbx-btn" data-x="no">取消</button><button class="dbx-btn ' + (danger ? "dbx-btn--danger" : "dbx-btn--primary") + '" data-x="ok">' + esc(okLabel) + "</button></div>");
    d.querySelector('[data-x="no"]').onclick = closeDialog;
    d.querySelector('[data-x="ok"]').onclick = function () {
      var b = this; b.disabled = true;
      new Promise(function (res) { res(ok()); }).then(closeDialog).catch(function (e) { b.disabled = false; fail(e); });
    };
  }

  /** 弹出表单：fields = [{ id, label, type: text|area|select|check, value, options, placeholder }]；ok(values) 返回 Promise */
  function formBox(title, fields, okLabel, ok, note) {
    var h = "<h3>" + esc(title) + '</h3><div class="form">';
    fields.forEach(function (f) {
      var lab = '<label class="dbx-label" for="f-' + f.id + '">' + esc(f.label) + "</label>";
      if (f.type === "area") h += "<div>" + lab + '<textarea class="dbx-textarea" id="f-' + f.id + '" rows="' + (f.rows || 6) + '" placeholder="' + esc(f.placeholder || "") + '"></textarea></div>';
      else if (f.type === "select") h += "<div>" + lab + '<select class="dbx-select" id="f-' + f.id + '">' + (f.options || []).map(function (o) { return '<option value="' + esc(o.value) + '">' + esc(o.label) + "</option>"; }).join("") + "</select></div>";
      else if (f.type === "check") h += '<label class="r"><input type="checkbox" id="f-' + f.id + '" /> ' + esc(f.label) + "</label>";
      else h += "<div>" + lab + '<input class="dbx-input" id="f-' + f.id + '" type="' + (f.type === "password" ? "password" : "text") + '" placeholder="' + esc(f.placeholder || "") + '" /></div>';
    });
    h += "</div>" + (note ? '<p class="dbx-hint">' + note + "</p>" : "") + '<div class="foot"><button class="dbx-btn" data-x="no">取消</button><button class="dbx-btn dbx-btn--primary" data-x="ok">' + esc(okLabel) + "</button></div>";
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

  function pager(page, hasNext, act) {
    if (page <= 1 && !hasNext) return "";
    return '<div class="pager"><button class="dbx-btn" data-pg="' + (page - 1) + '"' + (page <= 1 ? " disabled" : "") + '>上一页</button><span class="dbx-hint">第 ' + page + ' 页</span><button class="dbx-btn" data-pg="' + (page + 1) + '"' + (hasNext ? "" : " disabled") + ">下一页</button></div>";
  }
  function bindPager(root, fn) {
    Array.prototype.forEach.call(root.querySelectorAll("[data-pg]"), function (b) { b.onclick = function () { fn(+b.getAttribute("data-pg")); }; });
  }

  // ───────── 顶栏 ─────────
  function renderWho() {
    $("who").innerHTML = S.me ? avatar(S.me) + "<span>" + esc(S.me.login) + '</span><button class="dbx-btn" id="b-settings">设置</button>' : "";
    if (S.me) $("b-settings").onclick = openSettings;
  }
  function renderCrumb(extra) {
    var h = '<a id="c-home">我的仓库</a>';
    if (S.repo) h += ' / <a id="c-repo">' + esc(S.repo.full) + "</a>";
    if (extra) h += " / " + esc(extra);
    $("crumb").innerHTML = h;
    $("c-home").onclick = function () { S.repo = null; showRepos(); };
    if (S.repo) $("c-repo").onclick = function () { setTab(S.tab); };
  }

  // ───────── 登录 / 设置 ─────────
  function renderLogin(msg) {
    S.me = null; S.repo = null; renderWho(); $("crumb").innerHTML = "";
    view.innerHTML = '<div class="box login"><h2>连接 GitHub</h2><p class="dbx-hint">填一个个人访问令牌（PAT）。仓库读写要 <b>repo</b> 权限，改工作流文件和触发 Actions 要 <b>workflow</b>。细粒度令牌请给对应仓库勾上 Contents、Issues、Pull requests、Actions 的读写。令牌只保存在这个插件自己的数据目录里，不会发给界面或 AI。</p>' +
      (msg ? '<p class="warn">' + esc(msg) + "</p>" : "") +
      '<div class="form"><div><label class="dbx-label">令牌</label><input class="dbx-input" id="l-token" type="password" placeholder="ghp_… 或 github_pat_…" /></div>' +
      '<details><summary class="dbx-hint">企业版 / 自定义 API 地址（可选）</summary><input class="dbx-input" id="l-base" placeholder="https://github.example.com/api/v3" /></details>' +
      '<div><button class="dbx-btn dbx-btn--primary" id="l-go">连接</button></div></div></div>';
    $("l-go").onclick = function () {
      var b = this; b.disabled = true;
      rpc("gh/login", { token: $("l-token").value, apiBase: $("l-base").value }).then(function (r) { S.me = r.user; renderWho(); showRepos(); }).catch(function (e) { b.disabled = false; fail(e); });
    };
  }
  function openSettings() {
    rpc("gh/status").then(function (st) {
      var d = openDialog("<h3>设置</h3><p>已登录为 <b>" + esc(S.me.login) + '</b>　<span class="dbx-hint">' + esc(st.apiBase) + '</span></p><div class="form"><div><label class="dbx-label">换一个令牌（留空不改）</label><input class="dbx-input" id="s-token" type="password" /></div></div><div class="foot"><button class="dbx-btn dbx-btn--danger" data-x="out">退出登录并删除令牌</button><span style="flex:1"></span><button class="dbx-btn" data-x="no">关闭</button><button class="dbx-btn dbx-btn--primary" data-x="ok">保存</button></div>');
      d.querySelector('[data-x="no"]').onclick = closeDialog;
      d.querySelector('[data-x="out"]').onclick = function () { rpc("gh/logout").then(function () { closeDialog(); renderLogin(); }).catch(fail); };
      d.querySelector('[data-x="ok"]').onclick = function () {
        var t = $("s-token").value; if (!t) return closeDialog();
        rpc("gh/login", { token: t }).then(function (r) { S.me = r.user; renderWho(); closeDialog(); toast("已更新令牌"); }).catch(fail);
      };
    }).catch(fail);
  }

  // ───────── 仓库列表 ─────────
  var repoQ = { q: "", search: false, page: 1 };
  function showRepos() {
    S.repo = null; renderCrumb();
    view.innerHTML = '<div class="bar"><input class="dbx-input" id="r-q" placeholder="筛选我的仓库；或输入关键词后点「搜索 GitHub」" /><button class="dbx-btn" id="r-search">搜索 GitHub</button><button class="dbx-btn" id="r-mine">我的仓库</button><button class="dbx-btn dbx-btn--primary" id="r-new">新建仓库</button></div><div id="r-list">' + loading() + "</div>";
    $("r-q").value = repoQ.q;
    var t;
    $("r-q").oninput = function () { clearTimeout(t); t = setTimeout(function () { repoQ.q = $("r-q").value.trim(); repoQ.search = false; repoQ.page = 1; loadRepos(); }, 250); };
    $("r-search").onclick = function () { repoQ.q = $("r-q").value.trim(); repoQ.search = true; repoQ.page = 1; if (repoQ.q) loadRepos(); };
    $("r-mine").onclick = function () { repoQ = { q: "", search: false, page: 1 }; $("r-q").value = ""; loadRepos(); };
    $("r-new").onclick = function () {
      formBox("新建仓库", [{ id: "name", label: "仓库名" }, { id: "desc", label: "描述（可选）" }, { id: "priv", label: "私有仓库", type: "check", value: true }, { id: "init", label: "初始化 README", type: "check", value: true }], "创建", function (v) {
        return rpc("gh/createRepo", { name: v.name, description: v.desc, private: v.priv, autoInit: v.init }).then(function (r) { toast("已创建 " + r.full); openRepo(r.full); });
      });
    };
    loadRepos();
  }
  function loadRepos() {
    var seq = ++S.seq;
    $("r-list").innerHTML = loading();
    rpc("gh/repos", repoQ).then(function (r) {
      if (seq !== S.seq) return;
      if (!r.items.length) { $("r-list").innerHTML = '<div class="dbx-hint pad">没有仓库</div>'; return; }
      $("r-list").innerHTML = '<div class="list">' + r.items.map(function (x) {
        return '<div class="li click" role="button" tabindex="0" data-repo="' + esc(x.full) + '"><div class="main"><div class="t">' + esc(x.full) + (x.private ? ' <span class="lbl">私有</span>' : "") + (x.fork ? ' <span class="lbl">fork</span>' : "") + (x.archived ? ' <span class="lbl">已归档</span>' : "") + '</div><div class="m">' + esc(x.description || "（没有描述）") + '</div></div><div class="side">' + (x.language ? esc(x.language) + "<br>" : "") + "★ " + x.stars + "<br>" + ago(x.updated) + "</div></div>";
      }).join("") + "</div>" + pager(r.page, r.hasNext);
      Array.prototype.forEach.call($("r-list").querySelectorAll("[data-repo]"), function (el) { el.onclick = function () { openRepo(el.getAttribute("data-repo")); }; });
      bindPager($("r-list"), function (p) { repoQ.page = p; loadRepos(); });
    }).catch(function (e) { if (seq === S.seq) $("r-list").innerHTML = errBox(e); });
  }

  // ───────── 仓库页 ─────────
  function openRepo(full) {
    view.innerHTML = loading();
    rpc("gh/repo", { repo: full }).then(function (r) {
      S.repo = r; S.ref = r.branch; S.tab = "code"; S.path = "";
      renderRepoShell();
    }).catch(function (e) { view.innerHTML = errBox(e); });
  }
  var TABS = [["code", "代码"], ["issues", "Issues"], ["pulls", "Pull Requests"], ["actions", "Actions"], ["releases", "Releases"], ["branches", "分支"]];
  function renderRepoShell() {
    var r = S.repo;
    renderCrumb();
    view.innerHTML = "<h2>" + esc(r.full) + (r.private ? ' <span class="lbl">私有</span>' : "") + '</h2><div class="dbx-hint" style="margin-bottom:8px">' + esc(r.description || "") + " ★ " + r.stars + " · 默认分支 " + esc(r.branch) + (r.permissions && !r.permissions.push ? ' · <span class="warn">只读权限</span>' : "") + "</div>" +
      '<div class="tabs">' + TABS.map(function (t) { return '<div class="tab" role="button" tabindex="0" data-tab="' + t[0] + '">' + t[1] + "</div>"; }).join("") + '</div><div id="tab-body"></div>';
    Array.prototype.forEach.call(view.querySelectorAll("[data-tab]"), function (el) { el.onclick = function () { setTab(el.getAttribute("data-tab")); }; });
    setTab(S.tab);
  }
  function setTab(t) {
    S.tab = t; renderCrumb();
    Array.prototype.forEach.call(view.querySelectorAll("[data-tab]"), function (el) { el.classList.toggle("on", el.getAttribute("data-tab") === t); });
    var body = $("tab-body");
    if (!body) return renderRepoShell();
    body.innerHTML = loading();
    ({ code: tabCode, issues: tabIssues, pulls: tabPulls, actions: tabActions, releases: tabReleases, branches: tabBranches })[t](body);
  }
  var branchOptions = function (sel) { return S.repo.branches.map(function (b) { return '<option value="' + esc(b.name) + '"' + (b.name === sel ? " selected" : "") + ">" + esc(b.name) + "</option>"; }).join(""); };
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
      var head = '<div class="bar"><select class="dbx-select" id="br">' + branchOptions(S.ref) + '</select><div class="crumb" style="flex:1">' + bc + "</div>" + (r.type === "dir" ? '<button class="dbx-btn" id="newfile">新建文件</button>' : "") + "</div>";
      if (r.type === "dir") {
        body.innerHTML = head + '<div class="list">' + (r.items.length ? r.items.map(function (f) {
          return '<div class="li click" role="button" tabindex="0" data-open="' + esc(f.path) + '" data-type="' + f.type + '"><div class="main">' + (f.type === "dir" ? "📁 " : "📄 ") + esc(f.name) + '</div><div class="side">' + (f.type === "file" ? (f.size < 1024 ? f.size + " B" : (f.size / 1024).toFixed(1) + " KB") : "") + "</div></div>";
        }).join("") : '<div class="dbx-hint pad">空目录</div>') + "</div>";
      } else if (r.type === "file") {
        if (r.tooLarge || r.binary) body.innerHTML = head + '<div class="box dbx-hint">' + (r.binary ? "这是二进制文件，不能在这里查看" : "文件超过 1 MB，不能在这里查看 / 编辑") + "（" + r.size + " 字节）</div>";
        else body.innerHTML = head + '<textarea class="dbx-textarea editor" id="ed" spellcheck="false"></textarea><div class="bar" style="margin-top:8px"><button class="dbx-btn dbx-btn--primary" id="save">提交修改</button><button class="dbx-btn dbx-btn--danger" id="del">删除文件</button><span class="dbx-hint">' + esc(r.size) + " 字节 · 提交到分支 " + esc(S.ref) + "</span></div>" + linkBox(r.url);
        if ($("ed")) $("ed").value = r.text;
      } else {
        body.innerHTML = head + '<div class="box dbx-hint">这是一个' + esc(r.type) + "，这里不能打开</div>";
      }
      Array.prototype.forEach.call(body.querySelectorAll("[data-p]"), function (a) { a.style.cursor = "pointer"; a.onclick = function () { tabCode(body, a.getAttribute("data-p")); }; });
      Array.prototype.forEach.call(body.querySelectorAll("[data-open]"), function (el) { el.onclick = function () { tabCode(body, el.getAttribute("data-open")); }; });
      $("br").onchange = function () { S.ref = $("br").value; S.path = ""; tabCode(body); };
      if ($("newfile")) $("newfile").onclick = function () {
        formBox("新建文件", [{ id: "path", label: "文件路径", value: S.path ? S.path + "/" : "", placeholder: "docs/readme.md" }, { id: "content", label: "内容", type: "area", rows: 10 }, { id: "msg", label: "提交说明", value: "Create file" }], "提交", function (v) {
          return rpc("gh/putFile", { repo: R(), path: v.path, content: v.content, message: v.msg, branch: S.ref }).then(function (x) { toast("已提交 " + x.commit); tabCode(body, v.path.replace(/\/[^/]*$/, "").replace(/^[^/]*$/, "")); });
        }, "会直接提交到分支 <b>" + esc(S.ref) + "</b>。");
      };
      if ($("save")) $("save").onclick = function () {
        formBox("提交修改：" + r.path, [{ id: "msg", label: "提交说明", value: "Update " + r.name }], "提交", function (v) {
          return rpc("gh/putFile", { repo: R(), path: r.path, content: $("ed").value, message: v.msg, branch: S.ref, sha: r.sha }).then(function (x) { toast("已提交 " + x.commit); tabCode(body); });
        }, "会直接提交到分支 <b>" + esc(S.ref) + "</b>" + (S.ref === S.repo.branch ? "（默认分支）" : "") + "。");
      };
      if ($("del")) $("del").onclick = function () {
        formBox("删除文件：" + r.path, [{ id: "msg", label: "提交说明", value: "Delete " + r.name }], "删除", function (v) {
          return rpc("gh/deleteFile", { repo: R(), path: r.path, sha: r.sha, message: v.msg, branch: S.ref }).then(function () { toast("已删除"); tabCode(body, r.path.replace(/\/[^/]*$/, "").replace(/^[^/]*$/, "")); });
        }, "会在分支 <b>" + esc(S.ref) + "</b> 上提交一次删除（历史里还能找回）。");
      };
    }).catch(function (e) { if (seq === S.seq) body.innerHTML = errBox(e); });
  }

  // ───────── Issues ─────────
  var issueQ = { state: "open", q: "", page: 1 };
  function tabIssues(body) {
    body.innerHTML = '<div class="bar"><select class="dbx-select" id="i-state"><option value="open">打开的</option><option value="closed">已关闭</option><option value="all">全部</option></select><input class="dbx-input" id="i-q" placeholder="搜索 Issue" /><button class="dbx-btn dbx-btn--primary" id="i-new">新建 Issue</button></div><div id="i-list">' + loading() + "</div>";
    $("i-state").value = issueQ.state; $("i-q").value = issueQ.q;
    $("i-state").onchange = function () { issueQ.state = $("i-state").value; issueQ.page = 1; loadIssues(); };
    var t; $("i-q").oninput = function () { clearTimeout(t); t = setTimeout(function () { issueQ.q = $("i-q").value.trim(); issueQ.page = 1; loadIssues(); }, 300); };
    $("i-new").onclick = function () {
      formBox("新建 Issue", [{ id: "title", label: "标题" }, { id: "body", label: "内容", type: "area", rows: 8 }, { id: "labels", label: "标签（逗号分隔，可选）" }], "创建", function (v) {
        return rpc("gh/createIssue", { repo: R(), title: v.title, body: v.body, labels: v.labels.split(",").map(function (s) { return s.trim(); }).filter(Boolean) }).then(function (i) { toast("已创建 #" + i.number); showIssue(i.number); });
      });
    };
    loadIssues();
  }
  function loadIssues() {
    var seq = ++S.seq; var box = $("i-list"); box.innerHTML = loading();
    rpc("gh/issues", { repo: R(), state: issueQ.state, q: issueQ.q, page: issueQ.page }).then(function (r) {
      if (seq !== S.seq) return;
      box.innerHTML = r.items.length ? '<div class="list">' + r.items.map(function (i) {
        return '<div class="li click" role="button" tabindex="0" data-n="' + i.number + '"><span class="dot ' + i.state + '"></span><div class="main"><div class="t">' + esc(i.title) + '</div><div class="m">#' + i.number + " · " + esc(i.user && i.user.login) + " · " + ago(i.updated) + " " + labels(i.labels) + '</div></div><div class="side">' + (i.comments ? "💬 " + i.comments : "") + "</div></div>";
      }).join("") + "</div>" + pager(issueQ.page, r.hasNext) : '<div class="dbx-hint pad">没有符合条件的 Issue</div>';
      Array.prototype.forEach.call(box.querySelectorAll("[data-n]"), function (el) { el.onclick = function () { showIssue(+el.getAttribute("data-n")); }; });
      bindPager(box, function (p) { issueQ.page = p; loadIssues(); });
    }).catch(function (e) { if (seq === S.seq) box.innerHTML = errBox(e); });
  }
  function commentsHtml(list) {
    return (list || []).map(function (c) { return '<div class="box"><div class="hd">' + avatar(c.user) + "<b>" + esc(c.user && c.user.login) + "</b> " + ago(c.created) + '</div><div class="txt">' + esc(c.body) + "</div></div>"; }).join("");
  }
  function showIssue(n) {
    var body = $("tab-body"); body.innerHTML = loading(); renderCrumb("Issue #" + n);
    rpc("gh/issue", { repo: R(), number: n }).then(function (i) {
      body.innerHTML = '<div class="bar"><button class="dbx-btn" id="back">← 返回列表</button></div><h2>' + esc(i.title) + ' <span class="dbx-hint">#' + i.number + '</span></h2><div style="margin-bottom:8px"><span class="badge ' + i.state + '">' + (i.state === "open" ? "打开" : "已关闭") + "</span> " + esc(i.user && i.user.login) + " · " + ago(i.created) + " " + labels(i.labels) + "</div>" +
        '<div class="box"><div class="txt">' + esc(i.body || "（没有内容）") + "</div></div>" + commentsHtml(i.commentList) + linkBox(i.url) +
        '<h3>添加评论</h3><textarea class="dbx-textarea" id="cm" rows="4"></textarea><div class="bar" style="margin-top:8px"><button class="dbx-btn dbx-btn--primary" id="cm-go">评论</button><button class="dbx-btn" id="toggle">' + (i.state === "open" ? "关闭 Issue" : "重新打开") + '</button><button class="dbx-btn" id="edit">编辑</button></div>';
      $("back").onclick = function () { setTab("issues"); };
      $("cm-go").onclick = function () { rpc("gh/comment", { repo: R(), number: n, body: $("cm").value }).then(function () { toast("已评论"); showIssue(n); }).catch(fail); };
      $("toggle").onclick = function () { rpc("gh/updateIssue", { repo: R(), number: n, state: i.state === "open" ? "closed" : "open" }).then(function () { toast("已更新"); showIssue(n); }).catch(fail); };
      $("edit").onclick = function () {
        formBox("编辑 Issue #" + n, [{ id: "title", label: "标题", value: i.title }, { id: "body", label: "内容", type: "area", rows: 8, value: i.body }], "保存", function (v) {
          return rpc("gh/updateIssue", { repo: R(), number: n, title: v.title, body: v.body }).then(function () { toast("已保存"); showIssue(n); });
        });
      };
    }).catch(function (e) { body.innerHTML = errBox(e); });
  }

  // ───────── Pull Requests ─────────
  var pullQ = { state: "open", page: 1 };
  function tabPulls(body) {
    body.innerHTML = '<div class="bar"><select class="dbx-select" id="p-state"><option value="open">打开的</option><option value="closed">已关闭 / 已合并</option><option value="all">全部</option></select><span style="flex:1"></span><button class="dbx-btn dbx-btn--primary" id="p-new">新建 Pull Request</button></div><div id="p-list">' + loading() + "</div>";
    $("p-state").value = pullQ.state;
    $("p-state").onchange = function () { pullQ.state = $("p-state").value; pullQ.page = 1; loadPulls(); };
    $("p-new").onclick = function () {
      var other = S.repo.branches.filter(function (b) { return b.name !== S.repo.branch; })[0];
      formBox("新建 Pull Request", [
        { id: "head", label: "源分支（要合并的）", type: "select", options: S.repo.branches.map(function (b) { return { value: b.name, label: b.name }; }), value: other ? other.name : S.repo.branch },
        { id: "base", label: "目标分支", type: "select", options: S.repo.branches.map(function (b) { return { value: b.name, label: b.name }; }), value: S.repo.branch },
        { id: "title", label: "标题" }, { id: "body", label: "说明", type: "area", rows: 6 }, { id: "draft", label: "作为草稿", type: "check" }], "创建", function (v) {
        return rpc("gh/createPull", { repo: R(), head: v.head, base: v.base, title: v.title, body: v.body, draft: v.draft }).then(function (p) { toast("已创建 #" + p.number); showPull(p.number); });
      }, "跨仓库的 PR 请到 GitHub 网页上创建。");
    };
    loadPulls();
  }
  function loadPulls() {
    var seq = ++S.seq; var box = $("p-list"); box.innerHTML = loading();
    rpc("gh/pulls", { repo: R(), state: pullQ.state, page: pullQ.page }).then(function (r) {
      if (seq !== S.seq) return;
      box.innerHTML = r.items.length ? '<div class="list">' + r.items.map(function (p) {
        return '<div class="li click" role="button" tabindex="0" data-n="' + p.number + '"><span class="dot ' + p.state + '"></span><div class="main"><div class="t">' + (p.draft ? '<span class="lbl">草稿</span> ' : "") + esc(p.title) + '</div><div class="m">#' + p.number + " · " + esc(p.user && p.user.login) + " · " + esc(p.head) + " → " + esc(p.base) + " · " + ago(p.updated) + " " + labels(p.labels) + "</div></div></div>";
      }).join("") + "</div>" + pager(pullQ.page, r.hasNext) : '<div class="dbx-hint pad">没有符合条件的 Pull Request</div>';
      Array.prototype.forEach.call(box.querySelectorAll("[data-n]"), function (el) { el.onclick = function () { showPull(+el.getAttribute("data-n")); }; });
      bindPager(box, function (p) { pullQ.page = p; loadPulls(); });
    }).catch(function (e) { if (seq === S.seq) box.innerHTML = errBox(e); });
  }
  function diffHtml(patch) {
    if (!patch) return '<span class="dbx-hint">（没有文本 diff：二进制文件或改动太大）</span>';
    return patch.split("\n").map(function (l) { var c = l[0] === "+" ? "a" : l[0] === "-" ? "d" : l[0] === "@" ? "h" : ""; return '<span class="' + c + '">' + esc(l) + " </span>"; }).join("");
  }
  var STATE_ZH = { open: "打开", closed: "已关闭", merged: "已合并" };
  function showPull(n) {
    var body = $("tab-body"); body.innerHTML = loading(); renderCrumb("PR #" + n);
    rpc("gh/pull", { repo: R(), number: n }, 120000).then(function (p) {
      var canAct = p.state === "open";
      body.innerHTML = '<div class="bar"><button class="dbx-btn" id="back">← 返回列表</button></div><h2>' + esc(p.title) + ' <span class="dbx-hint">#' + p.number + '</span></h2><div style="margin-bottom:8px"><span class="badge ' + p.state + '">' + STATE_ZH[p.state] + "</span> " + (p.draft ? '<span class="lbl">草稿</span> ' : "") + esc(p.user && p.user.login) + " 想把 <b>" + esc(p.head) + "</b> 合并到 <b>" + esc(p.base) + "</b> · +" + (p.additions || 0) + " −" + (p.deletions || 0) + " · " + (p.changedFiles || 0) + " 个文件 " + labels(p.labels) + "</div>" +
        (canAct && p.mergeableState ? '<div class="dbx-hint" style="margin-bottom:8px">合并状态：' + esc(p.mergeable === false ? "有冲突，需要先解决" : p.mergeableState) + "</div>" : "") +
        '<div class="box"><div class="txt">' + esc(p.body || "（没有说明）") + "</div></div>" +
        "<h3>改动的文件（" + p.files.length + "）</h3>" + p.files.map(function (f) { return '<details class="file"><summary><span>' + esc(f.name) + '</span><span class="dbx-hint">' + esc(f.status) + ' <span class="ok">+' + f.additions + '</span> <span class="warn">−' + f.deletions + '</span></span></summary><pre class="code">' + diffHtml(f.patch) + "</pre></details>"; }).join("") +
        (p.reviews.length ? "<h3>评审</h3>" + p.reviews.map(function (r) { return '<div class="box"><div class="hd">' + avatar(r.user) + "<b>" + esc(r.user && r.user.login) + "</b> " + esc({ APPROVED: "批准了", CHANGES_REQUESTED: "要求修改", COMMENTED: "评论了", DISMISSED: "（已撤销）" }[r.state] || r.state) + "</div>" + (r.body ? '<div class="txt">' + esc(r.body) + "</div>" : "") + "</div>"; }).join("") : "") +
        (p.commentList.length ? "<h3>评论</h3>" + commentsHtml(p.commentList) : "") + linkBox(p.url) +
        '<h3>添加评论</h3><textarea class="dbx-textarea" id="cm" rows="4"></textarea><div class="bar" style="margin-top:8px"><button class="dbx-btn dbx-btn--primary" id="cm-go">评论</button>' +
        (canAct ? '<button class="dbx-btn" id="review">评审…</button><button class="dbx-btn dbx-btn--primary" id="merge"' + (p.draft || p.mergeable === false ? " disabled" : "") + ' title="' + (p.draft ? "草稿不能合并" : p.mergeable === false ? "有冲突" : "") + '">合并…</button><button class="dbx-btn" id="toggle">关闭 PR</button>' : (p.state === "closed" ? '<button class="dbx-btn" id="toggle">重新打开</button>' : "")) + "</div>";
      $("back").onclick = function () { setTab("pulls"); };
      $("cm-go").onclick = function () { rpc("gh/comment", { repo: R(), number: n, body: $("cm").value }).then(function () { toast("已评论"); showPull(n); }).catch(fail); };
      if ($("toggle")) $("toggle").onclick = function () { rpc("gh/updatePull", { repo: R(), number: n, state: p.state === "open" ? "closed" : "open" }).then(function () { toast("已更新"); showPull(n); }).catch(fail); };
      if ($("review")) $("review").onclick = function () {
        formBox("评审 #" + n, [{ id: "event", label: "结论", type: "select", options: [{ value: "COMMENT", label: "只评论" }, { value: "APPROVE", label: "批准" }, { value: "REQUEST_CHANGES", label: "要求修改" }] }, { id: "body", label: "说明", type: "area", rows: 5 }], "提交评审", function (v) {
          return rpc("gh/reviewPull", { repo: R(), number: n, event: v.event, body: v.body }).then(function () { toast("已提交评审"); showPull(n); });
        }, "不能评审自己创建的 PR（GitHub 的限制）。");
      };
      if ($("merge")) $("merge").onclick = function () {
        formBox("合并 #" + n, [{ id: "method", label: "合并方式", type: "select", options: [{ value: "merge", label: "合并提交（merge）" }, { value: "squash", label: "压缩合并（squash）" }, { value: "rebase", label: "变基合并（rebase）" }] }, { id: "title", label: "提交标题（可选）" }], "合并", function (v) {
          return rpc("gh/mergePull", { repo: R(), number: n, method: v.method, title: v.title }).then(function (r) { toast(r.merged ? "已合并 " + (r.sha || "") : r.message || "没有合并"); showPull(n); });
        }, "会修改 <b>" + esc(p.base) + "</b> 分支，不能撤销（只能再提交一次回滚）。");
      };
    }).catch(function (e) { body.innerHTML = errBox(e); });
  }

  // ───────── Actions ─────────
  var runQ = { page: 1, branch: "" };
  var RUN_CLS = function (r) { return r.status !== "completed" ? "progress" : r.conclusion === "success" ? "success" : r.conclusion === "failure" || r.conclusion === "timed_out" ? "failure" : ""; };
  var RUN_ZH = { queued: "排队中", in_progress: "运行中", waiting: "等待中", success: "成功", failure: "失败", cancelled: "已取消", skipped: "已跳过", timed_out: "超时", neutral: "中性", action_required: "需要操作" };
  var runText = function (r) { return RUN_ZH[r.status === "completed" ? r.conclusion : r.status] || r.conclusion || r.status; };
  function tabActions(body) {
    body.innerHTML = '<div class="bar"><select class="dbx-select" id="a-br"><option value="">全部分支</option>' + branchOptions(runQ.branch) + '</select><span style="flex:1"></span><button class="dbx-btn" id="a-refresh">刷新</button><button class="dbx-btn dbx-btn--primary" id="a-go">触发工作流…</button></div><div id="a-list">' + loading() + "</div>";
    $("a-br").value = runQ.branch;
    $("a-br").onchange = function () { runQ.branch = $("a-br").value; runQ.page = 1; loadRuns(); };
    $("a-refresh").onclick = loadRuns;
    $("a-go").onclick = function () {
      rpc("gh/workflows", { repo: R() }).then(function (w) {
        if (!w.items.length) return toast("这个仓库还没有工作流", true);
        formBox("触发工作流", [{ id: "wf", label: "工作流", type: "select", options: w.items.map(function (x) { return { value: String(x.id), label: x.name + "（" + x.path.replace(".github/workflows/", "") + "）" }; }) }, { id: "ref", label: "分支", type: "select", options: S.repo.branches.map(function (b) { return { value: b.name, label: b.name }; }), value: S.repo.branch }, { id: "inputs", label: "输入参数（JSON，可选）", type: "area", rows: 3, placeholder: '{"name":"value"}' }], "触发", function (v) {
          var inputs; if (v.inputs.trim()) { try { inputs = JSON.parse(v.inputs); } catch (e) { throw new Error("输入参数不是合法 JSON"); } }
          return rpc("gh/dispatch", { repo: R(), workflow: v.wf, ref: v.ref, inputs: inputs }).then(function () { toast("已触发，稍后刷新看结果"); setTimeout(loadRuns, 2500); });
        }, "只有声明了 <code>workflow_dispatch</code> 的工作流才能手动触发。");
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
        return '<div class="li"><span class="dot ' + RUN_CLS(x) + '"></span><div class="main"><div class="t">' + esc(x.title || x.name) + '</div><div class="m">' + esc(x.name) + " #" + x.number + " · " + esc(x.branch) + " · " + esc(x.sha) + " · " + esc(x.event) + " · " + esc(x.actor) + " · " + ago(x.created) + '</div><div class="jobs" id="jobs-' + x.id + '"></div></div><div class="side"><div>' + esc(runText(x)) + '</div><button class="dbx-btn dbx-btn--ghost" data-job="' + x.id + '">任务</button>' + (live ? '<button class="dbx-btn dbx-btn--ghost" data-cancel="' + x.id + '">取消</button>' : '<button class="dbx-btn dbx-btn--ghost" data-rerun="' + x.id + '">重跑</button>' + (RUN_CLS(x) === "failure" ? '<button class="dbx-btn dbx-btn--ghost" data-rerunf="' + x.id + '">只重跑失败的</button>' : "")) + "</div></div>";
      }).join("") + "</div>" + pager(runQ.page, r.hasNext) : '<div class="dbx-hint pad">还没有运行记录</div>';
      bindPager(box, function (p) { runQ.page = p; loadRuns(); });
      Array.prototype.forEach.call(box.querySelectorAll("[data-job]"), function (b) { b.onclick = function () {
        var id = b.getAttribute("data-job"), t = $("jobs-" + id);
        if (t.innerHTML) { t.innerHTML = ""; return; }
        t.innerHTML = '<span class="dbx-hint">加载中…</span>';
        rpc("gh/runJobs", { repo: R(), id: +id }).then(function (j) {
          t.innerHTML = j.items.map(function (job) { return '<details class="file"><summary><span>' + esc(job.name) + '</span><span class="dbx-hint">' + esc(RUN_ZH[job.conclusion || job.status] || job.conclusion || job.status) + "</span></summary><div style=\"padding:6px 10px\">" + job.steps.map(function (s) { return '<div class="dbx-hint">' + (s.conclusion === "success" ? "✓" : s.conclusion === "failure" ? "✗" : s.status === "completed" ? "–" : "…") + " " + esc(s.name) + "</div>"; }).join("") + "</div></details>"; }).join("") || '<span class="dbx-hint">没有任务</span>';
        }).catch(function (e) { t.innerHTML = '<span class="warn">' + esc(e.message) + "</span>"; });
      }; });
      var act = function (sel, method, extra, msg) { Array.prototype.forEach.call(box.querySelectorAll(sel), function (b) { b.onclick = function () {
        var p = { repo: R(), id: +b.getAttribute(sel.replace(/[\[\]]/g, "")) }; for (var k in extra) p[k] = extra[k];
        b.disabled = true; rpc(method, p).then(function () { toast(msg); setTimeout(loadRuns, 1500); }).catch(function (e) { b.disabled = false; fail(e); });
      }; }); };
      act("[data-rerun]", "gh/rerun", {}, "已重新运行");
      act("[data-rerunf]", "gh/rerun", { failedOnly: true }, "已重跑失败的任务");
      act("[data-cancel]", "gh/cancelRun", {}, "已请求取消");
    }).catch(function (e) { if (seq === S.seq) box.innerHTML = errBox(e); });
  }

  // ───────── Releases ─────────
  var relPage = 1;
  function tabReleases(body) {
    body.innerHTML = '<div class="bar"><span style="flex:1"></span><button class="dbx-btn dbx-btn--primary" id="rl-new">创建 Release</button></div><div id="rl-list">' + loading() + "</div>";
    $("rl-new").onclick = function () {
      formBox("创建 Release", [{ id: "tag", label: "标签（不存在会自动创建）", placeholder: "v1.0.0" }, { id: "target", label: "标签指向的分支（标签不存在时用）", type: "select", options: S.repo.branches.map(function (b) { return { value: b.name, label: b.name }; }), value: S.repo.branch }, { id: "name", label: "标题（可选）" }, { id: "body", label: "说明", type: "area", rows: 6 }, { id: "gen", label: "自动生成发布说明", type: "check" }, { id: "draft", label: "草稿（先不公开）", type: "check" }, { id: "pre", label: "标记为预发布", type: "check" }], "创建", function (v) {
        return rpc("gh/createRelease", { repo: R(), tag: v.tag, target: v.target, name: v.name, body: v.body, generateNotes: v.gen, draft: v.draft, prerelease: v.pre }).then(function () { toast("已创建"); loadReleases(); });
      });
    };
    loadReleases();
  }
  function loadReleases() {
    var seq = ++S.seq; var box = $("rl-list"); box.innerHTML = loading();
    rpc("gh/releases", { repo: R(), page: relPage }).then(function (r) {
      if (seq !== S.seq) return;
      box.innerHTML = r.items.length ? r.items.map(function (x) {
        return '<div class="box"><div class="hd"><b style="color:var(--color-foreground)">' + esc(x.name || x.tag) + '</b><span class="lbl">' + esc(x.tag) + "</span>" + (x.draft ? '<span class="lbl">草稿</span>' : "") + (x.prerelease ? '<span class="lbl">预发布</span>' : "") + "<span>" + esc(x.author) + " · " + ago(x.published || x.created) + '</span><span style="flex:1"></span><button class="dbx-btn dbx-btn--ghost dbx-btn--danger" data-del="' + x.id + '" data-tag="' + esc(x.tag) + '">删除</button></div>' + (x.body ? '<div class="txt">' + esc(x.body) + "</div>" : "") + (x.assets.length ? '<div class="dbx-hint" style="margin-top:4px">附件：' + x.assets.map(function (a) { return esc(a.name) + "（" + (a.size / 1024).toFixed(0) + " KB，下载 " + a.downloads + " 次）"; }).join("、") + "</div>" : "") + "</div>";
      }).join("") + pager(relPage, r.hasNext) : '<div class="dbx-hint pad">还没有 Release</div>';
      bindPager(box, function (p) { relPage = p; loadReleases(); });
      Array.prototype.forEach.call(box.querySelectorAll("[data-del]"), function (b) { b.onclick = function () {
        confirmBox("删除 Release「" + b.getAttribute("data-tag") + "」？", "只删除 Release 本身，标签和代码不会被删。", "删除", true, function () { return rpc("gh/deleteRelease", { repo: R(), id: +b.getAttribute("data-del") }).then(function () { toast("已删除"); loadReleases(); }); });
      }; });
    }).catch(function (e) { if (seq === S.seq) box.innerHTML = errBox(e); });
  }

  // ───────── 分支 ─────────
  function tabBranches(body) {
    rpc("gh/branches", { repo: R() }).then(function (r) {
      S.repo.branches = r.items;
      body.innerHTML = '<div class="bar"><span style="flex:1"></span><button class="dbx-btn dbx-btn--primary" id="b-new">新建分支</button></div><div class="list">' + r.items.map(function (b) {
        var isDef = b.name === S.repo.branch;
        return '<div class="li"><div class="main"><div class="t">' + esc(b.name) + (isDef ? ' <span class="lbl">默认</span>' : "") + (b.protected ? ' <span class="lbl">受保护</span>' : "") + '</div><div class="m">' + esc(b.sha) + '</div></div><div class="side">' + (isDef || b.protected ? "" : '<button class="dbx-btn dbx-btn--ghost dbx-btn--danger" data-del="' + esc(b.name) + '">删除</button>') + "</div></div>";
      }).join("") + "</div>";
      $("b-new").onclick = function () {
        formBox("新建分支", [{ id: "name", label: "分支名" }, { id: "from", label: "从哪个分支创建", type: "select", options: r.items.map(function (b) { return { value: b.name, label: b.name }; }), value: S.repo.branch }], "创建", function (v) {
          return rpc("gh/createBranch", { repo: R(), name: v.name, from: v.from }).then(function () { toast("已创建 " + v.name); tabBranches(body); });
        });
      };
      Array.prototype.forEach.call(body.querySelectorAll("[data-del]"), function (b) { b.onclick = function () {
        confirmBox("删除分支「" + b.getAttribute("data-del") + "」？", "分支上还没合并的提交会找不回来（除非别处有引用）。", "删除分支", true, function () { return rpc("gh/deleteBranch", { repo: R(), name: b.getAttribute("data-del") }).then(function () { toast("已删除"); tabBranches(body); }); });
      }; });
    }).catch(function (e) { body.innerHTML = errBox(e); });
  }

  // ───────── 启动 ─────────
  api.ready.then(function () {
    rpc("gh/status").then(function (st) {
      if (!st.hasToken) return renderLogin();
      if (st.error) return renderLogin(st.error);
      S.me = st.user; renderWho(); showRepos();
    }).catch(function (e) { view.innerHTML = errBox(e); });
  });
})();
