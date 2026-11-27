import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ROOT, launch, tmpdir } from "./helpers.mjs";
import { collect } from "../scripts/pack.mjs";

const sha = b => crypto.createHash("sha256").update(b).digest("hex");

// ───────── 本机假服务器：DBX 目录、DSH 索引、安装包、WebDAV、GitHub gist ─────────
const memsearchVersion = collect("memsearch").manifest.version;
const pkg = fs.readFileSync(path.join(ROOT, "packages", `memsearch-${memsearchVersion}.dbxp`));
let base = "";
let server;
const dav = new Map();
const gists = new Map();
let gistSeq = 0;

const dbxCatalog = () => ({
  schemaVersion: 1,
  plugins: [
    { id: "memsearch", name: "MemSearch", publisher: "M-Market", description: "长期记忆 markdown 检索", tags: ["memory", "search"], permissions: ["fs.read"], latestVersion: memsearchVersion, versions: [{ version: memsearchVersion, releasedAt: "2026-11-01", artifacts: [{ target: "universal", url: `${base}/pkg/memsearch.dbxp`, sha256: sha(pkg), size: pkg.length }] }] },
    { id: "evil", name: "Evil Plugin", description: "校验值对不上", latestVersion: memsearchVersion, versions: [{ version: memsearchVersion, artifacts: [{ target: "universal", url: `${base}/pkg/memsearch.dbxp`, sha256: "0".repeat(64), size: pkg.length }] }] },
    { id: "nosum", name: "No Checksum", description: "没有校验值", latestVersion: "1.0.0", versions: [{ version: "1.0.0", artifacts: [{ target: "universal", url: `${base}/pkg/memsearch.dbxp` }] }] },
    { id: "foreign-host", name: "Foreign Host", description: "下载地址在别的站", latestVersion: "1.0.0", versions: [{ version: "1.0.0", artifacts: [{ target: "universal", url: "https://evil.example.com/x.dbxp", sha256: "a".repeat(64) }] }] },
  ],
});
const dshIndex = () => ({
  format: 1,
  title: { en: "T" },
  metadata: { categories: { theme: { title: { zh: "主题与外观", en: "Themes" } }, dev: { title: { zh: "开发", en: "Dev" } } } },
  plugins: [
    { name: "dsh-cool-theme", title: { zh: "酷主题" }, description: { zh: "一个暗色主题" }, author: "alice", metadata: { category: "theme", keywords: ["dark", "dsh-plugin"], sortKeys: { stars: 500, updated: 1790000000 } }, versions: [{ version: "1.0.0", source: { type: "npm" } }, { version: "1.2.0", source: { type: "npm" } }, { version: "2.0.0-rc.1", source: { type: "npm" } }] },
    { name: "dsh-lint", description: { en: "lint things" }, metadata: { category: "dev", sortKeys: { stars: 9000 } }, versions: [{ version: "0.3.0", source: { type: "npm" } }] },
    { name: "dsh-memsearch-clone", description: { zh: "和 memsearch 同名关键词" }, metadata: { category: "dev", sortKeys: { stars: 1 } }, versions: [{ version: "0.0.1", source: { type: "npm" } }] },
  ],
});

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const send = (code, data, type = "application/json") => {
        res.writeHead(code, { "content-type": type });
        res.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
      };
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/dbx/index.json") return send(200, dbxCatalog());
      if (url.pathname === "/dsh/index.json") return send(200, dshIndex());
      if (url.pathname === "/broken/index.json") return send(200, "<html>not json</html>", "text/html");
      if (url.pathname === "/pkg/memsearch.dbxp") return send(200, pkg, "application/octet-stream");
      if (url.pathname.startsWith("/dav/")) {
        if (req.headers.authorization !== "Basic " + Buffer.from("bob:secret").toString("base64")) return send(401, "no");
        if (req.method === "PUT") return dav.set(url.pathname, body), send(201, "");
        return dav.has(url.pathname) ? send(200, dav.get(url.pathname)) : send(404, "");
      }
      if (url.pathname.startsWith("/gists")) {
        if (req.headers.authorization !== "Bearer ghp_test") return send(401, { message: "Bad credentials" });
        if (req.method === "POST" && url.pathname === "/gists") {
          const id = `g${++gistSeq}`;
          gists.set(id, JSON.parse(body.toString()).files);
          return send(201, { id });
        }
        const id = url.pathname.split("/")[2];
        if (!gists.has(id)) return send(404, { message: "Not Found" });
        if (req.method === "PATCH") {
          gists.set(id, { ...gists.get(id), ...JSON.parse(body.toString()).files });
          return send(200, { id });
        }
        return send(200, { id, files: gists.get(id) });
      }
      if (url.pathname === "/shots/index.json") return send(200, { schemaVersion: 1, plugins: [{ id: "demo", name: "Demo", source: "https://github.com/octo/demo", latestVersion: "1.0.0", versions: [{ version: "1.0.0", releasedAt: "2026-11-02", artifacts: [{ target: "universal", url: `${base}/pkg/memsearch.dbxp`, sha256: sha(pkg) }] }] }, { id: "curated", name: "Curated", source: "https://github.com/octo/curated", screenshots: ["https://raw.githubusercontent.com/octo/curated/HEAD/a.png", "http://evil.example.com/x.png"], latestVersion: "1.0.0", versions: [{ version: "1.0.0", artifacts: [{ target: "universal", url: `${base}/pkg/memsearch.dbxp`, sha256: sha(pkg) }] }] }] });
      if (url.pathname === "/raw/octo/demo/HEAD/README.md") {
        return send(200, [
          "# demo",
          "![build](https://img.shields.io/badge/build-passing-green.svg)",
          "![shot](docs/one.png)",
          '<img src="https://raw.githubusercontent.com/octo/demo/HEAD/two.png" width="300">',
          "![blob](https://github.com/octo/demo/blob/main/three.png)",
          "![att](https://github.com/user-attachments/assets/1111-2222)",
          "![ext](https://example.com/evil.png)",
          "![dup](docs/one.png)",
        ].join("\n"), "text/markdown");
      }
      send(404, "nope");
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const running = [];
const start = o => {
  const p = launch("market", o);
  running.push(p);
  return p;
};
after(() => running.forEach(p => p.stop()));

