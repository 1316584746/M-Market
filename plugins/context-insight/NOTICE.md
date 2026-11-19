Context Insight 的产品形态与交互参考了公开的同类上下文分析插件（Apache-2.0）：
洞察总览、KPI、7 天用量、热力图、技能 / 工具 / 命令排行、会话卡片、Context 详情的 9 类构成与成本估算的思路。
本插件的代码完全是为 M-Harness 的 trace 格式重新编写的，没有复制第三方源码。

Context Insight is modelled on a public context-analysis plugin (Apache-2.0): the insights overview, KPIs, 7-day usage, heatmap,
skill / tool / command rankings, session cards, the nine-way context composition and the cost estimate.
All code here was written from scratch for the M-Harness trace format; no third-party source code was copied.

成本估算：每个会话用的是「设置」里对应模型 / Agent 提供方所配置的模型，再按插件内置的离线单价表（美元 / 百万 token，数量级参考 [models.dev](https://models.dev) 这类公开模型价格库）计价，可在插件设置里按模型名覆盖；不联网拉取价格。
