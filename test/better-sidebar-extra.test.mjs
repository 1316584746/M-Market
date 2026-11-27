import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { launch, tmpdir } from "./helpers.mjs";

const running = [];
after(() => running.forEach(p => p.stop()));
const start = async o => {
  const p = launch("better-sidebar", o);
  running.push(p);
  return p;
};
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("等待超时");
    await new Promise(r => setTimeout(r, 40));
  }
};

/** 跑完一条命令，返回全部输出和退出码 */
async function run(p, command) {
  const s = await p.call("term/start", { command });
  if (s.cd) return s;
  let since = 0;
  let text = "";
  const r = await until(async () => {
    const x = await p.call("term/poll", { id: s.id, since });
    text += x.text;
    since = x.next;
    return x.done ? x : null;
  });
  return { ...r, text };
}

describe("better-sidebar：Git Graph", () => {
  it("分支、合并、标签都在图里，父子关系正确；提交详情带文件列表和 diff", async t => {
    if (!hasGit) return t.skip("没有 git");
    const ws = tmpdir("graph");
    const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: ws, stdio: "pipe", encoding: "utf8" });
    const commit = (msg, file, text) => {
      fs.writeFileSync(path.join(ws, file), text);
      g("add", "-A");
      g("commit", "-qm", msg);
    };
    g("init", "-q", "-b", "main");
    commit("一", "a.txt", "1\n");
    g("checkout", "-q", "-b", "feat");
    commit("分支提交", "b.txt", "b\n");
    g("checkout", "-q", "main");
    commit("主线提交", "a.txt", "1\n2\n");
    g("merge", "-q", "--no-ff", "-m", "合并 feat", "feat");
    g("tag", "v1");
    const p = await start();
    await p.call("ws/set", { path: ws });
    const r = await p.call("git/graph", { limit: 50 });
    assert.equal(r.isRepo, true);
    assert.deepEqual(r.commits.map(c => c.subject).sort(), ["一", "分支提交", "合并 feat", "主线提交"].sort());
    assert.equal(r.commits.length, 4);
    const merge = r.commits[0];
    assert.equal(merge.subject, "合并 feat");
    assert.equal(merge.parents.length, 2, "合并提交有两个父提交");
    assert.ok(merge.refs.some(x => /main/.test(x)) && merge.refs.some(x => /tag: v1/.test(x)));
    const byHash = new Map(r.commits.map(c => [c.hash, c]));
    assert.deepEqual(merge.parents.map(h => byHash.get(h).subject).sort(), ["主线提交", "分支提交"].sort());
    assert.equal(r.commits.at(-1).parents.length, 0, "根提交没有父提交");
    // 子在前、父在后
    const pos = new Map(r.commits.map((c, i) => [c.hash, i]));
    for (const c of r.commits) for (const h of c.parents) assert.ok(pos.get(h) > pos.get(c.hash));

    const d = await p.call("git/show", { hash: merge.short });
    assert.equal(d.message.split("\n")[0], "合并 feat");
    assert.deepEqual(d.files.map(f => [f.status, f.path]), [["A", "b.txt"]], "合并提交显示合进来了哪些文件");
    assert.match(d.diff, /\+b/);
    const one = await p.call("git/show", { hash: r.commits.find(c => c.subject === "分支提交").short });
    assert.deepEqual(one.files.map(f => [f.status, f.path]), [["A", "b.txt"]]);
    assert.match(one.diff, /\+b/);
    await assert.rejects(p.call("git/show", { hash: "--output=x" }), /不合法/);
    await assert.rejects(p.call("git/show", { hash: "HEAD; rm" }), /不合法/);
  });

  it("没有提交的仓库和非仓库都不报错", async t => {
    if (!hasGit) return t.skip("没有 git");
    const empty = tmpdir("empty");
    execFileSync("git", ["init", "-q"], { cwd: empty, stdio: "pipe" });
    const p = await start();
    await p.call("ws/set", { path: empty });
    assert.deepEqual(await p.call("git/graph"), { isRepo: true, commits: [] });
    await p.call("ws/set", { path: tmpdir("plain") });
    assert.equal((await p.call("git/graph")).isRepo, false);
  });
});

describe("better-sidebar：命令执行", () => {
  it("运行命令、拿输出和退出码（中文不乱码），cd 只改后面命令的目录", async () => {
    const ws = tmpdir("term");
    fs.mkdirSync(path.join(ws, "sub"));
    fs.writeFileSync(path.join(ws, "sub", "here.txt"), "x");
    const p = await start();
    await p.call("ws/set", { path: ws });
    const a = await run(p, "echo 你好，世界");
    assert.equal(a.code, 0);
    assert.match(a.text, /你好，世界/);
    const b = await run(p, `"${process.execPath}" -e "process.stdout.write(process.cwd()); process.exit(3)"`);
    assert.equal(b.code, 3);
    assert.equal(fs.realpathSync(b.text.trim()), fs.realpathSync(ws), "默认在工作区里跑");
    const cd = await run(p, "cd sub");
    assert.equal(cd.cd, true);
    assert.equal(fs.realpathSync(cd.cwd), fs.realpathSync(path.join(ws, "sub")));
    const c = await run(p, process.platform === "win32" ? "dir /b" : "ls");
    assert.match(c.text, /here\.txt/);
    await assert.rejects(p.call("term/start", { command: "cd 不存在的目录" }), /不存在/);
    await assert.rejects(p.call("term/start", { command: "  " }), /不能为空/);
    assert.equal(fs.realpathSync((await p.call("term/cwd")).cwd), fs.realpathSync(path.join(ws, "sub")));
  });

  it("增量取输出、往 stdin 写一行、停止长时间运行的命令", async () => {
    const p = await start();
    await p.call("ws/set", { path: tmpdir("term2") });
    const node = `"${process.execPath}"`;
    const echo = await p.call("term/start", { command: `${node} -e "process.stdin.once('data', d => { console.log('收到:' + String(d).trim()); process.exit(0) })"` });
    await p.call("term/input", { id: echo.id, line: "ping" });
    let since = 0;
    let text = "";
    const done = await until(async () => {
      const x = await p.call("term/poll", { id: echo.id, since });
      text += x.text;
      since = x.next;
      return x.done ? x : null;
    });
    assert.equal(done.code, 0);
    assert.match(text, /收到:ping/);
    const again = await p.call("term/poll", { id: echo.id, since });
    assert.equal(again.text, "", "带上 since 不会重复拿到旧输出");
    await assert.rejects(p.call("term/input", { id: echo.id, line: "x" }), /已经结束/);

    const long = await p.call("term/start", { command: `${node} -e "setInterval(() => {}, 1000)"` });
    assert.equal((await p.call("term/poll", { id: long.id })).done, false);
    await p.call("term/kill", { id: long.id });
    const killed = await until(async () => {
      const x = await p.call("term/poll", { id: long.id });
      return x.done ? x : null;
    });
    assert.equal(killed.done, true);
    await assert.rejects(p.call("term/poll", { id: 9999 }), /没有这条命令/);
  });

  it("同时运行的命令有上限", async () => {
    const p = await start();
    await p.call("ws/set", { path: tmpdir("term3") });
    const node = `"${process.execPath}"`;
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await p.call("term/start", { command: `${node} -e "setInterval(() => {}, 1000)"` })).id);
    await assert.rejects(p.call("term/start", { command: "echo x" }), /最多同时/);
    for (const id of ids) await p.call("term/kill", { id });
  });
});
