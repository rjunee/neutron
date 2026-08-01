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
import {
  createRitualRegistry,
  GATED_WRITE_TOOLS,
  RITUAL_TIMEOUT_MS,
} from './rituals.ts'
import { createRitualRunStore, type RitualRunStore } from './ritual-runs.ts'
import {
  createRitualExecutor,
  type RitualTurnInput,
  type RitualTurnResult,
} from './ritual-executor.ts'
import type { ReminderOutbound } from './dispatcher.ts'
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

/** Poll until `pred` holds (or throw) — the ritual settle+post chain is detached
 *  from `fire()`. Mirrors the helper in `ritual-executor.test.ts`. */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (pred()) return
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('condition not met within timeout')
}

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

// ── T7e — UNAPPROVED-BY-DEFAULT FIRE (registers but stays unapproved) ─────────
describe('bundled ritual fires UNAPPROVED by default (REAL ApprovalManager path)', () => {
  test('morning-brief with zero approval rows → durable skipped/unapproved, no turn, no spawn', async () => {
    seedBundledRituals({ rituals_dir: ritualsDir })
    const registry = createRitualRegistry({ rituals_dir: ritualsDir })
    registerBundledRituals(registry)

    const turn = mock(async (): Promise<RitualTurnResult> => ({ result: '', status: 'completed' }))
    const exec = createRitualExecutor({
      registry,
      // REAL approval path — zero approval rows means unapproved. OMIT
      // build_approval_check so the production createRitualApprovalCheck runs.
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound: passThroughOutbound,
      resolve_topic: resolveTopic,
      turn,
      runs,
      resolve_model: () => 'model-best',
      scope_cwd: (s) => {
        if (s !== 'instance') throw new Error('unsupported')
        return tmp
      },
      mint_run_id: () => 'run-1',
    })

    await exec.fire(await ritualRow('morning-brief'))

    const row = runs.get('run-1')!
    expect(row.status).toBe('skipped')
    expect(row.skip_reason).toBe('unapproved')
    expect(row.subagent_run_id).toBeNull()
    expect(turn).toHaveBeenCalledTimes(0)
    // Spawned NOTHING.
    expect(subagents.snapshot()).toHaveLength(0)
  })

  test('kaizen with zero approval rows → durable skipped/unapproved, no turn, no spawn', async () => {
    seedBundledRituals({ rituals_dir: ritualsDir })
    const registry = createRitualRegistry({ rituals_dir: ritualsDir })
    registerBundledRituals(registry)

    const turn = mock(async (): Promise<RitualTurnResult> => ({ result: '', status: 'completed' }))
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound: passThroughOutbound,
      resolve_topic: resolveTopic,
      turn,
      runs,
      resolve_model: () => 'model-best',
      scope_cwd: (s) => {
        if (s !== 'instance') throw new Error('unsupported')
        return tmp
      },
      mint_run_id: () => 'run-kz',
    })

    await exec.fire(await ritualRow('kaizen'))

    const row = runs.get('run-kz')!
    expect(row.status).toBe('skipped')
    expect(row.skip_reason).toBe('unapproved')
    expect(row.subagent_run_id).toBeNull()
    expect(turn).toHaveBeenCalledTimes(0)
    expect(subagents.snapshot()).toHaveLength(0)
  })
})

// ── T7f — approved spec-shape (the T1 pin task 8 unlocks) ─────────────────────
describe('bundled ritual approved fire — spec shape', () => {
  test('morning-brief approved → turn once with exact tools/prompt/cwd/timeout/model', async () => {
    seedBundledRituals({ rituals_dir: ritualsDir })
    const registry = createRitualRegistry({ rituals_dir: ritualsDir })
    registerBundledRituals(registry)
    const seededBytes = readFileSync(join(ritualsDir, 'morning-brief.md'), 'utf8')

    const turnCalls: RitualTurnInput[] = []
    const turn = mock(async (input: RitualTurnInput): Promise<RitualTurnResult> => {
      turnCalls.push(input)
      return { result: 'brief done', status: 'completed' }
    })
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound: passThroughOutbound,
      resolve_topic: resolveTopic,
      turn,
      runs,
      resolve_model: () => 'model-best',
      scope_cwd: (s) => {
        if (s !== 'instance') throw new Error('unsupported')
        return tmp
      },
      build_approval_check: () => ({ isApproved: () => true }),
      mint_run_id: () => 'run-2',
    })

    await exec.fire(await ritualRow('morning-brief'))

    expect(turn).toHaveBeenCalledTimes(1)
    const ti = turnCalls[0]!
    expect([...ti.tools!]).toEqual(['Read', 'Glob', 'Grep'])
    expect(ti.user_message).toBe(seededBytes)
    expect(ti.repo_path).toBe(tmp)
    expect(ti.timeout_ms).toBe(RITUAL_TIMEOUT_MS)
    expect(ti.model).toBe('model-best')
  })

  // The two things a bundled kaizen can silently get wrong, proven by OUTCOME:
  //  1. the widened surface never reaches the spawn (a kaizen with no WebSearch
  //     is granted the tools of a memory-diff and cannot do half its job); and
  //  2. the report goes nowhere. Skill Forge shipped for months persisting
  //     proposals into a log.info and telling nobody (#51). A weekly report that
  //     lands in a run row and never posts is the same defect wearing a hat, so
  //     this asserts the POST, not `silent === false`.
  test('kaizen approved → WebSearch reaches the spawn AND the report is posted', async () => {
    seedBundledRituals({ rituals_dir: ritualsDir })
    const registry = createRitualRegistry({ rituals_dir: ritualsDir })
    registerBundledRituals(registry)
    const seededBytes = readFileSync(join(ritualsDir, 'kaizen.md'), 'utf8')

    const posted: { topic_id: string; body: string }[] = []
    const capturingOutbound: ReminderOutbound = {
      post: async (m) => {
        posted.push({ topic_id: m.topic_id, body: m.body })
        return true
      },
    }

    const turnCalls: RitualTurnInput[] = []
    const turn = mock(async (input: RitualTurnInput): Promise<RitualTurnResult> => {
      turnCalls.push(input)
      return { result: 'SYSTEMIC: the same correction landed 4 times.', status: 'completed' }
    })
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound: capturingOutbound,
      resolve_topic: resolveTopic,
      turn,
      runs,
      resolve_model: () => 'model-best',
      scope_cwd: (s) => {
        if (s !== 'instance') throw new Error('unsupported')
        return tmp
      },
      build_approval_check: () => ({ isApproved: () => true }),
      mint_run_id: () => 'run-kz-ok',
    })

    await exec.fire(await ritualRow('kaizen'))

    expect(turn).toHaveBeenCalledTimes(1)
    const ti = turnCalls[0]!
    expect([...ti.tools!]).toEqual(['Read', 'Glob', 'Grep', 'WebSearch'])
    expect(ti.user_message).toBe(seededBytes)

    // The settle+post chain is DETACHED from fire() (ritual-executor.ts) — poll it
    // rather than asserting straight after fire, or this passes for the wrong
    // reason on a slow machine and fails for the wrong reason on a fast one.
    await waitFor(() => posted.length >= 1)

    // It REACHED him: one post, on the owner's topic, carrying the report text.
    expect(posted).toHaveLength(1)
    expect(posted[0]!.topic_id).toBe('app:owner-topic')
    expect(posted[0]!.body).toBe('SYSTEMIC: the same correction landed 4 times.')
  })
})
