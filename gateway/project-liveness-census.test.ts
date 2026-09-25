/**
 * #1237 — the project liveness census: its verdict order, the legacy-parent rule,
 * the ambiguous-parent rule, each busy source on its own, and a real `/proc` walk.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { OWN_SERVICE_PROVENANCE_ENV } from '@neutronai/runtime/mcp-servers.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectAdmission } from './project-admission.ts'
import {
  NATIVE_CHILD_RECENT_MS,
  combineVerdicts,
  decideProjectLiveness,
  readSubagentActivity,
  runProjectLivenessCensus,
  walkProcessDescendants,
  type CensusEvidence,
  type ParentObservation,
  type ProbeAnswer,
  type ProjectLivenessProbes,
} from './project-liveness-census.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'liveness-census-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const IDLE: ProbeAnswer = { verdict: 'idle', reasons: [] }
const BUSY: ProbeAnswer = { verdict: 'busy', reasons: ['busy probe'] }
const UNKNOWN: ProbeAnswer = { verdict: 'unknown', reasons: ['unknown probe'] }

function parent(over: Partial<ParentObservation> = {}): ParentObservation {
  return { sessionKey: 'key-a', childGeneration: 'gen-a', sessionId: 'session-a', pid: 4242, admissionGeneration: 2,
    activeTurn: false, turnSlotHeld: 0, poisoned: false, retiring: false, subagentsDirectory: '/nonexistent', ...over }
}

function evidence(over: Partial<CensusEvidence> = {}): CensusEvidence {
  return { sessions: { kind: 'answered', live: [parent()], unresolved: 0 }, turnInFlight: false, childLeases: 0,
    unleasedLiveRuns: 0, subagents: IDLE, descendants: IDLE, ...over }
}

describe('the verdict order', () => {
  test('busy beats unknown beats idle', () => {
    expect(combineVerdicts()).toBe('idle')
    expect(combineVerdicts('idle', 'idle')).toBe('idle')
    expect(combineVerdicts('idle', 'unknown')).toBe('unknown')
    expect(combineVerdicts('unknown', 'busy', 'idle')).toBe('busy')
    expect(combineVerdicts('busy', 'unknown')).toBe('busy')
  })

  test('an identified, participating, quiet parent is idle — the control every guard below departs from', () => {
    const out = decideProjectLiveness(evidence())
    expect(out.parent).toMatchObject({ kind: 'participating', generation: 2, pid: 4242 })
    expect([out.parentTurn, out.children, out.shells, out.verdict]).toEqual(['idle', 'idle', 'idle', 'idle'])
  })
})

describe('legacy vs participating parents', () => {
  test('a legacy parent (no stamp) reads children UNKNOWN even with no leases and an idle directory', () => {
    const out = decideProjectLiveness(evidence({ sessions: { kind: 'answered', live: [parent({ admissionGeneration: undefined })], unresolved: 0 } }))
    expect(out.parent.kind).toBe('legacy-unknown')
    expect(out.children).toBe('unknown')
    expect(out.verdict).toBe('unknown')
    expect(out.reasons.join('\n')).toContain('legacy parent')
  })

  test('a legacy parent with evidence of a child still reads busy', () => {
    const out = decideProjectLiveness(evidence({ childLeases: 1, sessions: { kind: 'answered', live: [parent({ admissionGeneration: undefined })], unresolved: 0 } }))
    expect(out.children).toBe('busy')
    expect(out.verdict).toBe('busy')
  })

  test('generation 0 is a stamp, not an absence', () => {
    const out = decideProjectLiveness(evidence({ sessions: { kind: 'answered', live: [parent({ admissionGeneration: 0 })], unresolved: 0 } }))
    expect(out.parent).toMatchObject({ kind: 'participating', generation: 0 })
    expect(out.verdict).toBe('idle')
  })

  test('a participating parent whose directory was never probed is unknown, not idle', () => {
    const { subagents: _omit, ...rest } = evidence()
    expect(decideProjectLiveness(rest).children).toBe('unknown')
  })
})

describe('ambiguous and unidentified parents', () => {
  test('two live candidates: every part unknown', () => {
    const out = decideProjectLiveness(evidence({ sessions: { kind: 'answered', live: [parent(), parent({ sessionKey: 'key-b' })], unresolved: 0 } }))
    expect(out.parent).toEqual({ kind: 'ambiguous', count: 2 })
    expect([out.parentTurn, out.children, out.shells, out.verdict]).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
  })

  test('one live plus one unresolved candidate is ambiguous; held leases still make children busy', () => {
    const out = decideProjectLiveness(evidence({ childLeases: 2, sessions: { kind: 'answered', live: [parent()], unresolved: 1 } }))
    expect(out.parent).toEqual({ kind: 'ambiguous', count: 2 })
    expect(out.children).toBe('busy')
    expect(out.verdict).toBe('busy')
  })

  test('a lone unresolved candidate is unidentified, never absent', () => {
    const out = decideProjectLiveness(evidence({ sessions: { kind: 'answered', live: [], unresolved: 1 } }))
    expect(out.parent.kind).toBe('unidentified')
    expect(out.verdict).toBe('unknown')
  })

  test('an unreadable session probe is unidentified', () => {
    const out = decideProjectLiveness(evidence({ sessions: { kind: 'unknown', reason: 'pool unreadable' } }))
    expect(out.parent).toEqual({ kind: 'unidentified', reason: 'pool unreadable' })
    expect(out.verdict).toBe('unknown')
  })

  test('no parent at all: idle unless a turn or a lease says otherwise', () => {
    const none = { kind: 'answered' as const, live: [], unresolved: 0 }
    expect(decideProjectLiveness(evidence({ sessions: none })).verdict).toBe('idle')
    expect(decideProjectLiveness(evidence({ sessions: none, turnInFlight: true })).parentTurn).toBe('busy')
    expect(decideProjectLiveness(evidence({ sessions: none, childLeases: 1 })).children).toBe('busy')
    expect(decideProjectLiveness(evidence({ sessions: none, unleasedLiveRuns: 1 })).children).toBe('busy')
  })
})

describe('each busy source alone makes the census busy', () => {
  const cases: Array<[string, Partial<CensusEvidence>, 'parentTurn' | 'children' | 'shells']> = [
    ['active turn', { sessions: { kind: 'answered', live: [parent({ activeTurn: true })], unresolved: 0 } }, 'parentTurn'],
    ['turn slot held', { sessions: { kind: 'answered', live: [parent({ turnSlotHeld: 1 })], unresolved: 0 } }, 'parentTurn'],
    ['abandoned turn', { sessions: { kind: 'answered', live: [parent({ poisoned: true })], unresolved: 0 } }, 'parentTurn'],
    ['turn in flight', { turnInFlight: true }, 'parentTurn'],
    ['native-child lease', { childLeases: 1 }, 'children'],
    ['unleased live run', { unleasedLiveRuns: 1 }, 'children'],
    ['recent native-child transcript', { subagents: BUSY }, 'children'],
    ['descendant process', { descendants: BUSY }, 'shells'],
    ['pane foreground', { pane: BUSY }, 'shells'],
  ]
  for (const [name, over, part] of cases) {
    test(name, () => {
      const out = decideProjectLiveness(evidence(over))
      expect(out[part]).toBe('busy')
      expect(out.verdict).toBe('busy')
    })
  }

  test('a retiring parent with no turn reads its turn unknown', () => {
    const out = decideProjectLiveness(evidence({ sessions: { kind: 'answered', live: [parent({ retiring: true })], unresolved: 0 } }))
    expect(out.parentTurn).toBe('unknown')
  })

  test('an unknown shell probe is unknown, never idle', () => {
    expect(decideProjectLiveness(evidence({ descendants: UNKNOWN })).shells).toBe('unknown')
  })
})

describe('the native-child directory', () => {
  test('missing is idle; a recent agent transcript is busy; an old one is idle; an unreadable one is unknown', async () => {
    const dir = scratch()
    const now = Date.now()
    expect((await readSubagentActivity(join(dir, 'absent'), now)).verdict).toBe('idle')
    const sub = join(dir, 'subagents')
    mkdirSync(sub)
    writeFileSync(join(sub, 'agent-old.jsonl'), '{}\n')
    const old = (now - NATIVE_CHILD_RECENT_MS * 2) / 1000
    utimesSync(join(sub, 'agent-old.jsonl'), old, old)
    writeFileSync(join(sub, 'unrelated.jsonl'), '{}\n')
    expect((await readSubagentActivity(sub, now)).verdict).toBe('idle')
    writeFileSync(join(sub, 'agent-new.jsonl'), '{}\n')
    expect(await readSubagentActivity(sub, Date.now())).toEqual({ verdict: 'busy', reasons: ['recent native-child transcripts: 1'] })
    // A FILE where the directory should be: readable path, unreadable directory.
    const notDir = join(dir, 'file')
    writeFileSync(notDir, 'x')
    expect((await readSubagentActivity(notDir, now)).verdict).toBe('unknown')
  })
})

describe('the /proc descendant walk', () => {
  test('an unreadable /proc or parent identity is unknown', async () => {
    const identity = () => ({ start_ticks: 1, boot_id: 'b' }) as never
    expect((await walkProcessDescendants(10, { identity: () => undefined })).verdict).toBe('unknown')
    expect((await walkProcessDescendants(10, { identity, readdir: async () => { throw new Error('EACCES') } })).verdict).toBe('unknown')
    expect((await walkProcessDescendants(10, { identity, readdir: async () => ['10'], readFile: async () => { throw new Error('EACCES') } })).verdict).toBe('unknown')
  })

  test('a parent pid that changes identity during the walk is unknown', async () => {
    let n = 0
    const out = await walkProcessDescendants(10, {
      identity: () => ({ start_ticks: n++, boot_id: 'b' }) as never,
      readdir: async () => ['10'],
      readFile: async () => '',
    })
    expect(out).toEqual({ verdict: 'unknown', reasons: ['parent pid changed identity during the census'] })
  })

  // A fake /proc: `tree` is the children, `environ` the NUL-joined environment
  // (a missing key reads ENOENT, the string 'EACCES' throws a permission error),
  // `argv` the cmdline — which the walk must NOT consult for ownership.
  const MARKER = OWN_SERVICE_PROVENANCE_ENV
  const GEN = 'gen-a'
  function fakeProc(tree: Record<number, number[]>, environ: Record<number, string>, comm: Record<number, string>,
    argv: Record<number, string> = {}) {
    const fail = (code: string): never => { throw Object.assign(new Error(code), { code }) }
    return {
      identity: () => ({ start_ticks: 1, boot_id: 'b' }) as never,
      readdir: async (path: string) => [path.split('/')[2]!],
      readFile: async (path: string) => {
        const pid = Number(path.split('/')[2])
        if (path.endsWith('/children')) return (tree[pid] ?? []).join(' ')
        if (path.endsWith('/environ')) {
          const env = environ[pid]
          if (env === undefined) return fail('ENOENT')
          if (env === 'EACCES') return fail('EACCES')
          return env
        }
        if (path.endsWith('/cmdline')) return argv[pid] ?? ''
        if (path.endsWith('/comm')) return `${comm[pid] ?? 'unknown'}\n`
        throw new Error(`unexpected proc read: ${path}`)
      },
    }
  }
  const env = (...entries: string[]) => `${entries.join('\0')}\0`
  /** The first child of `pid`, waited for (0 when none appeared). */
  async function grandchildOf(pid: number): Promise<number> {
    for (let i = 0; i < 150; i++) {
      const kids = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '')).trim()
      if (kids !== '') return Number.parseInt(kids.split(/\s+/)[0]!, 10)
      await Bun.sleep(20)
    }
    return 0
  }
  /** Kill a spawned wrapper AND the grandchild it started, so no `sleep` outlives the test. */
  async function killTree(p: ReturnType<typeof Bun.spawn>): Promise<void> {
    const kids = (await readFile(`/proc/${p.pid}/task/${p.pid}/children`, 'utf8').catch(() => '')).trim()
    for (const kid of kids === '' ? [] : kids.split(/\s+/)) {
      try { process.kill(Number.parseInt(kid, 10), 'SIGKILL') } catch { /* already gone */ }
    }
    p.kill()
    await p.exited
  }
  const own = { ownService: { env: MARKER, value: GEN } }

  test('(a) a marked wrapper and the grandchild it starts (the npx shape) are the parent\'s own service: idle', async () => {
    const proc = fakeProc({ 10: [11], 11: [13], 13: [] },
      { 11: env('PATH=/bin', `${MARKER}=${GEN}`), 13: env(`${MARKER}=${GEN}`, 'HOME=/h') },
      { 11: 'npm exec', 13: 'node' })
    expect(await walkProcessDescendants(10, { ...proc, ...own })).toEqual({ verdict: 'idle', reasons: [] })
  })

  test('(b) work a service starts OUTSIDE its provenance is still a shell; names only', async () => {
    const proc = fakeProc({ 10: [11, 12], 11: [13], 12: [], 13: [] },
      { 11: env(`${MARKER}=${GEN}`), 12: env(`${MARKER}=${GEN}`), 13: env('PATH=/bin') },
      { 11: 'bun', 12: 'bun', 13: 'bash' }, { 13: 'bash\0-c\0secret\0' })
    const out = await walkProcessDescendants(10, { ...proc, ...own })
    expect(out).toEqual({ verdict: 'busy', reasons: ['parent descendants running: 1 (bash)'] })
    expect(JSON.stringify(out)).not.toContain('secret')
    expect(JSON.stringify(out)).not.toContain(GEN)
  })

  test('(c) NEGATIVE CONTROL: the configured argv with no provenance is a shell', async () => {
    const proc = fakeProc({ 10: [11], 11: [] }, { 11: env('PATH=/bin') }, { 11: 'bun' },
      { 11: 'bun\0dev-channel\0' })
    expect(await walkProcessDescendants(10, { ...proc, ...own }))
      .toEqual({ verdict: 'busy', reasons: ['parent descendants running: 1 (bun)'] })
  })

  test('(d) a marker from ANOTHER generation, or only as a later duplicate, is not this parent\'s', async () => {
    const stale = fakeProc({ 10: [11], 11: [] }, { 11: env(`${MARKER}=gen-old`) }, { 11: 'bun' })
    expect((await walkProcessDescendants(10, { ...stale, ...own })).verdict).toBe('busy')
    // getenv reads the FIRST entry; a later matching duplicate proves nothing.
    const dup = fakeProc({ 10: [11], 11: [] }, { 11: env(`${MARKER}=gen-old`, `${MARKER}=${GEN}`) }, { 11: 'bun' })
    expect((await walkProcessDescendants(10, { ...dup, ...own })).verdict).toBe('busy')
    // A value that merely starts with the generation is not it.
    const prefix = fakeProc({ 10: [11], 11: [] }, { 11: env(`${MARKER}=${GEN}x`) }, { 11: 'bun' })
    expect((await walkProcessDescendants(10, { ...prefix, ...own })).verdict).toBe('busy')
  })

  test('(e) an unreadable or absent environ is unproven: busy, never idle', async () => {
    const denied = fakeProc({ 10: [11], 11: [] }, { 11: 'EACCES' }, { 11: 'bun' })
    expect(await walkProcessDescendants(10, { ...denied, ...own }))
      .toEqual({ verdict: 'busy', reasons: ['parent descendants running: 1 (bun)'] })
    const absent = fakeProc({ 10: [11], 11: [] }, {}, { 11: 'bun' })
    expect((await walkProcessDescendants(10, { ...absent, ...own })).verdict).toBe('busy')
    const empty = fakeProc({ 10: [11], 11: [] }, { 11: '' }, { 11: 'bun' })
    expect((await walkProcessDescendants(10, { ...empty, ...own })).verdict).toBe('busy')
  })

  test('(f) no provenance given, or an empty generation, exempts nothing', async () => {
    const proc = fakeProc({ 10: [11], 11: [] }, { 11: env(`${MARKER}=`) }, { 11: 'bun' })
    expect((await walkProcessDescendants(10, proc)).verdict).toBe('busy')
    expect((await walkProcessDescendants(10, { ...proc, ownService: { env: MARKER, value: '' } })).verdict).toBe('busy')
    // Control: the same process marked with the parent's generation is idle.
    const marked = fakeProc({ 10: [11], 11: [] }, { 11: env(`${MARKER}=${GEN}`) }, { 11: 'bun' })
    expect((await walkProcessDescendants(10, { ...marked, ...own })).verdict).toBe('idle')
  })

  test('(g) an own service whose children cannot be read is unknown, not idle', async () => {
    const proc = fakeProc({ 10: [11] }, { 11: env(`${MARKER}=${GEN}`) }, { 11: 'bun' })
    const out = await walkProcessDescendants(10, { ...proc, ...own,
      readFile: async (path: string) => {
        if (path === '/proc/11/task/11/children') throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return proc.readFile(path)
      } })
    expect(out).toEqual({ verdict: 'unknown', reasons: ['descendant process tree unreadable'] })
  })

  test.if(process.platform === 'linux')('a REAL process tree: the marked subtree is own, the same argv unmarked is a shell', async () => {
    const REAL_GEN = `gen-real-${process.pid}-${Date.now()}`
    const argv = ['/bin/sh', '-c', 'sleep 30 & wait']
    const marked = Bun.spawn(argv, { env: { ...process.env, [MARKER]: REAL_GEN }, stdout: 'ignore', stderr: 'ignore' })
    let unmarked: ReturnType<typeof Bun.spawn> | undefined
    try {
      const deps = { ownService: { env: MARKER, value: REAL_GEN } }
      // Wait for the marked wrapper to start its grandchild, so the idle read below
      // is about a real two-level tree and not a race.
      expect(await grandchildOf(marked.pid)).toBeGreaterThan(0)
      const markedOnly = await walkProcessDescendants(process.pid, deps)
      expect(markedOnly.reasons.join('')).not.toContain('sleep')
      // The identical argv, spawned without the marker: a shell.
      unmarked = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' })
      let both = await walkProcessDescendants(process.pid, deps)
      for (let i = 0; i < 100 && !both.reasons.join('').includes('sleep'); i++) {
        await Bun.sleep(20)
        both = await walkProcessDescendants(process.pid, deps)
      }
      expect(both.verdict).toBe('busy')
      expect(both.reasons.join('')).toContain('sleep')
    } finally {
      for (const p of [marked, unmarked]) {
        if (p === undefined) continue
        await killTree(p)
      }
    }
  })

  test('a real child process reads busy while it runs and idle after it exits', async () => {
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      const running = await walkProcessDescendants(process.pid)
      expect(running.verdict).toBe('busy')
      expect(running.reasons.join('')).toContain('sleep')
    } finally {
      child.kill()
      await child.exited
    }
    const after = await walkProcessDescendants(process.pid)
    expect(after.reasons.join('')).not.toContain('sleep')
  })
})

