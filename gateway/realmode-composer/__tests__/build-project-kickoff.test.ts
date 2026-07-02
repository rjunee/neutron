/**
 * Unit tests for `buildProjectKickoff` (the one-time agentic per-project kickoff).
 *
 * Covers the brief's done-criteria:
 *   - the HARD data-sufficiency gate picks meaty-vs-prompt correctly
 *     (thin work → null → deterministic fallback; rich work → draft-doc);
 *   - a drafted doc is PRESENTED (opening body carries a valid `docs:/` marker)
 *     AND INDEXED to GBrain recall (the indexer is called with the doc gist);
 *   - a data-rich hobby gets light-research notes; a thin hobby gets engaging
 *     questions (never a bad-job artifact);
 *   - a work project with a real upcoming deadline gets an offer-only reminder
 *     pitch (never auto-created);
 *   - create-if-missing: an existing doc is never clobbered (→ fall back).
 */

import { test, expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseDocLink } from '../../../runtime/doc-links.ts'
import type { ImportResult } from '../../../onboarding/history-import/types.ts'
import type { MaterializeOutcome } from '../../../onboarding/wow-moment/project-materializer.ts'
import type { ProjectOpeningDocs } from '../build-onboarding-handoff.ts'
import {
  buildProjectKickoff,
  type KickoffInput,
  type ProjectKickoffDeps,
} from '../build-project-kickoff.ts'
import type { ProjectKickoffComposer } from '../build-project-kickoff-composer.ts'

const NOW = 1_700_000_000_000

function ownerHome(): string {
  return mkdtempSync(join(tmpdir(), 'kickoff-home-'))
}

/** A composer that returns fixed markdown and records its calls. */
function stubComposer(body: string): ProjectKickoffComposer & { calls: number } {
  const fn = Object.assign(
    async (): Promise<string> => {
      fn.calls += 1
      return body
    },
    { calls: 0 },
  )
  return fn
}

function recordingIndexer(): {
  fn: NonNullable<ProjectKickoffDeps['indexer']>
  calls: Array<{ project_slug: string; body: string }>
} {
  const calls: Array<{ project_slug: string; body: string }> = []
  const fn: NonNullable<ProjectKickoffDeps['indexer']> = async (page) => {
    calls.push({ project_slug: page.project_slug, body: page.body })
  }
  return { fn, calls }
}

function outcome(over: Partial<MaterializeOutcome> = {}): MaterializeOutcome {
  return {
    project_slug: 'p',
    reason: 'created',
    docs_written: [],
    slice_chunk_count: 0,
    summary_written: false,
    llm_docs: false,
    git_ok: true,
    indexed: false,
    has_context: false,
    ...over,
  }
}

function baseInput(over: Partial<KickoffInput> = {}): KickoffInput {
  const docs: ProjectOpeningDocs = { readme: null, transcript_summary: null, status_md: null }
  return {
    project_id: 'topline',
    name: 'Topline',
    is_interest: false,
    docs,
    matched: null,
    import_result: null,
    outcome: outcome(),
    ...over,
  }
}

test('thin work project → null (fall back to deterministic opening)', async () => {
  const home = ownerHome()
  const composer = stubComposer('# unused')
  const kickoff = buildProjectKickoff({
    owner_home: home,
    project_slug: 'acme',
    composer,
    now: () => NOW,
    log: () => {},
  })
  const res = await kickoff.composeKickoff(baseInput())
  expect(res).toBeNull()
  expect(composer.calls).toBe(0) // gate short-circuits before the LLM
})

