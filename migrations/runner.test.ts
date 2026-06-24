import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyMigrations,
  isQuietMigrate,
  loadMigrations,
  summarizeMigrateResult,
} from './runner.ts'

const RUNNER = join(import.meta.dir, 'runner.ts')

// Run the runner as the CLI (`bun run migrations/runner.ts [db-path]`) with a
// controlled environment. cwd is an empty dir so Bun's auto .env load can't
// pull a stray NEUTRON_DB_PATH from the repo root into the resolution.
async function runCli(
  argv: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<number> {
  const proc = Bun.spawn(['bun', 'run', RUNNER, ...argv], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return proc.exited
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-mig-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

test('loadMigrations returns versions in lexicographic (numeric) order', () => {
  const ms = loadMigrations()
  expect(ms.length).toBeGreaterThanOrEqual(4)
  expect(ms[0]?.version).toBe(1)
  expect(ms[0]?.name).toBe('initial_schema')
  expect(ms[1]?.version).toBe(2)
  expect(ms[1]?.name).toBe('workspace_members')
  expect(ms[2]?.version).toBe(3)
  expect(ms[2]?.name).toBe('meters')
  expect(ms[3]?.version).toBe(4)
  expect(ms[3]?.name).toBe('gateway_core')

  const versions = ms.map((m) => m.version)
  for (let i = 1; i < versions.length; i++) {
    const prev = versions[i - 1]
    const cur = versions[i]
    expect(prev !== undefined && cur !== undefined && cur > prev).toBe(true)
  }
})

test('first apply runs all migrations in order and records them in _migrations', () => {
  const db = new Database(join(tmp, 'project.db'), { create: true })
  const result = applyMigrations(db)

  // 0059_syndication_events was deleted in the content-sync mesh rip
  // (connect-spec §2.1) so version 59 is absent from the migration set;
  // versions jump 58 → 60. Versions 64–68 (the C4-a1 forward vocabulary
  // migrations: instance_metadata/connect-instance/project_slug renames +
  // the privacy_mode and legacy-sentinel data moves) were DELETED by the A2
  // migration-collapse — their target state is now emitted directly by the
  // historical CREATEs, so the chain jumps 63 → 69. loadMigrations derives
  // versions from the file prefix and the runner has no contiguity
  // requirement, so these gaps are expected, not a bug.
  expect(result.applied).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
    51, 52, 53, 54, 55, 56, 57, 58, 60, 61, 62, 63, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80,
    81, 82, 83, 84, 85, 86,
  ])
  expect(result.skipped).toEqual([])

  const rows = db
    .query<{ version: number; name: string }, []>(
      'SELECT version, name FROM _migrations ORDER BY version',
    )
    .all()
  expect(rows.map((r) => r.version)).toEqual(result.applied)
  expect(rows[0]?.name).toBe('initial_schema')
  expect(rows[1]?.name).toBe('workspace_members')
  expect(rows[2]?.name).toBe('meters')
  expect(rows[3]?.name).toBe('gateway_core')
  expect(rows[4]?.name).toBe('topics_partial_unique')
  expect(rows[5]?.name).toBe('topic_origins')
  expect(rows[6]?.name).toBe('reverse_promotions')
  expect(rows[7]?.name).toBe('reverse_promotions_pk_scope')
  expect(rows[8]?.name).toBe('p15_onboarding_prereqs')
  expect(rows[9]?.name).toBe('p2_button_prompts')
  expect(rows[10]?.name).toBe('p2_onboarding_state')
  expect(rows[11]?.name).toBe('p2_imports')
  expect(rows[12]?.name).toBe('p2_wow_events')
  expect(rows[13]?.name).toBe('p2_profile_pic')
  expect(rows[14]?.name).toBe('p2_max_subs')
  expect(rows[15]?.name).toBe('p2_invites')
  expect(rows[16]?.name).toBe('p2_onboarding_metrics')
  expect(rows[17]?.name).toBe('p2_sean_ellis')
  expect(rows[18]?.name).toBe('p2_sean_ellis_prompt_link')
  expect(rows[19]?.name).toBe('button_prompts_kind')
  expect(rows[20]?.name).toBe('p3_cores_runtime')
  expect(rows[21]?.name).toBe('signup_consumed_tokens')
  expect(rows[22]?.name).toBe('p2_onboarding_attempt_id')
  expect(rows[23]?.name).toBe('pending_redirects')
  expect(rows[24]?.name).toBe('p2_v2_phase_rename')
  expect(rows[25]?.name).toBe('p2_v2_import_results_interests_confidence')
  expect(rows[26]?.name).toBe('p2_v2_wow_action_rename')
  expect(rows[27]?.name).toBe('reminders_recurrence')
  expect(rows[28]?.name).toBe('p2_v2_onboarding_metrics_view_v2')
  expect(rows[29]?.name).toBe('p2_v2_import_results_synthesizer_model')
  expect(rows[30]?.name).toBe('reminders_source')
  expect(rows[31]?.name).toBe('tasks_canonical')
  expect(rows[32]?.name).toBe('device_push_tokens')
  expect(rows[33]?.name).toBe('p2_onboarding_state_user_pk')
  expect(rows[34]?.name).toBe('cores_oauth_pending')
  expect(rows[35]?.name).toBe('core_installations_install_state')

  const topics = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='topics'",
    )
    .get()
  expect(topics?.name).toBe('topics')

  const reminders = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='reminders'",
    )
    .get()
  expect(reminders?.name).toBe('reminders')

  // P6.0 — canonical task DB substrate (migration 0032). Verify the table
  // + both indexes land.
  const tasks = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'",
    )
    .get()
  expect(tasks?.name).toBe('tasks')
  const tasksProjectIdx = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_project_slug_project_status'",
    )
    .get()
  expect(tasksProjectIdx?.name).toBe('idx_tasks_project_slug_project_status')
  const tasksDueIdx = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_project_due_date'",
    )
    .get()
  expect(tasksDueIdx?.name).toBe('idx_tasks_project_due_date')

  const approvals = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tool_approvals'",
    )
    .get()
  expect(approvals?.name).toBe('tool_approvals')

  // P5.6 — device push token store (migration 0033). Verify the table +
  // both indexes land so an instance DB at HEAD can store and fan out
  // Expo push tokens for the reminder-fired hook.
  const devicePushTokens = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='device_push_tokens'",
    )
    .get()
  expect(devicePushTokens?.name).toBe('device_push_tokens')
  const devicePushTokensTokenIdx = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_device_push_tokens_project_token'",
    )
    .get()
  expect(devicePushTokensTokenIdx?.name).toBe('idx_device_push_tokens_project_token')
  const devicePushTokensUserIdx = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_device_push_tokens_project_user'",
    )
    .get()
  expect(devicePushTokensUserIdx?.name).toBe('idx_device_push_tokens_project_user')

  const sessions = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
    )
    .get()
  expect(sessions?.name).toBe('sessions')

  const members = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_members'",
    )
    .get()
  expect(members?.name).toBe('workspace_members')

  const meters = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='meters'",
    )
    .get()
  expect(meters?.name).toBe('meters')

  const fts = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'",
    )
    .get()
  expect(fts?.name).toBe('messages_fts')

  // P2 S6 surfaces — verify the new tables + view land alongside the
  // versions assertion so any future drift is caught at the table level.
  const gateway_events = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='gateway_events'",
    )
    .get()
  expect(gateway_events?.name).toBe('gateway_events')

  const sean_ellis = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sean_ellis_responses'",
    )
    .get()
  expect(sean_ellis?.name).toBe('sean_ellis_responses')

  const onboarding_metrics_view = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='view' AND name='onboarding_metrics'",
    )
    .get()
  expect(onboarding_metrics_view?.name).toBe('onboarding_metrics')

  db.close()
})

