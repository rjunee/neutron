import { expect, test } from 'bun:test'
import { applyReviewSuite, assessReviewSuite, type SuiteObservation } from './review-suite.ts'
const snapshot = { head: 'a'.repeat(40), diff: '+code', pr: null }
const approve = { kind: 'approve' } as const

test('a deferred subset trusts host scope, while a full-suite unreadable receipt is unknown', async () => {
  const observe = async () => ({ kind: 'known' as const, runId: 'run', head: snapshot.head, round: 2,
    strategy: 'subset instructions', scope: 'subset' as const, report: { suiteOutcome: 'deferred' } })
  expect(await assessReviewSuite({ observe }, snapshot, 2, 'run')).toEqual({ kind: 'known', findings: [] })
  const full = async () => ({ ...(await observe()), scope: 'full-suite' as const })
  expect(await assessReviewSuite({ observe: full }, snapshot, 2, 'run')).toEqual({ kind: 'unknown', detail: 'Host-observed review suite exit code is missing or unreadable' })
})
test('a deferred subset carries failed-preexisting evidence without trusting its outcome to select scope', async () => {
  const f = fixture()
  f.observation.scope = 'subset'
  f.observation.report = { suiteOutcome: 'failed-preexisting', suiteEvidence: 'base red on named.test.ts' }
  expect(await f.assess()).toEqual({ kind: 'known', findings: [{
    title: 'FULL SUITE RED FOR PRE-EXISTING REASONS',
    evidence: 'Untrusted build transcription; verify the base comparison and named failures before approving:\nbase red on named.test.ts',
    advisory: true,
  }] })
  for (const suiteOutcome of [undefined, 'deferred', 'failed-new', 'unexpected-worker-value']) {
    f.observation.report = suiteOutcome === undefined ? {} : { suiteOutcome }
    expect(await f.assess()).toEqual({ kind: 'known', findings: [] })
  }
  f.observation.report = { suiteOutcome: 'failed-preexisting' }
  expect(await f.assess()).toMatchObject({ kind: 'known', findings: [{ title: 'FAILED-PREEXISTING CLAIMED WITHOUT EVIDENCE', advisory: false }] })
})
test('a NULL report keeps its own diagnostic even on a subset round', async () => {
  // ORDERING REGRESSION. `report?.hostExitCode === undefined` is also true when `report` is
  // null, so putting the subset exemption first silently turns "no command was derivable"
  // into "this round deferred its suite" — collapsing the two states a sibling commit exists
  // to separate. Adversarial review caught exactly that; this pins the order.
  const f = fixture()
  f.observation.scope = 'subset'
  f.observation.report = null
  expect(await f.assess()).toEqual({ kind: 'unknown', detail: 'No full-suite command is derivable from the test strategy' })
  // And the full-suite round keeps the same diagnostic, so the fix is about the state, not the scope.
  f.observation.scope = 'full-suite'
  expect(await f.assess()).toEqual({ kind: 'unknown', detail: 'No full-suite command is derivable from the test strategy' })
})
function fixture() {
  const observation: SuiteObservation = { kind: 'known', runId: 'run', head: snapshot.head, round: 2, strategy: 'run full suite', scope: 'full-suite', report: { hostExitCode: 0, suiteOutcome: 'passed' } }
  const source = { observe: async () => observation }
  const assess = () => assessReviewSuite(source, snapshot, 2, 'run')
  const decide = async () => applyReviewSuite(approve, await assess())
  return { observation, source, assess, decide }
}
test('G063 rejects a nonzero host receipt — advisory only for an EVIDENCED failed-preexisting claim — and never accepts a deferred claim', async () => {
  const f = fixture()
  expect(await f.decide()).toEqual(approve)
  for (const scope of ['full-suite', 'subset'] as const) {
    f.observation.scope = scope
    for (const suiteOutcome of ['not-run', 'failed-new', 'deferred', 'passed', undefined]) {
      f.observation.report = { hostExitCode: 1, ...(suiteOutcome === undefined ? {} : { suiteOutcome }) }
      expect((await f.decide()).kind).toBe('fix')
    }
  }
  // THE ONE DELIBERATE EXCEPTION, asserted in both directions so the title cannot
  // drift from the code again. This loop used to skip `failed-preexisting`
  // entirely, which is how a title claiming "every nonzero receipt rejects" sat
  // green over a gate that does not do that — and the gate inventory copied the
  // claim. The gates are the spec; the prose describes them, not the other way.
  f.observation.scope = 'full-suite'
  f.observation.report = { hostExitCode: 1, suiteOutcome: 'failed-preexisting' }
  expect(await f.decide()).toMatchObject({ kind: 'fix', findings: [expect.stringContaining('WITHOUT EVIDENCE')] })
  f.observation.report = { hostExitCode: 1, suiteOutcome: 'failed-preexisting', hostFailureId: 'host-suite:x', suiteEvidence: 'host-suite:x; base red on x.test.ts; re-ran at merge-base: red' }
  // Evidenced: advisory, so the panel's approve stands — the human verifies the comparison.
  expect(await f.decide()).toEqual(approve)
  f.observation.report = null
  expect(await f.assess()).toEqual({ kind: 'unknown', detail: 'No full-suite command is derivable from the test strategy' })
  f.observation.strategy = ''
  expect(await f.decide()).toEqual(approve)
  f.observation.strategy = 'run full suite'
  f.observation.report = { hostExitCode: 0 }
  expect(await f.decide()).toEqual(approve)
})
test('G063 distinguishes no derivable command from an unreadable host receipt', async () => {
  const f = fixture()
  f.observation.report = { hostExitCode: 0 }
  expect(await f.decide()).toEqual(approve)
  f.observation.report = { hostExitCode: 1 }
  expect(await f.decide()).toMatchObject({ kind: 'fix', findings: [expect.stringContaining('FULL SUITE NOT PROVEN')] })
  f.observation.report = null
  expect(await f.assess()).toEqual({ kind: 'unknown', detail: 'No full-suite command is derivable from the test strategy' })
  for (const report of [{}, { hostExitCode: 1.5 }]) {
    f.observation.report = report
    expect(await f.assess()).toEqual({ kind: 'unknown', detail: 'Host-observed review suite exit code is missing or unreadable' })
  }
})
test('G065 evidence earns an advisory finding and never waives panel rejection', async () => {
  const f = fixture()
  for (const suiteEvidence of [undefined, '', ' \n ']) {
    f.observation.report = { hostExitCode: 1, suiteOutcome: 'failed-preexisting', ...(suiteEvidence === undefined ? {} : { suiteEvidence }) }
    expect(await f.decide()).toMatchObject({ kind: 'fix', findings: [expect.stringContaining('WITHOUT EVIDENCE')] })
  }
  f.observation.report!.hostFailureId = 'host-suite:named'
  f.observation.report!.suiteEvidence = 'host-suite:named; base: named.test.ts fails without diff'
  const suite = await f.assess()
  expect(suite).toMatchObject({ kind: 'known', findings: [{ advisory: true, evidence: expect.stringContaining('base: named.test.ts') }] })
  expect(applyReviewSuite(approve, suite)).toEqual(approve)
  const rejection = { kind: 'fix', findings: ['code defect'], blockingCount: 1 } as const
  expect(applyReviewSuite(rejection, suite)).toEqual(rejection)
})

test('G065 preserves legacy full-suite evidence while host-suite generic evidence requires an actual prior host-red fix dispatch', async () => {
  const f = fixture()
  f.observation.report = { hostExitCode: 1, suiteOutcome: 'failed-preexisting', suiteEvidence: 'pytest tests/test_base.py is also red at base without diff', hostFailureFormat: 'generic' }
  expect(await f.decide()).toEqual(approve)
  f.observation.report.hostSuiteWorker = true
  expect((await f.decide()).kind).toBe('fix')
  f.observation.report.hostComparisonEligible = true
  expect(await f.decide()).toEqual(approve)
  f.observation.report.hostFailureFormat = 'bun'
  expect((await f.decide()).kind).toBe('fix')
  f.observation.report.hostFailureFormat = 'generic'
  f.observation.report.suiteEvidence = ''
  expect((await f.decide()).kind).toBe('fix')
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
