import { afterEach, expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { ReplSession } from '../adapters/claude-code/persistent/repl-session.ts'
import { sessionJsonlPath } from '../adapters/claude-code/persistent/jsonl-resumability.ts'
import { recordNativeParentLaunchEvidence } from '../adapters/claude-code/persistent/native-parent-launch-evidence.ts'
import { readProcessIdentity } from '../adapters/claude-code/persistent/process-identity.ts'
import { createNativeDispatchSigner, type NativeDispatchLease } from './claude-native-dispatch-receipt.ts'
import { admitNativeChildWorkspace, completeNativeChildWorkspace } from './native-child-workspace.ts'
import { reserveTrailerSlot } from './trailer-slot.ts'
import { CLAUDE_CONTINUATION_PROFILE } from './claude-native-continuation.ts'
import { cancelClaudeNativeChild, reconcileClaudeNativeCancellation, type NativeCancellationAuthority } from './claude-native-cancellation.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f() })

async function fixture(tool = true) {
  const root = await mkdtemp(join(tmpdir(), 'native-cancellation-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'work'), state = join(root, 'state'), common = join(root, 'git'), gitDir = join(common, 'work')
  await Promise.all([cwd, state, gitDir].map(p => mkdir(p, { recursive: true })))
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'build:0', role: 'build', model_id: 'claude-fable-5-1', effort: 'high',
    cwd, tools: 'edit-and-run', writable: true, network: true, thread: { id: 'parent' }, brief: { path: join(root, 'brief'), integrity: 'digest' },
    result: { path: join(state, 'build.result'), schema: 'fixture' }, budget: { wall_ms: 5000 }, needs_approval_decision: false }
  const key = createHash('sha256').update(JSON.stringify([request.run_id, request.step_id])).digest('hex')
  await reserveTrailerSlot(join(state, `claude-step-${key}.json`), JSON.stringify(request), request.result.path)
  const session = new ReplSession('key', 'generation', 'parent', 'channel', cwd)
  session.toolSurface = tool ? 'Agent,SendMessage,TaskStop' : 'Agent,SendMessage'
  const inputs: string[] = []
  let act = async (_line: string) => { await acknowledge() }
  session.attachChild({ pid: process.pid, write() {}, kill() {}, hasExited: () => false, exited: new Promise(() => {}),
    submitLine: async line => { inputs.push(line); await act(line) } })
  const launch = { version: 1 as const, sessionId: 'parent', childGeneration: 'generation', projectId: 'project',
    executable: { realPath: '/opt/claude', ...CLAUDE_CONTINUATION_PROFILE },
    argv: ['/opt/claude', '--session-id', 'parent', '--tools', session.toolSurface], tools: session.toolSurface.split(',') }
  recordNativeParentLaunchEvidence(session, launch)
  const workspace = await admitNativeChildWorkspace({ session, request, runId: 'run', worktree: cwd, branch: 'work', generation: 0,
    pending: () => [{ runId: 'run', stepId: 'build:0', generation: 0 }],
    git: async args => args[0] === 'symbolic-ref' ? 'refs/heads/work' : args.includes('--show-toplevel') ? cwd : args.includes('--absolute-git-dir') ? gitDir : common })
  cleanup.push(async () => completeNativeChildWorkspace(workspace))
  const signer = createNativeDispatchSigner()
  const lease: NativeDispatchLease = { scope: { ownerHandle: 'owner', projectId: 'project' }, generation: 0, token: 'lease',
    reason: 'liveChild', producer: `native-child:boot:${signer.keyDigest}`, workRef: JSON.stringify(['run', 'build:0']) }
  const actor = signer.begin(lease, request, Date.now() - 1)
  actor.prepare()
  actor.record({ kind: 'parent-bound', parent: { sessionId: 'parent', childGeneration: 'generation', pid: process.pid,
    processIdentity: readProcessIdentity(process.pid)!, launch } })
  actor.record({ kind: 'submission-started' })
  const receipt = actor.record({ kind: 'child-bound', nativeAgentId: 'child-a' })
  const transcript = sessionJsonlPath('parent', cwd, root)
  await mkdir(join(transcript, '..'), { recursive: true })
  await writeFile(transcript, '{"prefix":"retained"}\n')
  let preparation: string | undefined, held = true, releases = 0
  const authority: NativeCancellationAuthority = { lease, current: () => held, read: () => preparation,
    claim: async value => { if (preparation !== undefined || !held) return false; preparation = value; return true },
    complete: async (value, acknowledgement) => {
      if (!held || value !== preparation) return false
      expect(JSON.parse(acknowledgement).agentId).toBe('child-a')
      held = false; releases++; return true
    } }
  const rows = () => {
    const result = { message: 'Successfully stopped task: child-a (fixture)', task_id: 'child-a', task_type: 'local_agent', command: 'fixture' }
    return [
      { sessionId: 'parent', isSidechain: false, type: 'assistant', uuid: 'assistant-row', message: { role: 'assistant',
        content: [{ type: 'tool_use', name: 'TaskStop', id: 'stop-tool', input: { task_id: 'child-a' } }] } },
      { sessionId: 'parent', isSidechain: false, type: 'user', sourceToolAssistantUUID: 'assistant-row', toolUseResult: result,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'stop-tool', content: JSON.stringify(result) }] } },
    ]
  }
  async function acknowledge(transform?: (values: ReturnType<typeof rows>) => unknown[]) {
    const values = rows()
    await appendFile(transcript, (transform ? transform(values) : values).map(x => JSON.stringify(x)).join('\n') + '\n')
  }
  const options = () => ({ request, receipt, authority, stateDir: state, session, workspace, projectsDir: root,
    deadline: Date.now() + 100, signal: new AbortController().signal })
  return { options, request, receipt, authority, transcript, inputs, acknowledge, rows,
    setAct: (fn: typeof act) => { act = fn }, releases: () => releases, held: () => held }
}

