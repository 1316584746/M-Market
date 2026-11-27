<p align="center"><img src="assets/logo.svg" width="96" alt="M-Market" /></p>

# M-Market

[English](README.en.md) | 中文

[![check](https://github.com/1316584746/M-Market/actions/workflows/check.yml/badge.svg)](https://github.com/1316584746/M-Market/actions/workflows/check.yml)
[![license](https://img.shields.io/github/license/1316584746/M-Market)](LICENSE)
[![stars](https://img.shields.io/github/stars/1316584746/M-Market?style=flat)](https://github.com/1316584746/M-Market)

M-Harness 里的**插件市场**，也是 M-Harness 的**官方插件仓库**。浏览、搜索、一键安装。

## 安装

M-Harness 首次启动时已经预置了这个仓库（「设置 → 插件仓库」里叫「M-Harness 官方插件」）。打开「插件」页，找到 **插件市场** 点安装；装好后用它去装别的插件。

没有预置的话，在「插件仓库」里手动添加：

```
https://raw.githubusercontent.com/1316584746/M-Market/HEAD/catalog/index.json
```

第一次运行带后台程序的插件，M-Harness 会让你确认信任；换版本后要重新确认。

**要求**：M-Harness 要带「按脚本启动后台程序」的支持（`desktop/main/pluginhost.ts` 里按扩展名选内置 Node 运行）。更早的 M-Harness 只能启动原生可执行文件，这些插件在那样的版本上装得上但跑不起来。

## 官方插件

| 插件 | 做什么 | 给 AI 的工具 |
|---|---|---|
| **插件市场**（`market`） | 多来源目录、搜索 / 分类 / 排序、一键安装 / 更新 / 卸载、收藏、分组、备注、主题页、备份还原、诊断日志 | `market_search` `market_installed` `market_install` |
| **GitHub**（`github`） | 仓库、文件浏览与编辑提交、Issues、Pull Requests（diff / 审查 / 合并）、Actions、Releases、分支；**含写操作** | 8 个只读 + 10 个写（`github_issue_create` `github_pull_merge` `github_file_write` …） |
| **MemSearch 长期记忆**（`memsearch`） | 记忆存成 Markdown，离线关键词（BM25）检索，可挂载自己的笔记目录 | `memory_search` `memory_recent` `memory_add` |
| **上下文洞察**（`context-insight`） | 读 M-Harness 的 trace：token 走势、上下文构成、压缩事件、工具输出占用 | `context_runs` `context_stats` |
| **billion-context**（`billion-context`） | 管理 [billion-context](https://github.com/ranxianglei/billion-context) 压缩代理：安装 / 启动 / 停止，换算各模型提供方的代理地址 | — |
| **DSH-better-sidebar**（`better-sidebar`） | 文件树、查看 / 编辑、文件名和内容搜索、Git 状态 / diff / 暂存 | — |
| **Grafana**（`grafana`） | 只读连接你自己的 Grafana：组织与健康状态、正在触发的告警、仪表盘搜索和面板列表 | `grafana_status` `grafana_alerts` `grafana_dashboards` `grafana_dashboard` |
| **modsearch**（`modsearch`） | 给 AI 联网搜索和读网页：Firecrawl / Keenable / You.com 免注册可用，Tavily / Exa 填 key 后加入；多引擎自动故障转移、多 key 轮换、配额冷却、内网防护；长页面分段读取 | `web_search` `x_search` `read_page` `modsearch_doctor` |

七个插件都是 **一个包三个系统通用**（Windows / macOS / Linux）：后台程序是 Node 脚本（`.cjs`），由 M-Harness 自带的 Node 运行，不用按系统编译。

## 插件市场能做什么

- **浏览与搜索**：同时读官方目录和社区插件索引；分类胶囊带数量，按星标 / 最近更新 / 名称排序，类型和来源筛选；「最近更新」横条
- **一键安装 / 更新 / 卸载**（DBX 插件）：安装前显示它申请的权限；下载后核对目录里的 sha256 和包内 `checksums.json`，对不上不安装；只允许目录所在站点和几个常见托管站下载
- **截图**：目录里写了截图就直接用；没写就去插件仓库的 README 里找（只认 GitHub 托管的图，徽章和别的站的图会丢掉），在详情里轮播，点图放大
- **收藏、分组、备注**：分组可以重命名 / 删除；备注能被搜到；全部只存在本机
- **主题页**：把名称或关键词里带「主题 / 皮肤 / theme / skin」的插件单独列出来
- **备份与还原**：导出成可读的 JSON，或同步到 WebDAV、私有 Gist；还原是「合并」（备份之后新增的不会丢），也可以选覆盖
- **导出日志**：版本、来源状态、已装插件，路径和令牌已遮掉，不会发到任何地方
- **AI 工具**：`market_search` / `market_installed` / `market_install`

### 已知限制（诚实说明）

- **评论**：插件窗口里没法嵌入 giscus 评论区（沙箱不允许嵌入外部页面）。「评论」按钮给出的是该插件 GitHub 仓库的 Discussions / Issues 链接，复制到浏览器打开。
- **社区索引里的插件只能浏览**：M-Harness 没开放安装接口，市场是自己下载、校验、解压到 `plugins/` 目录的，只会装 DBX 包。其它格式的插件请到 M-Harness 自带的「插件中心」安装。
- **屏蔽与全部更新**：卡片「···」里可以屏蔽不想再看到的插件（在「已屏蔽」里找回）；「已安装」里有更新时一键「全部更新」（逐个校验，一个失败不影响其他；市场自己跳过，要单独更新）
- **没有的**：下载量统计、兼容性筛选、热禁用 / 启用、后台更新提醒（只在卡片上标「有更新」）、加载顺序与冲突诊断、GitHub 加速线路、定时自动备份。
- **卡片上的截图**只有目录里写了 `screenshots` 的插件才有；README 里找到的图只在详情里显示（逐个插件拉 README 太慢，也费流量）。

## 网站

`.github/workflows/site.yml` 每天抓一次上游的社区插件索引，合并本仓库的官方插件，生成可搜索的静态网站（`site/` 是样式和脚本，页面由 `scripts/build-site.mjs` 生成）并发布到 GitHub Pages。中文在根目录、英文在 `en/`，每种语言都有：首页（搜索 / 分类 / 排序）、安装页、隐私页、**每个插件一页**（含官方插件的下载链接、权限和 sha256）、404，另有 `sitemap.xml` 和 `robots.txt`。网站没有统计脚本和 Cookie。第一次要在仓库 **Settings → Pages** 里把 Source 选成 **GitHub Actions**。上游抓不到时只发布官方插件，不会让构建失败。

本地预览：`node scripts/build-site.mjs --aggregate`，然后用任意静态服务器打开 `site-dist/`。

## 安全

- 安装包按目录里的 sha256 校验，同时校验包内 `checksums.json`；解压拒绝带 `..` 的路径和绝对路径
- 下载只能是 https（本机地址除外），并且只能来自目录所在站点或 `raw.githubusercontent.com` / `github.com` / `objects.githubusercontent.com` / `cdn.jsdelivr.net` / `dl.dbxio.com`
- 插件的界面跑在沙箱 iframe 里，网络访问只放行清单里用 `host.network:` 声明过的域名
- 插件申请的权限会在安装前原样展示
- **令牌和密码是明文存的**：市场的 WebDAV 密码 / Gist 令牌、GitHub 插件的 Personal Access Token、Grafana 插件的服务账号令牌、modsearch 的各引擎 API key，都明文放在插件自己的数据目录里（沙箱里没有系统钥匙串）。请用最小权限的细粒度令牌。备份文件里不含它们。
- GitHub 插件的 AI 写操作工具会真的改你的仓库（合并 PR、提交文件、发 Release 等），不想让 AI 动手就别在「让 AI 使用插件」里勾上它
- 收录不等于背书：插件都是第三方代码，只装你信任的作者的

发现安全问题请看 [SECURITY.md](SECURITY.md)。

## 提交你的插件

- **官方仓库收录**：欢迎 PR 新插件。按下面「写一个新插件」做好，`node scripts/pack.mjs` 打包并提交，开 PR 时用仓库里的模板。
- **放在自己的仓库**：做一个 DBX 目录（`catalog/index.json`，格式见本仓库），在市场的「备份与来源」里把地址加成一个来源，就能被别人搜到、安装。
- Bug 请提 [issue](https://github.com/1316584746/M-Market/issues)，附上市场右上角「导出日志」的内容，定位会快很多。

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
node scripts/dev-ui.mjs market  # 在浏览器里调市场界面（github / 其它插件 id 同理）
```

改了插件源码后：升 `manifest.json` 的 `version` → `node scripts/pack.mjs` → 提交源码、`packages/`、`catalog/`。版本号不升的话，已经装了的用户不会收到更新。

### 写一个新插件

1. 复制一个现有插件目录到 `plugins/<新 id>/`，改 `manifest.json`。
2. 后台：`require("./rpc.cjs")` 的 `serve({ id, version, methods, tools })`。`methods` 给界面用，`tools` 给 AI 用（清单里要有 `type: "mcp"` 的贡献才会出现在「让 AI 使用插件」里）。
3. 界面：普通 HTML / JS，用 `window.dbxPlugin.invoke(方法名, 参数)` 调后台。**沙箱里没有 `alert` / `confirm` / `prompt`**，要确认就在页面里做；样式用宿主注入的 `--color-*` 变量和 `dbx-*` 类。
4. 权限写在 `permissions` 里，会原样展示给用户。网络访问用 `host.network:https://域名` 声明（最多 8 个），界面的 CSP 只放行声明过的域名。

## 它们和上游的关系

除了 modsearch，这些插件**不是**上游项目的移植，而是参考上游的产品思路、针对 M-Harness 的插件宿主重新写的精简版：

- modsearch：[liustack/modsearch](https://github.com/liustack/modsearch)（MIT）的 CommonJS 移植版，引擎路由、故障转移、多 key 轮换、配额冷却、内网防护的行为按原项目复刻，代码为重新实现。**没有**移植 Antigravity CLI 和 Grok Build（X 搜索）两个要拉起外部命令行的引擎，所以 `x_search` 只能用网页搜索代答并标明是二手证据；也没有跟随系统代理的网络层。搜索词和云端读网页的网址会发给所选引擎的服务，不想发就在设置里关掉云端读网页。

- MemSearch：参考 [zilliztech/memsearch](https://github.com/zilliztech/memsearch)（MIT）的「Markdown 是事实来源」。没有向量检索 / Milvus，只有关键词检索。**不会**在每次对话前后自动读写记忆（M-Harness 目前没有生命周期钩子），需要 AI 主动调用工具；界面里附了一段可加到「规则」里的提示词。
- 上下文洞察：参考公开的同类上下文分析工具的产品思路，代码完全为 M-Harness 的 trace 格式重写。只有 trace 里有的数据：没有缓存命中率和 Agent 父子网络；token 数模型返回了就用真实值，否则估算；费用按「设置」里各模型 / Agent 提供方对应的模型计价（见插件设置）。
- billion-context：只是管理器，不含它的代码。使用它须遵守其许可证的「产品出处标注」条款，插件界面底部和 `NOTICE.md` 已标注。
- DSH-better-sidebar：名称沿用 dsh market 里的 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT），产品形态参考它，代码重新编写。**没有**终端、侧边对话、任务页（子代理拓扑、后台任务）、按会话独立的布局和 `ctx.betterSidebar` 扩展服务：这些依赖 DSH 的网页、会话和终端服务，M-Harness 的插件宿主没有。也没有语法高亮、Git Graph。
- 插件市场：功能范围和限制见上面「插件市场能做什么」和「已知限制」。
- GitHub：直接调 GitHub REST API。
- Grafana：只调用用户自己的 Grafana HTTP API（组织、告警、仪表盘、注释），只读。不含 Grafana 的代码；Grafana 本体是 AGPL-3.0。

## 许可

仓库代码 MIT。各插件目录下的 `NOTICE.md` 说明它们参考的上游项目及其许可证。
