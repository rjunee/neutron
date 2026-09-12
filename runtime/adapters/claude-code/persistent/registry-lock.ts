/**
 * registry-lock.ts — POSIX flock-based locking for the persisted REPL registry.
 *
 * LIFTED VERBATIM from Nova `gateway/registry-lock.ts` (substrate-lift S2 § 2
 * row #12, ★ CORE-PRESERVED-VERBATIM). The FFI mechanism is byte-identical on
 * Linux/macOS — only the doc comment changes to reflect WHAT it guards.
 *
 * Nova guarded `running-agents.jsonl`, shared read/write between the gateway's
 * `pruneRegistry()` (TypeScript) and `spawn-agent.sh`'s append writes (Python).
 * Neutron has NO Python spawn side — the lock serializes the REPL registry's
 * read-modify-write so two concurrent watchdog ticks (or a watchdog tick racing
 * a `start()` cold-resume) can't both decide to spawn for the same `sessionKey`.
 *
 * Uses Bun's FFI to call flock(2) directly — no shelling out, no polling. The
 * kernel auto-releases the lock if the holder crashes (restart-idempotent). When
 * FFI is unavailable (non-Bun runtime / sandbox), `withFlockSync` degrades to
 * running `fn` unguarded, which is safe for single-process test runners.
 */

import { createLogger } from '@neutronai/logger'
import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'

const log = createLogger('registry-lock')

const LOCK_EX = 2
const LOCK_UN = 8

// Lazy-loaded FFI handle — initialized on first use.
let _lib: { symbols: { flock: (fd: number, op: number) => number } } | null = null

/**
 * The `flock(2)` call, as a settable reference so the NONZERO branch is reachable.
 *
 * `flock` on a valid descriptor essentially only fails on EBADF/EINTR/ENOLCK, none of
 * which a test can provoke on an FFI-capable host — so without this the degraded path
 * below is unreachable and `acquired` always equals `flockAvailable()`. A test that
 * compares those two therefore passes even if the report is hardcoded `true`, which
 * would silently suppress the degraded-concurrency warning in production.
 *
 * Same shape as `sinkPortOverrideRef`: one reference the boot path never touches and a
 * test can. It is not a second code path — production reads the same line either way.
 */
let flockImpl: ((fd: number, op: number) => number) | undefined

/** Force `flock`'s return value. Pass `undefined` to restore the real syscall. */
export function setFlockImplForTests(fn: ((fd: number, op: number) => number) | undefined): void {
  flockImpl = fn
}

function getFlockLib(): typeof _lib {
  if (_lib) return _lib
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dlopen, FFIType } = require('bun:ffi')
    const libPath =
      process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6'
    _lib = dlopen(libPath, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    return _lib
  } catch {
    // FFI unavailable (non-Bun runtime or sandbox). Return null —
    // withFlockSync degrades to no-op locking, which is safe for
    // single-process test runners.
    return null
  }
}

/**
 * Did the `flock(2)` FFI LIBRARY LOAD in this process?
 *
 * NOT "is the lock held" and NOT "will locking work" — the library can load and the
 * `flock` call can still return nonzero, in which case `withFlockSync` runs the body
 * unguarded and this predicate still answers true. A caller whose correctness
 * argument rests on the lock must therefore use `withFlockSync`'s `onOutcome`
 * report, not this: see the sink token's `loadOrCreateSinkToken`, whose
 * concurrent-replacement convergence is exactly such a guarantee. This is for
 * diagnostics and for deciding whether locking is configured at all.
 *
 * Cheap after the first call — `getFlockLib` memoises the handle.
 */
export function flockAvailable(): boolean {
  return getFlockLib() !== null
}

/** Derive the lockfile path from a registry path (`<dir>/.registry.lock`). */
export function registryLockPath(registryPath: string): string {
  return join(dirname(registryPath), '.registry.lock')
}

