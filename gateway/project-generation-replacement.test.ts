/**
 * #1237 — the project maintenance owner over the REAL admission store: legitimate
 * exact-generation replacement, busy/unknown/legacy/ambiguous/absent refusals, the
 * admission race, exact-generation drift, a refused replacement holding the fence,
 * the pure attestation table, and restart continuity through a second connection.
 * Every guard sits beside the opposite control that passes.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type {
  ExpectedParent,
  ReplacementObservation,
  ReplacementResult,
} from '@neutronai/runtime/adapters/claude-code/persistent/generation-replacement.ts'
import type { ReplSession } from '@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts'
import { OWN_SERVICE_PROVENANCE_ENV } from '@neutronai/runtime/mcp-servers.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectAdmission } from './project-admission.ts'
import { decideProjectLiveness, walkProcessDescendants, type CensusEvidence, type ParentObservation, type ProjectLivenessCensus } from './project-liveness-census.ts'
import {
  attestReplacement,
  replaceProjectGeneration,
  resumeProjectMaintenance,
  type AttestationExpectation,
  type ProjectMaintenancePorts,
} from './project-generation-replacement.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })

const SURFACE = 'Read,Bash,Agent'
const IDENTITY = { start_ticks: 77, boot_id: 'boot-a' }
const OLD = { sessionKey: 'cc-agent-general', childGeneration: 'gen-old', sessionId: 'conversation-1', pid: 4242 }

function openDb(): { path: string; db: ProjectDb } {
  const dir = mkdtempSync(join(tmpdir(), 'generation-replacement-'))
  const path = join(dir, 'project.db')
  seedMigratedDb(path)
  const db = ProjectDb.open(path)
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { path, db }
}

function admissionOver(db: ProjectDb, bootId = 'boot-1'): ProjectAdmission {
  return new ProjectAdmission({ db, ownerHandle: 'owner', bootId })
}

type ParentSpec = Partial<ParentObservation> | 'absent' | 'ambiguous'

/** A census as the real decision makes it, from one parent and quiet probes. */
function censusOf(admission: ProjectAdmission, parent: ParentSpec, over: Partial<CensusEvidence> = {}): ProjectLivenessCensus {
  const observation = (p: Partial<ParentObservation>): ParentObservation => ({
    ...OLD, admissionGeneration: 0, activeTurn: false, turnSlotHeld: 0, poisoned: false, retiring: false,
    subagentsDirectory: '/nonexistent', ...p,
  })
  const live = parent === 'absent' ? [] : parent === 'ambiguous' ? [observation({}), observation({ sessionKey: 'other' })] : [observation(parent)]
  const childLeases = admission.listLeases('liveChild').filter((l) => l.scope.projectId === null).length
  const decided = decideProjectLiveness({
    sessions: { kind: 'answered', live, unresolved: 0 }, turnInFlight: false, childLeases, unleasedLiveRuns: 0,
    subagents: { verdict: 'idle', reasons: [] }, descendants: { verdict: 'idle', reasons: [] }, ...over,
  })
  return { scope: admission.scopeFor(null), fence: admission.inspect(null), ...decided, observedAt: new Date(0).toISOString() }
}

function observationFor(generation: number, over: Partial<ReplacementObservation> = {}): ReplacementObservation {
  return {
    sessionId: OLD.sessionId, childGeneration: 'gen-new', pid: 5151, exited: false, identified: true,
    admissionGeneration: generation, toolSurface: SURFACE, toolBridgeActive: true, adopted: false,
    registry: { sessionId: OLD.sessionId, admission_generation: generation, tool_surface: SURFACE, tool_bridge: true },
    ...over,
  }
}

interface Harness {
  admission: ProjectAdmission
  ports: ProjectMaintenancePorts
  replaced: ExpectedParent[]
  phases: { census: string[]; replace: string[]; observe: string[] }
}

