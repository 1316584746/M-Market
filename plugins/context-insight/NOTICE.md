Context Insight 的产品形态与交互参考了公开的同类上下文分析插件（Apache-2.0）：
洞察总览、KPI、7 天用量、热力图、技能 / 工具 / 命令排行、会话卡片、Context 详情的 9 类构成与成本估算的思路。
本插件的代码完全是为 M-Harness 的 trace 格式重新编写的，没有复制第三方源码。

Context Insight is modelled on a public context-analysis plugin (Apache-2.0): the insights overview, KPIs, 7-day usage, heatmap,
skill / tool / command rankings, session cards, the nine-way context composition and the cost estimate.
All code here was written from scratch for the M-Harness trace format; no third-party source code was copied.

成本估算：每个会话用的是「设置」里对应模型 / Agent 提供方所配置的模型，再按插件内置的离线单价表（美元 / 百万 token，数量级参考 [models.dev](https://models.dev) 这类公开模型价格库）计价，可在插件设置里按模型名覆盖；不联网拉取价格。

联网说明：页头的「DeepSeek 余额」只在 M-Harness 配置里有指向 https://api.deepseek.com 的提供方、且能解出它的 key 时才会请求 `GET /user/balance`，key 只发给这个地址，不会返回到界面或写入插件数据；结果缓存 5 分钟。在插件设置里取消勾选「在页头显示 DeepSeek 余额」即不再联网。除此之外插件不访问网络。

Network note: the "DeepSeek balance" chip in the header calls `GET /user/balance` on https://api.deepseek.com only when the M-Harness config has a provider pointing there and its key resolves. The key goes to that host only, is never returned to the UI or stored in plugin data, and the result is cached for 5 minutes. Untick the option in the plugin settings to stop all network access; the plugin makes no other requests.
