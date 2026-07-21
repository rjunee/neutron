import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  createRitualRegistry,
  validateRitualFire,
  RITUAL_MODEL_TIER,
  RITUAL_TIMEOUT_MS,
  type RitualApprovalCheck,
  type RitualDef,
} from './rituals.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, '..', 'migrations')

/** A minimal valid def; override fields per test. */
function def(overrides: Partial<RitualDef> = {}): RitualDef {
  return {
    id: 'morning-brief',
    description: 'read STATUS.md + calendar and summarise the day',
    scope: 'project',
    tool_surface: ['Read', 'Glob', 'Grep'],
    egress: 'none',
    silent: false,
    ...overrides,
  }
}

/** An approval seam that always returns `value`; a jest/bun mock so we can assert calls. */
function approver(value: boolean): RitualApprovalCheck & { isApproved: ReturnType<typeof mock> } {
  return { isApproved: mock(() => value) }
}

// ── Registry + validation (T1 spec-shape slice) ──────────────────────────────

describe('createRitualRegistry — register/get/list/promptPathFor', () => {
  test('register + get + list round-trip; get returns a frozen def; promptPathFor joins', () => {
    const reg = createRitualRegistry({ rituals_dir: '/prompts/rituals' })
    reg.register(def())
    reg.register(def({ id: 'evening-wrap' }))

    expect(reg.get('morning-brief')?.id).toBe('morning-brief')
    expect(reg.get('nope')).toBeUndefined()
    expect(
      reg
        .list()
        .map((d) => d.id)
        .sort(),
    ).toEqual(['evening-wrap', 'morning-brief'])

    const got = reg.get('morning-brief')!
    expect(Object.isFrozen(got)).toBe(true)
    expect(Object.isFrozen(got.tool_surface)).toBe(true)
    expect(reg.promptPathFor('morning-brief')).toBe(join('/prompts/rituals', 'morning-brief.md'))
  })

  test('stored def is an independent frozen copy — post-register mutation of the source is inert', () => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    const source = def({ tool_surface: ['Read'] })
    reg.register(source)
    // Mutating the caller's array must not reach the registry's frozen copy.
    ;(source.tool_surface as string[]).push('Bash')
    expect(reg.get('morning-brief')?.tool_surface).toEqual(['Read'])
  })
})

describe('register() invariants — every rejection is a throw', () => {
  test.each(['..', 'a/b', 'UPPER', ''])('bad id %p throws', (badId) => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    expect(() => reg.register(def({ id: badId }))).toThrow(/RITUAL_ID_RE/)
  })

  test('duplicate id throws', () => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    reg.register(def())
    expect(() => reg.register(def())).toThrow(/duplicate/)
  })

  test('empty tool_surface throws (#361 toolless class)', () => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    expect(() => reg.register(def({ tool_surface: [] }))).toThrow(/#361|toolless/)
  })

  test('bad tool token throws', () => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    expect(() => reg.register(def({ tool_surface: ['rm -rf'] }))).toThrow(/tool token/)
  })

  test("egress 'none' + a web tool in surface throws", () => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    expect(() =>
      reg.register(def({ tool_surface: ['Read', 'WebFetch'], egress: 'none' })),
    ).toThrow(/egress/)
  })

  test("egress 'web' + no web tool throws", () => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    expect(() => reg.register(def({ tool_surface: ['Read'], egress: 'web' }))).toThrow(/egress/)
  })

  test('empty description throws', () => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    expect(() => reg.register(def({ description: '   ' }))).toThrow(/description/)
  })

  test('description over 200 chars throws', () => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    expect(() => reg.register(def({ description: 'x'.repeat(201) }))).toThrow(/200/)
  })

  test('a Bash surface + egress web + WebSearch is accepted (overturn 1: Bash rides approval)', () => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    expect(() =>
      reg.register(def({ tool_surface: ['Read', 'Bash', 'WebSearch'], egress: 'web' })),
    ).not.toThrow()
  })

  // Runtime enum/type guards — a def from imported user-data (JSON) never saw
  // the compiler, so a bogus scope/egress/silent must FAIL CLOSED at register().
  test("bogus scope value throws (imported-data guard)", () => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    expect(() =>
      reg.register(def({ scope: 'arbitrary' as unknown as RitualDef['scope'] })),
    ).toThrow(/scope/)
  })

  test("bogus egress value throws (imported-data guard)", () => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    // egress 'bogus' with no web tool would otherwise pass both consistency checks.
    expect(() =>
      reg.register(def({ egress: 'bogus' as unknown as RitualDef['egress'] })),
    ).toThrow(/egress/)
  })

  test('non-boolean silent throws (imported-data guard)', () => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    expect(() =>
      reg.register(def({ silent: 'yes' as unknown as RitualDef['silent'] })),
    ).toThrow(/silent/)
  })

  test('non-array tool_surface throws (imported-data guard)', () => {
    const reg = createRitualRegistry({ rituals_dir: '/p' })
    expect(() =>
      reg.register(def({ tool_surface: 'Read' as unknown as RitualDef['tool_surface'] })),
    ).toThrow(/tool_surface/)
  })

  // Coercion guards — RegExp.test stringifies its argument, so a non-string id
  // or tool token would MATCH the charset regex (42 → "42", null → "null") and
  // register under a non-string Map key / freeze a non-string tool grant into
  // the surface that flows to approval hashing + spawn. Both must throw.
  test.each([42, null, undefined, true, {}])(
    'non-string id %p throws (RegExp coercion guard)',
    (badId) => {
      const reg = createRitualRegistry({ rituals_dir: '/p' })
      expect(() =>
        reg.register(def({ id: badId as unknown as RitualDef['id'] })),
      ).toThrow(/RITUAL_ID_RE/)
    },
  )

  test.each([null, undefined, true, 42, {}])(
    'non-string tool_surface entry %p throws (RegExp coercion guard)',
    (badTool) => {
      const reg = createRitualRegistry({ rituals_dir: '/p' })
      expect(() =>
        reg.register(
          def({
            tool_surface: ['Read', badTool] as unknown as RitualDef['tool_surface'],
          }),
        ),
      ).toThrow(/tool token/)
    },
  )
})

