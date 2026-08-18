/**
 * dsh-codex-lite — the ChatGPT-subscription model route for DeepSeek Harness,
 * and nothing else: `ctx.llm` gains the `openai-codex` provider (pi-ai's
 * official catalog: models, wire protocol, OAuth refresh) backed by an
 * owner-only credential file under `$DSH_HOME`. Sign-in is the terminal
 * `dsh-codex-lite login` command; this plugin registers no HTTP routes, no
 * tools and no search provider, and changes no defaults. Its only browser
 * code is one Settings card editing the one field below.
 *
 * That field has three layers, each overriding the one above: the schema's
 * empty default, the composition entry (`cordis.patch.yml`, the deployment
 * baseline), and the user layer in `$DSH_HOME/settings.yaml`. The settings
 * seam owns the merge; a change there reaches the next request without a
 * restart, because the route reads its configuration through a thunk rather
 * than closing over the value it was composed with.
 * @module dsh-codex-lite
 */

import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { assertKnownModelIds, createOpenAICodexLiteAdapter, openAICodexCatalogModelIds } from './adapter.js'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from './store.js'

export { createOpenAICodexLiteAdapter } from './adapter.js'
export { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER, openAICodexAuthPath } from './store.js'
export { loginOpenAICodex, logoutOpenAICodex, openAICodexAuthStatus } from './auth.js'

/** Stable Cordis plugin name. */
export const name = 'llm-openai-codex-lite'

/** The LLM registry is the only service this plugin requires. */
export const inject = ['llm']

/**
 * Namespace of this plugin's user-editable section in `$DSH_HOME/settings.yaml`.
 *
 * It is the plugin name, which is also the composition entry id and the key
 * the browser card registers under — the Settings tab dispatches a card only
 * to the namespace it names, so both halves must spell this the same way.
 */
export const settingsNs = settingsNamespace('llm-openai-codex-lite')

/**
 * Per-model replacements for the installed pi-ai catalog's context window, by
 * model id.
 *
 * The catalog carries the conservative numbers OpenAI tuned the Codex client
 * around, not the model's documented ceiling: `gpt-5.6-sol` ships as a 272000
 * window although OpenAI documents 1,050,000. Raising `contextWindow` is what
 * lets a session keep more history before whatever compaction backend the
 * session's agent preset mounts starts summarizing, and it is the same local
 * bookkeeping choice Codex exposes as `model_context_window`; the number never
 * reaches the server, which enforces its own limit and prices input above
 * 272000 at a higher tier.
 *
 * The window is the only field worth replacing on this route: the Codex
 * Responses request body carries no output-token cap, so an output size would
 * change neither what the seam publishes nor what reaches the server.
 *
 * Empty by default, so an unconfigured install keeps the catalog exactly.
 */
export const Config = z.object({
  modelOverrides: z.dict(z.object({
    // The ceiling is `Number.MAX_SAFE_INTEGER` rather than a guess at how
    // large a window could plausibly get: past it, integers stop being
    // distinguishable and `String(value)` starts producing exponent notation,
    // so a stored value would render into the card as something the card
    // cannot parse back. Refusing it on the way in keeps every stored window
    // editable.
    contextWindow: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .description('Context window in tokens. Local bookkeeping: it sizes the context meter and the compaction trigger, and never reaches the server.'),
  }).description('Catalog field replacements for this model.'))
    .default({})
    .description('Per-model context windows for the openai-codex catalog, by model id.'),
})

/**
 * The "no overrides" answer, as one stable object.
 *
 * The adapter's profiles thunk memoizes on this object's identity, so a fresh
 * `{}` per call would rebuild the provider on every operation.
 */
const NO_OVERRIDES = Object.freeze({})

/**
 * Register the `openai-codex` route on the harness LLM seam, then bind the
 * route's sizing to the settings section so it can be edited at runtime.
 *
 * The registration is an effect owned by this plugin's fiber, so unloading the
 * plugin releases the route. Registration happens first and reads the
 * composition entry: an entry naming a model the catalog does not carry is a
 * configuration error that must fail this load, exactly as it did before the
 * section existed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the LLM registry.
 * @param {{modelOverrides?: Record<string, {contextWindow?: number}>}} [config] - validated plugin config.
 */
export function apply(ctx, config) {
  const entry = config ?? { modelOverrides: NO_OVERRIDES }
  // The authoritative source: the resolved settings section while one is
  // attached, the composition entry before that and after a detach.
  let current = () => entry
  const store = new OpenAICodexCredentialStore()
  ctx.llm.registerAdapter(
    [OPENAI_CODEX_PROVIDER],
    createOpenAICodexLiteAdapter(
      store,
      () => ctx.get('attachments'),
      () => current().modelOverrides ?? NO_OVERRIDES,
    ),
  )
  // The catalog ships with the package, so the known ids are fixed for this
  // install and the write-time check costs nothing per validation.
  const catalogIds = openAICodexCatalogModelIds()
  try {
    installSettingsSection(ctx, settingsNs, Config, entry, {
      // Refuse the write rather than store a section that would size nothing:
      // the seam runs this before it persists, so a bad edit leaves both the
      // document and the serving route untouched, and the message it relays
      // is the one the loader would have thrown.
      validate: (value) => { assertKnownModelIds(value?.modelOverrides ?? {}, catalogIds) },
      setSource: (source) => { current = source },
      // Nothing derived from the section needs re-judging: the route set, its
      // display name and its retry policy do not depend on configuration, and
      // the adapter re-reads the thunk per operation.
      onChange: () => {
        ctx.logger.debug('dsh-codex-lite: modelOverrides source changed; the next request resolves the new window')
      },
    })
  } catch (error) {
    // A settings section is an enhancement, not a prerequisite. Losing it
    // leaves the route serving the composition entry, which is worth saying
    // out loud rather than failing a fiber that is otherwise healthy.
    ctx.logger.error('dsh-codex-lite: settings section unavailable; the route keeps serving its composition entry')
    ctx.logger.error(error)
  }
}
