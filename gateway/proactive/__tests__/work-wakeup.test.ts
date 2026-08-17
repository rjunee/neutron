import { describe, expect, test } from 'bun:test'

import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import { resetLoggerStateForTests } from '@neutronai/logger'
import {
  buildWakeupPrompt,
  buildWorkWakeupLoop,
  runWorkWakeupSweep,
  MAX_WAKEUP_PROMPT_ITEMS,
  MAX_WAKEUP_REPORT_CHARS,
  WAKEUP_BLOCKED_PREFIX,
  WAKEUP_FAILURE_POST_CADENCE,
  WORK_WAKEUP_INTERVAL_MS,
  WORK_WAKEUP_OWNER_GRACE_MS,
  type WakeupDeferredItem,
  type WakeupProjectWork,
  type WorkWakeupDeps,
} from '../work-wakeup.ts'

const NOW = 1_700_000_000_000
const TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'] as const

function project(over: Partial<WakeupProjectWork> = {}): WakeupProjectWork {
  return {
    project_key: 'acme',
    chat_scope: 'acme',
    label: 'project "acme"',
    items: [{ title: 'Ship the importer' }],
    deferred: [],
    ...over,
  }
}

function deferral(over: Partial<WakeupDeferredItem> = {}): WakeupDeferredItem {
  return {
    title: 'Ship the importer',
    item_id: 'item-1',
    run_id: 'run-1',
    phase: 'forge-init',
    since_advance_ms: 120_000,
    ...over,
  }
}

/**
 * Capture the logger's INFO lines. It routes info → `console.log`
 * (`gateway/wiring/__tests__/resolve-llm-credentials.test.ts` uses the same
 * seam); the level is pinned so the assertion does not depend on the ambient
 * `NEUTRON_LOG_LEVEL`.
 */
function captureInfo(): { matching(event: string): string[]; clear(): void; restore(): void } {
  const lines: string[] = []
  const originalLog = console.log
  const originalLevel = process.env['NEUTRON_LOG_LEVEL']
  process.env['NEUTRON_LOG_LEVEL'] = 'info'
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '))
  }
  return {
    matching: (event: string): string[] => lines.filter((l) => l.includes(event)),
    /** Drop what has been captured so far — for asserting on a LATER tick alone. */
    clear: (): void => {
      lines.length = 0
    },
    restore: (): void => {
      console.log = originalLog
      if (originalLevel === undefined) delete process.env['NEUTRON_LOG_LEVEL']
      else process.env['NEUTRON_LOG_LEVEL'] = originalLevel
    },
  }
}

interface Harness {
  deps: WorkWakeupDeps
  specs: AgentSpec[]
  posts: Array<{ project_key: string; body: string; loud: boolean }>
}

function harness(over: {
  projects?: WakeupProjectWork[]
  reply?: string | (() => string)
  composeError?: string
  activity?: number | null
} = {}): Harness {
  const specs: AgentSpec[] = []
  const posts: Array<{ project_key: string; body: string; loud: boolean }> = []
  const deps: WorkWakeupDeps = {
    listOutstanding: () => over.projects ?? [project()],
    ownerActivityMs: () => over.activity ?? null,
    llm: {
      compose: async (spec) => {
        specs.push(spec)
        if (over.composeError !== undefined) throw new Error(over.composeError)
        const r = over.reply ?? 'Pushed the fix branch; next: green CI.'
        return typeof r === 'function' ? r() : r
      },
    },
    post: async (input) => {
      posts.push(input)
      return true
    },
    tool_names: TOOLS,
    resolveModel: () => 'model-x',
    now: () => NOW,
  }
  return { deps, specs, posts }
}

