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

import { parseDocLink } from '@neutronai/runtime/doc-links.ts'
import type { ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import type { MaterializeOutcome } from '@neutronai/onboarding/wow-moment/project-materializer.ts'
import type { ProjectOpeningDocs } from '../build-onboarding-handoff.ts'
import {
  buildProjectKickoff,
  type KickoffInput,
  type ProjectKickoffDeps,
} from '../build-project-kickoff.ts'
import {
  buildProjectKickoffComposer,
  OPENING_MESSAGE_MAX_TOKENS,
  type ProjectKickoffComposer,
} from '../build-project-kickoff-composer.ts'
import type { AnthropicMessagesClient } from '@neutronai/onboarding/interview/anthropic-client.ts'

const NOW = 1_700_000_000_000

function ownerHome(): string {
  return mkdtempSync(join(tmpdir(), 'kickoff-home-'))
}

/**
 * A composer that returns fixed markdown for the DOC kinds and a distinct
 * fully-composed bubble for the `opening_message` kind (#377), and records its
 * calls. `project_id` is recorded so isolation tests can assert per-project keying.
 */
function stubComposer(
  body: string,
  message = 'Here is where this project stands and I drafted a first pass for you to review.',
): ProjectKickoffComposer & { calls: number; kinds: string[]; projectIds: string[] } {
  const fn = Object.assign(
    async (input: { kind: string; project_id: string }): Promise<string> => {
      fn.calls += 1
      fn.kinds.push(input.kind)
      fn.projectIds.push(input.project_id)
      return input.kind === 'opening_message' ? message : body
    },
    { calls: 0, kinds: [] as string[], projectIds: [] as string[] },
  )
  return fn
}

function recordingIndexer(): {
  fn: NonNullable<ProjectKickoffDeps['indexer']>
  calls: Array<{ project_slug: string; body: string }>
} {
  const calls: Array<{ project_slug: string; body: string }> = []
  const fn: NonNullable<ProjectKickoffDeps['indexer']> = async (page) => {
    calls.push({ project_slug: page.owner_slug, body: page.body })
  }
  return { fn, calls }
}

function outcome(over: Partial<MaterializeOutcome> = {}): MaterializeOutcome {
  return {
    owner_slug: 'p',
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
    owner_slug: 'acme',
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
    owner_slug: 'acme',
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
  // Two composes now: the starting-plan DOC + the fully-LLM opening MESSAGE (#377).
  expect(composer.calls).toBe(2)
  expect(composer.kinds).toEqual(['draft_doc', 'opening_message'])
  // Both composes key THIS project's isolated session (#378): same project_id.
  expect(composer.projectIds).toEqual(['topline', 'topline'])
  // #377 — the retired hardcoded lead scaffold is GONE; the bubble is the LLM message.
  expect(res!.body).not.toContain('I took a first pass')
  expect(res!.body).toContain('I drafted a first pass for you to review')

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

test('#377 heading-only doc + opening-message compose failure → lead derives from the doc heading, NOT a generic boilerplate', async () => {
  const home = ownerHome()
  // DOC compose returns a heading-ONLY body (no prose paragraph); the
  // opening_message compose THROWS. The fallback must stay project-unique by
  // lifting the doc's OWN heading — never the retired generic scaffold.
  const composer = Object.assign(
    async (input: { kind: string }): Promise<string> => {
      if (input.kind === 'opening_message') throw new Error('compose failed')
      return '# Topline revenue reporting rollout\n\n## Next steps\n\n## Risks'
    },
    { calls: 0, kinds: [] as string[], projectIds: [] as string[] },
  )
  const kickoff = buildProjectKickoff({
    owner_home: home,
    owner_slug: 'acme',
    composer,
    now: () => NOW,
    log: () => {},
  })
  const input = baseInput({
    docs: {
      readme: null,
      transcript_summary: null,
      status_md: '---\none_liner: "Ship revenue reporting"\nstatus: active\npriority: P1\n---\n\n# Status\n\nBuilding the dashboard.\n\n## Open threads\n\n- Wire the warehouse\n',
    },
  })
  const res = await kickoff.composeKickoff(input)
  expect(res).not.toBeNull()
  expect(res!.action).toBe('draft-doc')
  // Lead is the doc's own heading text — project-unique, document-derived.
  expect(res!.body).toContain('Topline revenue reporting rollout')
  // NOT the retired generic boilerplate lead.
  expect(res!.body).not.toContain('I drafted a starting')
  // Still carries the tappable doc marker.
  expect(res!.body).toContain('docs:/topline/starting-plan.md')
})

test('draft-doc create-if-missing: an existing doc is never clobbered → null', async () => {
  const home = ownerHome()
  const docsDir = join(home, 'Projects', 'topline', 'docs')
  mkdirSync(docsDir, { recursive: true })
  writeFileSync(join(docsDir, 'starting-plan.md'), '# user edited\n', 'utf8')
  const composer = stubComposer('# fresh draft')
  const kickoff = buildProjectKickoff({
    owner_home: home,
    owner_slug: 'acme',
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
    owner_slug: 'acme',
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
    owner_slug: 'acme',
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
    owner_slug: 'acme',
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
    owner_slug: 'acme',
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
    owner_slug: 'acme',
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
    owner_slug: 'acme',
    composer: failing,
    now: () => NOW,
    log: () => {},
  })
  const res = await kickoff.composeKickoff(
    baseInput({ outcome: outcome({ summary_written: true, slice_chunk_count: 3 }) }),
  )
  expect(res).toBeNull() // fall back to the deterministic opening
})

// ---------------------------------------------------------------------------
// #378 CROSS-PROJECT BLEED — the whole point. Drives the REAL kickoff composer
// (`buildProjectKickoffComposer`) across 3 distinct projects through a fake that
// models per-session accumulating transcripts: a session "remembers" every
// project it has composed for and its replies leak every remembered name (the
// bleed). ISOLATED (one session per project_id) → each project's DOC + opening
// MESSAGE reference ONLY their own project. SHARED (one session for all — the
// pre-fix `cc-llm-*` wiring) → project 2/3 echo project 1. The second half is the
// "fails on main" demonstration; the first is the fix.
// ---------------------------------------------------------------------------

/**
 * A fake compose backend keyed by session. Each session accumulates the project
 * names it has been asked to compose for; every reply leaks the full accumulated
 * set — so a session SHARED across projects bleeds earlier projects into later
 * ones. `makeClient(sessionKey)` returns the client for that session.
 */
function transcriptModel(): {
  makeClient: (sessionKey: string) => AnthropicMessagesClient
} {
  const remembered = new Map<string, string[]>()
  const makeClient = (sessionKey: string): AnthropicMessagesClient => ({
    messages: {
      async create(args) {
        const seen = remembered.get(sessionKey) ?? []
        const content = args.messages[0]?.content ?? ''
        const name = content.match(/Project name:\s*(.+)/)?.[1]?.trim() ?? ''
        if (name.length > 0 && !seen.includes(name)) seen.push(name)
        remembered.set(sessionKey, seen)
        // Leak every project this SESSION has accumulated — the #378 bleed.
        return { content: [{ text: `# ${name} plan\n\nCovers: ${seen.join(', ')}.` }] }
      },
    },
  })
  return { makeClient }
}

const BLEED_PROJECTS = [
  { project_id: 'amascence', name: 'Amascence' },
  { project_id: 'dtc-ops', name: 'DTC ops' },
  { project_id: 'contemplative-practice', name: 'contemplative practice' },
]

async function runKickoffAcrossProjects(
  clientForProject: (project_id: string) => AnthropicMessagesClient,
): Promise<Array<{ name: string; openingBody: string; doc: string }>> {
  const home = ownerHome()
  const kickoff = buildProjectKickoff({
    owner_home: home,
    owner_slug: 'acme',
    composer: buildProjectKickoffComposer({ clientForProject }),
    now: () => NOW,
    log: () => {},
  })
  const out: Array<{ name: string; openingBody: string; doc: string }> = []
  for (const p of BLEED_PROJECTS) {
    const res = await kickoff.composeKickoff(
      baseInput({
        project_id: p.project_id,
        name: p.name,
        outcome: outcome({ summary_written: true }),
      }),
    )
    expect(res).not.toBeNull()
    const doc = readFileSync(join(home, 'Projects', p.project_id, 'docs', 'starting-plan.md'), 'utf8')
    out.push({ name: p.name, openingBody: res!.body, doc })
  }
  return out
}

test('#378 ISOLATED per-project sessions → each project DOC + opening references ONLY its own project (no bleed)', async () => {
  const { makeClient } = transcriptModel()
  // Isolation = a DISTINCT session per project_id (the fix).
  const results = await runKickoffAcrossProjects((project_id) => makeClient(project_id))
  // Project 2 (DTC ops) and 3 (contemplative practice) must NOT echo project 1.
  const dtc = results[1]!
  const contemplative = results[2]!
  expect(dtc.doc).toContain('DTC ops')
  expect(dtc.doc).not.toContain('Amascence')
  expect(dtc.openingBody).not.toContain('Amascence')
  expect(contemplative.doc).toContain('contemplative practice')
  expect(contemplative.doc).not.toContain('Amascence')
  expect(contemplative.doc).not.toContain('DTC ops')
  expect(contemplative.openingBody).not.toContain('Amascence')
})

test('#378 SHARED session (pre-fix behaviour) BLEEDS — project 2/3 echo project 1 (this is what fails on main)', async () => {
  const { makeClient } = transcriptModel()
  // The pre-fix wiring routed every project through ONE shared `cc-llm-*` session.
  const shared = makeClient('cc-llm-shared')
  const results = await runKickoffAcrossProjects(() => shared)
  // Demonstrates the bleed the fix removes: project 2's doc echoes project 1.
  expect(results[1]!.doc).toContain('Amascence')
  expect(results[2]!.doc).toContain('Amascence')
  expect(results[2]!.doc).toContain('DTC ops')
})

// ---------------------------------------------------------------------------
// Task 5 — has_context-first work-signal gate + de-templated opening prompt.
// The gate previously required import-derived signal (open threads / slices /
// rationale AND topics); an owner-DESCRIBED work project whose rationale never
// reaches `matched` had the materializer's own has_context=true yet failed the
// gate and got a generic deterministic opening (2026-07-21 dogfood variance).
// ---------------------------------------------------------------------------

test('work project with has_context alone (owner-described, no import match) → draft-doc', async () => {
  const home = ownerHome()
  const composer = stubComposer('# Topline plan\n\nFirst concrete step.')
  const kickoff = buildProjectKickoff({
    owner_home: home,
    owner_slug: 'acme',
    composer,
    now: () => NOW,
    log: () => {},
  })
  // matched:null, zero slices, no summary, no open threads — ONLY has_context.
  const res = await kickoff.composeKickoff(baseInput({ outcome: outcome({ has_context: true }) }))
  expect(res).not.toBeNull()
  expect(res!.action).toBe('draft-doc')
  expect(existsSync(join(home, 'Projects', 'topline', 'docs', 'starting-plan.md'))).toBe(true)
  expect(composer.kinds).toContain('draft_doc')
  expect(composer.kinds).toContain('opening_message')
})

test('work project with rationale-only match and NO materializer outcome → draft-doc (OR loosening)', async () => {
  const home = ownerHome()
  const composer = stubComposer('# Topline plan\n\nFirst concrete step.')
  const kickoff = buildProjectKickoff({
    owner_home: home,
    owner_slug: 'acme',
    composer,
    now: () => NOW,
    log: () => {},
  })
  // outcome:null → has_context defaults false; rationale alone (no topics) now
  // qualifies via the AND→OR fallback aligned with hasInterestSignal.
  const res = await kickoff.composeKickoff(
    baseInput({
      outcome: null,
      matched: {
        name: 'Topline',
        rationale: 'You discussed Topline at length in your imported history.',
        suggested_topics: [],
      },
    }),
  )
  expect(res).not.toBeNull()
  expect(res!.action).toBe('draft-doc')
})

test('opening_message prompt contract: no forced took-a-first-pass beat; demands per-project varied phrasing', async () => {
  const captured: Array<{ system: string; max_tokens: number }> = []
  const capturingClient: AnthropicMessagesClient = {
    messages: {
      async create(args) {
        captured.push({ system: args.system ?? '', max_tokens: args.max_tokens })
        return { content: [{ text: 'A grounded opener.' }] }
      },
    },
  }
  const composer = buildProjectKickoffComposer({ clientForProject: () => capturingClient })
  const text = await composer({
    kind: 'opening_message',
    project_id: 'p1',
    project_name: 'Topline',
    doc_title: 'Topline - starting plan',
    context_lines: ['Summary: pilot in flight'],
  })
  expect(text).toBe('A grounded opener.')
  expect(captured.length).toBe(1)
  const sys = captured[0]!.system
  // The OLD mandatory beat is gone (assert the exact long phrase, NOT the bare
  // substring 'took a first pass' which appears in the new banned-examples list).
  expect(sys).not.toContain('that you took a first pass and drafted a starting document')
  // Retained invariants + the vary-phrasing instruction + the appended-link note.
  expect(sys).toContain('do NOT reuse stock template phrases')
  expect(sys).toContain('a tappable link is appended')
  // The opening message rides the short-bubble budget, not the doc budget.
  expect(captured[0]!.max_tokens).toBe(OPENING_MESSAGE_MAX_TOKENS)
})
