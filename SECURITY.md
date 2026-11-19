# 安全 / Security

## 报告漏洞 / Reporting a vulnerability

请**不要**在公开 issue 里贴漏洞细节。请用 GitHub 的 [Private vulnerability reporting](https://github.com/1316584746/M-Market/security/advisories/new)（仓库 Security 标签页 → Report a vulnerability）私下报告。

Please do **not** put vulnerability details in a public issue. Use GitHub's [private vulnerability reporting](https://github.com/1316584746/M-Market/security/advisories/new) (Security tab → Report a vulnerability).

请附上：影响的插件和版本、复现步骤、你认为的影响范围。这是个人维护的项目，没有固定的响应时限，但会尽快看。

## 范围 / Scope

属于范围：安装包校验被绕过、解压写到插件目录之外、界面沙箱逃逸、令牌或密码被发到非预期的地方、备份 / 日志里泄露密钥。

不属于范围：第三方 DSH 插件本身的问题（请找它的作者）；已在 README 里说明的限制（例如令牌明文存放在插件数据目录里）。

## 已知的设计取舍

- WebDAV 密码、Gist 令牌、GitHub 个人访问令牌明文存放在 `plugin-data/<id>/` 下，沙箱里没有系统钥匙串。请使用最小权限的细粒度令牌。
- GitHub 插件的 AI 写操作工具会真的修改你的仓库。
