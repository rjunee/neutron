/**
 * @neutronai/open — S1 per-install OWNER BEARER credential.
 *
 * S0 minted a per-BOOT random app-ws token and S2 gated the guessable
 * `dev:owner` bearer on a LOOPBACK bind. S1 replaces the per-boot token with a
 * per-INSTALL owner bearer that is STABLE across restarts (so a native Expo/CLI
 * client keeps working after a redeploy, and the credential is a real thing an
 * operator can hand to a device) yet still unguessable — and makes a
 * properly-configured owner credential MANDATORY on a wide (public) bind.
 *
 * Resolution order:
 *   1. `NEUTRON_OWNER_BEARER` — an operator-set bearer (source `'env'`). Must
 *      meet the length floor; a too-short explicit value FAILS LOUD (a
 *      misconfiguration should never silently downgrade to a minted one).
 *   2. Otherwise a per-install RANDOM bearer PERSISTED 0600 under NEUTRON_HOME
 *      (source `'persisted'`), loaded through the shared hardened, fail-closed
 *      persisted-secret core (symlink/perms/too-short → rotate; races converge).
 *   3. If nothing on disk can be secured, a process-EPHEMERAL bearer + warn
 *      (source `'ephemeral'`) — never a guessable constant, never a hard failure
 *      here (the wide-bind BOOT guard, not this loader, decides fail-closed).
 *
 * The returned `source` feeds {@link assertOwnerCredentialPolicy}: a wide
 * (non-loopback) bind whose bearer is only `'ephemeral'` refuses to boot. This
 * loader NEVER throws for the persisted/ephemeral path (only for an explicit,
 * too-short env override).
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { createLogger } from '@neutronai/logger'

import { resolvePersistedSecret, type PersistedSecretSource } from './persisted-secret.ts'

/** Env var an operator can set to pin the owner bearer explicitly. */
export const OWNER_BEARER_ENV_VAR = 'NEUTRON_OWNER_BEARER'

/**
 * Length floor for the owner bearer — matches the cookie-secret floor. A minted
 * bearer (`nbt_` + 32 base64url chars = 36) clears it comfortably; an operator's
 * explicit value must too.
 */
export const OWNER_BEARER_MIN_LEN = 16

/** Recognizable, operator-visible prefix for a minted bearer. */
const MINTED_BEARER_PREFIX = 'nbt_'

/**
 * BEST-EFFORT mechanical-degeneracy filter for an OPERATOR-SUPPLIED owner bearer.
 *
 * The GUARANTEED-strong path is the auto-MINTED bearer (`nbt_` + 24 random bytes,
 * cryptographic) — operators should leave `NEUTRON_OWNER_BEARER` unset and let it
 * mint. When an operator DOES set it, we cannot prove its true entropy (guessability
 * detection is an unwinnable heuristic arms race — every filter has bypasses, e.g.
 * dictionary words with case variation). So this is a floor that rejects the OBVIOUS
 * mechanical degeneracies — repeated (`'a'×16` → 0.0 bits/char), short cycles
 * (`'ab'×8`), too-few distinct characters, and monotonic sequences (`'abcdefgh…'`,
 * `'0123456789…'`) — NOT a proof of strength. The error message + docs direct the
 * operator to a RANDOMLY-GENERATED value; the minted default is the real guarantee.
 */
export const OWNER_BEARER_MIN_ENTROPY_BITS_PER_CHAR = 3.0
/** Absolute floor on DISTINCT characters (a diverse random value has many more). */
export const OWNER_BEARER_MIN_DISTINCT_CHARS = 8
/** Reject when this fraction of adjacent-char steps are ±1 (a monotonic sequence). */
const OWNER_BEARER_MAX_SEQUENTIAL_FRACTION = 0.5

/** Shannon entropy of a string's character distribution, in bits per character. */
function shannonBitsPerChar(s: string): number {
  if (s.length === 0) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const count of freq.values()) {
    const p = count / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/** Fraction of adjacent-character transitions that step by exactly ±1 code point —
 *  high for a monotonic run ('abcdef…' → 1.0, '0123456789abcdef' → ~0.93). */
function sequentialFraction(s: string): number {
  if (s.length < 2) return 0
  let seq = 0
  for (let i = 1; i < s.length; i += 1) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1)
    if (d === 1 || d === -1) seq += 1
  }
  return seq / (s.length - 1)
}

/** TRUE when a bearer clears the best-effort mechanical-degeneracy floor (see above). */
export function hasSufficientBearerEntropy(s: string): boolean {
  if (new Set(s).size < OWNER_BEARER_MIN_DISTINCT_CHARS) return false
  if (sequentialFraction(s) >= OWNER_BEARER_MAX_SEQUENTIAL_FRACTION) return false
  return shannonBitsPerChar(s) >= OWNER_BEARER_MIN_ENTROPY_BITS_PER_CHAR
}

const log = createLogger('open-owner-bearer')

