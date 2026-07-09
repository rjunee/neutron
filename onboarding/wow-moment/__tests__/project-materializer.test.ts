/**
 * Unit tests for the Item 4 project materializer.
 *
 * Covers the failure-isolation + idempotency contract (spec § 4.2):
 * deterministic fallback on composer failure, git failure never sinks
 * the doc set, indexer failure is swallowed, a second run is a strict
 * no-op that never clobbers user edits, and slicing matches only
 * project-related chunks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  buildProjectMaterializer,
  mapBounded,
  TRANSCRIPT_SLICES_RELPATH,
  TRANSCRIPT_SUMMARY_RELPATH,
  type ProjectMaterializerDeps,
} from '../project-materializer.ts'
import type { ImportResult } from '../../history-import/types.ts'

let dir: string
let db: ProjectDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'materializer-'))
  db = ProjectDb.open(join(dir, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** No-op git so unit tests stay subprocess-free (git itself is covered
 *  by the action-level reproduce test). */
const noopGit = async (): Promise<void> => {}

function buildDeps(overrides: Partial<ProjectMaterializerDeps> = {}): ProjectMaterializerDeps {
  return {
    owner_home: dir,
    project_slug: 't1',
    db,
    now: () => 1_700_000_000_000,
    runGit: noopGit,
    logFailure: () => {},
    ...overrides,
  }
}

function emptyImport(): ImportResult {
  return {
    entities: [],
    topics: [],
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {},
    facts: {},
  }
}

function seedChunk(input: {
  hash: string
  conversation_id: string
  text: string
  entities?: string[]
  topics?: string[]
  analyzed?: number
}): void {
  db.raw().run(
    `INSERT INTO import_pass1_chunks
       (project_slug, source, chunk_hash, job_id, conversation_id, chunk_index,
        chunk_byte_length, candidate_entities_json, candidate_topics_json,
        candidate_tasks_json, voice_signals_json, dollars_billed, analyzed_at,
        analyzed, chunk_text)
     VALUES ('t1', 'chatgpt-zip', ?, 'job-1', ?, 0, ?, ?, ?, '[]', '{}', 0, 1700000000, ?, ?)`,
    [
      input.hash,
      input.conversation_id,
      Buffer.byteLength(input.text, 'utf8'),
      JSON.stringify((input.entities ?? []).map((name) => ({ name }))),
      JSON.stringify((input.topics ?? []).map((name) => ({ name }))),
      input.analyzed ?? 1,
      input.text,
    ],
  )
}

