# dsh-codex-lite

在 DeepSeek Harness 里用 ChatGPT Plus/Pro 订阅跑 Codex 模型 —— 只做这一件事。

四个源文件、零构建、零客户端代码。官方件能用的全用官方件:

| 职责 | 由谁承担 |
|---|---|
| OAuth(授权码 + PKCE、`auth.openai.com`、`127.0.0.1:1455` 回调、设备码、token 刷新) | `@earendil-works/pi-ai` 官方实现 |
| 模型目录、wire 协议(`chatgpt.com/backend-api` Responses) | pi-ai 官方 `openai-codex` catalog provider |
| 消息/流转换、附件、重试、reasoning 元数据 | dsh 官方 `PiAiAdapter`(`@deepseek-ai/dsh-llm-pi-ai` 公开导出) |
| 本插件自己写的 | 一个 0600 权限的凭据文件存储 + 终端登录命令 + 一个把 OAuth token 作为请求级 bearer 交给官方适配器的 15 行桥 |

**刻意不做的**(相对 dsh-codex):不注册任何 HTTP 路由、不挂 Settings UI、不接管 web 搜索、无 imagegen、不改写 `read_image`、无 TUI、不改默认模型。登录只在 dsh 主机的终端里发生,浏览器面零暴露。

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

## 使用

重启 `dsh web`,在会话里 `/model` 选 `openai-codex` 下的模型即可;默认模型保持你原有设置不变。未登录时请求会明确报错并提示登录命令。

## 配置:`modelOverrides`

pi-ai 的 catalog 给每个模型写死了尺寸,用的是 OpenAI 为 Codex 客户端调过的保守值——`gpt-5.6-sol` 是 `contextWindow: 272000`,而 OpenAI 文档标称 1,050,000(catalog 的 cost 里那个 `inputTokensAbove: 272000` 档位也印证模型本身支持更多)。`modelOverrides` 按模型 id 替换这些数字:

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: llm-openai-codex-lite
  config:
    modelOverrides:
      gpt-5.6-sol:
        contextWindow: 1000000
```

这等价于 Codex CLI 的 `model_context_window`(`~/.codex/config.toml` 对 dsh 无效,本插件不读 `~/.codex`)。可选字段只有 `contextWindow` 和 `maxTokens`,省略即继承 catalog;写了 catalog 里不存在的模型 id 会在加载时报错,不会静默失效。

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

## 卸载

```sh
dsh plugin --profile web remove dsh-codex-lite
dsh plugin --profile web exec dsh-codex-lite logout   # 或直接删除凭据文件(先于 remove 执行)
```
