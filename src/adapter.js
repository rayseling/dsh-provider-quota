/**
 * The one non-trivial piece: bridge pi-ai's OAuth-only `openai-codex` catalog
 * provider into dsh's official `PiAiAdapter`.
 *
 * `PiAiAdapter` passes credentials as a per-request `apiKey` override, and
 * pi-ai honours that override only when the provider declares an api-key auth
 * method — the catalog provider declares OAuth alone. So the route's provider
 * gains one api-key method that accepts exactly the explicit override (never
 * an environment key), and the override itself is the OAuth access token
 * resolved — and auto-refreshed — by a private `Models` collection holding the
 * plugin's file credential store. Everything else (message conversion,
 * attachment resolution, streaming, retries, reasoning metadata) is the
 * official adapter, untouched.
 *
 * Credential resolution is the one phase no other layer bounds: `PiAiAdapter`
 * awaits it before it builds the request's abort signal, and pi-ai refreshes
 * an expired token inside the credential store's cross-process lock without a
 * deadline of its own. This module therefore owns three guards around it —
 * one refresh at a time per process, a ceiling on the refresh so the file lock
 * is released, and a ceiling on the whole resolution so a stalled token
 * endpoint fails the turn instead of freezing it.
 * @module dsh-codex-lite/adapter
 */

import { createModels } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { safeMessage } from './redact.js'
import { OPENAI_CODEX_PROVIDER } from './store.js'

/** Provider idle ceiling for the streamed response. */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Ceiling on one request's base64 image payload, above which the adapter
 * replaces the oldest images with text placeholders until the request fits.
 *
 * Every Codex model but the spark one accepts images, and this plugin does
 * wire up the attachment store, so an image-heavy session accumulates until
 * the gateway refuses the request — as a payload-too-large the seam classifies
 * `INVALID_REQUEST` and never retries, which ends the turn outright.
 *
 * The number matches the host's own default for the pi-ai routes it composes.
 * It is written out rather than imported because that package does not export
 * it, so this is a copy that can drift; a profile without the field disables
 * the eviction entirely, which is the one outcome worth avoiding.
 */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * Ceiling for one credential resolution, refresh included. Reaching it fails
 * the request as a retryable timeout rather than leaving the turn suspended in
 * a phase the harness cannot cancel.
 */
const CREDENTIAL_TIMEOUT_MS = 20_000

/**
 * Ceiling for the OAuth refresh alone, below {@link CREDENTIAL_TIMEOUT_MS} so
 * the credential file lock is released while the caller is still waiting.
 */
const REFRESH_TIMEOUT_MS = 15_000

/**
 * Reject with `onTimeout()` once `promise` outlives `timeoutMs`.
 *
 * The underlying work is not cancelled: pi-ai's refresh takes no
 * `AbortSignal`, and the provider's own refresh issues a `fetch` without one,
 * so a deadline can only stop waiting. The abandoned promise keeps a rejection
 * handler here so a late failure never surfaces as an unhandled rejection.
 * @template T
 * @param {Promise<T>} promise - the work to bound.
 * @param {number} timeoutMs - deadline in milliseconds.
 * @param {() => Error} onTimeout - failure to reject with at the deadline.
 * @returns {Promise<T>} the work's result, or the timeout failure.
 */
function withDeadline(promise, timeoutMs, onTimeout) {
  promise.catch(() => {})
  /** @type {ReturnType<typeof setTimeout>} */
  let timer
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs)
  })
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
}

/** Marker carried by {@link boundedRefreshProvider}'s deadline failure. */
const REFRESH_TIMEOUT_MARKER = 'dsh-codex-lite: OpenAI Codex token refresh did not answer'

/**
 * pi-ai's own wording for a refresh whose `fetch` never produced a response —
 * DNS failure, a dropped link, a proxy refusing the connection. Copied from
 * `pi-ai/dist/auth/oauth/openai-codex.js` (0.82.1), where it reads
 * `OpenAI Codex token refresh error: ${cause}`.
 */
const REFRESH_TRANSPORT_PREFIX = 'OpenAI Codex token refresh error:'