describe('project-materializer', () => {
  test('second run is a strict no-op and never clobbers user edits', async () => {
    const m = buildProjectMaterializer(buildDeps())
    const input = {
      project: { name: 'Topline', rationale: 'Billing SaaS.' },
      slug: 'topline',
      import_result: null,
    }
    const first = await m.materialize(input)
    expect(first.reason).toBe('created')
    expect(first.docs_written).toContain('README.md')
    expect(first.docs_written).toContain('STATUS.md')

    // User edits the README between runs.
    const readmePath = join(dir, 'Projects', 'topline', 'README.md')
    writeFileSync(readmePath, '# Topline\n\nMY OWN EDIT\n', 'utf8')

    const second = await m.materialize(input)
    expect(second.reason).toBe('already_materialized')
    expect(second.docs_written).toEqual([])
    expect(readFileSync(readmePath, 'utf8')).toContain('MY OWN EDIT')
  })

  test('composer failure falls back to the deterministic template', async () => {
    const m = buildProjectMaterializer(
      buildDeps({
        composer: async () => {
          throw new Error('substrate down')
        },
      }),
    )
    const out = await m.materialize({
      project: { name: 'Topline', rationale: 'Billing SaaS.' },
      slug: 'topline',
      import_result: null,
    })
    expect(out.reason).toBe('created')
    expect(out.llm_docs).toBe(false)
    const readme = readFileSync(join(dir, 'Projects', 'topline', 'README.md'), 'utf8')
    expect(readme).toContain('Billing SaaS')
  })

  test('git failure never sinks the doc set', async () => {
    const m = buildProjectMaterializer(
      buildDeps({
        runGit: async () => {
          throw new Error('git: command not found')
        },
      }),
    )
    const out = await m.materialize({
      project: { name: 'Topline' },
      slug: 'topline',
      import_result: null,
    })
    expect(out.reason).toBe('created')
    expect(out.git_ok).toBe(false)
    expect(existsSync(join(dir, 'Projects', 'topline', 'STATUS.md'))).toBe(true)
  })

  test('indexer failure is swallowed; success marks indexed', async () => {
    const failing = buildProjectMaterializer(
      buildDeps({
        indexer: async () => {
          throw new Error('gbrain offline')
        },
      }),
    )
    const failed = await failing.materialize({
      project: { name: 'Topline' },
      slug: 'topline',
      import_result: null,
    })
    expect(failed.reason).toBe('created')
    expect(failed.indexed).toBe(false)

    const pages: string[] = []
    const ok = buildProjectMaterializer(
      buildDeps({
        indexer: async (input) => {
          pages.push(input.body)
        },
      }),
    )
    const succeeded = await ok.materialize({
      project: { name: 'Northwind Labs', rationale: 'Consumer brand launch.' },
      slug: 'northwind-labs',
      import_result: null,
    })
    expect(succeeded.indexed).toBe(true)
    expect(pages[0] ?? '').toContain('Northwind Labs')
    expect(pages[0] ?? '').toContain('Projects/northwind-labs/')
  })

  test('slices only project-related chunks; skips unanalyzed rows; summary only with slices', async () => {
    seedChunk({
      hash: 'h1',
      conversation_id: 'c1',
      text: 'Topline dunning emails cut churn.',
      entities: ['Topline'],
    })
    seedChunk({
      hash: 'h2',
      conversation_id: 'c2',
      text: 'Sourdough hydration notes.',
      topics: ['Baking'],
    })
    seedChunk({
      hash: 'h3',
      conversation_id: 'c3',
      text: 'Topline pricing draft (unfinalized placeholder).',
      entities: ['Topline'],
      analyzed: 0,
    })

    const m = buildProjectMaterializer(buildDeps())
    const out = await m.materialize({
      project: { name: 'Topline' },
      slug: 'topline',
      import_result: emptyImport(),
    })
    expect(out.slice_chunk_count).toBe(1)
    expect(out.summary_written).toBe(true)
    const slices = readFileSync(
      join(dir, 'Projects', 'topline', TRANSCRIPT_SLICES_RELPATH),
      'utf8',
    )
    expect(slices).toContain('dunning emails')
    expect(slices).not.toContain('Sourdough')
    expect(slices).not.toContain('unfinalized placeholder')

    // A signal-free project gets no slices, no transcripts dir, no summary.
    const none = await m.materialize({
      project: { name: 'Gardening' },
      slug: 'gardening',
      import_result: emptyImport(),
    })
    expect(none.slice_chunk_count).toBe(0)
    expect(none.summary_written).toBe(false)
    expect(
      existsSync(join(dir, 'Projects', 'gardening', TRANSCRIPT_SUMMARY_RELPATH)),
    ).toBe(false)
  })

  test('STATUS.md carries the § 4 frontmatter with a quoted one_liner', async () => {
    const m = buildProjectMaterializer(buildDeps())
    await m.materialize({
      project: { name: 'Topline', rationale: 'Billing SaaS: "the money one".' },
      slug: 'topline',
      import_result: null,
    })
    const status = readFileSync(join(dir, 'Projects', 'topline', 'STATUS.md'), 'utf8')
    expect(status).toContain('name: topline')
    expect(status).toContain('status: active')
    expect(status).toContain('priority: P2')
    expect(status).toContain('remote: local')
    expect(status).toContain('last_updated: 2023-11-14')
    // JSON-quoted so embedded quotes/colons stay YAML-safe.
    expect(status).toContain('one_liner: "Billing SaaS: \\"the money one\\"."')
  })

  // ── No-context data-sufficiency gate (2026-07-01 SEV1) ────────────────────

  test('a NO-CONTEXT project gets a MINIMAL STATUS.md + no overnight machinery', async () => {
    const m = buildProjectMaterializer(buildDeps())
    // Thin chat answer: no rationale, no import, no slices → no real context.
    const out = await m.materialize({
      project: { name: 'Mystery' },
      slug: 'mystery',
      import_result: null,
    })
    expect(out.reason).toBe('created')
    expect(out.has_context).toBe(false)
    const status = readFileSync(join(dir, 'Projects', 'mystery', 'STATUS.md'), 'utf8')
    // Clean frontmatter, empty one_liner, one honest body line.
    expect(status).toContain('name: mystery')
    expect(status).toContain('one_liner: ""')
    expect(status).toContain('Created during onboarding - no context yet.')
    // NO overnight opt-in, NO overnight section, NO phantom seed task.
    expect(status).not.toContain('autonomous_overnight_enabled')
    expect(status).not.toContain('Autonomous Overnight Work')
    expect(status).not.toContain('Deepen + analyze')
    // No em dashes (Sam hard rule).
    expect(status).not.toContain('—')
    // The overnight seed-context doc is NOT written for a no-context project.
    expect(existsSync(join(dir, 'Projects', 'mystery', 'docs', 'overnight', 'seed-context.md'))).toBe(
      false,
    )
  })

  test('a project WITH context keeps the full STATUS.md + overnight opt-in + seed doc', async () => {
    const m = buildProjectMaterializer(buildDeps())
    const out = await m.materialize({
      project: { name: 'Topline', rationale: 'Billing SaaS the owner ships.' },
      slug: 'topline',
      import_result: null,
    })
    expect(out.has_context).toBe(true)
    const status = readFileSync(join(dir, 'Projects', 'topline', 'STATUS.md'), 'utf8')
    expect(status).toContain('autonomous_overnight_enabled: true')
    expect(status).toContain('## Autonomous Overnight Work')
    expect(status).toContain('Deepen + analyze Topline from imported context')
    expect(existsSync(join(dir, 'Projects', 'topline', 'docs', 'overnight', 'seed-context.md'))).toBe(
      true,
    )
  })

  test('repair path: a transient git/index failure on the first run self-heals on re-fire', async () => {
    // First run: git AND indexer both fail transiently.
    let gitCalls: string[][] = []
    const failing = buildProjectMaterializer(
      buildDeps({
        runGit: async () => {
          throw new Error('git: transient failure')
        },
        indexer: async () => {
          throw new Error('gbrain offline')
        },
      }),
    )
    const input = {
      project: { name: 'Topline', rationale: 'Billing SaaS.' },
      slug: 'topline',
      import_result: null,
    }
    const first = await failing.materialize(input)
    expect(first.reason).toBe('created')
    expect(first.git_ok).toBe(false)
    expect(first.indexed).toBe(false)

    // Re-fire (overnight pass): same project, deps now healthy.
    const indexed: string[] = []
    const healed = buildProjectMaterializer(
      buildDeps({
        runGit: async (args) => {
          gitCalls.push(args)
        },
        indexer: async (i) => {
          indexed.push(i.project_slug)
        },
      }),
    )
    const second = await healed.materialize(input)
    expect(second.reason).toBe('already_materialized')
    // Git repaired (init ran — .git was never created by the failing run)…
    expect(gitCalls.some((args) => args[0] === 'init')).toBe(true)
    expect(second.git_ok).toBe(true)
    // …and the idempotent index re-ran.
    expect(indexed).toEqual(['topline'])
    expect(second.indexed).toBe(true)
    // Docs were NOT rewritten (no clobber).
    expect(second.docs_written).toEqual([])

    // Third pass over a HEALTHY repo: rev-parse verifies, no add/commit.
    // (The recorder stub never touched disk, so fake the .git dir the
    // real runner would have created; the stub's no-throw rev-parse
    // models a repo with a valid HEAD.)
    mkdirSync(join(dir, 'Projects', 'topline', '.git'), { recursive: true })
    gitCalls = []
    const third = await healed.materialize(input)
    expect(third.reason).toBe('already_materialized')
    expect(gitCalls.map((args) => args[0])).toEqual(['rev-parse'])
    expect(third.git_ok).toBe(true)
  })

  test('mapBounded preserves order and caps concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapBounded([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50])
    expect(peak).toBeLessThanOrEqual(2)
  })
})
