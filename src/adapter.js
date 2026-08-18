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
 * Whether a credential failure is a stall rather than a rejection.
 *
 * Two conditions qualify: this module's own refresh deadline, and another
 * writer holding the credential file lock — `dsh-atomic-write` gives a
 * contender a fixed two-second acquisition deadline, and the holder is only
 * committing a rotation. Both clear on their own, which makes them timeouts
 * rather than auth failures, and so eligible for the route's retry policy.
 * pi-ai reports either one as a `ModelsError` that folds the cause text into
 * its own message, so the message is where the condition stays recognizable.
 * @param {unknown} error - thrown value.
 * @returns {boolean} whether the failure is expected to clear by itself.
 */
function isTransientCredentialStall(error) {
  return error instanceof Error
    && (error.message.includes(REFRESH_TIMEOUT_MARKER)
      || error.message.includes('timed out waiting for the writer lock'))
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
 * Assemble the official dsh pi-ai adapter for the one `openai-codex` route.
 * @param {import('./store.js').OpenAICodexCredentialStore} store - the plugin's file credential store.
 * @param {() => import('@deepseek-ai/dsh-attachment').AttachmentStore | undefined} resolveAttachments - durable attachment service, resolved at request time.
 * @param {Record<string, {contextWindow?: number}> | (() => Record<string, {contextWindow?: number}>)} [modelOverrides]
 *   Per-model context windows, by model id. A thunk is re-read on every
 *   operation, so a configuration change reaches the next request without a
 *   restart.
 * @returns {PiAiAdapter} the adapter to register for `openai-codex`.
 */
export function createOpenAICodexLiteAdapter(store, resolveAttachments, modelOverrides = {}) {
  const currentOverrides = typeof modelOverrides === 'function' ? modelOverrides : () => modelOverrides
  const provider = openaiCodexProvider()
  const profiles = createProfilesThunk(currentOverrides, requestProvider(provider), {
    provider: OPENAI_CODEX_PROVIDER,
    displayName: 'OpenAI Codex',
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-codex-lite retryPolicy'),
    configuredMaxTokens: new Map(),
  })
  // Resolve once here: an override naming a model the catalog does not carry
  // is a configuration error this load must report, which stays true now that
  // the thunk defers every later rebuild to request time.
  profiles()
  // Private collection holding the persistent store: getAuth() returns the
  // stored access token, refreshing it through the provider's OAuth method
  // (and persisting the rotation) when expired.
  const models = createModels({ credentials: store })
  models.setProvider(boundedRefreshProvider(provider))
  // One resolution at a time. A refresh runs under the store's cross-process
  // lock, and that lock gives a contender two seconds, so letting concurrent
  // requests race it turns one slow refresh into a failed turn for every other
  // request in flight. Sharing the resolution also means one rotation per
  // expiry, which is what a provider issuing rotating refresh tokens expects.
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
  return new PiAiAdapter({
    profiles,
    resolveApiKey: async () => {
      let resolved
      try {
        resolved = await resolveCredential()
      } catch (error) {
        if (error instanceof LlmError) throw error
        // pi-ai reports a revoked refresh token, a damaged credential document
        // and lock contention alike as a plain `ModelsError`, which the seam
        // classifies as `UNKNOWN` and never retries; its message also carries
        // whatever the token endpoint answered, token material included.
        throw new LlmError(
          `OpenAI Codex credential resolution failed: ${safeMessage(error)}`,
          isTransientCredentialStall(error) ? 'TIMEOUT' : 'AUTH',
          { cause: error },
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
    },
    resolveAttachments,
  })
}
