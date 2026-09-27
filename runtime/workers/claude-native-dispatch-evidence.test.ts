import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createClaudeActingTurn, type ClaudeActingSession, type ClaudeNativeDispatchEvidence } from './claude-acting-turn.ts'
import type { ProjectActingTurn } from './project-runners.ts'
import { sessionJsonlPath } from '../adapters/claude-code/persistent/jsonl-resumability.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-evidence-')); dirs.push(dir)
  const input: Parameters<ProjectActingTurn>[0] = {
    conversation: { project_id: 'project', topic_id: 'topic', provider: 'anthropic', spec: { tools: [], model_preference: [] } },
    request: { run_id: 'run', step_id: 'step', role: 'build', model_id: 'worker', effort: 'high', cwd: dir,
      writable: true, network: false, tools: 'edit', brief: { path: join(dir, 'brief'), integrity: 'digest' },
      result: { path: join(dir, 'result'), schema: 'v1' }, thread: { id: 'session' }, budget: { wall_ms: 1000 }, needs_approval_decision: false },
    spec: { prompt: 'dispatch', tools: [], model_preference: [] }, timeout_ms: 1000, signal: new AbortController().signal,
  }
  const evidence: ClaudeNativeDispatchEvidence[] = []
  let submitted = 0
  const binding: ClaudeActingSession = { project_id: 'project', topic_id: 'topic', projects_dir: join(dir, 'projects'),
    grants: { tools: 'edit', writable: true, network: false, roots: [dir] }, onNativeDispatchEvidence: event => { evidence.push(event) },
    session: { sessionId: 'session', cwd: dir, toolSurface: 'Agent', acquireTurn: async () => () => {},
      child: { pid: 123, hasExited: () => false, exited: new Promise(() => {}), write() {}, kill() {}, submitLine: async () => {
        submitted++; writeFileSync(input.request.result.path, JSON.stringify({ run_id: 'run', step_id: 'step' }))
      } } } }
  const transcript = sessionJsonlPath('session', dir, binding.projects_dir)
  const directory = join(transcript.slice(0, -'.jsonl'.length), 'subagents')
  const child = (agentId: string, changed: Record<string, unknown> = {}) => {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `agent-${agentId}.meta.json`), JSON.stringify({ description: 'build: step' }))
    const path = join(directory, `agent-${agentId}.jsonl`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ agentId, sessionId: 'session', isSidechain: true, type: 'user',
      message: { role: 'user', content: `Request (data): ${JSON.stringify(input.request)}` }, ...changed }) + '\n')
  }
  return { input, binding, evidence, child, submitted: () => submitted, run: () => createClaudeActingTurn(binding)(input) }
}

test.each(['provider', 'grant', 'cancelled'] as const)('pre-dispatch %s refusal emits only not-submitted', async mode => {
  const f = fixture()
  if (mode === 'provider') f.input.conversation = { ...f.input.conversation, provider: 'pi' }
  if (mode === 'grant') f.input.request = { ...f.input.request, network: true }
  if (mode === 'cancelled') f.input.signal = AbortSignal.abort()
  await f.run()
  expect(f.submitted()).toBe(0)
  expect(f.evidence).toEqual([{ kind: 'not-submitted' }])
})
test('late acquisition cannot submit after a not-submitted receipt', async () => {
  const f = fixture()
  let acquire!: (release: () => void) => void
  let released = 0
  f.binding.session.acquireTurn = () => new Promise(resolve => { acquire = resolve })
  f.input.timeout_ms = 10
  expect((await f.run()).kind).toBe('unknown')
  expect(f.evidence).toEqual([{ kind: 'not-submitted' }])
  acquire(() => { released++ })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(released).toBe(1)
  expect(f.submitted()).toBe(0)
  expect(f.evidence).toEqual([{ kind: 'not-submitted' }])
})
test.each(['write-failed', 'lost-ack'] as const)('possible submission %s never emits not-submitted', async mode => {
  const f = fixture()
  if (mode === 'write-failed') f.binding.onNativeDispatchEvidence = event => { f.evidence.push(event); throw new Error('receipt write failed') }
  else f.binding.session.child.submitLine = async () => { throw new Error('lost acknowledgement') }
  await expect(f.run()).rejects.toThrow()
  expect(f.evidence).toEqual([{ kind: 'submission-started' }])
  expect(f.submitted()).toBe(0)
})
test('submission evidence precedes even a partial transport write', async () => {
  const f = fixture()
  let attempted = 0
  f.binding.session.child.submitLine = async () => {
    expect(f.evidence).toEqual([{ kind: 'submission-started' }])
    attempted++
    throw new Error('text accepted, Enter acknowledgement lost')
  }
  await expect(f.run()).rejects.toThrow('Enter acknowledgement lost')
  expect(attempted).toBe(1)
  expect(f.evidence).toEqual([{ kind: 'submission-started' }])
})
test.each(['exact', 'wrong-session', 'wrong-request', 'duplicate'] as const)('native child evidence requires exact unique binding: %s', async mode => {
  const f = fixture()
  f.child('native-child', mode === 'wrong-session' ? { sessionId: 'foreign' } : mode === 'wrong-request'
    ? { message: { role: 'user', content: `Request (data): ${JSON.stringify({ ...f.input.request, step_id: 'foreign' })}` } } : {})
  if (mode === 'duplicate') f.child('second-child')
  expect((await f.run()).kind).toBe('turn-ended')
  expect(f.submitted()).toBe(1)
  expect(f.evidence).toEqual([{ kind: 'submission-started' }, ...(mode === 'exact'
    ? [{ kind: 'child-bound' as const, nativeAgentId: 'native-child' }] : [])])
})
