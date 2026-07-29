import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyProjectScopedMigrations } from '@neutronai/migrations/runner.ts'
import {
  CODE_GEN_SCHEMA_VERSION,
  CodegenSidecarMismatchError,
  CodegenSidecarResolver,
  DEFAULT_MIGRATIONS_DIR,
} from '../src/sidecar/store.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'codegen-sidecar-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('CodegenSidecarResolver — schema round-trip', () => {
  test('first resolve creates db + applies migrations + writes code_gen_meta @ schema v2', async () => {
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    const sidecar = await resolver.resolve('proj-a')
    expect(sidecar.project_id).toBe('proj-a')
    expect(sidecar.db_path.endsWith('code-gen/code-gen.db')).toBe(true)
    // Settings bootstrap. The S1 `automerge_enabled` gate column was
    // dropped in 0002; the bootstrap row carries only the remaining
    // scalar settings.
    const s = sidecar.settings.get()
    expect(s.default_branch).toBe('main')
    expect(s.max_argus_rounds).toBe(8)
    expect((s as unknown as Record<string, unknown>)['automerge_enabled']).toBeUndefined()
    // schema_version reflects the v2 migration.
    expect(CODE_GEN_SCHEMA_VERSION).toBe(2)
    resolver.closeAll()
  })

  test('second resolve returns the cached handle', async () => {
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    const first = await resolver.resolve('proj-a')
    const second = await resolver.resolve('proj-a')
    expect(first).toBe(second)
    resolver.closeAll()
  })
})

describe('CodegenSidecar — task CRUD', () => {
  test('insert + get + update + list', async () => {
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    const sidecar = await resolver.resolve('proj-a')
    sidecar.tasks.insert({ task_id: 't1', request: 'add foo', status: 'pending' })
    sidecar.tasks.insert({ task_id: 't2', request: 'add bar', status: 'running' })
    const t1 = sidecar.tasks.get('t1')
    expect(t1?.status).toBe('pending')
    expect(t1?.request).toBe('add foo')
    expect(t1?.runner_kind).toBe('runtime')
    expect(t1?.project_id).toBe('proj-a')
    sidecar.tasks.update('t1', { status: 'completed', pr_number: 99, branch: 'feat/foo' })
    const t1b = sidecar.tasks.get('t1')
    expect(t1b?.status).toBe('completed')
    expect(t1b?.pr_number).toBe(99)
    expect(t1b?.branch).toBe('feat/foo')
    const list = sidecar.tasks.list({ limit: 10 })
    expect(list).toHaveLength(2)
    // updated_at DESC means t1 (just updated) appears first.
    expect(list[0]?.task_id).toBe('t1')
    expect(list[1]?.task_id).toBe('t2')
    resolver.closeAll()
  })

  test('findByPr returns the most-recent matching row', async () => {
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    const sidecar = await resolver.resolve('proj-a')
    sidecar.tasks.insert({ task_id: 't1', request: 'x', status: 'completed' })
    sidecar.tasks.update('t1', { pr_number: 5, worktree: '/tmp/x' })
    const found = sidecar.tasks.findByPr(5)
    expect(found?.task_id).toBe('t1')
    expect(found?.pr_number).toBe(5)
    expect(found?.worktree).toBe('/tmp/x')
    resolver.closeAll()
  })
})

describe('CodegenSidecar — settings round-trip', () => {
  test('settings.get bootstraps a default row with no automerge column', async () => {
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    const sidecar = await resolver.resolve('proj-a')
    const s = sidecar.settings.get()
    expect(s.default_branch).toBe('main')
    expect(s.max_argus_rounds).toBe(8)
    expect(s.subagent_timeout_ms).toBe(1_800_000)
    // S2: the `automerge_enabled` gate is gone — neither the row nor
    // the type surfaces it.
    expect((s as unknown as Record<string, unknown>)['automerge_enabled']).toBeUndefined()
    resolver.closeAll()
  })

  test('update writes scalar fields', async () => {
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    const sidecar = await resolver.resolve('proj-a')
    sidecar.settings.update({ repo_slug: 'foo-repo', gh_owner: 'me', max_argus_rounds: 3 })
    const s = sidecar.settings.get()
    expect(s.repo_slug).toBe('foo-repo')
    expect(s.gh_owner).toBe('me')
    expect(s.max_argus_rounds).toBe(3)
    resolver.closeAll()
  })
})

describe('CodegenSidecar — transcripts + audit append', () => {
  test('append + listForTask', async () => {
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    const sidecar = await resolver.resolve('proj-a')
    sidecar.tasks.insert({ task_id: 't1', request: 'x', status: 'running' })
    sidecar.transcripts.append({
      task_id: 't1',
      role: 'forge',
      prompt_hash: 'abc',
      response_excerpt: 'PR_NUMBER=1',
      model: 'sonnet-4-6',
      outcome: 'completed',
    })
    sidecar.transcripts.append({
      task_id: 't1',
      role: 'argus',
      prompt_hash: 'def',
      response_excerpt: 'APPROVE',
      model: 'sonnet-4-6',
      outcome: 'completed',
    })
    const rows = sidecar.transcripts.listForTask('t1')
    expect(rows).toHaveLength(2)
    resolver.closeAll()
  })

  test('audit.append + countForPr', async () => {
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    const sidecar = await resolver.resolve('proj-a')
    sidecar.audit.append({
      task_id: null,
      pr_number: 5,
      who_confirmed: 'user_confirm_token',
      gh_response_excerpt: 'merged',
    })
    expect(sidecar.audit.countForPr(5)).toBe(1)
    expect(sidecar.audit.countForPr(99)).toBe(0)
    resolver.closeAll()
  })

  test("audit.append accepts the S2 'autonomous' attribution", async () => {
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    const sidecar = await resolver.resolve('proj-a')
    sidecar.audit.append({
      task_id: null,
      pr_number: 7,
      who_confirmed: 'autonomous',
      gh_response_excerpt: 'merged via gh',
    })
    expect(sidecar.audit.countForPr(7)).toBe(1)
    resolver.closeAll()
  })
})

