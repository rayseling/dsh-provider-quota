# dsh-provider-quota

在 DeepSeek Harness 的会话里显示**当前模型所属账户**还剩多少 —— Codex 的 5h/7d、OpenCode Go 的 5h/7d/1m、DeepSeek 余额。只做这一件事。

**0.5.0 起它不再提供模型路由。** ChatGPT 订阅的 `openai-codex` 路由由宿主自带的 `llm-pi-ai` 服务：那个包已经能用 pi-ai 官方的 OAuth catalog provider、能按路由收窄模型列表、能逐模型改目录字段——本插件从前的适配器就是为这三件事存在的。同一个路由 id 只能注册一次，两边同时注册会在启动时报 `DUPLICATE_ADAPTER`。

宿主没有的是这些私有额度接口，所以剩下的就是它们。

| 职责 | 由谁承担 |
|---|---|
| Codex 模型请求、OAuth 刷新、模型目录 | 宿主的 `llm-pi-ai` + `@earendil-works/pi-ai` |
| 凭据存放与跨进程互斥 | 宿主的 credentials seam（`llm-pi-ai/openai-codex` 这条记录） |
| 本插件自己写的 | 把三个上游的额度/余额归一成同一个 union 的 Connection RPC（只出标准化数据，凭据一律留在主机）+ 一张只读的 Settings 卡片和一个会话头部额度胶囊（手写的经典脚本，无打包步骤） |

凭据永远不进浏览器，也不进 `settings.yaml`。额度读取走 Harness Connection 统一的请求检查和浏览器会话认证，不另开 HTTP 路由。

## 安装

需要 **dsh 0.1.2-alpha.1 或更新**：凭据记录（`recordKeyFor`、`modifyRecord`）和 Connection 的浏览器会话认证是这个版本定的；设置 section 的 service API 在 alpha.2 定型，卡片要靠它才能被派发。

```sh
dsh plugin --profile web add file:/path/to/dsh-provider-quota
```

## 配置 Codex 模型（宿主原生）

在 `$DSH_HOME/settings.yaml` 里配 `llm-pi-ai`。`models:` 是**整体替换**：写了它就只通告列出的这些，每条只写 `id` 就继承目录里的其余字段。要改上下文长度，在那条上写 `contextWindow`：

```yaml
llm-pi-ai:
  providers:
    openai-codex:
      models:
        - id: gpt-5.6-luna
        - id: gpt-5.6-sol
          contextWindow: 1000000
        - id: gpt-5.6-terra
```

`gpt-5.6-sol` 的目录值是 272000（OpenAI 为 Codex 客户端调过的保守值，其文档标称 1,050,000）。这个数字只用于本机记账：会话能保留多少历史、什么时候开始压缩。它不会让模型真实的上下文上限变大，而且超出模型原生长度的输入按更高的价格档计费。

`models:` 与 `modelOverrides:` 互斥，二选一。

## 登录

**这一版没有界面能替你跑登录流。** `llm-pi-ai` 注册了 authorization 流，但 0.1.3-alpha.1 里没有任何 Web / CLI / SDK / ACP 表面会发起它。所以目前只能手写凭据记录。

写进 `$DSH_HOME/.credentials.yaml`（文件权限必须 0600，属主之外可读会被拒绝）：

```yaml
version: 1
records:
  llm-pi-ai/openai-codex:
    kind: grant
    payload:
      type: oauth
      access: <access token>
      refresh: <refresh token>
      expires: 1788134407000
      accountId: <ChatGPT account id>
```

`payload` 就是 pi-ai 的 OAuth 凭据对象，可以来自任何一次 pi-ai `openai-codex` 登录——例如本插件 0.5.0 之前的 `dsh plugin --profile web exec dsh-provider-quota login` 写下的 `$DSH_HOME/.openai-codex-auth.json`，那个文件里的 `credential` 对象原样搬过来即可。`expires` 是毫秒时间戳。

**refresh token 用一次就轮换**，所以这份凭据只能存在一处。宿主刷新过一次之后，任何别处的副本（旧的 `.openai-codex-auth.json`、另一台机器上的拷贝）立刻失效。别留副本，也别指望回滚。

刷新由 pi-ai 在 `modifyRecord` 的跨进程锁里完成，模型请求和额度读取共用这一条记录、这一把锁，不会互相把对方的 token 刷废。

## 查看额度

只有一个展示面：**会话标题右侧的胶囊**，跟着当前会话选中的模型走。三个上游本插件都不路由，它只是「顺路读一下你已经配好的那把 key 还剩多少」：

- 胶囊按当前 provider 显示：
  - `openai-codex` → `5h 10% · 7d 20%`（滚动 5 小时与 7 天两个窗口的**已用**比例）
  - `opencode-go` / `opencode-go-extra` → `5h 10% · 7d 20% · 1m 30%`（三个窗口的**已用**比例）
  - `deepseek-official` / `deepseek` → `余额 ¥110.00`（官方账户余额）
  - 其他 provider 或空白新会话：不显示，绝不把别的账户的数字挂上去。
  点开胶囊是完整面板（逐窗口已用/剩余/进度条/重置时间，或逐币种余额），带「刷新」。切换模型即时切换数据，无需刷新页面。

