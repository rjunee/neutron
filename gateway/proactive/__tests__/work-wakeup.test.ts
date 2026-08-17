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

    expect(result).toEqual({ woke: 1, skipped_active: 0, failed: 0, deferred_to_run: 0, released_stalled_run: 0 })
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
    expect(result).toEqual({ woke: 0, skipped_active: 1, failed: 0, deferred_to_run: 0, released_stalled_run: 0 })
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
    expect(result).toEqual({ woke: 0, skipped_active: 0, failed: 0, deferred_to_run: 0, released_stalled_run: 0 })
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
    expect(result).toEqual({ woke: 0, skipped_active: 0, failed: 0, deferred_to_run: 1, released_stalled_run: 0 })
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

  test('the key SEPARATES its components — two items whose ids concatenate alike both speak', async () => {
    // The separator is a NUL, written as an escape, and nothing pinned it: a
    // mutation that removed it entirely (`${project}${item}${run}`) left every
    // test in this file green. That is the shape where a "tidy-up" to a space —
    // or to nothing — lands silently, and the failure it causes is one item going
    // permanently unlogged, which is the exact defect this logging exists to cure.
    //
    // These two triples are chosen to COLLIDE under naive concatenation and only
    // under it: 'ab' + 'c' and 'a' + 'bc' both flatten to 'abc' in one project, so
    // without a separator the second deferral reads as a standing repeat of the
    // first and is suppressed. With one, they are different keys and both speak.
    resetLoggerStateForTests()
    const lines = captureInfo()
    try {
      const h = harness({
        projects: [
          project({
            items: [],
            deferred: [
              deferral({ item_id: 'ab', run_id: 'c', title: 'First item' }),
              deferral({ item_id: 'a', run_id: 'bc', title: 'Second item' }),
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
    expect(deferrals[0]).toContain('First item')
    expect(deferrals[1]).toContain('Second item')
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

  test('OBSERVABILITY — a FIRST-SEEN deferral writes a line naming the run and its phase', async () => {
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

  test('OBSERVABILITY — a RELEASE writes its own line, carrying the verdict reason', async () => {
    // The other half of the same decision. Only the deferral was ever logged, so
    // an item being taken BACK from a parked run — the entire point of this change
    // — was the one transition invisible in the log.
    resetLoggerStateForTests()
    const lines = captureInfo()
    try {
      const h = harness({
        projects: [
          project({
            items: [
              {
                title: 'Ship the importer',
                stalled_run: {
                  run_id: 'run-1',
                  phase: 'forge-init',
                  reason: 'no-advance',
                  since_advance_ms: 7_200_000,
                },
              },
            ],
          }),
        ],
      })
      const r = await runWorkWakeupSweep(h.deps, new Map(), new Map())
      expect(r.released_stalled_run).toBe(1)
    } finally {
      lines.restore()
    }
    const released = lines.matching('wakeup_released_stalled_run')
    expect(released).toHaveLength(1)
    expect(released[0]).toContain('run-1')
    expect(released[0]).toContain('forge-init')
    expect(released[0]).toContain('no-advance')
  })

  test('a CORRUPT-CLOCK release is distinguishable from an ordinary unbound item', async () => {
    // Before this, `unknown-advance` looked in the log exactly like an item that
    // never had a run: nothing was written either way. The reason token is what
    // tells a broken stamp from an unbound item.
    resetLoggerStateForTests()
    const lines = captureInfo()
    try {
      const h = harness({
        projects: [
          project({
            items: [
              { title: 'Unbound work' },
              {
                title: 'Ship the importer',
                stalled_run: {
                  run_id: 'run-9',
                  phase: 'argus',
                  reason: 'unknown-advance',
                  since_advance_ms: 0,
                },
              },
            ],
          }),
        ],
      })
      await runWorkWakeupSweep(h.deps, new Map(), new Map())
    } finally {
      lines.restore()
    }
    const released = lines.matching('wakeup_released_stalled_run')
    // One line, for the bound item only — the unbound one is not a release.
    expect(released).toHaveLength(1)
    expect(released[0]).toContain('unknown-advance')
    expect(released[0]).toContain('run-9')
    expect(released[0]).not.toContain('Unbound work')
  })

  test('a STANDING release is rate-limited, but the COUNT is never suppressed', async () => {
    const releasedItem = {
      title: 'Ship the importer',
      stalled_run: {
        run_id: 'run-1',
        phase: 'forge-init',
        reason: 'no-advance' as const,
        since_advance_ms: 7_200_000,
      },
    }
    resetLoggerStateForTests()
    const lines = captureInfo()
    const window = new Map<string, number>()
    try {
      const h = harness({ projects: [project({ items: [releasedItem] })] })
      const first = await runWorkWakeupSweep(h.deps, new Map(), window)
      lines.clear()
      const second = await runWorkWakeupSweep(h.deps, new Map(), window)
      expect(first.released_stalled_run).toBe(1)
      // The fact survives the rate limit; only the volume is spent.
      expect(second.released_stalled_run).toBe(1)
    } finally {
      lines.restore()
    }
    expect(lines.matching('wakeup_released_stalled_run')).toHaveLength(0)
  })

  test('the release window is PRUNED once the item stops being released', async () => {
    const window = new Map<string, number>()
    const releasedItem = {
      title: 'Ship the importer',
      stalled_run: {
        run_id: 'run-1',
        phase: 'forge-init',
        reason: 'no-advance' as const,
        since_advance_ms: 7_200_000,
      },
    }
    await runWorkWakeupSweep(
      harness({ projects: [project({ items: [releasedItem] })] }).deps,
      new Map(),
      window,
    )
    expect(window.size).toBe(1)
    // The run reached a terminal phase, so the item is now plainly unbound.
    await runWorkWakeupSweep(
      harness({ projects: [project({ items: [{ title: 'Ship the importer' }] })] }).deps,
      new Map(),
      window,
    )
    expect(window.size).toBe(0)
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
    expect(result).toEqual({ woke: 0, skipped_active: 1, failed: 0, deferred_to_run: 1, released_stalled_run: 0 })
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

  test('a project whose items are ALL DEFERRED is pruned too — no turn ran to continue a streak', async () => {
    // The entry still exists on such a project, deliberately, so the deferral can
    // be reported. Keying the prune on the entry's mere presence therefore kept a
    // stale streak alive for as long as the builds ran, and the first genuine
    // failure afterwards was judged as its Nth rather than its first.
    const streaks = new Map<string, number>()
    streaks.set('acme', 2)
    const h = harness({ projects: [project({ items: [], deferred: [deferral()] })] })
    await runWorkWakeupSweep(h.deps, streaks)
    expect(streaks.has('acme')).toBe(false)

    // CONTROL: the next real failure is therefore loud at streak 1.
    const bad = harness({ composeError: 'boom' })
    await runWorkWakeupSweep(bad.deps, streaks)
    expect(bad.posts).toHaveLength(1)
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
      released_stalled_run: 0,
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

  test('an UNBOUND item carries no run talk at all — the plain case stays plain', () => {
    const prompt = buildWakeupPrompt({ label: 'x', items: [{ title: 't' }], now_iso: 'T' })
    expect(prompt).toContain('that no background run is advancing')
    expect(prompt).not.toContain('still bound to background run')
    expect(prompt).not.toContain('do NOT dispatch a second build')
  })

  test('THE PROMPT NO LONGER CLAIMS A PARKED RUN DOES NOT EXIST', () => {
    // The finding: an item released because its run stopped advancing was
    // described to the agent as having "no live background run". The run row is
    // still there and still bound, so that sentence invited the second dispatch
    // the whole selection policy exists to prevent.
    const prompt = buildWakeupPrompt({
      label: 'x',
      items: [
        {
          title: 'Ship the importer',
          stalled_run: {
            run_id: 'run-1',
            phase: 'forge-init',
            reason: 'no-advance',
            since_advance_ms: 3 * 60 * 60_000,
          },
        },
      ],
      now_iso: 'T',
    })
    expect(prompt).not.toContain('with no live background run')
    // It names the run, its phase, and how long it has been quiet...
    expect(prompt).toContain('still bound to background run run-1')
    expect(prompt).toContain('parked at phase "forge-init"')
    expect(prompt).toContain('no progress for 180m')
    // ...and sends the turn at the parked run rather than around it.
    expect(prompt).toContain('do NOT dispatch a second build')
    expect(prompt).toContain('stop/reap the parked')
  })

  test('an UNREADABLE stamp is not rendered as "0m" — that would read as just-moved', () => {
    // `unknown-advance` carries `since_advance_ms: 0` by construction
    // (`trident/run-driving.ts:176`), which is the absence of a reading and not a
    // measurement of zero.
    const prompt = buildWakeupPrompt({
      label: 'x',
      items: [
        {
          title: 'Ship the importer',
          stalled_run: {
            run_id: 'run-1',
            phase: 'forge-init',
            reason: 'unknown-advance',
            since_advance_ms: 0,
          },
        },
      ],
      now_iso: 'T',
    })
    expect(prompt).toContain('its last-progress time is unreadable')
    expect(prompt).not.toContain('no progress for 0m')
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
