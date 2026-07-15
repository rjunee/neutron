/**
 * RC2 — the composer's trident terminal-observer ASSEMBLY
 * (`buildTridentTerminalObserver`, the exact builder `open/composer.ts` wires
 * into the tick loop's `on_run_terminal`). Proves, against a REAL NexusStore +
 * REAL `code_trident_runs` rows (no mock past the seam):
 *   - flag ON: a genuine committed harvest persists handoff + decision, scoped;
 *   - the outer-harvest gate holds through the assembly (a stopped row that only
 *     carries an inner-written verdict persists nothing);
 *   - flag OFF (nexus null): nothing persists, but the caller's observers run;
 *   - observers + the nexus producer are isolated (a throwing observer never
 *     suppresses the others).
 * Deleting the nexus wiring from the builder fails these.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { NexusStore } from '@neutronai/gateway/nexus/nexus-store.ts'
import { TridentRunStore, type TridentRun } from '@neutronai/trident/store.ts'
import { buildTridentTerminalObserver } from '../wiring/trident-nexus-observer.ts'

const VALID_RESULT = JSON.stringify({
  ok: true,
  verdict: 'APPROVE',
  pr_number: 42,
  branch: 'feat-x',
  round: 1,
  checkpoint: 'argus-approved',
})

let tmp: string
let db: ProjectDb
let store: TridentRunStore
let nexusHome: string
let nexus: NexusStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-nexus-obs-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
  nexusHome = mkdtempSync(join(tmpdir(), 'neutron-trident-nexus-obs-home-'))
  nexus = new NexusStore({ owner_home: nexusHome })
})
afterEach(() => {
  db.close()
  nexus.closeAll()
  rmSync(tmp, { recursive: true, force: true })
  rmSync(nexusHome, { recursive: true, force: true })
})

async function terminalRun(patch: Partial<TridentRun>): Promise<TridentRun> {
  const run = await store.create({
    slug: 'add-thing',
    project_slug: 't1',
    repo_path: '/repo',
    task: 'Add a thing',
    branch: 'feat-x',
  })
  await store.update(run.id, patch)
  const updated = store.get(run.id)
  if (updated === null) throw new Error('run vanished')
  return updated
}

describe('buildTridentTerminalObserver', () => {
  test('flag ON + a genuine harvest (done + parseable result) → handoff + decision persist, scoped, and the caller observer runs', async () => {
    const seen: string[] = []
    const observer = buildTridentTerminalObserver({
      nexus,
      observers: [async (r): Promise<void> => void seen.push(r.id)],
    })
    const run = await terminalRun({
      phase: 'done',
      inner_result: VALID_RESULT,
      inner_verdict: 'APPROVE',
      inner_checkpoint: 'argus-approved',
      pr: 42,
      harvested_at: 1000, // the outer loop harvested
    })

    await observer(run)

    expect(seen).toEqual([run.id]) // caller observer ran
    const rows = await nexus.readRecent('t1', { limit: 100 })
    const byKind = new Map(rows.map((e) => [e.kind, e]))
    expect(byKind.get('handoff')?.actor_kind).toBe('orchestrator')
    expect(byKind.get('decision')?.actor_kind).toBe('argus')
    expect(byKind.get('decision')?.body).toContain('APPROVE')
    // Durable already (the producer awaited) — a different project is empty.
    expect(await nexus.readRecent('other', { limit: 100 })).toEqual([])
  })

  test('a done row whose committed inner_checkpoint was overwritten to a non-argus value ("merging") STILL persists the argus decision', async () => {
    // Realistic committed shape: applyResult set `inner_checkpoint = result.checkpoint`.
    const observer = buildTridentTerminalObserver({ nexus, observers: [] })
    const run = await terminalRun({
      phase: 'done',
      inner_result: VALID_RESULT,
      inner_verdict: 'APPROVE',
      inner_checkpoint: 'merging', // NOT an argus checkpoint
      pr: 42,
      harvested_at: 1000,
    })
    await observer(run)
    const rows = await nexus.readRecent('t1', { limit: 100 })
    const byKind = new Map(rows.map((e) => [e.kind, e]))
    expect(byKind.get('handoff')?.actor_kind).toBe('orchestrator')
    expect(byKind.get('decision')?.actor_kind).toBe('argus')
    expect(byKind.get('decision')?.body).toContain('APPROVE')
  })

  test('the outer-harvest gate holds through the assembly: a STOPPED row with an inner-written verdict but no harvest marker persists NOTHING', async () => {
    const observer = buildTridentTerminalObserver({ nexus, observers: [] })
    const run = await terminalRun({
      phase: 'stopped',
      inner_result: VALID_RESULT, // inner wrote a result…
      inner_verdict: 'APPROVE', // …and a verdict, but the stop won before harvest
      inner_checkpoint: 'argus-approved',
      // NO harvested_at — the outer loop never harvested.
    })
    await observer(run)
    expect(await nexus.readRecent('t1', { limit: 100 })).toEqual([])
  })

  test('a FORCE-TERMINATE of a live run (real terminalTransition) with a stale parseable result + verdict emits ZERO nexus events', async () => {
    // The exact Issue-1 repro: a nonterminal run whose DETACHED inner workflow
    // already wrote a parseable inner_result + verdict, then an out-of-band
    // terminate flips it to `failed` WITHOUT the outer loop ever harvesting.
    const observer = buildTridentTerminalObserver({ nexus, observers: [] })
    const live = await store.create({
      slug: 'add-thing',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'Add a thing',
      branch: 'feat-x',
    })
    await store.update(live.id, {
      subagent_run_id: 'wf-live',
      subagent_status: 'running',
      inner_result: VALID_RESULT,
      inner_verdict: 'APPROVE',
      inner_checkpoint: 'argus-approved',
    })
    // The generic terminator's atomic write — phase + reason ONLY, never harvested_at.
    const { run: terminated, won } = await store.terminalTransition(live.id, {
      phase: 'failed',
      failure_reason: 'cancelled by owner',
    })
    expect(won).toBe(true)
    expect(terminated).not.toBeNull()
    expect(terminated!.harvested_at).toBeNull()

    await observer(terminated!)
    expect(await nexus.readRecent('t1', { limit: 100 })).toEqual([])
  })

  test('flag OFF (nexus null): nothing persists, but the caller observers still run', async () => {
    const seen: string[] = []
    const observer = buildTridentTerminalObserver({
      nexus: null,
      observers: [async (r): Promise<void> => void seen.push(r.id)],
    })
    const run = await terminalRun({
      phase: 'done',
      inner_result: VALID_RESULT,
      inner_verdict: 'APPROVE',
      inner_checkpoint: 'argus-approved',
      harvested_at: 1000,
    })
    await observer(run)
    expect(seen).toEqual([run.id])
    expect(await nexus.readRecent('t1', { limit: 100 })).toEqual([])
  })

  test('isolation: a throwing caller observer never suppresses the nexus producer', async () => {
    const observer = buildTridentTerminalObserver({
      nexus,
      observers: [
        async (): Promise<void> => {
          throw new Error('skill-forge blew up')
        },
      ],
    })
    const run = await terminalRun({
      phase: 'done',
      inner_result: VALID_RESULT,
      inner_verdict: 'APPROVE',
      inner_checkpoint: 'argus-approved',
      pr: 42,
      harvested_at: 1000, // the outer loop harvested
    })
    // Resolves despite the throw…
    await expect(observer(run)).resolves.toBeUndefined()
    // …and the nexus producer still ran.
    const rows = await nexus.readRecent('t1', { limit: 100 })
    expect(rows.some((e) => e.kind === 'handoff')).toBe(true)
  })
})
