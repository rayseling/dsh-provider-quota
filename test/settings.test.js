/**
 * Integration tests for what this plugin reads out of settings and where it
 * mounts: its own namespace (which is what makes the browser card
 * dispatchable), the Connection channel, and the two differently-shaped
 * sections the API-key quota routes are configured in.
 *
 * These boot the real seam — `FileSettingsProvider` over a temp `$DSH_HOME`
 * and this plugin — rather than stubbing `ctx.settings`. A stub would only
 * test the shape of our own calls; the properties worth pinning (which section
 * shape a route reads, whether a namespace is described) live in the seam.
 *
 * Nothing here reaches OpenAI: every upstream is a stubbed `globalThis.fetch`,
 * and no Codex credential is ever resolved.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

const loaded = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('@deepseek-ai/dsh-settings-file'),
  import('../src/index.js'),
  import('@deepseek-ai/schemastery'),
]).then(modules => ({ modules }), error => ({ error }))
const skip = loaded.error === undefined ? false : `peer dependencies are not installed (${loaded.error.code ?? 'import failed'})`
const [cordis, settingsFile, plugin, schemastery] = loaded.modules ?? []

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
 * @param {{settings?: boolean, connection?: object, credentials?: object, webServer?: object}} [options] - services to provide.
 * @returns {Promise<object>} the root context.
 */
async function boot(home, options = {}) {
  const ctx = new cordis.Context()
  disposers.push(() => ctx.fiber.dispose())
  if (options.connection !== undefined) ctx.provide('connection', options.connection)
  if (options.credentials !== undefined) ctx.provide('credentials', options.credentials)
  if (options.webServer !== undefined) ctx.provide('webServer', options.webServer)
  if (options.settings !== false) {
    await ctx.plugin(settingsFile.FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false })
  }
  await ctx.plugin(plugin)
  return ctx
}

/** @returns {{connection: object, handler: () => object}} a Connection stub and a reader for what it captured. */
function captureRpc() {
  let registered
  return {
    connection: { rpc: { handle(channel, handler) { registered = { channel, handler }; return async () => {} } } },
    handler: () => registered,
  }
}

describe('the plugin namespace', { skip }, () => {
  test('the namespace is registered, which is what dispatches the browser card', async () => {
    // Not decoration: the plugins tab renders the intersection of the
    // namespaces the Host serves and the cards registered under them, so a
    // card whose namespace nobody registers is never dispatched. This section
    // holds no field — registering it is the whole reason it exists.
    const home = await freshHome()
    const ctx = await boot(home)
    assert.ok(
      ctx.settings.describe().some(descriptor => descriptor.ns === plugin.settingsNs),
      `settings.describe() must list ${plugin.settingsNs}`,
    )
    // The browser half spells this namespace as a literal, so that its own
    // suite needs no peer dependencies. This is the other end of that pact:
    // the card registers under the name asserted here, and a rename that
    // touched only one half would fail here rather than in a browser.
    assert.equal(plugin.settingsNs, 'codex-quota')
  })

  test('without a settings provider the quota still answers, only the card is lost', async () => {
    // The section makes the card dispatchable; it serves no value. So a
    // composition with no settings provider at all must still mount the
    // channel — a headless host reads quota through it and has no card to lose.
    const home = await freshHome()
    const rpc = captureRpc()
    await boot(home, { settings: false, connection: rpc.connection })
    assert.equal(rpc.handler()?.channel, '/dsh-codex-lite')
  })
})

describe('where the quota is reachable from', { skip }, () => {
  test('registers quota on the authenticated Connection boundary instead of a raw HTTP route', async () => {
    // What matters is WHERE the quota read is reachable from, not how many
    // arguments this plugin happens to pass. Counting the arguments would go
    // red the day Connection adds a parameter the plugin must start passing —
    // red for the correct fix. So this pins the boundary instead: a channel on
    // Connection, which applies request trust then browser-session
    // authentication, and no route of our own on the web server, which would
    // answer outside both.
    const home = await freshHome()
    const mountedRoutes = []
    const rpc = captureRpc()
    const webServer = { register: (path) => { mountedRoutes.push(path) } }
    await boot(home, { connection: rpc.connection, webServer })
    assert.equal(rpc.handler().channel, '/dsh-codex-lite')
    assert.equal(typeof rpc.handler().handler, 'function')
    assert.deepEqual(mountedRoutes, [], 'a raw HTTP route would answer outside the Connection fence')
  })
})

describe('the sections the API-key routes are configured in', { skip }, () => {
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
    const rpc = captureRpc()
    const credentials = {
      resolve: async ref => (String(ref) === 'DEEPSEEK_PRIVATE_KEY' ? { value: 'sk-private' } : undefined),
      readRecord: async () => undefined,
    }
    const ctx = await boot(home, { connection: rpc.connection, credentials })
    // Stand in for the native adapter's own section, with the shape it
    // installs: flat, `settingsPath: []`, no `providers` above the fields.
    const z = schemastery.default ?? schemastery
    ctx.settings.register(
      'llm-deepseek',
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
      const answer = await rpc.handler().handler('usage', { provider: 'deepseek-official' }, new AbortController().signal)
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

  test('the API-key routes read their pi-ai profile, not the defaults beside it', async () => {
    // The other half of the `readSection` regression above. That one covers
    // the flat native section; this one covers the shape it is easy to reach
    // only in theory — `providers` keyed by route inside the pi-ai section.
    // Both endpoint and credential reference are configured away from their
    // defaults, so a read that silently fell back would land on opencode.ai
    // with the wrong key name rather than failing.
    const home = await freshHome()
    const rpc = captureRpc()
    const credentials = {
      resolve: async ref => (String(ref) === 'OPENCODE_PRIVATE_KEY' ? { value: 'sk-opencode-private' } : undefined),
      readRecord: async () => undefined,
    }
    const ctx = await boot(home, { connection: rpc.connection, credentials })
    const z = schemastery.default ?? schemastery
    ctx.settings.register(
      'llm-pi-ai',
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
      const answer = await rpc.handler().handler('usage', { provider: 'opencode-go' }, new AbortController().signal)
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
    const rpc = captureRpc()
    const credentials = {
      resolve: async ref => (String(ref) === 'DEEPSEEK_PI_KEY' ? { value: 'sk-pi-deepseek' } : undefined),
      readRecord: async () => undefined,
    }
    const ctx = await boot(home, { connection: rpc.connection, credentials })
    const z = schemastery.default ?? schemastery
    ctx.settings.register(
      'llm-pi-ai',
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
      const answer = await rpc.handler().handler('usage', { provider: 'deepseek' }, new AbortController().signal)
      assert.equal(answer.ok, true, `expected a balance, got ${JSON.stringify(answer)}`)
      assert.equal(calls[0].url, 'https://deepseek.gateway.example/v1/user/balance',
        'the nested profile decides the origin; a silent fallback would read api.deepseek.com')
      assert.equal(calls[0].auth, 'Bearer sk-pi-deepseek')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
