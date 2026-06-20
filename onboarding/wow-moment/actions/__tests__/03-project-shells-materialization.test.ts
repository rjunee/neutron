/**
 * Item 4 (post-onboarding-experience spec § ITEM 4) — REPRODUCE-FIRST.
 *
 * Prod-verified gap: when projects are created during onboarding,
 * `03-project-shells` writes ONLY DB rows (`projects` + a `topics`
 * binding) — ZERO on-disk materialization. The instance has no
 * `Projects/<slug>/` folder, no doc set, no git repo. AND the raw
 * imported transcripts are DISCARDED after import (`import_pass1_chunks`
 * has no `chunk_text` retention), so there is nothing to slice per
 * project.
 *
 * These tests assert the SPEC'd behavior (spec § 4.2 +
 * docs/plans/project-folder-convention.md § 3 / § 4):
 *
 *   1. each confirmed project materializes as a real git repo at
 *      `<owner_home>/Projects/<id>/` with the standard doc set
 *      (README.md / CLAUDE.md / STATUS.md with § 4 frontmatter) + the
 *      § 3.1 subdirs (docs/ research/ notes/ archive/),
 *   2. retained raw transcript chunks slice per-project into
 *      `research/transcripts/imported-transcript-slices.md`,
 *   3. a transcript-summary doc + a project-page index call (GBrain)
 *      ride on the injected composer/indexer seams.
 *
 * On pre-Item-4 main, (1) fails because nothing touches disk, (2) fails
 * because `import_pass1_chunks.chunk_text` does not exist, and (3)
 * fails because `project-materializer.ts` does not exist. That is the
 * reproduction.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import action03 from '../03-project-shells.ts'
import {
  buildContext,
  makeFixture,
  teardown,
  type TestFixture,
} from '../../__tests__/test-helpers.ts'
import type { ImportResult } from '../../../history-import/types.ts'

let fix: TestFixture

beforeEach(() => {
  fix = makeFixture()
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

function importWithSignal(): ImportResult {
  return {
    entities: [
      { name: 'Topline', kind: 'company', mention_count: 9 },
      { name: 'Soren', kind: 'person', mention_count: 3 },
    ],
    topics: [{ name: 'Topline invoicing', recurrence_score: 0.8, recency_score: 0.9 }],
    proposed_projects: [
      { name: 'Topline', rationale: 'Billing SaaS you discuss weekly.', suggested_topics: [] },
      { name: 'Northwind Labs', rationale: 'Consumer brand launch threads.', suggested_topics: [] },
    ],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {},
    facts: {},
  }
}

/** Seed a retained raw chunk row (Item 4 capture — `chunk_text`). */
function seedChunk(input: {
  hash: string
  conversation_id: string
  chunk_index: number
  text: string
  topics: string[]
  entities: string[]
}): void {
  fix.db
    .raw()
    .run(
      `INSERT INTO import_pass1_chunks
         (project_slug, source, chunk_hash, job_id, conversation_id, chunk_index,
          chunk_byte_length, candidate_entities_json, candidate_topics_json,
          candidate_tasks_json, voice_signals_json, dollars_billed, analyzed_at,
          analyzed, chunk_text)
       VALUES ('t1', 'chatgpt-zip', ?, 'job-1', ?, ?, ?, ?, ?, '[]', '{}', 0, 1700000000, 1, ?)`,
      [
        input.hash,
        input.conversation_id,
        input.chunk_index,
        Buffer.byteLength(input.text, 'utf8'),
        JSON.stringify(input.entities.map((name) => ({ name, kind: 'concept', mention_count: 1 }))),
        JSON.stringify(input.topics.map((name) => ({ name }))),
        input.text,
      ],
    )
}

