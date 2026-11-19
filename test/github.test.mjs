import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launch } from "./helpers.mjs";
import { TOKEN, files, log, startMockGithub, state } from "./mock-github.mjs";

let base = "";
let mock;
before(async () => {
  mock = await startMockGithub();
  base = mock.base;
});
after(() => mock?.close());

const running = [];
after(() => running.forEach(p => p.stop()));
async function login() {
  const p = launch("github", { env: { GITHUB_API_URL: base } });
  running.push(p);
  await p.init();
  await p.call("gh/login", { token: TOKEN });
  log.length = 0;
  return p;
}

describe("github：登录", () => {
  it("没有令牌时给出明确提示；坏令牌被拒绝且不会保存；好令牌登录成功，令牌不回传", async () => {
    const p = launch("github", { env: { GITHUB_API_URL: base } });
    running.push(p);
    await p.init();
    const st = await p.call("gh/status");
    assert.equal(st.hasToken, false);
    await assert.rejects(p.call("gh/repos", {}), /还没有登录/);
    await assert.rejects(p.call("gh/login", { token: "short" }), /格式/);
    await assert.rejects(p.call("gh/login", { token: "ghp_" + "b".repeat(30) }), /令牌无效/);
    assert.equal((await p.call("gh/status")).hasToken, false, "验证失败不保留");
    const ok = await p.call("gh/login", { token: TOKEN });
    assert.equal(ok.user.login, "me");
    const s2 = await p.call("gh/status");
    assert.equal(s2.user.login, "me");
    assert.ok(!JSON.stringify(s2).includes(TOKEN));
    await p.call("gh/logout");
    assert.equal((await p.call("gh/status")).hasToken, false);
  });

  it("API 地址只接受 https（本机除外）", async () => {
    const p = launch("github", { env: { GITHUB_API_URL: base } });
    running.push(p);
    await assert.rejects(p.call("gh/login", { token: TOKEN, apiBase: "http://example.com" }), /https/);
  });
});

