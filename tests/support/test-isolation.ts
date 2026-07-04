/**
 * tests/support/test-isolation.ts — the shared test-isolation testkit (G9).
 *
 * WHY THIS EXISTS
 * ---------------
 * A cluster of onboarding / server-boot tests pass in a clean checkout but
 * fail on a re-run inside a long-lived worktree. The root cause is shared
 * DB/port state: each such test hand-rolls its own `NEUTRON_HOME`, env
 * save/restore, and teardown, and the ad-hoc versions drift in one of two
 * ways —
 *
 *   (a) they point `NEUTRON_DB_PATH` / `OWNER_HOME` at a FIXED path (a bare
 *       `/tmp/neutron-*` dir, not a per-run `mkdtemp`) that an earlier run
 *       already populated, so the second run opens a stale DB / dir, or
 *   (b) they forget to restore one of the env keys they mutate, leaking that
 *       value into the next file in the same long-lived `bun test` process.
 *
 * Both are invisible in a fresh worktree (nothing stale on disk, process
 * starts clean) and only bite on the second consecutive run in the same tree.
 *
 * This helper centralises the ONE correct pattern so a suite can be hermetic
 * and re-runnable in the same tree:
 *
 *   - a fresh, UNIQUE `NEUTRON_HOME` tmpdir per call (`mkdtempSync`), so no
 *     two runs — or two tests in one process — ever share a DB or home dir;
 *   - the standard per-instance env vars pointed inside that tmpdir;
 *   - a captured snapshot of EVERY env key it touches, restored on teardown
 *     (no leak into the next file);
 *   - a random free TCP port for the rare suite that must know a port number
 *     BEFORE the thing that binds it exists (`boot({ port: 0 })` is still
 *     preferred wherever the caller can read `handle.server.port` post-boot).
 *
 * Usage (bun:test):
 *
 *   let home: IsolatedHome
 *   beforeEach(() => { home = createIsolatedHome() })
 *   afterEach(() => { home.restore() })
 *   // ... process.env.NEUTRON_DB_PATH now points at home.dbPath ...
 *
 * NESTING CONTRACT (LIFO): each call snapshots the LIVE env at create time,
 * so if two homes are live at once the newer one's snapshot captures the
 * older one's values. Restore them newest-first (LIFO) — like unwinding a
 * stack of context managers. Restoring an OLDER home before a newer one puts
 * the env back to a value the newer home then overwrites with an already-
 * deleted dir, which is exactly the leak this testkit prevents. The dominant
 * beforeEach-create / afterEach-restore pattern is trivially LIFO (one live
 * home at a time); only fixtures that hold several homes open simultaneously
 * must order their teardown.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The per-instance env keys the isolated home OWNS: it sets them on create
 * and restores them on teardown. This is the canonical set every server-boot
 * suite needs; callers layer their own on via `extraEnvKeys` / `env`.
 */
export const ISOLATED_HOME_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
] as const

export interface IsolatedHome {
  /** Absolute path to this call's fresh, unique `NEUTRON_HOME` tmpdir. */
  readonly dir: string
  /** `<dir>/project.db` — the value `NEUTRON_DB_PATH` is pointed at. */
  readonly dbPath: string
  /** The url_slug seeded into `NEUTRON_INSTANCE_SLUG` (default `'owner'`). */
  readonly slug: string
  /**
   * Restore every touched env key to its pre-create value and remove the
   * tmpdir. Idempotent — safe to call twice (e.g. an early-return afterEach
   * plus a defensive afterAll).
   */
  restore(): void
}

export interface IsolatedHomeOptions {
  /** url_slug written to `NEUTRON_INSTANCE_SLUG` (default `'owner'`). */
  slug?: string
  /**
   * Extra env keys to snapshot + restore alongside the standard set — e.g.
   * `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` — for suites that also
   * mutate those and need them put back.
   */
  extraEnvKeys?: readonly string[]
  /**
   * Additional env values to SET after the standard ones are applied. A
   * value of `undefined` DELETES that key (and it is still restored on
   * teardown). Keys here are snapshotted automatically.
   */
  env?: Record<string, string | undefined>
}

/**
 * Create a fresh isolated `NEUTRON_HOME` and point the standard per-instance
 * env vars at it. Returns the resolved paths plus a `restore()` that puts the
 * environment back and deletes the tmpdir.
 */
export function createIsolatedHome(opts: IsolatedHomeOptions = {}): IsolatedHome {
  const slug = opts.slug ?? 'owner'
  const extra = opts.extraEnvKeys ?? []
  const envOverrides = opts.env ?? {}

  // Snapshot every key we might touch BEFORE mutating anything.
  const keys = Array.from(
    new Set<string>([...ISOLATED_HOME_ENV_KEYS, ...extra, ...Object.keys(envOverrides)]),
  )
  const saved: Record<string, string | undefined> = {}
  for (const k of keys) saved[k] = process.env[k]

  const dir = mkdtempSync(join(tmpdir(), `neutron-isohome-${slug}-`))
  const dbPath = join(dir, 'project.db')

  process.env['NEUTRON_HOME'] = dir
  process.env['OWNER_HOME'] = dir
  process.env['NEUTRON_DB_PATH'] = dbPath
  process.env['NEUTRON_INSTANCE_SLUG'] = slug

  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }

  let restored = false
  return {
    dir,
    dbPath,
    slug,
    restore() {
      if (restored) return
      restored = true
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Reserve a random free TCP port on 127.0.0.1. Binds `:0`, reads the
 * OS-assigned port, closes the listener, and resolves the number.
 *
 * Prefer `boot({ port: 0 })` and reading `handle.server.port` post-boot where
 * possible — that has no gap between reservation and use. Use this only when
 * a port number is needed BEFORE the component that binds it exists (e.g. to
 * build a base URL passed into that component's config). Inherent TOCTOU: the
 * port is free at resolve time but a racing process could still claim it —
 * acceptable for the single-box unit suite, never for production wiring.
 */
export function reserveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('reserveFreePort: listener has no numeric address')))
        return
      }
      const { port } = addr
      srv.close(() => resolve(port))
    })
  })
}
