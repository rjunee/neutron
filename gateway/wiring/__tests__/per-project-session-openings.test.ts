/**
 * Per-project session openings (ISSUES #378 + #377, Ryan-locked 2026-07-20).
 *
 * Proves the fix for the live cross-project content bleed the owner hit while
 * dogfooding M1: the per-project OPENING-message + KICKOFF-doc composers now
 * dispatch through EACH project's OWN warm `cc-agent-*` session, keyed by
 * `metering_context.project_id` per dispatch, instead of ONE shared, accumulating
 * `cc-llm` session. The tests exercise the REAL composer chain
 * (`buildProjectKickoff` → `buildProjectKickoffComposer` /
 * `buildProjectOpeningMessageComposer` → `buildGatewayAnthropicMessagesClient` →
 * `substrate.start`) over a fake Substrate that MODELS a per-session-key
 * accumulating transcript, so a wrong session key reproduces the bleed exactly.
 *
 * `composeKickoff` IS the per-project unit `emitProjectOpenings`
 * (build-onboarding-finalize.ts) runs in its concurrency-3 worker pool, so
 * driving it directly (concurrently) faithfully reproduces the finalize-path
 * behaviour for both the opening MESSAGE and the 'starting plan' DOC.
 *
 * Coverage:
 *   1. REPRODUCTION CONTROL — with NO project_id (the pre-fix shared-session
 *      routing) the fake's shared transcript BLEEDS: project 2's doc references
 *      project 1. Proves the fake models the real bug + that the project_id key
 *      is load-bearing.
 *   2. ISOLATION (the fix) — driven concurrently like the worker pool, each
 *      project's opening MESSAGE and starting-plan DOC reference ONLY their own
 *      project. No bleed.
 *   3. WHITE-BOX — every kickoff-doc dispatch carries
 *      `spec.metering_context.project_id === <project_id>`; none uses the shared
 *      (undefined) key.
 *   4. WHITE-BOX (opening composer) — `buildProjectOpeningMessageComposer` threads
 *      project_id → `metering_context.project_id` too.
 *   5. #377 — the opening bodies are FULLY LLM-composed + unique: no retired
 *      hardcoded lead ("I took a first pass…", "I did a little digging…"), and two
 *      projects' bodies differ (each leads with its own LLM gist).
 */

import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { ProjectOpeningDocs } from '../build-onboarding-handoff.ts'
import type { ComposeProjectOpeningInput } from '../build-onboarding-handoff.ts'
import { buildGatewayAnthropicMessagesClient } from '../build-anthropic-messages-client.ts'
import { buildProjectKickoffComposer } from '../build-project-kickoff-composer.ts'
import { buildProjectOpeningMessageComposer } from '../build-project-opening-message.ts'
import {
  buildProjectKickoff,
  type KickoffInput,
  type ProjectKickoffDeps,
} from '../build-project-kickoff.ts'

// ---------------------------------------------------------------------------
// Fake Substrate that MODELS a per-session-key accumulating transcript.
// ---------------------------------------------------------------------------
//
// `start(spec)` keys on `spec.metering_context?.project_id ?? '__SHARED__'` (the
// EXACT key dimension `build-llm-call-substrate.ts` folds into the warm-pool
// key), parses the dispatch's `Project name: X` out of the packed prompt, and
// APPENDS it to that key's transcript. The returned doc references EVERY project
// name accumulated on that session key so far — so a SHARED key (no project_id)
// bleeds prior projects' content into later ones, while a per-project key stays
// isolated. This is the shared-transcript conditioning that caused #378.
function isolationSubstrate(): {
  substrate: Substrate
  seen: AgentSpec[]
  keyOf: (spec: AgentSpec) => string
} {
  const seen: AgentSpec[] = []
  const transcripts = new Map<string, string[]>()
  const keyOf = (spec: AgentSpec): string => spec.metering_context?.project_id ?? '__SHARED__'
  return {
    seen,
    keyOf,
    substrate: {
      start(spec: AgentSpec): SessionHandle {
        seen.push(spec)
        const key = keyOf(spec)
        const name = /Project name:\s*(.+)/.exec(spec.prompt)?.[1]?.trim() ?? 'unknown'
        const names = transcripts.get(key) ?? []
        names.push(name)
        transcripts.set(key, names)
        // The doc body references every project on this session key — snapshotted
        // at start() so the bleed is deterministic under sequential dispatch.
        const covered = [...names]
        const body =
          `# ${name} - starting plan\n\n` +
          `This plan for ${name} covers ${covered.join(', ')}.\n\n` +
          `## Next steps\n- Ship it\n\n## Open questions\n- What is the deadline?\n`
        const events: Event[] = [
          { kind: 'token', text: body },
          {
            kind: 'completion',
            usage: { input_tokens: 1, output_tokens: 1 },
            substrate_instance_id: 'fake',
          },
        ]
        const iter = (async function* (): AsyncGenerator<Event, void, void> {
          for (const ev of events) yield ev
        })()
        return {
          events: iter,
          async respondToTool(): Promise<void> {
            throw new Error('not supported')
          },
          async cancel(): Promise<void> {},
          tool_resolution: 'internal',
        }
      },
    },
  }
}

