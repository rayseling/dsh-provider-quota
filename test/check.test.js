/**
 * Rejection proofs for the gates in `scripts/check.mjs`.
 *
 * Every collector gets a good sample AND a bad one, because the failure mode
 * of an agent-written check is that it passes everything: a gate that is
 * always green is worse than no gate, since it reports safety it never
 * measured. The bad samples here are shapes this repository has actually
 * shipped or that an adversarial review actually got past the gates — the
 * fabricated class name, the property accessor for a non-injected service, the
 * drifted plugin name, the undeclared import, `{ todo }` in place of a skip,
 * one word rewritten in `package.json`.
 *
 * The violation lists are asserted VERBATIM with `assert.deepEqual`, not
 * probed with a substring match. That pins three things at once: the violation
 * is found, the line number is right, and nothing extra appears. It also means
 * the message text cannot decay unnoticed — and for a gate an agent has to act
 * on, the message is the product.
 *
 * Only Node is imported here, so this file runs in a bare checkout.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'

import {
  REPO_ROOT,
  allGateIds,
  bareGateIds,
  collectCatalogWordingViolations,
  collectDeclaredDepViolations,
  collectDocBudgetViolations,
  collectDocRefViolations,
  collectDocSymbolViolations,
  collectRemoteCodeViolations,
  collectIdentityViolations,
  collectImageBudgetViolations,
  collectServiceReadViolations,
  collectSuiteViolations,
  collectWorkflowViolations,
  commentsOnly,
  exemptionsIn,
  hostSourceFiles,
  listExemptions,
  parseTap,
  scanProblems,
  stripComments,
  stripCommentsAndStrings,
} from '../scripts/check.mjs'

/** Fixture roots this file created. */
const roots = []
after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))))

/**
 * Materialize a fixture checkout.
 * @param {Record<string, string>} files - path relative to the root → contents.
 * @returns {Promise<string>} the fixture root.
 */
async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-lite-gate-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return root
}

/** A minimal package.json a fixture that only needs dependencies can start from. */
const MANIFEST = JSON.stringify({ name: 'dsh-codex-lite', peerDependencies: { 'some-pkg': '*' } })

// ---------------------------------------------------------------------------

describe('source scanning', () => {
  test('the three views are length-preserving and agree', () => {
    const cases = [
      'const a = 1\n',
      "const s = 'x\\",
      'const a = 1\n/* dangling',
      'const t = `a ${ "b" } c`\n',
      'const r = /[/*]/u\nconst q = 1\n',
      "const p = /\\w+'s/u\n",
      'a\r\nb\r\n',
      '',
    ]
    for (const source of cases) {
      for (const [name, transform] of [['stripComments', stripComments], ['stripCommentsAndStrings', stripCommentsAndStrings], ['commentsOnly', commentsOnly]]) {
        const out = transform(source)
        assert.equal(out.length, source.length, `${name} changed the length of ${JSON.stringify(source)}`)
        assert.equal(
          out.split('\n').length,
          source.split('\n').length,
          `${name} changed the line count of ${JSON.stringify(source)}`,
        )
      }
    }
  })

  test('a comment is blanked but the line numbering survives', () => {
    const stripped = stripComments('a\n// ctx.settings\nb\n')
    assert.equal(stripped.split('\n')[1].trim(), '', 'the comment body is gone')
    assert.equal(stripped.split('\n')[2], 'b')
  })

  test('string bodies survive comment stripping and vanish under the stricter pass', () => {
    const source = "const s = 'ctx.settings'\n"
    assert.match(stripComments(source), /ctx\.settings/u, 'the import scanner needs literals intact')
    assert.doesNotMatch(stripCommentsAndStrings(source), /ctx\.settings/u, 'the service scanner must not see them')
  })

  test('a regex literal containing a quote does not open string mode', () => {
    // A legal `/\w+'s/u` used to put the scanner into string mode for the rest
    // of the file, silently switching two gates off from that line down.
    const source = "const POSSESSIVE = /\\w+'s/u\nconst bad = ctx.settings\n"
    assert.match(stripCommentsAndStrings(source), /ctx\.settings/u, 'code after the regex is still code')
  })

  test('a regex containing a slash-star does not open comment mode', () => {
    // `/[/*]/u` sent stripComments into block-comment mode to end of file,
    // which inverted commentsOnly into raw code and turned a quoted exemption
    // marker into a live signature.
    const source = "const SLASH_OR_STAR = /[/*]/u\nconst help = 'sign with // gate-exempt: deps a b c'\n"
    assert.deepEqual([...exemptionsIn(source, 'deps').lines], [], 'the marker is inside a string, not a comment')
    assert.match(stripComments(source), /const help/u, 'the rest of the file is not a comment')
  })
})

// ---------------------------------------------------------------------------

describe('this checkout, checked by the runner it would be redirected away from', () => {
  test('the gates are still wired to `npm test`, and identity is clean here', () => {
    // The one bypass no gate can see from inside: rewriting `scripts.test` to
    // `node --test` removes all eight gates, and `npm test` then prints a full
    // green suite. This assertion lives in the SUITE, so the bypass trips the
    // runner it redirects to. It is the reason `collectIdentityViolations`
    // takes a root.
    assert.deepEqual(collectIdentityViolations(REPO_ROOT), [])
  })

  test('bare mode leaves out only the two gates that need a harness checkout', () => {
    // Defined as an exclusion, so a gate added later is in CI by default.
    // The first version listed what ran, and two gates that need nothing —
    // doc-budget and verify-workflow — sat outside CI for no reason: exactly
    // the place where AGENTS.md bloat and a rotting workflow would show up.
    assert.deepEqual(
      allGateIds().filter(id => !bareGateIds().includes(id)),
      ['doc-refs', 'doc-symbols', 'remote-codes'],
    )
    for (const id of ['doc-budget', 'verify-workflow', 'service-reads']) {
      assert.ok(bareGateIds().includes(id), `${id} needs nothing external and must run in CI`)
    }
  })

  test('every view is length-preserving over this repository\'s own sources', () => {
    // The dependency gate slices a specifier out of one view using offsets
    // matched in another. That is only sound while both are exactly as long as
    // the input, and the previous implementation was not.
    for (const rel of hostSourceFiles(REPO_ROOT)) {
      const source = readFileSync(join(REPO_ROOT, rel), 'utf8')
      for (const [name, transform] of [['stripComments', stripComments], ['stripCommentsAndStrings', stripCommentsAndStrings], ['commentsOnly', commentsOnly]]) {
        assert.equal(transform(source).length, source.length, `${name} changed the length of ${rel}`)
      }
      assert.deepEqual(scanProblems(rel, source), [], `${rel} does not scan cleanly`)
    }
  })
})

