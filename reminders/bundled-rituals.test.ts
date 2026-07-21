/**
 * @neutronai/reminders — bundled read-only ritual tests (plan task 7).
 *
 * T7 acceptance, fast per-commit half (the LLM-behaviour half is the gated
 * `bundled-rituals.e2e.test.ts`). Proves: the two ENGINE defs have the exact
 * read-only shape (zero intersection with GATED_WRITE_TOOLS — the no-Bash pin);
 * the in-repo templates are grounded on the real Neutron Projects/STATUS.md
 * layout and carry NO Vajra-isms (the static half of the ported-prompt silent-no-op
 * guard); seeding is copy-if-absent + idempotent + never-clobber; registration makes
 * both defs KNOWN + frozen; a bundled ritual fired WITHOUT the owner's approval lands
 * a durable 'skipped'/'unapproved' row via the REAL ApprovalManager path, calls the
 * turn zero times, and spawns nothing (the "registers but stays unapproved" bar); and
 * an approved fire pins tools/prompt-bytes/cwd/timeout/model (the T1 spec-shape the
 * task-8 approval will unlock).
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
  test('exactly two defs with the expected ids', () => {
    expect(BUNDLED_RITUAL_DEFS).toHaveLength(2)
    expect(BUNDLED_RITUAL_DEFS.map((d) => d.id)).toEqual(['morning-brief', 'evening-wrap'])
  })

  test.each(['morning-brief', 'evening-wrap'])(
    '%s is a read-only instance ritual with no gated tools',
    (id) => {
      const def = BUNDLED_RITUAL_DEFS.find((d) => d.id === id)!
      expect(def.scope).toBe('instance')
      expect([...def.tool_surface]).toEqual(['Read', 'Glob', 'Grep'])
      expect(def.egress).toBe('none')
      expect(def.silent).toBe(false)
      expect(def.description.trim().length).toBeGreaterThan(0)
      expect(def.description.length).toBeLessThanOrEqual(200)
      // The no-Bash pin: the surface has ZERO intersection with GATED_WRITE_TOOLS,
      // so the fire-time gated_tool_surface refusal never trips for these.
      expect(def.tool_surface.filter((t) => GATED_WRITE_TOOLS.has(t))).toEqual([])
    },
  )
})

// ── T7b — template assets ────────────────────────────────────────────────────
describe('bundled template assets', () => {
  test.each(['morning-brief', 'evening-wrap'])(
    '%s template exists, grounds on the Neutron layout, carries no Vajra-isms',
    (id) => {
      const path = bundledTemplatePathFor(id)
      expect(existsSync(path)).toBe(true)
      const content = readFileSync(path, 'utf8')
      expect(content.trim().length).toBeGreaterThan(0)
      // Real Neutron layout grounding (verified at reminders/context.ts:30,39).
      expect(content).toMatch(/Projects\//)
      expect(content).toMatch(/STATUS\.md/)
      // Static half of the ported-prompt silent-no-op guard: a GENERIC engine
      // template must not carry Ryan's Vajra-specific tooling/paths — those are
      // OWNER data that arrive via import, never the bundled engine default.
      expect(content).not.toMatch(
        /~\/vajra|\bgog\b|\bgh\b|tg-post|entities\/|MemPalace|Telegram|\bBash\b/i,
      )
    },
  )
})

// ── T7c — seeding ────────────────────────────────────────────────────────────
describe('seedBundledRituals — copy-if-absent + idempotent + never-clobber', () => {
  test('fresh dir seeds both, bytes match repo templates', () => {
    const { seeded, kept } = seedBundledRituals({ rituals_dir: ritualsDir })
    expect(seeded).toEqual(['morning-brief', 'evening-wrap'])
    expect(kept).toEqual([])
    for (const id of ['morning-brief', 'evening-wrap']) {
      const dest = readFileSync(join(ritualsDir, `${id}.md`), 'utf8')
      const src = readFileSync(bundledTemplatePathFor(id), 'utf8')
      expect(dest).toBe(src)
    }
  })

  test('second call is idempotent — seeds nothing, keeps both', () => {
    seedBundledRituals({ rituals_dir: ritualsDir })
    const { seeded, kept } = seedBundledRituals({ rituals_dir: ritualsDir })
    expect(seeded).toEqual([])
    expect(kept).toEqual(['morning-brief', 'evening-wrap'])
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
  test('registers both defs frozen', () => {
    const registry = createRitualRegistry({ rituals_dir: ritualsDir })
    registerBundledRituals(registry)
    expect(registry.list()).toHaveLength(2)
    const mb = registry.get('morning-brief')
    const ew = registry.get('evening-wrap')
    expect(mb).toBeDefined()
    expect(ew).toBeDefined()
    expect(Object.isFrozen(mb)).toBe(true)
    expect(Object.isFrozen(ew)).toBe(true)
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
})