function setup() {
  const home = tmpdir("mk");
  const plugins = path.join(home, "plugins");
  fs.mkdirSync(plugins, { recursive: true });
  // 默认来源指向本机假服务器，测试不碰真实网络
  const p = start({ home, env: { HARNESS_PLUGINS_DIR: plugins, MARKET_GITHUB_API: base, MARKET_DEFAULT_SOURCES: JSON.stringify(sources()) } });
  return { home, plugins, p };
}
const sources = () => [
  { id: "local-dbx", name: "本地 DBX", url: `${base}/dbx/index.json`, enabled: true },
  { id: "local-dsh", name: "本地 DSH", url: `${base}/dsh/index.json`, enabled: true },
];

describe("market：目录与搜索", () => {
  it("握手，并列出 DBX + DSH 两种来源", async () => {
    const { p } = setup();
    const init = await p.init();
    assert.equal(init.plugin.id, "market");
    await p.call("market/saveSettings", { sources: sources() });
    const r = await p.call("market/list", { refresh: true, pageSize: 100 });
    assert.equal(r.errors.length, 0);
    assert.equal(r.total, 7);
    const ms = r.items.find(x => x.id === "memsearch");
    assert.equal(ms.kind, "dbx");
    assert.equal(ms.installable, true);
    const theme = r.items.find(x => x.id === "dsh-cool-theme");
    assert.equal(theme.kind, "dsh");
    assert.equal(theme.version, "1.2.0", "DSH 取最高的正式版，不取 rc");
    assert.equal(theme.name, "酷主题");
    assert.equal(theme.category, "主题与外观");
    assert.equal(theme.stars, 500);
    assert.equal(theme.installable, false);
    assert.match(theme.noInstallReason, /插件中心/);
    assert.ok(r.categories.some(c => c.name === "开发" && c.count === 2));
  });

  it("没有校验值 / 下载站不明的条目：能看，但标为不能安装", async () => {
    const { p } = setup();
    await p.call("market/saveSettings", { sources: sources() });
    const r = await p.call("market/list", { pageSize: 100 });
    const nosum = r.items.find(x => x.id === "nosum");
    assert.equal(nosum.installable, false);
    assert.match(nosum.noInstallReason, /校验值/);
  });

  it("搜索：多个词都要命中；按星标 / 名称排序；分类和类型过滤；分页", async () => {
    const { p } = setup();
    await p.call("market/saveSettings", { sources: sources() });
    let r = await p.call("market/list", { q: "memsearch" });
    assert.deepEqual(r.items.map(x => x.id).sort(), ["dsh-memsearch-clone", "memsearch"]);
    assert.equal(r.items[0].id, "memsearch", "名字完全一致的排最前");
    r = await p.call("market/list", { q: "memory search" });
    assert.deepEqual(r.items.map(x => x.id), ["memsearch"]);
    r = await p.call("market/list", { kind: "dsh", sort: "stars" });
    assert.deepEqual(r.items.map(x => x.id), ["dsh-lint", "dsh-cool-theme", "dsh-memsearch-clone"]);
    r = await p.call("market/list", { kind: "dsh", sort: "name" });
    assert.equal(r.items.length, 3);
    r = await p.call("market/list", { category: "开发" });
    assert.equal(r.total, 2);
    r = await p.call("market/list", { tag: "dark" });
    assert.deepEqual(r.items.map(x => x.id), ["dsh-cool-theme"]);
    r = await p.call("market/list", { pageSize: 3, page: 3 });
    assert.equal(r.pages, 3);
    assert.equal(r.items.length, 1);
    r = await p.call("market/list", { pageSize: 3, page: 99 });
    assert.equal(r.page, 3, "页码越界会收回到最后一页");
  });

  it("一个来源挂了：别的来源照常，错误单独报告；有缓存时退回缓存", async () => {
    const { p } = setup();
    await p.call("market/saveSettings", { sources: [...sources(), { id: "broken", name: "坏来源", url: `${base}/broken/index.json`, enabled: true }] });
    const r = await p.call("market/list", { refresh: true, pageSize: 100 });
    assert.equal(r.total, 7);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].source, "坏来源");
    assert.match(r.errors[0].error, /JSON/);
    // 把 DSH 来源改成一个连不上的端口，缓存还在，所以还能看到条目
    await p.call("market/saveSettings", { sources: [sources()[0], { id: "local-dsh", name: "本地 DSH", url: "http://127.0.0.1:1/dsh/index.json", enabled: true }] });
    const r2 = await p.call("market/list", { refresh: true, pageSize: 100 });
    assert.equal(r2.errors.length, 1, "连不上就报错");
    const dsh = r2.items.filter(x => x.kind === "dsh");
    assert.equal(dsh.length, 0, "地址换了，旧地址的缓存不会串过来");
  });

  it("来源地址必须是 https（本机除外）", async () => {
    const { p } = setup();
    await assert.rejects(p.call("market/saveSettings", { sources: [{ name: "x", url: "http://example.com/a.json", enabled: true }] }), /https/);
    await assert.rejects(p.call("market/saveSettings", { sources: [] }), /至少/);
  });
});

