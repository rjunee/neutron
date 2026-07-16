import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CapabilityDeniedError,
  buildDevSecretsAccessor,
  buildSecretsAccessor,
  type PlatformSecretsStore,
} from '../secrets.ts'
import type { ManifestSecret, NeutronManifest } from '../manifest.ts'

function makeManifest(secrets: ManifestSecret[]): NeutronManifest {
  return {
    capabilities: [],
    tier_support: ['regular'],
    tools: [],
    ui_components: [],
    billing_hooks: [],
    linked_sources: [],
    secrets,
    compat: { coreApi: '^1.0.0' },
    build: { neutronVersion: '0.1.0' },
  }
}

/**
 * Mirrors the production `auth/secrets-store.ts:SecretsStore` semantics:
 * - `put()` is INSERT-only — duplicate `(slug, kind, label)` rejects.
 * - `rotate(id, plaintext)` updates ciphertext on an existing row.
 * - `list()` returns row `id` so callers can rotate by id.
 */
class InMemoryPlatformStore implements PlatformSecretsStore {
  private rows = new Map<
    string,
    { id: string; plaintext: string; expires_at?: number }
  >()
  private nextId = 1
  async get(input: { internal_handle: string; kind: string; label: string }): Promise<string | null> {
    const row = this.rows.get(`${input.internal_handle}:${input.kind}:${input.label}`)
    if (row === undefined) return null
    if (row.expires_at !== undefined && row.expires_at <= Date.now()) {
      return null
    }
    return row.plaintext
  }
  async put(input: {
    internal_handle: string
    kind: string
    label: string
    plaintext: string
    expires_at?: number
  }): Promise<{ id: string }> {
    const key = `${input.internal_handle}:${input.kind}:${input.label}`
    if (this.rows.has(key)) {
      throw new Error('duplicate_label')
    }
    const id = `id-${this.nextId++}`
    this.rows.set(key, {
      id,
      plaintext: input.plaintext,
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
    })
    return { id }
  }
  async rotate(
    id: string,
    new_plaintext: string,
    options?: { expires_at?: number },
  ): Promise<void> {
    for (const [k, v] of this.rows) {
      if (v.id === id) {
        this.rows.set(k, {
          id,
          plaintext: new_plaintext,
          ...(options?.expires_at !== undefined
            ? { expires_at: options.expires_at }
            : {}),
        })
        return
      }
    }
    throw new Error('not_found')
  }
  async list(input: { internal_handle: string; kind?: string }): Promise<Array<{ id: string; kind: string; label: string }>> {
    const out: Array<{ id: string; kind: string; label: string }> = []
    for (const [k, v] of this.rows) {
      const parts = k.split(':')
      if (parts.length < 3) continue
      const slug = parts[0] ?? ''
      const kind = parts[1] ?? ''
      const label = parts.slice(2).join(':')
      if (slug !== input.internal_handle) continue
      if (input.kind !== undefined && kind !== input.kind) continue
      out.push({ id: v.id, kind, label })
    }
    return out
  }
}

