# 本地安装与迭代

不是规则，是步骤——所以放在这里而不是 `AGENTS.md`：那份文件每次开工都要被完整读一遍，
带命令的多步流程占了位置，就会挤掉真正每次都要遵守的规则。

## 装进 profile

`dsh plugin add file:` 是**拷贝**安装，而且重跑 `add` 不会重新拷贝——pnpm 认为这个 `file:`
依赖没变，直接报 `Already up to date`，连版本号改了也一样。所以改了源码要真正生效，
得先把那份拷贝删掉：

```sh
rm -rf ~/.dsh/profiles/web/node_modules/dsh-codex-lite
dsh plugin --profile web add file:/path/to/dsh-codex-lite
```

迭代期更省事的是 `link:` 代替 `file:`，装成符号链接，源码即所得：

```sh
rm -rf ~/.dsh/profiles/web/node_modules/dsh-codex-lite
dsh plugin --profile web add link:/path/to/dsh-codex-lite
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