describe('exemptions', () => {
  test('a reason of fewer than three words is reported rather than honored', () => {
    for (const text of ['// gate-exempt: deps\nconst x = 1\n', '// gate-exempt: deps x\nconst x = 1\n']) {
      const { lines, listed, malformed } = exemptionsIn(text, 'deps')
      assert.deepEqual([...lines], [], `an unsigned exemption exempts nothing: ${JSON.stringify(text)}`)
      assert.deepEqual(listed, [])
      assert.deepEqual(malformed, ['line 1'])
    }
  })

  test('an exemption quoted inside a string literal grants nothing', () => {
    // Every gate's failure message ends by telling the reader how to sign an
    // exemption. Read exemptions from the raw text and each of those messages
    // silently exempts the lines around itself — which is what scripts/check.mjs
    // did on its first run, on its own message strings.
    const quoted = "const msg = 'sign the line with `// gate-exempt: deps because of reasons`'\nimport x from 'undeclared'\n"
    assert.deepEqual([...exemptionsIn(quoted, 'deps').lines], [], 'a quoted marker is text, not a signature')

    const real = '// gate-exempt: deps vendored fixture, resolved at runtime\nimport x from \'undeclared\'\n'
    assert.deepEqual([...exemptionsIn(real, 'deps').lines], [1, 2], 'a real comment signs its line and the next')
  })

  test('a CRLF checkout keeps its exemptions', () => {
    // `.` does not match `\r`, so the trailing-anchor pattern used to find
    // nothing at all: not honored, not listed, not even reported as malformed.
    const crlf = '// gate-exempt: deps vendored fixture, resolved at runtime\r\nimport x from \'undeclared\'\r\n'
    assert.deepEqual([...exemptionsIn(crlf, 'deps').lines], [1, 2])
  })

  test('a Markdown exemption must own its line, so documenting the syntax signs nothing', () => {
    const real = '<!-- gate-exempt: doc-refs the file ships in the harness only -->\n`packages/x.ts`\n'
    assert.deepEqual([...exemptionsIn(real, 'doc-refs', 'md').lines], [1, 2])
    assert.deepEqual(exemptionsIn(real, 'doc-refs', 'md').listed, ['line 1: the file ships in the harness only'])

    const inline = 'To exempt a line write `<!-- gate-exempt: doc-refs say why here -->` above it, e.g. `src/nope.js`.\n'
    assert.deepEqual([...exemptionsIn(inline, 'doc-refs', 'md').lines], [], 'an inline example is prose, not a signature')
  })

  test('listExemptions finds nothing in this repository, and the runner would print it if it did', async () => {
    const root = await fixture({
      'package.json': MANIFEST,
      'src/index.js': "export const inject = ['llm']\n// gate-exempt: service-reads the harness provides this one\nconst a = ctx.somethingElse\n",
    })
    assert.deepEqual(listExemptions(root), [
      'src/index.js service-reads — line 2: the harness provides this one',
    ])
  })
})

// ---------------------------------------------------------------------------

describe('gate: service-reads', () => {
  test('accepts injected services, context built-ins, and ctx.get', async () => {
    const root = await fixture({
      'src/index.js': [
        "export const inject = ['llm']",
        'export function apply(ctx) {',
        "  ctx.llm.registerAdapter(['x'], {})",
        "  ctx.logger.debug('logger is an own property of every context')",
        '  ctx._internal = 1',
        '  if (ctx.constructor !== undefined) return undefined',
        "  return ctx.get('settings')",
        '}',
        '',
      ].join('\n'),
    })
    assert.deepEqual(collectServiceReadViolations(root), [])
  })

  test('rejects the property accessor for a service that is not injected', async () => {
    const root = await fixture({
      'src/index.js': [
        "export const inject = ['llm']",
        'export function apply(ctx) {',
        "  return ctx.settings !== undefined ? ctx.settings : ctx.get('settings')",
        '}',
        '',
      ].join('\n'),
    })
    const expected = 'src/index.js:3: `ctx.settings` reads a service that is not in `inject` (llm). '
      + 'The property accessor throws `cannot get property "settings" without inject` before any fallback beside it can run, '
      + 'and an enclosing catch turns that into "nothing configured" for every call. '
      + "Use `ctx.get('settings')`, or sign the line with `// gate-exempt: service-reads <reason>`."
    assert.deepEqual(collectServiceReadViolations(root), [expected, expected])
  })

  test('rejects the optional-chaining spelling of the same bug', async () => {
    // `ctx?.settings` throws exactly as `ctx.settings` does — the accessor runs
    // either way — and it is the more natural modern spelling.
    const root = await fixture({
      'src/index.js': "export const inject = ['llm']\nconst s = ctx?.settings ?? ctx.get('settings')\n",
    })
    assert.equal(collectServiceReadViolations(root).length, 1)
    assert.match(collectServiceReadViolations(root)[0], /^src\/index\.js:2: `ctx\.settings`/u)
  })

  test('scans src/ subdirectories and .mjs files', async () => {
    // A non-recursive .js-only listing let a file under src/routes/ carry the
    // bug while the gate stayed green AND kept printing the same file count.
    const root = await fixture({
      'src/index.js': "export const inject = ['llm']\n",
      'src/routes/quota.js': 'const s = ctx.settings\n',
      'src/helper.mjs': 'const t = ctx.attachments\n',
    })
    assert.deepEqual(hostSourceFiles(root), ['src/helper.mjs', 'src/index.js', 'src/routes/quota.js'])
    assert.equal(collectServiceReadViolations(root).length, 2)
  })

  test('does not fire on the service name mentioned in a comment or a string', async () => {
    const root = await fixture({
      'src/index.js': [
        "export const inject = ['llm']",
        '// `ctx.get(name)` and not ctx.settings: the accessor refuses it.',
        "const message = 'ctx.settings would throw here'",
        '',
      ].join('\n'),
    })
    assert.deepEqual(collectServiceReadViolations(root), [])
  })

  test('honors a signed exemption and reports an unsigned one', async () => {
    const signed = await fixture({
      'src/index.js': [
        "export const inject = ['llm']",
        '// gate-exempt: service-reads the harness installs this as an accessor',
        'const a = ctx.somethingElse',
        '',
      ].join('\n'),
    })
    assert.deepEqual(collectServiceReadViolations(signed), [])

    const unsigned = await fixture({
      'src/index.js': [
        "export const inject = ['llm']",
        '// gate-exempt: service-reads',
        'const a = ctx.somethingElse',
        '',
      ].join('\n'),
    })
    assert.deepEqual(collectServiceReadViolations(unsigned), [
      'src/index.js:2: a `gate-exempt: service-reads` comment carries no usable reason. '
      + 'An exemption without one is unsigned; write what makes this read safe (at least a few words), or remove the comment.',
      'src/index.js:3: `ctx.somethingElse` reads a service that is not in `inject` (llm). '
      + 'The property accessor throws `cannot get property "somethingElse" without inject` before any fallback beside it can run, '
      + 'and an enclosing catch turns that into "nothing configured" for every call. '
      + "Use `ctx.get('somethingElse')`, or sign the line with `// gate-exempt: service-reads <reason>`.",
    ])
  })

  test('fails loudly when the inject list it compares against is gone', async () => {
    const root = await fixture({ 'src/index.js': 'const a = ctx.settings\n' })
    assert.deepEqual(collectServiceReadViolations(root), [
      'src/index.js: no `export const inject = [...]` found, so this gate cannot tell an injected service from an undeclared one. '
      + 'Restore the export, or delete this gate deliberately rather than letting it pass vacuously.',
    ])
  })
})

// ---------------------------------------------------------------------------

