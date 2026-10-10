/**
 * Integration tests for the credential half: the pi-ai `CredentialStore` over
 * the harness credential record, and the bounded resolver on top of it.
 *
 * These boot the real seam — a `LocalCredentialProvider` over a temp
 * `$DSH_HOME` — rather than stubbing `ctx.credentials`. A stub would only pin
 * the shape of our own calls; the properties worth pinning (that a rotation
 * lands in the document the native `llm-pi-ai` route reads, that the write is
 * serialized, that the lock is released) all live in the seam.
 *
 * The token endpoint is stubbed at `globalThis.fetch`, which is where pi-ai's
 * refresh actually calls out, so these exercise the real
 * `getAuth -> modify -> modifyRecord -> writer lock -> refresh` path without a
 * network. Nothing here reaches OpenAI.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, test } from 'node:test'

const loaded = await Promise.all([
  import('../src/credentials.js'),
  import('../src/token.js'),
  import('../src/usage.js'),
  import('@deepseek-ai/cordis'),
  import('@deepseek-ai/dsh-credentials'),
  import('@deepseek-ai/dsh-credentials-local'),
  import('@deepseek-ai/dsh-llm'),
]).then(modules => ({ modules }), error => ({ error }))
const skip = loaded.error === undefined ? false : `peer dependencies are not installed (${loaded.error.code ?? 'import failed'})`
const [credentialsModule, tokenModule, usageModule, cordis, credentialsSeam, credentialsLocal, llmModule] = loaded.modules ?? []

/**
 * The record address, spelled the way the harness's own pi-ai adapter family
 * spells it — scope `llm-pi-ai`, id `openai-codex` — rather than through the
 * `recordKeyFor` the source under test uses. The point of these tests is that
 * both plugins address the same record, which a shared helper would assume
 * instead of proving.
 * @returns {object} the credential key.
 */
const recordKey = () => credentialsSeam.credentialKey('llm-pi-ai', 'openai-codex')

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** Temp homes and live fibers this file created. */
const homes = []
const disposers = []
after(async () => {
  for (const dispose of disposers.reverse()) await dispose().catch(() => {})
  await Promise.all(homes.map(home => rm(home, { recursive: true, force: true })))
})

/**
 * A Codex access token. pi-ai reads the ChatGPT account id out of this claim
 * both when it stores a credential and when it builds request headers, so a
 * token without it is rejected before anything is persisted.
 * @returns {string} a JWT carrying the account claim.
 */