/**
 * Execute `fn` while holding an exclusive flock on `lockPath`.
 *
 * If FFI is unavailable (non-Bun runtime), `fn` runs without locking. This is
 * safe for tests (single-process) but logs a warning if the syscall errors.
 *
 * `onOutcome` REPORTS WHETHER THE LOCK WAS ACTUALLY HELD while `fn` ran, and it is
 * the only honest way for a caller to know. There are THREE states here and
 * `flockAvailable()` distinguishes only two of them: the library failed to load, the
 * library loaded and `flock` SUCCEEDED, and the library loaded and `flock` returned
 * NONZERO — in which case this function deliberately runs `fn` unguarded anyway
 * ("better to run unguarded than to skip the operation"), which is right for a
 * generic helper and indistinguishable from success to anyone asking
 * `flockAvailable()`. A caller whose correctness argument rests on the lock must be
 * able to tell those apart, so this reports the fact and lets the caller rule; it
 * does not change what this helper DOES, so the existing callers are untouched.
 * Called exactly once per invocation, before `fn`.
 */
export function withFlockSync<T>(
  lockPath: string,
  fn: () => T,
  onOutcome?: (acquired: boolean) => void,
): T {
  const lib = getFlockLib()
  if (!lib) {
    // No FFI — run unguarded (single-process test environments).
    onOutcome?.(false)
    return fn()
  }

  // Ensure the lock's parent dir exists: the auto-selector pre-creates
  // `<home>/.neutron/`, but a DIRECT caller of
  // `createPersistentReplSubstrate({ replRegistryPath })` (e.g. the proof script
  // or a test pointing straight at `<dir>/repl-registry.json`) may not — and a
  // missing parent makes `openSync(lockPath, 'w')` ENOENT-throw, which
  // `spawnSession` swallows → supervision silently disabled + no registry record
  // (Codex P2). Best-effort mkdir keeps the lock self-sufficient.
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
  } catch {
    /* already exists / unwritable — openSync below surfaces a real failure */
  }
  // O_NONBLOCK for the same reason the sink token's reader carries it: `'w'` on a
  // FIFO blocks until a READER appears, so a lockfile path that is a FIFO would hang
  // this call — and therefore the gateway boot that goes through it — instead of
  // failing. With the flag, such a path answers ENXIO and the error propagates.
  // Nothing changes for a regular file, which is every real lockfile: O_NONBLOCK
  // affects neither the create nor the write semantics there, and it does not touch
  // `flock` itself, which blocks on the LOCK, not on the fd.
  //
  // O_NOFOLLOW, and then `fstat` on the descriptor we already hold. O_TRUNC applies at
  // OPEN, so without O_NOFOLLOW a lock path that is a SYMLINK truncates whatever it
  // points at before this function has done anything at all — and `sinkTokenPath` /
  // `replRegistryPath` are caller-supplied (`types.ts`), so the lock can be made to
  // land in a directory an attacker writes. The token's own reader was given
  // O_NOFOLLOW for exactly this; the lock introduced beside it was not, which is the
  // same threat model failing to reach the sibling the change added.
  //
  // The `fstat` is not redundant with the flag: O_NOFOLLOW rejects a symlink, and the
  // type check rejects the rest (a directory, a socket, a FIFO that O_NONBLOCK let
  // through). It reads the FD, never the path, so there is no window to swap the file
  // between the check and the lock — asking where the open LANDED, not what the name
  // pointed at when we looked.
  const fd = openSync(
    lockPath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      fsConstants.O_NONBLOCK |
      fsConstants.O_NOFOLLOW,
  )
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`registry-lock: lock path is not a regular file: ${lockPath}`)
    }
    const rc = (flockImpl ?? lib.symbols.flock)(fd, LOCK_EX)
    if (rc !== 0) {
      log.error('flock_lock_ex_nonzero', { rc })
      // Fall through — better to run unguarded than to skip the operation. The
      // caller is TOLD, though: this is the state that looks fully capable and is
      // not, and a caller that only asked `flockAvailable()` would never learn it.
    }
    onOutcome?.(rc === 0)
    return fn()
  } finally {
    try {
      ;(flockImpl ?? lib.symbols.flock)(fd, LOCK_UN)
    } catch {
      /* best-effort unlock */
    }
    closeSync(fd)
  }
}