/**
 * pi-ai's own wording for a token endpoint that answered with a status —
 * `OpenAI Codex token refresh failed (503): …` in the same module. The status
 * is what separates a revoked grant from a bad five minutes at OpenAI.
 */
const REFRESH_STATUS = /OpenAI Codex token (?:refresh|exchange) failed \((\d{3})\)/u

/**
 * Classify a credential failure into the seam's retry taxonomy.
 *
 * The default retry policy retries `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`,
 * `TIMEOUT` and `TRANSPORT` and nothing else, so this function decides whether
 * a failure ends the turn. Only a failure that says the grant itself is bad deserves
 * `AUTH`: it is the one answer that sends the operator to `login`, and
 * spending it on a dropped packet teaches them to re-authenticate for a
 * problem re-authenticating cannot fix.
 *
 * Five conditions clear on their own. This module's own refresh deadline and
 * another writer holding the credential file lock are stalls — `dsh-atomic-write`
 * gives a contender a fixed two-second acquisition deadline, and the holder is
 * only committing a rotation. A refresh that never reached the endpoint is
 * transport. Any 5xx is the endpoint's own weather, and so are the only two
 * 4xx that describe the moment rather than the grant: 408, the endpoint saying
 * the request took too long, and 429, it saying not yet. Everything else —
 * 400 `invalid_grant` above all — is the grant.
 *
 * The evidence is the message rather than a code, because pi-ai throws a plain
 * `Error` at the refresh site and the `ModelsError` that carries it upward
 * folds that text into its own message. Wording is therefore this plugin's
 * dependency on pi-ai as much as the function signatures are; the tests pin
 * the exact strings 0.82.1 emits, so a rewording upstream fails a test here
 * rather than silently downgrading every blip back to `AUTH`.
 * @param {unknown} error - thrown value.
 * @returns {string} the seam error code to report it under.
 */
function classifyCredentialFailure(error) {
  if (!(error instanceof Error)) return 'AUTH'
  const message = error.message
  if (message.includes(REFRESH_TIMEOUT_MARKER)
    || message.includes('timed out waiting for the writer lock')) return 'TIMEOUT'
  if (message.includes(REFRESH_TRANSPORT_PREFIX)) return 'TRANSPORT'
  const status = REFRESH_STATUS.exec(message)
  if (status === null) return 'AUTH'
  const code = Number(status[1])
  if (code === 408) return 'TIMEOUT'
  if (code === 429) return 'RATE_LIMIT'
  return code >= 500 ? 'SERVER' : 'AUTH'
}

/**
 * Clone the provider with a request-scoped bearer-token entry beside its OAuth
 * method. The resolver accepts only the explicit override this plugin
 * supplies; it never discovers a key from the environment.
 * @param {import('@earendil-works/pi-ai').Provider} provider - the catalog provider.
 * @returns {import('@earendil-works/pi-ai').Provider} the same provider accepting a per-request bearer token.
 */
function requestProvider(provider) {
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        name: 'OpenAI Codex OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'OAuth' }
        },
      },
    },
  }
}

/**
 * Clone the provider so its OAuth refresh cannot outlive
 * {@link REFRESH_TIMEOUT_MS}.
 *
 * pi-ai runs `refresh` inside the credential store's `modify`, which this
 * plugin serializes with a cross-process file lock, and a contender for that
 * lock waits two seconds before failing. A refresh that hangs therefore fails
 * every concurrent sign-in, sign-out and refresh — including ones in other dsh
 * processes sharing `$DSH_HOME` — rather than only itself. Bounding the
 * refresh releases the lock, which is what those waiters need; the request
 * behind it cannot be cancelled and is simply abandoned.
 * @param {import('@earendil-works/pi-ai').Provider} provider - the catalog provider.
 * @returns {import('@earendil-works/pi-ai').Provider} the provider whose refresh is bounded.
 */
function boundedRefreshProvider(provider) {
  const oauth = provider.auth.oauth
  if (oauth === undefined) return provider
  return {
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        ...oauth,
        refresh: credential => withDeadline(
          oauth.refresh(credential),
          REFRESH_TIMEOUT_MS,
          () => new Error(`${REFRESH_TIMEOUT_MARKER} within ${REFRESH_TIMEOUT_MS}ms`),
        ),
      },
    },
  }
}

