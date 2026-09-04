/**
 * Contract tests for the browser half, executed as the classic script it is,
 * with no DOM and no React. They pin the three things that are expensive to
 * get wrong:
 *
 * - the module-table contract, because a mismatched handoff id or a `require`
 *   outside the platform seed set fails at page load rather than at build;
 * - the anti-brick posture, because an entry that throws or waits on a missing
 *   service takes the whole web UI down with it;
 * - what the two surfaces actually put on screen, which is the only thing this
 *   plugin's browser half does at all.
 *
 * They need no peer dependencies, so they run in any checkout — which is why
 * the namespace below is a literal rather than an import of the host half:
 * importing `../src/index.js` would pull pi-ai and the settings seam in behind
 * it and make this suite fail to load wherever those are absent. The two
 * halves are held to the same spelling from the other side instead, by an
 * assertion in `settings.test.js`, which needs those peers anyway.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'

/** The namespace both halves must spell identically; see the note above. */
const settingsNs = 'codex-quota'

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

/**
 * Execute the bundle the way the shell's script loader does: as a classic
 * script whose only contact with the page is `window.__ModuleLoader__`.
 *
 * Run in this realm rather than a `node:vm` one, so the objects the module
 * builds carry this realm's prototypes and assertions can compare them
 * structurally.
 * @param {Record<string, unknown>} [windowOverrides] - extra browser globals for one test.
 * @returns {object} the captured handoff.
 */
function load(windowOverrides = {}) {
  let captured
  const win = { __ModuleLoader__: { load: (handoff) => { captured = handoff } }, ...windowOverrides }
  // eslint-disable-next-line no-new-func -- executing a script is the contract under test
  new Function('window', 'globalThis', 'console', source)(win, win, console)
  return captured
}

/**
 * Materialize the module the way the client module table does.
 * @param {Record<string, unknown>} [table] - the modules `require` may answer.
 * @param {Record<string, unknown>} [windowOverrides] - extra browser globals for one test.
 * @returns {{exports: object, required: string[]}} the module and what it asked for.
 */
function materialize(table = { 'react': {}, '@deepseek-ai/dsh-client-ui-primitives': {} }, windowOverrides = {}) {
  const required = []
  const exports = load(windowOverrides).factory((specifier) => {
    required.push(specifier)
    assert.ok(specifier in table, `require(${JSON.stringify(specifier)}) is outside the platform seed set`)
    return table[specifier]
  })
  return { exports, required }
}

/**
 * Read a rendered element tree the way a reader would: the text it puts on
 * screen, plus the refresh control, so a test can assert what is shown rather
 * than what the state slot says.
 * @param {object} element - the root of a tree built by the fake `createElement`.
 * @returns {{text: string, refresh: object|undefined}} the visible text and the refresh button.
 */
function flatten(element) {
  const words = []
  let refresh
  const walk = node => {
    if (typeof node === 'string' || typeof node === 'number') { words.push(String(node)); return }
    if (node === null || typeof node !== 'object') return
    if (node.props !== undefined && node.props !== null && node.props.className === 'dcl-refresh') refresh = node
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (Array.isArray(node.children)) node.children.forEach(walk)
  }
  walk(element)
  return { text: words.join(' '), refresh }
}

