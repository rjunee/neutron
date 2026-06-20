/**
 * Job-runner regression test — v0.1.85 (2026-05-23): Pass-1 chunk size
 * adapts to the resolved credential kind.
 *
 * Bug (live prod walkthrough, 2026-05-23):
 * the runner's hard-coded `CHUNK_TARGET_TOKENS = 50_000` was the only
 * per-job chunk size. When the substrate authenticated via Max OAuth
 * (Bearer token), Anthropic's predictive rate-limit gate rejected
 * 50K-token-per-call requests with "This request would exceed your
 * account's rate limit" — even on the FIRST call when no prior usage
 * existed. Every Pass-1 chunk 429'd at submit time → 0/N processed →
 * every Max-only owner had a broken Claude import.
 *
 * Fix: the runner takes a `getCurrentCredentialKind` resolver in its
 * deps; at job-start time it calls the resolver and picks the chunk
 * target:
 *   - `'oauth'` (Max OAuth Bearer auth) → MAX_OAUTH_CHUNK_TARGET_TOKENS (4096)
 *   - any other kind / null / undefined → CHUNK_TARGET_TOKENS (50_000)
 *
 * The resolved value is stamped on `import_jobs.chunk_target_tokens`
 * (migration 0044) for telemetry. (A user-visible "Running on Max —
 * chunking smaller" notice originally rode this signal, but was
 * removed 2026-05-26 as an infra leak — chunk-size strategy is no
 * longer surfaced to the user.)
 *
 * These tests assert:
 *   1. With `getCurrentCredentialKind` returning `'oauth'`, the runner
 *      threads `target_tokens=4096` into the chunker. The persisted
 *      `chunk_target_tokens` column matches.
 *   2. With `getCurrentCredentialKind` returning `'api_key'`, the
 *      runner threads `target_tokens=50_000` (the default). The
 *      persisted column matches.
 *   3. With NO `getCurrentCredentialKind` (legacy callers / test
 *      seams), the runner falls back to the constructor's
 *      `chunkOptions` or the chunker default. The persisted column
 *      reflects the effective default (CHUNK_TARGET_TOKENS).
 *   4. A resolver that THROWS does NOT brick the job — the runner
 *      logs the failure, falls back to the default chunk size, and
 *      the import progresses normally.
 *   5. Live regression (the actual user-visible breakage): a 4-message
 *      conversation big enough to require multiple chunks at 50K
 *      packs into many MORE chunks at 4096. Without the fix, the
 *      runner would have submitted ONE 50K-token call to Anthropic
 *      and 429'd.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import {
  CHUNK_TARGET_TOKENS,
  MAX_OAUTH_CHUNK_TARGET_TOKENS,
  type Chunk,
  type ConversationRecord,
} from '../types.ts'
import { ImportJobRunner, type SourceParser } from '../job-runner.ts'
import type { Pass1LlmCall } from '../pass1-triage.ts'
import type { Pass2LlmCall } from '../pass2-synthesis.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-credkind-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Three conversations of ~50 messages each at ~300 chars per message.
 * Total payload ~45K chars (~11K tokens) per conversation. At the 50K
 * default each conversation comfortably fits in one chunk; at the 4096
 * Max-OAuth target each one splits into ~3 chunks. The two regimes
 * produce visibly different chunk counts so the regression test can
 * pin the chunk-target-tokens routing without inspecting closures.
 */
const BIG_CONVOS: ConversationRecord[] = Array.from({ length: 3 }).map(
  (_, c) => ({
    conversation_id: `convo-${c}`,
    messages: Array.from({ length: 50 }).map((_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `Conversation ${c} message ${i}. `.repeat(30),
    })),
  }),
)

const bigParser: SourceParser = async function* () {
  for (const r of BIG_CONVOS) yield r
}

const pass1: Pass1LlmCall = async () => ({
  result: {
    candidate_entities: [],
    candidate_topics: [],
    candidate_tasks: [],
    voice_signals: {},
  },
  dollars_billed: 0,
})

const pass2: Pass2LlmCall = async () => ({
  result: {
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
  },
  dollars_billed: 0,
})

test('credential.kind=oauth → chunker receives 4096 target_tokens and persists chunk_target_tokens=4096', async () => {
  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: bigParser,
    getCurrentCredentialKind: () => 'oauth',
  })

  const { job_id } = await runner.start({
    user_id: 'u1',
    project_slug: 't-oauth',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  const status = await runner.status(job_id)
  expect(status).not.toBeNull()
  expect(status!.status).toBe('completed')
  // Telemetry column: stamped at job-start time with the effective
  // target. This is what operators grep for in journald / sqlite.
  expect(status!.chunk_target_tokens).toBe(MAX_OAUTH_CHUNK_TARGET_TOKENS)
  // Live regression: at 4K the 3 conversations explode into many
  // more chunks than they would at 50K (which would pack each into 1).
  expect(status!.pass1_chunks_total).toBeGreaterThan(3)
})