describe('runWorkWakeupSweep — the wake path', () => {
  test('an eligible project gets ONE turn on its own chat session scope', async () => {
    const h = harness()
    const result = await runWorkWakeupSweep(h.deps, new Map())

    expect(result).toEqual({ woke: 1, skipped_active: 0, failed: 0, deferred_to_run: 0 })
    expect(h.specs).toHaveLength(1)
    const spec = h.specs[0]!
    // The warm-pool key — what lands the turn ON the owner's session.
    expect(spec.metering_context?.project_id).toBe('acme')
    expect(spec.model_preference).toEqual(['model-x'])
    expect(spec.prompt).toContain('Ship the importer')
    expect(spec.prompt).toContain('CONCRETE action')
    // The report is posted QUIET (durable + visible, no buzz).
    expect(h.posts).toEqual([
      { project_key: 'acme', body: 'Pushed the fix branch; next: green CI.', loud: false },
    ])
  })

  test('SAFETY — the compose turn presents the injected tool surface VERBATIM (a differing surface would evict the owner chat REPL)', async () => {
    const h = harness()
    await runWorkWakeupSweep(h.deps, new Map())
    expect(h.specs[0]!.tools.map((t) => t.name)).toEqual([...TOOLS])
  })

  test('owner active inside the grace window → skipped, and the session is NEVER entered', async () => {
    const h = harness({ activity: NOW - (WORK_WAKEUP_OWNER_GRACE_MS - 1) })
    const result = await runWorkWakeupSweep(h.deps, new Map())
    expect(result).toEqual({ woke: 0, skipped_active: 1, failed: 0, deferred_to_run: 0 })
    expect(h.specs).toHaveLength(0)
    expect(h.posts).toHaveLength(0)
  })

  test('CONTROL — owner idle past the grace window → wakes (proves the gate is the discriminator)', async () => {
    const h = harness({ activity: NOW - (WORK_WAKEUP_OWNER_GRACE_MS + 1) })
    const result = await runWorkWakeupSweep(h.deps, new Map())
    expect(result.woke).toBe(1)
    expect(h.specs).toHaveLength(1)
  })

  test('a BLOCKED reply posts LOUD — that is the "say so loudly" channel', async () => {
    const h = harness({ reply: `${WAKEUP_BLOCKED_PREFIX} need the API key for staging.` })
    await runWorkWakeupSweep(h.deps, new Map())
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]!.loud).toBe(true)
  })

  test('a project with zero items is not woken', async () => {
    const h = harness({ projects: [project({ items: [] })] })
    const result = await runWorkWakeupSweep(h.deps, new Map())
    expect(result).toEqual({ woke: 0, skipped_active: 0, failed: 0, deferred_to_run: 0 })
    expect(h.specs).toHaveLength(0)
  })

  test('a DEFERRED item is never woken, and the skip is COUNTED rather than swallowed', async () => {
    const h = harness({
      projects: [
        project({
          items: [],
          deferred: [
            {
              title: 'Ship the importer',
              item_id: 'item-1',
              run_id: 'run-1',
              phase: 'forge-init',
              since_advance_ms: 120_000,
            },
          ],
        }),
      ],
    })
    const result = await runWorkWakeupSweep(h.deps, new Map())
    expect(result).toEqual({ woke: 0, skipped_active: 0, failed: 0, deferred_to_run: 1 })
    expect(h.specs).toHaveLength(0)
  })

  test('a STANDING deferral is rate-limited, but the COUNT is never suppressed', async () => {
    // 288 lines a day per item is not a signal. The window is per ITEM, so the
    // first sweep speaks and the repeats inside the window stay quiet — while
    // `deferred_to_run` still counts every one, so nothing is lost.
    resetLoggerStateForTests()
    const lines = captureInfo()
    const deferralLog = new Map<string, number>()
    try {
      const h = harness({ projects: [project({ items: [], deferred: [deferral()] })] })
      const first = await runWorkWakeupSweep(h.deps, new Map(), deferralLog)
      const second = await runWorkWakeupSweep(h.deps, new Map(), deferralLog)
      expect(first.deferred_to_run).toBe(1)
      expect(second.deferred_to_run).toBe(1)
    } finally {
      lines.restore()
    }
    expect(lines.matching('wakeup_deferred_to_live_run')).toHaveLength(1)
  })

  test('TWO ITEMS SHARING ONE RUN each get their own line — the run is not the unit', async () => {
    // The window used to be keyed on (project, run). One trident run can drive
    // several board items, so the second and third items on a shared run were
    // SILENT: the counters said three deferrals and the log named one. A review
    // caught that the test which claimed to cover this quietly used distinct run
    // ids, so it never met the collision. These share `run-1` deliberately.
    resetLoggerStateForTests()
    const lines = captureInfo()
    try {
      const h = harness({
        projects: [
          project({
            items: [],
            deferred: [
              deferral({ item_id: 'item-1', title: 'Ship the importer' }),
              deferral({ item_id: 'item-2', title: 'Wire the reaper' }),
            ],
          }),
        ],
      })
      const result = await runWorkWakeupSweep(h.deps, new Map(), new Map())
      expect(result.deferred_to_run).toBe(2)
    } finally {
      lines.restore()
    }
    const deferrals = lines.matching('wakeup_deferred_to_live_run')
    expect(deferrals).toHaveLength(2)
    expect(deferrals[0]).toContain('Ship the importer')
    expect(deferrals[1]).toContain('Wire the reaper')
  })

  test('a RE-BOUND item speaks again — a new driver is not a standing deferral', async () => {
    // `attachRun` lets a later run supersede an earlier binding
    // (`work-board/store.ts:679`). Keyed on the item alone, the hand-off from R1
    // to R2 inside the half-hour window was suppressed, leaving the last line on
    // record naming R1 — stale attribution, which is worse than silence.
    resetLoggerStateForTests()
    const lines = captureInfo()
    const deferralLog = new Map<string, number>()
    try {
      const first = harness({
        projects: [project({ items: [], deferred: [deferral({ run_id: 'run-1' })] })],
      })
      await runWorkWakeupSweep(first.deps, new Map(), deferralLog)
      lines.clear()
      const second = harness({
        projects: [project({ items: [], deferred: [deferral({ run_id: 'run-2', phase: 'argus' })] })],
      })
      await runWorkWakeupSweep(second.deps, new Map(), deferralLog)
    } finally {
      lines.restore()
    }
    const deferrals = lines.matching('wakeup_deferred_to_live_run')
    expect(deferrals).toHaveLength(1)
    expect(deferrals[0]).toContain('run-2')
  })

  test('the deferral window map is PRUNED to what is currently deferred', async () => {
    // The window is owned by the loop rather than taken from `log.rateLimited`,
    // whose module-global map is never pruned in production
    // (`logger/index.ts:238-247`). A board item id is a fresh key per item, so
    // without this prune the map is the first unbounded keyspace in it.
    resetLoggerStateForTests()
    const lines = captureInfo()
    const deferralLog = new Map<string, number>()
    try {
      const withDeferral = harness({
        projects: [project({ items: [], deferred: [deferral({ item_id: 'gone-soon' })] })],
      })
      await runWorkWakeupSweep(withDeferral.deps, new Map(), deferralLog)
      expect(deferralLog.size).toBe(1)

      const withoutDeferral = harness({ projects: [project({ items: [], deferred: [] })] })
      await runWorkWakeupSweep(withoutDeferral.deps, new Map(), deferralLog)
      expect(deferralLog.size).toBe(0)
    } finally {
      lines.restore()
    }
  })

  test('OBSERVABILITY — every deferral writes a line naming the run and its phase', async () => {
    // The owner's complaint was "I can't tell if it's actually autonomously
    // progressing work". This is the line that answers it.
    resetLoggerStateForTests()
    const lines = captureInfo()
    try {
      const h = harness({
        projects: [
          project({
            items: [],
            deferred: [
              deferral(),
              deferral({
                item_id: 'item-2',
                title: 'Wire the reaper',
                run_id: 'run-2',
                phase: 'argus',
                since_advance_ms: 30_000,
              }),
            ],
          }),
        ],
      })
      await runWorkWakeupSweep(h.deps, new Map(), new Map())
    } finally {
      lines.restore()
    }
    const deferrals = lines.matching('wakeup_deferred_to_live_run')
    expect(deferrals).toHaveLength(2)
    expect(deferrals[0]).toContain('run-1')
    expect(deferrals[0]).toContain('forge-init')
    expect(deferrals[0]).toContain('Ship the importer')
    expect(deferrals[0]).toContain('120000')
    expect(deferrals[1]).toContain('run-2')
    expect(deferrals[1]).toContain('argus')
  })

  test('deferrals are reported even for a project whose owner is actively driving', async () => {
    const h = harness({
      activity: NOW - 1_000,
      projects: [
        project({
          deferred: [
            {
              title: 'Ship the importer',
              item_id: 'item-1',
              run_id: 'run-1',
              phase: 'forge-init',
              since_advance_ms: 1_000,
            },
          ],
        }),
      ],
    })
    const result = await runWorkWakeupSweep(h.deps, new Map())
    expect(result).toEqual({ woke: 0, skipped_active: 1, failed: 0, deferred_to_run: 1 })
  })

  test('an over-long report is truncated to the bound, never dropped', async () => {
    const h = harness({ reply: 'y'.repeat(MAX_WAKEUP_REPORT_CHARS + 500) })
    await runWorkWakeupSweep(h.deps, new Map())
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]!.body.length).toBe(MAX_WAKEUP_REPORT_CHARS)
    expect(h.posts[0]!.body.endsWith('…')).toBe(true)
  })
})

