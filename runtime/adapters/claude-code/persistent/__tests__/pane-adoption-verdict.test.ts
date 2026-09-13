/**
 * pane-adoption-verdict.test.ts — #539 seam 2: the ADOPT arm's classifier.
 *
 * `orphan-adoption.ts` was adopt-or-kill and only ever killed. This suite drives the
 * new verdict in BOTH directions, which is the only way it can be shown to be a
 * decision rather than a default:
 *
 *   - a pane that IS the child a row describes must be adopted (a classifier that
 *     refuses everything satisfies every "it refuses" case and is still broken);
 *   - a pane running a claude on our transcript that is NOT our child must be
 *     closed, because the one-owner-per-transcript invariant is enforced only by
 *     ending the other owner;
 *   - a pane running something else must be left alone;
 *   - and "the pane is gone", "I could not sample it" and "I could not ask" must
 *     stay three separate answers, because only the first licenses a cold spawn.
 */

import { describe, it, expect } from 'bun:test'
import {
  argvCarriesChannel,
  argvMatchesSession,
  classifyPaneForAdoption,
  cmdlineMatchesSession,
} from '../orphan-adoption.ts'
import type { HandleInspection } from '../pty-host.ts'

const SESSION = 'b1f3c0de-1234-5678-9abc-def012345678'
const CHANNEL = 'neutron-abcdef0123456789abcdef0123456789'
const ROW = { sessionId: SESSION, channelName: CHANNEL }

/** The real shape, in the order `buildReplArgv` emits it. */
const oursArgv = (sessionFlag: '--resume' | '--session-id' = '--resume'): string[] => [
  '/usr/local/bin/claude',
  sessionFlag,
  SESSION,
  '--dangerously-load-development-channels',
  `server:${CHANNEL}`,
  '--mcp-config',
  `/tmp/neutron-repl-${CHANNEL}/session-mcp.json`,
  '--model',
  'claude-opus-5',
]

const live = (argv: string[], extra: Partial<Extract<HandleInspection, { kind: 'live' }>> = {}): HandleInspection => ({
  kind: 'live',
  argv,
  ...extra,
})

describe('classifyPaneForAdoption — the adopt direction', () => {
  it('adopts a pane running THIS row\'s child, on either session flag', () => {
    expect(classifyPaneForAdoption(live(oursArgv('--resume'), { pid: 4242 }), ROW)).toEqual({
      kind: 'adopt',
      pid: 4242,
    })
    expect(classifyPaneForAdoption(live(oursArgv('--session-id')), ROW).kind).toBe('adopt')
  })

  it('carries the pid through when the host reported one, and omits it when it did not', () => {
    const withPid = classifyPaneForAdoption(live(oursArgv(), { pid: 77 }), ROW)
    expect(withPid).toEqual({ kind: 'adopt', pid: 77 })
    // ABSENT, not zero: a pid we were not given is not a pid of 0, and a caller that
    // probes `kill(pid, 0)` on a fabricated 0 asks about its own process group.
    expect(classifyPaneForAdoption(live(oursArgv()), ROW)).toEqual({ kind: 'adopt' })
  })
})

describe('classifyPaneForAdoption — the refuse directions', () => {
  it('CLOSES a claude on our transcript that lacks our dev-channel (herdr\'s own resume)', () => {
    // Exactly what herdr's native agent restore relaunches: `claude --resume <id>`
    // with none of our flags. On our transcript, not our child.
    const v = classifyPaneForAdoption(live(['claude', '--resume', SESSION]), ROW)
    expect(v.kind).toBe('close-foreign-owner')
  })

  it('CLOSES a claude on our transcript wired to a DIFFERENT channel', () => {
    const other = oursArgv()
    other[4] = 'server:neutron-someone-elses-channel'
    expect(classifyPaneForAdoption(live(other), ROW).kind).toBe('close-foreign-owner')
  })

  it('leaves a pane that is not a claude on our transcript UNTOUCHED', () => {
    expect(classifyPaneForAdoption(live(['/usr/sbin/cupsd', '-l', '-f']), ROW).kind).toBe(
      'leave-not-ours',
    )
    // The recycled-pid trap in pane form: a `tail` on our transcript path carries the
    // uuid AND the `claude` substring, and is not ours.
    expect(
      classifyPaneForAdoption(
        live(['tail', '-f', `/home/u/.claude/projects/p/${SESSION}.jsonl`]),
        ROW,
      ).kind,
    ).toBe('leave-not-ours')
  })

  it('leaves a DIFFERENT session\'s claude untouched even with our channel token', () => {
    const otherSession = oursArgv()
    otherSession[2] = 'ffffffff-0000-0000-0000-000000000000'
    expect(classifyPaneForAdoption(live(otherSession), ROW).kind).toBe('leave-not-ours')
  })
})

