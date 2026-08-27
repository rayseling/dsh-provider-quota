/**
 * dsh-codex-lite browser half: one card in Settings -> Plugins -> Plugin
 * configuration plus a session-header chip, both showing the host-normalized
 * Codex 5h/7d quota; the card also edits the per-model context window this
 * plugin's settings namespace owns.
 *
 * The harness ships no generic schema-form renderer — the package that once
 * held one is gone, and the plugin-configuration tab is a card registry keyed
 * by settings namespace, where a namespace no card claims renders nothing. So
 * this file is the card, hand-written as a classic script: no bundler, no JSX,
 * and the only modules it asks the client module table for are `react` and the
 * shipped UI primitives. Everything else it needs is a cordis service.
 *
 * It writes through `settings.mutate` rather than the scope's own setters,
 * because one card save has to be one atomic write, and folds the answer into
 * the shared describe mirror the way the scope's setters do — which is what
 * moves the revision the next write fences on. That mirror is the one thing
 * here that a harness older than 0.1.0-rc.8 does not have.
 *
 * Two failure modes here would take the whole web UI down with them, so both
 * are designed out rather than handled: the module declares no `inject`, and
 * resolves its services inside `apply` instead, because the boot sweep fails
 * the page for any entry left pending on a service that never arrived; and
 * every entry point is wrapped, because an entry whose `apply` throws fails
 * that same sweep. The worst outcome this file can produce is no card.
 */

