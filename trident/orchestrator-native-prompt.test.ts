import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import type { HostCommandResult } from './git-mode.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import {
  TridentSessionManager,
  type TridentDispatch,
  type TridentDispatchInput,
} from './session.ts'
import { TridentRunStore } from './store.ts'

/**
 * REGRESSION GUARD (PR #14 Argus BLOCKING #1/#2).
 *
 * The Forge→Argus build loop MUST keep running on its NATIVE,
 * parser-locked contract — Forge emits `PR_NUMBER=`/`BRANCH=`/`WORKTREE=`
 * (consumed by `parseForgeOutput`/`recordCompletion`); Argus emits
 * `APPROVE` / `REQUEST CHANGES` (consumed by `parseArgusVerdict`).
 *
 * A prior change re-pointed the build loop's SYSTEM prompt at the
 * cross-runtime legacy `prompts/{forge,argus}.md` files — which mandate a
 * DIFFERENT operating model (`/forge/delivered`, `/argus/delivered`,
 * `/codex:review`, gateway-token auth, inline buttons). Under that prompt
 * Forge would POST to `/forge/delivered` instead of emitting the contract
 * lines → `recordCompletion` marks the run crashed; Argus output would be
 * unparseable → `parseArgusVerdict` fail-safe-defaults to REQUEST_CHANGES,
 * flipping verdicts / spinning the fix loop.
 *
 * These tests assert BEHAVIOR, not just wiring: (a) the dispatched system
 * prompt is the bare native label and neither the system NOR the user turn
 * carries the legacy `/…/delivered` operating model; (b) the native
 * contract the orchestrator hands the agent actually round-trips through
 * the session parsers (PR meta captured / APPROVE → approved).
 */

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-native-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

/** A dispatch that records every input and replies on the NATIVE contract. */
function recordingDispatch(): {
  dispatch: TridentDispatch
  calls: TridentDispatchInput[]
} {
  const calls: TridentDispatchInput[] = []
  const dispatch: TridentDispatch = async (input) => {
    calls.push(input)
    if (input.kind === 'forge') {
      // Forge replies the way the NATIVE contract instructs.
      return {
        result: 'built it\nPR_NUMBER=7\nBRANCH=feat-x\nWORKTREE=/repo',
        status: 'completed',
      }
    }
    // Argus replies the way the NATIVE contract instructs.
    return { result: 'APPROVE', status: 'completed' }
  }
  return { dispatch, calls }
}

/** Substrings that ONLY appear in the legacy cross-runtime prompt model. */
const LEGACY_OPERATING_MODEL = ['/forge/delivered', '/argus/delivered', '/codex:review']

