/**
 * The substrate's two home-shaped inputs are normalized ONCE.
 *
 * WHY THIS FILE EXISTS: an earlier round of this change trimmed the supervision
 * home and left `options.cwd` forwarded raw, and NOTHING went red — the trim was
 * asserted by a docblock and pinned by no test. That is the exact shape of defect
 * the branch is about, reproduced inside the fix for it.
 *
 * Both arms below carry a REAL-PATH CONTROL, so a failure means "a blank was
 * honoured" rather than "the input stopped being read at all", which is a
 * different bug wearing the same green.
 *
 * AND THE FILE DID NOT DO WHAT ITS OWN FIRST PARAGRAPH SAYS. Everything above
 * pins the pure FUNCTION. The defect it describes lived at the SEAM — the line
 * in `createClaudeCodeSubstrateAuto` that decides whether the normalized value
 * or the raw one reaches the child. Measured on `main`: replacing
 * `p.cwd = resolved.cwd` with `p.cwd = options.cwd`, which is the pre-fix code
 * verbatim, left 162 of 162 tests green across every suite that names any of
 * these resolvers. A normalizer nothing is obliged to USE is a docblock with a
 * unit test attached. The `describe` blocks at the bottom close that, on the
 * same argument the sibling `append-system-prompt-wiring.test.ts` was written
 * for: that value was also proven onto an intermediate option bag while the
 * real factory dropped it at this exact mapping.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLogger } from '@neutronai/logger'

import {
  createClaudeCodeSubstrateAuto,
  deriveReplSupervisionPaths,
  resolveReplCwdAndHome,
} from '../index.ts'
import type { PersistentReplSubstrateOptions } from '../persistent/persistent-repl-substrate.ts'
import {
  activeModelWatchdogs,
  activeWatchdogs,
  supervisedBySessionKey,
} from '../persistent/pool-state.ts'

const BLANKS = ['', '   ', '\t\n'] as const

describe('resolveReplCwdAndHome', () => {
  test('a blank cwd is UNSET, not forwarded — otherwise crash recovery fails closed', () => {
    // THE FAIL-CLOSED CHAIN THIS PINS. `persistent/pool.ts` records the session
    // as `cwd: options.cwd ?? process.cwd()` — `??` falls through on `undefined`
    // but NOT on `'   '`, so a forwarded blank lands in the session record.
    // `persistent/supervision.ts` then refuses the respawn outright:
    // `if (!existsSync(record.cwd)) return { ok: false, reason: 'invalid-cwd' }`.
    // Every crash recovery for that session declines, silently, for the life of
    // the process. Unset instead means the pool's own default applies, which is
    // a directory that exists.
    for (const blank of BLANKS) {
      expect(resolveReplCwdAndHome({ cwd: blank, env: {} }).cwd).toBeUndefined()
    }
    expect(resolveReplCwdAndHome({ cwd: undefined, env: {} }).cwd).toBeUndefined()

    // CONTROL — a real cwd is still forwarded, so the assertions above fail for
    // "a blank was dropped" and not for "cwd stopped being read".
    expect(resolveReplCwdAndHome({ cwd: '/srv/inst', env: {} }).cwd).toBe('/srv/inst')
  })

  test('the supervision home falls through a blank cwd to NEUTRON_HOME', () => {
    // Blank on the FIRST slot must not shadow a perfectly good second one. The
    // pre-fix code took `options.cwd ?? NEUTRON_HOME`, so a blank cwd won the
    // `??` and derived the registry + state dir relative to the process CWD —
    // splitting supervision off the instance it was supervising.
    for (const blank of BLANKS) {
      expect(resolveReplCwdAndHome({ cwd: blank, env: { NEUTRON_HOME: '/srv/home' } }).home).toBe(
        '/srv/home',
      )
    }
    // …and a blank NEUTRON_HOME is unset on that slot too.
    for (const blank of BLANKS) {
      expect(
        resolveReplCwdAndHome({ cwd: '/srv/inst', env: { NEUTRON_HOME: blank } }).home,
      ).toBe('/srv/inst')
    }

    // CONTROLS — both slots are still read for a real value, and cwd still wins
    // over the env when both are real (the documented precedence).
    expect(resolveReplCwdAndHome({ env: { NEUTRON_HOME: '/srv/home' } }).home).toBe('/srv/home')
    expect(
      resolveReplCwdAndHome({ cwd: '/srv/inst', env: { NEUTRON_HOME: '/srv/home' } }).home,
    ).toBe('/srv/inst')
  })

  test('both blank means supervision is OFF, which is the chosen direction', () => {
    // `home: undefined` skips the entire supervision block in
    // `createClaudeCodeSubstrateAuto` — registry, respawns, watchdog, heartbeat.
    // That is deliberate: with no home there is nowhere to put a per-instance
    // registry, and inventing one under whatever CWD systemd chose is how two
    // instances come to share a registry that names neither. Pinned so the
    // decision is visible rather than emergent; the REPL still runs, only
    // recovery is absent.
    for (const blank of BLANKS) {
      expect(resolveReplCwdAndHome({ cwd: blank, env: { NEUTRON_HOME: blank } }).home).toBeUndefined()
    }
    expect(resolveReplCwdAndHome({ env: {} }).home).toBeUndefined()

    // CONTROL — supervision is ON whenever either slot carries a real path, so
    // the assertions above pin "both blank" and not "supervision never arms".
    expect(resolveReplCwdAndHome({ cwd: '/srv/inst', env: {} }).home).toBe('/srv/inst')
    expect(resolveReplCwdAndHome({ env: { NEUTRON_HOME: '/srv/home' } }).home).toBe('/srv/home')
  })

  test('a REAL path whose blankness is only leading/trailing survives byte-for-byte', () => {
    // The other direction of the same seam. Leading and trailing spaces are
    // legal in a POSIX path, so a normalizer that trimmed its RETURN would
    // silently rewrite a real directory — the regression this branch fixes in
    // `resolveStatePath`. The predicate trims to DECIDE; the value keeps its
    // bytes.
    const spaced = ' /real/dir '
    expect(resolveReplCwdAndHome({ cwd: spaced, env: {} }).cwd).toBe(spaced)
    expect(resolveReplCwdAndHome({ cwd: spaced, env: {} }).home).toBe(spaced)
    expect(resolveReplCwdAndHome({ env: { NEUTRON_HOME: spaced } }).home).toBe(spaced)
  })
})

// ---------------------------------------------------------------------------
// THE SEAM. Everything above proves the normalizer computes the right answer;
// these prove the factory USES it. `createClaudeCodeSubstrateAuto` maps its
// options bag onto `PersistentReplSubstrateOptions` and, when supervision arms,
// hands that same object to `registerSupervisedSubstrate`, which is how the
// watchdog and the admin-respawn endpoint reach a session's owning options
// (`persistent/supervision.ts` -> `supervisedBySessionKey`). Reading the bag
// back out of that map observes the POST-MAPPING value.
//
// NO REPL CHILD IS SPAWNED — nothing here calls `.start()`, so there is no PTY,
// no subprocess and no network. That is NOT the same as "nothing is started",
// which an earlier draft of this comment claimed and a cross-model review
// falsified: constructing the factory ALSO arms `startReplWatchdog` and
// `startModelUpdateWatchdogForInstance` (`../index.ts`), which are real timers.
// Hence the scoped `afterEach` below — it exists to stop them, not for tidiness.
//
// ENV IS MUTATED ONLY INSIDE A SYNCHRONOUS WINDOW, which is the whole isolation
// argument. `createClaudeCodeSubstrateAuto` reads `process.env` directly, so
// exercising a blank `cwd` against a real home REQUIRES setting `NEUTRON_HOME`.
// The runner executes many files concurrently INSIDE ONE PROCESS (see
// `scripts/run-tests.sh` — intra-process `--max-concurrency`, not separate
// processes), so `process.env` is shared with every other suite, and several of
// them set this same variable. A snapshot-restore in a file-level `afterEach`
// would therefore be able to overwrite another suite's home while that suite sat
// suspended at an `await` — a cross-file clobber that would surface as a flake in
// a file nobody had touched. `withEnvHome` sets, calls and restores WITHOUT an
// intervening `await`, so no other test can be scheduled inside the window at
// all: single-threaded execution turns the race into an impossibility rather
// than an unlikelihood.
// ---------------------------------------------------------------------------

const tempDirs: string[] = []

function tempHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function registeredFor(instanceId: string): PersistentReplSubstrateOptions | undefined {
  for (const o of supervisedBySessionKey.values()) {
    if (o.substrate_instance_id === instanceId) return o
  }
  return undefined
}

/** Every instance id this FILE constructed, so teardown can name them. */
const ourInstanceIds: string[] = []

