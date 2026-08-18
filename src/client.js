/**
 * dsh-codex-lite browser half: one card in Settings -> Plugins -> Plugin
 * configuration, editing the per-model context window this plugin's settings
 * namespace owns.
 *
 * The harness ships no generic schema-form renderer — the plugin-configuration
 * tab is a card registry keyed by settings namespace, and a namespace no card
 * claims renders nothing. So this file is the card, hand-written as a classic
 * script: no bundler, no JSX, and `react` is the only module it asks the
 * client module table for. Everything else it needs is a cordis service.
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

    /** The settings namespace this card edits; must equal the host half's. */
    var SETTINGS_NS = 'llm-openai-codex-lite'

    /** The compaction trigger ratio the shipped agent presets leave at its default. */
    var THRESHOLD_RATIO = 0.8

    var TEXT = {
      zh: {
        title: 'OpenAI Codex',
        description: '按模型覆盖上下文窗口',
        expand: '展开',
        collapse: '收起',
        model: '模型',
        window: '上下文窗口',
        placeholder: '继承 catalog',
        add: '添加模型',
        addPlaceholder: '模型 id',
        clear: '清除',
        save: '保存',
        discard: '放弃',
        saving: '保存中…',
        unsaved: '未保存',
        readOnly: '此部署的配置面只读,无法在这里保存。',
        sourceUser: '用户层',
        sourceBase: '配置层',
        sourceNone: '未设置',
        baseHint: '由 cordis.patch.yml 提供,只能覆盖、不能在这里删除。',
        invalid: '要一个正整数,可写 1m / 272k。',
        conflict: '配置已被其他地方改动,已重新读取,请确认后再保存。',
        offline: '写入没有送达主机,请检查连接后重试。',
        trigger: '压缩触发点约',
        tokens: 'tokens',
        compaction: '压缩触发点 ≈ 上下文窗口 × ' + THRESHOLD_RATIO
          + '(shipped agent preset 里 compaction-basic 的默认比例)。这个比例不属于本插件,'
          + '也改不到:Web 表面把 compaction-basic 放进了 agent preset 的隔离 realm。要调它,'
          + '把一份 shipped preset 复制到 $DSH_HOME/.agent-presets 后手工编辑。',
        local: '这个数字是本地记账,不发送给服务端:它决定上下文计量表的分母和压缩触发点。',
      },
      en: {
        title: 'OpenAI Codex',
        description: 'Per-model context window',
        expand: 'Expand',
        collapse: 'Collapse',
        model: 'Model',
        window: 'Context window',
        placeholder: 'inherit catalog',
        add: 'Add model',
        addPlaceholder: 'model id',
        clear: 'Clear',
        save: 'Save',
        discard: 'Discard',
        saving: 'Saving…',
        unsaved: 'unsaved',
        readOnly: 'This deployment serves the configuration plane read-only.',
        sourceUser: 'user layer',
        sourceBase: 'composition',
        sourceNone: 'unset',
        baseHint: 'Set by cordis.patch.yml: it can be overridden here, not deleted.',
        invalid: 'Expected a positive integer; 1m and 272k are accepted.',
        conflict: 'The document changed elsewhere. It has been re-read — review and save again.',
        offline: 'The write never reached the host. Check the connection and retry.',
        trigger: 'compaction at ≈',
        tokens: 'tokens',
        compaction: 'Compaction fires at ≈ context window × ' + THRESHOLD_RATIO
          + ', the default ratio of compaction-basic in the shipped agent presets. That ratio is'
          + ' not this plugin’s and cannot be reached from it: the web surface mounts'
          + ' compaction-basic inside the preset’s isolated realm. To change it, copy a shipped'
          + ' preset into $DSH_HOME/.agent-presets and edit it by hand.',
        local: 'This number is local bookkeeping and never reaches the server: it sizes the context'
          + ' meter and the compaction trigger.',
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
      if (!Number.isInteger(value) || value < 1) return undefined
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
          clearable: inUser || staged,
          baseValue: inBase ? windowIn(baseOverrides, id) : undefined,
        }
      })
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
     * @returns {object[]|undefined} the ops, or nothing when a draft is not a window.
     */
    function buildOps(user, drafts) {
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
      return ops
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
     * @param {object} api - the connection's wire face.
     * @param {object|undefined} locale - the locale service, when one is mounted.
     */
    function Controller(scope, api, locale) {
      var self = this
      this.scope = scope
      this.api = api
      this.locale = locale
      this.drafts = {}
      this.catalog = []
      this.failure = undefined
      this.saving = false
      this.store = createStore(this.project())
      this.face = {
        hooks: { codexCard: this.store },
        edit: function (model, text) { self.edit(model, text) },
        clearRow: function (model) { self.edit(model, '') },
        addRow: function (model) { self.addRow(model) },
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

    /** @returns {object} the snapshot the card renders. */
    Controller.prototype.project = function () {
      var snapshot = this.scope.getSnapshot()
      var rows = rowsOf(snapshot.base, snapshot.user, this.drafts)
      var known = {}
      rows.forEach(function (row) { known[row.model] = true })
      return {
        available: snapshot.status === 'ready',
        writable: snapshot.writable === true,
        language: this.language(),
        rows: rows,
        addable: this.catalog.filter(function (id) { return known[id] !== true }),
        dirty: Object.keys(this.drafts).length > 0,
        invalid: rows.some(function (row) { return row.invalid }),
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

    Controller.prototype.discard = function () {
      this.drafts = {}
      this.failure = undefined
      this.publish()
    }

    /** Load the catalog's model ids, so the add row can offer them. Best effort. */
    Controller.prototype.loadCatalog = function () {
      var self = this
      var request
      try {
        request = this.api.llm.models({})
      } catch (_wireUnavailable) {
        return
      }
      Promise.resolve(request).then(function (response) {
        if (response === undefined || response.result === undefined || !response.result.ok) return
        var groups = response.result.value.groups || []
        for (var index = 0; index < groups.length; index++) {
          if (groups[index].id !== 'openai-codex') continue
          self.catalog = (groups[index].models || []).map(function (model) { return model.id })
          self.publish()
          return
        }
      }, function () {
        // An unreachable catalog only costs the add row its suggestions; the
        // free-text field still reaches every model, and the host half refuses
        // an id the catalog does not carry with a message naming all of them.
      })
    }

    Controller.prototype.save = function () {
      var self = this
      if (this.saving) return Promise.resolve()
      var snapshot = this.scope.getSnapshot()
      var ops = buildOps(snapshot.user, this.drafts)
      var text = TEXT[this.language()]
      if (ops === undefined) {
        this.failure = text.invalid
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
      return Promise.resolve(this.api.settings.mutate(payload)).then(function (response) {
        self.saving = false
        if (response !== undefined && response.result !== undefined && response.result.ok) {
          self.drafts = {}
          self.failure = undefined
        } else {
          var error = response && response.result ? response.result.error : undefined
          // A conflict is the operator's to resolve, so it gets copy of its
          // own; everything else is the seam's own sentence, which for a
          // refused model id already lists every id the catalog carries.
          self.failure = error === undefined
            ? text.offline
            : error.code === 'settings-conflict' ? text.conflict : error.message
          // Re-read either way: a conflict means the document moved, and a
          // refusal is worth showing against current values.
          try { void self.scope.load() } catch (_reloadUnavailable) { /* the scope reloads on its own signals too */ }
        }
        self.publish()
      }, function () {
        self.saving = false
        self.failure = text.offline
        self.publish()
      })
    }

    // ── the card ──

    /**
     * @param {object} props - the injected face, with `hooks` bound to selectors.
     * @returns {object|null} the card, or nothing when this deployment does not serve the section.
     */
    function CodexCard(props) {
      var state = props.useCodexCard(function (snapshot) { return snapshot })
      var open = React.useState(false)
      var isOpen = open[0]
      var setOpen = open[1]
      // A namespace this deployment does not serve, or a section the Host
      // could not prove secret-free, has nothing to edit. Rendering a dead
      // card would be worse than rendering none.
      if (!state.available) return null
      var text = TEXT[state.language]
      var h = React.createElement

      var badge = function (row) {
        return row.source === 'user' ? text.sourceUser : row.source === 'base' ? text.sourceBase : text.sourceNone
      }

      var rows = state.rows.map(function (row) {
        var hint = row.invalid
          ? text.invalid
          : row.value === undefined
            ? (row.source === 'base' ? text.baseHint : '')
            : groupDigits(row.value) + ' ' + text.tokens + ' · ' + text.trigger + ' '
              + groupDigits(Math.floor(row.value * THRESHOLD_RATIO))
        return h('div', { key: row.model, style: STYLE.row },
          h('code', { style: STYLE.model }, row.model),
          h('input', {
            style: row.invalid ? STYLE.inputInvalid : STYLE.input,
            value: row.text,
            inputMode: 'numeric',
            spellCheck: false,
            'aria-label': text.window + ' — ' + row.model,
            'aria-invalid': row.invalid ? true : undefined,
            placeholder: text.placeholder,
            disabled: !state.writable || state.saving,
            onChange: function (event) { props.edit(row.model, event.target.value) },
          }),
          h('span', { style: STYLE.badge }, badge(row)),
          h('button', {
            type: 'button',
            style: STYLE.link,
            disabled: !state.writable || state.saving || !row.clearable,
            onClick: function () { props.clearRow(row.model) },
          }, text.clear),
          hint === '' ? null : h('p', { style: row.invalid ? STYLE.hintError : STYLE.hint }, hint),
        )
      })

      var addModel = React.useState('')
      var pending = addModel[0]
      var setPending = addModel[1]
      var addRow = h('div', { style: STYLE.row },
        h('input', {
          style: STYLE.input,
          value: pending,
          spellCheck: false,
          list: 'dsh-codex-lite-models',
          'aria-label': text.addPlaceholder,
          placeholder: text.addPlaceholder,
          disabled: !state.writable || state.saving,
          onChange: function (event) { setPending(event.target.value) },
        }),
        h('datalist', { id: 'dsh-codex-lite-models' },
          state.addable.map(function (id) { return h('option', { key: id, value: id }) })),
        h('button', {
          type: 'button',
          style: STYLE.link,
          disabled: !state.writable || state.saving || pending.trim() === '',
          onClick: function () { props.addRow(pending); setPending('') },
        }, text.add),
      )

      return h('li', { style: STYLE.card },
        h('button', {
          type: 'button',
          style: STYLE.header,
          'aria-expanded': isOpen,
          'aria-label': (isOpen ? text.collapse : text.expand) + ': ' + text.title,
          onClick: function () { setOpen(!isOpen) },
        },
        h('span', { style: STYLE.headText },
          h('span', { style: STYLE.name }, text.title),
          h('span', { style: STYLE.description }, text.description)),
        h('span', { style: STYLE.tail }, state.dirty ? text.unsaved : '', ' ', isOpen ? '▴' : '▾')),
        isOpen ? h('div', { style: STYLE.body },
          state.writable ? null : h('p', { style: STYLE.notice, role: 'status' }, text.readOnly),
          rows,
          addRow,
          h('p', { style: STYLE.note }, text.local),
          h('p', { style: STYLE.note }, text.compaction),
          state.failure === undefined ? null : h('p', { style: STYLE.failure, role: 'status' }, state.failure),
          h('div', { style: STYLE.footer },
            h('button', {
              type: 'button',
              style: STYLE.link,
              disabled: !state.dirty || state.saving,
              onClick: function () { props.discard() },
            }, text.discard),
            h('button', {
              type: 'button',
              style: STYLE.primary,
              disabled: !state.writable || !state.dirty || state.invalid || state.saving,
              onClick: function () { void props.save() },
            }, state.saving ? text.saving : text.save)),
        ) : null)
    }

    // Inline styles over the shell's own palette tokens, so the card follows
    // both themes without a stylesheet the module table would have to serve.
    var STYLE = {
      card: { listStyle: 'none', border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)', borderRadius: '8px', overflow: 'hidden' },
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', width: '100%', padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'inherit' },
      headText: { display: 'flex', flexDirection: 'column', gap: '2px' },
      name: { fontWeight: 600 },
      description: { fontSize: '0.85em', color: 'var(--dsw-alias-label-tertiary, #767676)' },
      tail: { fontSize: '0.85em', color: 'var(--dsw-alias-label-tertiary, #767676)', whiteSpace: 'nowrap' },
      body: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '0 14px 14px' },
      row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' },
      model: { minWidth: '11em', fontSize: '0.9em' },
      input: { width: '10em', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)', background: 'transparent', color: 'inherit', font: 'inherit' },
      inputInvalid: { width: '10em', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-label-error, #d24343)', background: 'transparent', color: 'inherit', font: 'inherit' },
      badge: { fontSize: '0.78em', color: 'var(--dsw-alias-label-tertiary, #767676)' },
      link: { background: 'none', border: 'none', padding: '4px 6px', cursor: 'pointer', font: 'inherit', fontSize: '0.85em', color: 'var(--dsw-alias-label-secondary, #555)' },
      primary: { padding: '5px 14px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)', cursor: 'pointer', font: 'inherit', fontSize: '0.9em' },
      hint: { flexBasis: '100%', margin: 0, fontSize: '0.78em', color: 'var(--dsw-alias-label-tertiary, #767676)' },
      hintError: { flexBasis: '100%', margin: 0, fontSize: '0.78em', color: 'var(--dsw-alias-label-error, #d24343)' },
      note: { margin: 0, fontSize: '0.78em', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, #767676)' },
      notice: { margin: 0, fontSize: '0.85em', color: 'var(--dsw-alias-label-secondary, #555)' },
      failure: { margin: 0, fontSize: '0.85em', color: 'var(--dsw-alias-label-error, #d24343)' },
      footer: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
    }

    /**
     * Bind the card to the services it needs, once they are all present.
     * @param {object} ctx - the scoped browser context.
     */
    function mount(ctx) {
      var connection = ctx.get('connection')
      var scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS, decode: decodeSection })
      var controller = new Controller(scope, connection.api, localeOf(ctx))
      ctx.effect(function () {
        var disposers = [scope.subscribe(function () { controller.publish() })]
        if (controller.locale !== undefined) {
          disposers.push(controller.locale.subscribe(function () { controller.publish() }))
        }
        return function () { disposers.forEach(function (dispose) { dispose() }) }
      }, 'dsh-codex-lite: card sources')
      controller.loadCatalog()
      ctx.slots.inject('settings.plugin.item', function () {
        return ctx.slots.register({
          name: 'settings.plugin.item',
          key: SETTINGS_NS,
          inject: function () { return controller.face },
        }, CodexCard)
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
      parseWindow: parseWindow,
      formatWindow: formatWindow,
      buildOps: buildOps,
      rowsOf: rowsOf,
    }
  }
})()
