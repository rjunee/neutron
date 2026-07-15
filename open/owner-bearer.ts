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
 * Select the app-ws owner-bearer token the composer presents from a threaded
 * `NEUTRON_OWNER_BEARER` env value. TRIMS and requires a non-empty value, so a
 * WHITESPACE-only or empty env is treated as UNSET and falls to a freshly minted
 * (unguessable) token rather than becoming a guessable few-spaces bearer. This
 * is the composer-side last line of defense: `server.ts` already resolves +
 * normalizes the per-install bearer before threading it, but a composer-direct
 * embed / test could pass a raw env value straight through.
 */
export function selectAppWsToken(injected: string | undefined): string {
  const trimmed = injected?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : mintOwnerBearer()
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
      return { value: trimmed, source: 'env' }
    }
    // An explicitly-EMPTY value is treated as unset → fall through to persisted.
  }

  const persisted = resolvePersistedSecret({
    path: ownerBearerPath(neutronHome),
    lockPath: ownerBearerLockPath(neutronHome),
    dir: neutronHome,
    minLen: OWNER_BEARER_MIN_LEN,
    mint: mintOwnerBearer,
    tmpPrefix: '.owner-bearer.tmp',
    log,
    unconvergedEvent: 'owner_bearer_unconverged',
    unconvergedNote:
      'using a process-ephemeral owner bearer — native clients must re-fetch it after restart',
  })
  return { value: persisted.value, source: persisted.source }
}
