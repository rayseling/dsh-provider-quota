# 0007 · 顺序装反时，勾选框保存成功、无人读取、界面报成功

**症状**：假想的——但它差一点就真的发生了。在把这批改动切成 commit 的时候，
如果卡片那个 commit 落在 host 半边之前，用户勾掉几个模型、点保存、卡片显示成功，
`settings.yaml` 里确实写进去了，**而模型列表一个都没少**。全程没有异常、没有红字。

**原因**：`enabledModels` 这件事有两半。卡片（`src/client.js`）负责写，
适配器（`src/adapter.js` 的 `selectableModelIds`）负责在 `listModels` 里读。
只落地写的那一半，写入链路是完整的——settings seam 不认识这个 key 也照存不误，
因为它存的是这个 namespace 下的一整个对象。没有任何一环会说「你写的这个东西没人看」。

## 为什么每层防线都没拦住

实测（构造「有 picker、无 host allowlist」的树，`grep -c enabledModels src/index.js` = 0）：

- **测试**：`node --test` → **183 pass / 0 fail / 0 skipped**。整套测试对这个顺序错误
  **完全无感**——卡片那半边的测试测的是卡片，host 那半边的测试还不存在。
- **类型**：JS 没有类型；就算有也拦不住——写的一方和读的一方之间没有任何静态联系，
  它们只是碰巧同意一个字符串 key。
- **settings seam**：用真 `FileSettingsProvider` + `ctx.settings.mutate(ns, ops)` 写进去，
  **没有被拒绝**。yaml 落盘：

  ```yaml
  llm-openai-codex-lite:
    enabledModels:
      - gpt-5.4
  ```

  重启后 `listModels` 仍返回全部 7 个模型，而同一份设置里的 `modelOverrides` 窗口（300000）
  安然无恙——**这份设置一半生效、一半是死信，而两者看起来一模一样**。
- **界面**：卡片拿到 seam 的成功答复，清掉 saving 状态，显示保存成功。它没说错，
  它确实保存成功了。

四层依次报告健康，而功能什么都没做。

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表。**这里只补边界：

一个「写在一处、读在另一处」的设置项，两半必须同批落地，或者读的一半先落地。
更一般地：**当一个 key 的写方和读方分处两个模块，settings seam 不会替你检查它们是否都在场**——
它存的是对象，不是契约。切 commit 的时候，这类特性没有中间态可言。

## 守住它的门

**没有门，也没有测试。** 这一条是靠人读顺序读出来的，写在这里是因为下一次不一定有人读。

能想到的最接近的兜底是「`selectableModelIds` 必须有生产调用方」这一类检查，
但它防的是删除，不是顺序——顺序错误里那个函数根本还不存在。
真正的判据只有一句：**改一个跨模块的设置 key 时，先问「读的那一半在吗」。**
