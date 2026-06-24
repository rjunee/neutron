import { expect, test } from 'bun:test'

import { auditWorkflow } from '../detector.ts'
import type { CompletedWorkflow } from '../types.ts'

function wf(over: Partial<CompletedWorkflow>): CompletedWorkflow {
  return {
    project_slug: 'p',
    intent: 'scrape a tweet and file it',
    steps: [{ action: 'tx-scrape' }, { action: 'doc_write' }],
    artifacts: ['note.md'],
    succeeded: true,
    ...over,
  }
}

test('a successful multi-step procedure is worthy', () => {
  expect(auditWorkflow(wf({})).worthy).toBe(true)
})

test('a failed workflow is never worthy', () => {
  expect(auditWorkflow(wf({ succeeded: false })).worthy).toBe(false)
})

test('a single-step workflow is not a procedure', () => {
  const r = auditWorkflow(wf({ steps: [{ action: 'tx-scrape' }] }))
  expect(r.worthy).toBe(false)
})

test('the same action repeated is not a procedure (needs distinct steps)', () => {
  const r = auditWorkflow(
    wf({ steps: [{ action: 'doc_write' }, { action: 'doc_write (again)' }] }),
  )
  expect(r.worthy).toBe(false)
})

test('an empty intent is not worthy', () => {
  expect(auditWorkflow(wf({ intent: '   ' })).worthy).toBe(false)
})
