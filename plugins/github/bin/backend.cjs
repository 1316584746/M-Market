"use strict";
/**
 * GitHub 管理台后台：仓库、文件（读 / 改 / 删）、分支、Issue、Pull Request、Actions、Release。
 * 令牌（PAT）只存在插件自己的数据目录里，不发给界面，也不进对话；所有请求都在这里发出。
 * 读写都有：写操作的工具在清单里标为「非只读」，界面上的危险操作（合并、删除）要二次确认。
 */
const { serve, settings } = require("./rpc.cjs");

const VERSION = require("../manifest.json").version;
const cfg = settings("settings.json");
const MAX_FILE = 1024 * 1024; // 在线编辑只处理 1 MB 以内的文本文件
const MAX_PATCH = 6000;

// ───────── 请求 ─────────

const apiBase = () => {
  const b = process.env.GITHUB_API_URL || cfg.get().apiBase || "https://api.github.com";
  return b.replace(/\/$/, "");
};
const token = () => cfg.get().token || "";

// ───────── 中英文：错误提示跟着界面语言走（界面每次调用都带 lang；AI 工具调用没带就用设置里存的，默认中文） ─────────
let LANG = "zh";
const m = (zh, en) => (LANG === "en" ? en : zh);
const LABELS = { 仓库名: "Repository name", 提交说明: "Commit message", 文件路径: "File path", "文件 sha": "File sha", 分支名: "Branch name", 来源分支: "Source branch", 标题: "Title", 评论内容: "Comment", 源分支: "Head branch", 目标分支: "Base branch", 工作流: "Workflow", 分支: "Branch", 标签: "Tag", 运行编号: "Run id", 发布编号: "Release id", 编号: "Number" };
const lbl = s => (LANG === "en" ? LABELS[s] || s : s);

function checkBase(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(m("API 地址不合法", "Invalid API URL"));
  }
  const local = u.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(u.hostname);
  if (u.protocol !== "https:" && !local) throw new Error(m("API 地址只支持 https", "The API URL must use https"));
  return u.toString().replace(/\/$/, "");
}

class GhError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function describe(status, j, rate) {
  let msg = j && typeof j.message === "string" ? j.message : "";
  if (j && Array.isArray(j.errors) && j.errors.length) {
    const d = j.errors.map(e => (typeof e === "string" ? e : e.message || [e.resource, e.field, e.code].filter(Boolean).join(" "))).filter(Boolean).join("；");
    if (d) msg += `（${d}）`;
  }
  const sep = LANG === "en" ? ": " : "：";
  if (status === 401) return m("令牌无效或已过期，请到「设置」里重新填写", "The token is invalid or expired. Enter a new one in Settings.");
  if (status === 403 && rate && rate.remaining === "0") return m(`触发了 GitHub 的速率限制${rate.reset ? "，" + new Date(+rate.reset * 1000).toLocaleTimeString() + " 后恢复" : ""}`, `GitHub rate limit reached${rate.reset ? "; resets at " + new Date(+rate.reset * 1000).toLocaleTimeString() : ""}`);
  if (status === 403) return m(`没有权限：${msg || "令牌缺少对应的权限（仓库操作要 repo，改工作流要 workflow）"}`, `Permission denied: ${msg || "the token lacks the required scope (repo for repositories, workflow for workflow files)"}`);
  if (status === 404) return m(`找不到（也可能是令牌没有这个仓库的访问权限）${msg && msg !== "Not Found" ? "：" + msg : ""}`, `Not found (or the token has no access to it)${msg && msg !== "Not Found" ? sep + msg : ""}`);
  if (status === 409) return m(`冲突：${msg || "内容已被别人改过，请刷新后重试"}`, `Conflict: ${msg || "the content was changed by someone else; refresh and try again"}`);
  if (status === 422) return m(`GitHub 拒绝了这个请求：${msg || "参数不对"}`, `GitHub rejected the request: ${msg || "invalid parameters"}`);
  return m(`GitHub 返回 ${status}${msg ? "：" + msg : ""}`, `GitHub returned ${status}${msg ? ": " + msg : ""}`);
}

