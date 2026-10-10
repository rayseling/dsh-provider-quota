/**
 * Server-side access to the private Codex subscription usage endpoint.
 *
 * OAuth material never crosses this module's Connection-RPC boundary: the
 * browser gets normalized rolling (5h) and weekly (7d) windows, while the
 * bearer token and ChatGPT account id stay in the host process. The upstream
 * response is deliberately treated as an additive/private contract — unknown
 * fields are ignored and windows are classified by duration rather than by
 * their primary/secondary slot.
 * @module dsh-provider-quota/usage
 */

/** OpenAI endpoint used by the current first-party Codex client. */
export const OPENAI_CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/**
 * Undocumented OpenCode Go API base (endpoint discovered by cc-switch#6433).
 *
 * A BASE, not a URL: {@link fetchOpencodeUsage} appends `/usage` to it, and
 * the same append runs on a `baseURL` read from the route's own settings. The
 * two have to agree on where the version segment lives, and this value carries
 * `/v1`. The installed pi-ai catalog is NOT uniform about it: the twelve
 * openai-completions models and the one openai-responses model carry
 * `.../zen/go/v1`, while the three anthropic-messages models carry
 * `.../zen/go` — that SDK appends `/v1/messages` itself. The quota read uses
 * this constant or the route's configured `baseURL`, never the model's own,
 * so the split does not reach it today. Configure the route with a base that
 * stops short of the version segment and the read goes to a path that does
 * not exist.
 */
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

/**
 * Static `x-opencode-session` for the quota read.
 *
 * The OpenCode gateway errors on requests without this header from
 * 2026-09-05. It asks for a stable id per conversation; a quota poll is not a
 * conversation, so a deployment-fixed id is all this read can honestly send —
 * it satisfies presence, not routing. Deliberately NOT the id the model route
 * sends, so poller traffic and inference traffic stay separable upstream.
 */
const OPENCODE_SESSION_ID = 'd8666b3e-6cd6-47d3-bec4-182b5c3513a5'

/**
 * DeepSeek's API root, where its official balance endpoint lives. Not the
 * route's default `baseURL`: the harness defaults that to the Messages mount
 * below this root (see {@link deepseekApiRoot}).
 */
export const DEEPSEEK_PUBLIC_BASE_URL = 'https://api.deepseek.com'

/** The Messages mount under a DeepSeek API root, with the `/v1` the harness reuses rather than doubles. */
const DEEPSEEK_MESSAGES_MOUNT = /\/anthropic(?:\/v1)?\/*$/u

/**
 * The DeepSeek API root a route's base hangs off.
 *
 * Since dsh 0.1.7-alpha.1 the harness reads the DeepSeek route's `baseURL`,
 * and `DEEPSEEK_BASE_URL`, as the root its Messages requests are built on —
 * officially `https://api.deepseek.com/anthropic` — and the balance endpoint
 * is not under that mount; it sits at the API root above it. So the mount
 * comes off before {@link fetchDeepSeekBalance} appends its suffix. Any other
 * path is a gateway whose layout this plugin cannot know, and it is used as
 * written. The origin never changes either way, so the key still goes only
 * where the route itself is configured to send it.
 * @param {string} base - an absolute http(s) base without a trailing slash.
 * @returns {string} the base the balance suffix is appended to.
 */
export function deepseekApiRoot(base) {
  var url = new URL(base)
  if (url.search !== '' || url.hash !== '' || !DEEPSEEK_MESSAGES_MOUNT.test(url.pathname)) return base
  url.pathname = url.pathname.replace(DEEPSEEK_MESSAGES_MOUNT, '')
  return url.href.replace(/\/+$/u, '')
}

/**
 * Harness Connection channel and method the browser chip calls. The channel is
 * Connection's shared `/api`, where the Host mounts the method as an exact
 * Fetch route (see `./rpc-route.js`); the method carries the package name
 * because `/api` is one namespace for every plugin.
 */
