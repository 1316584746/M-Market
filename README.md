# M-Market

M-Harness 的官方插件仓库。M-Harness 首次启动时已经预置了它（「设置 → 插件仓库」里叫「M-Harness 官方插件」），打开「插件」页就能看到下面的插件，点安装即可。

仓库按 **DBX 插件规范**组织：`catalog/index.json` 是插件目录，`packages/*.dbxp` 是安装包。M-Harness 的插件中心读目录、下载安装包、核对 sha256 和包内 `checksums.json`，再解压运行。

## 现有插件

| 插件 | 做什么 | 给 AI 的工具 |
|---|---|---|
| **MemSearch 长期记忆**（`memsearch`） | 记忆存成 Markdown，离线关键词（BM25）检索，可挂载自己的笔记目录 | `memory_search` `memory_recent` `memory_add` |
| **上下文洞察**（`context-insight`） | 读 M-Harness 的 trace：token 走势、上下文构成、压缩事件、工具输出占用 | `context_runs` `context_stats` |
| **billion-context**（`billion-context`） | 管理 [billion-context](https://github.com/ranxianglei/billion-context) 压缩代理：安装 / 启动 / 停止，换算各模型提供方的代理地址 | — |
| **侧边工作台**（`better-sidebar`） | 文件树、查看 / 编辑、文件名和内容搜索、Git 状态 / diff / 暂存 | — |
| **插件市场**（`market`） | 对标 DSH Market：多来源目录（DBX / DSH）、搜索 / 分类 / 标签 / 排序、一键安装 / 更新 / 卸载、收藏、分组、备注、备份还原（JSON / WebDAV / 私有 Gist） | `market_search` `market_installed` `market_install` |
| **GitHub**（`github`） | 仓库、文件浏览与编辑提交、Issues、Pull Requests（diff / 审查 / 合并）、Actions、Releases、分支；**含写操作**，用 Personal Access Token 登录 | 8 个只读 + 10 个写（`github_issue_create` `github_pull_merge` `github_file_write` …） |

六个插件都是 **一个包三个系统通用**（Windows / macOS / Linux）：后台程序是 Node 脚本（`.cjs`），由 M-Harness 自带的 Node 运行，不用按系统编译。

第一次运行带后台程序的插件，M-Harness 会让你确认信任；换版本后要重新确认。

### 它们和上游的关系（诚实说明）

这四个插件**不是**上游项目的移植，而是参考上游的产品思路、针对 M-Harness 的插件宿主重新写的精简版：

- MemSearch：参考 [zilliztech/memsearch](https://github.com/zilliztech/memsearch)（MIT）的「Markdown 是事实来源」。没有向量检索 / Milvus，只有关键词检索。**不会**在每次对话前后自动读写记忆（M-Harness 目前没有生命周期钩子），需要 AI 主动调用工具；界面里附了一段可加到「规则」里的提示词。
- 上下文洞察：参考 [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)（Apache-2.0）。只有 M-Harness 的 trace 里有的数据：没有缓存命中率和 Agent 父子网络；token 数模型返回了就用真实值，否则估算。
- billion-context：只是管理器，不含它的代码。使用它须遵守其许可证的「产品出处标注」条款，插件界面底部和 `NOTICE.md` 已标注。
- 侧边工作台：参考 DSH-better-sidebar（MIT）。**没有**终端、侧边对话、子代理页，没有语法高亮。
- 插件市场：功能范围对标 DSH Market，但**不是逐像素复刻**。没有截图预览、评论（giscus）和主题分栏；DSH 插件只能浏览，要装请去 M-Harness 自带的「插件中心」（宿主没有开放安装接口，市场是自己下载、核对 sha256 和包内 `checksums.json` 后解压到 `plugins/` 目录的，只装 DBX 包）。
- GitHub：直接调 GitHub REST API，令牌**明文**存在插件数据目录里（沙箱里没有系统钥匙串）。请用最小权限的细粒度令牌。AI 的写操作工具会真的改你的仓库（合并 PR、提交文件、发 Release 等），不想让 AI 动手就别在「让 AI 使用插件」里勾上它。

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
scripts/build-site.mjs  生成网站 site-dist/；加 --aggregate 合并上游 DSH 索引
scripts/dev-ui.mjs      在普通浏览器里调界面（假宿主 + 假 GitHub / 本地目录）
site/                   网站模板（纯静态，GitHub Pages）
test/                   后台程序、网站目录合并的行为测试
```

## 网站

`.github/workflows/site.yml` 每天抓一次上游 DSH 市场索引，合并本仓库的官方插件，生成可搜索的静态网站并发布到 GitHub Pages。第一次要在仓库 **Settings → Pages** 里把 Source 选成 **GitHub Actions**。上游抓不到时只发布官方插件，不会让构建失败。本地预览：`node scripts/build-site.mjs --aggregate`，然后用任意静态服务器打开 `site-dist/`。

## 开发

需要 Node ≥ 20，没有任何依赖。

```bash
node scripts/pack.mjs      # 打包全部插件，更新 catalog/index.json
node scripts/pack.mjs --check   # 校验包和目录与源码一致（CI 用）
node --test test/*.test.mjs     # 跑测试（解开 packages/ 里真正发布的包来测）
```

改了插件源码后：升 `manifest.json` 的 `version` → `node scripts/pack.mjs` → 提交源码、`packages/`、`catalog/`。版本号不升的话，已经装了的用户不会收到更新。

### 写一个新插件

1. 复制一个现有插件目录到 `plugins/<新 id>/`，改 `manifest.json`。
2. 后台：`require("./rpc.cjs")` 的 `serve({ id, version, methods, tools })`。`methods` 给界面用，`tools` 给 AI 用（清单里要有 `type: "mcp"` 的贡献才会出现在「让 AI 使用插件」里）。
3. 界面：普通 HTML / JS，用 `window.dbxPlugin.invoke(方法名, 参数)` 调后台。**沙箱里没有 `alert` / `confirm` / `prompt`**，要确认就在页面里做；样式用宿主注入的 `--color-*` 变量和 `dbx-*` 类。
4. 权限写在 `permissions` 里，会原样展示给用户。网络访问用 `host.network:https://域名` 声明，界面的 CSP 只放行声明过的域名。

### 宿主要求

后台程序用 `.js / .mjs / .cjs` 脚本，要 M-Harness 带「按脚本启动后台」的支持（`desktop/main/pluginhost.ts` 里按扩展名选内置 Node 运行）。更早的 M-Harness 只能启动原生可执行文件，这些插件在那样的版本上装得上但跑不起来。

## 许可

仓库代码 MIT。各插件目录下的 `NOTICE.md` 说明它们参考的上游项目及其许可证。
