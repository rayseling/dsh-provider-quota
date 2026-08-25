/**
 * Contract tests for the browser half, executed as the classic script it is,
 * with no DOM and no React. They pin the three things that are expensive to
 * get wrong:
 *
 * - the module-table contract, because a mismatched handoff id or a `require`
 *   outside the platform seed set fails at page load rather than at build;
 * - the anti-brick posture, because an entry that throws or waits on a missing
 *   service takes the whole web UI down with it;
 * - the pure edit helpers, which decide what actually reaches the document.
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
const settingsNs = 'llm-openai-codex-lite'

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

/** A context whose services all answer, capturing what the module registers. */
function fakeContext(overrides = {}) {
  const registrations = []
  const effects = []
  const effectDisposers = []
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: {}, base: undefined, user: undefined, revision: 3, writable: true, mode: 'host' }),
    subscribe: () => () => {},
  }
  // The Host's shared describe mirror. The scope derives from it, so folding a
  // write answer in is what moves the revision — there is no `load` on a scope.
  const mirror = { getSnapshot: () => ({ status: 'ready' }), subscribe: () => () => {}, ensure: () => Promise.resolve(), acceptView: () => {} }
  const api = {
    llm: { models: () => Promise.resolve({ result: { ok: true, value: { groups: [], failures: [] } } }) },
    settings: { mutate: () => Promise.resolve({ result: { ok: true, value: { user: {}, revision: 4 } } }) },
  }
  const connection = {
    api,
    rpc: { call: () => Promise.resolve({ ok: false, error: { code: 'unavailable' } }) },
  }
  const ctx = {
    registrations,
    effects,
    scope,
    api,
    connection,
    get: name => (name === 'connection' ? connection : name === 'remote' ? { $on: () => () => {} } : undefined),
    inject: (_names, callback) => { callback(ctx) },
    effect: (run, label) => {
      effects.push(label)
      const dispose = run()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
    },
    disposeEffects: () => { effectDisposers.splice(0).reverse().forEach(dispose => dispose()) },
    settingsScope: { bind: spec => ({ ...scope, spec }), describe: () => mirror },
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

  test('binds the scope with its own decoder', () => {
    const { exports } = materialize()
    let spec
    const ctx = fakeContext()
    ctx.settingsScope = { bind: (received) => { spec = received; return ctx.scope } }
    exports.apply(ctx)
    assert.equal(spec.namespace, settingsNs)
    assert.equal(typeof spec.decode, 'function', 'the default decoder can leave the card invisible with no diagnostic')
    assert.deepEqual(spec.decode({ modelOverrides: {} }), { modelOverrides: {} })
    assert.equal(spec.decode(null), undefined)
    assert.equal(spec.decode([]), undefined)
  })

  test('publishes a face whose hooks the slot renderer can bind', () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    assert.equal(typeof face.hooks.codexCard.getSnapshot, 'function')
    assert.equal(typeof face.hooks.codexCard.subscribe, 'function')
    for (const name of ['edit', 'resetRow', 'removeRow', 'addRow', 'setModelEnabled', 'selectAllModels', 'resetModels', 'refreshUsage', 'loadUsage', 'modelDirectoryFor', 'save', 'discard']) {
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
    ctx.settingsScope = { bind: () => { throw new Error('no settings surface here') } }
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

describe('parseWindow', () => {
  const cases = [
    ['1000000', 1_000_000], ['272000', 272_000],
    ['1m', 1_000_000], ['1M', 1_000_000], ['272k', 272_000], ['272K', 272_000],
    ['1.5m', 1_500_000], ['1.5k', 1500],
    ['1_000_000', 1_000_000], ['1,000,000', 1_000_000], ['  900000  ', 900_000],
  ]
  for (const [text, value] of cases) {
    test(`reads ${JSON.stringify(text)} as ${value}`, () => {
      assert.deepEqual(materialize().exports.parseWindow(text), { kind: 'set', value })
    })
  }

  test('reads an empty field as the intent to clear', () => {
    const { parseWindow } = materialize().exports
    assert.deepEqual(parseWindow(''), { kind: 'clear' })
    assert.deepEqual(parseWindow('   '), { kind: 'clear' })
  })

  test('refuses anything that is not a positive whole window', () => {
    const { parseWindow } = materialize().exports
    for (const text of ['0', '-1', 'abc', '1.0001k', '1.5', '1e6', '1m2', '∞']) {
      assert.equal(parseWindow(text), undefined, JSON.stringify(text))
    }
  })
})

describe('formatWindow', () => {
  test('renders the plain integer, so the field shows what is stored', () => {
    const { formatWindow } = materialize().exports
    assert.equal(formatWindow(1_000_000), '1000000')
    assert.equal(formatWindow(undefined), '')
  })

  test('every window the parser accepts survives being shown and read back', () => {
    // The pair has to be a round trip or a stored value becomes uneditable:
    // past 2^53 `String` switches to exponent notation, which the parser
    // refuses, so a field would show a number it then calls invalid.
    const { parseWindow, formatWindow } = materialize().exports
    for (const text of ['1', '272k', '1m', '9007199254740991']) {
      const read = parseWindow(text)
      assert.equal(read.kind, 'set', text)
      assert.deepEqual(parseWindow(formatWindow(read.value)), read, `round trip: ${text}`)
    }
    assert.equal(parseWindow('9007199254740993'), undefined, 'past 2^53 the digits stop being exact')
    assert.equal(parseWindow('1e100'), undefined)
  })
})

describe('an allowlist the catalog outgrew', () => {
  test('drops ids no checkbox can show, and passes them through only while the catalog is unknown', () => {
    const { orderModelIds } = materialize().exports
    const catalog = ['gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol']
    assert.deepEqual(
      orderModelIds(['gpt-5.6-sol', 'gpt-9-retired', 'gpt-5.4'], catalog),
      ['gpt-5.4', 'gpt-5.6-sol'],
      'catalog order, and nothing the grid cannot render',
    )
    // Resubmitting a dead id is what earns the raw seam rejection naming an id
    // that is nowhere on screen; the next save has to be the repair instead.
    assert.deepEqual(orderModelIds(['gpt-9-retired'], catalog), [])
    // An empty catalog is "not loaded yet", not "nothing exists" — dropping
    // the stored ids there would stage a write that wipes the allowlist.
    assert.deepEqual(orderModelIds(['gpt-9-retired'], []), ['gpt-9-retired'])
  })

  test('the fallback catalog never presents the composition allowlist as the whole catalog', async () => {
    // The base allowlist is a narrowing. Serving it as the catalog is what
    // locks a one-model deployment out of re-enabling anything, which is the
    // situation the catalog RPC exists to prevent.
    const { exports } = materialize()
    const ctx = fakeContext()
    ctx.scope.getSnapshot = () => ({
      status: 'ready', value: {}, base: { enabledModels: ['gpt-5.5'] }, user: undefined,
      revision: 3, writable: true, mode: 'host',
    })
    ctx.connection.rpc.call = async (_channel, method) => (method === 'catalog'
      ? { ok: false, error: { code: 'method-not-found' } }
      : { ok: false, error: { code: 'unavailable' } })
    ctx.api.llm.models = () => Promise.resolve({
      result: { ok: true, value: { groups: [{ id: 'openai-codex', models: [{ id: 'gpt-5.4' }, { id: 'gpt-5.6-sol' }] }], failures: [] } },
    })
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const state = face.hooks.codexCard.getSnapshot()
    assert.deepEqual(state.catalog, ['gpt-5.4', 'gpt-5.6-sol', 'gpt-5.5'],
      'the live list, unioned with the base so nothing enabled vanishes')
    assert.equal(state.catalogPartial, true, 'and it says the list may be short')
  })
})

describe('catalog lifecycle on unload', () => {
  test('a controller disposed mid-load aborts its request and stays quiet', async () => {
    // A late answer arriving after unmount is expected, not a fault worth a
    // console line and a publish into a torn-down store. `catalogState` is not
    // asserted here on purpose: dispose deliberately stops publishing, so the
    // last snapshot keeps whatever it said — the observable contract is the
    // abort and the silence.
    const { exports } = materialize()
    const ctx = fakeContext()
    let settle
    let aborted = false
    // The catalog RPC refuses at once, so the fallback runs and the hang is in
    // `api.llm.models` — which is the path whose late answer used to reach
    // `failCatalog` after unmount.
    ctx.connection.rpc.call = (_channel, method, _payload, signal) => {
      if (method !== 'catalog') return Promise.resolve({ ok: false, error: { code: 'unavailable' } })
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      return Promise.resolve({ ok: false, error: { code: 'method-not-found' } })
    }
    ctx.api.llm.models = () => new Promise((resolve) => { settle = resolve })
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    assert.equal(face.hooks.codexCard.getSnapshot().catalogState, 'loading')
    const warnings = []
    const realWarn = console.warn
    console.warn = (...args) => { warnings.push(args) }
    try {
      await new Promise(resolve => setImmediate(resolve))
      ctx.disposeEffects()
      settle({ result: { ok: false, error: { code: 'gone' } } })
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(warnings, [], 'a late answer after unmount is expected, not a warning')
    } finally {
      console.warn = realWarn
    }
    let started = false
    ctx.api.llm.models = () => { started = true; return Promise.resolve({ result: { ok: true, value: { groups: [], failures: [] } } }) }
    face.retryCatalog()
    assert.equal(started, false, 'and a disposed controller starts no new read')
    assert.equal(aborted, false, 'the RPC answered before unload, so nothing was left to abort')
  })
})

describe('weekly usage card state', () => {
  const result = {
    ok: true,
    value: {
      kind: 'windows',
      provider: 'openai-codex',
      planType: 'plus',
      windows: [{ id: '7d', usedPercent: 3, remainingPercent: 97, resetsAt: 1_788_134_407 }],
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

  test('loads on mount, publishes weekly usage, and force-refreshes on demand', async () => {
    const calls = []
    const { exports } = materialize()
    const ctx = fakeContext()
    ctx.connection.rpc.call = async (channel, method, payload, signal) => {
      calls.push({ channel, method, payload, signal })
      return method === 'catalog' ? { ok: true, value: { models: ['gpt-5.5', 'gpt-5.6-sol'] } } : result
    }
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    await new Promise(resolve => setImmediate(resolve))
    const state = face.hooks.codexCard.getSnapshot()
    assert.equal(state.usageState, 'ready')
    assert.deepEqual(state.usage, result.value)
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

  test('an account with no weekly window reads as ready-and-empty, not as a failure', async () => {
    // The host answers `windows: []` for an account OpenAI reports no weekly
    // window for. Refusing that shape here would file a real answer under
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
    assert.equal(state.usageState, 'ready')
    assert.equal(state.usageFailure, undefined)
    assert.deepEqual(state.usage.windows, [])
    assert.equal(exports.weeklyWindowOf(state.usage), undefined)
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
    assert.equal(state.usageFailure, 'signed-out')
    const copy = exports.quotaFailureText(state.usageFailure, 'zh')
    assert.match(copy, /尚未登录/u)
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
    assert.equal(face.hooks.codexCard.getSnapshot().usageState, 'loading')
    ctx.disposeEffects()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(aborted, true)
    assert.equal(face.hooks.codexCard.getSnapshot().usageState, 'loading', 'disposed controller publishes no late failure')
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

  test('capsule copy shows remaining, three OpenCode windows, and DeepSeek balance', () => {
    const { quotaChipLabel, quotaChipReady, TEXT } = materialize().exports
    const text = TEXT.zh
    assert.equal(quotaChipLabel({ state: 'ready', usage: { kind: 'windows', windows: [{ id: '7d', usedPercent: 40, remainingPercent: 60 }] } }, text), '周剩余 60%')
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
    }, text), '5h 90% · 7d 80% · 1m 70%')
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
      : name === 'remote' ? { $on: () => () => {} }
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
      : name === 'remote' ? { $on: () => () => {} }
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
      : name === 'remote' ? { $on: () => () => {} }
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
      : name === 'remote' ? { $on: () => () => {} }
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
      : name === 'remote' ? { $on: () => () => {} }
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

describe('the model list', () => {
  /** Drive the controller through its face, with a capturing catalog wire. */
  function withCatalog(models) {
    const { exports } = materialize()
    const ctx = fakeContext()
    let calls = 0
    ctx.api.llm.models = () => {
      calls++
      return Promise.resolve(models())
    }
    ctx.get = name => (name === 'connection' ? ctx.connection : name === 'remote' ? { $on: () => () => {} } : undefined)
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    return { face, calls: () => calls }
  }

  /** Let the catalog promise chain settle. */
  const settle = () => new Promise(resolve => setImmediate(resolve))

  test('offers every route model that is not already on the card', async () => {
    const { face } = withCatalog(() => ({
      result: { ok: true, value: { groups: [{ id: 'openai-codex', models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.6-sol' }] }] } },
    }))
    await settle()
    const state = face.hooks.codexCard.getSnapshot()
    assert.deepEqual(state.addable, ['gpt-5.5', 'gpt-5.6-sol'])
    assert.equal(state.catalogFailed, false)
  })

  test('a composition subset does not hide models from the full catalog picker', async () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    const snapshot = { status: 'ready', value: {}, base: { enabledModels: ['gpt-5.5'] }, user: undefined, revision: 3, writable: true, mode: 'host' }
    ctx.settingsScope = {
      bind: spec => ({ ...ctx.scope, spec, getSnapshot: () => snapshot }),
      describe: () => ({ acceptView: () => {} }),
    }
    ctx.connection.rpc.call = (_channel, method) => method === 'catalog'
      ? Promise.resolve({ ok: true, value: { models: ['gpt-5.5', 'gpt-5.6-sol'] } })
      : Promise.resolve({ ok: false, error: { code: 'unavailable' } })
    ctx.get = name => (name === 'connection' ? ctx.connection : name === 'remote' ? { $on: () => () => {} } : undefined)
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    await new Promise(resolve => setImmediate(resolve))
    const state = face.hooks.codexCard.getSnapshot()
    assert.deepEqual(state.catalog, ['gpt-5.5', 'gpt-5.6-sol'])
    assert.deepEqual(state.selectedModels, ['gpt-5.5'])
  })

  test('a response shaped otherwise fails the picker instead of the page', async () => {
    // The picker is the only way to add a model, so a list that never arrives
    // must be distinguishable from having added them all. A throw inside the
    // fulfilment handler used to escape as an unhandled rejection and leave
    // the button reading "all added".
    for (const value of [{ groups: 'not an array' }, { groups: [{ id: 'openai-codex', models: 'nope' }] }, {}]) {
      const { face } = withCatalog(() => ({ result: { ok: true, value } }))
      await settle()
      const state = face.hooks.codexCard.getSnapshot()
      assert.deepEqual(state.addable, [], JSON.stringify(value))
      assert.equal(state.catalogFailed, true, JSON.stringify(value))
    }
  })

  test('a rejected request fails the picker, and the retry asks again', async () => {
    const { face, calls } = withCatalog(() => Promise.reject(new Error('offline')))
    await settle()
    assert.equal(face.hooks.codexCard.getSnapshot().catalogFailed, true)
    assert.equal(calls(), 1)
    face.retryCatalog()
    await settle()
    assert.equal(calls(), 2, 'the operator can ask again without reloading the page')
  })
})

describe('rowsOf', () => {
  const base = { modelOverrides: { 'gpt-5.6-sol': { contextWindow: 1_000_000 } } }
  const user = { modelOverrides: { 'gpt-5.5': { contextWindow: 500_000 } } }

  test('labels a row by which layer holds it, never by comparing values', () => {
    const { rowsOf } = materialize().exports
    const equal = { modelOverrides: { 'gpt-5.6-sol': { contextWindow: 1_000_000 } } }
    const rows = rowsOf(base, equal, {})
    assert.equal(rows[0].source, 'user', 'an override equal to the layer below is still an override')
  })

  test('unions both layers and the staged edits, ordered by id', () => {
    const { rowsOf } = materialize().exports
    const rows = rowsOf(base, user, { 'gpt-5.4': '9000' })
    assert.deepEqual(rows.map(row => row.model), ['gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol'])
    assert.deepEqual(rows.map(row => row.source), ['none', 'user', 'base'])
    assert.deepEqual(rows.map(row => row.text), ['9000', '500000', '1000000'])
  })

  test('marks a staged draft that is not a window', () => {
    const { rowsOf } = materialize().exports
    const [row] = rowsOf({}, {}, { 'gpt-5.5': 'nonsense' })
    assert.equal(row.invalid, true)
    assert.equal(row.value, undefined)
    assert.equal(row.staged, true)
  })

  test('each row offers the action its value actually allows', () => {
    const { rowsOf } = materialize().exports
    const rows = rowsOf(base, user, { 'gpt-5.4': '' })
    assert.equal(rows.find(row => row.source === 'base').action, 'locked', 'a config-file value cannot be taken away here')
    assert.equal(rows.find(row => row.source === 'user').action, 'reset', 'a stored override goes back to the model default')
    assert.equal(rows.find(row => row.model === 'gpt-5.4').action, 'remove', 'a row someone just added is dropped outright')
  })

  test('tolerates layers the Host has not reported yet', () => {
    const { rowsOf } = materialize().exports
    assert.deepEqual(rowsOf(undefined, undefined, {}), [])
    assert.deepEqual(rowsOf(null, { modelOverrides: null }, {}), [])
  })
})

describe('hintsOf', () => {
  test('explains why a composition row cannot be cleared, alongside its numbers', () => {
    const { hintsOf } = materialize().exports
    const lines = hintsOf({ source: 'base', value: 1_000_000, invalid: false }, 'zh')
    assert.equal(lines.length, 2, 'the derived numbers, then the reason Clear is disabled')
    assert.match(lines[0].text, /1,000,000/u)
    assert.match(lines[1].text, /配置文件/u, 'it must say where the value comes from, without naming internals')
  })

  test('says nothing extra for a row the user layer owns', () => {
    const { hintsOf } = materialize().exports
    const lines = hintsOf({ source: 'user', value: 900_000, invalid: false }, 'zh')
    assert.equal(lines.length, 1)
    assert.doesNotMatch(lines[0].text, /配置文件/u)
  })

  test('an invalid draft replaces the numbers with the reason', () => {
    const { hintsOf } = materialize().exports
    const [line, ...rest] = hintsOf({ source: 'none', value: undefined, invalid: true }, 'zh')
    assert.equal(line.error, true)
    assert.deepEqual(rest, [])
  })

  test('still explains the composition row while its draft is invalid', () => {
    const { hintsOf } = materialize().exports
    const lines = hintsOf({ source: 'base', value: undefined, invalid: true }, 'zh')
    assert.equal(lines.length, 2)
    assert.equal(lines[0].error, true)
    assert.match(lines[1].text, /配置文件/u)
  })

  test('answers in English too, and falls back for an unknown language', () => {
    const { hintsOf } = materialize().exports
    assert.match(hintsOf({ source: 'base', value: 1000, invalid: false }, 'en')[1].text, /config file/u)
    assert.equal(hintsOf({ source: 'base', value: 1000, invalid: false }, 'kl').length, 2)
  })
})

describe('removing a row someone added', () => {
  test('drops it from the list instead of leaving an empty field behind', () => {
    const { exports } = materialize()
    const ctx = fakeContext()
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    face.addRow('gpt-5.4')
    assert.equal(face.hooks.codexCard.getSnapshot().rows.length, 1)
    face.removeRow('gpt-5.4')
    assert.deepEqual(face.hooks.codexCard.getSnapshot().rows, [], 'the row is gone, with nothing to save')
  })
})

describe('buildOps', () => {
  const user = { modelOverrides: { 'gpt-5.5': { contextWindow: 500_000 } } }

  test('writes one op per edited model, addressing the model alone', () => {
    const { buildOps } = materialize().exports
    assert.deepEqual(buildOps(user, { 'gpt-5.6-sol': '1m' }), [
      { op: 'set', path: ['modelOverrides', 'gpt-5.6-sol', 'contextWindow'], value: 1_000_000 },
    ])
  })

  test('clears a stored override, and ignores clearing one that is not stored', () => {
    const { buildOps } = materialize().exports
    assert.deepEqual(buildOps(user, { 'gpt-5.5': '' }), [{ op: 'unset', path: ['modelOverrides', 'gpt-5.5'] }])
    assert.deepEqual(buildOps(user, { 'gpt-5.4': '' }), [])
  })

  test('emits nothing for a draft that matches what is stored', () => {
    assert.deepEqual(materialize().exports.buildOps(user, { 'gpt-5.5': '500000' }), [])
  })

  test('refuses the whole write when any draft is not a window', () => {
    const { buildOps } = materialize().exports
    assert.equal(buildOps(user, { 'gpt-5.6-sol': '1m', 'gpt-5.4': 'oops' }), undefined)
  })

  test('orders ops by model id, so one save reads the same way twice', () => {
    const { buildOps } = materialize().exports
    const ops = buildOps({}, { 'gpt-5.6-sol': '1m', 'gpt-5.4': '2k', 'gpt-5.5': '3k' })
    assert.deepEqual(ops.map(op => op.path[1]), ['gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol'])
  })

  test('writes a model allowlist and combines it with context edits', () => {
    const { buildOps } = materialize().exports
    assert.deepEqual(buildOps({}, {}, { kind: 'set', ids: ['gpt-5.6-sol'] }), [
      { op: 'set', path: ['enabledModels'], value: ['gpt-5.6-sol'] },
    ])
    assert.deepEqual(buildOps({ enabledModels: ['gpt-5.6-sol'] }, {}, { kind: 'set', ids: ['gpt-5.6-sol'] }), [])
    assert.deepEqual(buildOps({ enabledModels: ['gpt-5.6-sol'] }, {}, { kind: 'unset' }), [
      { op: 'unset', path: ['enabledModels'] },
    ])
    assert.deepEqual(buildOps({ enabledModels: ['gpt-5.6-sol'] }, { 'gpt-5.6-sol': '1m' }, { kind: 'set', ids: ['gpt-5.5'] }), [
      { op: 'set', path: ['modelOverrides', 'gpt-5.6-sol', 'contextWindow'], value: 1_000_000 },
      { op: 'set', path: ['enabledModels'], value: ['gpt-5.5'] },
    ])
  })

  test('an emptied allowlist is told so, not told to enter a whole number', () => {
    // `buildOps` refuses for two unrelated reasons — an unparseable window and
    // an allowlist with nothing left in it — and `save` used to render the
    // window sentence for both. `modelSelectionOps` is the discriminator it
    // now asks, so that is what this pins; asserting only that the two strings
    // differ would pass with the wiring still crossed.
    const { modelSelectionOps, buildOps, TEXT } = materialize().exports
    const user = { enabledModels: ['gpt-5.6-sol'] }
    assert.equal(modelSelectionOps(user, { kind: 'set', ids: [] }), undefined,
      'an empty allowlist is what routes save() to the model copy')
    assert.deepEqual(modelSelectionOps(user, undefined), [],
      'no staged selection must not be mistaken for an empty one')
    // A bad window with a fine allowlist still refuses, and still through the
    // other branch — so the two reasons stay distinguishable at the call site.
    assert.equal(buildOps(user, { 'gpt-5.6-sol': 'not-a-number' }, undefined), undefined)
    assert.notEqual(TEXT.zh.modelsEmpty, TEXT.zh.invalid)
    assert.doesNotMatch(TEXT.en.modelsEmpty, /whole number/u)
    assert.match(TEXT.en.invalid, /whole number/u, 'the window copy is still the window copy')
  })

  test('refuses an empty model allowlist', () => {
    assert.equal(materialize().exports.buildOps({}, {}, { kind: 'set', ids: [] }), undefined)
  })
})

describe('save', () => {
  /** Drive the controller through its face, with a capturing settings wire. */
  function saving(mutate, snapshot = {}) {
    const { exports } = materialize()
    const ctx = fakeContext()
    const scope = {
      getSnapshot: () => ({ status: 'ready', base: undefined, user: undefined, revision: 7, writable: true, mode: 'host', ...snapshot }),
      subscribe: () => () => {},
    }
    ctx.settingsScope = { bind: () => scope, describe: () => ({ acceptView: () => {} }) }
    ctx.api.settings.mutate = mutate
    ctx.get = name => (name === 'connection' ? ctx.connection : name === 'remote' ? { $on: () => () => {} } : undefined)
    exports.apply(ctx)
    return ctx.registrations[0].options.inject()
  }

  test('sends one fenced mutate carrying every staged edit', async () => {
    let payload
    const face = saving((received) => {
      payload = received
      return Promise.resolve({ result: { ok: true, value: { user: {}, revision: 8 } } })
    })
    face.edit('gpt-5.6-sol', '900k')
    await face.save()
    assert.deepEqual(payload, {
      ns: settingsNs,
      ops: [{ op: 'set', path: ['modelOverrides', 'gpt-5.6-sol', 'contextWindow'], value: 900_000 }],
      expectedRevision: 7,
    })
    assert.equal(face.hooks.codexCard.getSnapshot().dirty, false, 'a committed save clears the drafts')
  })

  test('shows the seam refusal verbatim, since it names the known ids', async () => {
    const message = 'dsh-codex-lite: modelOverrides names "gpt-9-nope", which the openai-codex catalog does not carry; known ids are gpt-5.5, gpt-5.6-sol'
    const face = saving(() => Promise.resolve({ result: { ok: false, error: { code: 'settings-rejected', message } } }))
    face.addRow('gpt-9-nope')
    face.edit('gpt-9-nope', '1000')
    await face.save()
    const state = face.hooks.codexCard.getSnapshot()
    assert.equal(state.failure, message)
    assert.equal(state.dirty, true, 'a refused save keeps the drafts to correct')
  })

  test('answers a conflict with copy the operator can act on', async () => {
    const face = saving(() => Promise.resolve({ result: { ok: false, error: { code: 'settings-conflict', message: 'revision 7 is stale' } } }))
    face.edit('gpt-5.6-sol', '900k')
    await face.save()
    const { failure } = face.hooks.codexCard.getSnapshot()
    assert.notEqual(failure, 'revision 7 is stale', 'the wire wording is not for the reader')
    assert.match(failure, /改过|changed/u)
  })

  test('reports a write that never reached the host', async () => {
    const face = saving(() => Promise.reject(new Error('offline')))
    face.edit('gpt-5.6-sol', '900k')
    await face.save()
    assert.match(face.hooks.codexCard.getSnapshot().failure, /连接|connection/u)
  })

  test('reports a synchronous write transport error and clears saving', async () => {
    const face = saving(() => { throw new Error('offline') })
    face.edit('gpt-5.6-sol', '900k')
    await face.save()
    const state = face.hooks.codexCard.getSnapshot()
    assert.equal(state.saving, false)
    assert.match(state.failure, /连接|connection/u)
  })

  test('refuses to send an invalid draft', async () => {
    let calls = 0
    const face = saving(() => { calls++; return Promise.resolve({ result: { ok: true, value: {} } }) })
    face.edit('gpt-5.6-sol', 'nonsense')
    await face.save()
    assert.equal(calls, 0)
    assert.match(face.hooks.codexCard.getSnapshot().failure, /整数|whole number/u)
  })

  test('two saves in a row both land, because the first folds what it moved', async () => {
    // A committed write advances the document's revision, and the card fences
    // its writes on the revision it holds. That revision moves when the write
    // answer is folded into the shared mirror the scope derives from — so a
    // card that dropped the answer would send the superseded revision next and
    // be refused as a conflict nobody caused.
    //
    // The fake couples mirror and scope the way the Host does: acceptView
    // replaces what getSnapshot reports, synchronously.
    const { exports } = materialize()
    const ctx = fakeContext()
    let hostRevision = 7
    let held = 7
    const sent = []
    const folded = []
    const scope = {
      getSnapshot: () => ({ status: 'ready', base: undefined, user: undefined, revision: held, writable: true, mode: 'host' }),
      subscribe: () => () => {},
    }
    const mirror = { acceptView: (view) => { folded.push(view.revision); held = view.revision } }
    ctx.settingsScope = { bind: () => scope, describe: () => mirror }
    ctx.api.settings.mutate = (payload) => {
      sent.push(payload.expectedRevision)
      if (payload.expectedRevision !== hostRevision) {
        return Promise.resolve({ result: { ok: false, error: { code: 'settings-conflict', message: 'stale' } } })
      }
      hostRevision += 1
      return Promise.resolve({ result: { ok: true, value: { ns: settingsNs, user: {}, revision: hostRevision } } })
    }
    ctx.get = name => (name === 'connection' ? ctx.connection : name === 'remote' ? { $on: () => () => {} } : undefined)
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    face.edit('gpt-5.6-sol', '900k')
    await face.save()
    face.edit('gpt-5.5', '500k')
    await face.save()
    assert.deepEqual(folded, [8, 9], 'each answer is folded, not fetched back')
    assert.deepEqual(sent, [7, 8], 'the second write is fenced on what the first one produced')
    assert.equal(face.hooks.codexCard.getSnapshot().failure, undefined, 'no conflict nobody caused')
  })

  test('is current the moment it stops being busy, so a second click cannot race it', async () => {
    // Awaiting the save is not the only way in. A click arriving while the
    // write is in flight must find the card busy, and the first one to arrive
    // after it must find the revision already moved — there is no third state.
    const { exports } = materialize()
    const ctx = fakeContext()
    let held = 7
    let answer
    const order = []
    const scope = {
      getSnapshot: () => ({ status: 'ready', base: undefined, user: undefined, revision: held, writable: true, mode: 'host' }),
      subscribe: () => () => {},
    }
    ctx.settingsScope = {
      bind: () => scope,
      describe: () => ({ acceptView: (view) => { order.push('fold'); held = view.revision } }),
    }
    let sent = 0
    ctx.api.settings.mutate = () => {
      sent += 1
      return new Promise((resolve) => { answer = () => resolve({ result: { ok: true, value: { ns: settingsNs, user: {}, revision: 8 } } }) })
    }
    ctx.get = name => (name === 'connection' ? ctx.connection : name === 'remote' ? { $on: () => () => {} } : undefined)
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    face.edit('gpt-5.6-sol', '900k')
    const first = face.save()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(face.hooks.codexCard.getSnapshot().saving, true, 'busy while the write is in flight')
    face.edit('gpt-5.5', '500k')
    await face.save()
    assert.equal(sent, 1, 'the second click found the card still busy')
    answer()
    await first
    order.push('free')
    assert.deepEqual(order, ['fold', 'free'], 'the fold happens before the card is released, never after')
    assert.equal(held, 8)
    assert.equal(face.hooks.codexCard.getSnapshot().saving, false)
  })

  test('a mirror that refuses the fold costs a revision, not the card', async () => {
    // The fold reaches into Host state. If it throws, the save must still
    // finish: the Host's own document-updated signal repairs the mirror, and a
    // stale revision costs one recoverable conflict. A card stuck at "saving"
    // would cost everything after it.
    const { exports } = materialize()
    const ctx = fakeContext()
    ctx.settingsScope = {
      bind: () => ({
        getSnapshot: () => ({ status: 'ready', base: undefined, user: undefined, revision: 7, writable: true, mode: 'host' }),
        subscribe: () => () => {},
      }),
      describe: () => ({ acceptView: () => { throw new Error('mirror refused') } }),
    }
    ctx.api.settings.mutate = () => Promise.resolve({ result: { ok: true, value: { ns: settingsNs, user: {}, revision: 8 } } })
    ctx.get = name => (name === 'connection' ? ctx.connection : name === 'remote' ? { $on: () => () => {} } : undefined)
    exports.apply(ctx)
    const face = ctx.registrations[0].options.inject()
    face.edit('gpt-5.6-sol', '900k')
    await face.save()
    const state = face.hooks.codexCard.getSnapshot()
    assert.equal(state.saving, false, 'the card is released even when the fold throws')
    assert.equal(state.failure, undefined, 'the write did commit; the reader must not be told otherwise')
    assert.equal(state.dirty, false)
  })

  test('sends nothing when the drafts add up to no change', async () => {
    let calls = 0
    const face = saving(() => { calls++; return Promise.resolve({ result: { ok: true, value: {} } }) },
      { user: { modelOverrides: { 'gpt-5.6-sol': { contextWindow: 900_000 } } } })
    face.edit('gpt-5.6-sol', '900000')
    await face.save()
    assert.equal(calls, 0)
    assert.equal(face.hooks.codexCard.getSnapshot().dirty, false)
  })
})

describe('card copy', () => {
  test('never shows the reader a name only this codebase knows', () => {
    const { exports } = materialize()
    // Every string the card can render, reachable through its two text-bearing
    // exports plus the module source's own literals.
    const rows = [
      ...hintLines({ source: 'base', value: 1000, invalid: false }, exports),
      ...hintLines({ source: 'base', value: undefined, invalid: true }, exports),
      ...hintLines({ source: 'user', value: 1000, invalid: false }, exports),
    ]
    const forbidden = /cordis|patch\.yml|settings\.yaml|realm|preset 的隔离|compaction-basic|seam|namespace|用户层|配置层|schema/iu
    for (const line of rows) {
      assert.doesNotMatch(line, forbidden, `card copy leaks an internal name: ${line}`)
    }
  })

  function hintLines(row, exports) {
    return ['zh', 'en'].flatMap(language => exports.hintsOf(row, language).map(line => line.text))
  }
})