export const OPENAI_CODEX_USAGE_CHANNEL = '/api'
export const OPENAI_CODEX_USAGE_METHOD = 'dsh-provider-quota.usage'
const FIVE_HOUR_SECONDS = 5 * 60 * 60
const WEEK_SECONDS = 7 * 24 * 60 * 60
const WINDOW_TOLERANCE = 0.05
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Every credentialed request here refuses redirects outright.
 *
 * A cross-origin redirect drops `Authorization` — the fetch spec says so and
 * undici obeys — but nothing drops a CUSTOM header, so the `x-api-key` the
 * OpenCode gateway wants would be replayed verbatim at whatever origin the
 * redirect names, and so would the Codex account id. Following buys nothing
 * in exchange: all three endpoints are fixed paths under a base the operator
 * configured, so a redirect is either a misconfiguration or an attempt to
 * move the credential somewhere else, and refusing is the right answer to
 * both. The refusal surfaces as a `network` failure, which is what it is.
 */
const REDIRECT_POLICY = 'error'
const DEFAULT_CACHE_TTL_MS = 30_000
const DEFAULT_FORCE_MIN_INTERVAL_MS = 5_000

/** Stable, secret-free failure returned by the usage boundary. */
export class CodexUsageError extends Error {
  /**
   * @param {string} code - browser-facing failure code.
   * @param {string} message - host diagnostic containing no credential material.
   * @param {number} [status=502] - internal failure class retained for non-RPC callers.
   */
  constructor(code, message, status = 502) {
    super(message)
    this.name = 'CodexUsageError'
    this.code = code
    this.status = status
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @returns {number|undefined} */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** @param {number} value @returns {number} */
function clampPercent(value) {
  return Math.min(100, Math.max(0, value))
}

/**
 * Normalize one private-API rate-limit window without assuming its slot.
 * @param {unknown} value - upstream window.
 * @param {number} nowMs - wall clock used only for reset-after fallback.
 * @returns {{usedPercent: number, remainingPercent: number, windowSeconds: number, resetsAt: number}|undefined}
 */
export function normalizeCodexWindow(value, nowMs = Date.now()) {
  if (!isRecord(value)) return undefined
  const used = finiteNumber(value.used_percent)
  const duration = finiteNumber(value.limit_window_seconds)
  if (used === undefined || duration === undefined || duration <= 0) return undefined
  const resetAt = finiteNumber(value.reset_at)
  const resetAfter = finiteNumber(value.reset_after_seconds)
  const resetsAt = resetAt !== undefined && resetAt > 0
    ? resetAt
    : resetAfter !== undefined && resetAfter >= 0
      ? Math.floor(nowMs / 1000 + resetAfter)
      : undefined
  if (resetsAt === undefined) return undefined
  const usedPercent = clampPercent(used)
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowSeconds: duration,
    resetsAt,
  }
}

/**
 * Classify one window duration against the two window kinds current Codex
 * accounts carry, within {@link WINDOW_TOLERANCE}: the rolling five-hour
 * window and the weekly allowance.
 * @param {number} seconds @returns {'5h'|'7d'|undefined}
 */
function codexWindowId(seconds) {
  if (seconds >= FIVE_HOUR_SECONDS * (1 - WINDOW_TOLERANCE)
    && seconds <= FIVE_HOUR_SECONDS * (1 + WINDOW_TOLERANCE)) return '5h'
  if (seconds >= WEEK_SECONDS * (1 - WINDOW_TOLERANCE)
    && seconds <= WEEK_SECONDS * (1 + WINDOW_TOLERANCE)) return '7d'
  return undefined
}

/**
 * Reduce the private usage payload to the windows the card displays — the
 * rolling five-hour window and the weekly allowance — with `weekly` kept as
 * an alias for callers that predate the second window.
 * @param {unknown} payload - decoded upstream JSON.
 * @param {number} [nowMs] - wall clock for reset-after fallback and fetchedAt.
 * @returns {{planType?: string, allowed?: boolean, limitReached?: boolean, fiveHour: ReturnType<typeof normalizeCodexWindow>|null, weekly: ReturnType<typeof normalizeCodexWindow>|null, fetchedAt: string}}
 */
export function normalizeOpenAICodexUsage(payload, nowMs = Date.now()) {
  if (!isRecord(payload)) {
    throw new CodexUsageError('invalid-response', 'OpenAI Codex usage response is not an object')
  }
  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : undefined
  const candidates = [
    normalizeCodexWindow(rateLimit?.primary_window, nowMs),
    normalizeCodexWindow(rateLimit?.secondary_window, nowMs),
  ]
  let fiveHour = null
  let weekly = null
  for (const window of candidates) {
    // First recognized occurrence wins per kind: the same window in both
    // slots is one quota, not two rows.
    const id = window === undefined ? undefined : codexWindowId(window.windowSeconds)
    if (id === '5h' && fiveHour === null) fiveHour = window
    if (id === '7d' && weekly === null) weekly = window
  }
  return {
    ...(typeof payload.plan_type === 'string' ? { planType: payload.plan_type } : {}),
    ...(typeof rateLimit?.allowed === 'boolean' ? { allowed: rateLimit.allowed } : {}),
    ...(typeof rateLimit?.limit_reached === 'boolean' ? { limitReached: rateLimit.limit_reached } : {}),
    fiveHour,
    weekly,
    fetchedAt: new Date(nowMs).toISOString(),
  }
}

/** @param {unknown} error @returns {CodexUsageError} */
function credentialError(error) {
  if (error instanceof CodexUsageError) return error
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
  if (code === 'MISSING_CREDENTIAL') {
    return new CodexUsageError('signed-out', 'OpenAI Codex is not signed in', 401)
  }
  if (code === 'AUTH') {
    return new CodexUsageError('auth', 'OpenAI Codex authentication failed', 401)
  }
  if (code === 'TIMEOUT') {
    return new CodexUsageError('timeout', 'OpenAI Codex credential resolution timed out', 504)
  }
  return new CodexUsageError('credential', 'OpenAI Codex credential resolution failed', 502)
}

/** @returns {CodexUsageError} stable cancellation failure. */
function usageAborted() {
  return new CodexUsageError('aborted', 'OpenAI Codex usage request was cancelled', 499)
}

/** @param {AbortSignal|undefined} signal */
function throwIfUsageAborted(signal) {
  if (signal?.aborted) throw usageAborted()
}

/**
 * Fetch and normalize Codex subscription usage in the host process.
 * @param {{
 *   resolveAccessToken: () => Promise<string>,
 *   readCredential: () => Promise<Record<string, unknown>|undefined>,
 *   fetch?: typeof globalThis.fetch,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   endpoint?: string,
 *   signal?: AbortSignal,
 * }} options - injected credential/network dependencies.
 */
export async function fetchOpenAICodexUsage(options) {
  const now = options.now ?? Date.now
  throwIfUsageAborted(options.signal)
  let accessToken
  let credential
  try {
    accessToken = await options.resolveAccessToken()
    throwIfUsageAborted(options.signal)
    credential = await options.readCredential()
    throwIfUsageAborted(options.signal)
  } catch (error) {
    if (error instanceof CodexUsageError) throw error
    throw credentialError(error)
  }
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new CodexUsageError('signed-out', 'OpenAI Codex is not signed in', 401)
  }
  const accountId = isRecord(credential)
    ? typeof credential.accountId === 'string' && credential.accountId.length > 0
      ? credential.accountId
      : typeof credential.account_id === 'string' && credential.account_id.length > 0
        ? credential.account_id
        : undefined
    : undefined
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new CodexUsageError('unavailable', 'This host has no fetch implementation')
  }
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'dsh-provider-quota',
    ...(accountId === undefined ? {} : { 'ChatGPT-Account-Id': accountId }),
  }
  let response
  try {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    response = await fetchImpl(options.endpoint ?? OPENAI_CODEX_USAGE_URL, {
      method: 'GET',
      headers,
      redirect: REDIRECT_POLICY,
      signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw usageAborted()
    const timedOut = isRecord(error) && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new CodexUsageError(
      timedOut ? 'timeout' : 'network',
      timedOut ? 'OpenAI Codex usage request timed out' : 'OpenAI Codex usage request failed',
      timedOut ? 504 : 502,
    )
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CodexUsageError('auth', `OpenAI Codex usage endpoint rejected authentication (HTTP ${response.status})`, 401)
    }
    if (response.status === 429) {
      throw new CodexUsageError('rate-limited', 'OpenAI Codex usage endpoint is rate limited', 429)
    }
    throw new CodexUsageError('upstream', `OpenAI Codex usage endpoint failed (HTTP ${response.status})`, 502)
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    if (options.signal?.aborted) throw usageAborted()
    throw new CodexUsageError('invalid-response', 'OpenAI Codex usage endpoint did not return JSON')
  }
  throwIfUsageAborted(options.signal)
  return normalizeOpenAICodexUsage(payload, now())
}