/**
 * Build a substrate and remember its instance id.
 *
 * Every construction in this file goes through here so {@link stopOnlyOurs} can
 * name what it must undo. Nothing else about it differs from calling the factory
 * directly.
 */
function build(options: Parameters<typeof createClaudeCodeSubstrateAuto>[0]): unknown {
  ourInstanceIds.push(options.substrate_instance_id)
  return createClaudeCodeSubstrateAuto(options)
}

/**
 * The substrate's own logger identity, used ONLY to clear the latches this file
 * burnt.
 *
 * NOT `resetLoggerStateForTests()`, which an earlier revision called. A
 * cross-model reviewer showed why: that function clears `onceFired` and
 * `rateLimitState` for EVERY subsystem in the process (`logger/index.ts` —
 * `onceFired.clear()`), and the runner executes files concurrently inside ONE
 * process, so a sibling suite suspended at an `await` can have a latch it had
 * already burnt silently re-armed and see its "once" line fire twice. Its
 * reproduction was three lines and it was right. `clearOnce` takes a subsystem
 * and a key, so this touches exactly the keys below and nothing else.
 */
const substrateLog = createLogger('claude-code-substrate')

/**
 * Undo exactly what this file did, SYNCHRONOUSLY.
 *
 * The obvious teardown is `shutdownAllPersistentRepls()`, and both blocks in
 * this file used to call it. Two reviewers refused it and they were right: it is
 * a GLOBAL teardown — it SIGTERMs every warm REPL in the pool and clears every
 * supervision entry (`../persistent/pool.ts` — `shutdownAllPersistentRepls`,
 * which calls `.clear()` on both watchdog maps) — and because the runner
 * executes files concurrently inside ONE process (`scripts/run-tests.sh`), it
 * can fire while a sibling suite sits suspended awaiting a live drain, killing
 * the child that suite is waiting on. `append-system-prompt-wiring.test.ts`
 * awaits exactly that, in the same directory, on the same pool. That is the
 * env-clobber hazard one layer over, and scoping it to a `describe` narrows WHEN
 * it fires without changing WHAT it reaches.
 *
 * Nothing here needs it. No test in this file calls `.start()`, so no child and
 * no pooled session exists. What construction DOES create, per home, is a state
 * directory with a heartbeat file and restart-rate state (all under a tmpdir
 * this file owns, removed with it), one supervision registry entry per instance
 * id, and two timers keyed by paths derived from that same tmpdir —
 * `activeWatchdogs` by `replRegistryPath`, `activeModelWatchdogs` by
 * `modelUpdateStatePath` (both `.set()` in `../persistent/supervision.ts`). Each
 * is removed by name, touching nothing another suite can observe.
 *
 * Symbols, not line numbers, on purpose: an earlier revision of this docblock
 * cited `pool.ts:858-870` and `supervision.ts:714,875`, and those offsets move
 * on every edit above them. A citation that rots is worse than a symbol name a
 * reader can grep.
 */
