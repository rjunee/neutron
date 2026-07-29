import { expect, test } from 'bun:test'

import { auditWorkflow } from '../detector.ts'
import { completedWorkflowFromTridentRun } from '../trident-adapter.ts'

const base = {
  phase: 'done',
  project_slug: 'p',
  task: 'add a reactions feature',
  branch: 'feat/reactions',
  pr: 26,
  ralph: false,
  chat_id: 'chat',
  thread_id: 'thread',
}

test('a done trident run maps to a skill-worthy multi-step workflow', () => {
  const wf = completedWorkflowFromTridentRun(base)
  expect(wf.succeeded).toBe(true)
  expect(wf.intent).toBe('add a reactions feature')
  expect(wf.topic_id).toBe('chat:thread')
  expect(wf.artifacts).toEqual(['branch feat/reactions', 'PR #26'])
  expect(wf.steps.map((s) => s.action)).toContain('trident.argus-review')
  expect(auditWorkflow(wf).worthy).toBe(true)
})

test('ralph mode swaps the build step', () => {
  const wf = completedWorkflowFromTridentRun({ ...base, ralph: true })
  expect(wf.steps.map((s) => s.action)).toContain('trident.ralph-task')
})

test('a non-done run is not marked succeeded', () => {
  const wf = completedWorkflowFromTridentRun({ ...base, phase: 'failed' })
  expect(wf.succeeded).toBe(false)
  expect(auditWorkflow(wf).worthy).toBe(false)
})