function harness(opts: {
  census?: (call: number, admission: ProjectAdmission) => ProjectLivenessCensus | Promise<ProjectLivenessCensus>
  replace?: (expected: ExpectedParent) => ReplacementResult
  observe?: (generation: number) => ReplacementObservation | undefined
  budgetMs?: number
} = {}): Harness {
  const { db } = openDb()
  const admission = admissionOver(db)
  const replaced: ExpectedParent[] = []
  const phases = { census: [] as string[], replace: [] as string[], observe: [] as string[] }
  const phase = (): string => admission.inspect(null)?.phase ?? 'none'
  let clock = 0
  let calls = 0
  const ports: ProjectMaintenancePorts = {
    census: async () => {
      phases.census.push(phase())
      calls += 1
      return opts.census ? opts.census(calls, admission) : censusOf(admission, {})
    },
    replace: async (expected) => {
      phases.replace.push(phase())
      replaced.push(expected)
      return opts.replace ? opts.replace(expected) : { status: 'replaced', session: {} as ReplSession }
    },
    observe: () => {
      phases.observe.push(phase())
      const generation = admission.inspect(null)!.generation
      return opts.observe ? opts.observe(generation) : observationFor(generation)
    },
    identity: () => IDENTITY,
    expectedProfile: () => ({ toolSurface: SURFACE, toolBridge: true }),
    drainPollMs: 10,
    drainBudgetMs: opts.budgetMs ?? 50,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
  }
  return { admission, ports, replaced, phases }
}

describe('legitimate exact-generation replacement', () => {
  for (const mode of ['empty', 'exited', 'reaped-during-read', 'permission-list', 'permission-read', 'thread-vanished', 'shell'] as const) {
    test(`real descendant walker gates replacement: ${mode}`, async () => {
      let reaped = false
      const fail = (code: string): never => { throw Object.assign(new Error(code), { code }) }
      const descendants = () => walkProcessDescendants(OLD.pid, {
        identity: () => IDENTITY,
        ownService: { env: OWN_SERVICE_PROVENANCE_ENV, value: 'gen-own' },
        readdir: async (path) => {
          if (path === '/proc/11/task') {
            if (mode === 'permission-list') fail('EACCES')
            if (mode === 'exited' || reaped) fail('ENOENT')
          }
          return [path.split('/')[2]!]
        },
        readFile: async (path) => {
          if (path === `/proc/${OLD.pid}/task/${OLD.pid}/children`) return '11'
          if (path === '/proc/11/environ') return `PATH=/bin\0${OWN_SERVICE_PROVENANCE_ENV}=gen-own\0`
          if (path === '/proc/12/environ') return 'PATH=/bin\0'
          if (path === '/proc/11/task/11/children') {
            if (mode === 'permission-read') fail('EACCES')
            if (mode === 'thread-vanished') fail('ENOENT')
            if (mode === 'reaped-during-read') { reaped = true; fail('ENOENT') }
            return mode === 'shell' ? '12' : ''
          }
          if (path === '/proc/12/comm') return 'bash'
          if (path === '/proc/12/task/12/children') return ''
          throw new Error(`unexpected proc read: ${path}`)
        },
      })
      const allowed = ['empty', 'exited', 'reaped-during-read'].includes(mode)
      const answer = await descendants()
      const h = harness({ census: async (_call, admission) => censusOf(admission, {}, { descendants: await descendants() }) })
      const outcome = await replaceProjectGeneration({ admission: h.admission, ports: h.ports }, null)
      expect(outcome.status).toBe(allowed ? 'replaced' : mode === 'shell' ? 'busy' : 'unknown')
      expect(h.replaced.length).toBe(allowed ? 1 : 0)
      expect(answer.verdict).toBe(allowed ? 'idle' : mode === 'shell' ? 'busy' : 'unknown')
    })
  }

  test('a participating idle parent is replaced through every phase and admission reopens (control)', async () => {
    const h = harness()
    const before = await h.admission.generationFor(null)
    const outcome = await replaceProjectGeneration({ admission: h.admission, ports: h.ports }, null)
    expect(outcome).toEqual({ status: 'replaced', generation: before! + 1, parent: { sessionId: OLD.sessionId, from: 'gen-old', to: 'gen-new' } })
    expect(h.phases.census).toEqual(['draining', 'quiesced'])
    expect(h.phases.replace).toEqual(['replacing'])
    expect(h.phases.observe).toEqual(['attesting'])
    expect(h.replaced).toEqual([{ ...OLD, identity: IDENTITY }])
    expect(h.admission.inspect(null)).toMatchObject({ phase: 'open', generation: before! + 1, leases: 0 })
  })
})

