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
import { buildReplArgv } from '../build-repl-argv.ts'
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
    // `close-foreign-owner` (we would kill it). `leave-not-ours` is the honest answer:
    // the host DID report an argv and it says argv[0] is not a claude binary, which is a
    // positive finding about the process rather than an absence of one.
    expect(verdict.kind).toBe('leave-not-ours')
    expect(verdict.kind === 'leave-not-ours' && verdict.reason).toMatch(/claude --resume/)
  })

  it('REFUSES a smuggled argv[0] even when every OTHER rule is satisfied', () => {
    // THE VECTOR ABOVE IS REFUSED BY TWO RULES AT ONCE — `argv0IsClaude` rejects the
    // fused argv[0], and the `--resume` adjacency also fails because the flag was fused
    // INTO argv[0] and so is not an element. An assertion with two possible causes cannot
    // say which rule holds the line, and a mutation to either one leaves it green.
    //
    // This vector satisfies everything except the basename: `--resume <uuid>` are real
    // adjacent elements, the channel flag and value are real elements, and only argv[0]
    // is smuggled. So `argv0IsClaude` is the sole thing standing between it and an
    // `adopt`, which is the claim the whitespace removal rests on.
    const argv = [
      `${'claude'} --dangerously-load-development-channels`,
      '--resume',
      SESSION,
      '--dangerously-load-development-channels',
      `server:${CHANNEL}`,
    ]
    // The premise, asserted: every other rule IS satisfied.
    expect(argvCarriesChannel(argv, CHANNEL)).toBe(true)
    expect(argv[1]).toBe('--resume')
    expect(argv[2]).toBe(SESSION)
    // And it is still refused, on the basename alone.
    expect(argvMatchesSession(argv, SESSION)).toBe(false)
    expect(classifyPaneForAdoption(live(argv, { pid: 4242 }), ROW).kind).toBe('leave-not-ours')
    // The legitimate spaced binary is the other side of the same rule: `basenameOf`
    // splits on `/` and nothing else, so a space in a DIRECTORY name is fine.
    expect(argvMatchesSession(['/opt/my dir/claude', '--resume', SESSION], SESSION)).toBe(true)
  })

  it('ACCEPTS a real builder argv whose paths contain spaces — the case the old rule broke', () => {
    // ARGUS r12. An earlier revision refused any argv with whitespace in any element,
    // justified by an enumeration of what `buildReplArgv` emits that was simply wrong: it
    // also pushes `--mcp-config`, `--settings`, `--append-system-prompt-file` and
    // `--add-dir`, each a caller-supplied PATH, and the binary comes from `claude_bin` /
    // `CLAUDE_BIN`. A self-hoster with a project at `/srv/My Project` then had their own
    // live, correct child answered `unverifiable` — every boot, because nothing about the
    // situation ever changes.
    //
    // THE REAL BUILDER, NOT A HAND-WRITTEN ARRAY. A fixture typed out here would encode
    // the same wrong mental model of what the builder emits, which is exactly how the
    // rule got in. This asks the builder.
    const argv = buildReplArgv({
      claudeBin: '/opt/my tools/claude',
      sessionId: SESSION,
      resume: true,
      channelName: CHANNEL,
      mcpConfigPath: `/srv/My Project/.neutron/neutron-repl-${CHANNEL}/session-mcp.json`,
      settingsPath: `/srv/My Project/.neutron/neutron-repl-${CHANNEL}/settings.json`,
      appendSystemPromptFile: '/srv/My Project/.neutron/system-prompt.md',
      addDir: '/srv/My Project',
      model: 'claude-opus-5',
    })
    // The premise, asserted rather than assumed: this argv really does carry whitespace.
    expect(argv.some((el) => /\s/.test(el))).toBe(true)
    expect(argvMatchesSession(argv, SESSION)).toBe(true)
    // And the whole classifier accepts it — the channel arm reads the same vector.
    expect(classifyPaneForAdoption(live(argv, { pid: 4242 }), ROW)).toEqual({
      kind: 'adopt',
      pid: 4242,
    })
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