describe('validateRitualFire — fail-CLOSED verdicts', () => {
  let root: string
  let reg: ReturnType<typeof createRitualRegistry>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'neutron-rituals-'))
    mkdirSync(join(root, 'rituals'), { recursive: true })
    reg = createRitualRegistry({ rituals_dir: join(root, 'rituals') })
    reg.register(def())
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function writePrompt(id: string, body: string): void {
    writeFileSync(join(root, 'rituals', `${id}.md`), body)
  }

  test('unknown id → unknown_ritual; isApproved NOT called', async () => {
    const approvals = approver(true)
    const v = await validateRitualFire(reg, approvals, 'nope', () => {})
    expect(v).toMatchObject({ ok: false, reason: 'unknown_ritual' })
    expect(approvals.isApproved).not.toHaveBeenCalled()
  })

  test('registered but no prompt file → missing_prompt; isApproved NOT called', async () => {
    const approvals = approver(true)
    const v = await validateRitualFire(reg, approvals, 'morning-brief', () => {})
    expect(v).toMatchObject({ ok: false, reason: 'missing_prompt' })
    expect(approvals.isApproved).not.toHaveBeenCalled()
  })

  test('empty prompt file → missing_prompt', async () => {
    writePrompt('morning-brief', '   \n\t\n')
    const approvals = approver(true)
    const v = await validateRitualFire(reg, approvals, 'morning-brief', () => {})
    expect(v).toMatchObject({ ok: false, reason: 'missing_prompt' })
    expect(approvals.isApproved).not.toHaveBeenCalled()
  })

  test('prompt present + approvals:false → unapproved; called with (def, exact bytes)', async () => {
    const body = '# morning brief\nRITUAL-MARKER-77\n'
    writePrompt('morning-brief', body)
    const approvals = approver(false)
    const v = await validateRitualFire(reg, approvals, 'morning-brief', () => {})
    expect(v).toMatchObject({ ok: false, reason: 'unapproved' })
    expect(approvals.isApproved).toHaveBeenCalledTimes(1)
    expect(approvals.isApproved).toHaveBeenCalledWith(reg.get('morning-brief'), body)
  })

  test('approvals THROWS → unapproved (fail closed); log called once with id + reason', async () => {
    writePrompt('morning-brief', '# body\n')
    const approvals: RitualApprovalCheck = {
      isApproved: () => {
        throw new Error('approval store down')
      },
    }
    const logged: string[] = []
    const v = await validateRitualFire(reg, approvals, 'morning-brief', (m) => logged.push(m))
    expect(v).toMatchObject({ ok: false, reason: 'unapproved' })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('morning-brief')
    expect(logged[0]).toContain('unapproved')
  })

  test('happy path → ok:true with prompt bytes; non-empty tool_surface; no nudge/tools fallback shape', async () => {
    const body = '# morning brief\nRITUAL-MARKER-42\nread STATUS.md\n'
    writePrompt('morning-brief', body)
    const approvals = approver(true)
    const v = await validateRitualFire(reg, approvals, 'morning-brief', () => {})
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.prompt).toContain('RITUAL-MARKER-42')
      expect(v.prompt).toBe(body)
      expect(v.def.tool_surface).toEqual(['Read', 'Glob', 'Grep'])
      expect(v.def.tool_surface.length).toBeGreaterThan(0)
      // Fail-closed contract: the ok verdict carries NO nudge/tools fallback shape.
      expect('tools' in v).toBe(false)
      expect('nudge' in v).toBe(false)
    }
    expect(approvals.isApproved).toHaveBeenCalledWith(reg.get('morning-brief'), body)
  })
})

describe('module constants', () => {
  test('timeout is 45min; model tier is the smart default', () => {
    expect(RITUAL_TIMEOUT_MS).toBe(2_700_000)
    expect(RITUAL_MODEL_TIER).toBe('best')
  })
})

// ── Migration 0106 schema CHECKs (fresh-DB applyMigrations) ───────────────────

