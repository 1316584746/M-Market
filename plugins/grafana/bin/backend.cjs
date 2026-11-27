"use strict";
/**
 * Grafana 只读控制台：连接用户自己的 Grafana，查看组织 / 健康、告警、仪表盘和注释。
 * 服务账号令牌只存在插件数据目录里，不回传给界面，也不写进工具结果。
 * 不跟随重定向，避免把令牌送到别的主机。不会修改告警规则或仪表盘。
 */
const { serve, settings } = require("./rpc.cjs");

const VERSION = require("../manifest.json").version;
const cfg = settings();
const MAX_BODY = 2 * 1024 * 1024;

function token() {
  return String(cfg.get().token || "");
}

function scrub(s, extra) {
  let out = String(s ?? "");
  for (const t of [token(), extra]) if (t) out = out.split(String(t)).join("***");
  return out;
}

class GfError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isPrivateHost(hostname) {
  const h = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if ([a, b, Number(m[3]), Number(m[4])].some(n => n > 255)) return false;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** 公网必须 https；本机和局域网允许 http（自建 Grafana 很常见）。拒绝把账号写进地址。 */
function checkBase(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    throw new Error("地址不合法");
  }
  if (u.username || u.password) throw new Error("不要把账号密码写在地址里，令牌单独填写");
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("地址只支持 http 或 https");
  if (u.protocol === "http:" && !isPrivateHost(u.hostname)) throw new Error("公网地址请用 https；http 只允许本机或局域网");
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

function apiUrl(base, pathname, query) {
  const root = new URL(checkBase(base));
  const rel = String(pathname || "");
  if (!rel.startsWith("/") || rel.includes("..") || rel.includes("\\") || rel.includes("\0")) throw new Error("路径不合法");
  const prefix = root.pathname.replace(/\/$/, "");
  root.pathname = prefix + rel;
  root.search = "";
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") root.searchParams.set(k, String(v));
  return root;
}

function httpError(status, data, pathname, tok) {
  const msg = data && typeof data.message === "string" ? scrub(data.message, tok) : "";
  if (status === 401) return new GfError(status, "令牌无效或已过期");
  if (status === 403) return new GfError(status, "令牌没有权限：" + (msg || "查看仪表盘和告警需要 Viewer"));
  if (status === 404) {
    const hint = pathname === "/api/org" ? "这个地址上没有 Grafana 的 /api/org。如果挂在子路径（例如 /grafana），请把子路径一起写上" : "找不到接口" + (msg ? "：" + msg : "");
    return new GfError(status, hint);
  }
  return new GfError(status, "Grafana 返回 " + status + (msg ? "：" + msg : ""));
}

async function readJson(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BODY) throw new Error("Grafana 返回的内容太大");
  const text = buf.toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Grafana 返回的不是 JSON");
  }
}

