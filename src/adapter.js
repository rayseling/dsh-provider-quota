/**
 * The one non-trivial piece: bridge pi-ai's OAuth-only `openai-codex` catalog
 * provider into dsh's official `PiAiAdapter`.
 *
 * `PiAiAdapter` passes credentials as a per-request `apiKey` override, and
 * pi-ai honours that override only when the provider declares an api-key auth
 * method — the catalog provider declares OAuth alone. So the route's provider
 * gains one api-key method that accepts exactly the explicit override (never
 * an environment key), and the override itself is the OAuth access token
 * resolved — and auto-refreshed — by a private `Models` collection holding the
 * plugin's file credential store. Everything else (message conversion,
 * attachment resolution, streaming, retries, reasoning metadata) is the
 * official adapter, untouched.
 * @module dsh-codex-lite/adapter
 */

import { createModels } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { OPENAI_CODEX_PROVIDER } from './store.js'

/** Provider idle ceiling for the streamed response. */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Clone the provider with a request-scoped bearer-token entry beside its OAuth
 * method. The resolver accepts only the explicit override this plugin
 * supplies; it never discovers a key from the environment.
 * @param {import('@earendil-works/pi-ai').Provider} provider - the catalog provider.
 * @returns {import('@earendil-works/pi-ai').Provider} the same provider accepting a per-request bearer token.
 */
function requestProvider(provider) {
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        name: 'OpenAI Codex OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'OAuth' }
        },
      },
    },
  }
}

/**
 * Clone the provider with per-model catalog fields replaced.
 *
 * The installed pi-ai catalog sizes each model, and its numbers are the
 * conservative ones OpenAI tuned Codex around — `gpt-5.6-sol` ships as
 * 272000 even though the model documents a 1,050,000-token window. Both dsh
 * consumers of that size read it from this model list: the resolved model
 * info the seam publishes (the context meter and whatever compaction backend a
 * preset mounts) and the stream mapper's context-overflow detection. So
 * replacing it here is what a larger window means end to end.
 *
 * An override naming a model the catalog does not carry is a configuration
 * error and throws at load rather than silently sizing nothing.
 * @param {import('@earendil-works/pi-ai').Provider} provider - the catalog provider.
 * @param {Record<string, {contextWindow?: number, maxTokens?: number}>} overrides - per-model field replacements, by model id.
 * @returns {import('@earendil-works/pi-ai').Provider} the provider whose models carry the overrides.
 */
function withModelOverrides(provider, overrides) {
  const ids = Object.keys(overrides)
  if (ids.length === 0) return provider
  const catalog = provider.getModels()
  const unknown = ids.filter(id => !catalog.some(model => model.id === id))
  if (unknown.length > 0) {
    throw new Error(
      `dsh-codex-lite: modelOverrides names ${unknown.map(id => JSON.stringify(id)).join(', ')},`
      + ` which the openai-codex catalog does not carry; known ids are ${catalog.map(model => model.id).join(', ')}`,
    )
  }
  const models = catalog.map((model) => {
    const override = overrides[model.id]
    if (override === undefined) return model
    return {
      ...model,
      ...override.contextWindow === undefined ? {} : { contextWindow: override.contextWindow },
      ...override.maxTokens === undefined ? {} : { maxTokens: override.maxTokens },
    }
  })
  return { ...provider, getModels: () => models }
}

/**
 * Assemble the official dsh pi-ai adapter for the one `openai-codex` route.
 * @param {import('./store.js').OpenAICodexCredentialStore} store - the plugin's file credential store.
 * @param {() => import('@deepseek-ai/dsh-attachment').AttachmentStore | undefined} resolveAttachments - durable attachment service, resolved at request time.
 * @param {Record<string, {contextWindow?: number, maxTokens?: number}>} [modelOverrides] - per-model catalog field replacements, by model id.
 * @returns {PiAiAdapter} the adapter to register for `openai-codex`.
 */
export function createOpenAICodexLiteAdapter(store, resolveAttachments, modelOverrides = {}) {
  const provider = openaiCodexProvider()
  const profiles = new Map([[OPENAI_CODEX_PROVIDER, {
    provider: OPENAI_CODEX_PROVIDER,
    displayName: 'OpenAI Codex',
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-codex-lite retryPolicy'),
    configuredMaxTokens: new Map(),
    piProvider: withModelOverrides(requestProvider(provider), modelOverrides),
  }]])
  // Private collection holding the persistent store: getAuth() returns the
  // stored access token, refreshing it through the provider's OAuth method
  // (and persisting the rotation) when expired.
  const models = createModels({ credentials: store })
  models.setProvider(provider)
  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => {
      const resolved = await models.getAuth(OPENAI_CODEX_PROVIDER)
      const apiKey = resolved?.auth.apiKey
      if (apiKey === undefined || apiKey.length === 0) {
        throw new LlmError(
          'OpenAI Codex is not signed in: run `dsh plugin --profile web exec dsh-codex-lite login` on the dsh host',
          'MISSING_CREDENTIAL',
        )
      }
      return apiKey
    },
    resolveAttachments,
  })
}