function stopOnlyOurs(homes: readonly string[], instanceIds: readonly string[]): void {
  for (const home of homes) {
    const paths = deriveReplSupervisionPaths(home)
    activeWatchdogs.get(paths.replRegistryPath)?.stop()
    activeWatchdogs.delete(paths.replRegistryPath)
    activeModelWatchdogs.get(paths.modelUpdateStatePath)?.stop()
    activeModelWatchdogs.delete(paths.modelUpdateStatePath)
  }
  const ours = new Set(instanceIds)
  for (const [key, o] of supervisedBySessionKey.entries()) {
    if (ours.has(o.substrate_instance_id)) supervisedBySessionKey.delete(key)
  }
  for (const id of instanceIds) substrateLog.clearOnce(`supervision-off:${id}`)
}

/**
 * Run `fn` with `NEUTRON_HOME` set to `home` (or deleted when `undefined`) and
 * restore the previous value before returning. SYNCHRONOUS BY CONTRACT — `fn`
 * must not be async and must not await, or the isolation argument above is void.
 */
function withEnvHome<T>(home: string | undefined, fn: () => T): T {
  const prior = process.env['NEUTRON_HOME']
  if (home === undefined) delete process.env['NEUTRON_HOME']
  else process.env['NEUTRON_HOME'] = home
  try {
    return fn()
  } finally {
    if (prior === undefined) delete process.env['NEUTRON_HOME']
    else process.env['NEUTRON_HOME'] = prior
  }
}

