/**
 * @neutronai/open — generic per-install PERSISTED SECRET loader (S1).
 *
 * This is the hardened, fail-closed, hostile-FS-resistant secret loader S2
 * introduced for the session-cookie secret, GENERALIZED so a second owner
 * credential — the S1 per-install owner bearer — reuses the EXACT same
 * guarantees instead of re-deriving them (or shipping a weaker copy). The
 * caller supplies a {@link PersistedSecretSpec} (target path, sibling lock path,
 * length floor, mint fn, temp-name prefix, logger + unconverged event) and gets
 * back a value that is ALWAYS high-entropy — never a predictable constant — AND,
 * when it comes from disk, read from a confirmed REGULAR, 0600, NON-SYMLINK file
 * opened NO-FOLLOW whose value meets the length floor.
 *
 * The security discipline is byte-for-byte the S2 one:
 *   - a value found with perms BROADER than 0600 is COMPROMISED → ROTATED, not
 *     tightened-and-trusted (a later chmod can't un-expose it);
 *   - a SYMLINK / non-regular file is never followed/trusted → rotated;
 *   - a too-short / weak value is rotated;
 *   - first-writer-wins convergence behind a BEST-EFFORT advisory sibling
 *     lockfile carrying a unique owner TOKEN, with a post-acquire re-verify that
 *     makes a swapped-lock rotator YIELD (the residual pathname-lock window is
 *     documented, not falsely closed; unreachable in neutron's one-process-per-
 *     NEUTRON_HOME deployment);
 *   - on any failure the last resort is a process-EPHEMERAL value + loud warn —
 *     never a trusted-but-exposed on-disk value, never a guessable constant,
 *     never a hard boot failure, never a hang, never silent divergence.
 *
 * The RETURN carries the `source` (`'persisted'` = read-or-minted to disk;
 * `'ephemeral'` = the FS-failure fallback) so a caller can make a fail-closed
 * BOOT decision — e.g. S1 refuses a wide (non-loopback) bind whose owner bearer
 * could only be secured as ephemeral.
 */

import * as fs from 'node:fs'
import { join } from 'node:path'

import type { Logger } from '@neutronai/logger'

/** Where a value came from — lets a caller gate boot on a NON-persistent secret. */
export type PersistedSecretSource = 'persisted' | 'ephemeral'

export interface PersistedSecretResult {
  value: string
  source: PersistedSecretSource
}

export interface PersistedSecretSpec {
  /** Absolute path to the on-disk 0600 secret file. */
  path: string
  /** Sibling advisory lockfile path (serializes rotation). */
  lockPath: string
  /** Directory to `mkdir -p` + place temp files in (NEUTRON_HOME). */
  dir: string
  /** Minimum trusted length; a shorter persisted value is rotated. */
  minLen: number
  /** Mint a fresh high-entropy value (NO trailing newline; the writer adds one). */
  mint: () => string
  /** Basename prefix for the atomic-rename temp file. */
  tmpPrefix: string
  /** Logger for the unconverged-fallback warn. */
  log: Logger
  /** Structured event name for the ephemeral-fallback warn. */
  unconvergedEvent: string
  /** Human note surfaced with the ephemeral-fallback warn. */
  unconvergedNote: string
}

// EXCLUSIVE, NO-FOLLOW create: O_CREAT|O_EXCL fails on ANY existing entry (incl.
// a symlink); O_NOFOLLOW is belt-and-suspenders.
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
function readPersistedSecret(path: string, minLen: number): ReadResult {
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
    if (value.length < minLen) return { kind: 'reject' }
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
function installFreshSecret(spec: PersistedSecretSpec): string | null {
  const secret = spec.mint()
  const tmp = join(spec.dir, `${spec.tmpPrefix}.${process.pid}.${(tmpSeq += 1)}`)
  let fd: number
  try {
    fd = fs.openSync(tmp, WX_NOFOLLOW, 0o600)
  } catch {
    return null
  }
  try {
    // FULL write: `writeSync` may write fewer bytes than requested (short write),
    // and a partial write would rename a TRUNCATED secret into place that the
    // length-only verify could still accept (Codex). Loop over a Buffer until
    // every byte is on disk; a zero/negative return is a hard failure.
    const buf = Buffer.from(secret + '\n', 'utf8')
    let written = 0
    while (written < buf.length) {
      const n = fs.writeSync(fd, buf, written, buf.length - written)
      if (n <= 0) throw new Error(`short write: ${written}/${buf.length} bytes`)
      written += n
    }
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
    fs.renameSync(tmp, spec.path) // atomic replace (symlink or regular), one syscall
  } catch {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* non-fatal */
    }
    return null
  }
  // ALWAYS re-read: whoever renamed LAST is what every process converges on.
  const back = readPersistedSecret(spec.path, spec.minLen)
  return back.kind === 'ok' ? back.value : null
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
export const __persistedSecretTiming = {
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
export const __persistedLockInternals = {
  acquire: tryAcquireRotateLock,
  release: releaseRotateLock,
}

/**
 * Read the persisted per-install secret described by `spec`, minting +
 * persisting a fresh value on first boot (or rotating an untrusted one). See the
 * file header for the full hardening contract. The result's `source` is
 * `'persisted'` when the returned value is on disk (read or freshly installed)
 * and `'ephemeral'` when nothing could be secured (process-only fallback + warn).
 */
export function resolvePersistedSecret(spec: PersistedSecretSpec): PersistedSecretResult {
  // Fast path: an existing VALID secret is returned UNCHANGED — no lock, no
  // write, no rotation (the single-process loopback dogfood happy path: one
  // no-follow read).
  const first = readPersistedSecret(spec.path, spec.minLen)
  if (first.kind === 'ok') return { value: first.value, source: 'persisted' }

  try {
    fs.mkdirSync(spec.dir, { recursive: true })
  } catch {
    /* install may still fail below → ephemeral */
  }

  const deadline = Date.now() + LOCK_WAIT_TOTAL_MS

  while (Date.now() <= deadline) {
    const held = tryAcquireRotateLock(spec.lockPath)
    if (held !== null) {
      // We are the SOLE rotator.
      try {
        // A prior rotator may have already installed a valid secret in a window
        // before we got the lock → ADOPT it, don't overwrite (first-writer-wins).
        const underLock = readPersistedSecret(spec.path, spec.minLen)
        if (underLock.kind === 'ok') return { value: underLock.value, source: 'persisted' }
        const installed = installFreshSecret(spec)
        if (installed !== null) return { value: installed, source: 'persisted' }
        break // couldn't install even under the lock → ephemeral
      } finally {
        releaseRotateLock(held, spec.lockPath)
      }
    }
    // A competitor holds the lock → adopt their secret the moment it lands.
    const cur = readPersistedSecret(spec.path, spec.minLen)
    if (cur.kind === 'ok') return { value: cur.value, source: 'persisted' }
    __persistedSecretTiming.sleep(LOCK_WAIT_STEP_MS)
  }

  // Final adopt attempt — a late writer may have just landed the secret.
  const late = readPersistedSecret(spec.path, spec.minLen)
  if (late.kind === 'ok') return { value: late.value, source: 'persisted' }

  spec.log.warn(spec.unconvergedEvent, { path: spec.path, note: spec.unconvergedNote })
  return { value: spec.mint(), source: 'ephemeral' }
}
