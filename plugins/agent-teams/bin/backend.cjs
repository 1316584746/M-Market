"use strict";
/**
 * AgentTeams：多 Agent 团队协作，移植自 NanmiCoder/dsh-agent-teams 的产品模型（MIT）。
 * AI 工具：14 个 agent_teams_*（见 tools.cjs）；界面方法：at/*。
 */
const fs = require("node:fs");
const path = require("node:path");
const { serve, settings: openSettings, dataDir, harnessHome, harnessConfig } = require("./rpc.cjs");
const { Store, CAPTAIN, USER } = require("./state.cjs");
const { Scheduler } = require("./scheduler.cjs");
const { captainTools } = require("./tools.cjs");
const { providers } = require("./llm.cjs");

const VERSION = require("../manifest.json").version;
const prefs = openSettings("settings.json");

const getSettings = () => {
  const s = prefs.get();
  return { maxParallel: 4, maxSteps: 30, ...s };
};

/** 成员干活的目录：插件设置 > M-Harness 配置里的 workspace（相对家目录）> 启动目录 */
function workspace() {
  const home = harnessHome();
  const s = getSettings().workspace;
  const cfg = harnessConfig(home).workspace;
  const dir = s ? path.resolve(s) : cfg ? path.resolve(home || ".", String(cfg)) : process.cwd();
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`工作区目录不存在：${dir}（可以在 AgentTeams 设置里改）`);
  return dir;
}

const store = new Store(path.join(dataDir(), "teams"));
const sched = new Scheduler({ store, getSettings, workspace, log: (...a) => process.stderr.write(a.map(String).join(" ") + "\n") });

const teamView = (t, extra = true) => {
  const base = store.summary(t, USER);
  const full = new Map(t.tasks.map(k => [k.id, k]));
  base.tasks = base.tasks.map(k => ({ ...k, description: full.get(k.id).description, output: full.get(k.id).output, objective: full.get(k.id).objective, acceptance: full.get(k.id).acceptance, verify: full.get(k.id).verify, revisionLog: full.get(k.id).revisions, finishedAt: full.get(k.id).finishedAt }));
  base.createdAt = t.createdAt;
  base.approvedAt = t.approvedAt;
  base.allowAll = !!t.allowAll;
  base.approvals = sched.pending(t.id);
  if (extra) {
    base.messages = t.messages.slice(-200);
    base.activity = Object.fromEntries(store.activeMembers(t).map(m => [m.name, sched.recent(t.id, m.name, 40)]));
  }
  return base;
};

const redactRoute = r => (r ? { provider: r.provider || "", model: r.model || "", baseURL: r.baseURL || "", hasKey: !!r.apiKey } : null);

const methods = {
  "at/info": async () => ({ version: VERSION, workspace: (() => { try { return workspace(); } catch (e) { return `⚠ ${e.message}`; } })() }),
  "at/list": async () => ({
    teams: store.all().map(t => ({ ...store.summary(t, USER), approvals: sched.pending(t.id).length, createdAt: t.createdAt })),
    archived: store.all({ archived: true }).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, archivedAt: t.archivedAt, progress: store.progress(t) })),
  }),
  "at/get": async p => teamView(store.get(p?.id)),
  "at/approve": async p => teamView(store.approve(p?.id)),
  "at/edit-plan": async p => teamView(store.editPlan(p?.id, p?.plan || {})),
  "at/halt": async p => teamView(store.halt(p?.id)),
  "at/resume": async p => teamView(store.resume(p?.id)),
  "at/archive": async p => ({ ok: !!store.archive(p?.id) }),
  "at/restore": async p => {
    const t = store.get(p?.id);
    t.archivedAt = undefined;
    store.touch(t, "restore");
    return teamView(t);
  },
  "at/delete": async p => {
    store.destroy(p?.id);
    return { ok: true };
  },
  "at/allow-all": async p => {
    const t = store.setAllowAll(p?.id, !!p?.on);
    if (t.allowAll) sched.releaseAll(t.id);
    return teamView(t);
  },
  "at/approval": async p => ({ ok: sched.resolveApproval(p?.id, !!p?.allow) }),
  "at/send": async p => {
    const t = store.get(p?.id);
    store.sendMessage(t.id, USER, p?.to || CAPTAIN, p?.content);
    return teamView(t);
  },
  "at/add-member": async p => {
    store.addMember(p?.id, p?.member || {});
    return teamView(store.get(p.id));
  },
  "at/remove-member": async p => {
    store.removeMember(p?.id, p?.name);
    return teamView(store.get(p.id));
  },
  "at/create-task": async p => {
    store.createTask(p?.id, p?.task || {});
    return teamView(store.get(p.id));
  },
  "at/reassign": async p => {
    store.reassignTask(p?.id, p?.taskId, p?.assignee);
    return teamView(store.get(p.id));
  },
  "at/cancel-task": async p => {
    store.updateTask(p?.id, CAPTAIN, { taskId: p?.taskId, status: "cancelled", output: p?.reason || "用户取消" });
    return teamView(store.get(p.id));
  },
  "at/settings": async () => {
    const s = getSettings();
    return { workspace: s.workspace || "", route: redactRoute(s.route), maxParallel: s.maxParallel, maxSteps: s.maxSteps, providers: providers().list.map(p => ({ name: p.name, protocol: p.protocol, model: p.model, hasKey: !!p.apiKey, baseURL: p.baseURL })) };
  },
  "at/settings/set": async p => {
    const cur = prefs.get();
    const patch = {};
    if (p && "workspace" in p) patch.workspace = String(p.workspace || "").trim() || undefined;
    if (p && "maxParallel" in p) patch.maxParallel = Math.max(1, Math.min(Number(p.maxParallel) || 4, 16));
    if (p && "maxSteps" in p) patch.maxSteps = Math.max(1, Math.min(Number(p.maxSteps) || 30, 100));
    if (p && "route" in p) {
      const r = p.route || {};
      const old = cur.route || {};
      patch.route = r.baseURL ? { provider: String(r.provider || ""), model: String(r.model || ""), baseURL: String(r.baseURL), apiKey: typeof r.apiKey === "string" && r.apiKey ? r.apiKey : old.apiKey || "" } : undefined;
    }
    prefs.set(patch);
    sched.kick();
    return methods["at/settings"]();
  },
};

const tools = captainTools(store);

serve({ id: "agent-teams", version: VERSION, methods, tools });
sched.start();
process.on("exit", () => sched.stop());
