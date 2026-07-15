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
 * symlink (token-forgery vector), a non-regular file, a value found with perms
 * BROADER than 0600 (potentially already read by another local user → we ROTATE
 * rather than tighten-and-trust, since a later chmod can't un-expose it), or a
 * too-short/weak value — is ROTATED.
 *
 * Rotation aims for FIRST-WRITER-WINS convergence rather than last-writer-wins:
 * `rename(tmp → path)` is atomic but last-writer-wins (starter A can
 * rename→read→return secret A before starter B renames→returns secret B → they
 * DIVERGE). To converge, rotation is serialized behind a BEST-EFFORT advisory
 * sibling lockfile (`O_CREAT|O_EXCL|O_NOFOLLOW`). The process that creates the
 * lock rotates — re-reading the target FIRST so it adopts, not overwrites, a
 * secret a prior rotator already installed — while every competitor waits
 * (bounded) and ADOPTS that one on-disk secret. The lock carries a UNIQUE owner
 * TOKEN (pid + monotonic seq + time): a process only unlinks a lock still
 * carrying ITS token, only reclaims one confirmed stale (same token across two
 * reads + age), and RE-VERIFIES its token immediately after creating the lock —
 * yielding (adopt/retry) if a racer swapped the lock in between.
 *
 * HONEST LIMITATION: this is best-effort, NOT an absolute guarantee. A pathname
 * lockfile is validated by NAME, so a sub-millisecond check-then-unlink /
 * check-then-rotate window is inherent and cannot be fully closed without OS
 * advisory locking (flock/fcntl on a held fd), which Node doesn't expose without
 * a native addon — deliberately NOT taken here (platform-variance risk outweighs
 * an unreachable race). The post-acquire re-verify shrinks the window; it does
 * not eliminate it. In neutron's actual deployment — ONE server process per
 * NEUTRON_HOME — concurrent rotation of the same home does not occur, so this
 * residual window is unreachable in practice. On any failure the last resort is
 * a process-ephemeral secret + loud warn: never a trusted-but-exposed on-disk
 * value, never a guessable constant, never a hard boot failure, never a hang
 * (bounded waits/retries), never SILENT divergence-with-false-confidence.
 */

import { randomBytes } from 'node:crypto'
// Namespace import so the security-critical no-follow / perms / rotate branches
// are interceptable in tests (`spyOn(fs, 'openSync' | 'fchmodSync')`) — the
// destructured form isn't reliably spyable under Bun.
import * as fs from 'node:fs'
import { join } from 'node:path'

import { createLogger } from '@neutronai/logger'

/**
 * High-entropy floor for a PERSISTED / operator-provided secret. Matches the
 * consumer's documented contract (`gateway/http/cookie-user-claim.ts`: the
 * cookie secret is `>= 16 chars, caller-validated`). A shorter persisted value
 * is invalid → rotate; a shorter operator-set value fails loud at the composer.
 */
const log = createLogger('open-session-cookie')

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
    // Perms broader than 0600 mean another local user may have ALREADY read the
    // secret — a later `chmod` cannot un-expose it, so tightening-and-trusting
    // would keep a potentially-compromised value as the signing key. Treat any
    // non-owner-only file as COMPROMISED and ROTATE (mint a fresh secret via the
    // first-writer-wins install path).
    if ((st.mode & 0o777) !== 0o600) return { kind: 'reject' }
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
 * Install a fresh 0600 secret and RETURN THE ON-DISK BYTES. Called ONLY by the
 * process holding the rotate lock, so there is never a competing rename.
 *
 * Write the new secret to a unique per-process TEMP file in the same dir
 * (`O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`), then `renameSync(tmp → path)` — a
 * SINGLE syscall that atomically replaces whatever is there (a planted symlink,
 * a weak regular file, or nothing) with our regular 0600 file (no
 * unlink-then-create window). After the rename we RE-READ the target through the
 * no-follow loader and return THOSE confirmed bytes. Returns `null` when this
 * attempt couldn't install/confirm (caller falls to ephemeral). Best-effort temp
 * cleanup on every failure path.
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

/** Sibling exclusive lockfile that serializes rotation → one sole rotator. */
export function sessionCookieSecretLockPath(neutronHome: string): string {
  return sessionCookieSecretPath(neutronHome) + '.lock'
}

// Bounded lock cooperation: a competitor's rotation is a couple of syscalls, so
// a short wait covers it; a lock older than the (much larger) stale threshold
// means a crashed holder and is reclaimed. Every wait/retry is bounded — a
// pathological FS or a truly stuck lock falls to an ephemeral secret, never a
// hang.
const LOCK_WAIT_TOTAL_MS = 1000
const LOCK_WAIT_STEP_MS = 20
const LOCK_STALE_MS = 5000
const MAX_LOCK_ACQUIRE_ATTEMPTS = 3

/**
 * Synchronous sleep seam. Boot is single-threaded and synchronous here, so we
 * block the thread for the wait step. Exposed as a mutable member ONLY so tests
 * can drive the bounded lock-wait deterministically (`spyOn(this, 'sleep')`).
 */
export const __cookieSecretTiming = {
  sleep(ms: number): void {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    } catch {
      /* SharedArrayBuffer unavailable — skip the sleep; the loop is still bounded */
    }
  },
}