/** A context whose services all answer, capturing what the module registers. */
function fakeContext(overrides = {}) {
  const registrations = []
  const effects = []
  const effectDisposers = []
  const connection = {
    rpc: { call: () => Promise.resolve({ ok: false, error: { code: 'unavailable' } }) },
  }
  // The service names a real web shell answers. `inject` parks unless every
  // requested name is one of them, so a name the harness does not provide —
  // `remote.sesion`, or a namespace that moved — is a card that never mounts.
  // That is the externally observable consequence; asserting the literal list
  // instead would only prove this file copied it correctly out of src.
  const provided = new Set(['slots', 'connection', 'locale', 'modelDirectories'])
  const injections = []
  const missing = []
  const ctx = {
    registrations,
    effects,
    connection,
    injections,
    missing,
    get: name => (name === 'connection' ? connection : undefined),
    inject: (names, callback) => {
      injections.push(names)
      const absent = names.filter(name => !provided.has(name))
      if (absent.length > 0) { missing.push(...absent); return }
      callback(ctx)
    },
    effect: (run, label) => {
      effects.push(label)
      const dispose = run()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
    },
    disposeEffects: () => { effectDisposers.splice(0).reverse().forEach(dispose => dispose()) },
    slots: {
      inject: (_name, callback) => { callback() },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
    ...overrides,
  }
  return ctx
}

describe('module table contract', () => {
  test('registers under the loader entry name', () => {
    const handoff = load()
    assert.equal(handoff.id, 'dsh-codex-lite', 'the id must be the package name the loader graph keys on')
    assert.equal(typeof handoff.factory, 'function')
  })

  test('is a classic script, not an ES module', () => {
    assert.doesNotMatch(source, /^\s*(?:import|export)\s/mu, 'the shell loads this with a plain <script src>')
    assert.doesNotMatch(source, /^\s*await\s/mu, 'top-level await is not available in a classic script')
  })

  test('asks the module table only for platform modules the shell seeds', () => {
    // The seed set is fixed (packages/client/web/src/seed.ts); a require
    // outside it resolves only by luck and fails the page when the luck runs
    // out, so the set this bundle depends on is pinned here.
    assert.deepEqual(materialize().required, ['react', '@deepseek-ai/dsh-client-ui-primitives'])
  })

  test('exports a cordis plugin that declares no services', () => {
    const { exports } = materialize()
    assert.deepEqual(exports.inject, [], 'a service named here could leave the entry pending and fail the page')
    assert.equal(typeof exports.apply, 'function')
    assert.equal(exports.__esModule, undefined)
  })

  test('edits the same namespace the host half registers', () => {
    assert.equal(materialize().exports.SETTINGS_NS, settingsNs)
  })
})

describe('activation', () => {
  test('names only services a web shell answers, so the card actually mounts', () => {
    // A name nothing provides parks the fiber forever — no throw, no console
    // line, just a card that never appears. The failure is invisible except
    // through this: did it register?
    const { exports } = materialize()
    const ctx = fakeContext()
    exports.apply(ctx)
    assert.deepEqual(ctx.missing, [], 'every injected name must be one a web shell provides')
    assert.ok(ctx.registrations.length > 0, 'a parked fiber registers nothing')
    assert.ok(ctx.injections[0].includes('connection'), 'the quota read is the one service this card cannot do without')
  })

  test('a namespace the shell does not provide parks the card instead of mounting it half-wired', () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    const realInject = ctx.inject
    ctx.inject = (names, callback) => realInject(names.map(name => name === 'connection' ? 'conection' : name), callback)
    exports.apply(ctx)
    assert.deepEqual(ctx.missing, ['conection'])
    assert.equal(ctx.registrations.length, 0, 'a card that cannot reach the quota RPC must not register')
  })

  test('registers the card keyed by the namespace the tab dispatches on', () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    exports.apply(ctx)
    assert.equal(ctx.registrations.length, 2)
    const { options, component } = ctx.registrations[0]
    assert.equal(options.name, 'settings.plugin.item')
    assert.equal(options.key, settingsNs)
    assert.equal(typeof options.inject, 'function')
    assert.equal(typeof component, 'function')
  })

  test('registers the session-header quota chip beside the card, sharing one store', () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    exports.apply(ctx)
    const chip = ctx.registrations[1]
    assert.equal(chip.options.name, 'conversation.session.header.utilities')
    assert.equal(chip.options.id, 'dsh-codex-lite-usage')
    assert.equal(typeof chip.options.inject, 'function')
    assert.equal(typeof chip.component, 'function')
    const cardFace = ctx.registrations[0].options.inject()
    const chipFace = chip.options.inject()
    assert.equal(chipFace.hooks.codexCard, cardFace.hooks.codexCard, 'one usage store answers both surfaces')
    assert.equal(typeof chipFace.refreshUsage, 'function')
    assert.equal(chip.options.inject(), chipFace, 'the chip face identity is stable too')
  })

  test('a harness without the conversation slot still gets the card', () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    const injected = []
    ctx.slots = {
      inject: (name, callback) => { injected.push(name); if (name === 'settings.plugin.item') callback() },
      register: (options, component) => { ctx.registrations.push({ options, component }); return () => {} },
    }
    exports.apply(ctx)
    assert.deepEqual(injected, ['settings.plugin.item', 'conversation.session.header.utilities'])
    assert.equal(ctx.registrations.length, 1, 'the undeclared slot contributes nothing, the card survives')
    assert.equal(ctx.registrations[0].options.name, 'settings.plugin.item')
  })

  test('a registry that refuses the chip keeps the card', () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    ctx.slots = {
      inject: (_name, callback) => { callback() },
      register: (options, component) => {
        if (options.name === 'conversation.session.header.utilities') throw new Error('slot closed')
        ctx.registrations.push({ options, component })
        return () => {}
      },
    }
    assert.doesNotThrow(() => { exports.apply(ctx) })
    assert.equal(ctx.registrations.length, 1)
    assert.equal(ctx.registrations[0].options.name, 'settings.plugin.item')
  })

  test('publishes a face whose hooks the slot renderer can bind', () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    assert.equal(typeof face.hooks.codexCard.getSnapshot, 'function')
    assert.equal(typeof face.hooks.codexCard.subscribe, 'function')
    for (const name of ['refreshUsage', 'loadUsage', 'modelDirectoryFor']) {
      assert.equal(typeof face[name], 'function', `face.${name}`)
    }
    assert.equal(ctx.registrations[0].options.inject(), face, 'the face identity is stable, so the renderer can cache it')
  })

  test('survives a context that answers nothing', () => {
    const { exports } = materialize()
    assert.doesNotThrow(() => { exports.apply({ inject: () => {} }) })
  })

  test('survives every service it uses throwing', () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    ctx.get = () => { throw new Error('no service surface here') }
    assert.doesNotThrow(() => { exports.apply(ctx) })
    assert.equal(ctx.registrations.length, 0)
  })

  test('survives a slot registry that refuses the card', () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    ctx.slots = { inject: (_name, callback) => { callback() }, register: () => { throw new Error('slot closed') } }
    assert.doesNotThrow(() => { exports.apply(ctx) })
  })
})