describe('gate: doc-refs', () => {
  test('accepts paths that resolve and leaves prose alone', async () => {
    const root = await fixture({
      'src/index.js': 'export const name = 1\n',
      'AGENTS.md': [
        'See `src/index.js` for the entry point.',
        'The document lives at `$DSH_HOME/settings.yaml`, which is a runtime path.',
        'A bare `settings.yaml` is prose too.',
        '',
        '```sh',
        'cat nonexistent/path.js',
        '```',
        '',
      ].join('\n'),
    })
    assert.deepEqual(collectDocRefViolations(root, undefined), [])
  })

  test('rejects a path that does not exist', async () => {
    const root = await fixture({ 'AGENTS.md': 'The resolver lives in `src/resolver.js`.\n' })
    assert.deepEqual(collectDocRefViolations(root, undefined), [
      'AGENTS.md:1: `src/resolver.js` does not exist in this checkout. '
      + 'Documents are read as fact by the next agent, and a path that resolves to nothing sends it looking. '
      + 'Cite a real path, or drop the backticks if the token is prose.',
    ])
  })

  test('refuses to report green on harness citations it cannot reach', async () => {
    const root = await fixture({ 'AGENTS.md': 'See `packages/settings/settings/src/nope.ts`.\n' })
    assert.deepEqual(collectDocRefViolations(root, undefined), [
      'doc-refs: 1 citation(s) point into the harness and no harness checkout is reachable, so this gate cannot do its job. '
      + 'Reporting green here would claim a check that never ran — the failure this whole file exists to prevent. '
      + 'Set `DSH_HARNESS_ROOT=/path/to/deepseek-harness`, or keep a `deepseek-harness` checkout beside this one.',
    ])

    const harness = await fixture({ 'packages/keep.ts': '' })
    assert.deepEqual(collectDocRefViolations(root, harness), [
      `AGENTS.md:1: \`packages/settings/settings/src/nope.ts\` does not exist in the harness checkout at ${harness}. `
      + 'A citation that cannot be opened is worse than none — the next reader trusts it. '
      + 'Re-open the file and cite the real path.',
    ])
  })
})

// ---------------------------------------------------------------------------

describe('gate: doc-symbols', () => {
  test('accepts a symbol that exists and ignores platform globals', async () => {
    const root = await fixture({
      'src/adapter.js': 'export class SelectivePiAiAdapter { listModels() {} }\nexport function selectableModelIds() {}\n',
      'AGENTS.md': 'Narrowing `SelectivePiAiAdapter.listModels` also hides models; see `selectableModelIds()`. `NaN` is not ours.\n',
    })
    assert.deepEqual(collectDocSymbolViolations(root, undefined), [])
  })

  test('resolves a $-leading identifier instead of reporting it forever', async () => {
    // `\b$fetch\b` anchors on the `$`, so the name could never match.
    const root = await fixture({
      'src/probe.js': 'export function $fetch() {}\n',
      'AGENTS.md': 'Call `$fetch()` to probe.\n',
    })
    assert.deepEqual(collectDocSymbolViolations(root, undefined), [])
  })

  test('rejects an invented class name once a harness root can rule it out', async () => {
    const root = await fixture({
      'src/index.js': 'export const name = 1\n',
      'AGENTS.md': 'The hook is called by `SettingsRuntime.register` while resolving.\n',
    })
    const harness = await fixture({ 'packages/settings/src/index.ts': 'export abstract class SettingsProvider {}\n' })
    assert.deepEqual(collectDocSymbolViolations(root, harness), [
      'AGENTS.md:1: `SettingsRuntime.register` names `SettingsRuntime`, which appears in no source file here or in the harness. '
      + 'A described mechanism can be right while its name is invented, and the name is what the next reader greps for. '
      + 'Re-open the file and cite the real name.',
    ])
  })

  test('is not satisfied by the invented name appearing in a comment', async () => {
    // Writing "this used to be called SettingsRuntime" into a comment resolved
    // the citation without making it true.
    const root = await fixture({
      'src/index.js': '// Historical note: the resolve path used to be called SettingsRuntime.\nexport const name = 1\n',
      'AGENTS.md': 'The hook is called by `SettingsRuntime.register` while resolving.\n',
    })
    const harness = await fixture({ 'packages/settings/src/index.ts': 'export abstract class SettingsProvider {}\n' })
    assert.equal(collectDocSymbolViolations(root, harness).length, 1)
  })

  test('does not accept a prefix of a real harness symbol', async () => {
    const root = await fixture({
      'src/index.js': 'export const name = 1\n',
      'AGENTS.md': 'See `SettingsProv`.\n',
    })
    const harness = await fixture({ 'packages/settings/src/index.ts': 'export abstract class SettingsProvider {}\n' })
    assert.equal(collectDocSymbolViolations(root, harness).length, 1, 'a substring test let `SettingsProv` resolve')
  })

  test('survives a broken symlink under src/ instead of aborting the run', async () => {
    const root = await fixture({
      'src/index.js': 'export const name = 1\n',
      'AGENTS.md': 'See `TotallyInvented`.\n',
    })
    await symlink('nowhere.js', join(root, 'src', 'dead.js'))
    assert.doesNotThrow(() => collectDocSymbolViolations(root, undefined))
  })
})

// ---------------------------------------------------------------------------

describe('gate: remote-codes', () => {
  /** A harness whose declared vocabulary is the post-rename one. */
  const HARNESS = {
    'packages/typert/protocol/src/types.ts':
      "export interface RemoteErrorDetailsMap {\n  'gateway/internal': {}\n  'gateway/cancelled': {}\n}\n",
    'packages/api/settings-controller/src/types.ts':
      "declare module '@deepseek-ai/dsh-typert-protocol' {\n  interface RemoteErrorDetailsMap {\n"
      + "    'settings/rejected': { readonly ns: string }\n"
      + "    'settings/conflict': { readonly ns: string; readonly expected: number }\n  }\n}\n",
  }

  test('accepts codes the harness declares, across separate declaration merges', async () => {
    const root = await fixture({
      'src/client.js': "var t = error.code === 'gateway/internal' ? a : error.code === 'settings/conflict' ? b : c\n",
    })
    assert.deepEqual(collectRemoteCodeViolations(root, await fixture(HARNESS)), [])
  })

  test('reports the spelling the alpha.2 rename left behind', async () => {
    // The shipped bug: `internal` and `settings-conflict` stopped matching and
    // the settings card started rendering the carrier's English at the operator.
    const root = await fixture({
      'src/client.js': "var t = error.code === 'internal' ? a : error.code === 'settings-conflict' ? b : c\n",
    })
    const found = collectRemoteCodeViolations(root, await fixture(HARNESS))
    assert.equal(found.length, 2)
    assert.match(found[0], /`internal` is not a code the harness/u)
    assert.match(found[1], /`settings-conflict` is not a code the harness/u)
  })

  test('tells a typeof guard from a comparison', async () => {
    // `typeof result.error.code === 'string'` reads `.code === '…'` too, and
    // reporting it put `string` in the violation list.
    const root = await fixture({
      'src/client.js': "var c = typeof result.error.code === 'string' ? result.error.code : undefined\n"
        + "var t = error.code === 'gateway/internal'\n",
    })
    assert.deepEqual(collectRemoteCodeViolations(root, await fixture(HARNESS)), [])
  })

  test('is not satisfied by the real code appearing in a comment', async () => {
    const root = await fixture({
      'src/client.js': "// renamed from error.code === 'gateway/internal'\nvar t = error.code === 'internal'\n",
    })
    assert.equal(collectRemoteCodeViolations(root, await fixture(HARNESS)).length, 1)
  })

  test('honors a signed exemption on the comparison line', async () => {
    const root = await fixture({
      'src/client.js': "var t = error.code === 'quota-exhausted' // gate-exempt: remote-codes this route owns the code\n",
    })
    assert.deepEqual(collectRemoteCodeViolations(root, await fixture(HARNESS)), [])
  })

  test('refuses to pass when it cannot reach a harness, or reads a tree without the vocabulary', async () => {
    const root = await fixture({ 'src/client.js': "var t = error.code === 'gateway/internal'\n" })
    assert.match(collectRemoteCodeViolations(root, undefined)[0], /no harness checkout is reachable/u)
    const empty = await fixture({ 'packages/util/values/src/index.ts': 'export const x = 1\n' })
    assert.match(collectRemoteCodeViolations(root, empty)[0], /read the wrong tree/u)
  })

  test('refuses to pass a file that discriminates no codes at all', async () => {
    const root = await fixture({ 'src/client.js': 'export const name = 1\n' })
    assert.match(collectRemoteCodeViolations(root, await fixture(HARNESS))[0], /nothing to resolve/u)
  })

  test('skips a stale build tree, so a deleted code stops resolving', async () => {
    const root = await fixture({ 'src/client.js': "var t = error.code === 'settings/retired'\n" })
    const harness = await fixture({
      ...HARNESS,
      'packages/api/settings-controller/lib/types.d.ts':
        "interface RemoteErrorDetailsMap {\n  'settings/retired': {}\n}\n",
    })
    assert.equal(collectRemoteCodeViolations(root, harness).length, 1)
  })
})

