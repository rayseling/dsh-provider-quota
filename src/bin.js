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
import { redactSecrets, safeMessage } from './redact.js'
import { openAICodexAuthPath } from './store.js'

/**
 * Validate one authorization URL the provider announced, before it is shown to
 * the operator or handed to the platform opener.
 *
 * The printed line is an instruction to go and authenticate, so a URL that
 * does not parse, or that would send the operator to a non-HTTPS origin, fails
 * the sign-in rather than being displayed. The raw value stays out of the
 * diagnostics, since an authorization URL carries exchange parameters.
 * @param {string} rawUrl - the URL announced by the provider.
 * @returns {URL} the parsed HTTPS URL.
 */
function checkedAuthUrl(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('the provider announced an authorization URL that does not parse')
  }
  if (url.protocol !== 'https:') throw new Error(`refusing a non-HTTPS authorization URL from ${url.host}`)
  return url
}

/**
 * Hand one validated URL to the platform browser, best effort. Failing to
 * launch is not a sign-in failure: the URL is already on stdout, which is the
 * manual fallback, so nothing here throws.
 * @param {URL} url - authorization URL that passed {@link checkedAuthUrl}.
 */
function openBrowser(url) {
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
 * Render one provider auth event.
 * @param {import('@earendil-works/pi-ai').AuthEvent} event - provider event.
 */
function notify(event) {
  switch (event.type) {
    case 'auth_url': {
      const url = checkedAuthUrl(event.url)
      process.stdout.write(`Open this URL to sign in:\n${event.url}\n`)
      if (event.instructions !== undefined) process.stdout.write(`${event.instructions}\n`)
      openBrowser(url)
      break
    }
    case 'device_code': {
      const url = checkedAuthUrl(event.verificationUri)
      process.stdout.write(`Open this URL to sign in:\n${event.verificationUri}\nEnter code: ${event.userCode}\n`)
      openBrowser(url)
      break
    }
    default:
      // A provider event this build does not model, printed through the same
      // redaction as a thrown one: today's pi-ai mints none that carries token
      // material, and a default branch that trusts that is a default branch
      // that leaks the first time it stops being true.
      if (typeof event.message === 'string') process.stdout.write(`${redactSecrets(event.message)}\n`)
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

/**
 * Whether this module is the process entry point.
 *
 * `realpathSync` resolves the symlink a package manager installs as
 * `node_modules/.bin/dsh-codex-lite`, so the comparison holds for the
 * installed command as well as for a direct path. An entry that cannot be
 * resolved is simply not this module: importing `bin.js` must not fail on the
 * state of an argument that belongs to some other program.
 * @returns {boolean} whether this process should run a credential command.
 */
function isProcessEntry() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry)
  } catch {
    return false
  }
}

if (isProcessEntry()) {
  process.exitCode = await run(process.argv.slice(2))
}
