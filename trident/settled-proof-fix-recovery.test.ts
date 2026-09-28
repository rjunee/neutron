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
  const relocated: typeof worker = { ...worker, request: { ...worker.request,
    cwd: '/retry/work',
    brief: { path: '/retry/build.brief', integrity: 'new-context-bound-hash' },
    result: { ...worker.request.result, path: '/retry/build.result' },
  } }
  expect(proofFixWorkerMatches(bindings, 'build', relocated, bindings.briefs.build)).toBe(true)
  for (const change of [
    (value: typeof worker): typeof worker => ({ ...value, provider: 'pi' }),
    (value: typeof worker): typeof worker => ({ ...value, request: { ...value.request, model_id: 'another-model' } }),
    (value: typeof worker): typeof worker => ({ ...value, request: { ...value.request, effort: 'low' } }),
    (value: typeof worker): typeof worker => ({ ...value, request: { ...value.request, writable: false } }),
    (value: typeof worker): typeof worker => ({ ...value, request: { ...value.request, network: false } }),
    (value: typeof worker): typeof worker => ({ ...value, request: { ...value.request, tools: 'read-only' } }),
    (value: typeof worker): typeof worker => ({ ...value, request: { ...value.request,
      budget: { ...value.request.budget, wall_ms: value.request.budget.wall_ms + 1 },
    } }),
    (value: typeof worker): typeof worker => ({ ...value, request: { ...value.request,
      result: { ...value.request.result, schema: 'another-schema' },
    } }),
  ]) {
    const changed = change(relocated)
    expect(proofFixWorkerMatches(bindings, 'build', changed, bindings.briefs.build)).toBe(false)
  }
  expect(proofFixWorkerMatches(bindings, 'build', relocated, 'Changed instructions')).toBe(false)
  expect(proofFixWorkerMatches(bindings, 'fix', relocated, bindings.briefs.build)).toBe(false)
})
