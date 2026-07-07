/**
 * @neutronai/gateway/realmode-composer — synthesis cut-over routing test
 * (Step 2b, 2026-06-17).
 *
 * Asserts the LIVE composer wiring: with `importUseSynthesis: true` (the Open
 * single-owner composer's opt-in), `buildOnboardingEnginePieces` builds an
 * `ImportJobRunner` that drives the ONE accumulating synthesis session — the
 * injected `importSubstrate` receives the synthesis "read pass" prompts and
 * NEVER a `/clear`. This is the end-to-end proof the engine's import_running
 * machinery now runs through `onboarding/synthesis/*`, not the per-chunk
 * `buildImportJobRunnerHook`.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { buildOnboardingEnginePieces } from '../build-landing-stack.ts'
import type { Substrate, AgentSpec } from '../../../runtime/substrate.ts'
import type { Event } from '../../../runtime/events.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'
import type { ConversationRecord } from '../../../onboarding/history-import/types.ts'


let workdir: string
let ownerHome: string
let db: ProjectDb

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-synthesis-routing-'))
  ownerHome = join(workdir, 'project-home')
  mkdirSync(ownerHome, { recursive: true })
  const dbPath = join(workdir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(workdir, { recursive: true, force: true })
})

/** Synthesis-shaped fake substrate: answers "read pass" + consolidation. */
function makeSynthesisSubstrate(): { substrate: Substrate; dispatched: string[] } {
  const dispatched: string[] = []
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      dispatched.push(spec.prompt)
      let body = '{}'
      if (spec.prompt.includes('read pass')) {
        const ids = [...spec.prompt.matchAll(/id=(\S+)/g)].map((m) => m[1])
        body = JSON.stringify({
          projects: [
            { slug: 'apollo', name: 'Apollo Launch', status: 'launching', overview: 'DTC launch.', open_threads: ['Compliance with Sam'] },
          ],
          people: ['Sam'],
          routing: ids.map((id) => ({ conversation_id: id, project_slugs: ['apollo'] })),
        })
      } else if (spec.prompt.includes('accumulated model')) {
        body = JSON.stringify({ summary: 'You run the Apollo launch.', style: { tone: 'neutral' } })
      }
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: body }
        yield { kind: 'completion', usage: { input_tokens: 5, output_tokens: 5 }, substrate_instance_id: 'cc-synthesis-fake' }
      })()
      return { events, respondToTool: async () => undefined, cancel: async () => undefined, tool_resolution: 'internal' }
    },
  }
  return { substrate, dispatched }
}

async function* importRecords(): AsyncIterable<ConversationRecord> {
  yield {
    conversation_id: 'c-apollo-1',
    title: 'Apollo compliance',
    created_at: Date.parse('2026-06-01T00:00:00Z'),
    messages: [{ role: 'user', text: 'Apollo launch compliance review with Sam.' }],
  }
}

test('importUseSynthesis routes the engine import hook to the accumulating synthesis session (read-pass prompts, no /clear)', async () => {
  const { substrate, dispatched } = makeSynthesisSubstrate()
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug: 'owner',
    owner_home: ownerHome,
    static_dir: workdir,
    internal_handle: 't-owner001',
    // The Step 2b opt-in + the accumulating synthesis substrate + a
    // deterministic zip parser.
    importUseSynthesis: true,
    importSubstrate: substrate,
    importParse: () => importRecords(),
  })

  expect(pieces.importJobRunner).not.toBeNull()
  const runner = pieces.importJobRunner!
  const { job_id } = await runner.start({
    project_slug: 'owner',
    user_id: 'u-owner',
    source: 'claude-zip',
    payload: Buffer.from('zip'),
  })
  let final: Awaited<ReturnType<typeof runner.status>> = null
  for (let i = 0; i < 400; i += 1) {
    const s = await runner.status(job_id)
    if (s !== null && (s.status === 'completed' || s.status === 'failed')) {
      final = s
      break
    }
    await new Promise((r) => setTimeout(r, 5))
  }
  expect(final).not.toBeNull()
  expect(final!.status).toBe('completed')
  // The synthesis user-model flowed into the ImportResult the engine reads.
  expect(final!.result?.proposed_projects.map((p) => p.name)).toEqual(['Apollo Launch'])

  // The injected substrate ran the SYNTHESIS read-pass prompts — proving the
  // per-chunk Pass-1/Pass-2 path was bypassed — and never a `/clear`.
  expect(dispatched.some((p) => p.includes('read pass'))).toBe(true)
  for (const p of dispatched) expect(p).not.toContain('/clear')
})
