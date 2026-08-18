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
 * They need no peer dependencies, so they run in any checkout.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'
import { settingsNs } from '../src/index.js'

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

/**
 * Execute the bundle the way the shell's script loader does: as a classic
 * script whose only contact with the page is `window.__ModuleLoader__`.
 *
 * Run in this realm rather than a `node:vm` one, so the objects the module
 * builds carry this realm's prototypes and assertions can compare them
 * structurally.
 * @returns {object} the captured handoff.
 */
function load() {
  let captured
  const win = { __ModuleLoader__: { load: (handoff) => { captured = handoff } } }
  // eslint-disable-next-line no-new-func -- executing a script is the contract under test
  new Function('window', 'globalThis', 'console', source)(win, win, console)
  return captured
}

/**
 * Materialize the module the way the client module table does.
 * @param {Record<string, unknown>} [table] - the modules `require` may answer.
 * @returns {{exports: object, required: string[]}} the module and what it asked for.
 */
function materialize(table = { 'react': {}, '@deepseek-ai/dsh-client-ui-primitives': {} }) {
  const required = []
  const exports = load().factory((specifier) => {
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
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: {}, base: undefined, user: undefined, revision: 3, writable: true, mode: 'host' }),
    subscribe: () => () => {},
    load: () => Promise.resolve(),
  }
  const api = {
    llm: { models: () => Promise.resolve({ result: { ok: true, value: { groups: [], failures: [] } } }) },
    settings: { mutate: () => Promise.resolve({ result: { ok: true, value: { user: {}, revision: 4 } } }) },
  }
  const ctx = {
    registrations,
    effects,
    scope,
    api,
    get: name => (name === 'connection' ? { api } : name === 'remote' ? { $on: () => () => {} } : undefined),
    inject: (_names, callback) => { callback(ctx) },
    effect: (run, label) => { effects.push(label); run() },
    settingsScope: { bind: spec => ({ ...scope, spec }) },
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
    assert.equal(ctx.registrations.length, 1)
    const { options, component } = ctx.registrations[0]
    assert.equal(options.name, 'settings.plugin.item')
    assert.equal(options.key, settingsNs)
    assert.equal(typeof options.inject, 'function')
    assert.equal(typeof component, 'function')
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
    for (const name of ['edit', 'resetRow', 'removeRow', 'addRow', 'save', 'discard']) {
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
})

describe('save', () => {
  /** Drive the controller through its face, with a capturing settings wire. */
  function saving(mutate, snapshot = {}) {
    const { exports } = materialize()
    const ctx = fakeContext()
    const scope = {
      getSnapshot: () => ({ status: 'ready', base: undefined, user: undefined, revision: 7, writable: true, mode: 'host', ...snapshot }),
      subscribe: () => () => {},
      load: () => Promise.resolve(),
    }
    ctx.settingsScope = { bind: () => scope }
    ctx.api.settings.mutate = mutate
    ctx.get = name => (name === 'connection' ? { api: ctx.api } : name === 'remote' ? { $on: () => () => {} } : undefined)
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

  test('refuses to send an invalid draft', async () => {
    let calls = 0
    const face = saving(() => { calls++; return Promise.resolve({ result: { ok: true, value: {} } }) })
    face.edit('gpt-5.6-sol', 'nonsense')
    await face.save()
    assert.equal(calls, 0)
    assert.match(face.hooks.codexCard.getSnapshot().failure, /整数|whole number/u)
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
