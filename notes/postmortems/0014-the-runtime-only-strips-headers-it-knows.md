# 0014 · 跨源重定向会替你摘掉 Authorization，不会替你摘掉 x-api-key

**症状**：没有用户撞出来，是 0.6.0 审计里唯一一条我一开始想压低定级、
后来发现值得留档的——不是因为它多危险，而是因为**它的直觉是反的**。

OpenCode 的额度读取同时带两个头：`Authorization: Bearer <key>` 和
`x-api-key: <key>`，同一把 key，两种写法（网关两个都认）。
上游回一个 302 指向别的 origin，默认的 `redirect: 'follow'` 跟过去。
两台本地服务器跑的 PoC，第二个 origin 实际收到：

```json
[{"who":"origin","auth":"Bearer sk_SECRET","xApiKey":"sk_SECRET"},
 {"who":"elsewhere","xApiKey":"sk_SECRET"}]
```

`Authorization` 没了——运行时按 fetch 规范在跨源重定向时把它摘掉了。
`x-api-key` 原样送达。DeepSeek 那条只带 `Authorization`，所以**完全不受影响**；
同一份代码里的两个读取，一个漏一个不漏，区别只在多写了一个自定义头。

## 为什么每层防线都没拦住

- **直觉**：「fetch 会保护凭据头」这个印象是**对了一半**才最坏。
  它保护的是它**认识**的那几个（`Authorization`、Cookie、`Proxy-*`），
  规范里写死的一张名单。自定义头不在名单上，它没有办法知道
  `x-api-key` 里装的是凭据——那就是一个普通的字符串头。
- **测试**：`test/usage.test.js` 里有一条专门断言这两个头都发对了，
  用的是注入的假 `fetch`。假 `fetch` 不会重定向，**重定向语义是运行时的，
  不是我们的**——注入替身把被测的那一层整个换掉了。
- **门**：没有门看 fetch 的 `redirect` 选项，也不该有。
- **威胁模型**：能触发它的只有「已经握着这把 key 的那个 origin」
  （或者明文 http 下已经能看到 key 的 MITM）。所以每次想起它都会得出
  「不算紧急」，然后不了了之。而修它是一行。
- **相邻的自相矛盾**：紧挨着这两个头下面就是伪装成 Chrome 的
  `User-Agent`，注释写着「网关会拒绝可识别的 CLI agent」。
  一份既要伪装成浏览器、又把凭据交给任意重定向的请求头，
  两个决定各自都有道理，放在一起就没有。

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表。**这里补两条边界：

1. **运行时只摘它认识的头。** 凭据装在自定义头里，跨源保护就归你自己做。
2. **带凭据的请求默认不跟重定向。** 这里三个 endpoint 都是「操作者配的
   base + 固定后缀」，重定向要么是配错了、要么是有人想把凭据挪走，
   两种情况都该失败。要跟随，就手动跟并校验同源。

## 守住它的东西

`test/usage.test.js` 的
`a redirect off the configured origin fails the read instead of replaying the key there`。
它起**两台真的 `node:http` 服务器**、用**真的 `fetch`**——因为要证明的性质
是运行时的，不是我们的；断言我们自己传了 `redirect: 'error'`
只能证明这个选项拼写正确。断言的是第二个 origin 的收件箱是空的。

塞回原 bug 验证过：去掉三处 `redirect: REDIRECT_POLICY`，测试红在
`Missing expected rejection`。

**它证明不了**：只跑了 302。301/307/308 和 Location 里的相对地址没覆盖，
`redirect: 'error'` 对它们一视同仁，但这是从规范推出来的，不是测出来的。
另外 `httpBase` 仍然接受 `http://`——明文配置下 key 在线上裸奔，
比重定向早一步，这条没管（本地网关是合法用法，不能一刀切禁）。
