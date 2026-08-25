# dsh-codex-lite

在 DeepSeek Harness 里用 ChatGPT Plus/Pro 订阅跑 Codex 模型 —— 只做这一件事。

八个源文件、零构建。官方件能用的全用官方件:

| 职责 | 由谁承担 |
|---|---|
| OAuth(授权码 + PKCE、`auth.openai.com`、`127.0.0.1:1455` 回调、设备码、token 刷新) | `@earendil-works/pi-ai` 官方实现 |
| 模型目录、wire 协议(`chatgpt.com/backend-api` Responses) | pi-ai 官方 `openai-codex` catalog provider |
| 消息/流转换、附件、重试、reasoning 元数据 | dsh 官方 `PiAiAdapter`(`@deepseek-ai/dsh-llm-pi-ai` 公开导出) |
| 本插件自己写的 | 一个 0600 权限的凭据文件存储 + 终端登录命令 + 一个把 OAuth token 作为请求级 bearer 交给官方适配器的桥(含凭据解析的单飞与超时护栏)+ 一个 token 脱敏器 + 一个只返回标准化额度数据的 Connection RPC + 一张 Settings 卡片(手写的经典脚本,无打包步骤) |

**刻意不做的**(相对 dsh-codex):不接管 web 搜索、无 imagegen、不改写 `read_image`、无 TUI、不改默认模型。浏览器面只有一张设置卡片加会话头部的一个额度胶囊(按当前 provider 切换 Codex / OpenCode Go / DeepSeek 三种读数);登录仍然只在 dsh 主机的终端里发生,凭据永远不进浏览器,也不进 `settings.yaml`。额度读取复用 Harness Connection 的 trusted-host 栅栏,不直接注册绕过边界的 HTTP 路由。

## 安装

需要 **dsh 0.1.0-rc.8 或更新**。卡片保存后靠宿主的共享 settings mirror 把写入应答折回来推进 revision,rc.8 之前没有这个东西;宿主半侧(模型路由、登录、凭据存储)不受影响,更老的 dsh 上只是卡片不出现。

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

## 查看额度

会话界面和设置页都能看到,**跟着当前会话选中的模型走**,共用同一份数据:

- **会话界面**:会话标题右侧的胶囊按当前 provider 显示:
  - `openai-codex` → `周剩余 60%`(本周已用/剩余、重置时间)
  - `opencode-go` / `opencode-go-extra` → `5h 90% · 7d 80% · 1m 70%`(三个窗口的**剩余**比例)
  - `deepseek-official` / `deepseek` → `余额 ¥110.00`(官方账户余额)
  - 其他 provider 或空白新会话:不显示,绝不把别的账户的数字挂上去。
  点开胶囊是完整面板(逐窗口剩余/已用/进度条/重置时间,或逐币种余额),带「刷新」。切换模型即时切换数据,无需刷新页面。
- **设置页**:**设置 → 插件 → 插件配置 → OpenAI Codex** 卡片显示 Codex 周额度,展开后是同一份面板。

自动读取结果按账户+provider 在主机内存缓存 30 秒;手动刷新至少间隔 5 秒,防止连续请求把上游打到限流。会话头部胶囊挂在会话壳声明的 `conversation.session.header.utilities` 插槽上;不声明该插槽的旧部署只会少这个胶囊,卡片不受影响。当前模型来自会话的模型目录服务,插件只做软读取,服务缺失时也只是胶囊不显示。

### 三个上游

