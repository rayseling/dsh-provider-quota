# dsh-codex-lite

在 DeepSeek Harness 里用 ChatGPT Plus/Pro 订阅跑 Codex 模型 —— 模型路由只做这一件事。

外加一件小事:在会话里显示**当前模型所属账户**还剩多少——Codex 的 5h/7d、OpenCode Go 的 5h/7d/1m、DeepSeek 余额。后两个 provider 的模型不由本插件路由(那是 `llm-pi-ai` / `llm-deepseek` 的事),这里只读它们的余量。

八个源文件、零构建。官方件能用的全用官方件:

| 职责 | 由谁承担 |
|---|---|
| OAuth(授权码 + PKCE、`auth.openai.com`、`127.0.0.1:1455` 回调、设备码、token 刷新) | `@earendil-works/pi-ai` 官方实现 |
| 模型目录、wire 协议(`chatgpt.com/backend-api` Responses) | pi-ai 官方 `openai-codex` catalog provider |
| 消息/流转换、附件、重试、reasoning 元数据 | dsh 官方 `PiAiAdapter`(`@deepseek-ai/dsh-llm-pi-ai` 公开导出) |
| 本插件自己写的 | 一个 0600 权限的凭据文件存储 + 终端登录命令 + 一个把 OAuth token 作为请求级 bearer 交给官方适配器的桥(含凭据解析的单飞与超时护栏)+ 一个 token 脱敏器 + 一个把三个上游的额度/余额归一成同一个 union 的 Connection RPC(只出标准化数据,凭据一律留在主机)+ 一张 Settings 卡片和一个会话头部额度胶囊(手写的经典脚本,无打包步骤) |

**刻意不做的**(相对 dsh-codex):不接管 web 搜索、无 imagegen、不改写 `read_image`(宿主自带的那个在这条路由上照常可用,见「使用」)、无 TUI、不改默认模型。浏览器面只有一张设置卡片加会话头部的一个额度胶囊(按当前 provider 切换 Codex / OpenCode Go / DeepSeek 三种读数);登录仍然只在 dsh 主机的终端里发生,凭据永远不进浏览器,也不进 `settings.yaml`。额度读取走 Harness Connection 统一的请求检查和浏览器会话认证,不另开 HTTP 路由。

## 安装

需要 **dsh 0.1.2-alpha.2 或更新**:设置 section 的 service API 是这个版本定的;附件的工具可读路径和 Connection 浏览器认证在 alpha.1 已定,`PiAiAdapter` 的 auth 注入更早——0.1.1-rc.1 起就是必填。插件按这些接口接线,不再支持旧版。新版 `llm-pi-ai` 也能原生配置 Codex;不要同时在它的 `providers` 里启用 `openai-codex`,同名路由只能注册一次。

```sh
dsh plugin --profile web add file:/你克隆到的路径/dsh-codex-lite
```

## 登录

```sh
dsh plugin --profile web exec dsh-codex-lite login          # 打开浏览器授权
dsh plugin --profile web exec dsh-codex-lite login --device-code   # 无浏览器的主机
dsh plugin --profile web exec dsh-codex-lite status
dsh plugin --profile web exec dsh-codex-lite logout
```

凭据存放在 `$DSH_HOME/.openai-codex-auth.json`(0600,属主之外可读即拒绝;与 `~/.codex` 互不相干)。与 dsh-codex 同路径同格式,两个插件登录状态互通。

这个检查只在 macOS / Linux 上有效。Windows 报告的权限位是系统合成的,反映不了文件真正的访问控制,所以那里不做检查——凭据靠所在目录的权限保护,和 dsh 存的其他机密一样。

## 使用

重启 `dsh web`,在会话里 `/model` 选 `openai-codex` 下的模型即可;默认模型保持你原有设置不变。未登录时请求会明确报错并提示登录命令。

