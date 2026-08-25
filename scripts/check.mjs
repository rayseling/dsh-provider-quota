#!/usr/bin/env node
/**
 * dsh-codex-lite gates: eight independent collectors plus a runner.
 *
 * `npm test` runs this, not `node --test` — see AGENTS.md. The suite alone
 * cannot be the gate, because a checkout without the peer dependencies
 * reports `# tests 200 / pass 200 / fail 0 / skipped 0` and exits 0 while 72
 * of the 272 tests are never enumerated at all (a `describe(name, { skip },
 * fn)` subtree is one `ok … # SKIP` line and its children land in neither
 * counter).
 *
 * Discipline copied from deepseek-harness; machinery deliberately not:
 *
 *  - every collector is `collectX(root, …) => string[]`, taking the root as a
 *    parameter, so `test/check.test.js` can point it at a fixture directory
 *    instead of at this repository;
 *  - a collector never early-returns. It accumulates every violation, so one
 *    run shows all the work rather than the first item of it;
 *  - a success line always carries a COUNT and names what it did NOT check,
 *    so an empty scan cannot look like a pass;
 *  - a collector that cannot find the thing it compares FAILS. Passing
 *    vacuously is the one outcome a gate may never have;
 *  - every message carries location, fact, consequence, and remedy, because
 *    the message is what an agent acts on and is therefore the product;
 *  - an exemption is a signed comment with a mandatory reason, and every run
 *    prints the ones in force — not only `--exemptions`, which nothing
 *    requires anyone to pass.
 *
 * There is no gate graph here on purpose. Eight checks, no edges, under a
 * second without the suite: a `for` loop that accumulates failures and exits 1
 * is the whole scheduler. Revisit if a gate crosses ten seconds or grows a
 * real dependency edge.
 *
 * @module dsh-codex-lite/scripts/check
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/** This checkout, derived from this file rather than from `process.cwd()`. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Properties that resolve on a Cordis context without appearing in `inject`.
 *
 * Derived from the harness's vendored cordis, not from taste. The context
 * proxy trap returns early for anything `Reflect.has(target, prop)` finds
 * (`vendor/cordis/src/reflect.ts:140`), and the mixed-in methods resolve one
 * branch further down, as `reflect.props` accessors
 * (`vendor/cordis/src/reflect.ts:147-149`). So the safe set is:
 *
 *  (a) the string-keyed own properties the `Context` constructor assigns
 *      (`vendor/cordis/src/context.ts:75-81`) — `logger` among them, which is
 *      exactly why `ctx.logger` is safe here while `ctx.settings` is not;
 *  (b) the mixins registered at `vendor/cordis/src/reflect.ts:219-222`;
 *  (c) `Context.prototype`'s own members.
 *
 * Inherited `Object.prototype` members and `_`-prefixed names also resolve
 * (the latter through `isSpecialProperty`), but those are recognized
 * dynamically in {@link collectServiceReadViolations} rather than listed here.
 */
const CONTEXT_BUILTINS = new Set([
  // context.ts:75-81 — own properties of every context
  'root', 'baseUrl', 'fiber', 'reflect', 'registry', 'events', 'logger',
  // reflect.ts:219-222 — mixins, resolved as accessors
  'get', 'set', 'provide', 'accessor', 'mixin',
  'runtime', 'effect',
  'inject', 'plugin',
  'on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall',
  // Context.prototype
  'extend', 'isolate', 'intercept', 'constructor',
])

/**
 * Identifiers a documentation symbol may name without living in this
 * repository or in the harness: they are language or platform globals.
 */
const PLATFORM_GLOBALS = new Set([
  'NaN', 'Infinity', 'Math', 'JSON', 'Object', 'Array', 'Number', 'String',
  'Boolean', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'Error',
  'RegExp', 'Symbol', 'Proxy', 'Reflect', 'BigInt', 'Function',
  'Response', 'Request', 'Headers', 'URL', 'URLSearchParams', 'AbortSignal',
  'AbortController', 'TextEncoder', 'TextDecoder', 'Blob', 'FormData',
])

/** Root-level files a document may cite by bare name. */
const ROOT_FILES = new Set([
  'AGENTS.md', 'CLAUDE.md', 'README.md', 'LICENSE',
  'package.json', 'cordis.patch.yml', '.gitignore',
])

/** Extensions that make a backticked token a path rather than a symbol. */
const PATH_EXTENSIONS = /\.(js|mjs|cjs|ts|tsx|json|ya?ml|md|lock|toml|sh)$/u

/** The `npm test` command every other gate assumes is wired. */
const TEST_COMMAND = 'node scripts/check.mjs'

/**
 * The only gates a bare run leaves out.
 *
 * Defined as the EXCLUSION rather than as a list of what runs, so that a gate
 * added later is in CI by default and nobody has to remember to add it. The
 * first version listed the five that ran, and two gates that need nothing —
 * `doc-budget` and `verify-workflow` — sat outside it for no reason, which is
 * exactly the drift this shape prevents. It also means no count is written
 * down anywhere: the runner prints what it computed.
 *
 * These two verify that every `packages/...` path and symbol the documents
 * cite exists in the deepseek-harness tree, and refuse to report green when no
 * harness checkout is reachable. CI has none, so they run locally.
 */
const HARNESS_ONLY_GATES = ['doc-refs', 'doc-symbols']

/**
 * The one skip reason a bare run is allowed to produce.
 *
 * `test/{adapter,bin,settings,store}.test.js` each guard a `describe` on
 * whether the peer dependencies resolve, so that reading the repository
 * without a node_modules tree does not produce a wall of red. In CI — which
 * cannot install those peers, one of them 404s — those four skips are the
 * expected state and everything else is a suite someone gated off.
 */
const PEER_SKIP_REASON = /peer dependencies are not installed/u

// ---------------------------------------------------------------------------
// source scanning
// ---------------------------------------------------------------------------

/** Character classes {@link scan} assigns. */
const CODE = 0
const COMMENT = 1
const QUOTED = 2

/**
 * After one of these, a `/` opens a regular expression rather than a division.
 *
 * Whitespace is deliberately NOT here, and the whitespace branch of the
 * scanner deliberately does not overwrite the previous token: treating a space
 * as "an expression may start here" made `used / limit, x = ctx.settings, y =
 * used / window` one long regular expression, and everything between the two
 * slashes — including the forbidden read — vanished from the view both source
 * gates read.
 */
const REGEX_MAY_FOLLOW = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n'])
const REGEX_MAY_FOLLOW_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'do', 'else', 'yield', 'await', 'case',
])

/**
 * Keywords whose `(` opens a condition rather than an argument list.
 *
 * `)` alone cannot decide: `if (x) /re/.test(y)` starts a regex, `f(x) / 2`
 * is a division. Without the distinction, `if (value)/[/*]/u` was read as a
 * division followed by `/*` — a block comment that ran to end of file and took
 * two gates, and the honesty of the exemption list, with it.
 */
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with'])

/**
 * Classify every character of a JavaScript source as code, comment, or the
 * body of a string / template / regular expression.
 *
 * One scanner, three views. The alternative — three functions each tracking
 * quotes for themselves — is how a regular expression containing an apostrophe
 * (`/\w+'s/u`, perfectly legal) silently switched the service and dependency
 * gates off for the rest of a file: the stray quote opened string mode and
 * never closed. Deriving every view from one classification means a scanner
 * bug can no longer make two views disagree, and it makes all three views
 * exactly as long as the input — which the dependency gate's offset pairing
 * depends on.
 *
 * Delimiters (quotes, backticks, regex slashes) stay CODE so the shape of a
 * statement survives in the blanked view; only bodies are QUOTED. Template
 * substitutions return to CODE.
 *
 * It is still a scanner, not a parser: the regex-versus-division decision uses
 * the standard previous-token heuristic, which no scanner gets right in every
 * case. That is why each gate built on it reports a count rather than claiming
 * completeness.
 * @param {string} source - JavaScript source text.
 * @returns {Uint8Array} one class per character, same length as the input.
 */
