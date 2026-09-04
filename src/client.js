/**
 * dsh-codex-lite browser half: one card in Settings -> Plugins -> Plugin
 * configuration plus a session-header chip, both showing the host-normalized
 * account quota of the model route the session is on — Codex 5h/7d, OpenCode
 * Go 5h/7d/1m, or the DeepSeek balance.
 *
 * It edits nothing. The plugin's settings namespace holds no field; it exists
 * because the plugin-configuration tab dispatches a card only to a namespace
 * the Host serves, so the card needs one to be rendered under at all.
 *
 * The harness ships no generic schema-form renderer — the package that once
 * held one is gone, and the plugin-configuration tab is a card registry keyed
 * by settings namespace, where a namespace no card claims renders nothing. So
 * this file is the card, hand-written as a classic script: no bundler, no JSX,
 * and the only modules it asks the client module table for are `react` and the
 * shipped UI primitives. Everything else it needs is a cordis service.
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
    // The shipped primitives, so the card's disclosure chevron is the same
    // glyph its neighbours use rather than an imitation of one.
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var ChevronIcon = primitives.IconChevronDownOutline14

    /** The settings namespace this card is dispatched under; must equal the host half's. */
    var SETTINGS_NS = 'codex-quota'

    /** Trusted Harness Connection RPC carrying secret-free usage data. */
    var CODEX_USAGE_CHANNEL = '/dsh-codex-lite'
    var CODEX_USAGE_METHOD = 'usage'
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

    // Copy for someone fluent in AI but not in this codebase: quota windows,
    // resets and balances are words they already own, so the card uses them
    // plainly — and names nothing that exists only in here.
    //
    // Anything the neighbouring cards already have a word for keeps their
    // word: two cards calling the same act two things would read as two acts.
    var TEXT = {
      zh: {
        title: 'OpenAI Codex',
        description: '查看当前模型路线的账号额度：Codex 5 小时 / 7 天、OpenCode Go、DeepSeek 余额。',
        expand: '展开额度',
        collapse: '收起额度',
        quotaBadge: '周已用 {used}%',
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
        quotaSignedOut: 'Codex 登录记录缺失，见 README 的登录一节。',
        quotaAuth: 'Codex 登录已失效，见 README 的登录一节。',
        quotaTimeout: '读取额度超时，请稍后重试。',
        quotaRateLimited: '额度接口请求过于频繁，请稍后重试。',
        quotaFailed: '没能读取额度，请稍后重试。',
        refresh: '刷新',
        refreshing: '刷新中…',
      },
      en: {
        title: 'OpenAI Codex',
        description: 'Account usage for the route this session is on: Codex 5h/7d, OpenCode Go, DeepSeek balance.',
        expand: 'Show usage',
        collapse: 'Hide usage',
        quotaBadge: 'Weekly {used}% used',
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
        quotaSignedOut: 'No Codex sign-in record — see the sign-in section of the README.',
        quotaAuth: 'The Codex sign-in has expired — see the sign-in section of the README.',
        quotaTimeout: 'Usage timed out. Try again shortly.',
        quotaRateLimited: 'The usage endpoint is rate limited. Try again shortly.',
        quotaFailed: 'Could not load usage. Try again shortly.',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
      },
    }

    // ── pure helpers, also exported so they can be tested without a DOM ──

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
     * The capsule text for one provider family. Windows show the used
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
          return text.quotaBadge.replace('{used}', formatPercent(weekly.usedPercent))
        }
        return usage.windows.map(function (window) {
          return window.id + ' ' + formatPercent(window.usedPercent) + '%'
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

    // ── the controller ──

    /**
     * Own the one conversation behind both surfaces: the quota read, per
     * provider family, over the trusted Connection RPC.
     *
     * There is no settings conversation any more. The card edits nothing, so
     * this holds no draft, no revision to fence a write on, and no describe
     * mirror to fold an answer into.
     * @param {object} connection - trusted generic RPC transport.
     * @param {object|undefined} locale - the locale service, when one is mounted.
     */
    function Controller(connection, locale) {
      var self = this
      this.connection = connection
      this.locale = locale
      // One state slot per provider family, so switching models can never show
      // one account's numbers under another provider.
      this.routes = {}
      USAGE_ROUTES.forEach(function (route) { self.routes[route] = newUsageSlot() })
      this.modelDirectoryFor = undefined
      this.disposed = false
      this.usagePollTimer = undefined
      this.store = createStore(this.project())
      this.face = {
        hooks: { codexCard: this.store },
        refreshUsage: function (provider) { return self.loadUsage(provider === undefined ? 'openai-codex' : provider, true) },
        loadUsage: function (provider, force) { return self.loadUsage(provider, force === true) },
        modelDirectoryFor: function (sessionId) {
          return self.modelDirectoryFor === undefined ? undefined : self.modelDirectoryFor(sessionId)
        },
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

    /** @returns {object} the snapshot both surfaces render. */
    Controller.prototype.project = function () {
      return { language: this.language(), routes: this.routes }
    }

    Controller.prototype.publish = function () { this.store.set(this.project()) }

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
      USAGE_ROUTES.forEach(function (route) {
        var slot = self.routes[route]
        slot.generation++
        if (slot.abort !== undefined) slot.abort.abort()
        slot.abort = undefined
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


    /** One usage-window row: used first, remaining and reset beneath it. */
    function windowRowElement(window, text, language) {
      var h = React.createElement
      var remaining = formatPercent(window.remainingPercent)
      var used = formatPercent(window.usedPercent)
      return h('div', { key: window.id, className: 'dcl-window' },
        h('div', { className: 'dcl-quotaNumbers' },
          h('strong', { className: 'dcl-quotaFigure' }, text.usedLabel.replace('{used}', used)),
          h('span', { className: 'dcl-quotaSub' }, text.remainingLabel.replace('{remaining}', remaining))),
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
     * The Settings card: the Codex quota, and nothing to edit.
     *
     * It always renders. The old card returned null for a namespace this
     * deployment did not serve, because a dead editor is worse than none —
     * but this one displays a number the Host answers for, which does not
     * depend on the section existing beyond being dispatched at all.
     * @param {object} props - the injected face, with `hooks` bound to selectors.
     * @returns {object} the card.
     */
    function CodexCard(props) {
      var state = props.useCodexCard(function (snapshot) { return snapshot })
      var disclosure = React.useState(false)
      var isOpen = disclosure[0]
      var setOpen = disclosure[1]
      var text = TEXT[state.language]
      var h = React.createElement
      // The collapsed badge reads the same windows the session chip does, so
      // an account with both windows shows both, and one with only the weekly
      // allowance keeps the single-window copy.
      var quotaBadge = quotaChipLabel(state.routes.codex, text)
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
        React.createElement(ChevronIcon, { className: isOpen ? 'dcl-chevron dcl-chevronOpen' : 'dcl-chevron' })),
        isOpen
          ? h('div', { className: 'dcl-body' },
            windowsPanelElement(state.routes.codex, text, function () { void props.refreshUsage() }, state.language))
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
      '.dcl-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}',
      '.dcl-card:hover{border-color:var(--dsw-alias-label-dimmed)}',
      '.dcl-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.dcl-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}',
      '.dcl-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dcl-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.dcl-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}',
      '.dcl-description{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dcl-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}',
      '.dcl-chevronOpen{transform:rotate(180deg)}',
      '.dcl-quotaBadge{flex:none;border-radius:999px;padding:2px 9px;font-size:11px;line-height:17px;font-weight:600;white-space:nowrap;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.dcl-quotaBadgeMuted{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}',
      '.dcl-chipWrap{position:relative;display:inline-flex;flex:none}',
      '.dcl-chip{display:inline-flex;align-items:center;height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:11px;line-height:1;font-weight:600;white-space:nowrap;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .16s,border-color .16s}',
      '.dcl-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.dcl-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dcl-chipMuted{color:var(--dsw-alias-label-tertiary)}',
      '.dcl-chipPopover{position:absolute;top:calc(100% + 8px);right:0;z-index:60;width:264px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 32px rgba(0,0,0,.18)}',
      '.dcl-chipPopover .dcl-quota{margin:0;border:0;background:transparent}',
      '.dcl-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      '.dcl-quota{margin:12px 0 2px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3)}',
      '.dcl-quotaHead{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
      '.dcl-quotaTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dcl-plan{border-radius:999px;padding:1px 7px;font-size:10px;line-height:16px;font-weight:600;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}',
      '.dcl-refresh{margin-left:auto;border:0;background:none;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dcl-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.dcl-refresh:disabled{opacity:.5;cursor:default}',
      '.dcl-quotaNumbers{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.dcl-quotaFigure{font-size:18px;line-height:1.35;color:var(--dsw-alias-label-primary)}',
      '.dcl-quotaSub{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dcl-quotaTrack{height:7px;margin-top:9px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-module-platform)}',
      '.dcl-quotaFill{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-brand-primary);transition:width .2s ease}',
      '.dcl-quotaReset,.dcl-quotaEmpty,.dcl-quotaFailure{margin:8px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dcl-window{padding:8px 0}',
      '.dcl-quotaFailure{color:var(--dsw-alias-label-error)}',
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
     * Bind the two surfaces to the services they need, once they are present.
     * @param {object} ctx - the scoped browser context.
     */
    function mount(ctx) {
      ensureStyles()
      var controller = new Controller(ctx.get('connection'), localeOf(ctx))
      ctx.effect(function () {
        var disposers = []
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
     * any entry that does, and a quota card is not worth that.
     * @param {object} ctx - the browser plugin context.
     */
    function apply(ctx) {
      try {
        ctx.inject(['slots', 'connection'], function (scoped) {
          try {
            mount(scoped)
          } catch (error) {
            console.error('[dsh-codex-lite] quota card unavailable:', error)
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
