# 0001 · settings 的 `validate` 在每次「读取」时也跑

**症状**：某次 `dsh plugin update` 之后，用户在卡片里设的上下文长度悄悄变回默认值。
界面没有任何提示，只有两行日志。

**原因**：`installSettingsSection` 的 `validate` 钩子，被 `SettingsProvider.register`
在**解析这份设置时**就调用了（`packages/settings/settings/src/index.ts` 里
`resolved: deepFreeze(this.resolve(..., validate))`），也就是每次启动都会跑一遍——不只是写入时。

那次升级之后，pi-ai 的目录里少了一个模型 id。`validate` 里那条「名单必须都在目录里」的检查抛了异常，
于是**整份 section 被拒绝**——不只是出问题的那个字段。本插件 `src/index.js` 的 `catch` 接住它、
退回组合配置，于是同一份设置里**毫不相干的 `modelOverrides` 也一起没了**。

## 为什么每层防线都没拦住

- **测试**：当时所有 settings 测试都走「已启动的 context 上 `update()`」这条**写**路径。
  事故发生在**读**路径——启动时解析——那一趟从来没有测试走过。
- **类型**：`validate` 的签名不区分「写入前校验」和「解析时校验」，两者是同一个回调。
  从类型上看不出这个钩子会在启动时跑。
- **人工评审**：改动本身看起来完全正确——「名单里的模型必须存在」是一条讲得通的规则。
  错的不是这条规则，是它所在的位置。
- **报错**：没有报错。异常被 `catch` 吃掉，换成一行 `logger.error`，而设置界面照常渲染，
  只是值变回了默认。

## 规则

`validate` 里**不要放依赖外部世界的检查**。模型目录会因为 pi-ai 升级而改名/下架，环境变量会变，
文件会消失——这些都不是用户的错，却会让整份设置在下次启动时蒸发。

- 依赖外部状态的（例：`enabledModels` 是否还在目录里）→ **读取时过滤**，见 `selectableModelIds()`
- 只依赖自身形状的（非空、不重复）→ 可以放 `validate`，见 `assertEnabledModelShape()`
- 组合配置（`cordis.patch.yml`）里的值可以严格校验并大声报错：它随插件版本钉死，写错是部署方的 bug

## 守住它的门

没有门——这条是**行为性**的，脚本看不见。守住它的是 `test/settings.test.js` 里那条
「a stored allowlist the catalog outgrew survives the STARTUP read, sizing intact」：
先写 `settings.yaml`（漂移的 id 旁边放一个好窗口），**再**启动，断言窗口还在。
把 catalog 检查挪回 `validate` 会让它连同另外两条一起变红。
