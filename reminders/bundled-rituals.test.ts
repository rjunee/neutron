/**
 * @neutronai/reminders — bundled read-only ritual tests (plan task 7).
 *
 * T7 acceptance, fast per-commit half (the LLM-behaviour half is the gated
 * `bundled-rituals.e2e.test.ts`). Proves: every ENGINE def is WRITE-FREE (zero
 * intersection with GATED_WRITE_TOOLS — the no-Bash pin) and declares an egress
 * class consistent with its tool surface; the in-repo templates are grounded on
 * real Neutron paths and carry NO the legacy harness-isms (the static half of the
 * ported-prompt silent-no-op guard); seeding is copy-if-absent + idempotent +
 * never-clobber; registration makes every def KNOWN + frozen; a bundled ritual
 * fired WITHOUT the owner's approval lands a durable 'skipped'/'unapproved' row via
 * the REAL ApprovalManager path, calls the turn zero times, and spawns nothing (the
 * "registers but stays unapproved" bar); and an approved fire pins
 * tools/prompt-bytes/cwd/timeout/model.
 *
 * TWO pins are specific to `kaizen` (2026-08-01), the weekly improvement ritual
 * that replaced `daily-delta`:
 *  - its WIDER surface (WebSearch, egress 'web') actually reaches the spawn — a
 *    kaizen granted the read-only triple silently loses half its job; and
 *  - its report is POSTED, asserted on the outbound rather than on `silent`.
 *    Skill Forge persisted proposals into a `log.info` for months and told nobody
 *    (#51); a weekly report that settles into a run row is the same defect, so the
 *    test asserts the message left the building.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SubagentRegistry } from '@neutronai/runtime/subagent/registry.ts'
import { ApprovalManager, type ApprovalNotifier } from '@neutronai/tools/approval.ts'

import { ReminderStore, type Reminder } from './store.ts'
import { createRitualRegistry, GATED_WRITE_TOOLS, RITUAL_TIMEOUT_MS } from './rituals.ts'
import { createRitualRunStore, type RitualRunStore } from './ritual-runs.ts'
import { buildRitualFirePlanner } from './ritual-fire.ts'
import {
  buildReminderDispatcher,
  type ReminderLlm,
  type ReminderOutbound,
} from './dispatcher.ts'
import { MAX_NUDGE_BODY_CHARS } from './message-shape.ts'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'

/**
 * The owner's live-chat `--tools` surface, as a LOCAL literal.
 *
 * Deliberately NOT imported from `@neutronai/gateway` — `reminders` sits BELOW the
 * gateway and the barrel refuses that edge on purpose (`reminders/index.ts`). So
 * this layer proves only that the surface it is HANDED reaches the composition
 * spec; that production hands it the real live-chat constant is pinned one layer
 * up, in `open/__tests__/open-reminder-dispatch-wiring.test.ts`.
 */
const OWNER_CHAT_TOOL_SURFACE = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'Bash',
  'Skill',
  'Workflow',
] as const
import {
  BUNDLED_RITUAL_DEFS,
  bundledTemplatePathFor,
  registerBundledRituals,
  seedBundledRituals,
} from './bundled-rituals.ts'

let tmp: string
let db: ProjectDb
let store: ReminderStore
let runs: RitualRunStore
let subagents: SubagentRegistry
let ritualsDir: string

const noopNotifier: ApprovalNotifier = { notify: async () => {} }
const passThroughOutbound: ReminderOutbound = { post: async () => true }
const resolveTopic = (): string => 'app:owner-topic'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-bundled-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new ReminderStore(db)
  runs = createRitualRunStore(db)
  subagents = new SubagentRegistry()
  ritualsDir = mkdtempSync(join(tmpdir(), 'neutron-bundled-rituals-'))
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
  rmSync(ritualsDir, { recursive: true, force: true })
})

/** A due one-shot reminder tagged as a ritual. */
async function ritualRow(ritual_id: string): Promise<Reminder> {
  const r = await store.create({ owner_slug: 'owner', topic_id: null, fire_at: 1000, message: 'x' })
  db.raw().run('UPDATE reminders SET ritual_id = ? WHERE id = ?', [ritual_id, r.id])
  return { ...r, ritual_id }
}

