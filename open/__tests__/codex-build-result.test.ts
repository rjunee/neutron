import { afterEach, expect, test } from 'bun:test'
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { BoundedWorkRequest, WorkerRunner } from '@neutronai/runtime/bounded-work.ts'
import { createProjectRunners, decodeProjectTrailer, type ProjectTrailerDecoder } from '@neutronai/runtime/workers/project-runners.ts'
import { codexBuildResultTransport } from '../wiring/codex-build-result.ts'
import { reserveTrailerSlot } from '@neutronai/runtime/workers/trailer-slot.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture(wallMs = 1000) {
  const root = mkdtempSync(join(tmpdir(), 'codex-result-test-')); directories.push(root)
  const projectDir = join(root, 'project'), stateDir = join(root, 'owner-home', '.trident', 'project-builds', 'run')
  mkdirSync(projectDir); mkdirSync(stateDir, { recursive: true })
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'build-1', role: 'build', model_id: 'gpt-5.5', effort: null,
    cwd: projectDir, writable: true, network: true, tools: 'edit-and-run', brief: { path: join(stateDir, 'build.brief'), integrity: 'fixture' },
    result: { path: join(stateDir, 'build.result'), schema: 'fixture' }, thread: null, budget: { wall_ms: wallMs }, needs_approval_decision: false }
  const trailer: ProjectTrailerDecoder = { schemas: new Map([['fixture', value => !!value && typeof value === 'object' && 'answer' in value && typeof value.answer === 'string']]), metadata: () => undefined }
  const envelope = (input = request, answer = 'accepted') => JSON.stringify({ schema: input.result.schema, run_id: input.run_id, step_id: input.step_id, kind: 'completed', result: { answer } })
  let calls = 0
  const run = async (effect: WorkerRunner['run'], input = request) => {
    let lease: Awaited<ReturnType<ReturnType<typeof codexBuildResultTransport>['prepare']>> | undefined
    const signal = new AbortController().signal
    try {
      lease = await codexBuildResultTransport({ projectId: 'project', projectDir, stateDir, runId: 'run', trailer }).prepare(input, signal, 'dispatch')
      calls++
      await effect({ ...input, result: { ...input.result, path: lease.resultPath } }, 'in-repl', signal)
      if (!await lease.publish()) return { kind: 'unknown' as const }
      return decodeProjectTrailer(readFileSync(input.result.path, 'utf8'), input, trailer)
    } catch { return { kind: 'unknown' as const } }
    finally { lease?.close() }
  }
  return { root, projectDir, stateDir, request, trailer, envelope, run, calls: () => calls }
}

test.each(['completed', 'blocked'] as const)('publishes exact %s bytes from staged native output to the canonical sibling-home slot', async kind => {
  const f = fixture()
  const bytes = kind === 'completed' ? f.envelope() : JSON.stringify({ schema: 'fixture', run_id: 'run', step_id: 'build-1', kind, on: 'bounded reason' })
  let staged = ''
  expect((await f.run(async request => {
    staged = request.result.path
    expect(staged.startsWith(join(f.projectDir, '.neutron', 'build-results'))).toBe(true)
    expect(request.brief.path).toBe(f.request.brief.path)
    expect(existsSync(f.request.result.path)).toBe(false)
    writeFileSync(staged, bytes)
    return decodeProjectTrailer(bytes, request, f.trailer) as never
  })).kind).toBe(kind)
  expect(readFileSync(f.request.result.path, 'utf8')).toBe(bytes)
  expect(statSync(staged).ino).not.toBe(statSync(f.request.result.path).ino)
})

test.each(['run_id', 'step_id', 'schema', 'payload'] as const)('refuses captured %s mismatch even when inner worker returns completed', async field => {
  const f = fixture()
  expect((await f.run(async request => {
    const value = JSON.parse(f.envelope())
    if (field === 'payload') value.result = { answer: false }
    else value[field] = 'foreign'
    writeFileSync(request.result.path, JSON.stringify(value))
    return { kind: 'completed', result: { answer: 'accepted' }, usage: null, model_reported: null, thread_id: null }
  })).kind).toBe('unknown')
  expect(existsSync(f.request.result.path)).toBe(false)
})

