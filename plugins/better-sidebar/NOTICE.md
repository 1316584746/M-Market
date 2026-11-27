本插件的名称沿用 dsh market 里的 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT，作者 omdsh-dev），产品形态参考它：侧边工作台里的文件树、查看 / 编辑和 Git 面板。
本插件代码为针对 M-Harness 插件宿主重新编写的版本，不包含该项目的源码，也不是它的移植：它依赖 DSH 的网页服务、会话服务和终端，M-Harness 的插件宿主没有这些能力，所以没有终端、侧边对话、任务页（子代理拓扑和后台任务）、按会话独立的布局，也没有 `ctx.betterSidebar` 扩展服务。
