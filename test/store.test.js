/**
 * Unit tests for the credential store: the document contract, the owner-only
 * refusal, provider ownership, and the writer lock. Nothing here touches the
 * ambient `$DSH_HOME` — every case gets its own temp home.
 *
 * The store imports two harness utilities, so a checkout without the peer
 * dependencies installed skips instead of failing.
 */

import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

const loaded = await import('../src/store.js').then(module => ({ module }), error => ({ error }))
const skip = loaded.error === undefined ? false : `peer dependencies are not installed (${loaded.error.code ?? 'import failed'})`
const { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER, openAICodexAuthPath } = loaded.module ?? {}

/** Temp homes this file created; every one holds a credential document. */
const homes = []
after(() => Promise.all(homes.map(home => rm(home, { recursive: true, force: true }))))

/** @returns {Promise<{home: string, store: object, path: string}>} a store over a fresh temp home. */
async function freshStore() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-codex-lite-test-'))
  homes.push(home)
  return { home, store: new OpenAICodexCredentialStore(home), path: openAICodexAuthPath(home) }
}

/** @param {number} [lifetimeMs] @returns {object} a well-formed OAuth credential. */
const credential = (lifetimeMs = 3_600_000) => ({
  type: 'oauth',
  access: 'access-token-value',
  refresh: 'refresh-token-value',
  expires: Date.now() + lifetimeMs,
})

describe('OpenAICodexCredentialStore: the document', { skip }, () => {
  test('stores, reads back, and writes owner-only', async () => {
    const { store, path } = await freshStore()
    const stored = await store.modify(OPENAI_CODEX_PROVIDER, async () => credential())
    assert.equal(stored.refresh, 'refresh-token-value')
    assert.deepEqual(await store.readCurrent(), stored)
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600)
    }
  })

  test('writes exactly the versioned envelope', async () => {
    const { store, path } = await freshStore()
    await store.modify(OPENAI_CODEX_PROVIDER, async () => credential())
    const document = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(Object.keys(document), ['version', 'credential'])
    assert.equal(document.version, 1)
  })

  test('reads as absent when signed out', async () => {
    const { store } = await freshStore()
    assert.equal(await store.readCurrent(), undefined)
    assert.deepEqual(await store.list(), [])
  })

  test('lists the stored credential without its secrets', async () => {
    const { store } = await freshStore()
    await store.modify(OPENAI_CODEX_PROVIDER, async () => credential())
    assert.deepEqual(await store.list(), [{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }])
  })

  test('a callback returning undefined keeps the current credential', async () => {
    const { store } = await freshStore()
    const first = await store.modify(OPENAI_CODEX_PROVIDER, async () => credential())
    const second = await store.modify(OPENAI_CODEX_PROVIDER, async () => undefined)
    assert.deepEqual(second, first)
  })

  test('keeps provider-owned fields the validator does not name', async () => {
    const { store } = await freshStore()
    const stored = await store.modify(OPENAI_CODEX_PROVIDER, async () => ({ ...credential(), accountId: 'acc_test' }))
    assert.equal(stored.accountId, 'acc_test')
    assert.equal((await store.readCurrent()).accountId, 'acc_test')
  })

  test('hands every caller its own copy', async () => {
    const { store } = await freshStore()
    await store.modify(OPENAI_CODEX_PROVIDER, async () => credential())
    const one = await store.readCurrent()
    one.access = 'mutated'
    assert.equal((await store.readCurrent()).access, 'access-token-value')
  })
})

describe('OpenAICodexCredentialStore: refusals', { skip }, () => {
  test('rejects a document that is not JSON', async () => {
    const { store, path } = await freshStore()
    await writeFile(path, 'not json', { mode: 0o600 })
    await assert.rejects(store.readCurrent(), /is not valid JSON/u)
  })

  test('rejects a document of another format version', async () => {
    const { store, path } = await freshStore()
    await writeFile(path, JSON.stringify({ version: 2, credential: credential() }), { mode: 0o600 })
    await assert.rejects(store.readCurrent(), /version-1 credential document/u)
  })

  test('rejects a document whose credential is not an OAuth credential', async () => {
    const { store, path } = await freshStore()
    await writeFile(path, JSON.stringify({ version: 1, credential: { type: 'api_key', key: 'k' } }), { mode: 0o600 })
    await assert.rejects(store.readCurrent(), /does not hold an OAuth credential/u)
  })

  test('refuses a file readable beyond its owner', {
    skip: process.platform === 'win32' && 'mode bits do not express a Windows ACL',
  }, async () => {
    const { store, path } = await freshStore()
    await store.modify(OPENAI_CODEX_PROVIDER, async () => credential())
    await chmod(path, 0o644)
    await assert.rejects(store.readCurrent(), /readable beyond its owner/u)
  })

  test('names the file and the remedy in the refusal', {
    skip: process.platform === 'win32' && 'mode bits do not express a Windows ACL',
  }, async () => {
    const { store, path } = await freshStore()
    await store.modify(OPENAI_CODEX_PROVIDER, async () => credential())
    await chmod(path, 0o604)
    await assert.rejects(store.readCurrent(), error => error.message.includes(path) && error.message.includes('chmod 600'))
  })
})

describe('OpenAICodexCredentialStore: provider ownership', { skip }, () => {
  test('a foreign provider reads as absent', async () => {
    const { store } = await freshStore()
    await store.modify(OPENAI_CODEX_PROVIDER, async () => credential())
    assert.equal(await store.read('anthropic'), undefined)
    assert.notEqual(await store.read(OPENAI_CODEX_PROVIDER), undefined)
  })

  test('a foreign provider cannot write into this file', async () => {
    const { store } = await freshStore()
    await assert.rejects(
      store.modify('anthropic', async () => credential()),
      /does not own provider "anthropic"/u,
    )
  })

  test('a foreign sign-out leaves the credential alone', async () => {
    const { store } = await freshStore()
    await store.modify(OPENAI_CODEX_PROVIDER, async () => credential())
    await store.delete('anthropic')
    assert.notEqual(await store.readCurrent(), undefined)
  })
})

describe('OpenAICodexCredentialStore: sign-out and locking', { skip }, () => {
  test('delete removes the document, and is idempotent', async () => {
    const { store } = await freshStore()
    await store.modify(OPENAI_CODEX_PROVIDER, async () => credential())
    await store.delete(OPENAI_CODEX_PROVIDER)
    assert.equal(await store.readCurrent(), undefined)
    await store.delete(OPENAI_CODEX_PROVIDER)
  })

  test('concurrent writers serialize instead of losing an update', async () => {
    const { store } = await freshStore()
    await store.modify(OPENAI_CODEX_PROVIDER, async () => ({ ...credential(), access: 'first' }))
    await Promise.all([
      store.modify(OPENAI_CODEX_PROVIDER, async current => ({ ...current, access: `${current.access}+a` })),
      store.modify(OPENAI_CODEX_PROVIDER, async current => ({ ...current, access: `${current.access}+b` })),
    ])
    const final = (await store.readCurrent()).access
    assert.ok(final === 'first+a+b' || final === 'first+b+a', `both updates applied, got ${final}`)
  })

  test('releases the lock when the callback throws', async () => {
    const { store } = await freshStore()
    await assert.rejects(store.modify(OPENAI_CODEX_PROVIDER, async () => { throw new Error('boom') }), /boom/u)
    const stored = await store.modify(OPENAI_CODEX_PROVIDER, async () => credential())
    assert.equal(stored.refresh, 'refresh-token-value')
  })
})