function parseFrontmatter(md: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(md)
  expect(match).not.toBeNull()
  const out: Record<string, string> = {}
  for (const line of (match as RegExpExecArray)[1]!.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

describe('Item 4 — project materialization + transcript memory (reproduce-first)', () => {
  test('materializes each confirmed project as a git repo with the § 3 doc set', async () => {
    const ctx = buildContext(fix, {
      captured_projects: [
        { name: 'Topline', rationale: 'Billing SaaS you discuss weekly.' },
        { name: 'Northwind Labs' },
      ],
      import_result: importWithSignal(),
    })
    ctx.projects_confirmed = true

    const result = await action03.run(ctx)
    expect(result.fired).toBe(true)

    for (const slug of ['topline', 'northwind-labs']) {
      const root = join(fix.dir, 'Projects', slug)
      // Folder + § 3.1 subdirs.
      expect(existsSync(root)).toBe(true)
      for (const sub of ['docs', 'research', 'notes', 'archive']) {
        expect(statSync(join(root, sub)).isDirectory()).toBe(true)
      }
      // § 3.3 — every project is its own git repo with an initial commit.
      expect(statSync(join(root, '.git')).isDirectory()).toBe(true)
      const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
      expect(head).toMatch(/^[0-9a-f]{40}$/)
      // Standard doc set.
      expect(existsSync(join(root, 'README.md'))).toBe(true)
      expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true)
      // § 4 frontmatter on STATUS.md.
      const fm = parseFrontmatter(readFileSync(join(root, 'STATUS.md'), 'utf8'))
      expect(fm['name']).toBe(slug)
      expect(fm['status']).toBe('active')
      expect(fm['priority']).toMatch(/^P[0-3]$/)
      expect((fm['one_liner'] ?? '').length).toBeGreaterThan(0)
      expect(fm['remote']).toBe('local')
      expect(fm['last_updated']).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }

    // README carries the project's synthesized context, not a bare stub.
    const readme = readFileSync(join(fix.dir, 'Projects', 'topline', 'README.md'), 'utf8')
    expect(readme).toContain('Topline')
    expect(readme).toContain('Billing SaaS you discuss weekly')
  })

  test('slices retained transcript chunks per project into research/transcripts/', async () => {
    // Item 4 capture: raw chunk text is RETAINED on import_pass1_chunks.
    // On pre-Item-4 main this INSERT throws (no chunk_text column) —
    // that is the "raw transcripts are discarded" reproduction.
    seedChunk({
      hash: 'h1',
      conversation_id: 'conv-1',
      chunk_index: 0,
      text: 'User: how do we price Topline invoicing tiers?\nAssistant: ...',
      topics: ['Topline invoicing'],
      entities: ['Topline'],
    })
    seedChunk({
      hash: 'h2',
      conversation_id: 'conv-1',
      chunk_index: 1,
      text: 'User: Topline churn dropped 4% after the dunning emails.',
      topics: [],
      entities: ['Topline'],
    })
    seedChunk({
      hash: 'h3',
      conversation_id: 'conv-9',
      chunk_index: 0,
      text: 'User: best sourdough hydration for a home oven?',
      topics: ['Baking'],
      entities: [],
    })

    const ctx = buildContext(fix, {
      captured_projects: [{ name: 'Topline' }, { name: 'Northwind Labs' }],
      import_result: importWithSignal(),
    })
    ctx.projects_confirmed = true
    const result = await action03.run(ctx)
    expect(result.fired).toBe(true)

    const slicesPath = join(
      fix.dir,
      'Projects',
      'topline',
      'research',
      'transcripts',
      'imported-transcript-slices.md',
    )
    expect(existsSync(slicesPath)).toBe(true)
    const slices = readFileSync(slicesPath, 'utf8')
    expect(slices).toContain('Topline invoicing tiers')
    expect(slices).toContain('churn dropped 4%')
    // The unrelated conversation never bleeds into this project's slices.
    expect(slices).not.toContain('sourdough')

    // A transcript-summary doc exists (deterministic fallback without an
    // LLM composer — never a silent absence when slices were found).
    expect(
      existsSync(join(fix.dir, 'Projects', 'topline', 'docs', 'transcript-summary.md')),
    ).toBe(true)
  })

  test('LLM composer + GBrain indexer seams are honored when injected', async () => {
    // Dynamic import so the two reproduction tests above still report
    // their own artifact-gap failures on pre-Item-4 main (a static
    // import of a then-nonexistent module would fail the whole file).
    const { buildProjectMaterializer } = await import('../../project-materializer.ts')

    seedChunk({
      hash: 'h1',
      conversation_id: 'conv-1',
      chunk_index: 0,
      text: 'User: how do we price Topline invoicing tiers?',
      topics: ['Topline invoicing'],
      entities: ['Topline'],
    })

    const composed: string[] = []
    const indexed: Array<{ project_slug: string; name: string; body: string }> = []
    const materializer = buildProjectMaterializer({
      owner_home: fix.dir,
      project_slug: 't1',
      db: fix.db,
      now: () => 1_700_000_000_000,
      composer: async (input) => {
        composed.push(input.kind)
        return `# ${input.project_name}\n\nLLM ${input.kind} body.\n`
      },
      indexer: async (input) => {
        indexed.push(input)
      },
    })

    const ctx = buildContext(fix, {
      captured_projects: [{ name: 'Topline' }, { name: 'Northwind Labs' }],
      import_result: importWithSignal(),
    })
    ctx.projects_confirmed = true
    ctx.materializer = materializer
    const result = await action03.run(ctx)
    expect(result.fired).toBe(true)

    // Composer drove README + transcript-summary content.
    expect(composed).toContain('readme')
    expect(composed).toContain('transcript_summary')
    const readme = readFileSync(join(fix.dir, 'Projects', 'topline', 'README.md'), 'utf8')
    expect(readme).toContain('LLM readme body')
    const summary = readFileSync(
      join(fix.dir, 'Projects', 'topline', 'docs', 'transcript-summary.md'),
      'utf8',
    )
    expect(summary).toContain('LLM transcript_summary body')

    // Every materialized project indexed into the project memory layer.
    const slugs = indexed.map((i) => i.project_slug).sort()
    expect(slugs).toEqual(['northwind-labs', 'topline'])
    const tabsPage = indexed.find((i) => i.project_slug === 'topline')
    expect(tabsPage?.body ?? '').toContain('Topline')
  })
})
