/**
 * @neutronai/onboarding/synthesis — Step 2 mandatory behavior tests.
 *
 * Per the trident brief (`/tmp/trident-onboarding-step2-synthesis.md` §
 * "Tests") + the design (`onboarding-single-session-architecture-2026-06-17.md`
 * § Acceptance). These are BEHAVIOR tests (not phase-machine bookkeeping) per
 * CLAUDE.md "Spec is the source of truth":
 *
 *   1. Synthesis substrate factory constructed exactly ONCE for a multi-
 *      conversation import (NOT per-chunk).
 *   2. NO `/clear` emitted on the synthesis / onboarding path.
 *   3. The interview emits >= 1 question grounded in imported content.
 *   4. No-import path: synthesis stands up >= 1 project from interview answers.
 *   5. Per-project seed files (STATUS.md + history + a routed transcript) are
 *      written for a detected project.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Substrate, AgentSpec } from '../../../runtime/substrate.ts'
import type { Event } from '../../../runtime/events.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'
import type { ConversationRecord } from '../../history-import/types.ts'
import {
  runDeterministicPrepass,
  BATCH_TARGET_CONVERSATIONS_DEFAULT,
  BATCH_SUMMARY_TOKEN_BUDGET_DEFAULT,
} from '../prepass.ts'
import {
  runImportSynthesis,
  runInterviewOnlySynthesis,
  drainWithHeartbeat,
  FORBIDDEN_CONTEXT_RESET,
} from '../synthesis-session.ts'
import { buildInformedQuestion, buildInformedQuestionQueue } from '../informed-interview.ts'
import { writeProjectSeed } from '../seed-writer.ts'
import { MemoryRawTranscriptStore } from '../raw-store.ts'
import { rawFilenameFor } from '../raw-store.ts'

// ── Fake substrate (counting factory) ───────────────────────────────────────

interface FakeFactory {
  factory: () => Substrate
  stats: { constructions: number }
  dispatched: string[]
}

/**
 * A counting substrate factory. `responder(prompt)` returns the canned
 * assistant JSON for each turn; the factory counts constructions and records
 * every dispatched prompt so the tests can assert factory-once + no-/clear.
 */
function makeCountingFactory(responder: (prompt: string) => string): FakeFactory {
  const stats = { constructions: 0 }
  const dispatched: string[] = []
  const factory = (): Substrate => {
    stats.constructions += 1
    const substrate: Substrate = {
      start(spec: AgentSpec): SessionHandle {
        dispatched.push(spec.prompt)
        const body = responder(spec.prompt)
        const events = (async function* (): AsyncGenerator<Event, void, void> {
          if (body.length > 0) yield { kind: 'token', text: body }
          yield {
            kind: 'completion',
            usage: { input_tokens: 10, output_tokens: 10 },
            substrate_instance_id: 'fake-synthesis',
          }
        })()
        return {
          events,
          respondToTool: async () => undefined,
          cancel: async () => undefined,
          tool_resolution: 'internal',
        }
      },
    }
    return substrate
  }
  return { factory, stats, dispatched }
}

/** Extract `id=<...>` conversation ids the read prompt listed in this batch. */
function idsInPrompt(prompt: string): string[] {
  const out: string[] = []
  const re = /id=(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(prompt)) !== null) {
    if (m[1] !== undefined) out.push(m[1])
  }
  return out
}

/**
 * Import responder: routes every conversation in a read pass to a single
 * "Apollo launch" project; consolidation returns a grounded summary.
 */
function importResponder(prompt: string): string {
  if (prompt.includes('read pass')) {
    const routing = idsInPrompt(prompt).map((id) => ({
      conversation_id: id,
      project_slugs: ['apollo-launch'],
    }))
    return JSON.stringify({
      projects: [
        {
          slug: 'apollo-launch',
          name: 'Apollo launch',
          status: 'launching in 3 weeks',
          overview: 'Skincare brand launch with compliance review under way.',
          open_threads: ['Finish FDA compliance pass with Sam'],
        },
      ],
      people: ['Sam'],
      routing,
    })
  }
  if (prompt.includes('accumulated model')) {
    return JSON.stringify({
      summary: 'You are launching Apollo with Sam handling compliance.',
      style: { tone: 'terse', verbosity: 'low', structure_pref: 'bullets' },
      tasks: ['Submit FDA paperwork'],
      open_threads: ['Compliance sign-off'],
    })
  }
  return '{}'
}