describe('runWorkWakeupSweep — loud failure, bounded siren', () => {
  test('first failure posts LOUD with the cause; streak 2..N-1 stay off the chat; the Nth posts again', async () => {
    const streaks = new Map<string, number>()
    const h = harness({ composeError: 'substrate down' })

    await runWorkWakeupSweep(h.deps, streaks)
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]!.loud).toBe(true)
    expect(h.posts[0]!.body).toContain('substrate down')
    expect(h.posts[0]!.body).toContain('retrying every 5 minutes')

    // Streaks 2..(cadence-1): silent on chat (still logged, still retried).
    for (let s = 2; s < WAKEUP_FAILURE_POST_CADENCE; s += 1) {
      await runWorkWakeupSweep(h.deps, streaks)
    }
    expect(h.posts).toHaveLength(1)

    // The cadence-th failure is loud again.
    await runWorkWakeupSweep(h.deps, streaks)
    expect(h.posts).toHaveLength(2)
    expect(h.posts[1]!.body).toContain(`attempt ${WAKEUP_FAILURE_POST_CADENCE}`)
  })

  test('an empty reply is a FAILURE (the silent-composition class), not a quiet post', async () => {
    const h = harness({ reply: '   ' })
    const result = await runWorkWakeupSweep(h.deps, new Map())
    expect(result.failed).toBe(1)
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]!.loud).toBe(true)
  })

  test('a success RESETS the failure streak (the next failure is loud immediately)', async () => {
    const streaks = new Map<string, number>()
    streaks.set('acme', 3)
    const ok = harness()
    await runWorkWakeupSweep(ok.deps, streaks)
    expect(streaks.has('acme')).toBe(false)

    const bad = harness({ composeError: 'boom' })
    await runWorkWakeupSweep(bad.deps, streaks)
    expect(bad.posts).toHaveLength(1) // streak restarted at 1 → loud
  })

  test('a project that leaves the outstanding set is pruned from the streak map', async () => {
    const streaks = new Map<string, number>()
    streaks.set('gone-project', 4)
    const h = harness()
    await runWorkWakeupSweep(h.deps, streaks)
    expect(streaks.has('gone-project')).toBe(false)
  })

  test('a throwing post() on the failure path is contained — the sweep continues', async () => {
    const deps: WorkWakeupDeps = {
      ...harness({ composeError: 'down' }).deps,
      post: async () => {
        throw new Error('outbound dead too')
      },
    }
    await expect(runWorkWakeupSweep(deps, new Map())).resolves.toEqual({
      woke: 0,
      skipped_active: 0,
      failed: 1,
      deferred_to_run: 0,
    })
  })
})

