# 0005 · 拼 URL 时，版本段在哪一边

**症状**：额度显示变成「额度暂不可用」，模型请求一切正常。

**原因**：`OPENCODE_GO_BASE_URL` 是 **base**，不是完整 URL——`fetchOpencodeUsage`
会给它接 `/usage`。同一个接法也作用在从路由设置里读来的 `baseURL` 上，
所以两者必须在「`/v1` 归谁」上达成一致。当前常量带 `/v1`。

## 目录本身就不齐

装着的 pi-ai 目录**按 wire 形状分组**给 `baseUrl`：

| 形状 | 数量 | baseUrl |
|---|---|---|
| `openai-completions` | 12 | `https://opencode.ai/zen/go/v1` |
| `openai-responses` | 1 | `https://opencode.ai/zen/go/v1` |
| `anthropic-messages` | 3（`minimax-m3`、`qwen3.7-max`、`qwen3.7-plus`） | `https://opencode.ai/zen/go` |

最后那三个不带 `/v1`，因为 Anthropic 那套 SDK 自己会补 `/v1/messages`。
额度读取用的是设置里的 `baseURL` 或那个常量，**不是**模型自己的 `baseUrl`，
所以今天不会因此读错；但如果哪天改成「跟着当前模型的 `baseUrl` 走」，
那三个模型会把请求打到 `.../zen/go/usage`。

**别把这句写成「每个 opencode-go 模型都是 `/v1`」**——那是一句过度概括，
而且它在这份文件里躺过一段时间。

## 为什么每层防线都没拦住

- **测试在断言自己的输入**：`test/usage.test.js` 当时把字符串
  `'https://opencode.ai/zen/go/v1'` 当参数喂进 `fetchOpencodeUsage`，
  再断言请求的 URL 里有这个字符串。**真正的常量从没被喂进拼接它的那个函数。**
  实测：把 `src/usage.js` 里常量末尾的 `/v1` 删掉，整套 191 条测试全绿。
- **两处都对才对**：常量和设置里的 `baseURL` 各自看都合理，
  错的是它们在版本段上的**约定不一致**，而没有任何一处代码表达这个约定。

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表**——那一行是每次开工都会读到的版本。
下面是它装不下的边界条件。

常量是 base，后缀由 fetch 函数补。改任一边之前先确认另一边。
**不要为了让常量出现在断言里而把常量当输入喂进去。**

## 守住它的门

没有门——这条也是行为性的。守住它的是 `test/usage.test.js` 里
「shipped bases compose into the endpoints they are meant to reach」那一组：
import 真实的 `OPENCODE_GO_BASE_URL` / `DEEPSEEK_PUBLIC_BASE_URL`，
喂给拼接它们的函数，断言捕获到的 URL 逐字等于
`https://opencode.ai/zen/go/v1/usage` 和 `https://api.deepseek.com/user/balance`。
删掉常量里的 `/v1`，它变红。

Codex 的 `wham/usage` 和 OpenCode 的 `/usage` 都是未公开接口，
上游改动时对应显示会变成「额度暂不可用」，不影响模型请求。
