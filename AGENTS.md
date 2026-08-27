# 改这份代码之前，先读这几条

> 给**任何**改动本仓库的人和 agent 看（`AGENTS.md` 是跨工具约定的文件名）。
> `CLAUDE.md` 是指向这里的软链，别在那边另写一份。

## 八条已经咬过人的坑

共同点：出错时没有异常、没有红字，只有一个看起来正常、其实内容已经被悄悄改掉的结果。
每条都有完整复盘（症状 / 原因 / **为什么每层防线都没拦住**），点进去看。

| # | 规则 | 守它的 |
|---|---|---|
| [1](notes/postmortems/0001-settings-validate-runs-on-read.md) | `validate` 每次**读取**时也跑。里面**别查外部世界**（目录、环境变量、文件）——抛一次，整份 section 连同不相干的字段一起没 | `test/settings.test.js` 的 STARTUP 那条 |
| [2](notes/postmortems/0002-property-accessor-without-inject.md) | 软读**没 inject 的服务**只能用 `ctx.get(name)`。`ctx.settings` 抛在同表达式的兜底**之前**，外层 `catch` 把它变成「没配置」 | `service-reads` 门 |
| [3](notes/postmortems/0003-image-budget-fields-must-travel-together.md) | pi-ai profile 的三个图片预算字段**一起给真值**。少一个 → `NaN` → 每张图变成文本占位符 | `test/adapter.test.js` + `image-budget` |
| [4](notes/postmortems/0004-listmodels-narrows-every-catalog-reader.md) | 收窄 `listModels` 影响**所有宿主侧目录查询**，别写成「只影响选择器」，也别把编出来的 `/v1/models` 写回来 | `catalog-wording` 门 |
| [5](notes/postmortems/0005-base-url-version-segment.md) | `OPENCODE_GO_BASE_URL` 是 **base**，后缀由 fetch 补，两边要在「`/v1` 归谁」上一致（目录本身不齐） | `test/usage.test.js` composition 那组 |
| [6](notes/postmortems/0006-fabricated-class-name-in-the-instructions.md) | 文档里带反引号的符号名是一句「这是真的」的断言。不确定就别加反引号 | `doc-symbols` 门 |
| [7](notes/postmortems/0007-the-picker-that-saved-into-nothing.md) | 设置 key 的**写方和读方分处两模块**时 seam 不查两半是否都在。少一半：写入成功、落盘、无人读、界面报成功 | 无，只能靠人问 |
| [8](notes/postmortems/0008-a-docstring-ate-the-export.md) | 漏一个 `*/`，注释会吞到**下一个** `*/`，中间的 `export` 被吃掉而语法合法 | `scanProblems`（在 `service-reads` / `deps` 里跑） |

设计理由（为什么这么做、当时否决了什么）在 [`notes/implemented/`](notes/implemented/README.md)。

## 门禁：`npm test`

```sh
npm test            # 十道门 + 整套测试；这是唯一算数的那个命令
npm run test:raw    # 只跑 node --test，给紧编辑循环用——它不是证据
node scripts/check.mjs --only=<门名>    # 单跑一道
node scripts/check.mjs --exemptions     # 列出每一条豁免
```

十个纯 collector 加一个 `for` 循环，没有调度器（门名跑 `--help` 就有）。
**每道门的机制、作用域、以及它证明不了什么，写在对应 collector 的头注释里**——这里不重抄。

`identity` 里最要命的一条：**`scripts.test` 必须还在跑 `node scripts/check.mjs`**。
改掉它十道门当场全消失，而 `npm test` 照印绿色。兜底的是 `test/check.test.js` 那条自检
（断言本仓库 `identity` 干净），所以绕过会让**它重定向过去的那个 runner** 变红。

**CI 跑 `--bare`：除 `doc-refs` / `doc-symbols` 外全部**（这两道够不到 harness 就报红，留本地）。
裸模式**反着定义**，新加的门默认进 CI，所以这里不写数字——跑的时候它自己打印。
理由见 [`ci.yml`](.github/workflows/ci.yml) 头注释。

### skip 不是通过，todo 也不是

`node --test` 单独跑**会撒谎**。裸检出里它报 `# tests 204 / skipped 0`、退出码 0，
而完整检出是 287 条（权威数字在 `scripts/expected.json`）。`describe(name, { skip }, fn)` 不展开子树，整个 suite 记成一行
`ok N - … # SKIP`，里面的测试**既不进 `# tests` 也不进 `# skipped`**。

- 那四份 skip 守卫（`adapter`/`bin`/`settings`/`store`）是给别人在裸检出里读代码用的，
  不是给本仓库改动留的口子。**提交前必须零 skip。**
- `{ todo: '...' }` 同样禁止：它照常跑、照常抛，而摘要报 `# fail 0`。门同时看
  `# todo`、`# cancelled` 和任何一行 `not ok`。
- 要跑全部，在检出目录里软链一棵 node_modules（ESM 裸导入从导入文件所在位置逐级向上找，与 cwd 无关）：
  `ln -s ~/.dsh/profiles/node_modules node_modules`