async function* asIterable(records: ReadonlyArray<ConversationRecord>): AsyncIterable<ConversationRecord> {
  for (const r of records) yield r
}

function sampleRecords(): ConversationRecord[] {
  return [
    {
      conversation_id: 'conv-apollo-1',
      title: 'Apollo packaging',
      created_at: Date.parse('2026-05-01T00:00:00Z'),
      messages: [
        { role: 'user', text: 'Working on the Apollo launch packaging and compliance with Sam.' },
        { role: 'assistant', text: 'Got it, the compliance review is the long pole.' },
      ],
    },
    {
      conversation_id: 'conv-apollo-2',
      title: 'FDA compliance',
      created_at: Date.parse('2026-05-10T00:00:00Z'),
      messages: [
        { role: 'user', text: 'Need to finish the FDA compliance pass before the Apollo launch.' },
        { role: 'assistant', text: 'I can draft the checklist.' },
      ],
    },
  ]
}

const tmpDirs: string[] = []
function freshTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'synthesis-test-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// ── 1. Factory constructed exactly once ─────────────────────────────────────

describe('synthesis session — factory-once contract', () => {
  test('substrate factory is constructed exactly ONCE across a multi-conversation, multi-batch import', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const prepass = await runDeterministicPrepass(asIterable(sampleRecords()), {
      rawStore,
      // Force >1 read batch so a per-chunk regression (factory per batch) would
      // bump the construction count above 1.
      batch_target_conversations: 1,
    })
    expect(prepass.reading_batches.length).toBeGreaterThan(1)

    const fake = makeCountingFactory(importResponder)
    const result = await runImportSynthesis(
      { substrateFactory: fake.factory, rawStore, timeout_ms: 5000 },
      { prepass },
    )

    expect(result.factory_constructions).toBe(1)
    expect(fake.stats.constructions).toBe(1)
    // Reads happened across batches on the ONE session, plus a consolidation turn.
    expect(result.batches_read).toBe(prepass.reading_batches.length)
    expect(fake.dispatched.length).toBe(prepass.reading_batches.length + 1)
  })
})

// ── 1a. Small batches keep each read pass fast (2026-06-18 hang root-fix) ────

describe('prepass — SMALL read batches (synthesis-completes fix)', () => {
  test('default batch sizing is small enough that a read pass completes well under budget', () => {
    // The big batch (150 convos / 12 000 tokens) was the head of the production
    // hang cascade: one fat read pass > 90s → abandon-poison → cold respawn →
    // thrash → empty wow. Defaults must be small.
    expect(BATCH_TARGET_CONVERSATIONS_DEFAULT).toBeLessThanOrEqual(25)
    expect(BATCH_SUMMARY_TOKEN_BUDGET_DEFAULT).toBeLessThanOrEqual(4000)
  })

  test('a dense export yields MANY small passes, not a couple fat ones', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    // 60 conversations at the default batch size → at least 3 passes (60/25).
    const records: ConversationRecord[] = Array.from({ length: 60 }, (_, i) => ({
      conversation_id: `conv-${i}`,
      title: `Topic ${i}`,
      created_at: Date.parse('2026-05-01T00:00:00Z') + i * 1000,
      messages: [{ role: 'user' as const, text: `Working on topic ${i} with the team.` }],
    }))
    const prepass = await runDeterministicPrepass(asIterable(records), { rawStore })
    expect(prepass.reading_batches.length).toBeGreaterThanOrEqual(3)
    for (const b of prepass.reading_batches) {
      expect(b.conversation_ids.length).toBeLessThanOrEqual(BATCH_TARGET_CONVERSATIONS_DEFAULT)
    }
  })
})

// ── 1c. Timeout retry-once + pass counts (2026-06-18 synthesis-completes) ────

/**
 * A substrate whose Nth `start()` HANGS (never completes → the synthesis turn
 * budget fires) and all others return the given body. Lets a test prove the
 * read pass RETRIES once after a timeout instead of zeroing the synthesis.
 */
