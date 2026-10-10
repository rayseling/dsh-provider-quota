/**
 * Integration tests for the host half: where the quota channel mounts, and the
 * two differently-shaped profile entries — both owned by OTHER plugins — that
 * an API-key quota route reads its endpoint and credential reference out of.
 * This plugin has no configuration of its own; it only reads.
 *
 * These boot the real seam — `SettingsForms` over `ConfigEditor` over the
 * Loader, on a temp profile directory — rather than stubbing `ctx.settings`.
 * A stub would only pin the shape of our own calls, and the shape of our own
 * calls is exactly what went stale once: the 0.1.7-alpha.1 settings rewrite
 * dropped `get(ns)`, the plugin kept calling it inside a catch-all, and every
 * API-key route read defaults for two releases while this file was skipped.
 * The property worth pinning — that what an operator writes into a route's
 * own profile entry is where the request goes — lives in the seam, so the
 * entries here are mounted with the REAL `Config` of whatever package the
 * harness's base bundle mounts under each id (see `baseBundleAdapters`), and
 * only their `apply` is a no-op.
 *
 * Every answer is read back through the browser's own RPC caller, so an
 * envelope the page would reject fails here instead of reaching the chip as
 * its generic failure.
 *
 * Nothing here reaches OpenAI: every upstream is a stubbed `globalThis.fetch`,
 * and no Codex credential is ever resolved.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const loaded = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('@deepseek-ai/dsh-app-boot'),
  import('@deepseek-ai/dsh-config-editor'),
  import('@deepseek-ai/dsh-settings'),
  // `createWebConnectionRpc` is what a page's `connection.rpc.call` runs. The
  // shipped client is a page-loader script Node cannot import; this is the
  // module it is built from.
  import('@deepseek-ai/dsh-client-connection/src/client/rpc.ts'),
  import('../src/index.js'),
  Promise.resolve().then(() => require.resolve('@deepseek-ai/dsh-base/package.json')),
]).then(modules => ({ modules }), error => ({ error }))
const skip = loaded.error === undefined ? false : `peer dependencies are not installed (${loaded.error.code ?? 'import failed'})`
const [cordis, appBoot, configEditor, settingsForms, webRpc, plugin, baseBundleManifest] = loaded.modules ?? []

/** The two entry ids this plugin reads route configuration out of. */
const READ_ENTRY_IDS = ['llm-deepseek', 'llm-pi-ai']
let adapters

/**
 * The adapter the harness's base bundle mounts under each entry id this
 * plugin reads, found with the harness's own patch reader and resolved from
 * that bundle's own dependencies.
 *
 * Read, never written down. The plugin reads entries BY ID; which package
 * backs an id is upstream's choice, and it has changed: in 0.1.7-rc.2
 * `llm-deepseek` moved to the API-key package, while the protocol package
 * this file used to import kept its name and its `Config` export but lost
 * `apiKeyEnv` — so the real schema stripped the very field under test, and a
 * test that had pinned the right behaviour went red for a wrong fixture. A
 * bundle that stops giving out one of these ids fails here, because that
 * breaks the plugin itself.
 * @returns {Promise<Record<string, {name: string, Config: object, module: object}>>} the mounted adapter per entry id.
 */
function baseBundleAdapters() {
  adapters ??= (async () => {
    const manifest = JSON.parse(await readFile(baseBundleManifest, 'utf8'))
    const patches = appBoot.loadOverlayPatches('host.test', join(dirname(baseBundleManifest), manifest.dsh.bundle.patch))
    const names = new Map()
    const visit = (entry) => {
      if (typeof entry.id === 'string' && typeof entry.name === 'string') names.set(entry.id, entry.name)
      if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit)
    }
    for (const patch of patches) patch.insert?.forEach(visit)
    const resolveFromBundle = createRequire(baseBundleManifest).resolve
    const found = {}
    for (const id of READ_ENTRY_IDS) {
      const name = names.get(id)
      assert.ok(name !== undefined, `the base bundle mounts no entry with id "${id}", and that id is where this plugin reads the route's configuration`)
      const adapter = await import(pathToFileURL(resolveFromBundle(name)).href)
      assert.ok(adapter.Config !== undefined, `${name}, mounted as "${id}", exports no Config`)
      found[id] = { name, Config: adapter.Config, module: adapter }
    }
    return found
  })()
  return adapters
}

