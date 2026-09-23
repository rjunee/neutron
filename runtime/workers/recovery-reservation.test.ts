import { afterEach, expect, spyOn, test } from 'bun:test'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { claudeInReplRunner } from './claude-in-repl.ts'
import { codexInReplRunner } from './codex-in-repl.ts'
import { piInReplRunner } from './pi-in-repl.ts'
import { readArmedTrailerReservation } from './trailer-slot.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => fs.rm(path, { recursive: true, force: true }))) })

async function fixture(provider: 'claude' | 'codex' | 'pi') {
  const dir = await fs.mkdtemp(join(tmpdir(), 'reservation-recovery-')); dirs.push(dir)
  const req: BoundedWorkRequest = { run_id: 'run', step_id: 'step', role: 'build', model_id: 'model', effort: null,
    cwd: dir, tools: 'none', writable: false, network: false, thread: null, needs_approval_decision: false,
    brief: { path: join(dir, 'brief'), integrity: 'brief' }, result: { path: join(dir, 'result'), schema: 'result' },
    budget: { wall_ms: 1000 } }
  const key = createHash('sha256').update(JSON.stringify([req.run_id, req.step_id])).digest('hex')
  const reservation = join(dir, `${provider}-step-${key}.json`)
  const armed = JSON.stringify(req) + '\n#dispatch-armed\n'
  let composed = 0
  const construct = { claude: claudeInReplRunner, codex: codexInReplRunner, pi: piInReplRunner }[provider]
  const runner = construct({ state_dir: dir, topic_id: 'topic', subagent: 'worker',
    spec: { tools: [], model_preference: ['model'] },
    async composeActingTurn() { composed++; return '' },
    decodeTrailer: () => ({ kind: 'blocked' as const, on: 'retained result' }),
  })
  await fs.writeFile(req.result.path, 'retained result')
  const recover = (request = req, signal = new AbortController().signal) => runner.recover!(request, 'in-repl', signal)
  return { dir, req, reservation, armed, recover, composed: () => composed }
}

async function bounded<T>(work: Promise<T>): Promise<T | 'unbounded'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<'unbounded'>(resolve => { timer = setTimeout(() => resolve('unbounded'), 500) })]) }
  finally { clearTimeout(timer) }
}