describe('runProjectLivenessCensus over a real admission store', () => {
  function admission() {
    const dir = scratch()
    const path = join(dir, 'project.db')
    seedMigratedDb(path)
    const db = ProjectDb.open(path)
    cleanup.push(() => db.close())
    return new ProjectAdmission({ db, ownerHandle: 'owner-census', bootId: 'boot-census' })
  }
  function probes(over: Partial<ProjectLivenessProbes> = {}): ProjectLivenessProbes {
    return {
      sessions: async () => ({ kind: 'answered', live: [parent()], unresolved: 0 }),
      turnInFlight: () => false,
      subagentActivity: async () => IDLE,
      descendants: async () => IDLE,
      ...over,
    }
  }

  test('reads its own scope\'s native-child leases, and nothing else\'s', async () => {
    const a = admission()
    expect((await runProjectLivenessCensus({ admission: a, probes: probes() }, null)).verdict).toBe('idle')
    const child = await a.forNativeChild(null).admit('run-1', 'build:0')
    expect(child.status).toBe('admitted')
    const busy = await runProjectLivenessCensus({ admission: a, probes: probes() }, null)
    expect(busy.children).toBe('busy')
    expect(busy.scope).toEqual({ ownerHandle: 'owner-census', projectId: null })
    expect(busy.fence?.phase).toBe('open')
    if (child.status === 'admitted') await child.release()
    expect((await runProjectLivenessCensus({ admission: a, probes: probes() }, null)).verdict).toBe('idle')
  })

  test('a throwing probe reads unknown; it never throws out of the census', async () => {
    const a = admission()
    const out = await runProjectLivenessCensus({ admission: a, probes: probes({
      descendants: async () => { throw new Error('proc gone') },
    }) }, null)
    expect(out.shells).toBe('unknown')
    expect(out.reasons.join('\n')).toContain('shell probe failed: proc gone')
    const sessionsThrow = await runProjectLivenessCensus({ admission: a, probes: probes({
      sessions: async () => { throw new Error('pool gone') },
    }) }, null)
    expect(sessionsThrow.parent).toEqual({ kind: 'unidentified', reason: 'pool gone' })
  })

  test('an unresolvable native-child directory is unknown; a pane probe is consulted when present', async () => {
    const a = admission()
    const noDir = await runProjectLivenessCensus({ admission: a, probes: probes({
      sessions: async () => ({ kind: 'answered', live: [parent({ subagentsDirectory: null })], unresolved: 0 }),
    }) }, null)
    expect(noDir.children).toBe('unknown')
    const pane = await runProjectLivenessCensus({ admission: a, probes: probes({ paneForeground: async () => BUSY }) }, null)
    expect(pane.shells).toBe('busy')
  })
})
