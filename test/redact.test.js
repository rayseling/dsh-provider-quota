/**
 * Unit tests for the redactor. Every "leaks" case is a message shape pi-ai
 * 1.3.0 actually constructs, quoted from `dist/auth/oauth/openai-codex.js`,
 * so a provider change that moves a secret into a new shape fails here rather
 * than in someone's terminal scrollback.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { redactSecrets, safeMessage } from '../src/redact.js'

/** A value that must never survive redaction. */
const SECRET = 'rt_01JQZZ_TOP_SECRET_VALUE'

describe('redactSecrets: shapes pi-ai throws', () => {
  test('token exchange response, the login path (openai-codex.js:100)', () => {
    const body = JSON.stringify({
      access_token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.SIGNATURE',
      refresh_token: SECRET,
      id_token: 'opaque-id-token',
      expires_in: '3600',
    })
    const out = redactSecrets(`OpenAI Codex token exchange response missing fields: ${body}`)
    assert.doesNotMatch(out, /SECRET|SIGNATURE|opaque-id-token/u)
    assert.match(out, /"expires_in":"3600"/u, 'non-secret fields stay readable')
  })

  test('token refresh response, reached through ModelsError cause folding', () => {
    const out = redactSecrets(
      'OAuth refresh failed for openai-codex: OpenAI Codex token refresh response missing fields:'
      + ` {"access_token":"a","refresh_token":"${SECRET}","expires_in":null}`,
    )
    assert.doesNotMatch(out, new RegExp(SECRET, 'u'))
    assert.match(out, /OAuth refresh failed for openai-codex/u, 'the diagnostic survives')
  })

  test('device auth token response (openai-codex.js:193)', () => {
    const out = redactSecrets(
      'Invalid OpenAI Codex device auth token response:'
      + ' {"authorization_code":"ac_SECRET","code_verifier":"cv_SECRET","user_code":"ABCD-EFGH"}',
    )
    assert.doesNotMatch(out, /ac_SECRET|cv_SECRET/u)
    assert.match(out, /"user_code":"ABCD-EFGH"/u, 'the device code is meant to be read aloud')
  })

  test('device code request response (openai-codex.js:164)', () => {
    // pi-ai polls the device token endpoint with `device_auth_id` and
    // `user_code` and nothing else, so quoting both is quoting the grant. The
    // user code stays legible because the operator has to read it aloud; its
    // partner is what makes that safe.
    const out = redactSecrets(
      'Invalid OpenAI Codex device code response:'
      + ' {"device_auth_id":"da_SECRET","user_code":"ABCD-EFGH","interval":null}',
    )
    assert.doesNotMatch(out, /da_SECRET/u)
    assert.match(out, /"user_code":"ABCD-EFGH"/u, 'the device code is meant to be read aloud')
    assert.doesNotMatch(redactSecrets('{"deviceAuthId":"da_SECRET"}'), /da_SECRET/u)
  })

  test('non-2xx token response quoting the raw body (openai-codex.js:95)', () => {
    const out = redactSecrets(`OpenAI Codex token refresh failed (400): {"error":"invalid_grant","refresh_token":"${SECRET}"}`)
    assert.doesNotMatch(out, new RegExp(SECRET, 'u'))
    assert.match(out, /"error":"invalid_grant"/u)
  })
})

describe('redactSecrets: carriers other than a JSON body', () => {
  test('bare JWT anywhere in the text', () => {
    assert.equal(
      redactSecrets('token was eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.ABC done'),
      'token was [redacted token] done',
    )
  })

  test('query parameter and form field', () => {
    const out = redactSecrets('callback: http://127.0.0.1:1455/cb?code=AUTHCODE&state=xyz')
    assert.doesNotMatch(out, /AUTHCODE/u)
    assert.match(out, /state=xyz/u, 'a non-secret parameter is untouched')
  })

  test('Authorization header in a transport diagnostic', () => {
    assert.equal(redactSecrets('sent authorization: Bearer sk-proj-ABC123'), 'sent authorization: Bearer [redacted]')
  })

  test('camelCase and unfamiliar *token* / *secret* field names', () => {
    const out = redactSecrets('{"accessToken":"A","clientSecret":"B","someNewToken":"C","refreshCredential":"D"}')
    assert.doesNotMatch(out, /"A"|"B"|"C"|"D"/u)
  })

  test('a JSON value containing an escaped quote does not end the match early', () => {
    const out = redactSecrets(String.raw`{"refresh_token":"rt_a\"b_SECRET","expires_in":1}`)
    assert.doesNotMatch(out, /SECRET/u)
    assert.match(out, /"expires_in":1/u)
  })

  test('every occurrence in one message', () => {
    const out = redactSecrets(`{"refresh_token":"${SECRET}"} then {"refresh_token":"${SECRET}"}`)
    assert.equal(out.includes(SECRET), false)
    assert.equal(out.match(/\[redacted\]/gu)?.length, 2)
  })

  test('redacting an already redacted message changes nothing', () => {
    const once = redactSecrets(`{"refresh_token":"${SECRET}","access_token":"eyJa.b.c"}`)
    assert.equal(redactSecrets(once), once)
  })
})

describe('redactSecrets: what must survive', () => {
  test('diagnostics an operator needs', () => {
    const out = redactSecrets(
      'OpenAI Codex token refresh failed (400):'
      + ' {"error":"invalid_grant","error_code":"E42","client_id":"app_public"}',
    )
    assert.match(out, /invalid_grant/u)
    assert.match(out, /E42/u)
    assert.match(out, /app_public/u)
  })

  test('paths, model ids and plain prose', () => {
    const message = 'dsh-provider-quota: /Users/x/.dsh/.openai-codex-auth.json is not valid JSON (model gpt-5.6-sol)'
    assert.equal(redactSecrets(message), message)
  })
})

describe('safeMessage', () => {
  test('reads an Error message and redacts it', () => {
    assert.equal(safeMessage(new Error(`k {"refresh_token":"${SECRET}"}`)), 'k {"refresh_token":"[redacted]"}')
  })

  test('renders a thrown non-Error without inspecting it', () => {
    assert.equal(safeMessage('plain string'), 'plain string')
    assert.equal(safeMessage({ refresh_token: SECRET }), '[object Object]')
    assert.equal(safeMessage(undefined), 'undefined')
    assert.equal(safeMessage(null), 'null')
  })

  test('an Error subclass carrying a folded cause is still covered', () => {
    const inner = new Error(`missing fields: {"refresh_token":"${SECRET}"}`)
    const outer = new Error(`Credential store modify failed: ${inner.message}`, { cause: inner })
    assert.doesNotMatch(safeMessage(outer), new RegExp(SECRET, 'u'))
  })
})