for (const provider of ['claude', 'codex', 'pi'] as const) {
  for (const kind of ['fifo', 'symlink', 'oversize', 'malformed', 'directory'] as const) {
    test(`${provider} recovery rejects ${kind} reservation promptly without altering evidence`, async () => {
      const f = await fixture(provider)
      const request = { ...f.req, budget: { wall_ms: 35 } }
      const armed = JSON.stringify(request) + '\n#dispatch-armed\n'
      if (kind === 'fifo') expect(spawnSync('mkfifo', [f.reservation]).status).toBe(0)
      if (kind === 'symlink') {
        await fs.writeFile(join(f.dir, 'target'), armed)
        await fs.symlink(join(f.dir, 'target'), f.reservation)
      }
      if (kind === 'directory') await fs.mkdir(f.reservation)
      if (kind === 'oversize' || kind === 'malformed') await fs.writeFile(f.reservation, kind === 'oversize' ? 'x'.repeat(256 * 1024 + 1) : '{malformed')
      const before = await fs.lstat(f.reservation)
      const originalOpen = fs.open
      let reads = 0
      const opened = spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
        const file = await originalOpen(path, flags, mode)
        const originalRead = file.read.bind(file)
        spyOn(file, 'read').mockImplementation((...args: any[]) => { reads++; return (originalRead as any)(...args) })
        return file
      })
      const controller = new AbortController()
      const abort = setTimeout(() => controller.abort(), 35)
      try {
        const result = await bounded(f.recover(request, controller.signal))
        expect(result).not.toBe('unbounded')
        expect(result).toMatchObject({ kind: 'unknown' })
        const after = await fs.lstat(f.reservation)
        expect([after.mode, after.size, after.mtimeMs, after.ctimeMs]).toEqual([before.mode, before.size, before.mtimeMs, before.ctimeMs])
        expect(await fs.readFile(f.req.result.path, 'utf8')).toBe('retained result')
        if (kind === 'symlink') expect(await fs.readFile(join(f.dir, 'target'), 'utf8')).toBe(armed)
        if (kind !== 'malformed') expect(reads).toBe(0)
        expect(f.composed()).toBe(0)
      } finally {
        clearTimeout(abort)
        opened.mockRestore()
        // Release a blocked reader under the deliberately broken FIFO mutant.
        if (kind === 'fifo') { const release = await fs.open(f.reservation, constants.O_RDWR | constants.O_NONBLOCK); await release.close() }
      }
    })
  }

  test(`${provider} recovery rejects a growing regular reservation snapshot`, async () => {
    const f = await fixture(provider)
    await fs.writeFile(f.reservation, f.armed)
    const originalOpen = fs.open
    const opened = spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const file = await originalOpen(path, flags, mode)
      if (path === f.reservation) {
        const originalStat = file.stat.bind(file)
        let stats = 0
        spyOn(file, 'stat').mockImplementation((async (options: Parameters<typeof file.stat>[0]) => {
          if (++stats === 2) await fs.appendFile(f.reservation, 'growth')
          return originalStat(options)
        }) as typeof file.stat)
      }
      return file
    })
    try {
      expect(await bounded(f.recover())).toMatchObject({ kind: 'unknown' })
      expect(await fs.readFile(f.reservation, 'utf8')).toBe(f.armed + 'growth')
      expect(await fs.readFile(f.req.result.path, 'utf8')).toBe('retained result')
      expect(f.composed()).toBe(0)
    } finally { opened.mockRestore() }
  })

  for (const interruption of ['abort', 'deadline'] as const) {
    test(`${provider} recovery bounds a stalled reservation open by ${interruption}`, async () => {
      const f = await fixture(provider)
      await fs.writeFile(f.reservation, f.armed)
      let release!: () => void
      let stalledOpenReleased = false
      const stalled = new Promise<void>(resolve => {
        release = () => { stalledOpenReleased = true; resolve() }
      })
      const originalOpen = fs.open
      const opened = spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
        if (path === f.reservation) await stalled
        return originalOpen(path, flags, mode)
      })
      const controller = new AbortController()
      const timer = interruption === 'abort' ? setTimeout(() => controller.abort(), 25) : undefined
      try {
        expect(await bounded(f.recover({ ...f.req, budget: { wall_ms: interruption === 'deadline' ? 35 : 1000 } }, controller.signal))).toMatchObject({ kind: 'unknown' })
        expect(stalledOpenReleased).toBeFalse()
        expect(await fs.readFile(f.reservation, 'utf8')).toBe(f.armed)
        expect(f.composed()).toBe(0)
      } finally { clearTimeout(timer); release(); opened.mockRestore() }
    })
  }

  test(`${provider} recovery accepts unchanged exact armed regular evidence`, async () => {
    const f = await fixture(provider)
    await fs.writeFile(f.reservation, f.armed)
    expect(await bounded(f.recover())).toEqual({ kind: 'blocked', on: 'retained result' })
    expect(await fs.readFile(f.reservation, 'utf8')).toBe(f.armed)
    expect(f.composed()).toBe(0)
  })
}

test('reservation reader refuses a device descriptor before reading bytes', async () => {
  const originalOpen = fs.open
  let reads = 0
  const opened = spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const file = await originalOpen(path, flags, mode)
    const originalRead = file.read.bind(file)
    spyOn(file, 'read').mockImplementation((...args: any[]) => { reads++; return (originalRead as any)(...args) })
    return file
  })
  try {
    expect(await bounded(readArmedTrailerReservation('/dev/null', 'identity'))).toMatchObject({ kind: 'unknown' })
    expect(reads).toBe(0)
  } finally { opened.mockRestore() }
})
