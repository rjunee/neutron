/**
 * RC2 — nexus-emit tests.
 *
 * Covers the emitter side of the agent-nexus log:
 *   - the pure event builders (handoff / decision / learning) — actor/kind/
 *     refs/body shape + pointers-lean truncation
 *   - `emitNexusEvent` fire-and-forget append against a REAL on-disk NexusStore
 *     (no mock past the seam): the produced events round-trip through the store,
 *     and a rejecting append is swallowed (never throws into the producer).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NexusStore, type AgentNexusEvent } from '../nexus-store.ts'
import {
  emitNexusEvent,
  emitTridentTerminalEvents,
  reflectionLearningEvent,
  tridentDecisionEvent,
  tridentHandoffEvent,
  type TridentTerminalRun,
} from '../nexus-emit.ts'

/* ─── pure builders ───────────────────────────────────────────────── */

describe('event builders', () => {
  it('tridentHandoffEvent — orchestrator/handoff with run + pr refs', () => {
    const e = tridentHandoffEvent({
      slug: 'add-thing',
      task: 'Add a thing',
      verdict: 'APPROVE',
      round: 2,
      pr: 42,
    })
    expect(e.actor_kind).toBe('orchestrator')
    expect(e.kind).toBe('handoff')
    expect(e.actor_id).toBe('add-thing')
    expect(e.body).toContain('APPROVE')
    expect(e.body).toContain('round 2')
    expect(e.refs).toEqual([
      { kind: 'run', ref: 'add-thing' },
      { kind: 'pr', ref: '#42' },
    ])
  })

  it('tridentHandoffEvent — null verdict + no pr → no-verdict, run ref only', () => {
    const e = tridentHandoffEvent({ slug: 's', task: 't', verdict: null, round: 3, pr: null })
    expect(e.body).toContain('no-verdict')
    expect(e.refs).toEqual([{ kind: 'run', ref: 's' }])
  })

  it('tridentDecisionEvent — argus/decision carries verdict + note', () => {
    const e = tridentDecisionEvent({
      slug: 'add-thing',
      task: 'Add a thing',
      verdict: 'REQUEST_CHANGES',
      note: 'inner loop exhausted 3 round(s)',
      pr: 7,
    })
    expect(e.actor_kind).toBe('argus')
    expect(e.kind).toBe('decision')
    expect(e.body).toContain('REQUEST_CHANGES')
    expect(e.body).toContain('inner loop exhausted 3 round(s)')
    expect(e.refs).toEqual([
      { kind: 'run', ref: 'add-thing' },
      { kind: 'pr', ref: '#7' },
    ])
  })

  it('reflectionLearningEvent — reflection/learning, id actor, no refs', () => {
    const e = reflectionLearningEvent({
      id: 'corr-1',
      right: 'always use tabs',
      why: 'the repo is tab-indented',
    })
    expect(e.actor_kind).toBe('reflection')
    expect(e.kind).toBe('learning')
    expect(e.actor_id).toBe('corr-1')
    expect(e.body).toContain('always use tabs')
    expect(e.body).toContain('the repo is tab-indented')
    expect(e.refs).toBeNull()
  })

  it('keeps bodies pointers-lean — a huge task title is truncated with an ellipsis', () => {
    const e = tridentHandoffEvent({
      slug: 's',
      task: 'x'.repeat(50_000),
      verdict: 'APPROVE',
      round: 1,
    })
    // Well within the store's 8 KB body cap, and elided.
    expect(e.body.length).toBeLessThan(2048)
    expect(e.body).toContain('…')
  })
})

/* ─── fire-and-forget append against a REAL store ─────────────────── */

interface Harness {
  store: NexusStore
  tmp: string
  cleanup(): void
}

