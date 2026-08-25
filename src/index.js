/**
 * dsh-codex-lite — the ChatGPT-subscription model route for DeepSeek Harness,
 * and nothing else: `ctx.llm` gains the `openai-codex` provider (pi-ai's
 * official catalog: models, wire protocol, OAuth refresh) backed by an
 * owner-only credential file under `$DSH_HOME`. Sign-in is the terminal
 * `dsh-codex-lite login` command. In a Web composition it also registers one
 * read-only Connection RPC that answers the account-level usage of the
 * session's current model route — Codex weekly windows, OpenCode Go 5h/7d/1m
 * windows, or the official DeepSeek balance — for the Settings card and the
 * session-header chip; Connection applies the Harness trusted-host fence
 * first, and every credential stays host-side.
 * It registers no tools or search provider and changes no defaults.
 *
 * That field has three layers, each overriding the one above: the schema's
 * empty default, the composition entry (`cordis.patch.yml`, the deployment
 * baseline), and the user layer in `$DSH_HOME/settings.yaml`. The settings
 * seam owns the merge; a change there reaches the next request without a
 * restart, because the route reads its configuration through a thunk rather
 * than closing over the value it was composed with.
 * @module dsh-codex-lite
 */

import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { assertKnownModelIds, createOpenAICodexAccessResolver, createOpenAICodexLiteAdapter, openAICodexCatalogModelIds } from './adapter.js'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from './store.js'
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

export { createOpenAICodexAccessResolver, createOpenAICodexLiteAdapter } from './adapter.js'
export { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER, openAICodexAuthPath } from './store.js'
export { loginOpenAICodex, logoutOpenAICodex, openAICodexAuthStatus } from './auth.js'
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
export const name = 'llm-openai-codex-lite'

/** The LLM registry is the only required service; the trusted usage RPC mounts opportunistically. */
export const inject = ['llm']

/**
 * Namespace of this plugin's user-editable section in `$DSH_HOME/settings.yaml`.
 *
 * It is the plugin name, which is also the composition entry id and the key
 * the browser card registers under — the Settings tab dispatches a card only
 * to the namespace it names, so both halves must spell this the same way.
 */
export const settingsNs = settingsNamespace('llm-openai-codex-lite')

/**
 * Per-model replacements for the installed pi-ai catalog's context window, by
 * model id.
 *
 * The catalog carries the conservative numbers OpenAI tuned the Codex client
 * around, not the model's documented ceiling: `gpt-5.6-sol` ships as a 272000
 * window although OpenAI documents 1,050,000. Raising `contextWindow` is what
 * lets a session keep more history before whatever compaction backend the
 * session's agent preset mounts starts summarizing, and it is the same local
 * bookkeeping choice Codex exposes as `model_context_window`; the number never
 * reaches the server, which enforces its own limit and prices input above
 * 272000 at a higher tier.
 *
 * The window is the only field worth replacing on this route: the Codex
 * Responses request body carries no output-token cap, so an output size would
 * change neither what the seam publishes nor what reaches the server.
 *
 * Empty by default, so an unconfigured install keeps the catalog exactly.
 */
export const Config = z.object({
  modelOverrides: z.dict(z.object({
    // The ceiling is `Number.MAX_SAFE_INTEGER` rather than a guess at how
    // large a window could plausibly get: past it, integers stop being
    // distinguishable and `String(value)` starts producing exponent notation,
    // so a stored value would render into the card as something the card
    // cannot parse back. Refusing it on the way in keeps every stored window
    // editable.
    contextWindow: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .description('Context window in tokens. Local bookkeeping: it sizes the context meter and the compaction trigger, and never reaches the server.'),
  }).description('Catalog field replacements for this model.'))
    .default({})
    .description('Per-model context windows for the openai-codex catalog, by model id.'),
})

/**
 * The "no overrides" answer, as one stable object.
 *
 * The adapter's profiles thunk memoizes on this object's identity, so a fresh
 * `{}` per call would rebuild the provider on every operation.
 */
const NO_OVERRIDES = Object.freeze({})

