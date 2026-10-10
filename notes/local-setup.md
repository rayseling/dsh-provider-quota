# 本地安装与迭代

不是规则，是步骤——所以放在这里而不是 `AGENTS.md`：那份文件每次开工都要被完整读一遍，
带命令的多步流程占了位置，就会挤掉真正每次都要遵守的规则。

## 装进 profile

`dsh plugin add file:` 是**拷贝**安装，而且重跑 `add` 不会重新拷贝——pnpm 认为这个 `file:`
依赖没变，直接报 `Already up to date`，连版本号改了也一样。所以改了源码要真正生效，
得先把那份拷贝删掉：

```sh
rm -rf ~/.dsh/profiles/web/node_modules/dsh-provider-quota
dsh plugin --profile web add file:/path/to/dsh-provider-quota
```

迭代期更省事的是 `link:` 代替 `file:`，装成符号链接，源码即所得：

```sh
rm -rf ~/.dsh/profiles/web/node_modules/dsh-provider-quota
dsh plugin --profile web add link:/path/to/dsh-provider-quota
```

## 客户端热更

改 `src/client.js` 之后，还需要在**同一份 DeepSeek Harness 检出**里跑 `pnpm run dev:web`：
只有 HMR 接收器而没有这个构建 watcher 时，改动不会到达浏览器，仍要重启现有的 `dsh web` 并刷新页面。

## 跑全套测试

测试文件在检出里，而 ESM 的裸导入从**导入文件所在位置**逐级向上找，与 cwd 无关——
所以 `cd` 到装好插件的 profile 再跑没有用。在检出目录里软链一棵 node_modules 即可：

```sh
ln -s ~/.dsh/profiles/node_modules node_modules
```

`.gitignore` 里的 `node_modules` 不带尾斜杠正是为此：带斜杠的模式只匹配目录，这个软链会漏进 `git status`。

## 一个装完必查的硬约束

`package.json` 里声明了 `dsh.client`，`src/client.js` 就必须存在于**安装后的那份拷贝**里——
声明了却找不到文件会让 `dsh web` 直接起不来。装完、重启前先确认：

```sh
ls -l ~/.dsh/profiles/web/node_modules/dsh-provider-quota/src/client.js
```

## 浏览器那半边为什么单独测

`test/client.test.js` 把 `src/client.js` 当经典脚本执行，断言模块表契约（handoff id、
只 require `react` 和 `@deepseek-ai/dsh-client-ui-primitives`、`inject` 为空）、
会话胶囊的注册、每个 provider 各自独立的读取状态机、以及归一化与文案的纯函数。
它**不** import `src/index.js`——那样会把 pi-ai 和凭据层一起拖进来，裸检出里整个文件直接加载失败（不是 skip）。
包名和 handoff id 的一致由 `identity` 门盯着，不靠这份测试。

真实渲染这一半跑不到，只能人去看 `dsh web`——见 `AGENTS.md` 的「门盖不到的地方」。

### 软链里的软链会失效

`~/.dsh/profiles/node_modules/@deepseek-ai/*` 是 dsh 铺平的一层软链，每条指向 harness 检出里
pnpm 放那个包的位置。harness 升级后 pnpm 会把包挪到别的嵌套目录，这层不跟着动，于是一批链接悬空。
运行时不受影响（插件通过 `ctx` 拿服务，不 import 这些包），只有测试要 import 的那几个会报
`ERR_MODULE_NOT_FOUND`——而 `host` 那份 suite 会因此整个被 skip，`npm test` 的 `suite` 门才拦住它。
查和修：

```sh
for l in ~/.dsh/profiles/node_modules/@deepseek-ai/*; do [ -e "$l" ] || echo "$(basename $l)"; done
ln -sfn /path/to/deepseek-harness/packages/settings/settings ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-settings
ln -sfn /path/to/deepseek-harness/packages/boot/config-editor ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-config-editor
```

目标写 workspace 里的包目录（`packages/<组>/<包>`），不写 pnpm 的嵌套路径——前者不会随升级挪动。

要补哪几条，以 `test/host.test.js` 和 `test/credentials.test.js` 开头那串 import 为准，这里不抄名单。
`llm-deepseek`、`llm-pi-ai` 两个 entry 背后的适配器不用链：host 测试从 `@deepseek-ai/dsh-base`
自己的依赖里按 id 解析它们，所以只要 `dsh-base` 这一条有效。