async function call(base, tok, pathname, query) {
  if (!tok) throw new Error("还没有连接：先到「连接」里填写地址和令牌");
  const u = apiUrl(base, pathname, query);
  let res;
  try {
    res = await fetch(u, {
      headers: { accept: "application/json", authorization: "Bearer " + tok, "user-agent": "m-market-grafana/" + VERSION },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    const name = e && e.name;
    throw new Error(name === "TimeoutError" || name === "AbortError" ? "连接 Grafana 超时" : "连不上 Grafana，请检查地址是否可达");
  }
  if (res.status >= 300 && res.status < 400) throw new Error("Grafana 返回了重定向，已拒绝跟随，避免把令牌送到别的地址");
  const data = await readJson(res);
  if (!res.ok) throw httpError(res.status, data, pathname, tok);
  return data;
}

function savedBase() {
  const url = cfg.get().url;
  if (!url) throw new Error("还没有连接：先到「连接」里填写地址和令牌");
  return checkBase(url);
}

const authed = (pathname, query) => call(savedBase(), token(), pathname, query);

function shape(org, health, url) {
  return {
    connected: true,
    hasToken: true,
    url,
    org: org && org.name != null ? String(org.name) : "",
    version: health && health.version != null ? String(health.version) : "",
    database: health && health.database != null ? String(health.database) : "",
  };
}

async function status() {
  const url = cfg.get().url ? checkBase(cfg.get().url) : "";
  const hasToken = !!token();
  if (!url || !hasToken) return { connected: false, hasToken, url };
  try {
    const org = await call(url, token(), "/api/org");
    let health = null;
    try {
      health = await call(url, token(), "/api/health");
    } catch {
      health = null;
    }
    return shape(org, health, url);
  } catch (e) {
    return { connected: false, hasToken: true, url, error: scrub(e.message) };
  }
}

function checkToken(raw) {
  const t = String(raw || "").trim();
  if (t.length < 8 || t.length > 4096 || /[\r\n]/.test(t)) throw new Error("令牌格式不对：粘贴 Grafana 服务账号令牌（或原来的 API Key）");
  return t;
}

async function connect({ url, token: incoming }) {
  const nextUrl = checkBase(url);
  const nextToken = checkToken(String(incoming || "").trim() || token());
  const org = await call(nextUrl, nextToken, "/api/org");
  if (!org || typeof org !== "object" || (org.name == null && org.id == null)) throw new Error("这个地址没有返回 Grafana 的组织信息");
  let health = null;
  try {
    health = await call(nextUrl, nextToken, "/api/health");
  } catch {
    health = null;
  }
  cfg.set({ url: nextUrl, token: nextToken });
  return shape(org, health, nextUrl);
}

function disconnect() {
  cfg.set({ url: "", token: "" });
  return { connected: false, hasToken: false, url: "" };
}

function dashUrl(item) {
  const base = new URL(savedBase());
  const prefix = base.pathname.replace(/\/$/, "");
  const raw = String(item.url || "");
  if (raw.startsWith("/") && !raw.startsWith("//") && (!prefix || raw === prefix || raw.startsWith(prefix + "/"))) return base.origin + raw;
  return base.origin + prefix + "/d/" + encodeURIComponent(String(item.uid || ""));
}

async function dashboards({ query } = {}) {
  const q = String(query || "").trim().slice(0, 200);
  const data = await authed("/api/search", { type: "dash-db", limit: 50, query: q });
  if (!Array.isArray(data)) throw new Error("Grafana 返回的仪表盘列表无法识别");
  return {
    items: data.slice(0, 50).filter(x => x && x.uid).map(x => ({
      uid: String(x.uid),
      title: String(x.title || "（无标题）"),
      folder: String(x.folderTitle || ""),
      url: dashUrl(x),
      tags: Array.isArray(x.tags) ? x.tags.slice(0, 8).map(t => String(t)) : [],
    })),
  };
}

function walkPanels(list, out) {
  for (const p of list || []) {
    if (out.length >= 80) return;
    if (!p || typeof p !== "object") continue;
    if (p.type === "row") {
      walkPanels(p.panels, out);
      continue;
    }
    out.push({ title: String(p.title || "（无标题）"), type: String(p.type || "") });
    if (p.panels) walkPanels(p.panels, out);
  }
}

function uidOf(raw) {
  const uid = String(raw || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(uid)) throw new Error("仪表盘 uid 不合法");
  return uid;
}

async function dashboard({ uid } = {}) {
  const id = uidOf(uid);
  const data = await authed("/api/dashboards/uid/" + id);
  const dash = data && data.dashboard;
  if (!dash || typeof dash !== "object") throw new Error("Grafana 没有返回这个仪表盘");
  const panels = [];
  walkPanels(dash.panels, panels);
  return {
    uid: String(dash.uid || id),
    title: String(dash.title || "（无标题）"),
    folder: data.meta && data.meta.folderTitle ? String(data.meta.folderTitle) : "",
    url: dashUrl({ uid: dash.uid || id, url: data.meta && data.meta.url }),
    panels,
  };
}

const STATE_RANK = { active: 0, alerting: 0, pending: 1, no_data: 2, suppressed: 3, paused: 4, ok: 5 };

function normAlert(a) {
  if (a && (a.labels || a.status)) {
    const state = a.status && a.status.state ? String(a.status.state) : "active";
    return {
      name: String((a.labels && a.labels.alertname) || "（未命名）"),
      state,
      summary: String((a.annotations && (a.annotations.summary || a.annotations.description)) || ""),
      folder: String((a.labels && a.labels.grafana_folder) || ""),
      startsAt: String(a.startsAt || ""),
    };
  }
  return {
    name: String((a && (a.name || a.dashboardSlug)) || "（未命名）"),
    state: String((a && a.state) || ""),
    summary: String((a && a.message) || ""),
    folder: "",
    startsAt: String((a && a.newStateDate) || ""),
  };
}

async function alerts() {
  let data;
  try {
    data = await authed("/api/alertmanager/grafana/api/v2/alerts");
  } catch (e) {
    if (!(e instanceof GfError) || e.status !== 404) throw e;
    data = await authed("/api/alerts");
  }
  if (!Array.isArray(data)) throw new Error("Grafana 返回的告警列表无法识别");
  const items = data.slice(0, 100).map(normAlert);
  items.sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9));
  return { items };
}

