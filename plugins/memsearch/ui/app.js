(function () {
  "use strict";
  var api = window.dbxPlugin;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var call = function (m, p) { return api.invoke(m, p || {}, { timeoutMs: 60000 }); };
  var RULE = "回答有历史背景的问题、或开始一个新任务前，先用 memory_search 查一下相关记忆（用关键词）。\n任务结束时，如果产生了以后还会用到的结论、决定或用户偏好，用 memory_add 记一条（标题一句话，只记事实，不记流水账）。";

  function tab(t) {
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (b) { b.classList.toggle("on", b.getAttribute("data-t") === t); });
    ["search", "add", "sources", "ai"].forEach(function (n) { $("t-" + n).hidden = n !== t; });
    if (t === "sources") loadSources();
  }
  $("tabs").addEventListener("click", function (e) { var t = e.target && e.target.getAttribute && e.target.getAttribute("data-t"); if (t) tab(t); });

  function hit(h) {
    var meta = h.kind === "memory" ? "记忆 · " + esc(h.date) + " " + esc(h.time) : "笔记 · " + esc(h.source);
    return '<div class="hit"><div class="h"><span class="t">' + esc(h.title || (h.kind === "memory" ? "（无标题）" : h.source)) + '</span><span class="s">' + meta + (h.score ? " · 相关度 " + h.score : "") + "</span>" +
      (h.tags && h.tags.length ? '<span class="tg">' + h.tags.map(function (t) { return '<span class="dbx-badge">' + esc(t) + "</span>"; }).join(" ") + "</span>" : "") + "</div>" +
      '<div class="x">' + esc(h.full ? h.full.slice(0, 600) : h.text) + "</div>" +
      (h.kind === "memory" ? '<div class="act"><button class="dbx-btn dbx-btn--danger dbx-btn--ghost" data-del="' + esc(h.id) + '">删除</button></div>' : "") + "</div>";
  }

  function run() {
    var q = $("q").value.trim();
    $("results").innerHTML = '<div class="dbx-hint">查找中…</div>';
    var p = q ? call("memory/search", { query: q, limit: 20, kind: $("kind").value }) : call("memory/recent", { limit: 20 });
    p.then(function (rs) {
      $("results").innerHTML = rs.length ? rs.map(hit).join("") : '<div class="dbx-hint">' + (q ? "没有找到相关内容。" : "还没有记忆。到「记一条」里添加，或者让 AI 用 memory_add 记。") + "</div>";
    }).catch(function (e) { $("results").innerHTML = '<div class="warn">' + esc(e.message || e) + "</div>"; });
  }
  $("go").addEventListener("click", run);
  $("q").addEventListener("keydown", function (e) { if (e.key === "Enter") run(); });
  $("results").addEventListener("click", function (e) {
    var id = e.target && e.target.getAttribute && e.target.getAttribute("data-del");
    if (!id) return;
    // 沙箱里没有 confirm：第一次点变成「再点一次确认」
    if (e.target.getAttribute("data-sure") !== "1") { e.target.setAttribute("data-sure", "1"); e.target.textContent = "再点一次确认删除"; return; }
    call("memory/delete", { id: id }).then(function () { run(); refreshStat(); });
  });

  $("a-save").addEventListener("click", function () {
    var text = $("a-text").value.trim();
    if (!text) { $("a-msg").textContent = "内容不能为空"; return; }
    call("memory/add", { text: text, title: $("a-title").value, tags: $("a-tags").value }).then(function (r) {
      $("a-msg").textContent = "已保存（" + r.date + "）";
      $("a-text").value = ""; $("a-title").value = ""; $("a-tags").value = "";
      refreshStat();
    }).catch(function (e) { $("a-msg").textContent = e.message || String(e); });
  });

  function loadSources() {
    call("memory/stats").then(function (s) {
      $("s-list").innerHTML = s.sources.length ? s.sources.map(function (x) {
        return '<div class="src"><span title="' + esc(x.path) + '">' + (x.exists ? "" : '<b class="warn">[不存在] </b>') + esc(x.path) + '</span><button class="dbx-btn dbx-btn--ghost" data-rm="' + esc(x.path) + '">移除</button></div>';
      }).join("") : '<div class="dbx-hint">还没有挂载笔记目录。</div>';
      $("s-dir").textContent = "已索引笔记 " + s.noteFiles + " 个文件、" + s.notes + " 段。记忆文件存放在：" + s.dir;
    });
  }
  $("s-add").addEventListener("click", function () {
    $("s-err").textContent = "";
    call("sources/add", { path: $("s-path").value.trim() }).then(function () { $("s-path").value = ""; loadSources(); refreshStat(); }).catch(function (e) { $("s-err").textContent = e.message || String(e); });
  });
  $("s-list").addEventListener("click", function (e) {
    var p = e.target && e.target.getAttribute && e.target.getAttribute("data-rm");
    if (p) call("sources/remove", { path: p }).then(function () { loadSources(); refreshStat(); });
  });

  $("rule").value = RULE;
  $("rule-sel").addEventListener("click", function () { $("rule").focus(); $("rule").select(); });

  function refreshStat() {
    call("memory/stats").then(function (s) { $("stat").textContent = s.memories + " 条记忆" + (s.notes ? " · " + s.notes + " 段笔记" : ""); }).catch(function () {});
  }
  api.ready.then(function () { refreshStat(); run(); });
})();