function makeHangOnNthFactory(
  hangCallIndex: number,
  responder: (prompt: string) => string,
): FakeFactory {
  const stats = { constructions: 0 }
  const dispatched: string[] = []
  let calls = 0
  const factory = (): Substrate => {
    stats.constructions += 1
    const substrate: Substrate = {
      start(spec: AgentSpec): SessionHandle {
        calls += 1
        dispatched.push(spec.prompt)
        const hang = calls === hangCallIndex
        const body = responder(spec.prompt)
        const events = (async function* (): AsyncGenerator<Event, void, void> {
          if (hang) {
            // Never settle — the dispatchTurn timeout wins, then cancel() fires.
            await new Promise<void>(() => {})
          }
          if (body.length > 0) yield { kind: 'token', text: body }
          yield {
            kind: 'completion',
            usage: { input_tokens: 5, output_tokens: 5 },
            substrate_instance_id: 'fake-hang',
          }
        })()
        return {
          events,
          respondToTool: async () => undefined,
          cancel: async () => undefined,
          tool_resolution: 'internal',
        }
      },
    }
    return substrate
  }
  return { factory, stats, dispatched }
}

describe('synthesis session — a timed-out read pass retries once', () => {
  test('first read pass hangs (times out) → retried once on the same session, synthesis still produces a project', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    // One batch so the first read-pass dispatch is call #1; retry is call #2.
    const prepass = await runDeterministicPrepass(asIterable(sampleRecords()), {
      rawStore,
      batch_target_conversations: 50,
    })
    expect(prepass.reading_batches.length).toBe(1)

    const fake = makeHangOnNthFactory(1, importResponder)
    const result = await runImportSynthesis(
      { substrateFactory: fake.factory, rawStore, timeout_ms: 80 },
      { prepass },
    )

    // Read pass: 1 attempted, retried after the hang, succeeded.
    expect(result.read_passes_attempted).toBe(1)
    expect(result.read_passes_succeeded).toBe(1)
    // The retry landed a real project (NOT the empty fallback).
    expect(result.user_model.projects.length).toBeGreaterThan(0)
    // calls: read(hang) + read(retry) + consolidate = 3 dispatches, ONE factory.
    expect(fake.stats.constructions).toBe(1)
    expect(fake.dispatched.length).toBe(3)
  })

  test('happy path reports read_passes_attempted/succeeded equal to non-empty batches', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const prepass = await runDeterministicPrepass(asIterable(sampleRecords()), {
      rawStore,
      batch_target_conversations: 1,
    })
    const fake = makeCountingFactory(importResponder)
    const result = await runImportSynthesis(
      { substrateFactory: fake.factory, rawStore, timeout_ms: 5000 },
      { prepass },
    )
    expect(result.read_passes_attempted).toBe(prepass.reading_batches.length)
    expect(result.read_passes_succeeded).toBe(prepass.reading_batches.length)
  })

  test('every read pass hangs → 0 succeeded (the caller surfaces honest failure)', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const prepass = await runDeterministicPrepass(asIterable(sampleRecords()), {
      rawStore,
      batch_target_conversations: 50,
    })
    expect(prepass.reading_batches.length).toBe(1)
    // ALL dispatches hang (read + retry + consolidate) → every turn times out.
    let constructions = 0
    const alwaysHang = (): Substrate => {
      constructions += 1
      return {
        start(): SessionHandle {
          const events = (async function* (): AsyncGenerator<Event, void, void> {
            await new Promise<void>(() => {})
          })()
          return {
            events,
            respondToTool: async () => undefined,
            cancel: async () => undefined,
            tool_resolution: 'internal',
          }
        },
      }
    }
    const result = await runImportSynthesis(
      { substrateFactory: alwaysHang, rawStore, timeout_ms: 50 },
      { prepass },
    )
    expect(constructions).toBe(1)
    expect(result.read_passes_attempted).toBeGreaterThan(0)
    expect(result.read_passes_succeeded).toBe(0)
    expect(result.user_model.projects.length).toBe(0)
  })
})

// ── 1d. Stream-activity HEARTBEAT wedge-detector (2026-06-18, owner-requested) ─