/** Where the owner bearer came from — `'env'` + `'persisted'` are PERSISTENT. */
export type OwnerBearerSource = 'env' | PersistedSecretSource

export interface OwnerBearerResult {
  value: string
  source: OwnerBearerSource
}

/** Mint a fresh unguessable owner bearer (`nbt_<base64url>`), no trailing newline. */
function mintOwnerBearer(): string {
  return `${MINTED_BEARER_PREFIX}${randomBytes(24).toString('base64url')}`
}

/**
 * TRUE when a threaded bearer value is a VALID persistent owner credential: a
 * non-whitespace value meeting {@link OWNER_BEARER_MIN_LEN}. A whitespace-only,
 * empty, or too-short value (e.g. `NEUTRON_OWNER_BEARER=a`) is NOT persistent —
 * so on a wide bind it fails closed, and it is never used as the token. Mirrors
 * the floor `resolveOwnerBearer` enforces, so the composer-direct path can't
 * accept a weaker credential than the server entrypoint (Codex r3).
 */
export function isValidThreadedBearer(injected: string | undefined): boolean {
  const trimmed = injected?.trim()
  return (
    trimmed !== undefined &&
    trimmed.length >= OWNER_BEARER_MIN_LEN &&
    hasSufficientBearerEntropy(trimmed)
  )
}

/**
 * Select the app-ws owner-bearer token the composer presents from a threaded
 * bearer value. Uses the value VERBATIM (trimmed) when it is a valid persistent
 * bearer ({@link isValidThreadedBearer}); otherwise falls to a freshly minted
 * (unguessable) token — so a whitespace-only / too-short value never becomes the
 * authenticating credential. `server.ts` already resolves + validates the
 * per-install bearer before threading it, but a composer-direct embed / test
 * could pass a raw value straight through — this is the last line of defense.
 */
export function selectAppWsToken(injected: string | undefined): string {
  return isValidThreadedBearer(injected) ? injected!.trim() : mintOwnerBearer()
}

/** The on-disk owner-bearer file (0600) under NEUTRON_HOME. */
export function ownerBearerPath(neutronHome: string): string {
  return join(neutronHome, '.owner-bearer')
}

/** Sibling exclusive lockfile serializing owner-bearer rotation. */
export function ownerBearerLockPath(neutronHome: string): string {
  return ownerBearerPath(neutronHome) + '.lock'
}

/**
 * Resolve the per-install owner bearer. `env[NEUTRON_OWNER_BEARER]` wins when
 * set (trimmed; a too-short explicit value throws LOUD); otherwise the persisted
 * per-install bearer under NEUTRON_HOME. Returns the value + its `source` so the
 * caller can gate a wide bind on a NON-persistent (`ephemeral`) credential.
 */
export function resolveOwnerBearer(
  neutronHome: string,
  env: Record<string, string | undefined>,
): OwnerBearerResult {
  const raw = env[OWNER_BEARER_ENV_VAR]
  if (raw !== undefined) {
    const trimmed = raw.trim()
    if (trimmed.length > 0) {
      if (trimmed.length < OWNER_BEARER_MIN_LEN) {
        throw new Error(
          `${OWNER_BEARER_ENV_VAR} is too short (${trimmed.length} < ${OWNER_BEARER_MIN_LEN} chars) — ` +
            `refusing to authenticate the owner with a weak bearer. Use a high-entropy value ` +
            `(e.g. 32+ random chars) or unset it to auto-mint a per-install bearer.`,
        )
      }
      if (!hasSufficientBearerEntropy(trimmed)) {
        throw new Error(
          `${OWNER_BEARER_ENV_VAR} is too low-entropy (repeated or predictable characters) — ` +
            `refusing to authenticate the owner with a GUESSABLE bearer on a network-reachable ` +
            `surface. Use a high-entropy value (e.g. 32+ random chars) or unset it to auto-mint ` +
            `a per-install bearer.`,
        )
      }
      return { value: trimmed, source: 'env' }
    }
    // An explicitly-EMPTY value is treated as unset → fall through to persisted.
  }

  const persisted = resolvePersistedSecret({
    path: ownerBearerPath(neutronHome),
    lockPath: ownerBearerLockPath(neutronHome),
    dir: neutronHome,
    minLen: OWNER_BEARER_MIN_LEN,
    // A persisted `.owner-bearer` that clears the length floor but is LOW-ENTROPY
    // (guessable) must ROTATE, not be trusted — otherwise a planted/legacy weak file
    // would authenticate the owner on a wide bind, defeating the env-path entropy gate.
    validate: hasSufficientBearerEntropy,
    mint: mintOwnerBearer,
    tmpPrefix: '.owner-bearer.tmp',
    log,
    unconvergedEvent: 'owner_bearer_unconverged',
    unconvergedNote:
      'using a process-ephemeral owner bearer — native clients must re-fetch it after restart',
  })
  return { value: persisted.value, source: persisted.source }
}