async function annotations() {
  const data = await authed("/api/annotations", { limit: 20 });
  if (!Array.isArray(data)) throw new Error("Grafana 返回的注释无法识别");
  return {
    items: data.slice(0, 20).map(a => ({
      time: typeof a.time === "number" ? a.time : 0,
      text: String(a.text || "").replace(/\s+/g, " ").slice(0, 240),
      dashboardUID: String(a.dashboardUID || ""),
    })),
  };
}

const fmtAlert = a => `${a.state || "unknown"} ${a.name}${a.folder ? "（" + a.folder + "）" : ""}${a.summary ? "\n" + a.summary : ""}${a.startsAt ? "\n开始 " + a.startsAt : ""}`;

serve({
  id: "grafana",
  version: VERSION,
  methods: {
    "gf/status": async () => status(),
    "gf/connect": async p => connect(p || {}),
    "gf/disconnect": async () => disconnect(),
    "gf/dashboards": async p => dashboards(p || {}),
    "gf/dashboard": async p => dashboard(p || {}),
    "gf/alerts": async () => alerts(),
    "gf/annotations": async () => annotations(),
  },
  tools: [
    {
      name: "grafana_status",
      description: "查看已保存的 Grafana 是否连得上，返回组织名、版本和数据库状态。不含令牌。",
      readOnly: true,
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const s = await status();
        if (!s.hasToken || !s.url) return "还没有连接 Grafana。";
        if (!s.connected) return "已保存连接，但现在连不上：" + (s.error || "未知错误");
        return `已连接 ${s.org || "（未命名组织）"}\n地址 ${s.url}\n版本 ${s.version || "未知"}\n数据库 ${s.database || "未知"}`;
      },
    },
    {
      name: "grafana_alerts",
      description: "列出 Grafana 当前告警（统一告警；老版本回退到仪表盘告警）。只读。",
      readOnly: true,
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const r = await alerts();
        return r.items.length ? r.items.map(fmtAlert).join("\n\n") : "当前没有告警。";
      },
    },
    {
      name: "grafana_dashboards",
      description: "按标题搜索 Grafana 仪表盘，返回标题、所在文件夹和 uid。",
      readOnly: true,
      inputSchema: { type: "object", properties: { query: { type: "string", description: "标题关键词，可空" } } },
      run: async a => {
        const r = await dashboards({ query: a.query });
        return r.items.length ? r.items.map(d => `${d.title}${d.folder ? "（" + d.folder + "）" : ""} uid=${d.uid}\n${d.url}`).join("\n\n") : "没有匹配的仪表盘。";
      },
    },
    {
      name: "grafana_dashboard",
      description: "查看一个仪表盘有哪些面板（标题和类型）。不返回查询语句。uid 来自 grafana_dashboards。",
      readOnly: true,
      inputSchema: { type: "object", properties: { uid: { type: "string", description: "仪表盘 uid" } }, required: ["uid"] },
      run: async a => {
        const d = await dashboard({ uid: a.uid });
        const lines = d.panels.map(p => `- ${p.title}${p.type ? "（" + p.type + "）" : ""}`);
        return `${d.title}${d.folder ? "（" + d.folder + "）" : ""}\n${d.url}\n${lines.length ? lines.join("\n") : "（没有面板）"}`;
      },
    },
  ],
});
