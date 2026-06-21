/**
 * Shared real-PGLite brain boot for the GBrain round-trip test suites
 * (gbrain-memory, scribe, connect).
 *
 * WHY THIS EXISTS
 * ---------------
 * PGLite is a single-threaded, in-process WASM Postgres. `scripts/run-tests.sh`
 * runs each chunk at `--max-concurrency=N>1`, and bun loads ALL of a chunk's
 * files into ONE long-lived process (file parallelism is intra-process via the
 * event loop). So several of these heavy real-PGLite test files boot their
 * engines at the same time — or one boots while ~100 sibling files in the chunk
 * starve the runner's CPU/RAM (CI is a 2-vCPU / 7-GB ubuntu box).
 *
 * TWO distinct load-dependent flakes are tamed here:
 *
 *   1. **Bootstrap-probe race** (ISSUES #79, root-fixed by PR #13). gbrain's
 *      pre-schema probe (`pglite-engine.ts`: `const probe = rows[0]`)
 *      intermittently observes an EMPTY result set under contention, leaving
 *      `probe` undefined so `probe.pages_exists` throws
 *      `TypeError: ... (evaluating 'probe.pages_exists')`.
 *
 *   2. **WASM-init failure** (ISSUES #327, this change). `engine.connect()`
 *      calls `@electric-sql/pglite`'s `PGlite.create()`, which `readFile`s
 *      `pglite.data` and `WebAssembly.instantiate()`s the ~Postgres-in-WASM
 *      module. Even with boots serialised (see THE FIX), that first large WASM
 *      compile runs while the chunk's other files saturate the small CI runner,
 *      and the instantiate intermittently aborts. gbrain wraps every
 *      `PGlite.create()` throw with the header `PGLite failed to initialize its
 *      WASM runtime.` (`pglite-engine.ts buildPgliteInitErrorMessage`, gbrain
 *      #223), which is the #327 CI signature. It cleared on `gh run rerun
 *      --failed` because the retimed compile no longer overlaps the load spike.
 *
 * THE FIX (no assertion is weakened)
 * ----------------------------------
 *   1. A process-global async mutex serialises engine boots, so two heavy
 *      PGLite inits never overlap within a chunk (removes the interleave window
 *      — the deterministic half: the first boot compiles + warms PGLite's
 *      module cache, later boots reuse it).
 *   2. A bounded retry re-boots a FRESH engine when — and only when — the boot
 *      trips a KNOWN transient shape (`isTransientBoot`: the probe race OR the
 *      WASM-init failure). This handles the residual case where the serialised
 *      boot itself fails under sibling CPU/RAM starvation. Any OTHER boot error
 *      (a real schema regression, a migration failure) rethrows IMMEDIATELY,
 *      and a transient error that persists past every attempt surfaces with its
 *      original message — the retry never masks a genuinely broken runtime.
 *
 * gbrain is imported via computed specifiers (`'gbrain' + '/...'`) so its `.ts`
 * stays out of the tsc program — bun resolves it at runtime (mirrors the
 * original per-file harness).
 */

export interface PgliteEngineHandle {
  connect(o: { database_url: string }): Promise<void>
  initSchema(): Promise<void>
  setConfig(key: string, value: string): Promise<void>
  disconnect(): Promise<void>
}

export interface GbrainOp {
  name: string
  handler: (ctx: unknown, p: unknown) => Promise<unknown>
}

export interface BootedBrain {
  engine: PgliteEngineHandle
  operations: GbrainOp[]
}

// Module-level singleton → shared across every test file in the same bun
// process (one chunk), so boots serialise across files, not just within one.
let bootLock: Promise<void> = Promise.resolve()

async function withBootLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = bootLock
  let release!: () => void
  // Assign synchronously BEFORE the first await so the next caller chains
  // behind us (canonical async-mutex shape).
  bootLock = new Promise<void>((r) => {
    release = r
  })
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

