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
dsh plugin --profile web add file:/Volumes/4Macmini/Code/dsh-codex-lite
```

## 登录

```sh
dsh plugin --profile web exec dsh-codex-lite login          # 打开浏览器授权
dsh plugin --profile web exec dsh-codex-lite login --device-code   # 无浏览器的主机
dsh plugin --profile web exec dsh-codex-lite status
dsh plugin --profile web exec dsh-codex-lite logout
```

凭据存放在 `$DSH_HOME/.openai-codex-auth.json`(0600,属主之外可读即拒绝;与 `~/.codex` 互不相干)。与 dsh-codex 同路径同格式,两个插件登录状态互通。

**权限拒绝只在 POSIX 上成立。** Windows 报告的 mode 是从只读属性合成的,与文件真正的 ACL 无关,所以那里没有等价检查——凭据靠所在目录的 ACL 保护,和 `$DSH_HOME` 下其他 harness 机密一样。

## 使用

重启 `dsh web`,在会话里 `/model` 选 `openai-codex` 下的模型即可;默认模型保持你原有设置不变。未登录时请求会明确报错并提示登录命令。

## 配置:`modelOverrides`

pi-ai 的 catalog 给每个模型写死了尺寸,用的是 OpenAI 为 Codex 客户端调过的保守值——`gpt-5.6-sol` 是 `contextWindow: 272000`,而 OpenAI 文档标称 1,050,000(catalog 的 cost 里那个 `inputTokensAbove: 272000` 档位也印证模型本身支持更多)。`modelOverrides` 按模型 id 替换这个数字。

它有三层,后者覆盖前者(按模型 id 递归合并,不是整体替换):

| 层 | 位置 | 谁改 |
|---|---|---|
| schema 默认 | 空 | — |
| **组合层** | profile 的 `cordis.patch.yml` | 部署基线,随 profile 走 |
| **用户层** | `$DSH_HOME/settings.yaml` 的 `llm-openai-codex-lite:` 段 | Settings UI,或手编该文件 |

### Settings UI(推荐)

**设置 → 插件 → 插件配置 → OpenAI Codex**。按模型填上下文窗口,`1m` / `272k` / `1_000_000` 都认,保存即写入 `settings.yaml`——**不用重启**:下一个请求的上下文计量表分母和压缩触发点立刻按新值走,进行中的会话也一样(压缩后端每次预检都重新读模型信息)。

几个刻意的行为:

- 来自 `cordis.patch.yml` 的行标为**配置层**,只能覆盖、不能在这里删除:用户层是合并上去的,删掉用户层的值会回落到 patch 的值,而不是回落到 catalog。
- 写了 catalog 里不存在的模型 id,会被**拒绝写入**(而不是写进去再失效),卡片直接显示 seam 返回的原文,里面列出了全部已知 id。
- 卡片只在部署确实提供了这个配置段时出现;远程浏览器(非回环)还需要 profile 的 `connection` 配了 `privilegedAuthority: trusted-hosts`,否则配置面只对回环开放。

### settings.yaml

```yaml
# $DSH_HOME/settings.yaml
llm-openai-codex-lite:
  modelOverrides:
    gpt-5.6-sol:
      contextWindow: 1000000
```

手改这个文件会被热加载,卡片跟着刷新;写坏了会保留上一版好值并打 warning,不会让路由停摆。

### cordis.patch.yml(部署基线)

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: llm-openai-codex-lite
  config:
    modelOverrides:
      gpt-5.6-sol:
        contextWindow: 1000000
```

这等价于 Codex CLI 的 `model_context_window`(`~/.codex/config.toml` 对 dsh 无效,本插件不读 `~/.codex`)。唯一的字段是 `contextWindow`,省略即继承 catalog;这一层写了不存在的模型 id 会在**加载时**报错,而不是静默失效。

没有输出上限字段:Codex 的 Responses 请求体里根本不带 `max_output_tokens`,所以一个 `maxTokens` 既到不了服务端,也不会出现在会话面上的模型信息里——与其提供一个静默无效的旋钮,不如不提供。

**这是本地记账,数字不发给服务端。** 它决定两件事:上下文计量表的总量,以及会话在压缩前能留多少历史。超过 272000 tokens 的输入按模型更贵的计费档走(订阅下体现为额度消耗)。

### 自动压缩点

dsh 用比例而不是绝对值,所以没有与 Codex 的 `model_auto_compact_token_limit` 一一对应的字段——阈值是算出来的:

```
触发压缩的 token 数 = contextWindow × thresholdRatio
```

`thresholdRatio` 默认 `0.8`,所以上面这份配置把触发点从 217,600 抬到 **800,000**(Codex 那边建议手写的是 900,000,即更激进的 0.9)。

要精确对齐 0.9 得改压缩后端的配置,而它**不在** profile 的 patch 层:Web 表面把 `compaction-basic` 移到了 agent preset 的隔离 realm 里。复制一份 shipped preset 到 `$DSH_HOME/.agent-presets`(shipped 的那份只读),把它的 `compaction-basic` 行改成:

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.9
```

`compaction-basic` 还支持 per-model 策略(带 `provider` + `model` 的条目),所以可以只给 sol 调而不动其他模型;`retainRatio` 默认 `0.16`,决定压缩后保留多少上下文。

这个比例**不在本插件的可配置范围内**:Web 表面把 `compaction-basic` 放进了 agent preset 的隔离 realm,那棵子树不在 loader 条目里,profile 的 patch 按 id 寻址根本够不到,它也没有(在结构上也不能有)自己的 settings 段。Settings 卡片因此只把它当提示文字显示,不伪装成一个可调的旋钮。

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

`test/client.test.js` 也只依赖 Node:它把 `src/client.js` 当经典脚本执行,断言模块表契约(handoff id、只 require `react`、`inject` 为空)、卡片注册的 key、以及编辑/保存的纯函数。浏览器里跑不到的那部分——真实渲染——由下面的安装步骤人工验证。

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