describe('usage card state', () => {
  const result = {
    ok: true,
    value: {
      kind: 'windows',
      provider: 'openai-codex',
      planType: 'plus',
      windows: [
        { id: '5h', usedPercent: 12, remainingPercent: 88, resetsAt: 1_788_134_407 },
        { id: '7d', usedPercent: 3, remainingPercent: 97, resetsAt: 1_788_134_407 },
      ],
      fetchedAt: '2026-08-20T12:00:00.000Z',
    },
  }

  test('accepts only the normalized, secret-free provider-usage union', () => {
    const { readUsageResult } = materialize().exports
    assert.deepEqual(readUsageResult(result), result.value)
    assert.deepEqual(readUsageResult({
      ok: true,
      value: {
        kind: 'balance',
        provider: 'deepseek-official',
        isAvailable: true,
        balances: [{ currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00' }],
        fetchedAt: '2026-08-20T12:00:00.000Z',
      },
    }), {
      kind: 'balance',
      provider: 'deepseek-official',
      isAvailable: true,
      balances: [{ currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00' }],
      fetchedAt: '2026-08-20T12:00:00.000Z',
    })
    assert.deepEqual(readUsageResult({ ok: true, value: { kind: 'none', provider: 'glm-5.3' } }), { kind: 'none', provider: 'glm-5.3' })
    assert.equal(readUsageResult({ ok: true, value: { kind: 'windows', windows: [{ id: '7d', usedPercent: '3' }] } }), undefined)
    assert.equal(readUsageResult({ ok: true, value: { kind: 'windows', windows: 'none' } }), undefined)
    assert.equal(readUsageResult({ ok: true, value: { kind: 'balance', isAvailable: true, balances: [{ currency: 'CNY' }] } }), undefined)
    assert.equal(readUsageResult({ ok: true, value: { weekly: { usedPercent: 3 } } }), undefined, 'the legacy shape is gone')
    assert.equal(readUsageResult({ ok: false, error: { code: 'auth' } }), undefined)
  })

  test('loads on mount, publishes 5h/7d usage, and force-refreshes on demand', async () => {
    const calls = []
    const { exports } = materialize()
    const ctx = fakeContext()
    ctx.connection.rpc.call = async (channel, method, payload, signal) => {
      calls.push({ channel, method, payload, signal })
      return result
    }
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    await new Promise(resolve => setImmediate(resolve))
    const state = face.hooks.codexCard.getSnapshot()
    assert.equal(state.routes.codex.state, 'ready')
    assert.deepEqual(state.routes.codex.usage, result.value)
    const usageCall = calls.find(call => call.method === 'usage')
    assert.deepEqual(usageCall, {
      channel: '/dsh-codex-lite',
      method: 'usage',
      payload: { provider: 'openai-codex', force: false },
      signal: usageCall.signal,
    })
    assert.ok(usageCall.signal instanceof AbortSignal)
    await face.refreshUsage()
    const usageCalls = calls.filter(call => call.method === 'usage')
    assert.deepEqual(usageCalls[usageCalls.length - 1].payload, { provider: 'openai-codex', force: true })
  })

  test('polls Codex 30 seconds after each completed read and stops on unload', async () => {
    const timers = []
    const canceled = []
    const { exports } = materialize(undefined, {
      setTimeout: (callback, delay) => {
        const timer = { callback, delay }
        timers.push(timer)
        return timer
      },
      clearTimeout: timer => { canceled.push(timer) },
    })
    const ctx = fakeContext()
    const usageCalls = []
    let settleInitial
    ctx.connection.rpc.call = (_channel, method, payload) => {
      usageCalls.push(payload)
      if (usageCalls.length === 1) {
        return new Promise(resolve => { settleInitial = resolve })
      }
      return Promise.resolve({
        ok: true,
        value: {
          ...result.value,
          windows: result.value.windows.map((window, index) => index === 0
            ? { ...window, usedPercent: 13, remainingPercent: 87 }
            : window),
          fetchedAt: '2026-08-20T12:00:30.000Z',
        },
      })
    }
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    assert.equal(timers.length, 0, 'the next poll is measured from completion, not request start')
    settleInitial(result)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, 30_000)
    assert.deepEqual(usageCalls, [{ provider: 'openai-codex', force: false }])

    timers[0].callback()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(usageCalls.length, 2)
    assert.deepEqual(usageCalls[1], { provider: 'openai-codex', force: false }, 'polling preserves the shared Host cache')
    assert.equal(face.hooks.codexCard.getSnapshot().routes.codex.usage.windows[0].remainingPercent, 87)
    assert.equal(timers.length, 2, 'a settled poll schedules exactly one successor')

    ctx.disposeEffects()
    assert.equal(canceled.length, 1)
    assert.equal(canceled[0], timers[1])
    timers[1].callback()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(usageCalls.length, 2, 'a cleared late callback cannot read after unload')
  })

  test('the poll leaves the numbers on screen; a read the reader asked for says it is reading', async () => {
    // The only test here that renders. The panel decides what a reader sees,
    // and the bug this pins is invisible from the state slot alone: the poll
    // put the slot into `loading`, and the panel dutifully replaced two live
    // percentages with "正在读取额度…" every thirty seconds.
    const React = {
      createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
    }
    const timers = []
    const { exports } = materialize(
      { 'react': React, '@deepseek-ai/dsh-client-ui-primitives': {} },
      {
        setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer },
        clearTimeout: () => {},
      },
    )
    const ctx = fakeContext()
    // Reads answer at once until `hold` goes up, then stay in flight so the
    // panel can be read mid-read. Every held read is released at the end —
    // an unsettled one leaves this file's real 40s abort timer running.
    const held = []
    let hold = false
    const usageCalls = []
    ctx.connection.rpc.call = (_channel, method, payload) => {
      usageCalls.push(payload)
      if (!hold) return Promise.resolve(result)
      return new Promise(resolve => { held.push(resolve) })
    }
    exports.apply(ctx)
    await new Promise(resolve => setImmediate(resolve))
    const face = ctx.registrations[0].options.inject()
    const panel = () => flatten(exports.windowsPanelElement(
      face.hooks.codexCard.getSnapshot().routes.codex, exports.TEXT.zh, () => {}, 'zh'))

    const ready = panel()
    assert.ok(ready.text.includes('88'), 'the settled read shows the 5h window')
    assert.ok(ready.text.includes('97'), 'and the 7d one')

    hold = true
    timers[0].callback()
    await new Promise(resolve => setImmediate(resolve))
    const polling = panel()
    assert.equal(usageCalls.length, 2, 'the poll is in flight')
    assert.ok(polling.text.includes('88'), 'the poll does not blank the panel it is refreshing')
    assert.ok(polling.text.includes('97'))
    assert.equal(polling.refresh.props.disabled, false, 'nor take the refresh button away')

    void face.refreshUsage()
    await new Promise(resolve => setImmediate(resolve))
    const forced = panel()
    assert.deepEqual(usageCalls[2], { provider: 'openai-codex', force: true },
      'a forced read takes over the poll rather than joining its cached one')
    assert.ok(!forced.text.includes('88'), 'a read the reader asked for reads as in flight')
    assert.equal(forced.refresh.props.disabled, true)

    held.forEach(resolve => resolve(result))
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(panel().text.includes('88'), 'and the numbers come back when it lands')
  })

  test('an account with no windows reads as ready-and-empty, not as a failure', async () => {
    // The host answers `windows: []` for an account OpenAI reports no window
    // for. Refusing that shape here would file a real answer under
    // `invalid-response` and show the generic retry copy for a state no retry
    // can change.
    const { exports } = materialize()
    const ctx = fakeContext()
    ctx.connection.rpc.call = async () => ({
      ok: true,
      value: { kind: 'windows', provider: 'openai-codex', windows: [], fetchedAt: '2026-08-20T12:00:00.000Z' },
    })
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    await new Promise(resolve => setImmediate(resolve))
    const state = face.hooks.codexCard.getSnapshot()
    assert.equal(state.routes.codex.state, 'ready')
    assert.equal(state.routes.codex.failure, undefined)
    assert.deepEqual(state.routes.codex.usage.windows, [])
    assert.equal(exports.weeklyWindowOf(state.routes.codex.usage), undefined)
    assert.equal(exports.quotaChipReady(state.routes.codex), false, 'the capsule stays muted with no number to show')
  })

  test('maps a Host refusal to localized copy without exposing server detail', async () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    ctx.connection.rpc.call = async () => ({
      ok: false,
      error: { code: 'signed-out', message: 'access_MUST_NOT_RENDER' },
    })
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    await new Promise(resolve => setImmediate(resolve))
    const state = face.hooks.codexCard.getSnapshot()
    assert.equal(state.routes.codex.failure, 'signed-out')
    const copy = exports.quotaFailureText(state.routes.codex.failure, 'zh')
    assert.match(copy, /登录记录缺失/u)
    assert.doesNotMatch(copy, /MUST_NOT_RENDER/u)
  })

  test('aborts a hanging RPC on unload and ignores its late failure', async () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    let aborted = false
    ctx.connection.rpc.call = (_channel, _method, _payload, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true
        reject(new Error('late abort'))
      }, { once: true })
    })
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    assert.equal(face.hooks.codexCard.getSnapshot().routes.codex.state, 'loading')
    ctx.disposeEffects()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(aborted, true)
    assert.equal(face.hooks.codexCard.getSnapshot().routes.codex.state, 'loading', 'disposed controller publishes no late failure')
  })
})

