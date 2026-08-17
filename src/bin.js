#!/usr/bin/env node
/**
 * Terminal credential commands: `dsh-codex-lite <login|logout|status> [--device-code]`.
 * Login answers pi-ai's provider prompts non-interactively (browser flow by
 * default, device-code with the flag), opens the authorization URL, and never
 * prints token material — error text passes a redactor first.
 */

import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { loginOpenAICodex, logoutOpenAICodex, openAICodexAuthStatus } from './auth.js'
import { openAICodexAuthPath } from './store.js'

/**
 * Open one HTTPS URL with the platform browser, best effort.
 * @param {string} rawUrl - the authorization URL announced by the provider.
 */
function openBrowser(rawUrl) {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:') throw new Error(`refusing to open non-HTTPS authorization URL from ${url.host}`)
  const command = process.platform === 'win32'
    ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url.href] }
    : process.platform === 'darwin'
      ? { file: 'open', args: [url.href] }
      : { file: 'xdg-open', args: [url.href] }
  try {
    const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The printed URL remains the manual fallback.
  }
}

/**
 * Strip token-shaped material from an external OAuth diagnostic.
 * @param {unknown} error - thrown value.
 * @returns {string} printable message.
 */
function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

/**
 * Render one provider auth event.
 * @param {import('@earendil-works/pi-ai').AuthEvent} event - provider event.
 */
function notify(event) {
  switch (event.type) {
    case 'auth_url':
      process.stdout.write(`Open this URL to sign in:\n${event.url}\n`)
      if (event.instructions !== undefined) process.stdout.write(`${event.instructions}\n`)
      openBrowser(event.url)
      break
    case 'device_code':
      process.stdout.write(`Open this URL to sign in:\n${event.verificationUri}\nEnter code: ${event.userCode}\n`)
      openBrowser(event.verificationUri)
      break
    default:
      if (typeof event.message === 'string') process.stdout.write(`${event.message}\n`)
  }
}

function printHelp() {
  process.stdout.write([
    'Usage: dsh-codex-lite <login|logout|status> [--device-code]',
    '',
    '  login          sign in with ChatGPT (official Codex OAuth; separate from ~/.codex)',
    '  logout         remove the stored dsh credential',
    '  status         report non-secret sign-in state',
    '  --device-code  headless device-code login (login only)',
    '',
  ].join('\n'))
}

/**
 * Run one credential command.
 * @param {readonly string[]} argv - arguments after the script path.
 * @returns {Promise<number>} process exit code.
 */
export async function run(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [action, ...flags] = argv
  const deviceCode = flags.includes('--device-code')
  const unknown = flags.filter(flag => flag !== '--device-code')
  if (!['login', 'logout', 'status'].includes(action) || unknown.length > 0 || (deviceCode && action !== 'login')) {
    process.stderr.write(`dsh-codex-lite: invalid invocation: ${argv.join(' ')}\n`)
    printHelp()
    return 1
  }
  try {
    if (action === 'status') {
      const status = await openAICodexAuthStatus()
      if (!status.authenticated) {
        process.stdout.write('dsh-codex-lite: signed out\n')
        return 1
      }
      process.stdout.write(`dsh-codex-lite: signed in; access token expires ${status.expiresAt?.toISOString()} (refresh is automatic)\n`)
      return 0
    }
    if (action === 'logout') {
      await logoutOpenAICodex()
      process.stdout.write(`dsh-codex-lite: signed out; removed ${openAICodexAuthPath()}\n`)
      return 0
    }
    const readline = createInterface({ input: process.stdin, output: process.stdout })
    try {
      await loginOpenAICodex({
        prompt: async (prompt) => {
          if (prompt.type === 'select') {
            const wanted = deviceCode ? 'device_code' : 'browser'
            const option = prompt.options.find(candidate => candidate.id === wanted)
            if (option === undefined) throw new Error(`login did not offer the ${wanted} method`)
            return option.id
          }
          const suffix = prompt.placeholder === undefined ? '' : ` (${prompt.placeholder})`
          return readline.question(`${prompt.message}${suffix}: `, prompt.signal === undefined ? {} : { signal: prompt.signal })
        },
        notify,
      })
    } finally {
      readline.close()
    }
    process.stdout.write(`dsh-codex-lite: signed in; credential saved to ${openAICodexAuthPath()}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`dsh-codex-lite: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
