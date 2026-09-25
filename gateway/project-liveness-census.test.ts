/**
 * #1237 — the project liveness census: its verdict order, the legacy-parent rule,
 * the ambiguous-parent rule, each busy source on its own, and a real `/proc` walk.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectAdmission } from './project-admission.ts'
import {
  NATIVE_CHILD_RECENT_MS,
  combineVerdicts,
  decideProjectLiveness,
  matchesConfiguredService,
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

  test('own services are not shells, but their descendants are; names only', async () => {
    const tree: Record<number, number[]> = { 10: [11, 12], 11: [13], 12: [], 13: [] }
    const argv: Record<number, string> = { 11: 'bun\0dev-channel\0', 12: 'bun\0tools-bridge\0', 13: 'bash\0-c\0secret\0' }
    const deps = {
      identity: () => ({ start_ticks: 1, boot_id: 'b' }) as never,
      readdir: async (path: string) => [path.split('/')[2]!],
      readFile: async (path: string) => {
        const pid = Number(path.split('/')[2])
        if (path.endsWith('/children')) return (tree[pid] ?? []).join(' ')
        if (path.endsWith('/cmdline')) return argv[pid] ?? ''
        if (path.endsWith('/comm')) return pid === 13 ? 'bash\n' : 'bun\n'
        throw new Error('unexpected')
      },
      isOwnService: (a: string[]) => a.includes('dev-channel') || a.includes('tools-bridge'),
    }
    const out = await walkProcessDescendants(10, deps)
    expect(out).toEqual({ verdict: 'busy', reasons: ['parent descendants running: 1 (bash)'] })
    // Control: with no grandchild, the own services alone are idle.
    tree[11] = []
    expect(await walkProcessDescendants(10, deps)).toEqual({ verdict: 'idle', reasons: [] })
  })

  test('owner-installed MCP servers: an exact configured launch is an own service, never a process-name match', () => {
    const servers = [{ command: '/opt/mcp/server-a', args: ['--stdio'] }, { command: 'npx', args: ['-y', 'pkg-b'] }]
    expect(matchesConfiguredService(['/opt/mcp/server-a', '--stdio'], servers)).toBe(true)
    // A bare command resolved through PATH, and a shebang script exec'd by its interpreter.
    expect(matchesConfiguredService(['npx', '-y', 'pkg-b'], servers)).toBe(true)
    expect(matchesConfiguredService(['node', '/usr/local/bin/npx', '-y', 'pkg-b'], servers)).toBe(true)
    expect(matchesConfiguredService(['/bin/sh', '/opt/mcp/server-a', '--stdio'], servers)).toBe(true)
    // The same binary with other arguments, a prefix of the args, or another command: not configured.
    expect(matchesConfiguredService(['/opt/mcp/server-a', '--stdio', '--extra'], servers)).toBe(false)
    expect(matchesConfiguredService(['/opt/mcp/server-a'], servers)).toBe(false)
    expect(matchesConfiguredService(['/elsewhere/server-a', '--stdio'], servers)).toBe(false)
    expect(matchesConfiguredService(['bash', '-c', 'npx -y pkg-b'], servers)).toBe(false)
    expect(matchesConfiguredService(['npx', '-y', 'pkg-b'], [])).toBe(false)
  })

  test('a configured server is idle with its descendants still walked; the same binary unconfigured, or its own shell, is busy', async () => {
    const tree: Record<number, number[]> = { 10: [11], 11: [], 12: [] }
    const argv: Record<number, string> = { 11: '/opt/mcp/server-a\0--stdio\0', 12: 'bash\0-c\0work\0' }
    const deps = (servers: Array<{ command: string; args?: string[] }>) => ({
      identity: () => ({ start_ticks: 1, boot_id: 'b' }) as never,
      readdir: async (path: string) => [path.split('/')[2]!],
      readFile: async (path: string) => {
        const pid = Number(path.split('/')[2])
        if (path.endsWith('/children')) return (tree[pid] ?? []).join(' ')
        if (path.endsWith('/cmdline')) return argv[pid] ?? ''
        if (path.endsWith('/comm')) return pid === 12 ? 'bash\n' : 'server-a\n'
        throw new Error('unexpected')
      },
      isOwnService: (a: string[]) => matchesConfiguredService(a, servers),
    })
    const configured = [{ command: '/opt/mcp/server-a', args: ['--stdio'] }]
    expect(await walkProcessDescendants(10, deps(configured))).toEqual({ verdict: 'idle', reasons: [] })
    expect(await walkProcessDescendants(10, deps([{ command: '/opt/mcp/server-a', args: ['--other'] }])))
      .toEqual({ verdict: 'busy', reasons: ['parent descendants running: 1 (server-a)'] })
    expect(await walkProcessDescendants(10, deps([]))).toEqual({ verdict: 'busy', reasons: ['parent descendants running: 1 (server-a)'] })
    // The configured server spawns a shell of its own: that descendant is busy.
    tree[11] = [12]
    expect(await walkProcessDescendants(10, deps(configured))).toEqual({ verdict: 'busy', reasons: ['parent descendants running: 1 (bash)'] })
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