describe('secrets — capability gating (production accessor)', () => {
  test('get/put/list succeed for a declared secret', async () => {
    const manifest = makeManifest([
      {
        name: 'shopify_token',
        kind: 'byo_api_key',
        label: 'shopify',
        required: true,
        install_prompt: 'paste',
      },
    ])
    const store = new InMemoryPlatformStore()
    const accessor = buildSecretsAccessor(
      { manifest },
      { internal_handle: asOwnerHandle('topline'), store, core_id: '@neutronai/dtc-analytics' },
    )
    await accessor.put('byo_api_key', 'shopify', 'sk_test_123')
    expect(await accessor.get('byo_api_key', 'shopify')).toBe('sk_test_123')
    expect(await accessor.list()).toEqual([{ kind: 'byo_api_key', label: 'shopify' }])
  })

  test('get throws CapabilityDeniedError for an undeclared secret', async () => {
    const manifest = makeManifest([
      {
        name: 'shopify_token',
        kind: 'byo_api_key',
        label: 'shopify',
        required: true,
        install_prompt: 'paste',
      },
    ])
    const store = new InMemoryPlatformStore()
    const accessor = buildSecretsAccessor(
      { manifest },
      { internal_handle: asOwnerHandle('topline'), store, core_id: '@neutronai/dtc-analytics' },
    )
    await expect(accessor.get('byo_api_key', 'stripe')).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    )
  })

  test('put throws CapabilityDeniedError for an undeclared secret', async () => {
    const manifest = makeManifest([])
    const store = new InMemoryPlatformStore()
    const accessor = buildSecretsAccessor(
      { manifest },
      { internal_handle: asOwnerHandle('topline'), store, core_id: '@neutronai/dtc-analytics' },
    )
    await expect(accessor.put('byo_api_key', 'shopify', 'sk')).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    )
  })

  test('put() forwards expires_at on insert (Codex r6 P1)', async () => {
    const manifest = makeManifest([
      {
        name: 'gmail_oauth',
        kind: 'oauth_token',
        label: 'google',
        required: true,
        install_prompt: 'Connect Gmail',
      },
    ])
    const store = new InMemoryPlatformStore()
    const accessor = buildSecretsAccessor(
      { manifest },
      { internal_handle: asOwnerHandle('topline'), store, core_id: '@neutronai/dtc-analytics' },
    )
    const past = Date.now() - 1000
    await accessor.put('oauth_token', 'google', 'access_token_v1', {
      expires_at: past,
    })
    // Already-expired token reads as null — proves expires_at landed
    // in the platform store and the read path honours it.
    expect(await accessor.get('oauth_token', 'google')).toBe(null)
  })

  test('put() forwards expires_at on rotate (Codex r6 P1)', async () => {
    const manifest = makeManifest([
      {
        name: 'gmail_oauth',
        kind: 'oauth_token',
        label: 'google',
        required: true,
        install_prompt: 'Connect Gmail',
      },
    ])
    const store = new InMemoryPlatformStore()
    const accessor = buildSecretsAccessor(
      { manifest },
      { internal_handle: asOwnerHandle('topline'), store, core_id: '@neutronai/dtc-analytics' },
    )
    // Insert with expiry in the future (token still valid).
    await accessor.put('oauth_token', 'google', 'access_v1', {
      expires_at: Date.now() + 60_000,
    })
    expect(await accessor.get('oauth_token', 'google')).toBe('access_v1')
    // Refresh with an expired timestamp — rotate must update the
    // expiry so a stale-cache read returns null.
    await accessor.put('oauth_token', 'google', 'access_v2', {
      expires_at: Date.now() - 1000,
    })
    expect(await accessor.get('oauth_token', 'google')).toBe(null)
  })

  test('put() retries as rotate on a duplicate_label race (Codex r8 P2)', async () => {
    const manifest = makeManifest([
      {
        name: 'gmail_oauth',
        kind: 'oauth_token',
        label: 'google',
        required: true,
        install_prompt: 'x',
      },
    ])
    // Simulate a race: the first list() returns empty (no row yet),
    // but between list() and put() a concurrent writer inserted a
    // row. The SDK's put() then catches duplicate_label, re-list()s,
    // and rotates onto the loser's row id.
    let listCallCount = 0
    let storedPlaintext: string | null = null
    let storedId: string | null = null
    const store: PlatformSecretsStore = {
      async get() {
        return storedPlaintext
      },
      async list() {
        listCallCount += 1
        if (listCallCount === 1) return []
        if (storedId === null) return []
        return [{ id: storedId, kind: 'oauth_token', label: 'google' }]
      },
      async put(input) {
        if (storedId !== null) {
          // duck-typed duplicate_label error shape
          throw Object.assign(new Error('duplicate_label'), {
            code: 'duplicate_label',
          })
        }
        storedId = 'id-1'
        storedPlaintext = 'racing-writer-token'
        return { id: storedId }
      },
      async rotate(id, new_plaintext) {
        if (id !== storedId) throw new Error('not_found')
        storedPlaintext = new_plaintext
      },
    }
    const accessor = buildSecretsAccessor(
      { manifest },
      { internal_handle: asOwnerHandle('topline'), store, core_id: 'x' },
    )
    // Pre-seed via a side-channel: simulate the racing writer
    // landing INSERT after our list() but before our put().
    storedId = 'id-1'
    storedPlaintext = 'racing-writer-token'
    // Now this put() goes through the put-then-rotate retry path.
    await accessor.put('oauth_token', 'google', 'our-token')
    expect(storedPlaintext).toBe('our-token')
  })

  test('put() throws misconfigured when list() row lacks id (Codex r6 P2)', async () => {
    const manifest = makeManifest([
      {
        name: 'shopify_token',
        kind: 'byo_api_key',
        label: 'shopify',
        required: true,
        install_prompt: 'paste',
      },
    ])
    // A store that doesn't return id violates the duck-type contract.
    const store: PlatformSecretsStore = {
      async get() {
        return null
      },
      async put() {
        throw new Error('duplicate_label')
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async list() {
        return [{ kind: 'byo_api_key', label: 'shopify' } as any]
      },
      async rotate() {
        // unreachable — the misconfigured fast-fail should fire first
      },
    }
    const accessor = buildSecretsAccessor(
      { manifest },
      { internal_handle: asOwnerHandle('topline'), store, core_id: 'x' },
    )
    await expect(accessor.put('byo_api_key', 'shopify', 'sk')).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    )
  })

  test('put() rotates an existing secret instead of throwing duplicate (Codex r1 P2)', async () => {
    const manifest = makeManifest([
      {
        name: 'shopify_token',
        kind: 'byo_api_key',
        label: 'shopify',
        required: true,
        install_prompt: 'paste',
      },
    ])
    const store = new InMemoryPlatformStore()
    const accessor = buildSecretsAccessor(
      { manifest },
      { internal_handle: asOwnerHandle('topline'), store, core_id: '@neutronai/dtc-analytics' },
    )
    await accessor.put('byo_api_key', 'shopify', 'sk_test_123')
    // Re-put under the same (kind, label) — should rotate, not throw.
    await accessor.put('byo_api_key', 'shopify', 'sk_test_456')
    expect(await accessor.get('byo_api_key', 'shopify')).toBe('sk_test_456')
  })

  test('list returns only secrets the manifest declares (filters undeclared)', async () => {
    const manifest = makeManifest([
      {
        name: 'shopify_token',
        kind: 'byo_api_key',
        label: 'shopify',
        required: true,
        install_prompt: 'paste',
      },
    ])
    const store = new InMemoryPlatformStore()
    // Pre-seed the store with both declared and undeclared secrets.
    await store.put({
      internal_handle: asOwnerHandle('topline'),
      kind: 'byo_api_key',
      label: 'shopify',
      plaintext: 'a',
    })
    await store.put({
      internal_handle: asOwnerHandle('topline'),
      kind: 'byo_api_key',
      label: 'stripe',
      plaintext: 'b',
    })
    const accessor = buildSecretsAccessor(
      { manifest },
      { internal_handle: asOwnerHandle('topline'), store, core_id: '@neutronai/dtc-analytics' },
    )
    const list = await accessor.list()
    expect(list).toEqual([{ kind: 'byo_api_key', label: 'shopify' }])
  })
})

