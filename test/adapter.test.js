/**
 * Unit tests for the adapter: catalog sizing, and the guards around credential
 * resolution. The token endpoint is stubbed at `globalThis.fetch`, which is
 * where pi-ai's refresh actually calls out, so these exercise the real
 * `getAuth -> modify -> writer lock -> refresh` path without a network.
 *
 * The adapter imports pi-ai and two harness packages, so a checkout without
 * the peer dependencies installed skips instead of failing.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, test } from 'node:test'

const loaded = await Promise.all([
  import('../src/adapter.js'),
  import('../src/store.js'),
  import('@deepseek-ai/dsh-llm'),
]).then(modules => ({ modules }), error => ({ error }))
const skip = loaded.error === undefined ? false : `peer dependencies are not installed (${loaded.error.code ?? 'import failed'})`
const [adapterModule, storeModule, llmModule] = loaded.modules ?? []

const MODEL = 'gpt-5.6-sol'
/**
 * A second catalog id, taken from the installed catalog rather than written
 * down. A literal here goes red the day pi-ai retires that model — which is
 * drift, not a regression, and is exactly the failure mode notes/postmortems/
 * 0001 is about. `MODEL` stays a literal because these tests are about how it
 * is sized, and the assertions name it.
 * @returns {string} an id from the catalog that is not `MODEL`.
 */
const otherModelId = () => {
  const other = adapterModule.openAICodexCatalogModelIds().find(id => id !== MODEL)
  assert.ok(other !== undefined, 'the installed catalog carries only one model')
  return other
}
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

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

/** Temp homes this file created; every one holds a credential document. */
const homes = []
after(() => Promise.all(homes.map(home => rm(home, { recursive: true, force: true }))))

/** @returns {Promise<string>} a tracked, empty harness home. */
async function freshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-codex-lite-adapter-'))
  homes.push(home)
  return home
}

/**
 * A temp home holding one credential document.
 * @param {boolean} [expired] - whether the access token is already past expiry.
 * @returns {Promise<string>} the home path.
 */
async function homeWithCredential(expired = true) {
  const home = await freshHome()
  const document = {
    version: 1,
    credential: {
      type: 'oauth',
      access: accessToken(),
      refresh: 'rt_STORED',
      expires: expired ? Date.now() - 1_000 : Date.now() + 3_600_000,
    },
  }
  await writeFile(join(home, '.openai-codex-auth.json'), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  return home
}

/** @param {string} home @returns {object} an adapter over that home, with no attachment service. */
const adapterOver = (home, overrides = {}, enabledModels) => adapterModule.createOpenAICodexLiteAdapter(
  new storeModule.OpenAICodexCredentialStore(home),
  () => undefined,
  overrides,
  undefined,
  enabledModels,
)

/** Take one stream far enough to resolve a credential, and report what happened. */
async function resolveOnce(adapter) {
  try {
    for await (const _chunk of adapter.stream({ provider: 'openai-codex', model: MODEL, messages: [{ role: 'user', content: 'hi' }] })) break
    return undefined
  } catch (error) {
    return error
  }
}

/** @param {string} home @returns {Promise<boolean>} whether a writer lock is still present. */
const isLocked = async home => (await readdir(home)).some(entry => entry.endsWith('.lock'))

/** A token response body that satisfies pi-ai's field check. */
const tokenBody = (refresh = 'rt_ROTATED') => JSON.stringify({
  access_token: accessToken(),
  refresh_token: refresh,
  expires_in: 3600,
})

describe('catalog sizing', { skip }, () => {
  test('an enabled-model subset only narrows the advertised picker list', async () => {
    const home = await freshHome()
    const adapter = adapterOver(home, {}, [MODEL])
    const listed = await adapter.listModels('openai-codex')
    assert.deepEqual(listed.map(model => model.id), [MODEL])
    await assert.doesNotReject(adapter.resolveModel('openai-codex', otherModelId()), 'hidden exact selections remain routable')
  })

  test('a live enabled-model thunk changes listings without rebuilding the adapter', async () => {
    const home = await freshHome()
    let enabled = [MODEL]
    const adapter = adapterOver(home, {}, () => enabled)
    assert.deepEqual((await adapter.listModels('openai-codex')).map(model => model.id), [MODEL])
    const other = otherModelId()
    enabled = [other]
    assert.deepEqual((await adapter.listModels('openai-codex')).map(model => model.id), [other])
  })

  test('a context-window override reaches the resolved model', async () => {
    const adapter = adapterOver(await homeWithCredential(), { [MODEL]: { contextWindow: 1_000_000 } })
    const info = await adapter.resolveModel('openai-codex', MODEL)
    assert.equal(info.context.contextWindow, 1_000_000)
  })

  test('the route publishes no output cap, so none is invented', async () => {
    const adapter = adapterOver(await homeWithCredential(), { [MODEL]: { contextWindow: 1_000_000 } })
    const info = await adapter.resolveModel('openai-codex', MODEL)
    assert.equal('defaultMaxTokens' in info, false)
  })

  test('the route publishes a request image ceiling, so an image session stays evictable', async () => {
    // The adapter drops the oldest images once a request's base64 payload
    // passes this, and a profile without the field disables that entirely —
    // silently, since the field is only load-bearing once a session is long
    // and image-heavy. The gateway answers such a request with a payload-too-
    // large the seam classifies INVALID_REQUEST and never retries.
    //
    // The exact number is the host's own default for its pi-ai routes, copied
    // rather than imported because that package does not export it. This pins
    // only that a usable ceiling exists; drift in the value is a comment's job.
    const profile = adapterOver(await freshHome()).config.profiles().get('openai-codex')
    assert.ok(Number.isSafeInteger(profile.maxRequestImageBytes), 'the field must be present')
    assert.ok(profile.maxRequestImageBytes > 0)
  })

  test('the per-image budgets survive the offload pass instead of erasing the image', async () => {
    // These two fields are load-bearing in a way absence does not announce.
    // PiAiAdapter always builds the conversion policy from them, so omitting
    // them does not inherit the host default — it sends `undefined`, the
    // offload pass measures each image as `Math.min(bytes, undefined)` = NaN,
    // every budget comparison goes false, and the request reaches the model
    // with every image swapped for a text placeholder and nothing thrown.
    //
    // So this runs the harness's real offload function over the profile the
    // plugin actually builds, and asserts an image block is still an image
    // block on the far side. Pinning the numbers instead would pass just as
    // happily with both fields missing.
    const profile = adapterOver(await freshHome()).config.profiles().get('openai-codex')
    const { offloadRequestImagesWithPolicy } = llmModule
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this image' },
        { type: 'image', attachment: { attachmentId: 'att_1', mediaType: 'image/png', bytes: 40_000, width: 100, height: 100 } },
      ],
    }]
    const converted = offloadRequestImagesWithPolicy(messages, {
      representation: 'base64',
      maxBytes: profile.maxRequestImageBytes,
      byteQuantum: 1,
      byteLength: ref => Math.min(ref.bytes, profile.requestImageMaxBytes),
    })
    assert.deepEqual(
      converted[0].content.map(block => block.type),
      ['text', 'image'],
      'one small image under the budget must reach the wire as an image',
    )
    assert.ok(Number.isSafeInteger(profile.requestImagePixelBudget) && profile.requestImagePixelBudget > 0)
    assert.ok(Number.isSafeInteger(profile.requestImageMaxBytes) && profile.requestImageMaxBytes > 0)
  })

  test('an unconfigured route keeps the installed catalog', async () => {
    const adapter = adapterOver(await homeWithCredential())
    const models = await adapter.listModels('openai-codex')
    assert.ok(models.some(model => model.id === MODEL), 'the catalog still lists its models')
    assert.equal((await adapter.resolveModel('openai-codex', MODEL)).context.contextWindow, 272_000)
  })

  test('an override naming a model the catalog does not carry is refused at load', async () => {
    const home = await homeWithCredential()
    assert.throws(
      () => adapterOver(home, { 'gpt-9-nonexistent': { contextWindow: 5 } }),
      /modelOverrides names "gpt-9-nonexistent"/u,
    )
  })
})