/**
 * A factory whose every `start()` turn emits `preTicks` heartbeat events
 * (`status`, no text) spaced `tickGapMs` apart, THEN the responder JSON body as
 * one token, then completion. Used to prove a turn that keeps streaming past the
 * idle window is NOT aborted (the heartbeat resets idle on every event).
 */
function makeHeartbeatFactory(
  responder: (prompt: string) => string,
  opts: { preTicks: number; tickGapMs: number },
): FakeFactory {
  const stats = { constructions: 0 }
  const dispatched: string[] = []
  const factory = (): Substrate => {
    stats.constructions += 1
    const substrate: Substrate = {
      start(spec: AgentSpec): SessionHandle {
        dispatched.push(spec.prompt)
        const body = responder(spec.prompt)
        const events = (async function* (): AsyncGenerator<Event, void, void> {
          for (let i = 0; i < opts.preTicks; i += 1) {
            await Bun.sleep(opts.tickGapMs)
            yield { kind: 'status', message: 'working' }
          }
          if (body.length > 0) yield { kind: 'token', text: body }
          yield {
            kind: 'completion',
            usage: { input_tokens: 5, output_tokens: 5 },
            substrate_instance_id: 'fake-heartbeat',
          }
        })()
        return {
          events,
          respondToTool: async () => undefined,
          cancel: async () => undefined,
          tool_resolution: 'internal',
        }
      },
    }
    return substrate
  }
  return { factory, stats, dispatched }
}

/**
 * A factory whose every `start()` turn STREAMS a heartbeat event forever
 * (`status` every `tickGapMs`) and NEVER completes — used to prove the absolute
 * ceiling still backstops a turn that dodges the idle window indefinitely.
 */
function makeForeverStreamFactory(tickGapMs: number): FakeFactory {
  const stats = { constructions: 0 }
  const dispatched: string[] = []
  const factory = (): Substrate => {
    stats.constructions += 1
    const substrate: Substrate = {
      start(spec: AgentSpec): SessionHandle {
        dispatched.push(spec.prompt)
        const events = (async function* (): AsyncGenerator<Event, void, void> {
          for (;;) {
            await Bun.sleep(tickGapMs)
            yield { kind: 'status', message: 'working' }
          }
        })()
        return {
          events,
          respondToTool: async () => undefined,
          cancel: async () => undefined,
          tool_resolution: 'internal',
        }
      },
    }
    return substrate
  }
  return { factory, stats, dispatched }
}

/** A factory whose every `start()` turn emits NOTHING and hangs forever. */
function alwaysHangFactory(): () => Substrate {
  return (): Substrate => ({
    start(): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        await new Promise<void>(() => {})
      })()
      return {
        events,
        respondToTool: async () => undefined,
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  })
}