function startStore(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-nexus-emit-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  const store = new NexusStore({ owner_home })
  return {
    store,
    tmp,
    cleanup: () => {
      store.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function waitForEvents(
  store: NexusStore,
  project_id: string,
  atLeast: number,
): Promise<AgentNexusEvent[]> {
  for (let i = 0; i < 200; i++) {
    const rows = await store.readRecent(project_id, { limit: 100 })
    if (rows.length >= atLeast) return rows
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${atLeast} nexus event(s)`)
}

describe('emitNexusEvent', () => {
  let h: Harness
  beforeEach(() => {
    h = startStore()
  })
  afterEach(() => {
    h.cleanup()
  })

  it('returns void immediately and lands the built events in the project nexus', async () => {
    const r = emitNexusEvent(
      h.store,
      'proj-a',
      tridentHandoffEvent({ slug: 'run-1', task: 'Add a thing', verdict: 'APPROVE', round: 1, pr: 9 }),
    )
    expect(r).toBeUndefined()
    emitNexusEvent(
      h.store,
      'proj-a',
      tridentDecisionEvent({ slug: 'run-1', task: 'Add a thing', verdict: 'APPROVE', note: 'round 1', pr: 9 }),
    )
    emitNexusEvent(
      h.store,
      'proj-a',
      reflectionLearningEvent({ id: 'c1', right: 'use tabs', why: 'repo convention' }),
    )

    const rows = await waitForEvents(h.store, 'proj-a', 3)
    const byKind = new Map(rows.map((e) => [e.kind, e]))
    expect(byKind.get('handoff')?.actor_kind).toBe('orchestrator')
    expect(byKind.get('decision')?.actor_kind).toBe('argus')
    expect(byKind.get('learning')?.actor_kind).toBe('reflection')
    // refs round-tripped through the store's serializer.
    expect(byKind.get('handoff')?.refs_json).toContain('run-1')
    expect(byKind.get('handoff')?.refs_json).toContain('#9')
  })

  it('scopes events by project_id — a different project never sees them', async () => {
    emitNexusEvent(
      h.store,
      'proj-a',
      reflectionLearningEvent({ id: 'c1', right: 'x' }),
    )
    await waitForEvents(h.store, 'proj-a', 1)
    const other = await h.store.readRecent('proj-b', { limit: 100 })
    expect(other).toEqual([])
  })

  it('swallows a rejecting append (bad project_id) — never throws into the producer', async () => {
    const warns: string[] = []
    // `..` is a rejected project_id (escapes the per-project root) → appendEvent
    // rejects; the fire-and-forget wrapper must catch it and only log.
    expect(() =>
      emitNexusEvent(
        h.store,
        '..',
        reflectionLearningEvent({ id: 'c1', right: 'x' }),
        { warn: (m) => warns.push(m) },
      ),
    ).not.toThrow()
    // Give the rejection a tick to be caught.
    await new Promise((r) => setTimeout(r, 20))
    expect(warns.length).toBe(1)
    expect(warns[0]).toContain('append failed')
  })
})

/* ─── the trident terminal producer (post-commit) ─────────────────── */

function terminalRun(over: Partial<TridentTerminalRun> = {}): TridentTerminalRun {
  return {
    slug: 'add-thing',
    task: 'Add a thing',
    project_slug: 'proj-a',
    inner_verdict: 'APPROVE',
    inner_checkpoint: 'argus-approved',
    round: 2,
    pr: 42,
    failure_reason: null,
    ...over,
  }
}

describe('emitTridentTerminalEvents', () => {
  let h: Harness
  beforeEach(() => {
    h = startStore()
  })
  afterEach(() => {
    h.cleanup()
  })

  it('AWAITS its appends → events are durable the instant it resolves (no polling)', async () => {
    await emitTridentTerminalEvents(h.store, terminalRun(), { harvested: true })
    // Read IMMEDIATELY — the durable producer awaited the writes before
    // resolving, so a graceful drain can never lose them.
    const rows = await h.store.readRecent('proj-a', { limit: 100 })
    const byKind = new Map(rows.map((e) => [e.kind, e]))
    expect(byKind.get('handoff')?.actor_kind).toBe('orchestrator')
    expect(byKind.get('handoff')?.refs_json).toContain('#42')
    const decision = byKind.get('decision')
    expect(decision?.actor_kind).toBe('argus')
    expect(decision?.body).toContain('APPROVE')
    expect(decision?.refs_json).toContain('#42')
  })

  it('a genuine APPROVE whose committed checkpoint was OVERWRITTEN to a non-argus value (e.g. "merging") STILL emits the decision', async () => {
    // Trust boundary: `applyResult` overwrites `inner_checkpoint` with the
    // loosely-parsed `result.checkpoint` on APPROVE→done, so the committed value
    // can be anything. `inner_verdict === 'APPROVE'` is the reliable provenance
    // (the server gate forces any un-backed APPROVE to REQUEST_CHANGES).
    await emitTridentTerminalEvents(
      h.store,
      terminalRun({ inner_verdict: 'APPROVE', inner_checkpoint: 'merging' }),
      { harvested: true },
    )
    const rows = await h.store.readRecent('proj-a', { limit: 100 })
    const decision = rows.find((e) => e.kind === 'decision')
    expect(decision?.actor_kind).toBe('argus')
    expect(decision?.body).toContain('APPROVE')
  })

  it('a REQUEST_CHANGES with a non-argus checkpoint (inner-error) emits NO decision (no argus verdict)', async () => {
    await emitTridentTerminalEvents(
      h.store,
      terminalRun({ inner_verdict: 'REQUEST_CHANGES', inner_checkpoint: 'inner-error', pr: null }),
      { harvested: true },
    )
    const rows = await h.store.readRecent('proj-a', { limit: 100 })
    expect(rows.map((e) => e.kind)).toEqual(['handoff'])
  })

  it('exhausted REQUEST_CHANGES (argus reviewed): decision REQUEST_CHANGES with the failure reason', async () => {
    await emitTridentTerminalEvents(
      h.store,
      terminalRun({
        inner_verdict: 'REQUEST_CHANGES',
        inner_checkpoint: 'argus-request-changes',
        pr: null,
        failure_reason: 'inner loop exhausted 3 round(s) without Argus APPROVE',
      }),
      { harvested: true },
    )
    const rows = await h.store.readRecent('proj-a', { limit: 100 })
    const decision = rows.find((e) => e.kind === 'decision')
    expect(decision?.actor_kind).toBe('argus')
    expect(decision?.body).toContain('REQUEST_CHANGES')
    expect(decision?.body).toContain('inner loop exhausted 3 round(s)')
    expect(decision?.body).not.toContain(': APPROVE')
  })

  it('a pre-verdict failure (inner-error, NO argus checkpoint): handoff only, NO fabricated argus decision', async () => {
    await emitTridentTerminalEvents(
      h.store,
      terminalRun({
        inner_verdict: 'REQUEST_CHANGES',
        inner_checkpoint: 'inner-error',
        pr: null,
        failure_reason: 'inner workflow crashed before review',
      }),
      { harvested: true },
    )
    const rows = await h.store.readRecent('proj-a', { limit: 100 })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('handoff')
    expect(rows.some((e) => e.kind === 'decision')).toBe(false)
  })

  it('NOT a harvest (harvested=false) — even with an inner-written verdict, NOTHING is emitted', async () => {
    // The stopped / garbled / reaped case: the DETACHED inner workflow wrote
    // `inner_verdict` to the row before the outer loop could harvest, then the
    // outer transition was NOT a harvest. No handoff, no decision may be forged.
    await emitTridentTerminalEvents(
      h.store,
      terminalRun({ inner_verdict: 'APPROVE', inner_checkpoint: 'argus-approved' }),
      { harvested: false },
    )
    expect(await h.store.readRecent('proj-a', { limit: 100 })).toEqual([])
  })

  it('a reaped run with no verdict (harvested=false): NOTHING is emitted', async () => {
    await emitTridentTerminalEvents(
      h.store,
      terminalRun({ inner_verdict: null, inner_checkpoint: 'forge-done', pr: null }),
      { harvested: false },
    )
    expect(await h.store.readRecent('proj-a', { limit: 100 })).toEqual([])
  })
})

/* ─── terminal producer: durable-append failure isolation ─────────── */

/** A store whose `appendEvent` rejects for the given event kinds (fault
 *  injection at the store seam). Cast to `NexusStore` — the producer only ever
 *  calls `appendEvent`. */
function failingStore(failKinds: ReadonlySet<string>, attempted: string[]): NexusStore {
  return {
    async appendEvent(_project_id: string, input: { kind: string }): Promise<never> {
      attempted.push(input.kind)
      if (failKinds.has(input.kind)) throw new Error(`append failed: ${input.kind}`)
      return undefined as never
    },
  } as unknown as NexusStore
}

describe('emitTridentTerminalEvents — durable-append failure isolation', () => {
  const harvested = { harvested: true }

  it('BOTH appends fail → RESOLVES (never throws) and reports each via onErr', async () => {
    const attempted: string[] = []
    const warns: string[] = []
    const store = failingStore(new Set(['handoff', 'decision']), attempted)
    await expect(
      emitTridentTerminalEvents(
        store,
        {
          slug: 's',
          task: 't',
          project_slug: 'p',
          inner_verdict: 'APPROVE',
          inner_checkpoint: 'argus-approved',
          round: 1,
          pr: 1,
          failure_reason: null,
        },
        harvested,
        { warn: (m) => warns.push(m) },
      ),
    ).resolves.toBeUndefined()
    // Both were attempted (a failed handoff does NOT abort the decision)…
    expect(attempted).toEqual(['handoff', 'decision'])
    // …and both failures were reported.
    expect(warns.length).toBe(2)
    expect(warns[0]).toContain('kind=handoff')
    expect(warns[1]).toContain('kind=decision')
  })

  it('PARTIAL write (handoff ok, decision fails) → resolves, only the decision failure is reported', async () => {
    const attempted: string[] = []
    const warns: string[] = []
    const store = failingStore(new Set(['decision']), attempted)
    await emitTridentTerminalEvents(
      store,
      {
        slug: 's',
        task: 't',
        project_slug: 'p',
        inner_verdict: 'REQUEST_CHANGES',
        inner_checkpoint: 'argus-request-changes',
        round: 2,
        pr: null,
        failure_reason: 'exhausted',
      },
      harvested,
      { warn: (m) => warns.push(m) },
    )
    expect(attempted).toEqual(['handoff', 'decision'])
    expect(warns.length).toBe(1)
    expect(warns[0]).toContain('kind=decision')
  })

  it('a failing store still never throws when NO onErr sink is supplied (falls back to the logger)', async () => {
    const store = failingStore(new Set(['handoff', 'decision']), [])
    await expect(
      emitTridentTerminalEvents(
        store,
        {
          slug: 's',
          task: 't',
          project_slug: 'p',
          inner_verdict: 'APPROVE',
          inner_checkpoint: 'argus-approved',
          round: 1,
          pr: 1,
          failure_reason: null,
        },
        harvested,
      ),
    ).resolves.toBeUndefined()
  })
})
