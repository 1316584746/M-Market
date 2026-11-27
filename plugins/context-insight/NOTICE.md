Context Insight 的产品形态与交互参考了公开的同类上下文分析插件（Apache-2.0）：
洞察总览、KPI、7 天用量、热力图、技能 / 工具 / 命令排行、会话卡片、Context 详情的 9 类构成与成本估算的思路；0.4 起 Context 页的分步视图（统计、Token / 耗时拆分、当前上下文、时间线、上下文浏览器、事件 / 文件 / 命令）参考了公开的 dsh-context 插件（Apache-2.0）的页面结构，数据全部来自 M-Harness 的 trace，trace 里没有的项显示为「—」，不编造。
本插件的代码完全是为 M-Harness 的 trace 格式重新编写的，没有复制第三方源码。

Context Insight is modelled on a public context-analysis plugin (Apache-2.0): the insights overview, KPIs, 7-day usage, heatmap,
skill / tool / command rankings, session cards, the nine-way context composition and the cost estimate. Since 0.4 the step-by-step Context page (stats, token / timing breakdown, live context, timeline, context browser, events / files / commands) follows the page structure of the public dsh-context plugin (Apache-2.0); all data comes from M-Harness traces, anything the trace does not record shows as "—" and is never made up.
All code here was written from scratch for the M-Harness trace format; no third-party source code was copied.

成本估算：每个会话用的是「设置」里对应模型 / Agent 提供方所配置的模型，再按插件内置的离线单价表（美元 / 百万 token，数量级参考 [models.dev](https://models.dev) 这类公开模型价格库）计价，可在插件设置里按模型名覆盖；不联网拉取价格。

联网说明：页头的余额跟着「当前在用的提供方」走（最近一次运行 trace 里的 provider，没有就用配置里的 defaultProvider）。只有 DeepSeek（`GET /user/balance`）、Moonshot（`GET /v1/users/me/balance`）、SiliconFlow（`GET /v1/user/info`）、OpenRouter（`GET /api/v1/credits`）有用 key 查余额的接口，且 key 能解出来时才会请求，key 只发给该提供方自己的这一个地址，不会返回到界面或写入插件数据；结果按提供方缓存 5 分钟。Cursor、OpenAI、Anthropic、智谱和命令行 Agent 没有这种接口，页头只显示一个灰色说明，不联网。在插件设置里取消勾选「在页头显示当前提供方的余额」即完全不联网。除此之外插件不访问网络。

Network note: the balance chip in the header follows the provider currently in use (the provider of the latest run trace, else the config's defaultProvider). Only DeepSeek (`GET /user/balance`), Moonshot (`GET /v1/users/me/balance`), SiliconFlow (`GET /v1/user/info`) and OpenRouter (`GET /api/v1/credits`) have a key-based balance API, and the request is only made when the key resolves. The key goes to that provider's own endpoint only, is never returned to the UI or stored in plugin data, and the result is cached per provider for 5 minutes. Cursor, OpenAI, Anthropic, Zhipu and CLI agents have no such API, so the header shows a grey note and nothing goes online. Untick the option in the plugin settings to stop all network access; the plugin makes no other requests.
