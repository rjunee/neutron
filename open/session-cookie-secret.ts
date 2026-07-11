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
 * CONFIRM the secret file is owner-only 0600 — tightening a wider (restored /
 * hand-created 0644) file and RE-STATTING to verify the chmod actually took.
 * Returns `true` only when the on-disk perms are confirmed 0600. A stat/chmod
 * failure, or a chmod that silently didn't stick, returns `false` — Blocker #2:
 * the caller must then NOT trust the on-disk value (rotate / go ephemeral).
 */
function confirmOwnerOnly(path: string): boolean {
  try {
    if ((fs.statSync(path).mode & 0o777) === 0o600) return true
    fs.chmodSync(path, 0o600)
    // Re-stat: never ASSUME the chmod took (exotic FS / mount options).
    return (fs.statSync(path).mode & 0o777) === 0o600
  } catch {
    return false
  }
}

/**
 * The persisted secret if present + non-empty. `value` is the trimmed secret;
 * `secured` reports whether its perms are confirmed 0600. Returns `null` when
 * there is no usable file (absent / empty / unreadable) — the caller mints.
 */
function readPersistedSecret(path: string): { value: string; secured: boolean } | null {
  try {
    if (fs.existsSync(path)) {
      const existing = fs.readFileSync(path, 'utf8').trim()
      if (existing.length > 0) {
        return { value: existing, secured: confirmOwnerOnly(path) }
      }
    }
  } catch {
    /* unreadable — caller mints a fresh one */
  }
  return null
}

/** Mint + persist a fresh 0600 secret via exclusive create, confirming perms. */
function mintPersistedSecret(neutronHome: string, path: string): string {
  const secret = randomBytes(24).toString('hex')
  try {
    fs.mkdirSync(neutronHome, { recursive: true })
    // Medium #3 — EXCLUSIVE create (`wx`): if two starters race the first-boot
    // mint, only one wins; the loser gets EEXIST and reads back the winner's
    // secret below, so every process converges on ONE signing key (otherwise
    // each would truncate + return a DIFFERENT key and reject the other's
    // sessions). `mode` on create applies 0600.
    fs.writeFileSync(path, secret + '\n', { flag: 'wx', mode: 0o600 })
    // Blocker #2 — CONFIRM 0600 (re-stat); a persisted-but-unconfirmable secret
    // is not trustworthy, so fall through to the ephemeral path instead.
    if (confirmOwnerOnly(path)) return secret
    throw new Error('could not confirm 0600 on the freshly-persisted secret')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Lost the mint race — return the winner's secret, but ONLY if its perms
      // are confirmed 0600 (never trust an exposed on-disk value).
      const winner = readPersistedSecret(path)
      if (winner !== null && winner.secured) return winner.value
    }
    console.warn(
      `[open] could not securely persist the session-cookie secret to ${path} (${
        err instanceof Error ? err.message : String(err)
      }); using a process-ephemeral secret — owner sessions reset on restart.`,
    )
    return secret
  }
}

/**
 * Read the persisted per-install cookie secret, minting + persisting a fresh
 * random one on first boot. The returned value is ALWAYS a high-entropy random
 * string — never a predictable constant — AND, when it comes from disk, one
 * whose perms we've CONFIRMED are 0600 (Blocker #2 fail-closed contract). An
 * existing secret we cannot secure is ROTATED (mint a fresh 0600 file); if
 * nothing can be secured we return a process-ephemeral secret and warn, so a
 * locked-down FS degrades to "sessions reset on restart" — never a
 * trusted-but-world-readable on-disk value, never a hard boot failure.
 */
export function resolvePersistedCookieSecret(neutronHome: string): string {
  const path = sessionCookieSecretPath(neutronHome)
  const existing = readPersistedSecret(path)
  if (existing !== null) {
    if (existing.secured) return existing.value
    // Blocker #2 — an existing secret whose perms we could NOT confirm/tighten
    // to 0600 is exposed; do NOT trust it. Rotate: drop it and mint a fresh
    // 0600 file (best-effort unlink — if it can't be removed, the mint's `wx`
    // EEXIST readback re-checks perms and falls to ephemeral).
    try {
      fs.unlinkSync(path)
    } catch {
      /* couldn't remove — mintPersistedSecret handles the EEXIST re-check */
    }
  }
  return mintPersistedSecret(neutronHome, path)
}