/** @param {unknown} credential @returns {string} process-local cache identity, never published or logged. */
function credentialCacheIdentity(credential) {
  if (!isRecord(credential)) return 'signed-out'
  const accountId = typeof credential.accountId === 'string' && credential.accountId.length > 0
    ? credential.accountId
    : typeof credential.account_id === 'string' && credential.account_id.length > 0
      ? credential.account_id
      : undefined
  if (accountId !== undefined) return `account:${accountId}`
  return typeof credential.access === 'string' && credential.access.length > 0
    ? `access:${credential.access}`
    : 'signed-out'
}

/**
 * Observe one shared read. It is cancelled only after every attached caller has
 * left, so one closing tab cannot abort another tab's coalesced quota read.
 * @param {{promise: Promise<object>, controller: AbortController, waiters: Set<object>, settled: boolean}} entry
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<object>}
 */
function observeUsageRequest(entry, signal) {
  const waiter = {}
  entry.waiters.add(waiter)
  return new Promise((resolve, reject) => {
    let done = false
    const settle = (finish, value) => {
      if (done) return
      done = true
      signal?.removeEventListener('abort', onAbort)
      entry.waiters.delete(waiter)
      finish(value)
    }
    const onAbort = () => {
      settle(reject, usageAborted())
      if (!entry.settled && entry.waiters.size === 0) entry.controller.abort()
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    entry.promise.then(
      value => settle(resolve, value),
      error => settle(reject, error),
    )
  })
}

/**
 * Add account-scoped normalized caching, request coalescing, a minimum forced
 * refresh interval, and reference-counted cancellation around the upstream
 * read. The cache identity stays process-local and is discarded when the
 * stored account changes.
 * @param {Parameters<typeof fetchOpenAICodexUsage>[0] & {cacheTtlMs?: number, forceMinIntervalMs?: number}} options - fetch dependencies and cache policy.
 * @returns {{get(force?: boolean, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof fetchOpenAICodexUsage>>>}}
 */
export function createOpenAICodexUsageService(options) {
  const now = options.now ?? Date.now
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const forceMinInterval = options.forceMinIntervalMs ?? DEFAULT_FORCE_MIN_INTERVAL_MS
  let activeIdentity
  let generation = 0
  let cached
  let cachedAt = 0
  let lastAttemptAt = 0
  const inflight = new Map()
  return {
    async get(force = false, signal) {
      throwIfUsageAborted(signal)
      let credential
      try {
        credential = await options.readCredential()
        throwIfUsageAborted(signal)
      } catch (error) {
        if (error instanceof CodexUsageError) throw error
        throw credentialError(error)
      }
      const identity = credentialCacheIdentity(credential)
      if (identity !== activeIdentity) {
        activeIdentity = identity
        generation++
        cached = undefined
        cachedAt = 0
        lastAttemptAt = 0
      }
      const at = now()
      const joined = inflight.get(identity)
      if (joined !== undefined && !joined.controller.signal.aborted) {
        return observeUsageRequest(joined, signal)
      }
      if (joined !== undefined) inflight.delete(identity)
      if (cached !== undefined) {
        if (!force && at - cachedAt < ttl) return cached
        if (force && at - lastAttemptAt < forceMinInterval) return cached
      } else if (force && lastAttemptAt !== 0 && at - lastAttemptAt < forceMinInterval) {
        throw new CodexUsageError('refresh-throttled', 'OpenAI Codex usage refresh is cooling down', 429)
      }
      const startedGeneration = generation
      lastAttemptAt = at
      const entry = {
        controller: new AbortController(),
        waiters: new Set(),
        settled: false,
        promise: undefined,
      }
      entry.promise = fetchOpenAICodexUsage({ ...options, signal: entry.controller.signal }).then((value) => {
        if (generation === startedGeneration && activeIdentity === identity) {
          cached = value
          cachedAt = now()
        }
        return value
      }).finally(() => {
        entry.settled = true
        if (inflight.get(identity) === entry) inflight.delete(identity)
      })
      inflight.set(identity, entry)
      return observeUsageRequest(entry, signal)
    },
  }
}

/** @param {unknown} error @returns {string} */
function publicFailureCode(error) {
  if (error instanceof CodexUsageError) return error.code
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
  if (code === 'MISSING_CREDENTIAL') return 'signed-out'
  if (code === 'AUTH') return 'auth'
  if (code === 'TIMEOUT') return 'timeout'
  return 'unavailable'
}

/** @param {unknown} payload @returns {payload is {force?: boolean}} */
function isUsageRequest(payload) {
  if (!isRecord(payload) || Object.keys(payload).some(key => key !== 'force')) return false
  return payload.force === undefined || typeof payload.force === 'boolean'
}

/**
 * Build the Handler registered on Harness Connection RPC. Connection owns the
 * Host/Origin/fetch-site trust fence before this function can run.
 * @param {{get(force?: boolean, signal?: AbortSignal): Promise<object>}} service - normalized usage service.
 * @returns {(endpoint: string, payload: unknown, signal: AbortSignal) => Promise<object>}
 */
export function createOpenAICodexUsageRpc(service) {
  return async (endpoint, payload, signal) => {
    if (endpoint !== OPENAI_CODEX_USAGE_METHOD) {
      return { ok: false, error: { code: 'method-not-found', message: 'Unknown Codex usage method', details: {} } }
    }
    if (!isUsageRequest(payload)) {
      return { ok: false, error: { code: 'invalid-request', message: 'Invalid Codex usage request', details: {} } }
    }
    if (signal.aborted) {
      return { ok: false, error: { code: 'aborted', message: 'Codex usage request was cancelled', details: {} } }
    }
    try {
      return { ok: true, value: await service.get(payload.force === true, signal) }
    } catch (error) {
      return { ok: false, error: { code: publicFailureCode(error), message: 'Codex usage unavailable', details: {} } }
    }
  }
}

// ── provider-generic usage boundary ─────────────────────────────────────────
// The three providers below answer the same question — how much of the current
// account's allowance is left — with three different upstream shapes, and the
// browser gets one strict, secret-free union back. Every credential stays in
// this process: the RPC result carries provider, windows or balances, and a
// fetch timestamp, and nothing else.

/** @param {string} value @returns {string} non-cryptographic, process-local identity hash. */
function hashSecret(value) {
  var hash = 0x811c9dc5
  for (var index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** @param {unknown} value @returns {number|undefined} a finite number, from a number or numeric string. */
function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    var parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** @param {string} value @returns {number|undefined} seconds from an ISO timestamp. */
function isoSeconds(value) {
  var parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined
}

/** The browser-facing ids the OpenCode windows normalize to. */
const OPENCODE_WINDOW_IDS = ['5h', '7d', '1m']

/**
 * Normalize the OpenCode Go usage payload: rolling (5h), weekly (7d) and
 * monthly (1m) windows, upstream reporting the used percentage. Windows the
 * payload does not carry are omitted rather than invented.
 * @param {unknown} payload - decoded upstream JSON.
 * @param {number} [nowMs] - wall clock for fetchedAt.
 * @returns {{kind: 'windows', windows: {id: string, usedPercent: number, remainingPercent: number, resetsAt?: number}[], fetchedAt: string}}
 */
export function normalizeOpencodeGoUsage(payload, nowMs = Date.now()) {
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    throw new CodexUsageError('invalid-response', 'OpenCode Go usage response has no usage object')
  }
  var usage = payload.usage
  var windows = []
  for (var index = 0; index < OPENCODE_WINDOW_IDS.length; index++) {
    var id = OPENCODE_WINDOW_IDS[index]
    var key = id === '5h' ? 'rolling' : id === '7d' ? 'weekly' : 'monthly'
    var window = usage[key]
    if (!isRecord(window)) continue
    var used = numericValue(window.percent)
    if (used === undefined) continue
    var remaining = clampPercent(100 - used)
    var resetsAt = typeof window.resetsAt === 'string' ? isoSeconds(window.resetsAt) : undefined
    windows.push({
      id,
      usedPercent: clampPercent(used),
      remainingPercent: remaining,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    })
  }
  if (windows.length === 0) {
    throw new CodexUsageError('invalid-response', 'OpenCode Go usage response carried no windows')
  }
  return { kind: 'windows', windows, fetchedAt: new Date(nowMs).toISOString() }
}

/**
 * Normalize the official DeepSeek balance payload. Amounts stay the decimal
 * strings the API reports, so no float rounding ever touches a displayed sum.
 * @param {unknown} payload - decoded upstream JSON.
 * @param {number} [nowMs] - wall clock for fetchedAt.
 * @returns {{kind: 'balance', isAvailable: boolean, balances: {currency?: string, totalBalance: string, grantedBalance?: string, toppedUpBalance?: string}[], fetchedAt: string}}
 */
export function normalizeDeepSeekBalance(payload, nowMs = Date.now()) {
  if (!isRecord(payload) || !Array.isArray(payload.balance_infos)) {
    throw new CodexUsageError('invalid-response', 'DeepSeek balance response has no balance_infos')
  }
  var balances = []
  for (var index = 0; index < payload.balance_infos.length; index++) {
    var info = payload.balance_infos[index]
    if (!isRecord(info) || typeof info.total_balance !== 'string') continue
    balances.push({
      ...(typeof info.currency === 'string' ? { currency: info.currency } : {}),
      totalBalance: info.total_balance,
      ...(typeof info.granted_balance === 'string' ? { grantedBalance: info.granted_balance } : {}),
      ...(typeof info.topped_up_balance === 'string' ? { toppedUpBalance: info.topped_up_balance } : {}),
    })
  }
  return {
    kind: 'balance',
    isAvailable: typeof payload.is_available === 'boolean' ? payload.is_available : true,
    balances,
    fetchedAt: new Date(nowMs).toISOString(),
  }
}

/** @param {unknown} scheme @returns {boolean} whether an endpoint is an absolute http(s) URL. */
function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//u.test(value)
}

/**
 * Fetch and normalize the OpenCode Go usage payload. The endpoint is built by
 * the caller from the route's own baseURL plus the fixed /usage suffix, so the
 * API key only ever travels to the origin the model route itself is configured
 * against.
 * @param {{endpoint: string, apiKey: string, fetch?: typeof globalThis.fetch, now?: () => number, timeoutMs?: number, signal?: AbortSignal}} options
 */
export async function fetchOpencodeUsage(options) {
  throwIfUsageAborted(options.signal)
  if (!isHttpUrl(options.endpoint)) {
    throw new CodexUsageError('invalid-response', 'OpenCode Go usage endpoint is not an absolute URL')
  }
  var fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new CodexUsageError('unavailable', 'This host has no fetch implementation')
  var response
  try {
    var timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    var signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    response = await fetchImpl(options.endpoint + '/usage', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + options.apiKey,
        'x-api-key': options.apiKey,
        'x-opencode-session': OPENCODE_SESSION_ID,
        // The gateway rejects recognizable CLI agents; present as a browser.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      redirect: REDIRECT_POLICY,
      signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw usageAborted()
    var timedOut = isRecord(error) && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new CodexUsageError(timedOut ? 'timeout' : 'network', 'OpenCode Go usage request failed', timedOut ? 504 : 502)
  }
  if (!response.ok) {
    if (response.status === 401) throw new CodexUsageError('auth', 'OpenCode Go usage endpoint rejected the API key', 401)
    if (response.status === 403) throw new CodexUsageError('no-subscription', 'OpenCode Go API key has no Go subscription', 403)
    if (response.status === 429) throw new CodexUsageError('rate-limited', 'OpenCode Go usage endpoint is rate limited', 429)
    if (response.status === 404) throw new CodexUsageError('unavailable', 'OpenCode Go usage endpoint is unavailable', 404)
    throw new CodexUsageError('upstream', 'OpenCode Go usage endpoint failed (HTTP ' + response.status + ')', 502)
  }
  var payload
  try {
    payload = await response.json()
  } catch {
    if (options.signal?.aborted) throw usageAborted()
    throw new CodexUsageError('invalid-response', 'OpenCode Go usage endpoint did not return JSON')
  }
  throwIfUsageAborted(options.signal)
  return normalizeOpencodeGoUsage(payload, (options.now ?? Date.now)())
}

/**
 * Fetch and normalize the official DeepSeek balance payload: the fixed
 * /user/balance suffix on the API root of the route's own base.
 * @param {{endpoint: string, apiKey: string, fetch?: typeof globalThis.fetch, now?: () => number, timeoutMs?: number, signal?: AbortSignal}} options - `endpoint` is the route's base, Messages mount and all.
 */
export async function fetchDeepSeekBalance(options) {
  throwIfUsageAborted(options.signal)
  if (!isHttpUrl(options.endpoint)) {
    throw new CodexUsageError('invalid-response', 'DeepSeek balance endpoint is not an absolute URL')
  }
  var fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new CodexUsageError('unavailable', 'This host has no fetch implementation')
  var response
  try {
    var timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    var signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    response = await fetchImpl(deepseekApiRoot(options.endpoint) + '/user/balance', {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + options.apiKey },
      redirect: REDIRECT_POLICY,
      signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw usageAborted()
    var timedOut = isRecord(error) && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new CodexUsageError(timedOut ? 'timeout' : 'network', 'DeepSeek balance request failed', timedOut ? 504 : 502)
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CodexUsageError('auth', 'DeepSeek balance endpoint rejected the API key', 401)
    }
    if (response.status === 429) throw new CodexUsageError('rate-limited', 'DeepSeek balance endpoint is rate limited', 429)
    throw new CodexUsageError('upstream', 'DeepSeek balance endpoint failed (HTTP ' + response.status + ')', 502)
  }
  var payload
  try {
    payload = await response.json()
  } catch {
    if (options.signal?.aborted) throw usageAborted()
    throw new CodexUsageError('invalid-response', 'DeepSeek balance endpoint did not return JSON')
  }
  throwIfUsageAborted(options.signal)
  return normalizeDeepSeekBalance(payload, (options.now ?? Date.now)())
}

/**
 * One API-key provider's cache row: same semantics as the Codex service —
 * endpoint-plus-key identity, TTL, forced-refresh floor, in-flight coalescing
 * and reference-counted cancellation — but the identity comes from the key's
 * hash instead of an OAuth credential record.
 * @param {{fetchOne: (route: object, signal: AbortSignal) => Promise<object>, now: () => number, cacheTtlMs: number, forceMinIntervalMs: number}} options
 */
function createKeyedUsageCache(options) {
  var identity
  var generation = 0
  var cached
  var cachedAt = 0
  var lastAttemptAt = 0
  var inflight
  return {
    async get(route, force, signal) {
      throwIfUsageAborted(signal)
      var nextIdentity = route.endpoint + '|' + hashSecret(route.apiKey)
      if (nextIdentity !== identity) {
        identity = nextIdentity
        generation++
        cached = undefined
        cachedAt = 0
        lastAttemptAt = 0
        // The in-flight read belongs to the identity that started it. Leaving
        // it attached lets the coalescing below hand its answer to whoever
        // arrives next, which after a key rotation is a different account
        // reading the previous one's numbers. Detached, not aborted: the
        // caller already waiting on it still gets the answer it asked for.
        inflight = undefined
      }
      var at = options.now()
      var joined = inflight
      if (joined !== undefined && !joined.controller.signal.aborted) {
        return observeUsageRequest(joined, signal)
      }
      if (joined !== undefined) inflight = undefined
      if (cached !== undefined) {
        if (!force && at - cachedAt < options.cacheTtlMs) return cached
        if (force && at - lastAttemptAt < options.forceMinIntervalMs) return cached
      } else if (force && lastAttemptAt !== 0 && at - lastAttemptAt < options.forceMinIntervalMs) {
        throw new CodexUsageError('refresh-throttled', 'usage refresh is cooling down', 429)
      }
      var startedGeneration = generation
      lastAttemptAt = at
      var entry = { controller: new AbortController(), waiters: new Set(), settled: false, promise: undefined }
      entry.promise = options.fetchOne(route, entry.controller.signal).then(function (value) {
        if (generation === startedGeneration) {
          cached = value
          cachedAt = options.now()
        }
        return value
      }).finally(function () {
        entry.settled = true
        if (inflight === entry) inflight = undefined
      })
      inflight = entry
      return observeUsageRequest(entry, signal)
    },
  }
}

/**
 * One cache row per provider route, so switching models can never serve one
 * account's cached number to another provider. The Codex row delegates to the
 * OAuth service above; the API-key rows use {@link createKeyedUsageCache}.
 * @param {{
 *   resolveRoute: (provider: string) => Promise<{kind: string, endpoint?: string, apiKey?: string}|undefined>,
 *   codex: {resolveAccessToken: () => Promise<string>, readCredential: () => Promise<Record<string, unknown>|undefined>},
 *   fetch?: typeof globalThis.fetch,
 *   now?: () => number,
 *   cacheTtlMs?: number,
 *   forceMinIntervalMs?: number,
 * }} options - route resolver and per-kind dependencies.
 * @returns {{get(provider?: string, force?: boolean, signal?: AbortSignal): Promise<object>}}
 */
export function createProviderUsageService(options) {
  var now = options.now ?? Date.now
  var ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  var forceMinInterval = options.forceMinIntervalMs ?? DEFAULT_FORCE_MIN_INTERVAL_MS
  var codex = createOpenAICodexUsageService({
    ...options.codex,
    // A top-level fetch override wins; without one, the codex half keeps its
    // own injected fetch rather than silently falling back to the real one.
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    now,
    cacheTtlMs: ttl,
    forceMinIntervalMs: forceMinInterval,
  })
  // One upstream fetch per route kind; the API key and endpoint arrive with
  // the resolved route and never travel anywhere but that route's origin.
  function fetchOne(route, signal) {
    if (route.kind === 'opencode') {
      return fetchOpencodeUsage({ endpoint: route.endpoint, apiKey: route.apiKey, fetch: options.fetch, now, signal })
    }
    return fetchDeepSeekBalance({ endpoint: route.endpoint, apiKey: route.apiKey, fetch: options.fetch, now, signal })
  }
  var perProvider = new Map()
  function cacheFor(provider) {
    var row = perProvider.get(provider)
    if (row === undefined) {
      row = createKeyedUsageCache({ now, cacheTtlMs: ttl, forceMinIntervalMs: forceMinInterval, fetchOne })
      perProvider.set(provider, row)
    }
    return row
  }
  return {
    async get(provider, force, signal) {
      throwIfUsageAborted(signal)
      var route = await options.resolveRoute(provider)
      throwIfUsageAborted(signal)
      if (route === undefined) return { kind: 'none', provider }
      if (route.kind === 'codex') {
        var codexValue = await codex.get(force === true, signal)
        var codexWindows = []
        // Fixed order — rolling first, weekly second — so the chip reads the
        // same sequence regardless of which upstream slot carried which.
        if (codexValue.fiveHour !== null) codexWindows.push({
          id: '5h',
          usedPercent: codexValue.fiveHour.usedPercent,
          remainingPercent: codexValue.fiveHour.remainingPercent,
          resetsAt: codexValue.fiveHour.resetsAt,
        })
        if (codexValue.weekly !== null) codexWindows.push({
          id: '7d',
          usedPercent: codexValue.weekly.usedPercent,
          remainingPercent: codexValue.weekly.remainingPercent,
          resetsAt: codexValue.weekly.resetsAt,
        })
        return {
          kind: 'windows',
          provider,
          windows: codexWindows,
          ...(codexValue.planType === undefined ? {} : { planType: codexValue.planType }),
          fetchedAt: codexValue.fetchedAt,
        }
      }
      var value = await cacheFor(provider).get(route, force === true, signal)
      return { ...value, provider }
    },
  }
}

/**
 * The strict usage request payload: the route to read and an optional force
 * flag, and nothing else.
 *
 * The provider is required. Omitting it once meant "a page loaded before the
 * chip knew three routes", answered in the codex-only shape that page read.
 * Every such page calls the channel served before 0.7.0, which is no longer
 * registered, so nothing that reaches this Handler can mean that any more.
 * @param {unknown} payload - decoded RPC payload.
 * @returns {payload is {provider: string, force?: boolean}} whether it is answerable.
 */
function isProviderUsageRequest(payload) {
  if (!isRecord(payload) || Object.keys(payload).some(function (key) { return key !== 'provider' && key !== 'force' })) return false
  if (typeof payload.provider !== 'string' || payload.provider.length === 0 || payload.provider.length > 64
    || !/^[a-z0-9.-]+$/u.test(payload.provider)) return false
  return payload.force === undefined || typeof payload.force === 'boolean'
}

/**
 * Build the provider-aware Handler for Harness Connection RPC. Connection owns
 * the Host/Origin/fetch-site trust fence before this function can run.
 * @param {{get(provider?: string, force?: boolean, signal?: AbortSignal): Promise<object>}} service
 * @returns {(endpoint: string, payload: unknown, signal: AbortSignal) => Promise<object>}
 */
export function createProviderUsageRpc(service) {
  return async (endpoint, payload, signal) => {
    if (endpoint !== OPENAI_CODEX_USAGE_METHOD) {
      return { ok: false, error: { code: 'method-not-found', message: 'Unknown usage method', details: {} } }
    }
    if (!isProviderUsageRequest(payload)) {
      return { ok: false, error: { code: 'invalid-request', message: 'Invalid usage request', details: {} } }
    }
    if (signal.aborted) {
      return { ok: false, error: { code: 'aborted', message: 'usage request was cancelled', details: {} } }
    }
    try {
      return { ok: true, value: await service.get(payload.provider, payload.force === true, signal) }
    } catch (error) {
      return { ok: false, error: { code: publicFailureCode(error), message: 'usage unavailable', details: {} } }
    }
  }
}