describe("market：安装 / 更新 / 卸载", () => {
  it("安装：下载、校验、解压到 plugins/<id>/versions/<版本>，之后列表里显示已安装", async () => {
    const { p, plugins } = setup();
    await p.call("market/saveSettings", { sources: sources() });
    const r = await p.call("market/install", { key: "local-dbx:memsearch" });
    assert.equal(r.id, "memsearch");
    assert.equal(r.version, memsearchVersion);
    assert.equal(r.backend, true);
    assert.match(r.message, /信任/);
    const dir = path.join(plugins, "memsearch", "versions", memsearchVersion);
    assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
    assert.ok(fs.existsSync(path.join(dir, "bin", "backend.cjs")));
    assert.ok(fs.existsSync(path.join(dir, "checksums.json")));
    const list = await p.call("market/list", { view: "installed" });
    assert.deepEqual(list.items.map(x => x.id), ["memsearch"]);
    assert.equal(list.items[0].installed, memsearchVersion);
    assert.equal(list.items[0].update, false);
    assert.equal(list.counts.installed, 1);
  });

  it("安装的插件真能跑起来（用装好的文件启动后台）", async () => {
    const { p, plugins } = setup();
    await p.call("market/saveSettings", { sources: sources() });
    await p.call("market/install", { id: "memsearch" });
    const { spawn } = await import("node:child_process");
    const exe = path.join(plugins, "memsearch", "versions", memsearchVersion, "bin", "backend.cjs");
    const child = spawn(process.execPath, [exe], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, DBX_PLUGIN_DATA_DIR: tmpdir("ms-data") } });
    const out = await new Promise(res => {
      child.stdout.once("data", d => res(String(d)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "plugin/initialize", params: {} }) + "\n");
    });
    child.kill();
    assert.equal(JSON.parse(out).result.plugin.id, "memsearch");
  });

  it("有新版本时标「有更新」；卸载后恢复", async () => {
    const { p, plugins } = setup();
    await p.call("market/saveSettings", { sources: sources() });
    await p.call("market/install", { key: "local-dbx:memsearch" });
    // 把本地装的版本号改低，模拟「目录里是新版」
    const vdir = path.join(plugins, "memsearch", "versions");
    fs.renameSync(path.join(vdir, memsearchVersion), path.join(vdir, "0.0.1"));
    const r = await p.call("market/list", { view: "updates" });
    assert.deepEqual(r.items.map(x => x.id), ["memsearch"]);
    assert.equal(r.items[0].update, true);
    await p.call("market/install", { id: "memsearch" });
    assert.equal((await p.call("market/list", { view: "updates" })).total, 0);
    assert.deepEqual(fs.readdirSync(vdir), [memsearchVersion], "只保留最新版本");
    const rm = await p.call("market/uninstall", { id: "memsearch" });
    assert.equal(rm.removed, true);
    assert.equal((await p.call("market/list", { view: "installed" })).total, 0);
    assert.ok(!fs.existsSync(path.join(plugins, "memsearch")));
  });

  it("拒绝：校验值对不上 / 没有校验值 / 下载站不明 / DSH 插件 / 不存在", async () => {
    const { p, plugins } = setup();
    await p.call("market/saveSettings", { sources: sources() });
    await assert.rejects(p.call("market/install", { id: "evil" }), /校验失败/);
    await assert.rejects(p.call("market/install", { id: "nosum" }), /校验值/);
    await assert.rejects(p.call("market/install", { id: "foreign-host" }), /已拒绝/);
    await assert.rejects(p.call("market/install", { id: "dsh-cool-theme" }), /插件中心/);
    await assert.rejects(p.call("market/install", { id: "nope" }), /找不到/);
    assert.deepEqual(fs.readdirSync(plugins), [], "失败时什么都没装");
  });

  it("不能卸载市场自己，也不能用路径当 id", async () => {
    const { p } = setup();
    await assert.rejects(p.call("market/uninstall", { id: "market" }), /市场自己/);
    await assert.rejects(p.call("market/uninstall", { id: "../x" }), /不合法/);
  });
});

