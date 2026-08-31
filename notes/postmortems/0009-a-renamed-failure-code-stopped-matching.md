# 0009 · 宿主把失败码改了名，卡片没报错，只是换了句话说

**症状**：真的发生了，跟着 dsh 0.1.2-alpha.2 一起进的仓库，两个 commit
（[6498601](../../README.md)、f680e42）都没看见。设置卡片保存失败时，
本该弹「连接断了，请重试」的地方开始弹一句英文：
`client api: settings/mutate failed: transport failure for /api: HTTP 502`；
而版本冲突——那条本来有专门中文文案、告诉用户「有人在你之前改过」的分支——
也退化成宿主原样的英文句子。保存成功的路径一切正常，`npm test` 295 条全绿。

**原因**：alpha.2 的 `refactor(api): converge the Remote failure vocabulary`
把所有 Remote 失败码统一改成了 `<域>/<码>`：

| 之前 | alpha.2 |
|---|---|
| `internal` | `gateway/internal` |
| `settings-conflict` | `settings/conflict` |
| `settings-rejected` | `settings/rejected` |

`src/client.js` 里那三行判断留在旧拼写上。**比较的两边都是字符串**，
所以改名不抛异常、不报类型错、不少一个属性——它只是从此再也匹配不上，
每一次都落到旁边那个「什么都不是」的兜底分支，把宿主的英文原样渲染出去。

同一次升级里，只有那两个被删掉的 `dsh-settings` 导出会在 import 时抛错，
所以迁移时**顺着抛错的地方查**是查得到的；这一条不抛错，就查不到。

## 为什么每层防线都没拦住

- **import**：`ctx.remote.settings.mutate` 是生成出来的 Remote 方法，
  名字没变，签名没变。没有任何 import 会失败。
- **测试**：`test/client.test.js` 里恰好有三条测试专门覆盖这三个分支，
  升级后依然全绿——因为它们**把宿主的码手抄成了桩里的字面量**：
  `{ ok: false, error: { code: 'settings-conflict', … } }`。
  桩和被测代码一起停在旧词汇上，两边继续互相同意，而宿主已经走了。
  这正是 AGENTS.md「别把常量当输入喂进去再断言它出现」那一条，
  只不过这次常量的主人在**另一个仓库**里。
- **门**：`doc-symbols` 只判文档里的符号名，`deps` 只判 import 的包名，
  没有一道门看源码里的**字符串**是不是宿主还认的东西。
- **人**：`git diff` 看不出问题——那三行一个字符都没改。

四层都健康，而用户看到的是一句他读不懂的英文。

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表。**这里只补两条边界：

1. 跨仓库的词汇（失败码、事件名、channel 名）是**宿主的**，不是我们的。
   我们能引用它，不能替它做主，也不能假设它不会改名。
2. 桩里手抄一个别人拥有的常量，等于把「两边是否一致」这件事从测试里删掉。
   桩照样要写——真跑一遍宿主太贵——但**一致性要由别的东西来证**。

## 守住它的门

`remote-codes`（在 `scripts/check.mjs` 里，机制写在 collector 头注释）。
它把 `src/client.js` 里每一个 `.code === '…'` 的字面量拿去 harness 检出里
解析——每个包各自 declaration-merge 进 `RemoteErrorDetailsMap` 的那些键——
解析不到就报红。它跟 `doc-refs` / `doc-symbols` 一样够不到 harness 就拒绝报绿，
所以 CI 里不跑，留本地。

塞回原 bug 验证过：把两行改回 `'internal'` / `'settings-conflict'`，
门报两条违规并指名行号；改回来就绿。

**它证明不了**的，头注释里写了：码存在不等于这个 endpoint 会发它；
`var c = error.code; c === '…'` 这种写法照样绕得过去。