describe('busy, unknown and protected parents are never replaced', () => {
  test('busy for the whole budget → busy, never replaced, fence released (guard)', async () => {
    const h = harness({ census: (_n, a) => censusOf(a, { activeTurn: true }) })
    const outcome = await replaceProjectGeneration({ admission: h.admission, ports: h.ports }, null)
    expect(outcome.status).toBe('busy')
    expect(h.replaced).toEqual([])
    expect(h.phases.census.length).toBeGreaterThan(2)
    expect(h.admission.inspect(null)?.phase).toBe('open')
  })

  test('busy that drains into idle is replaced (control for busy and unknown)', async () => {
    const h = harness({ census: (n, a) => censusOf(a, { activeTurn: n < 3 }) })
    const outcome = await replaceProjectGeneration({ admission: h.admission, ports: h.ports }, null)
    expect(outcome.status).toBe('replaced')
    expect(h.replaced.length).toBe(1)
  })

  test('unknown never drains into idle (guard)', async () => {
    const h = harness({ census: (_n, a) => censusOf(a, {}, { descendants: { verdict: 'unknown', reasons: ['proc unreadable'] } }) })
    const outcome = await replaceProjectGeneration({ admission: h.admission, ports: h.ports }, null)
    expect(outcome).toMatchObject({ status: 'unknown' })
    expect(h.phases.census).toEqual(['draining'])
    expect(h.replaced).toEqual([])
    expect(h.admission.inspect(null)?.phase).toBe('open')
  })

  test('a legacy-unknown parent with idle everything is protected (guard) — the same evidence stamped is replaced (control)', async () => {
    const legacy = harness({ census: (_n, a) => censusOf(a, { admissionGeneration: undefined }) })
    expect((await replaceProjectGeneration({ admission: legacy.admission, ports: legacy.ports }, null)).status).toBe('protected')
    expect(legacy.replaced).toEqual([])
    expect(legacy.admission.inspect(null)?.phase).toBe('open')

    const stamped = harness({ census: (_n, a) => censusOf(a, { admissionGeneration: 0 }) })
    expect((await replaceProjectGeneration({ admission: stamped.admission, ports: stamped.ports }, null)).status).toBe('replaced')
  })

  test('an ambiguous parent is protected', async () => {
    const h = harness({ census: (_n, a) => censusOf(a, 'ambiguous') })
    expect((await replaceProjectGeneration({ admission: h.admission, ports: h.ports }, null)).status).toBe('protected')
    expect(h.replaced).toEqual([])
  })

  test('no parent → absent, nothing replaced, fence released', async () => {
    const h = harness({ census: (_n, a) => censusOf(a, 'absent') })
    expect(await replaceProjectGeneration({ admission: h.admission, ports: h.ports }, null)).toEqual({ status: 'absent' })
    expect(h.replaced).toEqual([])
    expect(h.admission.inspect(null)?.phase).toBe('open')
  })

  test('a scope already fenced by another owner is never stolen', async () => {
    const h = harness()
    const scope = h.admission.scopeFor(null)
    await h.admission.generationFor(null)
    expect(await h.admission.maintenance.beginMaintenance(scope)).not.toBeNull()
    expect((await replaceProjectGeneration({ admission: h.admission, ports: h.ports }, null)).status).toBe('already-fenced')
    expect(h.phases.census).toEqual([])
    expect(h.admission.inspect(null)?.phase).toBe('draining')
  })
})

describe('the admission race', () => {
  test('a lease admitted during the drain holds quiescence until it is released (guard + control)', async () => {
    const releases: Array<() => Promise<boolean>> = []
    const leasesAtCensus: number[] = []
    const h = harness({
      census: async (n, a) => {
        if (n === 1) {
          // Between this census and the advance, admitted work grows: a native child
          // of the build the fence already admitted joins it (the only admission a
          // fence permits).
          const child = await a.forNativeChild(null).admit('run-race', 'build:0')
          if (child.status !== 'admitted') throw new Error(`expected the child to join, got ${child.status}`)
          releases.push(child.release)
        }
        if (n === 2) for (const release of releases.splice(0)) await release()
        leasesAtCensus.push(a.inspect(null)!.leases)
        return censusOf(a, {})
      },
    })
    const build = await h.admission.admit(null, 'build', 'work-board', 'run-race')
    if (build.status !== 'admitted') throw new Error('expected the build to be admitted')
    releases.push(build.release)
    const outcome = await replaceProjectGeneration({ admission: h.admission, ports: h.ports }, null)
    expect(outcome.status).toBe('replaced')
    // It never quiesced while a lease existed: the first reading saw two, the next none.
    expect(leasesAtCensus).toEqual([2, 0, 0])
    expect(h.phases.census).toEqual(['draining', 'draining', 'quiesced'])
    expect(h.phases.replace).toEqual(['replacing'])
  })

  test('the store itself refuses to leave draining while a lease is held', async () => {
    const h = harness()
    const scope = h.admission.scopeFor(null)
    const build = await h.admission.admit(null, 'build', 'work-board', 'run-store')
    if (build.status !== 'admitted') throw new Error('expected admission')
    const fence = (await h.admission.maintenance.beginMaintenance(scope))!
    expect(await h.admission.maintenance.advance(fence)).toBeNull()
    await build.release()
    expect(await h.admission.maintenance.advance(fence)).not.toBeNull()
  })
})