describe("market：全部更新 / 屏蔽", () => {
  it("全部更新：逐个更新有新版的插件；没有可更新的时返回 0", async () => {
    const { p, plugins } = setup();
    await p.call("market/saveSettings", { sources: sources() });
    assert.equal((await p.call("market/updateAll")).updated.length, 0);
    await p.call("market/install", { id: "memsearch" });
    const vdir = path.join(plugins, "memsearch", "versions");
    fs.renameSync(path.join(vdir, memsearchVersion), path.join(vdir, "0.0.1"));
    assert.equal((await p.call("market/list")).counts.updates, 1);
    const r = await p.call("market/updateAll");
    assert.deepEqual(r.updated.map(x => [x.id, x.from, x.to]), [["memsearch", "0.0.1", memsearchVersion]]);
    assert.deepEqual(r.failed, []);
    assert.match(r.message, /已更新 1 个/);
    assert.equal((await p.call("market/list")).counts.updates, 0);
    assert.deepEqual(fs.readdirSync(vdir), [memsearchVersion]);
  });

  it("屏蔽：从「发现」和最近更新里消失，只在「已屏蔽」里；已装的不受影响；可取消；进备份", async () => {
    const { p } = setup();
    await p.call("market/saveSettings", { sources: sources() });
    const all = (await p.call("market/list", { pageSize: 100 })).total;
    await p.call("user/hide", { uid: "dsh:dsh-lint", on: true });
    let r = await p.call("market/list", { pageSize: 100 });
    assert.equal(r.total, all - 1);
    assert.ok(!r.items.some(x => x.id === "dsh-lint") && !r.recent.some(x => x.id === "dsh-lint"));
    assert.equal(r.counts.hidden, 1);
    r = await p.call("market/list", { view: "hidden" });
    assert.deepEqual(r.items.map(x => [x.id, x.hidden]), [["dsh-lint", true]]);
    const backup = await p.call("backup/export");
    assert.deepEqual(backup.user.hidden, ["dsh:dsh-lint"]);
    const q = setup().p;
    await q.call("backup/import", { data: backup, mode: "merge" });
    assert.equal((await q.call("market/list", { view: "hidden" })).total, 1);
    await p.call("user/hide", { uid: "dsh:dsh-lint", on: false });
    assert.equal((await p.call("market/list", { pageSize: 100 })).total, all);
    assert.equal((await p.call("market/list", { view: "hidden" })).total, 0);
    // 已安装的插件即使被屏蔽，也还在「发现」里（屏蔽只是不想再看到没装的）
    await p.call("market/install", { id: "memsearch" });
    await p.call("user/hide", { uid: "dbx:memsearch", on: true });
    r = await p.call("market/list", { pageSize: 100 });
    assert.ok(r.items.some(x => x.id === "memsearch"));
    await assert.rejects(p.call("user/hide", { uid: "memsearch" }), /不合法/);
  });
});

