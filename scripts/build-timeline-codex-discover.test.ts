import { afterEach, expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { combineTimelineSources } from '@neutronai/trident/build-timeline-catalogue.ts'
import { createTimelineHandler } from './build-timeline-server.ts'
import { discoverCodexRollouts, importRegisteredCodexRollout, importCodexSessionTree, importDiscoveredCodexRollouts, readDiscoveredRollout } from './build-timeline-codex-discover.ts'
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
  return { home, root, day, cwd, options, rollout }
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

test('append after discovery preserves the bounded prefix and the next scan gains the new command', async () => {
  const { root, day, cwd, options, rollout } = await fixture()
  const path = join(day, 'rollout-live.jsonl')
  await writeFile(path, rollout('thread-1', 'exec-1'))
  const discovered = await discoverCodexRollouts(root)
  const later = JSON.stringify({ type: 'event_msg', timestamp: new Date(5000).toISOString(), payload: {
    type: 'item_completed', thread_id: 'thread-1', turn_id: 'turn-1', started_at_ms: 4500, completed_at_ms: 5000,
    item: { type: 'CommandExecution', id: 'exec-2', command: ['/bin/bash', '-lc', 'bun test second.test.ts'], cwd,
      status: 'completed', exit_code: 0, stdout: '' },
  } }) + '\n'
  await appendFile(path, later)
  const bounded = await importDiscoveredCodexRollouts(root, discovered, options)
  expect(bounded.observations.map(row => row.phaseId)).toEqual(['codex:thread-1:exec-1'])
  const refreshed = await importCodexSessionTree(root, options)
  expect(refreshed.observations.map(row => row.phaseId)).toEqual(['codex:thread-1:exec-1', 'codex:thread-1:exec-2'])
})

test('append between descriptor verification and read leaves the captured prefix intact', async () => {
  const { root, day, options, rollout } = await fixture()
  const path = join(day, 'rollout-live.jsonl'), original = rollout('thread-1', 'exec-1')
  await writeFile(path, original)
  const [discovered] = await discoverCodexRollouts(root, async () => {
    await appendFile(path, JSON.stringify({ type: 'response_item', payload: { text: 'later' } }) + '\n')
  })
  const snapshot = await readDiscoveredRollout(root, discovered!)
  expect(snapshot).toBe(original)
  expect((await importDiscoveredCodexRollouts(root, [discovered!], options)).observations).toHaveLength(1)
})

test('empty just-created rollout is incomplete until the next scan observes bytes', async () => {
  const { root, day, options, rollout } = await fixture()
  const path = join(day, 'rollout-new.jsonl')
  await writeFile(path, '')
  const empty = await importCodexSessionTree(root, options)
  expect(empty).toMatchObject({ observations: [], coverage: { discovered: 1, emitted: 0, incomplete: 1 } })
  await appendFile(path, rollout('thread-1', 'exec-1'))
  const next = await importCodexSessionTree(root, options)
  expect(next).toMatchObject({ coverage: { discovered: 1, emitted: 1, incomplete: 0 } })
})

test('a truncated or rewritten captured prefix is refused', async () => {
  const { root, day, options, rollout } = await fixture()
  const path = join(day, 'rollout-a.jsonl'), original = rollout('thread-1', 'exec-1')
  await writeFile(path, original)
  const discovered = await discoverCodexRollouts(root)
  await truncate(path, Buffer.byteLength(original) - 1)
  await expect(importDiscoveredCodexRollouts(root, discovered, options)).rejects.toThrow('changed')
  await writeFile(path, original.replace('exec-1', 'exec-2'))
  await expect(importDiscoveredCodexRollouts(root, discovered, options)).rejects.toThrow('changed')
})

test('a same-size rewrite during descriptor capture is refused', async () => {
  const { root, day, rollout } = await fixture()
  const path = join(day, 'rollout-a.jsonl'), original = rollout('thread-1', 'exec-1')
  await writeFile(path, original)
  await expect(discoverCodexRollouts(root, async () => {
    await writeFile(path, original.replace('exec-1', 'exec-2'))
  })).rejects.toThrow('changed during read')
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

test('a regular file replaced inside the root cannot impersonate the discovered inode', async () => {
  const { root, day, options, rollout } = await fixture()
  const path = join(day, 'rollout-a.jsonl'), original = rollout('thread-a', 'exec-a')
  await writeFile(path, original)
  const discovered = await discoverCodexRollouts(root)
  await rename(path, join(day, 'moved-original.jsonl'))
  await writeFile(path, original + '\n')
  await expect(importDiscoveredCodexRollouts(root, discovered, options)).rejects.toThrow('changed')
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

test('registered discovery reaches the dashboard despite unrelated history exceeding both scan limits', async () => {
  const { root, day, options, rollout, home } = await fixture()
  await Promise.all(Array.from({ length: 257 }, (_, index) => writeFile(join(day, `rollout-history-${index}.jsonl`), '{}\n')))
  const oversized = join(day, 'rollout-history-large.jsonl')
  await writeFile(oversized, '')
  await truncate(oversized, 1024 * 1024 * 1024 + 1)
  const selected = join(day, 'rollout-selected.jsonl')
  await writeFile(selected, rollout('selected', 'exec-selected'))
  const result = await importRegisteredCodexRollout(root, selected, options)
  expect(result.coverage).toMatchObject({ emitted: 1, unbound: 0, incomplete: 0 })
  const snapshot = combineTimelineSources({ observedAt: 10000, repositories: [] }, result.observations, [], 10000)
  const handler = createTimelineHandler({ username: 'viewer', password: 'fixture', read: () => snapshot })
  const response = await handler(new Request('http://localhost/api/timeline', {
    headers: { authorization: `Basic ${Buffer.from('viewer:fixture').toString('base64')}` },
  }))
  const body = await response.text()
  expect(response.status).toBe(200)
  expect(JSON.parse(body).cards[0].segments).toHaveLength(1)
  expect(body).not.toContain(home)
  expect(body).not.toContain('PRIVATE OUTPUT')
  const unbound = await importRegisteredCodexRollout(root, selected, { ...options, bindings: [] }, result.checkpoint)
  expect(unbound).toMatchObject({ observations: [], coverage: { unbound: 1 } })
  expect(unbound.scan.readBytes).toBe(0)
  await expect(importRegisteredCodexRollout(root, oversized, options)).rejects.toThrow('bounds')
})

test('registered discovery rejects outside, non-dated, noncanonical and symlink aliases', async () => {
  const { root, day, home, rollout, options } = await fixture()
  const selected = join(day, 'rollout-selected.jsonl')
  await writeFile(selected, rollout('selected', 'exec-selected'))
  expect((await importRegisteredCodexRollout(root, selected, options)).checkpoint.path).toBe(selected)
  const outside = join(home, 'rollout-outside.jsonl')
  await writeFile(outside, rollout('outside', 'exec-outside'))
  const alias = join(day, 'rollout-alias.jsonl')
  await symlink(selected, alias)
  for (const path of [outside, `${day}/../28/rollout-selected.jsonl`, alias, 'rollout-selected.jsonl']) {
    await expect(importRegisteredCodexRollout(root, path, options)).rejects.toThrow()
  }
  await symlink(day, join(root, '2026', '09', '29'))
  await expect(importRegisteredCodexRollout(root, join(root, '2026', '09', '29', 'rollout-selected.jsonl'), options)).rejects.toThrow('Aliased')
})

test('registered snapshots retain append boundaries and reject replacement or rewrite', async () => {
  const { root, day, options, rollout } = await fixture()
  const path = join(day, 'rollout-live.jsonl'), original = rollout('thread-1', 'exec-1')
  await writeFile(path, original)
  const selected = await importRegisteredCodexRollout(root, path, options, undefined, async () => { await appendFile(path, '\n') })
  expect(selected.scan.readBytes).toBe(Buffer.byteLength(original))
  expect(selected.observations).toHaveLength(1)
  expect((await importRegisteredCodexRollout(root, path, options, selected.checkpoint)).scan.readBytes).toBe(1)
  await rename(path, join(day, 'moved.jsonl'))
  await writeFile(path, original)
  await expect(importRegisteredCodexRollout(root, path, options, selected.checkpoint)).rejects.toThrow('checkpoint')
  await expect(importRegisteredCodexRollout(root, path, options, undefined, async () => {
    await writeFile(path, original.replace('exec-1', 'exec-2'))
  })).rejects.toThrow('changed during read')
  await writeFile(path, '')
  const empty = await importRegisteredCodexRollout(root, path, options)
  expect(empty.coverage.incomplete).toBe(1)
})

test('checkpoint restart preserves historical turn context and only reads newly appended bytes', async () => {
  const { root, day, options, rollout } = await fixture()
  const path = join(day, 'rollout-live.jsonl')
  const scoped = { ...options, turnBindings: [{ sessionId: 'thread-1', turnId: 'turn-1', phase: 'build' as const,
    links: [{ repository: 'example/project', prNumber: 7 }] }] }
  const usage = JSON.stringify({ type: 'token_usage_record', payload: { thread_id: 'thread-1', turn_id: 'turn-1',
    turn_token_usage: { input_tokens: 25, output_tokens: 5, cached_input_tokens: 10 } } }) + '\n'
  await writeFile(path, rollout('thread-1', 'exec-1') + usage)
  const initial = await importRegisteredCodexRollout(root, path, scoped)
  const checkpoint = JSON.parse(JSON.stringify(initial.checkpoint))
  const task = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', started_at: 1, completed_at: 9 } }) + '\n'
  // An unfinished JSON line remains unread by the parser and resumes on restart.
  await appendFile(path, task.slice(0, 20))
  const partial = await importRegisteredCodexRollout(root, path, scoped, checkpoint)
  expect(partial.scan).toMatchObject({ readBytes: 20, partial: true })
  expect(partial.coverage.incomplete).toBe(1)
  expect(partial.checkpoint.offset).toBe(checkpoint.offset)
  await appendFile(path, task.slice(20))
  const resumed = await importRegisteredCodexRollout(root, path, scoped, JSON.parse(JSON.stringify(partial.checkpoint)))
  expect(resumed.scan).toMatchObject({ readBytes: Buffer.byteLength(task), partial: false })
  expect(resumed.observations).toHaveLength(2)
  expect(resumed.observations[1]).toMatchObject({ phase: 'build', model: 'model-a', inputTokens: 15, outputTokens: 5, cacheReadTokens: 10 })
  expect((await importRegisteredCodexRollout(root, path, scoped, resumed.checkpoint)).scan.readBytes).toBe(0)
  // Replaying an older persisted cursor after a crash is deterministic.
  expect((await importRegisteredCodexRollout(root, path, scoped, checkpoint)).observations).toEqual(resumed.observations)
  const foreign = join(day, 'rollout-foreign.jsonl')
  await writeFile(foreign, rollout('thread-foreign', 'exec-other'))
  await expect(importRegisteredCodexRollout(root, foreign, scoped, checkpoint)).rejects.toThrow('checkpoint')
  await truncate(path, 0)
  await expect(importRegisteredCodexRollout(root, path, scoped, resumed.checkpoint)).rejects.toThrow('checkpoint')
})

test('registered backfill streams beyond the full-tree byte limit and retains only receipt context', async () => {
  const { root, day, options, rollout } = await fixture()
  const path = join(day, 'rollout-large.jsonl')
  await writeFile(path, rollout('thread-1', 'exec-1'))
  const transcript = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(64 * 1024) } }) + '\n'
  const block = transcript.repeat(16)
  for (let index = 0; index < 129; index++) await appendFile(path, block)
  const result = await importRegisteredCodexRollout(root, path, options)
  expect(result.scan.sourceBytes).toBeGreaterThan(128 * 1024 * 1024)
  expect(result.observations).toHaveLength(1)
  expect(result.checkpoint.lines).toHaveLength(3)
  expect((await importRegisteredCodexRollout(root, path, options, result.checkpoint)).scan.readBytes).toBe(0)
  await appendFile(path, 'x'.repeat(8 * 1024 * 1024 + 1))
  await expect(importRegisteredCodexRollout(root, path, options, result.checkpoint)).rejects.toThrow('bounds')
})

test('checkpoint rejects a same-size rewrite and retained journal overflow', async () => {
  const { root, day, options, rollout } = await fixture()
  const path = join(day, 'rollout-live.jsonl'), original = rollout('thread-1', 'exec-1')
  await writeFile(path, original)
  const result = await importRegisteredCodexRollout(root, path, options)
  await writeFile(path, original.replace('exec-1', 'exec-2'))
  await expect(importRegisteredCodexRollout(root, path, options, result.checkpoint)).rejects.toThrow('checkpoint')
  const fresh = await importRegisteredCodexRollout(root, path, options)
  await expect(importRegisteredCodexRollout(root, path, options, { ...fresh.checkpoint,
    lines: Array(17).fill('x'.repeat(8 * 1024 * 1024)) })).rejects.toThrow('journal exceeds bounds')
})
