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
      var name = t.type === "diff" ? "Δ " + base(t.path) + (t.staged ? "（已暂存）" : "") : t.type === "graph" ? "⎇ Git Graph" : t.type === "commit" ? "◆ " + t.path : base(t.path);
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

  // ───────── 语法高亮（不依赖外部库的简易分词） ─────────

  var KW_C = "abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|defer|delete|do|else|enum|export|extends|false|final|finally|fn|for|from|func|function|go|if|implements|import|in|instanceof|interface|let|match|mod|namespace|new|nil|null|override|package|private|protected|pub|public|return|self|static|struct|super|switch|this|throw|throws|true|try|type|typeof|undefined|use|using|var|void|volatile|while|with|yield|int|long|string|bool|boolean|char|float|double|byte|short|unsigned|signed|impl|trait|where|mut|ref|crate|extern|inline|sizeof|typedef|template|typename|virtual|operator|friend|readonly|declare|of|is|out|when|object|val|fun|lateinit|sealed|data|companion";
  var KW_HASH = "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|self|True|try|while|with|yield|fi|then|do|done|esac|function|local|echo|export|unset|end|begin|module|require|puts|unless|until|elsif|rescue|ensure|defined|true|false|null";
  var KW_SQL = "select|from|where|and|or|not|insert|into|values|update|set|delete|create|table|alter|drop|index|view|join|left|right|inner|outer|full|on|as|group|by|order|having|limit|offset|union|all|distinct|null|is|in|like|between|exists|case|when|then|else|end|primary|key|foreign|references|default|constraint|unique|count|sum|avg|min|max|desc|asc|database|if|begin|commit|rollback|with|over|partition";
  var STR_DQ = '"(?:\\\\.|[^"\\\\\\n])*"?';
  var STR_SQ = "'(?:\\\\.|[^'\\\\\\n])*'?";
  var HL = {};
  function mkHl(parts, flags) {
    return { re: new RegExp(parts.map(function (p) { return "(" + p[1] + ")"; }).join("|"), flags || "g"), cls: parts.map(function (p) { return p[0]; }) };
  }
  HL.c = mkHl([["cm", "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)"], ["str", STR_DQ + "|" + STR_SQ + "|`(?:\\\\.|[^`\\\\])*`?"], ["num", "\\b\\d[\\w.]*\\b"], ["kw", "\\b(?:" + KW_C + ")\\b"]]);
  HL.hash = mkHl([["cm", "#[^\\n]*"], ["str", '"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$)|' + STR_DQ + "|" + STR_SQ], ["num", "\\b\\d[\\w.]*\\b"], ["kw", "\\b(?:" + KW_HASH + ")\\b"]]);
  HL.sql = mkHl([["cm", "--[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)"], ["str", "'(?:''|[^'])*'?"], ["num", "\\b\\d[\\w.]*\\b"], ["kw", "\\b(?:" + KW_SQL + ")\\b"]], "gi");
  HL.markup = mkHl([["cm", "<!--[\\s\\S]*?(?:-->|$)"], ["str", '"[^"\\n]*"?|\'[^\'\\n]*\'?'], ["kw", "<\\/?[A-Za-z][\\w:.-]*"]]);
  HL.json = mkHl([["key", '"(?:\\\\.|[^"\\\\\\n])*"(?=\\s*:)'], ["str", STR_DQ], ["num", "-?\\b\\d[\\d.eE+-]*\\b"], ["kw", "\\b(?:true|false|null)\\b"]]);
  HL.css = mkHl([["cm", "\\/\\*[\\s\\S]*?(?:\\*\\/|$)"], ["str", STR_DQ + "|" + STR_SQ], ["num", "#[0-9a-fA-F]{3,8}\\b|\\b\\d[\\d.]*(?:px|em|rem|%|vh|vw|s|ms|deg)?"], ["kw", "@[\\w-]+"], ["key", "[\\w-]+(?=\\s*:)"]]);
  var EXT_FAM = {
    js: "c", mjs: "c", cjs: "c", jsx: "c", ts: "c", tsx: "c", java: "c", c: "c", h: "c", cpp: "c", hpp: "c", cc: "c", cs: "c", go: "c", rs: "c", kt: "c", swift: "c", scala: "c", dart: "c", php: "c",
    py: "hash", sh: "hash", bash: "hash", zsh: "hash", rb: "hash", yml: "hash", yaml: "hash", toml: "hash", ini: "hash", conf: "hash", properties: "hash", env: "hash", r: "hash", pl: "hash", ps1: "hash", gitignore: "hash", dockerfile: "hash",
    sql: "sql", html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", xhtml: "markup",
    json: "json", jsonc: "json", json5: "json", css: "css", scss: "css", less: "css"
  };
  var HL_MAX = 300 * 1024;
  function langOf(p) {
    var n = base(p).toLowerCase();
    if (n === "dockerfile" || n === "makefile") return "hash";
    var i = n.lastIndexOf(".");
    return i >= 0 ? EXT_FAM[n.slice(i + 1)] || null : null;
  }
  function hlHtml(text, fam) {
    var h = HL[fam], out = "", last = 0, m;
    h.re.lastIndex = 0;
    while ((m = h.re.exec(text))) {
      if (m[0] === "") { h.re.lastIndex++; continue; }
      out += esc(text.slice(last, m.index));
      var k = 1; while (k < m.length && m[k] === undefined) k++;
      out += '<span class="tk-' + h.cls[k - 1] + '">' + esc(m[0]) + "</span>";
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last)) + "\n\n";
  }

  // ───────── Markdown 预览（先转义再加标签，链接只放行 http / https / mailto） ─────────

  function mdInline(s) {
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, function (_, a) { return "🖼 " + a; });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, function (_, t, u) {
      return /^(https?:\/\/|mailto:)/i.test(u.replace(/&amp;/g, "&")) ? '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + "</a>" : t + " (" + u + ")";
    });
    s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, function (_, a, b) { return "<strong>" + (a || b) + "</strong>"; });
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return "<code>" + esc(codes[i]) + "</code>"; });
  }
  function mdList(items) {
    var html = "", stack = [];
    items.forEach(function (it) {
      while (stack.length && it.indent < stack[stack.length - 1].indent) html += "</li></" + stack.pop().tag + ">";
      var top = stack[stack.length - 1];
      if (!top || it.indent > top.indent) { var tag = it.ordered ? "ol" : "ul"; html += "<" + tag + "><li>"; stack.push({ indent: it.indent, tag: tag }); }
      else html += "</li><li>";
      html += mdInline(it.text).replace(/^\[ \]\s*/, "☐ ").replace(/^\[[xX]\]\s*/, "☑ ");
    });
    while (stack.length) html += "</li></" + stack.pop().tag + ">";
    return html;
  }
  var MD_LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  var MD_ROW = function (l) { return l.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); }); };
  function mdHtml(src) {
    var lines = String(src).replace(/\r\n/g, "\n").split("\n"), out = [], i = 0, m;
    var blockStart = function (l) { return /^\s*(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || MD_LI.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l); };
    while (i < lines.length) {
      var l = lines[i];
      if ((m = /^\s*(```|~~~)/.exec(l))) {
        var buf = []; i++;
        while (i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre class="mdcode"><code>' + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }
      if (!l.trim()) { i++; continue; }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) { out.push("<h" + m[1].length + ">" + mdInline(m[2]) + "</h" + m[1].length + ">"); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
      if (/^\s*>/.test(l)) {
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push("<blockquote>" + mdHtml(q.join("\n")) + "</blockquote>");
        continue;
      }
      if (l.indexOf("|") >= 0 && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        var head = MD_ROW(l), rows = []; i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0) { rows.push(MD_ROW(lines[i])); i++; }
        out.push("<table><thead><tr>" + head.map(function (c) { return "<th>" + mdInline(c) + "</th>"; }).join("") + "</tr></thead><tbody>" + rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + mdInline(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table>");
        continue;
      }
      if (MD_LI.test(l)) {
        var items = [];
        while (i < lines.length && lines[i].trim()) {
          var mm = MD_LI.exec(lines[i]);
          if (mm) items.push({ indent: mm[1].replace(/\t/g, "    ").length, ordered: /\d/.test(mm[2]), text: mm[3] });
          else if (/^\s+\S/.test(lines[i]) && items.length) items[items.length - 1].text += " " + lines[i].trim();
          else break;
          i++;
        }
        out.push(mdList(items));
        continue;
      }
      var para = [l]; i++;
      while (i < lines.length && lines[i].trim() && !blockStart(lines[i])) { para.push(lines[i]); i++; }
      out.push("<p>" + para.map(function (x) { return mdInline(x.replace(/\s+$/, "")); }).join(" ") + "</p>");
    }
    return out.join("\n");
  }

  var isMd = function (p) { return /\.(md|markdown|mdx)$/i.test(p); };

  function renderEditor() {
    var box = $("editor");
    var tab = S.tabs.find(function (t) { return t.key === S.active; });
    if (!tab) { box.innerHTML = '<div class="empty dbx-hint">从左侧打开一个文件，或在 Git 里点一个改动看 diff / 打开 Git Graph。</div>'; return; }
    if (tab.type === "graph") return renderGraph(tab);
    if (tab.type === "commit") return renderCommit(tab);
    if (tab.type === "diff") {
      box.innerHTML = '<div class="ebody"><pre class="diff"><div class="meta">加载中…</div></pre></div>';
      call("git/diff", { path: tab.path, staged: !!tab.staged }).then(function (r) {
        if (S.active !== tab.key) return;
        box.innerHTML = '<div class="ebody"><pre class="diff">' + diffHtml(r.text) + "</pre></div>";
      }).catch(fail);
      return;
    }
    var f = fileOf(tab.path);
    if (!f) return;
    if (f.kind !== "text") { box.innerHTML = '<div class="empty dbx-hint">' + (f.kind === "binary" ? "这是二进制文件，不能在这里查看。" : "文件太大（" + sizeText(f.size) + "），超过 2 MB，不在这里打开。") + "</div>"; return; }
    var md = isMd(tab.path), mode = md ? f.mode || "edit" : "edit";
    var fam = f.content.length <= HL_MAX ? langOf(tab.path) : null;
    var bar = md ? '<div class="etools"><span class="dbx-hint">Markdown</span>' + [["edit", "编辑"], ["split", "分栏"], ["preview", "预览"]].map(function (x) { return '<button class="dbx-btn dbx-btn--ghost' + (mode === x[0] ? " on" : "") + '" data-m="' + x[0] + '">' + x[1] + "</button>"; }).join("") + "</div>" : "";
    box.innerHTML = bar + '<div class="ebody">' +
      (mode !== "preview" ? '<div class="gutter"></div><div class="cwrap' + (fam ? " hlon" : "") + '"><pre class="hl" aria-hidden="true"></pre><textarea class="code" spellcheck="false" wrap="off"></textarea></div>' : "") +
      (mode !== "edit" ? '<div class="md"></div>' : "") + "</div>";
    var mdEl = box.querySelector(".md"), mdTimer = null;
    var drawMd = function () { if (mdEl) mdEl.innerHTML = mdHtml(f.content); };
    drawMd();
    Array.prototype.forEach.call(box.querySelectorAll(".etools [data-m]"), function (b) {
      b.addEventListener("click", function () { syncCurrent(); f.mode = b.getAttribute("data-m"); renderEditor(); });
    });
    var ta = box.querySelector("textarea"), g = box.querySelector(".gutter"), hl = box.querySelector(".hl");
    if (!ta) return;
    var raf = 0;
    var paint = function () { raf = 0; if (fam && f.content.length <= HL_MAX) hl.innerHTML = hlHtml(ta.value, fam); };
    ta.value = f.content; g.textContent = lineGutter(f.content);
    if (fam) paint();
    ta.addEventListener("input", function () {
      f.content = ta.value; g.textContent = lineGutter(ta.value); renderTabs();
      if (fam && !raf) raf = requestAnimationFrame(paint);
      if (mdEl) { clearTimeout(mdTimer); mdTimer = setTimeout(drawMd, 150); }
    });
    ta.addEventListener("scroll", function () { g.scrollTop = ta.scrollTop; if (hl) { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; } });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Tab") { e.preventDefault(); var s = ta.selectionStart; ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(ta.selectionEnd); ta.selectionStart = ta.selectionEnd = s + 2; ta.dispatchEvent(new Event("input")); }
    });
    ta.focus();
  }

  function diffHtml(text) {
    return String(text).split("\n").map(function (l) {
      var c = /^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename)/.test(l) ? "meta" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : l[0] === "@" ? "hunk" : "";
      return '<div class="' + c + '">' + esc(l) + "</div>";
    }).join("");
  }

  // ───────── Git Graph ─────────

  var LANE_COLORS = ["#3b82f6", "#ef4444", "#16a34a", "#d97706", "#8b5cf6", "#0891b2", "#db2777", "#65a30d"];
  var ROW_H = 28, LANE_W = 16;

  /** 提交按「子在前、父在后」排好；每个提交占一列，往父提交拉线。返回每行画线需要的信息 */
  function graphLayout(commits) {
    var lanes = [], rows = [], max = 0;
    var free = function () { var i = lanes.indexOf(null); if (i < 0) i = lanes.length; return i; };
    commits.forEach(function (c) {
      var before = lanes.slice(), into = [];
      lanes.forEach(function (h, i) { if (h === c.hash) into.push(i); });
      var col = into.length ? into[0] : free();
      lanes[col] = null;
      into.forEach(function (i) { lanes[i] = null; });
      var pass = [];
      before.forEach(function (h, i) { if (h && into.indexOf(i) < 0) pass.push(i); });
      var down = [];
      c.parents.forEach(function (p, k) {
        var li = lanes.indexOf(p);
        if (li < 0) { li = k === 0 ? col : free(); lanes[li] = p; }
        down.push(li);
      });
      rows.push({ c: c, col: col, into: into, pass: pass, down: down });
      var used = lanes.reduce(function (a, h, i) { return h ? i : a; }, -1);
      max = Math.max(max, col, used, before.reduce(function (a, h, i) { return h ? i : a; }, -1));
    });
    return { rows: rows, width: max + 1 };
  }

  function graphSvg(r, width) {
    var x = function (i) { return 8 + i * LANE_W; }, mid = ROW_H / 2, h = "";
    var color = function (i) { return LANE_COLORS[i % LANE_COLORS.length]; };
    var curve = function (x1, y1, x2, y2, col) {
      return x1 === x2 ? '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + col + '" stroke-width="2"/>' : '<path d="M' + x1 + " " + y1 + " C" + x1 + " " + (y1 + (y2 - y1) / 2) + " " + x2 + " " + (y1 + (y2 - y1) / 2) + " " + x2 + " " + y2 + '" fill="none" stroke="' + col + '" stroke-width="2"/>';
    };
    r.pass.forEach(function (i) { h += curve(x(i), 0, x(i), ROW_H, color(i)); });
    r.into.forEach(function (i) { h += curve(x(i), 0, x(r.col), mid, color(i)); });
    r.down.forEach(function (i) { h += curve(x(r.col), mid, x(i), ROW_H, color(i)); });
    var merge = r.c.parents.length > 1;
    h += '<circle cx="' + x(r.col) + '" cy="' + mid + '" r="' + (merge ? 4 : 5) + '" fill="' + (merge ? "var(--color-background)" : color(r.col)) + '" stroke="' + color(r.col) + '" stroke-width="2"/>';
    return '<svg width="' + (8 + width * LANE_W) + '" height="' + ROW_H + '">' + h + "</svg>";
  }

  function refChip(ref) {
    var head = /^HEAD -> /.test(ref), tag = /^tag: /.test(ref), name = ref.replace(/^HEAD -> /, "").replace(/^tag: /, "");
    if (ref === "HEAD") return '<span class="ref head">HEAD</span>';
    return '<span class="ref ' + (tag ? "tag" : head ? "head" : /\//.test(name) ? "remote" : "branch") + '">' + esc(name) + "</span>";
  }

  function renderGraph(tab) {
    var box = $("editor");
    box.innerHTML = '<div class="ebody"><div class="graph"><div class="dbx-hint" style="padding:10px">加载中…</div></div></div>';
    call("git/graph", { limit: 300 }).then(function (g) {
      if (S.active !== tab.key) return;
      var el = box.querySelector(".graph");
      if (!g.isRepo) { el.innerHTML = '<div class="dbx-hint" style="padding:10px">这个目录不是 Git 仓库。</div>'; return; }
      if (!g.commits.length) { el.innerHTML = '<div class="dbx-hint" style="padding:10px">还没有提交。</div>'; return; }
      var L = graphLayout(g.commits);
      el.innerHTML = L.rows.map(function (r) {
        var c = r.c;
        return '<div class="grow" data-h="' + esc(c.hash) + '" style="height:' + ROW_H + 'px">' + graphSvg(r, L.width) + '<span class="gsub">' + c.refs.map(refChip).join("") + esc(c.subject) + '</span><span class="gmeta">' + esc(c.short) + " · " + esc(c.author) + " · " + esc(c.date) + "</span></div>";
      }).join("") + '<div class="dbx-hint" style="padding:6px 10px">最多显示最近 300 个提交（所有分支）。点一行看这次提交改了什么。</div>';
    }).catch(fail);
  }

  function renderCommit(tab) {
    var box = $("editor");
    box.innerHTML = '<div class="ebody"><div class="commit"><div class="dbx-hint" style="padding:10px">加载中…</div></div></div>';
    call("git/show", { hash: tab.hash }).then(function (r) {
      if (S.active !== tab.key) return;
      box.querySelector(".commit").innerHTML = '<div class="chead"><div class="ctitle">' + esc(r.message.split("\n")[0]) + '</div><div class="dbx-hint">' + esc(r.hash.slice(0, 12)) + " · " + esc(r.author) + " · " + esc(r.date) + "</div>" +
        (r.message.indexOf("\n") >= 0 ? '<pre class="cmsg">' + esc(r.message.split("\n").slice(1).join("\n").trim()) + "</pre>" : "") + "</div>" +
        '<div class="sec">改动的文件（' + r.files.length + "）</div>" + r.files.map(function (f) { return '<div class="cfile"><span class="st st-' + esc(f.status) + '">' + esc(f.status) + "</span>" + esc(f.from ? f.from + " → " + f.path : f.path) + "</div>"; }).join("") +
        '<pre class="diff">' + diffHtml(r.diff) + "</pre>";
    }).catch(fail);
  }

  $("editor").addEventListener("click", function (e) {
    var row = e.target.closest && e.target.closest(".grow[data-h]");
    if (!row) return;
    var h = row.getAttribute("data-h");
    addTab({ key: "c:" + h, type: "commit", path: h.slice(0, 7), hash: h });
  });

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
    var h = '<div class="gitbar"><b>' + esc(g.branch || "（游离 HEAD）") + "</b>" + (g.upstream ? "<span>→ " + esc(g.upstream) + "</span>" : "") + (g.ahead ? "<span>↑" + g.ahead + "</span>" : "") + (g.behind ? "<span>↓" + g.behind + "</span>" : "") + '<button class="dbx-btn" id="opengraph" style="margin-left:auto">Git Graph</button></div>';
    if (!g.files.length) h += '<div class="dbx-hint" style="padding:4px 10px">工作区干净，没有改动。</div>';
    if (staged.length) h += '<div class="sec">已暂存的更改（' + staged.length + "）</div>" + staged.map(function (f) { return gitFile(f, true); }).join("");
    var wk = changed.concat(mixed.filter(function (f) { return changed.indexOf(f) < 0; }));
    if (wk.length) h += '<div class="sec">更改（' + wk.length + "）</div>" + wk.map(function (f) { return gitFile(f, false); }).join("");
    h += '<div class="sec">最近提交</div><div id="glog"><span class="dbx-hint" style="padding:0 10px">加载中…</span></div>';
    box.innerHTML = h;
    call("git/log", { limit: 25 }).then(function (rows) {
      var el = $("glog"); if (!el) return;
      el.innerHTML = rows.length ? rows.map(function (r) { return '<div class="log" data-h="' + esc(r.hash) + '"><span class="h">' + esc(r.hash) + "</span>" + esc(r.subject) + ' <span class="d">· ' + esc(r.author) + " · " + esc(r.date) + "</span></div>"; }).join("") : '<span class="dbx-hint" style="padding:0 10px">还没有提交。</span>';
    }).catch(function () {});
  }

  $("p-git").addEventListener("click", function (e) {
    if (e.target.id === "opengraph") return addTab({ key: "graph", type: "graph", path: "Git Graph" });
    var lg = e.target.closest && e.target.closest(".log[data-h]");
    if (lg) { var hh = lg.getAttribute("data-h"); return addTab({ key: "c:" + hh, type: "commit", path: hh.slice(0, 7), hash: hh }); }
    var el = e.target.closest && e.target.closest(".gf");
    if (!el) return;
    var p = el.getAttribute("data-p"), staged = el.getAttribute("data-s") === "1";
    var act = e.target.getAttribute && e.target.getAttribute("data-act");
    if (act) { call("git/" + act, { paths: [p] }).then(function (g) { S.git = g; renderGit(); var t = S.tabs.find(function (x) { return x.path === p && x.type === "diff"; }); if (t) renderEditor(); }).catch(fail); return; }
    addTab({ key: "d:" + (staged ? "s:" : "w:") + p, type: "diff", path: p, staged: staged });
  });

  // ───────── 命令面板（没有 PTY：一次一条命令） ─────────

  var T = { job: 0, since: 0, timer: null, hist: [], hi: 0, cwd: "", running: false };
  var shortDir = function (p) { var s = String(p || "").replace(/[\\/]+$/, ""); return s.slice(Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")) + 1) || s; };

  function termPut(text, cls) {
    var out = $("termout");
    var near = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    var s = document.createElement("span");
    if (cls) s.className = cls;
    s.textContent = String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    out.appendChild(s);
    while (out.childNodes.length > 2000) out.removeChild(out.firstChild);
    if (near) out.scrollTop = out.scrollHeight;
  }
  function termState(running) {
    T.running = running;
    $("termstop").disabled = !running;
    $("termline").placeholder = running ? "命令运行中：输入一行会发给它的 stdin" : "输入命令，回车运行（↑ ↓ 翻历史）";
  }
  function termCwd() {
    return call("term/cwd").then(function (r) { T.cwd = r.cwd; $("termcwd").textContent = r.cwd; $("termcwd").title = r.cwd; $("termprompt").textContent = shortDir(r.cwd) + " $"; }).catch(function () {});
  }
  function termPoll() {
    clearTimeout(T.timer);
    var job = T.job;
    call("term/poll", { id: job, since: T.since }).then(function (r) {
      if (job !== T.job) return;
      if (r.text) termPut(r.text);
      T.since = r.next;
      if (r.done) {
        termPut("[" + (r.signal ? "被终止（" + r.signal + "）" : "退出码 " + r.code) + " · " + (r.ms / 1000).toFixed(1) + " 秒]\n", r.code === 0 ? "t-ok" : "t-bad");
        T.job = 0; termState(false); termCwd();
      } else T.timer = setTimeout(termPoll, 250);
    }).catch(function (e) { termPut(String(e.message || e) + "\n", "t-bad"); T.job = 0; termState(false); });
  }
  function termRun(line) {
    if (T.running) {
      termPut(line + "\n", "t-in");
      return call("term/input", { id: T.job, line: line }).catch(fail);
    }
    if (!line.trim()) return;
    T.hist.push(line); T.hi = T.hist.length;
    termPut(shortDir(T.cwd) + " $ " + line + "\n", "t-cmd");
    return call("term/start", { command: line }).then(function (r) {
      if (r.cd) { T.cwd = r.cwd; termCwd(); return; }
      T.job = r.id; T.since = 0; termState(true); termPoll();
    }).catch(function (e) { termPut(String(e.message || e) + "\n", "t-bad"); });
  }
  $("termbtn").addEventListener("click", function () {
    var t = $("term");
    t.hidden = !t.hidden;
    if (!t.hidden) { termCwd(); $("termline").focus(); }
  });
  $("termclose").addEventListener("click", function () { $("term").hidden = true; });
  $("termclear").addEventListener("click", function () { $("termout").textContent = ""; });
  $("termstop").addEventListener("click", function () { if (T.job) call("term/kill", { id: T.job }).catch(fail); });
  $("termline").addEventListener("keydown", function (e) {
    var el = $("termline");
    if (e.key === "Enter") { var v = el.value; el.value = ""; termRun(v); }
    else if (e.key === "ArrowUp" && T.hist.length) { e.preventDefault(); T.hi = Math.max(0, T.hi - 1); el.value = T.hist[T.hi] || ""; }
    else if (e.key === "ArrowDown" && T.hist.length) { e.preventDefault(); T.hi = Math.min(T.hist.length, T.hi + 1); el.value = T.hist[T.hi] || ""; }
  });

  api.ready.then(loadWs);
})();