| provider | 数据来源 | 凭据 |
| --- | --- | --- |
| `openai-codex` | `GET https://chatgpt.com/backend-api/wham/usage`(私有契约) | 插件自己存储的 ChatGPT OAuth(登录见上文),账户 id 同源 |
| `opencode-go` / `opencode-go-extra` | `GET {该路由实际 baseURL}/usage`(未公开接口,cc-switch#6433 发现) | 该路由配置的 `apiKeyEnv`(默认 `OPENCODE_GO_API_KEY`),回退 `llm-pi-ai` 存储的 API key 记录,再回退 OpenCode CLI 的 `auth.json`;同时携带 Bearer 与 `x-api-key` |
| `deepseek-official` / `deepseek` | `GET {该路由实际 baseURL}/user/balance`(官方接口) | 该路由配置的 `apiKeyEnv`(默认 `DEEPSEEK_API_KEY`),经 credentials seam 解析 |

OpenCode Go 返回「已用」百分比,展示层换算成剩余;DeepSeek 金额保持 API 返回的十进制字符串,不做浮点换算。浏览器通过 Harness Connection RPC 的 `/dsh-codex-lite` channel 拿到标准化后的结果;Connection 会先执行 Host / Origin / Fetch-Site trusted-host 栅栏。任何 access token、API key、账户 id 和上游原始响应都不会发到浏览器。

Codex 与 OpenCode 的接口都是未公开契约:上游改动时对应显示会变成「额度暂不可用」,不影响模型请求;点「刷新」可以重试。若上游本来就没给这个账户返回周额度窗口,面板说明的是这件事,而不是一句「重试」——重试改变不了它。

## 配置:上下文长度

每个 Codex 模型自带一个上下文长度,用的是 OpenAI 为 Codex 客户端调过的保守值——`gpt-5.6-sol` 是 272000 tokens,而 OpenAI 文档标称 1,050,000。这个插件让你改掉它。

### 在界面里改(推荐)

**设置 → 插件 → 插件配置 → OpenAI Codex**,按模型填数字,`1m` / `272k` / `1000000` 都认。保存立刻生效,**不用重启**:下一条消息就按新值走,正在进行的会话也一样。

每行右边的按钮随状态变:改过的行是「恢复默认」(回到模型自带的长度),刚添加还没保存的行是「移除」。

填了目录里没有的模型名会被**当场拒绝**,并列出所有可选的名字——不会出现"存进去了却没生效"。

从别的机器访问(不是 127.0.0.1)时要看到这张卡片,profile 的 `connection` 需要配 `privilegedAuthority: trusted-hosts`;否则设置面只对本机开放。

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

## 测试

```sh
npm test        # node --test,无构建、无测试框架依赖
```

`test/redact.test.js`、`test/usage.test.js` 和 `test/client.test.js` 只依赖 Node,任何检出里都能跑。store / adapter / CLI 三份测试需要 peer 依赖可解析,裸检出里会显式标记 skip,而不是伪装通过。

要跑全部,**检出目录自己**得有一棵可解析的 `node_modules`:ESM 的裸导入从导入文件所在位置逐级向上找,与 cwd 无关,所以 `cd` 到装好插件的 profile 再跑没有用——测试文件仍在检出里。软链到 profile 共享的那棵树即可:

```sh
ln -s ~/.dsh/profiles/node_modules node_modules
npm test
```

`.gitignore` 里的 `node_modules` 不带尾斜杠正是为此:带斜杠的模式只匹配目录,这个软链会漏进 `git status`。

`test/client.test.js` 也只依赖 Node:它把 `src/client.js` 当经典脚本执行,断言模块表契约(handoff id、只 require `react` 和 `@deepseek-ai/dsh-client-ui-primitives`、`inject` 为空)、卡片和会话胶囊两处注册(以及不声明胶囊插槽、或插槽注册抛错的部署里卡片照常活着)、三个 provider 槽各自独立的读取状态机、胶囊文案,以及编辑/保存的纯函数。为此它不 import `src/index.js`——那样会把 pi-ai 和设置层一起拖进来,裸检出里整个文件直接加载失败(不是 skip)。两边的 namespace 靠 `settings.test.js` 里的反向断言钉在一起,那份测试本来就需要 peer。浏览器里跑不到的那部分——真实渲染——由下面的安装步骤人工验证。

测试从不联网:token 和用量端点都在 `globalThis.fetch` 上打桩,凭据一律写进临时 `$DSH_HOME` 并在文件跑完后删除,`login` 不在测试范围内。

## 开发

`dsh plugin ... add file:<path>` 是**拷贝**安装,而且重跑 `add` 并不会重新拷贝——pnpm 认为这个 `file:` 依赖没变,直接报 `Already up to date`,连版本号改了也一样。改了源码要真正生效,得先把那份拷贝删掉:

```sh
rm -rf ~/.dsh/profiles/web/node_modules/dsh-codex-lite
dsh plugin --profile web add file:/path/to/dsh-codex-lite
```

迭代时更省事的是 `link:` 代替 `file:`,装成符号链接,源码即所得。客户端热更还需要在同一份 DeepSeek Harness 检出里运行 `pnpm run dev:web`;只有 HMR 接收器而没有这个构建 watcher 时,改 `src/client.js` 后仍要重启现有 `dsh web` 并刷新页面。

**一个硬约束:** `package.json` 里声明了 `dsh.client`,`src/client.js` 就必须存在于安装后的那份拷贝里——声明了却找不到文件会让 `dsh web` 直接起不来。装完、重启前先确认:

```sh
ls -l ~/.dsh/profiles/web/node_modules/dsh-codex-lite/src/client.js
```
