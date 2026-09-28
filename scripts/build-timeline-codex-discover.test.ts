import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { combineTimelineSources } from '@neutronai/trident/build-timeline-catalogue.ts'
import { createTimelineHandler } from './build-timeline-server.ts'
import { discoverCodexRollouts, importCodexSessionTree, importDiscoveredCodexRollouts } from './build-timeline-codex-discover.ts'
import type { CodexImportOptions } from './build-timeline-codex-import.ts'

const temporary: string[] = []
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }) })

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'timeline-native-discovery-'))
  temporary.push(home)
  const root = join(home, 'sessions')
  const day = join(root, '2026', '09', '28')
  await mkdir(day, { recursive: true })
  const cwd = join(home, 'private-worktree')
  const options: CodexImportOptions = {
    repositories: ['example/project'], evidenceRef: 'codex:discovered',
    bindings: [{ cwd, startedAt: 1000, endedAt: 10000, links: [{ repository: 'example/project', prNumber: 7 }] }],
  }
  const line = (type: string, payload: object, timestamp = 1000) => JSON.stringify({ type, payload, timestamp: new Date(timestamp).toISOString() })
  const rollout = (session: string, commandId: string, command = 'bun test private.test.ts') => [
    line('session_meta', { id: session }),
    line('turn_context', { turn_id: 'turn-1', model: 'model-a' }),
    line('event_msg', { type: 'item_completed', thread_id: session, turn_id: 'turn-1', started_at_ms: 2000, completed_at_ms: 4000,
      item: { type: 'CommandExecution', id: commandId, command: ['/bin/bash', '-lc', command], cwd,
        status: 'completed', exit_code: 0, stdout: 'PRIVATE OUTPUT' } }, 4000),
  ].join('\n') + '\n'
  return { home, root, day, options, rollout }
}

test('a newly created dated rollout is discovered and its attested command reaches the authenticated dashboard', async () => {
  const { root, day, options, rollout, home } = await fixture()
  expect(await discoverCodexRollouts(root)).toEqual([])
  await writeFile(join(day, 'rollout-first.jsonl'), rollout('thread-1', 'exec-1'))
  const first = await importCodexSessionTree(root, options)
  expect(first.coverage).toEqual({ discovered: 1, emitted: 1, unbound: 0, incomplete: 0 })
  await writeFile(join(day, 'rollout-second.jsonl'), rollout('thread-2', 'exec-2'))
  const second = await importCodexSessionTree(root, options)
  expect(second.coverage.discovered).toBe(2)
  expect(second.observations.map(row => row.phaseId)).toEqual(['codex:thread-1:exec-1', 'codex:thread-2:exec-2'])
  const snapshot = combineTimelineSources({ observedAt: 10000, repositories: [] }, second.observations, [], 10000)
  const handler = createTimelineHandler({ username: 'viewer', password: 'fixture', read: () => snapshot })
  const response = await handler(new Request('http://localhost/api/timeline', {
    headers: { authorization: `Basic ${Buffer.from('viewer:fixture').toString('base64')}` },
  }))
  expect(response.status).toBe(200)
  const body = await response.text()
  const segments = (JSON.parse(body) as { cards: Array<{ segments: Array<{ model: string | null; start: number; end: number; usage: { input: number | null } }> }> }).cards[0]!.segments
  expect(segments).toHaveLength(2)
  expect(segments[0]).toMatchObject({ model: 'model-a', start: 2000, end: 4000, usage: { input: null } })
  for (const privateText of [home, 'private.test.ts', 'PRIVATE OUTPUT']) expect(body).not.toContain(privateText)
})

test('discovery leaves commands without time-scoped PR evidence unassigned', async () => {
  const { root, day, options, rollout } = await fixture()
  await writeFile(join(day, 'rollout-unbound.jsonl'), rollout('thread-1', 'exec-1'))
  const result = await importCodexSessionTree(root, { ...options, bindings: [] })
  expect(result).toMatchObject({ observations: [], coverage: { discovered: 1, emitted: 0, unbound: 1 } })
})

test('invalid attribution scope is refused before an empty tree can report success', async () => {
  const { root, options } = await fixture()
  await expect(importCodexSessionTree(root, { ...options, repositories: [] })).rejects.toThrow('scope')
})

