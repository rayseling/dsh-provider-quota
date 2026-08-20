/**
 * dsh-codex-lite browser half: one card in Settings -> Plugins -> Plugin
 * configuration, editing the per-model context window this plugin's settings
 * namespace owns.
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
        description: '调整每个模型的上下文长度。',
        expand: '展开设置',
        collapse: '收起设置',
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
      },
      en: {
        title: 'OpenAI Codex',
        description: 'Adjust each model’s context length.',
        expand: 'Show settings',
        collapse: 'Hide settings',
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
    function Controller(scope, api, locale, mirror) {
      var self = this
      this.scope = scope
      this.api = api
      this.locale = locale
      // The shared describe mirror. `save` folds each write answer into it,
      // which is what advances the revision the next write fences on.
      this.mirror = mirror
      this.drafts = {}
      this.catalog = []
      this.catalogState = 'idle'
      this.failure = undefined
      this.saving = false
      this.store = createStore(this.project())
      this.face = {
        hooks: { codexCard: this.store },
        edit: function (model, text) { self.edit(model, text) },
        resetRow: function (model) { self.edit(model, '') },
        removeRow: function (model) { self.removeRow(model) },
        addRow: function (model) { self.addRow(model) },
        retryCatalog: function () { self.loadCatalog() },
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
        catalogFailed: this.catalogState === 'failed',
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

    Controller.prototype.removeRow = function (model) {
      delete this.drafts[model]
      this.failure = undefined
      this.publish()
    }

    Controller.prototype.discard = function () {
      this.drafts = {}
      this.failure = undefined
      this.publish()
    }

    /**
     * Load the catalog's model ids, so the add row can offer them.
     *
     * The picker offers these ids and nothing else, so a catalog that does not
     * arrive is not a missing convenience but a picker with nothing in it —
     * indistinguishable, without this state, from having already added every
     * model. It therefore fails loudly enough to be retried, and the button
     * says which of the two happened.
     */
    Controller.prototype.loadCatalog = function () {
      var self = this
      if (this.catalogState === 'loading') return
      this.catalogState = 'loading'
      this.publish()
      var request
      try {
        request = this.api.llm.models({})
      } catch (error) {
        this.failCatalog('unavailable', error)
        return
      }
      // `.catch` rather than a second `then` argument: a rejection handler
      // passed beside the fulfilment handler cannot see what that handler
      // throws, and everything below unwraps a response this card does not
      // control. A shape it did not expect would otherwise leave the picker
      // stuck on "loading" and the failure only in the console.
      Promise.resolve(request).then(function (response) {
        var result = response === undefined ? undefined : response.result
        if (result === undefined || !result.ok) {
          self.failCatalog('refused', result && result.error)
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
          self.failCatalog('carries no ' + OPENAI_CODEX_ROUTE + ' models', groups)
          return
        }
        self.catalog = models
          .map(function (model) { return model === null || typeof model !== 'object' ? undefined : model.id })
          .filter(function (id) { return typeof id === 'string' && id.length > 0 })
        self.catalogState = 'ready'
        self.publish()
      }).catch(function (error) {
        self.failCatalog('request failed', error)
      })
    }

    /**
     * Record that the model list did not arrive, and say so once in the
     * console for whoever is looking at one.
     * @param {string} reason - what went wrong, for the console line.
     * @param {unknown} detail - the underlying value, for the console line.
     */
    Controller.prototype.failCatalog = function (reason, detail) {
      console.warn('[dsh-codex-lite] model catalog ' + reason + ':', detail)
      this.catalogState = 'failed'
      this.publish()
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
        state.dirty ? h('span', { className: 'dcl-pending' }, text.unsaved) : null,
        React.createElement(ChevronIcon, { className: isOpen ? 'dcl-chevron dcl-chevronOpen' : 'dcl-chevron' })),
        isOpen
          ? h('div', { className: 'dcl-body' },
            state.writable ? null : h('p', { className: 'dcl-readOnly', role: 'status' }, text.readOnly),
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
      '.dcl-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
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
      var controller = new Controller(scope, connection.api, localeOf(ctx), ctx.settingsScope.describe())
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
      hintsOf: hintsOf,
    }
  }
})()
