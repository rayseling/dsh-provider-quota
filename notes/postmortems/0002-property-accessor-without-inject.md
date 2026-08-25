# 0002 · `ctx.settings` 对没 inject 的服务会抛，抛在兜底之前

**症状**：三条 API-key 路由（opencode-go / deepseek / deepseek-official）的 `apiKeyEnv`
和 `baseURL` 配了等于没配，永远走默认值。没有任何报错。
一把配给私有端点的 key，就这样被送到了公网端点。

**原因**：本插件只声明了 `inject = ['llm']`。Cordis 的上下文是个 Proxy，
属性访问器对未声明的服务直接抛 `cannot get property "settings" without inject`
（`vendor/cordis/src/reflect.ts`）。当时的写法是：

```js
var settings = ctx.settings !== undefined ? ctx.settings : ctx.get('settings')
```

`ctx.settings` 抛在同一个表达式里的 `ctx.get('settings')` 兜底**之前**——那个兜底永远没机会跑。
外面那层 `try/catch` 把异常变成「没配置」，每一次调用都是。

## 为什么每层防线都没拦住

- **这段代码从不执行到底**：`catch` 块里只有一句 `return undefined`，
  而返回 `undefined` 正是「这台机器没配这个 section」的合法答案。异常和正常的答案长得一模一样。
- **测试**：当时没有任何测试驱动一次真实的 usage RPC 再断言「请求去了哪个 origin」。
  有的是「某个 getter 返回了真值」这一类断言，而 `undefined` 也能让它们过。
- **类型**：`ctx.settings` 在类型上完全合法——服务是通过接口增强声明的，
  编译器不知道这个 fiber 没 inject 它。
- **看起来像好代码**：`x !== undefined ? x : fallback` 是防御性写法的标准形状。
  它防的方向是对的，只是这里第一个分支就炸了。

## 规则

**home 在 [`AGENTS.md`](../../AGENTS.md) 的坑表**——那一行是每次开工都会读到的版本。
下面是它装不下的边界条件。

软读取一个**没有 inject 的服务**，只能用 `ctx.get(name)`。
别写 `ctx.settings !== undefined ? ... : ctx.get(...)`——第一个分支就炸了。
同理，`catch` 块里如果什么都不做，至少想清楚它可能吞掉的是什么。

## 守住它的门

`service-reads`。它从 `src/index.js` 解析 `export const inject`，扫 `src/**` 里所有
`ctx.<name>`（含 `ctx?.<name>`），剔注释和字符串，不在 inject 也不是 Context 内建的就报。

这是五条坑里**唯一一条模式抓得住的**。但它只是一道语法围栏：
`ctx['settings']`、`const c = ctx; c.settings` 都绕得过去。
真正兜底的是 `test/settings.test.js` 里那两条断言「请求去了哪里」的测试。
