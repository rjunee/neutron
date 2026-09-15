import { expect, test } from 'bun:test'
import { assessReviewCi, applyReviewCi, deferReviewCi, type ReviewCiObservation, type ReviewCiSource } from './review-ci.ts'
import type { SuiteAssessment } from './review-suite.ts'
const head = 'a'.repeat(40), baseHead = 'b'.repeat(40)
const snapshot = { head, diff: '+code', pr: null }
const observed = (): ReviewCiObservation => ({ kind: 'known', head, status: 'red', failing: ['unit'], base: { head: baseHead, status: 'red', failing: ['unit'] } })
const assess = (value = observed()) => assessReviewCi({ observe: async () => value }, snapshot, baseHead)

test('G055 new red forces repair and matching base red holds without buying a fix', async () => {
  const advisory = await assess()
  expect(advisory).toMatchObject({ kind: 'known', findings: [{ advisory: true }] })
  expect(applyReviewCi({ kind: 'approve' }, advisory)).toMatchObject({ kind: 'blocked', on: expect.stringContaining('review-advisory-only') })
  const red = await assess({ ...observed(), failing: ['new'] })
  expect(red).toMatchObject({ kind: 'known', findings: [{ advisory: false }] })
  expect(applyReviewCi({ kind: 'approve' }, red)).toMatchObject({ kind: 'fix', findings: [expect.stringContaining('new')] })
  for (const status of ['green', 'none'] as const) expect(applyReviewCi({ kind: 'approve' }, await assess({ ...observed(), status, failing: [] }))).toEqual({ kind: 'approve' })
})

test('G055 base excuses only named measured red at the full pinned base', async () => {
  for (const base of [null, { ...observed().base!, head }, { ...observed().base!, status: 'green' as const }, { ...observed().base!, status: 'pending' as const }, { ...observed().base!, status: 'unknown' as const }, { ...observed().base!, failing: null }]) {
    expect(await assess({ ...observed(), base } as ReviewCiObservation)).toMatchObject({ kind: 'known', findings: [{ advisory: false }] })
  }
  for (const name of ['', ' ', 'unnamed check']) expect(await assess({ ...observed(), failing: [name], base: { ...observed().base!, failing: [name] } })).toMatchObject({ kind: 'known', findings: [{ advisory: false }] })
  expect(await assessReviewCi({ observe: async () => ({ ...observed(), base: { ...observed().base!, head: 'short' } }) }, snapshot, 'short')).toMatchObject({ kind: 'known', findings: [{ advisory: false }] })
})

test('G056 unknown CI observations defer and known green is a successful control', async () => {
  const sources: (ReviewCiSource | undefined)[] = [undefined,
    { observe: async () => { throw new Error('unavailable') } },
    { observe: async () => ({ kind: 'unknown', detail: 'missing check record' }) },
    ...[{ ...observed(), head: baseHead }, { ...observed(), status: 'pending' }, { ...observed(), status: 'unreadable' }, { ...observed(), failing: [] }, { ...observed(), failing: [7] }, { ...observed(), failing: null }].map(value => ({ observe: async () => value as ReviewCiObservation })),
  ]
  for (const source of sources) expect((await assessReviewCi(source, snapshot, baseHead)).kind).toBe('unknown')
  expect(await assess({ ...observed(), status: 'green', failing: [] })).toEqual({ kind: 'known', findings: [] })
  expect(deferReviewCi('pending')?.kind).toBe('unknown')
  expect(deferReviewCi('unknown')?.kind).toBe('unknown')
  expect(deferReviewCi('green')).toBeNull()
})

test('G055 CI composition preserves panel stops and includes blockers in code or design repairs', async () => {
  const red = await assess({ ...observed(), base: null })
  for (const panel of [{ kind: 'unknown', detail: 'unreadable' }, { kind: 'blocked', on: 'panel' }] as const) expect(applyReviewCi(panel, red)).toEqual(panel)
  expect(applyReviewCi({ kind: 'fix', findings: ['code'] }, red)).toMatchObject({ kind: 'fix', findings: [expect.stringContaining('CI FAILING'), 'code'] })
  expect(applyReviewCi({ kind: 're-plan', findings: ['design'], whatIsMissing: 'spec' }, red)).toMatchObject({ kind: 're-plan', findings: [expect.stringContaining('CI FAILING'), 'design'] })
  const unknown: SuiteAssessment = { kind: 'unknown', detail: 'CI unavailable' }
  expect(applyReviewCi({ kind: 'approve' }, unknown)).toEqual(unknown)
  expect(applyReviewCi({ kind: 'fix', findings: ['code'] }, await assess())).toEqual({ kind: 'fix', findings: ['code'] })
})

test('G055 malformed base entries cannot obscure readable matching base failures', async () => {
  expect(await assess({ ...observed(), base: { ...observed().base!, failing: [7, 'unit'] } } as unknown as ReviewCiObservation)).toMatchObject({ kind: 'known', findings: [{ advisory: true }] })
})