test.each(['invalid', 'different-valid'] as const)('decode captured A then swap %s B publishes only captured validated A', async swap => {
  const f = fixture()
  let staged = ''
  let swapped = false
  const validate = f.trailer.schemas.get('fixture')!
  ;(f.trailer.schemas as Map<string, (value: unknown) => boolean>).set('fixture', value => {
    if (!swapped) {
      swapped = true
      writeFileSync(staged, swap === 'invalid' ? '{}' : f.envelope(f.request, 'swapped'))
    }
    return validate(value)
  })
  expect((await f.run(async request => {
    staged = request.result.path
    writeFileSync(staged, f.envelope())
    return { kind: 'completed', result: { answer: 'accepted' }, usage: null, model_reported: null, thread_id: null }
  })).kind).toBe('completed')
  expect(swapped).toBe(true)
  expect(readFileSync(f.request.result.path, 'utf8')).toBe(f.envelope())
})

test('a child-held writable descriptor cannot mutate the installed canonical artifact', async () => {
  const f = fixture()
  let fd: number | undefined
  try {
    expect((await f.run(async request => {
      fd = openSync(request.result.path, 'w+')
      writeFileSync(fd, f.envelope())
      return decodeProjectTrailer(f.envelope(), request, f.trailer) as never
    })).kind).toBe('completed')
    expect(fstatSync(fd!).ino).not.toBe(statSync(f.request.result.path).ino)
    writeFileSync(fd!, 'CHILD_REWRITE')
    expect(readFileSync(f.request.result.path, 'utf8')).toBe(f.envelope())
  } finally { if (fd !== undefined) closeSync(fd) }
})

test.each(['final', 'ancestor'] as const)('refuses a staged %s symlink without publishing', async kind => {
  const f = fixture()
  expect((await f.run(async request => {
    const target = join(f.root, 'foreign'); mkdirSync(target)
    writeFileSync(join(target, 'result.json'), f.envelope())
    if (kind === 'final') symlinkSync(join(target, 'result.json'), request.result.path)
    else { renameSync(dirname(request.result.path), `${dirname(request.result.path)}-old`); symlinkSync(target, dirname(request.result.path)) }
    return decodeProjectTrailer(f.envelope(), request, f.trailer) as never
  })).kind).toBe('unknown')
  expect(existsSync(f.request.result.path)).toBe(false)
})

test('an existing staging ancestor symlink refuses before native work', async () => {
  const f = fixture()
  const target = join(f.root, 'foreign'); mkdirSync(target)
  symlinkSync(target, join(f.projectDir, '.neutron'))
  expect((await f.run(async () => { throw new Error('must not call') })).kind).toBe('unknown')
  expect(f.calls()).toBe(0)
})

test('foreign canonical destination refuses before native work', async () => {
  const f = fixture()
  expect((await f.run(async () => { throw new Error('must not call') }, { ...f.request, result: { ...f.request.result, path: join(f.root, 'global.result') } })).kind).toBe('unknown')
  expect(f.calls()).toBe(0)
  expect(existsSync(join(f.root, 'global.result'))).toBe(false)
})

test('failed atomic installation is unknown, not an accepted result', async () => {
  const f = fixture()
  mkdirSync(f.request.result.path)
  expect((await f.run(async request => {
    writeFileSync(request.result.path, f.envelope())
    return decodeProjectTrailer(f.envelope(), request, f.trailer) as never
  })).kind).toBe('unknown')
  expect(statSync(f.request.result.path).isDirectory()).toBe(true)
})

test('invalid UTF-8 source bytes refuse rather than publishing replacement characters', async () => {
  const f = fixture()
  expect((await f.run(async request => {
    const before = f.envelope().split('accepted')
    writeFileSync(request.result.path, Buffer.concat([Buffer.from(before[0]!), Buffer.from([0xff]), Buffer.from(before[1]!)]))
    return { kind: 'completed', result: { answer: 'replacement' }, usage: null, model_reported: null, thread_id: null }
  })).kind).toBe('unknown')
  expect(existsSync(f.request.result.path)).toBe(false)
})

test('a FIFO result refuses without blocking the host read', async () => {
  const f = fixture()
  expect((await f.run(async request => {
    expect(Bun.spawnSync(['mkfifo', request.result.path]).exitCode).toBe(0)
    return { kind: 'completed', result: { answer: 'not a file' }, usage: null, model_reported: null, thread_id: null }
  })).kind).toBe('unknown')
  expect(existsSync(f.request.result.path)).toBe(false)
})

