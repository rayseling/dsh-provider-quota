# dsh-codex-lite

在 DeepSeek Harness 里用 ChatGPT Plus/Pro 订阅跑 Codex 模型 —— 只做这一件事。

七个源文件、零构建。官方件能用的全用官方件:

| 职责 | 由谁承担 |
|---|---|
| OAuth(授权码 + PKCE、`auth.openai.com`、`127.0.0.1:1455` 回调、设备码、token 刷新) | `@earendil-works/pi-ai` 官方实现 |
| 模型目录、wire 协议(`chatgpt.com/backend-api` Responses) | pi-ai 官方 `openai-codex` catalog provider |
| 消息/流转换、附件、重试、reasoning 元数据 | dsh 官方 `PiAiAdapter`(`@deepseek-ai/dsh-llm-pi-ai` 公开导出) |
| 本插件自己写的 | 一个 0600 权限的凭据文件存储 + 终端登录命令 + 一个把 OAuth token 作为请求级 bearer 交给官方适配器的桥(含凭据解析的单飞与超时护栏)+ 一个 token 脱敏器 + 一张 Settings 卡片(手写的经典脚本,无打包步骤) |

**刻意不做的**(相对 dsh-codex):不注册任何 HTTP 路由、不接管 web 搜索、无 imagegen、不改写 `read_image`、无 TUI、不改默认模型。浏览器面只有一张卡片、只编辑一个字段;登录仍然只在 dsh 主机的终端里发生,凭据永远不进浏览器,也不进 `settings.yaml`。

## 安装

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

`test/redact.test.js` 只依赖 Node,任何检出里都能跑。store / adapter / CLI 三份测试需要 peer 依赖可解析,裸检出里会显式标记 skip,而不是伪装通过。

要跑全部,**检出目录自己**得有一棵可解析的 `node_modules`:ESM 的裸导入从导入文件所在位置逐级向上找,与 cwd 无关,所以 `cd` 到装好插件的 profile 再跑没有用——测试文件仍在检出里。软链到 profile 共享的那棵树即可:

```sh
ln -s ~/.dsh/profiles/node_modules node_modules
npm test
```

`.gitignore` 里的 `node_modules` 不带尾斜杠正是为此:带斜杠的模式只匹配目录,这个软链会漏进 `git status`。

`test/client.test.js` 也只依赖 Node:它把 `src/client.js` 当经典脚本执行,断言模块表契约(handoff id、只 require `react` 和 `@deepseek-ai/dsh-client-ui-primitives`、`inject` 为空)、卡片注册的 key、以及编辑/保存的纯函数。为此它不 import `src/index.js`——那样会把 pi-ai 和设置层一起拖进来,裸检出里整个文件直接加载失败(不是 skip)。两边的 namespace 靠 `settings.test.js` 里的反向断言钉在一起,那份测试本来就需要 peer。浏览器里跑不到的那部分——真实渲染——由下面的安装步骤人工验证。

测试从不联网:token 端点在 `globalThis.fetch` 上打桩,凭据一律写进临时 `$DSH_HOME` 并在文件跑完后删除,`login` 不在测试范围内。

## 开发

`dsh plugin ... add file:<path>` 是**拷贝**安装,而且重跑 `add` 并不会重新拷贝——pnpm 认为这个 `file:` 依赖没变,直接报 `Already up to date`,连版本号改了也一样。改了源码要真正生效,得先把那份拷贝删掉:

```sh
rm -rf ~/.dsh/profiles/web/node_modules/dsh-codex-lite
dsh plugin --profile web add file:/path/to/dsh-codex-lite
```

迭代时更省事的是 `link:` 代替 `file:`,装成符号链接,源码即所得;配合内置的客户端 HMR(每 500ms 轮询 bundle),改 `src/client.js` 可以不重启 `dsh web` 直接热更。

**一个硬约束:** `package.json` 里声明了 `dsh.client`,`src/client.js` 就必须存在于安装后的那份拷贝里——声明了却找不到文件会让 `dsh web` 直接起不来。装完、重启前先确认:

```sh
ls -l ~/.dsh/profiles/web/node_modules/dsh-codex-lite/src/client.js
```
