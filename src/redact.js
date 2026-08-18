/**
 * Redaction for diagnostics that pass through this plugin from pi-ai's OAuth
 * flow, so no token material reaches a terminal, a log or a pasted bug report.
 *
 * The provider reports a non-conforming token response by interpolating the
 * whole body — `... missing fields: {"access_token":"…","refresh_token":"…"}` —
 * and the device flow does the same with the authorization code and its PKCE
 * verifier, so redaction has to cover JSON object syntax and not only the
 * query-parameter form. Secrets are matched by field name rather than by value
 * shape: an opaque refresh token is indistinguishable from an id, and a rule
 * that only knows today's field names re-leaks the moment the provider adds
 * one.
 * @module dsh-codex-lite/redact
 */

/** Three-segment JWT, the shape of the Codex access token. */
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu

/** `Authorization: Bearer <token>` as it appears in a transport diagnostic. */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu

/** Secret carried as a query parameter or form field. */
const PARAMETER = /(\b(?:code|token|refresh_token|access_token|id_token|code_verifier|client_secret)=)[^&\s]+/giu

/**
 * Secret carried as a JSON string field. The name alternation covers every
 * `*token*`/`*secret*` field the provider can mint plus the exchange values
 * that are equally sufficient to obtain a credential; `user_code` is
 * deliberately absent, being the code the device flow asks the operator to
 * read aloud. The value alternation consumes JSON escapes so an embedded
 * quote cannot end the match early.
 */
const JSON_FIELD = new RegExp(
  '("(?:[A-Za-z0-9_-]*(?:token|secret|password|credential)[A-Za-z0-9_-]*'
  + '|code_verifier|authorization_code|device_code|api_?key)"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*',
  'giu',
)

/**
 * Strip token material from one diagnostic string.
 * @param {string} text - message that may quote provider input.
 * @returns {string} the message with every recognized secret replaced.
 */
export function redactSecrets(text) {
  return text
    .replace(JWT, '[redacted token]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(PARAMETER, '$1[redacted]')
    .replace(JSON_FIELD, '$1[redacted]')
}

/**
 * Render a thrown value as a printable, redacted message.
 * @param {unknown} error - thrown value.
 * @returns {string} printable message.
 */
export function safeMessage(error) {
  return redactSecrets(error instanceof Error ? error.message : String(error))
}
