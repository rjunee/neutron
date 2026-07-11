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
 * This is the credential that authenticates the owner, so the loader is
 * fail-closed and hostile-FS-resistant: it only ever RETURNS bytes read from a
 * confirmed REGULAR, 0600, NON-SYMLINK file opened NO-FOLLOW whose value meets
 * the high-entropy floor ({@link MIN_COOKIE_SECRET_LEN}). Anything else — a
 * symlink (token-forgery vector), a non-regular file, un-tightenable perms, or a
 * too-short/weak value — is ROTATED (mint a fresh 0600 file), else falls to a
 * process-ephemeral secret. Never a trusted-but-exposed on-disk value, never a
 * guessable constant, never a hard boot failure.
 */

import { randomBytes } from 'node:crypto'
// Namespace import so the security-critical no-follow / perms / rotate branches
// are interceptable in tests (`spyOn(fs, 'openSync' | 'fchmodSync')`) — the
// destructured form isn't reliably spyable under Bun.
import * as fs from 'node:fs'
import { join } from 'node:path'

/**
 * High-entropy floor for a PERSISTED / operator-provided secret. Matches the
 * consumer's documented contract (`gateway/http/cookie-user-claim.ts`: the
 * cookie secret is `>= 16 chars, caller-validated`). A shorter persisted value
 * is invalid → rotate; a shorter operator-set value fails loud at the composer.
 */
export const MIN_COOKIE_SECRET_LEN = 16

/** The on-disk secret file (0600) under NEUTRON_HOME. */
export function sessionCookieSecretPath(neutronHome: string): string {
  return join(neutronHome, '.session-cookie-secret')
}

// EXCLUSIVE, NO-FOLLOW create for the mint path: O_CREAT|O_EXCL fails on ANY
// existing entry (incl. a symlink); O_NOFOLLOW is belt-and-suspenders.
const WX_NOFOLLOW =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW

type ReadResult =
  | { kind: 'ok'; value: string }
  | { kind: 'reject' } // exists but untrusted (symlink / non-regular / perms / too short) → rotate
  | { kind: 'absent' } // no file → mint (keeps the first-boot wx-race convergence intact)

/**
 * Load the persisted secret through a NO-FOLLOW, race-resistant DESCRIPTOR:
 * open `O_NOFOLLOW` (a symlink throws `ELOOP` → reject), `fstat` the fd (require
 * a regular file), enforce + CONFIRM 0600 on the fd, then read the bytes FROM
 * the fd (no second path-based open → no TOCTOU). Only a value meeting the
 * length floor is trusted.
 */
function readPersistedSecret(path: string): ReadResult {
  let fd: number
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (err) {
    // No file → mint. A symlink (ELOOP) or anything else we can't open cleanly →
    // rotate (we will not follow / trust it).
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'reject' }
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return { kind: 'reject' } // reject a fifo/device/dir behind the name
    if ((st.mode & 0o777) !== 0o600) {
      // Tighten on the DESCRIPTOR (not the path), then re-fstat to CONFIRM the
      // chmod actually took — never assume it did.
      try {
        fs.fchmodSync(fd, 0o600)
      } catch {
        return { kind: 'reject' }
      }
      if ((fs.fstatSync(fd).mode & 0o777) !== 0o600) return { kind: 'reject' }
    }
    const value = fs.readFileSync(fd, 'utf8').trim()
    // Empty / short / weak persisted value is invalid → rotate to a fresh one.
    if (value.length < MIN_COOKIE_SECRET_LEN) return { kind: 'reject' }
    return { kind: 'ok', value }
  } catch {
    return { kind: 'reject' }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* already closed / invalid fd — non-fatal */
    }
  }
}

/** Mint + persist a fresh 0600 secret via NO-FOLLOW exclusive create, confirming. */
function mintPersistedSecret(neutronHome: string, path: string): string {
  const secret = randomBytes(24).toString('hex') // 48 hex chars ≫ the length floor
  try {
    fs.mkdirSync(neutronHome, { recursive: true })
    // Medium #3 — EXCLUSIVE create: if two starters race the first-boot mint,
    // only one wins; the loser gets EEXIST and reads back the winner's secret
    // below, so every process converges on ONE signing key. NO-FOLLOW so a
    // planted symlink can never be written through. Explicit fd so the numeric
    // O_* flags apply (the `writeFileSync` flag option is typed string-only).
    const fd = fs.openSync(path, WX_NOFOLLOW, 0o600)
    try {
      fs.writeSync(fd, secret + '\n')
    } finally {
      fs.closeSync(fd)
    }
    // Blocker #2 — CONFIRM the freshly-persisted file reads back as a regular,
    // 0600, valid secret; otherwise don't trust the on-disk copy.
    const check = readPersistedSecret(path)
    if (check.kind === 'ok' && check.value === secret) return secret
    throw new Error('could not confirm the freshly-persisted secret')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Lost the mint race — return the winner's secret, but ONLY if it is a
      // confirmed regular, 0600, valid on-disk value.
      const winner = readPersistedSecret(path)
      if (winner.kind === 'ok') return winner.value
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
 * random one on first boot (or rotating an untrusted one). The returned value is
 * ALWAYS a high-entropy random string — never a predictable constant — AND, when
 * it comes from disk, one read from a confirmed regular, 0600, non-symlink file
 * meeting {@link MIN_COOKIE_SECRET_LEN}. An existing entry we cannot trust is
 * ROTATED; if nothing can be secured we return a process-ephemeral secret and
 * warn (sessions reset on restart) — never a trusted-but-exposed on-disk value,
 * never a hard boot failure.
 */
export function resolvePersistedCookieSecret(neutronHome: string): string {
  const path = sessionCookieSecretPath(neutronHome)
  const read = readPersistedSecret(path)
  if (read.kind === 'ok') return read.value
  if (read.kind === 'reject') {
    // Untrusted existing entry (symlink / non-regular / wrong perms / too short):
    // remove it and mint a fresh secure file. `unlinkSync` removes the SYMLINK
    // itself (not its target). Best-effort — the mint's `wx` EEXIST readback
    // re-checks perms if it can't be removed.
    try {
      fs.unlinkSync(path)
    } catch {
      /* couldn't remove — mintPersistedSecret handles the EEXIST re-check */
    }
  }
  // 'absent' → straight to mint (no unlink → the first-boot wx race converges).
  return mintPersistedSecret(neutronHome, path)
}