describe("github：只读", () => {
  it("仓库：列表、筛选、搜索、详情含分支", async () => {
    const p = await login();
    let r = await p.call("gh/repos", {});
    assert.deepEqual(r.items.map(x => x.full), ["me/app", "me/other"]);
    assert.equal(r.items[0].private, true);
    r = await p.call("gh/repos", { q: "else" });
    assert.deepEqual(r.items.map(x => x.full), ["me/other"]);
    r = await p.call("gh/repos", { q: "found", search: true });
    assert.deepEqual(r.items.map(x => x.full), ["x/found"]);
    const info = await p.call("gh/repo", { repo: "me/app" });
    assert.equal(info.branch, "main");
    assert.deepEqual(info.branches.map(b => b.name), ["main", "feature"]);
  });

  it("仓库：加星标 / 个人 / 排序；跨仓库的我的 Issue、PR；通知", async () => {
    const p = await login();
    let r = await p.call("gh/repos", { scope: "starred" });
    assert.deepEqual(r.items.map(x => x.full), ["vuejs/core"]);
    r = await p.call("gh/repos", { sort: "name", dir: "asc" });
    assert.deepEqual(r.items.map(x => x.name), ["app", "other"]);
    r = await p.call("gh/repos", { sort: "name", dir: "desc" });
    assert.deepEqual(r.items.map(x => x.name), ["other", "app"]);
    r = await p.call("gh/repos", { scope: "archived" });
    assert.equal(r.items.length, 0);

    const iss = await p.call("gh/myWork", { kind: "issues", filter: "assigned" });
    assert.equal(iss.items[0].repo, "me/app");
    assert.equal(iss.items[0].isPull, false);
    const prs = await p.call("gh/myWork", { kind: "pulls", filter: "review" });
    assert.equal(prs.items[0].isPull, true);

    const n = await p.call("gh/notifications", {});
    assert.deepEqual(n.items.map(x => [x.repo, x.type, x.number, x.unread]), [["me/app", "PullRequest", 5, true], ["me/app", "Issue", 1, false]]);
    await p.call("gh/markRead", { id: "n1" });
    await p.call("gh/markRead", {});
    assert.deepEqual(log.filter(x => /notifications/.test(x.path)).map(x => x.method + " " + x.path), ["PATCH /notifications/threads/n1", "PUT /notifications"]);
  });

  it("中英文：语言存在设置里，错误提示跟着 lang 走", async () => {
    const p = await login();
    assert.equal((await p.call("gh/status")).lang, "");
    await assert.rejects(p.call("gh/contents", { repo: "bad repo", lang: "en" }), /owner\/name/);
    await assert.rejects(p.call("gh/contents", { repo: "me/app", path: "../x", lang: "en" }), /Invalid path/);
    await assert.rejects(p.call("gh/createIssue", { repo: "me/app", title: " ", lang: "en" }), /Title is required/);
    await assert.rejects(p.call("gh/contents", { repo: "me/app", path: "nope", lang: "en" }), /Not found/);
    await assert.rejects(p.call("gh/contents", { repo: "bad repo", lang: "zh" }), /所有者\/仓库名/);
    await p.call("gh/setLang", { lang: "en" });
    assert.equal((await p.call("gh/status")).lang, "en");
    await assert.rejects(p.call("gh/contents", { repo: "bad repo" }), /owner\/name/, "没带 lang（比如 AI 工具调用）就用设置里存的");
    await p.call("gh/setLang", { lang: "zh" });
    await assert.rejects(p.call("gh/contents", { repo: "bad repo" }), /所有者\/仓库名/);
  });

  it("文件：目录（文件夹排前）、文本、二进制、过大", async () => {
    const p = await login();
    const dir = await p.call("gh/contents", { repo: "me/app", path: "" });
    assert.deepEqual(dir.items.map(x => x.name), ["a-dir", "src", "README.md"]);
    const f = await p.call("gh/contents", { repo: "me/app", path: "README.md" });
    assert.equal(f.text, "# hello\n");
    assert.equal(f.sha, "sha-README.md");
    assert.equal((await p.call("gh/contents", { repo: "me/app", path: "bin.dat" })).binary, true);
    assert.equal((await p.call("gh/contents", { repo: "me/app", path: "big.txt" })).tooLarge, true);
    await assert.rejects(p.call("gh/contents", { repo: "me/app", path: "nope" }), /找不到/);
    await assert.rejects(p.call("gh/contents", { repo: "me/app", path: "../x" }), /路径/);
    await assert.rejects(p.call("gh/contents", { repo: "bad repo" }), /所有者\/仓库名/);
  });

  it("Issue：列表不含 PR；有下一页标记；搜索；详情含评论", async () => {
    const p = await login();
    const r = await p.call("gh/issues", { repo: "me/app", state: "all" });
    assert.deepEqual(r.items.map(i => i.number), [1, 3]);
    assert.equal(r.hasNext, true);
    assert.equal(r.items[0].labels[0].name, "bug");
    const s = await p.call("gh/issues", { repo: "me/app", q: "crash" });
    assert.deepEqual(s.items.map(i => i.number), [7]);
    const d = await p.call("gh/issue", { repo: "me/app", number: 1 });
    assert.equal(d.commentList[0].body, "first comment");
    await assert.rejects(p.call("gh/issue", { repo: "me/app", number: "x" }), /编号/);
  });

  it("PR：列表（已合并状态）、详情（diff 截断、过滤草稿评审）", async () => {
    const p = await login();
    const r = await p.call("gh/pulls", { repo: "me/app", state: "all" });
    assert.deepEqual(r.items.map(x => x.state), ["open", "merged"]);
    const d = await p.call("gh/pull", { repo: "me/app", number: 5 });
    assert.equal(d.head, "feature");
    assert.equal(d.files.length, 2);
    assert.match(d.files[0].patch, /\+new/);
    assert.match(d.files[1].patch, /已截断/);
    assert.ok(d.files[1].patch.length < 6100);
    assert.equal(d.reviews.length, 1, "PENDING 的评审不显示");
    assert.equal(d.commentList.length, 1);
  });

  it("Actions：运行记录、任务、工作流；Release；提交历史", async () => {
    const p = await login();
    const runs = await p.call("gh/runs", { repo: "me/app" });
    assert.equal(runs.items[0].sha, "abcdef1");
    assert.equal(runs.items[0].conclusion, "failure");
    const jobs = await p.call("gh/runJobs", { repo: "me/app", id: 100 });
    assert.equal(jobs.items[0].steps[1].conclusion, "failure");
    assert.equal((await p.call("gh/workflows", { repo: "me/app" })).items[0].name, "CI");
    const rel = await p.call("gh/releases", { repo: "me/app" });
    assert.equal(rel.items[0].tag, "v1.0.0");
    assert.equal(rel.items[0].assets[0].downloads, 3);
    const c = await p.call("gh/commits", { repo: "me/app" });
    assert.equal(c.items[0].message, "first");
    assert.equal(c.items[0].sha, "eeeeeee");
  });
});

