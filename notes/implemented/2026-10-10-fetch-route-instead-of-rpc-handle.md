# 0.7.0：额度路由改走 Connection 的 `fetch.register`，不再要求宿主打补丁

## 问题

自 dsh 0.1.5-alpha.1 起，Connection 的 `rpc.handle` 在 `rpc-host.ts` 的 `register()` 里用属性访问器读
`owner.webServer`。`owner` 是调用方的 ctx，但带着指向 Connection 自身 ctx 的 shadow，属性访问器从
Connection 的 fiber 出发找服务——而 Connection 自 0.1.5-alpha.1 起不再 `inject` `webServer`（为了让 Electron
宿主在没有 HTTP 载体时也能提供 Connection）。Web 组合里 `webServer` 是兄弟 fiber 提供的，从 Connection 的
fiber 够不到，`rpc.handle` 在 channel 落地前就抛 `cannot get property "webServer" without inject`。调用方在
自己的 `inject` 里加 `webServer` 没有用：查找不从调用方的 fiber 出发。

抛错发生在 `ctx.inject(['connection'], …)` 建出的子 fiber 里：子 fiber FAILED，条目仍 ACTIVE，启动审计
不报，客户端照常加载，`POST /dsh-provider-quota/usage` 永远打到静态兜底的 405，胶囊读「额度 --」。宿主自己
的插件只用 `rpc.intercept`（不碰载体），所以上游测试从未见过这条路；到 0.2.1-alpha.2 仍未修，Discussions 里
十几个同症状帖子零回复。

此前的解法是在部署的宿主上打补丁（`register()` 改成 `owner.get('webServer')` + `owner.inject(['webServer'])`
跟随载体），六轮外审修到 2026-10-10。每次同步上游都要 rebase 这块，而且它修的是宿主的 bug，不是本插件的。

## 决定

改用 Connection 的 **`fetch.register`**：在它共享的 `/api` 通道上挂一条精确路由
`POST /api/dsh-provider-quota.usage`（`src/rpc-route.js`）。这个入口 0.1.2-alpha.1 就有，从不读 `webServer`——它只往
Connection 的 `fetchRoutes` Map 写一条；真正的 HTTP 路由是 Connection 自己用 `ctx.inject(['webServer'])` 挂的 `/api`
前缀路由，按精确 pathname + method 派发过来，派发前先过 `admit()`（Host/Origin 围栏，再浏览器会话认证）、
`connection/request` waterfall 和请求体上限。载体晚到或重启，`/api` 跟着重新挂上，这条路由自然在。上游自己的
会话日志导出、文件上传、媒体引用和交付物都这么挂。

线格式不变：仍是 Connection 一元 RPC 的 `client-request` / `server-response` 信封，所以浏览器端继续用
`connection.rpc.call`，只改 channel（`/api`）与 method（`dsh-provider-quota.usage`——`/api` 是所有插件共用的命名
空间，方法名得带包名）。`rpc.handle` 替我们做的内容类型、JSON、信封、方法匹配检查，在 `src/rpc-route.js` 里按
上游的状态码复现（415 / 400 / `gateway/bad-request` / 500）。

顺带修了一个被掩盖的 bug：Handler 的失败结果从前没有 `details`，而 Connection 客户端把缺 `details` 的失败当成
非法信封抛 TypeError，胶囊因此永远显示「不可用」而不是真实原因（`auth`、`signed-out`…）。现在每个失败码都带
`details: {}`。经过见 [postmortem 0016](../postmortems/0016-a-failure-without-details.md)。

## 考虑过的方案

**继续打宿主补丁。** 能用，但维护的是别人的 bug；每次 rebase 都要动，六轮外审才稳定。放弃。

**在调用方的嵌套 `inject` 里声明 `['connection', 'webServer']`。** 只在打了补丁（`owner.get` 全局读）的宿主上
有效；无补丁时查找仍从 Connection 的 fiber 出发，声明无用。放弃。

**`rpc.intercept`。** 不碰载体，但每个 `/api` 只允许一个拦截器，上游已经占用。放弃。

**客户端直接 `fetch('api/…')` 收裸 JSON。** 更短，但丢掉 `rpc.call` 的 rpcId 校验和信封解析，而且宿主侧还是要
自己写路由。保留信封成本相同、收益更大。放弃。

## 后果

- URL 从 `/dsh-provider-quota/usage` 变为 `/api/dsh-provider-quota.usage`；只有本插件的胶囊调用，无兼容负担。
- 信封检查是上游逻辑的复制（`rpcFetchHandler` 未导出）。上游改信封格式时两边要一起动。`test/rpc-route.test.js`
  只钉住本插件这一侧的格式；`test/host.test.js` 用宿主真正的浏览器调用方 `createWebConnectionRpc()` 读每一个
  回答，客户端那一侧一改，host 测试就红。
- 「不带 provider 就按旧形状回答」的分支随之删掉：会那样发请求的旧页面打的是旧 URL，到不了这条路由。