/** Temp homes and live fibers this file created. */
const homes = []
const disposers = []
after(async () => {
  for (const dispose of disposers.reverse()) await dispose().catch(() => {})
  await Promise.all(homes.map(home => rm(home, { recursive: true, force: true })))
})

/** @returns {Promise<string>} a tracked, empty harness home. */
async function freshHome() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-provider-quota-settings-')))
  homes.push(home)
  return home
}

/**
 * The services a test hands the plugin, provided before it mounts.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the context to provide on.
 * @param {{connection?: object, credentials?: object, webServer?: object, settings?: object}} options - services to provide.
 */
function provideServices(ctx, options) {
  for (const name of ['connection', 'credentials', 'webServer', 'settings']) {
    if (options[name] !== undefined) ctx.provide(name, options[name])
  }
}

/**
 * Boot a bare composition: no Loader, no settings seam, only the services a
 * test hands over. This is what a headless host that mounts no settings
 * service looks like to the plugin.
 * @param {object} [options] - services to provide.
 * @returns {Promise<object>} the root context.
 */
async function bootBare(options = {}) {
  const ctx = new cordis.Context()
  disposers.push(() => ctx.fiber.dispose())
  provideServices(ctx, options)
  await ctx.plugin(plugin)
  return ctx
}

/**
 * Boot the seam the way the harness composes it: a real profile directory,
 * the config editor and the settings forms mounted from a bundle patch, and
 * the two adapters' entries — the base bundle's real `Config`, no-op `apply` —
 * configured from the profile's own user patch, which is the document the
 * Models page writes.
 * @param {string} home - temp harness home.
 * @param {{routes?: {'llm-deepseek'?: object, 'llm-pi-ai'?: object}, connection?: object, credentials?: object, webServer?: object}} [options] - user-layer config per entry, and services to provide.
 * @returns {Promise<object>} the root context.
 */
async function bootSeam(home, options = {}) {
  const mounted = await baseBundleAdapters()
  const dir = join(home, 'profiles', 'test')
  appBoot.initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-installation"}\n')
  await writeFile(join(bundle, 'package.json'),
    JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  // The composition base: the same entry ids the harness's base bundle gives
  // these two adapters, which is what makes them the ids this plugin reads.
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'llm-deepseek', name: 'cordis:deepseek' },
    { id: 'llm-pi-ai', name: 'cordis:piai' },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  // The user layer: one row per configured entry, as the Models page stores it.
  const rows = Object.entries(options.routes ?? {}).map(([id, config]) => ({ id, config }))
  await writeFile(profile.patchPath, JSON.stringify(rows))
  const ctx = await appBoot.boot('test', join(dir, 'cordis.yml'), appBoot.readProfilePatches('test', profile), (root) => {
    root.provide('profileContext', profile)
    root.provide('appReady', { onReady: (listener) => { listener(); return () => {} } })
    Object.assign(root.loader.builtins, {
      editor: configEditor.ConfigEditor,
      settings: settingsForms.SettingsForms,
      deepseek: { Config: mounted['llm-deepseek'].Config, apply() {} },
      piai: { Config: mounted['llm-pi-ai'].Config, apply() {} },
    })
  })
  disposers.push(() => ctx.fiber.dispose())
  provideServices(ctx, options)
  await ctx.plugin(plugin)
  return ctx
}

