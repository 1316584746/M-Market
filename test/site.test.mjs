import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCatalog, renderIndex, renderInstall, renderPlugin, renderPrivacy, renderSitemap, slim } from "../scripts/build-site.mjs";

const SHA = "a".repeat(64);
const own = {
  schemaVersion: 1,
  plugins: [{ id: "memsearch", name: "MemSearch", publisher: "M-Market", description: "记忆", tags: ["memory"], permissions: ["fs.read"], latestVersion: "0.1.0", versions: [{ version: "0.1.0", releasedAt: "2026-11-01", artifacts: [{ target: "universal", url: "https://raw.githubusercontent.com/x/y/HEAD/packages/memsearch-0.1.0.dbxp", sha256: SHA }] }], localizations: { en: { name: "MemSearch", description: "Memory" } } }],
};
const dsh = {
  format: 1,
  metadata: { categories: { dev: { title: { zh: "开发", en: "Development" } } } },
  plugins: [
    { name: "dsh-lint", description: { zh: "x".repeat(500), en: "lint" }, repository: { url: "https://github.com/a/dsh-lint" }, metadata: { category: "dev", sortKeys: { stars: 5 } }, versions: [{ version: "1.0.0", source: { type: "npm" } }] },
    { name: "@scope/evil", description: { zh: '<script>alert(1)</script> "quote"' }, metadata: {}, versions: [{ version: "0.0.1", source: { type: "npm" } }] },
    { name: "memsearch", description: { zh: "同名但是 DSH 的" }, versions: [{ version: "0.0.1", source: { type: "npm" } }] },
  ],
};
const cat = () => buildCatalog(own, [{ name: "hub", json: dsh }], new Date("2026-11-19T00:00:00Z"));

describe("网站目录合并", () => {
  it("官方插件在前、带下载链接；DSH 条目带分类和星标；列表用的精简版会截断简介", () => {
    const c = cat();
    assert.equal(c.generatedAt, "2026-11-19T00:00:00.000Z");
    assert.deepEqual(c.plugins.map(p => `${p.kind}:${p.id}`), ["dbx:memsearch", "dsh:dsh-lint", "dsh:@scope/evil", "dsh:memsearch"]);
    const [m, lint, evil] = c.plugins;
    assert.equal(m.official, true);
    assert.equal(m.download, "packages/memsearch-0.1.0.dbxp");
    assert.equal(m.sha256, SHA);
    assert.deepEqual(m.permissions, ["fs.read"]);
    assert.equal(lint.official, undefined);
    assert.equal(lint.download, undefined);
    assert.equal(lint.permissions, undefined, "社区插件不展示权限（目录里没有）");
    assert.equal(lint.category, "开发");
    assert.equal(lint.stars, 5);
    assert.equal(lint.description.length, 500, "详情页用完整简介");
    assert.ok(slim(lint).description.length <= 200);
    assert.equal(evil.slug, "dsh-_scope_evil", "@ 和斜杠换成下划线");
    assert.equal(new Set(c.plugins.map(p => p.slug)).size, c.plugins.length, "slug 不重复");
  });

  it("英文目录取英文简介和分类", () => {
    const c = buildCatalog(own, [{ name: "hub", json: dsh }], new Date(), "en");
    assert.equal(c.plugins[0].description, "Memory");
    assert.equal(c.plugins[1].category, "Development");
    assert.equal(c.plugins[1].description, "lint");
  });

  it("上游格式不对时跳过它，官方插件照常", () => {
    const c = buildCatalog(own, [{ name: "bad", json: { nope: 1 } }, { name: "hub", json: dsh }]);
    assert.equal(c.problems.length, 1);
    assert.match(c.problems[0], /bad/);
    assert.equal(c.plugins.length, 4);
  });

  it("没有上游也能生成", () => {
    assert.equal(buildCatalog(own).plugins.length, 1);
  });
});

describe("网站页面", () => {
  it("插件页：转义内容；DBX 页有下载、权限和校验值；DSH 页只指向插件中心", () => {
    const [m, lint, evil] = cat().plugins;
    const dbx = renderPlugin("zh", m);
    assert.match(dbx, /href="\.\.\/packages\/memsearch-0\.1\.0\.dbxp"/);
    assert.match(dbx, /<code>fs\.read<\/code>/);
    assert.ok(dbx.includes(SHA));
    assert.match(dbx, /<html lang="zh-CN">/);
    assert.match(dbx, /href="\.\.\/install\.html"/);
    const sub = renderPlugin("zh", lint);
    assert.doesNotMatch(sub, /packages\//);
    assert.match(sub, /插件中心/);
    assert.match(sub, /github\.com\/a\/dsh-lint\/discussions/);
    const bad = renderPlugin("zh", evil);
    assert.doesNotMatch(bad, /<script>alert/);
    assert.match(bad, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;quote&quot;/);
  });

  it("英文页：语言切换回中文版同一页，资源路径多一级", () => {
    const [m] = cat().plugins;
    const en = renderPlugin("en", m);
    assert.match(en, /<html lang="en">/);
    assert.match(en, /href="\.\.\/\.\.\/style\.css"/);
    assert.match(en, /href="\.\.\/\.\.\/plugin\/dbx-memsearch\.html"/, "切换语言指向中文版的同一页");
    assert.match(en, /href="\.\.\/\.\.\/packages\/memsearch-0\.1\.0\.dbxp"/);
  });

  it("首页：配置能解析，数据地址按语言走，没有统计脚本", () => {
    for (const [lang, data] of [["zh", "catalog.json"], ["en", "../catalog.en.json"]]) {
      const html = renderIndex(lang);
      const cfg = JSON.parse(/window\.SITE=(\{.*?\});<\/script>/s.exec(html)[1]);
      assert.equal(cfg.data, data);
      assert.equal(cfg.lang, lang);
      assert.match(cfg.t.count, /\{n\}/);
      assert.doesNotMatch(html, /google-analytics|gtag|hm\.baidu|umami|plausible/i);
    }
  });

  it("安装页带目录地址，隐私页说明不收集数据", () => {
    assert.match(renderInstall("zh"), /raw\.githubusercontent\.com\/1316584746\/M-Market\/HEAD\/catalog\/index\.json/);
    assert.match(renderPrivacy("zh"), /没有统计脚本/);
    assert.match(renderPrivacy("en"), /no analytics/);
  });

  it("slug 撞了就加后缀，页面不会互相覆盖", () => {
    const twin = { format: 1, plugins: [{ name: "a/b", versions: [{ version: "1.0.0" }] }, { name: "a_b", versions: [{ version: "1.0.0" }] }] };
    const slugs = buildCatalog({ plugins: [] }, [{ name: "t", json: twin }]).plugins.map(p => p.slug);
    assert.equal(new Set(slugs).size, 2);
  });

  it("sitemap：中英文页面都在", () => {
    const x = renderSitemap("https://example.com/m/", cat().plugins);
    assert.match(x, /<loc>https:\/\/example\.com\/m\/<\/loc>/);
    assert.match(x, /<loc>https:\/\/example\.com\/m\/en\/install\.html<\/loc>/);
    assert.match(x, /plugin\/dbx-memsearch\.html/);
    assert.match(x, /en\/plugin\/dsh-dsh-lint\.html/);
    assert.match(x, /plugin\/dsh-_scope_evil\.html/);
  });
});
