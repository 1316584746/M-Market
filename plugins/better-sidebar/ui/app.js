(function () {
  "use strict";
  var api = window.dbxPlugin;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var call = function (m, p) { return api.invoke(m, p || {}, { timeoutMs: 60000 }); };
  var base = function (p) { return p.slice(p.lastIndexOf("/") + 1); };
  var sizeText = function (n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; };

  var S = {
    root: "",
    expanded: { "": true },
    cache: {},
    files: {},          // path -> { content, orig, eol, bom, mtime, kind }
    tabs: [],           // { key, type: "file" | "diff", path, staged }
    active: null,
    git: null,
    sideTab: "files",
    msgTimer: null,
    cands: []
  };

  function toast(text, bad) {
    var el = $("msgbar");
    el.hidden = false;
    el.innerHTML = (bad ? '<span class="warn">' : "<span>") + esc(text) + "</span>";
    clearTimeout(S.msgTimer);
    S.msgTimer = setTimeout(function () { el.hidden = true; }, bad ? 8000 : 2500);
  }
  var fail = function (e) { toast(e && e.message ? e.message : String(e), true); };

  // ───────── 工作区 ─────────

  // 不用 datalist：输入框预填当前路径时，浏览器按前缀过滤，其它目录会被藏起来；Windows 路径里的 \ 也经常点不中。
  function samePath(a, b) {
    if (!a || !b) return false;
    var norm = function (p) { return String(p).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase(); };
    return norm(a) === norm(b);
  }
  function renderCands() {
    var box = $("candlist");
    var q = $("rootin").value.trim();
    var showAll = !q || samePath(q, S.root);
    var list = (S.cands || []).filter(function (c) {
      if (showAll) return true;
      var s = q.toLowerCase();
      return c.path.toLowerCase().indexOf(s) >= 0 || (c.why && c.why.toLowerCase().indexOf(s) >= 0);
    });
    if (!list.length) {
      box.innerHTML = '<li class="cand muted"><span class="dbx-hint">没有匹配的目录。输入完整路径后点「打开」。</span></li>';
      return;
    }
    box.innerHTML = list.map(function (c) {
      return '<li class="cand' + (samePath(c.path, q) ? " on" : "") + '" data-path="' + esc(c.path) + '"><span class="p" title="' + esc(c.path) + '">' + esc(c.path) + '</span><span class="why">' + esc(c.why) + "</span></li>";
    }).join("");
  }

  function loadWs() {
    return call("ws/get").then(function (w) {
      S.root = w.root;
      S.cands = w.candidates || [];
      $("root").textContent = w.root || "（未选择）";
      $("root").title = w.root;
      renderCands();
      if (!w.root) { $("editroot").hidden = false; return; }
      S.cache = {}; S.expanded = { "": true };
      return Promise.all([loadDir(""), refreshGit()]);
    }).catch(fail);
  }

  $("chroot").addEventListener("click", function () {
    var opening = $("editroot").hidden;
    $("editroot").hidden = !opening;
    $("rooterr").textContent = "";
    if (!opening) return;
    $("rootin").value = S.root;
    renderCands();
    $("rootin").focus();
    $("rootin").select();
  });
  $("rootin").addEventListener("input", renderCands);
  $("rootin").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); $("rootok").click(); }
    else if (e.key === "Escape") $("editroot").hidden = true;
  });
  $("candlist").addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest(".cand[data-path]");
    if (!el) return;
    $("rootin").value = el.getAttribute("data-path");
    $("rooterr").textContent = "";
    renderCands();
  });
  $("rootcancel").addEventListener("click", function () { $("editroot").hidden = true; });
  $("rootok").addEventListener("click", function () {
    call("ws/set", { path: $("rootin").value.trim() }).then(function () {
      $("editroot").hidden = true;
      S.tabs = []; S.files = {}; S.active = null;
      renderTabs(); renderEditor();
      return loadWs();
    }).catch(function (e) { $("rooterr").textContent = e.message || String(e); });
  });
  $("refresh").addEventListener("click", function () { S.cache = {}; Promise.all([loadDir(""), refreshExpanded(), refreshGit()]); });
  $("toggle").addEventListener("click", function () { $("side").classList.toggle("hide"); });

  // ───────── 侧栏 tab ─────────

  $("tabs").addEventListener("click", function (e) {
    var t = e.target && e.target.getAttribute && e.target.getAttribute("data-t");
    if (!t) return;
    S.sideTab = t;
    Array.prototype.forEach.call($("tabs").querySelectorAll("button"), function (b) { b.classList.toggle("on", b.getAttribute("data-t") === t); });
    ["files", "search", "git"].forEach(function (n) { $("p-" + n).hidden = n !== t; });
    if (t === "git") refreshGit();
    if (t === "search") $("sq").focus();
  });

  // ───────── 文件树 ─────────

  function loadDir(dir) {
    return call("fs/list", { dir: dir }).then(function (r) { S.cache[dir] = r; renderTree(); }).catch(function (e) { S.cache[dir] = { entries: [], error: e.message }; renderTree(); fail(e); });
  }
  function refreshExpanded() {
    return Promise.all(Object.keys(S.expanded).filter(function (d) { return d && S.expanded[d]; }).map(loadDir));
  }

  function treeHtml(dir, depth) {
    var r = S.cache[dir];
    if (!r) return '<div class="node" style="padding-left:' + (8 + depth * 14) + 'px"><span class="dbx-hint">加载中…</span></div>';
    var h = "";
    (r.entries || []).forEach(function (e) {
      var p = dir ? dir + "/" + e.name : e.name;
      var open = e.dir && S.expanded[p];
      var on = S.active && S.active === "f:" + p;
      h += '<div class="node' + (on ? " on" : "") + '" data-p="' + esc(p) + '" data-d="' + (e.dir ? 1 : 0) + '" style="padding-left:' + (8 + depth * 14) + 'px">' +
        '<span class="ar">' + (e.dir ? (open ? "▼" : "▶") : "") + '</span><span class="nm">' + (e.dir ? "📁 " : "") + esc(e.name) + "</span>" + (e.dir ? "" : '<span class="sz">' + sizeText(e.size) + "</span>") + "</div>";
      if (open) h += treeHtml(p, depth + 1);
    });
    if (r.truncated) h += '<div class="node"><span class="dbx-hint">（目录太大，只显示前 3000 项）</span></div>';
    if (r.error) h += '<div class="node"><span class="warn">' + esc(r.error) + "</span></div>";
    return h;
  }
  function renderTree() { $("p-files").innerHTML = treeHtml("", 0); }

  $("p-files").addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest(".node[data-p]");
    if (!el) return;
    var p = el.getAttribute("data-p");
    if (el.getAttribute("data-d") === "1") {
      S.expanded[p] = !S.expanded[p];
      if (S.expanded[p] && !S.cache[p]) loadDir(p); else renderTree();
    } else openFile(p);
  });

  // ───────── 打开 / 编辑 / 保存 ─────────

  var fileOf = function (p) { return S.files[p]; };
  var isDirty = function (p) { var f = fileOf(p); return !!f && f.kind === "text" && f.content !== f.orig; };

  function syncCurrent() {
    var ta = $("editor").querySelector("textarea.code");
    if (ta && S.active && S.active.indexOf("f:") === 0) { var f = fileOf(S.active.slice(2)); if (f && f.kind === "text") f.content = ta.value; }
  }

  function addTab(tab) {
    if (!S.tabs.some(function (t) { return t.key === tab.key; })) S.tabs.push(tab);
    syncCurrent();
    S.active = tab.key;
    renderTabs(); renderEditor(); renderTree();
  }

  function openFile(p) {
    if (S.files[p]) return addTab({ key: "f:" + p, type: "file", path: p });
    call("fs/read", { path: p }).then(function (r) {
      S.files[p] = r.binary ? { kind: "binary", size: r.size } : r.tooLarge ? { kind: "large", size: r.size } : { kind: "text", content: r.content, orig: r.content, eol: r.eol, bom: r.bom, mtime: r.mtime };
      addTab({ key: "f:" + p, type: "file", path: p });
    }).catch(fail);
  }

  function closeTab(key) {
    if (key.indexOf("f:") === 0 && isDirty(key.slice(2)) && closeTab.armed !== key) {
      closeTab.armed = key;
      toast("「" + base(key.slice(2)) + "」有未保存的修改，再点一次 × 放弃修改并关闭", true);
      return;
    }
    closeTab.armed = null;
    syncCurrent();
    var i = S.tabs.findIndex(function (t) { return t.key === key; });
    if (i < 0) return;
    S.tabs.splice(i, 1);
    if (key.indexOf("f:") === 0) delete S.files[key.slice(2)];
    if (S.active === key) S.active = S.tabs.length ? S.tabs[Math.min(i, S.tabs.length - 1)].key : null;
    renderTabs(); renderEditor(); renderTree();
  }

  function renderTabs() {
    $("openbar").innerHTML = S.tabs.map(function (t) {
      var name = t.type === "diff" ? "Δ " + base(t.path) + (t.staged ? "（已暂存）" : "") : base(t.path);
      return '<div class="otab' + (t.key === S.active ? " on" : "") + '" data-k="' + esc(t.key) + '" title="' + esc(t.path) + '">' + (t.type === "file" && isDirty(t.path) ? '<span class="dot">●</span>' : "") + "<span>" + esc(name) + '</span><span class="x" data-x="1">×</span></div>';
    }).join("");
  }
  $("openbar").addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest(".otab");
    if (!el) return;
    var k = el.getAttribute("data-k");
    if (e.target.getAttribute && e.target.getAttribute("data-x")) return closeTab(k);
    syncCurrent(); S.active = k; renderTabs(); renderEditor(); renderTree();
  });

  var lineGutter = function (text) { var n = text.split("\n").length, s = []; for (var i = 1; i <= n; i++) s.push(i); return s.join("\n"); };

  function renderEditor() {
    var box = $("editor");
    var tab = S.tabs.find(function (t) { return t.key === S.active; });
    if (!tab) { box.innerHTML = '<div class="empty dbx-hint">从左侧打开一个文件，或在 Git 里点一个改动看 diff。</div>'; return; }
    if (tab.type === "diff") {
      box.innerHTML = '<pre class="diff"><div class="meta">加载中…</div></pre>';
      call("git/diff", { path: tab.path, staged: !!tab.staged }).then(function (r) {
        if (S.active !== tab.key) return;
        box.innerHTML = '<pre class="diff">' + r.text.split("\n").map(function (l) {
          var c = /^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename)/.test(l) ? "meta" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : l[0] === "@" ? "hunk" : "";
          return '<div class="' + c + '">' + esc(l) + "</div>";
        }).join("") + "</pre>";
      }).catch(fail);
      return;
    }
    var f = fileOf(tab.path);
    if (!f) return;
    if (f.kind !== "text") { box.innerHTML = '<div class="empty dbx-hint">' + (f.kind === "binary" ? "这是二进制文件，不能在这里查看。" : "文件太大（" + sizeText(f.size) + "），超过 2 MB，不在这里打开。") + "</div>"; return; }
    box.innerHTML = '<div class="gutter"></div><textarea class="code" spellcheck="false" wrap="off"></textarea>';
    var ta = box.querySelector("textarea"), g = box.querySelector(".gutter");
    ta.value = f.content; g.textContent = lineGutter(f.content);
    ta.addEventListener("input", function () { f.content = ta.value; g.textContent = lineGutter(ta.value); renderTabs(); });
    ta.addEventListener("scroll", function () { g.scrollTop = ta.scrollTop; });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Tab") { e.preventDefault(); var s = ta.selectionStart; ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(ta.selectionEnd); ta.selectionStart = ta.selectionEnd = s + 2; ta.dispatchEvent(new Event("input")); }
    });
    ta.focus();
  }

  function save() {
    syncCurrent();
    var tab = S.tabs.find(function (t) { return t.key === S.active; });
    if (!tab || tab.type !== "file") return;
    var f = fileOf(tab.path);
    if (!f || f.kind !== "text" || f.content === f.orig) return;
    call("fs/write", { path: tab.path, content: f.content, eol: f.eol, bom: f.bom, expectMtime: f.mtime }).then(function (r) {
      f.orig = f.content; f.mtime = r.mtime;
      toast("已保存 " + tab.path);
      renderTabs(); refreshGit();
    }).catch(fail);
  }
  document.addEventListener("keydown", function (e) { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } });

  // ───────── 搜索 ─────────

  function doSearch() {
    var q = $("sq").value.trim(); if (!q) return;
    var text = $("smode").value === "text";
    $("sres").innerHTML = '<div class="dbx-hint" style="padding:6px 10px">搜索中…</div>';
    call(text ? "fs/grep" : "fs/find", { query: q }).then(function (r) {
      var h = r.hits.map(function (x) {
        return text ? '<div class="hit" data-p="' + esc(x.path) + '"><div class="p">' + esc(x.path) + ":" + x.line + '</div><div class="t">' + esc(x.text) + "</div></div>" : '<div class="hit" data-p="' + esc(x) + '"><div class="p">' + esc(x) + "</div></div>";
      }).join("");
      $("sres").innerHTML = (h || '<div class="dbx-hint" style="padding:6px 10px">没有结果。</div>') + (r.truncated ? '<div class="dbx-hint" style="padding:6px 10px">结果太多，只显示一部分，请换更具体的关键词。</div>' : "");
    }).catch(function (e) { $("sres").innerHTML = '<div class="warn" style="padding:6px 10px">' + esc(e.message || e) + "</div>"; });
  }
  $("sq").addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(); });
  $("sres").addEventListener("click", function (e) { var el = e.target.closest && e.target.closest(".hit"); if (el) openFile(el.getAttribute("data-p")); });

  // ───────── Git ─────────

  function refreshGit() {
    return call("git/status").then(function (g) { S.git = g; renderGit(); }).catch(function (e) { S.git = { isRepo: false, files: [], error: e.message }; renderGit(); });
  }

  function gitFile(f, staged) {
    var code = staged ? f.x : f.untracked ? "U" : f.y;
    return '<div class="gf' + (S.active === "d:" + (staged ? "s:" : "w:") + f.path ? " on" : "") + '" data-p="' + esc(f.path) + '" data-s="' + (staged ? 1 : 0) + '"><span class="st st-' + esc(code) + '">' + esc(code) + '</span><span class="nm" title="' + esc(f.path) + '">' + esc(f.from ? f.from + " → " + f.path : f.path) + '</span><button data-act="' + (staged ? "unstage" : "stage") + '" title="' + (staged ? "取消暂存" : "暂存") + '">' + (staged ? "−" : "+") + "</button></div>";
  }

  function renderGit() {
    var g = S.git, box = $("p-git");
    var badge = $("gitcount");
    if (!g || !g.isRepo) { box.innerHTML = '<div class="dbx-hint" style="padding:10px">' + esc(g && g.error ? g.error : "这个目录不是 Git 仓库。") + "</div>"; badge.hidden = true; return; }
    var staged = g.files.filter(function (f) { return f.staged; });
    var changed = g.files.filter(function (f) { return !f.staged && (f.changed || f.untracked); });
    var mixed = g.files.filter(function (f) { return f.staged && f.changed; });
    badge.hidden = !g.files.length; badge.textContent = g.files.length;
    var h = '<div class="gitbar"><b>' + esc(g.branch || "（游离 HEAD）") + "</b>" + (g.upstream ? "<span>→ " + esc(g.upstream) + "</span>" : "") + (g.ahead ? "<span>↑" + g.ahead + "</span>" : "") + (g.behind ? "<span>↓" + g.behind + "</span>" : "") + "</div>";
    if (!g.files.length) h += '<div class="dbx-hint" style="padding:4px 10px">工作区干净，没有改动。</div>';
    if (staged.length) h += '<div class="sec">已暂存的更改（' + staged.length + "）</div>" + staged.map(function (f) { return gitFile(f, true); }).join("");
    var wk = changed.concat(mixed.filter(function (f) { return changed.indexOf(f) < 0; }));
    if (wk.length) h += '<div class="sec">更改（' + wk.length + "）</div>" + wk.map(function (f) { return gitFile(f, false); }).join("");
    h += '<div class="sec">最近提交</div><div id="glog"><span class="dbx-hint" style="padding:0 10px">加载中…</span></div>';
    box.innerHTML = h;
    call("git/log", { limit: 25 }).then(function (rows) {
      var el = $("glog"); if (!el) return;
      el.innerHTML = rows.length ? rows.map(function (r) { return '<div class="log"><span class="h">' + esc(r.hash) + "</span>" + esc(r.subject) + ' <span class="d">· ' + esc(r.author) + " · " + esc(r.date) + "</span></div>"; }).join("") : '<span class="dbx-hint" style="padding:0 10px">还没有提交。</span>';
    }).catch(function () {});
  }

  $("p-git").addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest(".gf");
    if (!el) return;
    var p = el.getAttribute("data-p"), staged = el.getAttribute("data-s") === "1";
    var act = e.target.getAttribute && e.target.getAttribute("data-act");
    if (act) { call("git/" + act, { paths: [p] }).then(function (g) { S.git = g; renderGit(); var t = S.tabs.find(function (x) { return x.path === p && x.type === "diff"; }); if (t) renderEditor(); }).catch(fail); return; }
    addTab({ key: "d:" + (staged ? "s:" : "w:") + p, type: "diff", path: p, staged: staged });
  });

  api.ready.then(loadWs);
})();