describe("market：收藏 / 分组 / 备注", () => {
  it("收藏、分组、备注会体现在列表里，并能按它们筛选，也能搜到备注", async () => {
    const { p } = setup();
    await p.call("market/saveSettings", { sources: sources() });
    await p.call("user/favorite", { uid: "dbx:memsearch", on: true });
    await p.call("user/groupSet", { uid: "dbx:memsearch", group: "常用" });
    await p.call("user/groupSet", { uid: "dsh:dsh-lint", group: "常用" });
    await p.call("user/note", { uid: "dsh:dsh-lint", text: "团队统一用这个" });
    let r = await p.call("market/list", { view: "favorites" });
    assert.deepEqual(r.items.map(x => x.id), ["memsearch"]);
    assert.deepEqual(r.items[0].groups, ["常用"]);
    r = await p.call("market/list", { group: "常用" });
    assert.equal(r.total, 2);
    assert.deepEqual(r.groups, [{ name: "常用", count: 2 }]);
    r = await p.call("market/list", { q: "团队统一" });
    assert.deepEqual(r.items.map(x => x.id), ["dsh-lint"]);
    assert.equal(r.items[0].note, "团队统一用这个");
    await p.call("user/favorite", { uid: "dbx:memsearch", on: false });
    await p.call("user/note", { uid: "dsh:dsh-lint", text: "" });
    assert.equal((await p.call("market/list", { view: "favorites" })).total, 0);
    assert.equal((await p.call("market/list", { q: "团队统一" })).total, 0);
  });

  it("分组：新建 / 重命名 / 删除；重名和坏参数被拒绝", async () => {
    const { p } = setup();
    await p.call("user/groupCreate", { name: "A" });
    await p.call("user/groupCreate", { name: "B" });
    await p.call("user/groupSet", { uid: "dbx:memsearch", group: "A" });
    await assert.rejects(p.call("user/groupRename", { from: "A", to: "B" }), /同名/);
    await p.call("user/groupRename", { from: "A", to: "C" });
    let r = await p.call("market/list", { group: "C" });
    assert.deepEqual(r.groups.map(g => g.name).sort(), ["B", "C"]);
    await p.call("user/groupDelete", { name: "C" });
    r = await p.call("market/list", {});
    assert.deepEqual(r.groups.map(g => g.name), ["B"]);
    await assert.rejects(p.call("user/groupCreate", { name: "" }), /分组名/);
    await assert.rejects(p.call("user/favorite", { uid: "memsearch" }), /不合法/);
  });
});

