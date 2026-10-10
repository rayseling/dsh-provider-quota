/**
 * The usage Handler mounted as an exact Fetch route on Connection's shared
 * `/api` channel, speaking the same envelope `connection.rpc.call` sends.
 *
 * Why not `connection.rpc.handle`: since dsh 0.1.5-alpha.1 its `register()`
 * reads `owner.webServer` through Connection's OWN fiber, which no longer
 * declares that injection, so a foreign plugin's channel throws before it
 * lands — inside the `ctx.inject` child fiber, where nothing reports it — and
 * the route answers the static 405 for good. `connection.fetch.register` never
 * reads the carrier: it writes a Map that Connection dispatches from the `/api`
 * route it mounts itself under `ctx.inject(['webServer'])`, so the route is
 * there whenever the carrier is, comes back after a carrier restart, and sits
 * behind the same `admit()` (Host/Origin fence, then browser-session
 * authentication), the configured body cap and the `connection/request`
 * waterfall. The harness's own session-log export, file upload, media
 * references and deliverables routes mount the same way.
 *
 * The wire format is Connection's unary RPC envelope, so the browser keeps
 * calling `connection.rpc.call` with the client-side validation that brings;
 * only the channel and method names moved. Everything a Fetch route owns that
 * `rpc.handle` used to do for us — content type, JSON body, envelope, method
 * match — is reproduced here with the harness's own status codes.
 * @module dsh-provider-quota/rpc-route
 */

import { OPENAI_CODEX_USAGE_CHANNEL, OPENAI_CODEX_USAGE_METHOD } from './usage.js'

/** Absolute path the exact route is registered under: `/api/<method>`. */
export const OPENAI_CODEX_USAGE_PATH = `${OPENAI_CODEX_USAGE_CHANNEL}/${OPENAI_CODEX_USAGE_METHOD}`

/** Correlation id answered when the request carried none a response could echo. */
const INVALID_REQUEST_RPC_ID = 'invalid-request'

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {string} rpcId - correlation id to echo.
 * @param {{ok: boolean}} result - the Handler result, already secret-free.
 * @returns {Response} the JSON server-response envelope.
 */
function envelope(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result })
}

/**
 * @param {string} rpcId - correlation id to echo.
 * @param {string} message - what was wrong with the request.
 * @returns {Response} a `gateway/bad-request` failure envelope.
 */
function badRequest(rpcId, message) {
  return envelope(rpcId, { ok: false, error: { code: 'gateway/bad-request', message, details: { issues: [] } } })
}

/**
 * Build the exact Fetch route for the usage Handler.
 * @param {(endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{ok: boolean}>} handler - the usage Handler.
 * @returns {{path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response>}} the route for `connection.fetch.register`.
 */
export function createUsageFetchRoute(handler) {
  return {
    path: OPENAI_CODEX_USAGE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      var mediaType = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      var body
      try {
        body = await request.json()
      } catch (_notJson) {
        return new Response('body is not JSON', { status: 400 })
      }
      var rpcId = isRecord(body) && typeof body.rpcId === 'string' ? body.rpcId : INVALID_REQUEST_RPC_ID
      if (!isRecord(body) || body.type !== 'client-request' || rpcId === INVALID_REQUEST_RPC_ID || typeof body.method !== 'string') {
        return badRequest(rpcId, 'invalid client-request message')
      }
      if (body.method !== OPENAI_CODEX_USAGE_METHOD) {
        return badRequest(rpcId, `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(OPENAI_CODEX_USAGE_METHOD)}`)
      }
      try {
        return envelope(rpcId, await handler(body.method, body.payload, request.signal))
      } catch (error) {
        // The Handler already maps every failure it knows to a public code; a
        // throw here is a bug, and the message may carry an upstream detail.
        return new Response('handler failure', { status: 500 })
      }
    },
  }
}
