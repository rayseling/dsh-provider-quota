# 0004 · 收窄 `listModels` 不只影响模型选择器

**症状**：还没有咬到人——这一条是**在设计时**发现的，写下来是为了别把文案写错。

**事实**：`SelectivePiAiAdapter.listModels` 过滤掉的模型，会从**所有宿主侧目录查询**里消失。
收口是 `ctx.llm.listModels` 本身，宿主侧三处枚举各自独立调它：
`packages/api/session-controller/src/catalog.ts` 的 `buildModelCatalog`（浏览器目录）、
`packages/subagent/tool-subagent/src/list-models.ts`、`packages/acp/acp/src/model-control.ts`。
**别把普适性归给其中任何一处**——归给收口，否则下一个人去数某一处的调用方，会以为影响面被夸大了。
路由本身不受影响：按 provider+model 精确指定仍然解析得到，
已经在用被隐藏模型的会话也不会中断。

## 一处被编出来的端点，走到了用户界面上

这份文件、README 和**用户可见的** schema description 曾经都写着
「包括宿主 OpenAI 兼容 API 的 `/v1/models`」。**harness 不提供这个路由**——
全树里 `/v1/models` 只剩三处，全是 harness 作为**客户端**去探测上游 provider
（两处在 `packages/llm/llm-pi-ai/tests/discovery.spec.ts`，一处是
`packages/client/ui-settings-models` 的失败文案）。`buildModelCatalog` 生成的是宿主侧目录，不是 HTTP 端点。
这段枚举**就是**那句加粗结论的全部证据；原来引的那句 apiproxy README 已随包删除，别再找一句话来替它。

被过滤这件事是真的，被编的只是端点名字——和
[0006](0006-fabricated-class-name-in-the-instructions.md) 里那个 SettingsRuntime
是同一类错误，区别是这一次它一路走到了 Settings 卡片上，而且当时新加的 `catalog-wording` 门
**正把这个编造钉在原地**：把文案改对，门当场变红。

## 为什么每层防线都没拦住

- **描述完全正确，只有名字是编的。** 机制、后果、影响面全说对了，所以读的人不会起疑。
- **门在保护它。** 一道要求「文案里必须出现 `/v1/models`」的检查，
  把一个假事实变成了一条不许改的规则。**门只能钉住一个 token，钉不住这个 token 是不是真的。**

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表**——那一行是每次开工都会读到的版本。
下面是它装不下的边界条件。

改这块的文案时别写成「只影响选择器」。README 和 schema description 都已按实际行为措辞。
**别把「OpenAI 兼容 API 的 `/v1/models`」写回来。**

## 守住它的门

`catalog-wording`：schema 的 `.description()` 里必须有 `catalog`（读的是那个字符串本身，
不是文件、也不是同一条链上的兄弟调用），README 里必须有 `listModels`。
两个 token 都是真的。

**它证明不了**这句话是否通顺，也证明不了它描述的行为是否仍然成立。
