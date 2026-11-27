本插件是 [liustack/modsearch](https://github.com/liustack/modsearch)（MIT 许可证，Copyright (c) 2026 Leon Liu）的 CommonJS 移植版：引擎路由、故障转移、多 key 轮换、配额冷却、内网防护（SSRF）、HTML 转文本和页面窗口的行为都按原项目复刻，代码为重新实现。

移植范围：Firecrawl、Keenable、You.com、Tavily、Exa 和本地直连抓取。没有移植 Antigravity CLI 和 Grok Build（X 搜索）这两个要拉起外部命令行并登录的引擎，也没有移植跟随系统代理的网络层；`x_search` 因此会用网页搜索代答，并明确标注为二手证据。

本插件不内置任何第三方服务的密钥。搜索会把你的查询词发给所选引擎的云端；云端抓取会把网页地址发给对应服务。设置里可以关闭云端抓取，只用本地直连。

原项目许可证全文：

MIT License

Copyright (c) 2026 Leon Liu (liustack)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
