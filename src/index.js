/**
 * dsh-codex-lite — the ChatGPT-subscription model route for DeepSeek Harness,
 * and nothing else: `ctx.llm` gains the `openai-codex` provider (pi-ai's
 * official catalog: models, wire protocol, OAuth refresh) backed by an
 * owner-only credential file under `$DSH_HOME`. Sign-in is the terminal
 * `dsh-codex-lite login` command; this plugin registers no HTTP routes, no
 * tools, no search provider, no browser code, and changes no defaults.
 * @module dsh-codex-lite
 */

import z from '@deepseek-ai/schemastery'
import { createOpenAICodexLiteAdapter } from './adapter.js'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from './store.js'

export { createOpenAICodexLiteAdapter } from './adapter.js'
export { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER, openAICodexAuthPath } from './store.js'
export { loginOpenAICodex, logoutOpenAICodex, openAICodexAuthStatus } from './auth.js'

/** Stable Cordis plugin name. */
export const name = 'llm-openai-codex-lite'

/** The LLM registry is the only service this plugin touches. */
export const inject = ['llm']

/**
 * Per-model replacements for the installed pi-ai catalog's sizing, by model id.
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
 * Empty by default, so an unconfigured install keeps the catalog exactly.
 */
export const Config = z.object({
  modelOverrides: z.dict(z.object({
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
  })).default({}),
})

/**
 * Register the `openai-codex` route on the harness LLM seam. The registration
 * is an effect owned by this plugin's fiber, so unloading the plugin releases
 * the route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the LLM registry.
 * @param {{modelOverrides?: Record<string, {contextWindow?: number, maxTokens?: number}>}} [config] - validated plugin config.
 */
export function apply(ctx, config) {
  const store = new OpenAICodexCredentialStore()
  ctx.llm.registerAdapter(
    [OPENAI_CODEX_PROVIDER],
    createOpenAICodexLiteAdapter(store, () => ctx.get('attachments'), config?.modelOverrides ?? {}),
  )
}