test('a discovered task requires an exact session and turn phase binding', async () => {
  const { root, day, options, rollout } = await fixture()
  const task = JSON.stringify({ type: 'event_msg', timestamp: new Date(9000).toISOString(), payload: {
    type: 'task_complete', turn_id: 'turn-1', started_at: 1, completed_at: 9,
    last_agent_message: 'PR #7 build is done',
  } })
  await writeFile(join(day, 'rollout-task.jsonl'), rollout('thread-1', 'exec-1') + task + '\n')
  const unbound = await importCodexSessionTree(root, options)
  expect(unbound.observations).toHaveLength(1)
  expect(unbound.coverage.unbound).toBe(1)
  const bound = await importCodexSessionTree(root, { ...options, turnBindings: [{
    sessionId: 'thread-1', turnId: 'turn-1', phase: 'build', links: [{ repository: 'example/project', prNumber: 7 }],
  }] })
  expect(bound.observations.map(row => row.phase)).toEqual(['test', 'build'])
  expect(bound.observations[1]).toMatchObject({ startedAt: 1000, endedAt: 9000, model: 'model-a', inputTokens: null })
})

test('only the authorized dated tree is scanned; symlinks and unrelated files cannot add receipts', async () => {
  const { home, root, day, options, rollout } = await fixture()
  const outside = join(home, 'outside.jsonl')
  await writeFile(outside, rollout('outside', 'outside'))
  await symlink(outside, join(day, 'rollout-linked.jsonl'))
  await writeFile(join(day, 'unrelated.jsonl'), rollout('unrelated', 'unrelated'))
  await mkdir(join(root, 'other'), { recursive: true })
  await writeFile(join(root, 'other', 'rollout-ignored.jsonl'), rollout('ignored', 'ignored'))
  await symlink(join(home, 'elsewhere'), join(root, '2025'))
  expect(await discoverCodexRollouts(root)).toEqual([])
  expect((await importCodexSessionTree(root, options)).observations).toEqual([])
  await mkdir(join(home, 'alias'))
  await symlink(root, join(home, 'alias', 'sessions'))
  await expect(discoverCodexRollouts(join(home, 'alias', 'sessions'))).rejects.toThrow('root')
})

test('duplicate native receipt identities across files are refused', async () => {
  const { root, day, options, rollout } = await fixture()
  const receipt = rollout('thread-1', 'exec-1')
  await writeFile(join(day, 'rollout-a.jsonl'), receipt)
  await writeFile(join(day, 'rollout-b.jsonl'), receipt)
  await expect(importCodexSessionTree(root, options)).rejects.toThrow('Duplicate native receipt')
})

test('a rollout replaced after discovery cannot escape the authorized root', async () => {
  const { home, root, day, options, rollout } = await fixture()
  const first = join(day, 'rollout-a.jsonl'), second = join(day, 'rollout-b.jsonl')
  await writeFile(first, rollout('thread-a', 'exec-a'))
  await writeFile(second, rollout('thread-b', 'exec-b'))
  const discovered = await discoverCodexRollouts(root)
  const stable = await importDiscoveredCodexRollouts(root, discovered, options)
  expect(stable.observations.map(row => row.phaseId)).toEqual(['codex:thread-a:exec-a', 'codex:thread-b:exec-b'])

  const outside = join(home, 'outside.jsonl')
  await writeFile(outside, rollout('outside', 'outside'))
  await rename(second, join(home, 'original-b.jsonl'))
  await symlink(outside, second)
  await expect(importDiscoveredCodexRollouts(root, discovered, options)).rejects.toThrow()
})

test('a dated parent replaced after discovery cannot redirect an opened rollout', async () => {
  const { home, root, day, options, rollout } = await fixture()
  await writeFile(join(day, 'rollout-a.jsonl'), rollout('thread-a', 'exec-a'))
  const discovered = await discoverCodexRollouts(root)
  expect((await importDiscoveredCodexRollouts(root, discovered, options)).observations).toHaveLength(1)
  const outside = join(home, 'outside-day')
  await mkdir(outside)
  await writeFile(join(outside, 'rollout-a.jsonl'), rollout('outside', 'outside'))
  await rename(day, join(home, 'original-day'))
  await symlink(outside, day)
  await expect(importDiscoveredCodexRollouts(root, discovered, options)).rejects.toThrow('changed after discovery')
})

test('a scan refuses more than its configured rollout count', async () => {
  const { root, day } = await fixture()
  await Promise.all(Array.from({ length: 257 }, (_, index) => writeFile(join(day, `rollout-${index}.jsonl`), '{}\n')))
  await expect(discoverCodexRollouts(root)).rejects.toThrow('bounds')
})