;(function () {
  var sink = typeof window === 'undefined' ? undefined : window.__ModuleLoader__
  if (sink === undefined || typeof sink.load !== 'function') return
  sink.load({ id: 'dsh-codex-lite', factory: factory })

  /**
   * @param {(specifier: string) => any} require - the client module table.
   * @returns {object} this package's browser module.
   */
  function factory(require) {
    var React = require('react')
    // The same menu the Settings dialog's own selectors are built from, so
    // this card's dropdown is that control rather than an imitation of it.
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var Menu = primitives.Menu
    var ChevronIcon = primitives.IconChevronDownOutline14

    /** The settings namespace this card edits; must equal the host half's. */
    var SETTINGS_NS = 'llm-openai-codex-lite'

    /** The LLM route this plugin owns, as the model catalog groups it. */
    var OPENAI_CODEX_ROUTE = 'openai-codex'

    /** Trusted Harness Connection RPC carrying secret-free usage data. */
    var CODEX_USAGE_CHANNEL = '/dsh-codex-lite'
    var CODEX_USAGE_METHOD = 'usage'
    var CODEX_CATALOG_METHOD = 'catalog'
    // Host worst case is 20s credential resolution plus a 15s usage fetch.
    var CODEX_USAGE_TIMEOUT_MS = 40_000
    // Match the Host cache TTL. Scheduling from the previous completion keeps
    // the next ordinary read beyond that TTL without bypassing the shared cache.
    var CODEX_USAGE_POLL_MS = 30_000
    var scheduleUsagePoll = typeof globalThis.setTimeout === 'function'
      ? globalThis.setTimeout.bind(globalThis)
      : undefined
    var cancelUsagePoll = typeof globalThis.clearTimeout === 'function'
      ? globalThis.clearTimeout.bind(globalThis)
      : undefined

    // The provider routes this chip answers for, mapped to the state slot the
    // controller keeps per provider family — one slot per family, so switching
    // models can never show one account's numbers under another provider.
    var PROVIDER_ROUTES = {
      'openai-codex': 'codex',
      'opencode-go': 'opencode',
      'opencode-go-extra': 'opencode',
      'deepseek-official': 'deepseek',
      'deepseek': 'deepseek',
    }

    // The per-route state slots the controller projects.
    var USAGE_ROUTES = ['codex', 'opencode', 'deepseek']

    // A stable stand-in for the model directory when the service is absent or
    // a session has no directory scope: same shape, never notifies.
    var EMPTY_MODEL_SNAPSHOT = { current: null, routable: null, groups: [], failures: [], status: 'idle', error: null }
    var EMPTY_DIRECTORY = {
      getSnapshot: function () { return EMPTY_MODEL_SNAPSHOT },
      subscribe: function () { return function () {} },
      ensureLoaded: function () {},
    }

    /**
     * The fraction of the window at which the shipped agent presets start
     * compacting. It lives in the preset, not here — a preset that sets its
     * own ratio moves the real trigger and this card never learns of it — so
     * the line derived from it names the assumption instead of stating a fact.
     */
    var DEFAULT_THRESHOLD_RATIO = 0.8

    // Copy for someone fluent in AI but not in this codebase: context length,
    // tokens, compaction and billing tiers are words they already own, so the
    // card uses them plainly — and names nothing that exists only in here.
    //
    // Anything the neighbouring cards already have a word for keeps their
    // word: two cards calling the same act "放弃修改" and "撤销" would read as
    // two different acts.
    var TEXT = {
      zh: {
        title: 'OpenAI Codex',
        description: '查看 5 小时与 7 天额度，选择要显示的模型，并调整上下文长度。',
        expand: '展开设置',
        collapse: '收起设置',
        models: '可选模型',
        modelSummary: '已启用 {enabled}/{total}',
        selectAll: '全选',
        resetModels: '恢复默认模型',
        modelsLoading: '正在读取模型列表…',
        modelsHint: '取消勾选的模型不会出现在会话的模型选择器中，但已有会话仍可继续使用。',
        modelsEmpty: '至少要保留一个模型。',
        modelsPartial: '完整目录没读到，下面这份可能不全——它来自当前已启用的列表，不一定包含这次安装带的每个模型。点上面的重试可以再取一次。',
        window: '上下文长度',
        placeholder: '模型默认',
        add: '添加',
        addLabel: '添加模型',
        pick: '选择模型',
        allAdded: '已全部添加',
        catalogFailed: '模型列表没读到,重试',
        remove: '移除',
        clear: '恢复默认',
        save: '保存',
        discard: '放弃修改',
        saving: '保存中…',
        unsaved: '未保存',
        readOnly: '本部署的设置为只读。',
        sourceUser: '已覆盖',
        sourceBase: '来自配置文件',
        sourceNone: '模型默认',
        baseHint: '这个值写在本机的配置文件里。可以在这里调,但要回到模型默认值得去改那个文件。',
        invalid: '请填整数;留空表示使用模型默认值。也可以写成 1m 或 272k。',
        conflict: '这项设置刚在别处被改过,已经重新读取。请确认后再保存。',
        offline: '没保存成功,连接中断了。请稍后重试。',
        derived: '{value} tokens · 默认预设下约 {trigger} 时开始压缩较早的对话',
        note: '这个数字只用于本机记账:会话能保留多少历史、什么时候开始压缩。模型真实的上下文上限不会因此变大,而且超出模型原生长度的输入会按更高的价格档计费。',
        quotaBadge: '周剩余 {remaining}%',
        windowsTitle: '额度',
        window5h: '5 小时',
        window7d: '7 天',
        window1m: '1 个月',
        remainingLabel: '剩余 {remaining}%',
        usedLabel: '已使用 {used}%',
        resetsLabel: '重置 {time}',
        balanceTitle: '余额',
        balanceUnavailable: '余额不可用于 API 调用。',
        balanceToppedUp: '充值 {value}',
        balanceGranted: '赠送 {value}',
        quotaNoKey: '没有找到该提供方的 API Key。',
        quotaNoSubscription: '这个 API Key 没有对应的订阅。',
        quotaLoading: '正在读取额度…',
        quotaNoWindows: 'OpenAI 没有为这个账户返回额度窗口。',
        quotaSignedOut: '尚未登录。请在主机终端运行 dsh plugin --profile web exec dsh-codex-lite login。',
        quotaAuth: 'Codex 登录已失效，请在主机终端重新登录。',
        quotaTimeout: '读取额度超时，请稍后重试。',
        quotaRateLimited: '额度接口请求过于频繁，请稍后重试。',
        quotaFailed: '没能读取额度，请稍后重试。',
        refresh: '刷新',
        refreshing: '刷新中…',
      },
      en: {
        title: 'OpenAI Codex',
        description: 'View 5-hour and 7-day usage, choose visible models, and adjust context length.',
        expand: 'Show settings',
        collapse: 'Hide settings',
        models: 'Visible models',
        modelSummary: '{enabled}/{total} enabled',
        selectAll: 'Select all',
        resetModels: 'Reset model list',
        modelsLoading: 'Loading model list…',
        modelsHint: 'Unchecked models disappear from new model pickers, but existing sessions can still use them.',
        modelsEmpty: 'Keep at least one model enabled.',
        modelsPartial: 'The full catalog did not load, so this list may be short — it comes from what is already enabled and need not carry every model this install ships. Retry above to fetch it again.',
        window: 'Context length',
        placeholder: 'model default',
        add: 'Add',
        addLabel: 'Add a model',
        pick: 'Choose a model',
        allAdded: 'All added',
        catalogFailed: 'Model list unavailable — retry',
        remove: 'Remove',
        clear: 'Reset to default',
        save: 'Save',
        discard: 'Discard',
        saving: 'Saving…',
        unsaved: 'Unsaved',
        readOnly: 'This deployment stores settings read-only.',
        sourceUser: 'Overridden',
        sourceBase: 'from a config file',
        sourceNone: 'model default',
        baseHint: 'This value is set in a config file on this machine. You can change it here, but getting back to the model default means editing that file.',
        invalid: 'Enter a whole number, or leave blank to use the model default. 1m and 272k are accepted.',
        conflict: 'Someone just changed this setting elsewhere, so it has been reloaded. Check it and save again.',
        offline: 'Not saved — the connection dropped. Please try again.',
        derived: '{value} tokens · with the default preset, compaction starts around {trigger}',
        note: 'This number is local bookkeeping only: how much history a conversation keeps, and when compaction starts. It does not raise the model’s real context limit, and input past the model’s native length is billed at a higher tier.',
        quotaBadge: 'Weekly {remaining}% left',
        windowsTitle: 'Usage',
        window5h: '5h',
        window7d: '7d',
        window1m: '1m',
        remainingLabel: '{remaining}% left',
        usedLabel: '{used}% used',
        resetsLabel: 'Resets {time}',
        balanceTitle: 'Balance',
        balanceUnavailable: 'Balance unavailable for API calls.',
        balanceToppedUp: 'Topped up {value}',
        balanceGranted: 'Granted {value}',
        quotaNoKey: 'No API key configured for this provider.',
        quotaNoSubscription: 'This API key has no subscription.',
        quotaLoading: 'Loading usage…',
        quotaNoWindows: 'OpenAI did not return a usage window for this account.',
        quotaSignedOut: 'Not signed in. Run dsh plugin --profile web exec dsh-codex-lite login on the host.',
        quotaAuth: 'The Codex sign-in has expired. Sign in again on the host.',
        quotaTimeout: 'Usage timed out. Try again shortly.',
        quotaRateLimited: 'The usage endpoint is rate limited. Try again shortly.',
        quotaFailed: 'Could not load usage. Try again shortly.',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
      },
    }

    // ── pure helpers, also exported so they can be tested without a DOM ──

    /**
     * Read one window from what the operator typed.
     * @param {string} text - the field contents.
     * @returns {{kind: 'set', value: number} | {kind: 'clear'} | undefined}
     *   the window, the intent to remove the override, or nothing when the
     *   text is not a window at all.
     */
    function parseWindow(text) {
      var trimmed = String(text === undefined || text === null ? '' : text).trim().replace(/[_,\s]/g, '')
      if (trimmed === '') return { kind: 'clear' }
      var match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(trimmed)
      if (match === null) return undefined
      var scale = match[2] === undefined ? 1 : (match[2] === 'k' || match[2] === 'K' ? 1e3 : 1e6)
      var value = Number(match[1]) * scale
      // Safe, not merely integral: past 2^53 the digits stop being exact and
      // `String(value)` switches to exponent notation, which this very parser
      // rejects — so accepting one would write a value the field could never
      // show back. The host schema refuses the same range.
      if (!Number.isSafeInteger(value) || value < 1) return undefined
      return { kind: 'set', value: value }
    }

    /**
     * Render one stored window for editing. Always the plain integer, so what
     * the field shows is exactly what the document holds.
     * @param {number|undefined} value - the stored window.
     * @returns {string} the field contents.
     */
    function formatWindow(value) {
      return typeof value === 'number' ? String(value) : ''
    }

    /** @param {number} value @returns {string} the same number, digit-grouped. */
    function groupDigits(value) {
      return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /** @param {unknown} section @returns {object} the section's overrides map, always an object. */
    function overridesOf(section) {
      if (section === null || typeof section !== 'object') return {}
      var overrides = section.modelOverrides
      return overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {}
    }

    /** @param {unknown} section @returns {string[]} selected model ids, or an empty list. */
    function enabledModelsOf(section) {
      if (section === null || typeof section !== 'object' || !Array.isArray(section.enabledModels)) return []
      return section.enabledModels.filter(function (id, index, list) {
        return typeof id === 'string' && id.length > 0 && list.indexOf(id) === index
      })
    }

    /** @param {unknown} section @returns {boolean} whether the raw layer owns the allowlist. */
    function hasEnabledModels(section) {
      return section !== null && typeof section === 'object'
        && Object.prototype.hasOwnProperty.call(section, 'enabledModels')
        && Array.isArray(section.enabledModels)
    }

    /** @param {readonly string[]} left @param {readonly string[]} right @returns {boolean} same ids, regardless of order. */
    function sameModelSet(left, right) {
      if (left.length !== right.length) return false
      var wanted = new Set(left)
      if (wanted.size !== right.length) return false
      return right.every(function (id) { return wanted.has(id) })
    }

    /** @param {readonly string[]} ids @param {readonly string[]} catalog @returns {string[]} catalog-ordered ids. */
    function orderModelIds(ids, catalog) {
      // Catalog order, and catalog membership. An id the installed catalog no
      // longer carries has no checkbox in the grid, so carrying it into the
      // write would resubmit something the user can neither see nor remove —
      // and the host answers that with a raw seam sentence naming an id that
      // is nowhere on screen. Dropping it here is what makes the next save the
      // repair. An empty catalog means it has not loaded yet, and then the
      // stored ids are all we know, so they pass through untouched.
      if (catalog.length === 0) return ids.slice()
      var wanted = new Set(ids)
      var ordered = []
      catalog.forEach(function (id) { if (wanted.has(id)) ordered.push(id) })
      return ordered
    }

    /** @param {unknown} user @param {object|undefined} selection @returns {object[]|undefined} allowlist ops. */
    function modelSelectionOps(user, selection) {
      if (selection === undefined) return []
      var held = hasEnabledModels(user)
      if (selection.kind === 'unset') return held ? [{ op: 'unset', path: ['enabledModels'] }] : []
      var ids = Array.isArray(selection.ids) ? selection.ids : []
      if (ids.length === 0) return undefined
      if (held && sameModelSet(enabledModelsOf(user), ids)) return []
      return [{ op: 'set', path: ['enabledModels'], value: ids.slice() }]
    }

    /** @param {object} overrides @param {string} id @returns {number|undefined} the stored window. */
    function windowIn(overrides, id) {
      var entry = overrides[id]
      return entry !== null && typeof entry === 'object' ? entry.contextWindow : undefined
    }

    /**
     * Project the two layers and the staged edits into one row per model.
     *
     * A row's source is decided by which layer *holds* the id, never by
     * comparing values: an override that happens to equal the layer below is
     * still an override, and saying otherwise would mislabel it.
     * @param {unknown} base - the composition layer as the Host reported it.
     * @param {unknown} user - the user layer as the Host reported it.
     * @param {Record<string, string>} drafts - staged field contents, by model id.
     * @returns {object[]} one row per model, ordered by id.
     */
    function rowsOf(base, user, drafts) {
      var baseOverrides = overridesOf(base)
      var userOverrides = overridesOf(user)
      var seen = {}
      var collect = function (id) { seen[id] = true }
      Object.keys(baseOverrides).forEach(collect)
      Object.keys(userOverrides).forEach(collect)
      Object.keys(drafts).forEach(collect)
      return Object.keys(seen).sort().map(function (id) {
        var inUser = Object.prototype.hasOwnProperty.call(userOverrides, id)
        var inBase = Object.prototype.hasOwnProperty.call(baseOverrides, id)
        var stored = inUser ? windowIn(userOverrides, id) : inBase ? windowIn(baseOverrides, id) : undefined
        var staged = Object.prototype.hasOwnProperty.call(drafts, id)
        var text = staged ? drafts[id] : formatWindow(stored)
        var parsed = parseWindow(text)
        return {
          model: id,
          text: text,
          source: inUser ? 'user' : inBase ? 'base' : 'none',
          value: parsed !== undefined && parsed.kind === 'set' ? parsed.value : undefined,
          invalid: parsed === undefined,
          staged: staged,
          // What this row's button does, which differs by where the value
          // lives: a row that exists only because someone added it is removed
          // outright, a stored one is reset to the model's own length, and one
          // the config file supplies can be changed here but not taken away.
          action: inBase ? 'locked' : inUser ? 'reset' : 'remove',
          baseValue: inBase ? windowIn(baseOverrides, id) : undefined,
        }
      })
    }

    /**
     * The lines shown under one row: what the number means, and — for a value
     * the layer below supplies — why it cannot be cleared here.
     *
     * Pure, and exported, because the second line is the answer to the first
     * question the disabled Clear button provokes: leaving it unsaid is what
     * makes a greyed-out control look broken instead of explained.
     * @param {object} row - one row from {@link rowsOf}.
     * @param {string} language - the active language key.
     * @returns {{text: string, error?: boolean}[]} the lines, in order.
     */
    function hintsOf(row, language) {
      var text = TEXT[language] || TEXT.zh
      var lines = []
      if (row.invalid) {
        lines.push({ text: text.invalid, error: true })
      } else if (row.value !== undefined) {
        lines.push({
          text: text.derived
            .replace('{value}', groupDigits(row.value))
            .replace('{trigger}', groupDigits(Math.floor(row.value * DEFAULT_THRESHOLD_RATIO))),
        })
      }
      if (row.source === 'base') lines.push({ text: text.baseHint })
      return lines
    }

    /** @param {unknown} value @returns {boolean} whether value is a finite number. */
    function isFiniteNumber(value) { return typeof value === 'number' && Number.isFinite(value) }

    /**
     * Validate the tiny, secret-free provider-usage union the Host RPC
     * returns: windowed usage (Codex 5h/7d, OpenCode 5h/7d/1m), a DeepSeek
     * balance, or an explicit "nothing to show". Anything else is refused so a
     * provider never renders data shaped like another provider's.
     * @param {unknown} result - decoded Connection RPC result.
     * @returns {object|undefined} normalized usage, or nothing for an unexpected shape.
     */
    function readUsageResult(result) {
      if (result === null || typeof result !== 'object' || result.ok !== true) return undefined
      var value = result.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
      if (value.kind === 'windows') {
        // An empty list is a real answer, not a malformed one: it is what the
        // host sends for an account the upstream reports no window for. It has
        // to survive this gate, or the panel's "no windows" copy is
        // unreachable and that account reads as a transport failure instead.
        if (!Array.isArray(value.windows)) return undefined
        var windows = []
        for (var index = 0; index < value.windows.length; index++) {
          var window = value.windows[index]
          if (window === null || typeof window !== 'object'
            || typeof window.id !== 'string' || window.id.length === 0
            || !isFiniteNumber(window.usedPercent)
            || !isFiniteNumber(window.remainingPercent)) return undefined
          var normalized = {
            id: window.id,
            usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
            remainingPercent: Math.min(100, Math.max(0, window.remainingPercent)),
          }
          if (isFiniteNumber(window.resetsAt)) normalized.resetsAt = window.resetsAt
          windows.push(normalized)
        }
        return {
          kind: 'windows',
          provider: typeof value.provider === 'string' ? value.provider : undefined,
          planType: typeof value.planType === 'string' ? value.planType : undefined,
          windows: windows,
          fetchedAt: typeof value.fetchedAt === 'string' ? value.fetchedAt : undefined,
        }
      }
      if (value.kind === 'balance') {
        if (typeof value.isAvailable !== 'boolean' || !Array.isArray(value.balances)) return undefined
        var balances = []
        for (var b = 0; b < value.balances.length; b++) {
          var balance = value.balances[b]
          if (balance === null || typeof balance !== 'object' || typeof balance.totalBalance !== 'string') return undefined
          balances.push({
            currency: typeof balance.currency === 'string' ? balance.currency : undefined,
            totalBalance: balance.totalBalance,
            grantedBalance: typeof balance.grantedBalance === 'string' ? balance.grantedBalance : undefined,
            toppedUpBalance: typeof balance.toppedUpBalance === 'string' ? balance.toppedUpBalance : undefined,
          })
        }
        return {
          kind: 'balance',
          provider: typeof value.provider === 'string' ? value.provider : undefined,
          isAvailable: value.isAvailable,
          balances: balances,
          fetchedAt: typeof value.fetchedAt === 'string' ? value.fetchedAt : undefined,
        }
      }
      if (value.kind === 'none') {
        return { kind: 'none', provider: typeof value.provider === 'string' ? value.provider : undefined }
      }
      return undefined
    }

    /** @param {number} value @returns {string} compact percentage text. */
    function formatPercent(value) {
      var rounded = Math.round(value * 10) / 10
      return String(rounded)
    }

    /** @param {number} unixSeconds @param {string} language @returns {string} local reset time. */
    function formatResetTime(unixSeconds, language) {
      var date = new Date(unixSeconds * 1000)
      if (!Number.isFinite(date.getTime())) return '—'
      try {
        return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(date)
      } catch (_unsupportedDateStyle) {
        return date.toLocaleString()
      }
    }

    /** @param {object|undefined} usage @returns {object|undefined} the weekly window of a windows result. */
    function weeklyWindowOf(usage) {
      if (usage === undefined || usage === null || usage.kind !== 'windows') return undefined
      for (var index = 0; index < usage.windows.length; index++) {
        if (usage.windows[index].id === '7d') return usage.windows[index]
      }
      return undefined
    }

    /** @param {string} id @param {string} language @returns {string} the localized window label. */
    function windowLabel(id, language) {
      var text = TEXT[language] || TEXT.zh
      if (id === '5h') return text.window5h
      if (id === '7d') return text.window7d
      if (id === '1m') return text.window1m
      return id
    }

    /** @param {string|undefined} code @returns {string} the currency symbol, or the code itself. */
    function currencySymbol(code) {
      if (code === 'CNY') return '¥'
      if (code === 'USD') return '$'
      if (code === 'EUR') return '€'
      return code === undefined ? '' : code
    }

    /**
     * Pick the balance the chip shows: the account's CNY line when present,
     * then USD, then whatever the API listed first.
     * @param {object[]} balances @returns {object|undefined}
     */
    function preferredBalance(balances) {
      if (!Array.isArray(balances) || balances.length === 0) return undefined
      for (var index = 0; index < balances.length; index++) {
        if (balances[index].currency === 'CNY') return balances[index]
      }
      for (var index2 = 0; index2 < balances.length; index2++) {
        if (balances[index2].currency === 'USD') return balances[index2]
      }
      return balances[0]
    }

    /** @param {string|undefined} value @returns {string} the amount as reported, or a dash. */
    function amountText(value) {
      return typeof value === 'string' && value.length > 0 ? value : '—'
    }

    /** @param {object} routeState @returns {boolean} whether a quota number exists to show. */
    function quotaChipReady(routeState) {
      var usage = routeState === undefined ? undefined : routeState.usage
      if (usage === undefined || usage === null) return false
      if (usage.kind === 'windows') return usage.windows.length > 0
      if (usage.kind === 'balance') return usage.balances.length > 0
      return false
    }

    /**
     * The capsule text for one provider family. Windows show the remaining
     * percentage — one or both Codex windows, all three for OpenCode — and
     * DeepSeek shows the account balance. While loading or after a failure
     * the capsule reads "额度 …" / "额度 --" in the muted style.
     * @param {object} routeState - the per-route state slot.
     * @param {object} text - the active language copy.
     * @returns {string} the capsule text.
     */
    function quotaChipLabel(routeState, text) {
      var usage = routeState.usage
      if (usage !== undefined && usage !== null && usage.kind === 'windows' && usage.windows.length > 0) {
        var weekly = weeklyWindowOf(usage)
        if (weekly !== undefined && usage.windows.length === 1) {
          return text.quotaBadge.replace('{remaining}', formatPercent(weekly.remainingPercent))
        }
        return usage.windows.map(function (window) {
          return window.id + ' ' + formatPercent(window.remainingPercent) + '%'
        }).join(' · ')
      }
      if (usage !== undefined && usage !== null && usage.kind === 'balance') {
        var preferred = preferredBalance(usage.balances)
        if (preferred !== undefined) {
          return text.balanceTitle + ' ' + currencySymbol(preferred.currency) + amountText(preferred.totalBalance)
        }
      }
      return text.windowsTitle + (routeState.state === 'loading' ? ' …' : ' --')
    }

    /** @param {string|undefined} code @param {string} language @returns {string} localized usage failure. */
    function quotaFailureText(code, language) {
      var text = TEXT[language] || TEXT.zh
      if (code === 'signed-out') return text.quotaSignedOut
      if (code === 'auth' || code === 'credential') return text.quotaAuth
      if (code === 'timeout') return text.quotaTimeout
      if (code === 'rate-limited' || code === 'refresh-throttled') return text.quotaRateLimited
      if (code === 'no-credential') return text.quotaNoKey
      if (code === 'no-subscription') return text.quotaNoSubscription
      return text.quotaFailed
    }

    /**
     * Turn the staged edits into the write the seam should apply.
     *
     * One card save is one `mutate`, so the seam resolves and validates the
     * whole result once: either every edit lands or none does, and a refusal
     * names one reason rather than one per row. Ops address a single model,
     * so a model another writer added between this card's read and its write
     * survives untouched.
     * @param {unknown} user - the user layer as the Host reported it.
     * @param {Record<string, string>} drafts - staged field contents, by model id.
     * @param {object|undefined} modelSelection - staged allowlist set/unset intent.
     * @returns {object[]|undefined} the ops, or nothing when a draft is not a window or the selection is empty.
     */
    function buildOps(user, drafts, modelSelection) {
      var stored = overridesOf(user)
      var ops = []
      var ids = Object.keys(drafts).sort()
      for (var index = 0; index < ids.length; index++) {
        var id = ids[index]
        var parsed = parseWindow(drafts[id])
        if (parsed === undefined) return undefined
        var held = Object.prototype.hasOwnProperty.call(stored, id)
        if (parsed.kind === 'clear') {
          if (held) ops.push({ op: 'unset', path: ['modelOverrides', id] })
          continue
        }
        if (held && windowIn(stored, id) === parsed.value) continue
        ops.push({ op: 'set', path: ['modelOverrides', id, 'contextWindow'], value: parsed.value })
      }
      var modelOps = modelSelectionOps(user, modelSelection)
      if (modelOps === undefined) return undefined
      return ops.concat(modelOps)
    }

    // ── the observable the card renders from ──

    /**
     * The minimal `{getSnapshot, subscribe}` face the slot renderer turns into
     * a `use…` selector hook. One object per change, because the hook compares
     * snapshots by identity.
     * @param {object} initial - the first snapshot.
     * @returns {object} the store.
     */
    function createStore(initial) {
      var snapshot = initial
      var listeners = []
      return {
        getSnapshot: function () { return snapshot },
        subscribe: function (listener) {
          listeners.push(listener)
          return function () { listeners = listeners.filter(function (entry) { return entry !== listener }) }
        },
        set: function (next) {
          if (next === snapshot) return
          snapshot = next
          listeners.slice().forEach(function (listener) {
            try { listener() } catch (error) { console.error('[dsh-codex-lite] listener failed:', error) }
          })
        },
      }
    }

    // ── the controller ──

    /** @returns {object} one fresh per-route usage state slot. */
    function newUsageSlot() {
      return { usage: undefined, state: 'idle', failure: undefined, abort: undefined, generation: 0, background: false }
    }

    /**
     * Own the card's staged edits and the two conversations behind it: reads
     * from the settings scope, writes straight to the settings wire.
     *
     * The scope's own `set` is not used for writes. It addresses one top-level
     * field, while this card edits `modelOverrides.<model>.contextWindow`; and
     * it resolves without reporting why a write failed, while the whole point
     * of the host half's `validate` hook is to tell the operator which model
     * ids the catalog actually carries.
     * @param {object} scope - the bound settings scope.
     * @param {object} connection - API plus trusted generic RPC transport.
     * @param {object|undefined} locale - the locale service, when one is mounted.
     */
    function Controller(scope, connection, locale, mirror) {
      var self = this
      this.scope = scope
      this.connection = connection
      this.api = connection.api
      this.locale = locale
      // The shared describe mirror. `save` folds each write answer into it,
      // which is what advances the revision the next write fences on.
      this.mirror = mirror
      this.drafts = {}
      this.modelSelection = undefined
      this.catalog = []
      this.catalogState = 'idle'
      this.catalogPartial = false
      // One state slot per provider family; the usage/usageState/usageFailure
      // fields below mirror the Codex slot so the settings card keeps its reads.
      this.routes = {}
      USAGE_ROUTES.forEach(function (route) { self.routes[route] = newUsageSlot() })
      this.modelDirectoryFor = undefined
      this.disposed = false
      this.usagePollTimer = undefined
      this.failure = undefined
      this.saving = false
      this.store = createStore(this.project())
      this.face = {
        hooks: { codexCard: this.store },
        edit: function (model, text) { self.edit(model, text) },
        resetRow: function (model) { self.edit(model, '') },
        removeRow: function (model) { self.removeRow(model) },
        addRow: function (model) { self.addRow(model) },
        setModelEnabled: function (model, enabled) { self.setModelEnabled(model, enabled) },
        selectAllModels: function () { self.selectAllModels() },
        resetModels: function () { self.resetModels() },
        retryCatalog: function () { self.loadCatalog() },
        refreshUsage: function (provider) { return self.loadUsage(provider === undefined ? 'openai-codex' : provider, true) },
        loadUsage: function (provider, force) { return self.loadUsage(provider, force === true) },
        modelDirectoryFor: function (sessionId) {
          return self.modelDirectoryFor === undefined ? undefined : self.modelDirectoryFor(sessionId)
        },
        save: function () { return self.save() },
        discard: function () { self.discard() },
      }
    }

    Controller.prototype.language = function () {
      if (this.locale === undefined) return 'zh'
      try {
        var active = this.locale.getSnapshot().active
        return typeof active === 'string' && active.slice(0, 2).toLowerCase() === 'en' ? 'en' : 'zh'
      } catch (_localeUnavailable) {
        return 'zh'
      }
    }

    /**
     * The allowlist the card shows and writes back.
     *
     * Split out of {@link Controller#project} because a checkbox click needs
     * only this array, and reaching it through `project()` rebuilt every row,
     * badge and derived flag to throw all of them away.
     *
     * Every source lands on the same filter, so an id the installed catalog
     * outgrew can neither pad the "{enabled}/{total}" summary with a checkbox
     * that does not exist nor ride along into the next write. An allowlist
     * that survives none of the catalog selects all of it — the same answer
     * the host reaches for the same list.
     * @param {object} [snapshot] - the settings snapshot, when the caller already read one.
     * @returns {string[]} the selected ids, in catalog order.
     */
    Controller.prototype.selectedModels = function (snapshot) {
      var view = snapshot === undefined ? this.scope.getSnapshot() : snapshot
      var resolved = enabledModelsOf(view.value)
      var base = enabledModelsOf(view.base)
      var selected
      if (this.modelSelection === undefined) {
        selected = resolved.length > 0 ? resolved : base.length > 0 ? base : this.catalog
      } else if (this.modelSelection.kind === 'unset') {
        selected = base.length > 0 ? base : this.catalog
      } else {
        selected = this.modelSelection.ids
      }
      selected = orderModelIds(selected, this.catalog)
      return selected.length === 0 && this.catalog.length > 0 ? this.catalog.slice() : selected
    }

    /** @returns {object} the snapshot the card renders. */
    Controller.prototype.project = function () {
      var snapshot = this.scope.getSnapshot()
      var rows = rowsOf(snapshot.base, snapshot.user, this.drafts)
      var known = {}
      rows.forEach(function (row) { known[row.model] = true })
      var selectedModels = this.selectedModels(snapshot)
      var modelOps = modelSelectionOps(snapshot.user, this.modelSelection)
      var modelSelectionInvalid = modelOps === undefined
      var modelSelectionDirty = !modelSelectionInvalid && modelOps.length > 0
      return {
        available: snapshot.status === 'ready',
        writable: snapshot.writable === true,
        language: this.language(),
        rows: rows,
        addable: this.catalog.filter(function (id) { return known[id] !== true }),
        catalog: this.catalog.slice(),
        catalogState: this.catalogState,
        catalogFailed: this.catalogState === 'failed',
        catalogPartial: this.catalogPartial,
        selectedModels: selectedModels,
        modelSelectionDirty: modelSelectionDirty,
        modelSelectionInvalid: modelSelectionInvalid,
        modelCanReset: hasEnabledModels(snapshot.user) || this.modelSelection !== undefined,
        usage: this.routes.codex.usage,
        usageState: this.routes.codex.state,
        usageFailure: this.routes.codex.failure,
        routes: this.routes,
        dirty: Object.keys(this.drafts).length > 0 || modelSelectionDirty,
        invalid: rows.some(function (row) { return row.invalid }) || modelSelectionInvalid,
        saving: this.saving,
        failure: this.failure,
      }
    }

    Controller.prototype.publish = function () { this.store.set(this.project()) }

    Controller.prototype.edit = function (model, text) {
      this.drafts[model] = text
      this.failure = undefined
      this.publish()
    }

    Controller.prototype.addRow = function (model) {
      var id = String(model).trim()
      if (id === '' || Object.prototype.hasOwnProperty.call(this.drafts, id)) return
      this.drafts[id] = ''
      this.failure = undefined
      this.publish()
    }

    Controller.prototype.removeRow = function (model) {
      delete this.drafts[model]
      this.failure = undefined
      this.publish()
    }

    Controller.prototype.discard = function () {
      this.drafts = {}
      this.modelSelection = undefined
      this.failure = undefined
      this.publish()
    }

    /** @param {string} model @param {boolean} enabled - stage one checkbox change. */
    Controller.prototype.setModelEnabled = function (model, enabled) {
      if (!this.catalog.includes(model)) return
      var selected = this.selectedModels().slice()
      var has = selected.includes(model)
      if (enabled === has) return
      if (!enabled && selected.length <= 1) return
      selected = enabled ? selected.concat(model) : selected.filter(function (id) { return id !== model })
      this.modelSelection = { kind: 'set', ids: orderModelIds(selected, this.catalog) }
      this.failure = undefined
      this.publish()
    }

    /** Stage an explicit all-model allowlist. */
    Controller.prototype.selectAllModels = function () {
      if (this.catalog.length === 0) return
      this.modelSelection = { kind: 'set', ids: this.catalog.slice() }
      this.failure = undefined
      this.publish()
    }

    /** Stage removal of the user allowlist, returning to the composition default. */
    Controller.prototype.resetModels = function () {
      this.modelSelection = { kind: 'unset' }
      this.failure = undefined
      this.publish()
    }

    /**
     * Load the catalog's model ids, so the add row and visibility list can offer them.
     *
     * The picker offers these ids and nothing else, so a catalog that does not
     * arrive is not a missing convenience but a picker with nothing in it —
     * indistinguishable, without this state, from having already added every
     * model. It therefore fails loudly enough to be retried, and the button
     * says which of the two happened.
     */
    Controller.prototype.finishCatalog = function (ids, partial) {
      if (this.disposed) return false
      var catalog = enabledModelsOf({ enabledModels: ids })
      if (catalog.length === 0) return false
      this.catalog = catalog
      this.catalogPartial = partial === true
      this.catalogState = 'ready'
      this.publish()
      return true
    }

    /**
     * Fall back when the catalog RPC cannot answer.
     *
     * `baseCatalog` is the composition entry's allowlist — a NARROWING, not a
     * catalog — so it must never be tried first: a deployment that ships one
     * model would render exactly that one model and lock the user out of
     * re-enabling the rest, which is the whole thing the RPC was added to
     * prevent. `api.llm.models` is narrowed too (SelectivePiAiAdapter filters
     * the very list it reads), so neither source is authoritative here. Take
     * the union of what both know, mark the result partial so the card can
     * say the list may be short, and keep the base as the last resort rather
     * than the first.
     */
    Controller.prototype.loadLegacyCatalog = function (baseCatalog, reason, detail) {
      var self = this
      var request
      try {
        request = this.api.llm.models({})
      } catch (error) {
        if (baseCatalog.length > 0 && this.finishCatalog(baseCatalog, true)) return
        this.failCatalog(reason || 'unavailable', detail || error)
        return
      }
      Promise.resolve(request).then(function (response) {
        if (self.disposed) return
        var result = response === undefined ? undefined : response.result
        if (result === undefined || !result.ok) {
          if (baseCatalog.length > 0 && self.finishCatalog(baseCatalog, true)) return
          self.failCatalog(reason || 'refused', (result && result.error) || detail)
          return
        }
        var groups = result.value && result.value.groups
        var group
        if (Array.isArray(groups)) {
          for (var index = 0; index < groups.length; index++) {
            if (groups[index] && groups[index].id === OPENAI_CODEX_ROUTE) group = groups[index]
          }
        }
        var models = group === undefined ? undefined : group.models
        if (!Array.isArray(models)) {
          if (baseCatalog.length > 0 && self.finishCatalog(baseCatalog, true)) return
          self.failCatalog('carries no ' + OPENAI_CODEX_ROUTE + ' models', groups)
          return
        }
        var ids = models
          .map(function (model) { return model === null || typeof model !== 'object' ? undefined : model.id })
          .filter(function (id) { return typeof id === 'string' && id.length > 0 })
        baseCatalog.forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id) })
        if (!self.finishCatalog(ids, true)) self.failCatalog('carries no ' + OPENAI_CODEX_ROUTE + ' models', groups)
      }).catch(function (error) {
        if (self.disposed) return
        if (baseCatalog.length > 0 && self.finishCatalog(baseCatalog, true)) return
        self.failCatalog('request failed', error)
      })
    }

    Controller.prototype.loadCatalog = function () {
      var self = this
      if (this.disposed || this.catalogState === 'loading') return
      var baseCatalog = enabledModelsOf(this.scope.getSnapshot().base)
      this.catalogState = 'loading'
      this.publish()
      var abort = new AbortController()
      this.catalogAbort = abort
      var timer = setTimeout(function () { abort.abort() }, CODEX_USAGE_TIMEOUT_MS)
      var request
      try {
        request = this.connection.rpc.call(CODEX_USAGE_CHANNEL, CODEX_CATALOG_METHOD, {}, abort.signal)
      } catch (error) {
        clearTimeout(timer)
        this.catalogAbort = undefined
        this.loadLegacyCatalog(baseCatalog, 'unavailable', error)
        return
      }
      Promise.resolve(request).then(function (response) {
        if (self.disposed) return
        var result = response === undefined ? undefined : response.result === undefined ? response : response.result
        var models = result && result.ok && result.value && result.value.models
        if (!Array.isArray(models) || !self.finishCatalog(models)) {
          self.loadLegacyCatalog(baseCatalog, 'refused', result && result.error)
        }
      }).catch(function (error) {
        if (!self.disposed) self.loadLegacyCatalog(baseCatalog, 'request failed', error)
      }).finally(function () {
        clearTimeout(timer)
        if (self.catalogAbort === abort) self.catalogAbort = undefined
      })
    }

    /**
     * Record that the model list did not arrive, and say so once in the
     * console for whoever is looking at one.
     * @param {string} reason - what went wrong, for the console line.
     * @param {unknown} detail - the underlying value, for the console line.
     */
    Controller.prototype.failCatalog = function (reason, detail) {
      // A disposed controller has no store left to publish into and no reader
      // for the warning; a late answer arriving after unmount is expected, not
      // a fault worth a console line.
      if (this.disposed) return
      console.warn('[dsh-codex-lite] model catalog ' + reason + ':', detail)
      this.catalogState = 'failed'
      this.publish()
    }

    /**
     * Read one provider family's normalized usage over the trusted Connection
     * RPC. Each route slot carries its own generation and abort, so a late
     * answer for a provider the session has switched away from is dropped
     * rather than shown under the wrong provider.
     *
     * `background` marks a read nobody asked for — the poll. The panel reads
     * it to decide whether it may replace good numbers with a placeholder.
     * @param {string} provider - the provider route to read.
     * @param {boolean} force - bypass the Host's account cache.
     * @param {boolean} [background] - true for the poll, false for a read a reader asked for.
     * @returns {Promise<void>} settles when the slot has been published.
     */
    Controller.prototype.loadUsage = function (provider, force, background) {
      var self = this
      var route = typeof provider === 'string' ? PROVIDER_ROUTES[provider] : undefined
      if (this.disposed || route === undefined) return Promise.resolve()
      var slot = this.routes[route]
      // Two reads of one route collapse into one, except when a reader forces
      // a refresh over a poll: joining that read would answer the click with
      // the cached numbers the poll asked for.
      if (slot.state === 'loading' && !(force === true && slot.background === true)) return Promise.resolve()
      slot.state = 'loading'
      slot.background = background === true
      slot.failure = undefined
      this.publish()
      if (slot.abort !== undefined) slot.abort.abort()
      var abort = new AbortController()
      var generation = ++slot.generation
      slot.abort = abort
      var timer = setTimeout(function () { abort.abort() }, CODEX_USAGE_TIMEOUT_MS)
      var request
      try {
        request = this.connection.rpc.call(
          CODEX_USAGE_CHANNEL,
          CODEX_USAGE_METHOD,
          { provider: provider, force: force === true },
          abort.signal,
        )
      } catch (_requestFailed) {
        clearTimeout(timer)
        slot.abort = undefined
        slot.state = 'failed'
        slot.failure = 'unavailable'
        this.publish()
        return Promise.resolve()
      }
      return Promise.resolve(request).then(function (result) {
        if (self.disposed || generation !== slot.generation) return
        var code = result && result.error && typeof result.error.code === 'string' ? result.error.code : undefined
        if (!result || result.ok !== true) {
          slot.state = 'failed'
          slot.failure = code || 'unavailable'
          self.publish()
          return
        }
        var usage = readUsageResult(result)
        if (usage === undefined) {
          slot.state = 'failed'
          slot.failure = 'invalid-response'
          self.publish()
          return
        }
        slot.usage = usage
        slot.state = 'ready'
        slot.failure = undefined
        self.publish()
      }).catch(function () {
        if (self.disposed || generation !== slot.generation) return
        slot.state = 'failed'
        slot.failure = abort.signal.aborted ? 'timeout' : 'unavailable'
        self.publish()
      }).finally(function () {
        clearTimeout(timer)
        if (generation === slot.generation) slot.abort = undefined
      })
    }

    /**
     * Schedule the next Codex quota read after the previous one has settled.
     * A one-shot timer prevents a slow upstream response from stacking polls,
     * while an ordinary read preserves the Host's account-scoped cache.
     */
    Controller.prototype.scheduleCodexUsagePoll = function () {
      var self = this
      if (this.disposed || this.usagePollTimer !== undefined
        || scheduleUsagePoll === undefined || cancelUsagePoll === undefined) return
      this.usagePollTimer = scheduleUsagePoll(function () {
        self.usagePollTimer = undefined
        if (self.disposed) return
        void self.loadUsage('openai-codex', false, true).finally(function () {
          self.scheduleCodexUsagePoll()
        })
      }, CODEX_USAGE_POLL_MS)
      var timer = this.usagePollTimer
      if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    }

    /** Stop the quota poll and every pending usage read, making late completions inert. */
    Controller.prototype.dispose = function () {
      var self = this
      this.disposed = true
      if (this.usagePollTimer !== undefined) {
        cancelUsagePoll(this.usagePollTimer)
        this.usagePollTimer = undefined
      }
      if (this.catalogAbort !== undefined) {
        this.catalogAbort.abort()
        this.catalogAbort = undefined
      }
      USAGE_ROUTES.forEach(function (route) {
        var slot = self.routes[route]
        slot.generation++
        if (slot.abort !== undefined) slot.abort.abort()
        slot.abort = undefined
      })
    }

    Controller.prototype.save = function () {
      var self = this
      if (this.saving) return Promise.resolve()
      var snapshot = this.scope.getSnapshot()
      var ops = buildOps(snapshot.user, this.drafts, this.modelSelection)
      var text = TEXT[this.language()]
      if (ops === undefined) {
        // `buildOps` refuses for two unrelated reasons — an unparseable window
        // or an allowlist with nothing left in it — and telling someone who
        // emptied the checkbox grid to "enter a whole number" is the wrong
        // half of the truth.
        this.failure = modelSelectionOps(snapshot.user, this.modelSelection) === undefined
          ? text.modelsEmpty
          : text.invalid
        this.publish()
        return Promise.resolve()
      }
      if (ops.length === 0) {
        this.discard()
        return Promise.resolve()
      }
      this.saving = true
      this.failure = undefined
      this.publish()
      var payload = { ns: SETTINGS_NS, ops: ops }
      if (snapshot.revision !== undefined) payload.expectedRevision = snapshot.revision
      return Promise.resolve().then(function () { return self.api.settings.mutate(payload) }).then(function (response) {
        if (response !== undefined && response.result !== undefined && response.result.ok) {
          // The answer to a settings write IS the namespace's new view, so the
          // Host folds it into the shared mirror rather than paying for a read
          // that would only fetch back what it was just told. Doing the same
          // here is what advances the revision this card fences on. It lands
          // synchronously — the mirror notifies without batching and the scope
          // derives in that notification — so by the line below, the next save
          // already fences on what this one produced, and there is no window
          // between answering and being current for a second write to fall
          // into. A refusal needs no fold: a rejected write moved nothing, and
          // a conflict means someone else moved it, which reaches the mirror
          // as the Host's own document-updated signal.
          try {
            self.mirror.acceptView(response.result.value)
          } catch (_foldRefused) {
            // Not this card's to repair: the same signal arrives for every
            // committed write, so the mirror still converges — one round trip
            // later than it needed to. Swallowing keeps a Host-side throw from
            // stranding the card mid-save.
          }
          self.drafts = {}
          self.modelSelection = undefined
          self.failure = undefined
        } else {
          var error = response && response.result ? response.result.error : undefined
          // A conflict is the operator's to resolve, so it gets copy of its
          // own; everything else is the seam's own sentence, which for a
          // refused model id already lists every id the catalog carries.
          self.failure = error === undefined
            ? text.offline
            : error.code === 'settings-conflict' ? text.conflict : error.message
        }
        self.saving = false
        self.publish()
      }, function () {
        self.saving = false
        self.failure = text.offline
        self.publish()
      })
    }

    // ── the card ──

    /**
     * Lazily resolve the per-session model directory service, exactly once.
     * The service is not a declared dependency: reading it here is a soft
     * probe, so a web shell without the model-selection plugin costs only the
     * chip's provider switch, never this plugin's settings card.
     * @param {object} ctx - the scoped browser context.
     * @returns {() => object|undefined} the service resolver.
     */
    function modelDirectoriesOf(ctx) {
      var service
      return function () {
        // Memoize the HIT, never the miss. The chip can render before the
        // model-selection plugin has mounted, and a miss cached at that moment
        // would keep the chip off the header for the life of the page — only a
        // reload could recover it. A miss is cheap to re-ask.
        if (service !== undefined) return service
        try { service = ctx.get('modelDirectories') } catch (_missingService) { service = undefined }
        if (service === null) service = undefined
        return service
      }
    }

    /**
     * Per-session handles onto the shared model directory store, so the chip
     * can subscribe to model switches. A session without a directory scope —
     * or a harness without the service — gets the empty stand-in and renders
     * no chip, which is the whole recovery.
     * @param {() => object|undefined} resolveService - the lazy service probe.
     */
    function ModelTracker(resolveService) {
      this.resolveService = resolveService
      this.cache = new Map()
    }

    ModelTracker.prototype.directoryFor = function (sessionId) {
      var service = this.resolveService()
      if (service === undefined || sessionId === undefined || sessionId === null) return undefined
      var key = String(sessionId)
      // Ask the service every time and key the cache on the directory's own
      // identity. The harness disposes a session's directory when its scope
      // tears down and builds a fresh one on the way back, and a disposed one
      // stops notifying — so a wrapper cached by session id alone would leave
      // the chip subscribed to a dead store, frozen on the model state from
      // the previous visit. The cache still does its job: while the directory
      // is the same object the wrapper is too, which is what keeps
      // `useSyncExternalStore` from resubscribing on every render.
      var directory
      try {
        directory = service.directoryFor(sessionId)
        if (directory === null || directory === undefined || directory.store === undefined) directory = undefined
      } catch (_scopeFailed) {
        directory = undefined
      }
      if (directory === undefined) {
        // No scope registered yet is a timing miss, not a verdict. Answer the
        // stand-in without storing it, so the next render can find the real
        // one instead of inheriting this moment forever.
        this.cache.delete(key)
        return EMPTY_DIRECTORY
      }
      var cached = this.cache.get(key)
      if (cached !== undefined && cached.source === directory) return cached.entry
      var entry
      try {
        var store = directory.store
        entry = {
          getSnapshot: function () {
            try { return store.getSnapshot() } catch (_snapshotFailed) { return EMPTY_MODEL_SNAPSHOT }
          },
          subscribe: function (listener) {
            try { return store.subscribe(listener) } catch (_subscribeFailed) { return function () {} }
          },
          ensureLoaded: function () {
            // The store fills once load() has run — the model seat and the
            // /model popup trigger it on open, but a fresh page whose composer
            // was never opened would otherwise never learn its provider.
            try {
              var snapshot = store.getSnapshot()
              if (snapshot === null || snapshot === undefined || snapshot.status !== 'idle') return
              var pending = directory.load()
              if (pending !== undefined && pending !== null && typeof pending.catch === 'function') {
                pending.catch(function () { /* the next open remains the retry surface */ })
              }
            } catch (_loadFailed) { /* stay invisible rather than throw inside the slot */ }
          },
        }
      } catch (_wrapFailed) {
        return EMPTY_DIRECTORY
      }
      if (this.cache.size >= 128) this.cache.clear()
      this.cache.set(key, { source: directory, entry: entry })
      return entry
    }

    /** One usage-window row: remaining first, used and reset beneath it. */
    function windowRowElement(window, text, language) {
      var h = React.createElement
      var remaining = formatPercent(window.remainingPercent)
      var used = formatPercent(window.usedPercent)
      return h('div', { key: window.id, className: 'dcl-window' },
        h('div', { className: 'dcl-quotaNumbers' },
          h('strong', { className: 'dcl-quotaFigure' }, text.remainingLabel.replace('{remaining}', remaining)),
          h('span', { className: 'dcl-quotaSub' }, text.usedLabel.replace('{used}', used))),
        h('div', {
          className: 'dcl-quotaTrack',
          role: 'progressbar',
          'aria-label': windowLabel(window.id, language),
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': window.usedPercent,
        }, h('span', { className: 'dcl-quotaFill', style: { width: window.usedPercent + '%' } })),
        window.resetsAt === undefined
          ? null
          : h('p', { className: 'dcl-quotaReset' },
            text.resetsLabel.replace('{time}', formatResetTime(window.resetsAt, language))))
    }

    /**
     * Whether a read in flight is one the panel should show as in flight.
     * The poll is not: replacing good numbers with a placeholder every thirty
     * seconds reads as a fault, and what it would erase is still the truth
     * until the new answer lands. A poll with nothing on screen yet has
     * nothing to protect, so it shows the placeholder like any other read.
     * @param {object} routeState - one per-route state slot.
     * @param {boolean} hasContent - whether the slot still holds numbers to show.
     * @returns {boolean} true when the panel should read as loading.
     */
    function usageReadShows(routeState, hasContent) {
      if (routeState.state !== 'loading') return false
      return routeState.background !== true || !hasContent
    }

    /**
     * The windowed-usage panel: the one markup the settings card (Codex
     * 5h/7d) and the session chip (Codex 5h/7d, OpenCode 5h/7d/1m) share,
     * so the two surfaces cannot drift apart.
     * @param {object} routeState - one per-route state slot.
     * @param {object} text - the active language copy.
     * @param {() => void} onRefresh - the forced-refresh action.
     * @param {string} language - the active language key.
     * @returns {object} the panel element.
     */
    function windowsPanelElement(routeState, text, onRefresh, language) {
      var h = React.createElement
      var usage = routeState.usage
      var windows = usage !== undefined && usage !== null && usage.kind === 'windows' ? usage.windows : []
      var busy = usageReadShows(routeState, windows.length > 0)
      var content
      if (busy) {
        content = [h('p', { key: 'empty', className: 'dcl-quotaEmpty', role: 'status' }, text.quotaLoading)]
      } else if ((routeState.state === 'ready' || routeState.state === 'loading') && windows.length > 0) {
        content = windows.map(function (window) { return windowRowElement(window, text, language) })
        if (routeState.failure !== undefined) {
          content.push(h('p', { key: 'failure', className: 'dcl-quotaFailure', role: 'status' },
            quotaFailureText(routeState.failure, language)))
        }
      } else if (routeState.state === 'ready') {
        content = [h('p', { key: 'empty', className: 'dcl-quotaEmpty', role: 'status' }, text.quotaNoWindows)]
      } else {
        content = [h('p', { key: 'empty', className: 'dcl-quotaEmpty', role: 'status' },
          quotaFailureText(routeState.failure, language))]
      }
      return h('section', { className: 'dcl-quota', 'aria-label': text.windowsTitle },
        h('div', { className: 'dcl-quotaHead' },
          h('span', { className: 'dcl-quotaTitle' }, text.windowsTitle),
          usage !== undefined && usage !== null && usage.kind === 'windows' && usage.planType
            ? h('span', { className: 'dcl-plan' }, usage.planType.toUpperCase())
            : null,
          h('button', {
            type: 'button',
            className: 'dcl-refresh',
            disabled: busy,
            onClick: onRefresh,
          }, busy ? text.refreshing : text.refresh)),
        content)
    }

    /** The DeepSeek balance panel: every currency the API reported. */
    function balancePanelElement(routeState, text, onRefresh, language) {
      var h = React.createElement
      var usage = routeState.usage
      var balances = usage !== undefined && usage !== null && usage.kind === 'balance' ? usage.balances : []
      var busy = usageReadShows(routeState, balances.length > 0)
      var content
      if (busy) {
        content = [h('p', { key: 'empty', className: 'dcl-quotaEmpty', role: 'status' }, text.quotaLoading)]
      } else if (routeState.state === 'ready' || routeState.state === 'loading') {
        content = balances.map(function (balance, index) {
          return h('div', { key: index, className: 'dcl-window' },
            h('div', { className: 'dcl-quotaNumbers' },
              h('strong', { className: 'dcl-quotaFigure' },
                currencySymbol(balance.currency) + ' ' + amountText(balance.totalBalance)),
              h('span', { className: 'dcl-quotaSub' }, balance.currency)),
            balance.toppedUpBalance === undefined && balance.grantedBalance === undefined
              ? null
              : h('p', { className: 'dcl-quotaReset' },
                [balance.toppedUpBalance === undefined ? null : text.balanceToppedUp.replace('{value}', balance.toppedUpBalance),
                  balance.grantedBalance === undefined ? null : text.balanceGranted.replace('{value}', balance.grantedBalance)]
                  .filter(Boolean).join(' · ')))
        })
        if (usage.isAvailable !== true) {
          content.push(h('p', { key: 'unavailable', className: 'dcl-quotaFailure', role: 'status' }, text.balanceUnavailable))
        }
        if (routeState.failure !== undefined) {
          content.push(h('p', { key: 'failure', className: 'dcl-quotaFailure', role: 'status' },
            quotaFailureText(routeState.failure, language)))
        }
      } else {
        content = [h('p', { key: 'empty', className: 'dcl-quotaEmpty', role: 'status' },
          quotaFailureText(routeState.failure, language))]
      }
      return h('section', { className: 'dcl-quota', 'aria-label': text.balanceTitle },
        h('div', { className: 'dcl-quotaHead' },
          h('span', { className: 'dcl-quotaTitle' }, text.balanceTitle),
          h('button', {
            type: 'button',
            className: 'dcl-refresh',
            disabled: busy,
            onClick: onRefresh,
          }, busy ? text.refreshing : text.refresh)),
        content)
    }

    /** @param {string} route @param {object} routeState @param {object} text @param {string} language @param {() => void} onRefresh @returns {object} the panel for one route. */
    function chipPanelElement(route, routeState, text, language, onRefresh) {
      if (route === 'deepseek') return balancePanelElement(routeState, text, onRefresh, language)
      return windowsPanelElement(routeState, text, onRefresh, language)
    }

    /**
     * The session-header quota chip: the same usage store the settings card
     * renders, as a capsule beside the session title. Clicking opens the
     * shared quota panel in a small popover, so the header shows a one-line
     * hint and the details stay one click away. It is a hint, not a control
     * surface: a failed read shows the muted placeholder and the popover's
     * refresh button doubles as retry.
     * @param {object} props - the injected face, with `hooks` bound to selectors.
     * @returns {object} the chip and its popover.
     */
    function SessionQuotaChip(props) {
      var h = React.createElement
      var state = props.useCodexCard(function (snapshot) { return snapshot })
      var directory = props.modelDirectoryFor(props.sessionId)
      var dir = directory === undefined ? EMPTY_DIRECTORY : directory
      // Both arguments have to be stable across renders, not just correct.
      // React resubscribes whenever `subscribe` changes identity, and this
      // component re-renders on every controller publish — which includes each
      // keystroke in the context-window field, since the card and the chip
      // share one store. A fresh closure per render would churn a
      // subscribe/unsubscribe pair on the session's model store per character.
      var subscribeModels = React.useCallback(function (listener) { return dir.subscribe(listener) }, [dir])
      var readModels = React.useCallback(function () { return dir.getSnapshot() }, [dir])
      var modelState = React.useSyncExternalStore(subscribeModels, readModels)
      var sessionId = props.sessionId
      React.useEffect(function () {
        if (directory === undefined) return undefined
        directory.ensureLoaded()
      }, [directory, sessionId])
      var toggle = React.useState(false)
      var isOpen = toggle[0]
      var setOpen = toggle[1]
      var rootRef = React.useRef(null)
      // Close on any outside press, the way the shipped menus do; the popover
      // is not a modal, so the session keeps working while it is open.
      React.useEffect(function () {
        if (!isOpen) return undefined
        function onPointerDown(event) {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        return function () { document.removeEventListener('pointerdown', onPointerDown) }
      }, [isOpen])
      var current = modelState === null || modelState === undefined ? null : modelState.current
      var provider = current === null || current === undefined ? undefined : current.provider
      var route = typeof provider === 'string' ? PROVIDER_ROUTES[provider] : undefined
      var routeState = route === undefined ? undefined : state.routes[route]
      var loadUsage = props.loadUsage
      // The Codex slot loads with the settings card; the other two load the
      // first time a session actually selects their provider.
      React.useEffect(function () {
        if (route === undefined || routeState === undefined) return undefined
        if (routeState.state !== 'idle') return undefined
        void loadUsage(provider, false)
      }, [route, routeState, loadUsage, provider])
      // A provider this plugin does not answer for renders nothing at all —
      // showing Codex numbers next to a GLM session would be worse than empty.
      if (route === undefined || routeState === undefined) return null
      var text = TEXT[state.language]
      var label = quotaChipLabel(routeState, text)
      var ready = quotaChipReady(routeState)
      return h('span', { className: 'dcl-chipWrap', ref: rootRef },
        h('button', {
          type: 'button',
          className: ready ? 'dcl-chip' : 'dcl-chip dcl-chipMuted',
          'aria-haspopup': 'dialog',
          'aria-expanded': isOpen,
          'aria-label': provider,
          title: label,
          onClick: function () { setOpen(!isOpen) },
        }, label),
        isOpen
          ? h('div', { className: 'dcl-chipPopover', role: 'dialog', 'aria-label': provider },
            chipPanelElement(route, routeState, text, state.language, function () { void props.refreshUsage(provider) }))
          : null)
    }

    /**
     * Render the allowlist editor. It is deliberately separate from the context
     * rows: visibility is one top-level setting, while context fields remain
     * per-model overrides and can include hidden models.
     * @param {object} state - projected card state.
     * @param {object} text - localized copy.
     * @param {boolean} busy - whether writes are unavailable.
     * @param {object} props - controller face callbacks.
     * @returns {object} model selection section.
     */
    function modelSelectionElement(state, text, busy, props) {
      var h = React.createElement
      if (state.catalogState === 'loading' || state.catalogState === 'idle') {
        return h('section', { className: 'dcl-models', 'aria-label': text.models },
          h('div', { className: 'dcl-modelHead' },
            h('span', { className: 'dcl-label' }, text.models),
            h('span', { className: 'dcl-modelSummary', role: 'status' }, text.modelsLoading)))
      }
      if (state.catalogState === 'failed') {
        return h('section', { className: 'dcl-models', 'aria-label': text.models },
          h('div', { className: 'dcl-modelHead' },
            h('span', { className: 'dcl-label' }, text.models),
            h('button', {
              type: 'button',
              className: 'dcl-reset',
              disabled: busy,
              onClick: props.retryCatalog,
            }, text.catalogFailed)))
      }
      var selected = new Set(state.selectedModels)
      var summary = text.modelSummary
        .replace('{enabled}', String(selected.size))
        .replace('{total}', String(state.catalog.length))
      var allSelected = state.catalog.length > 0 && state.catalog.every(function (id) { return selected.has(id) })
      return h('section', { className: 'dcl-models', 'aria-label': text.models },
        h('div', { className: 'dcl-modelHead' },
          h('span', { className: 'dcl-label' }, text.models),
          h('span', { className: 'dcl-modelSummary' }, summary)),
        h('div', { className: 'dcl-modelActions' },
          h('button', {
            type: 'button',
            className: 'dcl-reset',
            disabled: busy || allSelected,
            onClick: props.selectAllModels,
          }, text.selectAll),
          h('button', {
            type: 'button',
            className: 'dcl-reset',
            disabled: busy || !state.modelCanReset,
            onClick: props.resetModels,
          }, text.resetModels)),
        h('div', { className: 'dcl-modelGrid', role: 'group', 'aria-label': text.models },
          state.catalog.map(function (id) {
            var checked = selected.has(id)
            return h('label', { key: id, className: checked ? 'dcl-modelOption dcl-modelOptionChecked' : 'dcl-modelOption' },
              h('input', {
                type: 'checkbox',
                checked: checked,
                disabled: busy || (checked && selected.size <= 1),
                onChange: function (event) { props.setModelEnabled(id, event.target.checked) },
              }),
              h('span', { className: 'dcl-modelName' }, id))
          })),
        state.catalogPartial
          ? h('p', { className: 'dcl-quotaFailure', role: 'status' }, text.modelsPartial)
          : null,
        h('p', { className: 'dcl-hint' }, text.modelsHint),
        state.modelSelectionInvalid ? h('p', { className: 'dcl-invalid', role: 'alert' }, text.modelsEmpty) : null)
    }

    /**
     * @param {object} props - the injected face, with `hooks` bound to selectors.
     * @returns {object|null} the card, or nothing when this deployment does not serve the section.
     */
    function CodexCard(props) {
      var state = props.useCodexCard(function (snapshot) { return snapshot })
      var disclosure = React.useState(false)
      var isOpen = disclosure[0]
      var setOpen = disclosure[1]
      var picking = React.useState(false)
      var isPicking = picking[0]
      var setPicking = picking[1]
      // A namespace this deployment does not serve, or a section the Host
      // could not prove secret-free, has nothing to edit. Rendering a dead
      // card would be worse than rendering none.
      if (!state.available) return null
      var text = TEXT[state.language]
      var h = React.createElement
      var busy = !state.writable || state.saving
      // The collapsed badge reads the same windows the session chip does,
      // so an account with both windows shows both, and one with only the
      // weekly allowance keeps the single-window copy.
      var quotaBadge = quotaChipLabel(state.routes.codex, text)
      var quotaPanel = windowsPanelElement(state.routes.codex, text, function () { void props.refreshUsage() }, state.language)

      var modelSelector = modelSelectionElement(state, text, busy, props)

      var fields = state.rows.map(function (row) {
        var fieldId = 'dcl-window-' + row.model
        // A row says where its value came from the way the shipped fields do:
        // a solid badge for one this card wrote, a muted one for a value that
        // arrived from elsewhere, and nothing at all for an untouched default.
        var marks = []
        if (row.source === 'user') {
          marks.push(h('span', { key: 'badge', className: 'dcl-badge' }, text.sourceUser))
        } else if (row.source === 'base') {
          marks.push(h('span', { key: 'badge', className: 'dcl-badgeMuted' }, text.sourceBase))
        }
        if (row.action !== 'locked') {
          marks.push(h('button', {
            key: 'action',
            type: 'button',
            className: 'dcl-reset',
            disabled: busy,
            onClick: function () {
              if (row.action === 'remove') props.removeRow(row.model)
              else props.resetRow(row.model)
            },
          }, row.action === 'remove' ? text.remove : text.clear))
        }
        return h('div', { key: row.model, className: 'dcl-field' },
          h('div', { className: 'dcl-head' },
            h('label', { className: 'dcl-label', htmlFor: fieldId }, row.model),
            marks.length === 0 ? null : h('span', { className: 'dcl-badges' }, marks)),
          h('input', {
            id: fieldId,
            className: row.invalid ? 'dcl-input dcl-inputInvalid' : 'dcl-input',
            type: 'text',
            inputMode: 'numeric',
            spellCheck: false,
            value: row.text,
            placeholder: text.placeholder,
            disabled: busy,
            'aria-invalid': row.invalid ? true : undefined,
            onChange: function (event) { props.edit(row.model, event.target.value) },
          }),
          hintsOf(row, state.language).map(function (line, index) {
            return h('p', { key: index, className: line.error ? 'dcl-invalid' : 'dcl-hint' }, line.text)
          }))
      })

      // Three states, because an empty picker has two very different causes:
      // every model is already on the card, or the list never arrived. The
      // second is the one the operator can act on, so it says so and the
      // button retries instead of opening an empty menu.
      var addable = state.addable
      var catalogFailed = state.catalogFailed === true && addable.length === 0
      var addField = h('div', { className: 'dcl-field' },
        h('div', { className: 'dcl-head' },
          h('span', { className: 'dcl-label' }, text.addLabel),
          h(Menu, {
            open: isPicking,
            onClose: function () { setPicking(false) },
            items: addable.map(function (id) { return { id: id, label: id } }),
            onSelect: function (id) { props.addRow(id); setPicking(false) },
            align: 'end',
            portal: true,
            anchor: h('button', {
              type: 'button',
              className: 'dcl-selector',
              'aria-haspopup': catalogFailed ? undefined : 'menu',
              'aria-expanded': catalogFailed ? undefined : isPicking,
              disabled: busy || (!catalogFailed && addable.length === 0),
              onClick: function () {
                if (catalogFailed) props.retryCatalog()
                else setPicking(!isPicking)
              },
            }, catalogFailed ? text.catalogFailed : addable.length === 0 ? text.allAdded : text.pick,
            h(ChevronIcon, { className: 'dcl-chevron' })),
          })))

      return h('li', { className: isOpen ? 'dcl-card dcl-cardOpen' : 'dcl-card' },
        h('button', {
          type: 'button',
          className: 'dcl-header',
          'aria-expanded': isOpen,
          'aria-label': (isOpen ? text.collapse : text.expand) + ': ' + text.title,
          onClick: function () { setOpen(!isOpen) },
        },
        h('span', { className: 'dcl-headText' },
          h('span', { className: 'dcl-name' }, text.title),
          h('span', { className: 'dcl-description' }, text.description)),
        h('span', { className: quotaChipReady(state.routes.codex) ? 'dcl-quotaBadge' : 'dcl-quotaBadge dcl-quotaBadgeMuted' }, quotaBadge),
        state.dirty ? h('span', { className: 'dcl-pending' }, text.unsaved) : null,
        React.createElement(ChevronIcon, { className: isOpen ? 'dcl-chevron dcl-chevronOpen' : 'dcl-chevron' })),
        isOpen
          ? h('div', { className: 'dcl-body' },
            state.writable ? null : h('p', { className: 'dcl-readOnly', role: 'status' }, text.readOnly),
            quotaPanel,
            modelSelector,
            fields,
            addField,
            h('p', { className: 'dcl-note' }, text.note),
            h('div', { className: 'dcl-footer' },
              state.failure === undefined
                ? null
                : h('p', { className: 'dcl-failed', role: 'status' }, state.failure),
              h('button', {
                type: 'button',
                className: 'dcl-discard',
                disabled: !state.dirty || state.saving,
                onClick: function () { props.discard() },
              }, text.discard),
              h('button', {
                type: 'button',
                className: 'dcl-save',
                disabled: !state.writable || !state.dirty || state.invalid || state.saving,
                onClick: function () { void props.save() },
              }, state.saving ? text.saving : text.save)))
          : null)
    }

    // The shipped cards are CSS modules, which this shell injects as <style>
    // tags at runtime — so a stylesheet is the native mechanism here, not a
    // workaround, and it is what buys hover, focus and disabled states that
    // inline styles cannot express. These rules mirror the shipped
    // PluginCard/fields modules so this card is the same object as its
    // neighbours rather than an approximation of one.
    var STYLE_TAG_ID = 'dsh-codex-lite/card.css'
    var CSS = [
      '.dcl-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;',
      'background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}',
      '.dcl-card:hover{border-color:var(--dsw-alias-label-dimmed)}',
      '.dcl-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.dcl-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;',
      'text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}',
      '.dcl-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dcl-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.dcl-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}',
      '.dcl-description{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dcl-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}',
      '.dcl-chevronOpen{transform:rotate(180deg)}',
      '.dcl-pending{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;',
      'white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}',
      '.dcl-quotaBadge{flex:none;border-radius:999px;padding:2px 9px;font-size:11px;line-height:17px;font-weight:600;',
      'white-space:nowrap;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.dcl-quotaBadgeMuted{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}',
      '.dcl-chipWrap{position:relative;display:inline-flex;flex:none}',
      '.dcl-chip{display:inline-flex;align-items:center;height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);',
      'border-radius:999px;background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:11px;line-height:1;font-weight:600;',
      'white-space:nowrap;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .16s,border-color .16s}',
      '.dcl-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.dcl-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dcl-chipMuted{color:var(--dsw-alias-label-tertiary)}',
      '.dcl-chipPopover{position:absolute;top:calc(100% + 8px);right:0;z-index:60;width:264px;',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);',
      'box-shadow:0 12px 32px rgba(0,0,0,.18)}',
      '.dcl-chipPopover .dcl-quota{margin:0;border:0;background:transparent}',
      '.dcl-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      '.dcl-models{margin:12px 0 2px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3)}',
      '.dcl-modelHead{display:flex;align-items:center;gap:10px}',
      '.dcl-modelSummary{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dcl-modelActions{display:flex;align-items:center;gap:12px;margin-top:8px}',
      '.dcl-modelGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px;margin-top:10px}',
      '.dcl-modelOption{display:flex;align-items:center;gap:7px;min-width:0;padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;',
      'font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dcl-modelOptionChecked{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform)}',
      '.dcl-modelOption input{accent-color:var(--dsw-alias-brand-primary);flex:none}',
      '.dcl-modelOption input:disabled{cursor:default}',
      '.dcl-modelName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dcl-quota{margin:12px 0 2px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-3)}',
      '.dcl-quotaHead{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
      '.dcl-quotaTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dcl-plan{border-radius:999px;padding:1px 7px;font-size:10px;line-height:16px;font-weight:600;',
      'background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}',
      '.dcl-refresh{margin-left:auto;border:0;background:none;padding:0;font:inherit;font-size:12px;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dcl-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.dcl-refresh:disabled{opacity:.5;cursor:default}',
      '.dcl-quotaNumbers{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.dcl-quotaFigure{font-size:18px;line-height:1.35;color:var(--dsw-alias-label-primary)}',
      '.dcl-quotaSub{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dcl-quotaTrack{height:7px;margin-top:9px;overflow:hidden;border-radius:999px;',
      'background:var(--dsw-alias-bg-module-platform)}',
      '.dcl-quotaFill{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-brand-primary);',
      'transition:width .2s ease}',
      '.dcl-quotaReset,.dcl-quotaEmpty,.dcl-quotaFailure{margin:8px 0 0;font-size:12px;line-height:1.5;',
      'color:var(--dsw-alias-label-tertiary)}',
      '.dcl-window{padding:8px 0}',
      '.dcl-window+.dcl-window{border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dcl-quotaFailure{color:var(--dsw-alias-label-error)}',
      '.dcl-readOnly{margin:12px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dcl-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
      '.dcl-field+.dcl-field{border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dcl-head{display:flex;align-items:center;gap:8px}',
      '.dcl-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.dcl-badges{display:inline-flex;align-items:center;gap:8px}',
      '.dcl-badge{border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;white-space:nowrap;',
      'font-weight:500;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}',
      '.dcl-badgeMuted{border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;white-space:nowrap;',
      'color:var(--dsw-alias-label-tertiary)}',
      '.dcl-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dcl-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.dcl-reset:disabled{cursor:default;opacity:.4}',
      '.dcl-input{height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.dcl-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dcl-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.dcl-inputInvalid{border-color:var(--dsw-alias-label-error)}',
      '.dcl-invalid{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}',
      '.dcl-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dcl-note{margin:12px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dcl-selector{display:inline-flex;align-items:center;gap:12px;height:36px;padding:0 14px;border:none;',
      'border-radius:18px;background:var(--dsw-alias-bg-module-platform);font:inherit;font-size:14px;',
      'line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dcl-selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dcl-selector:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.dcl-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;',
      'border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dcl-failed{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}',
      '.dcl-discard,.dcl-save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;',
      'font:inherit;font-size:13px;line-height:1.5;cursor:pointer}',
      '.dcl-discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}',
      '.dcl-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.dcl-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.dcl-discard:disabled,.dcl-save:disabled{opacity:.4;cursor:default}',
      '.dcl-discard:focus-visible,.dcl-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    ].join('')

    /** Put the card's rules in the document once, the way a built bundle does. */
    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_TAG_ID) !== null) return
      var tag = document.createElement('style')
      tag.id = STYLE_TAG_ID
      tag.dataset.plugin = 'dsh-codex-lite'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * Bind the card to the services it needs, once they are all present.
     * @param {object} ctx - the scoped browser context.
     */
    function mount(ctx) {
      ensureStyles()
      var connection = ctx.get('connection')
      var scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS, decode: decodeSection })
      // The shared describe mirror, which this card folds its write answers
      // into. Not defended here: `mount` runs inside `apply`'s try/catch, so a
      // Host without it costs this card and nothing else.
      var controller = new Controller(scope, connection, localeOf(ctx), ctx.settingsScope.describe())
      ctx.effect(function () {
        var disposers = [scope.subscribe(function () { controller.publish() })]
        if (controller.locale !== undefined) {
          disposers.push(controller.locale.subscribe(function () { controller.publish() }))
        }
        return function () {
          controller.dispose()
          disposers.forEach(function (dispose) { dispose() })
        }
      }, 'dsh-codex-lite: card sources')
      var tracker = new ModelTracker(modelDirectoriesOf(ctx))
      controller.modelDirectoryFor = function (sessionId) { return tracker.directoryFor(sessionId) }
      controller.loadCatalog()
      void controller.loadUsage('openai-codex', false).finally(function () {
        controller.scheduleCodexUsagePoll()
      })
      ctx.slots.inject('settings.plugin.item', function () {
        return ctx.slots.register({
          name: 'settings.plugin.item',
          key: SETTINGS_NS,
          inject: function () { return controller.face },
        }, CodexCard)
      })
      // The same controller answers the session-header chip: one usage store,
      // one refresh, two surfaces. The slot is declared by the conversation
      // shell; on a harness where it never is, inject simply never runs the
      // callback — and if it does run and the registry refuses, the chip is
      // what is lost, never the card above.
      ctx.slots.inject('conversation.session.header.utilities', function () {
        try {
          return ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'dsh-codex-lite-usage',
            order: 100,
            inject: function () { return controller.face },
          }, SessionQuotaChip)
        } catch (error) {
          console.error('[dsh-codex-lite] session quota chip unavailable:', error)
        }
      })
    }

    /**
     * Narrow the Host's section to what this card reads.
     *
     * Supplied rather than left to the scope's default, which validates the
     * value against a rehydrated copy of the schema and publishes nothing if
     * that fails — leaving the card invisible with no diagnostic. This decoder
     * has no failure mode worth that risk.
     * @param {unknown} section - the resolved section the Host reported.
     * @returns {object|undefined} the section, or nothing when it is not one.
     */
    function decodeSection(section) {
      if (section === null || typeof section !== 'object' || Array.isArray(section)) return undefined
      return section
    }

    /** @param {object} ctx @returns {object|undefined} the locale service, when it is mounted and observable. */
    function localeOf(ctx) {
      try {
        var service = ctx.get('locale')
        if (service !== undefined && service !== null
          && typeof service.getSnapshot === 'function' && typeof service.subscribe === 'function') {
          return service
        }
      } catch (_localeAbsent) {
        // Falling back to the default language is the whole recovery.
      }
      return undefined
    }

    /**
     * Entry point. Nothing here may throw: the browser boot fails the page for
     * any entry that does, and a Settings card is not worth that.
     * @param {object} ctx - the browser plugin context.
     */
    function apply(ctx) {
      try {
        ctx.inject(['slots', 'connection', 'remote', 'settingsScope'], function (scoped) {
          try {
            mount(scoped)
          } catch (error) {
            console.error('[dsh-codex-lite] settings card unavailable:', error)
          }
        })
      } catch (error) {
        console.error('[dsh-codex-lite] client plugin failed to apply:', error)
      }
    }

    return {
      // Declared empty on purpose: a service named here that never arrives
      // leaves this entry pending, and the boot sweep fails the page for it.
      inject: [],
      apply: apply,
      SETTINGS_NS: SETTINGS_NS,
      PROVIDER_ROUTES: PROVIDER_ROUTES,
      TEXT: TEXT,
      parseWindow: parseWindow,
      formatWindow: formatWindow,
      buildOps: buildOps,
      modelSelectionOps: modelSelectionOps,
      rowsOf: rowsOf,
      orderModelIds: orderModelIds,
      hintsOf: hintsOf,
      readUsageResult: readUsageResult,
      weeklyWindowOf: weeklyWindowOf,
      windowLabel: windowLabel,
      currencySymbol: currencySymbol,
      preferredBalance: preferredBalance,
      quotaChipLabel: quotaChipLabel,
      windowsPanelElement: windowsPanelElement,
      quotaChipReady: quotaChipReady,
      formatPercent: formatPercent,
      quotaFailureText: quotaFailureText,
    }
  }
})()
