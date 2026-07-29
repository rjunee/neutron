/**
 * @neutronai/onboarding/synthesis — top-level consolidation (2026-06-18
 * wall-of-text fix).
 *
 * THE BUG (Ryan, dogfooding): synthesis proposed 24 verbose micro-projects with
 * paragraph-long descriptions ("Acme Gravity Pheromone Fragrance — [paragraph]",
 * "Globex as a formulation dump") instead of ~6-10 crisp TOP-LEVEL companies
 * (Acme / Globex / Initech / Umbrella) with tight one-line descriptions. The
 * owner: "accurate but didn't boil it down… too much blah blah wall of text".
 *
 * The fix steers the LLM read prompts toward top-level consolidation +
 * one-line overviews AND enforces it deterministically via `finalizeProjects`:
 *   - the surfaced project count is bounded by MAX_SYNTHESIS_PROJECTS (~10);
 *   - every overview is crushed to a single crisp line (<= MAX_PROJECT_OVERVIEW_CHARS).
 *
 * These tests assert BOTH the unit-level guard and the end-to-end synthesis
 * result (an over-eager model returning 24 verbose projects → a bounded,
 * crisp list), per CLAUDE.md "behaviour tests, not bookkeeping".
 */

import { describe, expect, test } from 'bun:test'
import type { Substrate, AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { ConversationRecord } from '../../history-import/types.ts'
import type { ProjectModel } from '../types.ts'
import { runDeterministicPrepass } from '../prepass.ts'
import {
  runImportSynthesis,
  finalizeProjects,
  MAX_SYNTHESIS_PROJECTS,
  MAX_PROJECT_OVERVIEW_CHARS,
} from '../synthesis-session.ts'
import { MemoryRawTranscriptStore } from '../raw-store.ts'

function model(overrides: Partial<ProjectModel> & { slug: string; name: string }): ProjectModel {
  return {
    status: 'active',
    overview: '',
    open_threads: [],
    conversation_ids: [],
    ...overrides,
  }
}

describe('finalizeProjects — top-level consolidation guard', () => {
  test('caps the project count at MAX_SYNTHESIS_PROJECTS, keeping the best-supported', () => {
    // 24 micro-projects; the ones with the most routed conversations should win.
    const projects: ProjectModel[] = Array.from({ length: 24 }, (_, i) =>
      model({
        slug: `proj-${i}`,
        name: `Project ${i}`,
        // Project i gets i routed conversations → higher i is better-supported.
        conversation_ids: Array.from({ length: i }, (_, k) => `c-${i}-${k}`),
      }),
    )
    const out = finalizeProjects(projects)
    expect(out.length).toBe(MAX_SYNTHESIS_PROJECTS)
    expect(out.length).toBeLessThanOrEqual(10)
    // The best-supported (proj-23 … proj-14) survive; the thinnest are dropped.
    expect(out[0]!.slug).toBe('proj-23')
    expect(out.map((p) => p.slug)).not.toContain('proj-0')
  })

  test('crushes a paragraph overview to one crisp line', () => {
    const wall =
      'Globex is a luxury skincare formulation effort. It spans serum chemistry, ' +
      'preservative systems, regulatory review, packaging design, supplier negotiation, ' +
      'and a launch calendar. There are dozens of open formulation experiments.'
    const out = finalizeProjects([model({ slug: 'globex', name: 'Globex', overview: wall })])
    expect(out.length).toBe(1)
    const desc = out[0]!.overview
    expect(desc.length).toBeLessThanOrEqual(MAX_PROJECT_OVERVIEW_CHARS)
    // First sentence only — no second/third sentence bleed-through.
    expect(desc).not.toContain('There are dozens')
    expect(desc.startsWith('Globex is a luxury skincare formulation effort')).toBe(true)
  })

  test('never returns zero projects when given at least one', () => {
    const out = finalizeProjects([model({ slug: 'solo', name: 'Solo' })])
    expect(out.length).toBe(1)
  })
})

// ── End-to-end: an over-eager model returns 24 verbose projects ─────────────

function makeSubstrate(responder: (prompt: string) => string): () => Substrate {
  return (): Substrate => ({
    start(spec: AgentSpec): SessionHandle {
      const body = responder(spec.prompt)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        if (body.length > 0) yield { kind: 'token', text: body }
        yield {
          kind: 'completion',
          usage: { input_tokens: 10, output_tokens: 10 },
          substrate_instance_id: 'fake',
        }
      })()
      return {
        events,
        respondToTool: async () => undefined,
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  })
}

function idsInPrompt(prompt: string): string[] {
  const out: string[] = []
  const re = /id=(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(prompt)) !== null) if (m[1] !== undefined) out.push(m[1])
  return out
}

/** A model that ignores the "keep it small" steering and dumps 24 verbose projects. */
function overEagerResponder(prompt: string): string {
  if (prompt.includes('read pass')) {
    const ids = idsInPrompt(prompt)
    const projects = Array.from({ length: 24 }, (_, i) => ({
      slug: `micro-${i}`,
      name: `Micro Project ${i}`,
      status: 'active',
      overview:
        `Micro Project ${i} is a sprawling effort. It covers strategy, research, ` +
        `design, and execution across many workstreams. There is a lot going on here ` +
        `and the description rambles on well past a single crisp line.`,
      open_threads: [`thread ${i}`],
    }))
    // Route every conversation to the first project so it has the most support.
    const routing = ids.map((id) => ({ conversation_id: id, project_slugs: ['micro-0'] }))
    return JSON.stringify({ projects, people: [], routing })
  }
  if (prompt.includes('accumulated model')) {
    return JSON.stringify({ summary: 'A lot of projects.', style: {}, tasks: [], open_threads: [] })
  }
  return '{}'
}

async function* asIterable(records: ReadonlyArray<ConversationRecord>): AsyncIterable<ConversationRecord> {
  for (const r of records) yield r
}

describe('runImportSynthesis — wall-of-text consolidation end-to-end', () => {
  test('a model returning 24 verbose projects is consolidated to <=10 crisp top-level rows', async () => {
    const rawStore = new MemoryRawTranscriptStore()
    const records: ConversationRecord[] = Array.from({ length: 6 }, (_, i) => ({
      conversation_id: `conv-${i}`,
      title: `Conversation ${i}`,
      created_at: Date.parse('2026-05-01T00:00:00Z') + i * 86_400_000,
      messages: [
        { role: 'user', text: `Talking about work item ${i} across several brands.` },
        { role: 'assistant', text: 'Understood.' },
      ],
    }))
    const prepass = await runDeterministicPrepass(asIterable(records), { rawStore })

    const result = await runImportSynthesis(
      { substrateFactory: makeSubstrate(overEagerResponder), rawStore, timeout_ms: 5000 },
      { prepass },
    )

    // Count is bounded — NOT the wall of 24.
    expect(result.user_model.projects.length).toBeLessThanOrEqual(MAX_SYNTHESIS_PROJECTS)
    expect(result.project_seeds.length).toBeLessThanOrEqual(MAX_SYNTHESIS_PROJECTS)
    expect(result.project_seeds.length).toBeGreaterThan(0)

    // Every surfaced description is a crisp single line, never a paragraph.
    for (const seed of result.project_seeds) {
      expect(seed.overview.length).toBeLessThanOrEqual(MAX_PROJECT_OVERVIEW_CHARS)
      expect(seed.overview).not.toContain('rambles on')
    }
    // The best-supported project (all conversations routed to micro-0) survives.
    expect(result.project_seeds.some((s) => s.slug === 'micro-0')).toBe(true)
  })
})
