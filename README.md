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

四个插件都是 **一个包三个系统通用**（Windows / macOS / Linux）：后台程序是 Node 脚本（`.cjs`），由 M-Harness 自带的 Node 运行，不用按系统编译。

第一次运行带后台程序的插件，M-Harness 会让你确认信任；换版本后要重新确认。

### 它们和上游的关系（诚实说明）

这四个插件**不是**上游项目的移植，而是参考上游的产品思路、针对 M-Harness 的插件宿主重新写的精简版：

- MemSearch：参考 [zilliztech/memsearch](https://github.com/zilliztech/memsearch)（MIT）的「Markdown 是事实来源」。没有向量检索 / Milvus，只有关键词检索。**不会**在每次对话前后自动读写记忆（M-Harness 目前没有生命周期钩子），需要 AI 主动调用工具；界面里附了一段可加到「规则」里的提示词。
- 上下文洞察：参考 [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)（Apache-2.0）。只有 M-Harness 的 trace 里有的数据：没有缓存命中率和 Agent 父子网络；token 数模型返回了就用真实值，否则估算。
- billion-context：只是管理器，不含它的代码。使用它须遵守其许可证的「产品出处标注」条款，插件界面底部和 `NOTICE.md` 已标注。
- 侧边工作台：参考 DSH-better-sidebar（MIT）。**没有**终端、侧边对话、子代理页，没有语法高亮。

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
test/                   后台程序的行为测试
```

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

后台程序用 `.js / .mjs / .cjs` 脚本，要 M-Harness 带「按脚本启动后台」的支持（`desktop/main/pluginhost.ts` 里按扩展名选内置 Node 运行）。更早的 M-Harness 只能启动原生可执行文件，这四个插件在那样的版本上装得上但跑不起来。

## 许可

仓库代码 MIT。各插件目录下的 `NOTICE.md` 说明它们参考的上游项目及其许可证。