describe("github：写操作", () => {
  it("文件：新建、改（带 sha）、删；缺 sha / sha 过期给出可读的错误", async () => {
    const p = await login();
    const put = await p.call("gh/putFile", { repo: "me/app", path: "docs/new.md", content: "你好\n", message: "add doc", branch: "feature" });
    assert.equal(put.commit, "ccccccc");
    let w = log.at(-1);
    assert.equal(w.method, "PUT");
    assert.equal(w.path, "/repos/me/app/contents/docs/new.md");
    assert.equal(Buffer.from(w.body.content, "base64").toString("utf8"), "你好\n");
    assert.equal(w.body.branch, "feature");
    assert.equal(w.body.message, "add doc");

    await assert.rejects(p.call("gh/putFile", { repo: "me/app", path: "README.md", content: "x", message: "m" }), /GitHub 拒绝了这个请求/);
    await assert.rejects(p.call("gh/putFile", { repo: "me/app", path: "README.md", content: "x", message: "m", sha: "old" }), /冲突/);
    await p.call("gh/putFile", { repo: "me/app", path: "README.md", content: "# changed\n", message: "update", sha: "sha-README.md" });
    assert.equal(files["README.md"], "# changed\n");
    await assert.rejects(p.call("gh/putFile", { repo: "me/app", path: "a.md", content: "x", message: " " }), /提交说明/);

    await p.call("gh/deleteFile", { repo: "me/app", path: "src/a.ts", sha: "sha-src/a.ts", message: "rm", branch: "feature" });
    w = log.at(-1);
    assert.equal(w.method, "DELETE");
    assert.equal(w.body.sha, "sha-src/a.ts");
    assert.equal(files["src/a.ts"], undefined);
  });

  it("分支：新建（从来源分支取 sha）、删除；来源不存在报错；不合法的名字被拒绝", async () => {
    const p = await login();
    await p.call("gh/createBranch", { repo: "me/app", name: "fix/x", from: "main" });
    const w = log.at(-1);
    assert.equal(w.path, "/repos/me/app/git/refs");
    assert.deepEqual(w.body, { ref: "refs/heads/fix/x", sha: "a".repeat(40) });
    await assert.rejects(p.call("gh/createBranch", { repo: "me/app", name: "y", from: "ghost" }), /找不到/);
    await assert.rejects(p.call("gh/createBranch", { repo: "me/app", name: "bad name", from: "main" }), /不合法/);
    await assert.rejects(p.call("gh/createBranch", { repo: "me/app", name: "a..b", from: "main" }), /不合法/);
    await p.call("gh/deleteBranch", { repo: "me/app", name: "fix/x" });
    assert.equal(log.at(-1).path, "/repos/me/app/git/refs/heads/fix/x");
  });

  it("Issue：创建、改、关闭、评论；空内容被拒绝", async () => {
    const p = await login();
    const i = await p.call("gh/createIssue", { repo: "me/app", title: "崩溃了", body: "复现步骤", labels: ["bug"] });
    assert.equal(i.number, 10);
    assert.deepEqual(log.at(-1).body, { title: "崩溃了", body: "复现步骤", labels: ["bug"] });
    const c = await p.call("gh/updateIssue", { repo: "me/app", number: 10, state: "closed" });
    assert.equal(c.state, "closed");
    assert.deepEqual(log.at(-1).body, { state: "closed" });
    const cm = await p.call("gh/comment", { repo: "me/app", number: 10, body: "已修复" });
    assert.equal(cm.body, "已修复");
    await assert.rejects(p.call("gh/createIssue", { repo: "me/app", title: "  " }), /标题/);
    await assert.rejects(p.call("gh/comment", { repo: "me/app", number: 10, body: "" }), /评论内容/);
    await assert.rejects(p.call("gh/updateIssue", { repo: "me/app", number: 10 }), /没有要改/);
  });

  it("PR：创建、评审、合并（三种方式）、关闭；合并失败时给出原因", async () => {
    const p = await login();
    const pr = await p.call("gh/createPull", { repo: "me/app", title: "新功能", head: "feature", base: "main", body: "说明", draft: true });
    assert.equal(pr.number, 11);
    assert.deepEqual(log.at(-1).body, { title: "新功能", head: "feature", base: "main", body: "说明", draft: true });
    await p.call("gh/reviewPull", { repo: "me/app", number: 5, event: "APPROVE" });
    assert.equal(log.at(-1).body.event, "APPROVE");
    await assert.rejects(p.call("gh/reviewPull", { repo: "me/app", number: 5, event: "REQUEST_CHANGES", body: "" }), /评审内容/);
    for (const method of ["merge", "squash", "rebase"]) {
      const r = await p.call("gh/mergePull", { repo: "me/app", number: 5, method });
      assert.equal(r.merged, true);
      assert.equal(log.at(-1).body.merge_method, method);
    }
    await p.call("gh/mergePull", { repo: "me/app", number: 5, method: "evil" });
    assert.equal(log.at(-1).body.merge_method, "merge", "未知方式回退到 merge");
    await assert.rejects(p.call("gh/mergePull", { repo: "me/app", number: 99 }), /not mergeable/);
    await p.call("gh/updatePull", { repo: "me/app", number: 5, state: "closed" });
    assert.deepEqual(log.at(-1).body, { state: "closed" });
  });

  it("Actions：重跑 / 只重跑失败 / 取消 / 触发工作流；Release 创建 / 删除；新建仓库", async () => {
    const p = await login();
    await p.call("gh/rerun", { repo: "me/app", id: 100 });
    assert.equal(log.at(-1).path, "/repos/me/app/actions/runs/100/rerun");
    await p.call("gh/rerun", { repo: "me/app", id: 100, failedOnly: true });
    assert.equal(log.at(-1).path, "/repos/me/app/actions/runs/100/rerun-failed-jobs");
    await p.call("gh/cancelRun", { repo: "me/app", id: 101 });
    assert.equal(log.at(-1).path, "/repos/me/app/actions/runs/101/cancel");
    await p.call("gh/dispatch", { repo: "me/app", workflow: "42", ref: "main", inputs: { env: "prod" } });
    assert.deepEqual(log.at(-1).body, { ref: "main", inputs: { env: "prod" } });
    const rel = await p.call("gh/createRelease", { repo: "me/app", tag: "v2.0.0", name: "Two", body: "n", draft: true, prerelease: true, generateNotes: true, target: "main" });
    assert.equal(rel.tag, "v2.0.0");
    assert.deepEqual(log.at(-1).body, { tag_name: "v2.0.0", name: "Two", body: "n", draft: true, prerelease: true, target_commitish: "main", generate_release_notes: true });
    await p.call("gh/deleteRelease", { repo: "me/app", id: 9 });
    assert.equal(log.at(-1).path, "/repos/me/app/releases/9");
    const nr = await p.call("gh/createRepo", { name: "fresh", description: "d", private: true });
    assert.equal(nr.full, "me/fresh");
    await assert.rejects(p.call("gh/createRepo", { name: "bad name" }), /仓库名/);
  });
});

