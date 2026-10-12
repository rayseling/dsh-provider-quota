# Agent Note: skill 套件挂在已有的门上，不另起一套

Status: implemented

## 问题

`.agents/skills/` 下装着 write-notes-like-deepseek 套件的 skill，套件自带一套启动流程：
门禁入口是 .agents/gates.json 加 `run-gates.ts`，字数上限在 .agents/doc-budgets.json，hook 交给 lefthook，
笔记放 `.agents/notes/`。这几样本仓库都已经有了：门禁入口是 `scripts/check.mjs`，字数上限是
`scripts/budgets.json` 加 `doc-budget` 门，决策记录在 `notes/implemented/`，复盘在 `notes/postmortems/`。
照着流程做会出现两套门、两处笔记。另一边，[`notes/README.md`](../../README.md) 写的「四节一节都不能少、
考虑过的方案必填」一直没有门守着。

## 决定

套件只补本仓库缺的部分，入口仍是 `npm test`：

- **决策记录按 Agent Note 的形状放**：`implemented/<类>/yyyy-mm-dd-主题.md`，首行 `# Agent Note:`，第三行
  `Status:`，四节沿用原来的中文标题。`notes` 门原样调用套件的三条笔记校验，范围定为
  `AGENT_NOTE_ROOT=notes`、`AGENT_NOTE_IGNORE=postmortems`：复盘有自己的格式，不归它管。
- **`md-links` 门**原样调用套件的 `verify-md-links.ts`，补上 doc-refs 丢掉的 `#锚点`。
- 两道门都由 `node` 直接跑 `.ts`（Node 22.18.0 起默认剥离类型），不走 `npx tsx`：本仓库的 node_modules
  是指向 dsh profile 的软链。决定检查范围的 `AGENT_*` 变量由门设置、覆盖调用方的值；脚本不在时门报红，
  并给出重装命令。
- 不建 .agents/gates.json、.agents/doc-budgets.json 和 `.agents/notes/`，不装 lefthook。
- AGENTS.md 不加指向 skill 的链接行，也不建目录级 AGENTS.md：文档门只读根目录的 `.md` 和 `notes/`，
  写进 src/AGENTS.md 的规则会躲开三道文档门。
- 「考虑过的方案」这个标题由上游接受（rayseling/write-notes-like-deepseek@765062a），记录原文不改词。

## 考虑过的方案

- **照套件的启动流程建第二套门**（.agents/gates.json 加 lefthook）。最强的理由：和上游文档一字不差，
  以后照着 skill 操作不用换算。没选：两个入口必有一个先烂；本仓库的门有逐字断言的测试，也有
  [先证明会红](2026-08-25-what-a-gate-must-prove.md)的纪律，`run-gates.ts` 那一套两样都没有。
- **记录保持原样，不接校验。** 最强的理由：零迁移，路径和指向它们的链接都不用动。没选：
  「考虑过的方案必填」只写在 `notes/README.md` 里，没有门守着就等于没有。
- **把记录里的标题改成 `## 备选方案`，不动上游。** 最强的理由：只改本仓库，不依赖另一个仓库发版。
  没选：「考虑过的方案」就是 Alternatives considered 的直译，改的是词不是内容；上游接受这个写法，
  别的中文宿主也用得上，看板也因此抽得出这一节。
- **让 doc-refs 自己查锚点，不调用套件脚本。** 最强的理由：一套机制、一个门。没选：GitHub 标题 slug
  的规则得在这里再实现一遍，而套件的脚本已经实现，并且在上游 CI 里跑。
- **AGENTS.md 加上模板里的 skill 链接行。** 最强的理由：读 AGENTS.md 的人一眼看得到有哪些 skill。没选：
  这份文件贴着字数上限，而 Claude Code 和 Codex 本来就按 description 自动发现 skill。

## 后果

- **收益**：记录的形状和链接锚点在 CI 里也查，两道门都不需要 harness；新写的记录从第一篇起就过门。
- **代价**：两道门依赖第三方脚本。上游改了报错文案，`test/check.test.js` 里逐字断言的用例要跟着改；
  脚本不能在本仓库里改，改了会被下一次重装覆盖，要改就改上游再重装
  （`npx skills@1.7.1 add rayseling/write-notes-like-deepseek --agent codex claude-code -y`）。
- 跑这两道门的 Node 必须不低于 22.18.0。CI 写的是 `node-version: '22'`；本地用 Node 22.23.3 跑过 `--bare`。
- 归档封印的「只增不改」对比的是 HEAD，在干净的检出里等于自己和自己比；要真正拦住篡改，CI 得传
  `AGENT_NOTE_ARCHIVE_BASE_REF`。目前没有归档的记录，这一步没接。
