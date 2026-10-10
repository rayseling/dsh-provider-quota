# 0015 · seam 换了形状，插件把它读成「没配置」，两个版本没人发现

**症状**：没有用户撞出来。2026-09-23 复核 0.1.7-alpha.2 升级时，另一个会话报告
「运行时没有影响，插件工作正常；`host` suite 有 7 条测试被 skip，是 9/22 升 alpha.1 时留下的」。
两句都对，合起来是错的：胶囊显示的是 Codex 那条，它不读设置；
OpenCode 和 DeepSeek 两条从 alpha.1 起**每次都在读默认端点和默认 key 名**，
不管操作员在配置里写了什么。这台机器恰好两条都没配，所以默认值就是正确值，
哪一层都没有红。

**原因**：`src/index.js` 的 `readSection` 是

```js
try {
  var settings = ctx.get('settings')
  if (settings === undefined) return undefined
  return settings.get(ns)
} catch (_sectionUnavailable) {
  return undefined
}
```

0.1.7-alpha.1（harness #4587）把设置层整个重写：`SettingsForms` 没有 `get(ns)`，
读别的 entry 的实时配置走 `describe()`。于是 `settings.get` 是 `undefined`，
调用它抛 `TypeError`，`catch` 把它接成「没配置」，每条 API-key 路由退到默认值。
这正是坑 [2](0002-property-accessor-without-inject.md) 的 `catch` 和坑
[10](0010-a-base-url-that-was-wrong-read-as-absent.md) 的「没配 = 配错」，
只是这回坏的不是自己的读法，是对面的接口。

## 为什么每层防线都没拦住

- **测试**：`test/host.test.js` 就是为这个写的，而且它会红——如果它跑。
  它 import 的 `@deepseek-ai/dsh-settings-file` 随重写一起没了，整份 suite 按设计 skip
  （给裸检出读代码用的守卫），`node --test` 照印 `# skipped 0`、退出码 0。
  `suite` 门确实拦住了：`187 executed; expected 194`。**它从 9/22 起一直是红的**，
  被读成「测试欠账」而不是「插件坏了」。门报的是症状，人把症状当成了原因。
- **另一个会话的复核**：逐项核对了接口——`recordKeyFor`、credentials、launch-environment、
  `dsh-llm`——四个 import 的包都没变。`settings` 不在名单上，因为插件不 import 它，
  它是通过 `ctx.get` 拿的。**软读的服务不在依赖清单里**，按清单核对就核不到它。
- **线上实测**：看的是 Codex 路由，唯一不读设置的那条。
- **类型**：JS。就算有类型，`ctx.get('settings')` 拿回来的是宿主声明的类型，
  编译期看不见插件装在哪个版本的宿主上。
- **报错**：`catch (_sectionUnavailable) { return undefined }`——名字就写着它准备吃掉什么。
  它吃掉的是「服务在但读法错了」，而这个状态本来该抛。

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表。**边界：

- **三个状态，三个出口。** 服务不在（headless）→ 默认值；entry 不在（那个适配器没装）→ 默认值；
  服务在但读不了（方法不存在、调用抛错）→ **抛**，让额度读失败。前两个是「没配」，第三个是「配错」。
- **`catch` 只能接你叫得出名字的异常。** 接住「所有」的 `catch` 每一次都会在 seam 改形状时把红变绿。
- **suite 门红了先问「是谁没跑」，再问「少了几条」。** 少的那几条测的是什么，比数字重要。

## 守住它的门

`test/host.test.js` 重写到 0.1.7 的 seam 上：真 `SettingsForms` + `ConfigEditor` + Loader，
两个 entry 用宿主 base bundle 在那两个 id 下**实际挂载的包**的 `Config`，
配置写进 profile 自己的 `cordis.patch.yml`——Models 页写的就是这份文件。
包名是从 bundle 的补丁里按 id 读出来的，不写死：最初写死的是 `@deepseek-ai/dsh-llm-deepseek`，
0.1.7-rc.2 起 `llm-deepseek` 换成了 API-key 包，旧包还在、`Config` 却没了 `apiKeyEnv`，
这份测试在 2026-10-10 因此红过一次，被读成了「生产漂移」。
新增一条：给插件一个只有 `get` 的 settings 桩，一个本插件读不懂的 seam（alpha.1 之前的真 seam
其实 `get` 和 `describe()` 都有），断言两条 API-key 路由
`ok: false`、一个请求都没发、一个凭据都没解析。把旧的 `readSection` 塞回去，8 条里 4 条红。

`suite` 门那条 `187 / 194` 的红，就是这个 bug 从 9/22 到 9/23 唯一的信号。
