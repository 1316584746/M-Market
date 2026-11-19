#!/usr/bin/env node
// 把 plugins/<id>/ 打成 packages/<id>-<版本>.dbxp，并重新生成 catalog/index.json（M-Harness 插件中心读的 DBX 目录）。
//   node scripts/pack.mjs            打包 + 更新目录
//   node scripts/pack.mjs --check    只检查：包和目录是不是和源码一致（CI 用，不改任何文件）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readZip, writeZip } from "./zip.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS = path.join(ROOT, "plugins");
const PACKAGES = path.join(ROOT, "packages");
const CATALOG = path.join(ROOT, "catalog", "index.json");
const SHARED = [{ from: path.join(ROOT, "shared", "rpc.cjs"), to: "bin/rpc.cjs" }];
const BASE_URL = (process.env.MARKET_BASE_URL || "https://raw.githubusercontent.com/1316584746/M-Market/HEAD/packages").replace(/\/$/, "");
const CHECK = process.argv.includes("--check");

const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const posix = p => p.split(path.sep).join("/");

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(posix(path.relative(base, p)));
  }
  return out;
}

const TEXT = /\.(cjs|mjs|js|json|html|css|svg|md|txt)$/i;
/** 读文件；文本文件统一成 LF，这样在 Windows（CRLF 检出）和 Linux 上打出的包内容一致 */
const read = p => {
  const b = fs.readFileSync(p);
  return TEXT.test(p) && b.includes(13) ? Buffer.from(b.toString("utf8").replace(/\r\n/g, "\n"), "utf8") : b;
};

/** 一个插件源码目录 → 包里的文件列表（含公共库），顺序固定 */
export function collect(id) {
  const dir = path.join(PLUGINS, id);
  const files = new Map();
  for (const rel of walk(dir)) files.set(rel, read(path.join(dir, rel)));
  for (const s of SHARED) files.set(s.to, read(s.from));
  files.delete("checksums.json");
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  validate(id, manifest, files);
  const sums = Object.fromEntries([...files.keys()].sort().map(n => [n, sha256(files.get(n))]));
  const checksums = Buffer.from(JSON.stringify({ algorithm: "sha256", files: sums }, null, 2) + "\n");
  const names = ["manifest.json", ...[...files.keys()].filter(n => n !== "manifest.json").sort(), "checksums.json"];
  const data = new Map(files);
  data.set("checksums.json", checksums);
  return { manifest, names, data };
}

export function validate(dirName, m, files) {
  const err = msg => {
    throw new Error(`${dirName}：${msg}`);
  };
  if (m.id !== dirName) err(`manifest.id（${m.id}）和目录名不一致`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.id)) err("id 不合法");
  if (!/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(String(m.version))) err("version 要是 semver，例如 0.1.0");
  if (!m.name || !m.description) err("缺少 name / description");
  const be = m.entrypoints?.backend?.executable;
  if (be && !files.has(be)) err(`后台程序 ${be} 不存在`);
  const ui = m.entrypoints?.ui;
  if (ui && !files.has(ui.entry)) err(`界面入口 ${ui.entry} 不存在`);
  if (m.icon && !files.has(m.icon)) err(`图标 ${m.icon} 不存在`);
  if (!Array.isArray(m.permissions)) err("permissions 要是数组（没有也写 []）");
}

const pluginIds = () => fs.readdirSync(PLUGINS, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name).sort();
const pkgName = m => `${m.id}-${m.version}.dbxp`;

function readCatalog() {
  try {
    return JSON.parse(fs.readFileSync(CATALOG, "utf8"));
  } catch {
    return { plugins: [] };
  }
}

