import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TridentPhase } from '@neutronai/trident/store.ts'
import {
  PROJECT_BUILD_STATE_RETENTION_MS,
  reapProjectBuildState,
} from '../wiring/project-build-state-reaper.ts'

const cleanup: string[] = []
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

test('reaps expired terminal state while retaining live, recent, and unknown state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-build-state-reaper-'))
  cleanup.push(root)
  const now = Date.UTC(2026, 8, 16)
  const old = new Date(now - PROJECT_BUILD_STATE_RETENTION_MS).toISOString()
  const recent = new Date(now - PROJECT_BUILD_STATE_RETENTION_MS + 1).toISOString()
  const rows = new Map<string, { phase: TridentPhase; last_advanced_at: string }>([
    ['done-old', { phase: 'done', last_advanced_at: old }],
    ['failed-old', { phase: 'failed', last_advanced_at: old }],
    ['stopped-recent', { phase: 'stopped', last_advanced_at: recent }],
    ['live-old', { phase: 'argus', last_advanced_at: old }],
    ['bad-clock', { phase: 'done', last_advanced_at: 'not-a-time' }],
  ])
  for (const id of [...rows.keys(), 'missing-row']) {
    const dir = join(root, encodeURIComponent(id))
    await mkdir(dir)
    await writeFile(join(dir, 'evidence.log'), id)
  }
  await writeFile(join(root, 'not-a-directory'), 'keep')

  // Directory enumeration order varies across filesystems; assert exact membership.
  const removed = await reapProjectBuildState({ stateRoot: root, runs: { get: id => rows.get(id) ?? null }, now })
  expect(removed.sort())
    .toEqual(['done-old', 'failed-old'])

  const present = async (id: string): Promise<boolean> =>
    Bun.file(join(root, encodeURIComponent(id), 'evidence.log')).exists()
  expect(await present('done-old')).toBe(false)
  expect(await present('failed-old')).toBe(false)
  expect(await present('stopped-recent')).toBe(true)
  expect(await present('live-old')).toBe(true)
  expect(await present('bad-clock')).toBe(true)
  expect(await present('missing-row')).toBe(true)
  expect(await Bun.file(join(root, 'not-a-directory')).exists()).toBe(true)
})

test('a missing state root is an empty successful sweep', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'project-build-state-reaper-missing-'))
  cleanup.push(parent)
  expect(await reapProjectBuildState({ stateRoot: join(parent, 'absent'), runs: { get: () => null } })).toEqual([])
})
