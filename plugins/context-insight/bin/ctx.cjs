"use strict";
/**
 * 会话时间线：把一个会话（一次或多次续接的运行）的 trace 解析成「分步」的上下文档案——
 * 每一步的窗口构成、增量、耗时拆分、步骤摘要、事件，以及上下文浏览器要用的条目。
 *
 * 两种 trace 统一成同一个形状：
 *  - 模型类提供方（openai / anthropic …）：一次 model_call = 一步，窗口构成来自发给模型的消息，用量取真实值（没有就估算）；
 *  - 外部 Agent（Cursor / 命令行）：trace 里只有进度行。一步 = 一段模型输出（思考 / 回复）加上它发起的一批工具调用和结果；
 *    窗口构成 = 这个会话里你能看到的内容累计（提示词、模型输出、工具结果），看不到它内部的系统提示词和工具定义，所以那两项是 0。
 * 只读，不改任何文件；trace 里没有的数据一律留空，不编造。
 */

const WCATS = ["system", "tools", "user", "injected", "skill", "assistant", "results"];
const zero = () => Object.fromEntries(WCATS.map(k => [k, 0]));
const sumW = c => WCATS.reduce((n, k) => n + (c[k] || 0), 0);
const minus = (a, b) => Object.fromEntries(WCATS.map(k => [k, (a[k] || 0) - (b[k] || 0)]));

const ITEM_CAP = 3000; // 条目文本最多保留这么多字符（token 数按全文算）
const clip = (s, n) => {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) : s;
};
const oneLine = (s, n) => clip(String(s == null ? "" : s).replace(/\s+/g, " ").trim(), n);

const READ_RE = /^(read|read_file|readfile|view|cat|read_lints)$/i;
const WRITE_RE = /^(edit|edit_file|write|write_file|strreplace|str_replace|multiedit|apply_patch|delete|delete_file|notebookedit|editnotebook)$/i;
const SEARCH_RE = /^(grep|glob|rg|codebase_search|semsearch|search|list_dir|ls|web_search|websearch|webfetch|web_fetch|read_page)$/i;
const opOf = name => (READ_RE.test(name) ? "read" : WRITE_RE.test(name) ? "write" : SEARCH_RE.test(name) ? "search" : "other");

const argPath = a => (a && typeof a === "object" ? a.path || a.file_path || a.target_file || a.targetDirectory || a.target_directory || a.pattern || a.globPattern || a.query || a.url || "" : "");
const previewOf = (name, a) => {
  if (!a || typeof a !== "object") return "";
  const v = a.command || a.path || a.file_path || a.target_file || a.pattern || a.globPattern || a.query || a.url || a.description || a.name || "";
  return oneLine(typeof v === "string" ? v : JSON.stringify(v), 90);
};