test('rich work project → draft-doc: writes doc, presents tappable marker, indexes it', async () => {
  const home = ownerHome()
  const composer = stubComposer('# Topline - starting plan\n\nGet revenue reporting live.\n\n## Next steps\n- Wire the dashboard')
  const idx = recordingIndexer()
  const kickoff = buildProjectKickoff({
    owner_home: home,
    project_slug: 'acme',
    composer,
    indexer: idx.fn,
    now: () => NOW,
    log: () => {},
  })
  const input = baseInput({
    docs: {
      readme: null,
      transcript_summary: null,
      status_md: '---\none_liner: "Ship revenue reporting"\nstatus: active\npriority: P1\n---\n\n# Status\n\nBuilding the revenue dashboard.\n\n## Open threads\n\n- Wire the dashboard to the warehouse\n- Decide on the metric set\n',
    },
  })
  const res = await kickoff.composeKickoff(input)
  expect(res).not.toBeNull()
  expect(res!.action).toBe('draft-doc')
  expect(composer.calls).toBe(1)

  // Doc written on disk under the project's docs/ root.
  const abs = join(home, 'Projects', 'topline', 'docs', 'starting-plan.md')
  expect(existsSync(abs)).toBe(true)
  expect(readFileSync(abs, 'utf8')).toContain('starting plan')

  // Opening body presents a VALID tappable doc-link marker to that exact doc.
  const marker = res!.body.match(/\((docs:\/[^)]+)\)/)?.[1] ?? ''
  const parsed = parseDocLink(marker)
  expect(parsed).not.toBeNull()
  expect(parsed!.project_id).toBe('topline')
  expect(parsed!.path).toBe('starting-plan.md')

  // Indexed to GBrain recall with the doc content in the page body.
  expect(res!.indexed).toBe(true)
  expect(idx.calls.length).toBe(1)
  expect(idx.calls[0]!.project_slug).toBe('topline')
  expect(idx.calls[0]!.body).toContain('Get revenue reporting live')
})

test('draft-doc create-if-missing: an existing doc is never clobbered → null', async () => {
  const home = ownerHome()
  const docsDir = join(home, 'Projects', 'topline', 'docs')
  mkdirSync(docsDir, { recursive: true })
  writeFileSync(join(docsDir, 'starting-plan.md'), '# user edited\n', 'utf8')
  const composer = stubComposer('# fresh draft')
  const kickoff = buildProjectKickoff({
    owner_home: home,
    project_slug: 'acme',
    composer,
    now: () => NOW,
    log: () => {},
  })
  const res = await kickoff.composeKickoff(
    baseInput({ outcome: outcome({ summary_written: true }) }),
  )
  expect(res).toBeNull()
  expect(composer.calls).toBe(0) // never even composed; the doc already exists
  expect(readFileSync(join(docsDir, 'starting-plan.md'), 'utf8')).toBe('# user edited\n')
})

test('rich work project → deadline-offer when an upcoming related deadline exists (offer-only)', async () => {
  const home = ownerHome()
  const composer = stubComposer('# unused')
  const kickoff = buildProjectKickoff({
    owner_home: home,
    project_slug: 'acme',
    composer,
    now: () => NOW,
    log: () => {},
  })
  const import_result = {
    proposed_projects: [],
    proposed_tasks: [
      { title: 'Topline board deck due', due_at: NOW + 5 * 24 * 60 * 60 * 1000 },
      { title: 'Unrelated errand', due_at: NOW + 2 * 24 * 60 * 60 * 1000 },
    ],
  } as unknown as ImportResult
  const res = await kickoff.composeKickoff(baseInput({ import_result }))
  expect(res).not.toBeNull()
  expect(res!.action).toBe('deadline-offer')
  expect(res!.body).toContain('Topline board deck')
  expect(res!.body.toLowerCase()).toContain('remind')
  expect(res!.body).not.toContain('Unrelated errand') // only project-related deadlines
  expect(composer.calls).toBe(0) // no doc composed for a deadline offer
})