function main() {
  const old = new Map((readCatalog().plugins || []).map(p => [p.id, p]));
  const entries = [];
  const problems = [];
  if (!CHECK) fs.mkdirSync(PACKAGES, { recursive: true });
  if (!CHECK) fs.mkdirSync(path.dirname(CATALOG), { recursive: true });

  for (const id of pluginIds()) {
    const { manifest: m, names, data } = collect(id);
    const file = pkgName(m);
    const target = path.join(PACKAGES, file);

    let buf;
    if (CHECK) {
      if (!fs.existsSync(target)) {
        problems.push(`${file} 不存在，请运行 node scripts/pack.mjs`);
        continue;
      }
      buf = fs.readFileSync(target);
      // 内容比对（不比 zip 字节：不同 Node 版本的 deflate 结果可能不同）
      const inZip = new Map(readZip(buf).map(f => [f.name, f.data]));
      for (const n of names) if (!inZip.has(n) || sha256(inZip.get(n)) !== sha256(data.get(n))) problems.push(`${file} 里的 ${n} 和源码不一致，请重新打包`);
      for (const n of inZip.keys()) if (!data.has(n)) problems.push(`${file} 里多出文件 ${n}`);
    } else {
      // 内容没变就不重打，避免 git 里出现无意义的二进制差异
      const existing = fs.existsSync(target) ? fs.readFileSync(target) : null;
      let same = false;
      if (existing) {
        try {
          const inZip = new Map(readZip(existing).map(f => [f.name, f.data]));
          same = inZip.size === names.length && names.every(n => inZip.has(n) && sha256(inZip.get(n)) === sha256(data.get(n)));
        } catch {
          same = false;
        }
      }
      buf = same ? existing : writeZip(names.map(n => ({ name: n, data: data.get(n), mode: n.startsWith("bin/") ? 0o755 : 0o644 })));
      if (!same) fs.writeFileSync(target, buf);
      for (const f of fs.readdirSync(PACKAGES)) if (f.startsWith(`${m.id}-`) && f.endsWith(".dbxp") && f !== file) fs.unlinkSync(path.join(PACKAGES, f));
      console.log(`${same ? "未变化" : "已打包"}  ${file}  ${buf.length} 字节`);
    }

    const sum = sha256(buf);
    const prev = old.get(m.id)?.versions?.find(v => v.version === m.version);
    const same = prev?.artifacts?.[0]?.sha256 === sum;
    entries.push({
      id: m.id,
      name: m.name,
      publisher: m.publisher || "M-Market",
      description: m.description,
      license: m.license,
      homepage: m.homepage,
      // 市场卡片里的图标：直接用源码目录里的 SVG（装之前就能看到，不用等装好）
      icon: m.icon && /\/packages$/.test(BASE_URL) ? `${BASE_URL.replace(/\/packages$/, "")}/plugins/${m.id}/${m.icon}` : undefined,
      source: "https://github.com/1316584746/M-Market",
      tags: m.tags || [],
      permissions: m.permissions,
      latestVersion: m.version,
      versions: [
        {
          version: m.version,
          releasedAt: same && prev.releasedAt ? prev.releasedAt : new Date().toISOString().slice(0, 10),
          artifacts: [{ target: "universal", url: `${BASE_URL}/${file}`, sha256: sum, size: buf.length }],
        },
      ],
      localizations: m.localizations || {},
    });
  }

  const catalog = { schemaVersion: 1, name: "M-Market", plugins: entries };
  const text = JSON.stringify(catalog, null, 2) + "\n";
  if (CHECK) {
    const cur = fs.existsSync(CATALOG) ? fs.readFileSync(CATALOG, "utf8") : "";
    if (cur !== text) problems.push("catalog/index.json 和源码、包不一致，请运行 node scripts/pack.mjs");
    if (problems.length) {
      console.error(problems.map(p => `✗ ${p}`).join("\n"));
      process.exit(1);
    }
    console.log(`✓ ${entries.length} 个插件的包和目录都是最新的`);
    return;
  }
  fs.writeFileSync(CATALOG, text);
  console.log(`catalog/index.json 已更新（${entries.length} 个插件）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
