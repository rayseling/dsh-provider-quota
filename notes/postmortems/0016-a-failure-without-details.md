# 0016 · 失败少一个字段，每个原因都成了「没能读取额度」

**症状**：没有用户报过。2026-10-10 改走 `fetch.register` 时才发现：从额度 RPC 诞生那天
（9bbf651，2026-08-25）起，主机判定的每一种失败，登录记录缺失、登录失效、限流、主机侧超时，
到胶囊上都是同一句「没能读取额度，请稍后重试。」。面板让人重试，而该做的是重写凭据记录，
重试改变不了它。

**原因**：Connection 一元 RPC 的失败是 `{code, message, details}`。浏览器端的调用方
`createWebConnectionRpc()` 解析回答时要求 `details` 是一个对象，缺了就抛
`connection: invalid server-response failure`。这条检查来自宿主提交 dcddaa1a6e（2026-08-22），
本插件支持的最低版本 0.1.2-alpha.1 已经包含。插件的 Handler 从第一天起只回 `code` 和 `message`；
宿主侧 `rpc.handle` 的包装原样转发，不补字段。浏览器端一抛，`src/client.js` 的 `catch` 把任何异常
都记成 `unavailable`，`quotaFailureText` 对它给兜底文案。

## 为什么每层防线都没拦住

- **host 测试**：先是直接读 Handler 的返回值，后来自己拼请求、自己 `response.json()`。
  两种读法看到的都是正确的码，因为它们读的是本插件**以为**的信封，不是浏览器**接受**的那一份。
- **client 测试**：假的 `connection.rpc.call` 直接交出 `{ok: false, error: {code: 'auth'}}`，
  绕过了解析器。它证明「拿到 auth 会说登录失效」，而真实的调用方根本交不出这个对象。
- **`remote-codes` 门**：核对的是码，`quotaFailureText` 分支的每个码都有人铸造。码对、信封错，它看不见。
- **线上验证**：每次真开 `dsh web` 看的都是成功路径，Codex 的窗口、DeepSeek 的余额。
- **文案**：兜底说「请稍后重试」，对一次网络抖动它是对的，所以出现时没人觉得不对劲。
  一句通用的失败文案，是所有静默失败最好的掩护。

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表。**边界：

1. **跨进程的线格式，用对面的真解析器读。** 自己拼请求、自己读 JSON 的测试，只证明两端都同意本插件的理解。
2. **失败也是回答。** 只在成功路径上验证过的协议，失败码那一半等于没验证。

## 守住它的门

`test/host.test.js` 把路由交给宿主的 `createWebConnectionRpc()` 去读，每一个回答都过浏览器的解析器。
它在宿主的 `packages/client/connection/src/client/rpc.ts`，经那个包的 `./src/*` 导出引入：页面里
`connection.rpc.call` 跑的就是它，只是发布出去的那份是页面加载器脚本，Node 引不了。新增一条用上游 401 得到确定的 `auth`，
因为凭据缺失时插件会去读启动环境，结果取决于机器。

塞回原 bug 验证过：把 `src/usage.js` 里失败结果的 `details: {}` 全部去掉，host 测试 3 条红在
`connection: invalid server-response failure`。

**它证明不了**：浏览器拿到正确的码以后，面板是否显示对应文案。那一半在 `test/client.test.js`（假 React），
真实渲染只能人去看 `dsh web`。host 测试只在本地跑：CI 没有 harness，这份 suite 在那里按 peer 缺失 skip。