test('second apply on the same DB is idempotent (zero new applies)', () => {
  const dbPath = join(tmp, 'project.db')
  const db1 = new Database(dbPath, { create: true })
  const first = applyMigrations(db1)
  db1.close()

  const db2 = new Database(dbPath)
  const second = applyMigrations(db2)
  expect(second.applied).toEqual([])
  expect(second.skipped).toEqual(first.applied)

  const count = db2
    .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM _migrations')
    .get()
  expect(count?.c).toBe(first.applied.length)
  db2.close()
})

test('applied row has applied_at populated', () => {
  const db = new Database(join(tmp, 'project.db'), { create: true })
  applyMigrations(db)
  const row = db
    .query<{ applied_at: number }, []>('SELECT applied_at FROM _migrations WHERE version = 1')
    .get()
  expect(typeof row?.applied_at).toBe('number')
  expect(row?.applied_at).toBeGreaterThan(0)
  db.close()
})

// Regression for codex review (Sprint 1 P1) — fresh connections used to skip `PRAGMA foreign_keys`,
// so the REFERENCES + CASCADE constraints declared by 0001_initial_schema.sql were inert and
// orphaned `messages` rows could survive their parent session.
test('applyMigrations enables FK enforcement on every fresh connection', () => {
  const db = new Database(join(tmp, 'project.db'), { create: true })
  applyMigrations(db)

  const fk = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()
  expect(fk?.foreign_keys).toBe(1)

  expect(() => {
    db.run(
      `INSERT INTO messages (session_id, role, timestamp) VALUES (?, ?, ?)`,
      ['no-such-session', 'user', Date.now() / 1000],
    )
  }).toThrow(/FOREIGN KEY/i)

  db.close()
})

// Regression for codex review (Sprint 1 P2) — applyMigrations used to exec the SQL file then
// insert into _migrations as separate statements, leaving an instance DB partially migrated when
// any statement after the first succeeded but a later one failed.
test('applyMigrations rolls back the whole migration on mid-file failure', () => {
  const dir = join(tmp, 'migrations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '0001_partial_failure.sql'),
    `CREATE TABLE foo (id INTEGER PRIMARY KEY);
     INSERT INTO no_such_table (x) VALUES (1);`,
  )

  const db = new Database(join(tmp, 'project.db'), { create: true })
  expect(() => applyMigrations(db, dir)).toThrow()

  const fooRow = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='foo'",
    )
    .get()
  expect(fooRow).toBeNull()

  const migRow = db
    .query<{ version: number }, []>('SELECT version FROM _migrations WHERE version = 1')
    .get()
  expect(migRow).toBeNull()

  db.close()
})

