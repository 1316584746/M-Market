// 假 GitHub API：测试和 scripts/dev-ui.mjs 共用
import http from "node:http";

export const TOKEN = "ghp_" + "a".repeat(30);
export const log = []; // 记录所有写请求：{ method, path, body }
export const state = { base: "", rateLimited: false };
let server;

const repo = { full_name: "me/app", name: "app", owner: { login: "me" }, private: true, description: "demo app", language: "TypeScript", stargazers_count: 3, forks_count: 1, open_issues_count: 2, pushed_at: "2026-11-01T00:00:00Z", default_branch: "main", html_url: "https://github.com/me/app", permissions: { push: true, admin: true } };
const user = { login: "me", name: "Me", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4", html_url: "https://github.com/me" };
export const files = { "README.md": "# hello\n", "src/a.ts": "export const a = 1;\n", "bin.dat": "\u0000\u0001\u0002" };
const b64 = s => Buffer.from(s, "utf8").toString("base64");
const issue = (n, extra = {}) => ({ number: n, title: `issue ${n}`, state: "open", body: `body ${n}`, user, labels: [{ name: "bug", color: "d73a4a" }], comments: 1, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", html_url: `https://github.com/me/app/issues/${n}`, assignees: [], ...extra });

export async function startMockGithub() {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : undefined;
      const url = new URL(req.url, "http://x");
      const p = decodeURIComponent(url.pathname);
      const send = (code, data, headers = {}) => {
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(data === undefined ? "" : JSON.stringify(data));
      };
      if (req.method !== "GET") log.push({ method: req.method, path: p, body });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "Bad credentials" });
      if (state.rateLimited) return send(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" });
      let m;
      const M = (method, re) => req.method === method && (m = re.exec(p));

      if (M("GET", /^\/user$/)) return send(200, user);
      if (M("GET", /^\/user\/repos$/)) return send(200, [repo, { ...repo, full_name: "me/other", name: "other", description: "else", private: false }]);
      if (M("GET", /^\/search\/repositories$/)) return send(200, { items: [{ ...repo, full_name: "x/found", name: "found" }] });
      if (M("POST", /^\/user\/repos$/)) return send(201, { ...repo, full_name: `me/${body.name}`, name: body.name, private: body.private });
      if (M("GET", /^\/repos\/me\/app$/)) return send(200, repo);
      if (M("GET", /^\/repos\/me\/app\/branches$/)) return send(200, [{ name: "main", protected: true, commit: { sha: "a".repeat(40) } }, { name: "feature", protected: false, commit: { sha: "b".repeat(40) } }]);
      if (M("GET", /^\/repos\/me\/app\/git\/ref\/heads\/(.+)$/)) return m[1] === "main" ? send(200, { object: { sha: "a".repeat(40) } }) : send(404, { message: "Not Found" });
      if (M("POST", /^\/repos\/me\/app\/git\/refs$/)) return send(201, {});
      if (M("DELETE", /^\/repos\/me\/app\/git\/refs\/heads\/(.+)$/)) return send(204);

      if (M("GET", /^\/repos\/me\/app\/contents\/?(.*)$/)) {
        const f = m[1];
        if (!f) return send(200, [{ name: "src", path: "src", type: "dir", size: 0, sha: "d1" }, { name: "README.md", path: "README.md", type: "file", size: 8, sha: "f1" }, { name: "a-dir", path: "a-dir", type: "dir", size: 0, sha: "d2" }]);
        if (f === "src") return send(200, [{ name: "a.ts", path: "src/a.ts", type: "file", size: 20, sha: "f2" }]);
        if (f === "big.txt") return send(200, { type: "file", name: "big.txt", path: "big.txt", size: 2 * 1024 * 1024, sha: "f9", content: "" });
        if (files[f] != null) return send(200, { type: "file", name: f.split("/").pop(), path: f, size: files[f].length, sha: "sha-" + f, content: b64(files[f]), html_url: `https://github.com/me/app/blob/main/${f}` });
        return send(404, { message: "Not Found" });
      }
      if (M("PUT", /^\/repos\/me\/app\/contents\/(.+)$/)) {
        if (files[m[1]] != null && !body.sha) return send(422, { message: "Invalid request.\n\n\"sha\" wasn't supplied." });
        if (files[m[1]] != null && body.sha !== "sha-" + m[1]) return send(409, { message: "is at abc but expected def" });
        files[m[1]] = Buffer.from(body.content, "base64").toString("utf8");
        return send(200, { content: { sha: "new-sha" }, commit: { sha: "c".repeat(40), html_url: "https://github.com/me/app/commit/ccc" } });
      }
      if (M("DELETE", /^\/repos\/me\/app\/contents\/(.+)$/)) {
        delete files[m[1]];
        return send(200, { commit: { sha: "d".repeat(40) } });
      }
      if (M("GET", /^\/repos\/me\/app\/commits$/)) return send(200, [{ sha: "e".repeat(40), commit: { message: "first\n\nmore", author: { name: "Me", date: "2026-11-01T00:00:00Z" } }, author: user, html_url: "https://github.com/me/app/commit/e" }]);

      if (M("GET", /^\/repos\/me\/app\/issues$/)) return send(200, [issue(1), issue(2, { pull_request: {} }), issue(3, { state: "closed" })], { link: '<x>; rel="next"' });
      if (M("GET", /^\/user\/starred$/)) return send(200, [{ ...repo, full_name: "vuejs/core", name: "core", owner: { login: "vuejs" }, private: false, stargazers_count: 45000, description: "Vue 3 core" }]);
      if (M("GET", /^\/notifications$/)) return send(200, [{ id: "n1", unread: true, reason: "review_requested", updated_at: "2026-11-02T00:00:00Z", subject: { title: "pr 5", type: "PullRequest", url: "https://api.github.com/repos/me/app/pulls/5" }, repository: { full_name: "me/app" } }, { id: "n2", unread: false, reason: "mention", updated_at: "2026-11-01T00:00:00Z", subject: { title: "issue 1", type: "Issue", url: "https://api.github.com/repos/me/app/issues/1" }, repository: { full_name: "me/app" } }]);
      if (M("PATCH", /^\/notifications\/threads\/(\w+)$/) || M("PUT", /^\/notifications$/)) return send(205);
      if (M("GET", /^\/search\/issues$/)) {
        const isPr = /is:pr/.test(url.searchParams.get("q") || "");
        return send(200, { total_count: 1, items: [issue(7, { repository_url: "https://api.github.com/repos/me/app", ...(isPr ? { pull_request: {} } : {}) })] });
      }
      if (M("POST", /^\/repos\/me\/app\/issues$/)) return send(201, issue(10, { title: body.title, body: body.body, labels: (body.labels || []).map(name => ({ name })) }));
      if (M("GET", /^\/repos\/me\/app\/issues\/(\d+)$/)) return send(200, issue(+m[1]));
      if (M("PATCH", /^\/repos\/me\/app\/issues\/(\d+)$/)) return send(200, issue(+m[1], { state: body.state || "open", title: body.title || "t" }));
      if (M("GET", /^\/repos\/me\/app\/issues\/(\d+)\/comments$/)) return send(200, [{ id: 1, user, body: "first comment", created_at: "2026-11-02T00:00:00Z", html_url: "u" }]);
      if (M("POST", /^\/repos\/me\/app\/issues\/(\d+)\/comments$/)) return send(201, { id: 2, user, body: body.body, created_at: "2026-11-03T00:00:00Z", html_url: "u" });
      if (M("GET", /^\/repos\/me\/app\/labels$/)) return send(200, [{ name: "bug", color: "d73a4a" }]);

      const pull = (n, extra = {}) => ({ number: n, title: `pr ${n}`, state: "open", draft: false, body: "pr body", user, head: { ref: "feature", repo: { full_name: "me/app" } }, base: { ref: "main" }, labels: [], comments: 1, review_comments: 0, commits: 2, additions: 5, deletions: 1, changed_files: 1, mergeable: true, mergeable_state: "clean", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", html_url: `https://github.com/me/app/pull/${n}`, ...extra });
      if (M("GET", /^\/repos\/me\/app\/pulls$/)) return send(200, [pull(5), pull(6, { state: "closed", merged_at: "2026-11-02T00:00:00Z" })]);
      if (M("POST", /^\/repos\/me\/app\/pulls$/)) return send(201, pull(11, { title: body.title, draft: body.draft }));
      if (M("GET", /^\/repos\/me\/app\/pulls\/(\d+)$/)) return send(200, pull(+m[1]));
      if (M("PATCH", /^\/repos\/me\/app\/pulls\/(\d+)$/)) return send(200, pull(+m[1], { state: body.state || "open" }));
      if (M("GET", /^\/repos\/me\/app\/pulls\/(\d+)\/files$/)) return send(200, [{ filename: "src/a.ts", status: "modified", additions: 5, deletions: 1, patch: "@@ -1 +1,5 @@\n-old\n+new\n+x" }, { filename: "huge.js", status: "modified", additions: 1, deletions: 0, patch: "+" + "y".repeat(9000) }]);
      if (M("GET", /^\/repos\/me\/app\/pulls\/(\d+)\/reviews$/)) return send(200, [{ user, state: "APPROVED", body: "lgtm", submitted_at: "2026-11-02T00:00:00Z" }, { user, state: "PENDING", body: "draft review" }]);
      if (M("POST", /^\/repos\/me\/app\/pulls\/(\d+)\/reviews$/)) return send(200, { state: body.event === "APPROVE" ? "APPROVED" : "COMMENTED" });
      if (M("PUT", /^\/repos\/me\/app\/pulls\/(\d+)\/merge$/)) return +m[1] === 99 ? send(405, { message: "Pull Request is not mergeable" }) : send(200, { merged: true, sha: "f".repeat(40), message: "merged" });

      if (M("GET", /^\/repos\/me\/app\/actions\/workflows$/)) return send(200, { workflows: [{ id: 42, name: "CI", path: ".github/workflows/ci.yml", state: "active" }] });
      if (M("GET", /^\/repos\/me\/app\/actions\/runs$/)) return send(200, { workflow_runs: [{ id: 100, name: "CI", display_title: "fix bug", status: "completed", conclusion: "failure", head_branch: "main", head_sha: "abcdef1234", event: "push", actor: user, run_number: 7, run_attempt: 1, created_at: "2026-11-02T00:00:00Z", html_url: "u" }, { id: 101, name: "CI", status: "in_progress", conclusion: null, head_branch: "feature", head_sha: "1234567890", event: "pull_request", actor: user, run_number: 8, created_at: "2026-11-02T00:00:00Z" }] });
      if (M("GET", /^\/repos\/me\/app\/actions\/runs\/(\d+)\/jobs$/)) return send(200, { jobs: [{ id: 1, name: "build", status: "completed", conclusion: "failure", steps: [{ name: "checkout", status: "completed", conclusion: "success" }, { name: "test", status: "completed", conclusion: "failure" }] }] });
      if (M("POST", /^\/repos\/me\/app\/actions\/runs\/(\d+)\/(rerun|rerun-failed-jobs|cancel)$/)) return send(201, {});
      if (M("POST", /^\/repos\/me\/app\/actions\/workflows\/(\d+)\/dispatches$/)) return send(204);

      if (M("GET", /^\/repos\/me\/app\/releases$/)) return send(200, [{ id: 9, tag_name: "v1.0.0", name: "One", body: "notes", draft: false, prerelease: false, target_commitish: "main", author: user, created_at: "2026-11-01T00:00:00Z", published_at: "2026-11-01T00:00:00Z", html_url: "u", assets: [{ name: "a.zip", size: 2048, download_count: 3 }] }]);
      if (M("POST", /^\/repos\/me\/app\/releases$/)) return send(201, { id: 10, tag_name: body.tag_name, name: body.name, body: body.body, draft: body.draft, prerelease: body.prerelease, assets: [] });
      if (M("DELETE", /^\/repos\/me\/app\/releases\/(\d+)$/)) return send(204);

      send(404, { message: "Not Found" });
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  state.base = `http://127.0.0.1:${server.address().port}`;
  return { base: state.base, close: () => server.close() };
}