describe('build loop keeps its NATIVE parser-locked contract (not the legacy .md model)', () => {
  test('forge-init dispatches the bare `forge` system label + native PR contract', async () => {
    const { dispatch, calls } = recordingDispatch()
    const session = new TridentSessionManager({ dispatch })
    const { step } = buildTridentOrchestrator({
      session,
      run_host: async () => ok(),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
    })

    const run = await store.create({
      slug: 's',
      project_slug: 't',
      repo_path: '/repo',
      task: 'do it',
      branch: 'feat-x',
    })
    await step({ ...run, phase: 'forge-init' })
    await session.drain()

    const forgeCall = calls.find((c) => c.kind === 'forge')
    expect(forgeCall).toBeDefined()
    // (a) The SYSTEM prompt is the bare native label — NOT loaded .md content.
    expect(forgeCall!.system).toBe('forge')
    // The native execution contract rides the user turn…
    expect(forgeCall!.user_message).toContain('PR_NUMBER=')
    expect(forgeCall!.user_message).toContain('BRANCH=')
    expect(forgeCall!.user_message).toContain('WORKTREE=')
    expect(forgeCall!.user_message).toContain('do it')
    // …and the legacy `/forge/delivered` operating model never reaches the
    // agent (neither the system prompt nor the user turn).
    for (const legacy of LEGACY_OPERATING_MODEL) {
      expect(forgeCall!.system).not.toContain(legacy)
      expect(forgeCall!.user_message).not.toContain(legacy)
    }
  })

  test('forge native output round-trips through the parser (PR meta captured, not crashed)', async () => {
    const { dispatch } = recordingDispatch()
    const session = new TridentSessionManager({ dispatch })
    const { step } = buildTridentOrchestrator({
      session,
      run_host: async () => ok(),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
    })
    const run = await store.create({
      slug: 's',
      project_slug: 't',
      repo_path: '/repo',
      task: 'do it',
      branch: 'feat-x',
    })
    // Spawn forge-init, let it complete, then poll/transition.
    const spawned = await step({ ...run, phase: 'forge-init' })
    await session.drain()
    const advanced = await step(spawned.run)

    // The native PR_NUMBER=/BRANCH=/WORKTREE= contract parsed cleanly — the
    // run advanced OFF forge-init (it was NOT marked crashed for "emitted no
    // contract lines", which is what the legacy /forge/delivered model causes).
    expect(advanced.run.phase).not.toBe('forge-init')
    expect(advanced.run.phase).not.toBe('failed')
    const meta = session.forgeMetaFor(run.id)
    expect(meta).not.toBeNull()
    expect(meta!.pr).toBe(7)
    expect(meta!.branch).toBe('feat-x')
  })

  test('argus dispatches the bare `argus` system label + native verdict contract', async () => {
    const { dispatch, calls } = recordingDispatch()
    const session = new TridentSessionManager({ dispatch })
    const { step } = buildTridentOrchestrator({
      session,
      run_host: async (cmd) => (cmd.includes('--numstat') ? ok('1\t1\tf.ts') : ok()),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
    })

    const run = await store.create({
      slug: 's',
      project_slug: 't',
      repo_path: '/repo',
      task: 'do it',
      branch: 'feat-x',
    })
    await step({ ...run, phase: 'argus', pr: 7 })
    await session.drain()

    const argusCall = calls.find((c) => c.kind === 'argus')
    expect(argusCall).toBeDefined()
    // (a) The SYSTEM prompt is the bare native label — NOT loaded .md content.
    expect(argusCall!.system).toBe('argus')
    // The native verdict contract rides the user turn…
    expect(argusCall!.user_message).toContain('APPROVE')
    expect(argusCall!.user_message).toContain('REQUEST CHANGES')
    // …and the legacy `/argus/delivered` + cross-model-wrapper operating model
    // never reaches the agent.
    for (const legacy of LEGACY_OPERATING_MODEL) {
      expect(argusCall!.system).not.toContain(legacy)
      expect(argusCall!.user_message).not.toContain(legacy)
    }
  })

  test('argus native APPROVE round-trips through parseArgusVerdict (verdict honoured, not flipped)', async () => {
    const { dispatch } = recordingDispatch()
    const session = new TridentSessionManager({ dispatch })
    const { step } = buildTridentOrchestrator({
      session,
      run_host: async (cmd) => (cmd.includes('--numstat') ? ok('1\t1\tf.ts') : ok()),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
    })
    const run = await store.create({
      slug: 's',
      project_slug: 't',
      repo_path: '/repo',
      task: 'do it',
      branch: 'feat-x',
    })
    const spawned = await step({ ...run, phase: 'argus', pr: 7, branch: 'feat-x' })
    await session.drain()
    const advanced = await step(spawned.run)

    // A native `APPROVE` parsed as APPROVE → the run advanced to `done`
    // (merge). Under the legacy prompt the bare "APPROVE" would be buried in
    // an unparseable /argus/delivered payload and fail-safe to REQUEST_CHANGES,
    // sending the run back to forge-fix instead.
    expect(advanced.changed).toBe(true)
    expect(advanced.run.phase).toBe('done')
  })
})
