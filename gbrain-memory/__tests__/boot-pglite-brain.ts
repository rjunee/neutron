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
 * engines at the same time — or one boots while sibling files starve the CPU.
 *
 * gbrain's pre-schema bootstrap probe (`pglite-engine.ts`: `const probe =
 * rows[0]`) intermittently observes an EMPTY result set under that contention,
 * leaving `probe` undefined so `probe.pages_exists` throws
 * `TypeError: undefined is not an object (evaluating 'probe.pages_exists')`.
 * It surfaces as an `(unnamed)` beforeAll failure. Observed in CI on different
 * files each run (scribe-gbrain in chunk 7, shared-project-memory-mirror in
 * chunk 2) — the hallmark of a load-dependent flake, not a logic bug (every one
 * of these suites is green standalone and on `main`).
 *
 * THE FIX (no assertion is weakened)
 * ----------------------------------
 *   1. A process-global async mutex serialises engine boots, so two heavy
 *      PGLite inits never overlap within a chunk (removes the interleave window).
 *   2. A bounded retry re-boots a FRESH engine when — and only when — the boot
 *      trips the known transient bootstrap-probe error (handles the residual
 *      CPU-starvation case where a single file boots under sibling load). Any
 *      other boot error rethrows immediately, so a genuine schema regression
 *      still fails the suite.
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

function isTransientBootProbe(err: unknown): boolean {
  // gbrain bootstrap probe returned 0 rows → `probe` undefined → property read
  // throws "...is not an object (evaluating 'probe.<col>')". Match only that
  // shape; everything else is a real error and must propagate.
  const m = err instanceof Error ? err.message : String(err)
  return /evaluating 'probe\./.test(m)
}

/**
 * Boot a real in-memory GBrain PGLite brain (schema + ~100 migrations applied),
 * serialised against every other boot in the process and retried past the known
 * concurrency-induced bootstrap-probe flake. Returns the live engine plus the
 * gbrain `operations` array; callers build their own ctx/client and may call
 * `engine.setConfig(...)` before use.
 */
export async function bootPgliteBrain(): Promise<BootedBrain> {
  return withBootLock(async () => {
    const engMod = (await import('gbrain' + '/pglite-engine')) as {
      PGLiteEngine: new () => PgliteEngineHandle
    }
    const opsMod = (await import('gbrain' + '/operations')) as { operations: GbrainOp[] }

    let lastErr: unknown
    for (let attempt = 1; attempt <= 4; attempt++) {
      const eng = new engMod.PGLiteEngine()
      try {
        await eng.connect({ database_url: '' })
        await eng.initSchema()
        return { engine: eng, operations: opsMod.operations }
      } catch (err) {
        lastErr = err
        await eng.disconnect().catch(() => {})
        if (!isTransientBootProbe(err)) throw err
        // Brief backoff before a fresh attempt; we hold the mutex throughout so
        // no sibling boot competes during the retry.
        await new Promise((r) => setTimeout(r, 75 * attempt))
      }
    }
    throw lastErr
  })
}
