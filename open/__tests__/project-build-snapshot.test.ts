import { expect, test } from 'bun:test'
import { decodeProjectTrailer } from '@neutronai/runtime/workers/project-runners.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { validSnapshot } from '../wiring/project-build.ts'

const payload = { mutationClaim: null, worktreePath: '/fixture/worktree', branch: 'fixture', commitSha: 'a'.repeat(40),
  prNumber: 17, diffFile: '/fixture/diff', testsPassed: true }
const request = { run_id: 'fixture-run', step_id: 'fixture-build', result: { schema: 'project-build' } } as BoundedWorkRequest
const host = { schemas: new Map([['project-build', (value: unknown) => validSnapshot(value, 'forge')]]), metadata: () => undefined }
function decode(pr: unknown, forge: unknown = payload) {
  return decodeProjectTrailer(JSON.stringify({ schema: 'project-build', run_id: request.run_id, step_id: request.step_id,
    kind: 'completed', result: { head: 'a'.repeat(40), diff: '', pr, payload: forge } }), request, host)
}

test('valid PR snapshot objects survive decoding unchanged, separately from forge prNumber', () => {
  for (const state of ['OPEN', 'CLOSED', 'MERGED']) {
    const pr = { number: 17, head: 'b'.repeat(40), state }
    expect(decode(pr)).toMatchObject({ kind: 'completed', result: { pr, payload: { prNumber: 17 } } })
  }
})

test('null is a valid no-PR snapshot and is never synthesized from the forge PR number', () => {
  expect(decode(null)).toMatchObject({ kind: 'completed', result: { pr: null, payload: { prNumber: 17 } } })
})

test.each([17, 'https://example.invalid/pull/17', [], {}, { number: 17 },
  { number: '17', head: 'a', state: 'OPEN' }, { number: 0, head: 'a', state: 'OPEN' },
  { number: 1.5, head: 'a', state: 'OPEN' }, { number: 17, head: null, state: 'OPEN' },
  { number: 17, head: 'a', state: 'open' }].map(pr => [pr]))('malformed outer PR is refused with a field-specific diagnostic: %j', pr => {
  const outcome = decode(pr)
  expect(outcome.kind).toBe('unknown')
  if (outcome.kind !== 'unknown') throw new Error('Malformed snapshot was accepted')
  expect(outcome.detail).toContain('Project snapshot contract: result.pr')
  if (typeof pr === 'number') expect(outcome.detail).toContain('result.payload.prNumber')
})

test('outer diagnostics never echo untrusted PR or payload evidence', () => {
  const sentinel = 'UNTRUSTED_SNAPSHOT_SECRET_SENTINEL'
  const outcome = decode({ number: 17, head: 'a', state: sentinel }, { ...payload, suiteEvidence: sentinel })
  expect(JSON.stringify(outcome)).not.toContain(sentinel)
  expect(outcome).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('result.pr.state') })
})

test('valid outer PR cannot bypass role payload validation or envelope identity', () => {
  const result = { head: 'a', diff: '', pr: null, payload: { ...payload, testsPassed: 'true' } }
  expect(validSnapshot(result, 'forge')).toBe(false)
  expect(decodeProjectTrailer(JSON.stringify({ schema: 'project-build', run_id: 'other-run', step_id: request.step_id,
    kind: 'completed', result }), request, host)).toEqual({ kind: 'not-current-step' })
})
