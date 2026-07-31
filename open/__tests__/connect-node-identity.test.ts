/**
 * The self-hosted install's own Connect signing identity (ISSUES #421).
 *
 * This is net-new key material in the Open tree — before this, Open had no
 * asymmetric key of any kind, which is the reason Connect's guest tier could not
 * run there. Key handling gets its own pins:
 *
 *   - the PRIVATE half never reaches the served key set (an `exportJWK` of a
 *     private OKP key carries `d`; shipping the whole object would publish the
 *     signing key to every unauthenticated caller that can reach the JWKS);
 *   - the key SURVIVES a restart, so a collaborator's bearer keeps validating;
 *   - the key set contains EXACTLY this instance's key, so a bearer signed by
 *     anybody else fails — a self-hosted node federates with nobody by default;
 *   - `kid` is a pure function of the material (RFC 7638 thumbprint).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { calculateJwkThumbprint, type JWK } from 'jose'

import {
  connectSigningKeyPath,
  resolveConnectNodeIdentity,
} from '../connect-node-identity.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'connect-node-identity-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** The key set the middleware would actually see. */
async function servedKeySet(
  identity: Awaited<ReturnType<typeof resolveConnectNodeIdentity>>,
): Promise<{ keys: JWK[] }> {
  return (await identity.jwks.get()) as { keys: JWK[] }
}

describe('resolveConnectNodeIdentity', () => {
  test('the served JWKS carries ONLY public material — no `d`, no private params', async () => {
    const identity = await resolveConnectNodeIdentity(home)
    const set = await servedKeySet(identity)
    expect(set.keys).toHaveLength(1)
    const jwk = set.keys[0]!
    // The whole point: an OKP private JWK differs from the public one by `d`.
    expect(jwk.d).toBeUndefined()
    expect(Object.keys(jwk).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x'])
    expect(jwk.kty).toBe('OKP')
    expect(jwk.crv).toBe('Ed25519')
    expect(jwk.alg).toBe('EdDSA')
    // And the same for the publicJwk the identity exposes to callers.
    expect((identity.publicJwk as unknown as Record<string, unknown>)['d']).toBeUndefined()
  })

  test('the key PERSISTS across a restart — bearers keep validating', async () => {
    const first = await resolveConnectNodeIdentity(home)
    expect(first.source).toBe('persisted')
    const second = await resolveConnectNodeIdentity(home)
    expect(second.kid).toBe(first.kid)
    expect((await servedKeySet(second)).keys[0]!.x).toBe((await servedKeySet(first)).keys[0]!.x)
  })

  test('the private key file is owner-only (0600) on disk', async () => {
    await resolveConnectNodeIdentity(home)
    const mode = statSync(connectSigningKeyPath(home)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('a DIFFERENT install gets a DIFFERENT key — no shared or derived secret', async () => {
    const other = mkdtempSync(join(tmpdir(), 'connect-node-identity-other-'))
    try {
      const a = await resolveConnectNodeIdentity(home)
      const b = await resolveConnectNodeIdentity(other)
      expect(a.kid).not.toBe(b.kid)
      // …and neither node's key set contains the other's key, so a bearer minted
      // by one instance cannot authenticate against the other.
      const aKeys = (await servedKeySet(a)).keys.map((k) => k.x)
      const bKeys = (await servedKeySet(b)).keys.map((k) => k.x)
      expect(aKeys).not.toContain(bKeys[0])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  test('kid is the RFC 7638 thumbprint of the public key — it cannot drift', async () => {
    const identity = await resolveConnectNodeIdentity(home)
    const jwk = identity.publicJwk as { kty: string; crv: string; x: string }
    const expected = await calculateJwkThumbprint(
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x } as JWK,
      'sha256',
    )
    expect(identity.kid).toBe(expected)
    expect((await servedKeySet(identity)).keys[0]!.kid).toBe(expected)
  })
})