describe('migration 0106 — code_subagent_registry agent_kind widening', () => {
  let tmp: string
  let db: ProjectDb

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-ritual-schema-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
  })
  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test("agent_kind 'ritual' inserts; 'bogus' rejected by the live CHECK", () => {
    const raw = db.raw()
    const insert = (kind: string, runId: string) =>
      raw.run(
        `INSERT INTO code_subagent_registry
           (run_id, instance_key, agent_kind, started_at, last_event_at, boot_id)
         VALUES (?, ?, ?, 0, 0, 'boot-1')`,
        [runId, 'inst-1', kind],
      )
    expect(() => insert('ritual', 'r-ritual')).not.toThrow()
    expect(() => insert('bogus', 'r-bogus')).toThrow()
  })
})

describe('migration 0106 — code_ritual_runs CHECKs', () => {
  let tmp: string
  let db: ProjectDb

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-ritual-runs-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
  })
  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function insertRun(cols: Record<string, string | number | null>): void {
    const entries = Object.entries(cols)
    const placeholders = entries.map(() => '?').join(', ')
    const values: (string | number | null)[] = entries.map(([, v]) => v)
    db.raw().run(
      `INSERT INTO code_ritual_runs (${entries.map(([k]) => k).join(', ')}) VALUES (${placeholders})`,
      values,
    )
  }

  test("a valid 'running' row inserts", () => {
    expect(() =>
      insertRun({ run_id: 'run-1', ritual_id: 'morning-brief', status: 'running', started_at: 0 }),
    ).not.toThrow()
  })

  test("status 'bogus' is rejected", () => {
    expect(() =>
      insertRun({ run_id: 'run-2', ritual_id: 'x', status: 'bogus', started_at: 0 }),
    ).toThrow()
  })

  test("'skipped' WITHOUT skip_reason is rejected (invariant CHECK)", () => {
    expect(() =>
      insertRun({ run_id: 'run-3', ritual_id: 'x', status: 'skipped', started_at: 0 }),
    ).toThrow()
  })

  test("'finished' WITH a skip_reason is rejected (invariant CHECK)", () => {
    expect(() =>
      insertRun({
        run_id: 'run-4',
        ritual_id: 'x',
        status: 'finished',
        skip_reason: 'unapproved',
        started_at: 0,
      }),
    ).toThrow()
  })

  test("'skipped' + 'unapproved' inserts", () => {
    expect(() =>
      insertRun({
        run_id: 'run-5',
        ritual_id: 'x',
        status: 'skipped',
        skip_reason: 'unapproved',
        started_at: 0,
      }),
    ).not.toThrow()
  })
})

describe('migration 0106 — the agent_kind rebuild preserves prior rows', () => {
  test('a pre-0106 registry row survives the create-copy-drop-rename field-for-field', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-ritual-rebuild-'))
    const migTmp = mkdtempSync(join(tmpdir(), 'neutron-migs-pre0106-'))
    try {
      // Stage every migration EXCEPT 0106 into a scratch dir, apply them, then
      // insert a legacy registry row, then apply the real dir (0106 rebuilds).
      for (const f of readdirSync(MIGRATIONS_DIR)) {
        if (f === '0106_ritual_schema.sql') continue
        if (!/^\d{4}_.+\.sql$/.test(f)) continue
        cpSync(join(MIGRATIONS_DIR, f), join(migTmp, f))
      }
      const db = ProjectDb.open(join(tmp, 'project.db'))
      try {
        applyMigrations(db.raw(), migTmp)
        db.raw().run(
          `INSERT INTO code_subagent_registry
             (run_id, instance_key, agent_kind, status, spawn_depth, started_at,
              last_event_at, boot_id)
           VALUES ('legacy-1', 'inst-9', 'forge', 'finished', 2, 111, 222, 'boot-legacy')`,
        )

        // Now the real dir — 0000-0105 are already recorded (skipped); 0106 applies.
        const result = applyMigrations(db.raw())
        expect(result.applied).toContain(106)

        const row = db
          .raw()
          .query<
            {
              run_id: string
              instance_key: string
              agent_kind: string
              status: string
              spawn_depth: number
              started_at: number
              last_event_at: number
              boot_id: string
            },
            [string]
          >(`SELECT * FROM code_subagent_registry WHERE run_id = ?`)
          .get('legacy-1')
        expect(row).toMatchObject({
          run_id: 'legacy-1',
          instance_key: 'inst-9',
          agent_kind: 'forge',
          status: 'finished',
          spawn_depth: 2,
          started_at: 111,
          last_event_at: 222,
          boot_id: 'boot-legacy',
        })

        // And 'ritual' now passes the widened CHECK.
        expect(() =>
          db.raw().run(
            `INSERT INTO code_subagent_registry
               (run_id, instance_key, agent_kind, started_at, last_event_at, boot_id)
             VALUES ('ritual-1', 'inst-9', 'ritual', 0, 0, 'boot-new')`,
          ),
        ).not.toThrow()
      } finally {
        db.close()
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(migTmp, { recursive: true, force: true })
    }
  })
})