export function scan(source) {
  const kinds = new Uint8Array(source.length)
  let unterminated = false
  /** Template-literal nesting: one brace counter per open `${`. */
  const templates = []
  /** One entry per open `(`: whether it belongs to a control keyword. */
  const parens = []
  let prevChar = '\n'
  let prevWord = ''
  let afterControlParen = false
  let i = 0

  /** @param {number} from @param {number} to */
  const quote = (from, to) => { for (let k = from; k < to && k < source.length; k++) kinds[k] = QUOTED }
  /** @param {number} from @param {number} to */
  const comment = (from, to) => { for (let k = from; k < to && k < source.length; k++) kinds[k] = COMMENT }

  /**
   * Consume a template body from `at`, stopping at the closing backtick or a
   * substitution.
   * @param {number} at - first character after the opening delimiter.
   * @returns {number} index of the terminator.
   */
  const templateBody = (at) => {
    let k = at
    while (k < source.length) {
      const c = source[k]
      if (c === '\\') { k += 2; continue }
      if (c === '`') break
      if (c === '$' && source[k + 1] === '{') break
      k++
    }
    quote(at, k)
    return k
  }

  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]

    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      comment(i, stop)
      i = stop
      prevChar = '\n'
      prevWord = ''
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      if (end === -1) unterminated = true
      comment(i, stop)
      i = stop
      prevChar = ' '
      prevWord = ''
      continue
    }
    if (ch === '/' && (REGEX_MAY_FOLLOW.has(prevChar) || REGEX_MAY_FOLLOW_WORD.has(prevWord)
      || (prevChar === ')' && afterControlParen))) {
      let k = i + 1
      let inClass = false
      while (k < source.length) {
        const c = source[k]
        if (c === '\\') { k += 2; continue }
        if (c === '\n') break
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) break
        k++
      }
      if (k < source.length && source[k] === '/') {
        quote(i + 1, k)
        k++
        while (k < source.length && /[a-z]/u.test(source[k])) k++
        i = k
        prevChar = '/'
        prevWord = ''
        continue
      }
      // Unterminated: fall through and treat the slash as ordinary code.
    }
    if (ch === '`') {
      const end = templateBody(i + 1)
      if (end < source.length && source[end] === '$') {
        templates.push(0)
        i = end + 2
        prevChar = '{'
        prevWord = ''
        continue
      }
      i = Math.min(end + 1, source.length)
      prevChar = '`'
      prevWord = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      let k = i + 1
      while (k < source.length) {
        const c = source[k]
        if (c === '\\') { k += 2; continue }
        if (c === ch || c === '\n') break
        k++
      }
      quote(i + 1, k)
      i = Math.min(k + 1, source.length)
      prevChar = ch
      prevWord = ''
      continue
    }
    if (templates.length > 0 && ch === '{') templates[templates.length - 1]++
    if (templates.length > 0 && ch === '}') {
      if (templates[templates.length - 1] === 0) {
        templates.pop()
        const end = templateBody(i + 1)
        if (end < source.length && source[end] === '$') {
          templates.push(0)
          i = end + 2
          prevChar = '{'
          prevWord = ''
          continue
        }
        i = Math.min(end + 1, source.length)
        prevChar = '`'
        prevWord = ''
        continue
      }
      templates[templates.length - 1]--
    }
    if (ch === '(') parens.push(CONTROL_KEYWORDS.has(prevWord))
    if (ch === ')') afterControlParen = parens.pop() === true
    if (/\s/u.test(ch)) {
      // Only a newline moves the "an expression may start here" marker. A
      // space must leave the previous token alone, or every spaced division
      // opens a regular expression.
      if (ch === '\n') { prevChar = '\n'; prevWord = '' }
      i++
      continue
    }
    if (/[\w$]/u.test(ch)) {
      let k = i
      while (k < source.length && /[\w$]/u.test(source[k])) k++
      prevWord = source.slice(i, k)
      prevChar = source[k - 1]
      i = k
      continue
    }
    prevChar = ch
    prevWord = ''
    i++
  }
  kinds.unterminatedBlockComment = unterminated
  return kinds
}

/**
 * Problems the scanner itself found — reported as violations rather than
 * absorbed.
 *
 * An unterminated `/*` blanks everything after it. Silently, that is a gate
 * switching itself off for the rest of a file; said out loud, it is a typo
 * with a location.
 * @param {string} rel - path, for the message.
 * @param {string} source - JavaScript source text.
 * @returns {string[]} zero or one message.
 */
export function scanProblems(rel, source) {
  const problems = []
  if (scan(source).unterminatedBlockComment) {
    problems.push(
      `${rel}: a \`/*\` block comment is never closed, so everything after it reads as comment — `
      + 'which means every gate that scans this file stops seeing it, without saying so. '
      + 'Close the comment.',
    )
  }
  // A block comment that swallows a top-level statement. The unterminated case
  // above only fires when nothing closes the comment before end of file — and
  // a file with more than one JSDoc block almost never reaches that state. Drop
  // the `*/` off one docstring and the comment simply runs to the NEXT one,
  // eating whatever lay between: here that was an `export const`, and the
  // module stopped exporting it while every gate still read the file as valid.
  // Caught by the test suite, but only because something imported the symbol.
  const comments = commentsOnly(source)
  const lineOf = lineLookup(source)
  for (const hit of comments.matchAll(/^(export|import)\s/gmu)) {
    problems.push(
      `${rel}:${lineOf(hit.index)}: a \`${hit[1]}\` statement is inside a block comment. `
      + 'That is almost always a docstring missing its `*/`: the comment runs on to the next one and swallows the code between, '
      + 'so the module quietly stops exporting what it looks like it exports. '
      + 'Close the comment above this line.',
    )
  }
  return problems
}

/**
 * @param {string} source - JavaScript source text.
 * @param {(kind: number) => boolean} keep - whether a class survives verbatim.
 * @returns {string} the same length of text, everything else blanked.
 */
function view(source, keep) {
  const kinds = scan(source)
  const out = new Array(source.length)
  for (let i = 0; i < source.length; i++) {
    out[i] = keep(kinds[i]) ? source[i] : (source[i] === '\n' ? '\n' : ' ')
  }
  return out.join('')
}

/**
 * Comments blanked; code and literal bodies kept. Offsets preserved.
 * @param {string} source - JavaScript source text.
 * @returns {string} the same length of text.
 */
export function stripComments(source) {
  return view(source, kind => kind !== COMMENT)
}

/**
 * Comments AND literal bodies blanked, delimiters kept. Offsets preserved.
 *
 * Use this wherever a match inside a literal would be a false positive:
 * `ctx.settings` named in a documentation comment, or a whole fixture file
 * embedded in a test's string.
 * @param {string} source - JavaScript source text.
 * @returns {string} the same length of text.
 */
export function stripCommentsAndStrings(source) {
  return view(source, kind => kind === CODE)
}

/**
 * Everything except comments blanked — the exact inverse of
 * {@link stripComments}, taken from the same classification rather than by
 * comparing the two outputs character by character.
 *
 * Exemptions have to be read from this view. Read them from the raw text and
 * a marker quoted inside a string counts as a signature — and since every
 * gate's failure message ends by telling the reader how to write one, each of
 * those messages would silently exempt the lines around itself. That happened
 * here on the first run.
 * @param {string} source - JavaScript source text.
 * @returns {string} the same length of text.
 */
export function commentsOnly(source) {
  return view(source, kind => kind === COMMENT)
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} root - directory to read from.
 * @param {string} rel - path relative to that root.
 * @returns {string|undefined} the file's text, or nothing when it is unreadable.
 */
function readText(root, rel) {
  try {
    return readFileSync(join(root, rel), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * @param {string} root - directory to list.
 * @param {string} rel - subdirectory relative to that root.
 * @returns {string[]} file names, sorted; empty when the directory is absent.
 */
function listDir(root, rel) {
  try {
    return readdirSync(join(root, rel)).sort()
  } catch {
    return []
  }
}

/**
 * Walk a directory tree, yielding files whose name matches.
 * @param {string} dir - absolute directory to walk.
 * @param {RegExp} match - tested against the file name.
 * @param {string[]} [out] - accumulator.
 * @returns {string[]} absolute file paths, sorted.
 */
function walk(dir, match, skip = ['node_modules'], out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip.includes(entry.name) || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    // `isDirectory()` is false for a symlink to one, and `lib/` is a real
    // source directory here even though it is build output in the harness.
    // Both exclusions used to hide a whole subtree from two gates while the
    // printed file count stayed put.
    let directory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try {
        directory = statSync(full).isDirectory()
      } catch {
        continue
      }
    }
    if (directory) walk(full, match, skip, out)
    else if (match.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * The host-side sources the service and dependency gates read.
 *
 * Recursive and `.mjs`-aware on purpose. A non-recursive `.js`-only listing
 * let a file under `src/routes/` carry both an undeclared import and a
 * forbidden service read while both gates stayed green — and kept printing the
 * same file count as before, so nothing in the output hinted that anything had
 * been missed. Exported so the summary line reports what was actually scanned
 * instead of recomputing it a second, possibly different way.
 *
 * `src/client.js` is excluded by name: it is a classic browser script handed a
 * module table, not a Cordis fiber. Its `require` is a function parameter, and
 * its `ctx` is the client host object.
 * @param {string} root - checkout to scan.
 * @returns {string[]} repo-relative paths, sorted.
 */
export function hostSourceFiles(root) {
  return walk(join(root, 'src'), /\.(js|mjs)$/u)
    .map(file => relative(root, file).split(sep).join('/'))
    .filter(rel => rel !== 'src/client.js')
}

/**
 * Line lookup for one text, computed once instead of scanned per match.
 * @param {string} text - the source offsets point into.
 * @returns {(index: number) => number} 1-based line of an offset.
 */
function lineLookup(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return (index) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid] <= index) low = mid
      else high = mid - 1
    }
    return low + 1
  }
}

/**
 * Collect the signed exemptions in one file.
 *
 * The form is `// gate-exempt: <gate-id> <reason>` in source, and a whole-line
 * `<!-- gate-exempt: <gate-id> <reason> -->` in Markdown. The reason is
 * mandatory and must be at least three words: an exemption without one is
 * reported instead of honored, so the cheapest green path still costs a
 * sentence. It exempts the line it sits on and the line after it.
 *
 * Source exemptions are read from {@link commentsOnly}, and the Markdown form
 * must own its line, so neither a quoted marker nor an inline-code example of
 * the syntax can sign anything. Documenting the mechanism must not switch the
 * gate off for the document doing the documenting — the Markdown half had
 * exactly that hole.
 * @param {string} text - raw file text.
 * @param {string} gate - gate id the exemption must name.
 * @param {'js'|'md'} [kind='js'] - which comment syntax to read.
 * @returns {{lines: Set<number>, listed: string[], malformed: string[]}} exempt lines and their reasons.
 */
export function exemptionsIn(text, gate, kind = 'js') {
  const lines = new Set()
  const listed = []
  const malformed = []
  const pattern = kind === 'md'
    ? /^\s*<!--\s*gate-exempt:\s*([\w-]+)[ \t]*(.*?)\s*-->\s*$/u
    : /\/\/\s*gate-exempt:\s*([\w-]+)[ \t]*(.*?)\s*$/u
  // Split on either line ending: `.` does not match `\r`, so a CRLF checkout
  // used to lose every source exemption silently — neither honored, nor
  // reported as malformed, nor listed.
  const rows = (kind === 'md' ? text : commentsOnly(text)).split(/\r?\n/u)
  for (let i = 0; i < rows.length; i++) {
    const hit = pattern.exec(rows[i])
    if (hit === null) continue
    if (hit[1] !== gate) continue
    const reason = hit[2].trim()
    // Counted in characters, not space-separated words: the documents in this
    // repository are Chinese, and a word count refuses every reason written in
    // the language the rest of the file is written in.
    if (reason.replace(/\s+/gu, '').length < 8) {
      malformed.push(`line ${i + 1}`)
      continue
    }
    lines.add(i + 1)
    lines.add(i + 2)
    listed.push(`line ${i + 1}: ${reason}`)
  }
  return { lines, listed, malformed }
}