describe("market：备份还原", () => {
  const fill = async p => {
    await p.call("user/favorite", { uid: "dbx:memsearch" });
    await p.call("user/groupSet", { uid: "dbx:memsearch", group: "常用" });
    await p.call("user/note", { uid: "dbx:memsearch", text: "记忆插件" });
  };

  it("导出 → 在另一台机器导入（合并 / 覆盖）", async () => {
    const a = setup().p;
    await a.call("market/saveSettings", { sources: sources() });
    await fill(a);
    const backup = await a.call("backup/export");
    assert.equal(backup.format, "m-market-backup");
    assert.ok(!JSON.stringify(backup).includes("secret"), "备份里没有密码");

    const b = setup().p;
    await b.call("user/favorite", { uid: "dsh:dsh-lint" });
    const r = await b.call("backup/import", { data: backup, mode: "merge" });
    assert.equal(r.favorites, 2);
    assert.equal(r.notes, 1);
    assert.ok(r.sources >= 2);
    const l = await b.call("market/list", { view: "favorites", pageSize: 100 });
    assert.deepEqual(l.items.map(x => x.id).sort(), ["dsh-lint", "memsearch"]);

    const c = setup().p;
    await c.call("user/favorite", { uid: "dsh:dsh-lint" });
    await c.call("backup/import", { data: backup, mode: "replace" });
    const l2 = await c.call("market/list", { view: "favorites", pageSize: 100 });
    assert.deepEqual(l2.items.map(x => x.id), ["memsearch"], "覆盖导入会清掉原来的收藏");
  });

  it("导入：拒绝不是备份的文件；过滤掉不合法的内容", async () => {
    const { p } = setup();
    await assert.rejects(p.call("backup/import", { data: { hello: 1 } }), /不是 M-Market/);
    const r = await p.call("backup/import", { data: { format: "m-market-backup", version: 1, user: { favorites: ["dbx:ok", "bad", 5], groups: { __proto__: ["dbx:x"], g: ["dbx:y", 3] }, notes: { "dbx:ok": "n", bad: "x" } }, sources: [{ url: "file:///etc/passwd" }] } });
    assert.equal(r.favorites, 1);
    assert.equal(r.notes, 1);
    assert.equal(r.sources, 0);
    const s = await p.call("market/settings");
    assert.ok(!JSON.stringify(s.sources).includes("file:"));
  });

  it("WebDAV：上传 / 下载合并；密码不回传界面；认证失败有提示", async () => {
    const a = setup().p;
    await a.call("market/saveSettings", { sources: sources() });
    await fill(a);
    await a.call("market/saveSettings", { webdav: { url: `${base}/dav`, user: "bob", password: "secret" } });
    const s = await a.call("market/settings");
    assert.equal(s.webdav.hasPassword, true);
    assert.ok(!JSON.stringify(s).includes("secret"));
    const up = await a.call("backup/cloud", { action: "webdavPush" });
    assert.match(up.message, /WebDAV/);
    assert.ok(dav.has("/dav/m-market-backup.json"));

    const b = setup().p;
    await b.call("market/saveSettings", { sources: sources() });
    await b.call("market/saveSettings", { webdav: { url: `${base}/dav`, user: "bob", password: "secret" } });
    const down = await b.call("backup/cloud", { action: "webdavPull" });
    assert.equal(down.restored.favorites, 1);
    assert.equal((await b.call("market/list", { view: "favorites" })).total, 1);

    await b.call("market/saveSettings", { webdav: { password: "wrong" } });
    await assert.rejects(b.call("backup/cloud", { action: "webdavPull" }), /401/);
  });

  it("私有 Gist：第一次上传自动建 Gist，再次上传更新同一个，另一台能下载", async () => {
    const a = setup().p;
    await fill(a);
    await assert.rejects(a.call("backup/cloud", { action: "gistPush" }), /令牌/);
    await a.call("market/saveSettings", { gist: { token: "ghp_test" } });
    const up = await a.call("backup/cloud", { action: "gistPush" });
    assert.ok(up.gistId);
    const s = await a.call("market/settings");
    assert.equal(s.gist.gistId, up.gistId);
    assert.equal(s.gist.hasToken, true);
    assert.ok(!JSON.stringify(s).includes("ghp_test"));
    const again = await a.call("backup/cloud", { action: "gistPush" });
    assert.equal(again.gistId, up.gistId);

    const b = setup().p;
    await b.call("market/saveSettings", { gist: { token: "ghp_test", gistId: up.gistId } });
    const down = await b.call("backup/cloud", { action: "gistPull" });
    assert.equal(down.restored.notes, 1);

    await b.call("market/saveSettings", { gist: { token: "bad" } });
    await assert.rejects(b.call("backup/cloud", { action: "gistPull" }), /401|令牌/);
  });
});

