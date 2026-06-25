/**
 * Ported from Nova `gateway/tests/post-spawn-assertion.test.ts`. The polled-
 * budget, first-stage-to-fail-returns structure is the lifted Nova logic; the
 * tmux-window/pane-pid stages are swapped for child-alive → channel-handshake →
 * HTTP /health (the brief's CHECK SWAP). All probes are dep-injected.
 */

import { describe, it, expect } from 'bun:test'
import { assertReplAlive, type SpawnAssertionDeps } from '../post-spawn-assertion.ts'

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000
  return { now: () => t, advance: (ms) => { t += ms } }
}

const noSleep = async (): Promise<void> => {}

describe('assertReplAlive', () => {
  it('ok when child alive, handshake seen, /health responds', async () => {
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => 51234,
      hasHttpHealth: async () => true,
      sleep: noSleep,
      now: () => 1000,
    }
    const r = await assertReplAlive({ pid: 42 }, deps)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.pid).toBe(42)
      expect(r.channelPort).toBe(51234)
    }
  })

  it('dead-child when the child exits during boot', async () => {
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => false,
      getChannelPort: () => undefined,
      hasHttpHealth: async () => true,
      sleep: noSleep,
      now: () => 1000,
    }
    const r = await assertReplAlive({ pid: 42 }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('dead-child')
  })

  it('no-channel-ready when the handshake never lands within the budget', async () => {
    const clock = fakeClock()
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => undefined,
      hasHttpHealth: async () => true,
      sleep: async () => clock.advance(300),
      now: clock.now,
    }
    const r = await assertReplAlive({ pid: 42 }, deps, { readyBudgetMs: 1000, readyIntervalMs: 250 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no-channel-ready')
  })

  it('handshake landing mid-poll still succeeds', async () => {
    const clock = fakeClock()
    let polls = 0
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => {
        polls += 1
        return polls >= 3 ? 40000 : undefined
      },
      hasHttpHealth: async () => true,
      sleep: async () => clock.advance(250),
      now: clock.now,
    }
    const r = await assertReplAlive({ pid: 7 }, deps, { readyBudgetMs: 5000, readyIntervalMs: 250 })
    expect(r.ok).toBe(true)
  })

  it('no-http-health when /health never responds within its budget', async () => {
    const clock = fakeClock()
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => 40000,
      hasHttpHealth: async () => false,
      sleep: async () => clock.advance(600),
      now: clock.now,
    }
    const r = await assertReplAlive({ pid: 7 }, deps, { healthBudgetMs: 1000, healthIntervalMs: 500 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no-http-health')
  })

  // ── Stage 4: channel-MCP-unwired wedge (port row #6) ──────────────────────

  it('channel-wedged when the unwired signature persists past the confirm grace after health-up', async () => {
    const clock = fakeClock()
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => 40000,
      hasHttpHealth: async () => true,
      // The MCP never bound — every reply attempt prints the unwired error.
      readRingFresh: () => '⎿ Error: no MCP server configured with that name',
      sleep: async () => clock.advance(300),
      now: clock.now,
    }
    const r = await assertReplAlive({ pid: 7 }, deps, {
      channelWedgeGraceMs: 1000,
      channelWedgeIntervalMs: 250,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('channel-wedged')
  })

  it('re-reads the ring ONLY AFTER /health is up (invariant §7 ordering)', async () => {
    const clock = fakeClock()
    let healthOk = false
    let ringReadBeforeHealth = false
    let ringReads = 0
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => 40000,
      hasHttpHealth: async () => {
        // Health flips true on the 2nd poll; the ring must NOT have been read yet.
        const wasOk = healthOk
        healthOk = true
        return wasOk
      },
      readRingFresh: () => {
        ringReads += 1
        if (!healthOk) ringReadBeforeHealth = true
        return '⎿ Error: no MCP server configured with that name'
      },
      sleep: async () => clock.advance(300),
      now: clock.now,
    }
    const r = await assertReplAlive({ pid: 7 }, deps, {
      healthBudgetMs: 5000,
      healthIntervalMs: 300,
      channelWedgeGraceMs: 1000,
      channelWedgeIntervalMs: 250,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('channel-wedged')
    expect(ringReadBeforeHealth).toBe(false) // NEVER read the ring pre-health
    expect(ringReads).toBeGreaterThan(0) // but it DID read after health-up
  })

  it('does NOT fire on a healthy bound channel (clean ring after health-up)', async () => {
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => 51234,
      hasHttpHealth: async () => true,
      readRingFresh: () => '⏺ reply("done")\n⎿ ok\n',
      sleep: async () => {},
      now: () => 1000,
    }
    const r = await assertReplAlive({ pid: 42 }, deps)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.channelPort).toBe(51234)
  })

  it('does NOT fire when the phrase only appears doc-quoted (backticks) in the ring', async () => {
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => 51234,
      hasHttpHealth: async () => true,
      // A quotation of the phrase — not a live error frame — must not fast-fail.
      readRingFresh: () =>
        'note: the wedge prints `no MCP server configured with that name`',
      sleep: async () => {},
      now: () => 1000,
    }
    const r = await assertReplAlive({ pid: 42 }, deps)
    expect(r.ok).toBe(true)
  })

  it('treats a null/failed ring re-capture as NOT-unwired (glitch must not fast-fail)', async () => {
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => 51234,
      hasHttpHealth: async () => true,
      readRingFresh: () => null,
      sleep: async () => {},
      now: () => 1000,
    }
    const r = await assertReplAlive({ pid: 42 }, deps)
    expect(r.ok).toBe(true)
  })

  it('skips Stage 4 entirely when no ring reader is wired (back-compat)', async () => {
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => 51234,
      hasHttpHealth: async () => true,
      // readRingFresh omitted
      sleep: async () => {},
      now: () => 1000,
    }
    const r = await assertReplAlive({ pid: 42 }, deps)
    expect(r.ok).toBe(true)
  })

  it('a transient unwired frame that clears within grace still succeeds', async () => {
    const clock = fakeClock()
    let reads = 0
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => 40000,
      hasHttpHealth: async () => true,
      readRingFresh: () => {
        reads += 1
        // First read: a mid-render unwired frame; then it binds and clears.
        return reads <= 1 ? 'no MCP server configured with that name' : '⎿ ok'
      },
      sleep: async () => clock.advance(250),
      now: clock.now,
    }
    const r = await assertReplAlive({ pid: 7 }, deps, {
      channelWedgeGraceMs: 2000,
      channelWedgeIntervalMs: 250,
    })
    expect(r.ok).toBe(true)
  })
})