/**
 * Model ids the installed pi-ai `openai-codex` catalog carries.
 *
 * The catalog ships with the package, so the answer is fixed for an install
 * and worth reading once at load rather than once per validation.
 * @returns {string[]} every catalog model id.
 */
export function openAICodexCatalogModelIds() {
  return openaiCodexProvider().getModels().map(model => model.id)
}

/**
 * Refuse overrides naming a model the catalog does not carry.
 *
 * Exported so the settings section's `validate` hook refuses a bad write with
 * exactly the message the loader would throw, rather than a second wording of
 * the same rule.
 * @param {Record<string, unknown>} overrides - per-model overrides, by model id.
 * @param {readonly string[]} catalogIds - every id the catalog carries.
 */
export function assertKnownModelIds(overrides, catalogIds) {
  const unknown = Object.keys(overrides).filter(id => !catalogIds.includes(id))
  if (unknown.length === 0) return
  throw new Error(
    `dsh-codex-lite: modelOverrides names ${unknown.map(id => JSON.stringify(id)).join(', ')},`
    + ` which the openai-codex catalog does not carry; known ids are ${catalogIds.join(', ')}`,
  )
}

/**
 * Clone the provider with per-model catalog sizing replaced.
 *
 * The installed pi-ai catalog sizes each model, and its numbers are the
 * conservative ones OpenAI tuned Codex around — `gpt-5.6-sol` ships as
 * 272000 even though the model documents a 1,050,000-token window. Both dsh
 * consumers of that size read it from this model list: the resolved model
 * info the seam publishes (the context meter and whatever compaction backend a
 * preset mounts) and the stream mapper's context-overflow detection. So
 * replacing it here is what a larger window means end to end.
 *
 * Sizing is the whole surface, because `contextWindow` is the only catalog
 * field this route consumes: the Codex Responses request body carries no
 * output-token cap, so a `maxTokens` replacement would reach neither the seam
 * nor the wire.
 *
 * An override naming a model the catalog does not carry is a configuration
 * error and throws at load rather than silently sizing nothing.
 * @param {import('@earendil-works/pi-ai').Provider} provider - the catalog provider.
 * @param {Record<string, {contextWindow?: number}>} overrides - per-model context windows, by model id.
 * @returns {import('@earendil-works/pi-ai').Provider} the provider whose models carry the overrides.
 */
function withModelOverrides(provider, overrides) {
  const ids = Object.keys(overrides)
  if (ids.length === 0) return provider
  const catalog = provider.getModels()
  assertKnownModelIds(overrides, catalog.map(model => model.id))
  const models = catalog.map((model) => {
    const override = overrides[model.id]
    if (override === undefined || override.contextWindow === undefined) return model
    return { ...model, contextWindow: override.contextWindow }
  })
  return { ...provider, getModels: () => models }
}

/**
 * Build the `profiles()` thunk `PiAiAdapter` reads once per operation.
 *
 * The adapter memoizes its snapshot on the returned map's identity and
 * captures that snapshot before any await, so returning the same map keeps a
 * running request stable while returning a new one swaps the route for the
 * next request alone. Memoizing on the override object's identity is what
 * lets a configuration change reach the next request without a restart, and
 * what keeps an unchanged configuration from rebuilding the provider on every
 * operation.
 * @param {() => Record<string, {contextWindow?: number}>} currentOverrides - reads the live overrides.
 * @param {import('@earendil-works/pi-ai').Provider} requestReady - the provider carrying the bearer-token method.
 * @param {object} baseProfile - the profile fields no configuration touches.
 * @returns {() => ReadonlyMap<string, object>} the memoized thunk.
 */
export function createProfilesThunk(currentOverrides, requestReady, baseProfile) {
  let lastRaw
  let memoized
  return () => {
    const raw = currentOverrides()
    if (raw === lastRaw && memoized !== undefined) return memoized
    memoized = new Map([[OPENAI_CODEX_PROVIDER, {
      ...baseProfile,
      piProvider: withModelOverrides(requestReady, raw),
    }]])
    lastRaw = raw
    return memoized
  }
}

