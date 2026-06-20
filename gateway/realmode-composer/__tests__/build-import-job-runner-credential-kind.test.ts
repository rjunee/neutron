/**
 * Composer integration test — v0.1.85 (2026-05-23): the credential-kind
 * resolver threads from `buildImportJobRunnerHook(...)` through the
 * runner down to `chunkConversations(...)`.
 *
 * Per the sprint brief — same fixture under two credential-kind regimes:
 *
 *   - `'oauth'` (Max OAuth Bearer) → runner stamps
 *     `chunk_target_tokens = 4096` on the job row + chunker emits at
 *     the smaller target. Fixed regression for the 2026-05-23 Max-only
 *     incident (every chunk 429'd at submit time because 50K
 *     exceeded Anthropic's predictive rate-limit gate).
 *   - `'api_key'` (BYO API key / env var) → runner stamps
 *     `chunk_target_tokens = 50_000` and chunker emits at the
 *     throughput-optimised default.
 *
 * The runner uses a deterministic pass1/pass2 stub so this test
 * focuses on the credential-kind → chunk-size routing — no live
 * substrate dispatch.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { buildImportJobRunnerHook } from '../build-import-job-runner.ts'
import {
  CHUNK_TARGET_TOKENS,
  MAX_OAUTH_CHUNK_TARGET_TOKENS,
  type ConversationRecord,
} from '../../../onboarding/history-import/types.ts'
import type { SourceParser } from '../../../onboarding/history-import/job-runner.ts'
import type { Pass1LlmCall } from '../../../onboarding/history-import/pass1-triage.ts'
import type { Pass2LlmCall } from '../../../onboarding/history-import/pass2-synthesis.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-composer-credkind-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

// Single fat conversation: 100 messages × ~250 chars = ~25K chars
// (~6K tokens). Default 50K target packs it into 1 chunk; Max-OAuth
// 4096 target splits it into ~2 chunks. Two regimes → two distinct
// chunk counts so the routing assertion is robust.
const FAT: ConversationRecord = {
  conversation_id: 'fat-1',
  messages: Array.from({ length: 100 }).map((_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `Body ${i} content goes here. `.repeat(10),
  })),
}

const parser: SourceParser = async function* () {
  yield FAT
}

const pass1Stub: Pass1LlmCall = async () => ({
  result: {
    candidate_entities: [],
    candidate_topics: [],
    candidate_tasks: [],
    voice_signals: {},
  },
  dollars_billed: 0,
})

const pass2Stub: Pass2LlmCall = async () => ({
  result: {
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
  },
  dollars_billed: 0,
})

test('composer wiring: kind="oauth" → runner persists chunk_target_tokens=4096', async () => {
  const hook = buildImportJobRunnerHook({
    db,
    pass1Llm: pass1Stub,
    pass2Llm: pass2Stub,
    parse: parser,
    getCurrentCredentialKind: () => 'oauth',
  })
  const { job_id } = await hook.start({
    user_id: 'u1',
    project_slug: 't-oauth',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  // Wait for completion — `awaitJob` isn't on the hook surface, so
  // poll once `runner.status` returns `completed` (the stub LLMs
  // resolve immediately, so this is one tick).
  for (let i = 0; i < 200; i++) {
    const status = await hook.status(job_id)
    if (status !== null && status.status === 'completed') break
    await new Promise((r) => setTimeout(r, 5))
  }
  const status = await hook.status(job_id)
  expect(status).not.toBeNull()
  expect(status!.status).toBe('completed')
  expect(status!.chunk_target_tokens).toBe(MAX_OAUTH_CHUNK_TARGET_TOKENS)
  // Visible side-effect — at 4K, the fat conversation splits into
  // more chunks than it would at 50K.
  expect(status!.pass1_chunks_total).toBeGreaterThan(1)
})

test('composer wiring: kind="api_key" → runner persists the CHUNK_TARGET_TOKENS default (150000 since 2026-06-17)', async () => {
  const hook = buildImportJobRunnerHook({
    db,
    pass1Llm: pass1Stub,
    pass2Llm: pass2Stub,
    parse: parser,
    getCurrentCredentialKind: () => 'api_key',
  })
  const { job_id } = await hook.start({
    user_id: 'u1',
    project_slug: 't-byo',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  for (let i = 0; i < 200; i++) {
    const status = await hook.status(job_id)
    if (status !== null && status.status === 'completed') break
    await new Promise((r) => setTimeout(r, 5))
  }
  const status = await hook.status(job_id)
  expect(status).not.toBeNull()
  expect(status!.status).toBe('completed')
  expect(status!.chunk_target_tokens).toBe(CHUNK_TARGET_TOKENS)
  // At the throughput-default the fat conversation fits in 1 chunk.
  expect(status!.pass1_chunks_total).toBe(1)
})

test('composer wiring: no getCurrentCredentialKind → falls back to default chunker target (50K)', async () => {
  const hook = buildImportJobRunnerHook({
    db,
    pass1Llm: pass1Stub,
    pass2Llm: pass2Stub,
    parse: parser,
    // Intentionally no getCurrentCredentialKind — exercise the
    // back-compat path so legacy callers (T4 tests, etc.) keep
    // working unchanged.
  })
  const { job_id } = await hook.start({
    user_id: 'u1',
    project_slug: 't-legacy',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  for (let i = 0; i < 200; i++) {
    const status = await hook.status(job_id)
    if (status !== null && status.status === 'completed') break
    await new Promise((r) => setTimeout(r, 5))
  }
  const status = await hook.status(job_id)
  expect(status).not.toBeNull()
  expect(status!.status).toBe('completed')
  expect(status!.chunk_target_tokens).toBe(CHUNK_TARGET_TOKENS)
})
