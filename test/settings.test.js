/**
 * Integration tests for the settings section: the three layers, the live
 * rebuild without a re-registration, and the write-time refusal.
 *
 * These boot the real seam — `LlmRuntime`, `FileSettingsProvider` over a temp
 * `$DSH_HOME`, and this plugin — rather than stubbing `ctx.settings`. A stub
 * would only test the shape of our own calls; the properties worth pinning
 * (layer precedence, when a route is re-registered, whether a refused write
 * touches the document) all live in the seam.
 *
 * Nothing here reaches the network: `resolveModelInfo` answers from the
 * installed pi-ai catalog, and no credential is ever resolved.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

const loaded = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('@deepseek-ai/dsh-llm'),
  import('@deepseek-ai/dsh-settings-file'),
  import('../src/index.js'),
  import('@deepseek-ai/dsh-settings'),
  import('@deepseek-ai/schemastery'),
]).then(modules => ({ modules }), error => ({ error }))
const skip = loaded.error === undefined ? false : `peer dependencies are not installed (${loaded.error.code ?? 'import failed'})`
const [cordis, llm, settingsFile, plugin, settings, schemastery] = loaded.modules ?? []

const MODEL = 'gpt-5.6-sol'
const CATALOG_WINDOW = 272_000

/** Temp homes and live fibers this file created. */
const homes = []
const disposers = []
after(async () => {
  for (const dispose of disposers.reverse()) await dispose().catch(() => {})
  await Promise.all(homes.map(home => rm(home, { recursive: true, force: true })))
})

/** @returns {Promise<string>} a tracked, empty harness home. */
async function freshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-codex-lite-settings-'))
  homes.push(home)
  return home
}

/**
 * Boot the seam the way the harness composes it.
 * @param {string} home - temp harness home holding `settings.yaml`.
 * @param {object|undefined} config - the plugin's composition entry.
 * @param {{settings?: boolean, connection?: object}} [options] - optional settings provider and Connection service.
 * @returns {Promise<object>} the root context.
 */
async function boot(home, config, options = {}) {
  const ctx = new cordis.Context()
  disposers.push(() => ctx.fiber.dispose())
  await ctx.plugin(llm.LlmRuntime)
  if (options.connection !== undefined) ctx.provide('connection', options.connection)
  if (options.credentials !== undefined) ctx.provide('credentials', options.credentials)
  if (options.settings !== false) {
    await ctx.plugin(settingsFile.FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false })
  }
  await ctx.plugin(plugin, config)
  return ctx
}

/** @returns {Promise<number>} the window the route currently publishes for `model`. */
const windowOf = async (ctx, model = MODEL) =>
  (await ctx.llm.resolveModelInfo('openai-codex', model)).context.contextWindow
const listedModelsOf = async ctx => (await ctx.llm.listModels('openai-codex')).map(model => model.id)

