/**
 * §F2 — LoopRegistry unit tests. Covers registration + the duplicate-name guard
 * (the silently-added-twin catch), the sorted name set (what a composer test
 * pins), the live health snapshot, and the ONE boot-inventory line (running +
 * dormant).
 */

import { expect, test } from 'bun:test'

import { LoopRegistry, SupervisedLoop, type DormantLoop, type LoopDescriptor } from './index.ts'

function staticDescriptor(
  name: string,
  cadenceMs: number,
  extra: Partial<LoopDescriptor> = {},
): LoopDescriptor {
  return {
    name,
    cadenceMs,
    startedAt: 1000,
    health: () => ({ lastTickAt: null, lastError: null }),
    ...extra,
  }
}

test('register + names(): sorted set, size, has/get', () => {
  const reg = new LoopRegistry()
  reg.register(staticDescriptor('trident', 90_000))
  reg.register(staticDescriptor('cron', 0))
  reg.register(staticDescriptor('reminders', 30_000))

  expect(reg.size()).toBe(3)
  expect(reg.names()).toEqual(['cron', 'reminders', 'trident'])
  expect(reg.has('cron')).toBe(true)
  expect(reg.has('watchdog')).toBe(false)
  expect(reg.get('reminders')?.cadenceMs).toBe(30_000)
  expect(reg.list().map((d) => d.name)).toEqual(['cron', 'reminders', 'trident'])
})

test('register throws on a duplicate name (silently-added-twin guard)', () => {
  const reg = new LoopRegistry()
  reg.register(staticDescriptor('reminders', 30_000))
  expect(() => reg.register(staticDescriptor('reminders', 30_000))).toThrow(
    /already registered/,
  )
  // The first registration is intact.
  expect(reg.size()).toBe(1)
})

test('register-before-start on a dup throws BEFORE start — no timer leak (defect #2)', () => {
  const reg = new LoopRegistry()
  reg.register(staticDescriptor('reminders', 30_000))
  let timerArmed = false
  const loop = new SupervisedLoop({
    name: 'reminders',
    intervalMs: 10_000,
    tick: async () => {},
    setTimer: () => {
      timerArmed = true
      return 0
    },
    clearTimer: () => {},
  })
  // The register-before-start pattern: register (throws on dup) BEFORE start.
  expect(() => {
    reg.register(loop.describe())
    loop.start()
  }).toThrow(/already registered/)
  // start() was never reached → no timer armed, loop never ran.
  expect(timerArmed).toBe(false)
  expect(loop.stats().running).toBe(false)
  expect(loop.describe().startedAt).toBe(0)
})

test('bootLine names every running loop + cron detail + dormant set', () => {
  const reg = new LoopRegistry()
  reg.register(staticDescriptor('reminders', 30_000))
  reg.register(
    staticDescriptor('cron', 0, { detail: () => '2 jobs: focus_score, sean_ellis' }),
  )
  const dormant: readonly DormantLoop[] = [
    { name: 'agent-watcher', reason: 'x', deferredTo: 'D-7' },
    { name: 'project-backup-scheduler', reason: 'y', deferredTo: 'D-7' },
  ]

  const line = reg.bootLine('demo-owner', dormant)
  expect(line).toContain('project=demo-owner')
  expect(line).toContain('2 loop(s) running')
  expect(line).toContain('cron (2 jobs: focus_score, sean_ellis)')
  expect(line).toContain('reminders')
  expect(line).toContain('2 dormant (deferred): [agent-watcher, project-backup-scheduler]')
})

test('bootLine omits the dormant clause when none supplied', () => {
  const reg = new LoopRegistry()
  reg.register(staticDescriptor('reminders', 30_000))
  const line = reg.bootLine('demo-owner')
  expect(line).toContain('1 loop(s) running')
  expect(line).not.toContain('dormant')
})

test('SupervisedLoop.describe() yields a live descriptor (startedAt + lastTickAt)', async () => {
  let ticks = 0
  const loop = new SupervisedLoop({
    name: 'unit',
    intervalMs: 10_000,
    tick: async () => {
      ticks += 1
    },
    // Manual driver: a no-op timer so start() arms nothing; we call runOnce().
    setTimer: () => 0,
    clearTimer: () => {},
  })

  // Before start(): describe is callable but startedAt is 0 + no tick yet.
  expect(loop.describe().startedAt).toBe(0)

  loop.start()
  const desc = loop.describe()
  expect(desc.name).toBe('unit')
  expect(desc.cadenceMs).toBe(10_000)
  expect(desc.startedAt).toBeGreaterThan(0)
  expect(desc.health().lastTickAt).toBeNull()

  await loop.runOnce()
  expect(ticks).toBe(1)
  // health() is LIVE — re-reading the same descriptor reflects the tick.
  expect(desc.health().lastTickAt).toBeGreaterThan(0)
  expect(desc.health().lastError).toBeNull()

  await loop.stop()
})

test('SupervisedLoop.describe() surfaces the last tick error', async () => {
  const boom = new Error('tick boom')
  const loop = new SupervisedLoop({
    name: 'failing',
    intervalMs: 10_000,
    tick: async () => {
      throw boom
    },
    onError: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  })
  loop.start()
  await loop.runOnce()
  const health = loop.describe().health()
  expect(health.lastTickAt).toBeGreaterThan(0)
  expect(health.lastError).toBe(boom)
  await loop.stop()
})

test('SupervisedLoop CLEARS lastError on a success after a failure (recovery — defect #3)', async () => {
  const boom = new Error('transient')
  let shouldThrow = true
  const loop = new SupervisedLoop({
    name: 'recovering',
    intervalMs: 10_000,
    tick: async () => {
      if (shouldThrow) throw boom
    },
    onError: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  })
  loop.start()
  await loop.runOnce()
  expect(loop.describe().health().lastError).toBe(boom)
  // A later SUCCESS must null the error — not stay errored forever.
  shouldThrow = false
  await loop.runOnce()
  const health = loop.describe().health()
  expect(health.lastError).toBeNull()
  expect(health.lastTickAt).toBeGreaterThan(0)
  await loop.stop()
})