describe('the exact generation', () => {
  test('a parent that drifts after quiescence is not replaced (guard)', async () => {
    const h = harness({ census: (n, a) => censusOf(a, n === 1 ? {} : { childGeneration: 'gen-other' }) })
    const outcome = await replaceProjectGeneration({ admission: h.admission, ports: h.ports }, null)
    expect(outcome).toMatchObject({ status: 'unknown', reasons: ['parent changed after quiescence'] })
    expect(h.replaced).toEqual([])
    expect(h.admission.inspect(null)?.phase).toBe('open')
  })

  test('a parent already stamped with the fence generation is not replaced again', async () => {
    const h = harness({ census: (_n, a) => censusOf(a, { admissionGeneration: a.inspect(null)!.generation }) })
    const outcome = await replaceProjectGeneration({ admission: h.admission, ports: h.ports }, null)
    expect(outcome.status).toBe('unknown')
    expect(h.replaced).toEqual([])
  })
})

describe('a replacement that did not happen keeps admission closed', () => {
  for (const result of [
    { status: 'refused', reason: 'identity-mismatch' } as const,
    { status: 'unknown', reason: 'old child did not exit' } as const,
  ]) {
    test(`replace → ${result.status}: the fence stays at replacing and cannot be abandoned (guard)`, async () => {
      const h = harness({ replace: () => result })
      const outcome = await replaceProjectGeneration({ admission: h.admission, ports: h.ports }, null)
      expect(outcome.status).toBe('unknown')
      expect(h.phases.observe).toEqual([])
      expect(h.admission.inspect(null)?.phase).toBe('replacing')
      const persisted = h.admission.maintenance.resume(h.admission.scopeFor(null))!
      expect(persisted.phase).toBe('replacing')
      expect(await h.admission.maintenance.abandon(persisted)).toBe(false)
      expect(h.admission.inspect(null)?.phase).toBe('replacing')
    })
  }

  test('an attestation failure keeps the fence at attesting (guard)', async () => {
    const h = harness({ observe: (g) => observationFor(g, { toolSurface: 'Read,Bash' }) })
    const outcome = await replaceProjectGeneration({ admission: h.admission, ports: h.ports }, null)
    expect(outcome.status).toBe('attestation-failed')
    expect(h.admission.inspect(null)?.phase).toBe('attesting')
  })
})

describe('the attestation table', () => {
  const expected: AttestationExpectation = { sessionId: OLD.sessionId, priorChildGeneration: 'gen-old', generation: 3, toolSurface: SURFACE, toolBridge: true }

  test('the all-true observation attests (control)', () => {
    expect(attestReplacement(observationFor(3), expected)).toEqual({ ok: true })
  })

  const cases: Array<[string, ReplacementObservation | undefined, string]> = [
    ['absent observation', undefined, 'no fulfilled pooled replacement'],
    ['wrong conversation', observationFor(3, { sessionId: 'other' }), 'did not resume the same conversation'],
    ['same child generation', observationFor(3, { childGeneration: 'gen-old' }), 'same child generation'],
    ['stale generation', observationFor(3, { admissionGeneration: 2 }), 'is not the fence generation'],
    ['surface missing the subagent tool', observationFor(3, { toolSurface: 'Read,Bash', registry: { sessionId: OLD.sessionId, admission_generation: 3, tool_surface: 'Read,Bash', tool_bridge: true } }), 'does not carry Agent'],
    ['surface differing', observationFor(3, { toolSurface: 'Read,Agent', registry: { sessionId: OLD.sessionId, admission_generation: 3, tool_surface: 'Read,Agent', tool_bridge: true } }), 'tool surface differs'],
    ['bridge differing', observationFor(3, { toolBridgeActive: false, registry: { sessionId: OLD.sessionId, admission_generation: 3, tool_surface: SURFACE, tool_bridge: false } }), 'tool bridge differs'],
    ['exited', observationFor(3, { exited: true }), 'has exited'],
    ['unidentified', observationFor(3, { identified: false }), 'not the pool\'s identified child'],
    ['registry absent', observationFor(3, { registry: undefined }), 'no durable registry row'],
    ['registry conversation disagrees', observationFor(3, { registry: { sessionId: 'x', admission_generation: 3, tool_surface: SURFACE, tool_bridge: true } }), 'registry row names a different conversation'],
    ['registry stamp disagrees', observationFor(3, { registry: { sessionId: OLD.sessionId, admission_generation: 2, tool_surface: SURFACE, tool_bridge: true } }), 'registry row is not stamped'],
    ['registry surface disagrees', observationFor(3, { registry: { sessionId: OLD.sessionId, admission_generation: 3, tool_surface: 'Read', tool_bridge: true } }), 'registry row tool surface disagrees'],
    ['registry bridge disagrees', observationFor(3, { registry: { sessionId: OLD.sessionId, admission_generation: 3, tool_surface: SURFACE, tool_bridge: false } }), 'registry row tool bridge disagrees'],
  ]
  for (const [name, observation, reason] of cases) {
    test(`${name} fails with that reason (guard)`, () => {
      const out = attestReplacement(observation, expected)
      expect(out.ok).toBe(false)
      expect(out.ok ? [] : out.reasons.some((r) => r.includes(reason))).toBe(true)
    })
  }
})