/**
 * Parse a manifest-shaped JSON file.
 *
 * `JSON.parse` succeeding is not the same as getting an object: `null`, `3`
 * and `[]` are all valid JSON, and every one of them turned a property read
 * downstream into a TypeError that aborted the whole run.
 * @param {string|undefined} text - file contents.
 * @param {string} label - path, for the message.
 * @returns {{value: object}|{error: string}} the object, or why there is none.
 */
function parseObject(text, label) {
  if (text === undefined) return { error: `${label}: absent or unreadable. Run from a checkout root.` }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { error: `${label}: is not valid JSON (${error.message}). Nothing that reads it can be checked.` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: `${label}: parsed to ${Array.isArray(value) ? 'an array' : String(value)}, not an object. Nothing that reads it can be checked.` }
  }
  return { value }
}

/**
 * Locate the harness checkout whose internals this repository's documents cite.
 * @param {string} root - this checkout.
 * @returns {string|undefined} the harness root, when one is reachable.
 */
export function harnessRootFor(root) {
  const declared = process.env.DSH_HARNESS_ROOT
  if (typeof declared === 'string' && declared.length > 0) {
    return existsSync(join(declared, 'packages')) ? declared : undefined
  }
  const sibling = resolve(root, '..', 'deepseek-harness')
  return existsSync(join(sibling, 'packages')) ? sibling : undefined
}

/**
 * @param {string} identifier - a symbol name, possibly `$`-leading.
 * @returns {RegExp} a whole-word matcher. `\b$name\b` would anchor on `$`.
 */
function wholeWord(identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'u')
}

/**
 * The message a documentation gate fails with when it cannot reach the harness.
 * @param {string} gate - which gate.
 * @param {number} count - how many citations went unverified.
 * @returns {string} the violation.
 */
function harnessUnreachable(gate, count) {
  return `${gate}: ${count} citation(s) point into the harness and no harness checkout is reachable, so this gate cannot do its job. `
    + 'Reporting green here would claim a check that never ran — the failure this whole file exists to prevent. '
    + 'Set `DSH_HARNESS_ROOT=/path/to/deepseek-harness`, or keep a `deepseek-harness` checkout beside this one.'
}

// ---------------------------------------------------------------------------
// gate: service-reads
// ---------------------------------------------------------------------------

/**
 * Every `ctx.<name>` in the host-side sources must name either a service this
 * plugin injects or a context built-in (see {@link CONTEXT_BUILTINS}).
 *
 * This is AGENTS.md trap 2, and the only one of the five a pattern can see.
 * The bug it guards against reads `ctx.settings !== undefined ? … : ctx.get(…)`
 * — the property accessor throws before the fallback beside it ever runs, the
 * enclosing catch turns the throw into "nothing configured", and every API-key
 * route silently serves defaults.
 * @param {string} root - checkout to scan.
 * @returns {string[]} one message per violation.
 */
export function collectServiceReadViolations(root) {
  const violations = []
  const index = readText(root, 'src/index.js')
  if (index === undefined) {
    return ['src/index.js: absent, so the `inject` list backing this gate cannot be read. Run from a checkout root.']
  }
  const declared = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/u.exec(stripComments(index))
  if (declared === null) {
    return ['src/index.js: no `export const inject = [...]` found, so this gate cannot tell an injected service from an undeclared one. Restore the export, or delete this gate deliberately rather than letting it pass vacuously.']
  }
  const injected = new Set([...declared[1].matchAll(/['"]([^'"]+)['"]/gu)].map(m => m[1]))
  const allowed = new Set([...injected, ...CONTEXT_BUILTINS])

  for (const rel of hostSourceFiles(root)) {
    const raw = readText(root, rel)
    if (raw === undefined) continue
    violations.push(...scanProblems(rel, raw))
    const exempt = exemptionsIn(raw, 'service-reads')
    for (const at of exempt.malformed) {
      violations.push(
        `${rel}:${at.replace('line ', '')}: a \`gate-exempt: service-reads\` comment carries no usable reason. `
        + 'An exemption without one is unsigned; write what makes this read safe (at least a few words), or remove the comment.',
      )
    }
    const source = stripCommentsAndStrings(raw)
    const lineOf = lineLookup(source)
    // Optional chaining is matched too: `ctx?.settings` throws exactly as
    // `ctx.settings` does, and is the more natural modern spelling of the
    // historical bug.
    for (const hit of source.matchAll(/\bctx\s*\??\.\s*([A-Za-z_$][\w$]*)/gu)) {
      const prop = hit[1]
      if (allowed.has(prop)) continue
      // `isSpecialProperty` short-circuits `_`-prefixed names, and anything on
      // Object.prototype is found by `Reflect.has` before the service lookup
      // runs — neither can throw, so neither is this gate's business.
      if (prop.startsWith('_') || Object.hasOwn(Object.prototype, prop)) continue
      const line = lineOf(hit.index)
      if (exempt.lines.has(line)) continue
      violations.push(
        `${rel}:${line}: \`ctx.${prop}\` reads a service that is not in \`inject\` (${[...injected].join(', ') || 'none'}). `
        + `The property accessor throws \`cannot get property "${prop}" without inject\` before any fallback beside it can run, and an enclosing catch turns that into "nothing configured" for every call. `
        + `Use \`ctx.get('${prop}')\`, or sign the line with \`// gate-exempt: service-reads <reason>\`.`,
      )
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// documentation gates
// ---------------------------------------------------------------------------

/**
 * Backticked tokens in prose, outside fenced code blocks.
 * @param {string} markdown - document text.
 * @returns {{token: string, line: number}[]} every inline-code token.
 */
function inlineCodeTokens(markdown) {
  // Blank fenced blocks, preserving lines: a command line inside ```sh is not
  // a claim about this repository's contents.
  // Fences are matched line-anchored, and an unclosed opener runs to the end.
  // A lone ``` inside a sentence used to blank everything up to the next one,
  // hiding whatever claims lived in between.
  const prose = markdown.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1\2[^\n]*$|$)/gmu, block => block.replace(/[^\n]/gu, ' '))
  const lineOf = lineLookup(prose)
  const tokens = []
  for (const hit of prose.matchAll(/`([^`\n]+)`/gu)) {
    tokens.push({ token: hit[1], line: lineOf(hit.index) })
  }
  return tokens
}

/** @param {string} name - a document name. @returns {boolean} whether it is checked. */
function isCheckedDoc(name) {
  // CLAUDE.md is a symlink to AGENTS.md; reading both double-reports every
  // finding and every exemption in one file.
  return name.endsWith('.md') && name !== 'CLAUDE.md'
}

/**
 * Every document the two documentation gates judge.
 *
 * `notes/` is included, not just the root. Those files are where the incident
 * stories and the design rationale were moved TO, they are dense with
 * cross-references and harness citations, and an archive nothing checks is
 * exactly the kind of document that quietly stops being true.
 * @param {string} root - checkout to scan.
 * @returns {string[]} repo-relative paths, sorted.
 */
export function checkedDocs(root) {
  const docs = listDir(root, '.').filter(isCheckedDoc)
  for (const file of walk(join(root, 'notes'), /\.md$/u)) {
    docs.push(relative(root, file).split(sep).join('/'))
  }
  return docs
}

/**
 * Every backticked path in the checked documents must resolve — here, or in
 * the harness for `packages/…` citations.
 *
 * This is the "fabricated reference" failure mode: an agent writes a confident
 * path that has never existed. Tokens that are neither repository paths nor
 * harness paths (`settings.yaml`, `$DSH_HOME/...` — things that exist at
 * runtime, not in the tree) are prose and are left alone.
 * @param {string} root - checkout to scan.
 * @param {string|undefined} harnessRoot - harness checkout, when reachable.
 * @returns {string[]} one message per violation.
 */
export function collectDocRefViolations(root, harnessRoot) {
  const violations = []
  let unverified = 0
  for (const name of checkedDocs(root)) {
    const text = readText(root, name)
    if (text === undefined) continue
    const exempt = exemptionsIn(text, 'doc-refs', 'md')
    for (const { token, line } of inlineCodeTokens(text)) {
      if (exempt.lines.has(line)) continue
      // `src/index.js:148` is a citation, not prose: strip the locator before
      // deciding, or every gate-friendly `path:line` reference goes unchecked.
      const bare = token.replace(/:\d+(?:-\d+)?$/u, '')
      if (!PATH_EXTENSIONS.test(bare) && !ROOT_FILES.has(bare)) continue
      if (/[\s(){}<>*?|]/u.test(bare)) continue
      // `$DSH_HOME/settings.yaml` names a path that exists at runtime, under a
      // directory this checkout does not contain. Interpolation marks it.
      if (bare.includes('$')) continue

      if (bare.startsWith('packages/') || bare.startsWith('vendor/')) {
        if (harnessRoot === undefined) { unverified++; continue }
        if (existsSync(join(harnessRoot, bare))) continue
        violations.push(
          `${name}:${line}: \`${token}\` does not exist in the harness checkout at ${harnessRoot}. `
          + 'A citation that cannot be opened is worse than none — the next reader trusts it. '
          + 'Re-open the file and cite the real path.',
        )
        continue
      }
      let rel = bare
      if (!bare.includes('/') && /^[\w.-]+\.test\.js$/u.test(bare)) rel = join('test', bare)
      if (!bare.includes('/') && !ROOT_FILES.has(bare) && rel === bare) continue
      if (existsSync(join(root, rel))) continue
      violations.push(
        `${name}:${line}: \`${token}\` does not exist in this checkout. `
        + 'Documents are read as fact by the next agent, and a path that resolves to nothing sends it looking. '
        + 'Cite a real path, or drop the backticks if the token is prose.',
      )
    }

    // Markdown link targets, checked the same way. Backticked paths were the
    // only thing this gate saw at first, so `[见这里](notes/nope.md)` — the
    // form AGENTS.md was told to use INSTEAD of "see item 3 above", precisely
    // because a link is checkable — went unchecked. A dead link in an
    // instruction file is worse than the prose it replaced.
    const lineOf = lineLookup(text)
    for (const hit of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/gu)) {
      const target = hit[1]
      if (/^(https?:|mailto:|#)/u.test(target)) continue
      const line = lineOf(hit.index)
      if (exempt.lines.has(line)) continue
      const [path] = target.split('#')
      if (path.length === 0) continue
      if (existsSync(join(root, dirname(name), path))) continue
      violations.push(
        `${name}:${line}: the link target \`${target}\` resolves to nothing. `
        + 'A relative link is the checkable form of a cross-reference — that is the whole reason to prefer it over "see the section above" — '
        + 'so a broken one gives up the guarantee while looking like it kept it. '
        + 'Fix the path, or make it prose again.',
      )
    }
  }
  if (unverified > 0) violations.push(harnessUnreachable('doc-refs', unverified))
  return violations
}