describe('synthesis session — stream-activity heartbeat wedge-detector', () => {
  test('a turn that keeps streaming PAST the idle window is NOT aborted (heartbeat keeps it alive)', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const prepass = await runDeterministicPrepass(asIterable(sampleRecords()), {
      rawStore,
      batch_target_conversations: 50,
    })
    expect(prepass.reading_batches.length).toBe(1)

    // 8 heartbeats × 40ms = ~320ms of activity BEFORE the body lands — far longer
    // than the 150ms idle window. A FIXED total cap of 150ms (the old behavior)
    // would have killed this turn at 150ms; the heartbeat resets idle on each
    // 40ms event so the turn streams to completion.
    const fake = makeHeartbeatFactory(importResponder, { preTicks: 8, tickGapMs: 40 })
    const result = await runImportSynthesis(
      {
        substrateFactory: fake.factory,
        rawStore,
        idle_timeout_ms: 150,
        timeout_ms: 10000, // generous absolute ceiling — never the cause here
      },
      { prepass },
    )

    expect(result.read_passes_attempted).toBe(1)
    expect(result.read_passes_succeeded).toBe(1)
    expect(result.user_model.projects.length).toBeGreaterThan(0)
    // No retry happened: read + consolidate = exactly 2 dispatches on ONE session.
    expect(fake.stats.constructions).toBe(1)
    expect(fake.dispatched.length).toBe(2)
  })

  test('a turn with ZERO stream activity for the idle window IS aborted — fast, before the ceiling', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const prepass = await runDeterministicPrepass(asIterable(sampleRecords()), {
      rawStore,
      batch_target_conversations: 50,
    })
    expect(prepass.reading_batches.length).toBe(1)

    // Every turn emits nothing and hangs. idle=60ms catches it; the ceiling is
    // huge (10s), so if the idle-heartbeat were NOT the detector this test would
    // run ~10s+ and blow the test budget. It finishes in well under a second.
    const start = Date.now()
    const result = await runImportSynthesis(
      {
        substrateFactory: alwaysHangFactory(),
        rawStore,
        idle_timeout_ms: 60,
        timeout_ms: 10000,
      },
      { prepass },
    )
    const elapsed = Date.now() - start

    expect(result.read_passes_attempted).toBeGreaterThan(0)
    expect(result.read_passes_succeeded).toBe(0)
    expect(result.user_model.projects.length).toBe(0)
    // Idle (60ms), not the ceiling (10000ms), caught the wedge: read + retry +
    // consolidate + its retry ≈ 4 × ~60ms ≪ the ceiling.
    expect(elapsed).toBeLessThan(3000)
  })

  test('the absolute ceiling still backstops a turn that streams forever (dodges the idle window)', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const prepass = await runDeterministicPrepass(asIterable(sampleRecords()), {
      rawStore,
      batch_target_conversations: 50,
    })
    expect(prepass.reading_batches.length).toBe(1)

    // A status event every 20ms forever → the idle window (10s) NEVER fires, so
    // ONLY the absolute ceiling (200ms) can stop it. Proves the backstop.
    const start = Date.now()
    const result = await runImportSynthesis(
      {
        substrateFactory: makeForeverStreamFactory(20).factory,
        rawStore,
        idle_timeout_ms: 10000, // never fires — activity every 20ms
        timeout_ms: 200, // the only thing that can abort a forever-stream
      },
      { prepass },
    )
    const elapsed = Date.now() - start

    expect(result.read_passes_succeeded).toBe(0)
    expect(result.user_model.projects.length).toBe(0)
    // The ceiling (200ms) caught it well before the idle window (10000ms) could.
    expect(elapsed).toBeLessThan(10000)
  })
})

// ── 1e. CHILD-LIVENESS probe (2026-06-18 owner-dogfood false-wedge fix) ──────

/** A stream that emits NOTHING and never ends (a silent, in-flight turn). */
function silentForeverStream(): AsyncIterable<Event> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Event, void, void> {
      await new Promise<void>(() => {})
    },
  }
}

/** A stream silent for `silentMs`, then the body token + completion. */
function silentThenStream(body: string, silentMs: number): AsyncIterable<Event> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Event, void, void> {
      await Bun.sleep(silentMs)
      yield { kind: 'token', text: body }
      yield {
        kind: 'completion',
        usage: { input_tokens: 1, output_tokens: 1 },
        substrate_instance_id: 'fake-silent',
      }
    },
  }
}

describe('drainWithHeartbeat — child-liveness defeats the time-to-first-token false wedge', () => {
  test('a SILENT turn whose child stays ALIVE past the idle window is NOT wedged (only the ceiling stops it)', async () => {
    // The exact production failure: zero stream events for longer than the idle
    // window. With isAlive()=true the drain must treat the silence as liveness, NOT
    // a wedge — so it survives multiple idle windows and only the absolute ceiling
    // can stop a forever-silent-but-alive turn.
    const start = Date.now()
    const res = await drainWithHeartbeat(silentForeverStream(), {
      idleMs: 50,
      ceilingMs: 300,
      isAlive: () => true,
    })
    const elapsed = Date.now() - start
    expect(res.reason).toBe('ceiling') // NOT 'idle' — liveness defeated the false wedge
    expect(elapsed).toBeGreaterThanOrEqual(250) // survived several idle windows
  })

  test('a SILENT turn whose child EXITS is wedged FAST at the idle window (true hang)', async () => {
    let alive = true
    setTimeout(() => {
      alive = false
    }, 60)
    const start = Date.now()
    const res = await drainWithHeartbeat(silentForeverStream(), {
      idleMs: 40,
      ceilingMs: 10000,
      isAlive: () => alive,
    })
    const elapsed = Date.now() - start
    expect(res.reason).toBe('idle')
    expect(elapsed).toBeLessThan(2000) // idle wedge, not the 10s ceiling
  })

  test('with NO isAlive probe a silent turn wedges at the idle window (back-compat)', async () => {
    const res = await drainWithHeartbeat(silentForeverStream(), { idleMs: 40, ceilingMs: 5000 })
    expect(res.reason).toBe('idle')
  })

  test('a turn that reads SILENTLY past the idle window then streams completes (alive child)', async () => {
    const res = await drainWithHeartbeat(silentThenStream('hello', 120), {
      idleMs: 50,
      ceilingMs: 5000,
      isAlive: () => true,
    })
    expect(res.reason).toBe('done')
    expect(res.text).toBe('hello')
  })
})