describe("github：错误处理", () => {
  it("速率限制给出恢复时间；令牌失效提示重新填写", async () => {
    const p = await login();
    state.rateLimited = true;
    try {
      await assert.rejects(p.call("gh/issues", { repo: "me/app" }), /速率限制/);
    } finally {
      state.rateLimited = false;
    }
    const q = launch("github", { env: { GITHUB_API_URL: base } });
    running.push(q);
    await q.init();
    await q.call("gh/login", { token: TOKEN });
    // 令牌被服务器端撤销：换成一个错的写进配置
    const fs = await import("node:fs");
    const path = await import("node:path");
    const f = path.join(q.home, "plugin-data", "github", "settings.json");
    fs.writeFileSync(f, JSON.stringify({ token: "ghp_" + "z".repeat(30) }));
    await assert.rejects(q.call("gh/repos", {}), /令牌无效或已过期/);
  });
});

describe("github：AI 工具", () => {
  it("读写工具齐全，只读标记正确", async () => {
    const p = await login();
    const tools = (await p.call("mcp/tools")).tools;
    const by = Object.fromEntries(tools.map(t => [t.name, t]));
    for (const n of ["github_repos", "github_read", "github_commits", "github_issues", "github_issue", "github_pulls", "github_pull", "github_runs"]) assert.equal(by[n].annotations.readOnlyHint, true, n);
    for (const n of ["github_issue_create", "github_issue_update", "github_comment", "github_pull_create", "github_pull_merge", "github_pull_review", "github_file_write", "github_branch_create", "github_run_rerun", "github_release_create"]) assert.equal(by[n].annotations.readOnlyHint, false, n);
    assert.ok(by.github_pull_merge.description.includes("明确要求"));
    assert.deepEqual(by.github_comment.inputSchema.required, ["repo", "number", "body"]);
  });

  it("工具真的能调通：读文件、列 Issue、评论、写文件；出错时标 isError", async () => {
    const p = await login();
    let t = await p.tool("github_read", { repo: "me/app", path: "README.md" });
    assert.equal(t.isError, false);
    assert.equal(JSON.parse(t.text).sha, "sha-README.md");
    t = await p.tool("github_issues", { repo: "me/app", state: "all" });
    const items = JSON.parse(t.text);
    assert.deepEqual(items.map(i => i.number), [1, 3]);
    assert.ok(!("body" in items[0]), "列表工具只返回摘要，省 token");
    t = await p.tool("github_comment", { repo: "me/app", number: 1, body: "来自 AI" });
    assert.equal(t.isError, false);
    assert.equal(log.at(-1).body.body, "来自 AI");
    t = await p.tool("github_file_write", { repo: "me/app", path: "ai.txt", content: "hi", message: "ai" });
    assert.equal(t.isError, false);
    t = await p.tool("github_pull", { repo: "me/app", number: 5 });
    assert.equal(JSON.parse(t.text).files.length, 2);
    t = await p.tool("github_read", { repo: "me/app", path: "missing" });
    assert.equal(t.isError, true);
    assert.match(t.text, /找不到/);
    t = await p.tool("github_read", { repo: "not-a-repo" });
    assert.equal(t.isError, true);
  });
});