/**
 * Every backticked identifier in the checked documents must appear in some
 * source file — here or in the harness.
 *
 * Only two unambiguous shapes are judged: `Name.member` / `Name` in
 * CapitalCase, and `name()`. Everything else (`catch`, `model`, `wham/usage`)
 * is prose and is left alone.
 *
 * This gate exists because AGENTS.md shipped `SettingsRuntime.register`, a
 * class that has never existed under either name in either tree; the real one
 * is `SettingsProvider`. The mechanism around it was described correctly,
 * which is exactly why no reader caught it.
 *
 * Local sources are searched with comments stripped. Otherwise the gate is
 * satisfied by writing the invented name into a comment — "this used to be
 * called SettingsRuntime" — which resolves the citation without making it
 * true. The harness half uses the same whole-word test as the local half; a
 * substring test let `SettingsProv` resolve against `SettingsProvider`.
 * @param {string} root - checkout to scan.
 * @param {string|undefined} harnessRoot - harness checkout, when reachable.
 * @returns {string[]} one message per violation.
 */
export function collectDocSymbolViolations(root, harnessRoot) {
  const wanted = []
  for (const name of checkedDocs(root)) {
    const text = readText(root, name)
    if (text === undefined) continue
    const exempt = exemptionsIn(text, 'doc-symbols', 'md')
    for (const { token, line } of inlineCodeTokens(text)) {
      if (exempt.lines.has(line)) continue
      if (PATH_EXTENSIONS.test(token)) continue
      const symbol = /^([A-Z][A-Za-z0-9]*)(?:\.[A-Za-z_$][\w$]*)?$/u.exec(token)
        ?? /^([a-z_$][\w$]*)\(\)$/u.exec(token)
      if (symbol === null) continue
      if (PLATFORM_GLOBALS.has(symbol[1])) continue
      wanted.push({ doc: name, line, token, identifier: symbol[1] })
    }
  }
  if (wanted.length === 0) return []

  const local = walk(join(root, 'src'), /\.(js|mjs)$/u)
    .map((file) => {
      try {
        // Comments AND string bodies: an error message reading
        // `throw new Error('SettingsRuntime rejected the section')` used to
        // legitimize the very name this gate exists to catch.
        return stripCommentsAndStrings(readFileSync(file, 'utf8'))
      } catch {
        // A broken symlink under src/ used to abort the entire run: this was
        // the only readFileSync in the file outside a guard.
        return ''
      }
    })
    .join('\n')
  const unresolved = wanted.filter(item => !wholeWord(item.identifier).test(local))
  if (unresolved.length === 0) return []
  if (harnessRoot === undefined) return [harnessUnreachable('doc-symbols', unresolved.length)]

  const names = new Set(unresolved.map(item => item.identifier))
  const found = new Set()
  for (const file of walk(join(harnessRoot, 'packages'), /\.ts$/u, ['node_modules', 'lib'])) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const code = stripCommentsAndStrings(text)
    for (const identifier of names) {
      if (found.has(identifier)) continue
      if (wholeWord(identifier).test(code)) found.add(identifier)
    }
    if (found.size === names.size) break
  }
  return unresolved
    .filter(item => !found.has(item.identifier))
    .map(item =>
      `${item.doc}:${item.line}: \`${item.token}\` names \`${item.identifier}\`, which appears in no source file here or in the harness. `
      + 'A described mechanism can be right while its name is invented, and the name is what the next reader greps for. '
      + 'Re-open the file and cite the real name.',
    )
}

// ---------------------------------------------------------------------------
// gate: identity
// ---------------------------------------------------------------------------

/**
 * Collect the string leaves of an `exports`-shaped value.
 *
 * `exports` is legally a bare string, an object of subpaths, or nested
 * condition objects. `Object.values` over the bare-string form yields one
 * character per position, which produced a violation per character.
 * @param {unknown} value - a string, an array, or nested objects.
 * @param {string[]} [out] - accumulator.
 * @returns {string[]} every declared path.
 */
function exportPaths(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const entry of value) exportPaths(entry, out)
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) exportPaths(entry, out)
  return out
}

/**
 * The plugin's own name is spelled in four places and none of the four is
 * derived from the others; `npm test` has to be the command that runs these
 * gates; and `CLAUDE.md` has to be the link, not a second copy or nothing.
 *
 * The docstring in `src/index.js` already states the name contract — the
 * plugin name is also the composition entry id and the key the browser card
 * registers under, and the Settings tab dispatches a card only to the
 * namespace it names. This makes that prose executable: editing
 * `export const name` alone leaves the whole suite green.
 *
 * One thing this gate must NOT claim: the loader imports the composition
 * entry's `name:`, not its `id:`, so a drifted `id` does not stop the
 * composition from loading. It breaks the card dispatch, which is what the
 * message says.
 * @param {string} root - checkout to scan.
 * @returns {string[]} one message per violation.
 */