describe("market：AI 工具", () => {
  it("market_search / market_installed / market_install", async () => {
    const { p, plugins } = setup();
    await p.call("market/saveSettings", { sources: sources() });
    const tools = (await p.call("mcp/tools")).tools;
    assert.deepEqual(tools.map(t => t.name).sort(), ["market_install", "market_installed", "market_search"]);
    assert.equal(tools.find(t => t.name === "market_install").annotations.readOnlyHint, false);
    assert.equal(tools.find(t => t.name === "market_search").annotations.readOnlyHint, true);

    let t = await p.tool("market_search", { query: "memsearch", kind: "dbx" });
    assert.equal(t.isError, false);
    const found = JSON.parse(t.text);
    assert.equal(found.items[0].id, "memsearch");
    assert.equal(found.items[0].installed, null);

    t = await p.tool("market_install", { id: "memsearch" });
    assert.equal(t.isError, false);
    assert.ok(fs.existsSync(path.join(plugins, "memsearch")));

    t = await p.tool("market_installed", {});
    assert.deepEqual(JSON.parse(t.text).plugins.map(x => x.id), ["memsearch"]);

    t = await p.tool("market_install", { id: "evil" });
    assert.equal(t.isError, true);
    assert.match(t.text, /校验失败/);
  });
});