describe('settings section', { skip }, () => {
  test('the composition entry serves as the base layer', async () => {
    const home = await freshHome()
    const ctx = await boot(home, { modelOverrides: { [MODEL]: { contextWindow: 300_000 } } })
    assert.equal(await windowOf(ctx), 300_000)
  })

  test('an unconfigured install keeps the catalog', async () => {
    const home = await freshHome()
    const ctx = await boot(home, {})
    assert.equal(await windowOf(ctx), CATALOG_WINDOW)
  })

  test('the default allowlist advertises every installed model', async () => {
    const home = await freshHome()
    const ctx = await boot(home, {})
    const models = await listedModelsOf(ctx)
    assert.ok(models.length > 1)
    assert.ok(models.includes(MODEL))
  })

  test('a user allowlist narrows the picker but keeps hidden exact selections routable', async () => {
    const home = await freshHome()
    const ctx = await boot(home, {})
    const all = await listedModelsOf(ctx)
    await ctx.settings.update(plugin.settingsNs, { enabledModels: [MODEL] })
    assert.deepEqual(await listedModelsOf(ctx), [MODEL])
    assert.ok(all.includes('gpt-5.5'))
    await assert.doesNotReject(ctx.llm.resolveModelInfo('openai-codex', 'gpt-5.5'))
    await ctx.settings.replace(plugin.settingsNs, {})
    assert.deepEqual(await listedModelsOf(ctx), all)
  })

  test('rejects an empty or repeating allowlist, and survives one the catalog outgrew', async () => {
    const home = await freshHome()
    const ctx = await boot(home, {})
    await assert.rejects(ctx.settings.update(plugin.settingsNs, { enabledModels: [] }), /enabledModels|>= 1/u)
    await assert.rejects(ctx.settings.update(plugin.settingsNs, { enabledModels: [MODEL, MODEL] }), /duplicate/u)
    assert.deepEqual(await listedModelsOf(ctx), await listedModelsOf(await boot(await freshHome(), {})))
    // A retired id is drift, not a configuration error. The seam runs
    // `validate` when it resolves a namespace, so refusing one here would
    // refuse the whole section on the next boot — including the sizing below.
    await ctx.settings.update(plugin.settingsNs, {
      enabledModels: [MODEL, 'gpt-9-retired'],
      modelOverrides: { [MODEL]: { contextWindow: 300_000 } },
    })
    assert.deepEqual(await listedModelsOf(ctx), [MODEL], 'the id the catalog dropped selects nothing')
    assert.equal(await windowOf(ctx), 300_000, 'and it does not take the unrelated sizing with it')
  })

  test('an allowlist the catalog outgrew entirely advertises the catalog, not an empty picker', async () => {
    const home = await freshHome()
    const ctx = await boot(home, {})
    const all = await listedModelsOf(ctx)
    await ctx.settings.update(plugin.settingsNs, { enabledModels: ['gpt-9-retired'] })
    assert.deepEqual(await listedModelsOf(ctx), all)
  })

  test('a composition entry naming a model the catalog lacks still fails the load', async () => {
    // The stored layer degrades; the deployment's own entry does not. It ships
    // pinned beside the plugin, so a mismatch there is the operator's bug and
    // has to be loud.
    const home = await freshHome()
    await assert.rejects(
      boot(home, { enabledModels: ['gpt-9-nonexistent'] }),
      /which the openai-codex catalog does not carry/u,
    )
  })

  test('a composition allowlist is the default picker surface', async () => {
    const home = await freshHome()
    const ctx = await boot(home, { enabledModels: [MODEL] })
    assert.deepEqual(await listedModelsOf(ctx), [MODEL])
  })

  test('the namespace is registered, which is what dispatches the browser card', async () => {
    const home = await freshHome()
    const ctx = await boot(home, {})
    assert.ok(
      ctx.settings.describe().some(descriptor => descriptor.ns === plugin.settingsNs),
      `settings.describe() must list ${plugin.settingsNs}`,
    )
    // The browser half spells this namespace as a literal, so that its own
    // suite needs no peer dependencies. This is the other end of that pact:
    // the card registers under the name asserted here, and a rename that
    // touched only one half would fail here rather than in a browser.
    assert.equal(plugin.settingsNs, 'llm-openai-codex-lite')
  })

  test('registers quota on the trusted Connection boundary instead of a raw HTTP route', async () => {
    const home = await freshHome()
    let registered
    const connection = {
      rpc: {
        handle(channel, handler, options) {
          registered = { channel, handler, options }
          return async () => {}
        },
      },
    }
    await boot(home, {}, { connection })
    assert.equal(registered.channel, '/dsh-codex-lite')
    assert.equal(typeof registered.handler, 'function')
    assert.deepEqual(registered.options, { authority: 'trusted-host' })
  })

  test('the native DeepSeek route is read from its flat section, not through a providers dict', async () => {
    // The two DeepSeek routes this plugin answers for keep their configuration
    // in differently shaped sections: the pi-ai one nests profiles under
    // `providers` keyed by route, while llm-deepseek registers itself at
    // `settingsPath: []` and puts `apiKeyEnv`/`baseURL` at its own root.
    // Reading the native one through `providers` finds nothing and quietly
    // falls back to the defaults — which would send a key provisioned for a
    // private endpoint to the public one. So this configures both fields away
    // from their defaults and pins where the request actually goes.
    //
    // It doubles as the regression test for `readSection` reaching the section
    // at all: `ctx.settings` throws for a service this plugin never injects,
    // and the catch around it turned that into "nothing configured" for every
    // route at once.
    const home = await freshHome()
    let registered
    const connection = { rpc: { handle(channel, handler) { registered = handler; return async () => {} } } }
    const credentials = {
      resolve: async ref => (String(ref) === 'DEEPSEEK_PRIVATE_KEY' ? { value: 'sk-private' } : undefined),
      readRecord: async () => undefined,
    }
    const ctx = await boot(home, {}, { connection, credentials })
    // Stand in for the native adapter's own section, with the shape it
    // installs: flat, `settingsPath: []`, no `providers` above the fields.
    const z = schemastery.default ?? schemastery
    ctx.settings.register(
      settings.settingsNamespace('llm-deepseek'),
      z.object({ apiKeyEnv: z.string(), baseURL: z.string() }),
      { base: { apiKeyEnv: 'DEEPSEEK_PRIVATE_KEY', baseURL: 'https://deepseek.internal.example/v1/' } },
    )
    const calls = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), auth: init?.headers?.Authorization })
      return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.00' }] }),
        { headers: { 'content-type': 'application/json' } })
    }
    try {
      const answer = await registered('usage', { provider: 'deepseek-official' }, new AbortController().signal)
      assert.equal(answer.ok, true, `expected a balance, got ${JSON.stringify(answer)}`)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://deepseek.internal.example/v1/user/balance',
        'the configured baseURL must be where the balance is read, trailing slash trimmed')
      assert.equal(calls[0].auth, 'Bearer sk-private',
        'the key must come from the configured apiKeyEnv, not the default one')
      assert.equal(JSON.stringify(answer).includes('sk-private'), false, 'no key may reach the browser')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('a stored section overrides the entry for the next request, with no restart', async () => {
    const home = await freshHome()
    const ctx = await boot(home, { modelOverrides: { [MODEL]: { contextWindow: 300_000 } } })
    await ctx.settings.update(plugin.settingsNs, { modelOverrides: { [MODEL]: { contextWindow: 900_000 } } })
    assert.equal(await windowOf(ctx), 900_000)
    assert.match(await readFile(join(home, 'settings.yaml'), 'utf8'), /900000/u)
  })

  test('the route is not re-registered when only the sizing changed', async () => {
    const home = await freshHome()
    const ctx = await boot(home, { modelOverrides: { [MODEL]: { contextWindow: 300_000 } } })
    let announcements = 0
    ctx.on('llm/adapters-updated', () => { announcements++ })
    await ctx.settings.update(plugin.settingsNs, { modelOverrides: { [MODEL]: { contextWindow: 900_000 } } })
    assert.equal(await windowOf(ctx), 900_000, 'the new sizing is live')
    assert.equal(announcements, 0, 'a sizing change must not disturb the route registration')
  })

  test('the layers merge per model instead of replacing the map', async () => {
    const home = await freshHome()
    const ctx = await boot(home, { modelOverrides: { [MODEL]: { contextWindow: 300_000 } } })
    await ctx.settings.update(plugin.settingsNs, { modelOverrides: { 'gpt-5.5': { contextWindow: 500_000 } } })
    assert.equal(await windowOf(ctx, 'gpt-5.5'), 500_000, 'the user layer adds its model')
    assert.equal(await windowOf(ctx), 300_000, 'the entry keeps sizing the model it named')
  })

  test('the composition entry cannot be deleted from the user layer', async () => {
    const home = await freshHome()
    const ctx = await boot(home, { modelOverrides: { [MODEL]: { contextWindow: 300_000 } } })
    await ctx.settings.update(plugin.settingsNs, { modelOverrides: { [MODEL]: { contextWindow: 900_000 } } })
    await ctx.settings.replace(plugin.settingsNs, {})
    assert.equal(await windowOf(ctx), 300_000, 'clearing the user layer falls back to the entry, not the catalog')
  })

  test('a write naming a model the catalog does not carry is refused', async () => {
    const home = await freshHome()
    const ctx = await boot(home, { modelOverrides: { [MODEL]: { contextWindow: 900_000 } } })
    await assert.rejects(
      ctx.settings.update(plugin.settingsNs, { modelOverrides: { 'gpt-9-nonexistent': { contextWindow: 1000 } } }),
      /which the openai-codex catalog does not carry; known ids are/u,
    )
    assert.equal(await windowOf(ctx), 900_000, 'the refused write leaves the route serving')
    const document = await readFile(join(home, 'settings.yaml'), 'utf8').catch(() => '')
    assert.doesNotMatch(document, /gpt-9-nonexistent/u, 'validate runs before persist')
  })

  test('a window past the exact-integer range is refused, so every stored value stays editable', async () => {
    // Beyond 2^53 integers stop being distinguishable and `String` starts
    // producing exponent notation, which the card's field cannot parse back —
    // a value stored there would render as something the card calls invalid.
    const home = await freshHome()
    const ctx = await boot(home, { modelOverrides: { [MODEL]: { contextWindow: 900_000 } } })
    await assert.rejects(
      ctx.settings.update(plugin.settingsNs, { modelOverrides: { [MODEL]: { contextWindow: 1e100 } } }),
      /9007199254740991/u,
    )
    assert.equal(await windowOf(ctx), 900_000)
  })

  test('a stored section that is already invalid leaves the route serving its entry', async () => {
    const home = await freshHome()
    await writeFile(
      join(home, 'settings.yaml'),
      `${plugin.settingsNs}:\n  modelOverrides:\n    gpt-9-nonexistent:\n      contextWindow: 1000\n`,
      { mode: 0o600 },
    )
    const ctx = await boot(home, { modelOverrides: { [MODEL]: { contextWindow: 300_000 } } })
    assert.equal(await windowOf(ctx), 300_000)
  })

  test('a composition entry naming an unknown model still fails the load', async () => {
    const home = await freshHome()
    await assert.rejects(
      boot(home, { modelOverrides: { 'gpt-9-nonexistent': { contextWindow: 1000 } } }),
      /which the openai-codex catalog does not carry/u,
    )
  })

  test('no settings provider leaves the plugin on its composition entry', async () => {
    const home = await freshHome()
    const ctx = await boot(home, { modelOverrides: { [MODEL]: { contextWindow: 300_000 } } }, { settings: false })
    assert.equal(await windowOf(ctx), 300_000)
  })
})
