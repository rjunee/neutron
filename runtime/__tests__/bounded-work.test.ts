/**
 * The contract's own guards. Small on purpose: this file exists so eight lanes can
 * develop against a seam that is checked, not so it can test TypeScript.
 */
import { describe, expect, test } from 'bun:test'
import {
  fakeRunner,
  placementFor,
  type BoundedWorkOutcome,
  type BoundedWorkRequest,
} from '../bounded-work.ts'

const req = (over: Partial<BoundedWorkRequest> = {}): BoundedWorkRequest => ({
  run_id: 'r1',
  step_id: 's1',
  role: 'build',
  model_id: 'resolved-model-id',
  effort: null,
  cwd: '/w',
  writable: true,
  network: false,
  tools: 'edit-and-run',
  brief: { path: '/w/.brief', integrity: 'sha' },
  result: { schema: 'FORGE', path: '/w/.trailer.json' },
  thread: null,
  budget: { wall_ms: 60_000 },
  needs_approval_decision: false,
  ...over,
})

describe('placement is the host’s decision, per §3.2', () => {
  test('same provider as the REPL runs INSIDE it', () => {
    expect(placementFor('anthropic', 'anthropic')).toBe('in-repl')
    expect(placementFor('openai-codex', 'openai-codex')).toBe('in-repl')
  })

  test('a different provider is headless — and ONLY a different provider', () => {
    // The control that matters: §3.8 measured each headless job paying ~23–27k
    // cache-read tokens purely to warm up, so a rule that quietly sent same-provider
    // work headless would tax every build forever while still passing the case above.
    expect(placementFor('openai-codex', 'anthropic')).toBe('headless')
    expect(placementFor('pi', 'anthropic')).toBe('headless')
    const providers = ['anthropic', 'openai-codex', 'pi'] as const
    for (const p of providers) expect(placementFor(p, p)).toBe('in-repl')
  })
})

describe('the fake runner lets a lane develop with no process', () => {
  test('returns the scripted outcome for a step, and records the request', async () => {
    const done: BoundedWorkOutcome = {
      kind: 'completed', result: { head: 'abc' }, usage: { input_tokens: 1, output_tokens: 2 },
      model_reported: 'resolved-model-id', thread_id: null,
    }
    const r = fakeRunner('anthropic', { outcomes: new Map([['s1', done]]) })
    expect(await r.run(req(), 'in-repl', new AbortController().signal)).toEqual(done)
    expect(r.calls[0]?.model_id).toBe('resolved-model-id')
  })

  test('an unscripted step is UNKNOWN, never a silent success', async () => {
    // The whole reason `unknown` is in the union: a fake that returned `completed`
    // by default would make every lane's happy path pass before it was written.
    const out = await fakeRunner('anthropic').run(req({ step_id: 'never-scripted' }), 'in-repl', new AbortController().signal)
    expect(out.kind).toBe('unknown')
  })

  test('liveness defaults to unknown, not to nothing', async () => {
    // A probe that cannot see must not read as "the worker is gone" — that
    // collapse is what reaps healthy builds.
    expect(await fakeRunner('anthropic').liveness({ run_id: 'r1', step_id: 's1' })).toBe('unknown')
  })
})
