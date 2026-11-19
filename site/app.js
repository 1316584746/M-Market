(function () {
  "use strict";
  var S = window.SITE;
  var T = S.t;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var fill = function (tpl, o) { return tpl.replace(/\{(\w+)\}/g, function (_, k) { return o[k]; }); };
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
    var byName = function (a, b) { return a.name.localeCompare(b.name, S.lang === "en" ? "en" : "zh-CN"); };
    if (sort === "name") items.sort(byName);
    else if (sort === "updated") items.sort(function (a, b) { return (b.updated || "").localeCompare(a.updated || "") || byName(a, b); });
    else items.sort(function (a, b) { return (b.official ? 1 : 0) - (a.official ? 1 : 0) || (b.stars == null ? -1 : b.stars) - (a.stars == null ? -1 : a.stars) || byName(a, b); });
    return items;
  }

  function card(x) {
    var meta = [x.author, x.version && "v" + x.version, x.stars != null && "★ " + fmt(x.stars), x.updated].filter(Boolean).map(esc).join(" · ");
    var letter = esc((x.name || "?").trim().charAt(0).toUpperCase());
    var ico = '<span class="ico">' + (x.icon ? '<img src="' + esc(x.icon) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />' : "") + letter + "</span>";
    return '<article class="card"><a class="cover" href="plugin/' + encodeURIComponent(x.slug) + '.html" aria-label="' + esc(x.name) + '"></a><div class="r1">' + ico + '<div class="t"><h3 title="' + esc(x.name) + '">' + esc(x.name) + '</h3><div class="meta">' + meta + "</div></div></div><p>" + esc(x.description || T.noDesc) + "</p><div>" +
      '<span class="tag kind">' + (x.kind === "dbx" ? "DBX" : T.community) + "</span>" + (x.official ? '<span class="tag">' + esc(T.official) + "</span>" : "") + (x.category ? '<span class="tag">' + esc(x.category) + "</span>" : "") +
      (x.tags || []).slice(0, 3).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") + "</div></article>";
  }

  function render() {
    var items = filtered();
    var pages = Math.max(1, Math.ceil(items.length / PAGE));
    page = Math.min(page, pages);
    var slice = items.slice((page - 1) * PAGE, page * PAGE);
    $("grid").className = "wrap grid";
    $("grid").innerHTML = slice.length ? slice.map(card).join("") : '<div class="empty">' + esc(T.none) + "</div>";
    $("pager").innerHTML = pages > 1 ? '<button id="prev"' + (page <= 1 ? " disabled" : "") + ">" + esc(T.prev) + '</button><span class="hint">' + esc(fill(T.pageInfo, { p: page, ps: pages, n: items.length })) + '</span><button id="next"' + (page >= pages ? " disabled" : "") + ">" + esc(T.next) + "</button>" : '<span class="hint">' + esc(fill(T.total, { n: items.length })) + "</span>";
    if ($("prev")) $("prev").onclick = function () { page--; render(); scrollTo(0, 0); };
    if ($("next")) $("next").onclick = function () { page++; render(); scrollTo(0, 0); };
  }

  ["kind", "cat", "sort"].forEach(function (id) { $(id).addEventListener("change", function () { page = 1; render(); }); });
  var t;
  $("q").addEventListener("input", function () { clearTimeout(t); t = setTimeout(function () { page = 1; render(); }, 200); });

  fetch(S.data).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then(function (d) {
    all = d.plugins;
    var cats = {};
    all.forEach(function (x) { if (x.category) cats[x.category] = (cats[x.category] || 0) + 1; });
    Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; }).forEach(function (c) {
      var o = document.createElement("option"); o.value = c; o.textContent = c + " (" + cats[c] + ")"; $("cat").appendChild(o);
    });
    $("meta").textContent = fill(T.count, { n: all.length, o: all.filter(function (x) { return x.official; }).length });
    $("updated").textContent = d.generatedAt ? fill(T.generated, { d: d.generatedAt.slice(0, 10) }) : "";
    render();
  }).catch(function (e) {
    $("meta").textContent = T.failed + e.message;
  });
})();
