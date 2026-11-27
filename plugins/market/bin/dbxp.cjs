"use strict";
/** .dbxp 安装：下载 → 核对 sha256 → 安全解压 → 核对包内 checksums.json → 放进 plugins/<id>/versions/<版本>/ */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const MAX_PACKAGE = 64 * 1024 * 1024;
const MAX_FILES = 5000;
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const safeId = id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
const safeVer = v => /^[A-Za-z0-9._+-]+$/.test(v);

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip 包");
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_FILES) throw new Error("包里文件太多，已拒绝");
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 目录损坏");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/")) continue; // 目录项
    total += usize;
    if (total > MAX_PACKAGE * 4) throw new Error("解压后太大，已拒绝");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
    else throw new Error(`不支持的压缩方式：${method}`);
    if (data.length !== usize) throw new Error(`${name} 大小对不上`);
    out.push({ name, data });
  }
  return out;
}

/** 校验并安装一个已在内存里的包；返回 { id, version, name } */
function installBuffer(buf, root, expect = {}) {
  if (buf.length > MAX_PACKAGE) throw new Error("插件包太大，已拒绝");
  const files = readZip(buf);
  const by = new Map(files.map(f => [f.name, f.data]));
  const mraw = by.get("manifest.json");
  if (!mraw) throw new Error("插件包里没有 manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(mraw.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("插件的 manifest.json 解析失败");
  }
  const id = String(manifest?.id ?? "");
  const version = String(manifest?.version ?? "");
  if (expect.id && id !== expect.id) throw new Error(`插件包的 id（${id}）和目录里的（${expect.id}）不一致`);
  if (expect.version && version !== expect.version) throw new Error(`插件包的版本（${version}）和目录里的（${expect.version}）不一致`);
  if (!safeId(id)) throw new Error(`插件 id 不合法：${id}`);
  if (!safeVer(version)) throw new Error(`插件版本号不合法：${version}`);

  const sums = by.get("checksums.json");
  if (!sums) throw new Error("插件包里没有 checksums.json，没法校验完整性，已拒绝安装");
  let list;
  try {
    list = JSON.parse(sums.toString("utf8")).files ?? {};
  } catch {
    throw new Error("插件的 checksums.json 解析失败");
  }
  for (const [name, want] of Object.entries(list)) {
    const data = by.get(name);
    if (!data) throw new Error(`插件包缺少文件：${name}`);
    if (sha256(data) !== String(want).toLowerCase()) throw new Error(`插件文件校验失败：${name}`);
  }

  // 包里的每个文件都得在校验清单里：否则可以在清单之外夹带一个没被校验的文件一起装进去
  for (const f of files) {
    if (f.name !== "checksums.json" && !Object.prototype.hasOwnProperty.call(list, f.name)) throw new Error(`插件包里有没列入校验清单的文件：${f.name}`);
    if (/[\\:\0]/.test(f.name)) throw new Error(`插件包里有不安全的路径：${f.name}`);
  }

  const pluginDir = path.join(root, id);
  const vdir = path.join(pluginDir, "versions");
  const tmp = path.join(pluginDir, `.tmp-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(vdir, { recursive: true });
  try {
    for (const f of files) {
      const dest = path.join(tmp, ...f.name.split("/"));
      if (path.isAbsolute(f.name) || path.relative(tmp, dest).startsWith("..")) throw new Error(`插件包里有不安全的路径：${f.name}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.data, { mode: /^bin\//.test(f.name) ? 0o755 : 0o644 });
    }
    const final = path.join(vdir, version);
    try {
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(tmp, final);
    } catch (e) {
      if (e && (e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES")) throw new Error("插件文件正被占用（这个插件的后台程序可能还在运行），请先关掉它再试");
      throw e;
    }
    for (const d of fs.readdirSync(vdir)) if (d !== version) fs.rmSync(path.join(vdir, d), { recursive: true, force: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { id, version, name: typeof manifest.name === "string" ? manifest.name : id, backend: !!manifest.entrypoints?.backend, permissions: Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [] };
}

/** 已装插件：{ id: { version, name } }，每个插件取最高版本 */
function scanInstalled(root, cmp) {
  const out = {};
  let ids = [];
  try {
    ids = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name);
  } catch {
    return out;
  }
  for (const id of ids) {
    let vs = [];
    try {
      vs = fs.readdirSync(path.join(root, id, "versions"), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      continue;
    }
    vs = vs.filter(v => fs.existsSync(path.join(root, id, "versions", v, "manifest.json"))).sort(cmp);
    if (!vs.length) continue;
    const version = vs[vs.length - 1];
    let name = id;
    try {
      name = JSON.parse(fs.readFileSync(path.join(root, id, "versions", version, "manifest.json"), "utf8").replace(/^\uFEFF/, "")).name || id;
    } catch {
      /* 清单坏了就用 id */
    }
    out[id] = { version, name };
  }
  return out;
}

function uninstall(id, root) {
  if (!safeId(id)) throw new Error("插件 id 不合法");
  const dir = path.join(root, id);
  if (!fs.existsSync(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    if (e && (e.code === "EBUSY" || e.code === "EPERM")) throw new Error("插件文件正被占用（后台程序还在运行），请先关掉它再卸载");
    throw e;
  }
  return true;
}

module.exports = { readZip, installBuffer, scanInstalled, uninstall, sha256, MAX_PACKAGE };