**设置页没有这个插件的卡片。** 它没有任何可配的东西，所以不登记 settings section——在「设置 → 插件」里它只会作为已安装插件出现一行，点进插件配置那一页找不到它。要看额度就看会话里的胶囊。

页面打开期间，Codex 会在每次读取完成 30 秒后自动再读一次，期间面板保留上一次的数字，只有手动刷新才读作「正在读取额度」；自动读取结果按账户+provider 在主机内存缓存 30 秒，手动刷新至少间隔 5 秒，防止连续请求把上游打到限流。会话头部胶囊挂在会话壳声明的 `conversation.session.header.utilities` 插槽上；不声明该插槽的旧部署就什么也看不到（额度 RPC 仍然在，只是没有界面读它）。当前模型来自会话的模型目录服务，插件只做软读取，服务缺失时也只是胶囊不显示。

### 三个上游

| provider | 数据来源 | 凭据 |
| --- | --- | --- |
| `openai-codex` | `GET https://chatgpt.com/backend-api/wham/usage`（私有契约） | `llm-pi-ai/openai-codex` 这条 grant 记录，账户 id 同源 |
| `opencode-go` / `opencode-go-extra` | `GET {该路由实际 baseURL}/usage`（未公开接口，cc-switch#6433 发现） | 该路由配置的 `apiKeyEnv`（默认 `OPENCODE_GO_API_KEY`），回退 `llm-pi-ai` 存储的 API key 记录，再回退 OpenCode CLI 的 `auth.json`；同时携带 Bearer 与 `x-api-key` |
| `deepseek-official` / `deepseek` | `GET {该路由实际 baseURL}/user/balance`（官方接口） | 该路由配置的 `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`），经 credentials seam 解析 |

两个百分比上游给的都是「已用」，原样显示，旁边的剩余是 100 减出来的；DeepSeek 金额保持 API 返回的十进制字符串，不做浮点换算。浏览器通过 Harness Connection RPC 的 `/dsh-provider-quota` channel 拿到标准化结果；Connection 会先校验 Host / Origin / Fetch-Site 和浏览器会话。任何 access token、API key、账户 id 和上游原始响应都不会发到浏览器。

Codex 与 OpenCode 的接口都是未公开契约：上游改动时面板会说「没能读取额度」，不影响模型请求；点「刷新」可以重试。若上游本来就没给这个账户返回额度窗口，面板说明的是这件事，而不是一句「重试」——重试改变不了它。

从别的机器访问时，先让 Web profile 的 `trustedHosts` 接受该 authority，并用启动 URL 完成浏览器会话登录——认证后额度胶囊就可用。**到最新的 0.1.3-alpha.1 为止**，非 loopback 页面的 settings scope 仍建在内存里，卡片渲染不出内容——额度胶囊照常，设置卡片还没有能用的发布版。

## 故障排查

### 额度读不到

面板直接说原因：登录记录缺失、登录失效、超时、限流、上游没返回窗口。「登录记录缺失/失效」指的是上面那条 grant 记录——重写它，重启 dsh。胶囊本身不见，先确认宿主声明了 `conversation.session.header.utilities` 插槽，再看浏览器控制台有没有 `[dsh-provider-quota]` 开头的行。

### 卡住了：`.lock` 残留

刷新 token 的那一刻如果 dsh 被强杀（`kill -9`、断电），`$DSH_HOME` 里会留下 `.credentials.yaml.lock`。之后每次读写凭据都会等到超时才失败，提示里带 `timed out waiting for the writer lock`。锁**不会自己过期**——文件的年龄证明不了持有者已经退出。

锁文件里写着持有它的进程号。先确认那个进程真的没了，再删：

```sh
LOCK="${DSH_HOME:-$HOME/.dsh}/.credentials.yaml.lock"
ps -p "$(cat "$LOCK")" || rm -f "$LOCK"        # 进程还在就别删
```

凭据本身不受影响：写入是先写临时文件再原子替换，所以要么是改之前的完整内容，要么是改之后的，不会是半个。

## 卸载

```sh
dsh plugin --profile web remove dsh-provider-quota
```

凭据记录归 `llm-pi-ai` 管，卸载本插件不动它。

## 给改代码的人

先看 **[AGENTS.md](./AGENTS.md)**：那里是七条**出错时不报错**的坑、`npm test` 的九道门、
以及每道门盖不到的地方。每条坑各有一篇完整复盘在 [`notes/postmortems/`](./notes/postmortems/)，
设计理由在 [`notes/implemented/`](./notes/implemented/README.md)，
本地安装与迭代的步骤在 [`notes/local-setup.md`](./notes/local-setup.md)。

```sh
npm test    # 九道门 + 整套测试；这是唯一算数的那个命令
```
