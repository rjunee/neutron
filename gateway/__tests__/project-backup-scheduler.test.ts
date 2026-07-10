/**
 * P7.4 Phase 2 — ProjectBackupScheduler tests.
 *
 * Uses a stub `ProjectBackupStore` (no real git) so the suite stays
 * fast + hermetic. Coverage:
 *   - boot-time backfill fires immediately
 *   - per-project cadence (no double-fire within tickIntervalMs)
 *   - per-project jitter spreads load
 *   - last-attempted sidecar prevents double-fire on restart
 *   - stop() drops pending timers cleanly
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ProjectBackupScheduler,
  DEFAULT_TICK_INTERVAL_MS,
} from '../git/project-backup-scheduler.ts'
import type { BackupResult, ProjectBackupStatus } from '../git/project-backup-store.ts'

/** Test double — implements the subset of the ProjectBackupStore the
 *  scheduler depends on. */
class StubStore {
  readonly attempts = new Map<string, number>()
  readonly sidecar = new Map<string, number>()
  nextScheduledCalls: Array<{ project_id: string; ts_ms: number | null }> = []

  constructor(public now: () => number) {}

  async backupNow(project_id: string): Promise<BackupResult> {
    this.attempts.set(project_id, (this.attempts.get(project_id) ?? 0) + 1)
    return {
      ok: true,
      commit_sha: null,
      pushed: false,
      push_error: null,
      completed_at_ms: this.now(),
    }
  }

  async readLastAttemptedAt(project_id: string): Promise<number | null> {
    return this.sidecar.get(project_id) ?? null
  }

  async writeLastAttemptedAt(project_id: string, ts_ms: number): Promise<void> {
    this.sidecar.set(project_id, ts_ms)
  }

  setNextScheduledAt(project_id: string, ts_ms: number | null): void {
    this.nextScheduledCalls.push({ project_id, ts_ms })
  }

  async getStatus(project_id: string): Promise<ProjectBackupStatus> {
    return {
      state: 'ok',
      last_backup_at: null,
      last_check_at: null,
      last_commit_sha: null,
      last_push_at: null,
      last_push_error: null,
      remote_url: null,
      is_managed_remote: false,
      next_scheduled_at: null,
    }
  }
}

