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
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The on-disk secret file (0600) under NEUTRON_HOME. */
export function sessionCookieSecretPath(neutronHome: string): string {
  return join(neutronHome, '.session-cookie-secret')
}

/**
 * Read the persisted per-install cookie secret, minting + persisting a fresh
 * random one on first boot. The returned value is ALWAYS a high-entropy random
 * string — never a predictable constant. If NEUTRON_HOME is not writable we
 * still return a random (process-ephemeral) secret and warn, so a locked-down
 * FS degrades to "sessions reset on restart" rather than a guessable secret or
 * a hard boot failure.
 */
export function resolvePersistedCookieSecret(neutronHome: string): string {
  const path = sessionCookieSecretPath(neutronHome)
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim()
      if (existing.length > 0) return existing
    }
  } catch {
    /* unreadable — fall through and mint a fresh one */
  }
  const secret = randomBytes(24).toString('hex')
  try {
    mkdirSync(neutronHome, { recursive: true })
    // `mode` on writeFileSync only applies when CREATING the file; force 0600
    // afterwards in case it pre-existed with wider perms (mirrors the
    // install-token-env.ts secret-write idiom).
    writeFileSync(path, secret + '\n', { mode: 0o600 })
    try {
      chmodSync(path, 0o600)
    } catch {
      /* non-fatal */
    }
  } catch (err) {
    console.warn(
      `[open] could not persist the session-cookie secret to ${path} (${
        err instanceof Error ? err.message : String(err)
      }); using a process-ephemeral secret — owner sessions reset on restart.`,
    )
  }
  return secret
}
