## 改了什么

<!-- 一两句话：做了什么、为什么 -->

## 涉及的插件

- [ ] github
- [ ] memsearch
- [ ] context-insight
- [ ] billion-context
- [ ] better-sidebar
- [ ] 新插件：
- [ ] 只改了脚本 / 网站 / 文档

## 检查清单

- [ ] `node scripts/pack.mjs --check` 通过
- [ ] `node --test test/*.test.mjs` 通过
- [ ] 改了插件源码：已升 `manifest.json` 的 `version`，并提交了 `packages/` 和 `catalog/`
- [ ] 界面改动：用 `node scripts/dev-ui.mjs <插件 id>` 在浏览器里看过（浅色和 `?dark` 深色）
- [ ] 新增的权限都是用得到的，并在说明里写了原因
- [ ] 新行为有测试

## 权限变化

<!-- 没有就写「无」。新增 host.network / net.connect / fs.* 要说明用途 -->
