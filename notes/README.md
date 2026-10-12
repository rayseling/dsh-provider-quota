# 决策记录

代码只能告诉下一个人「现在是什么样」，说不出「为什么这样、当时放弃了什么」。
这里补那一块。理由写在 commit body 里 grep 不到，写在这里可以。

每篇放在 `implemented/<类>/yyyy-mm-dd-主题.md`。类只有六种：feature、bug-fix、simplification、
architecture、process、testing，判据见 [classification](../.agents/skills/write-notes-like-deepseek/references/classification.md)。
还没落地的放 `proposed/`，否掉的放 `rejected/`，流转规则见
[write-notes-like-deepseek](../.agents/skills/write-notes-like-deepseek/SKILL.md)。

**头三行和四节都固定，一节都不能少：**

```markdown
# Agent Note: <标题>

Status: implemented

## 问题
## 决定
## 考虑过的方案
## 后果
```

「考虑过的方案」**必填**，每个方案要写为什么没选。这是代码里永远看不出来的那部分：
不写，下一个人会觉得「有个更简单的办法」，然后把当年否决过的方案重新做一遍。
没有替代方案可写的改动，多半也不需要一篇记录。

**事实可以改，决定不能改。** 路径、名字、默认值随代码同步更新；
决定本身不动——反转了就新开一篇并链回旧篇。
让文档「和现状保持一致」的顺手改写，会把当年的取舍抹掉，而那正是这里唯一有价值的东西。

`npm test` 的 `notes` 门查目录、分类、文件名、头三行和必需的节；方案是不是真考虑过，它查不了。

故障复盘在 [`postmortems/`](postmortems/)：那里记「出过什么事、为什么每层防线都没拦住」，
这里记「为什么这么设计」。复盘不用上面的格式，`notes` 门不查它。
本地安装与迭代的步骤在 [`local-setup.md`](local-setup.md)。