describe('credential resolution', { skip }, () => {
  test('signed out asks for the login command by name', async () => {
    const home = await freshHome()
    globalThis.fetch = async () => assert.fail('a signed-out route must not call the token endpoint')
    const error = await resolveOnce(adapterOver(home))
    assert.ok(error instanceof llmModule.LlmError)
    assert.equal(error.code, 'MISSING_CREDENTIAL')
    assert.match(error.message, /dsh-codex-lite login/u)
  })

  test('a valid token is used without contacting the token endpoint', async () => {
    const home = await homeWithCredential(false)
    let called = false
    globalThis.fetch = async () => { called = true; return new Response('{}', { status: 500 }) }
    await resolveOnce(adapterOver(home))
    assert.equal(called, false, 'an unexpired credential costs no refresh')
  })

  test('an expired token is refreshed once and the rotation is persisted', async () => {
    const home = await homeWithCredential()
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return new Response(tokenBody(), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const error = await resolveOnce(adapterOver(home))
    assert.equal(error?.code, undefined, 'the credential resolved')
    assert.equal(calls, 1)
    const document = JSON.parse(await readFile(join(home, '.openai-codex-auth.json'), 'utf8'))
    assert.equal(document.credential.refresh, 'rt_ROTATED')
    assert.equal(document.credential.accountId, 'acc_test', 'provider-owned fields survive the round trip')
    assert.equal(await isLocked(home), false, 'the writer lock is released')
  })

  test('concurrent requests share one refresh', async () => {
    const home = await homeWithCredential()
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      await new Promise(resolve => setTimeout(resolve, 200))
      return new Response(tokenBody(), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const adapter = adapterOver(home)
    await Promise.all([resolveOnce(adapter), resolveOnce(adapter), resolveOnce(adapter)])
    assert.equal(calls, 1, 'one rotation per expiry, not one per request')
  })
})

describe('credential failures', { skip }, () => {
  test('a rejected refresh becomes an LlmError instead of a bare provider error', async () => {
    const home = await homeWithCredential()
    globalThis.fetch = async () => new Response('{"error":"invalid_grant"}', { status: 400 })
    const error = await resolveOnce(adapterOver(home))
    assert.ok(error instanceof llmModule.LlmError)
    assert.equal(error.code, 'AUTH')
    assert.match(error.message, /invalid_grant/u, 'the provider diagnostic survives')
  })

  test('a token response carrying secrets is redacted before it is reported', async () => {
    const home = await homeWithCredential()
    globalThis.fetch = async () => new Response(
      JSON.stringify({ access_token: 'a', refresh_token: 'rt_MUST_NOT_APPEAR', expires_in: 'not-a-number' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const error = await resolveOnce(adapterOver(home))
    assert.ok(error instanceof llmModule.LlmError)
    assert.doesNotMatch(error.message, /rt_MUST_NOT_APPEAR/u)
    assert.match(error.message, /\[redacted\]/u)
    assert.equal(await isLocked(home), false)
  })

  test('leaves nothing unredacted attached for a renderer to walk into', async () => {
    // The message is not the only thing a diagnostic renderer reads. Anything
    // that walks a `cause` chain — `errorChain`, an unhandled-rejection trace,
    // `util.inspect` in a log line — would print the original beside the
    // redacted wrapper. The seam detaches adapter failures to `{message,
    // code}` before publishing them, so this guards the object rather than any
    // one wire, and fails if a cause is ever reattached.
    const home = await homeWithCredential()
    globalThis.fetch = async () => new Response(
      JSON.stringify({ access_token: 'a', refresh_token: 'rt_MUST_NOT_APPEAR', expires_in: 'not-a-number' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const error = await resolveOnce(adapterOver(home))
    assert.ok(error instanceof llmModule.LlmError)
    assert.doesNotMatch(llmModule.errorChain(error), /rt_MUST_NOT_APPEAR/u)
    assert.equal(error.cause, undefined, 'nothing unredacted is kept for a renderer to find')
  })

  test('a refresh that never reached the endpoint is transport, not authentication', async () => {
    // pi-ai reports this as `OpenAI Codex token refresh error: <cause>`. Sent
    // as AUTH it would end the turn unretried and tell the operator to sign in
    // again, which fixes nothing about a dropped connection.
    const home = await homeWithCredential()
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    const error = await resolveOnce(adapterOver(home))
    assert.ok(error instanceof llmModule.LlmError)
    assert.equal(error.code, 'TRANSPORT')
  })

  test('a token endpoint answering 5xx is the endpoint failing, not the grant', async () => {
    const home = await homeWithCredential()
    globalThis.fetch = async () => new Response('upstream unavailable', { status: 503 })
    const error = await resolveOnce(adapterOver(home))
    assert.ok(error instanceof llmModule.LlmError)
    assert.equal(error.code, 'SERVER')
  })

  test('a token endpoint answering 408 is a timeout, the other retryable 4xx', async () => {
    const home = await homeWithCredential()
    globalThis.fetch = async () => new Response('request timeout', { status: 408 })
    const error = await resolveOnce(adapterOver(home))
    assert.ok(error instanceof llmModule.LlmError)
    assert.equal(error.code, 'TIMEOUT')
  })

  test('a throttled token endpoint is a rate limit', async () => {
    const home = await homeWithCredential()
    globalThis.fetch = async () => new Response('slow down', { status: 429 })
    const error = await resolveOnce(adapterOver(home))
    assert.ok(error instanceof llmModule.LlmError)
    assert.equal(error.code, 'RATE_LIMIT')
  })

  test('a refused grant is still authentication, and every retryable code is one the policy retries', async () => {
    const home = await homeWithCredential()
    globalThis.fetch = async () => new Response('{"error":"invalid_grant"}', { status: 403 })
    const error = await resolveOnce(adapterOver(home))
    assert.ok(error instanceof llmModule.LlmError)
    assert.equal(error.code, 'AUTH', 'a 4xx below 429 says the grant itself is bad')
    // The classifier is only useful if the seam agrees these codes are worth
    // retrying; pin that rather than trusting the taxonomy stays put.
    const policy = adapterOver(home).providerRetryPolicy('openai-codex')
    for (const code of ['TIMEOUT', 'TRANSPORT', 'SERVER', 'RATE_LIMIT']) {
      assert.ok(policy.retryableCodes.includes(code), `${code} must be retryable`)
    }
    assert.equal(policy.retryableCodes.includes('AUTH'), false)
  })

  test('a stalled token endpoint fails as a retryable timeout and frees the lock', async () => {
    const home = await homeWithCredential()
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      await new Promise((resolve) => { setTimeout(resolve, 600_000).unref() })
      return new Response('{}')
    }
    const adapter = adapterOver(home)
    const errors = await Promise.all([resolveOnce(adapter), resolveOnce(adapter)])
    assert.equal(calls, 1, 'the stall is shared, not multiplied')
    for (const error of errors) {
      assert.ok(error instanceof llmModule.LlmError)
      assert.equal(error.code, 'TIMEOUT', 'a stall clears by itself, so it is retryable')
    }
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(await isLocked(home), false, 'other processes are not left waiting on an abandoned refresh')
  })
})
