<p align="center"><img src="assets/logo.svg" width="96" alt="M-Market" /></p>

# M-Market

[English](README.en.md) | 中文

[![check](https://github.com/1316584746/M-Market/actions/workflows/check.yml/badge.svg)](https://github.com/1316584746/M-Market/actions/workflows/check.yml)
[![license](https://img.shields.io/github/license/1316584746/M-Market)](LICENSE)
[![stars](https://img.shields.io/github/stars/1316584746/M-Market?style=flat)](https://github.com/1316584746/M-Market)

M-Harness 的**官方插件仓库**：DBX 格式的插件包和目录，在 M-Harness 的「插件」页里一键安装。

## 安装

M-Harness 首次启动时已经预置了这个仓库（「设置 → 插件仓库」里叫「M-Harness 官方插件」）。打开「插件」页，找到想要的插件点安装。

没有预置的话，在「插件仓库」里手动添加：

```
https://raw.githubusercontent.com/1316584746/M-Market/HEAD/catalog/index.json
```

第一次运行带后台程序的插件，M-Harness 会让你确认信任；换版本后要重新确认。

**要求**：M-Harness 要带「按脚本启动后台程序」的支持（`desktop/main/pluginhost.ts` 里按扩展名选内置 Node 运行）。更早的 M-Harness 只能启动原生可执行文件，这些插件在那样的版本上装得上但跑不起来。

## 官方插件

| 插件 | 做什么 | 给 AI 的工具 |
|---|---|---|
| **GitHub**（`github`） | 仓库、文件浏览与编辑提交、Issues、Pull Requests（diff / 审查 / 合并）、Actions、Releases、分支；**含写操作** | 8 个只读 + 10 个写（`github_issue_create` `github_pull_merge` `github_file_write` …） |
| **MemSearch 长期记忆**（`memsearch`） | 记忆存成 Markdown，离线关键词（BM25）检索，可挂载自己的笔记目录 | `memory_search` `memory_recent` `memory_add` |
| **上下文洞察**（`context-insight`） | 读 M-Harness 的 trace：洞察总览，以及单个会话的分步上下文（统计、Token / 耗时拆分、当前上下文、时间线、上下文浏览器、事件、文件、命令；续接的 Cursor 运行合成一个对话） | `context_runs` `context_stats` |
| **billion-context**（`billion-context`） | 管理 [billion-context](https://github.com/ranxianglei/billion-context) 压缩代理：安装 / 启动 / 停止，换算各模型提供方的代理地址 | — |
| **DSH-better-sidebar**（`better-sidebar`） | 文件树、查看 / 编辑（语法高亮、Markdown 预览）、文件名和内容搜索、Git 状态 / diff / 暂存、Git Graph 和提交详情、命令面板（一次跑一条命令，无 PTY） | — |
| **Grafana**（`grafana`） | 只读连接你自己的 Grafana：组织与健康状态、正在触发的告警、仪表盘搜索和面板列表 | `grafana_status` `grafana_alerts` `grafana_dashboards` `grafana_dashboard` |
| **modsearch**（`modsearch`） | 给 AI 联网搜索和读网页：Firecrawl / Keenable / You.com 免注册可用，Tavily / Exa 填 key 后加入；多引擎自动故障转移、多 key 轮换、配额冷却、内网防护；长页面分段读取 | `web_search` `x_search` `read_page` `modsearch_doctor` |
| **AgentTeams**（`agent-teams`） | 多 Agent 团队协作：AI 当队长，组好带依赖的任务和持久成员；批准后成员自动领任务、互发消息，页面里看进度、任务依赖图、成员实时动态，并逐条确认成员的写文件 / 执行命令；可给任务加质量门（合同、完成证据、评审不过自动修复 + 复审） | 14 个 `agent_teams_*`（`create` `approve` `edit_plan` `add_member` `remove_member` `create_task` `reassign_task` `claim_task` `update_task` `amend_task` `send_message` `status` `resume` `delete`） |

八个插件都是 **一个包三个系统通用**（Windows / macOS / Linux）：后台程序是 Node 脚本（`.cjs`），由 M-Harness 自带的 Node 运行，不用按系统编译。

## 网站

`.github/workflows/site.yml` 每天抓一次上游的社区插件索引，合并本仓库的官方插件，生成可搜索的静态网站（`site/` 是样式和脚本，页面由 `scripts/build-site.mjs` 生成）并发布到 GitHub Pages。中文在根目录、英文在 `en/`，每种语言都有：首页（搜索 / 分类 / 排序）、安装页、隐私页、**每个插件一页**（含官方插件的下载链接、权限和 sha256）、404，另有 `sitemap.xml` 和 `robots.txt`。网站没有统计脚本和 Cookie。第一次要在仓库 **Settings → Pages** 里把 Source 选成 **GitHub Actions**。上游抓不到时只发布官方插件，不会让构建失败。

本地预览：`node scripts/build-site.mjs --aggregate`，然后用任意静态服务器打开 `site-dist/`。

## 安全

- 安装包按目录里的 sha256 校验，同时校验包内 `checksums.json`；解压拒绝带 `..` 的路径和绝对路径
- 下载只能是 https（本机地址除外），并且只能来自目录所在站点或 `raw.githubusercontent.com` / `github.com` / `objects.githubusercontent.com` / `cdn.jsdelivr.net` / `dl.dbxio.com`
- 插件的界面跑在沙箱 iframe 里，网络访问只放行清单里用 `host.network:` 声明过的域名
- 插件申请的权限会在安装前原样展示
- **令牌和密码是明文存的**：GitHub 插件的 Personal Access Token、Grafana 插件的服务账号令牌 / 账号密码、modsearch 的各引擎 API key、AgentTeams 里你自己填的自定义模型路由 key，都明文放在插件自己的数据目录里（沙箱里没有系统钥匙串）。请用最小权限的细粒度令牌。备份文件里不含它们。
- GitHub 插件的 AI 写操作工具会真的改你的仓库（合并 PR、提交文件、发 Release 等），不想让 AI 动手就别在「让 AI 使用插件」里勾上它
- 收录不等于背书：插件都是第三方代码，只装你信任的作者的

发现安全问题请看 [SECURITY.md](SECURITY.md)。

## 提交你的插件

- **官方仓库收录**：欢迎 PR 新插件。按下面「写一个新插件」做好，`node scripts/pack.mjs` 打包并提交，开 PR 时用仓库里的模板。
- **放在自己的仓库**：做一个 DBX 目录（`catalog/index.json`，格式见本仓库），在 M-Harness 的「设置 → 插件仓库」里把地址加成一个仓库，就能安装。
- Bug 请提 [issue](https://github.com/1316584746/M-Market/issues)，附上插件版本和复现步骤，定位会快很多。

## 目录结构

```
catalog/index.json      DBX 目录（pack 脚本生成，不要手改）
packages/*.dbxp         安装包（pack 脚本生成；.gitattributes 里标成二进制）
plugins/<id>/           每个插件的源码
  manifest.json         清单：id、版本、权限、入口、给 AI 的工具声明
  bin/backend.cjs       后台程序（stdio JSON-RPC）
  ui/                   界面（跑在 sandbox iframe 里，通过 window.dbxPlugin 调后台）
  assets/icon.svg
shared/rpc.cjs          各插件后台共用的 JSON-RPC 小库（打包时复制进 bin/rpc.cjs）
scripts/pack.mjs        打包 + 生成目录；加 --check 只校验
scripts/build-site.mjs  生成网站 site-dist/；加 --aggregate 合并上游社区索引
scripts/dev-ui.mjs      在普通浏览器里调界面（假宿主 + 假 GitHub / 本地目录）
site/                   网站模板（纯静态，GitHub Pages）
assets/                 README 用的图
test/                   后台程序、网站目录合并的行为测试
```

## 开发

需要 Node ≥ 20，没有任何依赖。

```bash
node scripts/pack.mjs           # 打包全部插件，更新 catalog/index.json
node scripts/pack.mjs --check   # 校验包和目录与源码一致（CI 用）
node --test test/*.test.mjs     # 跑测试（解开 packages/ 里真正发布的包来测）
node scripts/dev-ui.mjs github  # 在浏览器里调某个插件的界面（换成其它插件 id 同理）
```

改了插件源码后：升 `manifest.json` 的 `version` → `node scripts/pack.mjs` → 提交源码、`packages/`、`catalog/`。版本号不升的话，已经装了的用户不会收到更新。

### 写一个新插件

1. 复制一个现有插件目录到 `plugins/<新 id>/`，改 `manifest.json`。
2. 后台：`require("./rpc.cjs")` 的 `serve({ id, version, methods, tools })`。`methods` 给界面用，`tools` 给 AI 用（清单里要有 `type: "mcp"` 的贡献才会出现在「让 AI 使用插件」里）。
3. 界面：普通 HTML / JS，用 `window.dbxPlugin.invoke(方法名, 参数)` 调后台。**沙箱里没有 `alert` / `confirm` / `prompt`**，要确认就在页面里做；样式用宿主注入的 `--color-*` 变量和 `dbx-*` 类。
4. 权限写在 `permissions` 里，会原样展示给用户。网络访问用 `host.network:https://域名` 声明（最多 8 个），界面的 CSP 只放行声明过的域名。

## 它们和上游的关系

除了 modsearch 和 AgentTeams，这些插件**不是**上游项目的移植，而是参考上游的产品思路、针对 M-Harness 的插件宿主重新写的精简版：

- AgentTeams：产品模型移植自 [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)（MIT）：队长 + 持久成员、带依赖的任务、attempt / attemptId 尝试代次、信箱、先批准后运行、14 个协调工具的名字和语义，代码为重新实现。**不改 M-Harness 内核**的前提下和上游有这些不同：成员不是宿主的子 Agent，而是插件自己跑的「模型 → 工具」循环，只能用 M-Harness 里 type 为 `openai-compat` / `anthropic` 的提供方（cursor-sdk / 命令行 Agent 不行）；成员的读文件、写文件、执行命令由插件自己实现、不经过 M-Harness 的审批（读限工作区内；写和执行要在页面里确认，开「全部允许」才免确认；成员可设为只读）；聊天里没有内嵌团队卡片、没有系统提示词注入，队长靠 `agent_teams_status`（可带 `wait_seconds`）取成员结果；成员的 token 用量只记在团队文件里，不进 M-Harness 的 trace。质量门（任务类型与合同、完成证据、范围审计、评审不过自动创建修复 + 复审、超过上限升级给队长、目标覆盖与可交付判定）已实现，但范围检查是**写入时**拦截（插件自己持有 `write_file`），`run_command` 里发生的文件改动审计不到。**还没有**成员模型的第二选择（fallback）、`/agent-teams` 斜杠命令和命名多角色 profile。
- modsearch：[liustack/modsearch](https://github.com/liustack/modsearch)（MIT）的 CommonJS 移植版，引擎路由、故障转移、多 key 轮换、配额冷却、内网防护的行为按原项目复刻，代码为重新实现。**没有**移植 Antigravity CLI 和 Grok Build（X 搜索）两个要拉起外部命令行的引擎，所以 `x_search` 只能用网页搜索代答并标明是二手证据；也没有跟随系统代理的网络层。搜索词和云端读网页的网址会发给所选引擎的服务，不想发就在设置里关掉云端读网页。

- MemSearch：参考 [zilliztech/memsearch](https://github.com/zilliztech/memsearch)（MIT）的「Markdown 是事实来源」。没有向量检索 / Milvus，只有关键词检索。**不会**在每次对话前后自动读写记忆（M-Harness 目前没有生命周期钩子），需要 AI 主动调用工具；界面里附了一段可加到「规则」里的提示词。
- 上下文洞察：参考公开的同类上下文分析工具的产品思路，代码完全为 M-Harness 的 trace 格式重写。只有 trace 里有的数据：没有缓存命中率和 Agent 父子网络；token 数模型返回了就用真实值，否则估算；费用按「设置」里各模型 / Agent 提供方对应的模型计价（见插件设置）。
- billion-context：只是管理器，不含它的代码。使用它须遵守其许可证的「产品出处标注」条款，插件界面底部和 `NOTICE.md` 已标注。
- DSH-better-sidebar：名称沿用 dsh market 里的 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT），产品形态参考它，代码重新编写。**没有**终端、侧边对话、任务页（子代理拓扑、后台任务）、按会话独立的布局和 `ctx.betterSidebar` 扩展服务：这些依赖 DSH 的网页、会话和终端服务，M-Harness 的插件宿主没有。命令面板是「一次跑一条命令」的简化版，没有 PTY，跑不了需要交互的全屏程序（所以 manifest 多声明了 `process.exec` 权限）。
- GitHub：直接调 GitHub REST API。
- Grafana：只调用用户自己的 Grafana HTTP API（组织、告警、仪表盘、注释），只读。不含 Grafana 的代码；Grafana 本体是 AGPL-3.0。

## 许可

仓库代码 MIT。各插件目录下的 `NOTICE.md` 说明它们参考的上游项目及其许可证。