describe('provider route state', () => {
  test('maps provider ids onto the three route slots', () => {
    const { PROVIDER_ROUTES } = materialize().exports
    assert.equal(PROVIDER_ROUTES['openai-codex'], 'codex')
    assert.equal(PROVIDER_ROUTES['opencode-go'], 'opencode')
    assert.equal(PROVIDER_ROUTES['opencode-go-extra'], 'opencode')
    assert.equal(PROVIDER_ROUTES['deepseek-official'], 'deepseek')
    assert.equal(PROVIDER_ROUTES['deepseek'], 'deepseek')
    assert.equal(PROVIDER_ROUTES['glm-5.3'], undefined)
  })

  test('each provider slot loads independently and keeps its own data', async () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    const calls = []
    ctx.connection.rpc.call = async (_channel, _method, payload) => {
      calls.push(payload.provider)
      if (payload.provider === 'deepseek-official') {
        return {
          ok: true,
          value: {
            kind: 'balance',
            provider: 'deepseek-official',
            isAvailable: true,
            balances: [{ currency: 'CNY', totalBalance: '110.00' }],
            fetchedAt: '2026-08-20T12:00:00.000Z',
          },
        }
      }
      if (payload.provider === 'opencode-go') {
        return {
          ok: true,
          value: {
            kind: 'windows',
            provider: 'opencode-go',
            windows: [
              { id: '5h', usedPercent: 10, remainingPercent: 90, resetsAt: 1_788_134_407 },
              { id: '7d', usedPercent: 20, remainingPercent: 80, resetsAt: 1_788_134_407 },
              { id: '1m', usedPercent: 30, remainingPercent: 70, resetsAt: 1_788_134_407 },
            ],
            fetchedAt: '2026-08-20T12:00:00.000Z',
          },
        }
      }
      return { ok: false, error: { code: 'unavailable' } }
    }
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    await face.refreshUsage('opencode-go')
    await face.refreshUsage('deepseek-official')
    const state = face.hooks.codexCard.getSnapshot()
    assert.equal(state.routes.opencode.state, 'ready')
    assert.equal(state.routes.deepseek.state, 'ready')
    assert.equal(state.routes.opencode.usage.kind, 'windows')
    assert.equal(state.routes.deepseek.usage.kind, 'balance')
    assert.deepEqual(calls.slice(-2).sort(), ['deepseek-official', 'opencode-go'])
  })

  test('a busy provider slot coalesces a second refresh', async () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    let release
    const gate = new Promise(resolve => { release = resolve })
    let opencodeCalls = 0
    ctx.connection.rpc.call = (_channel, _method, payload) => {
      if (payload.provider === 'opencode-go') {
        opencodeCalls++
        return gate
      }
      return Promise.resolve({ ok: false, error: { code: 'unavailable' } })
    }
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    const first = face.refreshUsage('opencode-go')
    const second = face.refreshUsage('opencode-go')
    assert.equal(opencodeCalls, 1, 'the second refresh joins the in-flight read instead of racing it')
    release({
      ok: true,
      value: {
        kind: 'windows',
        provider: 'opencode-go',
        windows: [{ id: '5h', usedPercent: 10, remainingPercent: 90 }],
        fetchedAt: '2026-08-20T12:00:00.000Z',
      },
    })
    await Promise.all([first, second])
    const state = face.hooks.codexCard.getSnapshot()
    assert.equal(state.routes.opencode.state, 'ready')
    assert.equal(state.routes.opencode.usage.windows[0].remainingPercent, 90)
  })

  test('capsule copy shows used, three OpenCode windows, and DeepSeek balance', () => {
    const { quotaChipLabel, quotaChipReady, TEXT } = materialize().exports
    const text = TEXT.zh
    assert.equal(quotaChipLabel({ state: 'ready', usage: { kind: 'windows', windows: [{ id: '7d', usedPercent: 40, remainingPercent: 60 }] } }, text), '周已用 40%')
    assert.equal(quotaChipLabel({
      state: 'ready',
      usage: {
        kind: 'windows',
        windows: [
          { id: '5h', usedPercent: 10, remainingPercent: 90 },
          { id: '7d', usedPercent: 20, remainingPercent: 80 },
        ],
      },
    }, text), '5h 10% · 7d 20%')
    assert.equal(quotaChipLabel({
      state: 'ready',
      usage: {
        kind: 'windows',
        windows: [
          { id: '5h', usedPercent: 10, remainingPercent: 90 },
          { id: '7d', usedPercent: 20, remainingPercent: 80 },
          { id: '1m', usedPercent: 30, remainingPercent: 70 },
        ],
      },
    }, text), '5h 10% · 7d 20% · 1m 30%')
    assert.equal(quotaChipLabel({ state: 'ready', usage: { kind: 'balance', isAvailable: true, balances: [{ currency: 'CNY', totalBalance: '110.00' }] } }, text), '余额 ¥110.00')
    assert.equal(quotaChipLabel({ state: 'failed', failure: 'no-credential', usage: undefined }, text), '额度 --')
    assert.equal(quotaChipLabel({ state: 'loading', usage: undefined }, text), '额度 …')
    assert.equal(quotaChipReady({ usage: undefined }), false)
    assert.equal(quotaChipReady({ usage: { kind: 'windows', windows: [] } }), false)
    assert.equal(quotaChipReady({ usage: { kind: 'windows', windows: [{ id: '7d' }] } }), true)
    assert.equal(quotaChipReady({ usage: { kind: 'balance', balances: [] } }), false)
    assert.equal(quotaChipReady({ usage: { kind: 'balance', balances: [{}] } }), true)
  })

  test('failure copy covers missing keys and missing subscriptions', () => {
    const { quotaFailureText } = materialize().exports
    assert.match(quotaFailureText('no-credential', 'zh'), /API Key/u)
    assert.match(quotaFailureText('no-subscription', 'zh'), /订阅/u)
    assert.match(quotaFailureText('no-credential', 'en'), /API key/u)
  })

  test('exposes the session model directory through the face when the service exists', () => {
    const { exports } = materialize()
    const directory = {
      store: {
        getSnapshot: () => ({ current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, status: 'ready' }),
        subscribe: () => () => {},
      },
      load: async () => {},
    }
    const ctx = fakeContext()
    ctx.get = name => (name === 'connection' ? ctx.connection
      : name === 'remote' ? ctx.remote
      : name === 'modelDirectories' ? { directoryFor: () => directory }
      : undefined)
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    const entry = face.modelDirectoryFor('session-1')
    assert.equal(typeof entry.getSnapshot, 'function')
    assert.equal(entry.getSnapshot().current.provider, 'deepseek-official')
  })

  test('rebuilds the wrapper when the harness replaces a session directory', () => {
    // The harness disposes a session's directory when its scope tears down and
    // builds a fresh one on the way back, and a disposed one stops notifying.
    // Caching by session id alone leaves the chip subscribed to a dead store,
    // frozen on the model from the previous visit.
    const { exports } = materialize()
    const makeDirectory = provider => ({
      store: {
        getSnapshot: () => ({ current: { provider: provider, model: 'm' }, status: 'ready' }),
        subscribe: () => () => {},
      },
      load: async () => {},
    })
    let directory = makeDirectory('openai-codex')
    const ctx = fakeContext()
    ctx.get = name => (name === 'connection' ? ctx.connection
      : name === 'remote' ? ctx.remote
      : name === 'modelDirectories' ? { directoryFor: () => directory }
      : undefined)
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    const first = face.modelDirectoryFor('session-1')
    assert.equal(face.modelDirectoryFor('session-1'), first,
      'a stable directory must yield a stable wrapper, or useSyncExternalStore resubscribes every render')
    directory = makeDirectory('deepseek-official')
    const second = face.modelDirectoryFor('session-1')
    assert.notEqual(second, first, 'a replaced directory must not keep the old wrapper')
    assert.equal(second.getSnapshot().current.provider, 'deepseek-official')
  })

  test('a service that is not mounted yet is re-asked, not written off for the page', () => {
    // The chip can render before the model-selection plugin mounts. Caching
    // that miss keeps the chip off the header until a reload.
    const { exports } = materialize()
    const directory = {
      store: { getSnapshot: () => ({ current: { provider: 'openai-codex', model: 'm' }, status: 'ready' }), subscribe: () => () => {} },
      load: async () => {},
    }
    let service
    const ctx = fakeContext()
    ctx.get = name => (name === 'connection' ? ctx.connection
      : name === 'remote' ? ctx.remote
      : name === 'modelDirectories' ? service
      : undefined)
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    assert.equal(face.modelDirectoryFor('session-1'), undefined, 'nothing to answer with yet')
    service = { directoryFor: () => directory }
    const entry = face.modelDirectoryFor('session-1')
    assert.ok(entry !== undefined && entry.getSnapshot().current.provider === 'openai-codex',
      'the later mount has to be visible')
  })

  test('a session whose scope is not registered yet is retried once it is', () => {
    const { exports } = materialize()
    const directory = {
      store: { getSnapshot: () => ({ current: { provider: 'openai-codex', model: 'm' }, status: 'ready' }), subscribe: () => () => {} },
      load: async () => {},
    }
    let scoped = false
    const ctx = fakeContext()
    ctx.get = name => (name === 'connection' ? ctx.connection
      : name === 'remote' ? ctx.remote
      : name === 'modelDirectories' ? { directoryFor: () => { if (!scoped) throw new Error('no scope'); return directory } }
      : undefined)
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    assert.equal(face.modelDirectoryFor('session-1').getSnapshot().current, null, 'the stand-in, for now')
    scoped = true
    assert.equal(face.modelDirectoryFor('session-1').getSnapshot().current.provider, 'openai-codex',
      'a timing miss must not be cached as a verdict')
  })

  test('a session without a directory scope answers the empty stand-in', () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    ctx.get = name => (name === 'connection' ? ctx.connection
      : name === 'remote' ? ctx.remote
      : name === 'modelDirectories' ? { directoryFor: () => { throw new Error('no scope') } }
      : undefined)
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    const entry = face.modelDirectoryFor('session-1')
    assert.equal(entry.getSnapshot().current, null)
    assert.equal(typeof entry.ensureLoaded, 'function')
    assert.doesNotThrow(() => { entry.ensureLoaded() })
  })
})

