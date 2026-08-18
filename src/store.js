/**
 * Owner-only file persistence of the OpenAI Codex OAuth credential,
 * implementing pi-ai's `CredentialStore` for exactly one provider.
 *
 * On-disk document: `{ version: 1, credential: <pi-ai OAuthCredential> }` at
 * `$DSH_HOME/.openai-codex-auth.json` — the same path and format the dsh-codex
 * bundle uses, so a sign-in done by either package serves both. The file is
 * written atomically with mode 0600 under a cross-process file lock, and a
 * `$DSH_HOME` this plugin creates is created 0700 (an existing one keeps
 * whatever mode it already has).
 *
 * Refusing to read a file that is readable beyond its owner is a POSIX
 * guarantee only: Windows synthesizes the mode bits Node reports and its
 * access control lives in an ACL that a mode cannot express, so there the
 * document is protected by the directory holding it, exactly as every other
 * harness secret under `$DSH_HOME` is.
 * @module dsh-codex-lite/store
 */

import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Provider route and pi-ai provider id owned by this plugin. */
export const OPENAI_CODEX_PROVIDER = 'openai-codex'

/** Basename of the OAuth document inside the Harness home (shared with dsh-codex). */
const AUTH_FILENAME = '.openai-codex-auth.json'

/** Current on-disk format; readers reject every other version. */
const AUTH_FORMAT_VERSION = 1

/**
 * Absolute path of the credential document.
 * @param {string} [dshHome] - explicit Harness home; defaults to `$DSH_HOME` / `~/.dsh`.
 * @returns {string} the resolved path.
 */
export function openAICodexAuthPath(dshHome) {
  return resolve(join(resolveDshHome(dshHome), AUTH_FILENAME))
}

/** @param {unknown} error @returns {boolean} whether the error reports an absent path. */
function isENOENT(error) {
  return typeof error === 'object' && error !== null && /** @type {{code?: string}} */ (error).code === 'ENOENT'
}

/**
 * Reject a credential document readable by another POSIX user.
 *
 * Windows is exempt before anything is read: the mode it reports is
 * synthesized from the read-only attribute rather than derived from the file's
 * ACL, so the check could only produce a false verdict either way.
 * @param {string} filename - document path.
 */
async function assertOwnerOnly(filename) {
  if (process.platform === 'win32') return
  let mode
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (isENOENT(error)) return
    throw error
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `dsh-codex-lite: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
      + ` run "chmod 600 ${filename}" first`,
    )
  }
}

/**
 * Parse and validate the stored document without quoting token-bearing input.
 * @param {string} text - raw file contents.
 * @param {string} filename - document path, for diagnostics only.
 * @returns {{version: 1, credential: import('@earendil-works/pi-ai').OAuthCredential}} the document.
 */
function parseDocument(text, filename) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`dsh-codex-lite: ${filename} is not valid JSON`)
  }
  if (typeof value !== 'object' || value === null || value.version !== AUTH_FORMAT_VERSION) {
    throw new Error(`dsh-codex-lite: ${filename} is not a version-${AUTH_FORMAT_VERSION} credential document`)
  }
  const credential = value.credential
  if (
    typeof credential !== 'object' || credential === null
    || credential.type !== 'oauth'
    || typeof credential.access !== 'string'
    || typeof credential.refresh !== 'string'
    || typeof credential.expires !== 'number'
  ) {
    throw new Error(`dsh-codex-lite: ${filename} does not hold an OAuth credential`)
  }
  return value
}

/**
 * pi-ai `CredentialStore` over one owner-only JSON file, owning exactly the
 * `openai-codex` provider. Foreign provider ids read as absent and refuse
 * writes, so a wider Models collection cannot silently store into this file.
 */
export class OpenAICodexCredentialStore {
  /** @param {string} [dshHome] - explicit Harness home for tests; defaults to the ambient home. */
  constructor(dshHome) {
    /** @type {string} */
    this.filename = openAICodexAuthPath(dshHome)
  }

  /** @returns {Promise<import('@earendil-works/pi-ai').OAuthCredential | undefined>} the stored credential, absent when signed out. */
  async readCurrent() {
    await assertOwnerOnly(this.filename)
    let text
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return undefined
      throw error
    }
    return structuredClone(parseDocument(text, this.filename).credential)
  }

  /**
   * @param {string} providerId - pi-ai provider id.
   * @returns {Promise<import('@earendil-works/pi-ai').Credential | undefined>} the credential when this store owns the id.
   */
  async read(providerId) {
    return providerId === OPENAI_CODEX_PROVIDER ? this.readCurrent() : undefined
  }

  /** @returns {Promise<readonly {providerId: string, type: string}[]>} non-secret inventory of stored credentials. */
  async list() {
    return await this.readCurrent() === undefined
      ? []
      : [{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }]
  }

  /**
   * Read-modify-write under the cross-process file lock; `fn` returning
   * `undefined` keeps the current credential (pi-ai's no-change contract).
   * @param {string} providerId - pi-ai provider id; anything foreign throws.
   * @param {(current: import('@earendil-works/pi-ai').Credential | undefined) => Promise<import('@earendil-works/pi-ai').Credential | undefined>} fn - transformation.
   * @returns {Promise<import('@earendil-works/pi-ai').Credential | undefined>} the credential now stored.
   */
  async modify(providerId, fn) {
    if (providerId !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`dsh-codex-lite: credential store does not own provider "${providerId}"`)
    }
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return withFileLock(this.filename, async () => {
      const current = await this.readCurrent()
      const candidate = await fn(current)
      if (candidate === undefined) return current
      const document = parseDocument(
        JSON.stringify({ version: AUTH_FORMAT_VERSION, credential: candidate }),
        this.filename,
      )
      await writeFileAtomic(this.filename, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
      return structuredClone(document.credential)
    })
  }

  /**
   * Remove the stored credential (sign-out); foreign provider ids are a no-op.
   * @param {string} providerId - pi-ai provider id.
   */
  async delete(providerId) {
    if (providerId !== OPENAI_CODEX_PROVIDER) return
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    await withFileLock(this.filename, () => rm(this.filename, { force: true }))
  }
}
