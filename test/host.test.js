/**
 * Integration tests for the host half: where the quota channel mounts, and the
 * two differently-shaped sections — both owned by OTHER plugins — that an
 * API-key quota route reads its endpoint and credential reference out of.
 * This plugin registers no section of its own; it only reads.
 *
 * These boot the real seam — `FileSettingsProvider` over a temp `$DSH_HOME`
 * and this plugin — rather than stubbing `ctx.settings`. A stub would only
 * test the shape of our own calls; the property worth pinning — which section
 * shape a route reads — lives in the seam.
 *
 * Nothing here reaches OpenAI: every upstream is a stubbed `globalThis.fetch`,
 * and no Codex credential is ever resolved.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-quota-settings-'))
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

describe('a composition with no settings provider at all', { skip }, () => {
  test('still mounts the quota channel', async () => {
    // The plugin reads sections but registers none, so nothing about it needs
    // a settings provider to exist. A headless host that mounts none must
    // still get the quota RPC.
    const home = await freshHome()
    const rpc = captureRpc()
    await boot(home, { settings: false, connection: rpc.connection })
    assert.equal(rpc.handler()?.channel, '/dsh-provider-quota')
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
    assert.equal(rpc.handler().channel, '/dsh-provider-quota')
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

  test('a route id no catalog carries answers none, and costs no credential read', { skip }, async () => {
    // `opencode-go-extra` and `deepseek` used to be answered here. Neither was
    // a name anything upstream fixed: an `llm-pi-ai.providers` dict key IS the
    // route, so both were copies of one deployment's settings.yaml, and they
    // outlived it silently. The three that remain are pi-ai catalog names plus
    // the constant llm-deepseek registers under. An id outside them must answer
    // `none` without resolving a credential or reaching an endpoint — resolving
    // one would mean a removed route still had a key to spend.
    const home = await freshHome()
    const rpc = captureRpc()
    const asked = []
    const credentials = {
      resolve: async ref => { asked.push(String(ref)); return { value: 'sk-must-not-be-spent' } },
      readRecord: async key => { asked.push(String(key)); return undefined },
    }
    await boot(home, { connection: rpc.connection, credentials })
    const calls = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }
    try {
      for (const provider of ['opencode-go-extra', 'deepseek', 'glm-5.3']) {
        const answer = await rpc.handler().handler('usage', { provider }, new AbortController().signal)
        assert.equal(answer.ok, true, `${provider}: ${JSON.stringify(answer)}`)
        assert.equal(answer.value.kind, 'none', provider)
      }
      assert.deepEqual(calls, [], 'a route this plugin does not serve must reach no endpoint')
      assert.deepEqual(asked, [], 'nor resolve a credential it would have nowhere to send')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('a baseURL the plugin cannot use fails the read; it never becomes the public endpoint', { skip }, async () => {
    // A configured base and a missing one are two different states, and the
    // difference is a key. `httpBase(configured) ?? httpBase(env) ?? PUBLIC`
    // could not tell them apart: a private gateway typed without its scheme —
    // the single most likely way to get this field wrong — read as "nothing
    // configured", and the key provisioned for that gateway went to
    // api.deepseek.com. The OpenCode branch has always failed closed on the
    // same input, so this pins both, and pins that they agree.
    const home = await freshHome()
    const rpc = captureRpc()
    const credentials = {
      resolve: async () => ({ value: 'sk-provisioned-for-the-private-gateway' }),
      readRecord: async () => undefined,
    }
    const ctx = await boot(home, { connection: rpc.connection, credentials })
    const z = schemastery.default ?? schemastery
    ctx.settings.register('llm-deepseek', z.object({ baseURL: z.string() }),
      { base: { baseURL: 'deepseek.internal.example/v1' } })
    ctx.settings.register('llm-pi-ai', z.object({ providers: z.dict(z.object({ baseURL: z.string() })) }),
      { base: { providers: { 'opencode-go': { baseURL: 'gateway.internal.example/zen/go/v1' } } } })
    const calls = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }
    try {
      const answers = {}
      for (const provider of ['deepseek-official', 'opencode-go']) {
        answers[provider] = await rpc.handler().handler('usage', { provider }, new AbortController().signal)
      }
      // Where the key went is the finding; the failure code is only how the
      // reader hears about it. Assert them in that order.
      assert.deepEqual(calls, [], 'an unusable base must send the key nowhere, least of all to a public endpoint')
      for (const [provider, answer] of Object.entries(answers)) {
        assert.equal(answer.ok, false, `${provider} answered ${JSON.stringify(answer)} for a base it cannot use`)
        assert.equal(answer.error.code, 'unavailable', provider)
      }
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('the OpenCode CLI key is read for the route the CLI can be signed into', { skip }, async () => {
    // The last resort under the configured key and the stored record: the
    // CLI's own auth.json, under either spelling it files `opencode-go` as.
    // The CLI holds one entry per account, so a second opencode route would
    // need its own; this pins that the route it does cover still resolves.
    const home = await freshHome()
    const cliHome = await freshHome()
    await mkdir(join(cliHome, '.local', 'share', 'opencode'), { recursive: true })
    await writeFile(join(cliHome, '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ opencode: { type: 'api', key: 'sk-from-the-cli' } }))
    const rpc = captureRpc()
    await boot(home, {
      connection: rpc.connection,
      credentials: { resolve: async () => undefined, readRecord: async () => undefined },
    })
    const calls = []
    const realFetch = globalThis.fetch
    const realHome = process.env.HOME
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), auth: init?.headers?.Authorization })
      return new Response(JSON.stringify({ usage: { rolling: { percent: 5 } } }), { headers: { 'content-type': 'application/json' } })
    }
    process.env.HOME = cliHome
    try {
      const answer = await rpc.handler().handler('usage', { provider: 'opencode-go' }, new AbortController().signal)
      assert.equal(answer.ok, true, `expected a quota window, got ${JSON.stringify(answer)}`)
      assert.equal(calls[0].url, 'https://opencode.ai/zen/go/v1/usage')
      assert.equal(calls[0].auth, 'Bearer sk-from-the-cli')
      assert.equal(JSON.stringify(answer).includes('sk-from'), false, 'no key may reach the browser')
    } finally {
      globalThis.fetch = realFetch
      if (realHome === undefined) delete process.env.HOME
      else process.env.HOME = realHome
    }
  })
})
