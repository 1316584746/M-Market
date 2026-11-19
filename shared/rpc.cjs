"use strict";
/**
 * M-Market 插件后台的公共小库：stdio JSON-RPC 2.0（一行一条消息），和 M-Harness 的插件宿主对话。
 *
 *   serve({ id, version, methods, tools })
 *     methods  { "ns/method": async (params) => result }   界面通过 dbxPlugin.invoke 调用
 *     tools    [{ name, description, inputSchema, readOnly, run(args) => string | object }]
 *              给 AI 用的工具，宿主通过 mcp/tools、mcp/call 取用
 *
 * 约定：stdout 只写协议消息，日志一律写 stderr。
 */
const readline = require("node:readline");

const PROTOCOL_VERSION = 1;

function serve({ id, version, methods = {}, tools = [], capabilities = [] }) {
  const out = o => process.stdout.write(JSON.stringify(o) + "\n");
  const log = (...a) => process.stderr.write(a.map(x => (typeof x === "string" ? x : x instanceof Error ? x.stack || x.message : JSON.stringify(x))).join(" ") + "\n");
  // 插件代码里不小心的 console.log 不能污染协议通道
  console.log = console.info = console.debug = (...a) => log(...a);

  const byName = new Map(tools.map(t => [t.name, t]));
  const toText = v => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

  const handlers = {
    "plugin/initialize": async () => ({ protocolVersion: PROTOCOL_VERSION, plugin: { id, version }, capabilities }),
    "plugin/shutdown": async () => {
      setTimeout(() => process.exit(0), 20);
      return null;
    },
    "mcp/tools": async () => ({
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema || { type: "object", properties: {} },
        annotations: { readOnlyHint: !!t.readOnly },
      })),
    }),
    "mcp/call": async params => {
      const t = byName.get(String(params?.tool ?? ""));
      if (!t) return { content: [{ type: "text", text: `没有这个工具：${params?.tool}` }], isError: true };
      try {
        const r = await t.run(params?.arguments ?? {});
        return { content: [{ type: "text", text: toText(r) }] };
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    },
    ...methods,
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async line => {
    if (!line.trim()) return;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof m.method !== "string") return;
    const h = handlers[m.method];
    if (m.id === undefined || m.id === null) {
      if (h) h(m.params ?? {}).catch(e => log(e));
      return;
    }
    if (!h) return out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `没有这个方法：${m.method}` } });
    try {
      const result = await h(m.params ?? {});
      out({ jsonrpc: "2.0", id: m.id, result: result === undefined ? null : result });
    } catch (e) {
      out({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
    }
  });
  // 宿主退出（stdin 关闭）时一起退出，不留孤儿进程
  rl.on("close", () => process.exit(0));
  process.on("uncaughtException", e => log("uncaughtException", e));
  process.on("unhandledRejection", e => log("unhandledRejection", e));
  return { log };
}

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/** 插件自己的数据目录（宿主通过环境变量给），没有时退回临时目录（只在手动调试时发生） */
function dataDir() {
  const d = process.env.DBX_PLUGIN_DATA_DIR || path.join(os.tmpdir(), "m-market-plugin-data");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 数据目录里的 settings.json：读 / 合并写 */
function settings(file = "settings.json") {
  const f = path.join(dataDir(), file);
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")) || {};
    } catch {
      return {};
    }
  };
  return {
    get: read,
    set(patch) {
      const next = { ...read(), ...patch };
      fs.writeFileSync(f, JSON.stringify(next, null, 2));
      return next;
    },
  };
}

/**
 * 找到 M-Harness 的「家目录」（里面有 harness.config.json、.traces、plugins、plugin-data）。
 * 宿主把插件数据放在 <home>/plugin-data/<插件 id>，所以从数据目录往上两级就是家目录；找不到就按常见位置猜。
 */
function harnessHome() {
  const cands = [];
  const dd = process.env.DBX_PLUGIN_DATA_DIR;
  if (process.env.HARNESS_HOME) cands.push(process.env.HARNESS_HOME);
  if (dd && path.basename(path.dirname(dd)) === "plugin-data") cands.push(path.dirname(path.dirname(dd)));
  const h = os.homedir();
  if (process.platform === "win32") cands.push(path.join(process.env.APPDATA || path.join(h, "AppData", "Roaming"), "m-harness"));
  else if (process.platform === "darwin") cands.push(path.join(h, "Library", "Application Support", "m-harness"));
  else cands.push(path.join(process.env.XDG_CONFIG_HOME || path.join(h, ".config"), "m-harness"));
  for (const c of cands) if (fs.existsSync(path.join(c, "harness.config.json"))) return c;
  return cands[0] || "";
}

/** 读 M-Harness 的配置文件（去掉 BOM；读不到返回 {}） */
function harnessConfig(home = harnessHome()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8").replace(/^\uFEFF/, "")) || {};
  } catch {
    return {};
  }
}

module.exports = { serve, dataDir, settings, harnessHome, harnessConfig };
