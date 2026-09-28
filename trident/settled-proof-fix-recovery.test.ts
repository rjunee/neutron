import { expect, test } from 'bun:test'
import { proofFixWorkerMatches, type ProofFixBindings } from './settled-proof-fix-recovery.ts'

test('settled proof-only current worker bindings allow relocation without changing paid inputs', () => {
  const worker: ProofFixBindings['workers'][string] = { provider: 'anthropic', request: {
    model_id: 'model', effort: 'high', cwd: '/source/work', writable: true, network: true,
    tools: 'edit-and-run', thread: null, budget: { wall_ms: 1234 },
    brief: { path: '/source/build.brief.host', integrity: 'original-context-bound-hash' },
    result: { path: '/source/build.result', schema: 'project-build' },
  } }
  const bindings = { workers: { build: worker }, briefs: { build: 'Original complete instructions' } }
  const relocated = structuredClone(worker)
  relocated.request.cwd = '/retry/work'
  relocated.request.brief = { path: '/retry/build.brief', integrity: 'new-context-bound-hash' }
  relocated.request.result.path = '/retry/build.result'
  expect(proofFixWorkerMatches(bindings, 'build', relocated, bindings.briefs.build)).toBe(true)
  for (const change of [
    (value: typeof worker) => { value.provider = 'pi' },
    (value: typeof worker) => { value.request.model_id = 'another-model' },
    (value: typeof worker) => { value.request.effort = 'low' },
    (value: typeof worker) => { value.request.writable = false },
    (value: typeof worker) => { value.request.network = false },
    (value: typeof worker) => { value.request.tools = 'read-only' },
    (value: typeof worker) => { value.request.budget.wall_ms++ },
    (value: typeof worker) => { value.request.result.schema = 'another-schema' },
  ]) {
    const changed = structuredClone(relocated); change(changed)
    expect(proofFixWorkerMatches(bindings, 'build', changed, bindings.briefs.build)).toBe(false)
  }
  expect(proofFixWorkerMatches(bindings, 'build', relocated, 'Changed instructions')).toBe(false)
  expect(proofFixWorkerMatches(bindings, 'fix', relocated, bindings.briefs.build)).toBe(false)
})
