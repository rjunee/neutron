/**
 * D2 (2026-07-01) — ambient active-project context tests.
 *
 * The `AsyncLocalStorage` frame the chat-command path binds so a routed Core's
 * credential accessor can read the active project id at call time.
 */

import { expect, test } from 'bun:test'
import { currentActiveProjectId, runWithActiveProject } from '../active-project-context.ts'

test('no frame bound → currentActiveProjectId() is "" (→ global scope)', () => {
  expect(currentActiveProjectId()).toBe('')
})

test('runWithActiveProject binds the id for the duration of the callback', () => {
  const inside = runWithActiveProject('proj-alpha', () => currentActiveProjectId())
  expect(inside).toBe('proj-alpha')
  // Frame is popped after the callback returns.
  expect(currentActiveProjectId()).toBe('')
})

test('undefined / blank project id binds "" (General topic → global scope)', () => {
  expect(runWithActiveProject(undefined, () => currentActiveProjectId())).toBe('')
  expect(runWithActiveProject('   ', () => currentActiveProjectId())).toBe('')
})

test('propagates across awaits and nests (inner frame wins, outer restored)', async () => {
  const seen = await runWithActiveProject('outer', async () => {
    await Promise.resolve()
    const beforeNest = currentActiveProjectId()
    const nested = runWithActiveProject('inner', () => currentActiveProjectId())
    await Promise.resolve()
    const afterNest = currentActiveProjectId()
    return { beforeNest, nested, afterNest }
  })
  expect(seen.beforeNest).toBe('outer')
  expect(seen.nested).toBe('inner')
  expect(seen.afterNest).toBe('outer')
})
