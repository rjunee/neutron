import { beforeEach, describe, expect, test } from 'bun:test'

import {
  buildInMemoryTaskStore,
  buildPickNextService,
  buildStubPickNextLlmClient,
  PICK_NEXT_PROMPT_TEMPLATE,
  type PickNextLlmClient,
  type TaskStore,
} from '../index.ts'

describe('Tasks Core — pick-next service', () => {
  let store: TaskStore
  let nowMs = 1_700_000_000_000
  let nextN = 0

  beforeEach(() => {
    nowMs = 1_700_000_000_000
    nextN = 0
    store = buildInMemoryTaskStore({
      now: () => ++nowMs,
      nextId: () => `t-${nextN++}`,
    })
  })

  test('empty backlog returns null candidate without calling LLM', async () => {
    let llmCalls = 0
    const llm: PickNextLlmClient = {
      async rank() {
        llmCalls += 1
        return { chosen_index: 0, rationale: 'unused', model_id: 'stub' }
      },
    }
    const svc = buildPickNextService({ store, llm })
    const result = await svc.pick({ user_id: 'u' })
    expect(result.candidate).toBeNull()
    expect(result.alternatives).toEqual([])
    expect(llmCalls).toBe(0)
    expect(result.audit.candidates_considered).toBe(0)
    expect(result.audit.llm_model).toBe('none')
  })

  test('hands candidates to LLM in focus_score order + returns chosen candidate', async () => {
    await store.create({ title: 'low priority', priority: 0 })
    await store.create({ title: 'high priority', priority: 3 })
    await store.create({ title: 'medium priority', priority: 2 })

    let captured: { count: number; firstTitle: string | undefined } = {
      count: 0,
      firstTitle: undefined,
    }
    const llm: PickNextLlmClient = {
      async rank({ candidates }) {
        captured = {
          count: candidates.length,
          firstTitle: candidates[0]?.title,
        }
        return {
          chosen_index: 0,
          rationale: 'Top focus candidate.',
          model_id: 'test-llm',
        }
      },
    }
    const svc = buildPickNextService({ store, llm })
    const result = await svc.pick({ user_id: 'u' })
    expect(captured.count).toBe(3)
    expect(captured.firstTitle).toBe('high priority')
    expect(result.candidate?.title).toBe('high priority')
    expect(result.audit.llm_model).toBe('test-llm')
    expect(result.audit.candidates_considered).toBe(3)
  })

  test('alternatives slice excludes candidate + caps at limit_alternatives', async () => {
    // Higher priority value = more urgent (P6 canonical: 0-3, 3 = top).
    // Seed task-0..task-3 with priorities 3, 2, 1, 0 so the focus
    // order matches the index → assertion below.
    await store.create({ title: 'task-0', priority: 3 })
    await store.create({ title: 'task-1', priority: 2 })
    await store.create({ title: 'task-2', priority: 1 })
    await store.create({ title: 'task-3', priority: 0 })
    const svc = buildPickNextService({
      store,
      llm: buildStubPickNextLlmClient(),
    })
    const result = await svc.pick({ user_id: 'u', limit_alternatives: 2 })
    expect(result.candidate?.title).toBe('task-0')
    expect(result.alternatives.length).toBe(2)
    expect(result.alternatives.map((a) => a.title)).toEqual(['task-1', 'task-2'])
  })

  test('project_id filter narrows candidate set', async () => {
    await store.create({ title: 'p1-a', priority: 3, project_id: 'p1' })
    await store.create({ title: 'p2-a', priority: 3, project_id: 'p2' })
    const svc = buildPickNextService({
      store,
      llm: buildStubPickNextLlmClient(),
    })
    const result = await svc.pick({ user_id: 'u', project_id: 'p1' })
    expect(result.candidate?.title).toBe('p1-a')
    expect(result.alternatives.map((a) => a.project_id)).not.toContain('p2')
  })

  test('done/blocked tasks are skipped (open-only invariant)', async () => {
    const open = await store.create({ title: 'still open', priority: 3 })
    const done = await store.create({ title: 'already done', priority: 3 })
    await store.complete(done.id)
    const svc = buildPickNextService({
      store,
      llm: buildStubPickNextLlmClient(),
    })
    const result = await svc.pick({ user_id: 'u' })
    expect(result.candidate?.id).toBe(open.id)
    expect(result.audit.candidates_considered).toBe(1)
  })

  test('rationale is present even when LLM returns empty string', async () => {
    await store.create({ title: 'ship a', priority: 3 })
    const llm: PickNextLlmClient = {
      async rank() {
        return { chosen_index: 0, rationale: '', model_id: 'empty' }
      },
    }
    const svc = buildPickNextService({ store, llm })
    const result = await svc.pick({ user_id: 'u' })
    expect(result.rationale.length).toBeGreaterThan(0)
    expect(result.rationale).toContain('ship a')
  })

  test('out-of-range index clamps to valid candidate', async () => {
    await store.create({ title: 'only one', priority: 3 })
    const llm: PickNextLlmClient = {
      async rank() {
        return { chosen_index: 999, rationale: 'pick whatever', model_id: 'oor' }
      },
    }
    const svc = buildPickNextService({ store, llm })
    const result = await svc.pick({ user_id: 'u' })
    expect(result.candidate?.title).toBe('only one')
  })

  test('locked v1 prompt template contains the owner-voice rules', () => {
    expect(PICK_NEXT_PROMPT_TEMPLATE).toContain('owner')
    expect(PICK_NEXT_PROMPT_TEMPLATE).toContain('Revenue')
    expect(PICK_NEXT_PROMPT_TEMPLATE).toContain('no validating openings')
  })
})
