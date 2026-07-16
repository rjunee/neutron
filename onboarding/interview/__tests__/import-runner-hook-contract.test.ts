/**
 * Golden/contract test for the `ImportJobRunnerHook` seam lifted (K3,
 * 2026-07-03) out of `engine-internals.ts` into its own module. Pins the
 * surface the interview engine treats as opaque:
 *   - `start` returns `{ job_id }`;
 *   - `status` returns an `ImportJob | null`;
 *   - `cancel` resolves void;
 *   - `synthesizeOnDemand` returns `ImportResult | null`.
 * Also asserts the re-export chain (`engine.ts` → `engine-internals.ts` →
 * `import-runner-hook.ts`) stays intact so existing consumers keep resolving.
 */
import { expect, test } from 'bun:test'
import type { ImportJobRunnerHook } from '../import-runner-hook.ts'
import type { ImportJobRunnerHook as HookViaEngine } from '../engine.ts'
import type { ImportJob, ImportResult } from '../../history-import/types.ts'

const RESULT: ImportResult = {
  entities: [],
  topics: [],
  proposed_projects: [{ name: 'P', rationale: 'r', suggested_topics: [] }],
  proposed_tasks: [],
  proposed_reminders: [],
  voice_signals: {},
  facts: {},
}

// A conforming fake — the type-checker enforces the contract shape; the
// re-export alias below must unify with the canonical type or this file fails
// to compile (that IS the assertion).
const fake: ImportJobRunnerHook = {
  async start(input) {
    return { job_id: `job-${input.source}` }
  },
  async status(job_id): Promise<ImportJob | null> {
    if (job_id === 'missing') return null
    return {
      job_id,
      owner_slug: 'general',
      source: 'chatgpt-zip',
      status: 'completed',
      dollars_spent: 0,
      pass1_chunks_done: 1,
      pass1_chunks_total: 1,
      chunks_total_known: true,
      started_at: 0,
      result: RESULT,
    }
  },
  async cancel() {
    // no-op
  },
  async synthesizeOnDemand(job_id) {
    return job_id === 'empty' ? null : RESULT
  },
}

// Re-export chain must resolve to the same contract.
const alias: HookViaEngine = fake
void alias

test('start returns a job_id', async () => {
  expect(await fake.start({ owner_slug: 'general', user_id: 'u', source: 'chatgpt-zip', payload: Buffer.from('') })).toEqual({
    job_id: 'job-chatgpt-zip',
  })
})

test('status returns ImportJob | null', async () => {
  expect(await fake.status('missing')).toBeNull()
  const job = await fake.status('job-1')
  expect(job?.status).toBe('completed')
  expect(job?.result).toEqual(RESULT)
})

test('cancel resolves void; synthesizeOnDemand returns ImportResult | null', async () => {
  expect(await fake.cancel('job-1')).toBeUndefined()
  expect(await fake.synthesizeOnDemand('empty')).toBeNull()
  expect(await fake.synthesizeOnDemand('job-1')).toEqual(RESULT)
})
