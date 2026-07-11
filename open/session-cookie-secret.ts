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
// Namespace import so the security-critical TOCTOU / perms branches are
// interceptable in tests (`spyOn(fs, 'existsSync')`) — the destructured form
// isn't reliably spyable under Bun.
import * as fs from 'node:fs'
import { join } from 'node:path'

/** The on-disk secret file (0600) under NEUTRON_HOME. */
export function sessionCookieSecretPath(neutronHome: string): string {
  return join(neutronHome, '.session-cookie-secret')
}

/**
 * Enforce owner-only 0600 on the secret file. A restored backup / manually
 * created file can land 0644 (world-readable) — a signing secret must never be.
 * Best-effort + non-fatal (an exotic FS chmod failure must not abort boot).
 */
function enforceOwnerOnly(path: string): void {
  try {
    if ((fs.statSync(path).mode & 0o777) !== 0o600) fs.chmodSync(path, 0o600)
  } catch {
    /* non-fatal */
  }
}

/** Read the persisted secret if present + non-empty, enforcing 0600 first. */
function readPersistedSecret(path: string): string | null {
  try {
    if (fs.existsSync(path)) {
      const existing = fs.readFileSync(path, 'utf8').trim()
      if (existing.length > 0) {
        // High #2 — a pre-existing (restored / hand-created) file may be 0644;
        // tighten it to 0600 BEFORE we return it, so a world-readable secret is
        // never silently trusted.
        enforceOwnerOnly(path)
        return existing
      }
    }
  } catch {
    /* unreadable — caller mints a fresh one */
  }
  return null
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
  const existing = readPersistedSecret(path)
  if (existing !== null) return existing

  const secret = randomBytes(24).toString('hex')
  try {
    fs.mkdirSync(neutronHome, { recursive: true })
    // Medium #3 — EXCLUSIVE create (`wx`): if two starters race the first-boot
    // mint, only one wins; the loser gets EEXIST and reads back the winner's
    // secret below, so every process converges on ONE signing key (otherwise
    // each would truncate + return a DIFFERENT key and reject the other's
    // sessions). `mode` on create applies 0600.
    fs.writeFileSync(path, secret + '\n', { flag: 'wx', mode: 0o600 })
    enforceOwnerOnly(path)
    return secret
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Lost the mint race — return the winner's already-persisted secret.
      const winner = readPersistedSecret(path)
      if (winner !== null) return winner
    }
    console.warn(
      `[open] could not persist the session-cookie secret to ${path} (${
        err instanceof Error ? err.message : String(err)
      }); using a process-ephemeral secret — owner sessions reset on restart.`,
    )
    return secret
  }
}
