/**
 * @neutronai/agent-dispatch — scheduleDispatchLifecycleWatchdog (F4).
 *
 * Proves the SCHEDULED subagent lifecycle watchdog (the piece that was never
 * scheduled) actually RUNS on its tick and — NOTIFY-ONLY — emits a NON-TERMINAL
 * suspected-stuck ALERT while killing nothing and transitioning nothing:
 *   - Blocker-A: it does NOT push a terminal `crashed` report and the record
 *     stays `running`.
 *   - Blocker-C: the alert path journals a `watchdog_alert` system_event.
 *
 * DETERMINISTIC TICKS (round-10 P2). These tests drive the loop through the
 * scheduler's awaitable `runOnce()` — SupervisedLoop's own single-flight-guarded
 * runner — and AWAIT settlement, rather than firing the interval seam and hoping a
 * fixed `Bun.sleep` was long enough (a sleep-based race that flaked on loaded CI).
 * The injected `set_interval` is a no-op that never arms a real timer, so a tick
 * happens ONLY when the test calls `runOnce()`.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  SystemEventsStore,
  emitSystemEvent,
  registerSystemEventSink,
} from '@neutronai/persistence/system-events.ts'
import { newControlState, registerCanceller } from '@neutronai/runtime/subagent/control.ts'
import { SubagentRegistry } from '@neutronai/runtime/subagent/registry.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { DispatchService } from './service.ts'
import { registerDispatchToolSurface, DISPATCH_AGENT_TOOL } from './tool.ts'
import {
  scheduleDispatchLifecycleWatchdog,
  buildDispatchStuckAlertSink,
  selectDispatchAlertTopics,
  type AppWsAlertRegistry,
  type DispatchSuspectedStuckAlert,
} from './watchdog-report.ts'

let db: ProjectDb | undefined
let tmp: string | undefined

afterEach(() => {
  registerSystemEventSink(null)
  db?.close()
  db = undefined
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

/** A no-op interval seam — no real timer ever fires; tests drive `runOnce()`. */
const noTimer = (): ReturnType<typeof setInterval> => 0 as unknown as ReturnType<typeof setInterval>

