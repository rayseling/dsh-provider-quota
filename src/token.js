/**
 * The Codex access token: one bounded, single-flight resolution shared by every
 * reader in this process.
 *
 * Credential resolution is the one phase no caller bounds. pi-ai refreshes an
 * expired token inside the credential store's `modify`, which the harness
 * credential plane serializes across processes; pi-ai bounds the token request
 * itself, but nothing bounds the wait for that cross-process lock. This module
 * therefore owns three guards around it — one refresh
 * at a time per process, a ceiling on the refresh so the record lock is
 * released, and a ceiling on the whole resolution so a stalled token endpoint
 * fails the quota read instead of freezing it.
 *
 * Rotation is committed inside that same `modify`, to the record the native
 * `llm-pi-ai` route reads, so a refresh started here and a request served there
 * never end up holding two halves of one rotated grant.
 * @module dsh-provider-quota/token
 */

import { createModels } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { safeMessage } from './redact.js'
import { OPENAI_CODEX_PROVIDER } from './credentials.js'

/**
 * Ceiling for one credential resolution, refresh included. Reaching it fails
 * the request as a retryable timeout rather than leaving the turn suspended in
 * a phase the harness cannot cancel.
 */
const CREDENTIAL_TIMEOUT_MS = 20_000

/**
 * Ceiling for the OAuth refresh alone. Two deadlines sit above it and it has
 * to stay under both.
 *
 * {@link CREDENTIAL_TIMEOUT_MS}, so the credential record's document lock is
 * released while the caller is still waiting. And pi-ai 0.85.1's own 15s
 * `AbortSignal.timeout` around `refresh`, armed in
 * `@earendil-works/pi-ai/dist/auth/resolve.js`, so that the deadline which
 * fires first is always the one {@link boundedRefreshProvider} raises — the
 * only one carrying the marker {@link classifyCredentialFailure} reads as
 * TIMEOUT. At the equal values these two had, that race was settled by which
 * timer happened to be constructed first.
 */
const REFRESH_TIMEOUT_MS = 14_000

/**
 * Deadlines are injectable here for the same reason they are on every fetch in
 * `./usage.js`: a test that has to spend the real one cannot afford to assert
 * what happens at it, and a suite that cannot assert it stops noticing when
 * reaching the deadline quietly changes meaning. Nothing in the plugin passes
 * this; {@link REFRESH_TIMEOUT_MS} is the shipped value.
 * @typedef {{refreshTimeoutMs?: number}} ResolverOptions
 */

