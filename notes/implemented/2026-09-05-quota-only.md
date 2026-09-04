# 0.5.0：只留额度，模型路由交回宿主

## 问题

这个插件当初存在，是因为宿主给不了三件事：pi-ai 那个只认 OAuth 的 `openai-codex`
catalog provider 接不进去、Codex 的上下文长度改不了、想通告哪几个模型选不了。
外加一件宿主至今没有的：私有额度接口。

到 dsh 0.1.3-alpha.1，前三件宿主自己都有了：

- `llm-pi-ai` 直接注册 pi-ai 的 `openai-codex`，OAuth 凭据存在 credentials seam 的
  `llm-pi-ai/openai-codex` 记录里，刷新走 pi-ai 的 `getAuth` → `modifyRecord`，锁在
  seam 里；
- 该包的路由配置支持 `models:` 列表（整体替换，等于收窄目录）和 `modelOverrides:`
  （逐模型改目录字段，`contextWindow` 就在里面）。

于是本插件的适配器不再是「唯一能做到」的那条路，而是「第二个做同一件事的人」。
而同一个路由 id 只能注册一次：用户的 `settings.yaml` 里一旦有
`llm-pi-ai.providers.openai-codex`，两边同时注册就在启动时 `DUPLICATE_ADAPTER`，
整个 profile 起不来。这不是可以拖的重复，是互斥。

## 决定

砍成只剩额度：删掉当时的 src/adapter.js、src/auth.js、src/bin.js（含 `login` 命令和
package 的 `bin`）、src/store.js，以及 `enabledModels` / `modelOverrides` 两个 schema
字段和卡片上编辑它们的那半个界面。Cordis 插件名从 `llm-openai-codex-lite` 改成
`codex-quota`，因为它不再是一条 LLM 路由；npm 包名不动（用户 profile 按包名引用）。

Codex 的 access token 仍然要解析——额度接口就靠它——所以凭据这一半没删，而是**改接到
宿主的记录上**：`src/credentials.js` 是一个 pi-ai `CredentialStore`，读写
`recordKeyFor('openai-codex')` 那条 grant 记录；`src/token.js` 是原来那个单飞 + 双层超时
的解析器，架在它上面。

settings section 保留，schema 是空的。它没有字段可配，留着只为一件事：插件配置页渲染的是
「宿主服务的 namespace」和「注册到该 namespace 的卡片」的交集，没有 section 就没有卡片。

## 考虑过的方案

**整个插件删掉。** 额度是宿主没有的那件事，而且是每天都在看的那件事——OpenCode Go 和
DeepSeek 的余额宿主同样不显示。删掉就没了。

**保留适配器，让用户二选一（配了 `llm-pi-ai` 就别装本插件）。** 否决：这是把一个必然的
启动失败留给用户去踩，且失败信息是 `DUPLICATE_ADAPTER`，看不出该删哪一个。宿主原生的那条
路更该活着——它有测试、有文档、有维护者。

**继续用 `$DSH_HOME/.openai-codex-auth.json` 存凭据，只删路由。** 否决，而且是最危险的
一个：refresh token 用一次就轮换。两个文件各存一份，谁先刷新谁把对方的作废，表现是
「另一半随机开始报 401」，没有任何一处会说是为什么。共用一条记录、一把锁，是这次改动里
唯一不能省的部分。

**把 `credentialStoreFrom` 从 `llm-pi-ai` import 进来而不是抄一份。** 它没导出。抄的是
payload 与记录之间的映射（约 40 行，含 `jsonImage` 那个 undefined 处理），因为两个写方必须
写出同样的字节；`recordKeyFor` 是公开导出，所以地址是 import 的——上游改 scope 时那一半会
自己报错。

**把 `login` 留下来。** 否决：CLI 在 Cordis 之外，够不到 `ctx.credentials`，写不进这条
记录；要留就得在插件里再实现一遍凭据落盘，正好是上一条否决掉的东西。代价写在 README 里：
这一版没有任何界面能发起 authorization 流，登录只能手写记录。这是过渡状态，宿主接上界面
之后这一段就该删。

## 后果

- **登录变难了。** 从一条命令变成手写 YAML。已经登录过的人用旧文件里的 `credential`
  对象搬过去即可；没登录过的人需要另找一次 pi-ai `openai-codex` 登录。
- **旧的 `llm-openai-codex-lite` section 成了孤儿。** 没有插件登记它，宿主不会报错，
  它就静静留在 `settings.yaml` 里。迁移时该删。
- **`image-budget` 和 `catalog-wording` 两道门随被守的代码一起删了**，门从十一道变九道；
  AGENTS.md 的坑 3、坑 4 缩成一行指针，复盘留档。
- **`remote-codes` 差点变成空转**：它读的 `.code === '…'` 全在设置写入路径里。改成两半——
  宿主码那半保持不变（现在允许为空），插件自己的额度码那半是新加的，它把
  `quotaFailureText` 的分支解析到 `src/usage.js` / `src/index.js` 真能产出的码上。
  同一个失败形状（改名之后不抛错、只是不再匹配），两端都在本仓库里。
- **`src/client.js` 少了一半**，第一次有了对卡片组件本身的渲染用例（假 React）。
  胶囊和弹层仍然只被捕获、不被调用。