describe('restart continuity', () => {
  async function fencedAt(phase: 'draining' | 'replacing'): Promise<{ path: string; generation: number }> {
    const { path, db } = openDb()
    const first = admissionOver(db, 'boot-crashed')
    await first.generationFor(null)
    let fence = (await first.maintenance.beginMaintenance(first.scopeFor(null)))!
    while (fence.phase !== phase) fence = (await first.maintenance.advance(fence))!
    return { path, generation: fence.generation }
  }

  function restarted(path: string): ProjectAdmission {
    const db = ProjectDb.open(path)
    cleanup.push(() => db.close())
    return admissionOver(db, 'boot-restarted')
  }

  function restartPorts(admission: ProjectAdmission, parent: ParentSpec, observe?: (g: number) => ReplacementObservation): ProjectMaintenancePorts {
    return {
      census: async () => censusOf(admission, parent),
      replace: async () => { throw new Error('boot never replaces') },
      observe: () => (observe ?? observationFor)(admission.inspect(null)!.generation),
      identity: () => IDENTITY,
      expectedProfile: () => ({ toolSurface: SURFACE, toolBridge: true }),
    }
  }

  test('an open scope resumes as open', async () => {
    const { db } = openDb()
    const admission = admissionOver(db)
    expect(await resumeProjectMaintenance({ admission, ports: restartPorts(admission, {}) }, null)).toEqual({ status: 'open' })
  })

  test('a draining fence a crash left behind is abandoned and admission reopens (control)', async () => {
    const { path } = await fencedAt('draining')
    const admission = restarted(path)
    expect(await resumeProjectMaintenance({ admission, ports: restartPorts(admission, 'absent') }, null)).toEqual({ status: 'abandoned', phase: 'draining' })
    expect(admission.inspect(null)?.phase).toBe('open')
  })

  test('a replacing fence whose replacement is live at the fence generation attests and reopens (control)', async () => {
    const { path, generation } = await fencedAt('replacing')
    const admission = restarted(path)
    const outcome = await resumeProjectMaintenance({ admission, ports: restartPorts(admission, { admissionGeneration: generation, childGeneration: 'gen-new' }) }, null)
    expect(outcome).toEqual({ status: 'reopened', generation })
    expect(admission.inspect(null)?.phase).toBe('open')
  })

  test('a replacing fence with no replacement parent is HELD, never reopened blind (guard)', async () => {
    const { path } = await fencedAt('replacing')
    const admission = restarted(path)
    const outcome = await resumeProjectMaintenance({ admission, ports: restartPorts(admission, 'absent') }, null)
    expect(outcome).toMatchObject({ status: 'held', phase: 'replacing' })
    expect(admission.inspect(null)?.phase).toBe('replacing')
  })

  test('a replacing fence whose live parent is the OLD generation is held (guard)', async () => {
    const { path } = await fencedAt('replacing')
    const admission = restarted(path)
    const outcome = await resumeProjectMaintenance({ admission, ports: restartPorts(admission, { admissionGeneration: 0 }) }, null)
    expect(outcome.status).toBe('held')
    expect(admission.inspect(null)?.phase).toBe('replacing')
  })

  test('a replacement that fails attestation at restart is held at attesting (guard)', async () => {
    const { path, generation } = await fencedAt('replacing')
    const admission = restarted(path)
    const outcome = await resumeProjectMaintenance({
      admission,
      ports: restartPorts(admission, { admissionGeneration: generation }, (g) => observationFor(g, { registry: undefined })),
    }, null)
    expect(outcome).toMatchObject({ status: 'held', phase: 'attesting' })
    expect(admission.inspect(null)?.phase).toBe('attesting')
  })
})
