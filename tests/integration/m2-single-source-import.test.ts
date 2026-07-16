/**
 * remove-both-import-option (2026-06-06) — single-source import flow.
 *
 * The "Both" import-source option was removed: the importer only ever
 * processed one source per job, and the second upload was silently
 * dropped (ISSUES #85 / #85-followup). Rather than build 2-source
 * aggregation, the option was deleted. This test pins the post-removal
 * contract:
 *
 *   - the `ai_substrate_offered` source screen offers EXACTLY ChatGPT /
 *     Claude / Neither (no "Both");
 *   - a single upload at `import_upload_pending` advances straight to
 *     `import_running` (no second-upload prompt, no stay-and-wait), for
 *     both ChatGPT and Claude.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import {
  InterviewEngine,
  type ImportJobRunnerHook,
  type ImportPayloadResolver,
} from '@neutronai/onboarding/interview/engine.ts'
import type { ImportJob } from '@neutronai/onboarding/history-import/types.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'
import { STATIC_PHASE_SPECS } from '@neutronai/onboarding/interview/phase-prompts.ts'

const OWNER = 'm2-single-source'
const TOPIC = 'web:user-1'
const USER = 'user-1'

interface SentPrompt {
  project_slug: string
  topic_id: string
  prompt: { prompt_id: string; body: string; metadata?: Record<string, unknown> }
}

interface TestEnv {
  engine: InterviewEngine
  stateStore: InMemoryOnboardingStateStore
  sentPrompts: SentPrompt[]
  startedSources: string[]
  cleanup: () => void
}

function buildEnv(): TestEnv {
  const tmp = mkdtempSync(join(tmpdir(), 'm2-single-source-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  const stateStore = new InMemoryOnboardingStateStore()
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  const startedSources: string[] = []
  let jobSeq = 0
  const runner: ImportJobRunnerHook = {
    start: async (input: { source: string }) => {
      startedSources.push(input.source)
      jobSeq += 1
      return { job_id: `job-${jobSeq}` } as unknown as { job_id: string }
    },
    status: async (): Promise<ImportJob | null> => null,
    cancel: async () => undefined,
    synthesizeOnDemand: async () => null,
  }
  const resolver: ImportPayloadResolver = {
    resolve: async (input: { source: string }) =>
      ({
        conversations: [],
        source: input.source,
      } as unknown as ReturnType<ImportPayloadResolver['resolve']> extends Promise<infer R>
        ? R
        : never),
  }
  const sentPrompts: SentPrompt[] = []
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input: unknown) => {
      sentPrompts.push(input as SentPrompt)
      return { message_id: `mid-${sentPrompts.length}`, was_new: true }
    },
    importJobRunner: runner,
    importPayloadResolver: resolver,
  })
  return {
    engine,
    stateStore,
    sentPrompts,
    startedSources,
    cleanup: () => {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function seedSource(env: TestEnv, source: 'chatgpt' | 'claude'): Promise<void> {
  await env.stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'import_upload_pending',
    phase_state_patch: { ai_substrate_used: source },
    advanced_at: 1,
  })
}

async function notify(env: TestEnv, source: 'chatgpt' | 'claude', observed_at: number) {
  return env.engine.notifyImportUpload({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app_socket',
    source,
    observed_at,
  })
}

let env: TestEnv

describe('remove-both-import-option — single-source import', () => {
  beforeEach(() => {
    env = buildEnv()
  })
  afterEach(() => {
    env?.cleanup()
  })

  test('source screen offers exactly ChatGPT / Claude / Neither (no Both)', () => {
    const spec = STATIC_PHASE_SPECS['ai_substrate_offered']
    expect(spec).toBeDefined()
    const values = (spec!.options ?? []).map((o) => o.value).sort()
    expect(values).toEqual(['chatgpt', 'claude', 'neither'])
    const bodies = (spec!.options ?? []).map((o) => o.body)
    expect(bodies.some((b) => /both/i.test(b))).toBe(false)
  })

  test('single ChatGPT upload advances straight to import_running', async () => {
    await seedSource(env, 'chatgpt')
    const result = await notify(env, 'chatgpt', 10)

    expect(result.state?.phase).toBe('import_running')
    const ps = result.state?.phase_state as Record<string, unknown>
    expect(ps['import_source']).toBe('chatgpt-zip')
    expect(env.startedSources).toEqual(['chatgpt-zip'])
  })

  test('single Claude upload advances straight to import_running', async () => {
    await seedSource(env, 'claude')
    const result = await notify(env, 'claude', 10)

    expect(result.state?.phase).toBe('import_running')
    const ps = result.state?.phase_state as Record<string, unknown>
    expect(ps['import_source']).toBe('claude-zip')
    expect(env.startedSources).toEqual(['claude-zip'])
  })
})
