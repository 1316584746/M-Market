(function () {
  "use strict";
  var api = window.dbxPlugin;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var call = function (m, p, t) { return api.invoke(m, p || {}, { timeoutMs: t || 120000 }); };

  var S = { view: "all", q: "", kind: "", sort: "", source: "", category: "", tag: "", group: "", page: 1, data: null, busy: {} };

  // ───────── 小组件 ─────────
  var toastTimer;
  function toast(msg, isErr) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isErr ? 6000 : 2800);
  }
  function fail(e) { toast(e && e.message ? e.message : String(e), true); }

  function openDialog(html) {
    $("dlg").innerHTML = html;
    $("modal").hidden = false;
    return $("dlg");
  }
  function closeDialog() { $("modal").hidden = true; $("dlg").innerHTML = ""; }
  $("modal").addEventListener("mousedown", function (e) { if (e.target === $("modal")) closeDialog(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDialog(); });

  function fmtStars(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); }

  // ───────── 加载列表 ─────────
  var loadSeq = 0;
  function load(opts) {
    var seq = ++loadSeq;
    var p = { view: S.view, q: S.q, kind: S.kind, sort: S.sort, source: S.source, category: S.category, tag: S.tag, group: S.group, page: S.page, pageSize: 30, refresh: !!(opts && opts.refresh) };
    return call("market/list", p, 180000).then(function (r) {
      if (seq !== loadSeq) return;
      S.data = r;
      S.page = r.page;
      render();
    }).catch(function (e) {
      if (seq !== loadSeq) return;
      $("grid").innerHTML = '<div class="pad warn">' + esc(e.message || e) + "</div>";
    });
  }

  function render() {
    renderSide();
    renderNotice();
    var d = S.data;
    if (!d.items.length) {
      $("grid").innerHTML = '<div class="dbx-hint pad">' + (S.q || S.category || S.tag || S.group || S.view !== "all" ? "没有符合条件的插件" : "目录是空的：到右上角「来源与备份」里检查来源") + "</div>";
    } else {
      $("grid").innerHTML = d.items.map(card).join("");
    }
    $("pager").innerHTML = d.pages > 1
      ? '<button class="dbx-btn" data-act="prev"' + (d.page <= 1 ? " disabled" : "") + '>上一页</button><span class="dbx-hint">第 ' + d.page + " / " + d.pages + " 页，共 " + d.total + ' 个</span><button class="dbx-btn" data-act="next"' + (d.page >= d.pages ? " disabled" : "") + ">下一页</button>"
      : '<span class="dbx-hint">共 ' + d.total + " 个</span>";
  }

  function renderNotice() {
    var d = S.data;
    var h = "";
    d.errors.forEach(function (e) { h += '<div class="banner err">来源「' + esc(e.source) + "」：" + esc(e.error) + "</div>"; });
    $("notice").innerHTML = h;
  }

  function item(cls, label, count, attrs) {
    return '<div class="it ' + cls + '" role="button" tabindex="0" ' + attrs + '><span class="n">' + esc(label) + '</span><span class="c">' + (count == null ? "" : count) + "</span></div>";
  }

  function renderSide() {
    var d = S.data;
    var h = '<h4>浏览</h4>';
    h += item(S.view === "all" && !S.group && !S.category && !S.source ? "on" : "", "全部", null, 'data-nav="all"');
    h += item(S.view === "installed" ? "on" : "", "已安装", d.counts.installed, 'data-nav="installed"');
    h += item(S.view === "updates" ? "on" : "", "有更新", null, 'data-nav="updates"');
    h += item(S.view === "favorites" ? "on" : "", "★ 我的收藏", d.counts.favorites, 'data-nav="favorites"');
    h += '<h4>分组 <span class="mini" data-act="newgroup">＋ 新建</span></h4>';
    if (!d.groups.length) h += '<div class="it"><span class="n dbx-hint">还没有分组</span></div>';
    d.groups.forEach(function (g) { h += item(S.group === g.name ? "on" : "", g.name, g.count, 'data-group="' + esc(g.name) + '"'); });
    if (S.group) h += '<div class="it"><span class="mini" data-act="renamegroup">重命名</span><span class="mini warn" data-act="delgroup">删除分组</span></div>';
    if (d.categories.length) {
      h += "<h4>分类</h4>";
      d.categories.forEach(function (c) { h += item(S.category === c.name ? "on" : "", c.name, c.count, 'data-cat="' + esc(c.name) + '"'); });
    }
    h += "<h4>来源</h4>";
    d.sources.forEach(function (s) {
      if (!s.enabled) return;
      h += item(S.source === s.id ? "on" : "", s.name, s.count, 'data-source="' + esc(s.id) + '"');
    });
    $("side").innerHTML = h;
  }

  function card(x) {
    var ico = x.icon ? '<img src="' + esc(x.icon) + '" alt="" onerror="this.remove()" />' : "";
    var letter = esc((x.name || "?").trim().charAt(0).toUpperCase());
    var stat = [];
    if (x.author) stat.push(esc(x.author));
    if (x.version) stat.push("v" + esc(x.version));
    if (x.stars != null) stat.push("★ " + fmtStars(x.stars));
    if (x.updated) stat.push(esc(x.updated));
    var tags = (x.category ? '<span class="dbx-badge">' + esc(x.category) + "</span>" : "") + '<span class="dbx-badge">' + (x.kind === "dbx" ? "DBX" : "DSH") + "</span>" + x.tags.slice(0, 4).map(function (t) { return '<span class="dbx-badge">' + esc(t) + "</span>"; }).join("");
    var act = "";
    var u = esc(x.uid);
    if (x.kind === "dbx") {
      if (x.installed) {
        act += x.update ? '<button class="dbx-btn dbx-btn--primary" data-act="install" data-uid="' + u + '">更新到 v' + esc(x.version) + "</button>" : '<span class="ok">已安装 v' + esc(x.installed) + "</span>";
        act += '<button class="dbx-btn dbx-btn--danger" data-act="remove" data-uid="' + u + '">卸载</button>';
      } else if (x.installable) {
        act += '<button class="dbx-btn dbx-btn--primary" data-act="install" data-uid="' + u + '">安装</button>';
      } else {
        act += '<span class="dbx-hint" title="' + esc(x.noInstallReason) + '">不能安装：' + esc(x.noInstallReason) + "</span>";
      }
    } else {
      act += '<span class="dbx-hint" title="' + esc(x.noInstallReason) + '">到 M-Harness「插件中心」安装</span>';
    }
    act += '<span class="sub">';
    act += '<button class="sm" data-act="detail" data-uid="' + u + '">详情</button>';
    act += '<button class="sm" data-act="group" data-uid="' + u + '">分组' + (x.groups.length ? "(" + x.groups.length + ")" : "") + "</button>";
    act += '<button class="sm" data-act="note" data-uid="' + u + '">' + (x.note ? "改备注" : "备注") + "</button>";
    act += '<button class="star' + (x.favorite ? " on" : "") + '" data-act="fav" data-uid="' + u + '" title="收藏">' + (x.favorite ? "★" : "☆") + "</button>";
    act += "</span>";
    return '<div class="card"><div class="h"><div class="ico">' + ico + letter + '</div><div class="t"><div class="name" title="' + esc(x.name) + '">' + esc(x.name) + (x.update ? ' <span class="upd">有更新</span>' : "") + '</div><div class="meta">' + stat.join(" · ") + "</div></div></div>" +
      '<div class="desc" title="' + esc(x.description) + '">' + esc(x.description || "（没有简介）") + "</div>" +
      '<div class="tags">' + tags + "</div>" + (x.note ? '<div class="note">📝 ' + esc(x.note) + "</div>" : "") + '<div class="act">' + act + "</div></div>";
  }

  function find(uid) {
    var items = S.data ? S.data.items : [];
    for (var i = 0; i < items.length; i++) if (items[i].uid === uid) return items[i];
    return null;
  }

  // ───────── 动作 ─────────
  function doInstall(x) {
    var d = openDialog(
      "<h3>" + (x.installed ? "更新" : "安装") + "：" + esc(x.name) + " v" + esc(x.version) + "</h3>" +
      '<div class="dbx-hint">来源：' + esc(x.sourceName) + (x.author ? " · 作者：" + esc(x.author) : "") + "</div>" +
      "<h4>它会申请这些权限</h4><div>" + (x.permissions.length ? x.permissions.map(function (p) { return '<span class="perm">' + esc(p) + "</span>"; }).join("") : '<span class="dbx-hint">没有声明权限</span>') + "</div>" +
      '<p class="dbx-hint">安装包会按目录里的 sha256 校验，校验不过不会安装。带本机程序的插件第一次运行前，M-Harness 还会让你再确认一次信任。只装你信任的作者的插件。</p>' +
      '<div class="foot"><button class="dbx-btn" data-dlg="cancel">取消</button><button class="dbx-btn dbx-btn--primary" data-dlg="ok">确认' + (x.installed ? "更新" : "安装") + "</button></div>");
    d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
    d.querySelector('[data-dlg="ok"]').onclick = function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = "下载安装中…";
      call("market/install", { key: x.key }, 240000).then(function (r) {
        closeDialog();
        toast(r.message || "已安装");
        return load();
      }).catch(function (e) { closeDialog(); fail(e); });
    };
  }

  function doRemove(x) {
    var d = openDialog("<h3>卸载 " + esc(x.name) + "？</h3><p class=\"dbx-hint\">会删除这个插件的程序文件。它自己保存的数据目录不会删。</p>" +
      '<div class="foot"><button class="dbx-btn" data-dlg="cancel">取消</button><button class="dbx-btn dbx-btn--danger" data-dlg="ok">卸载</button></div>');
    d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
    d.querySelector('[data-dlg="ok"]').onclick = function () {
      call("market/uninstall", { id: x.id }).then(function () { closeDialog(); toast("已卸载 " + x.name); return load(); }).catch(function (e) { closeDialog(); fail(e); });
    };
  }

  function doDetail(x) {
    var links = [];
    if (x.repo) links.push(["仓库", x.repo]);
    if (x.homepage && x.homepage !== x.repo) links.push(["主页", x.homepage]);
    var d = openDialog(
      "<h3>" + esc(x.name) + ' <span class="dbx-badge">' + (x.kind === "dbx" ? "DBX" : "DSH") + "</span></h3>" +
      '<div class="dbx-hint">' + [x.author, x.version && "v" + x.version, x.license, x.updated, x.stars != null && "★ " + x.stars].filter(Boolean).map(esc).join(" · ") + "</div>" +
      '<p style="white-space:pre-wrap">' + esc(x.description || "（没有简介）") + "</p>" +
      (x.tags.length ? "<div>" + x.tags.map(function (t) { return '<span class="dbx-badge">' + esc(t) + "</span> "; }).join("") + "</div>" : "") +
      (x.permissions.length ? "<h4>权限</h4><div>" + x.permissions.map(function (p) { return '<span class="perm">' + esc(p) + "</span>"; }).join("") + "</div>" : "") +
      (links.length ? "<h4>链接（点一下全选，复制后到浏览器打开）</h4>" + links.map(function (l) { return '<div class="row"><span class="dbx-hint" style="width:40px">' + l[0] + '</span><input class="dbx-input" readonly value="' + esc(l[1]) + '" onfocus="this.select()" /></div>'; }).join("") : "") +
      '<div class="dbx-hint">来源：' + esc(x.sourceName) + "　标识：" + esc(x.uid) + "</div>" +
      '<div class="foot"><button class="dbx-btn" data-dlg="cancel">关闭</button></div>');
    d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
  }

  function doNote(x) {
    var d = openDialog("<h3>备注：" + esc(x.name) + '</h3><textarea class="dbx-textarea" id="note-t" maxlength="2000" placeholder="写给自己看的备注（留空 = 删除）"></textarea>' +
      '<div class="foot"><button class="dbx-btn" data-dlg="cancel">取消</button><button class="dbx-btn dbx-btn--primary" data-dlg="ok">保存</button></div>');
    $("note-t").value = x.note || "";
    d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
    d.querySelector('[data-dlg="ok"]').onclick = function () {
      call("user/note", { uid: x.uid, text: $("note-t").value }).then(function () { closeDialog(); return load(); }).catch(fail);
    };
  }

  function doGroup(x) {
    var groups = S.data.groups.map(function (g) { return g.name; });
    var d = openDialog("<h3>分组：" + esc(x.name) + "</h3>" +
      (groups.length ? groups.map(function (g, i) { return '<label class="row"><input type="checkbox" data-g="' + i + '"' + (x.groups.indexOf(g) >= 0 ? " checked" : "") + " /> " + esc(g) + "</label>"; }).join("") : '<div class="dbx-hint">还没有分组，在下面新建一个</div>') +
      '<h4>新建分组并加入</h4><div class="row"><input class="dbx-input" id="g-new" maxlength="40" placeholder="分组名" /></div>' +
      '<div class="foot"><button class="dbx-btn" data-dlg="cancel">取消</button><button class="dbx-btn dbx-btn--primary" data-dlg="ok">保存</button></div>');
    d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
    d.querySelector('[data-dlg="ok"]').onclick = function () {
      var jobs = [];
      groups.forEach(function (g, i) {
        var on = d.querySelector('[data-g="' + i + '"]').checked;
        if (on !== (x.groups.indexOf(g) >= 0)) jobs.push(call("user/groupSet", { uid: x.uid, group: g, on: on }));
      });
      var nn = $("g-new").value.trim();
      if (nn) jobs.push(call("user/groupSet", { uid: x.uid, group: nn, on: true }));
      Promise.all(jobs).then(function () { closeDialog(); return load(); }).catch(fail);
    };
  }

  function askText(title, value, ok) {
    var d = openDialog("<h3>" + esc(title) + '</h3><div class="row"><input class="dbx-input" id="ask-t" maxlength="40" /></div><div class="foot"><button class="dbx-btn" data-dlg="cancel">取消</button><button class="dbx-btn dbx-btn--primary" data-dlg="ok">确定</button></div>');
    $("ask-t").value = value || "";
    $("ask-t").focus();
    d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
    var go = function () { var v = $("ask-t").value.trim(); if (!v) return; ok(v); };
    d.querySelector('[data-dlg="ok"]').onclick = go;
    $("ask-t").addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  }

  // ───────── 来源与备份 ─────────
  function openSettings() {
    call("market/settings").then(function (cfg) {
      var d = openDialog(
        "<h3>来源与备份</h3>" +
        "<h4>目录来源</h4><div id=\"srcs\"></div>" +
        '<div class="row"><input class="dbx-input" id="src-name" placeholder="名称" style="max-width:150px" /><input class="dbx-input" id="src-url" placeholder="目录地址（https://…/index.json，DBX 目录或 DSH 市场索引）" /><button class="dbx-btn" id="src-add">添加</button></div>' +
        '<div class="row"><button class="dbx-btn dbx-btn--primary" id="src-save">保存来源并刷新</button><button class="dbx-btn" id="src-reset">恢复默认</button></div>' +
        '<h4>备份与还原（收藏、分组、备注、来源）</h4>' +
        '<textarea class="dbx-textarea" id="bk-text" placeholder="点「导出」生成备份 JSON；要还原时把备份粘贴到这里，再点「导入（合并）」"></textarea>' +
        '<div class="row"><button class="dbx-btn" id="bk-export">导出</button><button class="dbx-btn" id="bk-import">导入（合并）</button><button class="dbx-btn" id="bk-replace">导入（覆盖）</button></div>' +
        "<h4>WebDAV 同步</h4>" +
        '<div class="row"><input class="dbx-input" id="dav-url" placeholder="WebDAV 目录地址，如 https://dav.example.com/backup" /></div>' +
        '<div class="row"><input class="dbx-input" id="dav-user" placeholder="用户名" /><input class="dbx-input" id="dav-pass" type="password" placeholder="' + (cfg.webdav.hasPassword ? "密码（已保存，留空不改）" : "密码") + '" /></div>' +
        '<div class="row"><button class="dbx-btn" id="dav-save">保存</button><button class="dbx-btn" id="dav-push">上传</button><button class="dbx-btn" id="dav-pull">下载并合并</button></div>' +
        "<h4>私有 Gist 同步</h4>" +
        '<div class="row"><input class="dbx-input" id="gist-token" type="password" placeholder="' + (cfg.gist.hasToken ? "GitHub 令牌（已保存，留空不改）" : "GitHub 令牌（需要 gist 权限）") + '" /></div>' +
        '<div class="row"><input class="dbx-input" id="gist-id" placeholder="Gist ID（第一次上传会自动创建）" /></div>' +
        '<div class="row"><button class="dbx-btn" id="gist-save">保存</button><button class="dbx-btn" id="gist-push">上传</button><button class="dbx-btn" id="gist-pull">下载并合并</button></div>' +
        '<p class="dbx-hint">WebDAV 密码和 GitHub 令牌以明文存在插件自己的数据目录里（' + esc(cfg.pluginsDir.replace(/plugins$/, "plugin-data")) + '），不会发到别处；备份文件里不含它们。</p>' +
        '<div class="foot"><button class="dbx-btn" data-dlg="cancel">关闭</button></div>');
      var srcs = cfg.sources.map(function (s) { return { id: s.id, name: s.name, url: s.url, enabled: s.enabled }; });
      function drawSrcs() {
        $("srcs").innerHTML = srcs.map(function (s, i) {
          return '<div class="src"><input type="checkbox" data-i="' + i + '" ' + (s.enabled ? "checked" : "") + ' /><span class="n">' + esc(s.name) + '</span><span class="dbx-hint" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(s.url) + '">' + esc(s.url) + '</span><button class="dbx-btn dbx-btn--ghost" data-rm="' + i + '">删除</button></div>';
        }).join("");
        Array.prototype.forEach.call(d.querySelectorAll("[data-i]"), function (el) { el.onchange = function () { srcs[+el.getAttribute("data-i")].enabled = el.checked; }; });
        Array.prototype.forEach.call(d.querySelectorAll("[data-rm]"), function (el) { el.onclick = function () { srcs.splice(+el.getAttribute("data-rm"), 1); drawSrcs(); }; });
      }
      drawSrcs();
      $("dav-url").value = cfg.webdav.url; $("dav-user").value = cfg.webdav.user; $("gist-id").value = cfg.gist.gistId;
      d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
      $("src-add").onclick = function () {
        var url = $("src-url").value.trim();
        if (!url) return;
        srcs.push({ name: $("src-name").value.trim() || url, url: url, enabled: true });
        $("src-name").value = ""; $("src-url").value = "";
        drawSrcs();
      };
      $("src-save").onclick = function () {
        call("market/saveSettings", { sources: srcs }).then(function () { closeDialog(); toast("来源已保存"); S.source = ""; return load({ refresh: true }); }).catch(fail);
      };
      $("src-reset").onclick = function () { srcs = cfg.defaults.map(function (s) { return { id: s.id, name: s.name, url: s.url, enabled: s.enabled }; }); drawSrcs(); };
      $("bk-export").onclick = function () { call("backup/export").then(function (r) { $("bk-text").value = JSON.stringify(r, null, 2); $("bk-text").select(); toast("已生成，复制保存即可"); }).catch(fail); };
      function imp(mode) {
        var data;
        try { data = JSON.parse($("bk-text").value); } catch (e) { return fail(new Error("粘贴的内容不是 JSON")); }
        call("backup/import", { data: data, mode: mode }).then(function (r) { toast("已还原：" + r.favorites + " 个收藏、" + r.groups + " 个分组、" + r.notes + " 条备注"); return load(); }).catch(fail);
      }
      $("bk-import").onclick = function () { imp("merge"); };
      $("bk-replace").onclick = function () { imp("replace"); };
      function cloud(action, saveFirst) {
        var p = saveFirst ? saveFirst() : Promise.resolve();
        p.then(function () { return call("backup/cloud", { action: action }); }).then(function (r) { toast(r.message || "完成"); if (r.restored) return load(); }).catch(fail);
      }
      var saveDav = function () { return call("market/saveSettings", { webdav: { url: $("dav-url").value, user: $("dav-user").value, password: $("dav-pass").value } }); };
      var saveGist = function () { return call("market/saveSettings", { gist: { token: $("gist-token").value, gistId: $("gist-id").value } }); };
      $("dav-save").onclick = function () { saveDav().then(function () { toast("已保存"); }).catch(fail); };
      $("dav-push").onclick = function () { cloud("webdavPush", saveDav); };
      $("dav-pull").onclick = function () { cloud("webdavPull", saveDav); };
      $("gist-save").onclick = function () { saveGist().then(function () { toast("已保存"); }).catch(fail); };
      $("gist-push").onclick = function () { cloud("gistPush", saveGist); };
      $("gist-pull").onclick = function () { cloud("gistPull", saveGist); };
    }).catch(fail);
  }

  // ───────── 事件 ─────────
  function reset(patch) {
    S.view = "all"; S.source = ""; S.category = ""; S.tag = ""; S.group = "";
    for (var k in patch) S[k] = patch[k];
    S.page = 1;
    load();
  }

  document.addEventListener("click", function (e) {
    var el = e.target.closest ? e.target.closest("[data-act],[data-nav],[data-group],[data-cat],[data-source]") : null;
    if (!el || $("modal").contains(el)) return;
    var act = el.getAttribute("data-act");
    if (el.hasAttribute("data-nav")) return reset({ view: el.getAttribute("data-nav") });
    if (el.hasAttribute("data-group")) return reset({ group: el.getAttribute("data-group") });
    if (el.hasAttribute("data-cat")) return reset({ category: S.category === el.getAttribute("data-cat") ? "" : el.getAttribute("data-cat") });
    if (el.hasAttribute("data-source")) return reset({ source: S.source === el.getAttribute("data-source") ? "" : el.getAttribute("data-source") });
    if (act === "prev") { S.page--; return load(); }
    if (act === "next") { S.page++; return load(); }
    if (act === "newgroup") return askText("新建分组", "", function (n) { call("user/groupCreate", { name: n }).then(function () { closeDialog(); return load(); }).catch(fail); });
    if (act === "renamegroup") return askText("重命名分组", S.group, function (n) { call("user/groupRename", { from: S.group, to: n }).then(function () { S.group = n; closeDialog(); return load(); }).catch(fail); });
    if (act === "delgroup") {
      var g = S.group;
      var d = openDialog("<h3>删除分组「" + esc(g) + "」？</h3><p class=\"dbx-hint\">只删分组，里面的插件不受影响。</p><div class=\"foot\"><button class=\"dbx-btn\" data-dlg=\"cancel\">取消</button><button class=\"dbx-btn dbx-btn--danger\" data-dlg=\"ok\">删除</button></div>");
      d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
      d.querySelector('[data-dlg="ok"]').onclick = function () { call("user/groupDelete", { name: g }).then(function () { S.group = ""; closeDialog(); return load(); }).catch(fail); };
      return;
    }
    var x = find(el.getAttribute("data-uid"));
    if (!x) return;
    if (act === "install") return doInstall(x);
    if (act === "remove") return doRemove(x);
    if (act === "detail") return doDetail(x);
    if (act === "note") return doNote(x);
    if (act === "group") return doGroup(x);
    if (act === "fav") {
      call("user/favorite", { uid: x.uid, on: !x.favorite }).then(function () { return load(); }).catch(fail);
    }
  });

  var qTimer;
  $("q").addEventListener("input", function () { clearTimeout(qTimer); qTimer = setTimeout(function () { S.q = $("q").value.trim(); S.page = 1; load(); }, 250); });
  $("kind").addEventListener("change", function () { S.kind = $("kind").value; S.page = 1; load(); });
  $("sort").addEventListener("change", function () { S.sort = $("sort").value; S.page = 1; load(); });
  $("refresh").addEventListener("click", function () { var b = $("refresh"); b.disabled = true; load({ refresh: true }).then(function () { b.disabled = false; toast("目录已刷新"); }); });
  $("open-settings").addEventListener("click", openSettings);

  api.ready.then(function () { load(); });
})();
