/**
 * @neutronai/open — S2 (c) per-install session-cookie secret.
 *
 * The single-owner box signs its owner session cookie AND the local start-token
 * with ONE HMAC secret (`NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET`). When an
 * operator sets none, we must NEVER fall back to a guessable constant (the old
 * `open-ephemeral-<slug>` string let anyone who knew the slug forge the owner
 * cookie). Instead we derive a per-INSTALL RANDOM secret and persist it under
 * NEUTRON_HOME so it is stable across restarts (owner sessions survive a
 * redeploy) yet unforgeable.
 *
 * This is the credential that authenticates the owner, so it is loaded through
 * the shared fail-closed, hostile-FS-resistant persisted-secret core
 * ({@link resolvePersistedSecret}): a symlink / non-regular / broader-than-0600 /
 * too-short value is ROTATED, first-boot mint races converge first-writer-wins,
 * and the last resort is a process-ephemeral secret + loud warn — never a
 * trusted-but-exposed on-disk value, never a guessable constant, never a hang.
 * The S1 owner bearer (`owner-bearer.ts`) rides the SAME core, so both owner
 * credentials share one audited implementation.
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { createLogger } from '@neutronai/logger'

import {
  __persistedLockInternals,
  __persistedSecretTiming,
  resolvePersistedSecret,
} from './persisted-secret.ts'

/**
 * High-entropy floor for a PERSISTED / operator-provided secret. Matches the
 * consumer's documented contract (`gateway/http/cookie-user-claim.ts`: the
 * cookie secret is `>= 16 chars, caller-validated`). A shorter persisted value
 * is invalid → rotate; a shorter operator-set value fails loud at the composer.
 */
export const MIN_COOKIE_SECRET_LEN = 16

const log = createLogger('open-session-cookie')

/** The on-disk secret file (0600) under NEUTRON_HOME. */
export function sessionCookieSecretPath(neutronHome: string): string {
  return join(neutronHome, '.session-cookie-secret')
}

/** Sibling exclusive lockfile that serializes rotation → one sole rotator. */
export function sessionCookieSecretLockPath(neutronHome: string): string {
  return sessionCookieSecretPath(neutronHome) + '.lock'
}

/**
 * Test-only timing/lock seams — re-exported from the shared core so the existing
 * cookie-secret test suite (which drives the bounded lock-wait + ownership-token
 * discipline through these handles) keeps exercising the SAME code the loader
 * runs. Identity re-export: `spyOn(__cookieSecretTiming, 'sleep')` patches the
 * object the core actually calls.
 */
export const __cookieSecretTiming = __persistedSecretTiming
export const __rotateLockInternals = __persistedLockInternals

/**
 * Read the persisted per-install cookie secret, minting + persisting a fresh
 * random one on first boot (or rotating an untrusted one). The returned value is
 * ALWAYS a high-entropy random string — never a predictable constant — AND, when
 * it comes from disk, one read from a confirmed regular, 0600, non-symlink file
 * meeting {@link MIN_COOKIE_SECRET_LEN}. On an unrecoverable FS failure it falls
 * to a process-ephemeral secret (+ warn) rather than a hard boot failure. See
 * {@link resolvePersistedSecret} for the full hardening contract.
 */
export function resolvePersistedCookieSecret(neutronHome: string): string {
  return resolvePersistedSecret({
    path: sessionCookieSecretPath(neutronHome),
    lockPath: sessionCookieSecretLockPath(neutronHome),
    dir: neutronHome,
    minLen: MIN_COOKIE_SECRET_LEN,
    mint: () => randomBytes(24).toString('hex'), // 48 hex chars ≫ the length floor
    tmpPrefix: '.session-cookie-secret.tmp',
    log,
    unconvergedEvent: 'cookie_secret_unconverged',
    unconvergedNote: 'using a process-ephemeral secret — owner sessions reset on restart',
  }).value
}