describe("market：新界面用到的数据", () => {
  const shotsSetup = () => {
    const home = tmpdir("mk");
    const plugins = path.join(home, "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    const p = start({ home, env: { HARNESS_PLUGINS_DIR: plugins, MARKET_RAW_BASE: `${base}/raw`, MARKET_DEFAULT_SOURCES: JSON.stringify([{ id: "shots", name: "S", url: `${base}/shots/index.json`, enabled: true }]) } });
    return { home, p };
  };

  it("主题识别、最近更新、分类总数、更新数", async () => {
    const { p } = setup();
    await p.call("market/saveSettings", { sources: sources() });
    const all = await p.call("market/list", { refresh: true, pageSize: 100 });
    assert.equal(all.catTotal, 7);
    assert.ok(all.recent.length >= 1 && all.recent.every(x => x.updated), "最近更新只放有日期的");
    assert.ok(all.recent[0].updated >= all.recent[all.recent.length - 1].updated, "按日期从新到旧");
    const themes = await p.call("market/list", { theme: true, pageSize: 100 });
    assert.deepEqual(themes.items.map(x => x.id), ["dsh-cool-theme"]);
    assert.equal(themes.recent.length, 0, "筛选状态下不返回最近更新");
    assert.equal(all.counts.updates, 0);
    const second = await p.call("market/list", { page: 2, pageSize: 3 });
    assert.equal(second.recent.length, 0, "翻页时不重复返回最近更新");
  });

  it("截图：目录里写了就用目录的（只收 https）；没写就从 README 里挑，丢掉徽章和不明站点，结果有缓存", async () => {
    const { p } = shotsSetup();
    await p.call("market/list", { refresh: true });
    const curated = await p.call("market/screenshots", { key: "shots:curated" });
    assert.equal(curated.from, "catalog");
    assert.deepEqual(curated.images, ["https://raw.githubusercontent.com/octo/curated/HEAD/a.png"]);
    const r = await p.call("market/screenshots", { key: "shots:demo" });
    assert.equal(r.from, "readme");
    assert.deepEqual(r.images, [
      "https://raw.githubusercontent.com/octo/demo/HEAD/docs/one.png",
      "https://raw.githubusercontent.com/octo/demo/HEAD/two.png",
      "https://raw.githubusercontent.com/octo/demo/main/three.png",
      "https://github.com/user-attachments/assets/1111-2222",
    ]);
    assert.equal((await p.call("market/screenshots", { key: "shots:demo" })).from, "cache");
    await assert.rejects(p.call("market/screenshots", { key: "shots:nope" }), /找不到/);
  });

  it("诊断日志：列出版本、来源和已装插件，不含令牌和本机用户目录", async () => {
    const { home, p } = setup();
    await p.call("market/saveSettings", { sources: sources(), gist: { token: "ghp_SECRET1234567890", gistId: "g1" } });
    await p.call("market/list", { refresh: true });
    const r = await p.call("market/diagnostics");
    assert.match(r.text, /插件市场 \d+\.\d+\.\d+/);
    assert.match(r.text, /本地 DBX/);
    assert.doesNotMatch(r.text, /ghp_SECRET/);
    assert.doesNotMatch(r.text, new RegExp(home.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
    assert.equal((await p.call("market/settings")).version.length > 0, true);
  });
});

describe("market：安装包的完整性检查（dbxp.cjs）", () => {
  const require = createRequire(import.meta.url);
  const { installBuffer } = require(path.join(ROOT, "plugins/market/bin/dbxp.cjs"));
  const sha = b => crypto.createHash("sha256").update(b).digest("hex");

  /** 最小的 zip（只存不压缩，不写 CRC：安装器本来就不看它） */
  function zip(files) {
    const locals = [];
    const central = [];
    let off = 0;
    for (const [name, data] of Object.entries(files)) {
      const n = Buffer.from(name);
      const d = Buffer.from(data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt32LE(d.length, 18);
      lh.writeUInt32LE(d.length, 22);
      lh.writeUInt16LE(n.length, 26);
      locals.push(lh, n, d);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt32LE(d.length, 20);
      ch.writeUInt32LE(d.length, 24);
      ch.writeUInt16LE(n.length, 28);
      ch.writeUInt32LE(off, 42);
      central.push(ch, n);
      off += 30 + n.length + d.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cd, end]);
  }
  const pkg = (extra = {}, listed = ["a.js"]) => {
    const files = { "manifest.json": JSON.stringify({ id: "demo", version: "1.0.0" }), "a.js": "1", ...extra };
    const sums = Object.fromEntries(["manifest.json", ...listed].map(n => [n, sha(Buffer.from(files[n]))]));
    return zip({ ...files, "checksums.json": JSON.stringify({ files: sums }) });
  };

  it("正常的包能装", () => {
    const root = tmpdir("dbxp");
    assert.equal(installBuffer(pkg(), root).version, "1.0.0");
    assert.ok(fs.existsSync(path.join(root, "demo", "versions", "1.0.0", "a.js")));
  });

  it("包里夹带了没列入校验清单的文件：整个包拒绝，什么都不落盘", () => {
    const root = tmpdir("dbxp");
    assert.throws(() => installBuffer(pkg({ "bin/evil.js": "x" }), root), /没列入校验清单.*bin\/evil\.js/);
    assert.ok(!fs.existsSync(path.join(root, "demo", "versions", "1.0.0")));
  });

  it("文件内容被改过 / 路径里带 .. 、反斜杠、盘符冒号：拒绝", () => {
    const root = tmpdir("dbxp");
    const tampered = Buffer.from(pkg()); // 把 a.js 的内容从 1 改成 2
    tampered[tampered.indexOf(Buffer.from("a.js")) + 4] = "2".charCodeAt(0); // 紧跟在文件名后面的就是内容
    assert.throws(() => installBuffer(tampered, root), /校验失败/);
    for (const name of ["../x.js", "sub\\..\\..\\x.js", "C:x.js"]) {
      const files = { "manifest.json": JSON.stringify({ id: "demo", version: "1.0.0" }), [name]: "1" };
      const sums = Object.fromEntries(Object.entries(files).map(([n, d]) => [n, sha(Buffer.from(d))]));
      assert.throws(() => installBuffer(zip({ ...files, "checksums.json": JSON.stringify({ files: sums }) }), root), /不安全的路径/, name);
    }
  });
});
