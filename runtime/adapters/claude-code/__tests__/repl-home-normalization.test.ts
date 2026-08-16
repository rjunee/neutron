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
 */

import { describe, expect, test } from 'bun:test'

import { resolveReplCwdAndHome } from '../index.ts'

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
