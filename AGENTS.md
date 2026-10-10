# 改这份代码之前，先读这几条

> 给**任何**改动本仓库的人和 agent 看。`CLAUDE.md` 是指向这里的软链，别在那边另写一份。

## 已经咬过人的坑

共同点：没有异常、没有红字，只有一个看起来正常、内容已被悄悄换掉的结果。
每条有完整复盘，重点是**为什么每层防线都没拦住**。

| # | 规则 | 守它的 |
|---|---|---|
| [1](notes/postmortems/0001-settings-validate-runs-on-read.md) | `validate` 每次**读取**时也跑。里面**别查外部世界**（目录、环境变量、文件）——抛一次，整份 section 连同不相干的字段一起没 | 无（本插件没有 section） |
| [2](notes/postmortems/0002-property-accessor-without-inject.md) | 软读**没 inject 的服务**只能用 `ctx.get(name)`：`ctx.settings` 抛在兜底**之前**，`catch` 把它变成「没配置」 | `service-reads` 门 |
| [5](notes/postmortems/0005-base-url-version-segment.md) | `OPENCODE_GO_BASE_URL` 是 **base**，后缀由 fetch 补，两边要在「`/v1` 归谁」上一致（目录本身不齐） | `test/usage.test.js` |
| [6](notes/postmortems/0006-fabricated-class-name-in-the-instructions.md) | 文档里带反引号的符号名是一句「这是真的」的断言。不确定就别加反引号 | `doc-symbols` 门 |
| [7](notes/postmortems/0007-the-picker-that-saved-into-nothing.md) | 设置 key 的**写方和读方分处两模块**时 seam 不查两半是否都在。少一半：写入成功、落盘、无人读、界面报成功 | 无，只能靠人问 |
| [8](notes/postmortems/0008-a-docstring-ate-the-export.md) | 漏一个 `*/`，注释会吞到**下一个** `*/`，中间的 `export` 被吃掉而语法合法 | `scanProblems` |
| [9](notes/postmortems/0009-a-renamed-failure-code-stopped-matching.md) | 失败码改名后不抛错，只是不再匹配，落到旁边的兜底。宿主的归 `<域>/<码>` 管，**插件自己的额度码同理** | `remote-codes` 门（两半都查） |
| [10](notes/postmortems/0010-a-base-url-that-was-wrong-read-as-absent.md) | 「**没配**」和「**配错**」不能落到同一个 `undefined`：一个用默认值，一个必须失败 | `test/host.test.js` |
| [11](notes/postmortems/0011-one-slot-served-two-accounts.md) | 状态槽按**身份**建不按长相；换身份要清 `cached` **和** `inflight`。替身把 `useEffect` 桩成空函数 = 把被测的判断删掉再断言它没错 | 三条测试 |
| [12](notes/postmortems/0012-a-deadline-that-only-stopped-waiting.md) | `race` 加超时只停**等待**不停**工作**；包装回调时少接一个 `signal` 参数是静默的 | `test/credentials.test.js` |
| [13](notes/postmortems/0013-names-copied-out-of-one-machines-config.md) | 字面量要能答「**主人是谁**」：一台机器配置里的名字是快照不是事实。算得出的数字别抄进散文 | 两条测试；散文那半无门 |
| [14](notes/postmortems/0014-the-runtime-only-strips-headers-it-knows.md) | 跨源重定向摘 `Authorization`，**不摘自定义头**。带凭据的请求默认 `redirect: 'error'` | `test/usage.test.js` |
| [15](notes/postmortems/0015-a-seam-that-changed-shape-read-as-absent.md) | seam **在但读不了**是「配错」不是「没配」：抛，别 `catch` 成默认值 | `test/host.test.js` |
| [16](notes/postmortems/0016-a-failure-without-details.md) | 线格式用**对面的真解析器**读：少一个字段，对面整条拒收，落进兜底 | `test/host.test.js` |

坑 [3](notes/postmortems/0003-image-budget-fields-must-travel-together.md)（图片预算三字段）和
[4](notes/postmortems/0004-listmodels-narrows-every-catalog-reader.md)（`listModels` 收窄）随模型路由在 0.5.0 移出本仓库。

设计理由在 [`notes/implemented/`](notes/implemented/README.md)。

## 门禁：`npm test`

```sh
npm test            # 九道门 + 整套测试；这是唯一算数的那个命令
npm run test:raw    # 只跑 node --test，紧编辑循环用——不是证据
node scripts/check.mjs --only=<门名>    # 单跑一道
node scripts/check.mjs --exemptions     # 列出每一条豁免
```

**每道门的机制、作用域、以及它证明不了什么，写在对应 collector 的
头注释里**。最要命的一条：**`scripts.test` 必须还在跑 `node scripts/check.mjs`**，
改掉它九道门当场消失而 `npm test` 照印绿色（`identity` 门管）。

**CI 跑 `--bare`：除够不到 harness 的那几道外全部**（它们没有 harness 就报红，留本地）。
裸模式**反着定义**，新加的门默认进 CI；是哪几道它自己打印。
理由见 [`ci.yml`](.github/workflows/ci.yml) 头注释。