describe('CodegenSidecarMismatchError — copy-leak detection', () => {
  test('opening a sidecar against a wrong project_id throws', async () => {
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    await resolver.resolve('proj-a')
    resolver.closeAll()
    // Now try to open the SAME on-disk file as a different project_id.
    // The resolver caches by project_id, so we use a fresh resolver
    // pointed at a project root that maps to the same on-disk path —
    // approximated via resolveProjectRoot:
    const resolver2 = new CodegenSidecarResolver({
      owner_home: tmp,
      resolveProjectRoot: () => join(tmp, 'Projects', 'proj-a'),
    })
    await expect(resolver2.resolve('proj-b')).rejects.toBeInstanceOf(CodegenSidecarMismatchError)
    resolver2.closeAll()
  })
})

describe('0002 migration — drops automerge_enabled + widens who_confirmed CHECK', () => {
  test('S1-only sidecar → apply 0002 → automerge_enabled column is gone, autonomous attribution accepted', () => {
    // Build a sidecar at S1 by pointing applyProjectScopedMigrations at
    // a directory containing ONLY 0001*.sql (copy from the real
    // migrations dir).
    const s1Dir = join(tmp, 'mig-s1-only')
    mkdirSync(s1Dir, { recursive: true })
    const s1Path = join(DEFAULT_MIGRATIONS_DIR, '0001_code_tasks_settings_transcripts_audit.sql')
    writeFileSync(
      join(s1Dir, '0001_code_tasks_settings_transcripts_audit.sql'),
      readFileSync(s1Path, 'utf8'),
    )

    const dbPath = join(tmp, 's1-then-s2.db')
    const db = new Database(dbPath, { create: true })
    db.exec('PRAGMA foreign_keys = ON')
    applyProjectScopedMigrations(db, s1Dir)

    // At S1 the automerge_enabled column SHOULD exist.
    const colsBefore = db
      .query<{ name: string }, []>('PRAGMA table_info(code_settings)')
      .all()
      .map((r) => r.name)
    expect(colsBefore).toContain('automerge_enabled')

    // Seed a row in code_settings so the migration's INSERT-SELECT
    // copies real data, and a code_merge_audit row using one of the S1
    // attribution values so the audit-recreate carries it across.
    db.run(
      `INSERT INTO code_settings (project_id, automerge_enabled, default_branch, repo_slug, gh_owner, max_argus_rounds, subagent_timeout_ms, updated_at) VALUES (?, 1, 'main', 'r', 'me', 5, 600000, ?)`,
      ['proj-x', Date.now()],
    )
    db.run(
      `INSERT INTO code_merge_audit (id, task_id, pr_number, merge_strategy, merged_at, who_confirmed, gh_response_excerpt) VALUES (?, NULL, 11, 'squash', ?, 'automerge_gate', 'ok')`,
      ['aud-1', Date.now()],
    )

    // Now apply BOTH migrations (0001 will be skipped per _migrations).
    applyProjectScopedMigrations(db, DEFAULT_MIGRATIONS_DIR)

    const colsAfter = db
      .query<{ name: string }, []>('PRAGMA table_info(code_settings)')
      .all()
      .map((r) => r.name)
    expect(colsAfter).not.toContain('automerge_enabled')
    expect(colsAfter).toContain('project_id')
    expect(colsAfter).toContain('default_branch')
    expect(colsAfter).toContain('max_argus_rounds')

    // The seed row survived the table swap.
    const row = db
      .query<{ project_id: string; default_branch: string; max_argus_rounds: number }, []>(
        'SELECT project_id, default_branch, max_argus_rounds FROM code_settings',
      )
      .get()
    expect(row?.project_id).toBe('proj-x')
    expect(row?.default_branch).toBe('main')
    expect(row?.max_argus_rounds).toBe(5)

    // Historical audit row carried over.
    const audCount = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM code_merge_audit`)
      .get()
    expect(audCount?.n).toBe(1)

    // 'autonomous' is now a valid CHECK enum value.
    db.run(
      `INSERT INTO code_merge_audit (id, task_id, pr_number, merge_strategy, merged_at, who_confirmed, gh_response_excerpt) VALUES (?, NULL, 12, 'squash', ?, 'autonomous', 'ok')`,
      ['aud-2', Date.now()],
    )
    const audCount2 = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM code_merge_audit WHERE who_confirmed = 'autonomous'`)
      .get()
    expect(audCount2?.n).toBe(1)

    db.close()
  })
})