describe('the card component', () => {
  /**
   * Enough React for a component that only reads state and builds elements.
   * The card is one of the pieces AGENTS.md warns is captured but never
   * called; calling it is the only way a rename inside it goes red here
   * rather than in a browser.
   * @returns {object} the fake module the client module table hands over.
   */
  function fakeReact() {
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: initial => [initial, () => {}],
      useCallback: fn => fn,
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useSyncExternalStore: (_subscribe, read) => read(),
    }
  }

  /** @param {object} slot - one per-route usage slot @returns {{text: string}} what the card renders. */
  function renderCard(slot) {
    const { exports } = materialize({ 'react': fakeReact(), '@deepseek-ai/dsh-client-ui-primitives': {} })
    const ctx = fakeContext()
    exports.apply(ctx)
    const { component } = ctx.registrations[0]
    return flatten(component({
      useCodexCard: select => select({ language: 'zh', routes: { codex: slot } }),
      refreshUsage: () => {},
    }))
  }

  test('the collapsed header carries the account numbers, not an editor', () => {
    const rendered = renderCard({
      usage: { kind: 'windows', windows: [{ id: '5h', usedPercent: 12, remainingPercent: 88 }], planType: 'plus' },
      state: 'ready',
      failure: undefined,
      background: false,
      generation: 1,
    })
    assert.match(rendered.text, /OpenAI Codex/u)
    assert.match(rendered.text, /5h 12%/u, 'the badge reads the windows the Host answered')
    assert.doesNotMatch(rendered.text, /保存|上下文长度/u, 'this card edits nothing')
  })

  test('a route with nothing read yet still renders, muted', () => {
    const rendered = renderCard({ usage: undefined, state: 'loading', failure: undefined, background: false, generation: 0 })
    assert.match(rendered.text, /额度 …/u)
  })
})

