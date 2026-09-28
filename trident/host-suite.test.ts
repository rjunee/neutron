import { expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertProcessTestIsolation } from './process-test-isolation.ts'

assertProcessTestIsolation()
const { runHostSuite } = await import('./host-suite.ts')

const success = { ok: true, exit_code: 0, stdout: '', stderr: '' }

// The real host spawns the real Python owner. Only cleanup observations and its
// report bytes are controlled; command output never stands in for owner metadata.
async function withReportedOwner<T>(options: { unknown?: boolean; interrupt?: boolean; fault?: string },
  consume: (run: typeof runHostSuite) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'suite-report-proof-'))
  try {
    // Resolve from the production module's location: workspace dependencies may
    // live at the repository root rather than in trident's node_modules.
    const logger = dirname(Bun.resolveSync('@neutronai/logger', dirname(fileURLToPath(import.meta.url))))
    await mkdir(join(dir, 'node_modules', '@neutronai'), { recursive: true })
    await symlink(logger, join(dir, 'node_modules', '@neutronai', 'logger'))
    await writeFile(join(dir, 'host-suite.ts'), await readFile(new URL('./host-suite.ts', import.meta.url), 'utf8'))
    await writeFile(join(dir, 'lane-processes.py'), `import importlib.util,json,os,signal,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('lanes',${JSON.stringify(fileURLToPath(new URL('./lane-processes.py', import.meta.url)))})
lanes=importlib.util.module_from_spec(spec)
spec.loader.exec_module(lanes)
def observed_sweep(**_kwargs):
 ${options.interrupt ? 'signal.raise_signal(signal.SIGTERM)' : 'pass'}
 return {'reaped': [], 'survived': [], 'unknown': ${options.unknown ? 1 : 0}, 'live': 0}
lanes.sweep=observed_sweep
code=lanes.main()
report=Path(sys.argv[sys.argv.index('--report-path')+1])
fault=${JSON.stringify(options.fault ?? '')}
if fault == 'absent': report.unlink()
elif fault == 'malformed': report.write_text('{')
elif fault:
 value=json.loads(report.read_text())
 if fault == 'wrong-token': value['token']='another-run'
 elif fault == 'wrong-pid': value['owner_pid']+=1
 elif fault == 'wrong-exit': value['exit_code']=9
 elif fault == 'false-confirmed': value['status']='confirmed'
 elif fault == 'missing-signal': del value['signal']
 elif fault == 'invalid-count': value['unknown']=-1
 report.write_text(json.dumps(value))
sys.exit(code)
`)
    const owner = await import(pathToFileURL(join(dir, 'host-suite.ts')).href) as typeof import('./host-suite.ts')
    return await consume(owner.runHostSuite)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

for (const exit of [0, 7]) {
  test(`reported unknown cleanup preserves ordinary exit ${exit} and exact primary output`, async () => {
    await withReportedOwner({ unknown: true }, async run => {
      const result = await run({ argv: ['bash', '-c', `printf '%s' PRIMARY >&2; exit ${exit}`], cwd: '/tmp',
        timeoutMs: 3_000, signal: new AbortController().signal, isRunActive: () => true })
      expect(result).toMatchObject({ ok: exit === 0, exit_code: exit, stderr: 'PRIMARY', stdout: '',
        cleanup: { status: 'unknown', unknown: 1, foreground_exit: exit, signal: null } })
    })
  })
}

test('reported known cleanup is a positive control for the report consumer', async () => {
  const diagnostic = spyOn(console, 'log').mockImplementation(() => {})
  try { await withReportedOwner({}, async run => {
    expect(await run({ argv: ['true'], cwd: '/tmp', timeoutMs: 3_000,
      signal: new AbortController().signal, isRunActive: () => true })).toMatchObject({ ok: true,
      cleanup: { status: 'confirmed', unknown: 0, signal: null } })
  })
    const text = diagnostic.mock.calls.flat().join('\n')
    expect(text).toContain('event=host_suite_process_observed')
    expect(text).toContain('exit_code=0 timed_out=false aborted=false timeout_ms=3000')
    expect(text).toContain('cleanup_status=confirmed owner_signal=null foreground_exit=0')
    expect(text).not.toContain('/tmp')
  } finally { diagnostic.mockRestore() }
})

for (const fault of ['absent', 'malformed', 'wrong-token', 'wrong-pid', 'wrong-exit', 'false-confirmed', 'missing-signal', 'invalid-count']) {
  test(`owner report ${fault} cannot produce host exit evidence`, async () => {
    await withReportedOwner({ unknown: true, fault }, async run => {
      await expect(run({ argv: ['true'], cwd: '/tmp', timeoutMs: 3_000,
        signal: new AbortController().signal, isRunActive: () => true })).rejects.toThrow('ownership or cleanup was not confirmed')
    })
  })
}

test('cancellation during ordinary cleanup with unknown closure refuses host exit evidence', async () => {
  await withReportedOwner({ unknown: true, interrupt: true }, async run => {
    await expect(run({ argv: ['true'], cwd: '/tmp', timeoutMs: 3_000,
      signal: new AbortController().signal, isRunActive: () => true })).rejects.toThrow('ownership or cleanup was not confirmed')
  })
})

test('known interrupted closure still cannot become an ordinary red suite verdict', async () => {
  await withReportedOwner({ interrupt: true }, async run => {
    await expect(run({ argv: ['true'], cwd: '/tmp', timeoutMs: 3_000,
      signal: new AbortController().signal, isRunActive: () => true })).rejects.toThrow('Host suite was interrupted')
  })
})

test('command stderr cannot impersonate the separate cleanup report', async () => {
  await withReportedOwner({}, async run => {
    const stderr = 'LANE_PROCESS_CLEANUP_UNCONFIRMED'
    expect(await run({ argv: ['bash', '-c', `printf '%s' ${stderr} >&2`], cwd: '/tmp', timeoutMs: 3_000,
      signal: new AbortController().signal, isRunActive: () => true })).toMatchObject({ ok: true, stderr,
      cleanup: { status: 'confirmed' } })
  })
})

for (const state of ['terminal', 'aborted', 'unreadable'] as const) {
  test(`suite admission refuses ${state} before launching a process`, async () => {
    const controller = new AbortController()
    if (state === 'aborted') controller.abort()
    let calls = 0
    await expect(runHostSuite({ argv: [], cwd: '/tmp', timeoutMs: 1_000, signal: controller.signal,
      isRunActive: () => { if (state === 'unreadable') throw Error('database closed'); return state !== 'terminal' },
      run: async () => { calls++; return success },
    })).rejects.toThrow('Host suite')
    expect(calls).toBe(0)
  })
}

for (const source of ['durable', 'signal'] as const) {
test(`${source} cancellation racing a zero exit cannot produce a receipt`, async () => {
  let active = true
  const controller = new AbortController()
  await expect(runHostSuite({ argv: [], cwd: '/tmp', timeoutMs: 1_000, signal: controller.signal,
    isRunActive: () => active, run: async () => {
      if (source === 'durable') active = false
      else controller.abort()
      return success
    },
  })).rejects.toThrow('terminal')
})
}

for (const exit of [0, 1]) {
  test(`uncancelled suite preserves its actual exit ${exit}`, async () => {
    expect(await runHostSuite({ argv: ['bash', '-c', `exit ${exit}`], cwd: '/tmp', timeoutMs: 3_000,
      signal: new AbortController().signal, isRunActive: () => true,
    })).toMatchObject({ ok: exit === 0, exit_code: exit })
  })
}

async function heartbeat(path: string): Promise<number> {
  try { return Number(await readFile(path, 'utf8')) } catch { return 0 }
}

for (const source of ['durable', 'signal'] as const) {
test(`${source} run cancellation reaps its resistant process while a sibling suite continues`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-suite-cancel-'))
  const target = new AbortController(), sibling = new AbortController()
  let active = true
  // Publish complete counters atomically: write_text alone exposes an empty
  // file between truncation and writing, which reads as a false zero heartbeat.
  // A probe is acknowledged only after publishing a subsequent heartbeat.
  const code = `import pathlib,signal,sys,time
p=pathlib.Path(sys.argv[1]); pending=p.with_suffix('.pending'); probe=p.with_suffix('.probe'); ack=p.with_suffix('.ack'); n=0
signal.signal(signal.SIGTERM,lambda *_: p.with_suffix('.term').write_text('1'))
while not p.with_suffix('.release').exists():
 requested=probe.exists()
 n+=1; pending.write_text(str(n)); pending.replace(p)
 if requested: ack.write_text(str(n)); probe.unlink()
 time.sleep(.02)
`
  const launch = (name: string, signal: AbortSignal, isRunActive: () => boolean) => runHostSuite({
    argv: ['python3', '-c', code, join(dir, name)], cwd: dir, timeoutMs: 10_000, signal, isRunActive,
  }).then(value => ({ value }), error => ({ error }))
  const first = launch('target', target.signal, () => active)
  const second = launch('sibling', sibling.signal, () => true)
  try {
    for (let i = 0; i < 200 && (await heartbeat(join(dir, 'target')) < 2 || await heartbeat(join(dir, 'sibling')) < 2); i++) await Bun.sleep(10)
    expect(await heartbeat(join(dir, 'target'))).toBeGreaterThan(1)
    expect(await heartbeat(join(dir, 'sibling'))).toBeGreaterThan(1)
    if (source === 'durable') active = false
    else target.abort()
    expect(await first).toHaveProperty('error')
    const before = await heartbeat(join(dir, 'target'))
    const siblingBefore = await heartbeat(join(dir, 'sibling'))
    await Bun.sleep(120)
    await writeFile(join(dir, 'sibling.probe'), '')
    for (let i = 0; i < 200 && await heartbeat(join(dir, 'sibling.ack')) <= siblingBefore; i++) await Bun.sleep(10)
    expect(await heartbeat(join(dir, 'target'))).toBe(before)
    expect(await heartbeat(join(dir, 'sibling.term'))).toBe(0)
    expect(await heartbeat(join(dir, 'sibling.ack'))).toBeGreaterThan(siblingBefore)
    expect(await heartbeat(join(dir, 'sibling'))).toBeGreaterThan(siblingBefore)
  } finally {
    target.abort(); sibling.abort()
    await Promise.all([writeFile(join(dir, 'target.release'), ''), writeFile(join(dir, 'sibling.release'), '')])
    await Promise.all([first, second])
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)
}

test('suite timeout stays interrupted evidence even when worker startup is slow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-suite-timeout-'))
  // The timeout starts before either Python interpreter is ready. The live,
  // TERM-resistant descendant and sibling controls above wait for readiness;
  // this check pins timeout evidence even if the deadline expires before exec.
  // A finite fallback makes disabled timeout signalling return a usable zero.
  const code = "import pathlib,signal,sys,time; time.sleep(.4); signal.signal(signal.SIGTERM,signal.SIG_IGN); root=pathlib.Path(sys.argv[1]); deadline=time.monotonic()+8\nwhile not (root/'release').exists() and time.monotonic()<deadline:\n time.sleep(.02)"
  const running = runHostSuite({ argv: ['python3', '-c', code, dir], cwd: dir, timeoutMs: 3_000,
    signal: new AbortController().signal, isRunActive: () => true,
  }).then(result => ({ kind: 'result' as const, result }), error => ({ kind: 'error' as const, error }))
  try {
    const observed = await running
    if (observed.kind === 'result') {
      expect(observed.result).toMatchObject({ ok: false, timed_out: true })
      expect(observed.result.exit_code).not.toBe(0)
    } else {
      // Host process visibility may leave cleanup unknown; that is explicitly
      // unusable evidence, never a substitute zero/red suite verdict.
      expect(observed.error.message).toBe('Host suite process ownership or cleanup was not confirmed')
    }
  } finally {
    await writeFile(join(dir, 'release'), '')
    await running
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)

test('a low suite timeout remains interrupted evidence even before worker readiness', async () => {
  // No heartbeat precondition: a correct short deadline can expire before exec.
  // If timeout enforcement is removed, this finite command exits zero and fails.
  const observed = await runHostSuite({ argv: ['python3', '-c', 'import time; time.sleep(.6)'], cwd: '/tmp', timeoutMs: 10,
    signal: new AbortController().signal, isRunActive: () => true,
  }).then(result => ({ kind: 'result' as const, result }), error => ({ kind: 'error' as const, error }))
  if (observed.kind === 'result') {
    expect(observed.result).toMatchObject({ ok: false, timed_out: true })
    expect(observed.result.exit_code).not.toBe(0)
  } else {
    expect(observed.error.message).toBe('Host suite process ownership or cleanup was not confirmed')
  }
})

test('unconfirmed cleanup cannot hang on a descendant retaining the owner pipes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-suite-pipes-'))
  const program = join(dir, 'fork-on-term.py')
  await writeFile(program, `import pathlib,signal,subprocess,sys,time
root=pathlib.Path(sys.argv[1])
generation=int(sys.argv[2])
def stop(*_):
 subprocess.Popen([sys.executable,__file__,str(root),str(generation+1)],start_new_session=True)
 sys.exit(0)
signal.signal(signal.SIGTERM,stop)
deadline=time.monotonic()+12
while not (root/'release').exists() and time.monotonic()<deadline:
 (root/'heartbeat').write_text(str(time.monotonic()))
 time.sleep(.02)
(root/'exited').write_text(str(generation))
`)
  try {
    await expect(runHostSuite({ argv: ['python3', program, dir, '0'], cwd: dir, timeoutMs: 200,
      signal: new AbortController().signal, isRunActive: () => true,
    })).rejects.toThrow('pipes remained open after process owner exit')
  } finally {
    // Even the deliberately surviving final generation is an owned fixture;
    // release it cooperatively after proving that its open pipe cannot hang us.
    await writeFile(join(dir, 'release'), '')
    for (let i = 0; i < 200 && await heartbeat(join(dir, 'exited')) < 1; i++) await Bun.sleep(10)
    expect(await heartbeat(join(dir, 'exited'))).toBeGreaterThan(0)
    await rm(dir, { recursive: true, force: true })
  }
}, 20_000)