/**
 * A Connection stub that captures the exact Fetch route the plugin registers,
 * and the browser's own caller pointed at it.
 *
 * Not a hand-built envelope: a test that writes the request and reads the
 * response itself checks the envelope this plugin believes in, and that
 * belief was wrong once. Every failure the plugin answered lacked the
 * `details` record the caller insists on, so the caller threw instead of
 * returning `{ok: false}`, and the chip showed its generic failure for a
 * missing sign-in, a rejected key and a rate limit alike — while every test
 * here, reading raw JSON, saw the right code.
 * @returns {{connection: object, route: () => object, call: (payload: object) => Promise<object>}}
 */
function captureRpc() {
  let registered
  const rpc = webRpc.createWebConnectionRpc(
    (input, init) => registered.fetch(new Request(new URL(String(input), 'http://host/'), init)),
  )
  return {
    connection: { fetch: { register(route) { registered = route; return async () => {} } } },
    route: () => registered,
    call: payload => rpc.call('/api', registered.path.slice('/api/'.length), payload),
  }
}

/**
 * Stub the upstream and record every call; restored by the returned function.
 * @param {(url: string, init: object|undefined) => Response} respond - the upstream's answer.
 * @returns {{calls: Array<{url: string, auth: string|undefined}>, restore: () => void}}
 */
function stubUpstream(respond) {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization })
    return respond(String(url), init)
  }
  return { calls, restore: () => { globalThis.fetch = realFetch } }
}

const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('a composition with no settings provider at all', { skip }, () => {
  test('still mounts the quota channel', async () => {
    // The plugin reads entries but registers none, so nothing about it needs
    // a settings service to exist. A headless host that mounts none must
    // still get the quota RPC.
    const rpc = captureRpc()
    await bootBare({ connection: rpc.connection })
    assert.equal(rpc.route()?.path, '/api/dsh-provider-quota.usage')
  })
})

describe('where the quota is reachable from', { skip }, () => {
  test('registers quota on the authenticated Connection boundary instead of a raw HTTP route', async () => {
    // What matters is WHERE the quota read is reachable from, not how many
    // arguments this plugin happens to pass. Counting the arguments would go
    // red the day Connection adds a parameter the plugin must start passing —
    // red for the correct fix. So this pins the boundary instead: an exact
    // route on Connection's own `/api`, which applies request trust then
    // browser-session authentication before dispatching to it, and no route of
    // our own on the web server, which would answer outside both. Not
    // `rpc.handle` either: that path has read a `webServer` Connection does not
    // inject since dsh 0.1.5-alpha.1 and needs a harness patch to land.
    const mountedRoutes = []
    const rpc = captureRpc()
    const webServer = { register: (path) => { mountedRoutes.push(path) } }
    await bootBare({ connection: rpc.connection, webServer })
    assert.deepEqual(
      { path: rpc.route().path, methods: rpc.route().methods, requestBody: rpc.route().requestBody },
      { path: '/api/dsh-provider-quota.usage', methods: ['POST'], requestBody: 'buffered' },
    )
    assert.equal(typeof rpc.route().fetch, 'function')
    assert.deepEqual(mountedRoutes, [], 'a raw HTTP route would answer outside the Connection fence')
  })

  test('a failure reaches the browser as the reason the host chose, not as a broken envelope', async () => {
    // The chip tells "sign in again" from "try later" by the code alone, so
    // the code has to survive the browser's envelope check. A rejected key is
    // the case: the host knows exactly what went wrong, and an envelope the
    // caller throws on would turn that into the generic failure.
    const rpc = captureRpc()
    await bootBare({
      connection: rpc.connection,
      credentials: { resolve: async () => ({ value: 'sk-rejected' }), readRecord: async () => undefined },
    })
    const upstream = stubUpstream(() => new Response('{"error":"Authentication Fails"}', { status: 401 }))
    try {
      const answer = await rpc.call({ provider: 'deepseek-official' })
      assert.equal(answer.ok, false, `a rejected key answered ${JSON.stringify(answer)}`)
      assert.equal(answer.error.code, 'auth')
      assert.equal(upstream.calls.length, 1)
    } finally {
      upstream.restore()
    }
  })
})