describe('secrets — buildDevSecretsAccessor (plaintext JSON file)', () => {
  let tmp: string
  afterEach(() => {
    if (tmp !== undefined && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  })

  test('throws without NEUTRON_DEV_AUTH unless bypass_env_guard is set', () => {
    tmp = mkdtempSync(join(tmpdir(), 'cores-sdk-secrets-'))
    expect(() =>
      buildDevSecretsAccessor(
        { manifest: makeManifest([]) },
        { file_path: join(tmp, 'x.json'), core_id: 'x' },
      ),
    ).toThrow(CapabilityDeniedError)
  })

  test('round-trips plaintext through the JSON file', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'cores-sdk-secrets-'))
    const file_path = join(tmp, '.secrets-dev.json')
    const manifest = makeManifest([
      {
        name: 'shopify_token',
        kind: 'byo_api_key',
        label: 'shopify',
        required: true,
        install_prompt: 'x',
      },
    ])
    const accessor = buildDevSecretsAccessor(
      { manifest },
      { file_path, core_id: 'x', bypass_env_guard: true },
    )
    await accessor.put('byo_api_key', 'shopify', 'plain-text')
    expect(await accessor.get('byo_api_key', 'shopify')).toBe('plain-text')
    expect(existsSync(file_path)).toBe(true)
    expect(await accessor.list()).toEqual([{ kind: 'byo_api_key', label: 'shopify' }])
  })

  test('dev accessor still enforces capability gating', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'cores-sdk-secrets-'))
    const accessor = buildDevSecretsAccessor(
      { manifest: makeManifest([]) },
      { file_path: join(tmp, '.secrets-dev.json'), core_id: 'x', bypass_env_guard: true },
    )
    await expect(accessor.get('byo_api_key', 'shopify')).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    )
  })
})
