/**
 * The exact Fetch route that carries the usage Handler over Connection's
 * shared `/api` channel. What is pinned here is the wire protocol the browser's
 * `connection.rpc.call` speaks — it is the harness's envelope, reproduced on
 * our side because `rpc.handle` cannot be used (see src/rpc-route.js) — and
 * that nothing a failing Handler knows leaks past it.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createUsageFetchRoute, OPENAI_CODEX_USAGE_PATH } from '../src/rpc-route.js'
import { createProviderUsageRpc, OPENAI_CODEX_USAGE_CHANNEL, OPENAI_CODEX_USAGE_METHOD } from '../src/usage.js'

const READY = { kind: 'windows', provider: 'openai-codex', windows: [], fetchedAt: '2026-08-20T12:00:00.000Z' }

/**
 * @param {object} [overrides] - envelope fields to replace, `undefined` to drop one.
 * @param {RequestInit} [init] - request fields to replace.
 * @returns {Request} what the browser's `rpc.call` would send.
 */
function post(overrides = {}, init = {}) {
  const envelope = { type: 'client-request', rpcId: 'r-1', method: OPENAI_CODEX_USAGE_METHOD, payload: { provider: 'openai-codex' }, ...overrides }
  return new Request(`http://host${OPENAI_CODEX_USAGE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
    ...init,
  })
}

describe('the usage route on the shared /api channel', () => {
  test('is an exact, buffered POST route at /api/<method>, so Connection and not this plugin finds the carrier', () => {
    const route = createUsageFetchRoute(async () => ({ ok: true, value: READY }))
    assert.equal(OPENAI_CODEX_USAGE_CHANNEL, '/api', 'only the shared channel is dispatched by exact route')
    assert.equal(route.path, `/api/${OPENAI_CODEX_USAGE_METHOD}`)
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
    assert.match(OPENAI_CODEX_USAGE_METHOD, /^[A-Za-z0-9_$.-]+$/u, 'one path segment in the charset Connection accepts')
  })

  test('answers the server-response envelope the browser validates, echoing the rpcId', async () => {
    const seen = []
    const route = createUsageFetchRoute(async (endpoint, payload, signal) => {
      seen.push({ endpoint, payload, aborted: signal.aborted })
      return { ok: true, value: READY }
    })
    const response = await route.fetch(post({ rpcId: 'r-42' }))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^application\/json/u)
    assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'r-42', result: { ok: true, value: READY } })
    assert.deepEqual(seen, [{ endpoint: OPENAI_CODEX_USAGE_METHOD, payload: { provider: 'openai-codex' }, aborted: false }])
  })

  test('a Handler failure reaches the browser with the code it chose, and a details object the client insists on', async () => {
    // The client half of Connection rejects a failure without a `details`
    // record as an invalid envelope, and the chip then reads 'unavailable'
    // instead of the real reason. Every code the Handler mints carries one.
    const route = createUsageFetchRoute(createProviderUsageRpc({
      get: async () => { throw Object.assign(new Error('token_MUST_NOT_LEAK'), { code: 'AUTH' }) },
    }))
    const body = await (await route.fetch(post())).json()
    assert.deepEqual(body.result, { ok: false, error: { code: 'auth', message: 'usage unavailable', details: {} } })
    assert.doesNotMatch(JSON.stringify(body), /MUST_NOT_LEAK/u)
  })

  test('rejects what is not a JSON client-request for this method with the harness status codes', async () => {
    const route = createUsageFetchRoute(async () => { throw new Error('the Handler must not run') })
    assert.equal((await route.fetch(post({}, { headers: { 'content-type': 'text/plain' } }))).status, 415)
    assert.equal((await route.fetch(post({}, { body: '{not json' }))).status, 400)
    const wrongType = await (await route.fetch(post({ type: 'server-response' }))).json()
    assert.deepEqual(wrongType, {
      type: 'server-response',
      rpcId: 'r-1',
      result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } } },
    })
    const noId = await (await route.fetch(post({ rpcId: undefined }))).json()
    assert.equal(noId.rpcId, 'invalid-request')
    assert.equal(noId.result.error.code, 'gateway/bad-request')
    const otherMethod = await (await route.fetch(post({ method: 'usage' }))).json()
    assert.equal(otherMethod.result.error.code, 'gateway/bad-request')
    assert.match(otherMethod.result.error.message, /"usage" does not match endpoint/u)
  })

  test('a Handler that throws is a 500 without its message', async () => {
    const route = createUsageFetchRoute(async () => { throw new Error('sk_secret_MUST_NOT_LEAK') })
    const response = await route.fetch(post())
    assert.equal(response.status, 500)
    assert.doesNotMatch(await response.text(), /MUST_NOT_LEAK/u)
  })
})