**读图**:宿主自带的 `read_image` 在这条路由上照常可用,本插件不替换它。pi-ai 官方 catalog 给除 `gpt-5.3-codex-spark` 以外的每个 Codex 模型都声明了 `image` 输入;附件同时接上请求字节和新版工具可读路径:会话的文件系统能映射到宿主附件时(本机 fs),被预算挤掉的图仍留下可供 `read_image` 使用的归一化路径;沙箱执行环境映射不到,占位文案会直说没有本地路径。spark 是纯文本模型,对它调 `read_image` 会被明确拒绝并提示换模型,而不是先读盘再在上游失败。

> 0.4.0 之前有个 bug:profile 少写了 `requestImagePixelBudget` 和 `requestImageMaxBytes` 两个字段。适配器**总是**按这两个字段拼出图片策略对象传下去,所以缺字段并不会退回宿主默认值,而是传下去一对 `undefined`——转换层随后把每张图的大小算成 `NaN`,预算比较全部落空,于是把请求里**每一张图都换成了文本占位符**,全程不报错。表现就是模型回一句「我这边没收到图片内容」。升级到 0.4.0 即可。

## 选择可用模型

模型太多时,可以在 **设置 → 插件 → 插件配置 → OpenAI Codex** 卡片的「可选模型」区域取消不想用的模型。复选框保存后立即生效,不需要重启;当前已经打开的会话即使正在使用被隐藏的模型也不会中断,只是它不会再出现在新的下拉列表里。**注意它收窄的是这条路由对外通告的目录,不止是选择器**——宿主是从同一个 `listModels` 回答所有目录查询的(网关的 `models` RPC 走 `buildModelCatalog`,而它就是调 `listModels`),所以取消勾选的模型在每一处目录里都会一并消失。路由本身不受影响:按 provider+model 精确指定仍然解析得到。卡片读取插件安装版本的完整目录,所以组合配置即使只启用一个模型,也仍然可以在这里重新启用其他模型。

默认不写用户覆盖,所以展示 pi-ai 当前安装版本的全部 Codex 模型。选择一个子集后会写入 $DSH_HOME/settings.yaml:

~~~yaml
llm-openai-codex-lite:
  enabledModels:
    - gpt-5.6-sol
    - gpt-5.6-luna
~~~

「全选」会保存当前完整清单;「恢复默认模型」会清除用户层覆盖,让组合配置和后续版本新增的模型自动回到列表。至少要保留一个模型。重复或空的设置会被拒绝,不会写入文件;而指向当前 catalog 里已经不存在的模型 id 不算错误——pi-ai 升级改名或下架一个模型是常事,这类 id 读取时直接忽略,不会连累同一份设置里的上下文长度覆盖(组合配置里的名单仍然严格,写错会在加载时报错)。上下文长度覆盖与可见性独立,隐藏模型的上下文设置会保留,重新勾选后继续生效。

## 查看额度

会话界面和设置页都能看到,**跟着当前会话选中的模型走**,共用同一份数据。三个上游里只有 Codex 是本插件路由的,另外两个纯粹是「顺路读一下你已经配好的那把 key 还剩多少」——本插件不碰它们的模型请求:

- **会话界面**:会话标题右侧的胶囊按当前 provider 显示:
  - `openai-codex` → `5h 90% · 7d 80%`(滚动 5 小时与 7 天两个窗口的**剩余**比例)
  - `opencode-go` / `opencode-go-extra` → `5h 90% · 7d 80% · 1m 70%`(三个窗口的**剩余**比例)
  - `deepseek-official` / `deepseek` → `余额 ¥110.00`(官方账户余额)
  - 其他 provider 或空白新会话:不显示,绝不把别的账户的数字挂上去。
  点开胶囊是完整面板(逐窗口剩余/已用/进度条/重置时间,或逐币种余额),带「刷新」。切换模型即时切换数据,无需刷新页面。
- **设置页**:**设置 → 插件 → 插件配置 → OpenAI Codex** 卡片显示 Codex 的 5h/7d 额度,展开后是同一份面板。

页面打开期间,Codex 会在每次读取完成 30 秒后自动再读一次,期间面板保留上一次的数字,只有手动刷新才读作「正在读取额度」;自动读取结果按账户+provider 在主机内存缓存 30 秒,手动刷新至少间隔 5 秒,防止连续请求把上游打到限流。会话头部胶囊挂在会话壳声明的 `conversation.session.header.utilities` 插槽上;不声明该插槽的旧部署只会少这个胶囊,卡片不受影响。当前模型来自会话的模型目录服务,插件只做软读取,服务缺失时也只是胶囊不显示。

