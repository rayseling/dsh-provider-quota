# 0006 · 那份教人别信绿色的文件，自己带了一个不存在的类

<!-- gate-exempt: doc-symbols 下面两行逐字引用旧版 AGENTS.md，那句话里的类名正是本文的主题，必须保持原样 -->
**症状**：`AGENTS.md` 第 1 条坑里写着「`validate` 钩子被 `SettingsRuntime.register`
在解析这份设置时就调用了」。**harness 里没有 SettingsRuntime 这个类。**
`grep -rn --include="*.ts" SettingsRuntime packages/ vendor/` 命中 0 次。
真名是 `SettingsProvider`（`packages/settings/settings/src/index.ts`）。

机制描述完全正确——`register()` 确实在解析时调用 `validate`，
被逐字引用的那行 `resolved: deepFreeze(this.resolve(..., validate))` 也确实在那个文件里。
**只有名字是凭空造的。**

## 为什么每层防线都没拦住

- **周围全对**：路径对、行为对、引用的代码对。一处准确叙述里的一个假名字，
  比一整段胡说更难被发现，因为读的人会被正确的部分说服。
- **没人会去 grep**：这份文件是给 agent 看的说明，读它的人（和 agent）默认它是事实。
  下一个人真去 grep SettingsRuntime 的时候，只会得到 0 行结果和一次困惑。
- **文档不进测试**：仓库里当时没有任何检查看过文档一眼。
- **同类的第二起**：后来发现 `/v1/models` 也是编的，见
  [0004](0004-listmodels-narrows-every-catalog-reader.md)——那一次走到了用户界面上。

## 规则

文档里带反引号的符号名是一句「这是真的」的断言。不确定就别加反引号——
去掉反引号它就是散文，加上它就要经得起 grep。

## 守住它的门

`doc-symbols`：文档里 `Name.member` 的**大写头**和 `name()`，
必须在本仓库 `src/**` 或 harness 的 `packages/**` 里以完整单词出现。
本地那半边扫的是**剥掉注释和字符串之后**的代码——
否则往注释里写一句「历史上这里叫 SettingsRuntime」就能把这道门骗过去。

**它证明不了**这个符号周围的描述是准的。它只保证名字是真的。
够不到 harness 检出时（没有 `DSH_HARNESS_ROOT`、也没有兄弟目录）这道门**报红而不是报绿**：
查不了就说查不了，不装作查过。