describe('the profile entries the API-key routes are configured in', { skip }, () => {
  test('the native DeepSeek route is read from its flat entry, not through a providers dict', async () => {
    // The two shapes this plugin reads are the adapters' own: pi-ai keeps a
    // `providers` dict keyed by route, while llm-deepseek registers itself at
    // `settingsPath: []` and puts `apiKeyEnv`/`baseURL` at its own root.
    // Reading the native one through `providers` finds nothing and quietly
    // falls back to the defaults — which would send a key provisioned for a
    // private endpoint to the public one. So this configures both fields away
    // from their defaults, in the profile's own user patch, and pins where the
    // request actually goes.
    const home = await freshHome()
    const rpc = captureRpc()
    const credentials = {
      resolve: async ref => (String(ref) === 'DEEPSEEK_PRIVATE_KEY' ? { value: 'sk-private' } : undefined),
      readRecord: async () => undefined,
    }
    await bootSeam(home, {
      connection: rpc.connection,
      credentials,
      routes: { 'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_PRIVATE_KEY', baseURL: 'https://deepseek.internal.example/v1/' } },
    })
    const upstream = stubUpstream(() => json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.00' }] }))
    try {
      const answer = await rpc.call({ provider: 'deepseek-official' })
      assert.equal(answer.ok, true, `expected a balance, got ${JSON.stringify(answer)}`)
      assert.equal(upstream.calls.length, 1)
      assert.equal(upstream.calls[0].url, 'https://deepseek.internal.example/v1/user/balance',
        'the configured baseURL must be where the balance is read, trailing slash trimmed')
      assert.equal(upstream.calls[0].auth, 'Bearer sk-private',
        'the key must come from the configured apiKeyEnv, not the default one')
      assert.equal(JSON.stringify(answer).includes('sk-private'), false, 'no key may reach the browser')
    } finally {
      upstream.restore()
    }
  })

  test('the DeepSeek root the harness itself resolves reads the balance where DeepSeek serves it', async () => {
    // The adapter mounted as `llm-deepseek` reads `baseURL` as a Messages
    // root. Ask it which root it uses when nothing is configured, write that
    // value into the entry the way an operator copying the harness's docs
    // would, and the read must land on DeepSeek's documented balance
    // endpoint, not under the Messages mount. Two sides that disagree on who
    // owns a path segment is trap 5; this is the DeepSeek half of it.
    const home = await freshHome()
    const harnessRoot = (await baseBundleAdapters())['llm-deepseek'].module.resolveAdapterOptions({}).baseURL
    const rpc = captureRpc()
    await bootSeam(home, {
      connection: rpc.connection,
      credentials: { resolve: async () => ({ value: 'sk-official' }), readRecord: async () => undefined },
      routes: { 'llm-deepseek': { baseURL: harnessRoot } },
    })
    const upstream = stubUpstream(() => json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }))
    try {
      const answer = await rpc.call({ provider: 'deepseek-official' })
      assert.equal(answer.ok, true, `expected a balance, got ${JSON.stringify(answer)}`)
      assert.deepEqual(upstream.calls.map(call => call.url), ['https://api.deepseek.com/user/balance'],
        `the harness resolves ${harnessRoot} as its root; the balance is not under that mount`)
    } finally {
      upstream.restore()
    }
  })

  test('the API-key routes read their pi-ai profile, not the defaults beside it', async () => {
    // The other half: the shape it is easy to reach only in theory —
    // `providers` keyed by route inside the pi-ai entry. Both endpoint and
    // credential reference are configured away from their defaults, so a
    // read that silently fell back would land on opencode.ai with the wrong
    // key name rather than failing.
    const home = await freshHome()
    const rpc = captureRpc()
    const credentials = {
      resolve: async ref => (String(ref) === 'OPENCODE_PRIVATE_KEY' ? { value: 'sk-opencode-private' } : undefined),
      readRecord: async () => undefined,
    }
    await bootSeam(home, {
      connection: rpc.connection,
      credentials,
      routes: { 'llm-pi-ai': { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_PRIVATE_KEY', baseURL: 'https://gateway.internal.example/zen/go/v1/' } } } },
    })
    const upstream = stubUpstream(() => json({ usage: { rolling: { percent: 12 } } }))
    try {
      const answer = await rpc.call({ provider: 'opencode-go' })
      assert.equal(answer.ok, true, `expected a quota window, got ${JSON.stringify(answer)}`)
      assert.equal(upstream.calls.length, 1)
      assert.equal(upstream.calls[0].url, 'https://gateway.internal.example/zen/go/v1/usage',
        'the configured baseURL is where the read goes, trailing slash trimmed and /usage appended')
      assert.equal(upstream.calls[0].auth, 'Bearer sk-opencode-private',
        'the key must come from the configured apiKeyEnv, not from OPENCODE_GO_API_KEY')
      assert.equal(JSON.stringify(answer).includes('sk-opencode'), false, 'no key may reach the browser')
    } finally {
      upstream.restore()
    }
  })

  test('a route id no catalog carries answers none, and costs no credential read', async () => {
    // `opencode-go-extra` and `deepseek` used to be answered here. Neither was
    // a name anything upstream fixed: an `llm-pi-ai.providers` dict key IS the
    // route, so both were copies of one deployment's settings, and they went
    // stale the day that file changed. The chip renders nothing for a route it
    // does not serve, and the host must not spend a credential read or an
    // upstream request finding that out — even when the operator DID
    // configure that route, which is the case this pins.
    const home = await freshHome()
    const rpc = captureRpc()
    const asked = []
    const credentials = {
      resolve: async (ref) => { asked.push(String(ref)); return { value: 'sk-should-not-be-read' } },
      readRecord: async () => undefined,
    }
    await bootSeam(home, {
      connection: rpc.connection,
      credentials,
      routes: { 'llm-pi-ai': { providers: { 'opencode-go-extra': { apiKeyEnv: 'OPENCODE_EXTRA_KEY', baseURL: 'https://extra.example/v1' } } } },
    })
    const upstream = stubUpstream(() => json({}))
    try {
      for (const provider of ['opencode-go-extra', 'deepseek', 'glm-5.3']) {
        const answer = await rpc.call({ provider })
        assert.equal(answer.ok, true, `${provider}: ${JSON.stringify(answer)}`)
        assert.equal(answer.value.kind, 'none', provider)
      }
      assert.deepEqual(upstream.calls, [], 'a route this plugin does not serve must reach no endpoint')
      assert.deepEqual(asked, [], 'nor resolve a credential it would have nowhere to send')
    } finally {
      upstream.restore()
    }
  })

  test('a baseURL the plugin cannot use fails the read; it never becomes the public endpoint', async () => {
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
    await bootSeam(home, {
      connection: rpc.connection,
      credentials,
      routes: {
        'llm-deepseek': { baseURL: 'deepseek.internal.example/v1' },
        'llm-pi-ai': { providers: { 'opencode-go': { baseURL: 'gateway.internal.example/zen/go/v1' } } },
      },
    })
    const upstream = stubUpstream(() => json({}))
    try {
      const answers = {}
      for (const provider of ['deepseek-official', 'opencode-go']) {
        answers[provider] = await rpc.call({ provider })
      }
      // Where the key went is the finding; the failure code is only how the
      // reader hears about it. Assert them in that order.
      assert.deepEqual(upstream.calls, [], 'an unusable base must send the key nowhere, least of all to a public endpoint')
      for (const [provider, answer] of Object.entries(answers)) {
        assert.equal(answer.ok, false, `${provider} answered ${JSON.stringify(answer)} for a base it cannot use`)
        assert.equal(answer.error.code, 'unavailable', provider)
      }
    } finally {
      upstream.restore()
    }
  })

  test('the OpenCode CLI key is read for the route the CLI can be signed into', async () => {
    // The last resort under the configured key and the stored record: the
    // CLI's own auth.json, under either spelling it files `opencode-go` as.
    // The CLI holds one entry per account, so a second opencode route would
    // need its own; this pins that the route it does cover still resolves —
    // on a real seam whose pi-ai entry configures nothing for it.
    const home = await freshHome()
    const cliHome = await freshHome()
    await mkdir(join(cliHome, '.local', 'share', 'opencode'), { recursive: true })
    await writeFile(join(cliHome, '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ opencode: { type: 'api', key: 'sk-from-the-cli' } }))
    const rpc = captureRpc()
    await bootSeam(home, {
      connection: rpc.connection,
      credentials: { resolve: async () => undefined, readRecord: async () => undefined },
    })
    const upstream = stubUpstream(() => json({ usage: { rolling: { percent: 5 } } }))
    const realHome = process.env.HOME
    process.env.HOME = cliHome
    try {
      const answer = await rpc.call({ provider: 'opencode-go' })
      assert.equal(answer.ok, true, `expected a quota window, got ${JSON.stringify(answer)}`)
      assert.equal(upstream.calls[0].url, 'https://opencode.ai/zen/go/v1/usage')
      assert.equal(upstream.calls[0].auth, 'Bearer sk-from-the-cli')
      assert.equal(JSON.stringify(answer).includes('sk-from'), false, 'no key may reach the browser')
    } finally {
      upstream.restore()
      if (realHome === undefined) delete process.env.HOME
      else process.env.HOME = realHome
    }
  })

  test('a credential reference the route names, resolving to nothing, fails the read instead of borrowing a key', async () => {
    // The configured reference is the operator saying which key belongs to
    // this route. When it misses, the model route itself stops with
    // MISSING_CREDENTIAL; a stored record or the OpenCode CLI's key found
    // nearby may belong to another account entirely, and the endpoint it
    // would travel to is this route's — another tenant's gateway, here.
    const home = await freshHome()
    const cliHome = await freshHome()
    await mkdir(join(cliHome, '.local', 'share', 'opencode'), { recursive: true })
    await writeFile(join(cliHome, '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ opencode: { type: 'api', key: 'sk-account-a-cli' } }))
    const rpc = captureRpc()
    await bootSeam(home, {
      connection: rpc.connection,
      credentials: {
        resolve: async () => undefined,
        readRecord: async () => ({ kind: 'api-key', key: 'sk-account-a-record' }),
      },
      routes: { 'llm-pi-ai': { providers: { 'opencode-go': { apiKeyEnv: 'TENANT_B_OPENCODE_KEY', baseURL: 'https://tenant-b.example/zen/go/v1' } } } },
    })
    const upstream = stubUpstream(() => json({ usage: { rolling: { percent: 1 } } }))
    const realHome = process.env.HOME
    process.env.HOME = cliHome
    try {
      const answer = await rpc.call({ provider: 'opencode-go' })
      assert.deepEqual(upstream.calls, [], 'no key may travel when the one the route names is missing')
      assert.equal(answer.ok, false, `a missing named key answered ${JSON.stringify(answer)}`)
      assert.equal(answer.error.code, 'no-credential')
    } finally {
      upstream.restore()
      if (realHome === undefined) delete process.env.HOME
      else process.env.HOME = realHome
    }
  })

  test('a route that names no reference reads the key its adapter stored for that route', async () => {
    // The other side of the rule above, so it cannot be "fixed" into refusing
    // everything: with no reference named, the model route authenticates
    // from what its adapter stored for it, and so does this read — that
    // record and no other.
    const home = await freshHome()
    const asked = []
    const rpc = captureRpc()
    await bootSeam(home, {
      connection: rpc.connection,
      credentials: {
        resolve: async () => undefined,
        readRecord: async (key) => {
          asked.push(String(key))
          return String(key) === 'llm-pi-ai/opencode-go' ? { kind: 'api-key', key: 'sk-stored-for-this-route' } : undefined
        },
      },
    })
    const upstream = stubUpstream(() => json({ usage: { rolling: { percent: 3 } } }))
    try {
      const answer = await rpc.call({ provider: 'opencode-go' })
      assert.equal(answer.ok, true, `expected a quota window, got ${JSON.stringify(answer)}`)
      assert.deepEqual(asked, ['llm-pi-ai/opencode-go'])
      assert.deepEqual(upstream.calls, [{ url: 'https://opencode.ai/zen/go/v1/usage', auth: 'Bearer sk-stored-for-this-route' }])
    } finally {
      upstream.restore()
    }
  })

  test('the OpenCode CLI key only ever goes to OpenCode\'s own endpoint', async () => {
    // The CLI signs into opencode.ai, so its key is an opencode.ai key. A
    // route repointed at another gateway that names no key of its own must
    // not be handed that one.
    const home = await freshHome()
    const cliHome = await freshHome()
    await mkdir(join(cliHome, '.local', 'share', 'opencode'), { recursive: true })
    await writeFile(join(cliHome, '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ opencode: { type: 'api', key: 'sk-opencode-ai-cli' } }))
    const rpc = captureRpc()
    await bootSeam(home, {
      connection: rpc.connection,
      credentials: { resolve: async () => undefined, readRecord: async () => undefined },
      routes: { 'llm-pi-ai': { providers: { 'opencode-go': { baseURL: 'https://gateway.elsewhere.example/zen/go/v1' } } } },
    })
    const upstream = stubUpstream(() => json({ usage: { rolling: { percent: 1 } } }))
    const realHome = process.env.HOME
    process.env.HOME = cliHome
    try {
      const answer = await rpc.call({ provider: 'opencode-go' })
      assert.deepEqual(upstream.calls, [], 'the CLI key must not reach a gateway it was not issued for')
      assert.equal(answer.ok, false)
      assert.equal(answer.error.code, 'no-credential')
    } finally {
      upstream.restore()
      if (realHome === undefined) delete process.env.HOME
      else process.env.HOME = realHome
    }
  })

  test('a settings service this plugin cannot read fails the read instead of reading the defaults', async () => {
    // The seam before 0.1.7-alpha.1 answered `get(ns)`; the plugin called it
    // inside a catch-all, so when the method went away the TypeError became
    // "nothing configured" and both API-key routes read their defaults for
    // two releases. A seam that is present but unreadable is "配错", not
    // "没配": the read must fail, send the key nowhere, and not even resolve
    // one. The stub here IS the point — it is the shape of a seam this plugin
    // does not understand.
    const rpc = captureRpc()
    const asked = []
    const credentials = {
      resolve: async (ref) => { asked.push(String(ref)); return { value: 'sk-must-not-travel' } },
      readRecord: async () => undefined,
    }
    const settings = { get: () => ({ apiKeyEnv: 'DEEPSEEK_PRIVATE_KEY', baseURL: 'https://deepseek.internal.example/v1' }) }
    await bootBare({ connection: rpc.connection, credentials, settings })
    const upstream = stubUpstream(() => json({}))
    try {
      for (const provider of ['deepseek-official', 'opencode-go']) {
        const answer = await rpc.call({ provider })
        assert.equal(answer.ok, false, `${provider} answered ${JSON.stringify(answer)} through a seam it cannot read`)
        assert.equal(answer.error.code, 'unavailable', provider)
      }
      assert.deepEqual(upstream.calls, [], 'a seam the plugin cannot read must send a key nowhere — the defaults are exactly the wrong place')
      assert.deepEqual(asked, [], 'nor resolve one it would have nowhere to send')
    } finally {
      upstream.restore()
    }
  })
})