test('exact native stop acknowledgement releases the original child once without writing a worker result', async () => {
  const f = await fixture()
  expect(await cancelClaudeNativeChild(f.options())).toEqual({ kind: 'stopped' })
  expect(f.inputs).toHaveLength(1); expect(f.inputs[0]).toContain('"task_id":"child-a"')
  expect(f.releases()).toBe(1)
  expect(await Bun.file(f.request.result.path).exists()).toBe(false)
  expect(await reconcileClaudeNativeCancellation(f.request, f.receipt, f.authority)).toBeUndefined()
})

test('lost submission acknowledgement recovers the exact native result after restart without resending', async () => {
  const f = await fixture()
  f.setAct(async () => { await f.acknowledge(); throw Error('lost terminal acknowledgement') })
  expect((await cancelClaudeNativeChild(f.options())).kind).toBe('unknown')
  expect(f.held()).toBe(true)
  expect(await reconcileClaudeNativeCancellation(f.request, f.receipt, { ...f.authority })).toEqual({ kind: 'stopped' })
  expect(f.inputs).toHaveLength(1); expect(f.releases()).toBe(1)
})

test('spent cancellation remains unresolved without native acknowledgement and never buys another input', async () => {
  const f = await fixture(); f.setAct(async () => {})
  expect((await cancelClaudeNativeChild(f.options())).kind).toBe('unknown')
  expect((await cancelClaudeNativeChild(f.options())).kind).toBe('unknown')
  expect(f.inputs).toHaveLength(1); expect(f.held()).toBe(true)
  await f.acknowledge()
  expect(await reconcileClaudeNativeCancellation(f.request, f.receipt, f.authority)).toEqual({ kind: 'stopped' })
})

for (const corruption of ['queued-text', 'wrong-task', 'wrong-session', 'tool-error', 'unlinked-result', 'missing-native-result', 'duplicate-invocation', 'rewritten-prefix'] as const) {
  test(`${corruption} cannot release cancellation ownership`, async () => {
    const f = await fixture()
    f.setAct(async () => {
      await f.acknowledge(values => {
        const rows: any[] = values
        if (corruption === 'queued-text') return [{ sessionId: 'parent', type: 'queue-operation', operation: 'enqueue', content: '<task-notification><task-id>child-a</task-id><status>killed</status></task-notification>' }]
        if (corruption === 'wrong-task') rows[0].message.content[0].input.task_id = 'sibling'
        if (corruption === 'wrong-session') rows[1].sessionId = 'another-parent'
        if (corruption === 'tool-error') rows[1].message.content[0].is_error = true
        if (corruption === 'unlinked-result') rows[1].sourceToolAssistantUUID = 'different-row'
        if (corruption === 'missing-native-result') delete rows[1].toolUseResult
        if (corruption === 'duplicate-invocation') rows.splice(1, 0, { ...rows[0], uuid: 'second', message: { ...rows[0].message,
          content: [{ ...rows[0].message.content[0], id: 'another-tool' }] } })
        return rows
      })
      if (corruption === 'rewritten-prefix') await writeFile(f.transcript, (await readFile(f.transcript, 'utf8')).replace('retained', 'tampered'))
    })
    expect((await cancelClaudeNativeChild(f.options())).kind).toBe('unknown')
    expect(f.held()).toBe(true); expect(f.releases()).toBe(0)
    const control = await fixture()
    expect(await cancelClaudeNativeChild(control.options())).toEqual({ kind: 'stopped' })
  })
}

test('unsupported tool profile and foreign signed child refuse before parent input', async () => {
  const missing = await fixture(false)
  expect(await cancelClaudeNativeChild(missing.options())).toEqual({ kind: 'unknown', reason: 'tool-unavailable' })
  expect(missing.inputs).toHaveLength(0)
  const other = await fixture()
  other.receipt.body.nativeAgentId = 'sibling'
  expect(await cancelClaudeNativeChild(other.options())).toEqual({ kind: 'unknown', reason: 'identity' })
  expect(other.inputs).toHaveLength(0); expect(other.held()).toBe(true)
})
