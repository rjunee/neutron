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

  // ── Stage 4: channel-MCP-bound gate (port row #6) ─────────────────────────
  // Gates on the dev-channel's `/channel-bound` signal (claude's MCP handshake),
  // NOT the always-present "no MCP server configured" TUI warning (the removed
  // false-positive). A working channel posts /channel-bound; a genuine no-bind
  // wedge never does.

  it('channel-wedged when /channel-bound never arrives within the budget', async () => {
    const clock = fakeClock()
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => 40000,
      hasHttpHealth: async () => true,
      // claude never completed the MCP handshake → no /channel-bound, ever.
      isChannelBound: () => false,
      sleep: async () => clock.advance(300),
      now: clock.now,
    }
    const r = await assertReplAlive({ pid: 7 }, deps, {
      channelBoundBudgetMs: 1000,
      channelBoundIntervalMs: 250,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('channel-wedged')
  })

  it('does NOT fire on a healthy channel that posts /channel-bound', async () => {
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => 51234,
      hasHttpHealth: async () => true,
      isChannelBound: () => true,
      sleep: async () => {},
      now: () => 1000,
    }
    const r = await assertReplAlive({ pid: 42 }, deps)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.channelPort).toBe(51234)
  })

  it('/channel-bound landing mid-poll still succeeds', async () => {
    const clock = fakeClock()
    let polls = 0
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => 40000,
      hasHttpHealth: async () => true,
      isChannelBound: () => {
        polls += 1
        return polls >= 3 // handshake completes a few polls after /health
      },
      sleep: async () => clock.advance(250),
      now: clock.now,
    }
    const r = await assertReplAlive({ pid: 7 }, deps, {
      channelBoundBudgetMs: 5000,
      channelBoundIntervalMs: 250,
    })
    expect(r.ok).toBe(true)
  })

  it('dead-child during the Stage-4 bind wait fails fast', async () => {
    const clock = fakeClock()
    let alive = true
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => alive,
      getChannelPort: () => 40000,
      hasHttpHealth: async () => true,
      isChannelBound: () => {
        alive = false // child dies while we wait for the handshake
        return false
      },
      sleep: async () => clock.advance(250),
      now: clock.now,
    }
    const r = await assertReplAlive({ pid: 7 }, deps, { channelBoundBudgetMs: 5000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('dead-child')
  })

  it('skips Stage 4 entirely when no bind probe is wired (back-compat)', async () => {
    const deps: SpawnAssertionDeps = {
      isChildAlive: () => true,
      getChannelPort: () => 51234,
      hasHttpHealth: async () => true,
      // isChannelBound omitted
      sleep: async () => {},
      now: () => 1000,
    }
    const r = await assertReplAlive({ pid: 42 }, deps)
    expect(r.ok).toBe(true)
  })
})
