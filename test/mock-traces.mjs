// 给 context-insight 的本地预览造一批假的 M-Harness trace（近两个月、几个提供方、技能 / 命令 / 压缩 / 外部 Agent 都有）
import fs from "node:fs";
import path from "node:path";

const DAY = 86400000;
const ev = (runId, ts, event) => JSON.stringify({ ts, runId, event });

export function seedTraces(home) {
  fs.writeFileSync(
    path.join(home, "harness.config.json"),
    JSON.stringify({ traceDir: ".traces", limits: { contextTokens: 32000 }, providers: { deepseek: { type: "openai", model: "deepseek-chat" }, claude: { type: "anthropic", model: "claude-sonnet-4" }, cursor: { type: "cursor-sdk", model: "composer" } } }),
  );
  const dir = path.join(home, ".traces");
  fs.mkdirSync(dir, { recursive: true });
  const tasks = ["重构登录模块", "写周报", "修复支付回调超时", "给 README 加安装说明", "排查内存泄漏", "整理接口文档", "迁移到 pnpm", "优化首页加载速度"];
  const skills = ["refactor", "docs", "debug"];
  const cmds = ["npm test", "git status", "pnpm install", "node build.js"];
  let n = 0;
  for (let d = 0; d < 56; d++) {
    const perDay = d < 7 ? 2 + (d % 3) : (d * 7) % 4 === 0 ? 0 : 1 + (d % 2);
    for (let k = 0; k < perDay; k++) {
      n++;
      const t0 = Date.now() - d * DAY - k * 3600000 - 120000;
      const provider = n % 7 === 0 ? "cursor" : n % 3 === 0 ? "claude" : "deepseek";
      const id = `r${n}`;
      const lines = [ev(id, t0, { type: "run_start", runId: id, provider, input: tasks[n % tasks.length] })];
      if (provider === "cursor") {
        for (let i = 0; i < 6; i++) lines.push(ev(id, t0 + 100 + i, { type: "agent_progress", kind: ["thinking", "tool", "text", "status"][i % 4], line: `步骤 ${i + 1}：处理中` }));
        lines.push(ev(id, t0 + 900, { type: "done", reason: "final", text: "ok" }));
      } else {
        const steps = 2 + (n % 5);
        let ctx = 600;
        for (let s = 1; s <= steps; s++) {
          const sys = { role: "system", content: "你是一个严谨的编程助手。".repeat(30) };
          const msgs = [sys, { role: "user", content: tasks[n % tasks.length] }];
          const calls = [{ id: `c${s}`, name: s === 1 ? "use_skill" : s % 2 ? "run_command" : "read_file", args: s === 1 ? { name: skills[n % 3] } : s % 2 ? { command: cmds[n % 4] } : { path: `src/file${s}.ts` } }];
          for (let j = 1; j < s; j++) msgs.push({ role: "assistant", content: "", toolCalls: calls }, { role: "tool", content: "x".repeat(800 * j), toolCallId: calls[0].id });
          const tt = t0 + s * 5000;
          lines.push(ev(id, tt, { type: "model_call", step: s, messages: msgs }));
          const input = ctx + s * 900 + (n % 5) * 300;
          lines.push(ev(id, tt + 1, { type: "model_reply", step: s, ms: 500 + s * 120, tokens: input + 150, reply: { message: { role: "assistant", content: s === steps ? "完成" : "" }, toolCalls: s === steps ? [] : calls, usage: { input, output: 150, total: input + 150 } } }));
          if (s < steps) {
            const c = calls[0];
            lines.push(ev(id, tt + 2, { type: "tool_call", step: s, name: c.name, args: c.args }));
            lines.push(ev(id, tt + 3, { type: "tool_result", step: s, name: c.name, output: c.name === "run_command" ? `exit=${n % 4 === 0 ? 1 : 0}\nok` : "y".repeat(1500), ms: 40 + s * 30 }));
          }
          if (s === 4) lines.push(ev(id, tt + 4, { type: "context_trim", before: 12000, after: 5000, dropped: 5 }));
        }
        lines.push(ev(id, t0 + steps * 5000 + 10, { type: "done", reason: n % 11 === 0 ? "max_steps" : "final", text: "完成" }));
      }
      const f = path.join(dir, `20260101-${String(n).padStart(6, "0")}-${id}.jsonl`);
      fs.writeFileSync(f, lines.join("\n") + "\n");
      const m = new Date(t0 + 60000);
      fs.utimesSync(f, m, m);
    }
  }
  return dir;
}
