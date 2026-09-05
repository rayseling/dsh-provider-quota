# 0011 · 一份状态服务两个账户——同一个错误，在两层各犯了一次

**症状**：会话切到第二个 OpenCode 账户，头部胶囊仍然显示第一个账户的
`5h 11%`。不是缓存过期，是**根本没去读**——宿主全程没被问过第二个账户。
另一半在宿主：一次读取还在飞的时候把 API key 换掉，新 key 的调用者拿到的
是旧 key 那次请求的结果，上游只被打了**一次**。

两处都没有异常、没有失败码。屏幕上是一个格式完全正确的百分比。

**原因**：同一个错误的两个版本——**一份状态被两个身份共用**。

浏览器侧，`src/client.js` 的状态槽按「画哪种面板」建：

```js
'opencode-go': 'opencode', 'opencode-go-extra': 'opencode',
'deepseek': 'deepseek', 'deepseek-official': 'deepseek',
```

胶囊那个 effect 的条件是 `if (routeState.state !== 'idle') return`。
第一个账户读完，共享槽变成 `ready`；切到第二个账户时 effect 一看不是 `idle`，
什么都不做，于是屏幕上留着上一个账户的数字。而这段代码的注释当时写的是
「one slot per family, so switching models can never show one account's
numbers under another provider」——**注释描述的正是它做不到的那件事**。

宿主侧，`src/usage.js` 的 `createKeyedUsageCache` 在身份变化时清了缓存：

```js
if (nextIdentity !== identity) {
  identity = nextIdentity; generation++
  cached = undefined; cachedAt = 0; lastAttemptAt = 0
}          // ← inflight 没动
var joined = inflight
if (joined !== undefined && …) return observeUsageRequest(joined, signal)
```

`cached` 和 `inflight` 是**同一件事的两种状态**：一次读取的结果，和一次
正在进行的读取。换身份时只重置了前者，紧接着几行的合流逻辑就把后者
交给了新身份。`generation` 守卫只拦住了「把旧结果**写进**缓存」，
没拦住「把旧结果**返回**给调用者」。

## 为什么每层防线都没拦住

- **测试（浏览器）**：`test/client.test.js` 的假 React 把
  `useEffect: () => {}` 桩成空函数。胶囊唯一的那个判断——「现在屏幕上这个
  provider 还需不需要读」——**从来没有被执行过**。整份测试跑得飞快、全绿，
  而被测的那行代码在测试里根本不存在。这是本条最值钱的一课：
  **一个把 hook 桩成 no-op 的替身，等于把被测对象的判断删掉再断言它没错。**
- **测试（宿主）**：`API-key routes keep one cache per provider` 那条测的是
  两个**不同 provider** 之间不串味，用的是顺序调用。在途竞争需要
  「一次读取悬停时换 key」这种编排，而顺序调用永远造不出这个窗口。
- **门**：没有门能看出「两个 key 映射到同一个槽」是不是有意的——
  它在语法和类型上都合法，而且看起来还挺整洁。
- **注释**：注释不但没拦住，还**帮了倒忙**。两处的注释都自信地陈述了
  正确的性质（"can never show one account's numbers under another provider"），
  读代码的人读到它就不会再去验证。断言性的注释在错的时候，
  比没有注释更糟。
- **人**：按「画哪种面板」分组，看起来是把重复代码收敛了一次，
  是个会被夸的改动。

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表。**这里补三条边界：

1. **状态槽的键必须是身份，不是长相。** 两个账户画同一种面板，
   不构成它们可以共用一份状态。今天守着这条的不是什么假想路由，
   是 `openai-codex` 和 `opencode-go`——都画窗口面板，都活着，
   而且 Codex 在挂载时就读，所以共享槽在另一条路由第一次上屏之前
   就已经是 `ready` 了。
2. **换身份时，要清的是「所有表示同一件事的状态」。** 结果和在途请求
   是一件事的两个阶段，只清一个，另一个会替你把旧身份的数据递出去。
3. **替身不能把被测的判断桩掉。** `useEffect`、`setTimeout`、`subscribe`
   这类东西桩成空函数，测试还是会绿——绿的是一段没跑过的代码。
   替身要么真跑，要么就承认这块没测。

## 守住它的东西

三条测试，都验过塞回 bug 会红：

- `test/client.test.js` 的
  `switching to another account that draws the same panel reads it, not the first`：
  假 React 现在**收集** effect 由调用方跑。按面板形状建槽时它在**第一条**
  断言就红——`actual: '5h 77%'`，Codex 挂载时读进去的数字出现在
  OpenCode 会话上。
- 同文件的 `two accounts that draw the same panel keep separate numbers`。
- `test/usage.test.js` 的
  `a key rotated mid-flight gets its own read, not the previous key's answer`：
  用一个可控的闸门把第一次读取悬停住再换 key。塞回 bug 报
  `upstreamCalls` 是 1 而不是 2。

**它们证明不了**：`src/client.js` 里真实渲染的那一半仍然只有人能看
（见 AGENTS.md「门盖不到的地方」）。effect 现在会跑了，但跑它的是假 React，
不是浏览器——真实的重渲染时机、依赖数组的行为，还是只有 `dsh web` 能验。
