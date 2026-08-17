/**
 * Sign-in orchestration over pi-ai's official OpenAI Codex OAuth flow
 * (authorization code + PKCE against auth.openai.com, loopback callback on
 * 127.0.0.1:1455, or headless device code). pi-ai owns the whole protocol;
 * this module only supplies the persistent store and reads non-secret state.
 * @module dsh-codex-lite/auth
 */

import { createModels } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from './store.js'

/**
 * Run the provider-native OAuth flow and persist the resulting credential.
 * @param {import('@earendil-works/pi-ai').AuthInteraction} interaction - terminal callbacks answering the provider's prompts.
 * @param {OpenAICodexCredentialStore} [store] - credential store; defaults under `$DSH_HOME`.
 */
export async function loginOpenAICodex(interaction, store = new OpenAICodexCredentialStore()) {
  const models = createModels({ credentials: store })
  models.setProvider(openaiCodexProvider())
  await models.login(OPENAI_CODEX_PROVIDER, 'oauth', interaction)
}

/**
 * Remove the stored credential (does not touch `~/.codex`).
 * @param {OpenAICodexCredentialStore} [store] - credential store; defaults under `$DSH_HOME`.
 */
export async function logoutOpenAICodex(store = new OpenAICodexCredentialStore()) {
  await store.delete(OPENAI_CODEX_PROVIDER)
}

/**
 * Read non-secret sign-in state without refreshing anything.
 * @param {OpenAICodexCredentialStore} [store] - credential store; defaults under `$DSH_HOME`.
 * @returns {Promise<{authenticated: boolean, expiresAt?: Date}>} stored state and access-token expiry.
 */
export async function openAICodexAuthStatus(store = new OpenAICodexCredentialStore()) {
  const credential = await store.readCurrent()
  return credential === undefined
    ? { authenticated: false }
    : { authenticated: true, expiresAt: new Date(credential.expires) }
}