async function request(method, p, { query, body, raw, needAuth = true } = {}) {
  const t = token();
  if (needAuth && !t) throw new Error(m("还没有登录：先到「设置」里填 GitHub 令牌", "Not signed in: enter a GitHub token first"));
  const u = new URL(apiBase() + p);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  const res = await fetch(u, {
    method,
    headers: {
      accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "m-market-github/" + VERSION,
      ...(t ? { authorization: `Bearer ${t}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const textBody = buf.toString("utf8");
  const rate = { remaining: res.headers.get("x-ratelimit-remaining"), reset: res.headers.get("x-ratelimit-reset") };
  if (!res.ok) {
    let j = null;
    try {
      j = JSON.parse(textBody);
    } catch {
      /* 非 JSON */
    }
    throw new GhError(res.status, describe(res.status, j, rate));
  }
  const link = res.headers.get("link") || "";
  const hasNext = /rel="next"/.test(link);
  if (res.status === 204 || !textBody) return { data: null, hasNext };
  if (raw) return { data: textBody, hasNext };
  try {
    return { data: JSON.parse(textBody), hasNext };
  } catch {
    return { data: textBody, hasNext };
  }
}
const get = (p, o) => request("GET", p, o);

// ───────── 参数校验 ─────────

const repoOf = r => {
  const s = String(r ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) throw new Error(m("仓库要写成 所有者/仓库名", "Write the repository as owner/name"));
  return s;
};
const intOf = (n, label = "编号") => {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0) throw new Error(m(`${label}不合法`, `Invalid ${lbl(label).toLowerCase()}`));
  return v;
};
const pathOf = p => {
  const s = String(p ?? "").replace(/^\/+/, "");
  if (s.split("/").some(x => x === ".." || x === ".")) throw new Error(m("路径不合法", "Invalid path"));
  return s.split("/").map(encodeURIComponent).join("/");
};
const need = (v, label) => {
  const s = String(v ?? "").trim();
  if (!s) throw new Error(m(`${label}不能为空`, `${lbl(label)} is required`));
  return s;
};
const pageOf = p => Math.max(1, Math.min(1000, Number(p) || 1));
const PER = 30;
const clip = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "\n…" + m("（已截断）", " (truncated)") : s || "");

// ───────── 数据整形（只留界面和 AI 需要的字段） ─────────

const userOf = u => (u ? { login: u.login, avatar: u.avatar_url } : null);
const repoShape = r => ({ full: r.full_name, name: r.name, owner: r.owner?.login, private: !!r.private, fork: !!r.fork, archived: !!r.archived, description: r.description || "", language: r.language || "", stars: r.stargazers_count ?? 0, forks: r.forks_count ?? 0, issues: r.open_issues_count ?? 0, updated: r.pushed_at || r.updated_at, created: r.created_at, branch: r.default_branch, url: r.html_url, permissions: r.permissions ? { push: !!r.permissions.push, admin: !!r.permissions.admin } : undefined });
const labelsOf = l => (Array.isArray(l) ? l.map(x => (typeof x === "string" ? { name: x } : { name: x.name, color: x.color })) : []);
const issueShape = i => ({ number: i.number, title: i.title, state: i.state, body: i.body || "", user: userOf(i.user), labels: labelsOf(i.labels), comments: i.comments ?? 0, created: i.created_at, updated: i.updated_at, url: i.html_url, assignees: (i.assignees || []).map(a => a.login), isPull: !!i.pull_request });
const commentShape = c => ({ id: c.id, user: userOf(c.user), body: c.body || "", created: c.created_at, url: c.html_url });
const pullShape = p => ({ number: p.number, title: p.title, state: p.merged_at || p.merged ? "merged" : p.state, draft: !!p.draft, body: p.body || "", user: userOf(p.user), head: p.head?.ref, headRepo: p.head?.repo?.full_name, base: p.base?.ref, labels: labelsOf(p.labels), comments: (p.comments ?? 0) + (p.review_comments ?? 0), commits: p.commits, additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files, mergeable: p.mergeable, mergeableState: p.mergeable_state, created: p.created_at, updated: p.updated_at, url: p.html_url });
const runShape = r => ({ id: r.id, name: r.name || r.display_title, title: r.display_title, status: r.status, conclusion: r.conclusion, branch: r.head_branch, sha: (r.head_sha || "").slice(0, 7), event: r.event, actor: r.actor?.login, number: r.run_number, attempt: r.run_attempt, created: r.created_at, updated: r.updated_at, url: r.html_url });
const releaseShape = r => ({ id: r.id, tag: r.tag_name, name: r.name || "", body: r.body || "", draft: !!r.draft, prerelease: !!r.prerelease, target: r.target_commitish, author: r.author?.login, created: r.created_at, published: r.published_at, url: r.html_url, assets: (r.assets || []).map(a => ({ name: a.name, size: a.size, downloads: a.download_count })) });

// ───────── 登录 ─────────

async function whoami() {
  const { data } = await get("/user");
  return { login: data.login, name: data.name || "", avatar: data.avatar_url, url: data.html_url };
}

const methods = {
  "gh/status": async () => {
    const out = { hasToken: !!token(), apiBase: apiBase(), lang: cfg.get().lang || "" };
    if (!out.hasToken) return out;
    try {
      out.user = await whoami();
    } catch (e) {
      out.error = e.message;
    }
    return out;
  },
  "gh/login": async p => {
    const t = String(p?.token ?? "").trim();
    const patch = {};
    if (typeof p?.apiBase === "string") patch.apiBase = p.apiBase.trim() ? checkBase(p.apiBase.trim()) : "";
    const prev = cfg.get();
    if (t) {
      if (/\s/.test(t) || t.length < 20 || t.length > 400) throw new Error(m("令牌格式不对", "Invalid token format"));
      patch.token = t;
    }
    cfg.set(patch);
    try {
      const user = await whoami();
      return { user, apiBase: apiBase() };
    } catch (e) {
      cfg.set({ token: prev.token || "", apiBase: prev.apiBase || "" }); // 验证不过就退回原来的
      throw e;
    }
  },
  "gh/logout": async () => {
    const c = cfg.get();
    cfg.set({ ...c, token: "" });
    return { ok: true };
  },

  // 仓库
  "gh/repos": async p => {
    const q = String(p?.q ?? "").trim();
    if (q && p?.search) {
      const r = await get("/search/repositories", { query: { q, per_page: PER, page: pageOf(p.page) } });
      return { items: (r.data.items || []).map(repoShape), hasNext: r.hasNext, page: pageOf(p.page) };
    }
    // scope：all 全部 / starred 已加星标 / owned 我自己的 / archived 已归档；sort：pushed 最近活跃 / name 名称 / stars 星标数 / created 创建时间
    const scope = ["all", "starred", "owned", "archived"].includes(p?.scope) ? p.scope : "all";
    const r =
      scope === "starred"
        ? await get("/user/starred", { query: { per_page: 100, page: pageOf(p?.page) } })
        : await get("/user/repos", { query: { per_page: 100, page: pageOf(p?.page), sort: "pushed", affiliation: scope === "owned" ? "owner" : "owner,collaborator,organization_member" } });
    let items = r.data.map(repoShape);
    if (scope === "archived") items = items.filter(x => x.archived);
    if (q) items = items.filter(x => `${x.full} ${x.description}`.toLowerCase().includes(q.toLowerCase()));
    const sort = ["pushed", "name", "stars", "created"].includes(p?.sort) ? p.sort : "pushed";
    const key = { pushed: x => x.updated || "", name: x => x.name.toLowerCase(), stars: x => x.stars, created: x => x.created || "" }[sort];
    const dir = p?.dir === "asc" ? 1 : -1;
    if (sort !== "pushed" || dir === 1) items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * dir);
    return { items, hasNext: r.hasNext, page: pageOf(p?.page) };
  },
  // 跨仓库的「我的 Issue / PR」：kind=issues|pulls；filter=assigned 指派给我 / created 我创建的 / mentioned 提到我的 / review 等我评审（只对 PR）
  "gh/myWork": async p => {
    const kind = p?.kind === "pulls" ? "pulls" : "issues";
    const filter = ["assigned", "created", "mentioned", "review"].includes(p?.filter) ? p.filter : kind === "pulls" ? "created" : "assigned";
    const state = ["open", "closed", "all"].includes(p?.state) ? p.state : "open";
    const who = { assigned: "assignee:@me", created: "author:@me", mentioned: "mentions:@me", review: "review-requested:@me" }[filter];
    const q = [kind === "pulls" ? "is:pr" : "is:issue", state === "all" ? "" : "is:" + state, who, "archived:false"].filter(Boolean).join(" ");
    const r = await get("/search/issues", { query: { q, sort: "updated", order: "desc", per_page: PER, page: pageOf(p?.page) } });
    const items = (r.data.items || []).map(i => ({ ...issueShape(i), repo: String(i.repository_url || "").split("/repos/")[1] || "", state: i.pull_request?.merged_at ? "merged" : i.state, draft: !!i.draft }));
    return { items, hasNext: r.hasNext, total: r.data.total_count ?? items.length };
  },
  // 通知（GitHub 的「待办」）；经典令牌需要 notifications 权限
  "gh/notifications": async p => {
    const r = await get("/notifications", { query: { all: p?.all ? "true" : "false", per_page: PER, page: pageOf(p?.page) } });
    const items = r.data.map(n => ({
      id: n.id,
      title: n.subject?.title || "",
      type: n.subject?.type || "",
      number: Number(/\/(?:issues|pulls)\/(\d+)$/.exec(n.subject?.url || "")?.[1]) || 0,
      repo: n.repository?.full_name || "",
      reason: n.reason,
      unread: !!n.unread,
      updated: n.updated_at,
    }));
    return { items, hasNext: r.hasNext };
  },
  "gh/markRead": async p => {
    if (p?.id) await request("PATCH", `/notifications/threads/${encodeURIComponent(String(p.id))}`);
    else await request("PUT", "/notifications", { body: {} });
    return { ok: true };
  },
  "gh/setLang": async p => {
    const lang = p?.lang === "en" ? "en" : "zh";
    cfg.set({ lang });
    return { lang };
  },
  "gh/repo": async p => {
    const repo = repoOf(p?.repo);
    const [info, br] = await Promise.all([get(`/repos/${repo}`), get(`/repos/${repo}/branches`, { query: { per_page: 100 } })]);
    return { ...repoShape(info.data), branches: br.data.map(b => ({ name: b.name, protected: !!b.protected })) };
  },
  "gh/createRepo": async p => {
    const name = need(p?.name, "仓库名");
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(m("仓库名只能含字母、数字、-、_、.", "Repository names may only contain letters, digits, -, _ and ."));
    const r = await request("POST", "/user/repos", { body: { name, description: String(p?.description ?? ""), private: p?.private !== false, auto_init: p?.autoInit === true } });
    return repoShape(r.data);
  },

  // 文件
  "gh/contents": async p => {
    const repo = repoOf(p?.repo);
    const r = await get(`/repos/${repo}/contents/${pathOf(p?.path)}`, { query: { ref: p?.ref } });
    if (Array.isArray(r.data)) {
      const items = r.data.map(f => ({ name: f.name, path: f.path, type: f.type, size: f.size, sha: f.sha })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      return { type: "dir", items };
    }
    if (r.data.type !== "file") return { type: r.data.type, name: r.data.name, path: r.data.path };
    if (r.data.size > MAX_FILE) return { type: "file", name: r.data.name, path: r.data.path, size: r.data.size, sha: r.data.sha, tooLarge: true };
    const buf = Buffer.from(r.data.content || "", "base64");
    if (buf.includes(0)) return { type: "file", name: r.data.name, path: r.data.path, size: r.data.size, sha: r.data.sha, binary: true };
    return { type: "file", name: r.data.name, path: r.data.path, size: r.data.size, sha: r.data.sha, text: buf.toString("utf8"), url: r.data.html_url };
  },
  "gh/putFile": async p => {
    const repo = repoOf(p?.repo);
    const body = { message: need(p?.message, "提交说明"), content: Buffer.from(String(p?.content ?? ""), "utf8").toString("base64") };
    if (p?.branch) body.branch = String(p.branch);
    if (p?.sha) body.sha = String(p.sha);
    const r = await request("PUT", `/repos/${repo}/contents/${pathOf(need(p?.path, "文件路径"))}`, { body });
    return { sha: r.data.content?.sha, commit: r.data.commit?.sha?.slice(0, 7), url: r.data.commit?.html_url };
  },
  "gh/deleteFile": async p => {
    const repo = repoOf(p?.repo);
    const body = { message: need(p?.message, "提交说明"), sha: need(p?.sha, "文件 sha") };
    if (p?.branch) body.branch = String(p.branch);
    const r = await request("DELETE", `/repos/${repo}/contents/${pathOf(need(p?.path, "文件路径"))}`, { body });
    return { commit: r.data.commit?.sha?.slice(0, 7) };
  },
  "gh/commits": async p => {
    const repo = repoOf(p?.repo);
    const r = await get(`/repos/${repo}/commits`, { query: { sha: p?.ref, path: p?.path, per_page: PER, page: pageOf(p?.page) } });
    return { items: r.data.map(c => ({ sha: c.sha.slice(0, 7), message: (c.commit.message || "").split("\n")[0], author: c.author?.login || c.commit.author?.name, date: c.commit.author?.date, url: c.html_url })), hasNext: r.hasNext };
  },

  // 分支
  "gh/branches": async p => {
    const repo = repoOf(p?.repo);
    const r = await get(`/repos/${repo}/branches`, { query: { per_page: 100, page: pageOf(p?.page) } });
    return { items: r.data.map(b => ({ name: b.name, protected: !!b.protected, sha: b.commit?.sha?.slice(0, 7) })), hasNext: r.hasNext };
  },
  "gh/createBranch": async p => {
    const repo = repoOf(p?.repo);
    const name = need(p?.name, "分支名");
    if (/[\s~^:?*[\\]|\.\.|\/\/|^\/|\/$|\.lock$/.test(name)) throw new Error(m("分支名不合法", "Invalid branch name"));
    const from = need(p?.from, "来源分支");
    const base = await get(`/repos/${repo}/git/ref/heads/${pathOf(from)}`);
    await request("POST", `/repos/${repo}/git/refs`, { body: { ref: `refs/heads/${name}`, sha: base.data.object.sha } });
    return { name };
  },
  "gh/deleteBranch": async p => {
    const repo = repoOf(p?.repo);
    await request("DELETE", `/repos/${repo}/git/refs/heads/${pathOf(need(p?.name, "分支名"))}`);
    return { ok: true };
  },

  // Issue
  "gh/issues": async p => {
    const repo = repoOf(p?.repo);
    const state = ["open", "closed", "all"].includes(p?.state) ? p.state : "open";
    const q = String(p?.q ?? "").trim();
    if (q) {
      const r = await get("/search/issues", { query: { q: `repo:${repo} is:issue ${state === "all" ? "" : "is:" + state} ${q}`.replace(/\s+/g, " "), per_page: PER, page: pageOf(p?.page) } });
      return { items: (r.data.items || []).map(issueShape), hasNext: r.hasNext };
    }
    const r = await get(`/repos/${repo}/issues`, { query: { state, per_page: PER, page: pageOf(p?.page), labels: p?.labels } });
    return { items: r.data.filter(i => !i.pull_request).map(issueShape), hasNext: r.hasNext };
  },
  "gh/issue": async p => {
    const repo = repoOf(p?.repo);
    const n = intOf(p?.number);
    const [i, c] = await Promise.all([get(`/repos/${repo}/issues/${n}`), get(`/repos/${repo}/issues/${n}/comments`, { query: { per_page: 100 } })]);
    return { ...issueShape(i.data), commentList: c.data.map(commentShape) };
  },
  "gh/createIssue": async p => {
    const repo = repoOf(p?.repo);
    const body = { title: need(p?.title, "标题"), body: String(p?.body ?? "") };
    if (Array.isArray(p?.labels) && p.labels.length) body.labels = p.labels.map(String);
    if (Array.isArray(p?.assignees) && p.assignees.length) body.assignees = p.assignees.map(String);
    const r = await request("POST", `/repos/${repo}/issues`, { body });
    return issueShape(r.data);
  },
  "gh/updateIssue": async p => {
    const repo = repoOf(p?.repo);
    const body = {};
    if (typeof p?.title === "string") body.title = need(p.title, "标题");
    if (typeof p?.body === "string") body.body = p.body;
    if (p?.state === "open" || p?.state === "closed") body.state = p.state;
    if (p?.stateReason) body.state_reason = String(p.stateReason);
    if (Array.isArray(p?.labels)) body.labels = p.labels.map(String);
    if (!Object.keys(body).length) throw new Error(m("没有要改的内容", "Nothing to change"));
    const r = await request("PATCH", `/repos/${repo}/issues/${intOf(p?.number)}`, { body });
    return issueShape(r.data);
  },
  "gh/comment": async p => {
    const repo = repoOf(p?.repo);
    const r = await request("POST", `/repos/${repo}/issues/${intOf(p?.number)}/comments`, { body: { body: need(p?.body, "评论内容") } });
    return commentShape(r.data);
  },
  "gh/labels": async p => {
    const r = await get(`/repos/${repoOf(p?.repo)}/labels`, { query: { per_page: 100 } });
    return { items: r.data.map(l => ({ name: l.name, color: l.color })) };
  },

  // Pull Request
  "gh/pulls": async p => {
    const repo = repoOf(p?.repo);
    const state = ["open", "closed", "all"].includes(p?.state) ? p.state : "open";
    const r = await get(`/repos/${repo}/pulls`, { query: { state, per_page: PER, page: pageOf(p?.page) } });
    return { items: r.data.map(pullShape), hasNext: r.hasNext };
  },
  "gh/pull": async p => {
    const repo = repoOf(p?.repo);
    const n = intOf(p?.number);
    const [pr, files, comments, reviews] = await Promise.all([get(`/repos/${repo}/pulls/${n}`), get(`/repos/${repo}/pulls/${n}/files`, { query: { per_page: 100 } }), get(`/repos/${repo}/issues/${n}/comments`, { query: { per_page: 100 } }), get(`/repos/${repo}/pulls/${n}/reviews`, { query: { per_page: 100 } })]);
    return {
      ...pullShape(pr.data),
      files: files.data.map(f => ({ name: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: clip(f.patch, MAX_PATCH) })),
      commentList: comments.data.map(commentShape),
      reviews: reviews.data.filter(r => r.state !== "PENDING").map(r => ({ user: userOf(r.user), state: r.state, body: r.body || "", submitted: r.submitted_at })),
    };
  },
  "gh/createPull": async p => {
    const repo = repoOf(p?.repo);
    const r = await request("POST", `/repos/${repo}/pulls`, { body: { title: need(p?.title, "标题"), head: need(p?.head, "源分支"), base: need(p?.base, "目标分支"), body: String(p?.body ?? ""), draft: p?.draft === true } });
    return pullShape(r.data);
  },
  "gh/updatePull": async p => {
    const repo = repoOf(p?.repo);
    const body = {};
    if (typeof p?.title === "string") body.title = need(p.title, "标题");
    if (typeof p?.body === "string") body.body = p.body;
    if (p?.state === "open" || p?.state === "closed") body.state = p.state;
    if (typeof p?.base === "string" && p.base) body.base = p.base;
    if (!Object.keys(body).length) throw new Error(m("没有要改的内容", "Nothing to change"));
    const r = await request("PATCH", `/repos/${repo}/pulls/${intOf(p?.number)}`, { body });
    return pullShape(r.data);
  },
  "gh/mergePull": async p => {
    const repo = repoOf(p?.repo);
    const method = ["merge", "squash", "rebase"].includes(p?.method) ? p.method : "merge";
    const body = { merge_method: method };
    if (p?.title) body.commit_title = String(p.title);
    if (p?.message) body.commit_message = String(p.message);
    const r = await request("PUT", `/repos/${repo}/pulls/${intOf(p?.number)}/merge`, { body });
    return { merged: !!r.data?.merged, sha: r.data?.sha?.slice(0, 7), message: r.data?.message };
  },
  "gh/reviewPull": async p => {
    const repo = repoOf(p?.repo);
    const event = ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(p?.event) ? p.event : "COMMENT";
    if (event !== "APPROVE" && !String(p?.body ?? "").trim()) throw new Error(m("评审内容不能为空", "A review comment is required"));
    const r = await request("POST", `/repos/${repo}/pulls/${intOf(p?.number)}/reviews`, { body: { event, body: String(p?.body ?? "") } });
    return { state: r.data.state };
  },

  // Actions
  "gh/workflows": async p => {
    const r = await get(`/repos/${repoOf(p?.repo)}/actions/workflows`, { query: { per_page: 100 } });
    return { items: (r.data.workflows || []).map(w => ({ id: w.id, name: w.name, path: w.path, state: w.state })) };
  },
  "gh/runs": async p => {
    const repo = repoOf(p?.repo);
    const r = await get(`/repos/${repo}/actions/runs`, { query: { per_page: PER, page: pageOf(p?.page), branch: p?.branch, status: p?.status } });
    return { items: (r.data.workflow_runs || []).map(runShape), hasNext: r.hasNext };
  },
  "gh/runJobs": async p => {
    const r = await get(`/repos/${repoOf(p?.repo)}/actions/runs/${intOf(p?.id, "运行编号")}/jobs`, { query: { per_page: 100 } });
    return { items: (r.data.jobs || []).map(j => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, started: j.started_at, completed: j.completed_at, steps: (j.steps || []).map(s => ({ name: s.name, status: s.status, conclusion: s.conclusion })) })) };
  },
  "gh/rerun": async p => {
    const repo = repoOf(p?.repo);
    const id = intOf(p?.id, "运行编号");
    await request("POST", `/repos/${repo}/actions/runs/${id}/${p?.failedOnly ? "rerun-failed-jobs" : "rerun"}`);
    return { ok: true };
  },
  "gh/cancelRun": async p => {
    await request("POST", `/repos/${repoOf(p?.repo)}/actions/runs/${intOf(p?.id, "运行编号")}/cancel`);
    return { ok: true };
  },
  "gh/dispatch": async p => {
    const repo = repoOf(p?.repo);
    const wf = need(p?.workflow, "工作流");
    const body = { ref: need(p?.ref, "分支") };
    if (p?.inputs && typeof p.inputs === "object") body.inputs = p.inputs;
    await request("POST", `/repos/${repo}/actions/workflows/${encodeURIComponent(wf)}/dispatches`, { body });
    return { ok: true };
  },

  // Release
  "gh/releases": async p => {
    const r = await get(`/repos/${repoOf(p?.repo)}/releases`, { query: { per_page: PER, page: pageOf(p?.page) } });
    return { items: r.data.map(releaseShape), hasNext: r.hasNext };
  },
  "gh/createRelease": async p => {
    const repo = repoOf(p?.repo);
    const body = { tag_name: need(p?.tag, "标签"), name: String(p?.name ?? ""), body: String(p?.body ?? ""), draft: p?.draft === true, prerelease: p?.prerelease === true };
    if (p?.target) body.target_commitish = String(p.target);
    if (p?.generateNotes === true) body.generate_release_notes = true;
    const r = await request("POST", `/repos/${repo}/releases`, { body });
    return releaseShape(r.data);
  },
  "gh/deleteRelease": async p => {
    await request("DELETE", `/repos/${repoOf(p?.repo)}/releases/${intOf(p?.id, "发布编号")}`);
    return { ok: true };
  },
};

// ───────── AI 工具 ─────────

const S = { type: "string" };
const repoProp = { type: "string", description: "仓库，写成 所有者/仓库名" };
const tool = (name, description, readOnly, properties, required, run) => ({ name, description, readOnly, inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) }, run });
const viaMethod = (m, map = a => a) => a => methods[m](map(a));

const tools = [
  tool("github_repos", "列出我的 GitHub 仓库，或用 query 搜索（search=true 时搜全站）。", true, { query: S, search: { type: "boolean" } }, [], async a => (await methods["gh/repos"]({ q: a.query, search: a.search })).items.slice(0, 40)),
  tool("github_read", "读取仓库里的目录列表或文本文件内容。path 留空 = 根目录。", true, { repo: repoProp, path: S, ref: { ...S, description: "分支 / 标签 / 提交，默认分支" } }, ["repo"], viaMethod("gh/contents")),
  tool("github_commits", "查看提交历史。", true, { repo: repoProp, ref: S, path: S }, ["repo"], async a => (await methods["gh/commits"](a)).items),
  tool("github_issues", "列出 Issue（不含 PR），state 为 open / closed / all，可用 query 搜索。", true, { repo: repoProp, state: S, query: S }, ["repo"], async a => (await methods["gh/issues"]({ ...a, q: a.query })).items.map(i => ({ number: i.number, title: i.title, state: i.state, user: i.user?.login, labels: i.labels.map(l => l.name), comments: i.comments, updated: i.updated }))),
  tool("github_issue", "查看一个 Issue 的内容和评论。", true, { repo: repoProp, number: { type: "number" } }, ["repo", "number"], viaMethod("gh/issue")),
  tool("github_pulls", "列出 Pull Request。", true, { repo: repoProp, state: S }, ["repo"], async a => (await methods["gh/pulls"](a)).items.map(p => ({ number: p.number, title: p.title, state: p.state, draft: p.draft, user: p.user?.login, head: p.head, base: p.base, updated: p.updated }))),
  tool("github_pull", "查看一个 Pull Request：描述、改动文件（含 diff）、评论、评审。", true, { repo: repoProp, number: { type: "number" } }, ["repo", "number"], viaMethod("gh/pull")),
  tool("github_runs", "查看 GitHub Actions 的运行记录。", true, { repo: repoProp, branch: S, status: S }, ["repo"], async a => (await methods["gh/runs"](a)).items),
  tool("github_issue_create", "新建 Issue。", false, { repo: repoProp, title: S, body: S, labels: { type: "array", items: S } }, ["repo", "title"], viaMethod("gh/createIssue")),
  tool("github_issue_update", "修改 Issue：标题、正文、标签，或关闭 / 重开（state=closed|open）。", false, { repo: repoProp, number: { type: "number" }, title: S, body: S, state: S, labels: { type: "array", items: S } }, ["repo", "number"], viaMethod("gh/updateIssue")),
  tool("github_comment", "给 Issue 或 Pull Request 加评论。", false, { repo: repoProp, number: { type: "number" }, body: S }, ["repo", "number", "body"], viaMethod("gh/comment")),
  tool("github_pull_create", "新建 Pull Request。", false, { repo: repoProp, title: S, head: { ...S, description: "源分支（跨仓库写 用户:分支）" }, base: S, body: S, draft: { type: "boolean" } }, ["repo", "title", "head", "base"], viaMethod("gh/createPull")),
  tool("github_pull_merge", "合并 Pull Request。会改动目标分支，只在用户明确要求时调用。method：merge / squash / rebase。", false, { repo: repoProp, number: { type: "number" }, method: S }, ["repo", "number"], viaMethod("gh/mergePull")),
  tool("github_pull_review", "评审 Pull Request：event 为 APPROVE / REQUEST_CHANGES / COMMENT。", false, { repo: repoProp, number: { type: "number" }, event: S, body: S }, ["repo", "number", "event"], viaMethod("gh/reviewPull")),
  tool("github_file_write", "创建或修改仓库里的一个文本文件（直接提交）。修改已有文件要带 sha（先用 github_read 取到）。", false, { repo: repoProp, path: S, content: S, message: S, branch: S, sha: S }, ["repo", "path", "content", "message"], viaMethod("gh/putFile")),
  tool("github_branch_create", "从已有分支新建分支。", false, { repo: repoProp, name: S, from: S }, ["repo", "name", "from"], viaMethod("gh/createBranch")),
  tool("github_run_rerun", "重新运行一次 Actions（failedOnly=true 只重跑失败的任务）。", false, { repo: repoProp, id: { type: "number" }, failedOnly: { type: "boolean" } }, ["repo", "id"], viaMethod("gh/rerun")),
  tool("github_release_create", "创建 Release（会创建标签，draft=true 先存草稿）。", false, { repo: repoProp, tag: S, name: S, body: S, target: S, draft: { type: "boolean" }, prerelease: { type: "boolean" } }, ["repo", "tag"], viaMethod("gh/createRelease")),
];

// 每次调用先确定语言：界面传 lang 就用它；AI 工具调用没传，就用设置里存的（默认中文）
for (const name of Object.keys(methods)) {
  const fn = methods[name];
  methods[name] = async p => {
    LANG = p?.lang === "en" || p?.lang === "zh" ? p.lang : cfg.get().lang === "en" ? "en" : "zh";
    return fn(p);
  };
}

serve({ id: "github", version: VERSION, methods, tools });
