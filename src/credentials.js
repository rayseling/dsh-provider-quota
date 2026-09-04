/**
 * The Codex OAuth credential, read and rotated through the harness credential
 * plane instead of through a file this plugin owns.
 *
 * The record lives at `llm-pi-ai/openai-codex` — the address the harness's own
 * pi-ai adapter family writes, because {@link recordKeyFor} is that family's
 * export rather than a string spelled here. Sharing the address is the point:
 * the native `llm-pi-ai` route serves the model requests while this plugin
 * only reads quota, and a refresh performed by either one has to be the same
 * write. A refresh token rotates on use, so two stores over two documents
 * would each invalidate the other's copy the first time they refreshed.
 *
 * Exclusion comes from `modifyRecord`, which serializes across processes: pi-ai
 * runs the OAuth refresh *inside* `modify`, so the rotated credential is
 * committed before the lock is released and a second resolver joining late
 * reads the new one rather than refreshing again.
 *
 * The payload mapping below is a copy of the harness's own
 * `credentialStoreFrom` (`packages/llm/llm-pi-ai/src/auth.ts`), which that
 * package does not export. Copying it is what keeps the two writers writing
 * the same bytes; the copy is small, and the alternative — inventing a second
 * payload shape — is the failure it prevents.
 * @module dsh-codex-lite/credentials
 */

import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'

/** Provider route and pi-ai provider id whose credential this plugin reads. */
export const OPENAI_CODEX_PROVIDER = 'openai-codex'

/**
 * The JSON image of one grant payload: plain objects lose their
 * explicitly-undefined members and array entries JSON cannot hold become null,
 * exactly as `JSON.stringify` would render them. pi-ai credentials idiomatically
 * carry optional members as explicit `undefined`, which the credential store's
 * strict validator refuses as unrepresentable. Everything else — non-finite
 * numbers and foreign prototypes included — passes through untouched, so a
 * genuinely unstorable value still fails loud at the store.
 * @param {unknown} value - the value to render.
 * @returns {unknown} the value's JSON image.
 */
function jsonImage(value) {
  if (Array.isArray(value)) return value.map(entry => entry === undefined ? null : jsonImage(entry))
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    /** @type {Record<string, unknown>} */
    const image = {}
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) image[key] = jsonImage(member)
    }
    return image
  }
  return value
}

/**
 * Translate a stored record into the credential pi-ai expects.
 *
 * An `api-key` record is structural on both sides, so it is rebuilt field by
 * field. A `grant` payload is pi-ai's own OAuth credential, stored verbatim:
 * the seam treats it as opaque JSON precisely so a library that owns a token
 * format keeps owning it, refresh fields and all.
 * @param {object|undefined} record - the stored record, or nothing when none is stored.
 * @returns {object|undefined} the pi-ai credential, or nothing for an absent record.
 */
function toPiCredential(record) {
  if (record === undefined || record === null) return undefined
  if (record.kind === 'api-key') {
    return {
      type: 'api_key',
      ...record.key === undefined ? {} : { key: record.key },
      ...record.env === undefined ? {} : { env: { ...record.env } },
    }
  }
  return /** @type {object} */ (record.payload)
}

/**
 * Translate a pi-ai credential into the record to store.
 * @param {object} credential - what a refresh produced.
 * @returns {object} the record to commit, in the union the credential seam stores.
 */
function toRecord(credential) {
  if (credential.type === 'api_key') {
    return {
      kind: 'api-key',
      ...credential.key === undefined ? {} : { key: credential.key },
      ...credential.env === undefined ? {} : { env: { ...credential.env } },
    }
  }
  return { kind: 'grant', payload: jsonImage(credential) }
}

/**
 * Read the stored Codex credential without a service of its own.
 *
 * `ctx.get(name)` and not `ctx.credentials`: this plugin declares no injection,
 * and the property accessor throws for a service the fiber never declared —
 * before any fallback beside it can run. A composition with no credential plane
 * genuinely holds no credential, which is what "nothing stored" says.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {Promise<object|undefined>} the pi-ai credential, or nothing.
 */
export async function readCodexCredential(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || credentials === null) return undefined
  return toPiCredential(await credentials.readRecord(recordKeyFor(OPENAI_CODEX_PROVIDER)))
}

/**
 * A pi-ai `CredentialStore` over the harness credential records, owning exactly
 * the `openai-codex` record.
 *
 * Reads answer "nothing stored" without a credentials service, because that
 * composition holds no credential; `modify` refuses instead, because a refresh
 * whose rotated token silently evaporated would report success and then fail
 * every later request with a token the endpoint has already retired.
 *
 * Foreign provider ids read as absent and refuse writes: this store is handed
 * to a private `Models` collection carrying one provider, so a foreign id is a
 * wiring mistake rather than a credential that happens to be missing.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context carrying the optional `credentials` service.
 * @returns {object} the store to hand `createModels()`.
 */
export function createCodexCredentialStore(ctx) {
  const writable = () => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined || credentials === null) {
      throw new Error(
        'dsh-codex-lite: this composition mounts no credentials service, so the Codex credential cannot be'
        + ' rotated; mount one (dsh-credentials-local) to keep the sign-in alive',
      )
    }
    return credentials
  }
  return {
    async read(providerId) {
      if (providerId !== OPENAI_CODEX_PROVIDER) return undefined
      return readCodexCredential(ctx)
    },
    async list() {
      return await readCodexCredential(ctx) === undefined
        ? []
        : [{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }]
    },
    async modify(providerId, mutate) {
      if (providerId !== OPENAI_CODEX_PROVIDER) {
        throw new Error(`dsh-codex-lite: credential store does not own provider "${providerId}"`)
      }
      const stored = await writable().modifyRecord(
        recordKeyFor(OPENAI_CODEX_PROVIDER),
        async (current) => {
          const next = await mutate(toPiCredential(current))
          return next === undefined ? undefined : toRecord(next)
        },
      )
      return toPiCredential(stored)
    },
    // `async` so a missing service reaches the caller as a rejection: pi-ai's
    // store contract is promise-returning, and a synchronous throw would escape
    // the `ModelsError` wrapper every other storage failure gets.
    async delete(providerId) {
      if (providerId !== OPENAI_CODEX_PROVIDER) return
      await writable().deleteRecord(recordKeyFor(OPENAI_CODEX_PROVIDER))
    },
  }
}
