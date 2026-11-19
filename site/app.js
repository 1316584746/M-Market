(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var safeUrl = function (u) { return /^https?:\/\//i.test(u || "") ? u : ""; };
  var PAGE = 36;
  var all = [];
  var page = 1;

  function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); }

  function filtered() {
    var terms = $("q").value.toLowerCase().split(/\s+/).filter(Boolean);
    var kind = $("kind").value, cat = $("cat").value, sort = $("sort").value;
    var items = all.filter(function (x) {
      if (kind && x.kind !== kind) return false;
      if (cat && x.category !== cat) return false;
      if (!terms.length) return true;
      var hay = (x.name + "\n" + x.id + "\n" + x.description + "\n" + (x.author || "") + "\n" + (x.category || "") + "\n" + (x.tags || []).join(" ")).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });
    var byName = function (a, b) { return a.name.localeCompare(b.name, "zh-CN"); };
    if (sort === "name") items.sort(byName);
    else if (sort === "updated") items.sort(function (a, b) { return (b.updated || "").localeCompare(a.updated || "") || byName(a, b); });
    else items.sort(function (a, b) { return (b.official ? 1 : 0) - (a.official ? 1 : 0) || (b.stars == null ? -1 : b.stars) - (a.stars == null ? -1 : a.stars) || byName(a, b); });
    return items;
  }

  function card(x) {
    var links = "";
    if (x.download) links += '<a href="' + esc(x.download) + '">下载安装包</a>';
    if (safeUrl(x.repo)) links += '<a href="' + esc(x.repo) + '" rel="noopener">仓库</a>';
    if (safeUrl(x.homepage) && x.homepage !== x.repo) links += '<a href="' + esc(x.homepage) + '" rel="noopener">主页</a>';
    var meta = [x.author, x.version && "v" + x.version, x.stars != null && "★ " + fmt(x.stars), x.updated].filter(Boolean).map(esc).join(" · ");
    return '<article class="card"><h3 title="' + esc(x.name) + '">' + esc(x.name) + '</h3><div class="meta">' + meta + "</div><p>" + esc(x.description || "（没有简介）") + "</p><div>" +
      '<span class="tag kind">' + (x.kind === "dbx" ? "DBX" : "DSH") + "</span>" + (x.official ? '<span class="tag">官方</span>' : "") + (x.category ? '<span class="tag">' + esc(x.category) + "</span>" : "") +
      (x.tags || []).slice(0, 4).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") + '</div><div class="links">' + links + "</div></article>";
  }

  function render() {
    var items = filtered();
    var pages = Math.max(1, Math.ceil(items.length / PAGE));
    page = Math.min(page, pages);
    var slice = items.slice((page - 1) * PAGE, page * PAGE);
    $("grid").innerHTML = slice.length ? slice.map(card).join("") : '<div class="empty">没有符合条件的插件</div>';
    $("pager").innerHTML = pages > 1 ? '<button id="prev"' + (page <= 1 ? " disabled" : "") + '>上一页</button><span class="hint">第 ' + page + " / " + pages + " 页，共 " + items.length + ' 个</span><button id="next"' + (page >= pages ? " disabled" : "") + ">下一页</button>" : '<span class="hint">共 ' + items.length + " 个</span>";
    if ($("prev")) $("prev").onclick = function () { page--; render(); scrollTo(0, 0); };
    if ($("next")) $("next").onclick = function () { page++; render(); scrollTo(0, 0); };
  }

  ["kind", "cat", "sort"].forEach(function (id) { $(id).addEventListener("change", function () { page = 1; render(); }); });
  var t;
  $("q").addEventListener("input", function () { clearTimeout(t); t = setTimeout(function () { page = 1; render(); }, 200); });

  fetch("catalog.json").then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then(function (d) {
    all = d.plugins;
    var cats = {};
    all.forEach(function (x) { if (x.category) cats[x.category] = (cats[x.category] || 0) + 1; });
    Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; }).forEach(function (c) {
      var o = document.createElement("option"); o.value = c; o.textContent = c + "（" + cats[c] + "）"; $("cat").appendChild(o);
    });
    $("meta").textContent = "共收录 " + all.length + " 个插件（官方 " + all.filter(function (x) { return x.official; }).length + " 个）";
    $("updated").textContent = d.generatedAt ? "目录生成于 " + d.generatedAt.slice(0, 10) + "。" : "";
    render();
  }).catch(function (e) {
    $("meta").textContent = "目录加载失败：" + e.message;
  });
})();
