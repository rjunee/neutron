import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { suiteFailure } from './suite-failure.ts'
import { applyReviewSuite, assessReviewSuite } from './gates/review-suite.ts'
import { reviewProgress } from './gates/review-progress.ts'

test('generic bun run test carries bounded untrusted names to the fix finding without minting identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-wrapper-'))
  try {
    const log = join(dir, 'suite.log')
    const name = 'scripts/__tests__/discover-test-files.test.ts: keeps discovery order'
    await writeFile(log, `bun test v1.3.13\nscripts/__tests__/discover-test-files.test.ts:\n(fail) keeps discovery order [11.00ms]\n 1 fail\nRan 1 test across 1 file. [11.00ms]\n${'tail filler\n'.repeat(800)}`)
    const command = 'export NEUTRON_TEST_JOBS=2\nexport NEUTRON_TEST_CONCURRENCY=1\nbun run test'
    const observed = await suiteFailure(log, command, dir)
    expect(observed.hostFailureFormat).toBe('generic')
    expect(observed.hostFailureId).toBeUndefined()
    expect(observed.hostDiagnostics).toContain(`Untrusted Bun-shaped failure lines (verify in the host log):\n${name}`)
    expect(observed.hostDiagnostics.split('Log tail:\n')[1]).not.toContain(name)
    expect(observed.hostDiagnostics.length).toBeLessThan(11_000)
    const snapshot = { head: 'a'.repeat(40), diff: '', pr: null }
    const suite = await assessReviewSuite({ observe: async () => ({ kind: 'known', runId: 'run', head: snapshot.head, round: 1,
      strategy: command, scope: 'full-suite', report: { hostExitCode: 1, ...observed } }) }, snapshot, 1, 'run')
    expect(applyReviewSuite({ kind: 'approve' }, suite)).toMatchObject({ kind: 'fix',
      findings: [expect.stringContaining(name)] })
    for (const other of ['npm test', 'bun run other', 'export OTHER=1\nbun run test']) {
      const generic = await suiteFailure(log, other, dir)
      expect(generic.hostFailureFormat).toBe('generic')
      expect(generic.hostFailureId).toBeUndefined()
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('real Bun lifecycle hooks and PATH shadowing make package-wrapper bytes untrustworthy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-wrapper-exec-'))
  try {
    const pkg = join(dir, 'package.json')
    const run = () => {
      const result = Bun.spawnSync(['bun', 'run', 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
      return { code: result.exitCode, output: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr) }
    }
    await writeFile(pkg, JSON.stringify({ scripts: { test: 'echo MAIN' } }))
    expect(run()).toMatchObject({ code: 0, output: expect.stringContaining('MAIN') })
    await writeFile(pkg, JSON.stringify({ scripts: { pretest: 'echo PRE; exit 7', test: 'echo MAIN' } }))
    const pretest = run()
    expect(pretest.code).toBe(7)
    expect(pretest.output).toContain('PRE')
    expect(pretest.output).not.toContain('MAIN')
    await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true })
    await writeFile(join(dir, 'node_modules', '.bin', 'bash'), '#!/bin/sh\necho SHADOW\nexit 7\n', { mode: 0o755 })
    await writeFile(pkg, JSON.stringify({ scripts: { test: "bash -c 'echo REAL'" } }))
    const shadow = run()
    expect(shadow.code).toBe(7)
    expect(shadow.output).toContain('SHADOW')
    expect(shadow.output).not.toMatch(/(?:^|\n)REAL(?:\n|$)/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('generic failure hints are capped even when a log contains many long names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-wrapper-bounds-'))
  try {
    const log = join(dir, 'suite.log')
    const lines = Array.from({ length: 30 }, (_, index) =>
      `tests/case-${String(index).padStart(2, '0')}.test.ts:\n(fail) ${'x'.repeat(300)} [1.00ms]\n`)
    await writeFile(log, `bun test v1.3.13\n${lines.join('')}30 fail\nRan 30 tests across 30 files. [1.00ms]\n${'tail filler\n'.repeat(800)}`)
    const result = await suiteFailure(log, 'bun run test')
    const hints = result.hostDiagnostics.split('Untrusted Bun-shaped failure lines (verify in the host log):\n')[1]!
      .split('Log tail:\n')[0]!.trimEnd().split('\n')
    expect(result.hostFailureFormat).toBe('generic')
    expect(result.hostFailureId).toBeUndefined()
    expect(hints).toHaveLength(20)
    expect(hints.every(line => line.length <= 240)).toBe(true)
    expect(result.hostDiagnostics).not.toContain('tests/case-29.test.ts')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('complete large diagnostics preserve named failures, but incomplete or crashing output never earns identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-failure-'))
  try {
    const log = join(dir, 'suite.log')
    const transcript = (diagnostic: string) => `bun test v1.3.13\ntests/example.test.ts:\n${diagnostic}\n(fail) rejects invalid input [3.00ms]\n 1 fail\nRan 1 test across 1 file. [3.00ms]\n`
    await writeFile(log, transcript('ordinary diagnostic'))
    const control = await suiteFailure(log, 'bash scripts/run-tests.sh')
    expect(control.hostFailureId).toBeDefined()
    for (const length of [21_689, 65_536]) {
      await writeFile(log, transcript('[trident] event=mutation_proof_exempt '.padEnd(length, 'x')))
      const measured = await suiteFailure(log, 'bash scripts/run-tests.sh')
      expect(measured.hostFailureId).toBe(control.hostFailureId)
      const current = { findings: [measured.hostFailureId!], blockingCount: 1 }
      expect(reviewProgress({ findings: ['resolved defect'], blockingCount: 2 }, current)).toEqual({ kind: 'allow' })
      expect(reviewProgress(current, current)).toMatchObject({ kind: 'blocked', on: expect.stringContaining('repeated finding') })
    }
    for (const diagnostic of ['x'.repeat(65_537), 'error: Cannot find module '.padEnd(21_689, 'x'),
      '\x1b[31m'.repeat(4_000) + 'SyntaxError: invalid module',
      'tests/' + 'x'.repeat(65_537) + '.test.ts:']) {
      await writeFile(log, transcript(diagnostic))
      const incomplete = await suiteFailure(log, 'bash scripts/run-tests.sh')
      expect(incomplete.hostFailureId).toBeUndefined()
      expect(reviewProgress({ findings: ['resolved defect'], blockingCount: 2 },
        { findings: [], blockingCount: 1, unknownIdentities: true })).toMatchObject({ kind: 'unknown' })
      const suite = await assessReviewSuite({ observe: async () => ({ kind: 'known', runId: 'run', head: 'head', round: 2,
        strategy: 'bash scripts/run-tests.sh', scope: 'full-suite', report: { hostExitCode: 1, hostSuiteWorker: true,
          hostComparisonEligible: true, suiteOutcome: 'failed-preexisting', suiteEvidence: `${control.hostFailureId}: reproduced at base`, ...incomplete } }) },
      { head: 'head', diff: '', pr: null }, 2, 'run')
      expect(applyReviewSuite({ kind: 'approve' }, suite).kind).toBe('fix')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('large complete file headers change failure identity instead of attributing failures to the preceding file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-failure-'))
  try {
    const log = join(dir, 'suite.log')
    const transcript = (header: string) => `bun test v1.3.13\ntests/previous.test.ts:\n${header}\n(fail) same name [3.00ms]\n 1 fail\nRan 1 test across 1 file. [3.00ms]\n`
    await writeFile(log, transcript(''))
    const previous = await suiteFailure(log, 'bun test')
    expect(previous.hostFailureId).toBeDefined()
    const header = `tests/${'x'.repeat(21_689)}.test.ts`
    await writeFile(log, transcript(`${header}:`))
    const current = await suiteFailure(log, 'bun test')
    expect(current.hostFailureId).toBeDefined()
    expect(current.hostFailureId).not.toBe(previous.hostFailureId)
    expect(current.hostDiagnostics).toContain(`${header}: same name`)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('host named failure identity survives timings and rounds but rejects a different failure or command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-failure-'))
  try {
    const log = join(dir, 'suite.log')
    const transcript = (name: string, duration: number) => `bun test v1.3.13\ntests/example.test.ts:\n(fail) ${name} [${duration}.00ms]\n 1 fail\nRan 1 test across 1 file. [${duration}.00ms]\n`
    await writeFile(log, transcript('rejects invalid input', 3))
    const first = await suiteFailure(log, 'bun test')
    expect(first.hostFailureId).toMatch(/^host-suite:[a-f0-9]{64}$/)
    await writeFile(log, transcript('rejects invalid input', 70))
    const second = await suiteFailure(log, 'bun test')
    expect(second.hostFailureId).toBe(first.hostFailureId)
    const snapshot = { head: 'b'.repeat(40), diff: '', pr: null }
    const assess = (diagnostics: typeof first, suiteEvidence: string) => assessReviewSuite({ observe: async () => ({
      kind: 'known', runId: 'run', head: snapshot.head, round: 2, strategy: 'bun test', scope: 'full-suite',
      report: { hostExitCode: 1, suiteOutcome: 'failed-preexisting', suiteEvidence, hostSuiteWorker: true, hostComparisonEligible: true, ...diagnostics },
    }) }, snapshot, 2, 'run')
    const evidence = `${first.hostFailureId}; tests/example.test.ts rejects invalid input also fails at base without diff`
    const advisory = await assess(second, evidence)
    expect(applyReviewSuite({ kind: 'approve' }, advisory).kind).toBe('approve')
    const veto = { kind: 'blocked', on: 'panel veto' } as const
    expect(applyReviewSuite(veto, advisory)).toEqual(veto)
    for (const empty of ['', ' ', 'stage-1 unrelated failure']) {
      expect(applyReviewSuite({ kind: 'approve' }, await assess(second, empty)).kind).toBe('fix')
    }
    await writeFile(log, transcript('accepts valid input', 3))
    const changed = await suiteFailure(log, 'bun test')
    expect(changed.hostFailureId).not.toBe(first.hostFailureId)
    expect(applyReviewSuite({ kind: 'approve' }, await assess(changed, evidence)).kind).toBe('fix')
    expect((await suiteFailure(log, 'other runner')).hostFailureId).not.toBe(changed.hostFailureId)
    await writeFile(log, transcript('handles SyntaxError and Unhandled errors', 3))
    expect((await suiteFailure(log, 'bun test')).hostFailureId).toBeDefined()
    for (const broken of [transcript('rejects invalid input', 3) + "error: Cannot find module './broken-by-diff'\n",
      transcript('rejects invalid input', 3).replace('Ran 1 test across 1 file. [3.00ms]', ''),
      transcript('rejects invalid input', 3).replace('1 fail', '2 fail')]) {
      await writeFile(log, broken)
      const incomplete = await suiteFailure(log, 'bun test')
      expect(incomplete.hostFailureFormat).toBe('bun')
      expect(incomplete.hostFailureId).toBeUndefined()
      expect(applyReviewSuite({ kind: 'approve' }, await assess(incomplete, evidence)).kind).toBe('fix')
    }
    await writeFile(log, 'x'.repeat(100_000) + '\nunknown failure\n')
    const unknown = await suiteFailure(log, 'bun test')
    expect(unknown.hostFailureId).toBeUndefined()
    expect(unknown.hostDiagnostics.length).toBeLessThan(6500)
    expect(applyReviewSuite({ kind: 'approve' }, await assess(unknown, evidence)).kind).toBe('fix')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
