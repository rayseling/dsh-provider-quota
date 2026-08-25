# 0008 · 一个漏掉的 `*/` 吃掉了一个 export，而为这类错建的门是绿的

**症状**：`refactor: name the OpenCode base…` 那个 commit 提交后验证，
`node --test` 报 **134 条 / 1 失败**（基线 172）。报错是
`SyntaxError: The requested module '../src/usage.js' does not provide an export named 'OPENCODE_GO_BASE_URL'`。

**原因**：改那段 docstring 时漏了收尾的 `*/`。于是：

```js
/**
 * ……docstring 正文……
 * not exist.                        ← 这里本该有 */
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'   ← 被吞
```

注释**没有**一路吞到文件尾——它吞到**下一个 JSDoc 的 `*/`** 就闭合了，
中间的 `export const` 正好在那一段里。文件语法完全合法，`node --check` 通过。

## 为什么每层防线都没拦住

- **`scanProblems` 那道门是绿的。** 它就是为这一类建的，但只检测「`/*` 到文件尾都没闭合」。
  一个有第二个 JSDoc 块的文件**永远走不到那个分支**——而这个仓库每个源文件都有很多个。
  门覆盖的是这一类的一个子集，而子集边界没写在任何地方。
- **类型/语法**：注释是合法语法，被吞掉的代码也是合法注释内容。没有任何东西是「错」的。
- **测试抓到了，但纯属碰巧**：只因为 `test/usage.test.js` 恰好 import 了那个符号。
  一个只在模块内部用、不被 import 的 export 被吃掉，测试会全绿。
- **我跑的是 `node --test`，不是 `npm test`。** 当时正在切 commit，工作树的 `package.json`
  已经指向还没跟踪的 `scripts/check.mjs`，所以「唯一算数的那个命令」暂时用不了。
  **「临时状态下门跑不起来」本身就是一个风险窗口**，而那正是改动最密集的时候。

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表。**这里只补边界：

修一道门的时候，先问「这一类还有哪些写法」，而不是「怎么让这个样本变红」——
这条在 [`what-a-gate-must-prove`](../implemented/2026-08-25-what-a-gate-must-prove.md)
里已经是决定，本文是它第三次被证实。

## 守住它的门

`service-reads` 和 `deps` 都会调 `scanProblems`，现在它有两条判据：

1. `/*` 到文件尾都没闭合（原有）；
2. **注释块里出现顶格的 `export` / `import`**（本次新增）——几乎必然是漏了 `*/`，
   因为 JSDoc 正文里不会顶格写这两个词。

`test/check.test.js` 里配了两条证明：一条合成样本（三个 docstring、中间那个不闭合，
逐字断言违规数组）、一条反向样本（闭合之后零违规）。另外拿真实的 `src/usage.js`
精确复现过这次事故，确认变红、干净文件不误报。

**它证明不了**注释里被吞掉的是不是别的东西（一句 `const`、一个函数声明都不会触发），
也拦不住把 `*/` 漏在一个后面没有任何 JSDoc 的文件末尾——那种情况回落到第 1 条。