// ---------------------------------------------------------------------------

describe('gate: identity', () => {
  /**
   * @param {Record<string, string>} [overrides] - files replacing the coherent defaults.
   * @returns {Promise<string>} a fixture whose four spellings agree.
   */
  async function identityFixture(overrides = {}) {
    const root = await fixture({
      'src/index.js': "export const name = 'llm-openai-codex-lite'\nexport const settingsNs = 'llm-openai-codex-lite'\n",
      'src/client.js': "    var SETTINGS_NS = 'llm-openai-codex-lite'\n",
      'cordis.patch.yml': '- insert:\n    - id: llm-openai-codex-lite\n      name: dsh-codex-lite\n',
      'package.json': JSON.stringify({
        name: 'dsh-codex-lite',
        scripts: { test: 'node scripts/check.mjs' },
        exports: { '.': './src/index.js' },
      }),
      'AGENTS.md': '# rules\n',
      ...overrides,
    })
    if (!Object.hasOwn(overrides, 'CLAUDE.md')) await symlink('AGENTS.md', join(root, 'CLAUDE.md'))
    return root
  }

  test('accepts a coherent checkout', async () => {
    assert.deepEqual(collectIdentityViolations(await identityFixture()), [])
  })

  test('accepts double quotes and a YAML trailing comment as ordinary edits', async () => {
    // One Prettier run rewrites the JS quotes; a comment beside the entry id is
    // normal YAML. Neither is drift, and reporting either as a missing anchor
    // sends the reader hunting.
    const root = await identityFixture({
      'src/index.js': 'export const name = "llm-openai-codex-lite"\nexport const settingsNs = "llm-openai-codex-lite"\n',
      'cordis.patch.yml': '- insert:\n    - id: llm-openai-codex-lite  # the entry id\n      name: dsh-codex-lite\n',
    })
    assert.deepEqual(collectIdentityViolations(root), [])
  })

  test('rejects a drifted plugin name — the case the whole suite stays green for', async () => {
    const root = await identityFixture({
      'src/index.js': "export const name = 'llm-openai-codex-DRIFTED'\nexport const settingsNs = 'llm-openai-codex-lite'\n",
    })
    const violations = collectIdentityViolations(root)
    assert.equal(violations.length, 3, 'all three other spellings are reported, not just the first')
    assert.deepEqual(violations[0],
      'src/index.js `export const settingsNs`: spells "llm-openai-codex-lite" while src/index.js `export const name` spells "llm-openai-codex-DRIFTED". '
      + 'These four are one identity: the Settings tab dispatches a card only to the namespace it names, so a drift here makes the card silently never arrive. '
      + "(The loader imports the entry's `name:`, not its `id:`, so the composition still loads — which is why the suite stays green.) "
      + 'Make all four agree.')
  })

  test('rejects an npm test that no longer runs the gates', async () => {
    // One word, and every gate is gone while `npm test` still prints a full
    // green suite. Nothing else in the system can see this.
    const root = await identityFixture({
      'package.json': JSON.stringify({
        name: 'dsh-codex-lite',
        scripts: { test: 'node --test' },
        exports: { '.': './src/index.js' },
      }),
    })
    assert.deepEqual(collectIdentityViolations(root), [
      'package.json: `scripts.test` is "node --test", which does not run `node scripts/check.mjs`. '
      + '`npm test` is the only command AGENTS.md tells anyone to run, so a value that does not reach this file silently removes all eight gates — '
      + 'and the bare test runner it usually gets pointed at reports success even when whole suites were skipped. '
      + 'Add the command back (chaining more after it is fine), or update TEST_COMMAND in scripts/check.mjs.',
    ])
  })

  test('rejects an entry name that does not match the package name', async () => {
    const root = await identityFixture({
      'cordis.patch.yml': '- insert:\n    - id: llm-openai-codex-lite\n      name: some-other-package\n',
    })
    assert.deepEqual(collectIdentityViolations(root), [
      'cordis.patch.yml `name:`: is "some-other-package" but package.json `name` is "dsh-codex-lite". '
      + "This one is a real contract: the loader treats the entry's `name` as the module specifier it imports (vendor/loader/src/config/entry.ts). "
      + 'A mismatch means the composition imports a package that is not this one.',
    ])
  })

  test('walks conditional exports and does not iterate a bare string as characters', async () => {
    const conditional = await identityFixture({
      'package.json': JSON.stringify({
        name: 'dsh-codex-lite',
        scripts: { test: 'node scripts/check.mjs' },
        exports: { '.': { import: './src/does-not-exist.js' } },
      }),
    })
    assert.equal(collectIdentityViolations(conditional).length, 1)

    const bare = await identityFixture({
      'package.json': JSON.stringify({
        name: 'dsh-codex-lite',
        scripts: { test: 'node scripts/check.mjs' },
        exports: './src/index.js',
      }),
    })
    assert.deepEqual(collectIdentityViolations(bare), [], 'a bare string used to yield one violation per character')
  })

  test('rejects CLAUDE.md as a copy and as an absence', async () => {
    const copy = await identityFixture({ 'CLAUDE.md': 'see AGENTS.md\n' })
    assert.deepEqual(collectIdentityViolations(copy), [
      'CLAUDE.md: must be a symbolic link to AGENTS.md, not a copy. '
      + 'It is the file a Claude Code session loads; without it those sessions start with no instructions at all, and a copy would drift from the original. '
      + 'Run: rm -f CLAUDE.md && ln -s AGENTS.md CLAUDE.md',
    ])

    const gone = await fixture({
      'src/index.js': "export const name = 'x'\nexport const settingsNs = 'x'\n",
      'src/client.js': "var SETTINGS_NS = 'x'\n",
      'cordis.patch.yml': '- insert:\n    - id: x\n      name: dsh-codex-lite\n',
      'package.json': JSON.stringify({ name: 'dsh-codex-lite', scripts: { test: 'node scripts/check.mjs' } }),
    })
    assert.deepEqual(collectIdentityViolations(gone), [
      'CLAUDE.md: is missing. '
      + 'It is the file a Claude Code session loads; without it those sessions start with no instructions at all, and a copy would drift from the original. '
      + 'Run: rm -f CLAUDE.md && ln -s AGENTS.md CLAUDE.md',
    ])
  })

  test('fails loudly when an anchor it compares is missing, rather than passing quietly', async () => {
    const root = await identityFixture({ 'src/client.js': 'var somethingElse = 1\n' })
    assert.deepEqual(collectIdentityViolations(root), [
      'src/client.js `SETTINGS_NS`: this gate could not find the value it compares (pattern SETTINGS_NS\\s*=\\s*[\'"]([^\'"]+)[\'"]). '
      + 'A gate that cannot locate its anchor must fail, not pass quietly — a silent skip here is how four spellings drift apart unnoticed. '
      + 'Restore the declaration, or update this pattern in scripts/check.mjs.',
    ])
  })

  test('refuses a package.json that is valid JSON but not an object', async () => {
    const root = await identityFixture({ 'package.json': 'null' })
    assert.deepEqual(collectIdentityViolations(root), [
      'package.json: parsed to null, not an object. Nothing that reads it can be checked.',
    ])
  })
})

