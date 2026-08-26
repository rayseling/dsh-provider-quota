/** Unit coverage for the private Codex usage boundary. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  CodexUsageError,
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
  DEEPSEEK_PUBLIC_BASE_URL,
  OPENAI_CODEX_USAGE_URL,
  OPENCODE_GO_BASE_URL,
} from '../src/usage.js'

const NOW = Date.parse('2026-08-20T12:00:00Z')
const WEEK = 7 * 24 * 60 * 60
const FIVE_HOURS = 5 * 60 * 60

function window(used, seconds, resetAt = 1_788_134_407) {
  return {
    used_percent: used,
    limit_window_seconds: seconds,
    reset_after_seconds: 60,
    reset_at: resetAt,
  }
}

function payload(primary, secondary) {
  return {
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: primary,
      secondary_window: secondary,
    },
  }
}

describe('usage normalization', () => {
  test('finds a primary-only weekly window, as current Codex accounts can return', () => {
    const usage = normalizeOpenAICodexUsage(payload(window(3, WEEK), null), NOW)
    assert.deepEqual(usage, {
      planType: 'plus',
      allowed: true,
      limitReached: false,
      fiveHour: null,
      weekly: { usedPercent: 3, remainingPercent: 97, windowSeconds: WEEK, resetsAt: 1_788_134_407 },
      fetchedAt: '2026-08-20T12:00:00.000Z',
    })
  })

  test('classifies by duration and collects both windows without assuming slots', () => {
    const usage = normalizeOpenAICodexUsage(payload(window(15, FIVE_HOURS), window(42, WEEK)), NOW)
    assert.equal(usage.fiveHour.usedPercent, 15)
    assert.equal(usage.weekly.usedPercent, 42)
    const swapped = normalizeOpenAICodexUsage(payload(window(9, WEEK), window(15, FIVE_HOURS)), NOW)
    assert.equal(swapped.fiveHour.usedPercent, 15, 'the rolling window follows its duration, not its slot')
    assert.equal(swapped.weekly.usedPercent, 9)
    const duplicated = normalizeOpenAICodexUsage(payload(window(9, WEEK), window(42, WEEK)), NOW)
    assert.equal(duplicated.weekly.usedPercent, 9, 'the same window in both slots is one quota, not two')
    const primaryWeekly = normalizeOpenAICodexUsage(payload(window(9, WEEK), window(60, 24 * 60 * 60)), NOW)
    assert.equal(primaryWeekly.fiveHour, null)
    assert.equal(primaryWeekly.weekly.usedPercent, 9)
  })

  test('tolerates missing optional windows and does not mislabel a daily window', () => {
    const daily = normalizeOpenAICodexUsage(payload(window(7, 24 * 60 * 60), null), NOW)
    assert.equal(daily.fiveHour, null)
    assert.equal(daily.weekly, null)
    const empty = normalizeOpenAICodexUsage({ plan_type: 'free', rate_limit: null }, NOW)
    assert.equal(empty.fiveHour, null)
    assert.equal(empty.weekly, null)
  })

  test('clamps percentages and derives reset time only when reset_at is absent', () => {
    const usage = normalizeOpenAICodexUsage(payload({
      used_percent: 120,
      limit_window_seconds: WEEK,
      reset_after_seconds: 90,
    }, null), NOW)
    assert.equal(usage.fiveHour, null)
    assert.deepEqual(usage.weekly, {
      usedPercent: 100,
      remainingPercent: 0,
      windowSeconds: WEEK,
      resetsAt: Math.floor(NOW / 1000) + 90,
    })
  })
})

describe('host-side usage fetch', () => {
  test('sends OAuth only upstream and returns no credential material', async () => {
    let request
    const usage = await fetchOpenAICodexUsage({
      resolveAccessToken: async () => 'access_MUST_STAY_HOST_SIDE',
      readCredential: async () => ({ accountId: 'acc_workspace' }),
      now: () => NOW,
      fetch: async (url, options) => {
        request = { url, options }
        return new Response(JSON.stringify(payload(window(3, WEEK), null)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    assert.equal(request.url, OPENAI_CODEX_USAGE_URL)
    assert.equal(request.options.headers.Authorization, 'Bearer access_MUST_STAY_HOST_SIDE')
    assert.equal(request.options.headers['ChatGPT-Account-Id'], 'acc_workspace')
    assert.doesNotMatch(JSON.stringify(usage), /access_MUST|acc_workspace/u)
  })

  test('maps sign-out and upstream failures to stable secret-free errors', async () => {
    await assert.rejects(
      fetchOpenAICodexUsage({
        resolveAccessToken: async () => { throw Object.assign(new Error('secret response'), { code: 'MISSING_CREDENTIAL' }) },
        readCredential: async () => undefined,
      }),
      error => error instanceof CodexUsageError && error.code === 'signed-out' && !error.message.includes('secret'),
    )
    await assert.rejects(
      fetchOpenAICodexUsage({
        resolveAccessToken: async () => 'secret-access',
        readCredential: async () => ({}),
        fetch: async () => new Response('refresh_token=secret-body', { status: 503 }),
      }),
      error => error instanceof CodexUsageError && error.code === 'upstream'
        && !error.message.includes('secret-access') && !error.message.includes('secret-body'),
    )
  })
})

describe('OpenCode Go usage normalization', () => {
  const goPayload = (windows) => ({ usage: windows })

  test('turns upstream used percentages into remaining 5h/7d/1m windows', () => {
    const usage = normalizeOpencodeGoUsage(goPayload({
      rolling: { status: 'ok', percent: 10, resetsAt: '2026-08-20T17:00:00.000Z' },
      weekly: { status: 'ok', percent: 20, resetsAt: '2026-08-24T00:00:00.000Z' },
      monthly: { status: 'ok', percent: 30, resetsAt: '2026-09-09T00:41:03.000Z' },
    }), NOW)
    assert.deepEqual(usage, {
      kind: 'windows',
      windows: [
        { id: '5h', usedPercent: 10, remainingPercent: 90, resetsAt: Math.floor(Date.parse('2026-08-20T17:00:00.000Z') / 1000) },
        { id: '7d', usedPercent: 20, remainingPercent: 80, resetsAt: Math.floor(Date.parse('2026-08-24T00:00:00.000Z') / 1000) },
        { id: '1m', usedPercent:30, remainingPercent: 70, resetsAt: Math.floor(Date.parse('2026-09-09T00:41:03.000Z') / 1000) },
      ],
      fetchedAt: '2026-08-20T12:00:00.000Z',
    })
  })

  test('omits windows the payload does not carry and refuses an empty payload', () => {
    const usage = normalizeOpencodeGoUsage(goPayload({ weekly: { percent: '25.5' } }), NOW)
    assert.deepEqual(usage.windows, [{ id: '7d', usedPercent: 25.5, remainingPercent: 74.5 }])
    assert.throws(() => normalizeOpencodeGoUsage({}, NOW), error => error instanceof CodexUsageError && error.code === 'invalid-response')
    assert.throws(() => normalizeOpencodeGoUsage(goPayload({ rolling: { percent: 'nope' } }), NOW), error => error.code === 'invalid-response')
  })

  test('clamps absurd upstream percentages', () => {
    const usage = normalizeOpencodeGoUsage(goPayload({ rolling: { percent: 140 } }), NOW)
    assert.deepEqual(usage.windows[0], { id: '5h', usedPercent: 100, remainingPercent: 0 })
  })
})

describe('DeepSeek balance normalization', () => {
  test('keeps amounts as the decimal strings the API reports', () => {
    const balance = normalizeDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
        { currency: 'USD', total_balance: '15.20' },
      ],
    }, NOW)
    assert.deepEqual(balance, {
      kind: 'balance',
      isAvailable: true,
      balances: [
        { currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00' },
        { currency: 'USD', totalBalance: '15.20' },
      ],
      fetchedAt: '2026-08-20T12:00:00.000Z',
    })
  })

  test('refuses a payload without balance_infos and defaults availability to true', () => {
    assert.throws(() => normalizeDeepSeekBalance({ is_available: false }, NOW), error => error.code === 'invalid-response')
    assert.equal(normalizeDeepSeekBalance({ balance_infos: [] }, NOW).isAvailable, true)
  })
})

describe('shipped bases compose into the endpoints they are meant to reach', () => {
  // The cases below hand `fetch*` a hard-coded endpoint string and then assert
  // the request carried that same string back. That is an assertion about the
  // test's own input: the exported constant is never involved, so deleting the
  // `/v1` segment from it leaves the whole suite green. These three feed the
  // real constants in instead, which is the only way the version segment is
  // pinned to the side it belongs on.
  //
  // Trap 5 in AGENTS.md: each base is a BASE, and each fetch appends a fixed
  // suffix. Move the version segment to the wrong side and the read goes to a
  // path that does not exist — with no error anywhere near the change.

  /**
   * @param {(options: object) => Promise<unknown>} fetcher - the boundary under test.
   * @param {string} endpoint - the shipped base, passed through unmodified.
   * @param {string} body - a payload that normalizes without throwing.
   * @returns {Promise<string>} the URL the boundary actually requested.
   */
  async function requestedUrl(fetcher, endpoint, body) {
    let seen
    await fetcher({
      endpoint,
      apiKey: 'k',
      now: () => NOW,
      fetch: async (url) => {
        seen = String(url)
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    return seen
  }

  test('OPENCODE_GO_BASE_URL keeps the version segment the /usage suffix needs', async () => {
    assert.equal(
      await requestedUrl(fetchOpencodeUsage, OPENCODE_GO_BASE_URL, JSON.stringify({ usage: { rolling: { percent: 1 } } })),
      'https://opencode.ai/zen/go/v1/usage',
    )
  })

  test('DEEPSEEK_PUBLIC_BASE_URL stops short of the version segment its suffix carries', async () => {
    assert.equal(
      await requestedUrl(fetchDeepSeekBalance, DEEPSEEK_PUBLIC_BASE_URL, JSON.stringify({ is_available: true, balance_infos: [] })),
      'https://api.deepseek.com/user/balance',
    )
  })

})

describe('API-key provider fetches', () => {
  test('OpenCode: bearer plus x-api-key upstream, nothing secret in the result', async () => {
    let request
    const usage = await fetchOpencodeUsage({
      endpoint: 'https://opencode.ai/zen/go/v1',
      apiKey: 'sk_MUST_STAY_HOST_SIDE',
      now: () => NOW,
      fetch: async (url, options) => {
        request = { url, options }
        return new Response(JSON.stringify({ usage: { rolling: { percent: 10, resetsAt: '2026-08-20T17:00:00.000Z' } } }), { status: 200 })
      },
    })
    assert.equal(request.url, 'https://opencode.ai/zen/go/v1/usage')
    assert.equal(request.options.headers.Authorization, 'Bearer sk_MUST_STAY_HOST_SIDE')
    assert.equal(request.options.headers['x-api-key'], 'sk_MUST_STAY_HOST_SIDE')
    assert.doesNotMatch(JSON.stringify(usage), /MUST_STAY/u)
  })

  test('OpenCode: 403 means no subscription, 404 means the endpoint moved', async () => {
    await assert.rejects(
      fetchOpencodeUsage({ endpoint: OPENCODE_GO_BASE_URL, apiKey: 'k', fetch: async () => new Response('denied', { status: 403 }) }),
      error => error.code === 'no-subscription',
    )
    await assert.rejects(
      fetchOpencodeUsage({ endpoint: OPENCODE_GO_BASE_URL, apiKey: 'k', fetch: async () => new Response('gone', { status: 404 }) }),
      error => error.code === 'unavailable',
    )
  })

  test('DeepSeek: fixed /user/balance suffix, 401 maps to auth', async () => {
    let request
    const balance = await fetchDeepSeekBalance({
      endpoint: 'https://api.deepseek.com',
      apiKey: 'sk_MUST_STAY_HOST_SIDE',
      now: () => NOW,
      fetch: async (url, options) => {
        request = { url, options }
        return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00' }] }), { status: 200 })
      },
    })
    assert.equal(request.url, 'https://api.deepseek.com/user/balance')
    assert.equal(request.options.headers.Authorization, 'Bearer sk_MUST_STAY_HOST_SIDE')
    assert.doesNotMatch(JSON.stringify(balance), /MUST_STAY/u)
    await assert.rejects(
      fetchDeepSeekBalance({ endpoint: 'https://api.deepseek.com', apiKey: 'k', fetch: async () => new Response('no', { status: 401 }) }),
      error => error.code === 'auth',
    )
  })
})

describe('provider usage service and RPC', () => {
  const codexValue = () => ({
    planType: 'plus',
    allowed: true,
    limitReached: false,
    weekly: { usedPercent: 3, remainingPercent: 97, windowSeconds: WEEK, resetsAt: 1_788_134_407 },
    fetchedAt: '2026-08-20T12:00:00.000Z',
  })

  test('codex answers both 5h and 7d windows; unknown providers answer none', async () => {
    const service = createProviderUsageService({
      resolveRoute: async provider => (provider === 'openai-codex' ? { kind: 'codex' } : undefined),
      codex: {
        resolveAccessToken: async () => 'access',
        readCredential: async () => ({ accountId: 'acc' }),
        fetch: async () => new Response(JSON.stringify(payload(window(12, FIVE_HOURS), window(3, WEEK))), { status: 200 }),
        now: () => NOW,
      },
    })
    const value = await service.get('openai-codex')
    assert.equal(value.kind, 'windows')
    assert.equal(value.provider, 'openai-codex')
    assert.equal(value.planType, 'plus')
    assert.deepEqual(value.windows, [
      { id: '5h', usedPercent: 12, remainingPercent: 88, resetsAt: 1_788_134_407 },
      { id: '7d', usedPercent: 3, remainingPercent: 97, resetsAt: 1_788_134_407 },
    ])
    assert.deepEqual(await service.get('glm-5.3'), { kind: 'none', provider: 'glm-5.3' })
  })

  test('API-key routes keep one cache per provider, keyed by the key identity', async () => {
    const opencodeCalls = []
    const deepseekCalls = []
    const service = createProviderUsageService({
      resolveRoute: async provider => {
        if (provider === 'opencode-go') return { kind: 'opencode', endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'k1' }
        if (provider === 'deepseek-official') return { kind: 'deepseek', endpoint: 'https://api.deepseek.com', apiKey: 'k2' }
        return undefined
      },
      codex: { resolveAccessToken: async () => 'access', readCredential: async () => ({ accountId: 'acc' }) },
      now: () => NOW,
      fetch: async (url) => {
        if (url.includes('/usage')) {
          opencodeCalls.push(url)
          return new Response(JSON.stringify({ usage: { rolling: { percent: 10 } } }), { status: 200 })
        }
        deepseekCalls.push(url)
        return new Response(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }), { status: 200 })
      },
    })
    const first = await service.get('opencode-go')
    const second = await service.get('opencode-go')
    assert.equal(opencodeCalls.length, 1, 'second read comes from the cache')
    assert.equal(first.windows[0].remainingPercent, 90)
    assert.equal(second.windows[0].remainingPercent, 90)
    const balance = await service.get('deepseek-official')
    assert.equal(deepseekCalls.length, 1)
    assert.equal(balance.kind, 'balance')
    assert.equal(balance.balances[0].totalBalance, '1.00')
    const switchedBack = await service.get('opencode-go')
    assert.equal(opencodeCalls.length, 1, 'the other provider never consumed this cache')
    assert.equal(switchedBack.windows[0].remainingPercent, 90)
  })

  test('the RPC validates the provider payload and keeps the legacy shape for stale callers', async () => {
    const service = {
      get: async provider => provider === 'openai-codex'
        ? { kind: 'windows', provider: 'openai-codex', planType: 'plus', windows: [{ id: '7d', usedPercent: 3, remainingPercent: 97, resetsAt: 1_788_134_407 }], fetchedAt: '2026-08-20T12:00:00.000Z' }
        : { kind: 'none', provider },
    }
    const rpc = createProviderUsageRpc(service)
    const signal = new AbortController().signal
    assert.equal((await rpc('usage', { provider: 'BAD KEY' }, signal)).error.code, 'invalid-request')
    assert.equal((await rpc('usage', { provider: 'openai-codex', extra: 1 }, signal)).error.code, 'invalid-request')
    const fresh = await rpc('usage', { provider: 'openai-codex' }, signal)
    assert.equal(fresh.value.kind, 'windows')
    assert.equal(fresh.value.provider, 'openai-codex')
    // A request with no provider is a pre-upgrade page: answer the legacy shape.
    const legacy = await rpc('usage', {}, signal)
    assert.deepEqual(legacy.value, {
      planType: 'plus',
      weekly: { usedPercent: 3, remainingPercent: 97, windowSeconds: WEEK, resetsAt: 1_788_134_407 },
      fetchedAt: '2026-08-20T12:00:00.000Z',
    })
    const catalogRpc = createProviderUsageRpc(service, ['gpt-5.5', 'gpt-5.6-sol'])
    assert.deepEqual(await catalogRpc('catalog', {}, signal), {
      ok: true,
      value: { models: ['gpt-5.5', 'gpt-5.6-sol'] },
    })
    assert.equal((await catalogRpc('catalog', { extra: true }, signal)).error.code, 'invalid-request')
  })

  test('the RPC publishes only a stable failure code when the router throws', async () => {
    const rpc = createProviderUsageRpc({
      get: async () => { throw new Error('sk_secret_MUST_NOT_LEAK') },
    })
    const result = await rpc('usage', { provider: 'deepseek-official' }, new AbortController().signal)
    assert.deepEqual(result, { ok: false, error: { code: 'unavailable', message: 'usage unavailable' } })
    assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_LEAK/u)
  })
})

