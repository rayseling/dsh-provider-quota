# 0012 · 到点了只是不等了，请求还在跑——顺手把依赖唯一的取消也拆了

**症状**：Codex 的 OAuth 刷新超时之后，事务失败、文档锁释放、调用方拿到
TIMEOUT，一切看起来都按设计走。但那个刷新请求**还在飞**。它可能在几十秒
后成功，在 OpenAI 那边把 grant 轮换掉，而本地那条事务早就失败了、
轮换后的 refresh token 没有人落盘。下一次读取拿着已经作废的旧 token 去刷新，
用户被登出，要重新登录一次——而所有日志显示的都是一次普通超时。

**原因**：`src/token.js` 的 `boundedRefreshProvider` 当时是这么包的：

```js
refresh: credential => withDeadline(
  oauth.refresh(credential),          // ← 只传了 credential
  REFRESH_TIMEOUT_MS,
  () => new Error(`${REFRESH_TIMEOUT_MARKER} within …`),
),
```

`withDeadline` 是一个 `Promise.race`：到点了 reject，**底下那个 promise
继续跑**。它本来不必如此——pi-ai 0.84.2 会把一个 signal 递进
`refresh(credential, signal)`，而这个箭头函数只接一个参数，把它丢了。
丢掉之后，`refreshAccessToken` 里的 `fetch(TOKEN_URL, { signal: undefined })`
**没有任何上限**。

而当时那段注释是这么解释这个选择的：

> pi-ai's own ceiling equals REFRESH_TIMEOUT_MS, so it would fire at the same
> moment under a message this module cannot recognise

这句话**一半对一半错**，错的那一半正是要命的。对的部分：pi-ai 确实有
一个 15 秒的 ceiling，就在 `node_modules/@earendil-works/pi-ai/dist/auth/resolve.js` 里
`AbortSignal.any([signal, AbortSignal.timeout(15_000)])`；两个 deadline
同时到期，谁先跳决定失败码是 TIMEOUT 还是 TRANSPORT，这个顾虑是真的。
错的部分：那个 ceiling 是**通过这个 signal 生效的**。把 signal 丢掉，
pi-ai 的 ceiling 就跟着一起没了。注释以为自己在「放弃一个冗余的取消，
换取一个可识别的错误措辞」，实际上是在「放弃唯一的取消」。

两个性质本来不冲突，只是要自己拿一个 controller：

```js
refresh: (credential, signal) => {
  const deadline = new AbortController()
  const bounded = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal])
  return withDeadline(oauth.refresh(credential, bounded), timeoutMs, () => {
    deadline.abort()
    return new Error(`${REFRESH_TIMEOUT_MARKER} within ${timeoutMs}ms`)
  })
}
```

顺带把 `REFRESH_TIMEOUT_MS` 从 15s 降到 14s。等值的时候，那场竞争是靠
「谁的定时器先被构造」决出的，而 pi-ai 的构造在前——也就是说原本想保住的
TIMEOUT 措辞，本来就随时可能变成 TRANSPORT。

## 为什么每层防线都没拦住

- **签名**：JS 允许少接参数。`credential => …` 和 `(credential, signal) => …`
  在调用点毫无区别，没有 lint、没有类型错、没有运行时警告。
  丢一个回调参数是**静默**的。
- **注释**：又是它。这段注释不只是过时，它是一段**推理**——而推理里有一步
  是错的（把「有 ceiling」当成「ceiling 与 signal 无关」）。
  写得越详细越有说服力，就越没人会去核对它引用的那个上游文件。
- **测试**：`test/credentials.test.js` 覆盖了刷新的成功、400、5xx、408、429、
  transport、并发共享，唯独没有「到点了会怎样」——因为真等一次要 15 秒，
  而整份 suite 跑完不到 1 秒。**贵到不敢测的分支，就是没测的分支。**
- **门**：没有门能判断一个 promise 被 race 掉之后底下的工作是否被取消。
- **后果的形状**：它的代价不落在超时那一刻，而落在**下一次**读取——
  表现是「登录失效」，看起来像 token 过期、像上游抽风、像任何别的东西，
  唯独不像是十分钟前那次超时干的。

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表。**这里补三条边界：

1. **`Promise.race` 加超时只停止「等待」，不停止「工作」。** 要停止工作
   得有取消通道。这两件事必须分别问一遍，别用一个 race 假装两个都做了。
2. **依赖递进来的 signal 是接口的一部分。** 包装一个回调时少接一个参数，
   等于把它悄悄拆掉；包装器要么原样透传，要么在注释里说清为什么不。
3. **超时值要能注入。** 不是为了给部署调，是为了让测试**买得起**这个分支。
   `src/usage.js` 里每个 fetch 都收 `timeoutMs` 就是这个道理，
   `createOpenAICodexAccessResolver` 现在也收 `refreshTimeoutMs`。

## 守住它的东西

`test/credentials.test.js` 的
`a refresh that outlives its deadline is cancelled, not left running`。
它把 deadline 注成 30ms，`fetch` 桩成一个**只有 abort 能结束**的 promise，
然后同时断言两件事：请求真的被取消了、失败码是 TIMEOUT。

塞回原 bug 验证过：把 `refresh` 改回只接 `credential`，测试红在
`the token request must be ended, not abandoned to finish later`。

**它证明不了**：取消 socket 并不能撤销上游已经处理完的轮换。
如果 OpenAI 那边已经把 token 换了，客户端做什么都晚了——这个修复把窗口
从「无上限」收到「deadline 以内」，不是把它关掉。真正关掉它需要
「晚到的成功也要落盘」，那是另一个设计，本次没做。
