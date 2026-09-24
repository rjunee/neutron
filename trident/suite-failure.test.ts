import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { suiteFailure } from './suite-failure.ts'
import { applyReviewSuite, assessReviewSuite } from './gates/review-suite.ts'

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

test('an oversized non-failure log line is skipped and does not void host failure identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-failure-'))
  try {
    const log = join(dir, 'suite.log')
    const base = 'bun test v1.3.13\ntests/example.test.ts:\n(fail) rejects invalid input [3.00ms]\n 1 fail\nRan 1 test across 1 file. [3.00ms]\n'
    const noise = `[trident] event=mutation_proof_exempt run_id=run branch=feat-x reason="no production file in this diff: ${'tests/support/enormous.test.ts, '.repeat(700)}"\n`
    expect(noise.length).toBeGreaterThan(20_000)
    // One long line before the file header (file unset) and one after it (file set): both are skipped.
    const withNoise = base.replace('tests/example.test.ts:\n', `${'x'.repeat(20_000)}\ntests/example.test.ts:\n${noise}`)
    await writeFile(log, base)
    const plain = await suiteFailure(log, 'bun test')
    await writeFile(log, withNoise)
    const noisy = await suiteFailure(log, 'bun test')
    expect(noisy.hostFailureId).toMatch(/^host-suite:[a-f0-9]{64}$/)
    expect(noisy.hostFailureId).toBe(plain.hostFailureId)
    expect(noisy.hostDiagnostics).toContain('Failure identity:')
    expect(noisy.hostDiagnostics.length).toBeLessThan(6500)
    // Positive controls: an oversized line that could itself be load-bearing still voids identity.
    for (const loadBearing of [
      base.replace('(fail) rejects invalid input [3.00ms]', `(fail) ${'n'.repeat(20_000)} [3.00ms]`),
      base.replace('(fail) rejects invalid input [3.00ms]', `\x1b[31m(fail)\x1b[0m ${'n'.repeat(20_000)} [3.00ms]`),
      `${withNoise}error: Cannot find module '${'m'.repeat(20_000)}'\n`,
      base.replace('Ran 1 test', `TypeError: ${'t'.repeat(20_000)}\nRan 1 test`),
    ]) {
      await writeFile(log, loadBearing)
      expect((await suiteFailure(log, 'bun test')).hostFailureId).toBeUndefined()
    }
    // A log truncated inside the oversized line (no `Ran` line) still has no identity.
    await writeFile(log, withNoise.slice(0, withNoise.indexOf('[trident]') + 5_000))
    const truncated = await suiteFailure(log, 'bun test')
    expect(truncated.hostFailureFormat).toBe('bun')
    expect(truncated.hostFailureId).toBeUndefined()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