const NOW = 1_700_000_000_000

/** A rich-work STATUS.md (open threads) so the kickoff's data-sufficiency gate
 *  fires the draft-doc path. Distinct one-liner per project. */
function richStatus(oneLiner: string, thread: string): string {
  return (
    `---\none_liner: "${oneLiner}"\nstatus: active\npriority: P1\n---\n\n` +
    `# Status\n\n${oneLiner}.\n\n## Open threads\n\n- ${thread}\n`
  )
}

interface ProjectFixture {
  id: string
  name: string
  status: string
}

const PROJECTS: readonly ProjectFixture[] = [
  { id: 'amascence', name: 'Amascence', status: richStatus('Grow Amascence DTC revenue', 'Launch the spring collection') },
  { id: 'dtc-ops', name: 'DTC Ops', status: richStatus('Tighten fulfillment SLAs', 'Pick a 3PL for the west coast') },
  {
    id: 'contemplative-practice',
    name: 'Contemplative Practice',
    status: richStatus('Deepen daily sitting practice', 'Find a weekly sangha'),
  },
]

function kickoffFor(
  substrate: Substrate,
  ownerHome: string,
): ProjectKickoffDeps {
  return {
    owner_home: ownerHome,
    owner_slug: 'acme',
    composer: buildProjectKickoffComposer({ client: buildGatewayAnthropicMessagesClient({ substrate }) }),
    indexer: null,
    now: () => NOW,
    log: () => {},
  }
}

function kickoffInput(p: ProjectFixture): KickoffInput {
  const docs: ProjectOpeningDocs = { readme: null, transcript_summary: null, status_md: p.status }
  return {
    project_id: p.id,
    name: p.name,
    is_interest: false,
    docs,
    matched: null,
    import_result: null,
    outcome: {
      owner_slug: p.id,
      reason: 'created',
      docs_written: [],
      slice_chunk_count: 0,
      summary_written: false,
      llm_docs: false,
      git_ok: true,
      indexed: false,
      has_context: true,
    },
  }
}

// ---------------------------------------------------------------------------
// 1. REPRODUCTION CONTROL — the shared-session route (no project_id) BLEEDS.
// ---------------------------------------------------------------------------

test('REPRO: routing kickoff-doc composes through ONE shared session bleeds across projects', async () => {
  const fake = isolationSubstrate()
  const client = buildGatewayAnthropicMessagesClient({ substrate: fake.substrate })
  const composer = buildProjectKickoffComposer({ client })

  // Dispatch WITHOUT project_id — exactly the pre-fix routing (the shim built no
  // metering_context, so every project shared the substrate's one warm REPL).
  const bodies: string[] = []
  for (const p of PROJECTS) {
    bodies.push(
      await composer({
        kind: 'draft_doc',
        // project_id intentionally OMITTED — models the shared cc-llm session.
        project_name: p.name,
        doc_title: `${p.name} - starting plan`,
        context_lines: [`Summary: ${p.name} work`],
      }),
    )
  }

  // Every dispatch shared the '__SHARED__' key → the transcript accumulated →
  // project 2's and project 3's docs reference project 1 (Amascence). This is the
  // cross-project content bleed the fix eliminates.
  expect(fake.seen.every((s) => s.metering_context === undefined)).toBe(true)
  expect(bodies[1]).toContain('Amascence')
  expect(bodies[2]).toContain('Amascence')
  expect(bodies[2]).toContain('DTC Ops')
})

// ---------------------------------------------------------------------------
// 2 + 3. ISOLATION (the fix) + WHITE-BOX — per-project session keying.
// ---------------------------------------------------------------------------

