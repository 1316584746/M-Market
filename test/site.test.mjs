import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCatalog } from "../scripts/build-site.mjs";

const own = {
  schemaVersion: 1,
  plugins: [{ id: "memsearch", name: "MemSearch", publisher: "M-Market", description: "记忆", tags: ["memory"], latestVersion: "0.1.0", versions: [{ version: "0.1.0", releasedAt: "2026-11-01", artifacts: [{ target: "universal", url: "https://raw.githubusercontent.com/x/y/HEAD/packages/memsearch-0.1.0.dbxp", sha256: "a".repeat(64) }] }] }],
};
const dsh = {
  format: 1,
  metadata: { categories: { dev: { title: { zh: "开发" } } } },
  plugins: [
    { name: "dsh-lint", description: { zh: "x".repeat(500) }, metadata: { category: "dev", sortKeys: { stars: 5 } }, versions: [{ version: "1.0.0", source: { type: "npm" } }] },
    { name: "memsearch", description: { zh: "同名但是 DSH 的" }, versions: [{ version: "0.0.1", source: { type: "npm" } }] },
  ],
};

describe("网站目录合并", () => {
  it("官方插件在前、带下载链接；DSH 条目带分类和星标；超长简介被截断", () => {
    const c = buildCatalog(own, [{ name: "hub", json: dsh }], new Date("2026-11-19T00:00:00Z"));
    assert.equal(c.generatedAt, "2026-11-19T00:00:00.000Z");
    assert.deepEqual(c.plugins.map(p => `${p.kind}:${p.id}`), ["dbx:memsearch", "dsh:dsh-lint", "dsh:memsearch"]);
    const [m, lint] = c.plugins;
    assert.equal(m.official, true);
    assert.equal(m.download, "packages/memsearch-0.1.0.dbxp");
    assert.equal(lint.official, undefined);
    assert.equal(lint.download, undefined);
    assert.equal(lint.category, "开发");
    assert.equal(lint.stars, 5);
    assert.ok(lint.description.length <= 240);
  });

  it("上游格式不对时跳过它，官方插件照常", () => {
    const c = buildCatalog(own, [{ name: "bad", json: { nope: 1 } }, { name: "hub", json: dsh }]);
    assert.equal(c.problems.length, 1);
    assert.match(c.problems[0], /bad/);
    assert.equal(c.plugins.length, 3);
  });

  it("没有上游也能生成", () => {
    assert.equal(buildCatalog(own).plugins.length, 1);
  });
});
