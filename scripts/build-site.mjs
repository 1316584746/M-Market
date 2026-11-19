#!/usr/bin/env node
// 生成对外网站（纯静态，可放 GitHub Pages）：site-dist/
//   node scripts/build-site.mjs                 只含本仓库的官方插件
//   node scripts/build-site.mjs --aggregate     再抓上游的 DSH 市场索引，合并成一份可搜索的目录（每日 CI 用）
//   --upstream <url>  可重复；不给就用默认的 DSH 插件市场索引
// 上游抓不到时不会让构建失败：那一家跳过并在日志里说明；全部抓不到也只剩官方插件。
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { parseCatalog } = require(path.join(ROOT, "plugins", "market", "bin", "catalog.cjs"));

export const DEFAULT_UPSTREAMS = [{ name: "dsh-hub", url: "https://dshbazaar.io/api/index.json" }];
const clip = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

/** 把若干来源合成一份紧凑目录。own 是本仓库的 DBX 目录 JSON；upstreams 是 [{ name, json }] */
export function buildCatalog(own, upstreams = [], now = new Date()) {
  const out = [];
  const seen = new Set();
  const add = (entries, official) => {
    for (const e of entries) {
      const uid = `${e.kind}:${e.id}`;
      if (seen.has(uid)) continue;
      seen.add(uid);
      const file = e.install?.url ? path.posix.basename(new URL(e.install.url, "http://x").pathname) : "";
      out.push({
        id: e.id,
        name: e.name,
        kind: e.kind,
        official: official || undefined,
        author: e.author,
        description: clip(e.description, 240),
        category: e.category,
        tags: (e.tags || []).slice(0, 6),
        version: e.version,
        stars: e.stars,
        updated: e.updated,
        repo: e.repo,
        homepage: e.homepage,
        download: official && file ? `packages/${file}` : undefined,
      });
    }
  };
  add(parseCatalog(own, "M-Market", "zh-CN"), true);
  const problems = [];
  for (const u of upstreams) {
    try {
      add(parseCatalog(u.json, u.name, "zh-CN"), false);
    } catch (e) {
      problems.push(`${u.name}：${e.message}`);
    }
  }
  return { generatedAt: now.toISOString(), plugins: JSON.parse(JSON.stringify(out)), problems };
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000), headers: { "user-agent": "m-market-site" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse((await res.text()).replace(/^\uFEFF/, ""));
}

async function main() {
  const args = process.argv.slice(2);
  const aggregate = args.includes("--aggregate");
  const urls = args.flatMap((a, i) => (a === "--upstream" && args[i + 1] ? [args[i + 1]] : []));
  const ups = urls.length ? urls.map((u, i) => ({ name: `upstream-${i + 1}`, url: u })) : DEFAULT_UPSTREAMS;

  const own = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog", "index.json"), "utf8"));
  const upstreams = [];
  if (aggregate) {
    for (const u of ups) {
      try {
        upstreams.push({ name: u.name, json: await fetchJson(u.url) });
        console.log(`已抓取 ${u.name}`);
      } catch (e) {
        console.warn(`跳过 ${u.name}（${u.url}）：${e.message}`);
      }
    }
  }
  const cat = buildCatalog(own, upstreams);
  cat.problems.forEach(p => console.warn("跳过：" + p));

  const dist = path.join(ROOT, "site-dist");
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, "packages"), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, "site"))) fs.copyFileSync(path.join(ROOT, "site", f), path.join(dist, f));
  for (const f of fs.readdirSync(path.join(ROOT, "packages"))) if (f.endsWith(".dbxp")) fs.copyFileSync(path.join(ROOT, "packages", f), path.join(dist, "packages", f));
  fs.writeFileSync(path.join(dist, "catalog.json"), JSON.stringify({ generatedAt: cat.generatedAt, plugins: cat.plugins }));
  fs.writeFileSync(path.join(dist, ".nojekyll"), "");
  const official = cat.plugins.filter(p => p.official).length;
  console.log(`site-dist/ 已生成：${cat.plugins.length} 个插件（官方 ${official}，社区 ${cat.plugins.length - official}）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