- `scripts/expected.json` 的 `tests` 是**唯一一个改一下就能把红变绿的数字**，
  **只许和加/删测试同一个 commit 改**。改成字符串或删掉 key 也不行，门会拒。

### 改了什么 → 跑什么

| 改动 | 至少要跑 |
|---|---|
| `src/` 任何行为 | `npm test` |
| `src/client.js` | `npm test` + **真开一次 `dsh web` 看**；commit message 里写明「手动验证：dsh web，截图 `.shots/<名>.png`」 |
| `src/index.js` 的 settings 形状 | `npm test`，重点看 `test/settings.test.js`（启的是真 seam，不是桩） |
| 文档 | `npm test`；引 `packages/…` 要设 `DSH_HARNESS_ROOT`，否则两道文档门**报红**（查不了就说查不了） |
| `scripts/check.mjs` | `npm test`，并且**把 bug 塞回去看它变红**再还原 |
| `package.json` / `cordis.patch.yml` | `npm test` |

### 门盖不到的地方

不写出来，「全绿」就会被当成「全对」：

- **`src/client.js` 占 `src/` 将近一半，行为测试只到额度面板为止。** 只有 `windowsPanelElement`
  有一条真渲染的用例；其余组件被**捕获**却从不调用（`react` 是 `{}`），换成 `throw` 照样全绿。
  唯一验证手段是人去看真实的 `dsh web`。
- **`login` 的 OAuth 零执行**；Windows 权限位按平台 skip；`cordis.patch.yml` 只比字符串。
- **`npm install` 装不起来**（未发布的传递 peer 会 404）。`deps` 管的是清单**诚实**，不是可安装性。
- **CI 绿不代表文档引用解析得到**（那两道留在本地），也不代表 peer 测试跑过（在 CI 里它们从不执行）。
  **两批 commit 落地之前 CI 是红的，这是预期**（`catalog-wording` 锚在 `enabledModels` 上，
  `identity` 要 `CLAUDE.md` 是软链，都还没进历史）。
- **裸模式的 skip 判据是按 reason 文本匹配的**：一条 flaky 测试只要把理由写成
  「peer dependencies are not installed」就能混过去。这是为了不多维护一份 suite 名单而接受的代价。
- **已知绕得过去的**：`ctx['settings']`、`const c = ctx; c.settings`、去掉反引号、
  `Name.member` 的后半截。

### 写测试和写门时

四条常驻规则，理由见 [`what-a-gate-must-prove`](notes/implemented/2026-08-25-what-a-gate-must-prove.md)：

1. **断言行为，不断言字段存在**（坑 3 就是这么放过去的）。
2. **断言外部可观测的事实**，不断言被测对象自己的说法；也别把常量当输入喂进去再断言它出现（坑 5）。
3. **新加门或回归测试先证明它会红**：塞回 bug → 变红 → 还原，汇报里写明。
4. **修门时修机制，不修那个样本。** 收到绕过样本先问「这一类还有哪些写法」。

### 豁免

源码 `// gate-exempt: <门名> <理由>`；Markdown 用**独占一行**的 `<!-- gate-exempt: … -->`。
**理由必填**，管所在行和下一行，`npm test` 每次把在生效的连理由一起打出来。
**只从注释位置读**——否则每道门那句「要豁免就写 `// gate-exempt: …`」的报错文案会豁免掉自己所在的行，
而这一段会豁免掉 `AGENTS.md` 自己。两个都真的踩到过。

## 汇报与提交

- **只汇报你真正跑过的命令。** 没跑就写「未跑」，别写「应该跑 X / Y / Z」。
- 说「这只是环境问题」不禁止，但要拆成可核查的项：确切命令、失败在哪一步、平台差异、其余检查是否仍绿。
- **本地就是唯一的门**（这个仓库没有 CI），所以上一条不是礼节，是唯一的记录。

## 语言与文档约定

- 代码注释、JSDoc、错误字符串、门的报错文案——**英文**；`README.md` 和这份文件——**中文**。
- 每个事实只写一处：**规则**在这里、**故事**在 `notes/postmortems/`、**理由**在 `notes/implemented/`、
  **门的机制**在 collector 头注释、**用户视角**在 `README.md`。写之前先想清楚它属于哪一处。
- 这里只放**每次都要遵守**的规则。一条坑一旦有门守着就缩到一行加一个链接——
  这份文件应该随着门变多而**变短**，`doc-budget` 盯着它。
- 每条禁令后面紧跟合法路径。只写「禁止 X」，agent 会自己发明变通方案。

## 我们并没有禁止的事

没写下来的默认，agent 会当成规则：

- **没有禁止加依赖。** `devDependencies` 短、`node_modules` 是软链，不代表不许加。
  判断标准：维护得好、有真实调用方、不把安装体积拖起来。手搓一个别人维护得更好的东西不是节俭。
- **没有禁止改测试。** 但要付「解释」的代价：说清这个行为为什么过时了。
- **没有禁止加 `scripts/`。** 门是普通代码：要测试、要注释、要能被删。

## 本地安装

`dsh plugin add file:` 是**拷贝**安装，改了源码不生效；迭代期用 `link:`。
完整步骤和热更的坑见 [`notes/local-setup.md`](notes/local-setup.md)。