test('FIX: each project composes in its OWN per-project session — opening + doc reference only that project', async () => {
  const fake = isolationSubstrate()
  const ownerHome = mkdtempSync(join(tmpdir(), 'ppso-'))
  const kickoff = buildProjectKickoff(kickoffFor(fake.substrate, ownerHome))

  // Drive all three CONCURRENTLY — mirrors emitProjectOpenings' concurrency-3
  // worker pool. Per-project keying makes interleaving irrelevant.
  const results = await Promise.all(PROJECTS.map((p) => kickoff.composeKickoff(kickoffInput(p))))

  for (let i = 0; i < PROJECTS.length; i += 1) {
    const self = PROJECTS[i]!
    const res = results[i]
    expect(res).not.toBeNull()
    expect(res!.action).toBe('draft-doc')

    // The opening MESSAGE references ONLY its own project.
    expect(res!.body).toContain(self.name)
    for (const other of PROJECTS) {
      if (other.id === self.id) continue
      expect(res!.body).not.toContain(other.name)
    }

    // The on-disk 'starting plan' DOC references ONLY its own project.
    const docPath = join(ownerHome, 'Projects', self.id, 'docs', 'starting-plan.md')
    const docBody = readFileSync(docPath, 'utf8')
    expect(docBody).toContain(self.name)
    for (const other of PROJECTS) {
      if (other.id === self.id) continue
      expect(docBody).not.toContain(other.name)
    }
  }

  // WHITE-BOX — every kickoff-doc dispatch carried its OWN project_id as the
  // metering_context (the per-project warm-pool key); none used the shared key.
  expect(fake.seen).toHaveLength(PROJECTS.length)
  const keys = fake.seen.map((s) => s.metering_context?.project_id).sort()
  expect(keys).toEqual([...PROJECTS.map((p) => p.id)].sort())
  expect(fake.seen.every((s) => s.metering_context?.project_id !== undefined)).toBe(true)
})

// ---------------------------------------------------------------------------
// 4. WHITE-BOX — the OPENING-message composer threads project_id too.
// ---------------------------------------------------------------------------

test('WHITE-BOX: buildProjectOpeningMessageComposer keys each compose by project_id', async () => {
  const fake = isolationSubstrate()
  const compose = buildProjectOpeningMessageComposer({
    anthropicClient: buildGatewayAnthropicMessagesClient({ substrate: fake.substrate }),
  })

  const mkInput = (p: ProjectFixture): ComposeProjectOpeningInput => ({
    name: p.name,
    imported_project: null,
    import_result: null,
    project_docs: { readme: null, transcript_summary: null, status_md: p.status },
    owner_slug: 'acme',
    user_id: 'owner',
    project_id: p.id,
  })

  await Promise.all([compose(mkInput(PROJECTS[0]!)), compose(mkInput(PROJECTS[1]!))])

  expect(fake.seen).toHaveLength(2)
  const keys = fake.seen.map((s) => s.metering_context?.project_id).sort()
  expect(keys).toEqual([PROJECTS[0]!.id, PROJECTS[1]!.id].sort())
})

// ---------------------------------------------------------------------------
// 5. #377 — openings are FULLY LLM-composed + unique (no hardcoded lead).
// ---------------------------------------------------------------------------

test('#377: opening bodies carry no hardcoded lead and vary per project', async () => {
  const fake = isolationSubstrate()
  const ownerHome = mkdtempSync(join(tmpdir(), 'ppso-377-'))
  const kickoff = buildProjectKickoff(kickoffFor(fake.substrate, ownerHome))

  const a = await kickoff.composeKickoff(kickoffInput(PROJECTS[0]!))
  const b = await kickoff.composeKickoff(kickoffInput(PROJECTS[1]!))

  for (const res of [a, b]) {
    expect(res).not.toBeNull()
    // The retired hardcoded lead scaffolds are GONE.
    expect(res!.body).not.toContain('I took a first pass')
    expect(res!.body).not.toContain('drafted a starting plan')
    expect(res!.body).not.toContain('I did a little digging')
    // The body LEADS with the LLM's own project-grounded framing (the doc gist).
    expect(res!.body.startsWith('This plan for')).toBe(true)
  }
  // Unique per project — no shared boilerplate lead.
  expect(a!.body).not.toBe(b!.body)
  expect(a!.body).toContain(PROJECTS[0]!.name)
  expect(b!.body).toContain(PROJECTS[1]!.name)
})
