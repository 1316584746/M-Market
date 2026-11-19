(function () {
  "use strict";
  const api = window.dbxPlugin;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const call = (m, p, t) => api.invoke(m, p || {}, { timeoutMs: t || 120000 });

  const IC = {
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
    mark: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
    dots: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>',
    gh: '<svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  };
  $("ico-search").innerHTML = IC.search;

  // 这些偏好存在浏览器存储里；沙箱不让用时退回内存，只是不跨次记住
  const memPref = {};
  const pref = {
    get(k) { try { return localStorage.getItem("market." + k); } catch { return memPref[k] == null ? null : memPref[k]; } },
    set(k, v) { try { localStorage.setItem("market." + k, v); } catch { memPref[k] = v; } },
  };

  const S = { tab: "discover", q: "", kind: "", sort: "", source: "", category: "", tag: "", group: "", sub: "installed", page: 1, items: [], data: null, total: null };

  // ───────── 小组件 ─────────
  let toastTimer;
  function toast(msg, isErr) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2800);
  }
  const fail = e => toast(e && e.message ? e.message : String(e), true);

  function openDialog(html, wide) {
    $("dlg").className = "dlg" + (wide ? " wide" : "");
    $("dlg").innerHTML = html;
    $("modal").hidden = false;
    return $("dlg");
  }
  function closeDialog() { $("modal").hidden = true; $("dlg").innerHTML = ""; }
  $("modal").addEventListener("mousedown", e => { if (e.target === $("modal")) closeDialog(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { closeDialog(); closeMenu(); } });
  const btn = (cls, label, attrs) => '<button class="pill ' + cls + '" ' + (attrs || "") + ">" + label + "</button>";
  const foot = inner => '<div class="foot2">' + inner + "</div>";

  const fmtStars = n => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
  const letterOf = x => esc((x.name || "?").trim().charAt(0).toUpperCase());
  const icoOf = (x, sm) => '<div class="ico' + (sm ? " sm" : "") + '">' + (x.icon ? '<img src="' + esc(x.icon) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()" />' : "") + letterOf(x) + "</div>";

  // ───────── 加载列表 ─────────
  let loadSeq = 0;
  function params(more) {
    const p = { q: S.q, kind: S.kind, sort: S.sort, source: S.source, category: S.category, tag: S.tag, pageSize: 30, page: S.page };
    if (S.tab === "themes") p.theme = true;
    if (S.tab === "favorites") p.view = "favorites";
    if (S.tab === "hidden") p.view = "hidden";
    if (S.tab === "installed") { p.view = S.sub === "updates" ? "updates" : "installed"; p.group = S.group; }
    return Object.assign(p, more);
  }
  function load(opts) {
    const append = !!(opts && opts.append);
    const seq = ++loadSeq;
    if (!append) S.page = 1;
    const p = params({ page: append ? S.page + 1 : 1, refresh: !!(opts && opts.refresh) });
    return call("market/list", p, 180000).then(r => {
      if (seq !== loadSeq) return;
      S.data = r;
      S.page = r.page;
      S.items = append ? S.items.concat(r.items) : r.items;
      if (S.tab === "discover" && !S.q && !S.category && !S.kind && !S.source) S.total = r.total;
      render();
    }).catch(e => {
      if (seq !== loadSeq) return;
      $("grid").innerHTML = '<div class="pad warn">' + esc(e.message || e) + "</div>";
    });
  }

  function render() {
    const d = S.data;
    $("notice").innerHTML = d.errors.map(e => '<div class="banner err">来源「' + esc(e.source) + "」：" + esc(e.error) + "</div>").join("");
    $("sub").textContent = "发现社区为 M-Harness 打造的能力" + (S.total != null ? " · " + S.total : "");
    // 标签页上的数量
    const ti = document.querySelector('[data-tab="installed"]');
    ti.innerHTML = "已安装" + (d.counts.installed ? ' <span class="n">(' + d.counts.installed + ")</span>" : "");
    const tf = document.querySelector('[data-tab="favorites"]');
    tf.innerHTML = "收藏" + (d.counts.favorites ? ' <span class="n">(' + d.counts.favorites + ")</span>" : "");
    const th = document.querySelector('[data-tab="hidden"]');
    th.innerHTML = "已屏蔽" + (d.counts.hidden ? ' <span class="n">(' + d.counts.hidden + ")</span>" : "");
    // 来源下拉
    const sel = $("source");
    const keep = S.source;
    sel.innerHTML = '<option value="">全部</option>' + d.sources.filter(s => s.enabled).map(s => '<option value="' + esc(s.id) + '">' + esc(s.name) + "（" + s.count + "）</option>").join("");
    sel.value = keep;
    renderSub();
    renderCaps();
    renderRecent();
    const empty = S.q || S.category || S.tag || S.group || S.source || S.kind
      ? "没有符合条件的插件"
      : S.tab === "favorites" ? "还没有收藏：在插件卡片上点书签图标"
      : S.tab === "hidden" ? "没有屏蔽任何插件：在卡片的「···」菜单里可以屏蔽不想再看到的插件"
      : S.tab === "installed" ? (S.sub === "updates" ? "没有可更新的插件" : "还没有安装任何插件")
      : S.tab === "themes" ? "目录里没有识别为主题的插件"
      : "目录是空的：到「备份与来源」里检查来源";
    $("grid").innerHTML = S.items.length ? S.items.map(card).join("") : '<div class="hint pad">' + empty + "</div>";
    $("more").innerHTML = d.page < d.pages
      ? btn("ghost", "加载更多", 'data-act="more"') + '<span class="hint">已显示 ' + S.items.length + " / " + d.total + "</span>"
      : '<span class="hint">共 ' + d.total + " 个</span>";
  }

  function renderSub() {
    const el = $("subtabs");
    if (S.tab !== "installed") { el.hidden = true; return; }
    const d = S.data;
    el.hidden = false;
    let h = '<button class="cap' + (S.sub === "installed" && !S.group ? " on" : "") + '" data-sub="installed">全部已安装</button>';
    h += '<button class="cap' + (S.sub === "updates" ? " on" : "") + '" data-sub="updates">有更新 <span class="c">' + d.counts.updates + "</span></button>";
    d.groups.forEach(g => { h += '<button class="cap' + (S.group === g.name ? " on" : "") + '" data-group="' + esc(g.name) + '">' + esc(g.name) + ' <span class="c">' + g.count + "</span></button>"; });
    h += '<button class="cap add" data-act="newgroup">＋ 新建分组</button>';
    if (d.counts.updates) h += '<button class="ibtn on" data-act="updateall">全部更新（' + d.counts.updates + "）</button>";
    if (S.group) h += '<button class="ibtn" data-act="renamegroup">重命名</button><button class="ibtn warn" data-act="delgroup">删除分组</button>';
    el.innerHTML = h;
  }

  function renderCaps() {
    const d = S.data;
    const el = $("caps");
    if (S.tab === "installed") { el.innerHTML = ""; return; }
    let h = '<button class="cap' + (!S.category ? " on" : "") + '" data-cat="">全部 <span class="c">' + (d.catTotal) + "</span></button>";
    d.categories.forEach(c => { h += '<button class="cap' + (S.category === c.name ? " on" : "") + '" data-cat="' + esc(c.name) + '">' + esc(c.name) + ' <span class="c">' + c.count + "</span></button>"; });
    el.innerHTML = h;
  }

  function renderRecent() {
    const el = $("recent");
    const d = S.data;
    if (S.tab !== "discover" || !d.recent.length) { el.innerHTML = ""; return; }
    const hidden = pref.get("hideRecent") === "1";
    if (hidden) { el.innerHTML = '<div class="recent-h"><span></span><button class="ibtn" data-act="showrecent">显示「最近更新」</button></div>'; return; }
    el.innerHTML = '<div class="recent-h"><span>最近更新</span><button class="ibtn" data-act="hiderecent">隐藏这一块</button></div><div class="strip">' +
      d.recent.map(x => '<div class="rc"><div class="r1">' + icoOf(x, true) + '<span class="nm" title="' + esc(x.name) + '">' + esc(x.name) + "</span>" + action(x, true) + '</div><div class="ds">' + esc(x.description || "（没有简介）") + "</div></div>").join("") + "</div>";
  }

  // 安装类按钮：药丸
  function action(x, small) {
    const u = esc(x.uid);
    const c = small ? " sm" : "";
    if (x.kind === "dbx") {
      if (x.installed) return x.update ? btn("primary" + c, "更新", 'data-act="install" data-uid="' + u + '"') : '<button class="pill done' + c + '" disabled>已安装</button>';
      if (x.installable) return btn("primary" + c, "安装", 'data-act="install" data-uid="' + u + '"');
      return btn("ghost" + c, "详情", 'data-act="detail" data-uid="' + u + '" title="' + esc(x.noInstallReason) + '"');
    }
    return btn("ghost" + c, "详情", 'data-act="detail" data-uid="' + u + '" title="' + esc(x.noInstallReason) + '"');
  }

  function card(x) {
    const u = esc(x.uid);
    const meta = [x.author, x.version && "v" + x.version, x.stars != null && "★ " + fmtStars(x.stars), x.updated].filter(Boolean).map(esc).join(" · ");
    const badges = (x.category ? '<span class="badge">' + esc(x.category) + "</span>" : "") + '<span class="badge kind">' + (x.kind === "dbx" ? "DBX" : "DSH") + "</span>" + x.tags.slice(0, 3).map(t => '<span class="badge">' + esc(t) + "</span>").join("");
    const shots = x.screenshots.length ? '<div class="shots">' + x.screenshots.slice(0, 2).map(s => '<button data-act="detail" data-uid="' + u + '" aria-label="查看截图"><img src="' + esc(s) + '" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.remove()" /></button>').join("") + "</div>" : "";
    return '<article class="card"><div class="r1">' + icoOf(x) + '<div class="t"><div class="name"><span class="nm" title="' + esc(x.name) + '">' + esc(x.name) + "</span>" +
      (x.repo ? '<button class="src" data-act="detail" data-uid="' + u + '" title="源码与链接">' + IC.gh + "</button>" : "") + (x.update ? '<span class="upd">有更新</span>' : "") +
      '</div><div class="meta">' + meta + "</div></div>" + action(x) + "</div>" +
      '<div class="desc" title="' + esc(x.description) + '">' + esc(x.description || "（没有简介）") + "</div>" + shots +
      (x.note ? '<div class="note">📝 ' + esc(x.note) + "</div>" : "") +
      '<div class="badges">' + badges + '</div><div class="foot">' +
      '<button class="ibtn' + (x.favorite ? " on" : "") + '" data-act="fav" data-uid="' + u + '" title="' + (x.favorite ? "取消收藏" : "收藏") + '" aria-label="收藏">' + IC.mark + "</button>" +
      '<button class="ibtn" data-act="comments" data-uid="' + u + '" title="评论 / 讨论">' + IC.chat + " 评论</button>" +
      '<button class="ibtn" data-act="menu" data-uid="' + u + '" title="更多" aria-label="更多">' + IC.dots + "</button></div></article>";
  }

  const find = uid => S.items.concat(S.data ? S.data.recent : []).find(i => i.uid === uid) || null;

  // ───────── ··· 菜单 ─────────
  function closeMenu() { $("menu").hidden = true; }
  function openMenu(x, anchor) {
    const m = $("menu");
    const u = esc(x.uid);
    let h = '<button data-m="detail" data-uid="' + u + '">详情</button><button data-m="group" data-uid="' + u + '">分组' + (x.groups.length ? "（" + x.groups.length + "）" : "") + '</button><button data-m="note" data-uid="' + u + '">' + (x.note ? "改备注" : "写备注") + "</button>";
    h += '<button data-m="hide" data-uid="' + u + '">' + (x.hidden ? "取消屏蔽" : "屏蔽") + "</button>";
    if (x.kind === "dbx" && x.installed) h += '<button class="danger" data-m="remove" data-uid="' + u + '">卸载</button>';
    m.innerHTML = h;
    m.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = m.offsetWidth, hh = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + "px";
    m.style.top = (r.bottom + hh + 8 > window.innerHeight ? Math.max(8, r.top - hh - 4) : r.bottom + 4) + "px";
  }
  $("menu").addEventListener("click", e => {
    const b = e.target.closest("[data-m]");
    if (!b) return;
    const x = find(b.getAttribute("data-uid"));
    closeMenu();
    if (!x) return;
    const k = b.getAttribute("data-m");
    if (k === "detail") doDetail(x);
    else if (k === "group") doGroup(x);
    else if (k === "note") doNote(x);
    else if (k === "remove") doRemove(x);
    else if (k === "hide") call("user/hide", { uid: x.uid, on: !x.hidden }).then(() => { toast(x.hidden ? "已取消屏蔽" : "已屏蔽 " + x.name); return load(); }).catch(fail);
  });
  window.addEventListener("scroll", closeMenu, true);

  // ───────── 动作 ─────────
  function doInstall(x) {
    const d = openDialog(
      "<h3>" + (x.installed ? "更新" : "安装") + "：" + esc(x.name) + " v" + esc(x.version) + "</h3>" +
      '<div class="hint">来源：' + esc(x.sourceName) + (x.author ? " · 作者：" + esc(x.author) : "") + "</div>" +
      "<h4>它会申请这些权限</h4><div>" + (x.permissions.length ? x.permissions.map(p => '<span class="perm">' + esc(p) + "</span>").join("") : '<span class="hint">没有声明权限</span>') + "</div>" +
      '<p class="hint">安装包会按目录里的 sha256 校验，校验不过不会安装。带本机程序的插件第一次运行前，M-Harness 还会让你再确认一次信任。只装你信任的作者的插件。</p>' +
      foot(btn("ghost", "取消", 'data-dlg="cancel"') + btn("primary", "确认" + (x.installed ? "更新" : "安装"), 'data-dlg="ok"')));
    d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
    d.querySelector('[data-dlg="ok"]').onclick = function () {
      this.disabled = true;
      this.textContent = "下载安装中…";
      call("market/install", { key: x.key }, 240000).then(r => { closeDialog(); toast(r.message || "已安装"); return load(); }).catch(e => { closeDialog(); fail(e); });
    };
  }

  function doUpdateAll() {
    const n = S.data ? S.data.counts.updates : 0;
    const d = openDialog("<h3>全部更新（" + n + " 个）</h3><p class=\"hint\">会逐个下载并按 sha256 校验后更新，一个失败不影响其他。插件市场自己正在运行，会跳过，请单独更新它。</p>" + foot(btn("ghost", "取消", 'data-dlg="cancel"') + btn("primary", "开始更新", 'data-dlg="ok"')));
    d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
    d.querySelector('[data-dlg="ok"]').onclick = function () {
      this.disabled = true;
      this.textContent = "更新中…";
      call("market/updateAll", {}, 900000).then(r => {
        closeDialog();
        const bad = r.failed.concat(r.skipped).map(x => x.name + "：" + (x.error || x.reason)).join("；");
        toast(r.message + (bad ? "（" + bad + "）" : ""));
        return load();
      }).catch(e => { closeDialog(); fail(e); });
    };
  }

  function doRemove(x) {
    const d = openDialog('<h3>卸载 ' + esc(x.name) + '？</h3><p class="hint">会删除这个插件的程序文件。它自己保存的数据目录不会删。</p>' + foot(btn("ghost", "取消", 'data-dlg="cancel"') + btn("danger", "卸载", 'data-dlg="ok"')));
    d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
    d.querySelector('[data-dlg="ok"]').onclick = () => {
      call("market/uninstall", { id: x.id }).then(() => { closeDialog(); toast("已卸载 " + x.name); return load(); }).catch(e => { closeDialog(); fail(e); });
    };
  }

  const linkRow = (label, url) => '<div class="row"><span class="hint" style="width:44px">' + label + '</span><input class="dbx-input" readonly value="' + esc(url) + '" onfocus="this.select()" /></div>';

  function gallery(box, images) {
    let i = 0;
    const draw = () => {
      box.innerHTML = '<div class="main"><img src="' + esc(images[i]) + '" alt="截图 ' + (i + 1) + '" referrerpolicy="no-referrer" />' +
        (images.length > 1 ? '<button class="nav p" aria-label="上一张">‹</button><button class="nav n" aria-label="下一张">›</button>' : "") + "</div>" +
        (images.length > 1 ? '<div class="dots">' + images.map((_, k) => '<button class="' + (k === i ? "on" : "") + '" data-i="' + k + '" aria-label="第 ' + (k + 1) + ' 张"></button>').join("") + "</div>" : "");
      box.querySelector("img").onclick = () => box.classList.toggle("zoom");
      box.querySelector("img").onerror = () => { images.splice(i, 1); if (!images.length) { box.remove(); return; } i = Math.min(i, images.length - 1); draw(); };
      const p = box.querySelector(".p"), n = box.querySelector(".n");
      if (p) p.onclick = () => { i = (i + images.length - 1) % images.length; draw(); };
      if (n) n.onclick = () => { i = (i + 1) % images.length; draw(); };
      Array.prototype.forEach.call(box.querySelectorAll("[data-i]"), b => { b.onclick = () => { i = +b.getAttribute("data-i"); draw(); }; });
    };
    draw();
  }

  function doDetail(x, focus) {
    const repo = x.repo || "";
    const gh = /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repo);
    const links = [];
    if (repo) links.push(["仓库", repo]);
    if (x.homepage && x.homepage !== repo) links.push(["主页", x.homepage]);
    if (gh) links.push(["更新记录", repo + "/releases"]);
    const d = openDialog(
      '<div class="r1" style="display:flex;gap:10px;align-items:center">' + icoOf(x) + '<div style="flex:1;min-width:0"><h3 style="margin:0">' + esc(x.name) + ' <span class="badge kind">' + (x.kind === "dbx" ? "DBX" : "DSH") + "</span></h3>" +
      '<div class="hint">' + [x.author, x.version && "v" + x.version, x.license, x.updated, x.stars != null && "★ " + x.stars].filter(Boolean).map(esc).join(" · ") + "</div></div>" + (x.kind === "dbx" && x.installed && !x.update ? '<button class="pill done" disabled>已安装</button>' : x.kind === "dbx" && x.installable ? btn("primary", x.installed ? "更新" : "安装", 'data-dlg="install"') : "") + "</div>" +
      '<div id="gal" class="gal" hidden></div>' +
      '<p style="white-space:pre-wrap">' + esc(x.description || "（没有简介）") + "</p>" +
      (x.kind === "dsh" ? '<p class="hint">这是 DSH 插件：请到 M-Harness 的「插件中心」里安装。这里只能浏览。</p>' : "") +
      (x.tags.length ? "<div>" + x.tags.map(t => '<span class="badge">' + esc(t) + "</span> ").join("") + "</div>" : "") +
      (x.permissions.length ? "<h4>权限</h4><div>" + x.permissions.map(p => '<span class="perm">' + esc(p) + "</span>").join("") + "</div>" : "") +
      (links.length ? "<h4>链接（点一下全选，复制后到浏览器打开）</h4>" + links.map(l => linkRow(l[0], l[1])).join("") : "") +
      '<div id="cm"><h4>评论 / 讨论</h4>' +
      (gh ? '<p class="hint">插件窗口里没法直接嵌入评论区。这个插件的讨论在它的 GitHub 仓库里，复制链接到浏览器打开：</p>' + linkRow("讨论", repo + "/discussions") + linkRow("问题", repo + "/issues")
        : '<p class="hint">这个插件没有 GitHub 仓库地址，无法给出讨论入口。</p>') + "</div>" +
      '<div class="hint" style="margin-top:8px">来源：' + esc(x.sourceName) + "　标识：" + esc(x.uid) + "</div>" +
      foot(btn("ghost", "关闭", 'data-dlg="cancel"')), true);
    d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
    const ib = d.querySelector('[data-dlg="install"]');
    if (ib) ib.onclick = () => doInstall(x);
    if (focus === "comments") $("cm").scrollIntoView({ block: "start" });
    // 截图：目录里写了就直接用，没有就去仓库 README 里找（只认 GitHub 托管的图）
    const box = $("gal");
    const show = imgs => { if (imgs && imgs.length && $("gal") === box) { box.hidden = false; gallery(box, imgs.slice()); } };
    if (x.screenshots.length) show(x.screenshots);
    else if (gh) call("market/screenshots", { key: x.key }, 30000).then(r => show(r.images)).catch(() => {});
  }

  function doNote(x) {
    const d = openDialog("<h3>备注：" + esc(x.name) + '</h3><textarea class="dbx-textarea" id="note-t" maxlength="2000" placeholder="写给自己看的备注（留空 = 删除）"></textarea>' + foot(btn("ghost", "取消", 'data-dlg="cancel"') + btn("primary", "保存", 'data-dlg="ok"')));
    $("note-t").value = x.note || "";
    d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
    d.querySelector('[data-dlg="ok"]').onclick = () => { call("user/note", { uid: x.uid, text: $("note-t").value }).then(() => { closeDialog(); return load(); }).catch(fail); };
  }

  function doGroup(x) {
    const groups = S.data.groups.map(g => g.name);
    const d = openDialog("<h3>分组：" + esc(x.name) + "</h3>" +
      (groups.length ? groups.map((g, i) => '<label class="row"><input type="checkbox" data-g="' + i + '"' + (x.groups.indexOf(g) >= 0 ? " checked" : "") + " /> " + esc(g) + "</label>").join("") : '<div class="hint">还没有分组，在下面新建一个</div>') +
      '<h4>新建分组并加入</h4><div class="row"><input class="dbx-input" id="g-new" maxlength="40" placeholder="分组名" /></div>' + foot(btn("ghost", "取消", 'data-dlg="cancel"') + btn("primary", "保存", 'data-dlg="ok"')));
    d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
    d.querySelector('[data-dlg="ok"]').onclick = () => {
      const jobs = [];
      groups.forEach((g, i) => {
        const on = d.querySelector('[data-g="' + i + '"]').checked;
        if (on !== (x.groups.indexOf(g) >= 0)) jobs.push(call("user/groupSet", { uid: x.uid, group: g, on }));
      });
      const nn = $("g-new").value.trim();
      if (nn) jobs.push(call("user/groupSet", { uid: x.uid, group: nn, on: true }));
      Promise.all(jobs).then(() => { closeDialog(); return load(); }).catch(fail);
    };
  }

  function askText(title, value, ok) {
    const d = openDialog("<h3>" + esc(title) + '</h3><div class="row"><input class="dbx-input" id="ask-t" maxlength="40" /></div>' + foot(btn("ghost", "取消", 'data-dlg="cancel"') + btn("primary", "确定", 'data-dlg="ok"')));
    $("ask-t").value = value || "";
    $("ask-t").focus();
    d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
    const go = () => { const v = $("ask-t").value.trim(); if (v) ok(v); };
    d.querySelector('[data-dlg="ok"]').onclick = go;
    $("ask-t").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  }

  // ───────── 导出日志 ─────────
  function exportLog() {
    call("market/diagnostics").then(r => {
      const d = openDialog('<h3>诊断日志</h3><p class="hint">路径和令牌已经遮掉，不会发到任何地方。反馈问题时把下面的内容复制给我们。</p><textarea class="dbx-textarea" id="log-t" readonly style="min-height:260px"></textarea>' + foot(btn("ghost", "关闭", 'data-dlg="cancel"')));
      $("log-t").value = r.text;
      $("log-t").focus();
      $("log-t").select();
      d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
    }).catch(fail);
  }

  // ───────── 备份与来源（高级） ─────────
  function renderAdvanced() {
    const adv = $("advanced");
    adv.innerHTML = '<div class="hint pad">加载中…</div>';
    call("market/settings").then(cfg => {
      adv.innerHTML =
        '<div class="panel"><h3>目录来源</h3><div class="hint">DBX 来源的插件可以在这里直接安装；DSH 来源只用来浏览。</div><div id="srcs" style="margin-top:8px"></div>' +
        '<div class="row"><input class="dbx-input" id="src-name" placeholder="名称" style="max-width:150px;flex:none" /><input class="dbx-input" id="src-url" placeholder="目录地址（https://…/index.json，DBX 目录或 DSH 市场索引）" />' + btn("ghost sm", "添加", 'id="src-add"') + "</div>" +
        '<div class="row">' + btn("primary sm", "保存来源并刷新", 'id="src-save"') + btn("ghost sm", "恢复默认", 'id="src-reset"') + "</div></div>" +
        '<div class="panel"><h3>备份与还原</h3><div class="hint">收藏、分组、备注、来源</div><h4>JSON 文件</h4>' +
        '<textarea class="dbx-textarea" id="bk-text" placeholder="点「导出」生成备份 JSON；要还原时把备份粘贴到这里，再点「导入（合并）」"></textarea>' +
        '<div class="row" style="margin-top:6px">' + btn("ghost sm", "导出", 'id="bk-export"') + btn("ghost sm", "导入（合并）", 'id="bk-import"') + btn("ghost sm", "导入（覆盖）", 'id="bk-replace"') + "</div>" +
        "<h4>WebDAV 同步</h4>" +
        '<div class="row"><input class="dbx-input" id="dav-url" placeholder="WebDAV 目录地址，如 https://dav.example.com/backup" /></div>' +
        '<div class="row"><input class="dbx-input" id="dav-user" placeholder="用户名" /><input class="dbx-input" id="dav-pass" type="password" placeholder="' + (cfg.webdav.hasPassword ? "密码（已保存，留空不改）" : "密码") + '" /></div>' +
        '<div class="row">' + btn("ghost sm", "保存", 'id="dav-save"') + btn("ghost sm", "上传", 'id="dav-push"') + btn("ghost sm", "下载并合并", 'id="dav-pull"') + "</div>" +
        "<h4>私有 Gist 同步</h4>" +
        '<div class="row"><input class="dbx-input" id="gist-token" type="password" placeholder="' + (cfg.gist.hasToken ? "GitHub 令牌（已保存，留空不改）" : "GitHub 令牌（需要 gist 权限）") + '" /></div>' +
        '<div class="row"><input class="dbx-input" id="gist-id" placeholder="Gist ID（第一次上传会自动创建）" /></div>' +
        '<div class="row">' + btn("ghost sm", "保存", 'id="gist-save"') + btn("ghost sm", "上传", 'id="gist-push"') + btn("ghost sm", "下载并合并", 'id="gist-pull"') + "</div>" +
        '<p class="hint">WebDAV 密码和 GitHub 令牌以明文存在插件自己的数据目录里（' + esc(cfg.pluginsDir.replace(/plugins$/, "plugin-data")) + "），不会发到别处；备份文件里不含它们。</p></div>";
      let srcs = cfg.sources.map(s => ({ id: s.id, name: s.name, url: s.url, enabled: s.enabled }));
      const drawSrcs = () => {
        $("srcs").innerHTML = srcs.map((s, i) => '<div class="src"><input type="checkbox" data-i="' + i + '" ' + (s.enabled ? "checked" : "") + ' /><span>' + esc(s.name) + '</span><span class="hint" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(s.url) + '">' + esc(s.url) + '</span><button class="pill ghost sm" data-rm="' + i + '">删除</button></div>').join("");
        Array.prototype.forEach.call(adv.querySelectorAll("[data-i]"), el => { el.onchange = () => { srcs[+el.getAttribute("data-i")].enabled = el.checked; }; });
        Array.prototype.forEach.call(adv.querySelectorAll("[data-rm]"), el => { el.onclick = () => { srcs.splice(+el.getAttribute("data-rm"), 1); drawSrcs(); }; });
      };
      drawSrcs();
      $("dav-url").value = cfg.webdav.url; $("dav-user").value = cfg.webdav.user; $("gist-id").value = cfg.gist.gistId;
      $("src-add").onclick = () => {
        const url = $("src-url").value.trim();
        if (!url) return;
        srcs.push({ name: $("src-name").value.trim() || url, url, enabled: true });
        $("src-name").value = ""; $("src-url").value = "";
        drawSrcs();
      };
      $("src-save").onclick = () => { call("market/saveSettings", { sources: srcs }).then(() => { toast("来源已保存"); S.source = ""; return load({ refresh: true }); }).catch(fail); };
      $("src-reset").onclick = () => { srcs = cfg.defaults.map(s => ({ id: s.id, name: s.name, url: s.url, enabled: s.enabled })); drawSrcs(); };
      $("bk-export").onclick = () => { call("backup/export").then(r => { $("bk-text").value = JSON.stringify(r, null, 2); $("bk-text").select(); toast("已生成，复制保存即可"); }).catch(fail); };
      const imp = mode => {
        let data;
        try { data = JSON.parse($("bk-text").value); } catch (e) { return fail(new Error("粘贴的内容不是 JSON")); }
        call("backup/import", { data, mode }).then(r => { toast("已还原：" + r.favorites + " 个收藏、" + r.groups + " 个分组、" + r.notes + " 条备注"); return load(); }).catch(fail);
      };
      $("bk-import").onclick = () => imp("merge");
      $("bk-replace").onclick = () => imp("replace");
      const cloud = (action, saveFirst) => {
        (saveFirst ? saveFirst() : Promise.resolve()).then(() => call("backup/cloud", { action })).then(r => { toast(r.message || "完成"); if (r.restored) return load(); }).catch(fail);
      };
      const saveDav = () => call("market/saveSettings", { webdav: { url: $("dav-url").value, user: $("dav-user").value, password: $("dav-pass").value } });
      const saveGist = () => call("market/saveSettings", { gist: { token: $("gist-token").value, gistId: $("gist-id").value } });
      $("dav-save").onclick = () => { saveDav().then(() => toast("已保存")).catch(fail); };
      $("dav-push").onclick = () => cloud("webdavPush", saveDav);
      $("dav-pull").onclick = () => cloud("webdavPull", saveDav);
      $("gist-save").onclick = () => { saveGist().then(() => toast("已保存")).catch(fail); };
      $("gist-push").onclick = () => cloud("gistPush", saveGist);
      $("gist-pull").onclick = () => cloud("gistPull", saveGist);
    }).catch(e => { adv.innerHTML = '<div class="pad warn">' + esc(e.message || e) + "</div>"; });
  }

  // ───────── 标签页 / 事件 ─────────
  function setTab(t) {
    S.tab = t; S.category = ""; S.group = ""; S.sub = "installed"; S.tag = "";
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), el => { el.classList.toggle("on", el.getAttribute("data-tab") === t); });
    const adv = t === "advanced";
    $("browse").hidden = adv;
    $("advanced").hidden = !adv;
    if (adv) { $("notice").innerHTML = ""; renderAdvanced(); } else load();
  }

  document.addEventListener("click", e => {
    if (!e.target.closest) return;
    if (!e.target.closest("#menu") && !e.target.closest('[data-act="menu"]')) closeMenu();
    const tab = e.target.closest("[data-tab]");
    if (tab) return setTab(tab.getAttribute("data-tab"));
    const el = e.target.closest("[data-act],[data-sub],[data-group],[data-cat]");
    if (!el || $("modal").contains(el)) return;
    const act = el.getAttribute("data-act");
    if (el.hasAttribute("data-cat")) { S.category = el.getAttribute("data-cat"); return load(); }
    if (el.hasAttribute("data-sub")) { S.sub = el.getAttribute("data-sub"); S.group = ""; return load(); }
    if (el.hasAttribute("data-group")) { S.group = S.group === el.getAttribute("data-group") ? "" : el.getAttribute("data-group"); S.sub = "installed"; return load(); }
    if (act === "more") return load({ append: true });
    if (act === "hiderecent") { pref.set("hideRecent", "1"); return renderRecent(); }
    if (act === "showrecent") { pref.set("hideRecent", "0"); return renderRecent(); }
    if (act === "updateall") return doUpdateAll();
    if (act === "newgroup") return askText("新建分组", "", n => { call("user/groupCreate", { name: n }).then(() => { closeDialog(); return load(); }).catch(fail); });
    if (act === "renamegroup") return askText("重命名分组", S.group, n => { call("user/groupRename", { from: S.group, to: n }).then(() => { S.group = n; closeDialog(); return load(); }).catch(fail); });
    if (act === "delgroup") {
      const g = S.group;
      const d = openDialog("<h3>删除分组「" + esc(g) + "」？</h3><p class=\"hint\">只删分组，里面的插件不受影响。</p>" + foot(btn("ghost", "取消", 'data-dlg="cancel"') + btn("danger", "删除", 'data-dlg="ok"')));
      d.querySelector('[data-dlg="cancel"]').onclick = closeDialog;
      d.querySelector('[data-dlg="ok"]').onclick = () => { call("user/groupDelete", { name: g }).then(() => { S.group = ""; closeDialog(); return load(); }).catch(fail); };
      return;
    }
    const x = find(el.getAttribute("data-uid"));
    if (!x) return;
    if (act === "menu") return openMenu(x, el);
    if (act === "install") return doInstall(x);
    if (act === "detail") return doDetail(x);
    if (act === "comments") return doDetail(x, "comments");
    if (act === "fav") call("user/favorite", { uid: x.uid, on: !x.favorite }).then(() => load()).catch(fail);
  });

  // 横向滚动的条（分类胶囊 / 最近更新）：鼠标滚轮直接横着滚
  document.addEventListener("wheel", e => {
    const el = e.target.closest ? e.target.closest(".caps, .strip, .subtabs, .tabs") : null;
    if (el && el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { el.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });

  let qTimer;
  $("q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = $("q").value.trim(); load(); }, 250); });
  $("kind").addEventListener("change", () => { S.kind = $("kind").value; load(); });
  $("sort").addEventListener("change", () => { S.sort = $("sort").value; load(); });
  $("source").addEventListener("change", () => { S.source = $("source").value; load(); });
  $("filter-btn").addEventListener("click", () => {
    const f = $("filters");
    f.hidden = !f.hidden;
    $("filter-btn").setAttribute("aria-expanded", String(!f.hidden));
  });
  $("refresh").addEventListener("click", () => { const b = $("refresh"); b.disabled = true; load({ refresh: true }).then(() => { b.disabled = false; toast("目录已刷新"); }); });
  $("export-log").addEventListener("click", exportLog);

  api.ready.then(() => {
    call("market/settings").then(c => { if (c.version) $("ver").textContent = "v" + c.version; }).catch(() => {});
    load();
  });
})();
