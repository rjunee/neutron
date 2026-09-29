import { expect, test } from 'bun:test'
import { mintProjectChatOrchestratorAuthority, validateProjectChatOrchestratorAuthority } from './orchestrator-authority.ts'

const facts = { project_scope: 'owner/project', project_id: 'project', call_id: 'native-call',
  chat_id: 'thread', session_id: 'session', thread_id: 'thread', generation: 'generation', lease_id: 'lease' }
const args = { source_run_id: 'rejected', source_event_id: 19, direction: 'Revise the plan' }
const invocation = { project_scope: facts.project_scope, project_id: facts.project_id,
  call_id: facts.call_id, tool_name: 'work_board_replan_build', args }

test('only the original host object validates; JSON, copies, model facts and absent authority refuse', () => {
  const authority = mintProjectChatOrchestratorAuthority({ facts, toolName: invocation.tool_name, args, assertCurrent() {} })
  expect(validateProjectChatOrchestratorAuthority(authority, invocation)).toEqual(facts)
  for (const forged of [undefined, null, {}, facts, { ...authority }, structuredClone(authority), JSON.parse(JSON.stringify(authority))]) {
    expect(() => validateProjectChatOrchestratorAuthority(forged, invocation)).toThrow('Authenticated')
  }
})

test('invocation cannot move across project, call, tool or exact recovery source', () => {
  const authority = mintProjectChatOrchestratorAuthority({ facts, toolName: invocation.tool_name, args, assertCurrent() {} })
  for (const field of ['project_scope', 'project_id', 'call_id', 'tool_name'] as const) {
    expect(() => validateProjectChatOrchestratorAuthority(authority, { ...invocation, [field]: 'foreign' })).toThrow()
  }
  expect(() => validateProjectChatOrchestratorAuthority(authority, { ...invocation, args: { ...args, source_event_id: 20 } })).toThrow()
  expect(validateProjectChatOrchestratorAuthority(authority, { ...invocation, args: structuredClone(args) })).toEqual(facts)
})

test('captured facts and arguments cannot mutate an issued grant; live generation is rechecked', () => {
  let current = true
  let assertions = 0
  const sourceFacts = { ...facts }, sourceArgs = { ...args }
  const authority = mintProjectChatOrchestratorAuthority({ facts: sourceFacts, toolName: invocation.tool_name, args: sourceArgs,
    assertCurrent() { assertions++; if (!current) throw new Error('Owner generation changed') } })
  sourceFacts.project_id = 'foreign'; sourceArgs.source_event_id++
  const audit = validateProjectChatOrchestratorAuthority(authority, invocation)
  expect(Object.isFrozen(audit)).toBe(true)
  expect(audit).toEqual(facts)
  current = false
  expect(() => validateProjectChatOrchestratorAuthority(authority, invocation)).toThrow('generation')
  expect(assertions).toBe(3)
})