describe('card copy', () => {
  test('never shows the reader a name only this codebase knows', () => {
    const { TEXT } = materialize().exports
    // Every string either surface can render: the card and the chip both build
    // their text out of this table and nothing else.
    const forbidden = /cordis|patch\.yml|settings\.yaml|realm|compaction-basic|seam|namespace|用户层|配置层|schema|modelOverrides|installSection/iu
    for (const language of Object.keys(TEXT)) {
      for (const [key, line] of Object.entries(TEXT[language])) {
        assert.doesNotMatch(line, forbidden, `card copy leaks an internal name at ${language}.${key}: ${line}`)
      }
    }
  })

  test('the sign-in copy sends the reader somewhere that exists', () => {
    // The command it used to name — `dsh plugin … exec dsh-codex-lite login` —
    // was deleted with the adapter. Copy that still named it would send the
    // reader to a command that answers "unknown".
    const { TEXT } = materialize().exports
    for (const language of Object.keys(TEXT)) {
      for (const key of ['quotaSignedOut', 'quotaAuth']) {
        assert.doesNotMatch(TEXT[language][key], /login|dsh plugin/u, `${language}.${key} still names the deleted command`)
        assert.match(TEXT[language][key], /README/u, `${language}.${key} must point at the sign-in section`)
      }
    }
  })
})
