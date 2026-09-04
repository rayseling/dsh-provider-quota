/**
 * dsh-provider-quota — the account-quota surface for the model routes a Harness
 * composition already serves, and nothing else.
 *
 * It registers one read-only Connection RPC that answers the account-level
 * usage of the session's current model route — Codex 5h/7d windows, OpenCode
 * Go 5h/7d/1m windows, or the official DeepSeek balance — for the Settings
 * card and the session-header chip. Connection applies request trust and
 * browser-session authentication first, and every credential stays host-side.
 *
 * It registers no model route. The `openai-codex` route is the harness's own
 * `llm-pi-ai` plugin's to serve: that package reached pi-ai's OAuth catalog
 * provider, per-route `models:` narrowing and per-model field overrides, which
 * is everything the adapter this plugin used to register existed for. Two
 * registrations of one route id are a `DUPLICATE_ADAPTER` failure at load, so
 * serving it here is not a choice a deployment could make alongside the native
 * one. What the harness does not have is this: the private usage endpoints.
 *
 * The Codex credential is read through the harness credential plane at the
 * record `llm-pi-ai` itself writes, so the quota read and the model requests
 * share one grant and one refresh (see `./credentials.js`).
 * @module dsh-provider-quota
 */

import z from '@deepseek-ai/schemastery'
import { createCodexCredentialStore, readCodexCredential } from './credentials.js'
import { createOpenAICodexAccessResolver } from './token.js'
import {
  CodexUsageError,
  createProviderUsageRpc,
  createProviderUsageService,
  DEEPSEEK_PUBLIC_BASE_URL,
  OPENAI_CODEX_USAGE_CHANNEL,
  OPENCODE_GO_BASE_URL,
} from './usage.js'
import { credentialKey, credentialRef, isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

export { createCodexCredentialStore, readCodexCredential, OPENAI_CODEX_PROVIDER } from './credentials.js'
export { createOpenAICodexAccessResolver } from './token.js'
export {
  createOpenAICodexUsageRpc,
  createOpenAICodexUsageService,
  createProviderUsageRpc,
  createProviderUsageService,
  fetchDeepSeekBalance,
  fetchOpencodeUsage,
  fetchOpenAICodexUsage,
  normalizeDeepSeekBalance,
  normalizeOpencodeGoUsage,
  normalizeOpenAICodexUsage,
  OPENAI_CODEX_USAGE_CHANNEL,
  OPENAI_CODEX_USAGE_METHOD,
  OPENAI_CODEX_USAGE_URL,
  OPENCODE_GO_BASE_URL,
} from './usage.js'

/** Stable Cordis plugin name. */
export const name = 'provider-quota'

/**
 * No service is required, and saying so is not a formality.
 *
 * Every service this plugin touches is optional and read soft: `connection`
 * and `settings` through `ctx.inject`, `credentials` through `ctx.get`. A name
 * listed here would instead hold this fiber pending until that service
 * arrived — a headless composition mounting no Connection would keep the
 * plugin unloaded forever rather than mounting nothing. The empty list is also
 * what lets `service-reads` tell a soft read from an undeclared one.
 */
export const inject = []

/**
 * Namespace of this plugin's section in `$DSH_HOME/settings.yaml`.
 *
 * It is the plugin name, which is also the composition entry id and the key
 * the browser card registers under — the Settings tab dispatches a card only
 * to the namespace it names, so both halves must spell this the same way.
 */
export const settingsNs = 'provider-quota'

/**
 * The section this plugin serves: nothing.
 *
 * It is registered anyway, and the empty schema is the honest shape rather
 * than a placeholder for a field to come. The plugins tab renders the
 * INTERSECTION of two ledgers — the namespaces the Host serves and the cards
 * registered into `settings.plugin.item` — so a card whose namespace nobody
 * registers is never dispatched
 * (`packages/client/ui-settings-plugins/src/client/tab-store.ts`). This
 * plugin's card displays quota and edits nothing, so without this registration
 * it would not appear at all.
 *
 * Nothing reads a value out of it, which is why there is no `validate` hook:
 * there is no field an edit could get wrong.
 */
export const Config = z.object({})

/**
 * Read one settings section defensively: an absent service, an unmounted
 * namespace, or a reader that throws all answer "nothing", never a throw that
 * could take the quota read down with it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} ns - the settings namespace.
 * @returns {unknown} the live section, when one is attached.
 */
function readSection(ctx, ns) {
  try {
    // `ctx.get(name)` and not `ctx.settings`: this plugin declares no
    // injection, and the property accessor refuses a service the fiber never
    // declared — it throws `cannot get property "settings" without inject`
    // before the fallback beside it can run. The catch below then turns that
    // into "nothing configured" for every route, silently, so every API-key
    // route would read its endpoint and credential reference from the defaults
    // instead of from the section the operator actually wrote.
    var settings = ctx.get('settings')
    if (settings === undefined || settings === null) return undefined
    return settings.get(ns)
  } catch (_sectionUnavailable) {
    return undefined
  }
}

/**
 * Resolve one API key the same way the model routes resolve their own: the
 * configured credential reference through the credentials seam (which layers
 * the managed store over the process environment), then the owning adapter's
 * stored api-key record, then the launch environment — the same last resort
 * the native DeepSeek adapter documents. The value leaves this module only
 * inside an upstream Authorization header.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} envName - the credential reference (POSIX identifier).
 * @param {string|undefined} recordOwner - stored-record scope, when this route stores keys.
 * @param {string} recordId - stored-record id under that scope.
 * @returns {Promise<string|undefined>} the key, or nothing when none is configured.
 */
async function resolveApiKey(ctx, envName, recordOwner, recordId) {
  try {
    var credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      var hit = await credentials.resolve(credentialRef(envName))
      if (hit !== undefined && hit.value.length > 0) return hit.value
      if (recordOwner !== undefined && isCredentialKeySegment(recordId)) {
        var record = await credentials.readRecord(credentialKey(recordOwner, recordId))
        if (record !== undefined && record.kind === 'api-key'
          && typeof record.key === 'string' && record.key.length > 0) {
          return record.key
        }
      }
    }
  } catch (_credentialUnavailable) {
    // Fall through to the launch environment.
  }
  var ambient = launchEnvironmentOf(ctx).get(envName)
  if (ambient !== undefined && ambient.value.length > 0) return ambient.value
  return undefined
}