### skip 不是通过，todo 也不是

`node --test` 单独跑**会撒谎**：跳掉的 `describe` 子树哪个计数都不进，
照样 `# skipped 0`、退出码 0（机制在 `collectSuiteViolations` 头注释里）。

- 那两份 skip 守卫（`host`/`credentials`）是给别人在裸检出里读代码用的，
  不是给本仓库改动留的口子。**提交前零 skip。**
- `{ todo: '...' }` 同样禁止：它照常跑、照常抛，而摘要报 `# fail 0`。门同时看
  `# todo`、`# cancelled` 和任何一行 `not ok`。
- 要跑全部得先软链一棵 node_modules，见 [`notes/local-setup.md`](notes/local-setup.md)。
- `scripts/expected.json` 的 `tests` 是**唯一一个改一下就能把红变绿的数字**，
  **只许和加/删测试同一个 commit 改**。改成字符串或删掉 key 也不行，门会拒。

### 改了什么 → 跑什么

| 改动 | 至少要跑 |
|---|---|
| `src/` 任何行为、`package.json`、`cordis.patch.yml` | `npm test` |
| `src/client.js` | `npm test` + **真开一次 `dsh web` 看**；commit message 里写明「手动验证：dsh web，截图 `.shots/<名>.png`」 |
| `src/index.js` / `src/credentials.js` | `npm test`，重点看 `test/host.test.js` 和 `test/credentials.test.js`（真 seam，不是桩） |
| 文档 | `npm test`；引 `packages/…` 要设 `DSH_HARNESS_ROOT`，否则文档门**报红** |
| `scripts/check.mjs` | `npm test`，并且**把 bug 塞回去看它变红**再还原 |

### 门盖不到的地方

不写出来，「全绿」会被当成「全对」：

- **`src/client.js` 的行为测试只到胶囊本体**（假 React）：余额那支面板从不调用，换成 `throw`
  照样全绿；样式和真实 hook 时机只能人去看 `dsh web`。
- **凭据记录的跨进程互斥没测过**：`modifyRecord` 的锁只在一个进程里跑过。`cordis.patch.yml` 只比字符串。
- **`npm install` 装不起来**（传递 peer 404）。`deps` 管的是清单**诚实**，不是可安装性。
- **CI 绿不代表文档引用和失败码解析得到**，也不代表 peer 测试跑过——它们在 CI 里从不执行。
- **每道门自己会打印它证明不了什么**，那份比这里全，包括已知绕得过去的写法。

### 写测试和写门时

四条常驻规则，理由见 [`what-a-gate-must-prove`](notes/implemented/2026-08-25-what-a-gate-must-prove.md)：

1. **断言行为，不断言字段存在**（坑 3 就是这么漏的）。
2. **断言外部可观测的事实**，不断言被测对象自己的说法；也别把常量喂进去再断言它出现（坑 5）。
3. **新加门或回归测试先证明它会红**：塞回 bug → 变红 → 还原，汇报里写明。
4. **修门时修机制，不修那个样本。** 收到绕过样本先问「这一类还有哪些写法」。

### 豁免

源码 `// gate-exempt: <门名> <理由>`；Markdown 用**独占一行**的 `<!-- gate-exempt: … -->`。
**理由必填**，管所在行和下一行，`npm test` 每次把生效的连理由打出来。
**只从注释位置读**，理由在 `exemptionsIn` 的头注释里。

## 汇报与提交

- **只汇报你真正跑过的命令。** 没跑就写「未跑」，别写「应该跑 X」。
- 说「这只是环境问题」不禁止，但要拆成可核查的项：确切命令、失败在哪一步、其余检查是否仍绿。
- **CI 少跑几道门**，本地才是完整的那次——上一条不是礼节，是唯一的记录。

## 语言与文档约定

- 代码注释、JSDoc、错误字符串、门的报错文案——**英文**；`README.md` 和这份文件——**中文**。
- 每个事实只写一处：**规则**在这里、**故事**在 `notes/postmortems/`、**理由**在 `notes/implemented/`、
  **门的机制**在 collector 头注释、**用户视角**在 `README.md`。写之前先想清楚它属于哪一处。
- 这里只放**每次都要遵守**的规则，一条坑缩到一行加一个链接——
  这份文件应该随着门变多而**变短**，`doc-budget` 盯着它。
- 每条禁令后面紧跟合法路径。只写「禁止 X」，agent 会自己发明变通。

## 我们并没有禁止的事

没写下来的默认，agent 会当成规则：

- **没有禁止加依赖。** 判断标准：维护得好、有真实调用方、不拖安装体积。
  手搓一个别人维护得更好的东西不是节俭。
- **没有禁止改测试。** 但要付「解释」的代价：说清这个行为为什么过时了。
- **没有禁止加 `scripts/`。** 门是普通代码：要测试、要注释、要能被删。

## 本地安装

`dsh plugin add file:` 是**拷贝**安装，改了源码不生效；迭代期用 `link:`。步骤和热更的坑见
[`notes/local-setup.md`](notes/local-setup.md)。
