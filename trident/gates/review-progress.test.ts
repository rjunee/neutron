import { expect, test } from 'bun:test'
import { reviewProgress } from './review-progress.ts'

test('progress unreadable host evidence stays unknown', () => {
  for (const current of [undefined, { findings: [''], blockingCount: 1 }, { findings: ['a'], blockingCount: -1 }, { findings: ['a'], blockingCount: NaN }, { findings: ['a'], blockingCount: 1.5 }]) {
    expect(reviewProgress(undefined, current)).toMatchObject({ kind: 'unknown' })
  }
  expect(reviewProgress(undefined, { findings: ['a'], blockingCount: 1 })).toEqual({ kind: 'allow' })
})

test('G070 repeats stop regardless of the current or previous severity count', () => {
  for (const before of [0, 1]) for (const after of [0, 1]) {
    expect(reviewProgress({ findings: ['same'], blockingCount: before }, { findings: ['same'], blockingCount: after })).toEqual({ kind: 'blocked', on: 'Review requires orchestrator arbitration: repeated finding',
      reviewStop: { trigger: 'repeat-finding', previous: { findings: ['same'], blockingCount: before }, current: { findings: ['same'], blockingCount: after } } })
  }
  expect(reviewProgress({ findings: ['old'], blockingCount: 1 }, { findings: ['new'], blockingCount: 0 })).toEqual({ kind: 'allow' })
})

test('G071 compares readable code counts, excluding advisory-only rounds', () => {
  for (const count of [2, 3]) expect(reviewProgress({ findings: ['old'], blockingCount: 2 }, { findings: ['new'], blockingCount: count })).toEqual({ kind: 'blocked', on: 'Review requires orchestrator arbitration: no-progress',
    reviewStop: { trigger: 'no-progress', previous: { findings: ['old'], blockingCount: 2 }, current: { findings: ['new'], blockingCount: count } } })
  for (const [before, after] of [[2, 1], [1, 0], [0, 1], [0, 0]]) expect(reviewProgress({ findings: ['old'], blockingCount: before! }, { findings: ['new'], blockingCount: after! })).toEqual({ kind: 'allow' })
})

test('G072 unidentified suite failures cannot establish repetition or improvement', () => {
  const first = { findings: ['panel defect'], blockingCount: 2, unknownIdentities: true }
  const red = { findings: [], blockingCount: 1, unknownIdentities: true }
  expect(reviewProgress(undefined, first)).toEqual({ kind: 'allow' })
  expect(reviewProgress(first, red)).toEqual({ kind: 'unknown', detail: 'Review progress cannot compare unidentified host suite failures' })
  expect(reviewProgress(red, red)).toEqual({ kind: 'blocked', on: 'Review requires orchestrator arbitration: no-progress', reviewStop: { trigger: 'no-progress', previous: red, current: red } })
  expect(reviewProgress(first, { findings: [], blockingCount: 0 })).toEqual({ kind: 'allow' })
  expect(reviewProgress(first, { findings: ['panel defect'], blockingCount: 1 })).toEqual({ kind: 'blocked', on: 'Review requires orchestrator arbitration: repeated finding',
    reviewStop: { trigger: 'repeat-finding', previous: first, current: { findings: ['panel defect'], blockingCount: 1 } } })
})
