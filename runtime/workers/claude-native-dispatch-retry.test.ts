import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectRunners, type ProjectRunnersOptions } from './project-runners.ts'
import type { BoundedWorkRequest } from '../bounded-work.ts'

test('nonaborted same-step refusal retry cannot invoke actor again; a new step can', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-retry-control-'))
  try {
    const request: BoundedWorkRequest = { run_id: 'run', step_id: 'step', role: 'plan', model_id: 'model', effort: null,
      cwd: dir, writable: false, network: false, tools: 'read-only', brief: { path: join(dir, 'brief'), integrity: 'digest' },
      result: { path: join(dir, 'result'), schema: 'schema' }, thread: null, budget: { wall_ms: 100 }, needs_approval_decision: false }
    let calls = 0
    const options: ProjectRunnersOptions = { conversation: { project_id: 'project', topic_id: 'topic', provider: 'anthropic',
      spec: { tools: [], model_preference: [] } }, run_id: request.run_id, state_dir: dir,
      actingTurn: async () => { calls++; return { kind: 'refused', reason: 'capability-unsupported', detail: 'before input' } },
      trailer: { schemas: new Map(), metadata: () => undefined }, headless: {} }
    expect((await (await createProjectRunners(options)).inRepl!.run(request, 'in-repl', new AbortController().signal)).kind).toBe('refused')
    expect(calls).toBe(1)
    // This signal is LIVE: an already-aborted retry would not test reservation ownership.
    expect((await (await createProjectRunners(options)).inRepl!.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
    expect(calls).toBe(1)
    expect((await (await createProjectRunners(options)).inRepl!.run({ ...request, step_id: 'new-step' }, 'in-repl', new AbortController().signal)).kind).toBe('refused')
    expect(calls).toBe(2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
