/**
 * Trident-port PR-5 — the `/code` → foundational-Trident chat filter.
 *
 * Proves the gateway-level `buildTridentCodeChatCommandFilter` rewiring:
 * `/code <task>` creates a `code_trident_runs` row via the per-instance
 * `TridentRunStore` (NOT the retired Code-Gen Core orchestrator), claims
 * the command (never falls through to the LLM), and answers honestly when
 * no build target is wired.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { TridentRunStore } from '../../trident/store.ts'
import type { TridentCodeContext } from '../../trident/code-command.ts'
import { buildTridentCodeChatCommandFilter } from '../boot-helpers.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-codewire-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const matchInput = (body: string) => ({
  user_id: 'u1',
  project_slug: 'proj-1',
  channel_topic_id: 'topic-1',
  project_id: 'proj-1',
  body,
})

function ctxFor(): TridentCodeContext {
  return {
    store,
    project_slug: 'proj-1',
    repo_path: '/repo',
    resolveMergeMode: async () => 'local',
    resolveRalph: async () => false,
  }
}

describe('buildTridentCodeChatCommandFilter', () => {
  test('/code <task> creates a code_trident_runs row and claims the command', async () => {
    const filter = buildTridentCodeChatCommandFilter({ resolve_context: () => ctxFor() })
    const res = await filter.match(matchInput('/code add a feature flag'))
    expect(res).not.toBeNull()
    const run_id = (res!.data as { run_id: string }).run_id
    const row = store.get(run_id)!
    expect(row.phase).toBe('forge-init')
    expect(row.task).toBe('add a feature flag')
    expect(row.merge_mode).toBe('local')
    expect(res!.text).toContain('Trident run')
  })

  test('a non-/code body returns null (falls through to the LLM path)', async () => {
    const filter = buildTridentCodeChatCommandFilter({ resolve_context: () => ctxFor() })
    expect(await filter.match(matchInput('what is the weather'))).toBeNull()
  })

  test('null context still claims /code but answers unavailable (no LLM fallthrough)', async () => {
    const filter = buildTridentCodeChatCommandFilter({
      resolve_context: () => null,
      unavailable_message: 'no repo wired here',
    })
    const res = await filter.match(matchInput('/code do a thing'))
    expect(res).not.toBeNull()
    expect(res!.text).toBe('no repo wired here')
    expect(res!.error?.code).toBe('unavailable')
    // No row was created.
    expect(store.listNonTerminal().length).toBe(0)
  })

  test('null context + /code help still answers with the unavailable text', async () => {
    const filter = buildTridentCodeChatCommandFilter({
      resolve_context: () => null,
      unavailable_message: 'no repo wired here',
    })
    const res = await filter.match(matchInput('/code'))
    expect(res!.text).toBe('no repo wired here')
    expect(res!.error).toBeUndefined()
  })

  test('resolve_context may be async', async () => {
    const filter = buildTridentCodeChatCommandFilter({
      resolve_context: async () => ctxFor(),
    })
    const res = await filter.match(matchInput('/code async path'))
    expect((res!.data as { run_id: string }).run_id).toBeDefined()
  })
})