// ---------------------------------------------------------------------------

describe('gate: deps', () => {
  test('accepts declared specifiers, relative paths, and node: builtins', async () => {
    const root = await fixture({
      'package.json': MANIFEST,
      'src/index.js': "import { a } from 'some-pkg'\nimport { b } from './local.js'\nimport { c } from 'node:fs'\n",
    })
    assert.deepEqual(collectDeclaredDepViolations(root), [])
  })

  test('rejects an undeclared import in a test file', async () => {
    const root = await fixture({
      'package.json': MANIFEST,
      'test/settings.test.js': "import x from 'some-pkg'\nimport y from '@scope/undeclared-pkg/sub'\n",
    })
    assert.deepEqual(collectDeclaredDepViolations(root), [
      'test/settings.test.js:2: imports `@scope/undeclared-pkg`, which no dependency field in package.json declares. '
      + 'It resolves here only because node_modules is a symlink into a shared profile tree; anyone who follows the manifest cannot run this file at all, '
      + 'and a skip guard would make that invisible rather than loud. '
      + 'Declare it, or sign the line with `// gate-exempt: deps <reason>`.',
    ])
  })

  test('reaches src/ subdirectories', async () => {
    const root = await fixture({
      'package.json': MANIFEST,
      'src/routes/quota.js': "import { padStart } from 'left-pad'\n",
    })
    assert.equal(collectDeclaredDepViolations(root).length, 1)
  })

  test('ignores a JSDoc type import, which is not a resolution edge', async () => {
    const root = await fixture({
      'package.json': MANIFEST,
      'src/index.js': "/** @param {import('@deepseek-ai/cordis').Context} ctx */\nexport function apply(ctx) {}\n",
    })
    assert.deepEqual(collectDeclaredDepViolations(root), [])
  })

  test('does not read fixture source embedded in a string literal as a real edge', async () => {
    // This file itself is the reason: its fixtures carry import statements as
    // string contents. A scanner that matched them would report every gate
    // test as an undeclared dependency, and the cheapest way to make that
    // green would be to stop scanning test/ at all.
    const root = await fixture({
      'package.json': MANIFEST,
      'test/check.test.js': [
        "import { collect } from '../scripts/check.mjs'",
        'const fixtureSource = "import x from \'not-a-real-edge\'\\n"',
        "const other = `require('also-not-one')`",
        '',
      ].join('\n'),
    })
    assert.deepEqual(collectDeclaredDepViolations(root), [])
  })

  test('skips src/client.js, whose require is a browser module table', async () => {
    const root = await fixture({
      'package.json': MANIFEST,
      'src/client.js': "function factory(require) {\n  var React = require('react')\n}\n",
    })
    assert.deepEqual(collectDeclaredDepViolations(root), [])
  })
})

// ---------------------------------------------------------------------------

describe('gate: image-budget', () => {
  const profile = [
    'const profiles = createProfilesThunk(currentOverrides, requestProvider(provider), {',
    '  provider: OPENAI_CODEX_PROVIDER,',
    '  maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,',
    '  requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,',
    '  requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,',
    '})',
    '',
  ].join('\n')

  test('accepts a profile that sets all three together', async () => {
    assert.deepEqual(collectImageBudgetViolations(await fixture({ 'src/adapter.js': profile })), [])
  })

  test('rejects the profile with one field deleted — the exact shape of trap 3', async () => {
    const root = await fixture({
      'src/adapter.js': profile.replace('  requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,\n', ''),
    })
    assert.deepEqual(collectImageBudgetViolations(root), [
      'src/adapter.js:1: the profile passed to `createProfilesThunk` does not set `requestImageMaxBytes`. '
      + 'An omitted budget field is not a host default — it travels down as `undefined`, `Math.min(bytes, undefined)` is `NaN`, '
      + 'and every image in the request is silently replaced by a text placeholder. '
      + 'Set all three together; the defaults are in `packages/llm/llm-pi-ai/src/config.ts` (2048² pixels, 1 MiB).',
    ])
  })

  test('rejects a field explicitly set to undefined, which is the trap itself', async () => {
    const root = await fixture({
      'src/adapter.js': profile.replace('REQUEST_IMAGE_MAX_BYTES,', 'undefined,'),
    })
    assert.deepEqual(collectImageBudgetViolations(root), [
      'src/adapter.js:1: `requestImageMaxBytes` resolves to `undefined`. '
      + 'That is the trap itself rather than a way around it: the field still reaches `Math.min(bytes, undefined)`, the comparison still yields `NaN`, '
      + 'and every image is still replaced by a text placeholder, with no error anywhere. '
      + 'Give it a real budget.',
    ])
  })

  test('is not fooled by a decoy object elsewhere in the file', async () => {
    const root = await fixture({
      'src/adapter.js': 'const IMAGE_BUDGET_REFERENCE = {\n  maxRequestImageBytes: 1,\n  requestImagePixelBudget: 2,\n  requestImageMaxBytes: 3,\n}\n'
        + '\n'.repeat(40) + profile.replace('  requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,\n', ''),
    })
    assert.equal(collectImageBudgetViolations(root).length, 1, 'the decoy must not satisfy the gate')
  })

  test('fails rather than passing vacuously when the file is gone', async () => {
    const root = await fixture({ 'package.json': MANIFEST })
    assert.deepEqual(collectImageBudgetViolations(root), [
      'src/adapter.js: absent, so the profile this gate reads does not exist. A gate whose subject is missing must fail rather than pass vacuously.',
    ])
  })
})

// ---------------------------------------------------------------------------

