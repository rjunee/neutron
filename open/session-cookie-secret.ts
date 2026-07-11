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
 * too-short/weak value — is ROTATED via an ATOMIC temp-file + `rename` (no
 * unlink-then-create window) and then RE-READ, so concurrent starters CONVERGE
 * on one on-disk secret. Otherwise it falls to a process-ephemeral secret. Never
 * a trusted-but-exposed on-disk value, never a guessable constant, never a hard
 * boot failure, never a hang (bounded retries).
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

/** Per-process temp-name sequence (pid + counter — deterministic, never Math.random). */
let tmpSeq = 0

/**
 * ATOMICALLY install a fresh 0600 secret and RETURN THE ON-DISK BYTES.
 *
 * Write the new secret to a unique per-process TEMP file in the same dir
 * (`O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`), then `renameSync(tmp → path)` — a
 * SINGLE syscall that atomically replaces whatever is there (a planted symlink,
 * a weak regular file, or nothing) with our regular 0600 file. There is NO
 * unlink-then-create window (the concurrent-rotation divergence bug). After the
 * rename we ALWAYS RE-READ the target through the no-follow loader and return
 * THOSE bytes — so if a concurrent starter's rename landed last, every process
 * converges on that one on-disk secret rather than each returning its own mint.
 * Returns `null` when this attempt couldn't install/confirm (caller retries or
 * falls to ephemeral). Best-effort temp cleanup on every failure path.
 */
function installFreshSecret(neutronHome: string, path: string): string | null {
  const secret = randomBytes(24).toString('hex') // 48 hex chars ≫ the length floor
  const tmp = join(neutronHome, `.session-cookie-secret.tmp.${process.pid}.${(tmpSeq += 1)}`)
  let fd: number
  try {
    fd = fs.openSync(tmp, WX_NOFOLLOW, 0o600)
  } catch {
    return null
  }
  try {
    fs.writeSync(fd, secret + '\n')
  } catch {
    try {
      fs.closeSync(fd)
    } catch {
      /* non-fatal */
    }
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* non-fatal */
    }
    return null
  }
  try {
    fs.closeSync(fd)
  } catch {
    /* non-fatal */
  }
  try {
    fs.renameSync(tmp, path) // atomic replace (symlink or regular), one syscall
  } catch {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* non-fatal */
    }
    return null
  }
  // ALWAYS re-read: whoever renamed LAST is what every process converges on.
  const back = readPersistedSecret(path)
  return back.kind === 'ok' ? back.value : null
}

/**
 * Read the persisted per-install cookie secret, minting + persisting a fresh
 * random one on first boot (or rotating an untrusted one). The returned value is
 * ALWAYS a high-entropy random string — never a predictable constant — AND, when
 * it comes from disk, one read from a confirmed regular, 0600, non-symlink file
 * meeting {@link MIN_COOKIE_SECRET_LEN}. An existing entry we cannot trust is
 * ROTATED atomically; concurrent starters CONVERGE on one on-disk secret; if
 * nothing can be secured we return a process-ephemeral secret and warn (sessions
 * reset on restart) — never a trusted-but-exposed on-disk value, never a hard
 * boot failure, never a hang (bounded retries).
 */
export function resolvePersistedCookieSecret(neutronHome: string): string {
  const path = sessionCookieSecretPath(neutronHome)
  // Fast path: an existing VALID secret is returned UNCHANGED — no rotation, no
  // write (the single-process loopback dogfood happy path: one no-follow read).
  const first = readPersistedSecret(path)
  if (first.kind === 'ok') return first.value

  try {
    fs.mkdirSync(neutronHome, { recursive: true })
  } catch {
    /* install may still fail below → ephemeral */
  }

  // Bounded rotate→re-read cycles so a pathological FS can't spin.
  const MAX_ATTEMPTS = 3
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    // A valid secret may have appeared meanwhile (a concurrent starter won) —
    // converge on it instead of installing our own.
    const cur = readPersistedSecret(path)
    if (cur.kind === 'ok') return cur.value
    const installed = installFreshSecret(neutronHome, path)
    if (installed !== null) return installed
  }
  console.warn(
    `[open] could not converge a persisted session-cookie secret at ${path}; using a ` +
      `process-ephemeral secret — owner sessions reset on restart.`,
  )
  return randomBytes(24).toString('hex')
}
