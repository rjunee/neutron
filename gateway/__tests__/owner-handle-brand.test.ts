/**
 * N1 — negative type test for the branded `OwnerHandle` at the credential
 * boundaries.
 *
 * The acceptance for the identity-glossary + brand unit: passing the WRONG
 * (unbranded / possibly-mutable `url_slug`) string where the FROZEN owner
 * handle is required must be a COMPILE ERROR — that is the mechanical guard
 * against re-introducing the 2026-05-12 credential-loss incident.
 *
 * These assertions are enforced by `tsc` (the `@ts-expect-error` lines FAIL to
 * compile if the raw-string call ever stops erroring — e.g. if someone reverts
 * a boundary back to `string`). The bodies are never invoked at runtime; the
 * closures exist purely so the typechecker visits the calls. See
 * `persistence/AGENTS.md` § "Identity glossary" and `persistence/owner-handle.ts`.
 */

import { test, expect } from 'bun:test'
import type { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import type { ApiKeyStore } from '@neutronai/auth/api-key-store.ts'
import type { MaxOAuthClient } from '@neutronai/auth/max-oauth.ts'
import type { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import type { CodexCredentialService } from '@neutronai/trident/codex-credential.ts'
import type { ResolveLlmCredentialsInput } from '@neutronai/gateway/wiring/resolve-llm-credentials.ts'
import { asOwnerHandle } from '@neutronai/persistence/index.ts'

// A plain string standing in for a mutable `url_slug` — exactly what a caller
// must NOT feed to a credential lookup.
const rawSlug: string = 'mutable-url-slug'

test('SecretsStore.get rejects a raw string slug and accepts a branded OwnerHandle', () => {
  async function _typecheck(store: SecretsStore): Promise<void> {
    // @ts-expect-error — a bare string (a possibly-mutable url_slug) is NOT a
    // valid credential key; the branded boundary rejects it at compile time.
    await store.get({ owner_handle: rawSlug, kind: 'byo_api_key', label: 'k' })
    // The branded, known-good handle typechecks.
    await store.get({ owner_handle: asOwnerHandle(rawSlug), kind: 'byo_api_key', label: 'k' })
  }
  void _typecheck
  expect(typeof _typecheck).toBe('function')
})

test('ApiKeyStore.add rejects a raw string slug and accepts a branded OwnerHandle', () => {
  async function _typecheck(store: ApiKeyStore): Promise<void> {
    // @ts-expect-error — raw string rejected at the ApiKeyStore boundary.
    await store.add({ owner_handle: rawSlug, provider: 'anthropic', label: 'l', plaintext: 'p' })
    await store.add({
      owner_handle: asOwnerHandle(rawSlug),
      provider: 'anthropic',
      label: 'l',
      plaintext: 'p',
    })
  }
  void _typecheck
  expect(typeof _typecheck).toBe('function')
})

test('ProjectCredentialStore.resolve rejects a raw string slug and accepts a branded OwnerHandle', () => {
  function _typecheck(store: ProjectCredentialStore): void {
    // @ts-expect-error — the owner boundary must be the frozen handle, not a
    // raw url_slug string.
    store.resolve(rawSlug, 'proj-a', 'meta_ads')
    store.resolve(asOwnerHandle(rawSlug), 'proj-a', 'meta_ads')
  }
  void _typecheck
  expect(typeof _typecheck).toBe('function')
})

// The wrappers explicitly named as branded boundaries in persistence/AGENTS.md
// must ALSO reject a raw slug — casting one internally would reopen the incident.

test('MaxOAuthClient.getAccessToken rejects a raw string slug and accepts a branded OwnerHandle', () => {
  async function _typecheck(client: MaxOAuthClient): Promise<void> {
    // @ts-expect-error — the credential wrapper must demand the frozen handle.
    await client.getAccessToken(rawSlug)
    await client.getAccessToken(asOwnerHandle(rawSlug))
  }
  void _typecheck
  expect(typeof _typecheck).toBe('function')
})

test('CodexCredentialService.status rejects a raw string slug and accepts a branded OwnerHandle', () => {
  function _typecheck(service: CodexCredentialService): void {
    // @ts-expect-error — the Codex credential wrapper must demand the frozen handle.
    service.status(rawSlug)
    service.status(asOwnerHandle(rawSlug))
  }
  void _typecheck
  expect(typeof _typecheck).toBe('function')
})

test('ResolveLlmCredentialsInput.owner_handle rejects a raw string slug', () => {
  const _bad: Pick<ResolveLlmCredentialsInput, 'owner_handle'> = {
    // @ts-expect-error — the LLM-credential resolver must demand the frozen handle.
    owner_handle: rawSlug,
  }
  const _good: Pick<ResolveLlmCredentialsInput, 'owner_handle'> = {
    owner_handle: asOwnerHandle(rawSlug),
  }
  void _bad
  void _good
  expect(_good.owner_handle).toBe(asOwnerHandle(rawSlug))
})
