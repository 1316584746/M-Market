<p align="center"><img src="assets/logo.svg" width="96" alt="M-Market" /></p>

# M-Market

English | [中文](README.md)

[![check](https://github.com/1316584746/M-Market/actions/workflows/check.yml/badge.svg)](https://github.com/1316584746/M-Market/actions/workflows/check.yml)
[![license](https://img.shields.io/github/license/1316584746/M-Market)](LICENSE)
[![stars](https://img.shields.io/github/stars/1316584746/M-Market?style=flat)](https://github.com/1316584746/M-Market)

The **official plugin repository** for M-Harness: DBX plugin packages and a catalog, installed with one click from M-Harness's Plugins page.

## Install

M-Harness ships with this repository preset (Settings → Plugin repositories → "M-Harness official plugins"). Open the **Plugins** page, find the plugin you want and click Install.

If it is not preset, add this catalog URL as a plugin repository:

```
https://raw.githubusercontent.com/1316584746/M-Market/HEAD/catalog/index.json
```

The first time a plugin with a backend process runs, M-Harness asks you to trust it; a new version asks again.

**Requirement**: an M-Harness build that can start script backends (`desktop/main/pluginhost.ts` picks the bundled Node by file extension). Older builds can only launch native executables: these plugins install there but will not run.

## Official plugins

| Plugin | What it does | AI tools |
|---|---|---|
| **GitHub** (`github`) | Repositories, file browse and edit-commit, Issues, Pull Requests (diff / review / merge), Actions, Releases, branches; **includes write operations** | 8 read-only + 10 write tools (`github_issue_create` `github_pull_merge` `github_file_write` …) |
| **MemSearch** (`memsearch`) | Long-term memory as Markdown, offline keyword (BM25) search, mountable note folders | `memory_search` `memory_recent` `memory_add` |
| **Context Insight** (`context-insight`) | Reads M-Harness traces: insights page (KPIs, token & cost chart, token / time breakdown, activity heatmap, skill / tool / command rankings, session cards), a per-session step-by-step context view (stats, token / timing breakdown, live context, timeline, context browser, events, file activity, command runs; continued Cursor runs are merged into one conversation); optional balance of the provider currently in use in the header (DeepSeek / Moonshot / SiliconFlow / OpenRouter only, the key goes to that provider's own endpoint; other providers such as Cursor have no balance API and nothing is sent; can be switched off) | `context_runs` `context_stats` `context_overview` |
| **billion-context** (`billion-context`) | Manager for the [billion-context](https://github.com/ranxianglei/billion-context) compression proxy: install / start / stop, per-provider proxy URLs | — |
| **DSH-better-sidebar** (`better-sidebar`) | File tree, view / edit (syntax highlighting, Markdown preview), name and content search, Git status / diff / stage, Git Graph with commit details, a command panel (one command at a time, no PTY) | — |
| **Grafana** (`grafana`) | Read-only console for your own Grafana: org and health, firing alerts, dashboard search and panel lists | `grafana_status` `grafana_alerts` `grafana_dashboards` `grafana_dashboard` |
| **modsearch** (`modsearch`) | Web search and page reading for the AI: Firecrawl / Keenable / You.com work with no signup, Tavily / Exa join once you add a key; automatic multi-engine failover, multi-key rotation, quota cooldown, private-network guard, paged reading of long pages | `web_search` `x_search` `read_page` `modsearch_doctor` |
| **AgentTeams** (`agent-teams`) | Multi-agent teams: the AI is the captain and plans dependency-aware tasks with durable members; after approval members claim tasks and message each other, while the page shows progress, the task graph and live member activity, and asks you to confirm member file writes / commands; tasks can carry quality gates (contract, completion evidence, automatic repair + re-review when a review fails) | 14 `agent_teams_*` tools (`create` `approve` `edit_plan` `add_member` `remove_member` `create_task` `reassign_task` `claim_task` `update_task` `amend_task` `send_message` `status` `resume` `delete`) |

All eight are **one package for all three platforms**: the backend is a Node script (`.cjs`) run by the Node bundled with M-Harness; nothing is compiled per OS.

## Website

`.github/workflows/site.yml` fetches the upstream community plugin index daily, merges it with this repository's official plugins, builds a searchable static site (`site/` is the template) and publishes it to GitHub Pages. Set **Settings → Pages → Source** to **GitHub Actions** once. If the upstream is unreachable, only official plugins are published; the build does not fail.

## Security

- Packages are verified against the catalog sha256 and the in-package `checksums.json`; extraction rejects `..` and absolute paths
- Downloads must be https (loopback excepted) and come from the catalog's host or `raw.githubusercontent.com` / `github.com` / `objects.githubusercontent.com` / `cdn.jsdelivr.net` / `dl.dbxio.com`
- Plugin UIs run in a sandboxed iframe; network access is limited to the origins declared as `host.network:` in the manifest
- **Tokens and passwords are stored in plain text** in the plugin's data directory (the sandbox has no keychain): the GitHub plugin's personal access token, the Grafana plugin's service-account token or account password, modsearch's engine API keys, and the custom model-route key you may enter in AgentTeams. Use minimal-scope fine-grained tokens. Backups never contain them.
- The GitHub plugin's AI write tools change your repositories for real; do not enable them if you do not want the AI to act
- Listed does not mean endorsed: plugins are third-party code

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Submit your plugin

- **Into this repository**: PRs welcome. Build it as described below, run `node scripts/pack.mjs`, and open a PR with the template.
- **In your own repository**: publish a DBX catalog (`catalog/index.json`, same format as here) and add its URL under Settings → Plugin repositories in M-Harness to install from it.
- Bugs go to [issues](https://github.com/1316584746/M-Market/issues); include the plugin version and steps to reproduce.

## Layout

```
catalog/index.json      DBX catalog (generated by scripts/pack.mjs)
packages/*.dbxp         packages (generated; marked binary in .gitattributes)
plugins/<id>/           plugin sources (manifest.json, bin/backend.cjs, ui/, assets/)
shared/rpc.cjs          shared JSON-RPC helper (copied into each package as bin/rpc.cjs)
scripts/                pack.mjs, build-site.mjs, dev-ui.mjs
site/                   static website template
assets/                 images for the README
test/                   behaviour tests
```

## Development

Node ≥ 20, no dependencies.

```bash
node scripts/pack.mjs           # build all packages, update catalog/index.json
node scripts/pack.mjs --check   # verify packages and catalog match the sources (CI)
node --test test/*.test.mjs     # tests run against the published packages in packages/
node scripts/dev-ui.mjs github  # debug a plugin UI in a normal browser (other plugin ids work too)
```

After changing a plugin: bump `version` in its `manifest.json`, run `node scripts/pack.mjs`, commit sources, `packages/` and `catalog/`. Without a version bump, installed users receive no update.

## License

Repository code is MIT. Each plugin's `NOTICE.md` lists the third-party projects it drew on and their licenses.
