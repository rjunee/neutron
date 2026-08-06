import { describe, expect, test } from 'bun:test'

import { MAX_CONCURRENT_SUBAGENTS, SubagentRegistry, type AgentKind } from './registry.ts'
import { spawnSubagent } from './spawn.ts'

/**
 * Concurrency cap — ONE lane over every live subagent row.
 *
 * This file used to pin a SECOND, isolated `ritual` lane against its own
 * `MAX_CONCURRENT_RITUALS` ceiling. ISSUES #504 deleted the ritual spawn path (a
 * ritual is now a reminder composed on the owner's own warm session and never
 * becomes a subagent), so that lane had no population left to count and went with
 * it. What remains — and what must not regress — is that ONE cap governs every
 * kind, and that a terminal row frees its slot.
 */

const verify = async () => {
  throw new Error('top-level spawns carry no delegation token')
}

/** Spawn `n` top-level records of `kind`, each with a distinct run_id. */
async function fill(
  registry: SubagentRegistry,
  kind: AgentKind,
  n: number,
  prefix: string,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    // eslint-disable-next-line no-await-in-loop
    await spawnSubagent(
      { instance_key: 'inst', agent_kind: kind },
      { registry, verify_delegation: verify, mint_run_id: () => `${prefix}-${i}` },
    )
  }
}

describe('subagent concurrency cap', () => {
  test('the cap counts EVERY live row, whatever its kind', async () => {
    const registry = new SubagentRegistry()
    await fill(registry, 'forge', 4, 'forge')
    await fill(registry, 'atlas', 4, 'atlas')
    expect(registry.live()).toHaveLength(MAX_CONCURRENT_SUBAGENTS)

    await expect(
      spawnSubagent(
        { instance_key: 'inst', agent_kind: 'forge' },
        { registry, verify_delegation: verify, mint_run_id: () => 'forge-extra' },
      ),
    ).rejects.toThrow(/global concurrency cap hit \(8\/8\)/)
    // The refused spawn minted no record.
    expect(registry.byRunId('forge-extra')).toBeUndefined()
  })

  test('a terminal row frees its slot', async () => {
    const registry = new SubagentRegistry()
    await fill(registry, 'forge', MAX_CONCURRENT_SUBAGENTS, 'forge')
    await registry.updateTerminal('forge-0', { status: 'finished', ended_at: Date.now() })
    const fresh = await spawnSubagent(
      { instance_key: 'inst', agent_kind: 'forge' },
      { registry, verify_delegation: verify, mint_run_id: () => 'forge-next' },
    )
    expect(fresh.run_id).toBe('forge-next')
  })
})
