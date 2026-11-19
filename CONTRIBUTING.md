# 参与贡献

欢迎提 issue 和 PR。

## 提 issue

- Bug：用「Bug 报告」模板；市场的问题请附上右上角「导出日志」的内容
- 想要的功能：用「功能建议」模板
- 想让官方仓库收录一个插件：用「插件收录」模板

## 提 PR

1. `node scripts/pack.mjs --check` 和 `node --test test/*.test.mjs` 要全部通过（没有任何依赖，Node ≥ 20 就行）
2. 改了某个插件：升它 `manifest.json` 里的 `version`，运行 `node scripts/pack.mjs`，把 `packages/` 和 `catalog/` 的变化一起提交
3. 新插件：复制一个现有的插件目录，参考 README 里的「写一个新插件」；权限只申请用得到的
4. 新行为要有测试；界面改动用 `node scripts/dev-ui.mjs <插件 id>` 在浏览器里看过

## 约定

- 源码文件用 LF 换行（`.gitattributes` 已固定），安装包按字节算 sha256，不要手改 `.dbxp` 和 `catalog/index.json`
- 沙箱里没有 `alert` / `confirm` / `prompt`
- 不要引入运行时依赖；后台程序只用 Node 自带模块
