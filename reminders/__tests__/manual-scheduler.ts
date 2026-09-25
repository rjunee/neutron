import { expect, mock } from 'bun:test'
import type { ReminderScheduler } from '../tick.ts'

/** Captures only the reminder timer; every other composed timer and I/O stays real. */
export function manualReminderScheduler() {
  let callback: (() => void) | null = null
  const handle = Symbol('reminder interval')
  const scheduler: ReminderScheduler = {
    setTimer: mock((fn: () => void, _ms: number) => {
      if (callback !== null) throw new Error('reminder timer already armed')
      callback = fn
      return handle
    }),
    clearTimer: mock((value: unknown) => {
      expect(value).toBe(handle)
      callback = null
    }),
  }
  return {
    scheduler,
    assertStarted() {
      expect(scheduler.setTimer).toHaveBeenCalledTimes(1)
      expect(scheduler.setTimer).toHaveBeenCalledWith(expect.any(Function), 30_000)
      expect(scheduler.clearTimer).not.toHaveBeenCalled()
    },
    fire() {
      if (callback === null) throw new Error('reminder timer is not armed')
      callback()
    },
    assertStopped() {
      expect(scheduler.clearTimer).toHaveBeenCalledTimes(1)
      expect(callback).toBeNull()
    },
  }
}