function createCtx({ est, readLines, canonTool, programOf, skillFromPath, toolGroup }) {
  const sourceOf = name => {
    const g = toolGroup(name);
    if (g) return g.group === "mcp" ? "mcp:" + g.server : "plugin:" + g.server;
    return "";
  };

  function parseRows(file) {
    const rows = [];
    for (const l of readLines(file)) {
      let j;
      try {
        j = JSON.parse(l);
      } catch {
        continue;
      }
      if (j && j.event) rows.push({ ts: j.ts || 0, e: j.event });
    }
    return rows;
  }

  /** 模型消息 → 窗口构成 */
  function composeMsgs(msgs) {
    const c = zero();
    const callName = new Map();
    for (const m of msgs) if (Array.isArray(m.toolCalls)) for (const tc of m.toolCalls) callName.set(tc.id, tc.name);
    for (const m of msgs) {
      const t = est(m.content) + 4;
      if (m.role === "system") c.system += t;
      else if (m.role === "user") c.user += t;
      else if (m.role === "assistant") c.assistant += t + (Array.isArray(m.toolCalls) ? est(JSON.stringify(m.toolCalls)) : 0);
      else if (m.role === "tool") {
        if (callName.get(m.toolCallId) === "use_skill") c.skill += t;
        else c.results += t;
      }
    }
    return c;
  }

  /**
   * 解析会话。files = [{ file, name }]（按时间先后）。返回完整档案；条目（items）只有外部 Agent 会在这里生成，
   * 模型类的条目按需从对应的 model_call 重建（避免把每一步的整份消息都存一遍）。
   */
  function build(files, opts) {
    const o = opts || {};
    const S = {
      window: o.window || 0,
      turns: [],
      steps: [],
      events: [],
      items: [],
      tools: new Map(),
      fileOps: [],
      commands: [],
      subagents: [],
      live: zero(),
      agent: false,
      runs: files.map(f => f.name),
      skipped: "",
    };
    const cum = zero(); // 外部 Agent：会话里累计看得到的内容
    let userInputs = 0;

    const note = (type, step, ts, label, delta, extra) => S.events.push({ type, step: step ? step.n : 0, turn: step ? step.turn : 0, ts, label: oneLine(label, 140), delta: delta == null ? null : delta, ...(extra || {}) });
    const addTool = (name, ms, out, err) => {
      const t = S.tools.get(name) || { name, count: 0, ms: 0, out: 0, errs: 0, source: sourceOf(name) };
      t.count++;
      t.ms += ms || 0;
      t.out += out || 0;
      if (err) t.errs++;
      S.tools.set(name, t);
    };
    const addFile = (name, args, step, ts) => {
      const op = opOf(name);
      const p = argPath(args);
      if (op !== "other" && p && typeof p === "string") S.fileOps.push({ path: p, op, step: step.n, turn: step.turn, ts, tool: name });
    };
    const addCmd = (c, step) => S.commands.push({ ...c, step: step.n, turn: step.turn });

    for (const f of files) {
      let rows;
      try {
        rows = parseRows(f.file);
      } catch (e) {
        S.skipped = e.message;
        continue;
      }
      if (!rows.length) continue;
      const hasModel = rows.some(r => r.e.type === "model_call");
      if (hasModel) modelRun(f, rows);
      else agentRun(f, rows);
    }

    // ───────── 外部 Agent ─────────
    function agentRun(f, rows) {
      S.agent = true;
      const start = rows.find(r => r.e.type === "run_start") || rows[0];
      const input = String(start.e.input || "");
      const turn = S.turns.length + 1;
      const tinfo = { n: turn, run: f.name, input: clip(input, 400), startedAt: start.ts, endedAt: rows[rows.length - 1].ts, reason: "", error: "", first: S.steps.length + 1, last: 0 };
      S.turns.push(tinfo);
      userInputs++;
      const firstStepN = S.steps.length + 1;
      S.items.push({ step: firstStepN, turn, cat: "user", kind: "user", title: "user", tokens: est(input) + 4, text: clip(input, ITEM_CAP), truncated: input.length > ITEM_CAP });
      cum.user += est(input) + 4;

      let started = false;
      let runBegin = start.ts;
      let prevCalls = [];
      const newStep = t0 => ({ t0, marks: [], think: 0, text: 0, args: 0, thinkTxt: [], texts: [], calls: [] });
      let cur = newStep(start.ts);
      let open = 0;
      const queues = new Map();
      let preOverhead = 0;

      const close = (endTs, final) => {
        if (!cur.marks.length && !cur.calls.length) return;
        const n = S.steps.length + 1;
        const marks = cur.marks.slice().sort((a, b) => a.ts - b.ts);
        const timing = { ttft: 0, reasoning: 0, answers: 0, args: 0, tools: 0, model: 0, overhead: 0 };
        if (marks.length) {
          timing.ttft = Math.max(0, marks[0].ts - cur.t0);
          const firstTool = marks.findIndex(m => m.c === "tools");
          for (let i = 0; i < marks.length; i++) {
            const end = i + 1 < marks.length ? marks[i + 1].ts : endTs;
            let c = marks[i].c;
            if (c !== "tools" && firstTool >= 0 && i === firstTool - 1) c = "args";
            timing[c] += Math.max(0, end - marks[i].ts);
          }
        }
        if (preOverhead) {
          timing.overhead += preOverhead;
          preOverhead = 0;
        }
        const before = { ...cum };
        const comp = { ...before };
        const outTok = cur.think + cur.text + cur.args;
        const step = {
          n,
          turn,
          run: f.name,
          ts: cur.t0,
          endTs,
          ms: Math.max(0, endTs - cur.t0) + timing.overhead,
          comp,
          delta: null,
          prompt: sumW(comp),
          output: outTok,
          estimated: true,
          actual: null,
          timing,
          reasoningTok: cur.think,
          textTok: cur.text,
          argTok: cur.args,
          resultTok: 0,
          brief: {
            user: oneLine(input, 160),
            in: prevCalls.slice(0, 4),
            inMore: Math.max(0, prevCalls.length - 4),
            resp: oneLine(cur.texts.join("") || cur.thinkTxt.join(""), 200),
            respKind: cur.texts.length ? "answer" : cur.thinkTxt.length ? "thinking" : "",
            calls: cur.calls.slice(0, 4).map(c => ({ tool: c.name, preview: c.preview })),
            callsMore: Math.max(0, cur.calls.length - 4),
          },
          calls: cur.calls.map(c => ({ name: c.name, ms: c.ms, err: c.err, preview: c.preview })),
          flags: [],
        };
        step.delta = minus(comp, S.steps.length ? S.steps[S.steps.length - 1].comp : zero());
        // 本步的内容进入窗口（下一步的请求才会带上）
        cum.assistant += cur.think + cur.text + cur.args;
        const thinkText = cur.thinkTxt.join("");
        const answerText = cur.texts.join("");
        if (cur.think) S.items.push({ step: n, turn, cat: "assistant", kind: "thinking", title: "thinking", tokens: cur.think, text: clip(thinkText, ITEM_CAP), truncated: thinkText.length > ITEM_CAP });
        if (cur.text) S.items.push({ step: n, turn, cat: "assistant", kind: "answer", title: "answer", tokens: cur.text, text: clip(answerText, ITEM_CAP), truncated: answerText.length > ITEM_CAP });
        for (const c of cur.calls) {
          S.items.push({ step: n, turn, cat: "assistant", kind: "tools", title: c.name, tool: c.name, source: sourceOf(c.name), tokens: c.argTok, text: clip(c.argsText, ITEM_CAP), truncated: c.argsText.length > ITEM_CAP });
          const skillName = c.skill;
          const rcat = skillName ? "skill" : "results";
          if (c.done) {
            S.items.push({ step: n, turn, cat: rcat, kind: "result", title: c.name, tool: c.name, source: sourceOf(c.name), tokens: c.out, ok: !c.err, text: clip(c.resText, ITEM_CAP), truncated: c.resText.length > ITEM_CAP });
            cum[rcat] += c.out;
            step.resultTok += c.out;
            if (skillName) {
              step.flags.push({ type: "skill", label: skillName });
              note("skill", step, c.ts, skillName, c.out);
            }
          }
          addTool(c.name, c.ms, c.out, c.err);
          addFile(c.name, c.args, step, c.ts);
          // 子 Agent：Cursor 的 task 工具
          if (/^(task|subagent)$/i.test(c.name)) S.subagents.push({ turn, step: n, ts: c.ts, ms: c.ms, err: c.err, type: String((c.args && (c.args.subagent_type || c.args.subagentType || c.args.agent)) || ""), desc: oneLine((c.args && (c.args.description || c.args.prompt)) || "", 160) });
          if (c.cmd) addCmd({ ts: c.ts, command: c.cmd, program: programOf(c.cmd), exit: c.exit, timedOut: false, blocked: false, ms: c.ms }, step);
        }
        S.steps.push(step);
        tinfo.last = n;
        prevCalls = cur.calls.filter(c => c.done).map(c => ({ tool: c.name, preview: c.preview, ok: !c.err }));
        cur = newStep(endTs);
        open = 0;
      };

      for (const r of rows) {
        const e = r.e;
        if (e.type === "agent_progress") {
          const kind = e.kind || "text";
          const line = String(e.line == null ? "" : e.line);
          if (kind === "status") {
            if (!started && /开始运行|开始处理/.test(line)) {
              started = true;
              preOverhead = Math.max(0, r.ts - runBegin);
              cur.t0 = r.ts;
            }
            if (/重连|重试|失败|错误|中断|断开|超时/.test(line)) note("warn", S.steps[S.steps.length - 1] || null, r.ts, line);
            continue;
          }
          if (kind === "thinking") {
            cur.marks.push({ ts: r.ts, c: "reasoning" });
            cur.think += est(line);
            cur.thinkTxt.push(line);
          } else if (kind === "text") {
            cur.marks.push({ ts: r.ts, c: "answers" });
            cur.text += est(line);
            cur.texts.push(line);
          } else if (kind === "tool") {
            const text = line.trim();
            const call = /^🔧\s*(\S+)\s*([\s\S]*)$/.exec(text);
            if (call) {
              let args = null;
              const rawArgs = call[2].trim();
              if (rawArgs.startsWith("{")) {
                try {
                  args = JSON.parse(rawArgs);
                } catch {
                  args = null;
                }
              }
              const name = canonTool(call[1], args);
              const c = { name, raw: call[1], args, ts: r.ts, ms: 0, out: 0, err: false, done: false, argsText: rawArgs, argTok: est(line), preview: previewOf(name, args), resText: "", skill: "", cmd: "", exit: null };
              if (name === "use_skill" && args && typeof args.name === "string") c.skill = args.name;
              const fp = args && (args.path || args.file_path || args.target_file);
              if (READ_RE.test(name) && fp) c.skill = c.skill || skillFromPath(fp);
              if ((name === "shell" || name === "run_command") && args && typeof args.command === "string") c.cmd = args.command.slice(0, 300);
              cur.calls.push(c);
              cur.args += c.argTok;
              cur.marks.push({ ts: r.ts, c: "tools" });
              const q = queues.get(call[1]) || [];
              q.push(c);
              queues.set(call[1], q);
              open++;
              continue;
            }
            const res = /^[✓✗×✘]\s*(\S+)\s*(?:→|->)\s*([\s\S]*)$/.exec(text);
            if (res) {
              const q = queues.get(res[1]);
              const c = q && q.length ? q.shift() : null;
              if (!c) continue;
              const body = res[2];
              c.done = true;
              c.ms = Math.max(0, r.ts - c.ts);
              c.out = est(body) + 4;
              c.resText = body;
              c.err = /^[✗×✘]/.test(text) || /"status"\s*:\s*"error"/.test(body.slice(0, 80));
              if (c.cmd) {
                const m = /"exitCode"\s*:\s*(-?\d+)/.exec(body);
                if (m) c.exit = Number(m[1]);
                else if (c.err) c.exit = 1;
              }
              cur.marks.push({ ts: r.ts, c: "tools" });
              open = Math.max(0, open - 1);
              if (open === 0) close(r.ts, false);
            }
          }
        } else if (e.type === "done") {
          tinfo.reason = e.reason || "";
          tinfo.error = e.error || "";
          tinfo.endedAt = r.ts;
          // 有没发完的工具调用（被中断）：照样收尾
          if (cur.calls.length) for (const c of cur.calls) if (!c.done) c.err = true;
          close(r.ts, true);
          if (e.error || (e.reason && e.reason !== "final")) note("error", S.steps[S.steps.length - 1] || null, r.ts, e.error || e.reason);
        }
      }
      // 没有 done（还在跑 / 异常结束）
      if (cur.marks.length || cur.calls.length) close(rows[rows.length - 1].ts, true);
      if (!tinfo.last) tinfo.first = 0;
    }

    // ───────── 模型类提供方 ─────────
    function modelRun(f, rows) {
      const start = rows.find(r => r.e.type === "run_start") || rows[0];
      const stepsMap = new Map();
      const pending = new Map();
      let cur = 0;
      let tinfo = null;
      const turnBase = S.turns.length;
      const get = n => {
        if (!stepsMap.has(n)) stepsMap.set(n, { n: 0, local: n, ts: 0, ms: 0, comp: zero(), prompt: 0, output: 0, estimated: true, actual: null, calls: [], flags: [], brief: null, toolMs: 0, userCount: 0, msgCount: 0, turn: 1 });
        return stepsMap.get(n);
      };
      const evs = [];
      for (const r of rows) {
        const e = r.e;
        switch (e.type) {
          case "model_call": {
            cur = e.step;
            const s = get(e.step);
            const msgs = Array.isArray(e.messages) ? e.messages : [];
            s.ts = r.ts;
            s.comp = composeMsgs(msgs);
            s.msgCount = msgs.length;
            s.userCount = msgs.filter(m => m.role === "user").length;
            const lastUser = [...msgs].reverse().find(m => m.role === "user");
            let k = msgs.length;
            while (k > 0 && msgs[k - 1].role === "tool") k--;
            const callName = new Map();
            for (const m of msgs) if (Array.isArray(m.toolCalls)) for (const tc of m.toolCalls) callName.set(tc.id, tc.name);
            s.brief = {
              user: oneLine(lastUser ? lastUser.content : "", 160),
              in: msgs.slice(k).slice(0, 4).map(m => ({ tool: callName.get(m.toolCallId) || "tool", preview: oneLine(m.content, 90), ok: !/^(错误|error)/i.test(String(m.content || "")) })),
              inMore: Math.max(0, msgs.length - k - 4),
              resp: "",
              respKind: "",
              calls: [],
              callsMore: 0,
            };
            break;
          }
          case "model_reply": {
            const s = get(e.step);
            const u = e.reply && e.reply.usage;
            s.ms = e.ms || 0;
            const calls = (e.reply && e.reply.toolCalls) || [];
            const content = e.reply && e.reply.message && e.reply.message.content;
            const outEst = (calls.length ? est(JSON.stringify(calls)) : 0) + est(content);
            if (u && typeof u.input === "number") {
              s.estimated = false;
              s.prompt = u.input;
              s.output = u.output == null ? 0 : u.output;
              s.actual = { prompt: u.input, output: s.output };
            } else {
              s.prompt = sumW(s.comp);
              s.output = outEst;
            }
            if (s.brief) {
              s.brief.resp = oneLine(content || "", 200);
              s.brief.respKind = content ? "answer" : "";
              s.brief.calls = calls.slice(0, 4).map(c => ({ tool: canonTool(c.name, c.args), preview: previewOf(c.name, c.args) }));
              s.brief.callsMore = Math.max(0, calls.length - 4);
            }
            break;
          }
          case "tool_call": {
            const q = pending.get(e.step) || [];
            q.push({ name: e.name, args: e.args, ts: r.ts });
            pending.set(e.step, q);
            break;
          }
          case "tool_result": {
            const q = pending.get(e.step) || [];
            const i = q.findIndex(x => x.name === e.name);
            const call = i >= 0 ? q.splice(i, 1)[0] : { args: null, ts: r.ts };
            const s = get(e.step);
            const name = canonTool(e.name, call.args);
            const out = est(e.output) + 4;
            const outStr = String(e.output || "");
            const failed = /^(错误|error)/i.test(outStr) || /^\[超时已终止\]/.test(outStr);
            const c = { name, ms: e.ms || 0, err: failed, preview: previewOf(name, call.args), out };
            s.calls.push(c);
            s.toolMs += e.ms || 0;
            addTool(name, e.ms || 0, out, failed);
            const skill = e.name === "use_skill" && call.args && typeof call.args.name === "string" ? call.args.name : e.name === "read_file" ? skillFromPath(call.args && call.args.path) : "";
            if (skill) evs.push({ type: "skill", step: e.step, ts: r.ts, label: skill, delta: out });
            evs.push({ type: "_file", step: e.step, ts: r.ts, name: e.name, args: call.args });
            if (e.name === "run_command") {
              const command = String((call.args && call.args.command) || "");
              const m = /^(\[超时已终止\]\s*)?exit=(-?\d+|null)/.exec(outStr);
              evs.push({ type: "_cmd", step: e.step, ts: r.ts, c: { ts: r.ts, command: command.slice(0, 300), program: programOf(command), exit: m ? (m[2] === "null" ? null : Number(m[2])) : null, timedOut: !!(m && m[1]), blocked: false, ms: e.ms || 0 } });
            }
            break;
          }
          case "tool_blocked":
            evs.push({ type: "blocked", step: cur, ts: r.ts, label: `${e.name || ""} ${e.reason || ""}` });
            if (e.name === "run_command") evs.push({ type: "_cmd", step: cur, ts: r.ts, c: { ts: r.ts, command: "", program: "?", exit: null, timedOut: false, blocked: true, ms: 0 } });
            break;
          case "approval":
            evs.push({ type: "approval", step: e.step || cur, ts: r.ts, label: `${e.approved ? "approved" : "denied"} ${e.name || ""}`, approved: !!e.approved });
            break;
          case "context_trim":
            evs.push({ type: "trim", step: cur, ts: r.ts, label: `${e.before} → ${e.after}`, delta: (e.after || 0) - (e.before || 0), dropped: e.dropped, before: e.before, after: e.after });
            break;
          case "done":
            tinfo = { reason: e.reason || "", error: e.error || "", ts: r.ts };
            break;
          default:
        }
      }
      const list = [...stepsMap.values()].filter(s => s.ts).sort((a, b) => a.local - b.local);
      const turnOfStep = new Map();
      list.forEach((s, i) => {
        s.n = S.steps.length + i + 1;
        s.turn = turnBase + Math.max(1, s.userCount);
        turnOfStep.set(s.local, s);
      });
      // 回合：同一次运行里用户消息数一样的步骤算一回合
      const byTurn = new Map();
      for (const s of list) {
        if (!byTurn.has(s.turn)) byTurn.set(s.turn, []);
        byTurn.get(s.turn).push(s);
      }
      for (const [tn, ss] of byTurn) {
        const tstep = ss[0];
        S.turns.push({ n: tn, run: f.name, input: tstep.brief ? tstep.brief.user : oneLine(start.e.input, 160), startedAt: ss[0].ts, endedAt: ss[ss.length - 1].ts, reason: "", error: "", first: ss[0].n, last: ss[ss.length - 1].n });
      }
      if (S.turns.length && tinfo) {
        const t = S.turns[S.turns.length - 1];
        t.reason = tinfo.reason;
        t.error = tinfo.error;
        t.endedAt = tinfo.ts;
      }
      userInputs += byTurn.size;
      const base = S.steps.length;
      list.forEach((s, i) => {
        const prev = i === 0 ? (base ? S.steps[base - 1].comp : zero()) : list[i - 1].comp;
        const nextTs = i + 1 < list.length ? list[i + 1].ts : tinfo ? tinfo.ts : s.ts + s.ms + s.toolMs;
        const timing = { ttft: 0, reasoning: 0, answers: 0, args: 0, tools: s.toolMs, model: s.ms, overhead: Math.max(0, Math.min(120000, nextTs - s.ts - s.ms - s.toolMs)) };
        S.steps.push({
          n: s.n,
          turn: s.turn,
          run: f.name,
          ts: s.ts,
          endTs: nextTs,
          ms: Math.max(0, nextTs - s.ts),
          comp: s.comp,
          delta: minus(s.comp, prev),
          prompt: s.prompt,
          output: s.output,
          estimated: s.estimated,
          actual: s.actual,
          timing,
          reasoningTok: 0,
          textTok: 0,
          argTok: 0,
          resultTok: 0,
          brief: s.brief,
          calls: s.calls,
          flags: [],
          local: s.local,
          msgCount: s.msgCount,
        });
      });
      // 事件、文件、命令挂到对应的步骤上
      const stepOfLocal = new Map(list.map(s => [s.local, S.steps.find(x => x.n === s.n)]));
      for (const ev of evs) {
        const st = stepOfLocal.get(ev.step) || null;
        if (ev.type === "_file") {
          const op = opOf(ev.name);
          const p = argPath(ev.args);
          if (st && op !== "other" && typeof p === "string" && p) S.fileOps.push({ path: p, op, step: st.n, turn: st.turn, ts: ev.ts, tool: ev.name });
        } else if (ev.type === "_cmd") {
          if (st) addCmd(ev.c, st);
        } else {
          if (st) st.flags.push({ type: ev.type, label: ev.label });
          note(ev.type, st, ev.ts, ev.label, ev.delta, ev.type === "trim" ? { dropped: ev.dropped, before: ev.before, after: ev.after } : ev.type === "approval" ? { approved: ev.approved } : undefined);
        }
      }
      if (tinfo && (tinfo.error || (tinfo.reason && tinfo.reason !== "final"))) note("error", S.steps[S.steps.length - 1] || null, tinfo.ts, tinfo.error || tinfo.reason);
    }

    S.live = S.agent ? { ...cum } : S.steps.length ? { ...S.steps[S.steps.length - 1].comp } : zero();
    S.userInputs = userInputs;
    S.events.sort((a, b) => a.ts - b.ts);
    return S;
  }

  // ───────── 汇总给界面 ─────────

  function summarize(S) {
    const tm = { ttft: 0, reasoning: 0, answers: 0, args: 0, tools: 0, model: 0, overhead: 0 };
    let outTok = 0;
    let genMs = 0;
    for (const s of S.steps) {
      for (const k of Object.keys(tm)) tm[k] += s.timing[k] || 0;
      if (S.agent) {
        outTok += s.output;
        genMs += (s.timing.reasoning || 0) + (s.timing.answers || 0) + (s.timing.args || 0);
      } else if (s.actual && s.ms > 0) {
        outTok += s.actual.output;
        genMs += s.ms;
      }
    }
    const ops = { read: 0, write: 0, search: 0 };
    for (const f of S.fileOps) if (ops[f.op] != null) ops[f.op]++;
    const events = { skill: 0, trim: 0, blocked: 0, approval: 0, error: 0, warn: 0 };
    for (const e of S.events) if (events[e.type] != null) events[e.type]++;
    const answers = S.steps.filter(s => !s.calls.length && (S.agent ? s.textTok > 0 : s.brief && s.brief.resp)).length;
    return {
      timing: tm,
      tps: genMs > 0 && outTok > 0 ? outTok / (genMs / 1000) : null,
      tpsEstimated: S.agent,
      ops,
      events,
      answers,
      toolCalls: [...S.tools.values()].reduce((n, t) => n + t.count, 0),
    };
  }

  // ───────── 上下文浏览器的条目 ─────────

  /** 模型类：某一步发给模型的消息，转成条目。items 里 isNew 表示相对上一步新增 */
  function modelItems(file, local, prevLocal) {
    const grab = want => {
      for (const l of readLines(file)) {
        if (!l.includes('"type":"model_call"')) continue;
        let j;
        try {
          j = JSON.parse(l);
        } catch {
          continue;
        }
        if (j.event && j.event.step === want) return Array.isArray(j.event.messages) ? j.event.messages : [];
      }
      return null;
    };
    const msgs = grab(local) || [];
    const prev = prevLocal != null ? grab(prevLocal) : null;
    const key = m => `${m.role}|${m.toolCallId || ""}|${String(m.content || "").length}|${String(m.content || "").slice(0, 80)}|${Array.isArray(m.toolCalls) ? m.toolCalls.map(c => c.id).join(",") : ""}`;
    const seen = new Set((prev || []).map(key));
    const callName = new Map();
    for (const m of msgs) if (Array.isArray(m.toolCalls)) for (const tc of m.toolCalls) callName.set(tc.id, tc.name);
    return msgs.slice(0, 600).map((m, i) => {
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      const tool = calls.length ? calls.map(c => c.name).join(", ") : m.role === "tool" ? callName.get(m.toolCallId) : "";
      let cat;
      let kind;
      if (m.role === "system") (cat = "system"), (kind = "system");
      else if (m.role === "user") (cat = "user"), (kind = "user");
      else if (m.role === "assistant") (cat = "assistant"), (kind = calls.length && !m.content ? "tools" : "answer");
      else (cat = tool === "use_skill" ? "skill" : "results"), (kind = "result");
      const raw = String(m.content || "") + (calls.length ? "\n" + JSON.stringify(calls) : "");
      const tokens = est(m.content) + (calls.length ? est(JSON.stringify(calls)) : 0) + 4;
      return { id: i, pos: i + 1, cat, kind, title: tool || m.role, tool: tool || "", source: tool ? sourceOf(tool) : "", tokens, ok: kind === "result" ? !/^(错误|error)/i.test(String(m.content || "")) : undefined, text: clip(raw, ITEM_CAP), truncated: raw.length > ITEM_CAP, isNew: prev ? !seen.has(key(m)) : false };
    });
  }

  /** 外部 Agent：到第 stepN 步为止窗口里的条目（total）或这一步新增的（delta） */
  function agentItems(S, stepN, mode) {
    const items = S.items.filter(it => (mode === "delta" ? it.step === stepN : it.step <= stepN));
    return items.map((it, i) => ({ id: i, pos: i + 1, ...it, isNew: it.step === stepN }));
  }

  return { build, summarize, modelItems, agentItems, WCATS, opOf };
}

module.exports = { createCtx, WCATS };
