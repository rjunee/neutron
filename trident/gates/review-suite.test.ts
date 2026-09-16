import { expect, test } from 'bun:test'
import { applyReviewSuite, assessReviewSuite, type SuiteObservation } from './review-suite.ts'
const snapshot = { head: 'a'.repeat(40), diff: '+code', pr: null }
const approve = { kind: 'approve' } as const
function fixture() {
  const observation: SuiteObservation = { kind: 'known', runId: 'run', head: snapshot.head, round: 2, strategy: 'run full suite', scope: 'full-suite', report: { hostExitCode: 0, suiteOutcome: 'passed' } }
  const source = { observe: async () => observation }
  const assess = () => assessReviewSuite(source, snapshot, 2, 'run')
  const decide = async () => applyReviewSuite(approve, await assess())
  return { observation, source, assess, decide }
}
test('G063 full suite rejection and dispatched subset deferral are distinct', async () => {
  const f = fixture()
  expect(await f.decide()).toEqual(approve)
  for (const scope of ['full-suite', 'subset'] as const) {
    f.observation.scope = scope
    for (const suiteOutcome of ['not-run', 'failed-new', 'deferred', 'passed', undefined]) {
      f.observation.report = { hostExitCode: 1, ...(suiteOutcome === undefined ? {} : { suiteOutcome }) }
      expect((await f.decide()).kind).toBe(scope === 'subset' && suiteOutcome === 'deferred' ? 'approve' : 'fix')
    }
  }
  f.observation.report = null
  expect((await f.decide()).kind).toBe('unknown')
  f.observation.strategy = ''
  expect(await f.decide()).toEqual(approve)
  f.observation.strategy = 'run full suite'
  f.observation.report = { hostExitCode: 0 }
  expect(await f.decide()).toEqual(approve)
})
test('G063 distinguishes host-observed pass, failure, and unknown', async () => {
  const f = fixture()
  f.observation.report = { hostExitCode: 0 }
  expect(await f.decide()).toEqual(approve)
  f.observation.report = { hostExitCode: 1 }
  expect(await f.decide()).toMatchObject({ kind: 'fix', findings: [expect.stringContaining('FULL SUITE NOT PROVEN')] })
  for (const report of [null, {}, { hostExitCode: 1.5 }]) {
    f.observation.report = report
    expect(await f.decide()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('Host-observed') })
  }
})
test('G065 evidence earns an advisory finding and never waives panel rejection', async () => {
  const f = fixture()
  for (const suiteEvidence of [undefined, '', ' \n ']) {
    f.observation.report = { hostExitCode: 1, suiteOutcome: 'failed-preexisting', ...(suiteEvidence === undefined ? {} : { suiteEvidence }) }
    expect(await f.decide()).toMatchObject({ kind: 'fix', findings: [expect.stringContaining('WITHOUT EVIDENCE')] })
  }
  f.observation.report!.suiteEvidence = 'base: named.test.ts fails without diff'
  const suite = await f.assess()
  expect(suite).toMatchObject({ kind: 'known', findings: [{ advisory: true, evidence: expect.stringContaining('base: named.test.ts') }] })
  expect(applyReviewSuite(approve, suite)).toEqual(approve)
  const rejection = { kind: 'fix', findings: ['code defect'], blockingCount: 1 } as const
  expect(applyReviewSuite(rejection, suite)).toEqual(rejection)
})
test('suite observation must establish source, identity and dispatch configuration', async () => {
  expect(await assessReviewSuite(undefined, snapshot, 2, 'run')).toMatchObject({ kind: 'unknown' })
  expect(await assessReviewSuite({ observe: async () => { throw Error('offline') } }, snapshot, 2, 'run')).toMatchObject({ kind: 'unknown' })
  expect(await assessReviewSuite({ observe: async () => ({ kind: 'unknown', detail: 'checkpoint missing' }) }, snapshot, 2, 'run')).toEqual({ kind: 'unknown', detail: 'checkpoint missing' })
  for (const change of [{ kind: 'other' }, { runId: 'other' }, { head: 'b'.repeat(40) }, { round: 1 }, { strategy: null }, { scope: 'worker-choice' }]) {
    const f = fixture(); Object.assign(f.observation, change)
    expect((await f.decide()).kind).toBe('unknown')
  }
  for (const report of [{ hostExitCode: 'zero' }, { hostExitCode: 0, suiteOutcome: 1 }, { hostExitCode: 1, suiteEvidence: 1 }]) {
    const f = fixture(); Object.assign(f.observation, { report })
    expect((await f.decide()).kind).toBe('unknown')
  }
  expect(await fixture().decide()).toEqual(approve)
})
test('suite thrown host cause is bounded and normal refusal text is unchanged', async () => {
  expect(await assessReviewSuite({ observe: async () => { throw new Error('recognisable suite failure') } }, snapshot, 2, 'run')).toEqual({
    kind: 'unknown', detail: 'Review suite host observation failed: Error: recognisable suite failure',
  })
  expect(await assessReviewSuite({ observe: async () => ({ kind: 'known', runId: 'other', head: snapshot.head, round: 2, strategy: '', scope: 'subset', report: null }) }, snapshot, 2, 'run')).toEqual({
    kind: 'unknown', detail: 'Review suite record does not match run, revision and round',
  })
})
test('suite composition preserves stops and combines repairs with code and re-plan decisions', async () => {
  const f = fixture(); f.observation.report = { hostExitCode: 1 }
  const suite = await f.assess()
  for (const panel of [{ kind: 'unknown', detail: 'panel missing' }, { kind: 'blocked', on: 'peer deferred' }] as const) expect(applyReviewSuite(panel, suite)).toEqual(panel)
  expect(applyReviewSuite(approve, { kind: 'unknown', detail: 'missing' })).toEqual({ kind: 'unknown', detail: 'missing' })
  for (const panel of [{ kind: 'fix', findings: ['code'], blockingCount: 2 }, { kind: 're-plan', findings: ['code'], whatIsMissing: 'requirement' }] as const) {
    expect(applyReviewSuite(panel, suite)).toMatchObject({ ...panel, findings: [expect.stringContaining('FULL SUITE NOT PROVEN'), 'code'], blockingCount: panel.kind === 'fix' ? 3 : 2 })
  }
})
