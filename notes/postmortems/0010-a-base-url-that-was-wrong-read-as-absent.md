# 0010 · 配错的 baseURL 读起来像没配，于是私有网关的 key 去了公共端点

**症状**：没有用户撞出来，是 0.6.0 的一次外部审计翻出来的——但它一旦触发，
表现是这样的：`llm-deepseek` 的 `baseURL` 写成 `deepseek.internal.example/v1`
（漏掉 `https://`），插件不报错、不警告，把那条私有网关专用的 key 装进
`Authorization` 发去 `https://api.deepseek.com/user/balance`，拿回 200，
胶囊显示一个余额。数字是真的，只不过是**另一个账户**的；而 key 已经出门了。

复现只要两行配置，动态验证过：

```
配置 baseURL="deepseek.internal.example/v1"
实际请求 https://api.deepseek.com/user/balance  Bearer sk-PRIVATE-SECRET
```

**原因**：`src/index.js` 里那三行看起来再普通不过的「取第一个有值的」：

```js
const base = httpBase(configured)
  ?? httpBase(launchEnvironmentOf(ctx).get('DEEPSEEK_BASE_URL')?.value)
  ?? DEEPSEEK_PUBLIC_BASE_URL
```

`httpBase` 对两种输入都返回 `undefined`：**没给字符串**，和**给了一个不是
绝对 http(s) 地址的字符串**。`??` 只认 `undefined`，认不出它是哪一种来的。
于是「没配置」和「配错了」变成同义词，而后者的兜底是把 key 发给第三方。

漏 scheme 恰恰是这个字段最常见的写错法。

最难堪的一点：**同一个文件里，上面三行就是正确写法**。OpenCode 分支把三元
放进 `httpBase(...)` 里——三元选**来源**，`httpBase` 校验选出来的那个，
选不出就抛：

```js
const endpoint = httpBase(isProfile && typeof profile.baseURL === 'string' ? profile.baseURL : OPENCODE_GO_BASE_URL)
if (endpoint === undefined) throw new CodexUsageError('unavailable', …)
```

同样的输入，OpenCode 一个请求都不发，DeepSeek 把 key 发去了公共端点。
而 DeepSeek 分支自己的注释（讲两种 section 形状那段）写的正是这个后果——
「sends a key configured for a private endpoint to the public one」。
文件里既有正确写法，又有对错误后果的明文警告，两个分支还是分了岔。

## 为什么每层防线都没拦住

- **类型**：`configured` 和 `httpBase()` 的返回都是 `string | undefined`。
  两种 `undefined` 在类型上完全一样，没有任何东西能把它们分开。
- **测试**：`test/host.test.js` 有三条专门测 DeepSeek 读哪个 section 的，
  每一条都配了**合法**的 `baseURL`。它们证明的是「配对了会读对」，
  没有一条问「配错了会怎样」。**正确路径的覆盖率不构成对错误路径的覆盖。**
- **门**：没有门看 `??` 链，也不该有——`??` 本身没问题，问题在
  它上游那个函数把两件事映射到了同一个值。
- **相邻的正确写法**：因为两种写法**各自**读起来都正常，
  「同文件里已有对的版本」没能起到提示作用。要发现它得把两个分支并排读，
  而 diff 从来不会把它们并排给你。
- **人**：`?? ?? 默认值` 是全世界最眼熟的三行之一。正因为眼熟，
  没人会停下来问「这个 undefined 有几种来源」。

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表。**这里补两条边界：

1. 「**没配置**」和「**配错了**」在凭据路由的判断里不能落到同一个值。
   合成一个 `undefined` 之后就再也分不开了，而它们该走的路相反：
   一个用默认值，一个必须失败。
2. 校验放在**选完来源之后**，只做一次。三元选来源、校验器把关，
   选不出就抛——不要让校验器兼任「有没有配」的探测器。

## 守住它的东西

`test/host.test.js` 的
`a baseURL the plugin cannot use fails the read; it never becomes the public endpoint`。
它同时喂 `deepseek-official` 和 `opencode-go` 一个漏 scheme 的 base，
**先断言一个请求都没发出去**，再断言失败码——顺序是有意的：
key 去了哪里是发现本身，失败码只是用户怎么知道。

塞回原 bug 验证过：改回 `?? ?? PUBLIC`，测试报
`actual: [ 'https://api.deepseek.com/user/balance' ]`，红得指名道姓。

**它证明不了**：只覆盖「漏 scheme」这一种写错法。一个 `https://` 开头、
主机名却打错的地址仍然是合法配置，key 照发不误——那是操作者自己的 origin，
插件无从判断，也不该判断。

## 复发：指名的凭据引用解析不到（2026-10-10）

同一个错误，换到了 key 上。profile 写了 `apiKeyEnv`，就是操作者在说「这条路由用这把 key」。
它解析不到时，插件曾依次去读 `llm-pi-ai` 为路由存的记录、启动环境、OpenCode CLI 的 `auth.json`，
找到哪把用哪把，发往这条路由配置的端点。宿主自己的模型路由此时直接报 MISSING_CREDENTIAL。
一次外部审计照这个顺序复现：账户 A 的 key 被发往租户 B 的网关。

**为什么没拦住**：host 测试分别覆盖了「指名的引用解析得到」和「什么都没配时读 CLI 的 key」，
没有一条把「指名但缺失」和「旁边另有一把 key」放在一起。两条各自是对的，合起来的那个状态没人测。

**边界**：指名的引用只走 credentials seam，没有这个 seam 时只走启动环境，缺了就失败。
记录和 CLI 的 key 只给没指名引用的路由用，CLI 的 key 只发往默认的 opencode.ai 端点。
守它的是 `test/host.test.js` 的
`a credential reference the route names, resolving to nothing, fails the read instead of borrowing a key`
和 `the OpenCode CLI key only ever goes to OpenCode's own endpoint`，修之前都红在
`upstream.calls` 不为空，里面是那把被借走的 key。另有一条反向的
`a route that names no reference reads the key its adapter stored for that route`，
防止这条规则被「修」成什么都拒绝。
