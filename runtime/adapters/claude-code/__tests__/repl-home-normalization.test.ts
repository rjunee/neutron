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

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClaudeCodeSubstrateAuto, resolveReplCwdAndHome } from '../index.ts'
import { shutdownAllPersistentRepls } from '../persistent/persistent-repl-substrate.ts'
import type { PersistentReplSubstrateOptions } from '../persistent/persistent-repl-substrate.ts'
import { supervisedBySessionKey } from '../persistent/pool-state.ts'

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
  // SCOPED TO THIS BLOCK on purpose. Registered at file level it would also fire
  // after the four pure-function tests above, which start nothing and touch no
  // env — and `shutdownAllPersistentRepls` is a GLOBAL clear of every persistent
  // REPL, so firing it more often than necessary is reach into other suites for
  // no benefit.
  afterEach(async () => {
    await shutdownAllPersistentRepls()
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('a blank cwd never reaches the child, so crash recovery cannot fail closed', () => {
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
        createClaudeCodeSubstrateAuto({ substrate_instance_id: id, cwd: blank }),
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
      createClaudeCodeSubstrateAuto({ substrate_instance_id: realId, cwd: realCwd }),
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
      createClaudeCodeSubstrateAuto({ substrate_instance_id: id, cwd: '   ' }),
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
      withEnvHome(blank, () =>
        createClaudeCodeSubstrateAuto({ substrate_instance_id: id, cwd: blank }),
      )
      expect(registeredFor(id)).toBeUndefined()
    }

    // CONTROL — supervision DOES arm whenever either slot carries a real path, so
    // the assertions above pin "both blank" rather than "registration never
    // happens", which would make this test vacuous. Both arms are exercised: the
    // env slot alone, and the cwd slot alone with the env slot ABSENT.
    const armedHome = tempHome('neutron-cwd-seam-arm-')
    const armedByEnv = `cc-armed-env-${Date.now()}`
    withEnvHome(armedHome, () =>
      createClaudeCodeSubstrateAuto({ substrate_instance_id: armedByEnv, cwd: '   ' }),
    )
    expect(registeredFor(armedByEnv)).toBeDefined()

    const armedByCwd = `cc-armed-cwd-${Date.now()}`
    const armedCwd = tempHome('neutron-cwd-seam-armcwd-')
    withEnvHome(undefined, () =>
      createClaudeCodeSubstrateAuto({ substrate_instance_id: armedByCwd, cwd: armedCwd }),
    )
    expect(registeredFor(armedByCwd)).toBeDefined()
  })
})