// ── T7a — def shape ──────────────────────────────────────────────────────────
describe('BUNDLED_RITUAL_DEFS — shape', () => {
  test('exactly three defs with the expected ids', () => {
    expect(BUNDLED_RITUAL_DEFS).toHaveLength(3)
    expect(BUNDLED_RITUAL_DEFS.map((d) => d.id)).toEqual([
      'morning-brief',
      'evening-wrap',
      'kaizen',
    ])
  })

  test('daily-delta is GONE — no def, no template, nothing to seed', () => {
    // The owner dropped it (2026-08-01): its job was proving the system worked,
    // which the reachability gates now cover. This pins the removal as CLEAN —
    // a def without a template (or the reverse) is exactly the orphan this
    // repo keeps producing.
    expect(BUNDLED_RITUAL_DEFS.map((d) => d.id)).not.toContain('daily-delta')
    expect(existsSync(bundledTemplatePathFor('daily-delta'))).toBe(false)
    const { seeded } = seedBundledRituals({ rituals_dir: ritualsDir })
    expect(seeded).not.toContain('daily-delta')
    expect(existsSync(join(ritualsDir, 'daily-delta.md'))).toBe(false)
  })

  test.each(BUNDLED_RITUAL_DEFS.map((d) => d.id))(
    '%s is a write-free instance ritual',
    (id) => {
      const def = BUNDLED_RITUAL_DEFS.find((d) => d.id === id)!
      expect(def.scope).toBe('instance')
      expect(def.silent).toBe(false)
      expect(def.description.trim().length).toBeGreaterThan(0)
      expect(def.description.length).toBeLessThanOrEqual(200)
      // The no-Bash pin: the surface has ZERO intersection with GATED_WRITE_TOOLS,
      // so the fire-time gated_tool_surface refusal never trips for these. This
      // holds for kaizen too — it may reach the WEB, it may never WRITE.
      expect(def.tool_surface.filter((t) => GATED_WRITE_TOOLS.has(t))).toEqual([])
    },
  )

  // Surfaces differ on exactly one axis — web egress — and the registry enforces
  // the tool_surface/egress consistency both ways (rituals.ts), so these pins
  // catch a def that grants WebSearch while still claiming egress 'none'.
  test.each(['morning-brief', 'evening-wrap'])('%s is read-only with no egress', (id) => {
    const def = BUNDLED_RITUAL_DEFS.find((d) => d.id === id)!
    expect([...def.tool_surface]).toEqual(['Read', 'Glob', 'Grep'])
    expect(def.egress).toBe('none')
  })

  test('kaizen grants WebSearch and declares web egress', () => {
    const def = BUNDLED_RITUAL_DEFS.find((d) => d.id === 'kaizen')!
    expect([...def.tool_surface]).toEqual(['Read', 'Glob', 'Grep', 'WebSearch'])
    expect(def.egress).toBe('web')
    // WebFetch is deliberately NOT granted: an arbitrary-URL fetch next to a
    // broad read surface is a cleaner exfiltration channel than a search box.
    expect(def.tool_surface).not.toContain('WebFetch')
  })

  test('every def registers — egress/surface consistency is real, not asserted', () => {
    // validateRitualDef THROWS when a def grants a web tool under egress 'none'
    // (or claims 'web' with no web tool). Registering all three proves the
    // kaizen widening is internally consistent rather than merely typed.
    const registry = createRitualRegistry({ rituals_dir: ritualsDir })
    expect(() => registerBundledRituals(registry)).not.toThrow()
  })
})