describe('gate: catalog-wording', () => {
  /**
   * @param {string} description - the text inside the enabledModels `.description(...)`.
   * @param {string} [chain] - extra chained calls before `.description`.
   * @returns {string} a src/index.js body shaped like the real one.
   */
  const schemaSource = (description, chain = '') => `export const Config = z.object({
  enabledModels: z.array(z.string().min(1))
    .default(openAICodexCatalogModelIds())${chain}
    .description('${description}'),
  modelOverrides: z.dict(z.object({})),
})
`
  const README = 'The allowlist narrows what `listModels` answers.\n'

  test('accepts a description that says catalog', async () => {
    const root = await fixture({
      'src/index.js': schemaSource('Codex models this route advertises. It narrows the advertised catalog, not just the picker.'),
      'README.md': README,
    })
    assert.deepEqual(collectCatalogWordingViolations(root), [])
  })

  const SOFTENED = 'src/index.js: the `enabledModels` schema `.description()` no longer says `catalog`. '
    + 'The Settings card renders that string verbatim, and it is the only place a user learns that this allowlist narrows the advertised catalog '
    + 'rather than just the model picker — unchecking a model removes it from every list the harness answers, and finding that out afterwards is a '
    + 'support call. Say it in the description itself; a comment nearby, or a sibling call in the same chain, does not reach the user.'

  test('rejects a description softened back to "only the picker"', async () => {
    const root = await fixture({
      'src/index.js': schemaSource('Codex models the model picker offers.'),
      'README.md': README,
    })
    assert.deepEqual(collectCatalogWordingViolations(root), [SOFTENED])
  })

  test('is not satisfied by a sibling call in the same chain carrying the token', async () => {
    // Scoping the check to the region rather than to the description argument
    // passed on exactly this: the user-visible string had lost the fact while
    // `.role('…')` beside it carried the word.
    const root = await fixture({
      'src/index.js': schemaSource('Codex models the model picker offers.', "\n    .role('catalog')"),
      'README.md': README,
    })
    assert.deepEqual(collectCatalogWordingViolations(root), [SOFTENED])
  })

  test('rejects a README that no longer names the mechanism', async () => {
    const root = await fixture({
      'src/index.js': schemaSource('It narrows the advertised catalog.'),
      'README.md': 'The allowlist narrows the picker.\n',
    })
    assert.deepEqual(collectCatalogWordingViolations(root), [
      'README.md: does not mention `listModels` anywhere. It is where a reader learns what the allowlist does, and the reason it reaches every '
      + 'model list is that the harness answers all of them from that one call. Name the mechanism, so the claim stays checkable.',
    ])
  })

  test('fails loudly when the schema field it reads is gone', async () => {
    const root = await fixture({ 'src/index.js': 'export const Config = z.object({})\n', 'README.md': README })
    assert.deepEqual(collectCatalogWordingViolations(root), [
      'src/index.js: no `enabledModels:` schema field found, so the text this gate reads does not exist. '
      + 'A gate that cannot locate its anchor must fail rather than pass quietly. '
      + 'Restore it, or update the pattern in scripts/check.mjs.',
    ])
  })
})

// ---------------------------------------------------------------------------

describe('gate: doc-budget', () => {
  /** @param {object} files @returns {string} a budgets.json body. */
  const budgets = files => JSON.stringify({ files })

  test('accepts a document under its ceiling, counting code points', async () => {
    const root = await fixture({
      'scripts/budgets.json': budgets({ 'AGENTS.md': { limit: 10, why: 'small on purpose' } }),
      'AGENTS.md': '一二三四五',
    })
    assert.deepEqual(collectDocBudgetViolations(root), [])
  })

  test('rejects a document over its ceiling, and prescribes the order', async () => {
    // 12 Chinese characters is 12 code points and 36 bytes: a byte or word
    // count would put this in a different place entirely.
    const root = await fixture({
      'scripts/budgets.json': budgets({ 'AGENTS.md': { limit: 10, why: 'small on purpose' } }),
      'AGENTS.md': '一二三四五六七八九十十一',
    })
    assert.deepEqual(collectDocBudgetViolations(root), [
      'AGENTS.md: 12 characters, over its 10 ceiling by 2. '
      + 'Handle it in this order — (1) MOVE anything that is not a standing order out: an incident story belongs in notes/postmortems/, '
      + "a design rationale in notes/implemented/, a gate mechanism in that collector's header comment; "
      + '(2) COMPRESS what is left; (3) only then RAISE the ceiling in scripts/budgets.json, and write the reason into its `why`. '
      + 'Raising it first is how a file everyone is supposed to read stops being read.',
    ])
  })

  test('a budgeted document that does not exist is a failure, not a pass', async () => {
    // Deleting the file is the cheapest way to be under budget.
    const root = await fixture({
      'scripts/budgets.json': budgets({ 'AGENTS.md': { limit: 10, why: 'small on purpose' } }),
    })
    assert.deepEqual(collectDocBudgetViolations(root), [
      'AGENTS.md: is budgeted at 10 characters but does not exist. '
      + 'A budgeted document that vanished is the cheapest way to be under budget, so this is a failure rather than a pass. '
      + 'Restore the file, or remove its entry from scripts/budgets.json in the same change that deletes it.',
    ])
  })

  test('is one of the gates a bare run executes, so CI catches the bloat', async () => {
    // The document that grows is the one an agent reads every session, and CI
    // is where an over-budget AGENTS.md should surface — this gate needs
    // neither a harness checkout nor node_modules, so nothing justified
    // leaving it out.
    assert.ok(bareGateIds().includes('doc-budget'))
    const root = await fixture({
      'scripts/budgets.json': JSON.stringify({ files: { 'AGENTS.md': { limit: 10, why: 'small on purpose' } } }),
      'AGENTS.md': '一二三四五六七八九十十一',
    })
    assert.equal(collectDocBudgetViolations(root).length, 1, 'the collector does not vary by mode; only the gate list does')
  })

  test('an empty or malformed budget list fails rather than enforcing nothing', async () => {
    const empty = await fixture({ 'scripts/budgets.json': budgets({}) })
    assert.deepEqual(collectDocBudgetViolations(empty), [
      'scripts/budgets.json: `files` is missing or empty, so this gate has nothing to enforce and would pass vacuously. '
      + 'Give it at least one `{ "<path>": { "limit": <number>, "why": "<reason>" } }` entry.',
    ])

    const bad = await fixture({
      'scripts/budgets.json': budgets({ 'AGENTS.md': { limit: '10', why: 'quoted' } }),
      'AGENTS.md': '一二三',
    })
    assert.deepEqual(collectDocBudgetViolations(bad), [
      'scripts/budgets.json: the ceiling for `AGENTS.md` is "10", not a positive whole number, so nothing is enforced for it.',
    ])

    const absent = await fixture({ 'AGENTS.md': '一二三' })
    assert.deepEqual(collectDocBudgetViolations(absent), [
      'scripts/budgets.json: absent or unreadable. Run from a checkout root.',
    ])
  })
})

// ---------------------------------------------------------------------------

