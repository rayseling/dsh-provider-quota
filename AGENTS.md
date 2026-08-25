# 改这份代码之前，先读这几条

> 这份文件是给**任何**改动本仓库的人和 agent 看的（`AGENTS.md` 是跨工具约定的文件名）。
> `CLAUDE.md` 只是指向这里的一行指针，别在那边另写一份。

这里只记**已经咬过人、而且咬人时不出声**的坑。每一条都是在真实故障里查出来的，不是猜测。
共同点是：出错时没有异常、没有红字，只有一个看起来正常、其实内容已经被悄悄改掉的结果。

---

## 1. settings 的 `validate` 会在每次「读取」时跑，不只是「写入」

**症状**：某次 `dsh plugin update` 之后，用户在卡片里设的上下文长度悄悄变回默认值，界面无提示，只有两行日志。

**原因**：`installSettingsSection` 的 `validate` 钩子，被 `SettingsRuntime.register` 在**解析这份设置时**就调用了
（`packages/settings/settings/src/index.ts` 里 `resolved: deepFreeze(this.resolve(..., validate))`），也就是每次启动都会跑一遍。
一旦它抛异常，**整份 section 被拒绝**——不只是出问题的那个字段。本插件 `src/index.js` 的 `catch` 接住它、
退回组合配置，于是同一份设置里**毫不相干的其他字段也一起没了**。

**规则**：`validate` 里**不要放依赖外部世界的检查**。模型目录会因为 pi-ai 升级而改名/下架，环境变量会变，
文件会消失——这些都不是用户的错，却会让整份设置在下次启动时蒸发。

- 依赖外部状态的（例：模型名单 `enabledModels` 是否还在目录里）→ **读取时过滤**，见 `selectableModelIds()`
- 只依赖自身形状的（非空、不重复）→ 可以放 `validate`，见 `assertEnabledModelShape()`
- 组合配置（`cordis.patch.yml`）里的值可以严格校验并大声报错：它随插件版本钉死，写错是部署方的 bug

## 2. `ctx.settings` 对没 inject 的服务会抛，`ctx.get('settings')` 不会

**症状**：三条 API-key 路由（opencode-go / deepseek / deepseek-official）的 `apiKeyEnv` 和 `baseURL`
配了等于没配，永远走默认值。没有任何报错。

**原因**：本插件只声明了 `inject = ['llm']`。属性访问器 `ctx.settings` 对未声明的服务直接抛
`cannot get property "settings" without inject`，而且抛在同一个表达式里的 `?? ctx.get('settings')` 兜底**之前**。
外面那层 `try/catch` 把它变成「没配置」，每一次调用都是。

**规则**：软读取一个**没有 inject 的服务**，只能用 `ctx.get(name)`。别写 `ctx.settings !== undefined ? ... : ctx.get(...)`
——第一个分支就炸了。同理，`catch` 块里如果什么都不做，至少想清楚它可能吞掉的是什么。

## 3. 手搓 pi-ai profile 时，图片预算字段不能省

**症状**：发图给 Codex 模型，模型回「我这边没收到图片内容」或「这张被系统省略了」。请求正常返回，不报错。

**原因**：`PiAiAdapter` **总是**用 profile 的两个字段拼出图片策略对象传下去：

```js
{ maxPixels: profile.requestImagePixelBudget, maxBytes: profile.requestImageMaxBytes }
```

省略这两个字段**不会**退回宿主默认值——它传下去一对 `undefined`，而下游 `toPiContextWithImages` 的默认参数
只在整个对象缺失时才生效。于是 `Math.min(bytes, undefined)` = `NaN`，预算比较全部落空，
移除循环走完整个列表，**请求里每一张图都被换成文本占位符**。

**规则**：profile 里 `maxRequestImageBytes` / `requestImagePixelBudget` / `requestImageMaxBytes`
**三个一起给**。官方默认值在 `packages/llm/llm-pi-ai/src/config.ts`（2048² 像素、1 MiB）。
`test/adapter.test.js` 里有一条回归测试：它拿真实 profile 跑 harness 自己的 offload 函数，
断言图片过去之后**还是** image——别把它改成「断言这两个数字存在」，那样两个 bug 都在也照样绿。

## 4. 收窄 `listModels` 不只影响模型选择器

`SelectivePiAiAdapter.listModels` 过滤掉的模型，会从**所有目录查询**里消失，包括宿主 OpenAI 兼容 API 的
`/v1/models`（`packages/host/apiproxy/src/api-proxy.ts` 的 `buildModelCatalog` 就是调 `ctx.llm.listModels`）。
路由本身不受影响——按 provider+model 精确指定仍然解析得到。

**规则**：改这块的文案时别写成「只影响选择器」。README 和 schema description 现在都已按实际行为措辞，
改动时保持一致。

## 5. 未公开契约：拼 URL 时注意版本段在哪一边

`OPENCODE_GO_BASE_URL` 是 **base**，不是完整 URL——`fetchOpencodeUsage` 会给它接 `/usage`。
同一个接法也作用在从路由设置里读来的 `baseURL` 上，所以两者必须在「`/v1` 归谁」上达成一致。
当前常量带 `/v1`，因为装着的 pi-ai 目录给每个 opencode-go 模型标的 `baseUrl` 就是 `.../zen/go/v1`。

Codex 的 `wham/usage` 和 OpenCode 的 `/usage` 都是未公开接口，上游改动时对应显示会变成「额度暂不可用」，
不影响模型请求。

---

## 测试

```sh
npm test        # node --test，无构建、无测试框架依赖
```

`redact` / `usage` / `client` 三份只依赖 Node，裸检出里都能跑；`store` / `adapter` / `settings` / `bin`
需要 peer 依赖可解析，缺了会显式 skip 而不是伪装通过。要跑全部，在检出目录里软链一棵 node_modules：

```sh
ln -s ~/.dsh/profiles/node_modules node_modules
```

**写测试时**：断言「行为」而不是「字段存在」。上面第 3 条那个 bug 之所以能潜伏，
就是因为一条只检查数字存不存在的测试一直是绿的。

## 本地安装

`dsh plugin add file:` 是**拷贝**安装，重跑 `add` 不会重新拷贝（pnpm 认为依赖没变），改了源码不会生效。
迭代期请用 `link:`：

```sh
rm -rf ~/.dsh/profiles/web/node_modules/dsh-codex-lite
dsh plugin --profile web add link:/path/to/dsh-codex-lite
```

改 `src/client.js` 的热更还需要在 harness 检出里另跑 `pnpm run dev:web`；否则仍要重启 `dsh web` 并刷新页面。