/** A held rotate lock: the open fd plus the UNIQUE owner token we stamped in it. */
type HeldRotateLock = { fd: number; token: string }

/** Per-process monotonic acquire counter → unique tokens (never Math.random). */
let lockSeq = 0

/** Read the lock's owner token + mtime via a NO-FOLLOW fd (null on any error). */
function readRotateLockObservation(lockPath: string): { token: string; mtimeMs: number } | null {
  let fd: number
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const mtimeMs = fs.fstatSync(fd).mtimeMs
    const token = fs.readFileSync(fd, 'utf8').trim()
    return { token, mtimeMs }
  } catch {
    return null
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Classify an EEXIST lock without touching it: a LIVE competitor (→ wait +
 * adopt), a RECLAIMABLE crashed-holder orphan, or GONE (vanished → retry the
 * create). A stale lock is only RECLAIMABLE if a SECOND read still shows the
 * SAME token and is still stale — so we never reclaim a lock that just changed
 * hands (was reclaimed + refreshed by someone else) between our two reads.
 */
function classifyRotateLock(lockPath: string): 'live' | 'reclaimable' | 'gone' {
  const o1 = readRotateLockObservation(lockPath)
  if (!o1) return 'gone'
  if (Date.now() - o1.mtimeMs <= LOCK_STALE_MS) return 'live'
  const o2 = readRotateLockObservation(lockPath)
  if (!o2) return 'gone'
  if (o2.token !== o1.token || Date.now() - o2.mtimeMs <= LOCK_STALE_MS) return 'live'
  return 'reclaimable'
}

/**
 * Try to become the SOLE rotator by exclusively creating the sibling lockfile
 * (`O_CREAT|O_EXCL|O_NOFOLLOW`) and stamping a UNIQUE owner token into it.
 * Returns the held lock, or `null` if a LIVE competitor holds it. A confirmed
 * stale orphan is reclaimed and re-tried, bounded so a churning adversary can't
 * spin us.
 */
function tryAcquireRotateLock(lockPath: string): HeldRotateLock | null {
  for (let attempt = 0; attempt < MAX_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    let fd: number
    try {
      fd = fs.openSync(lockPath, WX_NOFOLLOW, 0o600)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null // unexpected → ephemeral
      const cls = classifyRotateLock(lockPath)
      if (cls === 'live') return null // live competitor → wait + adopt
      if (cls === 'reclaimable') {
        try {
          fs.unlinkSync(lockPath) // reclaim the confirmed orphan…
        } catch {
          /* someone else reclaimed it first — non-fatal */
        }
      }
      continue // 'gone' or just-reclaimed → retry the exclusive create
    }
    // We created it → stamp a UNIQUE owner token (pid + monotonic seq + time) so
    // release/reclaim can PROVE ownership and never touch another owner's lock.
    const token = `${process.pid}.${(lockSeq += 1)}.${Date.now()}`
    try {
      fs.writeSync(fd, token)
    } catch {
      try {
        fs.closeSync(fd)
      } catch {
        /* non-fatal */
      }
      try {
        fs.unlinkSync(lockPath)
      } catch {
        /* non-fatal */
      }
      return null
    }
    // Post-acquire RE-VERIFY: confirm the on-disk token is still OURS. Because a
    // pathname lock is validated by NAME, a racer that reclaimed+recreated the
    // lock in the sub-millisecond window since our exclusive create would now
    // own the pathname under a DIFFERENT token. If so we are NOT the sole rotator
    // → YIELD (close our stale fd, return null; the caller re-reads + adopts or
    // retries) rather than rotate concurrently. This shrinks — it cannot fully
    // close — the inherent check-then-act window of a pathname lockfile.
    const verify = readRotateLockObservation(lockPath)
    if (verify === null || verify.token !== token) {
      try {
        fs.closeSync(fd)
      } catch {
        /* non-fatal */
      }
      return null
    }
    return { fd, token }
  }
  return null
}

/**
 * Release the lock, unlinking the pathname ONLY if it still carries OUR token.
 * If we were reclaimed while stalled (another process now owns the pathname),
 * the token won't match and we leave THEIR lock intact — otherwise our release
 * would delete a live lock and let a third rotator run concurrently. Best-effort;
 * on any ambiguity we prefer NOT unlinking (the lock is harmlessly reclaimed as
 * stale later) over removing a lock that might be someone else's.
 */
function releaseRotateLock(held: HeldRotateLock, lockPath: string): void {
  const cur = readRotateLockObservation(lockPath)
  if (cur !== null && cur.token === held.token) {
    try {
      fs.unlinkSync(lockPath)
    } catch {
      /* already gone — non-fatal */
    }
  }
  try {
    fs.closeSync(held.fd)
  } catch {
    /* already closed — non-fatal */
  }
}

/** Test-only seam: exercise the lock-ownership discipline directly. */
export const __rotateLockInternals = {
  acquire: tryAcquireRotateLock,
  release: releaseRotateLock,
}

/**
 * Read the persisted per-install cookie secret, minting + persisting a fresh
 * random one on first boot (or rotating an untrusted one). The returned value is
 * ALWAYS a high-entropy random string — never a predictable constant — AND, when
 * it comes from disk, one read from a confirmed regular, 0600, non-symlink file
 * meeting {@link MIN_COOKIE_SECRET_LEN}.
 *
 * Best-effort FIRST-WRITER-WINS convergence: an untrusted/absent entry is rotated
 * behind the advisory sibling lock (see the file header for the ownership-token +
 * post-acquire-re-verify discipline and its inherent, unreachable-in-deployment
 * residual window). The process that acquires the lock rotates — re-reading the
 * target FIRST so it ADOPTS (not overwrites) a secret a prior rotator already
 * installed — while every competitor waits (bounded) and adopts that same on-disk
 * secret, so concurrent starters converge on the first installed value rather than
 * diverging. If nothing can be secured we return a process-ephemeral secret and
 * warn (sessions reset on restart) — never a trusted-but-exposed on-disk value,
 * never a hard boot failure, never a hang, never silent divergence.
 */
export function resolvePersistedCookieSecret(neutronHome: string): string {
  const path = sessionCookieSecretPath(neutronHome)
  // Fast path: an existing VALID secret is returned UNCHANGED — no lock, no
  // write, no rotation (the single-process loopback dogfood happy path: one
  // no-follow read).
  const first = readPersistedSecret(path)
  if (first.kind === 'ok') return first.value

  try {
    fs.mkdirSync(neutronHome, { recursive: true })
  } catch {
    /* install may still fail below → ephemeral */
  }

  const lockPath = sessionCookieSecretLockPath(neutronHome)
  const deadline = Date.now() + LOCK_WAIT_TOTAL_MS

  while (Date.now() <= deadline) {
    const held = tryAcquireRotateLock(lockPath)
    if (held !== null) {
      // We are the SOLE rotator.
      try {
        // A prior rotator may have already installed a valid secret in a window
        // before we got the lock → ADOPT it, don't overwrite (first-writer-wins).
        const underLock = readPersistedSecret(path)
        if (underLock.kind === 'ok') return underLock.value
        const installed = installFreshSecret(neutronHome, path)
        if (installed !== null) return installed
        break // couldn't install even under the lock → ephemeral
      } finally {
        releaseRotateLock(held, lockPath)
      }
    }
    // A competitor holds the lock → adopt their secret the moment it lands.
    const cur = readPersistedSecret(path)
    if (cur.kind === 'ok') return cur.value
    __cookieSecretTiming.sleep(LOCK_WAIT_STEP_MS)
  }

  // Final adopt attempt — a late writer may have just landed the secret.
  const late = readPersistedSecret(path)
  if (late.kind === 'ok') return late.value

  log.warn('cookie_secret_unconverged', {
    path,
    note: 'using a process-ephemeral secret — owner sessions reset on restart',
  })
  return randomBytes(24).toString('hex')
}