test.each(['before-install', 'after-install'] as const)('host replacement %s publishes the same staged receipt without another child dispatch', async point => {
  const f = fixture()
  let calls = 0
  const transport = codexBuildResultTransport({ projectId: 'project', projectDir: f.projectDir, stateDir: f.stateDir, runId: 'run', trailer: f.trailer })
  const options = { conversation: { project_id: 'project', topic_id: 'topic', provider: 'openai-codex' as const, spec: { tools: [], model_preference: [] } },
    run_id: 'run', state_dir: f.stateDir, trailer: f.trailer, headless: {},
    actingTurn: async (turn: { request: BoundedWorkRequest }) => {
      calls++
      writeFileSync(turn.request.result.path, f.envelope())
      return { kind: 'turn-ended' as const }
    } }
  const first = await createProjectRunners({ ...options, codexResultTransport: { async prepare(...args) {
    const lease = await transport.prepare(...args)
    return { ...lease, async publish() {
      if (point === 'after-install') expect(await lease.publish()).toBe(true)
      throw new Error('Host stopped before terminal observation was returned')
    } }
  } } })
  expect((await first.inRepl!.run(f.request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(existsSync(f.request.result.path)).toBe(point === 'after-install')
  const replacement = await createProjectRunners({ ...options, codexResultTransport: transport })
  expect((await replacement.inRepl!.run(f.request, 'in-repl', new AbortController().signal)).kind).toBe('completed')
  expect(readFileSync(f.request.result.path, 'utf8')).toBe(f.envelope())
  expect(calls).toBe(1)
})

test('resume refuses missing transport authority instead of minting a replacement stage', async () => {
  const f = fixture()
  const transport = codexBuildResultTransport({ projectId: 'project', projectDir: f.projectDir, stateDir: f.stateDir, runId: 'run', trailer: f.trailer })
  await expect(transport.prepare(f.request, new AbortController().signal, 'resume')).rejects.toThrow()
  expect(existsSync(join(f.projectDir, '.neutron'))).toBe(false)
})

test.each([false, true])('exclusive dispatch clears preexisting same-step stage; fresh child output=%s', async fresh => {
  const f = fresh ? fixture() : fixture(80)
  expect(f.request.budget.wall_ms).toBe(fresh ? 1000 : 80)
  const transport = codexBuildResultTransport({ projectId: 'project', projectDir: f.projectDir, stateDir: f.stateDir, runId: 'run', trailer: f.trailer })
  const lease = await transport.prepare(f.request, new AbortController().signal, 'dispatch')
  writeFileSync(lease.resultPath, f.envelope(f.request, 'stale'))
  lease.close()
  let calls = 0
  let staleAtDispatch = false
  const runners = await createProjectRunners({ conversation: { project_id: 'project', topic_id: 'topic', provider: 'openai-codex', spec: { tools: [], model_preference: [] } },
    run_id: 'run', state_dir: f.stateDir, trailer: f.trailer, headless: {}, codexResultTransport: transport,
    actingTurn: async turn => {
      calls++
      staleAtDispatch = existsSync(turn.request.result.path)
      if (fresh) {
        await Bun.sleep(150)
        writeFileSync(turn.request.result.path, f.envelope())
      }
      return { kind: 'turn-ended' }
    } })
  expect((await runners.inRepl!.run(f.request, 'in-repl', new AbortController().signal)).kind).toBe(fresh ? 'completed' : 'unknown')
  expect(calls).toBe(1)
  expect(staleAtDispatch).toBe(false)
  expect(existsSync(f.request.result.path)).toBe(fresh)
  if (fresh) expect(readFileSync(f.request.result.path, 'utf8')).toBe(f.envelope())
})

test('unarmed concurrent loser and armed resume never clear the winning child receipt', async () => {
  const f = fixture()
  const transport = codexBuildResultTransport({ projectId: 'project', projectDir: f.projectDir, stateDir: f.stateDir, runId: 'run', trailer: f.trailer })
  const lease = await transport.prepare(f.request, new AbortController().signal, 'dispatch')
  const reservation = join(f.stateDir, 'exclusive.json'), identity = JSON.stringify(f.request)
  let release!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  const winner = reserveTrailerSlot(reservation, identity, f.request.result.path, async () => {
    await lease.clearForDispatch(); entered(); await waiting
  })
  try {
    await ready
    writeFileSync(lease.resultPath, f.envelope())
    expect((await reserveTrailerSlot(reservation, identity, f.request.result.path, lease.clearForDispatch)).kind).toBe('unknown')
    expect(readFileSync(lease.resultPath, 'utf8')).toBe(f.envelope())
    release()
    expect((await winner).kind).toBe('dispatch')
    expect((await reserveTrailerSlot(reservation, identity, f.request.result.path, lease.clearForDispatch)).kind).toBe('resume')
    expect(await lease.publish()).toBe(true)
    expect(readFileSync(f.request.result.path, 'utf8')).toBe(f.envelope())
  } finally { release(); await winner; lease.close() }
})

test('failed exclusive stage clear leaves an unarmed reservation and cannot dispatch or resume', async () => {
  const f = fixture()
  const reservation = join(f.stateDir, 'exclusive.json'), identity = JSON.stringify(f.request)
  let clears = 0
  const clear = async () => { clears++; throw new Error('Clear failed') }
  expect((await reserveTrailerSlot(reservation, identity, f.request.result.path, clear)).kind).toBe('unknown')
  expect(readFileSync(reservation, 'utf8')).toBe(identity)
  expect((await reserveTrailerSlot(reservation, identity, f.request.result.path, clear)).kind).toBe('unknown')
  expect(clears).toBe(1)
})

test.each(['review', 'synthesis'] as const)('exact host-minted %s panel slot has no arbitrary owner-home destination authority', async role => {
  const f = fixture()
  const name = `review-${'0123456789abcdef'.repeat(4)}`
  const panel = join(f.stateDir, name); mkdirSync(panel)
  const request: BoundedWorkRequest = { ...f.request, role, step_id: `${name}:1:0`, brief: { ...f.request.brief, path: join(panel, 'brief.json') },
    result: { schema: 'verdict', path: join(panel, 'result.json') }, writable: false, tools: 'read-only' }
  ;(f.trailer.schemas as Map<string, (value: unknown) => boolean>).set('verdict', f.trailer.schemas.get('fixture')!)
  expect((await f.run(async child => {
    writeFileSync(child.result.path, f.envelope(request))
    return decodeProjectTrailer(f.envelope(request), request, f.trailer) as never
  }, request)).kind).toBe('completed')
  expect(readFileSync(request.result.path, 'utf8')).toBe(f.envelope(request))
  expect((await f.run(async () => { throw new Error('must not call') }, { ...request, result: { ...request.result, path: join(f.stateDir, 'global.result') } })).kind).toBe('unknown')
  expect(f.calls()).toBe(1)
})

test.each(['legacy', 'short', 'long', 'uppercase', 'nonhex', 'traversal', 'suffix', 'newline', 'zero-round', 'negative-attempt', 'foreign-brief'] as const)
('durable panel transport refuses %s identity before native work', async damage => {
  const f = fixture()
  const digest = '0123456789abcdef'.repeat(4)
  const name = damage === 'legacy' ? 'review-aB123z'
    : damage === 'short' ? `review-${digest.slice(1)}`
    : damage === 'long' ? `review-${digest}0`
    : damage === 'uppercase' ? `review-${digest.toUpperCase()}`
    : damage === 'nonhex' ? `review-g${digest.slice(1)}`
    : damage === 'traversal' ? `../review-${digest}` : `review-${digest}`
  const panel = join(f.stateDir, name); mkdirSync(panel)
  const step = `${name}:${damage === 'zero-round' ? 0 : 1}:${damage === 'negative-attempt' ? -1 : 0}`
  const request: BoundedWorkRequest = { ...f.request, role: 'review',
    step_id: `${step}${damage === 'suffix' ? ':extra' : damage === 'newline' ? '\n' : ''}`,
    brief: { ...f.request.brief, path: join(damage === 'foreign-brief' ? f.stateDir : panel, 'brief.json') },
    result: { schema: 'verdict', path: join(panel, 'result.json') }, writable: false, tools: 'read-only' }
  ;(f.trailer.schemas as Map<string, (value: unknown) => boolean>).set('verdict', f.trailer.schemas.get('fixture')!)
  expect((await f.run(async child => {
    writeFileSync(child.result.path, f.envelope(request))
    return decodeProjectTrailer(f.envelope(request), request, f.trailer) as never
  }, request)).kind).toBe('unknown')
  expect(f.calls()).toBe(0)
  expect(existsSync(request.result.path)).toBe(false)
})
