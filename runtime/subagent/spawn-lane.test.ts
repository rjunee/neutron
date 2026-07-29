import { describe, expect, test } from 'bun:test'

import {
  MAX_CONCURRENT_RITUALS,
  MAX_CONCURRENT_SUBAGENTS,
  SubagentRegistry,
  type AgentKind,
} from './registry.ts'
import { spawnSubagent } from './spawn.ts'

/**
 * Concurrency LANE isolation (executor-mode reminders, plan task 4). A ritual
 * (`agent_kind === 'ritual'`) counts ONLY against `MAX_CONCURRENT_RITUALS`; every
 * other kind counts ONLY against `MAX_CONCURRENT_SUBAGENTS`. The two populations
 * are counted separately, so neither lane can starve the other — a ritual pileup
 * caps at 2 while interactive dispatch keeps its full 8, and 8 live forge agents
 * never block a ritual.
 */

const verify = async () => {
  throw new Error('top-level spawns carry no delegation token')
}

/** Spawn `n` top-level records of `kind`, each with a distinct run_id. */
async function fill(registry: SubagentRegistry, kind: AgentKind, n: number, prefix: string): Promise<void> {
  for (let i = 0; i < n; i++) {
    // eslint-disable-next-line no-await-in-loop
    await spawnSubagent(
      { instance_key: 'inst', agent_kind: kind },
      { registry, verify_delegation: verify, mint_run_id: () => `${prefix}-${i}` },
    )
  }
}

describe('ritual concurrency lane', () => {
  test('a ritual spawns even with the NON-ritual lane full (8 live forge)', async () => {
    const registry = new SubagentRegistry()
    await fill(registry, 'forge', MAX_CONCURRENT_SUBAGENTS, 'forge')
    expect(registry.live()).toHaveLength(8)

    const ritual = await spawnSubagent(
      { instance_key: 'inst', agent_kind: 'ritual' },
      { registry, verify_delegation: verify, mint_run_id: () => 'ritual-0' },
    )
    expect(ritual.agent_kind).toBe('ritual')
    // The ritual joined its OWN lane — the forge cap did NOT block it.
    expect(registry.live()).toHaveLength(9)
  })

  test('the 3rd concurrent ritual is refused (lane cap 2) while 2 rituals are live', async () => {
    const registry = new SubagentRegistry()
    await fill(registry, 'ritual', MAX_CONCURRENT_RITUALS, 'ritual')
    expect(registry.live().filter((r) => r.agent_kind === 'ritual')).toHaveLength(2)

    await expect(
      spawnSubagent(
        { instance_key: 'inst', agent_kind: 'ritual' },
        { registry, verify_delegation: verify, mint_run_id: () => 'ritual-extra' },
      ),
    ).rejects.toThrow(/ritual lane cap hit \(2\/2\)/)
    // The refused spawn minted no record.
    expect(registry.byRunId('ritual-extra')).toBeUndefined()
  })

  test('live rituals do NOT count toward the non-ritual cap (2 rituals + 8 forge OK, 9th forge refused)', async () => {
    const registry = new SubagentRegistry()
    // 2 live rituals occupy the ritual lane.
    await fill(registry, 'ritual', 2, 'ritual')
    // 7 forge then an 8th forge — all fit the non-ritual lane (rituals excluded).
    await fill(registry, 'forge', 7, 'forge')
    const eighth = await spawnSubagent(
      { instance_key: 'inst', agent_kind: 'forge' },
      { registry, verify_delegation: verify, mint_run_id: () => 'forge-7' },
    )
    expect(eighth.agent_kind).toBe('forge')
    expect(registry.live().filter((r) => r.agent_kind !== 'ritual')).toHaveLength(8)

    // The 9th forge trips the non-ritual cap — proving the 2 rituals never
    // consumed any of the 8 interactive slots.
    await expect(
      spawnSubagent(
        { instance_key: 'inst', agent_kind: 'forge' },
        { registry, verify_delegation: verify, mint_run_id: () => 'forge-8' },
      ),
    ).rejects.toThrow(/global concurrency cap hit \(8\/8\)/)
  })

  test('a finished ritual frees its lane slot', async () => {
    const registry = new SubagentRegistry()
    await fill(registry, 'ritual', 2, 'ritual')
    // Drive one terminal → the lane drops to 1 live ritual, so a new one fits.
    await registry.updateTerminal('ritual-0', { status: 'finished', ended_at: Date.now() })
    const fresh = await spawnSubagent(
      { instance_key: 'inst', agent_kind: 'ritual' },
      { registry, verify_delegation: verify, mint_run_id: () => 'ritual-2' },
    )
    expect(fresh.run_id).toBe('ritual-2')
  })
})