/**
 * Reject with `onTimeout()` once `promise` outlives `timeoutMs`.
 *
 * This stops WAITING and nothing else; cancelling the work behind it is the
 * caller's business. {@link boundedRefreshProvider} does cancel its own, from
 * inside `onTimeout`; the credential resolution below has nothing to cancel.
 * The abandoned promise keeps a rejection handler here so a late failure never
 * surfaces as an unhandled rejection.
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
const REFRESH_TIMEOUT_MARKER = 'dsh-provider-quota: OpenAI Codex token refresh did not answer'

/**
 * pi-ai's own wording for a refresh whose `fetch` never produced a response —
 * DNS failure, a dropped link, a proxy refusing the connection. Copied from
 * `pi-ai/dist/auth/oauth/openai-codex.js` (0.85.1), where it reads
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
 * `AUTH`: it is the one answer that sends the operator back to the sign-in
 * record, and spending it on a dropped packet teaches them to re-authenticate
 * for a problem re-authenticating cannot fix.
 *
 * Five conditions clear on their own. This module's own refresh deadline and
 * another writer holding the credentials document's lock are stalls — every
 * writer of that document waits 30s for it and the holder is only committing a
 * rotation. A refresh that never reached the endpoint is
 * transport. Any 5xx is the endpoint's own weather, and so are the only two
 * 4xx that describe the moment rather than the grant: 408, the endpoint saying
 * the request took too long, and 429, it saying not yet. Everything else —
 * 400 `invalid_grant` above all — is the grant.
 *
 * The evidence is the message rather than a code, because pi-ai throws a plain
 * `Error` at the refresh site and the `ModelsError` that carries it upward
 * folds that text into its own message. Wording is therefore this plugin's
 * dependency on pi-ai as much as the function signatures are; the tests pin
 * the exact strings 0.85.1 emits, so a rewording upstream fails a test here
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
 * Clone the provider so its OAuth refresh cannot outlive
 * {@link REFRESH_TIMEOUT_MS} — and so that reaching that deadline ends the
 * request rather than only stopping the wait for it.
 *
 * pi-ai runs `refresh` inside the credential store's `modify`, which the
 * harness credential plane serializes with a cross-process lock over the whole
 * credentials document, and every contender for it waits 30s before failing. A
 * refresh that hangs therefore stalls every concurrent write to that document —
 * the native `llm-pi-ai` route's own refresh, any other route's key, and the
 * same work in other dsh processes sharing `$DSH_HOME` — rather than only
 * itself. Bounding the refresh below that wait releases the lock, which is what
 * those waiters need.
 *
 * Two things have to hold at once, and the first version of this wrapper
 * bought the first by giving up the second:
 *
 * - The rejection must carry {@link REFRESH_TIMEOUT_MARKER}, or
 *   {@link classifyCredentialFailure} sees pi-ai's own abort wording and
 *   reports TRANSPORT for what is this module's deadline. That is why the
 *   deadline is raised here instead of delegated to pi-ai's, and why
 *   {@link REFRESH_TIMEOUT_MS} now sits below it rather than equal to it.
 * - The token request must actually be cancelled. Passing `refresh` the
 *   credential alone dropped the signal pi-ai hands in, which left the
 *   underlying `fetch` unsignalled — not bounded at 15s by pi-ai, bounded by
 *   nothing at all. An abandoned refresh could then succeed minutes later and
 *   rotate the grant at OpenAI, while the transaction that would have stored
 *   the rotated refresh token had already failed and released the lock. A
 *   grant rotated upstream and dropped here is a sign-in the operator redoes.
 *
 * So keep pi-ai's signal, add one this module can trip, and trip it as the
 * deadline rejects. Cancelling the socket cannot un-rotate a refresh the
 * endpoint already committed — nothing on this side can — but it bounds that
 * window to the deadline instead of leaving it open.
 * @param {import('@earendil-works/pi-ai').Provider} provider - the catalog provider.
 * @param {number} timeoutMs - the deadline to bound the refresh at.
 * @returns {import('@earendil-works/pi-ai').Provider} the provider whose refresh is bounded and cancelled.
 */
function boundedRefreshProvider(provider, timeoutMs) {
  const oauth = provider.auth.oauth
  if (oauth === undefined) return provider
  return {
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        ...oauth,
        refresh: (credential, signal) => {
          const deadline = new AbortController()
          const bounded = signal === undefined
            ? deadline.signal
            : AbortSignal.any([signal, deadline.signal])
          return withDeadline(
            oauth.refresh(credential, bounded),
            timeoutMs,
            () => {
              deadline.abort()
              return new Error(`${REFRESH_TIMEOUT_MARKER} within ${timeoutMs}ms`)
            },
          )
        },
      },
    },
  }
}

/**
 * Resolve the OAuth access token through pi-ai, sharing refresh work and
 * keeping one timeout/error taxonomy for every reader of the quota endpoint.
 *
 * The returned function deliberately exposes only the access token. Callers
 * that need the non-secret ChatGPT account id read it from the credential store
 * after this resolution, when a possible token rotation has been persisted.
 * @param {object} store - the pi-ai credential store over the harness credential record.
 * @param {ResolverOptions} [options] - deadline overrides; the plugin passes none.
 * @returns {() => Promise<string>} a single-flight, bounded access-token resolver.
 */
export function createOpenAICodexAccessResolver(store, options = {}) {
  const models = createModels({ credentials: store })
  models.setProvider(boundedRefreshProvider(openaiCodexProvider(), options.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS))
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
        'OpenAI Codex is not signed in: no grant record is stored at llm-pi-ai/openai-codex'
        + ' (see the sign-in section of the dsh-provider-quota README)',
        'MISSING_CREDENTIAL',
      )
    }
    return apiKey
  }
}
