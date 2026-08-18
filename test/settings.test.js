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
]).then(modules => ({ modules }), error => ({ error }))
const skip = loaded.error === undefined ? false : `peer dependencies are not installed (${loaded.error.code ?? 'import failed'})`
const [cordis, llm, settingsFile, plugin] = loaded.modules ?? []

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
 * @param {{settings?: boolean}} [options] - whether to compose a settings provider at all.
 * @returns {Promise<object>} the root context.
 */
async function boot(home, config, options = {}) {
  const ctx = new cordis.Context()
  disposers.push(() => ctx.fiber.dispose())
  await ctx.plugin(llm.LlmRuntime)
  if (options.settings !== false) {
    await ctx.plugin(settingsFile.FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false })
  }
  await ctx.plugin(plugin, config)
  return ctx
}

/** @returns {Promise<number>} the window the route currently publishes for `model`. */
const windowOf = async (ctx, model = MODEL) =>
  (await ctx.llm.resolveModelInfo('openai-codex', model)).context.contextWindow

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

  test('the namespace is registered, which is what dispatches the browser card', async () => {
    const home = await freshHome()
    const ctx = await boot(home, {})
    assert.ok(
      ctx.settings.describe().some(descriptor => descriptor.ns === plugin.settingsNs),
      `settings.describe() must list ${plugin.settingsNs}`,
    )
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
