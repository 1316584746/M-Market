"use strict";
/**
 * 调度器：空闲成员自动领下一个依赖已满足的任务，有未读消息的空闲成员被唤醒；
 * 改派、移除、暂停、归档时中止正在跑的那一轮（旧尝试作废）。同时跑的成员数有上限。
 * 另外管着审批队列（成员写文件 / 执行命令要先过这里）和每个成员的活动记录（界面里的「实时动态」）。
 */
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const { runTurn, settle } = require("./runner.cjs");
const LOG_CAP = 300;
const APPROVAL_TTL = 10 * 60 * 1000;

class Scheduler extends EventEmitter {
  constructor({ store, getSettings, workspace, log = () => {} }) {
    super();
    this.store = store;
    this.getSettings = getSettings;
    this.workspace = workspace;
    this.log = log;
    this.running = new Map(); // "team/member" -> { controller, taskId, attempt }
    this.activity = new Map(); // "team/member" -> [{ ts, kind, text }]
    this.approvals = new Map();
    this.scheduled = false;
    this.stopped = false;
  }

  start() {
    this.onChanged = () => this.kick();
    this.onRevoke = e => {
      const r = this.running.get(`${e.teamId}/${e.member}`);
      if (r && r.taskId === e.taskId) r.controller.abort(new Error("revoked"));
    };
    this.onDestroyed = e => {
      for (const [key, r] of this.running) if (key.startsWith(`${e.teamId}/`)) r.controller.abort(new Error("destroyed"));
    };
    this.store.on("changed", this.onChanged);
    this.store.on("revoke", this.onRevoke);
    this.store.on("destroyed", this.onDestroyed);
    this.timer = setInterval(() => this.kick(), 5000);
    this.timer.unref?.();
    this.kick();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.store.off("changed", this.onChanged);
    this.store.off("revoke", this.onRevoke);
    this.store.off("destroyed", this.onDestroyed);
    for (const r of this.running.values()) r.controller.abort(new Error("stopped"));
    for (const a of this.approvals.values()) a.resolve(false);
  }

  kick() {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      try {
        this.tick();
      } catch (e) {
        this.log("tick", e);
      }
    });
  }

  /** 正在跑的成员数（测试和界面用） */
  busy() {
    return this.running.size;
  }

  tick() {
    if (this.stopped) return;
    const max = Math.max(1, Math.min(Number(this.getSettings().maxParallel) || 4, 16));
    for (const team of this.store.all()) {
      if (team.phase !== "running" || team.halted) continue;
      for (const member of this.store.activeMembers(team)) {
        if (this.running.size >= max) return;
        const key = `${team.id}/${member.name}`;
        if (this.running.has(key)) continue;
        let task = null;
        try {
          task = this.store.claimTask(team.id, member.name);
        } catch {
          task = null;
        }
        if (!task && !this.store.unread(team, member.name).length) continue;
        this.launch(team, member, task);
      }
    }
  }

  launch(team, member, task) {
    const key = `${team.id}/${member.name}`;
    const controller = new AbortController();
    const entry = { controller, taskId: task?.id, attempt: task?.attempt };
    this.running.set(key, entry);
    this.store.setMemberStatus(team, member.name, "working");
    member.spawnError = undefined;
    const log = (kind, text) => this.note(team.id, member.name, kind, text);
    const snapshot = task ? { ...task } : null;
    (async () => {
      const outcome = {};
      try {
        const res = await runTurn({
          store: this.store, team, member, task: snapshot, settings: this.getSettings(), signal: controller.signal, log,
          workspace: this.workspace(), ask: (kind, detail, c) => this.ask(team, member.name, kind, detail, c?.signal || controller.signal),
        });
        outcome.text = res.text;
      } catch (e) {
        if (controller.signal.aborted) outcome.aborted = true;
        else {
          outcome.error = e instanceof Error ? e.message : String(e);
          log("error", outcome.error);
          member.spawnError = outcome.error;
        }
      }
      this.running.delete(key);
      this.denyFor(team.id, member.name);
      if (!outcome.aborted) settle(this.store, team, member, snapshot, outcome);
      if (this.store.teams.has(team.id)) this.store.setMemberStatus(team, member.name, "idle");
      this.kick();
    })();
  }

  // ───────── 活动记录 ─────────

  note(teamId, member, kind, text) {
    const key = `${teamId}/${member}`;
    const arr = this.activity.get(key) || [];
    arr.push({ ts: Date.now(), kind, text: String(text).slice(0, 2000) });
    if (arr.length > LOG_CAP) arr.splice(0, arr.length - LOG_CAP);
    this.activity.set(key, arr);
    this.emit("activity", { teamId, member });
  }

  recent(teamId, member, n = 60) {
    return (this.activity.get(`${teamId}/${member}`) || []).slice(-n);
  }

  // ───────── 审批 ─────────

  ask(team, member, kind, detail, signal) {
    if (this.store.get(team.id).allowAll) return Promise.resolve(true);
    return new Promise(resolve => {
      const id = crypto.randomBytes(4).toString("hex");
      const done = ok => {
        clearTimeout(timer);
        this.approvals.delete(id);
        this.emit("approval", { teamId: team.id });
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), APPROVAL_TTL);
      signal?.addEventListener("abort", () => done(false), { once: true });
      this.approvals.set(id, { id, teamId: team.id, member, kind, detail, createdAt: Date.now(), resolve: done });
      this.note(team.id, member, "approval", `等待确认：${kind === "write" ? `写入 ${detail.path}` : `执行 ${detail.command}`}`);
      this.emit("approval", { teamId: team.id });
    });
  }

  resolveApproval(id, allow) {
    const a = this.approvals.get(String(id));
    if (!a) throw new Error("这条确认已经过期或被处理了");
    a.resolve(!!allow);
    return true;
  }

  pending(teamId) {
    return [...this.approvals.values()].filter(a => !teamId || a.teamId === teamId).map(({ resolve, ...rest }) => rest);
  }

  /** 开了「全部允许」后，已经在等的确认一起放行 */
  releaseAll(teamId) {
    for (const a of [...this.approvals.values()]) if (a.teamId === teamId) a.resolve(true);
  }

  denyFor(teamId, member) {
    for (const a of [...this.approvals.values()]) if (a.teamId === teamId && a.member === member) a.resolve(false);
  }
}

module.exports = { Scheduler };
