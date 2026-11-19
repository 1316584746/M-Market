// 测试公用：把打好的 .dbxp 解到临时目录，像 M-Harness 宿主那样用 stdio JSON-RPC 启动它的后台程序。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { readZip } from "../scripts/zip.mjs";
import { collect } from "../scripts/pack.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const tmpdir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), `mm-${prefix}-`));

/** 解开 packages/ 里的包（测的是真正发布的东西，不是源码目录） */
export function unpack(id, to) {
  const { manifest } = collect(id);
  const file = path.join(ROOT, "packages", `${id}-${manifest.version}.dbxp`);
  for (const f of readZip(fs.readFileSync(file))) {
    const dest = path.join(to, ...f.name.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
  }
  return { dir: to, manifest };
}

/** 启动后台程序：home 是假的 M-Harness 家目录；数据目录按宿主的约定放在 <home>/plugin-data/<id> */
export function launch(id, { home, env = {} } = {}) {
  const h = home ?? tmpdir("home");
  const dir = path.join(tmpdir("pkg"), id);
  const { manifest } = unpack(id, dir);
  const dataDir = path.join(h, "plugin-data", id);
  fs.mkdirSync(dataDir, { recursive: true });
  const exe = path.join(dir, manifest.entrypoints.backend.executable);
  const child = spawn(process.execPath, [exe], { cwd: dir, env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir, DBX_PLUGIN_ID: id, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let seq = 0;
  const pending = new Map();
  let stderr = "";
  child.stderr.on("data", d => (stderr += d));
  readline.createInterface({ input: child.stdout }).on("line", l => {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  });
  child.on("exit", () => {
    for (const p of pending.values()) p.reject(new Error(`后台程序退出了：${stderr.slice(-300)}`));
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id2 = ++seq;
      pending.set(id2, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: id2, method, params }) + "\n");
    });
  const tool = async (name, args = {}) => {
    const r = await call("mcp/call", { tool: name, arguments: args });
    return { text: r.content.map(c => c.text).join("\n"), isError: !!r.isError };
  };
  return {
    home: h,
    dir,
    manifest,
    call,
    tool,
    stop: () => {
      child.kill();
    },
    async init() {
      return call("plugin/initialize", { host: { dbxVersion: "0.6.30", hostApiVersion: "1.0.0", protocolVersions: [1] }, plugin: { id, version: manifest.version }, permissions: manifest.permissions });
    },
  };
}
