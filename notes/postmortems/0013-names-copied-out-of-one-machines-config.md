# 0013 · 从一台机器的 settings.yaml 抄进源码的名字，没有主人

**症状**：`PROVIDER_ROUTES` 里躺着两个路由 id——`opencode-go-extra` 和
`deepseek`——插件为它们准备了状态槽、写了凭据解析分支、在 README 的表格里
列了它们的接口和 key 来源。而它们在**任何地方都不存在**：不在 pi-ai 的
catalog 里，不在 deepseek-harness 整棵树里，不在操作者当前的 `settings.yaml`
里。`opencode-go-extra` 曾经在 `settings.yaml.bak-2026-09-04` 里出现过一次，
第二天就被合并掉了。没有任何东西在那一刻报错，因为**没有任何东西知道
这两个名字曾经指向什么**。

外部审计还拿 `opencode-go-extra` 造了一个 PoC，论证「切换账户会串数据」。
那个 bug 是真的（见 [0011](0011-one-slot-served-two-accounts.md)），
但用来演示它的那条路由是审计自己构造的——**它复现的是一个已经不存在的配置**。

**原因**：`llm-pi-ai` 的配置写得明明白白，就在 `config.ts` 那行注释里：
「the `providers` dict key IS the route」。也就是说 `llm-pi-ai.providers`
底下的 key 是**操作者随手起的名字**，不是任何上游约定。而引入这段代码的
那个 commit（`9bbf651`）的说明里只提了三个 provider，`opencode-go-extra`
是照着当时那台机器的配置顺手加进去的，从来没进过任何设计说明。

分不清的两类名字长得一模一样：

| id | 主人 | 会不会变 |
|---|---|---|
| `openai-codex`、`opencode-go` | pi-ai 的 catalog | 上游改才变 |
| `deepseek-official` | native `llm-deepseek` 的 `const PROVIDER` | 上游改才变 |
| `opencode-go-extra`、`deepseek` | 某台机器的 `settings.yaml` | 那台机器改就变，且不通知任何人 |

同一次审计还翻出四处同源的漂移，都是「把一个主人在别处的事实抄成本地常量」：
`HARNESS_ONLY_GATES` 有三个元素而它的注释说「These two」；`ci.yml` 的头注释
点名了两道排除的门（实际三道），而这段注释本身还在自夸是防漂移的；
`PEER_SKIP_REASON` 的注释点名了 `test/{adapter,bin,settings,store}.test.js`
四个文件——**一个都不存在**；AGENTS.md 写完整检出 237 条，
`scripts/expected.json` 写 186。

## 为什么每层防线都没拦住

- **门**：`identity` 门盯的是包名的几种拼写互相一致，`doc-symbols` 盯的是
  文档里的符号在 harness 里存在。**没有一道门问「这个字符串的主人是谁」**——
  因为这个问题机器答不了：`opencode-go-extra` 和 `opencode-go` 在语法上、
  类型上、命名风格上完全一样。
- **测试**：测试用的是同一批名字。喂 `opencode-go-extra` 进去，插件老老实实
  给它建槽、解析 key、答一个结果——测试于是绿。**测试证明的是
  「这个名字被处理了」，不是「这个名字该存在」。**
- **运行时**：一个没人服务的路由 id 不会报错，它只是永远不会被选中。
  死代码的定义就是没有信号。
- **人**：删一个 provider 的时候不会想到「有没有别的仓库把这个名字抄过去了」。
  抄的那一方也不会留下引用——它是个字符串字面量，不是 import。
- **注释里的数字同理**：写下「These two」的那一刻它是对的，
  加第三个元素的人没有理由去读那段散文。

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表。**这里补两条边界：

1. **写进源码的每一个字面量，都要能回答「主人是谁」。** 主人在上游的
   （catalog 名、常量、失败码），抄进来要说清出处；主人是**某台机器的配置**的，
   根本不该抄——那不是一个事实，是一份快照。
2. **注释里的数字和文件名，是代码的一部分，只是没人编译它。**
   「These two」「四个文件」「237 条」都是可以变红的断言，
   写成「运行时自己打印」或「以 X 为准」就永远不会。裸模式那句
   `Left out: doc-refs, doc-symbols, remote-codes` 是自己算出来打印的，
   所以它一直是对的——而三处照抄它的散文全错了。

## 守住它的东西

两条测试，都验过塞回 bug 会红：

- `test/host.test.js` 的
  `a route id no catalog carries answers none, and costs no credential read`：
  把 `opencode-go-extra`、`deepseek`、`glm-5.3` 一起喂进 RPC，
  断言都答 `none`、**一个凭据都没解析、一个 endpoint 都没碰**。
  把 `opencode-go-extra` 加回 `resolveRoute` 就红。
- `test/client.test.js` 的
  `the chip answers for three fixed route ids and reads nothing for any other`，
  外加一条 `Object.keys(routes)` 的全等断言——加一个名字就得改这一行。

散文那半没有门守，只能靠「别把算得出来的东西抄成散文」这条规则。

**它们证明不了**：三个 id 里没有一个被验证过「上游此刻仍然叫这个名字」。
pi-ai 换掉 catalog 里的 `opencode-go`，或者 native 插件改掉它的 `PROVIDER`
常量，这两条测试照样全绿——它们钉的是「不多不少就这三个」，
不是「这三个是对的」。