describe('gate: verify-workflow', () => {
  const GOOD = `name: CI
permissions:
  contents: read
jobs:
  gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - run: node scripts/check.mjs --bare
  all-checks-passed:
    if: always()
    needs: [gates]
    runs-on: ubuntu-latest
    steps:
      - run: test "\${{ needs.gates.result }}" = "success"
`

  test('accepts a workflow that keeps all four properties', async () => {
    assert.deepEqual(collectWorkflowViolations(await fixture({ '.github/workflows/ci.yml': GOOD })), [])
  })

  test('no workflow at all is a position, not a violation', async () => {
    // This repository ran on local gates only for its whole life.
    assert.deepEqual(collectWorkflowViolations(await fixture({ 'package.json': MANIFEST })), [])
  })

  test('rejects continue-on-error', async () => {
    const root = await fixture({ '.github/workflows/ci.yml': GOOD.replace('    runs-on: ubuntu-latest\n      steps', '    runs-on: ubuntu-latest\n    continue-on-error: true\n      steps').replace('  gates:\n', '  gates:\n    continue-on-error: true\n') })
    assert.deepEqual(collectWorkflowViolations(root), [
      '.github/workflows/ci.yml:6: uses `continue-on-error`, which turns a failing step green while leaving it looking like it ran. '
      + 'A check that cannot fail is not a check. Express "this one does not block" by leaving the job out of the required `needs` list instead.',
    ])
  })

  test('rejects a missing permissions block', async () => {
    const root = await fixture({ '.github/workflows/ci.yml': GOOD.replace('permissions:\n  contents: read\n', '') })
    assert.deepEqual(collectWorkflowViolations(root), [
      '.github/workflows/ci.yml: declares no top-level `permissions:` block, so the job inherits whatever the repository default is — today, and after anyone changes it. '
      + 'Add `permissions:` with the narrowest set the job needs (`contents: read` here).',
    ])
  })

  test('rejects a checkout that leaves credentials on disk', async () => {
    const root = await fixture({ '.github/workflows/ci.yml': GOOD.replace('        with:\n          persist-credentials: false\n', '') })
    assert.deepEqual(collectWorkflowViolations(root), [
      ".github/workflows/ci.yml:8: `actions/checkout` does not set `persist-credentials: false`. "
      + "Nothing in this workflow reads git history, and a token left in the runner's git config is one a later step — or a later edit — can pick up. "
      + 'Add it under `with:`.',
    ])
  })

  test('rejects a required job that would be skipped when its dependency fails', async () => {
    // Branch protection counts a skipped job as a pass: the same "a skip is
    // not a pass" hole as the suite gate, one layer up.
    const root = await fixture({ '.github/workflows/ci.yml': GOOD.replace('    if: always()\n', '') })
    assert.deepEqual(collectWorkflowViolations(root), [
      '.github/workflows/ci.yml:12: job `all-checks-passed` has `needs:` but no job-level `if: always()`. '
      + 'Without it the job is SKIPPED when an upstream job fails, and branch protection counts a skipped job as a pass — '
      + 'the same "a skip is not a pass" hole the suite gate exists for, one layer up. '
      + "Give it `if: always()` and assert each dependency's `result` explicitly.",
    ])
  })

  test('is judged per job: always() on an unrelated step does not satisfy it', async () => {
    // The first version asked whether `if: always()` appeared anywhere in the
    // file. The real workflow has one on a reporting step, so removing it from
    // the job that needed it left the gate green.
    const root = await fixture({
      '.github/workflows/ci.yml': GOOD
        .replace('    if: always()\n', '')
        .replace('      - run: node scripts/check.mjs --bare\n', '      - run: echo done\n        if: always()\n'),
    })
    assert.equal(collectWorkflowViolations(root).length, 1, 'a step-level always() must not stand in for the job-level one')
  })
})

// ---------------------------------------------------------------------------

describe('gate: suite', () => {
  test('a skipped describe is invisible in the counters — the reason this gate exists', () => {
    const { counts, skipped } = parseTap([
      'TAP version 13',
      'ok 1 - catalog sizing # SKIP peer dependencies are not installed (ERR_MODULE_NOT_FOUND)',
      'ok 2 - redaction',
      '1..2',
      '# tests 123',
      '# pass 123',
      '# fail 0',
      '# skipped 0',
      '',
    ].join('\n'))
    assert.equal(counts.skipped, 0, 'the counter really does say zero')
    assert.deepEqual(skipped, [{ name: 'catalog sizing', reason: 'peer dependencies are not installed (ERR_MODULE_NOT_FOUND)' }])
  })

  test('a todo test throws, is counted as a pass, and is still caught', () => {
    // `test('…', { todo: 'flaky' }, fn)` keeps running the test and keeps
    // throwing while the summary reports `# fail 0 / # skipped 0`. One word
    // per test defeated every other mechanism in this gate.
    const { counts, failedLines } = parseTap([
      'not ok 1 - the native DeepSeek route # TODO flaky under the new seam',
      '1..1',
      '# tests 234',
      '# pass 231',
      '# fail 0',
      '# skipped 0',
      '# todo 3',
      '',
    ].join('\n'))
    assert.equal(counts.fail, 0, 'the failure counter is zero')
    assert.equal(counts.todo, 3)
    assert.equal(failedLines, 1, 'the `not ok` line is what actually reveals it')
  })

  test('reports a missing test file, an unrecorded one, and a wrong count', async () => {
    const root = await fixture({
      'scripts/expected.json': JSON.stringify({ tests: 99, files: ['gone', 'present'] }),
      'test/present.test.js': "import { test } from 'node:test'\ntest('one', () => {})\n",
      'test/surprise.test.js': "import { test } from 'node:test'\ntest('two', () => {})\n",
    })
    assert.deepEqual(collectSuiteViolations(root), [
      'test/gone.test.js: recorded in scripts/expected.json but not present. '
      + 'A renamed or deleted test file takes every test in it away without producing a single skip line. '
      + 'Restore the file, or remove it from `files` in the same commit that deletes it.',
      'test/surprise.test.js: exists but is not recorded in scripts/expected.json. '
      + 'Add it to `files` so a later rename cannot remove it silently.',
      '2 test(s) executed; scripts/expected.json records 99. '
      + 'If you added or removed tests, update that number in this same commit. '
      + 'If you did not, something stopped running — find out what before changing the number.',
    ])
  })

  test('refuses a recorded count that is not a whole number', async () => {
    // Quoting the number, or deleting the key, disabled the comparison
    // permanently while every summary kept claiming it had run.
    for (const tests of ['"1"', 'null', '1.5']) {
      const root = await fixture({
        'scripts/expected.json': `{"tests": ${tests}, "files": ["present"]}`,
        'test/present.test.js': "import { test } from 'node:test'\ntest('one', () => {})\n",
      })
      const violations = collectSuiteViolations(root)
      assert.equal(violations.length, 1, `tests: ${tests}`)
      assert.match(violations[0], /^scripts\/expected\.json: `tests` is .*not a whole number/u)
    }
  })

  test('accepts a checkout whose files and count match', async () => {
    const root = await fixture({
      'scripts/expected.json': JSON.stringify({ tests: 1, files: ['present'] }),
      'test/present.test.js': "import { test } from 'node:test'\ntest('one', () => {})\n",
    })
    assert.deepEqual(collectSuiteViolations(root), [])
  })

  test('refuses to pass when there is nothing to compare against', async () => {
    const root = await fixture({ 'test/present.test.js': "import { test } from 'node:test'\ntest('one', () => {})\n" })
    assert.deepEqual(collectSuiteViolations(root), [
      'scripts/expected.json: absent or unreadable. Run from a checkout root.',
    ])
  })
})

// ---------------------------------------------------------------------------