describe('classifyPaneForAdoption — absence, ignorance and failure are three answers', () => {
  it('gone is a positive absence', () => {
    expect(classifyPaneForAdoption({ kind: 'gone' }, ROW)).toEqual({ kind: 'gone' })
  })

  it('a live pane with no argv is UNVERIFIABLE, not not-ours', () => {
    const v = classifyPaneForAdoption(live([]), ROW)
    expect(v.kind).toBe('unverifiable')
  })

  it('a host that could not be asked is UNAVAILABLE, not gone', () => {
    const v = classifyPaneForAdoption({ kind: 'unavailable', reason: 'socket timeout' }, ROW)
    expect(v.kind).toBe('unavailable')
    expect(v.kind === 'unavailable' && v.reason).toContain('socket timeout')
  })
})

describe('argvCarriesChannel', () => {
  it('matches the VALUE after the flag, never a substring elsewhere', () => {
    expect(argvCarriesChannel(oursArgv(), CHANNEL)).toBe(true)
    // The channel name also appears inside the --mcp-config PATH. That must not count.
    expect(
      argvCarriesChannel(['claude', '--mcp-config', `/tmp/neutron-repl-${CHANNEL}/session-mcp.json`], CHANNEL),
    ).toBe(false)
    // The flag with somebody else's value.
    expect(
      argvCarriesChannel(['claude', '--dangerously-load-development-channels', 'server:other'], CHANNEL),
    ).toBe(false)
    // A trailing flag with no value at all.
    expect(argvCarriesChannel(['claude', '--dangerously-load-development-channels'], CHANNEL)).toBe(false)
  })

  it('an empty channel name matches nothing', () => {
    expect(argvCarriesChannel(['claude', '--dangerously-load-development-channels', 'server:'], '')).toBe(
      false,
    )
  })
})


describe('the argv is matched as a VECTOR, because flattening it defeats the binary gate', () => {
  /**
   * ARGUS r7 BLOCKER. The classifier used to `join(' ')` the host's argv and hand the
   * string to `cmdlineMatchesSession`, which re-split it on whitespace. POSIX lets a
   * process choose any argv[0], so an argv whose FIRST ELEMENT is `'claude --resume'`
   * reparses with `tokens[0] === 'claude'` and passes a gate whose whole job is to
   * require that argv[0] be a claude binary. The pane in that case is a stranger's,
   * and the two things this classifier licenses — attach, and close — are both
   * destructive when pointed at one.
   */
  const SMUGGLED = [
    `${'claude'} --resume`,
    SESSION,
    '--dangerously-load-development-channels',
    `server:${CHANNEL}`,
  ]

  it('REFUSES an argv[0] that only looks like a claude once the vector is flattened', () => {
    // The proof the attack is real: flatten-and-reparse says yes...
    expect(cmdlineMatchesSession(SMUGGLED.join(' '), SESSION)).toBe(true)
    // ...and the element-wise matcher, which is what the classifier now uses, says no.
    expect(argvMatchesSession(SMUGGLED, SESSION)).toBe(false)
  })

  it('and the classifier neither adopts nor closes that pane', () => {
    const verdict = classifyPaneForAdoption(live(SMUGGLED, { pid: 4242 }), ROW)
    // NOT `adopt` (we would attach to a stranger's screen) and NOT
    // `close-foreign-owner` (we would kill it). `unverifiable` routes to the pid
    // identity probe, which is the only safe direction for a pane we cannot read.
    expect(verdict.kind).toBe('unverifiable')
    expect(verdict.kind === 'unverifiable' && verdict.reason).toMatch(/whitespace/i)
  })

  it('refuses whitespace ANYWHERE in the vector, not only in argv[0]', () => {
    // A tab and a newline are the same lossy character class as a space, and an
    // element after argv[0] is the one a caller is least likely to think about.
    for (const smuggle of ['--resume\t--dangerously-load-development-channels', 'x\ny']) {
      const argv = ['/usr/local/bin/claude', '--resume', SESSION, smuggle]
      expect(argvMatchesSession(argv, SESSION)).toBe(false)
      expect(classifyPaneForAdoption(live(argv), ROW).kind).toBe('unverifiable')
    }
  })

  it('THE POSITIVE CONTROL: the ordinary argv is still adopted', () => {
    // A matcher that refused every vector would satisfy all three cases above and
    // deliver nothing, so the real launch shape must still pass element-wise.
    expect(argvMatchesSession(oursArgv(), SESSION)).toBe(true)
    expect(classifyPaneForAdoption(live(oursArgv(), { pid: 4242 }), ROW)).toEqual({
      kind: 'adopt',
      pid: 4242,
    })
  })

  it('the ps KILL path is unchanged: its tokens can never carry whitespace', () => {
    // `cmdlineMatchesSession` splits on whitespace, so the new rule is vacuous for it
    // and the recycled-pid gate behaves exactly as it did.
    expect(cmdlineMatchesSession(oursArgv().join(' '), SESSION)).toBe(true)
    expect(cmdlineMatchesSession(`tail -f /x/.claude/projects/${SESSION}.jsonl`, SESSION)).toBe(false)
    expect(cmdlineMatchesSession(undefined, SESSION)).toBe(false)
  })

  it('an empty session id matches nothing, in either form', () => {
    expect(argvMatchesSession(oursArgv(), '')).toBe(false)
    expect(cmdlineMatchesSession(oursArgv().join(' '), '')).toBe(false)
  })
})