function accessToken() {
  const segment = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return [
    segment({ alg: 'none', typ: 'JWT' }),
    segment({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_test' } }),
    'signature',
  ].join('.')
}

/** A token response body that satisfies pi-ai's field check. */
const tokenBody = (refresh = 'rt_ROTATED') => JSON.stringify({
  access_token: accessToken(),
  refresh_token: refresh,
  expires_in: 3600,
})

/**
 * Boot a context carrying the file-backed credential plane over a fresh home.
 * @returns {Promise<object>} the root context.
 */
async function bootCredentials() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-provider-quota-credentials-'))
  homes.push(home)
  const ctx = new cordis.Context()
  disposers.push(() => ctx.fiber.dispose())
  await ctx.plugin(credentialsLocal.LocalCredentialProvider, {
    path: join(home, '.credentials.yaml'),
    dshHome: home,
    watch: false,
  })
  ctx.home = home
  return ctx
}

/**
 * Store one Codex grant the way a sign-in would.
 * @param {object} ctx - a context carrying the credential plane.
 * @param {boolean} [expired] - whether the access token is already past expiry.
 * @returns {Promise<void>} settles once the record is committed.
 */
async function storeGrant(ctx, expired = true) {
  await ctx.get('credentials').modifyRecord(recordKey(), async () => ({
    kind: 'grant',
    payload: {
      type: 'oauth',
      access: accessToken(),
      refresh: 'rt_STORED',
      expires: expired ? Date.now() - 1_000 : Date.now() + 3_600_000,
      accountId: 'acc_test',
    },
  }))
}

/** @param {object} ctx @returns {Promise<object|undefined>} the stored record, read through the seam. */
const storedRecord = ctx => ctx.get('credentials').readRecord(recordKey())

/** @param {object} ctx @returns {Promise<boolean>} whether a writer lock is still present. */
const isLocked = async ctx => (await readdir(ctx.home)).some(entry => entry.endsWith('.lock'))

/** @param {object} ctx @param {object} [options] @returns {() => Promise<string>} a resolver over that context's record. */
const resolverOver = (ctx, options) => tokenModule.createOpenAICodexAccessResolver(
  credentialsModule.createCodexCredentialStore(ctx),
  options,
)

/** @param {() => Promise<string>} resolve @returns {Promise<unknown>} the thrown value, or nothing. */
async function resolveOnce(resolve) {
  try {
    await resolve()
    return undefined
  } catch (error) {
    return error
  }
}

describe('the record credential store', { skip }, () => {
  test('reads the grant the harness stored, as the credential pi-ai expects', async () => {
    const ctx = await bootCredentials()
    await storeGrant(ctx, false)
    const store = credentialsModule.createCodexCredentialStore(ctx)
    const credential = await store.read('openai-codex')
    assert.equal(credential?.type, 'oauth')
    assert.equal(credential?.refresh, 'rt_STORED')
    assert.equal(credential?.accountId, 'acc_test')
    assert.deepEqual(await store.list(), [{ providerId: 'openai-codex', type: 'oauth' }])
  })

  test('an absent record reads as signed out rather than as a failure', async () => {
    const ctx = await bootCredentials()
    const store = credentialsModule.createCodexCredentialStore(ctx)
    assert.equal(await store.read('openai-codex'), undefined)
    assert.deepEqual(await store.list(), [])
  })

  test('a provider this store does not own reads absent and refuses to write', async () => {
    const ctx = await bootCredentials()
    await storeGrant(ctx, false)
    const store = credentialsModule.createCodexCredentialStore(ctx)
    assert.equal(await store.read('anthropic'), undefined)
    await assert.rejects(store.modify('anthropic', async () => ({ type: 'oauth' })), /does not own provider/u)
  })

  test('without a credentials service a read is empty and a write refuses', async () => {
    const ctx = new cordis.Context()
    disposers.push(() => ctx.fiber.dispose())
    const store = credentialsModule.createCodexCredentialStore(ctx)
    assert.equal(await store.read('openai-codex'), undefined)
    await assert.rejects(
      store.modify('openai-codex', async () => ({ type: 'oauth', access: 'a', refresh: 'b', expires: 1 })),
      /mounts no credentials service/u,
    )
  })
})

describe('token resolution over the record', { skip }, () => {
  test('signed out names the record instead of a command that no longer exists', async () => {
    const ctx = await bootCredentials()
    globalThis.fetch = async () => assert.fail('a signed-out route must not call the token endpoint')
    const error = await resolveOnce(resolverOver(ctx))
    assert.ok(error instanceof llmModule.LlmError)
    assert.equal(error.code, 'MISSING_CREDENTIAL')
    assert.match(error.message, /llm-pi-ai\/openai-codex/u)
  })

  test('a valid token is used without contacting the token endpoint', async () => {
    const ctx = await bootCredentials()
    await storeGrant(ctx, false)
    let called = false
    globalThis.fetch = async () => { called = true; return new Response('{}', { status: 500 }) }
    assert.equal(typeof await resolverOver(ctx)(), 'string')
    assert.equal(called, false, 'an unexpired credential costs no refresh')
  })

  test('an expired token is refreshed once and the rotation lands in the shared record', async () => {
    const ctx = await bootCredentials()
    await storeGrant(ctx)
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return new Response(tokenBody(), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    assert.equal(await resolveOnce(resolverOver(ctx)), undefined, 'the credential resolved')
    assert.equal(calls, 1)
    const record = await storedRecord(ctx)
    assert.equal(record?.kind, 'grant', 'the rotation is still a grant record, not a rewritten shape')
    assert.equal(record.payload.refresh, 'rt_ROTATED')
    assert.equal(record.payload.accountId, 'acc_test', 'provider-owned fields survive the round trip')
    assert.equal(await isLocked(ctx), false, 'the writer lock is released')
  })

  test('a second reader of the same record sees the rotation instead of refreshing again', async () => {
    // The property the shared record buys: a refresh token rotates on use, so
    // a second store over a second document would spend the retired one and
    // sign the account out. Here the second resolver — a stand-in for the
    // native llm-pi-ai route, which reads this same record — finds a credential
    // that is already fresh.
    const ctx = await bootCredentials()
    await storeGrant(ctx)
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return new Response(tokenBody(), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    assert.equal(await resolveOnce(resolverOver(ctx)), undefined)
    assert.equal(await resolveOnce(resolverOver(ctx)), undefined)
    assert.equal(calls, 1, 'the second reader spends no rotation of its own')
  })

  test('concurrent readers share one refresh', async () => {
    const ctx = await bootCredentials()
    await storeGrant(ctx)
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      await new Promise(resolve => setTimeout(resolve, 200))
      return new Response(tokenBody(), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const resolve = resolverOver(ctx)
    await Promise.all([resolveOnce(resolve), resolveOnce(resolve), resolveOnce(resolve)])
    assert.equal(calls, 1, 'one rotation per expiry, not one per reader')
  })

  test('a missing record reaches the browser as the signed-out code the chip already reads', async () => {
    // The chip renders "尚未登录" for exactly this code, so what this pins is
    // the seam between a resolver failure and the public vocabulary — not the
    // wording of either.
    const ctx = await bootCredentials()
    globalThis.fetch = async () => assert.fail('a signed-out route must not call the token endpoint')
    const store = credentialsModule.createCodexCredentialStore(ctx)
    const service = usageModule.createProviderUsageService({
      resolveRoute: async () => ({ kind: 'codex' }),
      codex: {
        resolveAccessToken: tokenModule.createOpenAICodexAccessResolver(store),
        readCredential: () => credentialsModule.readCodexCredential(ctx),
      },
    })
    const rpc = usageModule.createProviderUsageRpc(service)
    const answer = await rpc(usageModule.OPENAI_CODEX_USAGE_METHOD, { provider: 'openai-codex' }, new AbortController().signal)
    assert.equal(answer.ok, false)
    assert.equal(answer.error.code, 'signed-out')
  })
})

describe('credential failures over the record', { skip }, () => {
  test('a rejected refresh becomes an LlmError instead of a bare provider error', async () => {
    const ctx = await bootCredentials()
    await storeGrant(ctx)
    globalThis.fetch = async () => new Response('{"error":"invalid_grant"}', { status: 400 })
    const error = await resolveOnce(resolverOver(ctx))
    assert.ok(error instanceof llmModule.LlmError)
    assert.equal(error.code, 'AUTH')
    assert.match(error.message, /invalid_grant/u, 'the provider diagnostic survives')
  })

  test('a token response carrying secrets is redacted before it is reported', async () => {
    const ctx = await bootCredentials()
    await storeGrant(ctx)
    globalThis.fetch = async () => new Response(
      JSON.stringify({ access_token: 'a', refresh_token: 'rt_MUST_NOT_APPEAR', expires_in: 'not-a-number' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const error = await resolveOnce(resolverOver(ctx))
    assert.ok(error instanceof llmModule.LlmError)
    assert.doesNotMatch(error.message, /rt_MUST_NOT_APPEAR/u)
    assert.match(error.message, /\[redacted\]/u)
    assert.doesNotMatch(llmModule.errorChain(error), /rt_MUST_NOT_APPEAR/u)
    assert.equal(error.cause, undefined, 'nothing unredacted is kept for a renderer to find')
    assert.equal(await isLocked(ctx), false)
  })

  test('a refresh that outlives its deadline is cancelled, not left running', async () => {
    // Two properties, and the first is worth nothing without the second.
    //
    // Reaching the deadline has to report TIMEOUT. Let pi-ai's own ceiling win
    // that race instead and the failure arrives worded as an abort, which
    // `classifyCredentialFailure` reads as TRANSPORT — a dropped link, retried
    // as such.
    //
    // And the request has to actually END. Calling `refresh` with the
    // credential alone dropped the signal pi-ai hands in, leaving the token
    // request unsignalled: the deadline stopped the waiting while the fetch
    // ran on with no ceiling at all. Such a refresh can still succeed at
    // OpenAI long afterwards and rotate the grant, by which time the
    // transaction that would have stored the rotated token has failed and
    // released the lock — and the operator signs in again.
    const ctx = await bootCredentials()
    await storeGrant(ctx)
    let cancelled = false
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      // The endpoint that never answers: only an abort can end this request,
      // so a deadline that carries none hangs here until the suite times out.
      init.signal.addEventListener('abort', () => {
        cancelled = true
        reject(new Error('the token request was cancelled'))
      }, { once: true })
    })
    const error = await resolveOnce(resolverOver(ctx, { refreshTimeoutMs: 30 }))
    assert.equal(cancelled, true, 'the token request must be ended, not abandoned to finish later')
    assert.equal(error?.code, 'TIMEOUT')
    assert.equal(await isLocked(ctx), false, 'releasing the document lock is what the deadline is for')
  })

  test('a refresh that never reached the endpoint is transport, not authentication', async () => {
    const ctx = await bootCredentials()
    await storeGrant(ctx)
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    const error = await resolveOnce(resolverOver(ctx))
    assert.equal(error?.code, 'TRANSPORT')
  })

  test('a token endpoint answering 5xx is the endpoint failing, not the grant', async () => {
    const ctx = await bootCredentials()
    await storeGrant(ctx)
    globalThis.fetch = async () => new Response('upstream unavailable', { status: 503 })
    const error = await resolveOnce(resolverOver(ctx))
    assert.equal(error?.code, 'SERVER')
  })

  test('a token endpoint answering 408 is a timeout, the other retryable 4xx', async () => {
    const ctx = await bootCredentials()
    await storeGrant(ctx)
    globalThis.fetch = async () => new Response('request timeout', { status: 408 })
    const error = await resolveOnce(resolverOver(ctx))
    assert.equal(error?.code, 'TIMEOUT')
  })

  test('a throttled token endpoint is a rate limit', async () => {
    const ctx = await bootCredentials()
    await storeGrant(ctx)
    globalThis.fetch = async () => new Response('slow down', { status: 429 })
    const error = await resolveOnce(resolverOver(ctx))
    assert.equal(error?.code, 'RATE_LIMIT')
  })

  test('the chip hears each refresh failure as what it was, and only a rejected grant as a sign-in problem', async () => {
    // The tests above stop at the resolver, which classifies correctly. The
    // usage layer in front of it used to know three of those codes and file
    // the rest under `credential`, which the chip reads as "the sign-in has
    // expired" — sending the operator to re-authenticate over a dropped
    // packet. So this follows each failure all the way to the public code.
    const cases = [
      { upstream: async () => { throw new TypeError('fetch failed') }, code: 'network' },
      { upstream: async () => new Response('upstream unavailable', { status: 503 }), code: 'upstream' },
      { upstream: async () => new Response('slow down', { status: 429 }), code: 'rate-limited' },
      { upstream: async () => new Response('request timeout', { status: 408 }), code: 'timeout' },
      { upstream: async () => new Response('{"error":"invalid_grant"}', { status: 400 }), code: 'auth' },
    ]
    for (const { upstream, code } of cases) {
      const ctx = await bootCredentials()
      await storeGrant(ctx)
      globalThis.fetch = upstream
      const store = credentialsModule.createCodexCredentialStore(ctx)
      const service = usageModule.createProviderUsageService({
        resolveRoute: async () => ({ kind: 'codex' }),
        codex: {
          resolveAccessToken: tokenModule.createOpenAICodexAccessResolver(store),
          readCredential: () => credentialsModule.readCodexCredential(ctx),
        },
      })
      const rpc = usageModule.createProviderUsageRpc(service)
      const answer = await rpc(usageModule.OPENAI_CODEX_USAGE_METHOD, { provider: 'openai-codex' }, new AbortController().signal)
      assert.equal(answer.ok, false, code)
      assert.equal(answer.error.code, code)
    }
  })
})