describe('buildWakeupPrompt', () => {
  test('caps listed items and counts the rest', () => {
    const items = Array.from({ length: MAX_WAKEUP_PROMPT_ITEMS + 3 }, (_, i) => ({
      title: `item-${i}`,
    }))
    const prompt = buildWakeupPrompt({ label: 'project "p"', items, now_iso: 'T' })
    expect(prompt).toContain(`item-${MAX_WAKEUP_PROMPT_ITEMS - 1}`)
    expect(prompt).not.toContain(`item-${MAX_WAKEUP_PROMPT_ITEMS}`)
    expect(prompt).toContain('(+3 more in-progress items)')
  })

  test('names the BLOCKED protocol so the loud channel is reachable from the prompt', () => {
    const prompt = buildWakeupPrompt({ label: 'x', items: [{ title: 't' }], now_iso: 'T' })
    expect(prompt).toContain(WAKEUP_BLOCKED_PREFIX)
  })
})

describe('buildWorkWakeupLoop', () => {
  test('describes a supervised loop at the 5-minute cadence, register-before-start compatible', () => {
    const h = harness()
    const wakeup = buildWorkWakeupLoop(h.deps)
    const d = wakeup.describe()
    expect(d.name).toBe('work-wakeup')
    expect(d.cadenceMs).toBe(WORK_WAKEUP_INTERVAL_MS)
    // Never started here — the lazy startedAt getter reads 0 until start()
    // (`loop/index.ts` describe(): "0 until then").
    expect(d.startedAt).toBe(0)
    expect(d.isActive?.()).toBe(false)
  })

  test('a manual tick drives the sweep end-to-end through the loop body', async () => {
    const h = harness()
    const wakeup = buildWorkWakeupLoop(h.deps)
    const result = await wakeup.loop.runOnce()
    expect(result.ran).toBe(true)
    expect(h.posts).toHaveLength(1)
  })

  test('THE COUNTERS REACH AN OPERATOR: the loop logs the sweep summary it used to discard', async () => {
    // `WakeupSweepResult` was returned and dropped by this, its only production
    // caller — so the claim that a rate-limited per-item line "never costs the
    // fact" was true of a number nothing printed. An aspirational docblock. The
    // summary is what makes the deferral count reachable even on a tick where
    // every per-item line is inside its window.
    resetLoggerStateForTests()
    const lines = captureInfo()
    try {
      const h = harness({
        projects: [
          project({
            items: [],
            deferred: [deferral({ item_id: 'a' }), deferral({ item_id: 'b' })],
          }),
        ],
      })
      const wakeup = buildWorkWakeupLoop(h.deps)
      // Twice: the second tick's per-item lines are suppressed by the window, and
      // the summary must STILL report both deferrals.
      await wakeup.loop.runOnce()
      lines.clear()
      await wakeup.loop.runOnce()
    } finally {
      lines.restore()
    }
    expect(lines.matching('wakeup_deferred_to_live_run')).toHaveLength(0)
    const summaries = lines.matching('wakeup_sweep')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toContain('deferred_to_run=2')
  })

  test('a fully idle tick stays silent — 288 summaries of zeros a day is not a signal', async () => {
    resetLoggerStateForTests()
    const lines = captureInfo()
    try {
      const h = harness({ projects: [] })
      const wakeup = buildWorkWakeupLoop(h.deps)
      await wakeup.loop.runOnce()
    } finally {
      lines.restore()
    }
    expect(lines.matching('wakeup_sweep')).toHaveLength(0)
  })
})
