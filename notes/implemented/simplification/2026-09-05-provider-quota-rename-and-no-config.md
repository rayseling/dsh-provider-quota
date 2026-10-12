# Agent Note: 0.6.0：改名 dsh-provider-quota，并且不再登记 settings section

Status: implemented

## 问题

两件事同时不对了。

**名字。** `dsh-codex-lite` 里的 codex 指的是它当年注册的那条 `openai-codex` 模型路由。
路由在 0.5.0 交回宿主之后，剩下的东西对三家 provider 一视同仁：Codex 的 5h/7d、
OpenCode Go 的 5h/7d/1m、DeepSeek 的余额，判断哪一家全看会话当前选的模型。名字里点名其中
一家，会让读到它的人以为另外两家是附赠品，或者干脆以为这插件还在跑 Codex 请求。

**那张卡片。** 0.5.0 保留了一个空 schema 的 settings section，理由写在当时的记录里：插件
配置页渲染的是「宿主服务的 namespace」∩「注册到该 namespace 的卡片」，没有 section 卡片
永远不会被派发。但倒过来看这件事就变了味——section 不是为了配置而存在的，它是为了骗出一张
卡片；而那张卡片显示的内容，是会话胶囊点开后那个面板的子集。为了一个更差的第二副本，登记
一段用户永远不会去编辑、却会在 `settings.yaml` 里看到的 namespace。

## 决定

改名 `dsh-provider-quota`，六处标识一起动：npm 包名、Cordis 插件名（= 组合条目 `id`）、
条目的 `name:`、Connection 频道 `/dsh-provider-quota`、浏览器 handoff id、会话头部槽位
条目 id。报错前缀跟着改。复盘和已有的决策记录不改——它们记的是当时那个名字下发生的事。

删掉 `Config`、`settingsNs`、`installSection` 那一块、`settings.plugin.item` 的注册，以及
客户端里的卡片组件与只有它用的文案。**会话头部胶囊和它的弹层面板是唯一的展示面。**

仍然软读 `llm-pi-ai` / `llm-deepseek` 两段 section——那是**别人的**配置，API-key 路由的
endpoint 和凭据引用就写在那里。`@deepseek-ai/dsh-settings` 和 `@deepseek-ai/schemastery`
从 peer 降为 dev：运行时不 import 它们，测试要靠真 seam 跑那两处软读。

## 考虑过的方案

**只改名，卡片留着。** 否决的理由就是上面那段：空 section 的唯一作用是让一张多余的卡片能被
派发。改名的时候不清掉，它会以「历史原因」的身份再活一年。

**只删卡片，名字留着。** 两件事互不依赖，本可以分开。但名字这件事有半衰期——每多一天，就多
一处文档、一条 profile、一个人的记忆按旧名字建立。合并部署一次，比分两次少一轮
`~/.dsh` 迁移和一次重启。

**保留 section，改成有真字段可配（比如轮询间隔、显示哪几个 provider）。** 否决：那是为了
留住 section 而发明配置项。轮询间隔与宿主缓存 TTL 绑定，改它只会让两者错位；provider 由
会话选的模型决定，不是用户该挑的。没有人问过要这些。

**把卡片挂到 `llm-pi-ai` 的 namespace 下（那个 section 宿主确实服务）。** 否决：那是别人的
namespace，keyed 槽位一个 key 只有一个条目，`llm-pi-ai` 哪天自己出一张卡片，两边就要抢。

## 后果

- **设置页里没有这个插件的卡片了。** 「设置 → 插件」的已安装列表里还有一行，插件配置那一页
  没有。额度只在会话胶囊里看——这也是它本来最该在的地方。
- **`settings.yaml` 里干净了一点**：不再出现一个空的 `codex-quota:` 段。旧版留下的那一段
  没人登记，删掉即可。
- **客户端不再 require `@deepseek-ai/dsh-client-ui-primitives`**（那个 chevron 是卡片的），
  模块表依赖只剩 `react`。
- **`identity` 门重写了**：原来盯的是四处 namespace 拼写，现在盯三处包名（package.json、
  handoff id、条目 `name:`）加一处条目 `id` = Cordis `name`。handoff id 是新加的一半，
  它守的是「shell 按包名加载了这个 bundle，bundle 自报另一个 id，于是谁也 require 不到它，
  而且没有任何一行报错」。
- **test/settings.test.js 改名为 `test/host.test.js`**：它测的已经不是自己的 section，
  而是「频道挂在哪」和「读别人的两种 section 形状」。