// ── T7b — template assets ────────────────────────────────────────────────────
describe('bundled template assets', () => {
  // Every def's template must exist + carry NO the legacy harness-isms (iterate the DEFS so a
  // new bundled ritual is covered automatically). NOTE: `entities/` is NOT a
  // the legacy harness-ism — it is the canonical Neutron memory path (`entities/INDEX.md`,
  // written by the memory-index), which the memory-reading rituals legitimately
  // name. Same for `corrections/` and `persona/` — Neutron's own paths.
  test.each(BUNDLED_RITUAL_DEFS.map((d) => d.id))(
    '%s template exists and carries no the legacy harness-isms',
    (id) => {
      const path = bundledTemplatePathFor(id)
      expect(existsSync(path)).toBe(true)
      const content = readFileSync(path, 'utf8')
      expect(content.trim().length).toBeGreaterThan(0)
      // Static half of the ported-prompt silent-no-op guard: a GENERIC engine
      // template must not carry Ryan's the legacy harness-specific tooling/paths — those are
      // OWNER data that arrive via import, never the bundled engine default.
      expect(content).not.toMatch(/~\/legacy|\bgog\b|\bgh\b|tg-post|MemoryStore|Telegram|\bBash\b/i)
    },
  )

  // The two project-reading rituals additionally ground on the real Neutron
  // Projects/STATUS.md layout (kaizen reads it too, alongside much more).
  test.each(['morning-brief', 'evening-wrap'])(
    '%s grounds on the Projects/STATUS.md layout',
    (id) => {
      const content = readFileSync(bundledTemplatePathFor(id), 'utf8')
      // Real Neutron layout grounding (verified at reminders/context.ts:30,39).
      expect(content).toMatch(/Projects\//)
      expect(content).toMatch(/STATUS\.md/)
    },
  )

  // Kaizen's whole point is the REPEAT correction — "corrected four times, so fix
  // the system, not the instance". A kaizen that cannot see corrections is not
  // this ritual, and a kaizen that reports without proposing a systemic fix is
  // the failure mode the legacy prompt was written against. Pin both, plus the
  // two safety clauses its widened surface depends on.
  describe('kaizen template', () => {
    const content = (): string => readFileSync(bundledTemplatePathFor('kaizen'), 'utf8')

    test('grounds on the real Neutron self-improvement inputs', () => {
      const c = content()
      expect(c).toMatch(/corrections\/corrections-log\.md/)
      expect(c).toMatch(/persona\/SOUL\.md/)
      expect(c).toMatch(/diary\//)
      expect(c).toMatch(/Projects\/\*\/(ACTIONS|STATUS)\.md/)
      expect(c).toMatch(/logs\/server\.log/)
      expect(c).toMatch(/diagnostics\/client-reports\.jsonl/)
    })

    test('carries the repeat-correction rule, with a threshold', () => {
      const c = content()
      expect(c).toMatch(/SYSTEMIC/)
      expect(c).toMatch(/3 or more times/)
      // The instance-vs-system distinction is the ritual, not decoration.
      expect(c).toMatch(/instance-level fix is not an acceptable proposal/)
    })

    test('states it cannot change anything — it proposes', () => {
      // GATED_WRITE_TOOLS refuses Write/Edit at fire time, so a template that
      // implies it edits files would produce a run that lies about its work.
      expect(content()).toMatch(/READ-ONLY/)
      expect(content()).toMatch(/PROPOSAL/)
    })

    test('forbids sending instance content out over its own egress', () => {
      // The one hazard of read-broadly + web-egress in a single agent.
      const c = content()
      expect(c).toMatch(/NEVER put anything from this instance into a query/)
      expect(c).toMatch(/NEVER read secrets|Do not open `\.env`/)
    })
  })
})

// ── T7c — seeding ────────────────────────────────────────────────────────────
describe('seedBundledRituals — copy-if-absent + idempotent + never-clobber', () => {
  const ALL_IDS = BUNDLED_RITUAL_DEFS.map((d) => d.id)

  test('fresh dir seeds all, bytes match repo templates', () => {
    const { seeded, kept } = seedBundledRituals({ rituals_dir: ritualsDir })
    expect(seeded).toEqual(ALL_IDS)
    expect(kept).toEqual([])
    for (const id of ALL_IDS) {
      const dest = readFileSync(join(ritualsDir, `${id}.md`), 'utf8')
      const src = readFileSync(bundledTemplatePathFor(id), 'utf8')
      expect(dest).toBe(src)
    }
  })

  test('second call is idempotent — seeds nothing, keeps all', () => {
    seedBundledRituals({ rituals_dir: ritualsDir })
    const { seeded, kept } = seedBundledRituals({ rituals_dir: ritualsDir })
    expect(seeded).toEqual([])
    expect(kept).toEqual(ALL_IDS)
  })

  test('never clobbers an owner-edited file', () => {
    seedBundledRituals({ rituals_dir: ritualsDir })
    writeFileSync(join(ritualsDir, 'morning-brief.md'), 'OWNER EDIT', 'utf8')
    const { seeded, kept } = seedBundledRituals({ rituals_dir: ritualsDir })
    expect(seeded).toEqual([])
    expect(kept).toContain('morning-brief')
    expect(readFileSync(join(ritualsDir, 'morning-brief.md'), 'utf8')).toBe('OWNER EDIT')
  })
})

// ── T7d — registration ───────────────────────────────────────────────────────
describe('registerBundledRituals', () => {
  test('registers all defs frozen', () => {
    const registry = createRitualRegistry({ rituals_dir: ritualsDir })
    registerBundledRituals(registry)
    expect(registry.list()).toHaveLength(3)
    for (const id of BUNDLED_RITUAL_DEFS.map((d) => d.id)) {
      const def = registry.get(id)
      expect(def).toBeDefined()
      expect(Object.isFrozen(def)).toBe(true)
    }
    expect(registry.get('kaizen')).toBeDefined()
  })
})

// ── T7e/T7f — a bundled ritual fires down the ONE reminder path (ISSUES #504) ──
//
// These two blocks replaced suites that drove `createRitualExecutor` and asserted
// a spawn onto the ephemeral `cc-ritual-*` REPL. That lane is deleted: a ritual is
// a reminder, so the subject under test is now the ONE `ReminderDispatcher` with a
// ritual fire planner installed, and what gets asserted is the thing the old lane
// got wrong — that the ritual's turn goes to the SAME composition seam (and
// therefore the same tool-bridged warm session) a plain nudge's does.

/** Build the ONE dispatcher with a real planner over the real ApprovalManager. */
function buildFireStack(opts: {
  registry: ReturnType<typeof createRitualRegistry>
  approved: boolean
  mint: string
  outbound?: ReminderOutbound
  compose?: (spec: AgentSpec) => Promise<string>
}): {
  dispatch: (r: Reminder) => Promise<void>
  specs: AgentSpec[]
  timeouts: (number | undefined)[]
  composeCalls: () => number
} {
  const specs: AgentSpec[] = []
  const timeouts: (number | undefined)[] = []
  const llm: ReminderLlm = {
    compose: async (spec, o) => {
      specs.push(spec)
      timeouts.push(o?.timeout_ms)
      return opts.compose !== undefined ? await opts.compose(spec) : 'composed body'
    },
  }
  const planner = buildRitualFirePlanner({
    registry: opts.registry,
    // REAL approval path unless the test explicitly forces approval: zero
    // approval rows means UNAPPROVED, which must fail closed.
    approvals: new ApprovalManager(db, noopNotifier),
    project_slug: 'owner',
    runs,
    ...(opts.approved ? { build_approval_check: () => ({ isApproved: () => true }) } : {}),
    mint_run_id: () => opts.mint,
  })
  const dispatcher = buildReminderDispatcher({
    outbound: opts.outbound ?? passThroughOutbound,
    llm,
    resolveTopicId: resolveTopic,
    // The owner's live-chat surface, as production threads it.
    tool_names: OWNER_CHAT_TOOL_SURFACE,
    ritual_planner: planner,
    resolve_ritual_model: () => 'model-best',
  })
  return {
    dispatch: (r) => dispatcher.dispatch(r),
    specs,
    timeouts,
    composeCalls: () => specs.length,
  }
}

describe('bundled ritual fires UNAPPROVED by default (REAL ApprovalManager path)', () => {
  test.each(['morning-brief', 'kaizen'])(
    '%s with zero approval rows → durable skipped/unapproved, NO turn, NO post',
    async (id) => {
      seedBundledRituals({ rituals_dir: ritualsDir })
      const registry = createRitualRegistry({ rituals_dir: ritualsDir })
      registerBundledRituals(registry)

      const posted: string[] = []
      const stack = buildFireStack({
        registry,
        approved: false,
        mint: 'run-skip',
        outbound: {
          post: async (m) => {
            posted.push(m.body)
            return true
          },
        },
      })

      await stack.dispatch(await ritualRow(id))

      const row = runs.get('run-skip')!
      expect(row.status).toBe('skipped')
      expect(row.skip_reason).toBe('unapproved')
      expect(row.subagent_run_id).toBeNull()
      // The prompt was never composed and nothing reached the owner.
      expect(stack.composeCalls()).toBe(0)
      expect(posted).toHaveLength(0)
      // And nothing was spawned — there is no spawn path left at all.
      expect(subagents.snapshot()).toHaveLength(0)
    },
  )
})

describe('bundled ritual approved fire — composes on the shared session and posts', () => {
  test('morning-brief approved → ONE turn on the shared seam with the approved prompt', async () => {
    seedBundledRituals({ rituals_dir: ritualsDir })
    const registry = createRitualRegistry({ rituals_dir: ritualsDir })
    registerBundledRituals(registry)
    const seededBytes = readFileSync(join(ritualsDir, 'morning-brief.md'), 'utf8')

    const posted: { topic_id: string; body: string }[] = []
    const stack = buildFireStack({
      registry,
      approved: true,
      mint: 'run-ok',
      outbound: {
        post: async (m) => {
          posted.push({ topic_id: m.topic_id, body: m.body })
          return true
        },
      },
      compose: async () => 'brief done',
    })

    await stack.dispatch(await ritualRow('morning-brief'))

    // ONE composition turn, carrying the APPROVED prompt bytes verbatim.
    expect(stack.composeCalls()).toBe(1)
    const spec = stack.specs[0]!
    expect(spec.prompt).toBe(seededBytes)
    expect(spec.model_preference).toEqual(['model-best'])
    expect(stack.timeouts[0]).toBe(RITUAL_TIMEOUT_MS)

    // ⚠️ THE LOAD-BEARING ASSERTION. The turn presents the OWNER'S LIVE-CHAT tool
    // surface — NOT the ritual def's narrower ['Read','Glob','Grep']. That is the
    // #504 fix, not a leak: the ritual composes on the owner's WARM session, and
    // the persistent pool evicts+respawns a warm child whose requested surface
    // differs from the spawned one (spawn.ts:824,837). Presenting the ritual's own
    // surface would tear the owner's chat REPL down on every fire AND still not
    // restrict the ritual. `tool_surface` is now the APPROVAL declaration; the
    // session is the runtime.
    expect([...spec.tools.map((t) => t.name)]).toEqual([...OWNER_CHAT_TOOL_SURFACE])
    expect(spec.tools.map((t) => t.name)).toContain('Bash')

    // The ledger recorded the whole chain, and the body reached the owner.
    const row = runs.get('run-ok')!
    expect(row.status).toBe('finished')
    expect(row.content_hash).toBeTruthy()
    expect(row.ended_at).not.toBeNull()
    expect(row.output_summary).toBe('brief done')
    expect(posted).toEqual([{ topic_id: 'app:owner-topic', body: 'brief done' }])
  })

  // The nudge bound (#293 defect B, `MAX_NUDGE_BODY_CHARS`) caps what a fired
  // REMINDER may post, because a 3.4k "nudge" is a composition failure. A ritual
  // is the opposite case: a morning brief is SUPPOSED to be long, it composes on
  // its own `RITUAL_MAX_TOKENS` budget, and it has no literal body to degrade to.
  // So the ritual path is exempt, and this pins that it stayed exempt.
  test('an approved ritual body far over MAX_NUDGE_BODY_CHARS posts in full — the bound is nudge-only', async () => {
    seedBundledRituals({ rituals_dir: ritualsDir })
    const registry = createRitualRegistry({ rituals_dir: ritualsDir })
    registerBundledRituals(registry)
    const longBrief = 'A long, legitimate morning brief.'.repeat(200)
    expect(longBrief.length).toBeGreaterThan(MAX_NUDGE_BODY_CHARS)

    const posted: string[] = []
    const stack = buildFireStack({
      registry,
      approved: true,
      mint: 'run-long',
      outbound: {
        post: async (m) => {
          posted.push(m.body)
          return true
        },
      },
      compose: async () => longBrief,
    })

    await stack.dispatch(await ritualRow('morning-brief'))

    expect(posted).toEqual([longBrief])
    expect(runs.get('run-long')!.status).toBe('finished')
  })

  // The thing a bundled kaizen can silently get wrong: the report goes nowhere.
  // Skill Forge shipped for months persisting proposals into a log.info and telling
  // nobody (#51). A weekly report that lands in a run row and never posts is the
  // same defect wearing a hat, so this asserts the POST, not `silent === false`.
  test('kaizen approved → the report is POSTED, not just recorded', async () => {
    seedBundledRituals({ rituals_dir: ritualsDir })
    const registry = createRitualRegistry({ rituals_dir: ritualsDir })
    registerBundledRituals(registry)
    const seededBytes = readFileSync(join(ritualsDir, 'kaizen.md'), 'utf8')

    const posted: { topic_id: string; body: string }[] = []
    const stack = buildFireStack({
      registry,
      approved: true,
      mint: 'run-kz-ok',
      outbound: {
        post: async (m) => {
          posted.push({ topic_id: m.topic_id, body: m.body })
          return true
        },
      },
      compose: async () => 'SYSTEMIC: the same correction landed 4 times.',
    })

    await stack.dispatch(await ritualRow('kaizen'))

    expect(stack.composeCalls()).toBe(1)
    expect(stack.specs[0]!.prompt).toBe(seededBytes)
    // It REACHED him — synchronously, because the fire is no longer detached.
    expect(posted).toHaveLength(1)
    expect(posted[0]!.topic_id).toBe('app:owner-topic')
    expect(posted[0]!.body).toBe('SYSTEMIC: the same correction landed 4 times.')
    expect(runs.get('run-kz-ok')!.status).toBe('finished')
  })

  test('an approved ritual whose turn yields nothing is a RECORDED, NOTICED failure', async () => {
    seedBundledRituals({ rituals_dir: ritualsDir })
    const registry = createRitualRegistry({ rituals_dir: ritualsDir })
    registerBundledRituals(registry)

    const posted: string[] = []
    const stack = buildFireStack({
      registry,
      approved: true,
      mint: 'run-empty',
      outbound: {
        post: async (m) => {
          posted.push(m.body)
          return true
        },
      },
      // Empty output — the nudge path would degrade to a literal body; a ritual
      // has none, so it must record a failure rather than post a placeholder.
      compose: async () => '   ',
    })

    await stack.dispatch(await ritualRow('morning-brief'))

    const row = runs.get('run-empty')!
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toContain('returned an empty body')
    // Exactly one owner-visible notice — a dead ritual is never silent.
    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain('morning-brief')
  })
})

// ── ISSUES #506 (second half) — a FAILED ritual names itself in the LOGS ──────
//
// The 2026-08-05 `evening-wrap` failure was undiagnosable for TWO independent
// reasons. #504's rewrite fixed the first: the ledger's `failure_reason` is now the
// real cause from the composition turn, not the tautological
// `"retry exhausted after 1 attempts: failed"`. The second survived it — a failed
// ritual still emitted NO log line naming itself, so `journalctl` over the whole
// window matched zero lines for `ritual|evening|error|fail` while a control grep
// proved 84 lines existed. An operator diagnosing "my brief didn't arrive" reaches
// for the journal before the ledger.
//
// Driven through the REAL dispatcher → planner → settle path with a composition
// seam that throws, and asserted on `console.warn`, which is where the logger
// routes `warn` by default. Asserting on the ledger row instead would pass on the
// half that was ALREADY fixed and say nothing about the half this covers.
describe('a failed ritual is diagnosable from the logs (#506)', () => {
  test('logs ritual_run_failed with the real cause, not just a ledger row', async () => {
    seedBundledRituals({ rituals_dir: ritualsDir })
    const registry = createRitualRegistry({ rituals_dir: ritualsDir })
    registerBundledRituals(registry)

    const warned: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]): void => {
      warned.push(args.map((a) => String(a)).join(' '))
    }
    try {
      const stack = buildFireStack({
        registry,
        approved: true,
        mint: 'r-506-fail',
        compose: async () => {
          throw new Error('substrate refused: no credential')
        },
      })
      await stack.dispatch(await ritualRow('morning-brief'))
    } finally {
      console.warn = realWarn
    }

    const line = warned.find((l) => l.includes('ritual_run_failed'))
    expect(line).toBeDefined()
    // The RITUAL and the RUN, so a journal grep for either finds it.
    expect(line).toContain('morning-brief')
    expect(line).toContain('r-506-fail')
    // And the actual cause — the whole point. A line that says only "failed"
    // rebuilds the defect.
    expect(line).toContain('substrate refused')
  })

  test('a SUCCEEDING ritual logs no failure line', async () => {
    // Otherwise the grep an operator runs would match every healthy run too, which
    // is the same "signal you learn to ignore" failure as a gate that always fires.
    seedBundledRituals({ rituals_dir: ritualsDir })
    const registry = createRitualRegistry({ rituals_dir: ritualsDir })
    registerBundledRituals(registry)

    const warned: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]): void => {
      warned.push(args.map((a) => String(a)).join(' '))
    }
    try {
      const stack = buildFireStack({ registry, approved: true, mint: 'r-506-ok' })
      await stack.dispatch(await ritualRow('morning-brief'))
    } finally {
      console.warn = realWarn
    }
    expect(warned.filter((l) => l.includes('ritual_run_failed'))).toEqual([])
  })
})
