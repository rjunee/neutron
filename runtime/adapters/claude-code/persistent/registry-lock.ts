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
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'

const log = createLogger('registry-lock')

const LOCK_EX = 2
const LOCK_UN = 8

// Lazy-loaded FFI handle — initialized on first use.
let _lib: { symbols: { flock: (fd: number, op: number) => number } } | null = null

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

/** Derive the lockfile path from a registry path (`<dir>/.registry.lock`). */
export function registryLockPath(registryPath: string): string {
  return join(dirname(registryPath), '.registry.lock')
}

/**
 * Execute `fn` while holding an exclusive flock on `lockPath`.
 *
 * If FFI is unavailable (non-Bun runtime), `fn` runs without locking. This is
 * safe for tests (single-process) but logs a warning if the syscall errors.
 */
export function withFlockSync<T>(lockPath: string, fn: () => T): T {
  const lib = getFlockLib()
  if (!lib) {
    // No FFI — run unguarded (single-process test environments).
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
  const fd = openSync(lockPath, 'w')
  try {
    const rc = lib.symbols.flock(fd, LOCK_EX)
    if (rc !== 0) {
      log.error('flock_lock_ex_nonzero', { rc })
      // Fall through — better to run unguarded than to skip the operation.
    }
    return fn()
  } finally {
    try {
      lib.symbols.flock(fd, LOCK_UN)
    } catch {
      /* best-effort unlock */
    }
    closeSync(fd)
  }
}
