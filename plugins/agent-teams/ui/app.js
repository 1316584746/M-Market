(function () {
  "use strict";
  const api = window.dbxPlugin;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rpc = (m, p) => api.invoke(m, p || {}, { timeoutMs: 30000 });

  const S = { list: null, id: decodeURIComponent((location.hash || "").slice(1)), team: null, info: null, editing: null, showArchived: false, dlg: null, openTask: "", err: "" };

  const PHASE = (t) => (t.archived ? ["已归档", "mut"] : t.phase === "staged" ? ["待批准", "warn"] : t.halted ? ["已暂停", "bad"] : t.quality && t.quality.state === "escalated" ? ["需要决定", "bad"] : t.progress.finished ? (t.quality && t.quality.state === "blocked" ? ["未达标", "warn"] : ["已完成", "ok"]) : ["运行中", "run"]);
  const TS = { pending: ["待办", "mut"], claimed: ["已领取", "run"], in_progress: ["进行中", "run"], completed: ["已完成", "ok"], failed: ["失败", "bad"], cancelled: ["已取消", "mut"] };
  const MS = { idle: "空闲", working: "工作中" };
  const COLOR = { pending: "#94a3b8", claimed: "#3b82f6", in_progress: "#3b82f6", completed: "#10b981", failed: "#ef4444", cancelled: "#cbd5e1" };

  const p2 = n => String(n).padStart(2, "0");
  const when = ts => { if (!ts) return ""; const d = new Date(ts); return p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()); };
  const fmt = n => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n); };
  const badge = (txt, cls) => '<span class="b ' + cls + '">' + esc(txt) + "</span>";

  // ───────── 任务依赖图（按依赖深度分列） ─────────
  function graph(tasks) {
    if (!tasks.length) return '<div class="dim">还没有任务</div>';
    const byId = new Map(tasks.map(k => [k.id, k]));
    const depth = new Map();
    const depthOf = id => {
      if (depth.has(id)) return depth.get(id);
      depth.set(id, 0);
      const d = Math.max(-1, ...(byId.get(id).dependencies || []).filter(x => byId.has(x)).map(depthOf)) + 1;
      depth.set(id, d);
      return d;
    };
    tasks.forEach(k => depthOf(k.id));
    const cols = [];
    tasks.forEach(k => { (cols[depth.get(k.id)] ||= []).push(k); });
    const W = 168, H = 46, GX = 52, GY = 14;
    const pos = new Map();
    cols.forEach((col, c) => col.forEach((k, r) => pos.set(k.id, { x: c * (W + GX) + 4, y: r * (H + GY) + 4 })));
    const width = cols.length * (W + GX) - GX + 8;
    const height = Math.max(...cols.map(c => c.length)) * (H + GY) - GY + 8;
    let g = '<svg class="dag" viewBox="0 0 ' + width + " " + height + '" style="min-width:' + Math.min(width, 900) + 'px;height:' + height + 'px">';
    tasks.forEach(k => (k.dependencies || []).forEach(d => {
      const a = pos.get(d), b = pos.get(k.id);
      if (!a || !b) return;
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
      g += '<path d="M' + x1 + " " + y1 + " C" + mx + " " + y1 + " " + mx + " " + y2 + " " + x2 + " " + y2 + '" class="edge' + (byId.get(d).status === "completed" ? " done" : "") + '"/>';
    }));
    tasks.forEach(k => {
      const p = pos.get(k.id), st = TS[k.status] || [k.status, "mut"];
      g += '<g class="node" data-task="' + esc(k.id) + '" transform="translate(' + p.x + "," + p.y + ')"><title>' + esc(k.id + " " + k.subject + " · " + st[0] + (k.assignee ? " · " + k.assignee : "")) + "</title>" +
        '<rect width="' + W + '" height="' + H + '" rx="8" class="nbox"/><rect width="5" height="' + H + '" rx="2" fill="' + COLOR[k.status] + '"/>' +
        '<text x="14" y="19" class="nt">' + esc(k.id + " " + (k.subject.length > 15 ? k.subject.slice(0, 14) + "…" : k.subject)) + "</text>" +
        '<text x="14" y="36" class="ns">' + esc(st[0] + (k.assignee ? " · " + k.assignee : k.ready ? " · 待认领" : "")) + "</text></g>";
    });
    return g + "</svg>";
  }

  function progressBar(p) {
    if (!p.total) return '<div class="pbar"></div>';
    const seg = (n, c) => (n ? '<i style="width:' + (n / p.total) * 100 + "%;background:" + c + '"></i>' : "");
    return '<div class="pbar">' + seg(p.done, COLOR.completed) + seg(p.inProgress, COLOR.in_progress) + seg(p.failed, COLOR.failed) + seg(p.cancelled, COLOR.cancelled) + "</div>";
  }

  // ───────── 团队详情 ─────────
  function viewApprovals(t) {
    if (!t.approvals || !t.approvals.length) return "";
    return '<section class="box warnbox"><h3>等待你确认（' + t.approvals.length + "）</h3>" + t.approvals.map(a =>
      '<div class="ap"><div><b>' + esc(a.member) + "</b> 想" + (a.kind === "write" ? "写入文件 <code>" + esc(a.detail.path) + "</code>（" + a.detail.bytes + " 字节）" : "执行命令 <code>" + esc(a.detail.command) + "</code>") + (a.kind === "write" && a.detail.preview ? "<pre>" + esc(a.detail.preview) + (a.detail.bytes > 400 ? "\n…" : "") + "</pre>" : "") + "</div>" +
      '<div class="apb"><button type="button" data-ap="' + esc(a.id) + '" data-allow="1" class="primary">允许</button><button type="button" data-ap="' + esc(a.id) + '" data-allow="0">拒绝</button></div></div>').join("") + "</section>";
  }

  // ───────── 质量门：任务类型、合同、证据、总览 ─────────
  const KIND = { implementation: "实现", repair: "修复", review: "评审", verification: "验证", integration: "集成", requirements: "需求" };
  const SEV = { blocker: "bad", high: "bad", medium: "warn", low: "mut" };
  const VERDICT = { pass: ["通过", "ok"], needs_revision: ["需要修改", "warn"], reject: ["打回", "bad"] };
  const list = (title, arr, block) => (arr && arr.length ? (block ? "<div><b>" + title + "</b><ul>" + arr.map(x => "<li>" + x + "</li>").join("") + "</ul></div>" : "<div><b>" + title + "</b> " + arr.join(' <span class="dim">·</span> ') + "</div>") : "");
  const stIcon = s => (s === "passed" ? "✓ " : s === "failed" ? "✗ " : "· ");

  function contractHtml(k) {
    if (!k.kind) return "";
    const kv = (a, f) => (a || []).map(f || esc);
    const res = (k.acceptanceResults || []).map(r => '<span class="' + (r.status === "passed" ? "okc" : "warn") + '">' + stIcon(r.status) + esc(r.criterion) + "</span>" + (r.evidence ? ' <span class="dim">' + esc(r.evidence) + "</span>" : ""));
    const cmds = (k.commandsRun || []).map(c => '<span class="' + (c.status === "passed" ? "okc" : "warn") + '">' + stIcon(c.status) + "<code>" + esc(c.command) + "</code></span>" + (c.exitCode !== undefined && c.exitCode !== null ? ' <span class="dim">exit ' + esc(c.exitCode) + "</span>" : "") + (c.evidence ? ' <span class="dim">' + esc(c.evidence) + "</span>" : ""));
    const finds = (k.findings || []).map(f => badge(f.severity, SEV[f.severity] || "mut") + (f.resolved ? " " + badge("已解决", "ok") : "") + " <b>" + esc(f.id) + "</b> " + (f.file ? "<code>" + esc(f.file + (f.line ? ":" + f.line : "")) + "</code> " : "") + esc(f.problem) + (f.requiredFix ? ' <span class="dim">→ ' + esc(f.requiredFix) + "</span>" : ""));
    const link = [k.reviewedTaskId ? "评审对象 " + k.reviewedTaskId : "", k.sourceTaskId ? "修复来源 " + k.sourceTaskId : "", k.supersededBy ? "已被 " + k.supersededBy + " 接替" : "", k.round > 1 ? "第 " + k.round + " 轮" : ""].filter(Boolean);
    return '<div class="contract"><b>合同</b> ' + badge(KIND[k.kind] || k.kind, "run") + (k.verdict ? " " + badge((VERDICT[k.verdict] || [k.verdict, "mut"])[0], (VERDICT[k.verdict] || [0, "mut"])[1]) : "") + (k.forced ? " " + badge("队长强制收尾，未验证", "warn") : "") + (link.length ? ' <span class="dim">' + esc(link.join(" · ")) + "</span>" : "") +
      (k.objective ? "<div>" + esc(k.objective) + "</div>" : "") +
      list("范围（可写）", kv(k.inScope, x => "<code>" + esc(x) + "</code>")) + list("范围外（禁止）", kv(k.outOfScope, x => "<code>" + esc(x) + "</code>")) + list("验收", kv(k.acceptance), 1) + list("验证命令", kv(k.verify, x => "<code>" + esc(x) + "</code>")) + list("交付物", kv(k.deliverables)) + list("非目标", kv(k.nonGoals)) +
      (k.changedPaths && k.changedPaths.length ? list("实际改动", kv(k.changedPaths, x => "<code>" + esc(x) + "</code>")) : "") + list("验收结果", res, 1) + list("执行过的命令", cmds, 1) + list("评审发现", finds, 1) + "</div>";
  }

  function viewQuality(t) {
    const q = t.quality;
    if (!q) return "";
    const tone = { running: "run", halted: "mut", escalated: "bad", blocked: "warn", deliverable: "ok" }[q.state] || "mut";
    const cov = (q.coverage || []).map(r => '<div class="cov">' + badge({ passed: "已覆盖", in_progress: "进行中", blocked: "有失败", missing: "无任务" }[r.status] || r.status, { passed: "ok", in_progress: "run", blocked: "bad", missing: "warn" }[r.status] || "mut") + " " + esc(r.goal_item) + (r.task_ids.length ? ' <span class="dim">' + esc(r.task_ids.join(", ")) + "</span>" : "") + "</div>").join("");
    const rows = (title, arr, cls) => (arr && arr.length ? '<div class="' + cls + '"><b>' + title + "</b><ul>" + arr.map(x => "<li>" + esc(x) + "</li>").join("") + "</ul></div>" : "");
    return '<section class="box qbox ' + (q.state === "escalated" || q.state === "blocked" ? "warnbox" : "") + '"><h3>质量门 ' + badge(q.deliverable ? "可交付" : q.state === "running" ? "进行中" : q.state === "escalated" ? "需要决定" : q.state === "blocked" ? "未达标" : "已暂停", tone) + '<span class="dim">' + esc(q.summary) + "</span></h3>" +
      rows("升级给队长", (q.escalations || []).map(e => e.reason), "warn") + rows("阻塞交付", q.blockers, "warn") + rows("提醒", q.warnings, "dim") + (cov ? "<div><b>目标覆盖</b>" + cov + "</div>" : "") + "</section>";
  }

  function viewTasks(t) {
    const rows = t.tasks.map(k => {
      const st = TS[k.status] || [k.status, "mut"];
      const open = S.openTask === k.id;
      const can = k.status === "pending" || k.status === "claimed" || k.status === "in_progress";
      return '<tr class="trow' + (open ? " open" : "") + '" data-task="' + esc(k.id) + '"><td class="mono">' + esc(k.id) + "</td><td>" + (k.kind ? badge(KIND[k.kind] || k.kind, "run") + " " : "") + esc(k.subject) + (k.round > 1 ? ' <span class="dim">第 ' + k.round + " 轮</span>" : "") + (k.supersededBy ? ' <span class="dim">已被接替</span>' : "") + (k.revisions ? ' <span class="dim">修订 ' + k.revisions + "</span>" : "") + "</td><td>" + badge(st[0], st[1]) + (k.blockedBy && k.blockedBy.length && can ? ' <span class="warn" title="依赖的任务失败或被取消了">卡住</span>' : "") + "</td><td>" + esc(k.assignee || "—") + '</td><td class="dim">' + esc((k.dependencies || []).join(", ") || "—") + "</td></tr>" +
        (open ? '<tr class="detail"><td colspan="5">' + (k.description ? "<div><b>说明</b>\n" + esc(k.description) + "</div>" : "") + contractHtml(k) + (k.output ? "<div><b>结果</b><pre>" + esc(k.output) + "</pre></div>" : '<div class="dim">还没有结果</div>') +
          (k.revisionLog ? "<div><b>修订记录</b>" + k.revisionLog.map(r => '<div class="dim">' + esc(when(r.at) + " · " + r.reason + "（改了 " + r.fields.join("、") + "）") + "</div>").join("") + "</div>" : "") +
          (can && !t.archived ? '<div class="acts"><select data-reassign="' + esc(k.id) + '"><option value="">改派给…</option><option value="__none">未指派</option>' + t.members.map(m => '<option value="' + esc(m.name) + '">' + esc(m.name) + "</option>").join("") + '</select><button type="button" data-cancel="' + esc(k.id) + '">取消任务</button></div>' : "") + "</td></tr>" : "");
    }).join("");
    return '<section class="box"><h3>任务<span class="dim">点一行看说明和结果</span></h3><div class="scroll">' + graph(t.tasks) + '</div><table class="tbl"><thead><tr><th>#</th><th>标题</th><th>状态</th><th>负责人</th><th>依赖</th></tr></thead><tbody>' + rows + "</tbody></table></section>";
  }

  function viewMembers(t) {
    return '<section class="box"><h3>成员<span class="dim">' + t.members.length + " 人</span></h3>" + (t.members.length ? '<div class="members">' + t.members.map(m => {
      const log = (t.activity && t.activity[m.name]) || [];
      const lines = log.slice(-6).map(l => '<div class="lg ' + esc(l.kind) + '"><span class="dim">' + esc(when(l.ts).slice(6)) + "</span> " + esc(l.text.length > 160 ? l.text.slice(0, 160) + "…" : l.text) + "</div>").join("");
      return '<div class="mem' + (m.status === "working" ? " busy" : "") + '"><div class="mh"><b>' + esc(m.name) + "</b>" + (m.role ? ' <span class="dim">' + esc(m.role) + "</span>" : "") + '<span class="sp"></span>' + badge(MS[m.status] || m.status, m.status === "working" ? "run" : "mut") + (m.toolPolicy === "readonly" ? " " + badge("只读", "warn") : "") + "</div>" +
        '<div class="dim">' + esc(m.currentTask ? "正在做 " + m.currentTask : "没有进行中的任务") + (m.model ? " · " + esc((m.provider ? m.provider + " / " : "") + m.model) : "") + (m.usage && m.usage.calls ? " · " + fmt(m.usage.input) + " 入 / " + fmt(m.usage.output) + " 出 · " + m.usage.calls + " 次调用" : "") + "</div>" +
        (m.spawnError ? '<div class="warn">' + esc(m.spawnError) + "</div>" : "") + (lines ? '<div class="logs">' + lines + "</div>" : "") +
        (t.archived ? "" : '<div class="acts"><button type="button" data-rmmember="' + esc(m.name) + '">移除</button></div>') + "</div>";
    }).join("") + "</div>" : '<div class="dim">没有成员</div>') + "</section>";
  }

  function viewMessages(t) {
    const msgs = t.messages || [];
    const opts = ["captain"].concat(t.members.map(m => m.name));
    return '<section class="box"><h3>消息<span class="dim">队长和成员之间的往来</span></h3><div class="msgs" id="msgs">' + (msgs.length ? msgs.map(m => '<div class="msg ' + (m.from === "user" ? "me" : "") + '"><span class="dim">' + esc(when(m.ts)) + "</span> <b>" + esc(m.from) + "</b> → " + esc(m.to) + "：" + esc(m.content) + "</div>").join("") : '<div class="dim">还没有消息</div>') + "</div>" +
      (t.archived ? "" : '<div class="send"><select id="msgTo">' + opts.map(o => "<option>" + esc(o) + "</option>").join("") + '</select><input id="msgText" placeholder="发给队长或成员（队长在下次 agent_teams_status 时看到）" /><button type="button" id="msgSend" class="primary">发送</button></div>') + "</section>";
  }

  // 待批准的方案编辑器
  function viewEditor(t) {
    const d = S.editing;
    const memberRow = (m, i) => '<div class="erow"><input data-m="' + i + '" data-f="name" placeholder="成员名" value="' + esc(m.name) + '" /><input data-m="' + i + '" data-f="role" placeholder="角色" value="' + esc(m.role || "") + '" /><input data-m="' + i + '" data-f="model" placeholder="模型（可选）" value="' + esc(m.model || "") + '" /><select data-m="' + i + '" data-f="toolPolicy"><option value="full"' + (m.toolPolicy !== "readonly" ? " selected" : "") + '>可写可执行</option><option value="readonly"' + (m.toolPolicy === "readonly" ? " selected" : "") + '>只读</option></select><button type="button" data-delm="' + i + '">×</button></div>';
    const taskRow = (k, i) => '<div class="erow t"><input data-k="' + i + '" data-f="subject" placeholder="标题" value="' + esc(k.subject) + '" /><select data-k="' + i + '" data-f="assignee"><option value="">谁空闲谁领</option>' + d.members.filter(m => m.name).map(m => "<option" + (k.assignee === m.name ? " selected" : "") + ">" + esc(m.name) + "</option>").join("") + '</select><input data-k="' + i + '" data-f="deps" placeholder="依赖（标题或序号，逗号分隔）" value="' + esc(k.deps) + '" /><button type="button" data-delk="' + i + '">×</button><textarea data-k="' + i + '" data-f="description" placeholder="说明">' + esc(k.description || "") + "</textarea></div>";
    return '<section class="box"><h3>编辑方案<span class="dim">保存后仍是待批准</span></h3><textarea id="edDesc" placeholder="团队目标">' + esc(d.description || "") + "</textarea><h4>成员</h4>" + d.members.map(memberRow).join("") + '<button type="button" id="addM">+ 成员</button><h4>任务（序号从 1 起，依赖可写标题或序号）</h4>' + d.tasks.map(taskRow).join("") + '<button type="button" id="addK">+ 任务</button><div class="acts"><button type="button" id="edSave" class="primary">保存方案</button><button type="button" id="edCancel">放弃修改</button></div></section>';
  }

  function viewTeam() {
    const t = S.team;
    if (!t) return '<div class="empty">加载中…</div>';
    const [ph, cls] = PHASE(t);
    const head = '<div class="th"><div><h2>' + esc(t.name) + " " + badge(ph, cls) + "</h2>" + (t.description ? '<div class="dim">' + esc(t.description) + "</div>" : "") + "</div>" + '<div class="acts">' +
      (t.archived ? '<button type="button" data-act="restore">恢复</button><button type="button" data-act="delete" class="danger">永久删除</button>' :
        (t.phase === "staged" ? '<button type="button" data-act="approve" class="primary">批准并运行</button><button type="button" data-act="edit">编辑方案</button>' :
          (t.halted ? '<button type="button" data-act="resume" class="primary">恢复</button>' : '<button type="button" data-act="halt">暂停</button>')) + '<button type="button" data-act="archive">归档</button>') + "</div></div>";
    const allow = t.archived ? "" : '<label class="chk"><input type="checkbox" id="allowAll"' + (t.allowAll ? " checked" : "") + ' /> 本团队全部允许（成员写文件、执行命令不再逐条确认）</label>';
    const counts = t.progress.total ? '<span class="dim">' + t.progress.done + "/" + t.progress.total + " 完成" + (t.progress.inProgress ? " · " + t.progress.inProgress + " 进行中" : "") + (t.progress.failed ? " · " + t.progress.failed + " 失败" : "") + (t.progress.cancelled ? " · " + t.progress.cancelled + " 取消" : "") + "</span>" : '<span class="dim">还没有任务</span>';
    const hint = t.phase === "staged" ? '<div class="hint">这是待批准的方案：成员还没有开始干活。确认成员和任务没问题后点「批准并运行」，或者告诉 AI 你同意。</div>' : "";
    return head + hint + viewApprovals(t) + '<section class="box"><div class="pr">' + progressBar(t.progress) + counts + "</div>" + allow + "</section>" + viewQuality(t) +
      (S.editing ? viewEditor(t) : viewTasks(t) + viewMembers(t)) + viewMessages(t);
  }

  function viewSide() {
    const L = S.list;
    if (!L) return "";
    const items = L.teams.map(t => {
      const [ph, cls] = PHASE(t);
      return '<div class="ti' + (t.id === S.id ? " on" : "") + '" data-team="' + esc(t.id) + '"><div class="tn">' + esc(t.name) + (t.approvals ? ' <span class="b bad">' + t.approvals + "</span>" : "") + '</div><div class="dim">' + badge(ph, cls) + " " + t.progress.done + "/" + t.progress.total + "</div>" + progressBar(t.progress) + "</div>";
    }).join("");
    const arch = L.archived.length ? '<div class="arch"><button type="button" id="togArch" class="link">已归档（' + L.archived.length + "）" + (S.showArchived ? " ▾" : " ▸") + "</button>" + (S.showArchived ? L.archived.map(t => '<div class="ti' + (t.id === S.id ? " on" : "") + '" data-team="' + esc(t.id) + '"><div class="tn">' + esc(t.name) + '</div><div class="dim">' + esc(when(t.archivedAt)) + "</div></div>").join("") : "") + "</div>" : "";
    return items + arch;
  }

  function viewEmpty() {
    return '<div class="empty"><h2>还没有团队</h2><p>让 AI 当队长，对它说一句话就行，比如：</p><pre>组一个团队，把 src 目录里的模块分析一遍：\n一个人读代码，一个人写总结，总结等读完再开始。</pre><p class="dim">AI 会调用 agent_teams_create 提出方案（成员和带依赖的任务）。你在这里确认后点「批准并运行」，成员就会自动领任务干活，进度和动态实时显示在这里。</p><p class="dim">成员用 M-Harness 里 type 为 openai-compat / anthropic 的模型提供方（Cursor 和命令行 Agent 不是模型接口，成员用不了）；点右上角「设置」可以看当前在用的 Agent、成员会用哪个模型、指定工作目录。</p></div>';
  }

  // ───────── 设置 ─────────
  function viewDialog() {
    const s = S.dlg;
    if (!s) return "";
    const all = s.all || [];
    const cur = s.current;
    const eff = s.effective || {};
    const typeName = t => (t === "cursor-sdk" ? "Cursor" : t === "cli" ? "命令行 Agent" : t === "anthropic" ? "Anthropic" : t === "openai-compat" ? "OpenAI 兼容" : t);
    const keyBadge = p => (p.hasKey ? '<span class="pv-b ok">key 就绪</span>' : '<span class="pv-b bad" title="' + esc(p.keyEnv ? "环境变量 " + p.keyEnv + " 没有设置" : "没有配置 key") + '">' + esc(p.keyEnv ? "缺 " + p.keyEnv : "没有 key") + "</span>");
    const usable = all.filter(p => p.usable);
    const other = all.filter(p => !p.usable);
    // 当前在用的 Agent
    let now;
    if (cur) {
      now = '<div class="pv-now"><div class="pv-nh"><b>' + esc(cur.name) + '</b><span class="pv-b">' + esc(typeName(cur.type)) + "</span>" + (cur.model ? '<span class="dim">' + esc(cur.model) + "</span>" : "") + '<span class="pv-b' + (cur.recent ? " on" : "") + '">' + (cur.recent ? "最近一次运行用的" : "M-Harness 默认") + "</span></div>" +
        (cur.usable ? '<div class="dim">它是模型接口，成员可以直接用。</div>' : '<div class="pv-warn">' + esc(cur.reason) + "。</div>") + "</div>";
    } else now = '<div class="dim">没有读到 M-Harness 的提供方配置。</div>';
    const effLine = eff.ok
      ? '<div class="pv-eff ok">成员实际会用：<b>' + esc(eff.provider) + "</b> · " + esc(eff.model) + "</div>"
      : '<div class="pv-eff bad">成员现在没有可用的模型：' + esc(eff.error || "未知原因") + "</div>";
    const radio = (val, title, sub, badges, checked) => '<label class="pv-card' + (checked ? " on" : "") + '"><input type="radio" name="pv" value="' + esc(val) + '"' + (checked ? " checked" : "") + " /><div><div class=\"pv-t\"><b>" + esc(title) + "</b>" + badges + '</div><div class="dim">' + esc(sub) + "</div></div></label>";
    const list = radio("", "跟随 M-Harness（推荐）", "优先用默认提供方「" + (s.defaultName || "-") + "」，它不能用或没有 key 时换第一个有 key 的", "", !s.provider) +
      usable.map(p => radio(p.name, p.name, (p.model || "（未配置模型）") + " · " + p.baseURL, (p.name === s.defaultName ? '<span class="pv-b">默认</span>' : "") + keyBadge(p), s.provider === p.name)).join("");
    const na = other.length ? '<div class="pv-na"><div class="dim">这些成员用不了：</div>' + other.map(p => '<div class="pv-off"><b>' + esc(p.name) + '</b><span class="pv-b">' + esc(typeName(p.type)) + '</span><span class="dim" title="' + esc(p.reason) + '">' + esc(p.reason) + "</span></div>").join("") + "</div>" : "";
    return '<div class="modal" id="modal"><div class="dlg wide"><h3>AgentTeams 设置</h3>' +
      '<section class="dsec"><h4>当前使用的 Agent</h4>' + now + effLine + "</section>" +
      '<section class="dsec"><h4>成员用哪个模型</h4><div class="pv-list">' + list + "</div>" + na + "</section>" +
      '<section class="dsec"><h4>常规</h4><div class="dgrid">' +
      '<label class="dcol wide2"><span>工作目录</span><input id="sWs" placeholder="' + esc((S.info && S.info.workspace) || "") + '" value="' + esc(s.workspace) + '" /><span class="dim">成员读写文件、执行命令都限定在这个目录里；留空 = 用 M-Harness 配置里的 workspace。当前：' + esc((S.info && S.info.workspace) || "") + "</span></label>" +
      '<label class="dcol"><span>同时干活的成员数</span><input id="sPar" type="number" min="1" max="16" value="' + esc(s.maxParallel) + '" /></label>' +
      '<label class="dcol"><span>每轮最多步数</span><input id="sSteps" type="number" min="1" max="100" value="' + esc(s.maxSteps) + '" /></label></div></section>' +
      '<details class="dsec"' + (s.route ? " open" : "") + "><summary>自定义路由（可选，填了就覆盖上面的选择）</summary>" +
      '<div class="dgrid">' +
      '<label class="dcol wide2"><span>接口地址</span><input id="rUrl" placeholder="https://api.deepseek.com" value="' + esc(s.route ? s.route.baseURL : "") + '" /></label>' +
      '<label class="dcol"><span>模型</span><input id="rModel" value="' + esc(s.route ? s.route.model : "") + '" /></label>' +
      '<label class="dcol"><span>key</span><input id="rKey" type="password" placeholder="' + (s.route && s.route.hasKey ? "已保存，留空不改" : "") + '" /></label></div>' +
      '<div class="dim">key 以明文存在插件数据目录里，只用来请求你填的接口地址，不会显示在界面里。</div></details>' +
      '<div class="acts"><button type="button" id="sCancel">取消</button><button type="button" id="sSave" class="primary">保存</button></div></div></div>';
  }

  // ───────── 渲染 ─────────
  function paint() {
    const keep = { to: ($("msgTo") || {}).value, text: ($("msgText") || {}).value, focus: document.activeElement && document.activeElement.id, scroll: ($("main") || {}).scrollTop, sideScroll: ($("side") || {}).scrollTop };
    const L = S.list;
    $("app").innerHTML = '<header class="top"><div class="brand">AgentTeams</div><span class="dim" id="ws">' + esc(S.info ? S.info.workspace : "") + '</span><span class="sp"></span><button type="button" id="refresh">刷新</button><button type="button" id="settings">设置</button></header>' +
      (S.err ? '<div class="errbar">' + esc(S.err) + "</div>" : "") +
      '<div class="body"><aside id="side">' + viewSide() + '</aside><main id="main">' + (L && !L.teams.length && !L.archived.length ? viewEmpty() : S.id ? viewTeam() : '<div class="empty">选一个团队</div>') + "</main></div>" + viewDialog();
    if ($("msgTo") && keep.to) $("msgTo").value = keep.to;
    if ($("msgText") && keep.text) $("msgText").value = keep.text;
    if (keep.focus === "msgText" && $("msgText")) { const e = $("msgText"); e.focus(); e.setSelectionRange(e.value.length, e.value.length); }
    if ($("main") && keep.scroll) $("main").scrollTop = keep.scroll;
    if ($("side") && keep.sideScroll) $("side").scrollTop = keep.sideScroll;
    bind();
  }

  const act = (fn) => { S.err = ""; return fn().then(t => { if (t && t.id) S.team = t; return refresh(); }).catch(e => { S.err = e.message || String(e); paint(); }); };

  function bind() {
    const q = (sel, fn) => document.querySelectorAll(sel).forEach(fn);
    $("refresh").onclick = () => refresh(true);
    $("settings").onclick = () => rpc("at/settings").then(s => { S.dlg = { ...s, workspace: s.workspace }; paint(); });
    q("[data-team]", e => { e.onclick = () => { S.id = e.getAttribute("data-team"); S.team = null; S.editing = null; S.openTask = ""; paint(); load().then(() => { last = ""; paint(); }); }; });
    const ta = $("togArch"); if (ta) ta.onclick = () => { S.showArchived = !S.showArchived; paint(); };
    q("[data-act]", e => { e.onclick = () => {
      const a = e.getAttribute("data-act");
      if (a === "approve") act(() => rpc("at/approve", { id: S.id }));
      else if (a === "halt") act(() => rpc("at/halt", { id: S.id }));
      else if (a === "resume") act(() => rpc("at/resume", { id: S.id }));
      else if (a === "archive") act(() => rpc("at/archive", { id: S.id }).then(() => { S.id = ""; S.team = null; return null; }));
      else if (a === "restore") act(() => rpc("at/restore", { id: S.id }));
      else if (a === "delete") {
        if (e.getAttribute("data-sure") !== "1") { e.setAttribute("data-sure", "1"); e.textContent = "再点一次确认删除"; return; }
        act(() => rpc("at/delete", { id: S.id }).then(() => { S.id = ""; S.team = null; return null; }));
      } else if (a === "edit") {
        const t = S.team;
        S.editing = { description: t.description || "", members: t.members.map(m => ({ name: m.name, role: m.role || "", model: m.model || "", toolPolicy: m.toolPolicy || "full", prompt: m.executionPrompt })), tasks: t.tasks.map(k => ({ subject: k.subject, description: k.description || "", assignee: k.assignee || "", deps: (k.dependencies || []).map(id => (t.tasks.find(x => x.id === id) || {}).subject || id).join(", ") })) };
        paint();
      }
    }; });
    const aa = $("allowAll"); if (aa) aa.onchange = () => act(() => rpc("at/allow-all", { id: S.id, on: aa.checked }));
    q("[data-ap]", e => { e.onclick = () => rpc("at/approval", { id: e.getAttribute("data-ap"), allow: e.getAttribute("data-allow") === "1" }).then(() => load()).catch(x => { S.err = x.message; paint(); }); });
    q("tr.trow, .node", e => { e.onclick = () => { const id = e.getAttribute("data-task"); S.openTask = S.openTask === id ? "" : id; paint(); }; });
    q("[data-reassign]", e => { e.onchange = () => { if (!e.value) return; act(() => rpc("at/reassign", { id: S.id, taskId: e.getAttribute("data-reassign"), assignee: e.value === "__none" ? "" : e.value })); }; });
    q("[data-cancel]", e => { e.onclick = () => act(() => rpc("at/cancel-task", { id: S.id, taskId: e.getAttribute("data-cancel"), reason: "用户在页面里取消" })); });
    q("[data-rmmember]", e => { e.onclick = () => act(() => rpc("at/remove-member", { id: S.id, name: e.getAttribute("data-rmmember") })); });
    const send = $("msgSend");
    if (send) send.onclick = () => { const txt = $("msgText").value.trim(); if (!txt) return; act(() => rpc("at/send", { id: S.id, to: $("msgTo").value, content: txt })); };
    const mt = $("msgText"); if (mt) mt.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send.click(); } };
    const ms = $("msgs"); if (ms) ms.scrollTop = ms.scrollHeight;
    bindEditor();
    bindDialog();
  }

  function bindEditor() {
    const d = S.editing;
    if (!d) return;
    document.querySelectorAll("[data-m]").forEach(e => { e.oninput = e.onchange = () => { d.members[+e.getAttribute("data-m")][e.getAttribute("data-f")] = e.value; }; });
    document.querySelectorAll("[data-k]").forEach(e => { e.oninput = e.onchange = () => { d.tasks[+e.getAttribute("data-k")][e.getAttribute("data-f")] = e.value; }; });
    const sync = () => { d.description = $("edDesc").value; };
    $("edDesc").oninput = sync;
    $("addM").onclick = () => { sync(); d.members.push({ name: "", role: "", model: "", toolPolicy: "full" }); paint(); };
    $("addK").onclick = () => { sync(); d.tasks.push({ subject: "", description: "", assignee: "", deps: "" }); paint(); };
    document.querySelectorAll("[data-delm]").forEach(e => { e.onclick = () => { sync(); d.members.splice(+e.getAttribute("data-delm"), 1); paint(); }; });
    document.querySelectorAll("[data-delk]").forEach(e => { e.onclick = () => { sync(); d.tasks.splice(+e.getAttribute("data-delk"), 1); paint(); }; });
    $("edCancel").onclick = () => { S.editing = null; paint(); };
    $("edSave").onclick = () => {
      sync();
      const plan = {
        description: d.description,
        members: d.members.filter(m => m.name.trim()).map(m => ({ name: m.name.trim(), role: m.role, model: m.model, toolPolicy: m.toolPolicy, prompt: m.prompt })),
        tasks: d.tasks.filter(k => k.subject.trim()).map(k => ({ subject: k.subject.trim(), description: k.description, assignee: k.assignee || undefined, dependencies: k.deps.split(",").map(x => x.trim()).filter(Boolean).map(x => (/^\d+$/.test(x) ? Number(x) : x)) })),
      };
      act(() => rpc("at/edit-plan", { id: S.id, plan }).then(t => { S.editing = null; return t; }));
    };
  }

  function bindDialog() {
    if (!S.dlg) return;
    $("sCancel").onclick = () => { S.dlg = null; paint(); };
    $("modal").onclick = e => { if (e.target === $("modal")) { S.dlg = null; paint(); } };
    $("sSave").onclick = () => {
      const url = $("rUrl").value.trim();
      const pv = document.querySelector('input[name="pv"]:checked');
      const patch = { provider: pv ? pv.value : "", workspace: $("sWs").value.trim(), maxParallel: Number($("sPar").value) || 4, maxSteps: Number($("sSteps").value) || 30, route: url ? { provider: "custom", model: $("rModel").value.trim(), baseURL: url, apiKey: $("rKey").value } : null };
      rpc("at/settings/set", patch).then(() => { S.dlg = null; return refresh(true); }).catch(e => { S.err = e.message; paint(); });
    };
  }

  // ───────── 取数 ─────────
  let last = "";
  function load() {
    if (!S.id) return Promise.resolve();
    const id = S.id;
    return rpc("at/get", { id }).then(t => { if (id === S.id) { S.team = t; } }).catch(e => { if (id === S.id) { S.team = null; S.id = ""; S.err = e.message; } });
  }
  function refresh(force) {
    return Promise.all([rpc("at/list"), rpc("at/info")]).then(r => {
      S.list = r[0]; S.info = r[1];
      if (!S.id && S.list.teams.length) S.id = S.list.teams[0].id;
      return load();
    }).then(() => {
      // 编辑方案、弹窗、聚焦输入框的时候，后台轮询不重绘，免得打断你
      const typing = S.editing || S.dlg || (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && document.activeElement.id !== "msgText");
      const sig = JSON.stringify([S.list, S.team, S.err, S.id]);
      if (force || (!typing && sig !== last)) { last = sig; paint(); }
    }).catch(e => { S.err = e.message || String(e); paint(); });
  }

  paint();
  refresh(true);
  setInterval(() => { if (!document.hidden) refresh(); }, 2000);
})();