/**
 * A factory whose every `start()` turn reads SILENTLY (zero events) for
 * `silentMs` then streams the responder body — and whose handle exposes
 * `isAlive: () => true`. Proves an import where every pass is silent-then-streams
 * completes (the child-liveness probe defeats the false wedge) instead of
 * `pass1_all_failed`.
 */
function makeSilentThenStreamFactory(
  responder: (prompt: string) => string,
  opts: { silentMs: number },
): FakeFactory {
  const stats = { constructions: 0 }
  const dispatched: string[] = []
  const factory = (): Substrate => {
    stats.constructions += 1
    const substrate: Substrate = {
      start(spec: AgentSpec): SessionHandle {
        dispatched.push(spec.prompt)
        const body = responder(spec.prompt)
        const events = silentThenStream(body, opts.silentMs)
        return {
          events,
          respondToTool: async () => undefined,
          cancel: async () => undefined,
          tool_resolution: 'internal',
          // The substrate-superset liveness probe the drain reads structurally.
          isAlive: () => true,
        } as SessionHandle
      },
    }
    return substrate
  }
  return { factory, stats, dispatched }
}

describe('synthesis import — silent-then-streams read passes complete via child-liveness', () => {
  test('every read pass reads SILENTLY past the idle window yet the import completes (NOT pass1_all_failed)', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const prepass = await runDeterministicPrepass(asIterable(sampleRecords()), {
      rawStore,
      batch_target_conversations: 50,
    })
    expect(prepass.reading_batches.length).toBe(1)

    // Each pass is silent for 120ms — longer than the 50ms idle window. Without the
    // child-liveness probe this would false-wedge every pass (the live failure:
    // 100% of passes wedged → pass1_all_failed). isAlive()=true defeats it.
    const fake = makeSilentThenStreamFactory(importResponder, { silentMs: 120 })
    const result = await runImportSynthesis(
      { substrateFactory: fake.factory, rawStore, idle_timeout_ms: 50, timeout_ms: 10000 },
      { prepass },
    )

    expect(result.read_passes_succeeded).toBeGreaterThan(0)
    expect(result.user_model.projects.length).toBeGreaterThan(0)
    // Consolidation pass ran on the same session → a non-empty user-model summary.
    expect(result.user_model.summary.length).toBeGreaterThan(0)
    // No retry/respawn churn: read + consolidate = 2 dispatches on ONE session.
    expect(fake.stats.constructions).toBe(1)
    expect(fake.dispatched.length).toBe(2)
  })
})

// ── 1b. Progress advances across read passes (2026-06-18 hang fix) ──────────

describe('synthesis session — onProgress advances per read pass', () => {
  test('emits (0,total) up-front then a strictly non-decreasing done reaching total', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const prepass = await runDeterministicPrepass(asIterable(sampleRecords()), {
      rawStore,
      batch_target_conversations: 1,
    })
    const total = prepass.reading_batches.length
    expect(total).toBeGreaterThan(1)

    const fake = makeCountingFactory(importResponder)
    const ticks: Array<{ done: number; total: number }> = []
    const result = await runImportSynthesis(
      {
        substrateFactory: fake.factory,
        rawStore,
        timeout_ms: 5000,
        onProgress: (done, t) => ticks.push({ done, total: t }),
      },
      { prepass },
    )

    // First tick is the known-denominator (0, total) so the bar is never stuck at
    // known=false; subsequent ticks advance to total.
    expect(ticks.length).toBeGreaterThanOrEqual(2)
    expect(ticks[0]).toEqual({ done: 0, total })
    for (let i = 1; i < ticks.length; i += 1) {
      expect(ticks[i]!.total).toBe(total)
      expect(ticks[i]!.done).toBeGreaterThanOrEqual(ticks[i - 1]!.done)
    }
    expect(ticks[ticks.length - 1]!.done).toBe(total)
    // A real (mocked) synthesis ran — NOT the empty fallback.
    expect(result.batches_read).toBe(total)
    expect(result.user_model.projects.length).toBeGreaterThan(0)
  })
})

