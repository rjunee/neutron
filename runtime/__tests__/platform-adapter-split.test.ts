/**
 * Locks the Open-core / Managed-extension PlatformAdapter split (audit §0.5 / Q5).
 *
 * The split is type-level + behavior-preserving: `PlatformAdapter` must remain
 * structurally identical to `OpenPlatformAdapter & ManagedPlatformExtension`, and
 * every Managed-only op on a `LocalPlatformAdapter` must still throw
 * `PlatformOperationUnsupportedError` (the defense-in-depth backstop), while the
 * Open-core methods keep real single-instance behavior.
 */
import { describe, test, expect } from 'bun:test'
import {
  PlatformOperationUnsupportedError,
  type ManagedPlatformExtension,
  type OpenPlatformAdapter,
  type PlatformAdapter,
} from '../platform-adapter.ts'
import { buildLocalPlatformAdapter } from '../platform-adapter-local.ts'

// Compile-time guard: the two derived views must reconstitute PlatformAdapter
// exactly (any drift here is a tsc error, failing the build).
type _Assert = OpenPlatformAdapter & ManagedPlatformExtension
const _roundTripA: _Assert = {} as PlatformAdapter
const _roundTripB: PlatformAdapter = {} as _Assert
void _roundTripA
void _roundTripB

function localAdapter(): PlatformAdapter {
  return buildLocalPlatformAdapter({
    selfOwner: {
      internal_handle: 't-local-001',
      url_slug: 'local',
      owner_home: '/tmp/neutron-split-test',
      agent_name: null,
      tier: 'open',
      kind: 'user',
    },
  })
}

describe('PlatformAdapter Open/Managed split', () => {
  test('every Managed-only op throws PlatformOperationUnsupportedError on Local', async () => {
    const p = localAdapter()
    await expect(
      p.renameSlug({ internal_handle: 't', current_url_slug: 'a', new_url_slug: 'b' }),
    ).rejects.toBeInstanceOf(PlatformOperationUnsupportedError)
    await expect(
      p.mintInstallToken({
        internal_handle: 't',
        identity: { provider: 'google', sub: 's', email: 'e@x.co' },
        audience: 'a',
        ttl_s: 60,
      }),
    ).rejects.toBeInstanceOf(PlatformOperationUnsupportedError)
    await expect(
      p.connectCall({
        target_instance_slug: 't',
        origin_tag: { workspace_instance_slug: 'w', project_id: 'p' },
        endpoint: '/x',
        body: null,
      }),
    ).rejects.toBeInstanceOf(PlatformOperationUnsupportedError)
    await expect(
      p.provisionManagerBot({ internal_handle: 't', bot_name_hint: 'b' }),
    ).rejects.toBeInstanceOf(PlatformOperationUnsupportedError)
    await expect(p.reloadCaddy()).rejects.toBeInstanceOf(PlatformOperationUnsupportedError)
    await expect(p.regenerateSudoers()).rejects.toBeInstanceOf(
      PlatformOperationUnsupportedError,
    )
  })

  test('the thrown error names the operation', async () => {
    const p = localAdapter()
    try {
      await p.reloadCaddy()
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PlatformOperationUnsupportedError)
      expect((err as PlatformOperationUnsupportedError).operation).toBe('reloadCaddy')
    }
  })

  test('Open-core methods keep real single-instance behavior', () => {
    const p = localAdapter()
    expect(p.resolveOwnerBySlug('local')?.internal_handle).toBe('t-local-001')
    expect(p.resolveOwnerBySlug('nope')).toBeNull()
    expect(p.capabilities.slug_rename).toBe(false)
    expect(p.slugAvailability.check({ slug: 'valid-slug' }).available).toBe(true)
  })
})