describe('createClaudeCodeSubstrateAuto forwards the NORMALIZED cwd, not the raw one', () => {
  // SCOPED TO THIS BLOCK on purpose — the four pure-function tests above start
  // nothing — and SYNCHRONOUS, with no `await`, so no sibling suite can be
  // scheduled inside the window, and nothing global is cleared. See
  // {@link stopOnlyOurs} for why this is not `shutdownAllPersistentRepls()`.
  //
  // Instance ids are named by {@link build} rather than by a per-block `track()`
  // helper: two describes in this file need the same bookkeeping, so it lives at
  // file level and every construction routes through it.
  afterEach(() => {
    stopOnlyOurs(tempDirs, ourInstanceIds.splice(0))
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('a blank cwd is not forwarded as the child cwd, so crash recovery cannot fail closed', () => {
    // THE CHAIN, restated where it is now actually asserted. `persistent/pool.ts:118`
    // records the session as `cwd: options.cwd ?? process.cwd()`; `??` falls through
    // on `undefined` but NOT on `'   '`. `persistent/supervision.ts` then refuses the
    // respawn — `existsSync('   ')` is false — and every crash recovery for that
    // session declines silently for the life of the process. The normalizer answers
    // `undefined` for a blank; this pins that the factory PASSES that answer on.
    //
    // A real `NEUTRON_HOME` is set so the supervision block arms and the mapped bag
    // is registered — the blank under test is the CWD slot only.
    const home = tempHome('neutron-cwd-seam-home-')
    BLANKS.forEach((blank, i) => {
      const id = `cc-blank-cwd-${i}-${Date.now()}`
      withEnvHome(home, () =>
        build({ substrate_instance_id: id, cwd: blank }),
      )
      const reg = registeredFor(id)
      expect(reg).toBeDefined()
      expect(reg!.cwd).toBeUndefined()
    })

    // CONTROL — a real cwd IS forwarded, byte-for-byte. Without this the
    // assertions above would also pass for a factory that stopped setting `cwd`
    // at all, which is a different bug wearing the same green.
    const realId = `cc-real-cwd-${Date.now()}`
    const realCwd = tempHome('neutron-cwd-seam-real-')
    withEnvHome(home, () =>
      build({ substrate_instance_id: realId, cwd: realCwd }),
    )
    expect(registeredFor(realId)?.cwd).toBe(realCwd)
  })

  test('a blank cwd still reaches NEUTRON_HOME for supervision — one input, one answer', () => {
    // The other half of the same call. The pre-fix code had `cwd` and the
    // supervision home disagreeing about the same blank string: one slot honoured
    // it, the other did not. Both now read it as unset, so the supervision state
    // dir lands under the instance home while the child gets the pool's default.
    const home = tempHome('neutron-cwd-seam-both-')
    const id = `cc-blank-cwd-home-${Date.now()}`
    withEnvHome(home, () =>
      build({ substrate_instance_id: id, cwd: '   ' }),
    )
    const reg = registeredFor(id)
    expect(reg).toBeDefined()
    expect(reg!.cwd).toBeUndefined()
    expect(reg!.replRegistryPath).toBe(join(home, '.neutron', 'repl-registry.json'))
  })

  test('both slots blank: supervision does not arm — the documented direction, at the seam', () => {
    // `resolveReplCwdAndHome` returning `home: undefined` is asserted above as a
    // VALUE. What it MEANS is that the whole supervision block is skipped. THIS
    // TEST OBSERVES REGISTRATION ONLY, and says so rather than implying more: the
    // registry path, respawns, watchdog and heartbeat are not independently
    // asserted here — they are wired inside the SAME `if (home !== undefined)`
    // block in `../index.ts`, so registration is a proxy for the block having
    // been entered, and it is a proxy that stops holding the moment that block is
    // split. The consequence, unasserted but real, is that the REPL then runs
    // unrecovered and nothing anywhere reports it. That is deliberate (there is
    // nowhere to put a
    // per-instance registry, and inventing one under whatever CWD systemd chose is
    // how two instances come to share a registry naming neither), and it is a
    // SILENT direction, which is exactly why it should be pinned where it happens
    // rather than one function upstream.
    for (const blank of BLANKS) {
      const id = `cc-both-blank-${blank.length}-${Date.now()}`
      // Captured through {@link errorLines} rather than left to escape: this
      // path ANNOUNCES supervision-off, so an uncaptured build wrote a real log
      // line to CI's stderr on every run — three of them — that no assertion
      // owned. Reviewers read those as a leak or a failure and have to go prove
      // otherwise. Capturing turns each one into a claim instead of noise.
      const lines = withEnvHome(blank, () =>
        errorLines(() => build({ substrate_instance_id: id, cwd: blank })),
      )
      expect(registeredFor(id)).toBeUndefined()
      expect(lines.filter((l) => l.includes(DISABLED)).length).toBe(1)
    }

    // CONTROL — supervision DOES arm whenever either slot carries a real path, so
    // the assertions above pin "both blank" rather than "registration never
    // happens", which would make this test vacuous. Both arms are exercised: the
    // env slot alone, and the cwd slot alone with the env slot ABSENT.
    const armedHome = tempHome('neutron-cwd-seam-arm-')
    const armedByEnv = `cc-armed-env-${Date.now()}`
    withEnvHome(armedHome, () =>
      build({ substrate_instance_id: armedByEnv, cwd: '   ' }),
    )
    expect(registeredFor(armedByEnv)).toBeDefined()

    const armedByCwd = `cc-armed-cwd-${Date.now()}`
    const armedCwd = tempHome('neutron-cwd-seam-armcwd-')
    withEnvHome(undefined, () =>
      build({ substrate_instance_id: armedByCwd, cwd: armedCwd }),
    )
    expect(registeredFor(armedByCwd)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// SUPERVISION-OFF IS ANNOUNCED, NOT JUST DECIDED.
//
// The decision to skip supervision when there is no home is deliberate and
// pinned above, at the seam. Its SILENCE was not deliberate. A REPL with no
// watchdog, no crash respawn and no heartbeat behaves identically to a healthy
// one right up until the first crash that nothing recovers — so the one thing
// that must not happen is for the factory to arm nothing and say nothing.
//
// AND THE FIRST VERSION OF THIS BLOCK COULD NOT SEE ITS OWN SUBJECT. It spied
// on `console.warn` and never touched `NEUTRON_LOG_LEVEL`, so under the single
// most common production setting (`NEUTRON_LOG_LEVEL=error`) the line it
// asserts is DROPPED at `logger/index.ts:263` before any sink runs — the test
// passed locally on the default `info` and would have stayed green against a
// substrate that says nothing at all where it matters. A reviewer found it.
// The level is now PINNED PER TEST rather than inherited, and the level pinned
// is `error`: the quietest the logger has, so every assertion below holds at
// the strictest setting an operator can choose, and the emission it observes
// is `log.error` for that reason rather than `log.warn`.
// ---------------------------------------------------------------------------

/**
 * Run `fn` with `NEUTRON_HOME` and `NEUTRON_LOG_LEVEL` pinned, restoring both
 * before returning. SYNCHRONOUS BY CONTRACT for the same reason as
 * {@link withEnvHome} — no `await` inside the window, so no sibling suite in
 * this single process can be scheduled while the env is mutated.
 */
function withEnv(home: string | undefined, level: string, fn: () => void): void {
  const priorHome = process.env['NEUTRON_HOME']
  const priorLevel = process.env['NEUTRON_LOG_LEVEL']
  if (home === undefined) delete process.env['NEUTRON_HOME']
  else process.env['NEUTRON_HOME'] = home
  process.env['NEUTRON_LOG_LEVEL'] = level
  try {
    fn()
  } finally {
    if (priorHome === undefined) delete process.env['NEUTRON_HOME']
    else process.env['NEUTRON_HOME'] = priorHome
    if (priorLevel === undefined) delete process.env['NEUTRON_LOG_LEVEL']
    else process.env['NEUTRON_LOG_LEVEL'] = priorLevel
  }
}

/** Lines the substrate logger actually emitted to `console.error` during `fn`. */
function errorLines(fn: () => void): string[] {
  const spy = spyOn(console, 'error').mockImplementation(() => {})
  try {
    fn()
    return spy.mock.calls.map((c) =>
      c.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
    )
  } finally {
    spy.mockRestore()
  }
}

const DISABLED = 'repl_supervision_disabled_no_home'

describe('supervision-off is ANNOUNCED, not just decided', () => {
  // The `once` latch is per-PROCESS module state (`logger/index.ts` —
  // `onceFired`), so a suite that did not clear it would depend on which of its
  // own tests ran first. Cleared PER KEY after each test, never with the global
  // `resetLoggerStateForTests()` — see {@link stopOnlyOurs}, which is where both
  // the latch keys and the timers this block arms are undone by name.
  afterEach(() => {
    stopOnlyOurs(tempDirs, ourInstanceIds.splice(0))
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('a blank home with no cwd REPORTS that supervision is disabled — at NEUTRON_LOG_LEVEL=error', () => {
    const lines = errorLines(() => {
      withEnv('   ', 'error', () => {
        build({ substrate_instance_id: 'cc-supervision-off-probe' })
      })
    })
    expect(lines.some((e) => e.includes(DISABLED))).toBe(true)
  })

  test('CONTROL — at that same level an ordinary warn IS dropped, so the test above is not vacuous', () => {
    // Without this, "the report survives `NEUTRON_LOG_LEVEL=error`" could be
    // true because the level gate does nothing, and the assertion above would
    // pin no property of the emission at all. This is the mutation control for
    // the `error`-versus-`warn` choice: it proves the gate is live at this
    // level, so downgrading the emission to `warn` MUST turn the test above red.
    const probe = createLogger('claude-code-substrate-level-control')
    const warned = spyOn(console, 'warn').mockImplementation(() => {})
    const errored = spyOn(console, 'error').mockImplementation(() => {})
    try {
      withEnv(undefined, 'error', () => {
        probe.warn('level_control_warn')
        probe.error('level_control_error')
      })
      expect(warned.mock.calls.length).toBe(0)
      expect(errored.mock.calls.length).toBe(1)
    } finally {
      warned.mockRestore()
      errored.mockRestore()
    }
  })

  test('CONTROL — a REAL home arms supervision and stays quiet about disabling it', () => {
    // Without this the assertion above would also pass against a substrate that
    // reported unconditionally, which would be a different kind of useless.
    //
    // THIS CONTROL TAKES THE ARMED BRANCH, so it creates real timers, a real
    // state directory and a registry entry. All of it is undone by name in the
    // block's `afterEach` — see {@link stopOnlyOurs}, and note that the home is
    // allocated through {@link tempHome} so the same teardown owns it.
    const tmp = tempHome('repl-supervision-control-')
    const id = 'cc-supervision-on-probe'
    const lines = errorLines(() => {
      withEnv(tmp, 'error', () => {
        build({ substrate_instance_id: id })
      })
    })
    expect(lines.some((e) => e.includes(DISABLED))).toBe(false)
    // …and it really did take the ARMED branch, so the silence above is the
    // silence of supervision working rather than of a factory that stopped
    // reporting at all.
    expect(registeredFor(id)).toBeDefined()
  })

  test('a latch BURNT then armed then broken again reports the SECOND time too', () => {
    // THE CROSS-MODEL REVIEWER'S SEQUENCE, run as written. `log.once` is
    // per-process state keyed by subsystem × key, so an instance that reported
    // once and was then constructed WITH a home would stay silent forever the
    // next time its home went missing — and "unsupervised and silent" is the
    // exact state this report exists to prevent. The armed branch now clears the
    // key, making it a RISING-EDGE latch.
    const id = 'cc-supervision-relapse'
    const home = tempHome('repl-supervision-relapse-')

    const first = errorLines(() => {
      withEnv('   ', 'error', () => build({ substrate_instance_id: id }))
    })
    expect(first.filter((e) => e.includes(DISABLED)).length).toBe(1)

    // Same id, now supervised — and this is the construction that clears it.
    const armed = errorLines(() => {
      withEnv(home, 'error', () => build({ substrate_instance_id: id }))
    })
    expect(armed.filter((e) => e.includes(DISABLED)).length).toBe(0)

    const relapse = errorLines(() => {
      withEnv('   ', 'error', () => build({ substrate_instance_id: id }))
    })
    expect(relapse.filter((e) => e.includes(DISABLED)).length).toBe(1)
  })

  test('the report fires ONCE per CONTINUOUSLY-DISABLED run of constructions, not once per build', () => {
    // NOT "once per instance", which is what this title said until a cross-model
    // reviewer pointed at the test 27 lines above: an armed construction CLEARS
    // the key, so the same instance reports again the next time it loses its
    // home. Both properties are wanted and they are not the same sentence —
    // suppression within an unbroken disabled run, re-arming across one — and
    // naming the wrong one here would have made that deliberate re-arm look like
    // a bug to whoever read this first.
    //
    // A line that repeats every time a substrate is built is not a report, it
    // is a flood that buries the thing it was raised about. The warm pool
    // constructs per (instance, role), so a dispatch-heavy process would
    // otherwise emit an unchanging line indefinitely.
    const lines = errorLines(() => {
      withEnv('   ', 'error', () => {
        for (let i = 0; i < 5; i += 1) {
          build({ substrate_instance_id: 'cc-supervision-flood-probe' })
        }
      })
    })
    expect(lines.filter((e) => e.includes(DISABLED)).length).toBe(1)
  })

  test('a DIFFERENT instance still gets its own report', () => {
    // CONTROL for the latch above: "once" must be keyed per instance, not
    // globally, or the second misconfigured instance in a process is silent —
    // which would reintroduce the exact silence this line exists to end.
    const lines = errorLines(() => {
      withEnv('   ', 'error', () => {
        build({ substrate_instance_id: 'cc-supervision-keyed-a' })
        build({ substrate_instance_id: 'cc-supervision-keyed-b' })
      })
    })
    expect(lines.filter((e) => e.includes(DISABLED)).length).toBe(2)
  })

  test('the report names WHICH slot was blank, PER FIELD, and never the path itself', () => {
    // Operators need to know which variable to set. They must not learn the
    // owner's data-dir layout from a log line, so the report is a SHAPE
    // (`unset` / `blank`) rather than a value.
    //
    // ASSERTED PER FIELD. An earlier version only checked that the joined line
    // CONTAINED `neutron_home`, `blank` and `cwd` somewhere — which pins almost
    // nothing: a mutation reporting `cwd: 'blank'` when cwd was actually UNSET
    // still passes, because the word `blank` is supplied by the other field.
    // Both fields are checked directly, in the one arrangement that
    // distinguishes them: cwd genuinely unset, NEUTRON_HOME genuinely blank, so
    // the two fields must DIFFER.
    const secret = '   '
    const lines = errorLines(() => {
      withEnv(secret, 'error', () => {
        build({ substrate_instance_id: 'cc-supervision-shape-probe' })
      })
    })
    const emitted = lines.find((e) => e.includes(DISABLED))
    expect(emitted).toBeDefined()
    const line = emitted as string

    // cwd was never passed → 'unset'. NEUTRON_HOME was '   ' → 'blank'.
    // A mutation that collapses the two classifications breaks one of these.
    expect(line).toMatch(/\bcwd=unset\b/)
    expect(line).toMatch(/\bneutron_home=blank\b/)
    expect(line).not.toMatch(/\bcwd=blank\b/)
    expect(line).not.toMatch(/\bneutron_home=unset\b/)

    // …and no field carries the value itself. The emitted line is
    // `… cwd=unset neutron_home=blank` — a shape, not a path.
    expect(line).not.toContain(secret)
  })

  test('the report describes the values the DECISION read, not a later re-read of a live object', () => {
    // THE PIN THE PREVIOUS ROUND DID NOT HAVE, and its absence was the finding.
    // Round 5 hoisted `const env = process.env` and claimed that made the report
    // "structurally unable to disagree" with the decision. A cross-model reviewer
    // falsified the claim and it reproduces here: `process.env` is a LIVE object,
    // so sharing the CONTAINER shares no observation at all. The decision reads
    // `NEUTRON_HOME` at one instant and the report read it at a later one, and
    // anything running in between moved the answer.
    //
    // The window is real rather than theoretical, and this test opens it the way
    // the reviewer did: the factory reads `options.claude_bin` AFTER it resolves
    // the home, so a getter on that property runs between the two reads. Option
    // bags reach this factory from callers, so a getter is a legal input.
    //
    // WHAT THIS ASSERTS: the environment gains a blank `NEUTRON_HOME` mid
    // construction, so the DECISION saw it unset (and turned supervision off for
    // that reason). The report must therefore say `unset`. Pre-fix it said
    // `blank` — describing a condition that was not the one it acted on, which is
    // this whole PR's subject reproduced inside the fix for it, for the second
    // time in this file.
    //
    // IT FAILS CLOSED under a refactor, which is the property that keeps it
    // honest: if the `claude_bin` read ever moves BEFORE the resolve, the
    // decision sees the blank too, the report says `blank`, and this goes red
    // rather than passing vacuously.
    let getterFired = false
    const lines = errorLines(() => {
      withEnv(undefined, 'error', () => {
        build({
          substrate_instance_id: 'cc-supervision-snapshot-probe',
          // Returns a real value rather than `undefined` because
          // `exactOptionalPropertyTypes` is on and `claude_bin?: string` does not
          // accept one. The value is irrelevant — this factory only maps it onto
          // an option bag and never starts a REPL — while the SIDE EFFECT is the
          // whole point.
          get claude_bin(): string {
            getterFired = true
            process.env['NEUTRON_HOME'] = '   '
            return 'claude'
          },
        })
      })
    })

    // CONTROL — the window actually opened. Without this the assertion below
    // could pass because nothing ever mutated the environment, which would pin
    // nothing at all.
    expect(getterFired).toBe(true)

    const emitted = lines.find((e) => e.includes(DISABLED))
    expect(emitted).toBeDefined()
    const line = emitted as string
    expect(line).toMatch(/\bneutron_home=unset\b/)
    expect(line).not.toMatch(/\bneutron_home=blank\b/)
  })
})