// ── 2. No /clear on the synthesis path ──────────────────────────────────────

describe('synthesis session — never emits /clear', () => {
  test('no dispatched prompt contains the context-reset command', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const prepass = await runDeterministicPrepass(asIterable(sampleRecords()), {
      rawStore,
      batch_target_conversations: 1,
    })
    const fake = makeCountingFactory(importResponder)
    await runImportSynthesis(
      { substrateFactory: fake.factory, rawStore, timeout_ms: 5000 },
      { prepass },
    )
    expect(fake.dispatched.length).toBeGreaterThan(0)
    for (const prompt of fake.dispatched) {
      expect(prompt).not.toContain(FORBIDDEN_CONTEXT_RESET)
    }
  })
})

// ── 3. Informed question grounded in imported content ───────────────────────

describe('informed interview — grounded in imported content', () => {
  test('emits at least one question that references an imported project', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const prepass = await runDeterministicPrepass(asIterable(sampleRecords()), { rawStore })
    const fake = makeCountingFactory(importResponder)
    const result = await runImportSynthesis(
      { substrateFactory: fake.factory, rawStore, timeout_ms: 5000 },
      { prepass },
    )

    const q = buildInformedQuestion(result.user_model)
    expect(q).not.toBeNull()
    // Grounded in the imported project name + a real person from the model.
    expect(q?.text).toContain('Apollo launch')
    expect(q?.references_person).toBe(true)
    expect(q?.text).toContain('Sam')
    expect(q?.project_slug).toBe('apollo-launch')

    const queue = buildInformedQuestionQueue(result.user_model)
    expect(queue.length).toBeGreaterThanOrEqual(1)
  })

  test('returns null for an empty model (caller falls back to a generic question)', () => {
    const q = buildInformedQuestion({
      summary: '',
      projects: [],
      people: [],
      open_threads: [],
      tasks: [],
      style: {},
    })
    expect(q).toBeNull()
  })
})

// ── 4. No-import path stands up >= 1 project ────────────────────────────────

describe('no-import path — interview-only still produces a project', () => {
  test('synthesis stands up >= 1 project from interview answers (model returned one)', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const responder = (prompt: string): string => {
      if (prompt.includes('No chat history was imported')) {
        return JSON.stringify({
          projects: [
            {
              slug: 'pottery-studio',
              name: 'Pottery studio',
              status: 'active',
              overview: 'Opening a community pottery studio downtown.',
              open_threads: ['Sign the lease'],
            },
          ],
          people: [],
          summary: 'You are opening a pottery studio.',
          style: { tone: 'neutral' },
          tasks: ['Sign the lease'],
          open_threads: ['Lease'],
        })
      }
      return '{}'
    }
    const fake = makeCountingFactory(responder)
    const result = await runInterviewOnlySynthesis(
      { substrateFactory: fake.factory, rawStore, timeout_ms: 5000 },
      {
        answers: [
          { prompt: 'What are you working on?', answer: 'Opening a pottery studio downtown.' },
        ],
      },
    )
    expect(result.source).toBe('interview')
    expect(result.factory_constructions).toBe(1)
    expect(result.user_model.projects.length).toBeGreaterThanOrEqual(1)
    expect(result.project_seeds.length).toBeGreaterThanOrEqual(1)
    expect(result.project_seeds[0]?.slug).toBe('pottery-studio')
  })

  test('guarantees a project even when the model returns none (deterministic fallback)', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    // Responder returns NO projects — the no-dead-end contract must still
    // synthesize one from the answers.
    const fake = makeCountingFactory(() => JSON.stringify({ projects: [], summary: '' }))
    const result = await runInterviewOnlySynthesis(
      { substrateFactory: fake.factory, rawStore, timeout_ms: 5000 },
      {
        answers: [
          { prompt: 'What are you working on?', answer: 'Building a SaaS billing tool for agencies.' },
        ],
      },
    )
    expect(result.user_model.projects.length).toBeGreaterThanOrEqual(1)
    expect(result.project_seeds.length).toBeGreaterThanOrEqual(1)
  })
})