### 三个上游

| provider | 数据来源 | 凭据 |
| --- | --- | --- |
| `openai-codex` | `GET https://chatgpt.com/backend-api/wham/usage`(私有契约) | 插件自己存储的 ChatGPT OAuth(登录见上文),账户 id 同源 |
| `opencode-go` / `opencode-go-extra` | `GET {该路由实际 baseURL}/usage`(未公开接口,cc-switch#6433 发现) | 该路由配置的 `apiKeyEnv`(默认 `OPENCODE_GO_API_KEY`),回退 `llm-pi-ai` 存储的 API key 记录,再回退 OpenCode CLI 的 `auth.json`;同时携带 Bearer 与 `x-api-key` |
| `deepseek-official` / `deepseek` | `GET {该路由实际 baseURL}/user/balance`(官方接口) | 该路由配置的 `apiKeyEnv`(默认 `DEEPSEEK_API_KEY`),经 credentials seam 解析 |

OpenCode Go 返回「已用」百分比,展示层换算成剩余;DeepSeek 金额保持 API 返回的十进制字符串,不做浮点换算。浏览器通过 Harness Connection RPC 的 `/dsh-codex-lite` channel 拿到标准化结果;Connection 会先校验 Host / Origin / Fetch-Site 和浏览器会话。任何 access token、API key、账户 id 和上游原始响应都不会发到浏览器。

Codex 与 OpenCode 的接口都是未公开契约:上游改动时对应显示会变成「额度暂不可用」,不影响模型请求;点「刷新」可以重试。若上游本来就没给这个账户返回额度窗口,面板说明的是这件事,而不是一句「重试」——重试改变不了它。

## 配置:上下文长度

每个 Codex 模型自带一个上下文长度,用的是 OpenAI 为 Codex 客户端调过的保守值——`gpt-5.6-sol` 是 272000 tokens,而 OpenAI 文档标称 1,050,000。这个插件让你改掉它。

### 在界面里改(推荐)

**设置 → 插件 → 插件配置 → OpenAI Codex**,按模型填数字,`1m` / `272k` / `1000000` 都认。保存立刻生效,**不用重启**:下一条消息就按新值走,正在进行的会话也一样。

每行右边的按钮随状态变:改过的行是「恢复默认」(回到模型自带的长度),刚添加还没保存的行是「移除」。

填了目录里没有的模型名会被**当场拒绝**,并列出所有可选的名字——不会出现"存进去了却没生效"。

从别的机器访问时,先让 Web profile 的 `trustedHosts` 接受该 authority,并用启动 URL 完成浏览器会话登录——认证后额度胶囊就可用。**到 alpha.2 为止**,非 loopback 页面的 settings scope 仍建在内存里,卡片渲染不出内容——额度胶囊照常,设置卡片要 alpha.2 之后的宿主。

### 这个数字意味着什么

它只用于本机记账:决定一次会话能保留多少历史、什么时候开始压缩,以及输入框上方那个进度环的总量。**它不会让模型真实的上下文上限变大。** 超出模型原生长度(sol 是 272000)的输入按更高的价格档计费,订阅下体现为额度消耗更快。

可配的只有上下文长度。输出上限(max tokens)没有——Codex 的请求里根本不带这个字段,提供了也只是摆设。

### 写在文件里(可选)

界面改的值落在 `$DSH_HOME/settings.yaml`:

```yaml
llm-openai-codex-lite:
  modelOverrides:
    gpt-5.6-sol:
      contextWindow: 1000000
```

手改这个文件会被热加载,界面跟着刷新;写坏了会保留上一版好值并告警,不会让模型变得不可用。

也可以写进 profile 的 `cordis.patch.yml`,当作**这台机器的出厂值**:

```yaml
- id: llm-openai-codex-lite
  config:
    modelOverrides:
      gpt-5.6-sol:
        contextWindow: 1000000
```

代价是它在界面里**撤不掉**:界面只能盖住它,那一行的按钮会是灰的。所以日常想调的数字别写这儿——这一层留给"新机器装上就该是这个数"的场景。(写错模型名会在启动时报错。)

### 什么时候开始自动压缩

会话用到大约 **上下文长度 × 0.8** 时,较早的对话会被压缩成摘要。这个比例不属于本插件,界面里也不提供,它由 Agent 预设决定。

卡片里那行"默认预设下约 xxx 时开始压缩"就是按 0.8 算的。改了下面的 `thresholdRatio` 之后,真实触发点会跟着变,而卡片仍按默认值显示——它读不到预设,所以那行字只是个方位感,不是承诺。

要改的话:把一份自带预设复制到 `$DSH_HOME/.agent-presets`(自带的那份是只读的),编辑其中 `compaction-basic` 那一行:

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.9
```

`compaction-basic` 支持按模型分别设置(条目里带 `provider` + `model`),所以可以只调 sol 而不动别的;`retainRatio` 默认 `0.16`,决定压缩之后留下多少。

### 卡片不见了

如果 `settings.yaml` 里这一段在**启动时**就是坏的(比如手编时填了目录里没有的模型名),设置面不会登记这个 namespace,卡片也就无处可挂——面板里干脆看不到 OpenAI Codex 这张卡,而不是显示一张报错的卡。

模型路由本身不受影响:它继续按配置文件里的基线值服务,请求照常走。所以症状是"能用,但改不了"。

把 `settings.yaml` 里那一段改对(或整段删掉),**重启 dsh** 卡片就回来了。运行中修好文件不会让它自己出现——登记只在启动时发生一次。

```sh
grep -A 6 'llm-openai-codex-lite' "${DSH_HOME:-$HOME/.dsh}/settings.yaml"
```

### 卡住了:`.lock` 残留

刷新 token 的那一刻如果 dsh 被强杀(`kill -9`、断电),`$DSH_HOME` 里会留下一个锁文件。之后 `login` / `logout` 和每次自动刷新都会等两秒再失败,提示里带 `timed out waiting for the writer lock`。锁**不会自己过期**——文件的年龄证明不了持有者已经退出,所以没人敢替你判断。

锁文件里写着持有它的进程号。先确认那个进程真的没了,再删:

```sh
LOCK="${DSH_HOME:-$HOME/.dsh}/.openai-codex-auth.json.lock"
ps -p "$(cat "$LOCK")" || rm -f "$LOCK"        # 进程还在就别删
rm -f "${DSH_HOME:-$HOME/.dsh}"/.openai-codex-auth.json.*.tmp
```

凭据本身不受影响:写入是先写临时文件再原子替换,所以要么是改之前的完整内容,要么是改之后的,不会是半个。

## 卸载

```sh
dsh plugin --profile web exec dsh-codex-lite logout   # 先登出:remove 之后这个命令就没了
dsh plugin --profile web remove dsh-codex-lite
```

## 给改代码的人

先看 **[AGENTS.md](./AGENTS.md)**：那里是八条**出错时不报错**的坑、`npm test` 的十道门、
以及每道门盖不到的地方。八条坑各有一篇完整复盘在 [`notes/postmortems/`](./notes/postmortems/)，
设计理由在 [`notes/implemented/`](./notes/implemented/README.md)，
本地安装与迭代的步骤在 [`notes/local-setup.md`](./notes/local-setup.md)。

```sh
npm test        # 十道门 + 整套测试；这是唯一算数的那个命令
```

**别单跑 `node --test`**：没有 peer 依赖的检出里它会给出假绿——四份测试整份 `describe` 被跳过，
而跳过的 suite 既不进 `# tests` 也不进 `# skipped`，于是它报「全通过、零跳过、退出码 0」，
实际有四分之一没跑。`suite` 那道门就是堵这个的。

测试从不联网：token 和用量端点都在 `globalThis.fetch` 上打桩，凭据写进临时 `$DSH_HOME` 并在文件跑完后删除，
`login` 不在测试范围内。