/**
 * Transient-boot signatures that a bounded retry may legitimately self-heal.
 * Deliberately TIGHT so a deterministic error (a SQL/migration failure, a bad
 * config) is never swallowed:
 *
 *   - `evaluating 'probe.` — the #79 bootstrap-probe race (empty result set →
 *     `probe` undefined → property read throws).
 *   - `PGLite failed to initialize its WASM runtime` — the #327 gbrain wrapper
 *     header, present on EVERY `PGlite.create()` throw (the WASM-init step) and
 *     on nothing else (migration/SQL errors happen after create and lack it).
 *   - `Invalid FS bundle size` — PGLite's `getPreloadedPackage` byteLength guard
 *     firing on a partially-read `pglite.data` (raw, in case unwrapped).
 *   - a WASM compile/instantiate/abort RuntimeError under memory pressure.
 */
const TRANSIENT_BOOT_SIGNATURES: readonly RegExp[] = [
  /evaluating 'probe\./,
  /PGLite failed to initialize its WASM runtime/i,
  /Invalid FS bundle size/i,
  /WebAssembly\.(?:instantiate|compile|Module)/i,
  /\bRuntimeError\b[\s\S]{0,40}(?:abort|memory|unreachable)/i,
  /Cannot read propert(?:y|ies) of undefined \(reading ['"]byteLength['"]\)/i,
]

/**
 * True iff `err` is a KNOWN transient PGLite boot failure (probe race or
 * WASM-init). Pure + exported so the unit test can prove the retry fires on
 * BOTH transient shapes and rejects a deterministic error.
 */
export function isTransientBoot(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return TRANSIENT_BOOT_SIGNATURES.some((re) => re.test(m))
}

export interface BootRetryOptions {
  /** Total attempts including the first (default 4). */
  maxAttempts?: number
  /** Base backoff in ms between attempts (default 75; linear by attempt). */
  baseDelayMs?: number
  /** Injectable sleep (the unit test passes a no-op so retries add no wall time). */
  sleep?: (ms: number) => Promise<void>
  /** Observability hook (unit test asserts it fires; real boot logs to stderr). */
  onRetry?: (attempt: number, err: unknown) => void
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

/**
 * Run `boot` with a bounded retry that ONLY retries a known transient boot
 * failure (`isTransientBoot`). A non-transient error — or a transient error
 * that persists past `maxAttempts` — propagates UNCHANGED, so a real init
 * problem is never masked. `boot` owns its own per-attempt cleanup (e.g.
 * disconnecting a half-booted engine before it throws).
 */
export async function withTransientBootRetry<T>(
  boot: () => Promise<T>,
  opts: BootRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4)
  const baseDelayMs = opts.baseDelayMs ?? 75
  const sleep = opts.sleep ?? defaultSleep

  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await boot()
    } catch (err) {
      lastErr = err
      // Non-transient → surface immediately, never mask a real error.
      if (!isTransientBoot(err)) throw err
      // Transient but out of attempts → surface the real failure.
      if (attempt >= maxAttempts) throw err
      opts.onRetry?.(attempt, err)
      // We hold the boot mutex throughout, so no sibling boot competes during
      // the backoff — the retimed retry just waits out the load spike.
      await sleep(baseDelayMs * attempt)
    }
  }
  // Unreachable (the loop either returns or throws); satisfies the type.
  throw lastErr
}

/**
 * Boot a real in-memory GBrain PGLite brain (schema + ~100 migrations applied),
 * serialised against every other boot in the process and retried past the known
 * concurrency-induced flakes (probe race + WASM-init). Returns the live engine
 * plus the gbrain `operations` array; callers build their own ctx/client and may
 * call `engine.setConfig(...)` before use.
 */
export async function bootPgliteBrain(): Promise<BootedBrain> {
  return withBootLock(async () => {
    const engMod = (await import('gbrain' + '/pglite-engine')) as {
      PGLiteEngine: new () => PgliteEngineHandle
    }
    const opsMod = (await import('gbrain' + '/operations')) as { operations: GbrainOp[] }

    return withTransientBootRetry(
      async () => {
        const eng = new engMod.PGLiteEngine()
        try {
          await eng.connect({ database_url: '' })
          await eng.initSchema()
          return { engine: eng, operations: opsMod.operations }
        } catch (err) {
          // Dispose the half-booted engine before the retry boots a fresh one,
          // so a failed attempt can't leak a connection/lock.
          await eng.disconnect().catch(() => {})
          throw err
        }
      },
      {
        onRetry(attempt, err) {
          const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
          process.stderr.write(
            `[boot-pglite-brain] transient boot failure (attempt ${attempt}), retrying: ${msg}\n`,
          )
        },
      },
    )
  })
}
