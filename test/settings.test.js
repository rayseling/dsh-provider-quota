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
import { zstdDecompressSync } from 'node:zlib'

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

/**
 * A Codex access token. pi-ai reads the ChatGPT account id out of this claim
 * when it builds request headers, so a token without it never reaches a wire.
 * @returns {string} a JWT carrying the account claim.
 */
function accessToken() {
  const segment = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return [
    segment({ alg: 'none', typ: 'JWT' }),
    segment({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_test' } }),
    'signature',
  ].join('.')
}

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
  if (options.webServer !== undefined) ctx.provide('webServer', options.webServer)
  if (options.attachments !== undefined) ctx.provide('attachments', options.attachments)
  if (options.fs !== undefined) ctx.provide('fs', options.fs)
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

  test('registers quota on the authenticated Connection boundary instead of a raw HTTP route', async () => {
    // What matters is WHERE the quota read is reachable from, not how many
    // arguments this plugin happens to pass. Counting the arguments would go
    // red the day Connection adds a parameter the plugin must start passing —
    // red for the correct fix. So this pins the boundary instead: a channel on
    // Connection, which applies request trust then browser-session
    // authentication, and no route of our own on the web server, which would
    // answer outside both.
    const home = await freshHome()
    let registered
    const mountedRoutes = []
    const connection = {
      rpc: {
        handle(channel, handler) {
          registered = { channel, handler }
          return async () => {}
        },
      },
    }
    const webServer = { register: (path) => { mountedRoutes.push(path) } }
    await boot(home, {}, { connection, webServer })
    assert.equal(registered.channel, '/dsh-codex-lite')
    assert.equal(typeof registered.handler, 'function')
    assert.deepEqual(mountedRoutes, [], 'a raw HTTP route would answer outside the Connection fence')
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

  test('the API-key routes read their pi-ai profile, not the defaults beside it', async () => {
    // The other half of the `readSection` regression above. That one covers
    // the flat native section; this one covers the shape it is easy to reach
    // only in theory — `providers` keyed by route inside the pi-ai section —
    // and it is the branch coverage proved never executes. Both endpoint and
    // credential reference are configured away from their defaults, so a read
    // that silently fell back would land on opencode.ai with the wrong key
    // name rather than failing.
    const home = await freshHome()
    let registered
    const connection = { rpc: { handle(channel, handler) { registered = handler; return async () => {} } } }
    const credentials = {
      resolve: async ref => (String(ref) === 'OPENCODE_PRIVATE_KEY' ? { value: 'sk-opencode-private' } : undefined),
      readRecord: async () => undefined,
    }
    const ctx = await boot(home, {}, { connection, credentials })
    const z = schemastery.default ?? schemastery
    ctx.settings.register(
      settings.settingsNamespace('llm-pi-ai'),
      z.object({ providers: z.dict(z.object({ apiKeyEnv: z.string(), baseURL: z.string() })) }),
      { base: { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_PRIVATE_KEY', baseURL: 'https://gateway.internal.example/zen/go/v1/' } } } },
    )
    const calls = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), auth: init?.headers?.Authorization })
      return new Response(JSON.stringify({ usage: { rolling: { percent: 12 } } }), { headers: { 'content-type': 'application/json' } })
    }
    try {
      const answer = await registered('usage', { provider: 'opencode-go' }, new AbortController().signal)
      assert.equal(answer.ok, true, `expected a quota window, got ${JSON.stringify(answer)}`)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://gateway.internal.example/zen/go/v1/usage',
        'the configured baseURL is where the read goes, trailing slash trimmed and /usage appended')
      assert.equal(calls[0].auth, 'Bearer sk-opencode-private',
        'the key must come from the configured apiKeyEnv, not from OPENCODE_GO_API_KEY')
      assert.equal(JSON.stringify(answer).includes('sk-opencode'), false, 'no key may reach the browser')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('the pi-ai DeepSeek profile is read through providers, unlike the native one', async () => {
    // `deepseek` and `deepseek-official` are two routes with two section
    // shapes; the branch that tells them apart is the one below. Pinning only
    // the native shape would leave a fallback to the PUBLIC endpoint looking
    // correct for the pi-ai route.
    const home = await freshHome()
    let registered
    const connection = { rpc: { handle(channel, handler) { registered = handler; return async () => {} } } }
    const credentials = {
      resolve: async ref => (String(ref) === 'DEEPSEEK_PI_KEY' ? { value: 'sk-pi-deepseek' } : undefined),
      readRecord: async () => undefined,
    }
    const ctx = await boot(home, {}, { connection, credentials })
    const z = schemastery.default ?? schemastery
    ctx.settings.register(
      settings.settingsNamespace('llm-pi-ai'),
      z.object({ providers: z.dict(z.object({ apiKeyEnv: z.string(), baseURL: z.string() })) }),
      { base: { providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_PI_KEY', baseURL: 'https://deepseek.gateway.example/v1' } } } },
    )
    const calls = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), auth: init?.headers?.Authorization })
      return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '5.00' }] }),
        { headers: { 'content-type': 'application/json' } })
    }
    try {
      const answer = await registered('usage', { provider: 'deepseek' }, new AbortController().signal)
      assert.equal(answer.ok, true, `expected a balance, got ${JSON.stringify(answer)}`)
      assert.equal(calls[0].url, 'https://deepseek.gateway.example/v1/user/balance',
        'the nested profile decides the origin; a silent fallback would read api.deepseek.com')
      assert.equal(calls[0].auth, 'Bearer sk-pi-deepseek')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('the catalog RPC answers the installed catalog, not whatever it was handed', async () => {
    // `test/usage.test.js` builds the RPC directly and asserts it returns the
    // ids it was constructed with — a unit test of the RPC, and an assertion
    // about its own input as far as this plugin is concerned. Dropping the
    // second argument at the call site in src/index.js leaves the whole suite
    // green while every browser gets `{models: []}` and the card silently
    // falls back to its "the full catalog did not load" path. This joins the
    // two halves: boot the real plugin, ask over the real channel.
    const home = await freshHome()
    let registered
    const connection = { rpc: { handle(channel, handler) { registered = handler; return async () => {} } } }
    await boot(home, { enabledModels: [MODEL] }, { connection })
    const answer = await registered('catalog', {}, new AbortController().signal)
    assert.equal(answer.ok, true, `expected a catalog, got ${JSON.stringify(answer)}`)
    assert.deepEqual(answer.value.models, plugin.openAICodexCatalogModelIds(),
      'the card needs the UNFILTERED installed catalog, so a narrowed allowlist can still be widened again')
    assert.ok(answer.value.models.length > 1, 'an empty list is what a dropped argument looks like')
  })

  test('a stored allowlist the catalog outgrew survives the STARTUP read, sizing intact', async () => {
    // The incident this repository's first note is about happened on the read
    // path, not the write path: every other case here edits through a booted
    // context, while the section that vanished was one the seam RESOLVED at
    // startup. `validate` runs there too, so a catalog-membership check inside
    // it refuses the whole section on the first boot after a model rename —
    // taking the unrelated `modelOverrides` window with it.
    const home = await freshHome()
    await writeFile(
      join(home, 'settings.yaml'),
      `${plugin.settingsNs}:\n  enabledModels:\n    - ${MODEL}\n    - gpt-9-retired\n  modelOverrides:\n    ${MODEL}:\n      contextWindow: 900000\n`,
      { mode: 0o600 },
    )
    const ctx = await boot(home, {})
    assert.equal(await windowOf(ctx), 900_000,
      'the window stored beside a drifted model id must survive the boot that resolves them together')
    assert.deepEqual(await listedModelsOf(ctx), [MODEL], 'and the retired id is dropped on read, not refused on load')
  })

  test('no settings provider leaves the plugin on its composition entry', async () => {
    const home = await freshHome()
    const ctx = await boot(home, { modelOverrides: { [MODEL]: { contextWindow: 300_000 } } }, { settings: false })
    assert.equal(await windowOf(ctx), 300_000)
  })

  test('an image handle carries the path the SESSION can read, not the host location', async () => {
    // The seam postmortem 0007 is about: the resolver lives in `apply` here
    // and its only consumer is inside the adapter, so nothing checks that the
    // two halves meet. test/adapter.test.js stubs the resolver parameter
    // directly, which leaves the composed wiring — the `fs` service name, the
    // argument order, the import — with no coverage at all: renaming
    // `ctx.get('fs')` to a service nobody provides keeps every gate green and
    // every test passing while the feature is permanently dead.
    //
    // The two paths differ on purpose. Asserting the MAPPED one, and that the
    // host one is absent, is what distinguishes a live mapping from a resolver
    // that never ran (both would otherwise show an unmapped placeholder).
    const hostPath = '/dsh/attachments/pixel.png'
    const sessionPath = '/workspace/.dsh/attachments/pixel.png'
    const ref = {
      attachmentId: 'sha256:0123456789abcdef',
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
      name: 'pixel.png',
    }
    const attachments = {
      imageHostPath: () => hostPath,
      readImageRequest: async () => ({
        variantId: 'sha256:request-version',
        attachment: ref,
        data: Uint8Array.from([137, 80, 78, 71]),
        mediaType: 'image/png',
        bytes: 4,
        width: 1,
        height: 1,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }),
    }
    const fs = { processPathFromHostPath: given => (given === hostPath ? sessionPath : undefined) }
    const home = await freshHome()
    await writeFile(
      join(home, '.openai-codex-auth.json'),
      `${JSON.stringify({
        version: 1,
        credential: { type: 'oauth', access: accessToken(), refresh: 'rt_STORED', expires: Date.now() + 3_600_000 },
      })}\n`,
      { mode: 0o600 },
    )
    // The only case in this file that resolves a credential, so it is also the
    // only one that needs the store pointed at the temp home.
    const realHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const ctx = await boot(home, {}, { attachments, fs })
    const realFetch = globalThis.fetch
    let body = ''
    globalThis.fetch = async (input, init) => {
      if (input instanceof Request) body = await input.clone().text()
      else if (typeof init?.body === 'string') body = init.body
      else if (init?.body instanceof Uint8Array) body = zstdDecompressSync(init.body).toString('utf8')
      return new Response('probe complete', { status: 503 })
    }
    try {
      for await (const _chunk of ctx.llm.stream({
        provider: 'openai-codex',
        model: MODEL,
        messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }] }],
      })) {
        // Drain the terminal chunks the adapter emits after the probe answer.
      }
    } finally {
      globalThis.fetch = realFetch
      if (realHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = realHome
    }
    assert.ok(body.includes(sessionPath), 'the model must be handed the path this session can actually open')
    assert.ok(!body.includes(hostPath), 'the raw host location is not readable from the session and must not travel')
  })
})
