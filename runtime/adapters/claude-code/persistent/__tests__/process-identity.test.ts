/**
 * A PID IS AN IDENTIFIER, NOT A HANDLE (#518).
 *
 * A gateway-shutdown entry stays eligible for four hours, and the kernel reissues pids
 * well inside that on a busy box. Every reader that confirms a launcher's death against
 * a stored NUMBER is therefore asking about whoever holds that number now — and cannot
 * tell. These cases pin the pair that closes the gap (`/proc` start ticks + boot id) and,
 * in the same breath, pin that it refuses to answer where it cannot know: an identity
 * that cannot be read must degrade to "unverifiable", never to a confident comparison.
 */
import { describe, expect, it } from 'bun:test'

import {
  classifyRecordedPid,
  currentBootId,
  isProcessIdentity,
  readProcessIdentity,
  type ProcessIdentity,
} from '../process-identity.ts'

/** `/proc/<pid>/stat` with a comm that contains BOTH a space and a close-paren — the
 *  shape that shifts every field for a naive `split(' ')`. Field 22 is 777. */
const TRICKY_STAT = `4242 (claude (repl) 1) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 6 0 0 20 0 9 0 777 123 456\n`

function fakeProc(files: Record<string, string>): { readFile: (p: string) => string } {
  return {
    readFile: (p: string) => {
      const v = files[p]
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
  }
}

const BOOT = 'boot-aaaa'
const procFor = (pid: number, stat: string): Record<string, string> => ({
  '/proc/sys/kernel/random/boot_id': `${BOOT}\n`,
  [`/proc/${pid}/stat`]: stat,
})

describe('readProcessIdentity', () => {
  it('reads field 22 past a comm containing spaces and parens', () => {
    // RED-mutation: parse from the FIRST `)` (or split the whole line on whitespace and
    // take index 21). Both read a number out of the comm and stamp a wrong identity —
    // which is worse than no identity, because it looks comparable.
    expect(readProcessIdentity(4242, fakeProc(procFor(4242, TRICKY_STAT)))).toEqual({
      start_ticks: 777,
      boot_id: BOOT,
    })
  })

  it('a host with no /proc has no identity, and says so', () => {
    // macOS self-host, or a container without /proc. RED-mutation: default to
    // `{ start_ticks: 0, boot_id: '' }` — every reader would then compare two zeroes
    // and call an unrelated process ours.
    expect(readProcessIdentity(4242, fakeProc({}))).toBeUndefined()
  })

  it('a stat line that does not parse is no identity', () => {
    expect(readProcessIdentity(4242, fakeProc(procFor(4242, '4242 (x) S 1 2 3\n')))).toBeUndefined()
    expect(readProcessIdentity(4242, fakeProc(procFor(4242, 'nonsense\n')))).toBeUndefined()
  })

  it('THE POSITIVE CONTROL — it reads THIS process out of the real kernel', () => {
    // The fakes above prove the parser; this proves the parser is pointed at the format
    // the kernel actually emits. Without it every case here could agree with a wrong
    // idea of `/proc`.
    const me = readProcessIdentity(process.pid)
    expect(me?.boot_id).toBe(currentBootId() as string)
    expect(me?.start_ticks).toBeGreaterThan(0)
  })
})

describe('isProcessIdentity refuses a half-shaped record', () => {
  it('a registry row is not a trusted type boundary', () => {
    expect(isProcessIdentity({ start_ticks: 1, boot_id: 'b' })).toBe(true)
    expect(isProcessIdentity({ start_ticks: '1', boot_id: 'b' })).toBe(false)
    expect(isProcessIdentity({ start_ticks: 1.5, boot_id: 'b' })).toBe(false)
    expect(isProcessIdentity({ start_ticks: 1, boot_id: '' })).toBe(false)
    expect(isProcessIdentity({ start_ticks: 1 })).toBe(false)
    expect(isProcessIdentity(undefined)).toBe(false)
    expect(isProcessIdentity(null)).toBe(false)
  })
})

describe('classifyRecordedPid', () => {
  const stamped: ProcessIdentity = { start_ticks: 777, boot_id: BOOT }
  const live = (pid: number, stat: string) => ({ ...fakeProc(procFor(pid, stat)), signal: () => {} })
  const gone = (pid: number) => ({
    ...fakeProc({ '/proc/sys/kernel/random/boot_id': `${BOOT}\n` }),
    signal: (p: number) => {
      if (p === pid) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
    },
  })

  it('a live pid with the SAME start time is still ours', () => {
    expect(classifyRecordedPid(4242, stamped, live(4242, TRICKY_STAT))).toBe('ours-alive')
  })

  it('A LIVE PID WITH A DIFFERENT START TIME HAS BEEN REISSUED — ours is gone', () => {
    // A running process keeps its pid, so a different start time is positive evidence
    // that ours released it. RED-mutation: return 'ours-alive' whenever the pid is live
    // (the pre-identity behaviour) — a dead launcher then reads as alive and its build
    // waits out the 90-minute reaper.
    const later = TRICKY_STAT.replace(' 777 ', ' 999 ')
    expect(classifyRecordedPid(4242, stamped, live(4242, later))).toBe('confirmed-gone')
  })

  it('an absent pid is confirmed gone', () => {
    expect(classifyRecordedPid(4242, stamped, gone(4242))).toBe('confirmed-gone')
  })

  it('EPERM is a live pid, not a dead one — and the identity decides whose', () => {
    // EPERM says the pid exists under another uid. Reading it as a death would report a
    // running launcher as killed.
    const eperm = {
      ...fakeProc(procFor(4242, TRICKY_STAT)),
      signal: () => {
        const err = new Error('EPERM') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      },
    }
    expect(classifyRecordedPid(4242, stamped, eperm)).toBe('ours-alive')
  })

  it('another boot is NOT COMPARABLE, and that is not the same as unverifiable', () => {
    // Start ticks count from boot, so a pid+start-time pair from a previous boot can
    // collide by coincidence. RED-mutation: drop the boot check — this case then reads a
    // live stranger as our launcher.
    expect(classifyRecordedPid(4242, { start_ticks: 777, boot_id: 'boot-other' }, live(4242, TRICKY_STAT))).toBe(
      'not-comparable',
    )
  })

  it('an UNREADABLE boot id is unverifiable — "I cannot tell" is its own answer', () => {
    // THE PAIR THAT MATTERS: a DIFFERENT boot id says the recorded process cannot still
    // be running; an UNREADABLE one says only that this host cannot answer, and a live
    // process may well be standing behind that pid. RED-mutation: collapse the two into
    // 'not-comparable' — a macOS host would then report every launcher dead.
    expect(classifyRecordedPid(4242, stamped, { ...fakeProc({}), signal: () => {} })).toBe('unverifiable')
  })

  it('no identity, or a half-shaped one, is unverifiable even when the pid is gone', () => {
    // The reuse-then-exit case: without an identity the absence of a pid is an
    // observation about a NUMBER. RED-mutation: return 'confirmed-gone' here — the
    // caller would attribute a death to a record it cannot tie to a process.
    expect(classifyRecordedPid(4242, undefined, gone(4242))).toBe('unverifiable')
    expect(classifyRecordedPid(4242, { boot_id: BOOT }, gone(4242))).toBe('unverifiable')
    expect(classifyRecordedPid(undefined, stamped, gone(4242))).toBe('unverifiable')
    expect(classifyRecordedPid(-1, stamped, gone(4242))).toBe('unverifiable')
  })

  it('a live pid whose identity cannot be READ BACK is unverifiable, not ours', () => {
    // The pid answers, `/proc` does not. Nothing ties it to us, so nothing is concluded.
    const blind = {
      readFile: (p: string) => {
        if (p === '/proc/sys/kernel/random/boot_id') return `${BOOT}\n`
        throw new Error('ENOENT')
      },
      signal: () => {},
    }
    expect(classifyRecordedPid(4242, stamped, blind)).toBe('unverifiable')
  })

  it('THE END-TO-END CONTROL — a real process, alive then killed', async () => {
    // Everything above is against a fake `/proc`. This one runs the whole rule against
    // the kernel: a process we spawn is `ours-alive` while it lives and `confirmed-gone`
    // once it is killed and reaped.
    const proc = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    try {
      const id = readProcessIdentity(proc.pid)
      expect(id).toBeDefined()
      expect(classifyRecordedPid(proc.pid, id)).toBe('ours-alive')
      proc.kill('SIGKILL')
      await proc.exited
      expect(classifyRecordedPid(proc.pid, id)).toBe('confirmed-gone')
    } finally {
      proc.kill('SIGKILL')
    }
  })
})
