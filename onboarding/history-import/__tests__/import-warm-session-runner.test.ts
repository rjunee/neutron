/**
 * import-warm-session-runner.test.ts — ONE substrate across all chunks
 * (2026-06-17 import warm-session sprint, brief test #3).
 *
 * The fix wires the import Pass-1 + Pass-2 callers over a SINGLE warm substrate
 * instance (the Open composer's `cc-import-*`). This runner-level test proves
 * the contract the substrate wiring guarantees:
 *   (a) every chunk's Pass-1 analysis AND the Pass-2 synthesis dispatch through
 *       the SAME substrate object — never a per-chunk substrate construction;
 *   (b) each Pass-1 request carries ONLY its own chunk — prior chunks' content
 *       does NOT accumulate into later requests (the per-chunk-isolation
 *       guarantee, independent of how the substrate itself pools/clears).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ImportJobRunner, type SourceParser } from '../job-runner.ts'
import type { ConversationRecord } from '../types.ts'
import {
  buildPass1SubstrateCaller,
  buildPass2SubstrateCaller,
} from '../substrate-callers.ts'
import type { AgentSpec, Substrate } from '../../../runtime/substrate.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'
import type { Event } from '../../../runtime/events.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-warm-runner-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeRecords(count: number): ConversationRecord[] {
  return Array.from({ length: count }).map((_, i) => ({
    conversation_id: `c${i}`,
    messages: [
      { role: 'user' as const, text: `UNIQUE_MARKER_${i} — conversation about projects.` },
      { role: 'assistant' as const, text: `Reply ${i}` },
    ],
  }))
}

function makeParser(records: ConversationRecord[]): SourceParser {
  return async function* () {
    for (const r of records) yield r
  }
}

/** A single capturing Substrate: records EVERY start(spec) (so we can prove all
 *  chunks ran through ONE instance) and returns a minimal handle that emits one
 *  valid-JSON token + a completion. */
function capturingSubstrate(): { substrate: Substrate; prompts: string[]; startCount: () => number } {
  const prompts: string[] = []
  let starts = 0
  const JSON_BODY = JSON.stringify({
    candidate_entities: [],
    candidate_topics: [],
    candidate_tasks: [],
    voice_signals: {},
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
    entities: [],
    topics: [],
    facts: [],
  })
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      starts += 1
      prompts.push(spec.prompt)
      async function* events(): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: JSON_BODY }
        yield {
          kind: 'completion',
          usage: { input_tokens: 10, output_tokens: 5 },
          session: { id: 'cap', last_active_at: 1 },
          substrate_instance_id: 'cc-import-test',
        }
      }
      return {
        events: events(),
        async respondToTool() {},
        async cancel() {},
        tool_resolution: 'internal',
      }
    },
  }
  return { substrate, prompts, startCount: () => starts }
}

test('all chunks + Pass-2 dispatch through ONE substrate; no prior-chunk accumulation', async () => {
  const { substrate, prompts, startCount } = capturingSubstrate()
  // Pricing zeroed so dollar-billing stays deterministic; both callers wrap the
  // SAME substrate object — exactly how the Open composer wires `cc-import-*`.
  const pass1 = buildPass1SubstrateCaller({ substrate, pricing: { input_usd_per_m: 0, output_usd_per_m: 0 } })
  const pass2 = buildPass2SubstrateCaller({ substrate, pricing: { input_usd_per_m: 0, output_usd_per_m: 0 } })

  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'PASS1-SYSTEM',
    pass2Prompt: 'PASS2-SYSTEM',
    parse: makeParser(makeRecords(3)),
    // Omitted pass1Concurrency ⇒ default 1 (sequential, one warm session).
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'u',
    project_slug: 't-warm',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  const status = await runner.status(job_id)
  expect(status!.status).toBe('completed')
  expect(status!.pass1_chunks_done).toBe(3)

  // 3 Pass-1 chunk dispatches + 1 Pass-2 synthesis — all through the ONE
  // substrate object (a per-chunk substrate construction would not share this
  // counter / prompt log).
  expect(startCount()).toBe(4)

  // Per-chunk isolation: each Pass-1 request body carries ONLY its own chunk's
  // unique marker — prior chunks' content does NOT accumulate into later
  // requests. (Pass-2's aggregated body is excluded from this per-chunk check.)
  const pass1Prompts = prompts.filter((p) => p.includes('UNIQUE_MARKER_'))
  expect(pass1Prompts.length).toBe(3)
  for (let i = 0; i < 3; i += 1) {
    const own = pass1Prompts.filter((p) => p.includes(`UNIQUE_MARKER_${i}`))
    // Exactly one Pass-1 request mentions marker i, and that request mentions
    // NO other chunk's marker.
    expect(own.length).toBe(1)
    const others = [0, 1, 2].filter((j) => j !== i)
    for (const j of others) expect(own[0]!.includes(`UNIQUE_MARKER_${j}`)).toBe(false)
  }
})
