/**
 * launcher-liveness-probe.test.ts — `probeLauncherGenerationAlive`, the PULL half
 * of launcher-death detection (T2 of "a dead build is detected in seconds").
 *
 * The watchdog PUSHES a crash event; this probe lets trident's `trident-liveness`
 * loop ASK whether a recorded launcher generation is still a live PROCESS, so a
 * death whose event was lost is caught in seconds instead of by the 90-minute
 * reaper. Everything here is an OBSERVABLE: a real registry file on disk, a real
 * live pid (`process.pid`), and a real DEAD pid (a child spawned and awaited to
 * exit) — no stubbed `isPidAlive`.
 *
 * The invariant under test is asymmetric on purpose: 'dead' requires POSITIVE
 * evidence, every ambiguous path answers 'unknown'. A probe that guessed 'dead'
 * from a missing/corrupt registry would reap healthy builds — strictly worse than
 * the timeout it replaces.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeLauncherGenerationAlive } from '../persistent-repl-substrate.ts'
import type { ReplSession } from '../repl-session.ts'
import { pool } from '../pool-state.ts'
import { saveRegistry, type ReplRegistryRecord } from '../repl-registry.ts'

const tmpDirs: string[] = []
const pooledKeys: string[] = []

afterEach(() => {
  for (const key of pooledKeys.splice(0)) pool.delete(key)
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshRegistryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-liveness-'))
  tmpDirs.push(dir)
  return join(dir, 'repl-registry.json')
}

/** Write a registry file in the real on-disk shape (`saveRegistry`), keyed by
 *  sessionKey exactly as the substrate writes it. */
function writeRegistry(path: string, rows: Partial<ReplRegistryRecord>[]): void {
  const registry: Record<string, ReplRegistryRecord> = {}
  for (const [i, row] of rows.entries()) {
    const sessionKey = row.sessionKey ?? `instance-a /work/repo-${i}`
    registry[sessionKey] = {
      sessionKey,
      sessionId: `session-${i}`,
      cwd: `/work/repo-${i}`,
      channelName: `chan-${i}`,
      has_session: true,
      ...row,
    }
  }
  saveRegistry(path, registry)
}

/** Install a fake pooled session carrying `childGeneration` + `hasChildExited()`
 *  — the two fields the probe reads off the live pool. Removed in `afterEach`. */
function poolSession(sessionKey: string, childGeneration: string, exited: boolean): void {
  pool.set(
    sessionKey,
    Promise.resolve({ childGeneration, hasChildExited: () => exited } as unknown as ReplSession),
  )
  pooledKeys.push(sessionKey)
}