/** Deterministically drain the microtask queue (no wall-clock) so a "has this
 *  promise NOT resolved yet?" assertion is stable without a `sleep`. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('scheduleDispatchLifecycleWatchdog (F4)', () => {
  test('Blocker-A: the scheduled tick emits a NON-TERMINAL alert, killing/transitioning NOTHING', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)

    // A live atlas dispatch stale for 10 min (> 5-min threshold).
    await registry.create({ run_id: 'r1', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('r1', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    // Register a canceller — proof-nothing-killed: it must never be invoked.
    let cancellerCalls = 0
    registerCanceller(control, 'r1', async () => {
      cancellerCalls++
    })

    const alerts: DispatchSuspectedStuckAlert[] = []
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: (a) => {
        alerts.push(a)
      },
      set_interval: noTimer,
      clear_interval: () => {},
    })

    await scheduled.runOnce()

    // The tick RAN and emitted a NON-TERMINAL suspected-stuck alert…
    expect(alerts.length).toBe(1)
    const a = alerts[0]!
    expect(a.run_id).toBe('r1')
    expect(a.agent_kind).toBe('atlas')
    expect(a.reason).toBe('stuck')
    // …the alert is NOT a terminal report: no `crashed`/`status`, and it says so.
    expect((a as unknown as { status?: unknown }).status).toBeUndefined()
    expect(a.markdown).toContain('NOT been stopped')
    expect(a.markdown).not.toContain('crashed')

    // NOTHING killed, NOTHING transitioned — the record is still live+running.
    expect(cancellerCalls).toBe(0)
    expect(registry.byRunId('r1')?.status).toBe('running')
    expect(registry.byRunId('r1')?.failure_reason).toBeUndefined()
    expect(registry.live().length).toBe(1)

    // A second tick does NOT re-alert the same still-live run (deduped).
    await scheduled.runOnce()
    expect(alerts.length).toBe(1)

    await scheduled.stop()
  })

  test('Blocker-C: a stuck dispatched subagent produces a watchdog_alert system_event', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-dispatch-o4-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    // Wire the ambient O4 sink exactly as the gateway boot does.
    registerSystemEventSink(new SystemEventsStore({ db }))

    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    await registry.create({ run_id: 'r2', instance_key: 'owner', agent_kind: 'sentinel', spawn_depth: 0 })
    await registry.update('r2', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    // The composer's alert sink journals `watchdog_alert` into O4. AWAIT the write
    // so `runOnce()` settling guarantees the row is durable (no fire-and-forget race).
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: async (alert) => {
        await emitSystemEvent({
          event: 'watchdog_alert',
          module: 'watchdog',
          level: 'warn',
          project_slug: 'owner',
          payload: { source: 'dispatch_lifecycle', run_id: alert.run_id, reason: alert.reason },
        })
      },
      set_interval: noTimer,
      clear_interval: () => {},
    })

    await scheduled.runOnce()

    const rows = db.all<{ event_name: string; module: string; payload_json: string }, []>(
      `SELECT event_name, module, payload_json FROM system_events WHERE event_name = 'watchdog_alert'`,
      [],
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.module).toBe('watchdog')
    expect(rows[0]!.payload_json).toContain('dispatch_lifecycle')
    expect(rows[0]!.payload_json).toContain('r2')

    await scheduled.stop()
  })

  test('round-4 wrapper propagation: alert_sink rejects on tick 1 → NOT latched → retried + delivered exactly once', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)

    // A live atlas dispatch stale past threshold — detected every tick until latched.
    await registry.create({ run_id: 'r3', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('r3', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    let cancellerCalls = 0
    registerCanceller(control, 'r3', async () => {
      cancellerCalls++
    })

    // The sink REJECTS the first delivery (transient O4/app-ws blip), then succeeds.
    let sinkCalls = 0
    let deliveries = 0
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: async (_a) => {
        sinkCalls++
        if (sinkCalls === 1) throw new Error('sink boom')
        deliveries++
      },
      set_interval: noTimer,
      clear_interval: () => {},
    })

    // Tick 1 — the wrapper PROPAGATES the rejection, so the run is NOT added to
    // `notified`. Nothing delivered, nothing killed, the tick did not wedge (the
    // rejection is contained by SupervisedLoop's onError, so runOnce resolves).
    await scheduled.runOnce()
    expect(sinkCalls).toBe(1)
    expect(deliveries).toBe(0)
    expect(cancellerCalls).toBe(0)
    expect(registry.byRunId('r3')?.status).toBe('running')

    // Tick 2 — still un-latched → rediscovered, sink recovers → delivered ONCE.
    await scheduled.runOnce()
    expect(sinkCalls).toBe(2)
    expect(deliveries).toBe(1)

    // Tick 3 — now latched → no repeat delivery (exactly-once holds).
    await scheduled.runOnce()
    expect(sinkCalls).toBe(2)
    expect(deliveries).toBe(1)
    expect(cancellerCalls).toBe(0)

    await scheduled.stop()
  })

  test('round-4 High-B single-flight: two OVERLAPPING ticks notify a still-live run exactly once', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    await registry.create({ run_id: 'r4', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('r4', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    // A DEFERRED sink: it does not resolve until released, so tick 1 stays in-flight
    // (awaiting delivery) across the moment tick 2 starts. `sinkEntered` fires the
    // instant tick 1 reaches the sink, making the assertion deterministic (no sleep).
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => {
      release = res
    })
    let sinkEnteredResolve: () => void = () => {}
    const sinkEntered = new Promise<void>((res) => {
      sinkEnteredResolve = res
    })
    let sinkCalls = 0
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: async (_a) => {
        sinkCalls++
        sinkEnteredResolve()
        await gate
      },
      set_interval: noTimer,
      clear_interval: () => {},
    })

    // Start two ticks back-to-back WITHOUT awaiting the first. runOnce() sets the
    // in-flight guard synchronously, so tick 2 is single-flight-SKIPPED — a
    // non-single-flight loop would read the run as un-notified and fire again.
    const t1 = scheduled.runOnce()
    const t2 = scheduled.runOnce()
    await t2 // the skipped tick resolves immediately (no body ran)
    await sinkEntered // tick 1 has reached the sink — deterministic checkpoint
    expect(sinkCalls).toBe(1) // tick 2 skipped — no duplicate notify

    // Release → tick 1 completes and latches the run in `notified`.
    release()
    await t1

    // A later, non-overlapping tick sees the run already notified → no repeat.
    await scheduled.runOnce()
    expect(sinkCalls).toBe(1)

    await scheduled.stop()
  })

  test('round-7 High-2: stop() is QUIESCING — it does not resolve until the in-flight tick drains', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    await registry.create({ run_id: 'r5', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('r5', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    // A DEFERRED sink holds the tick in-flight until released — this stands in for
    // registry pruning / persistence that must NOT resume against a closing DB.
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => {
      release = res
    })
    let tickCompleted = false
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: async (_a) => {
        await gate
        tickCompleted = true
      },
      set_interval: noTimer,
      clear_interval: () => {},
    })

    // Start a tick WITHOUT awaiting; it blocks inside the gated sink (in-flight).
    const tick = scheduled.runOnce()
    await flushMicrotasks()
    expect(tickCompleted).toBe(false)

    // stop() must NOT resolve while a tick is in-flight — it DRAINS it first. The
    // gateway awaits this before db.close(), so no post-close DB access occurs.
    let stopResolved = false
    const stopPromise = scheduled.stop().then(() => {
      stopResolved = true
    })
    await flushMicrotasks()
    expect(stopResolved).toBe(false) // still draining the in-flight tick
    expect(tickCompleted).toBe(false)

    // Release the tick → it completes, and ONLY THEN does stop() resolve.
    release()
    await tick
    await stopPromise
    expect(tickCompleted).toBe(true)
    expect(stopResolved).toBe(true)
  })
})

describe('buildDispatchStuckAlertSink — persist-before-deliver (round-9)', () => {
  const alert: DispatchSuspectedStuckAlert = {
    run_id: 'r1',
    agent_kind: 'atlas',
    reason: 'stuck',
    age_ms: 1,
    markdown: 'x',
  }

  test('journal record() rejects → NO visible push; on retry the push lands EXACTLY ONCE', async () => {
    let journalCalls = 0
    let pushCalls = 0
    const sink = buildDispatchStuckAlertSink({
      // The durable journal REJECTS on the first call, then persists (returns true).
      journal: async (): Promise<boolean> => {
        journalCalls++
        if (journalCalls === 1) throw new Error('journal down')
        return true
      },
      // The user-visible push always "succeeds" — the mutation check: with the OLD
      // send-then-record order this counter would reach 2 (fires on both ticks).
      push: (): void => {
        pushCalls++
      },
    })

    // Tick 1 — journal rejects → the sink rejects BEFORE any push (persist-first),
    // so the watchdog leaves the run un-latched and the user sees NOTHING yet.
    await expect(sink(alert)).rejects.toThrow('journal down')
    expect(pushCalls).toBe(0)

    // Tick 2 (retry) — journal commits → the push fires. EXACTLY ONCE across both.
    await sink(alert)
    expect(pushCalls).toBe(1)
    expect(journalCalls).toBe(2)
  })

  test('a push that throws is swallowed (journal already committed → alert stays latched)', async () => {
    const sink = buildDispatchStuckAlertSink({
      journal: async (): Promise<boolean> => true,
      push: (): void => {
        throw new Error('dead socket')
      },
    })
    // A dead socket must NOT propagate — the durable journal already committed, so
    // re-throwing would wrongly un-latch and re-journal.
    await expect(Promise.resolve(sink(alert))).resolves.toBeUndefined()
  })

  test('round-14: a NULL durable sink (journal returns false) SUPPRESSES the push and does NOT deliver', async () => {
    let journalCalls = 0
    let pushCalls = 0
    const sink = buildDispatchStuckAlertSink({
      // No durable target → journal persists NOTHING and signals it (false).
      journal: async (): Promise<boolean> => {
        journalCalls++
        return false
      },
      push: (): void => {
        pushCalls++
      },
    })

    // The sink must REJECT (not-delivered) so the run is left un-latched, and it must
    // NOT perform the user-visible push — a visible alert with no durable record is
    // exactly the hole this closes.
    await expect(sink(alert)).rejects.toThrow(/no durable system-event sink/i)
    expect(journalCalls).toBe(1)
    expect(pushCalls).toBe(0)
  })

  test('integration: journal rejects tick 1 → the VISIBLE push is delivered EXACTLY ONCE across retry ticks', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    await registry.create({ run_id: 'r7', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('r7', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    let journalCalls = 0
    let pushCalls = 0
    const sink = buildDispatchStuckAlertSink({
      journal: async (): Promise<boolean> => {
        journalCalls++
        if (journalCalls === 1) throw new Error('journal down')
        return true
      },
      push: (): void => {
        pushCalls++
      },
    })

    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: sink,
      set_interval: noTimer,
      clear_interval: () => {},
    })

    // Tick 1 — journal rejects → run NOT latched, NO visible push.
    await scheduled.runOnce()
    expect(journalCalls).toBe(1)
    expect(pushCalls).toBe(0)

    // Tick 2 — journal commits → the visible push fires once, run latched.
    await scheduled.runOnce()
    expect(pushCalls).toBe(1)

    // Tick 3 — latched → no repeat visible push (exactly-once holds).
    await scheduled.runOnce()
    expect(pushCalls).toBe(1)

    await scheduled.stop()
  })

  test('round-14 integration: a NULL durable sink never pushes and keeps RETRYING; delivers once a sink is wired', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    await registry.create({ run_id: 'r8', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('r8', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    // Mirror the composer's real journal: resolveSystemEventSink() === null → the
    // journal writes nothing and returns false, until a sink is wired.
    let sinkWired = false
    let journalWrites = 0
    let pushCalls = 0
    const sink = buildDispatchStuckAlertSink({
      journal: async (): Promise<boolean> => {
        if (!sinkWired) return false // no durable target yet
        journalWrites++
        return true
      },
      push: (): void => {
        pushCalls++
      },
    })
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: sink,
      set_interval: noTimer,
      clear_interval: () => {},
    })

    // Ticks 1-2 with a NULL sink → NO push, nothing journaled, run NOT latched
    // (the throw is caught + logged by the notifier wrapper — observable, retryable).
    await scheduled.runOnce()
    await scheduled.runOnce()
    expect(pushCalls).toBe(0)
    expect(journalWrites).toBe(0)

    // The O4 sink gets wired → the next tick journals AND pushes exactly once.
    sinkWired = true
    await scheduled.runOnce()
    expect(journalWrites).toBe(1)
    expect(pushCalls).toBe(1)

    // Latched → no repeat.
    await scheduled.runOnce()
    expect(pushCalls).toBe(1)

    await scheduled.stop()
  })
})

describe('selectDispatchAlertTopics — cross-binding isolation (round-11/13)', () => {
  // The owner-root/General topic + two live per-project topics (two conversations).
  const ownerRoot = 'app:owner'
  const topicA = 'app:owner:projA'
  const topicB = 'app:owner:projB'
  const registry: AppWsAlertRegistry = {
    has: (t) => t === ownerRoot || t === topicA || t === topicB,
    topics: () => [ownerRoot, topicA, topicB],
  }
  const base: DispatchSuspectedStuckAlert = {
    run_id: 'r1',
    agent_kind: 'atlas',
    reason: 'stuck',
    age_ms: 1,
    markdown: 'x',
  }

  test('an app_socket-bound alert routes to ONLY its binding topic — siblings never see it', () => {
    const bound = { ...base, delivery_target: { channel: 'app_socket', binding_id: topicA } }
    const topics = selectDispatchAlertTopics(bound, registry, { owner_root_topic: ownerRoot })
    expect(topics).toEqual([topicA])
    expect(topics).not.toContain(topicB) // no cross-binding leak
    expect(topics).not.toContain(ownerRoot)
  })

  test('a bound target whose topic has NO live device routes NOWHERE — never falls back to broadcast', () => {
    const bound = { ...base, delivery_target: { channel: 'app_socket', binding_id: 'app:owner:gone' } }
    expect(selectDispatchAlertTopics(bound, registry, { owner_root_topic: ownerRoot })).toEqual([])
  })

  test('a recorded but UNSUPPORTED channel does not broadcast', () => {
    const bound = { ...base, delivery_target: { channel: 'telegram', binding_id: '123' } }
    expect(selectDispatchAlertTopics(bound, registry, { owner_root_topic: ownerRoot })).toEqual([])
  })

  test('round-13: an ORIGIN-LESS alert falls back to the owner-ROOT topic ONLY — never sibling projects', () => {
    const topics = selectDispatchAlertTopics(base, registry, { owner_root_topic: ownerRoot })
    expect(topics).toEqual([ownerRoot])
    expect(topics).not.toContain(topicA) // the r11 fan-to-all leak is closed
    expect(topics).not.toContain(topicB)
  })

  test('round-13: an origin-less alert with NO owner-root configured DROPS the ephemeral push', () => {
    expect(selectDispatchAlertTopics(base, registry)).toEqual([])
  })
})

describe('round-13 E2E — real dispatch_agent path: origin-stamped alert isolates to its project', () => {
  test('dispatch_agent from projA → stuck-alert reaches ONLY app:owner:projA, never projB', async () => {
    // Real registry + control; the dispatch TURN hangs so the run stays live.
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    const service = new DispatchService({
      registry,
      control,
      dispatch: () => new Promise<never>(() => {}), // never settles → run stays running
      report: () => {},
      instance_key: 'inst-a',
      repo_path: '/home/owner',
      board: {
        get: (_slug: string, id: string) => ({
          id,
          title: 'a fully specified plan item with plenty of detail here',
          design_doc_ref: null,
        }),
        attachRun: async () => undefined,
        clearRun: async () => undefined,
      },
      project_slug: 'owner',
      default_model: 'm',
      persona_loader: () => ({ content: 'ROLE', source: 'fallback' }),
    })

    // Register the REAL tool with the production-shaped resolver (project_id →
    // app:owner:<project_id>). This is the actual tool→service wiring, not a
    // manually-populated target.
    const toolReg = new ToolRegistry()
    registerDispatchToolSurface(toolReg, service, {
      resolve_delivery_target: (ctx) => ({
        channel: 'app_socket',
        binding_id: ctx.project_id !== null ? `app:owner:${ctx.project_id}` : 'app:owner',
      }),
    })
    const tool = toolReg.get(DISPATCH_AGENT_TOOL)!

    // The live agent dispatches a research task FROM PROJECT A.
    await tool.handler(
      { kind: 'research', task: 'investigate the thing', board_item_id: 'it1' },
      { project_slug: 'owner', project_id: 'projA', topic_id: null, call_id: 'c1', speaker_user_id: null },
    )

    // The run is live and carries projA's origin binding (stamped by the tool).
    const live = registry.live()
    expect(live.length).toBe(1)
    const run_id = live[0]!.run_id
    expect(live[0]!.delivery_target).toEqual({ channel: 'app_socket', binding_id: 'app:owner:projA' })

    // Make it stale (past the 5-min suspected-stuck threshold).
    await registry.update(run_id, { last_event_at: Date.now() - 10 * 60_000 })

    // Two live conversations (+ owner root). Capture where the ephemeral push lands
    // via the REAL router the composer's push uses.
    const twoTopics: AppWsAlertRegistry = {
      has: (t) => t === 'app:owner' || t === 'app:owner:projA' || t === 'app:owner:projB',
      topics: () => ['app:owner', 'app:owner:projA', 'app:owner:projB'],
    }
    let pushedTopics: string[] = []
    const sink = buildDispatchStuckAlertSink({
      journal: async () => true, // durable record written — routing is what we assert
      push: (alert) => {
        pushedTopics = selectDispatchAlertTopics(alert, twoTopics, { owner_root_topic: 'app:owner' })
      },
    })

    // Drive the REAL lifecycle watchdog once: registry → runLifecycleTick →
    // notifier → sink → router. Nothing manually populated.
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: sink,
      set_interval: noTimer,
      clear_interval: () => {},
    })
    await scheduled.runOnce()
    await scheduled.stop()

    // ISOLATION: the alert reached ONLY projA's topic. The sibling project B — and
    // even the owner-root/General surface — NEVER received it.
    expect(pushedTopics).toEqual(['app:owner:projA'])
    expect(pushedTopics).not.toContain('app:owner:projB')
    expect(pushedTopics).not.toContain('app:owner')
  })
})
