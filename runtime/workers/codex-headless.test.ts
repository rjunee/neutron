import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { createCodexHeadlessRunner } from './codex-headless.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-headless-'))
  const script = join(dir, 'wrapper.sh')
  const seen = join(dir, 'seen.env')
  const threads = join(dir, 'threads')
  writeFileSync(script, `#!/bin/bash\nenv > ${JSON.stringify(seen)}\nprintf '%s\\n' "$NEUTRON_CODEX_THREAD_ID" >> ${JSON.stringify(threads)}\necho 'stdout-is-not-the-result'\nprintf 'HEAD=measured-head\\nSTATUS=ok\\n' > "$NEUTRON_CODEX_BUILD_TRAILER_FILE"\n`)
  chmodSync(script, 0o755)
  const request = (over: Partial<BoundedWorkRequest> = {}): BoundedWorkRequest => ({
    run_id: 'run-1', step_id: 'step-1', role: 'build', model_id: 'gpt-test', effort: 'high',
    cwd: dir, writable: true, network: false, tools: 'edit-and-run',
    brief: { path: join(dir, 'brief'), integrity: '7:receipt' },
    result: { schema: 'FORGE', path: join(dir, 'trailer') }, thread: null,
    budget: { wall_ms: 5_000 }, needs_approval_decision: false, ...over,
  })
  return { script, seen, threads, request }
}

describe('Codex headless WorkerRunner', () => {
  test('returns the measured trailer rather than stdout', async () => {
    const f = fixture()
    const runner = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    const outcome = await runner.run(f.request(), 'headless', new AbortController().signal)
    expect(outcome.kind).toBe('completed')
    if (outcome.kind === 'completed') expect(outcome.result).toEqual({ HEAD: 'measured-head', STATUS: 'ok' })
  })

  test('scrubs every GitHub credential family at spawn and retains an ordinary control', async () => {
    const f = fixture()
    const runner = createCodexHeadlessRunner({
      buildScript: f.script, probe: { ok: true },
      env: { PATH: process.env.PATH, GH_TOKEN: 'secret', GH_ENTERPRISE_TOKEN: 'secret', GITHUB_TOKEN: 'secret', RUNNER_CONTROL: 'visible' },
    })
    expect((await runner.run(f.request(), 'headless', new AbortController().signal)).kind).toBe('completed')
    const childEnv = readFileSync(f.seen, 'utf8')
    expect(childEnv).toContain('RUNNER_CONTROL=visible')
    expect(childEnv).not.toContain('GH_TOKEN=')
    expect(childEnv).not.toContain('GH_ENTERPRISE_TOKEN=')
    expect(childEnv).not.toContain('GITHUB_TOKEN=')
  })

  test('a second call carries the same durable thread id', async () => {
    const f = fixture()
    const runner = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    const threaded = f.request({ thread: { id: 'thread-42' } })
    const first = await runner.run(threaded, 'headless', new AbortController().signal)
    const second = await runner.run({ ...threaded, step_id: 'step-2' }, 'headless', new AbortController().signal)
    expect(first.kind === 'completed' && first.thread_id).toBe('thread-42')
    expect(second.kind === 'completed' && second.thread_id).toBe('thread-42')
    expect(readFileSync(f.threads, 'utf8')).toBe('thread-42\nthread-42\n')
  })

  test('unsupported placement and roles are refused, never failed', async () => {
    const f = fixture()
    const runner = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    expect(runner.supports('build', 'in-repl')).toEqual(expect.objectContaining({ ok: false, reason: 'placement-unavailable' }))
    expect(runner.supports('arbitrate', 'headless')).toEqual(expect.objectContaining({ ok: false, reason: 'capability-unsupported' }))
    expect(await runner.run(f.request({ role: 'arbitrate' }), 'headless', new AbortController().signal)).toEqual({ kind: 'refused', reason: 'capability-unsupported' })
  })

  test('an unavailable startup probe refuses admission', () => {
    const runner = createCodexHeadlessRunner({ probe: { ok: false, reason: 'provider-not-connected', detail: 'not logged in' } })
    expect(runner.supports('build', 'headless')).toEqual({ ok: false, reason: 'provider-not-connected', detail: 'not logged in' })
  })

  test('approval decisions cannot be requested from a worker', () => {
    const f = fixture()
    // @ts-expect-error The bounded-work contract deliberately permits only false.
    const invalid: BoundedWorkRequest = f.request({ needs_approval_decision: true })
    expect(invalid.needs_approval_decision as boolean).toBe(true)
  })
})
