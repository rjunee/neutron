import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import type { DispatchAgentKind } from './agent-prompts.ts'
import type { HostCommandResult } from './git-mode.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import {
  TridentSessionManager,
  type TridentDispatch,
  type TridentDispatchInput,
} from './session.ts'
import { TridentRunStore } from './store.ts'

/**
 * The orchestrator is the ONLY place the Forge→Argus state machine spawns
 * sub-agents. Before this change it passed the literal kind label
 * (`system: 'forge'`) — the rich `prompts/<kind>.md` execution contract
 * never reached the agent. These tests pin that the orchestrator now loads
 * the agent's system prompt via the (injectable) loader and hands it to
 * the dispatch as `system` for BOTH the forge and argus phases.
 */

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-prompt-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

function recordingDispatch(): {
  dispatch: TridentDispatch
  calls: TridentDispatchInput[]
} {
  const calls: TridentDispatchInput[] = []
  const dispatch: TridentDispatch = async (input) => {
    calls.push(input)
    if (input.kind === 'forge') {
      return {
        result: 'built\nPR_NUMBER=7\nBRANCH=feat-x\nWORKTREE=/repo',
        status: 'completed',
      }
    }
    return { result: 'APPROVE', status: 'completed' }
  }
  return { dispatch, calls }
}

describe('orchestrator wires loaded prompt-file content into system', () => {
  test('forge-init dispatch carries the loaded forge system prompt (not the literal label)', async () => {
    const { dispatch, calls } = recordingDispatch()
    const session = new TridentSessionManager({ dispatch })
    const loaded: Record<DispatchAgentKind, string> = {
      forge: 'FORGE CONTRACT FROM prompts/forge.md',
      argus: 'ARGUS CONTRACT FROM prompts/argus.md',
      atlas: 'unused',
      sentinel: 'unused',
    }
    const { step } = buildTridentOrchestrator({
      session,
      run_host: async () => ok(),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
      agent_system_prompt: (kind) => loaded[kind],
    })

    const run = await store.create({
      slug: 's',
      project_slug: 't',
      repo_path: '/repo',
      task: 'do it',
      branch: 'feat-x',
    })
    // Spawn-if-needed → fires the forge-init dispatch in the background.
    await step({ ...run, phase: 'forge-init' })
    await session.drain()

    const forgeCall = calls.find((c) => c.kind === 'forge')
    expect(forgeCall).toBeDefined()
    expect(forgeCall!.system).toBe('FORGE CONTRACT FROM prompts/forge.md')
    expect(forgeCall!.system).not.toBe('forge')
    // The per-run task instructions still ride the user turn.
    expect(forgeCall!.user_message).toContain('do it')
  })

  test('argus dispatch carries the loaded argus system prompt', async () => {
    const { dispatch, calls } = recordingDispatch()
    const session = new TridentSessionManager({ dispatch })
    const { step } = buildTridentOrchestrator({
      session,
      run_host: async (cmd) => (cmd.includes('--numstat') ? ok('1\t1\tf.ts') : ok()),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
      agent_system_prompt: (kind) =>
        kind === 'argus' ? 'ARGUS CONTRACT FROM prompts/argus.md' : 'forge-sys',
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
    expect(argusCall!.system).toBe('ARGUS CONTRACT FROM prompts/argus.md')
    expect(argusCall!.system).not.toBe('argus')
  })

  test('default loader (no override) loads the REAL prompts/forge.md content', async () => {
    const { dispatch, calls } = recordingDispatch()
    const session = new TridentSessionManager({ dispatch })
    // No agent_system_prompt override → uses the real on-disk loader.
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
    // Proves the dead-code file is now live in the real spawn path.
    expect(forgeCall!.system).toContain('You are Forge')
    expect(forgeCall!.system).not.toContain('{{OWNER_HOME}}')
  })
})