describe('ProjectBackupScheduler', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'p74p2-sched-'))
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('fires backupNow per-project on first poll (boot-time backfill)', async () => {
    let now = 0
    const store = new StubStore(() => now)
    // Run a real (small) jitter; tests sleep through it via Bun.sleep.
    const sched = new ProjectBackupScheduler({
      store: store as unknown as import('../git/project-backup-store.ts').ProjectBackupStore,
      tickIntervalMs: 60_000,
      jitterMaxMs: 0,
      enumerateProjects: async () => ['a', 'b', 'c'],
      now: () => now,
      pollIntervalMs: 999_999,
    })
    sched.start()
    // Poll uses setTimeout(0) for jitter=0; await microtasks.
    await new Promise((resolve) => setTimeout(resolve, 50))
    sched.stop()
    expect(store.attempts.get('a')).toBe(1)
    expect(store.attempts.get('b')).toBe(1)
    expect(store.attempts.get('c')).toBe(1)
  })

  it('does not double-fire within tickIntervalMs', async () => {
    let now = 1_000_000
    const store = new StubStore(() => now)
    const sched = new ProjectBackupScheduler({
      store: store as unknown as import('../git/project-backup-store.ts').ProjectBackupStore,
      tickIntervalMs: 60_000,
      jitterMaxMs: 0,
      enumerateProjects: async () => ['a'],
      now: () => now,
      pollIntervalMs: 999_999,
    })
    sched.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Same poll again — sidecar says we just ran, skip.
    now += 30_000 // half tickInterval
    await sched.poll()
    sched.stop()
    expect(store.attempts.get('a')).toBe(1)
  })

  it('re-fires after tickIntervalMs has elapsed', async () => {
    let now = 1_000_000
    const store = new StubStore(() => now)
    const sched = new ProjectBackupScheduler({
      store: store as unknown as import('../git/project-backup-store.ts').ProjectBackupStore,
      tickIntervalMs: 1_000,
      jitterMaxMs: 0,
      enumerateProjects: async () => ['a'],
      now: () => now,
      pollIntervalMs: 999_999,
    })
    sched.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    now += 2_000 // jump past tickInterval
    await sched.poll()
    await new Promise((resolve) => setTimeout(resolve, 30))
    sched.stop()
    expect(store.attempts.get('a')).toBe(2)
  })

  it('honors a pre-existing last-attempted sidecar on boot', async () => {
    let now = 100_000
    const store = new StubStore(() => now)
    // Pretend the gateway ran 30s ago; tickInterval is 60s.
    store.sidecar.set('a', now - 30_000)
    const sched = new ProjectBackupScheduler({
      store: store as unknown as import('../git/project-backup-store.ts').ProjectBackupStore,
      tickIntervalMs: 60_000,
      jitterMaxMs: 0,
      enumerateProjects: async () => ['a'],
      now: () => now,
      pollIntervalMs: 999_999,
    })
    sched.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    sched.stop()
    expect(store.attempts.get('a') ?? 0).toBe(0)
  })

  it('boot-time backfill fires when sidecar is older than tickInterval', async () => {
    let now = 100_000
    const store = new StubStore(() => now)
    // Pretend the gateway last ran 8h ago; tickInterval is 6h.
    store.sidecar.set('a', now - 8 * 60 * 60 * 1000)
    const sched = new ProjectBackupScheduler({
      store: store as unknown as import('../git/project-backup-store.ts').ProjectBackupStore,
      tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
      jitterMaxMs: 0,
      enumerateProjects: async () => ['a'],
      now: () => now,
      pollIntervalMs: 999_999,
    })
    sched.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    sched.stop()
    expect(store.attempts.get('a')).toBe(1)
  })

  it('writes the last-attempted sidecar BEFORE the snapshot fires', async () => {
    let now = 1_000_000
    let writeOrder = 0
    const store = new StubStore(() => now)
    const origWrite = store.writeLastAttemptedAt.bind(store)
    let writeAt = 0
    store.writeLastAttemptedAt = async (id: string, ts: number): Promise<void> => {
      writeAt = ++writeOrder
      return origWrite(id, ts)
    }
    let backupAt = 0
    const origBackup = store.backupNow.bind(store)
    store.backupNow = async (id: string): Promise<BackupResult> => {
      backupAt = ++writeOrder
      return origBackup(id)
    }
    const sched = new ProjectBackupScheduler({
      store: store as unknown as import('../git/project-backup-store.ts').ProjectBackupStore,
      tickIntervalMs: 60_000,
      jitterMaxMs: 0,
      enumerateProjects: async () => ['a'],
      now: () => now,
      pollIntervalMs: 999_999,
    })
    sched.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    sched.stop()
    expect(writeAt).toBeGreaterThan(0)
    expect(backupAt).toBeGreaterThan(writeAt)
  })

  it('stop() clears pending jittered timers', async () => {
    let now = 1_000_000
    const store = new StubStore(() => now)
    const sched = new ProjectBackupScheduler({
      store: store as unknown as import('../git/project-backup-store.ts').ProjectBackupStore,
      tickIntervalMs: 1_000,
      jitterMaxMs: 5_000,
      enumerateProjects: async () => ['a', 'b'],
      now: () => now,
      pollIntervalMs: 999_999,
      random: () => 0.5, // always pick midpoint of the jitter window
    })
    sched.start()
    await sched.stop()
    // Give any pending jittered timers a chance to fire if they
    // weren't actually cancelled.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(store.attempts.get('a') ?? 0).toBe(0)
    expect(store.attempts.get('b') ?? 0).toBe(0)
  })

  it('§F1 stop() quiesces an already-fired in-flight backup', async () => {
    const now = 1_000_000
    // Gated store: backupNow blocks until released, so an already-launched
    // snapshot is held in flight while we call stop().
    let entered = false
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const store = new StubStore(() => now)
    store.backupNow = async (project_id: string): Promise<BackupResult> => {
      entered = true
      store.attempts.set(project_id, (store.attempts.get(project_id) ?? 0) + 1)
      await gate
      return { ok: true, commit_sha: null, pushed: false, push_error: null, completed_at_ms: now }
    }
    let jitterCb: (() => void) | null = null
    const sched = new ProjectBackupScheduler({
      store: store as unknown as import('../git/project-backup-store.ts').ProjectBackupStore,
      tickIntervalMs: 1_000,
      jitterMaxMs: 0,
      enumerateProjects: async () => ['a'],
      now: () => now,
      random: () => 0,
      pollIntervalMs: 999_999,
      setInterval: () => 1 as unknown as NodeJS.Timeout,
      clearInterval: () => {},
      // Capture the jitter timer so we can fire the snapshot deterministically.
      setTimeout: (fn) => {
        jitterCb = fn as () => void
        return 2 as unknown as NodeJS.Timeout
      },
      clearTimeout: () => {},
    })
    sched.start() // immediate poll → schedules the jitter timer (captured)
    for (let i = 0; i < 50 && jitterCb === null; i++) {
      await new Promise((r) => setTimeout(r, 2))
    }
    expect(jitterCb).not.toBeNull()
    jitterCb!() // launch the snapshot → backupNow blocks on the gate
    for (let i = 0; i < 50 && !entered; i++) {
      await new Promise((r) => setTimeout(r, 2))
    }
    expect(entered).toBe(true)

    let stopped = false
    const stopP = sched.stop().then(() => {
      stopped = true
    })
    await new Promise((r) => setTimeout(r, 15))
    expect(stopped).toBe(false) // must not resolve while backupNow is in flight

    release()
    await stopP
    expect(stopped).toBe(true)
  })

  it('§F1 stop() quiesces a directly-invoked poll() and blocks a post-stop snapshot', async () => {
    const now = 1_000_000
    let entered = false
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const store = new StubStore(() => now)
    // Gate the FIRST store read so a manually-driven poll() can be held in flight.
    store.readLastAttemptedAt = async (project_id: string): Promise<number | null> => {
      entered = true
      await gate
      return store.sidecar.get(project_id) ?? null
    }
    let jitterArmed = 0
    const sched = new ProjectBackupScheduler({
      store: store as unknown as import('../git/project-backup-store.ts').ProjectBackupStore,
      tickIntervalMs: 1_000,
      jitterMaxMs: 0,
      enumerateProjects: async () => ['a'],
      now: () => now,
      random: () => 0,
      pollIntervalMs: 999_999,
      setInterval: () => 1 as unknown as NodeJS.Timeout,
      clearInterval: () => {},
      setTimeout: () => {
        jitterArmed++
        return 2 as unknown as NodeJS.Timeout
      },
      clearTimeout: () => {},
    })
    // Drive poll() DIRECTLY (manual) — no start(). It blocks on the gated read.
    const pollP = sched.poll()
    for (let i = 0; i < 50 && !entered; i++) {
      await new Promise((r) => setTimeout(r, 2))
    }
    expect(entered).toBe(true)

    let stopped = false
    const stopP = sched.stop().then(() => {
      stopped = true
    })
    await new Promise((r) => setTimeout(r, 15))
    expect(stopped).toBe(false) // stop() awaits the in-flight direct poll

    release()
    await stopP
    await pollP
    expect(stopped).toBe(true)
    // The poll saw `stopped` after its gated read and bailed BEFORE writing the
    // sidecar / arming a jitter timer → no snapshot escapes the shutdown.
    expect(jitterArmed).toBe(0)
    expect(store.attempts.get('a') ?? 0).toBe(0)
  })
})