test('credential.kind=api_key → chunker receives the CHUNK_TARGET_TOKENS default (150_000 since 2026-06-17) and persists it', async () => {
  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: bigParser,
    getCurrentCredentialKind: () => 'api_key',
  })

  const { job_id } = await runner.start({
    user_id: 'u1',
    project_slug: 't-byo',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  const status = await runner.status(job_id)
  expect(status).not.toBeNull()
  expect(status!.status).toBe('completed')
  expect(status!.chunk_target_tokens).toBe(CHUNK_TARGET_TOKENS)
  // Each ~11K-token conversation fits in one chunk at the default target
  // (chunks are per-conversation), so we see exactly 3 chunks total.
  expect(status!.pass1_chunks_total).toBe(3)
})

test('credential.kind=codex_oauth → still uses 50K default (only Max OAuth opt-in triggers the smaller target)', async () => {
  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: bigParser,
    getCurrentCredentialKind: () => 'codex_oauth',
  })

  const { job_id } = await runner.start({
    user_id: 'u1',
    project_slug: 't-codex',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  const status = await runner.status(job_id)
  expect(status!.chunk_target_tokens).toBe(CHUNK_TARGET_TOKENS)
  expect(status!.pass1_chunks_total).toBe(3)
})

test('no getCurrentCredentialKind wired → falls back to chunker default (50K), back-compat with legacy callers', async () => {
  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: bigParser,
    // Intentionally no getCurrentCredentialKind — pre-v0.1.85 shape.
  })

  const { job_id } = await runner.start({
    user_id: 'u1',
    project_slug: 't-legacy',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  const status = await runner.status(job_id)
  // Stamped with the effective default even when no resolver is wired
  // — operators can still grep journald for the path taken.
  expect(status!.chunk_target_tokens).toBe(CHUNK_TARGET_TOKENS)
})

test('resolver returning null → falls back to default (legacy-row-equivalent path)', async () => {
  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: bigParser,
    getCurrentCredentialKind: () => null,
  })

  const { job_id } = await runner.start({
    user_id: 'u1',
    project_slug: 't-null',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  const status = await runner.status(job_id)
  expect(status!.chunk_target_tokens).toBe(CHUNK_TARGET_TOKENS)
})

test('resolver that THROWS does NOT brick the job — falls back to default + logs', async () => {
  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: bigParser,
    getCurrentCredentialKind: () => {
      throw new Error('credential pool resolver blew up')
    },
  })

  const { job_id } = await runner.start({
    user_id: 'u1',
    project_slug: 't-throw',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  const status = await runner.status(job_id)
  expect(status).not.toBeNull()
  expect(status!.status).toBe('completed')
  expect(status!.chunk_target_tokens).toBe(CHUNK_TARGET_TOKENS)
})

test('async resolver is awaited (matches the production lazy resolveLlmCredentials path)', async () => {
  let resolveCount = 0
  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: bigParser,
    getCurrentCredentialKind: async (): Promise<'oauth'> => {
      resolveCount += 1
      // Mimic a real-world resolver doing async work (DB read,
      // env-file overlay, MaxOAuth refresh).
      await new Promise((r) => setTimeout(r, 5))
      return 'oauth'
    },
  })

  const { job_id } = await runner.start({
    user_id: 'u1',
    project_slug: 't-async',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  const status = await runner.status(job_id)
  expect(status!.chunk_target_tokens).toBe(MAX_OAUTH_CHUNK_TARGET_TOKENS)
  // The resolver is called ONCE per job — at start time, before
  // chunking. Mid-job rotation does NOT re-chunk (would invalidate
  // the chunk_hash dedup table).
  expect(resolveCount).toBe(1)
})

test('live regression: at 50K the same input would yield 1 chunk; at 4K it yields several — proves the override is wired', async () => {
  // Single conversation big enough that 50K packs it into 1 chunk and
  // 4K splits it across many. The pre-fix runner would have submitted
  // ONE 50K-token call to Anthropic on the Max OAuth path → 429.
  const SINGLE: ConversationRecord = {
    conversation_id: 'big-single',
    messages: Array.from({ length: 100 }).map((_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `Message ${i} `.repeat(50),
    })),
  }
  const oneConvoParser: SourceParser = async function* () {
    yield SINGLE
  }

  // First run: api_key path — single chunk at 50K default.
  const runnerApi = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: oneConvoParser,
    getCurrentCredentialKind: () => 'api_key',
  })
  const { job_id: jobApi } = await runnerApi.start({
    user_id: 'u1',
    project_slug: 't-cmp-api',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runnerApi.awaitJob(jobApi)
  const apiStatus = await runnerApi.status(jobApi)
  expect(apiStatus!.pass1_chunks_total).toBe(1)

  // Same input through the Max OAuth path — many more chunks.
  const runnerOauth = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: oneConvoParser,
    getCurrentCredentialKind: () => 'oauth',
  })
  const { job_id: jobOauth } = await runnerOauth.start({
    user_id: 'u1',
    project_slug: 't-cmp-oauth',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runnerOauth.awaitJob(jobOauth)
  const oauthStatus = await runnerOauth.status(jobOauth)
  expect(oauthStatus!.pass1_chunks_total).toBeGreaterThan(
    apiStatus!.pass1_chunks_total,
  )
  // Avoid an unused-import warning on Chunk in tests that strictly
  // pin the count.
  void ({} as Chunk)
})
