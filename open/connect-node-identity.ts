/**
 * @neutronai/open — the self-hosted instance's OWN Connect signing identity
 * (ISSUES #421).
 *
 * Connect's guest tier makes the receiving node the SOLE AUTHORITY for guest
 * bearers: `connect/guest-auth-handler.ts` claims a single-use invite and then
 * mints the collaborator's bearer with the node's OWN key, and
 * `connect/api/jwt-bearer-middleware.ts` validates that same bearer against a
 * JWKS. On Managed those two halves are fed by the identity service. A
 * self-hosted Neutron has no identity service and, before this module, no
 * asymmetric key material of any kind — which is why Connect could ship in the
 * Open repo and still never be servable there.
 *
 * This is that missing half, and nothing more: ONE Ed25519 keypair per install,
 * used to sign the guest bearers this instance issues and to verify the guest
 * bearers this instance receives. It is deliberately NOT a general identity
 * service — it mints nothing but connect bearers, and it trusts no key but its
 * own.
 *
 * SECURITY POSTURE
 *   - The private key is persisted through {@link resolvePersistedSecret}, so it
 *     inherits the whole hardened contract: 0600-or-rotate, never follow a
 *     symlink, regular-file-only, first-writer-wins under an advisory lock, and
 *     a process-ephemeral fallback (never a predictable constant) if the
 *     filesystem is hostile. An ephemeral key is surfaced on the result so a
 *     caller can see that outstanding guest bearers will not survive a restart.
 *   - The JWKS contains EXACTLY this instance's public key. There is no remote
 *     fetch and no configured issuer, so a bearer signed by anybody else — a
 *     hosted relay, another self-hoster, an attacker running their own
 *     Neutron — fails signature validation here. A self-hosted node federates
 *     with nobody by default.
 *   - `kid` is the RFC 7638 thumbprint of the public JWK, so it is a pure
 *     function of the key: it cannot drift from the material it names, and a
 *     rotated key automatically stops matching old tokens.
 */

import { generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'

import { calculateJwkThumbprint, exportJWK, importPKCS8, type JWK, type KeyLike } from 'jose'
import { JwksCache } from '@neutronai/jwt-validator/index.ts'
import { createLogger } from '@neutronai/logger'

import { resolvePersistedSecret, type PersistedSecretSource } from './persisted-secret.ts'

/**
 * Structural mirror of `connect/api/mint-instance-token.ts:CrossInstanceActiveKey`.
 * Declared inline rather than imported for the SAME reason `runtime/connect-
 * handlers.ts` mirrors the other connect types: the `connect-is-dynamic-only`
 * CI rule (`.dependency-cruiser.cjs`) forbids a static edge into `connect/api/*`
 * from outside `connect/`, and TypeScript's structural typing closes the gap
 * with no `extends` relationship needed.
 */
export interface CrossInstanceActiveKey {
  kid: string
  privateKey: KeyLike
}

const log = createLogger('connect-node-identity')

/** A base64-wrapped PKCS#8 Ed25519 PEM is ~160 chars; the floor rejects a
 *  truncated / emptied file well below that while staying clear of the real
 *  length (an Ed25519 PKCS#8 DER is only 48 bytes, so a DER-based floor would
 *  have to sit under 64 — the PEM wrapper buys headroom AND lets `jose` import
 *  the key directly). */
const MIN_KEY_LEN = 100

export function connectSigningKeyPath(neutronHome: string): string {
  return join(neutronHome, '.connect-signing-key')
}

export function connectSigningKeyLockPath(neutronHome: string): string {
  return join(neutronHome, '.connect-signing-key.lock')
}

/**
 * Generate a fresh Ed25519 private key as a single-line, base64-wrapped PKCS#8
 * PEM. Base64-wrapping keeps the on-disk value one line, which is what the
 * persisted-secret loader's trim-and-length contract expects.
 */
function mintSigningKey(): string {
  const { privateKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return Buffer.from(privateKey as unknown as string, 'utf8').toString('base64')
}

/** Trust predicate: the persisted blob must decode to a PKCS#8 PEM body. */
function isUsableSigningKey(value: string): boolean {
  return decodeSigningKeyPem(value) !== null
}

function decodeSigningKeyPem(value: string): string | null {
  try {
    const pem = Buffer.from(value, 'base64').toString('utf8')
    return pem.includes('-----BEGIN PRIVATE KEY-----') ? pem : null
  } catch {
    return null
  }
}

export interface ConnectNodeIdentity {
  /** The `getActiveKey` thunk `mintInstanceToken` (and therefore the guest-auth
   *  + guest-refresh handlers) signs with. */
  getActiveKey: () => Promise<CrossInstanceActiveKey>
  /** JWKS holding EXACTLY this instance's public key, served in-process. */
  jwks: JwksCache
  /** Stable RFC 7638 thumbprint of the public key. */
  kid: string
  /** The public half, for an owner-facing diagnostic / a future published JWKS. */
  publicJwk: JWK
  /** `'ephemeral'` means the key could not be persisted — guest bearers minted
   *  this boot stop validating after a restart. */
  source: PersistedSecretSource
}

/**
 * Resolve (or first-boot mint) this install's Connect signing identity.
 *
 * The returned {@link ConnectNodeIdentity.jwks} is a real {@link JwksCache} — the
 * exact type `jwt-bearer-middleware` consumes — but its transport is an
 * in-process function returning this instance's own key set. Nothing is fetched
 * over the network, so there is no bootstrap dependency, no outage mode, and no
 * third party who can add a key to the set this node trusts.
 */
export async function resolveConnectNodeIdentity(
  neutronHome: string,
): Promise<ConnectNodeIdentity> {
  const persisted = resolvePersistedSecret({
    path: connectSigningKeyPath(neutronHome),
    lockPath: connectSigningKeyLockPath(neutronHome),
    dir: neutronHome,
    minLen: MIN_KEY_LEN,
    validate: isUsableSigningKey,
    mint: mintSigningKey,
    tmpPrefix: '.connect-signing-key.tmp',
    log,
    unconvergedEvent: 'connect_signing_key_unconverged',
    unconvergedNote:
      'using a process-ephemeral Connect signing key — collaborator bearers stop validating after a restart',
  })

  // The loader guarantees a value meeting the floor + predicate, so this decode
  // succeeds; the throw is an assertion, not an expected path.
  const pem = decodeSigningKeyPem(persisted.value)
  if (pem === null) {
    throw new Error('connect signing key did not decode as PKCS#8 after validation')
  }
  // `extractable` so the PUBLIC half can be derived for the JWKS. The private
  // half never leaves this process.
  const privateKey = await importPKCS8(pem, 'EdDSA', { extractable: true })
  const privateJwk = await exportJWK(privateKey)
  // Public OKP JWK is exactly {kty, crv, x} — everything else on the exported
  // private JWK is secret material and must never reach the key set.
  const publicJwk: JWK = { kty: privateJwk.kty!, crv: privateJwk.crv!, x: privateJwk.x! }
  const kid = await calculateJwkThumbprint(publicJwk, 'sha256')
  const keySet = { keys: [{ ...publicJwk, kid, alg: 'EdDSA', use: 'sig' }] }

  const jwks = new JwksCache('neutron:self/connect-jwks', {
    // In-process transport: this node IS the authority for its own guest
    // bearers, so the "fetch" is a constant. Keeping the JwksCache type means
    // the middleware, the validator and every downstream consumer are the same
    // code Managed runs.
    fetch: async () =>
      new Response(JSON.stringify(keySet), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  })

  if (persisted.source === 'ephemeral') {
    log.warn('connect_signing_key_ephemeral', {
      note: 'Connect collaborator bearers will not survive a gateway restart',
    })
  }

  return {
    getActiveKey: async (): Promise<CrossInstanceActiveKey> => ({ kid, privateKey }),
    jwks,
    kid,
    publicJwk,
    source: persisted.source,
  }
}