test('overdue / far-future deadlines do not trigger an offer', async () => {
  const home = ownerHome()
  const kickoff = buildProjectKickoff({
    owner_home: home,
    project_slug: 'acme',
    composer: stubComposer('x'),
    now: () => NOW,
    log: () => {},
  })
  const import_result = {
    proposed_projects: [],
    proposed_tasks: [
      { title: 'Topline thing overdue', due_at: NOW - 24 * 60 * 60 * 1000 },
      { title: 'Topline thing far off', due_at: NOW + 400 * 24 * 60 * 60 * 1000 },
    ],
  } as unknown as ImportResult
  const res = await kickoff.composeKickoff(baseInput({ import_result }))
  expect(res).toBeNull() // no upcoming-window deadline, and thin otherwise
})

test('thin hobby → engaging questions (never null, never a doc)', async () => {
  const home = ownerHome()
  const composer = stubComposer('# unused')
  const kickoff = buildProjectKickoff({
    owner_home: home,
    project_slug: 'acme',
    composer,
    now: () => NOW,
    log: () => {},
  })
  const res = await kickoff.composeKickoff(
    baseInput({ project_id: 'climbing', name: 'Rock Climbing', is_interest: true }),
  )
  expect(res).not.toBeNull()
  expect(res!.action).toBe('interest-questions')
  expect(res!.body.length).toBeGreaterThan(0)
  expect(res!.body).toContain('?') // it actually asks something
  expect(composer.calls).toBe(0) // deterministic; no LLM, no doc
  expect(existsSync(join(home, 'Projects', 'climbing', 'docs', 'starting-notes.md'))).toBe(false)
})

test('rich hobby → interest-research: drafts light notes + indexes them', async () => {
  const home = ownerHome()
  const composer = stubComposer('# Photography - starting notes\n\nStart with light and composition.\n')
  const idx = recordingIndexer()
  const kickoff = buildProjectKickoff({
    owner_home: home,
    project_slug: 'acme',
    composer,
    indexer: idx.fn,
    now: () => NOW,
    log: () => {},
  })
  const res = await kickoff.composeKickoff(
    baseInput({
      project_id: 'photography',
      name: 'Photography',
      is_interest: true,
      matched: { name: 'Photography', rationale: 'you shared several photo edits', suggested_topics: ['composition'] },
    }),
  )
  expect(res).not.toBeNull()
  expect(res!.action).toBe('interest-research')
  expect(res!.doc_relpath).toBe('starting-notes.md')
  expect(existsSync(join(home, 'Projects', 'photography', 'docs', 'starting-notes.md'))).toBe(true)
  const marker = res!.body.match(/\((docs:\/[^)]+)\)/)?.[1] ?? ''
  expect(parseDocLink(marker)?.path).toBe('starting-notes.md')
  expect(res!.indexed).toBe(true)
  expect(idx.calls.length).toBe(1)
})

test('rich hobby with a failing composer degrades to engaging questions (not null)', async () => {
  const home = ownerHome()
  const failing: ProjectKickoffComposer = async () => {
    throw new Error('substrate down')
  }
  const kickoff = buildProjectKickoff({
    owner_home: home,
    project_slug: 'acme',
    composer: failing,
    now: () => NOW,
    log: () => {},
  })
  const res = await kickoff.composeKickoff(
    baseInput({
      project_id: 'photography',
      name: 'Photography',
      is_interest: true,
      outcome: outcome({ summary_written: true }),
    }),
  )
  expect(res).not.toBeNull()
  expect(res!.action).toBe('interest-questions') // hobby always gets a meaty opening
})

test('rich work with a failing composer → null (better nothing than a bad job)', async () => {
  const home = ownerHome()
  const failing: ProjectKickoffComposer = async () => {
    throw new Error('substrate down')
  }
  const kickoff = buildProjectKickoff({
    owner_home: home,
    project_slug: 'acme',
    composer: failing,
    now: () => NOW,
    log: () => {},
  })
  const res = await kickoff.composeKickoff(
    baseInput({ outcome: outcome({ summary_written: true, slice_chunk_count: 3 }) }),
  )
  expect(res).toBeNull() // fall back to the deterministic opening
})
