/**
 * A DEAD RUN MUST NOT HOLD ITS NAME FOREVER.
 *
 * THE DEFECT (owner-hit 2026-08-11, ISSUES #530). `slugifyTask` derives the slug
 * from a task's first 35 characters, and the unique index covered EVERY row with
 * no phase predicate — so a task whose opening words matched a prior run's could
 * not be dispatched at all, including when that prior run was cancelled or failed.
 * "Retry the thing that just broke, unchanged" was structurally impossible, and it
 * is the most common thing an owner does after a failure. He worked around it by
 * rewording his task; the dispatch had died on
 * `UNIQUE constraint failed: code_trident_runs.project_slug, code_trident_runs.slug`.
 *
 * The intent — one LIVE run per task per project — is preserved and asserted here
 * too, because a fix that let two concurrent runs of the same task race would be a
 * worse bug than the one it replaces.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

let tmp: string
let db: ProjectDb
const SLUG = 'email-pipeline-p1'
const PROJ = 'neutron-open'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-slug-retry-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

let seq = 0
/** Insert a run row directly — this is an INDEX test, not a store test. */
function insertRun(phase: string, slug = SLUG): void {
  seq += 1
  db.prepare<never, [string, string, string, string, string, string, string]>(
    `INSERT INTO code_trident_runs
       (id, slug, project_slug, phase, round, max_rounds, ralph, ralph_round,
        max_ralph_rounds, merge_mode, repo_path, task, started_at, last_advanced_at)
     VALUES (?, ?, ?, ?, 1, 3, 0, 0, 20, 'pr', '/repo', ?, ?, ?)`,
  ).run(`run-${seq}`, slug, PROJ, phase, 'a task', '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z')
}

describe('slug uniqueness applies to LIVE runs only', () => {
  for (const terminal of ['done', 'failed', 'stopped']) {
    test(`a NEW run reuses the slug of a ${terminal} run — this is the retry the owner could not do`, () => {
      insertRun(terminal)
      expect(() => insertRun('forge-init')).not.toThrow()
    })
  }

  test('two LIVE runs of the same task still COLLIDE — the idempotency intent is preserved', () => {
    // The original index existed for this and it still must hold: a double-dispatch
    // of the same task is refused rather than racing itself. A fix that allowed this
    // would be a worse bug than the one it replaces.
    insertRun('forge-init')
    expect(() => insertRun('argus')).toThrow()
  })

  test('MANY dead runs do not accumulate into a block — retry works repeatedly', () => {
    // The real shape of his day: fail, retry, fail, retry. Each attempt leaves
    // another terminal row behind, and none of them may hold the name.
    insertRun('failed')
    insertRun('stopped')
    insertRun('done')
    expect(() => insertRun('forge-init')).not.toThrow()
  })

  test('a different slug is unaffected', () => {
    insertRun('forge-init')
    expect(() => insertRun('forge-init', 'a-different-task')).not.toThrow()
  })

  test('the same slug on a DIFFERENT project is unaffected', () => {
    insertRun('forge-init')
    seq += 1
    expect(() =>
      db
        .prepare<never, [string, string, string, string, string, string, string]>(
          `INSERT INTO code_trident_runs
             (id, slug, project_slug, phase, round, max_rounds, ralph, ralph_round,
              max_ralph_rounds, merge_mode, repo_path, task, started_at, last_advanced_at)
           VALUES (?, ?, ?, ?, 1, 3, 0, 0, 20, 'pr', '/repo', ?, ?, ?)`,
        )
        .run(`run-${seq}`, SLUG, 'other-project', 'forge-init', 't', '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'),
    ).not.toThrow()
  })
})