describe('usage cache and trusted RPC', () => {
  test('coalesces reads, caches them, and rate-limits forced refreshes', async () => {
    let calls = 0
    let clock = NOW
    let release
    const gate = new Promise(resolve => { release = resolve })
    const service = createOpenAICodexUsageService({
      resolveAccessToken: async () => 'access',
      readCredential: async () => ({ accountId: 'acc' }),
      now: () => clock,
      forceMinIntervalMs: 5_000,
      fetch: async () => {
        calls++
        if (calls === 1) await gate
        return new Response(JSON.stringify(payload(window(calls, WEEK), null)), { status: 200 })
      },
    })
    const first = service.get()
    const joined = service.get(true)
    release()
    assert.equal((await first).weekly.usedPercent, 1)
    assert.equal((await joined).weekly.usedPercent, 1)
    assert.equal(calls, 1)
    assert.equal((await service.get(true)).weekly.usedPercent, 1, 'an immediate forced read reuses the cache')
    assert.equal(calls, 1)
    clock += 5_000
    assert.equal((await service.get(true)).weekly.usedPercent, 2)
    assert.equal(calls, 2)
  })

  test('invalidates cached usage when the stored account changes', async () => {
    let accountId = 'account-a'
    let calls = 0
    const service = createOpenAICodexUsageService({
      resolveAccessToken: async () => 'access',
      readCredential: async () => ({ accountId }),
      now: () => NOW,
      fetch: async () => {
        calls++
        return new Response(JSON.stringify(payload(window(calls, WEEK), null)), { status: 200 })
      },
    })
    assert.equal((await service.get()).weekly.usedPercent, 1)
    accountId = 'account-b'
    assert.equal((await service.get()).weekly.usedPercent, 2)
    assert.equal(calls, 2, 'the second account never receives the first account cache')
  })

  test('throttles repeated force attempts even when the first one failed', async () => {
    let calls = 0
    const service = createOpenAICodexUsageService({
      resolveAccessToken: async () => 'access',
      readCredential: async () => ({ accountId: 'acc' }),
      now: () => NOW,
      forceMinIntervalMs: 5_000,
      fetch: async () => { calls++; return new Response('unavailable', { status: 503 }) },
    })
    await assert.rejects(service.get(true), error => error.code === 'upstream')
    await assert.rejects(service.get(true), error => error.code === 'refresh-throttled')
    assert.equal(calls, 1)
  })

  test('cancels upstream work when the last RPC caller aborts', async () => {
    let entered
    const started = new Promise(resolve => { entered = resolve })
    let upstreamAborted = false
    const service = createOpenAICodexUsageService({
      resolveAccessToken: async () => 'access',
      readCredential: async () => ({ accountId: 'acc' }),
      now: () => NOW,
      fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
        entered()
        signal.addEventListener('abort', () => {
          upstreamAborted = true
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      }),
    })
    const rpc = createOpenAICodexUsageRpc(service)
    const abort = new AbortController()
    const pending = rpc('usage', {}, abort.signal)
    await started
    abort.abort()
    assert.equal((await pending).error.code, 'aborted')
    assert.equal(upstreamAborted, true)
  })

  test('keeps a coalesced read alive until every caller leaves', async () => {
    let entered
    const started = new Promise(resolve => { entered = resolve })
    let release
    let upstreamSignal
    const response = new Promise(resolve => { release = resolve })
    const service = createOpenAICodexUsageService({
      resolveAccessToken: async () => 'access',
      readCredential: async () => ({ accountId: 'acc' }),
      now: () => NOW,
      fetch: async (_url, { signal }) => {
        upstreamSignal = signal
        entered()
        await response
        return new Response(JSON.stringify(payload(window(4, WEEK), null)), { status: 200 })
      },
    })
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = service.get(false, firstAbort.signal)
    const second = service.get(false, secondAbort.signal)
    await started
    firstAbort.abort()
    await assert.rejects(first, error => error.code === 'aborted')
    assert.equal(upstreamSignal.aborted, false, 'the second caller still owns the shared read')
    release()
    assert.equal((await second).weekly.usedPercent, 4)
  })

  test('returns normalized quota through a strict, secret-free RPC result', async () => {
    const forced = []
    const rpc = createOpenAICodexUsageRpc({
      get: async force => {
        forced.push(force)
        return { weekly: { usedPercent: 3, remainingPercent: 97, windowSeconds: WEEK, resetsAt: 1_788_134_407 } }
      },
    })
    const signal = new AbortController().signal
    assert.deepEqual(await rpc('usage', { force: true }, signal), {
      ok: true,
      value: { weekly: { usedPercent: 3, remainingPercent: 97, windowSeconds: WEEK, resetsAt: 1_788_134_407 } },
    })
    assert.deepEqual(forced, [true])
    assert.equal((await rpc('other', {}, signal)).error.code, 'method-not-found')
    assert.equal((await rpc('usage', { force: 'yes' }, signal)).error.code, 'invalid-request')
  })

  test('publishes only a stable RPC failure code', async () => {
    const rpc = createOpenAICodexUsageRpc({ get: async () => { throw new Error('access_MUST_NOT_LEAK') } })
    const result = await rpc('usage', {}, new AbortController().signal)
    assert.deepEqual(result, { ok: false, error: { code: 'unavailable', message: 'Codex usage unavailable' } })
    assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_LEAK/u)
  })
})