/** A pid that is definitely NOT alive: spawn a trivial child, await its exit
 *  (which reaps it), then reuse its pid. Real death, not a stubbed probe. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' })
  const pid = child.pid
  await child.exited
  return pid
}

describe('probeLauncherGenerationAlive — registry path', () => {
  it('answers alive for a record whose recorded pid is running', () => {
    const path = freshRegistryPath()
    writeRegistry(path, [{ child_generation: 'gen-live', pid: process.pid }])

    expect(probeLauncherGenerationAlive('gen-live', path)).toBe('alive')
  })

  it('answers dead for a record whose recorded pid has exited', async () => {
    const path = freshRegistryPath()
    writeRegistry(path, [{ child_generation: 'gen-dead', pid: await deadPid() }])

    expect(probeLauncherGenerationAlive('gen-dead', path)).toBe('dead')
  })

  it('finds the matching generation among several rows', async () => {
    const path = freshRegistryPath()
    writeRegistry(path, [
      { child_generation: 'gen-other-1', pid: process.pid },
      { child_generation: 'gen-dead', pid: await deadPid() },
      { child_generation: 'gen-other-2', pid: process.pid },
    ])

    expect(probeLauncherGenerationAlive('gen-dead', path)).toBe('dead')
    expect(probeLauncherGenerationAlive('gen-other-2', path)).toBe('alive')
  })
})

describe('probeLauncherGenerationAlive — every ambiguity is unknown, never dead', () => {
  it('answers unknown when the registry exists but no row carries the generation', () => {
    const path = freshRegistryPath()
    writeRegistry(path, [{ child_generation: 'gen-someone-else', pid: process.pid }])

    // A SUPERSEDED generation looks exactly like this: it was already event-latched
    // at respawn, so its absence must not be re-read as a fresh death.
    expect(probeLauncherGenerationAlive('gen-missing', path)).toBe('unknown')
  })

  it('answers unknown when the registry file does not exist', () => {
    const path = freshRegistryPath()

    expect(probeLauncherGenerationAlive('gen-anything', path)).toBe('unknown')
  })

  it('answers unknown when the registry file is unparseable garbage', () => {
    const path = freshRegistryPath()
    writeFileSync(path, '{ this is not json', 'utf8')

    expect(probeLauncherGenerationAlive('gen-anything', path)).toBe('unknown')
  })

  it('answers unknown for a matching record that records no pid', () => {
    const path = freshRegistryPath()
    writeRegistry(path, [{ child_generation: 'gen-no-pid' }])

    expect(probeLauncherGenerationAlive('gen-no-pid', path)).toBe('unknown')
  })

  it('answers unknown for malformed matching pids', () => {
    const path = freshRegistryPath()
    for (const pid of [null, '4242', 1.5, 0, -1]) {
      writeRegistry(path, [{ child_generation: 'gen-bad-pid', pid: pid as never }])
      expect(probeLauncherGenerationAlive('gen-bad-pid', path)).toBe('unknown')
    }
  })
})

describe('probeLauncherGenerationAlive — the live pool outranks the registry', () => {
  it('answers alive for a pooled session whose child has not exited', () => {
    const path = freshRegistryPath()
    poolSession('probe-pool-alive', 'gen-pooled-alive', false)

    expect(probeLauncherGenerationAlive('gen-pooled-alive', path)).toBe('alive')
  })

  it('answers dead for a pooled session whose child has exited', () => {
    const path = freshRegistryPath()
    poolSession('probe-pool-dead', 'gen-pooled-dead', true)

    expect(probeLauncherGenerationAlive('gen-pooled-dead', path)).toBe('dead')
  })

  it('trusts the pooled session over a contradicting registry row', () => {
    // We own the handle; the registry's pid can outlive its process (or be
    // recycled by the OS onto something unrelated), so it never wins.
    const path = freshRegistryPath()
    writeRegistry(path, [{ child_generation: 'gen-contested', pid: process.pid }])
    poolSession('probe-pool-contested', 'gen-contested', true)

    expect(probeLauncherGenerationAlive('gen-contested', path)).toBe('dead')
  })

  it('trusts a live pooled session over a registry row whose pid is dead', async () => {
    const path = freshRegistryPath()
    writeRegistry(path, [{ child_generation: 'gen-contested-2', pid: await deadPid() }])
    poolSession('probe-pool-contested-2', 'gen-contested-2', false)

    expect(probeLauncherGenerationAlive('gen-contested-2', path)).toBe('alive')
  })

  it('ignores pooled sessions on other generations and falls through to the registry', () => {
    const path = freshRegistryPath()
    writeRegistry(path, [{ child_generation: 'gen-registry-only', pid: process.pid }])
    poolSession('probe-pool-unrelated', 'gen-unrelated', true)

    expect(probeLauncherGenerationAlive('gen-registry-only', path)).toBe('alive')
  })

  it('skips a still-spawning pool entry rather than reading it as a death', () => {
    const path = freshRegistryPath()
    // A pending promise (spawn in flight) carries no generation yet — it must not
    // short-circuit the registry answer.
    pool.set('probe-pool-pending', new Promise<ReplSession>(() => {}))
    pooledKeys.push('probe-pool-pending')
    writeRegistry(path, [{ child_generation: 'gen-behind-pending', pid: process.pid }])

    expect(probeLauncherGenerationAlive('gen-behind-pending', path)).toBe('alive')
  })

  it('skips a failed pool entry rather than reading it as a death', () => {
    const path = freshRegistryPath()
    const failed = Promise.reject(new Error('spawn failed'))
    failed.catch(() => {})
    pool.set('probe-pool-failed', failed as unknown as Promise<ReplSession>)
    pooledKeys.push('probe-pool-failed')

    expect(probeLauncherGenerationAlive('gen-never-spawned', path)).toBe('unknown')
  })
})