// ── 5. Per-project seed files written ───────────────────────────────────────

describe('seed-writer — per-project seed files', () => {
  test('writes STATUS.md + history doc + a routed raw transcript for a detected project', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const prepass = await runDeterministicPrepass(asIterable(sampleRecords()), { rawStore })
    const fake = makeCountingFactory(importResponder)
    const result = await runImportSynthesis(
      { substrateFactory: fake.factory, rawStore, timeout_ms: 5000 },
      { prepass },
    )

    const seed = result.project_seeds.find((s) => s.slug === 'apollo-launch')
    expect(seed).toBeDefined()
    expect(seed!.conversation_ids.length).toBeGreaterThanOrEqual(1)

    const ownerHome = freshTmp()
    const signalsById = new Map(prepass.conversations.map((c) => [c.conversation_id, c]))
    const outcome = writeProjectSeed(
      { owner_home: ownerHome, rawStore, now: () => Date.parse('2026-06-17T00:00:00Z'), signalsById },
      seed!,
    )
    expect(outcome.reason).toBe('created')

    const projectRoot = join(ownerHome, 'Projects', 'apollo-launch')
    // STATUS.md with the § 4 frontmatter.
    const statusPath = join(projectRoot, 'STATUS.md')
    expect(existsSync(statusPath)).toBe(true)
    const status = readFileSync(statusPath, 'utf8')
    expect(status).toContain('name: apollo-launch')
    expect(status).toContain('last_updated:')
    expect(status).toContain('Apollo launch')

    // History doc.
    expect(existsSync(join(projectRoot, 'docs', 'history.md'))).toBe(true)

    // At least one routed raw transcript under research/transcripts/.
    expect(outcome.transcripts_written).toBeGreaterThanOrEqual(1)
    const firstConv = seed!.conversation_ids[0]!
    const transcriptPath = join(projectRoot, 'research', 'transcripts', rawFilenameFor(firstConv))
    expect(existsSync(transcriptPath)).toBe(true)
    expect(readFileSync(transcriptPath, 'utf8').length).toBeGreaterThan(0)
  })

  test('is idempotent — a second write is a no-op (never clobbers user edits)', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    rawStore.put('c1', 'USER: hello')
    const ownerHome = freshTmp()
    const seed = {
      slug: 'demo',
      name: 'Demo',
      status: 'active',
      overview: 'A demo project.',
      open_threads: [],
      conversation_ids: ['c1'],
    }
    const deps = { owner_home: ownerHome, rawStore, now: () => 0 }
    const first = writeProjectSeed(deps, seed)
    expect(first.reason).toBe('created')
    const second = writeProjectSeed(deps, seed)
    expect(second.reason).toBe('already_seeded')
    expect(second.docs_written.length).toBe(0)
  })
})

// ── Pre-pass determinism (no LLM) ───────────────────────────────────────────

describe('deterministic pre-pass — no LLM', () => {
  test('persists raw transcripts, sorts by recency, and surfaces top terms', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const prepass = await runDeterministicPrepass(asIterable(sampleRecords()), { rawStore })
    expect(prepass.total_conversations).toBe(2)
    // Most-recent first.
    expect(prepass.conversations[0]?.conversation_id).toBe('conv-apollo-2')
    // Raw transcripts retained on disk (the per-project corpus).
    expect(rawStore.has('conv-apollo-1')).toBe(true)
    expect(rawStore.get('conv-apollo-1')).toContain('Apollo')
    // "apollo" should be a top term.
    expect(prepass.top_terms.some((t) => t.term === 'apollo')).toBe(true)
  })
})
