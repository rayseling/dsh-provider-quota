/**
 * Unit tests for the terminal command surface, driven as a subprocess so the
 * exit code is the real one an operator gets. Every case runs against an empty
 * temp `$DSH_HOME`, and none of them is `login`: the sign-in path talks to
 * `auth.openai.com` and opens a browser, so it is not something a test suite
 * may start.
 *
 * The CLI imports pi-ai through the sign-in module, so a checkout without the
 * peer dependencies installed skips instead of failing.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const BIN = fileURLToPath(new URL('../src/bin.js', import.meta.url))

const loaded = await import('../src/auth.js').then(module => ({ module }), error => ({ error }))
const skip = loaded.error === undefined ? false : `peer dependencies are not installed (${loaded.error.code ?? 'import failed'})`

/** Temp homes this file created, one per invocation. */
const homes = []
after(() => Promise.all(homes.map(home => rm(home, { recursive: true, force: true }))))

/**
 * Run the CLI against an empty harness home.
 * @param {readonly string[]} args - arguments after the script path.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} the observed result.
 */
async function cli(args) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-codex-lite-cli-'))
  homes.push(home)
  const options = { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' }
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], options)
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

describe('dsh-codex-lite CLI', { skip }, () => {
  test('no arguments and --help print usage and succeed', async () => {
    for (const args of [[], ['--help'], ['-h']]) {
      const { code, stdout } = await cli(args)
      assert.equal(code, 0, `${JSON.stringify(args)} should succeed`)
      assert.match(stdout, /Usage: dsh-codex-lite <login\|logout\|status>/u)
    }
  })

  test('status reports a signed-out home with a non-zero code', async () => {
    const { code, stdout } = await cli(['status'])
    assert.equal(code, 1, 'signed out is a failed query, so scripts can branch on it')
    assert.match(stdout, /signed out/u)
  })

  test('an unknown action is refused on stderr', async () => {
    const { code, stderr } = await cli(['bogus'])
    assert.equal(code, 1)
    assert.match(stderr, /invalid invocation/u)
  })

  test('--device-code is refused for anything but login', async () => {
    for (const args of [['status', '--device-code'], ['logout', '--device-code']]) {
      const { code, stderr } = await cli(args)
      assert.equal(code, 1, `${JSON.stringify(args)} should be refused`)
      assert.match(stderr, /invalid invocation/u)
    }
  })

  test('a flag in the action position is refused rather than reordered', async () => {
    const { code } = await cli(['--device-code', 'login'])
    assert.equal(code, 1)
  })

  test('an unknown flag is refused', async () => {
    const { code, stderr } = await cli(['status', '--force'])
    assert.equal(code, 1)
    assert.match(stderr, /invalid invocation/u)
  })

  test('logout on a signed-out home succeeds', async () => {
    const { code } = await cli(['logout'])
    assert.equal(code, 0)
  })

  test('importing the module does not run it, whatever argv holds', async () => {
    const { stdout } = await run(
      process.execPath,
      ['--input-type=module', '--eval', `await import(${JSON.stringify(BIN)}); console.log('imported')`, '/nonexistent/entry'],
      { encoding: 'utf8' },
    )
    assert.match(stdout, /^imported$/mu, 'an unresolvable argv[1] is not this module, and not an error either')
    assert.doesNotMatch(stdout, /Usage:/u, 'importing must not execute a command')
  })
})