/**
 * Resolve the OAuth access token through pi-ai, sharing refresh work and keeping
 * the same timeout/error taxonomy for model calls and auxiliary Codex APIs.
 *
 * The returned function deliberately exposes only the access token. Callers
 * that need the non-secret ChatGPT account id read it from the credential store
 * after this resolution, when a possible token rotation has been persisted.
 * @param {import('./store.js').OpenAICodexCredentialStore} store - the plugin's file credential store.
 * @returns {() => Promise<string>} a single-flight, bounded access-token resolver.
 */
export function createOpenAICodexAccessResolver(store) {
  const models = createModels({ credentials: store })
  models.setProvider(boundedRefreshProvider(openaiCodexProvider()))
  /** @type {Promise<import('@earendil-works/pi-ai').AuthResult | undefined> | undefined} */
  let inflight
  const resolveCredential = () => {
    inflight ??= models.getAuth(OPENAI_CODEX_PROVIDER).finally(() => { inflight = undefined })
    return withDeadline(
      inflight,
      CREDENTIAL_TIMEOUT_MS,
      () => new LlmError(
        `OpenAI Codex credential resolution timed out after ${CREDENTIAL_TIMEOUT_MS}ms`,
        'TIMEOUT',
      ),
    )
  }
  return async () => {
    let resolved
    try {
      resolved = await resolveCredential()
    } catch (error) {
      if (error instanceof LlmError) throw error
      // No `cause`: the provider's response can contain credential material,
      // and every surface using this resolver must remain safe to render/log.
      throw new LlmError(
        `OpenAI Codex credential resolution failed: ${safeMessage(error)}`,
        classifyCredentialFailure(error),
      )
    }
    const apiKey = resolved?.auth.apiKey
    if (apiKey === undefined || apiKey.length === 0) {
      throw new LlmError(
        'OpenAI Codex is not signed in: run `dsh plugin --profile web exec dsh-codex-lite login` on the dsh host',
        'MISSING_CREDENTIAL',
      )
    }
    return apiKey
  }
}

/**
 * Assemble the official dsh pi-ai adapter for the one `openai-codex` route.
 * @param {import('./store.js').OpenAICodexCredentialStore} store - the plugin's file credential store.
 * @param {() => import('@deepseek-ai/dsh-attachment').AttachmentStore | undefined} resolveAttachments - durable attachment service, resolved at request time.
 * @param {Record<string, {contextWindow?: number}> | (() => Record<string, {contextWindow?: number}>)} [modelOverrides]
 *   Per-model context windows, by model id. A thunk is re-read on every
 *   operation, so a configuration change reaches the next request without a
 *   restart.
 * @param {() => Promise<string>} [resolveAccessToken] - shared OAuth access-token resolver.
 * @returns {PiAiAdapter} the adapter to register for `openai-codex`.
 */
export function createOpenAICodexLiteAdapter(store, resolveAttachments, modelOverrides = {}, resolveAccessToken) {
  const currentOverrides = typeof modelOverrides === 'function' ? modelOverrides : () => modelOverrides
  const provider = openaiCodexProvider()
  const profiles = createProfilesThunk(currentOverrides, requestProvider(provider), {
    provider: OPENAI_CODEX_PROVIDER,
    displayName: 'OpenAI Codex',
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-codex-lite retryPolicy'),
    configuredMaxTokens: new Map(),
  })
  // Resolve once here: an override naming a model the catalog does not carry
  // is a configuration error this load must report, which stays true now that
  // the thunk defers every later rebuild to request time.
  profiles()
  // The host can pass one resolver shared with the usage endpoint, so a token
  // rotation requested by either consumer is one operation under the file lock.
  const accessToken = resolveAccessToken ?? createOpenAICodexAccessResolver(store)
  return new PiAiAdapter({
    profiles,
    resolveApiKey: accessToken,
    resolveAttachments,
  })
}