// The documented quickstart runs a BARE `bun run migrate` (no db-path arg). It
// must succeed — resolving the same file the server opens (resolveOpenDbPath) —
// not exit 2 against an unspecified path, and not depend on the parent dir
// already existing.
test('CLI with no db-path arg defaults to <NEUTRON_HOME>/project.db and migrates it', async () => {
  const home = join(tmp, 'home', 'neutron') // does not exist yet — runner must mkdir it
  const cwd = join(tmp, 'cwd')
  mkdirSync(cwd, { recursive: true })
  const code = await runCli([], { HOME: join(tmp, 'home'), NEUTRON_HOME: home }, cwd)
  expect(code).toBe(0)
  expect(existsSync(join(home, 'project.db'))).toBe(true)
})

// A pinned NEUTRON_DB_PATH (the same env var Bun loads from .env) wins, and the
// runner creates its parent directory so a fresh pin works on first run.
test('CLI with no arg honors NEUTRON_DB_PATH and creates its parent dir', async () => {
  const pinned = join(tmp, 'pinned', 'nested', 'db.sqlite')
  const cwd = join(tmp, 'cwd2')
  mkdirSync(cwd, { recursive: true })
  const code = await runCli([], { HOME: join(tmp, 'home2'), NEUTRON_DB_PATH: pinned }, cwd)
  expect(code).toBe(0)
  expect(existsSync(pinned)).toBe(true)
})

// An explicit db-path arg still wins over the resolved default (install.sh
// passes one).
test('CLI with an explicit db-path arg migrates exactly that file', async () => {
  const explicit = join(tmp, 'explicit.db')
  const cwd = join(tmp, 'cwd3')
  mkdirSync(cwd, { recursive: true })
  const code = await runCli([explicit], { HOME: join(tmp, 'home3'), NEUTRON_HOME: join(tmp, 'unused') }, cwd)
  expect(code).toBe(0)
  expect(existsSync(explicit)).toBe(true)
  // The resolved default must NOT have been touched.
  expect(existsSync(join(tmp, 'unused', 'project.db'))).toBe(false)
})

// ── Quiet/summary mode (install.sh, P1) ──────────────────────────────────────

test('isQuietMigrate honors NEUTRON_MIGRATE_QUIET=1/true and nothing else', () => {
  expect(isQuietMigrate({ NEUTRON_MIGRATE_QUIET: '1' })).toBe(true)
  expect(isQuietMigrate({ NEUTRON_MIGRATE_QUIET: 'true' })).toBe(true)
  expect(isQuietMigrate({ NEUTRON_MIGRATE_QUIET: '0' })).toBe(false)
  expect(isQuietMigrate({ NEUTRON_MIGRATE_QUIET: 'yes' })).toBe(false)
  expect(isQuietMigrate({})).toBe(false)
})

test('summarizeMigrateResult renders a single clean ✓ line', () => {
  expect(summarizeMigrateResult({ applied: [], skipped: [1, 2] })).toBe(
    '✓ database ready (already up to date)',
  )
  expect(summarizeMigrateResult({ applied: [1], skipped: [] })).toBe(
    '✓ database ready (1 migration applied)',
  )
  expect(summarizeMigrateResult({ applied: [1, 2, 3], skipped: [] })).toBe(
    '✓ database ready (3 migrations applied)',
  )
})

// Capture variant of runCli — returns exit code + trimmed stdout so the quiet
// CLI path can be asserted end-to-end (this is what install.sh shows the user).
async function runCliCapture(
  argv: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(['bun', 'run', RUNNER, ...argv], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = (await new Response(proc.stdout).text()).trim()
  const code = await proc.exited
  return { code, stdout }
}

test('CLI with NEUTRON_MIGRATE_QUIET=1 prints the one-line summary, not JSON', async () => {
  const explicit = join(tmp, 'quiet.db')
  const cwd = join(tmp, 'cwd-quiet')
  mkdirSync(cwd, { recursive: true })
  const { code, stdout } = await runCliCapture(
    [explicit],
    { HOME: join(tmp, 'home-quiet'), NEUTRON_MIGRATE_QUIET: '1' },
    cwd,
  )
  expect(code).toBe(0)
  // The clean install line — no raw {"applied":[...]} JSON dump.
  expect(stdout).toMatch(/^✓ database ready \(\d+ migrations? applied\)$/)
  expect(stdout).not.toContain('"applied"')
})

test('CLI WITHOUT the quiet flag keeps the raw JSON output (standalone/debug)', async () => {
  const explicit = join(tmp, 'loud.db')
  const cwd = join(tmp, 'cwd-loud')
  mkdirSync(cwd, { recursive: true })
  const { code, stdout } = await runCliCapture(
    [explicit],
    { HOME: join(tmp, 'home-loud') },
    cwd,
  )
  expect(code).toBe(0)
  expect(stdout).toContain('"applied"')
  expect(JSON.parse(stdout)).toHaveProperty('applied')
})