/** The OpenCode CLI's own stored key, for hosts signed into opencode directly. */
async function opencodeAuthJsonKey() {
  try {
    var raw = JSON.parse(await readFile(join(homedir(), '.local', 'share', 'opencode', 'auth.json'), 'utf8'))
    var entry = raw['opencode-go'] ?? raw['opencode']
    if (entry !== null && typeof entry === 'object' && entry.type === 'api'
      && typeof entry.key === 'string' && entry.key.length > 0) {
      return entry.key
    }
  } catch (_authJsonUnavailable) {
    // Absent or unreadable — nothing stored.
  }
  return undefined
}

/**
 * @param {string|undefined} value
 * @returns {string|undefined} an absolute http(s) base without a trailing slash, or nothing.
 */
function httpBase(value) {
  if (typeof value !== 'string') return undefined
  var trimmed = value.trim()
  if (!/^https?:\/\/[^\/\s]+/u.test(trimmed)) return undefined
  return trimmed.replace(/\/+$/u, '')
}

/**
 * Mount the quota RPC, and the namespace that lets its card be dispatched.
 *
 * Both are effects owned by this plugin's fiber, so unloading the plugin
 * releases the channel and the section with it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  // The Codex reader and the native `llm-pi-ai` route resolve the same stored
  // grant. Whichever refreshes first commits the rotation inside the credential
  // record's write lock, and the other reads what it wrote.
  const store = createCodexCredentialStore(ctx)
  const resolveAccessToken = createOpenAICodexAccessResolver(store)
  // The three quota sources, keyed by the model route the browser reports.
  // The endpoint of each API-key route is built from that route's own baseURL
  // plus a fixed suffix, so a key can only ever travel to the origin the model
  // route itself is configured against; unknown routes answer "none" and the
  // browser renders nothing. Headless compositions keep the RPC without
  // acquiring a browser dependency; in Web, Connection owns request trust plus
  // browser-session authentication, and channel registration follows this
  // plugin's fiber on unload.
  const piSection = () => readSection(ctx, 'llm-pi-ai')
  const nativeSection = () => readSection(ctx, 'llm-deepseek')
  const resolveRoute = async (provider) => {
    if (provider === 'openai-codex') return { kind: 'codex' }
    if (provider === 'opencode-go' || provider === 'opencode-go-extra') {
      const section = piSection()
      const profile = section === undefined ? undefined : section.providers?.[provider]
      const isProfile = profile !== null && typeof profile === 'object'
      const envName = isProfile && typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0
        ? profile.apiKeyEnv : 'OPENCODE_GO_API_KEY'
      const key = await resolveApiKey(ctx, envName, 'llm-pi-ai', provider) ?? await opencodeAuthJsonKey()
      if (key === undefined) throw new CodexUsageError('no-credential', 'OpenCode Go API key is not configured')
      const endpoint = httpBase(isProfile && typeof profile.baseURL === 'string' ? profile.baseURL : OPENCODE_GO_BASE_URL)
      if (endpoint === undefined) throw new CodexUsageError('unavailable', 'OpenCode Go usage endpoint is not an absolute URL')
      return { kind: 'opencode', endpoint, apiKey: key }
    }
    if (provider === 'deepseek-official' || provider === 'deepseek') {
      // Two section shapes, not one. The pi-ai section keys a profile dict by
      // route, so `deepseek` there is `providers.deepseek`; the native
      // llm-deepseek section is flat — it registers itself at `settingsPath:
      // []`, so `apiKeyEnv` and `baseURL` sit at its root with no `providers`
      // above them. Reading the native one through `providers` finds nothing
      // and silently falls back to the defaults, which sends a key configured
      // for a private endpoint to the public one.
      const isNative = provider === 'deepseek-official'
      const section = isNative ? nativeSection() : piSection()
      const profile = section === undefined
        ? undefined
        : isNative ? section : section.providers?.['deepseek']
      const isProfile = profile !== null && typeof profile === 'object'
      const envName = isProfile && typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0
        ? profile.apiKeyEnv : 'DEEPSEEK_API_KEY'
      const key = await resolveApiKey(ctx, envName, provider === 'deepseek' ? 'llm-pi-ai' : undefined, provider === 'deepseek' ? 'deepseek' : '')
      if (key === undefined) throw new CodexUsageError('no-credential', 'DeepSeek API key is not configured')
      const configured = isProfile && typeof profile.baseURL === 'string' ? profile.baseURL : undefined
      const base = httpBase(configured)
        ?? httpBase(launchEnvironmentOf(ctx).get('DEEPSEEK_BASE_URL')?.value)
        ?? DEEPSEEK_PUBLIC_BASE_URL
      return { kind: 'deepseek', endpoint: base, apiKey: key }
    }
    return undefined
  }
  const usage = createProviderUsageService({
    resolveRoute,
    codex: { resolveAccessToken, readCredential: () => readCodexCredential(ctx) },
  })
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.rpc.handle(OPENAI_CODEX_USAGE_CHANNEL, createProviderUsageRpc(usage))
  })
  // `installSection` is a method on the settings service, so the
  // optional-service wiring is the caller's: the body runs only while a
  // provider is attached. The owner argument is `ctx`, not `settingsCtx` — the
  // seam uses it to tell this plugin unloading from the provider merely
  // detaching.
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.settings.installSection(ctx, settingsNs, Config, {}, {
        // Nothing is served from the section, so neither hook has work to do.
        // They are required by the seam, and writing them as no-ops states
        // that plainly.
        setSource: () => {},
        onChange: () => {},
      })
    } catch (error) {
      // The section is what makes the card dispatchable, not what makes the
      // quota readable. Losing it costs the Settings card while the chip and
      // the RPC keep working, which is worth saying out loud rather than
      // failing a fiber that is otherwise healthy.
      ctx.logger.error('dsh-provider-quota: settings namespace unavailable; the Settings card cannot be dispatched')
      ctx.logger.error(error)
    }
  })
}