export function collectIdentityViolations(root) {
  const violations = []
  const index = readText(root, 'src/index.js')
  const client = readText(root, 'src/client.js')
  const patch = readText(root, 'cordis.patch.yml')
  if (index === undefined || client === undefined || patch === undefined) {
    return ['identity: one of src/index.js, src/client.js, cordis.patch.yml is missing, so nothing can be compared. Run from a checkout root.']
  }
  const parsed = parseObject(readText(root, 'package.json'), 'package.json')
  if ('error' in parsed) return [parsed.error]
  const manifest = parsed.value

  /**
   * @param {string} text - source to search.
   * @param {RegExp} pattern - one capturing group.
   * @param {string} where - human location for the failure message.
   * @returns {string|undefined} the captured value, or nothing (loudly).
   */
  const capture = (text, pattern, where) => {
    const hit = pattern.exec(text)
    if (hit !== null) return hit[1].replace(/^['"]|['"]$/gu, '')
    violations.push(
      `${where}: this gate could not find the value it compares (pattern ${pattern.source}). `
      + 'A gate that cannot locate its anchor must fail, not pass quietly — a silent skip here is how four spellings drift apart unnoticed. '
      + 'Restore the declaration, or update this pattern in scripts/check.mjs.',
    )
    return undefined
  }

  // YAML comments are stripped before capture, and both quote styles are
  // accepted on both sides: `id: x  # why` and a Prettier run that rewrites
  // `'x'` to `"x"` are ordinary edits, not drift.
  const yaml = patch.replace(/#.*$/gmu, '')
  const source = stripComments(index)
  const pluginName = capture(source, /export\s+const\s+name\s*=\s*['"]([^'"]+)['"]/u, 'src/index.js `export const name`')
  const namespace = capture(source, /settingsNamespace\(\s*['"]([^'"]+)['"]\s*\)/u, 'src/index.js `settingsNamespace(...)`')
  const clientNs = capture(stripComments(client), /SETTINGS_NS\s*=\s*['"]([^'"]+)['"]/u, 'src/client.js `SETTINGS_NS`')
  const entryId = capture(yaml, /^\s*-?\s*id:\s*(\S+)\s*$/mu, 'cordis.patch.yml `id:`')
  const entryName = capture(yaml, /^\s*name:\s*(\S+)\s*$/mu, 'cordis.patch.yml `name:`')

  if (pluginName !== undefined) {
    const spellings = [
      { value: namespace, where: 'src/index.js `settingsNamespace(...)`' },
      { value: clientNs, where: 'src/client.js `SETTINGS_NS`' },
      { value: entryId, where: 'cordis.patch.yml `id:`' },
    ]
    for (const { value, where } of spellings) {
      if (value === undefined || value === pluginName) continue
      violations.push(
        `${where}: spells "${value}" while src/index.js \`export const name\` spells "${pluginName}". `
        + 'These four are one identity: the Settings tab dispatches a card only to the namespace it names, so a drift here makes the card silently never arrive. '
        + "(The loader imports the entry's `name:`, not its `id:`, so the composition still loads — which is why the suite stays green.) "
        + 'Make all four agree.',
      )
    }
  }

  if (entryName !== undefined && entryName !== manifest.name) {
    violations.push(
      `cordis.patch.yml \`name:\`: is "${entryName}" but package.json \`name\` is "${manifest.name}". `
      + "This one is a real contract: the loader treats the entry's `name` as the module specifier it imports (vendor/loader/src/config/entry.ts). "
      + 'A mismatch means the composition imports a package that is not this one.',
    )
  }

  // The gates are only a gate if the command everyone runs is the one that
  // runs them. Rewriting this single value makes all eight disappear while
  // `npm test` keeps printing a full green suite — the cheapest total bypass
  // in the repository, and the one nothing else can see.
  // Containment, not equality: `node scripts/check.mjs && node scripts/lint.mjs`
  // still runs every gate, and refusing it would make the remedy "delete your
  // lint step". What must not happen is the command ceasing to run the gates
  // at all.
  const testScript = manifest.scripts?.test
  const runsGates = typeof testScript === 'string'
    && new RegExp(`(^|&&|;|\\|\\|)\\s*node\\s+\\.?/?${TEST_COMMAND.replace('node ', '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(\\s|$)`, 'u').test(testScript)
    && !testScript.includes('--only=')
  if (!runsGates) {
    violations.push(
      `package.json: \`scripts.test\` is ${JSON.stringify(testScript)}, which does not run \`${TEST_COMMAND}\`. `
      + '`npm test` is the only command AGENTS.md tells anyone to run, so a value that does not reach this file silently removes all eight gates — '
      + 'and the bare test runner it usually gets pointed at reports success even when whole suites were skipped. '
      + 'Add the command back (chaining more after it is fine), or update TEST_COMMAND in scripts/check.mjs.',
    )
  }

  for (const declared of [...exportPaths(manifest.exports), ...exportPaths(manifest.bin), ...exportPaths(manifest.files)]) {
    const rel = declared.replace(/^\.\//u, '')
    if (existsSync(join(root, rel))) continue
    violations.push(
      `package.json: declares "${declared}", which does not exist in this checkout. `
      + "npm resolves these at install time in the consumer's tree, so the failure surfaces on someone else's machine. "
      + 'Add the file or drop the entry.',
    )
  }

  let link
  try {
    const stats = lstatSync(join(root, 'CLAUDE.md'))
    link = stats.isSymbolicLink() ? readlinkSync(join(root, 'CLAUDE.md')) : null
  } catch {
    link = undefined
  }
  if (link !== 'AGENTS.md') {
    violations.push(
      `CLAUDE.md: ${link === undefined ? 'is missing' : 'must be a symbolic link to AGENTS.md, not a copy'}. `
      + 'It is the file a Claude Code session loads; without it those sessions start with no instructions at all, and a copy would drift from the original. '
      + 'Run: rm -f CLAUDE.md && ln -s AGENTS.md CLAUDE.md',
    )
  }
  return violations
}

// ---------------------------------------------------------------------------
// gate: deps
// ---------------------------------------------------------------------------

/**
 * Every bare specifier imported by the host sources, the tests, or the gate
 * scripts must be declared in some dependency field of package.json.
 *
 * Two deliberate scope decisions, each a review finding rather than an
 * oversight:
 *
 *  - `src/client.js` is skipped (see {@link hostSourceFiles}). Writing `react`
 *    into `peerDependencies` would make every profile that installs this
 *    plugin demand React for no reason. The same invariant is already pinned
 *    harder by `test/client.test.js`, which asserts the exact required set.
 *  - ANY dependency field satisfies this gate. Two of the specifiers are
 *    test-time only, and `peerDependencies` means "the host must provide
 *    this"; forcing them into the wrong field would trade a missing
 *    declaration for a false one.
 * @param {string} root - checkout to scan.
 * @returns {string[]} one message per violation.
 */
export function collectDeclaredDepViolations(root) {
  const violations = []
  const parsed = parseObject(readText(root, 'package.json'), 'package.json')
  if ('error' in parsed) return [parsed.error]
  const manifest = parsed.value
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])

  const files = [...hostSourceFiles(root)]
  for (const dir of ['test', 'scripts']) {
    for (const file of walk(join(root, dir), /\.(js|mjs)$/u)) {
      files.push(relative(root, file).split(sep).join('/'))
    }
  }

  for (const rel of files) {
    const raw = readText(root, rel)
    if (raw === undefined) continue
    violations.push(...scanProblems(rel, raw))
    const exempt = exemptionsIn(raw, 'deps')
    // Two views of the same offsets. The import SHAPE is matched against the
    // text with literal bodies blanked, so fixture source embedded in a string
    // — `test/check.test.js` is full of it — is not read as a real edge. The
    // specifier is then sliced out of the comments-only view at the very same
    // offsets. Both views come from one classification, so both are exactly as
    // long as the input; that is what makes the pairing safe.
    //
    // A JSDoc `import('pkg')` annotation lives in a comment and is gone from
    // both views: a type reference is not a resolution edge.
    const shape = stripCommentsAndStrings(raw)
    const source = stripComments(raw)
    const lineOf = lineLookup(source)
    const patterns = [
      /\bfrom\s*(['"])([^'"]*)\1/gu,
      // A side-effect import has no `from`, and a dynamic import may use a
      // template literal. Both resolve at runtime; both used to be invisible.
      /\bimport\s*(['"])([^'"]*)\1/gu,
      /\bimport\s*\(\s*(['"`])([^'"`]*)\1\s*\)/gu,
      /\brequire\s*\(\s*(['"`])([^'"`]*)\1\s*\)/gu,
    ]
    for (const pattern of patterns) {
      for (const hit of shape.matchAll(pattern)) {
        const start = hit.index + hit[0].indexOf(hit[1]) + 1
        const specifier = source.slice(start, start + hit[2].length)
        if (/^[./]/u.test(specifier) || specifier.startsWith('node:') || specifier.startsWith('#')) continue
        const pkg = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]
        if (pkg.length === 0 || declared.has(pkg)) continue
        const line = lineOf(hit.index)
        if (exempt.lines.has(line)) continue
        violations.push(
          `${rel}:${line}: imports \`${pkg}\`, which no dependency field in package.json declares. `
          + 'It resolves here only because node_modules is a symlink into a shared profile tree; anyone who follows the manifest cannot run this file at all, '
          + 'and a skip guard would make that invisible rather than loud. '
          + 'Declare it, or sign the line with `// gate-exempt: deps <reason>`.',
        )
      }
    }
  }
  return [...new Set(violations)]
}

// ---------------------------------------------------------------------------
// gate: image-budget
// ---------------------------------------------------------------------------

/** The call whose argument is the hand-rolled profile. */
const PROFILE_BUILDER = 'createProfilesThunk'

/** The three fields a hand-rolled pi-ai profile has to carry together. */
const IMAGE_BUDGET_FIELDS = ['maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes']

/**
 * The hand-rolled pi-ai profile must set all three image budget fields, close
 * together, to real values.
 *
 * AGENTS.md trap 3. Omitting one does NOT fall back to a host default: the
 * adapter always builds `{ maxPixels, maxBytes }` out of the profile, so a
 * missing field travels down as `undefined`, `Math.min(bytes, undefined)` is
 * `NaN`, every budget comparison fails, and every image in the request is
 * replaced by a text placeholder. Nothing throws.
 *
 * The VALUES are checked, not just the keys. Writing
 * `requestImageMaxBytes: undefined` is the exact state the trap describes, and
 * a key-only check waves it through — it did.
 *
 * This is a BACKSTOP. The real assertion is in `test/adapter.test.js`, which
 * runs the harness's own offload function over a real profile and asserts the
 * image is still an image afterwards. That is strictly stronger. But it needs
 * the peer dependencies and is skipped in a bare checkout, which is where this
 * text-level check earns its keep. Do NOT let this one replace it.
 * @param {string} root - checkout to scan.
 * @returns {string[]} one message per violation.
 */
export function collectImageBudgetViolations(root) {
  const adapter = readText(root, 'src/adapter.js')
  if (adapter === undefined) {
    return ['src/adapter.js: absent, so the profile this gate reads does not exist. A gate whose subject is missing must fail rather than pass vacuously.']
  }
  const source = stripComments(adapter)

  // Anchor on the call that builds the profile, and balance its parentheses,
  // rather than searching the file for each field name. Searching the file
  // finds the FIRST occurrence of each, so a reference object anywhere above —
  // `const IMAGE_BUDGET_REFERENCE = { …all three… }` — satisfies the gate
  // while the real profile is missing a field. That decoy got past the first
  // version of this check.
  const calls = []
  for (const hit of source.matchAll(new RegExp(`(function\\s+)?\\b${PROFILE_BUILDER}\\s*\\(`, 'gu'))) {
    // The declaration is not a call; only its invocations carry a profile.
    if (hit[1] !== undefined) continue
    let depth = 0
    let end = hit.index
    for (let i = source.indexOf('(', hit.index); i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    calls.push({ line: lineLookup(source)(hit.index), text: source.slice(hit.index, end + 1) })
  }
  if (calls.length === 0) {
    return [
      `src/adapter.js: no call to \`${PROFILE_BUILDER}\` found, so the profile this gate reads does not exist. `
      + 'A gate that cannot locate its anchor must fail rather than pass quietly. '
      + 'Restore the call, or update PROFILE_BUILDER in scripts/check.mjs.',
    ]
  }

  /**
   * Follow one level of `const NAME = value`, so that a budget moved into a
   * named constant is still judged by its value.
   * @param {string} value - the text after the colon.
   * @returns {string} the value, or what the constant it names is bound to.
   */
  const resolved = (value) => {
    if (!/^[A-Za-z_$][\w$]*$/u.test(value)) return value
    const binding = new RegExp(`\\b(?:const|let|var)\\s+${value}\\s*=\\s*([^\\n;]*)`, 'u').exec(source)
    return binding === null ? value : binding[1].trim()
  }

  const violations = []
  // Every call site is judged on its own. Joining them let a second, unrelated
  // profile supply the fields a first one was missing.
  for (const call of calls) {
    const assignments = IMAGE_BUDGET_FIELDS.map((field) => {
      const hit = new RegExp(`\\b${field}\\s*:\\s*([^,\\n}]*)`, 'u').exec(call.text)
      return { field, value: hit === null ? undefined : hit[1].trim() }
    })
    const missing = assignments.filter(entry => entry.value === undefined)
    if (missing.length > 0) {
      violations.push(
        `src/adapter.js:${call.line}: the profile passed to \`${PROFILE_BUILDER}\` does not set ${missing.map(entry => `\`${entry.field}\``).join(' and ')}. `
        + 'An omitted budget field is not a host default — it travels down as `undefined`, `Math.min(bytes, undefined)` is `NaN`, '
        + 'and every image in the request is silently replaced by a text placeholder. '
        + 'Set all three together; the defaults are in `packages/llm/llm-pi-ai/src/config.ts` (2048² pixels, 1 MiB).',
      )
      continue
    }
    const empty = assignments.filter((entry) => {
      const value = resolved(entry.value)
      return value === 'undefined' || value === 'null' || value.length === 0
    })
    if (empty.length > 0) {
      violations.push(
        `src/adapter.js:${call.line}: \`${empty.map(entry => entry.field).join('` and `')}\` resolves to \`${resolved(empty[0].value) || 'nothing'}\`. `
        + 'That is the trap itself rather than a way around it: the field still reaches `Math.min(bytes, undefined)`, the comparison still yields `NaN`, '
        + 'and every image is still replaced by a text placeholder, with no error anywhere. '
        + 'Give it a real budget.',
      )
    }
  }
  return violations
  return []
}

// ---------------------------------------------------------------------------
// gate: catalog-wording
// ---------------------------------------------------------------------------

/**
 * The user-facing description of the model allowlist must say that it narrows
 * the advertised catalog, not just the picker.
 *
 * AGENTS.md trap 4: `listModels` is what the harness answers EVERY catalog
 * reader from — `buildModelCatalog` in the API gateway backs the `models` RPC
 * behind every host-side model list — so a model unchecked here
 * disappears from those enumerations too. An edit that softened the
 * description back to "the model picker" would be a documentation regression
 * with a support cost.
 *
 * An earlier version of this gate required the token `/v1/models`. That
 * endpoint does not exist: the harness registers no such route, and every
 * occurrence of the string in that tree is the harness acting as a CLIENT
 * against an upstream provider. It had been inherited from AGENTS.md and
 * copied into the user-visible description, and pinning it here would have
 * held a fabrication in place — the same failure as `SettingsRuntime`, one
 * step worse for reaching the interface. The required tokens are now ones
 * that are true: `catalog` in the description, and `listModels` in the README.
 * (`doc-symbols` does NOT independently confirm `listModels` — a bare
 * lowercase identifier matches neither shape it judges. This gate pins the
 * string; nothing pins the symbol behind it.)
 *
 * The schema half reads the description STRING, not the file and not the
 * surrounding chain. Checking the file passes on the token appearing in a
 * nearby comment; checking the chain passes on a sibling `.role('…')` carrying
 * it. Both were observed while red-testing this gate.
 * @param {string} root - checkout to scan.
 * @returns {string[]} one message per violation.
 */
export function collectCatalogWordingViolations(root) {
  const violations = []

  const index = readText(root, 'src/index.js')
  if (index === undefined) {
    violations.push('src/index.js: absent, so the description this gate reads does not exist. Run from a checkout root.')
  } else {
    const region = /enabledModels:\s*([\s\S]*?)(?:\n {2}\w|\n\}\))/u.exec(stripComments(index))
    const description = region === null
      ? null
      : /\.description\(\s*(['"])([\s\S]*?)\1\s*\)/u.exec(region[1])
    if (description === null) {
      violations.push(
        `src/index.js: no ${region === null ? '`enabledModels:` schema field' : '`.description(...)` on `enabledModels`'} found, so the text this gate reads does not exist. `
        + 'A gate that cannot locate its anchor must fail rather than pass quietly. '
        + 'Restore it, or update the pattern in scripts/check.mjs.',
      )
    } else if (!description[2].includes('catalog')) {
      violations.push(
        'src/index.js: the `enabledModels` schema `.description()` no longer says `catalog`. '
        + 'The Settings card renders that string verbatim, and it is the only place a user learns that this allowlist narrows the advertised catalog '
        + 'rather than just the model picker — unchecking a model removes it from every list the harness answers, and finding that out afterwards is a '
        + 'support call. Say it in the description itself; a comment nearby, or a sibling call in the same chain, does not reach the user.',
      )
    }
  }

  const readme = readText(root, 'README.md')
  if (readme === undefined) {
    violations.push(
      'README.md: absent, so half of what this gate claims to check does not exist. '
      + 'A summary line naming a file that is not there is the exact failure the other seven collectors are written against.',
    )
  } else if (!readme.includes('listModels')) {
    violations.push(
      'README.md: does not mention `listModels` anywhere. It is where a reader learns what the allowlist does, and the reason it reaches every '
      + 'model list is that the harness answers all of them from that one call. Name the mechanism, so the claim stays checkable.',
    )
  }
  return violations
}

// ---------------------------------------------------------------------------
// gate: doc-budget
// ---------------------------------------------------------------------------

/**
 * The documents an agent reads every session have a ceiling, and it is counted
 * in code points.
 *
 * An instruction file is read in full at the start of every session, and what
 * an agent can hold is finite: the longer the file, the more reliably the
 * rules at the bottom of it are the ones that get skipped. So length is an
 * engineering property here, not a matter of taste, and it belongs in a gate
 * rather than in a reviewer's memory — this repository already tried the
 * reviewer, and `AGENTS.md` reached 9626 characters with six full incident
 * narratives inside it.
 *
 * Code points, NOT `wc -w`. These documents are Chinese; `wc -w` counts
 * whitespace-separated runs, so it reads a whole paragraph as a handful of
 * words and swings about 8% with the locale on identical bytes. A word budget
 * copied from an English repository would simply never trip.
 *
 * A budgeted file that does not exist is a violation, not a pass: the usual
 * way a document stops being over budget is that someone deleted it.
 * @param {string} root - checkout to scan.
 * @returns {string[]} one message per violation.
 */
export function collectDocBudgetViolations(root) {
  const parsed = parseObject(readText(root, 'scripts/budgets.json'), 'scripts/budgets.json')
  if ('error' in parsed) return [parsed.error]
  const budgets = parsed.value.files
  if (budgets === null || typeof budgets !== 'object' || Array.isArray(budgets) || Object.keys(budgets).length === 0) {
    return [
      'scripts/budgets.json: `files` is missing or empty, so this gate has nothing to enforce and would pass vacuously. '
      + 'Give it at least one `{ "<path>": { "limit": <number>, "why": "<reason>" } }` entry.',
    ]
  }

  const violations = []
  for (const [rel, budget] of Object.entries(budgets)) {
    const limit = budget?.limit
    if (!Number.isInteger(limit) || limit <= 0) {
      violations.push(
        `scripts/budgets.json: the ceiling for \`${rel}\` is ${JSON.stringify(limit)}, not a positive whole number, so nothing is enforced for it.`,
      )
      continue
    }
    const text = readText(root, rel)
    if (text === undefined) {
      violations.push(
        `${rel}: is budgeted at ${limit} characters but does not exist. `
        + 'A budgeted document that vanished is the cheapest way to be under budget, so this is a failure rather than a pass. '
        + 'Restore the file, or remove its entry from scripts/budgets.json in the same change that deletes it.',
      )
      continue
    }
    const size = [...text].length
    if (size <= limit) continue
    violations.push(
      `${rel}: ${size} characters, over its ${limit} ceiling by ${size - limit}. `
      + 'Handle it in this order — (1) MOVE anything that is not a standing order out: an incident story belongs in notes/postmortems/, '
      + 'a design rationale in notes/implemented/, a gate mechanism in that collector\'s header comment; '
      + '(2) COMPRESS what is left; (3) only then RAISE the ceiling in scripts/budgets.json, and write the reason into its `why`. '
      + 'Raising it first is how a file everyone is supposed to read stops being read.',
    )
  }
  return violations
}

// ---------------------------------------------------------------------------
// gate: verify-workflow
// ---------------------------------------------------------------------------

/**
 * Split a workflow into its top-level jobs.
 *
 * Two-space keys under `jobs:` start a job; anything more deeply indented
 * belongs to it. Enough structure to ask a question about one job without
 * pulling in a YAML parser, and no more.
 * @param {string} text - workflow source.
 * @returns {{name: string, index: number, body: string}[]} one entry per job.
 */
function jobBlocks(text) {
  const start = /^jobs:\s*$/mu.exec(text)
  if (start === null) return []
  const rest = text.slice(start.index + start[0].length)
  const heads = [...rest.matchAll(/^ {2}([A-Za-z_][\w-]*):\s*$/gmu)]
  return heads.map((head, i) => ({
    name: head[1],
    index: start.index + start[0].length + head.index,
    body: rest.slice(head.index, i + 1 < heads.length ? heads[i + 1].index : rest.length),
  }))
}

/**
 * The CI workflow keeps the properties that stop it reporting a false green.
 *
 * String-level checks, no YAML parser: the properties worth pinning are the
 * presence or absence of four literal strings, and pulling in a parser to
 * assert four strings would be more moving parts than the thing it checks.
 *
 * Each rule is the GitHub-layer version of a failure this repository already
 * had one layer down:
 *
 *  - `continue-on-error` turns a red job green while leaving it looking like
 *    it ran. Nothing else here can see that.
 *  - a required job that does not run `if: always()` is SKIPPED when an
 *    upstream job fails, and branch protection counts a skipped job as a pass
 *    — the same "a skip is not a pass" hole as the suite gate, one layer up.
 *  - `persist-credentials: false` keeps a token off the runner's disk when
 *    nothing in the job reads history.
 *  - an explicit `permissions:` block stops the job inheriting whatever the
 *    repository default happens to be later.
 *
 * The workflow being ABSENT is not a violation: this repository ran with no CI
 * at all for its whole life, and "local is the only gate" is a documented
 * position rather than an oversight. What is checked is a workflow that exists
 * and has quietly lost one of these.
 * @param {string} root - checkout to scan.
 * @returns {string[]} one message per violation.
 */
export function collectWorkflowViolations(root) {
  const violations = []
  for (const file of walk(join(root, '.github', 'workflows'), /\.ya?ml$/u)) {
    const rel = relative(root, file).split(sep).join('/')
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lineOf = lineLookup(text)
    for (const hit of text.matchAll(/continue-on-error/gu)) {
      violations.push(
        `${rel}:${lineOf(hit.index)}: uses \`continue-on-error\`, which turns a failing step green while leaving it looking like it ran. `
        + 'A check that cannot fail is not a check. Express "this one does not block" by leaving the job out of the required `needs` list instead.',
      )
    }
    if (!/^permissions:/mu.test(text)) {
      violations.push(
        `${rel}: declares no top-level \`permissions:\` block, so the job inherits whatever the repository default is — today, and after anyone changes it. `
        + 'Add `permissions:` with the narrowest set the job needs (`contents: read` here).',
      )
    }
    for (const hit of text.matchAll(/uses:\s*actions\/checkout@/gu)) {
      const line = lineOf(hit.index)
      const window = text.slice(hit.index, hit.index + 400)
      if (/persist-credentials:\s*false/u.test(window)) continue
      violations.push(
        `${rel}:${line}: \`actions/checkout\` does not set \`persist-credentials: false\`. `
        + 'Nothing in this workflow reads git history, and a token left in the runner\'s git config is one a later step — or a later edit — can pick up. '
        + 'Add it under `with:`.',
      )
    }
    // Per JOB, not per file. Asking whether `if: always()` appears anywhere
    // passes as soon as any step has it — this workflow has one on an
    // unrelated summary step, and the check went green with the property
    // removed from the job that needed it.
    for (const job of jobBlocks(text)) {
      if (!/^\s{4}needs:/mu.test(job.body)) continue
      if (/^\s{4}if:\s*always\(\)/mu.test(job.body)) continue
      violations.push(
        `${rel}:${lineOf(job.index)}: job \`${job.name}\` has \`needs:\` but no job-level \`if: always()\`. `
        + 'Without it the job is SKIPPED when an upstream job fails, and branch protection counts a skipped job as a pass — '
        + 'the same "a skip is not a pass" hole the suite gate exists for, one layer up. '
        + 'Give it `if: always()` and assert each dependency\'s `result` explicitly.',
      )
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// gate: suite
// ---------------------------------------------------------------------------

/**
 * Parse the counters and directives out of a TAP stream.
 * @param {string} tap - the reporter's stdout.
 * @returns {{counts: Record<string, number|null>, skipped: {name: string, reason: string}[], failedLines: number}} the parsed summary.
 */
export function parseTap(tap) {
  /** @param {string} label @returns {number|null} */
  const count = label => {
    const hit = new RegExp(`^# ${label} (\\d+)$`, 'mu').exec(tap)
    return hit === null ? null : Number(hit[1])
  }
  const skipped = []
  let failedLines = 0
  for (const line of tap.split('\n')) {
    const skip = /^\s*ok\s+\d+\s+-\s+(.+?)\s+#\s+SKIP\s*(.*)$/u.exec(line)
    if (skip !== null) skipped.push({ name: skip[1], reason: skip[2].trim() })
    if (/^\s*not ok\s+\d+\s/u.test(line)) failedLines++
  }
  return {
    counts: {
      tests: count('tests'),
      pass: count('pass'),
      fail: count('fail'),
      skipped: count('skipped'),
      todo: count('todo'),
      cancelled: count('cancelled'),
    },
    skipped,
    failedLines,
  }
}

/**
 * Run the suite and refuse to accept anything but a real, complete pass.
 *
 * Three independent mechanisms, because each alone is bypassable:
 *
 *  - ANY skip, todo, cancellation or `not ok` line fails. Costs nothing to
 *    maintain, and it is the only one that sees a suite newly gated off.
 *    `todo` matters as much as `skip`: `test('…', { todo: 'flaky' }, fn)`
 *    keeps running the test, keeps throwing, and reports `# fail 0` — one word
 *    per test defeats every other layer here.
 *  - The set of test FILES must equal the recorded one. Renaming
 *    `test/usage.test.js` to `test/usage.js` removes its tests and produces no
 *    skip line at all.
 *  - The executed count must equal the recorded one. Deleting individual tests
 *    from a file that still exists moves neither of the other two.
 *
 * The recorded count is the one number in this repository an agent can edit to
 * turn red into green. AGENTS.md says so, and says it may only change in the
 * same commit that adds or removes a test — and this gate refuses a `tests`
 * value that is not a whole number, because quoting it or deleting the key
 * would disable that comparison for good while the summary kept claiming it
 * had run.
 * @param {string} root - checkout to run in.
 * @returns {string[]} one message per violation.
 */
export function collectSuiteViolations(root, { bare = false } = {}) {
  const parsed = parseObject(readText(root, 'scripts/expected.json'), 'scripts/expected.json')
  if ('error' in parsed) return [parsed.error]
  const expected = parsed.value
  const violations = []

  if (!bare && !Number.isInteger(expected.tests)) {
    violations.push(
      `scripts/expected.json: \`tests\` is ${JSON.stringify(expected.tests)}, not a whole number, so the executed-count comparison cannot run. `
      + 'Quoting or deleting it disables that check permanently while every summary keeps claiming it happened. '
      + 'Set it to the number `npm run test:raw` reports.',
    )
  }
  if (!Array.isArray(expected.files)) {
    violations.push(
      `scripts/expected.json: \`files\` is ${JSON.stringify(expected.files)}, not an array, so a renamed or deleted test file cannot be detected.`,
    )
  }

  const actualFiles = listDir(root, 'test')
    .filter(name => name.endsWith('.test.js'))
    .map(name => name.slice(0, -'.test.js'.length))
  const expectedFiles = Array.isArray(expected.files) ? [...expected.files].sort() : []
  for (const name of expectedFiles.filter(entry => !actualFiles.includes(entry))) {
    violations.push(
      `test/${name}.test.js: recorded in scripts/expected.json but not present. `
      + 'A renamed or deleted test file takes every test in it away without producing a single skip line. '
      + 'Restore the file, or remove it from `files` in the same commit that deletes it.',
    )
  }
  for (const name of actualFiles.filter(entry => !expectedFiles.includes(entry))) {
    violations.push(
      `test/${name}.test.js: exists but is not recorded in scripts/expected.json. `
      + 'Add it to `files` so a later rename cannot remove it silently.',
    )
  }

  // `NODE_TEST_CONTEXT` is how a test runner tells a child it is a subtest:
  // inherit it and the child abandons TAP for the v8-serialized channel, this
  // parser sees no `# tests` line, and the gate reports a runner failure that
  // did not happen. It is inherited whenever check.mjs is run from a test —
  // which is exactly what test/check.test.js does.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_OPTIONS
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // Without this, one test that never settles hangs `npm test` forever, and
    // since the suite runs last the operator sees seven `ok` lines and then
    // nothing. A healthy run is about 16 seconds, so silence is ambiguous for
    // the first 16 of them; ten minutes is far past any real run.
    timeout: 10 * 60_000,
    killSignal: 'SIGKILL',
    env,
  })
  if (run.signal !== null && run.signal !== undefined) {
    return [
      `node --test was killed with ${run.signal} after the 10 minute timeout, so no result exists. `
      + 'Something did not settle — most often a test awaiting a promise nothing resolves, or a child process left running. '
      + 'Run `npm run test:raw` and watch which file stops producing output.',
    ]
  }
  const tap = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  const { counts, skipped, failedLines } = parseTap(tap)

  if (counts.tests === null) {
    violations.push(
      'node --test produced no `# tests` summary line, so nothing ran or the reporter changed. '
      + `Exit status was ${run.status}. Run \`npm run test:raw\` and read the output directly.`,
    )
    return violations
  }
  if ((counts.fail ?? 0) !== 0 || failedLines > 0) {
    violations.push(
      `${Math.max(counts.fail ?? 0, failedLines)} test(s) failed. Run \`npm run test:raw\` for the failures themselves; fix those before anything else here.`,
    )
  }
  const NOT_A_PASS = {
    skipped: 'a skipped test asserted nothing, and the runner counts it beside the ones that did',
    todo: 'a todo test keeps running and keeps throwing while the summary still says `# fail 0`',
    cancelled: 'a cancelled test stopped partway, so whatever it had not reached went unasserted',
  }
  for (const [label, value] of [['skipped', counts.skipped], ['todo', counts.todo], ['cancelled', counts.cancelled]]) {
    if (value === null || value === 0) continue
    violations.push(`${value} test(s) reported as ${label}: ${NOT_A_PASS[label]}.`)
  }
  for (const { name, reason } of skipped) {
    // In bare mode the four peer-dependency guards are the reason the suite
    // runs at all, so THEY are expected — but only they. Matching on the
    // reason rather than on a recorded list of suite names means CI needs no
    // second number to maintain, and a suite newly gated off for any other
    // reason ("flaky", "TODO", "broken on CI") is still caught.
    if (bare && PEER_SKIP_REASON.test(reason)) continue
    violations.push(
      `"${name}" was skipped (${reason || 'no reason given'})${bare ? ', and the reason is not a missing peer dependency' : ''}. `
      + 'A skipped `describe` subtree hides every test inside it and is counted in neither `# tests` nor `# skipped`, so the suite still reports success. '
      + (bare
        ? 'In bare mode the four peer-dependency guards are expected; nothing else is. Fix the test, or state the missing peer dependency as its reason.'
        : 'Make the dependency resolvable (`ln -s ~/.dsh/profiles/node_modules node_modules`) and run again.'),
    )
  }
  if (!bare && Number.isInteger(expected.tests) && counts.tests !== expected.tests) {
    violations.push(
      `${counts.tests} test(s) executed; scripts/expected.json records ${expected.tests}. `
      + 'If you added or removed tests, update that number in this same commit. '
      + `If you did not, ${counts.tests < expected.tests ? 'something stopped running' : 'something is running twice'} — find out what before changing the number.`,
    )
  }
  if (run.status !== 0 && violations.length === 0) {
    violations.push(`node --test exited ${run.status} with no failure the parser could name. Run \`npm run test:raw\`.`)
  }
  return violations
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

/** @param {string} root @returns {{path: string, kind: 'js'|'md'}[]} files that may carry an exemption. */
function exemptableFiles(root) {
  const files = []
  for (const rel of hostSourceFiles(root)) files.push({ path: rel, kind: 'js' })
  files.push({ path: 'src/client.js', kind: 'js' })
  for (const dir of ['test', 'scripts']) {
    for (const name of listDir(root, dir)) {
      if (/\.(js|mjs)$/u.test(name)) files.push({ path: `${dir}/${name}`, kind: 'js' })
    }
  }
  for (const name of checkedDocs(root)) files.push({ path: name, kind: 'md' })
  return files
}

/**
 * Every signed exemption in the checkout.
 * @param {string} root - checkout to scan.
 * @returns {string[]} one line per exemption, malformed ones included.
 */
export function listExemptions(root) {
  const ids = ['service-reads', 'deps', 'doc-refs', 'doc-symbols']
  const found = []
  for (const { path, kind } of exemptableFiles(root)) {
    const text = readText(root, path)
    if (text === undefined) continue
    for (const id of ids) {
      const { listed, malformed } = exemptionsIn(text, id, kind)
      for (const entry of listed) found.push(`${path} ${id} — ${entry}`)
      for (const entry of malformed) found.push(`${path} ${id} — ${entry}: NO USABLE REASON`)
    }
  }
  return found
}

/**
 * The gate list. Order is cheapest-first, so a run fails fast on the things
 * that take milliseconds and the suite (seconds) runs last.
 * @param {string} root - checkout to run against.
 * @returns {{id: string, run: () => string[], summary: () => string}[]} the gates.
 */
function gates(root, { bare = false } = {}) {
  const harness = harnessRootFor(root)
  const docs = checkedDocs(root)
  const harnessNote = harness === undefined
    ? 'no harness checkout reachable'
    : `harness citations checked against ${harness}`
  return [
    {
      id: 'identity',
      run: () => collectIdentityViolations(root),
      summary: () => 'identity: 4 name spellings, the loader contract, the `npm test` wiring, package.json exports/bin, the CLAUDE.md link — all agree. Proves nothing about whether the composition patch is semantically right.',
    },
    {
      id: 'service-reads',
      run: () => collectServiceReadViolations(root),
      summary: () => `service-reads: ${hostSourceFiles(root).length} file(s) scanned under src/** (client.js excluded — a browser module table, not a fiber). A syntactic fence: \`ctx['settings']\` and \`const c = ctx; c.settings\` both slip past it.`,
    },
    {
      id: 'deps',
      run: () => collectDeclaredDepViolations(root),
      summary: () => 'deps: every bare specifier in src/**, test/ and scripts/ is declared. Proves the manifest is honest, NOT that a fresh clone can `npm install` — it cannot; an unpublished transitive peer 404s.',
    },
    {
      id: 'image-budget',
      run: () => collectImageBudgetViolations(root),
      summary: () => `image-budget: ${IMAGE_BUDGET_FIELDS.length} fields set to real values inside the ${PROFILE_BUILDER} call itself. A bare-checkout backstop only — the real assertion is behavioural, in test/adapter.test.js, and this proves nothing about what the harness does with the numbers.`,
    },
    {
      id: 'catalog-wording',
      run: () => collectCatalogWordingViolations(root),
      summary: () => 'catalog-wording: the enabledModels description still says `catalog`, and the README still names `listModels`. Proves the token is in the text a user reads — not that the sentence around it is clear.',
    },
    {
      id: 'verify-workflow',
      run: () => collectWorkflowViolations(root),
      summary: () => {
        const files = walk(join(root, '.github', 'workflows'), /\.ya?ml$/u).length
        return files === 0
          ? 'verify-workflow: no workflow files — this repository has run with local gates only, which is a position rather than an oversight.'
          : `verify-workflow: ${files} workflow file(s); no continue-on-error, explicit permissions, checkout without credentials, a required job that runs on always(). Proves the shape, not that the job runs the right commands.`
      },
    },
    {
      id: 'doc-budget',
      run: () => collectDocBudgetViolations(root),
      summary: () => {
        const parsed = parseObject(readText(root, 'scripts/budgets.json'), 'budgets')
        const files = 'error' in parsed ? {} : parsed.value.files ?? {}
        const rows = Object.entries(files).map(([rel, budget]) => {
          const text = readText(root, rel)
          return `${rel} ${text === undefined ? '?' : [...text].length}/${budget?.limit}`
        })
        return `doc-budget: ${rows.join(', ')} (code points). Proves the files an agent reads every session still fit — not that what is in them is worth reading.`
      },
    },
    {
      id: 'doc-refs',
      run: () => collectDocRefViolations(root, harness),
      summary: () => `doc-refs: ${docs.length} document(s) scanned; ${harnessNote}. Proves the cited paths exist, not that they are the right ones.`,
    },
    {
      id: 'doc-symbols',
      run: () => collectDocSymbolViolations(root, harness),
      summary: () => `doc-symbols: ${docs.length} document(s) scanned; ${harnessNote}. Judges the CapitalCase head of \`Name.member\`, and \`name()\` — the member half is prose, and so is anything with the backticks removed.`,
    },
    {
      id: 'suite',
      run: () => collectSuiteViolations(root, { bare }),
      summary: () => {
        const files = listDir(root, 'test').filter(name => name.endsWith('.test.js')).length
        const parsed = parseObject(readText(root, 'scripts/expected.json'), 'expected')
        const recorded = 'error' in parsed ? '?' : parsed.value.tests
        return bare
          ? `suite (bare): ${files} recorded test file(s) all present; the only skips are the peer-dependency guards; nothing failed, todo or cancelled. The executed COUNT is not pinned here — it depends on which peers resolve — so this proves less than the full run does.`
          : `suite: ${recorded} test(s) across ${files} file(s), none skipped, todo or cancelled. Proves the tests RAN, not that they assert anything, and not that the untested paths are correct.`
      },
    },
  ]
}

/**
 * The gate ids a bare run executes, derived rather than listed.
 * @param {string} [root] - checkout to enumerate against.
 * @returns {string[]} gate ids, in run order.
 */
export function bareGateIds(root = REPO_ROOT) {
  return gates(root, { bare: true }).map(gate => gate.id).filter(id => !HARNESS_ONLY_GATES.includes(id))
}

/**
 * Every gate id.
 * @param {string} [root] - checkout to enumerate against.
 * @returns {string[]} gate ids, in run order.
 */
export function allGateIds(root = REPO_ROOT) {
  return gates(root).map(gate => gate.id)
}

/** Entry point. */
function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: node scripts/check.mjs [--bare] [--only=<gate>] [--exemptions]\n'
      + `gates: ${gates(REPO_ROOT).map(g => g.id).join(', ')}\n`
      + 'DSH_HARNESS_ROOT points at a deepseek-harness checkout so `packages/...` citations can be verified.')
    return
  }
  if (args.includes('--exemptions')) {
    const found = listExemptions(REPO_ROOT)
    for (const entry of found) console.log(entry)
    console.log(found.length === 0 ? 'no exemptions signed in this checkout' : `${found.length} exemption(s)`)
    return
  }
  // Bare mode: everything that needs neither a harness checkout nor a
  // resolvable node_modules tree — see .github/workflows/ci.yml.
  const bare = args.includes('--bare')
  const only = args.find(a => a.startsWith('--only='))?.slice('--only='.length)
  const all = gates(REPO_ROOT, { bare }).filter(gate => !bare || !HARNESS_ONLY_GATES.includes(gate.id))
  const selected = all.filter(gate => only === undefined || gate.id === only)
  if (selected.length === 0) {
    console.error(`no gate named "${only}". Known gates: ${all.map(g => g.id).join(', ')}`)
    process.exitCode = 1
    return
  }

  if (bare) {
    console.log(`mode bare: running ${all.length} of ${gates(REPO_ROOT).length} gates. `
      + `Left out: ${HARNESS_ONLY_GATES.join(', ')} — they verify \`packages/...\` citations against a deepseek-harness `
      + 'checkout and refuse to report green without one, and CI has none. Everything else runs here.')
  }
  let failed = 0
  for (const gate of selected) {
    const started = Date.now()
    const violations = gate.run()
    const ms = Date.now() - started
    if (violations.length === 0) {
      console.log(`ok   ${gate.summary()} (${ms}ms)`)
      continue
    }
    failed++
    console.log(`FAIL ${gate.id}: ${violations.length} violation(s) (${ms}ms)`)
    for (const violation of violations) console.log(`  - ${violation}`)
  }

  // An exemption may exist; it may not be quiet. Printing the ones in force
  // during the run everyone does is the difference between the two —
  // `--exemptions` is a flag nothing requires anyone to pass.
  const exemptions = listExemptions(REPO_ROOT)
  if (exemptions.length > 0) {
    console.log(`\nnote ${exemptions.length} signed exemption(s) in force:`)
    for (const entry of exemptions) console.log(`  - ${entry}`)
  }

  if (failed > 0) {
    console.log(`\n${failed} of ${selected.length} gate(s) failed. Nothing here is a style preference; each one is a failure this repository has already had.`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
