/**
 * @neutronai/trident — Ralph build-mode tests (Trident v2).
 *
 * Ralph DETECTION (`detectRalphMode`) is unchanged: a `/code` against a governed
 * repo (a `SPEC.md` at the git root) or an explicit flag sets `run.ralph`. What
 * CHANGED in v2: the one-task-per-fresh-context BUILD now lives INSIDE the inner
 * CC Dynamic Workflow (`inner-workflow.mjs` RALPH_NOTE), not the per-phase
 * orchestrator graph. So the orchestrator's only Ralph job is to THREAD
 * `run.ralph` through to the inner loop; the workflow does the governed build.
 * (The inlined RALPH_NOTE is asserted in inner-workflow.test.ts; the
 * fail-loud REMAINING_TASKS guards remain unit-tested in state-machine.test.ts /
 * vajra-fixes.test.ts FIX 7.)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import { detectRalphMode, defaultRalphModeProbe, type HostCommandResult } from './git-mode.ts'
import type { InnerLoopInput, InnerLoopResult } from './inner-loop.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore } from './store.ts'
import { TridentTickLoop } from './tick.ts'

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

describe('detectRalphMode', () => {
  const hostReturning = (root: string) => async (cmd: string[]): Promise<HostCommandResult> => {
    if (cmd.includes('rev-parse')) return ok(root)
    return ok()
  }

  test('explicit flag forces Ralph even without a SPEC.md', async () => {
    const probe = defaultRalphModeProbe(hostReturning('/nope'), async () => false)
    expect(await detectRalphMode('/nope', probe, { explicit: true })).toBe(true)
  })

  test('governed repo (git root has SPEC.md) → Ralph', async () => {
    const probe = defaultRalphModeProbe(hostReturning('/root'), async (p) => p === '/root/SPEC.md')
    expect(await detectRalphMode('/root/sub', probe)).toBe(true)
  })

  test('ungoverned repo (no SPEC.md) → legacy single-context', async () => {
    const probe = defaultRalphModeProbe(hostReturning('/root'), async () => false)
    expect(await detectRalphMode('/root', probe)).toBe(false)
  })

  test('a throwing probe degrades to legacy (never errors run creation)', async () => {
    const probe = defaultRalphModeProbe(hostReturning('/root'), async () => {
      throw new Error('fs exploded')
    })
    expect(await detectRalphMode('/root', probe)).toBe(false)
  })
})

describe('Ralph mode threads through to the inner loop', () => {
  let tmp: string
  let db: ProjectDb
  let store: TridentRunStore

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-ralph-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    store = new TridentRunStore(db)
  })
  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('a governed run launches the inner loop with run.ralph === true', async () => {
    const inputs: InnerLoopInput[] = []
    const inner_loop = async (input: InnerLoopInput): Promise<InnerLoopResult> => {
      inputs.push(input)
      return { status: 'completed', verdict: 'APPROVE', pr_number: 5, branch: 'feat-governed', round: 1, checkpoint: 'argus-approved', raw: '' }
    }
    const orch = buildTridentOrchestrator({
      inner_loop,
      db_path: join(tmp, 'project.db'),
      run_host: async () => ok(),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
    })
    const loop = new TridentTickLoop({ store, step: orch.step })
    const run = await store.create({
      slug: 'govern-it',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'Make the code match SPEC.md',
      branch: 'feat-governed',
      ralph: true,
      merge_mode: 'pr',
    })

    for (let i = 0; i < 10; i++) {
      await loop.runOnce()
      await orch.drain()
      const r = store.get(run.id)
      if (r !== null && isTerminalPhase(r.phase)) break
    }

    expect(store.get(run.id)?.phase).toBe('done')
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.run.ralph).toBe(true)
  })

  // Keeps a stray reference so `writeFileSync` import (used by other governed
  // fixtures historically) doesn't dangle in a future edit.
  test('default probe against a real temp dir with SPEC.md detects governed', async () => {
    writeFileSync(join(tmp, 'SPEC.md'), '# spec')
    const probe = defaultRalphModeProbe(async () => ok(''))
    expect(await detectRalphMode(tmp, probe)).toBe(true)
  })
})