/**
 * Read one settings section defensively: an absent service, an unmounted
 * namespace, or a reader that throws all answer "nothing", never a throw that
 * could take the model route down with the quota read.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} ns - the branded settings namespace.
 * @returns {unknown} the live section, when one is attached.
 */
function readSection(ctx, ns) {
  try {
    // `ctx.get(name)` and not `ctx.settings`: this plugin injects only `llm`,
    // and the property accessor refuses a service the fiber never declared —
    // it throws `cannot get property "settings" without inject` before the
    // fallback beside it can run. The catch below then turns that into
    // "nothing configured" for every route, silently, so every API-key route
    // would read its endpoint and credential reference from the defaults
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
 * Register the `openai-codex` route on the harness LLM seam, then bind the
 * route's sizing to the settings section so it can be edited at runtime.
 *
 * The registration is an effect owned by this plugin's fiber, so unloading the
 * plugin releases the route. Registration happens first and reads the
 * composition entry: an entry naming a model the catalog does not carry is a
 * configuration error that must fail this load, exactly as it did before the
 * section existed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the LLM registry.
 * @param {{modelOverrides?: Record<string, {contextWindow?: number}>}} [config] - validated plugin config.
 */
export function apply(ctx, config) {
  const entry = config ?? { modelOverrides: NO_OVERRIDES }
  // The authoritative source: the resolved settings section while one is
  // attached, the composition entry before that and after a detach.
  let current = () => entry
  const store = new OpenAICodexCredentialStore()
  // Model requests and quota reads share one pi-ai resolver. If either one
  // rotates an expired OAuth token, concurrent work joins that same refresh
  // instead of contending for the credential file's cross-process lock.
  const resolveAccessToken = createOpenAICodexAccessResolver(store)
  ctx.llm.registerAdapter(
    [OPENAI_CODEX_PROVIDER],
    createOpenAICodexLiteAdapter(
      store,
      () => ctx.get('attachments'),
      () => current().modelOverrides ?? NO_OVERRIDES,
      resolveAccessToken,
    ),
  )
  // The three quota sources, keyed by the model route the browser reports.
  // The endpoint of each API-key route is built from that route's own baseURL
  // plus a fixed suffix, so a key can only ever travel to the origin the model
  // route itself is configured against; unknown routes answer "none" and the
  // browser renders nothing. Headless compositions keep the model route
  // without acquiring a browser dependency; in Web, Connection owns the
  // Host/Origin/fetch-site trust fence and the channel registration follows
  // this plugin's fiber on unload.
  const piSection = () => readSection(ctx, settingsNamespace('llm-pi-ai'))
  const nativeSection = () => readSection(ctx, settingsNamespace('llm-deepseek'))
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
    codex: { resolveAccessToken, readCredential: () => store.readCurrent() },
  })
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.rpc.handle(
      OPENAI_CODEX_USAGE_CHANNEL,
      createProviderUsageRpc(usage),
      { authority: 'trusted-host' },
    )
  })
  // The catalog ships with the package, so the known ids are fixed for this
  // install and the write-time check costs nothing per validation.
  const catalogIds = openAICodexCatalogModelIds()
  try {
    installSettingsSection(ctx, settingsNs, Config, entry, {
      // Refuse the write rather than store a section that would size nothing:
      // the seam runs this before it persists, so a bad edit leaves both the
      // document and the serving route untouched, and the message it relays
      // is the one the loader would have thrown.
      validate: (value) => { assertKnownModelIds(value?.modelOverrides ?? {}, catalogIds) },
      setSource: (source) => { current = source },
      // Nothing derived from the section needs re-judging: the route set, its
      // display name and its retry policy do not depend on configuration, and
      // the adapter re-reads the thunk per operation.
      onChange: () => {
        ctx.logger.debug('dsh-codex-lite: modelOverrides source changed; the next request resolves the new window')
      },
    })
  } catch (error) {
    // A settings section is an enhancement, not a prerequisite. Losing it
    // leaves the route serving the composition entry, which is worth saying
    // out loud rather than failing a fiber that is otherwise healthy.
    ctx.logger.error('dsh-codex-lite: settings section unavailable; the route keeps serving its composition entry')
    ctx.logger.error(error)
  }
}
