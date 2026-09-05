/**
 * dsh-provider-quota — the account-quota surface for the model routes a Harness
 * composition already serves, and nothing else.
 *
 * It registers one read-only Connection RPC that answers the account-level
 * usage of the session's current model route — Codex 5h/7d windows, OpenCode
 * Go 5h/7d/1m windows, or the official DeepSeek balance — for the
 * session-header chip that is this plugin's only surface. Connection applies
 * request trust and browser-session authentication first, and every credential
 * stays host-side.
 *
 * It configures nothing, so it registers no settings section. It does READ two
 * sections other plugins own — `llm-pi-ai` and `llm-deepseek` — because the
 * endpoint and credential reference of an API-key quota route are the ones
 * that route is already configured with.
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
 * through `ctx.inject`, `settings` and `credentials` through `ctx.get`. A name
 * listed here would instead hold this fiber pending until that service
 * arrived — a headless composition mounting no Connection would keep the
 * plugin unloaded forever rather than mounting nothing. The empty list is also
 * what lets `service-reads` tell a soft read from an undeclared one.
 */
export const inject = []

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

/**
 * The OpenCode CLI's own stored key, for hosts signed into opencode directly.
 *
 * Scoped to the route that asks. The CLI files one entry per account, and
 * `opencode-go-extra` exists precisely to be a SECOND account: answering it
 * out of the `opencode-go` entry reports the first account's quota under the
 * second route — the same confusion the browser's per-provider slots prevent,
 * except here it is the host reading the wrong key, so no amount of slot
 * keying reaches it. Only the route the CLI itself names carries the legacy
 * `opencode` spelling.
 * @param {string} provider - the model route asking for a key.
 * @returns {Promise<string|undefined>} the stored key, when the CLI holds one for THIS route.
 */
async function opencodeAuthJsonKey(provider) {
  try {
    var raw = JSON.parse(await readFile(join(homedir(), '.local', 'share', 'opencode', 'auth.json'), 'utf8'))
    var entry = provider === 'opencode-go' ? raw['opencode-go'] ?? raw['opencode'] : raw[provider]
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
 * Mount the quota RPC.
 *
 * It is an effect owned by this plugin's fiber, so unloading the plugin
 * releases the channel with it.
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
      const key = await resolveApiKey(ctx, envName, 'llm-pi-ai', provider) ?? await opencodeAuthJsonKey(provider)
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
      // Same shape as the OpenCode branch above, and for the same reason: the
      // ternary picks the SOURCE, `httpBase` validates whatever it picked, and
      // a value it cannot use fails the read. Written the other way round —
      // `httpBase(configured) ?? httpBase(env) ?? PUBLIC` — a base that is
      // merely missing its scheme is indistinguishable from no base at all,
      // and the fallback sends a key provisioned for a private endpoint to
      // api.deepseek.com. An absent field is the only "not configured": the
      // settings schema omits a string it was never given rather than
      // defaulting it to empty.
      const configured = isProfile && typeof profile.baseURL === 'string'
        ? profile.baseURL
        : launchEnvironmentOf(ctx).get('DEEPSEEK_BASE_URL')?.value
      const base = httpBase(configured === undefined ? DEEPSEEK_PUBLIC_BASE_URL : configured)
      if (base === undefined) throw new CodexUsageError('unavailable', 'DeepSeek balance endpoint is not an absolute URL')
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
}
