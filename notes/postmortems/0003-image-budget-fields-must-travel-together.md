# 0003 · 手搓 pi-ai profile 时，图片预算字段少一个，每张图都会被换成文本

> **0.5.0 起本仓库不再有这段代码**：模型路由交回宿主的 `llm-pi-ai`，本文留档，再写同类代码时先读它。下面的符号名是当时的，本仓库已查不到。

**症状**：发图给 Codex 模型，模型回「我这边没收到图片内容」或「这张被系统省略了」。
请求正常返回，HTTP 200，不报错。0.4.0 之前一直是这样。

**原因**：`PiAiAdapter` **总是**用 profile 的两个字段拼出图片策略对象传下去：

```js
{ maxPixels: profile.requestImagePixelBudget, maxBytes: profile.requestImageMaxBytes }
```

省略这两个字段**不会**退回宿主默认值——它传下去一对 `undefined`，
而下游 `toPiContextWithImages` 的默认参数只在**整个对象缺失**时才生效。
于是 `Math.min(bytes, undefined)` = `NaN`，预算比较全部落空（`NaN` 参与的比较一律 false），
移除循环走完整个列表，**请求里每一张图都被换成文本占位符**。

## 为什么每层防线都没拦住

- **默认值的方向反了**：「不给这个字段就用默认值」是绝大多数配置的直觉，
  这里恰好相反——不给字段比给一个坏值更糟。
- **`NaN` 不抛**：它安静地让每个比较都返回 false，而这里 false 的含义是「超预算，移除」。
  一个数值 bug 变成了一个策略决定。
- **测试**：当时那条测试只断言「这两个数字存在」。字段确实存在过一段时间又被删掉，
  而删掉之后测试早已改成检查别的东西。**一条只检查字段存不存在的测试，两个 bug 都在也照样绿。**
- **端到端**：唯一能发现它的是真的发一张图给模型，而测试从不联网。

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表**——那一行是每次开工都会读到的版本。
下面是它装不下的边界条件。

profile 里 `maxRequestImageBytes` / `requestImagePixelBudget` / `requestImageMaxBytes`
**三个一起给**，而且要给真值——`undefined` 和不给是同一件事。
官方默认值在 `packages/llm/llm-pi-ai/src/config.ts`（2048² 像素、1 MiB）。

## 守住它的门

两层，缺一不可：

1. **行为断言**（真正的那个）：test/adapter.test.js（已删） 拿真实 profile 跑 harness 自己的
   offload 函数，断言图片过去之后**还是** image。删掉任一字段，它给出
   `actual: ['text','text'], expected: ['text','image']`。
   **别把它改回「断言这两个数字存在」。**
2. **`image-budget` 门**（裸检出兜底）：那份测试需要 peer 依赖，裸检出里会被跳过。
   门在文本层锚定 `createProfilesThunk` 的调用，逐个调用点检查三个字段都在、
   值不是 `undefined`/`null`（会跟一层 `const` 间接引用）。