describe('scanner: the shapes that switched gates off', () => {
  test('spaced division is division, not a regular expression', async () => {
    // `used / limit, x = ctx.settings, y = used / window` was read as one long
    // regex, and everything between the slashes — including the forbidden read
    // — disappeared from the view the gate scans.
    const root = await fixture({
      'src/index.js': "export const inject = ['llm']\nconst pct = used / limit, prefs = ctx.settings, per = used / window\n",
    })
    assert.equal(collectServiceReadViolations(root).length, 1)
  })

  test('a regex right after a control-flow `)` does not open a block comment', async () => {
    // `if (value)/[/*]/u` was read as division plus `/*`, which ran to end of
    // file: two gates blind, and a marker quoted in a string became a printed
    // exemption.
    const root = await fixture({
      'package.json': MANIFEST,
      'src/index.js': [
        "export const inject = ['llm']",
        'if (value)/[/*]/u.test(value)',
        "import { pad } from 'left-pad'",
        "const help = 'sign with // gate-exempt: deps a vendored fixture resolved at runtime'",
        '',
      ].join('\n'),
    })
    assert.equal(collectDeclaredDepViolations(root).length, 1, 'the undeclared import is still visible')
    assert.deepEqual(listExemptions(root), [], 'the quoted marker signs nothing')
  })

  test('a docstring missing its close swallows the next export, and is caught', () => {
    // This one is from a real incident: a `*/` was dropped while editing the
    // OPENCODE_GO_BASE_URL docstring. The comment did not run to end of file —
    // it ran to the NEXT docstring, ate the `export const` between them, and
    // the module silently stopped exporting the constant. The unterminated
    // check below never fires in a file that has a second JSDoc block, so it
    // saw nothing.
    const swallowed = [
      '/** first */',
      'export const A = 1',
      '',
      '/**',
      ' * second docstring, never closed',
      'export const B = 2',
      '',
      '/** third */',
      'export const C = 3',
      '',
    ].join('\n')
    assert.deepEqual(scanProblems('src/x.js', swallowed), [
      'src/x.js:6: a `export` statement is inside a block comment. '
      + 'That is almost always a docstring missing its `*/`: the comment runs on to the next one and swallows the code between, '
      + 'so the module quietly stops exporting what it looks like it exports. '
      + 'Close the comment above this line.',
    ])
    assert.deepEqual(scanProblems('src/x.js', swallowed.replace(' * second docstring, never closed', ' * second docstring\n */')), [])
  })

  test('an unterminated block comment is reported rather than absorbed', () => {
    assert.deepEqual(scanProblems('src/x.js', 'const a = 1\n/* never closed\nconst b = ctx.settings\n'), [
      'src/x.js: a `/*` block comment is never closed, so everything after it reads as comment — '
      + 'which means every gate that scans this file stops seeing it, without saying so. '
      + 'Close the comment.',
    ])
  })

  test('a division after a call is still division', async () => {
    const root = await fixture({ 'src/index.js': "export const inject = ['llm']\nconst half = size(x) / 2\nconst s = ctx.settings\n" })
    assert.equal(collectServiceReadViolations(root).length, 1)
  })
})

// ---------------------------------------------------------------------------

describe('scope: the places a file could hide', () => {
  test('src/lib/ and a symlinked src/ directory are scanned', async () => {
    const root = await fixture({
      'package.json': MANIFEST,
      'src/index.js': "export const inject = ['llm']\n",
      'src/lib/quota-math.js': "import { pad } from 'left-pad'\nconst s = ctx.settings\n",
    })
    assert.equal(collectServiceReadViolations(root).length, 1, 'src/lib/ used to be skipped as build output')
    assert.equal(collectDeclaredDepViolations(root).length, 1)
  })

  test('deps recurses into test/ and scripts/', async () => {
    const root = await fixture({
      'package.json': MANIFEST,
      'scripts/lib/util.mjs': "import x from 'undeclared-deep'\n",
      'test/helpers/fake.js': "import y from 'undeclared-helper'\n",
    })
    assert.equal(collectDeclaredDepViolations(root).length, 2)
  })

  test('a side-effect import and a template-literal dynamic import both count', async () => {
    const root = await fixture({
      'package.json': MANIFEST,
      'src/index.js': "import 'undeclared-side-effect'\nawait import(`undeclared-template`)\n",
    })
    assert.equal(collectDeclaredDepViolations(root).length, 2)
  })
})

// ---------------------------------------------------------------------------

describe('the remaining sample-shaped fixes', () => {
  test('doc-symbols is not satisfied by the invented name inside a string literal', async () => {
    const root = await fixture({
      'src/index.js': "throw new Error('SettingsRuntime rejected the section')\n",
      'AGENTS.md': 'The hook is called by `SettingsRuntime.register` while resolving.\n',
    })
    const harness = await fixture({ 'packages/settings/src/index.ts': 'export abstract class SettingsProvider {}\n' })
    assert.equal(collectDocSymbolViolations(root, harness).length, 1)
  })

  test('doc-refs checks a `path.ts:line` citation instead of dropping it as prose', async () => {
    const root = await fixture({ 'AGENTS.md': 'See `src/resolver.js:17` for the branch.\n' })
    assert.equal(collectDocRefViolations(root, undefined).length, 1)
  })

  test('a lone fence marker in prose does not blank the claims after it', async () => {
    const root = await fixture({
      'AGENTS.md': 'Wrap the snippet in ``` when you paste it.\n\nThe resolver lives in `src/resolver.js`.\n',
    })
    assert.equal(collectDocRefViolations(root, undefined).length, 1)
  })

  test('image-budget follows one level of const indirection', async () => {
    const root = await fixture({
      'src/adapter.js': 'const REQUEST_IMAGE_MAX_BYTES = undefined\n'
        + "const profiles = createProfilesThunk(a, b, {\n  maxRequestImageBytes: 1,\n  requestImagePixelBudget: 2,\n  requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,\n})\n",
    })
    assert.equal(collectImageBudgetViolations(root).length, 1)
  })

  test('image-budget judges each call site on its own', async () => {
    const root = await fixture({
      'src/adapter.js': "const first = createProfilesThunk(a, b, {\n  maxRequestImageBytes: 1,\n  requestImagePixelBudget: 2,\n  requestImageMaxBytes: 3,\n})\n"
        + "const second = createProfilesThunk(a, b, { provider: 'opencode-go', maxRequestImageBytes: 1 })\n",
    })
    assert.equal(collectImageBudgetViolations(root).length, 1, 'joining the call sites let one supply the other\'s fields')
  })

  test('catalog-wording fails rather than reporting a check on a README that is gone', async () => {
    const root = await fixture({ 'src/index.js': "enabledModels: x\n    .description('narrows the catalog'),\n  modelOverrides: y\n" })
    assert.equal(collectCatalogWordingViolations(root).length, 1)
  })

  test('a CJK exemption reason is accepted, and a two-character one is not', () => {
    assert.deepEqual([...exemptionsIn('// gate-exempt: deps 依赖在运行时由宿主注入，不需要声明\nconst x = 1\n', 'deps').lines], [1, 2])
    assert.deepEqual(exemptionsIn('// gate-exempt: deps 短\nconst x = 1\n', 'deps').malformed, ['line 1'])
  })

  test('scripts.test may chain more commands but may not narrow the run', async () => {
    /** @param {string} command @returns {Promise<number>} violations. */
    const violationsFor = async (command) => {
      const root = await fixture({
        'src/index.js': "export const name = 'x'\nexport const settingsNs = 'x'\n",
        'src/client.js': "var SETTINGS_NS = 'x'\n",
        'cordis.patch.yml': '- insert:\n    - id: x\n      name: dsh-codex-lite\n',
        'package.json': JSON.stringify({ name: 'dsh-codex-lite', scripts: { test: command } }),
        'AGENTS.md': '# rules\n',
      })
      await symlink('AGENTS.md', join(root, 'CLAUDE.md'))
      return collectIdentityViolations(root).length
    }
    assert.equal(await violationsFor('node scripts/check.mjs'), 0)
    assert.equal(await violationsFor('node scripts/check.mjs && node scripts/lint.mjs'), 0, 'chaining a lint step is legitimate')
    assert.equal(await violationsFor('node --test'), 1)
    assert.equal(await violationsFor('node scripts/check.mjs --only=deps'), 1, 'running one gate is not running the gates')
  })
})
