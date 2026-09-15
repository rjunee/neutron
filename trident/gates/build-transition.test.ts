import { expect, test } from 'bun:test'
import { builderBranch, confirmedMerged, fixLanded } from './build-transition.ts'
import type { BuildSnapshot } from '../build-run.ts'

const head = 'a'.repeat(40)
const snapshot: BuildSnapshot = { head: 'absent', diff: '', pr: { number: 7, head, state: 'MERGED' } }

test('G023 assignment and disagreement have distinct refusals and matching controls', () => {
  expect(builderBranch(undefined, { branch: 'change' }).kind).toBe('unknown')
  expect(builderBranch(' ', { branch: 'change' }).kind).toBe('unknown')
  expect(builderBranch('change', { branch: 'other' }).kind).toBe('blocked')
  for (const payload of [null, {}, { branch: '' }, { branch: ' change ' }]) expect(builderBranch('change', payload)).toEqual({ kind: 'allow' })
})

test('G036 merge confirmation requires readable matching PR identity, not a live branch', () => {
  expect(confirmedMerged(snapshot)).toBe(true)
  expect(confirmedMerged(snapshot, { ...snapshot.pr!, head: 'b'.repeat(40), state: 'OPEN' })).toBe(true)
  expect(confirmedMerged(snapshot, { ...snapshot.pr!, number: 8 })).toBe(false)
  expect(confirmedMerged({ ...snapshot, pr: null })).toBe(false)
  for (const pr of [
    { ...snapshot.pr!, state: 'OPEN' as const }, { ...snapshot.pr!, state: 'CLOSED' as const },
    { ...snapshot.pr!, number: 0 }, { ...snapshot.pr!, number: 1.5 },
    { ...snapshot.pr!, head: '' }, { ...snapshot.pr!, head: 'short' },
  ]) expect(confirmedMerged({ ...snapshot, pr })).toBe(false)
})

test('G042 landed requires two full different OIDs and normalizes case and whitespace', () => {
  expect(fixLanded(head, 'b'.repeat(40))).toBe(true)
  expect(fixLanded(head, head)).toBe(false)
  expect(fixLanded(head, ` ${head.toUpperCase()}\n`)).toBe(false)
  for (const bad of ['', 'absent', 'short']) {
    expect(fixLanded(head, bad)).toBe(false)
    expect(fixLanded(bad, head)).toBe(false)
  }
})
