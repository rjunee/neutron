import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../index.ts'
import * as repl from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { startProjectChatRecovery } from '@neutronai/open/wiring/project-chat-recovery.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

for (const held of [true, false]) {
  test(`boot drains ${held ? 'held' : 'settled'} recovery before persistent teardown`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'recovery-shutdown-'))
    const previous = { db: process.env.NEUTRON_DB_PATH, slug: process.env.NEUTRON_INSTANCE_SLUG }
    process.env.NEUTRON_DB_PATH = join(root, 'project.db')
    process.env.NEUTRON_INSTANCE_SLUG = 'test-owner'
    const order: string[] = []
    const entered = deferred()
    const release = deferred()
    const draining = deferred()
    let passes = 0
    let timerTicks = 0
    let ownerTimer: ReturnType<typeof setInterval> | undefined
    let stop: (() => Promise<void>) | undefined
    // This is the physical-process boundary: the test never walks/kills a real
    // pool. A recovery-created timer models the late supervision rearm.
    const teardown = spyOn(repl, 'shutdownAllPersistentRepls').mockImplementation(async () => {
      order.push('repl-teardown')
      if (ownerTimer !== undefined) clearInterval(ownerTimer)
    })
    let handle: Awaited<ReturnType<typeof boot>> | undefined
    try {
      handle = await boot({
        port: 0,
        composer: ({ db, project_slug }) => ({
          db, project_slug,
          topic_handler: async () => {},
          approval_notifier: { notify: async () => undefined },
          watchdog_notifier: { notify: async () => undefined },
          reminder_dispatcher: { dispatch: async () => undefined },
          heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
          platform: STUB_PLATFORM,
          on_graph_ready: async () => {
            const recovery = startProjectChatRecovery(async () => {
              passes++
              if (held && passes === 1) throw new Error('terminal host unavailable')
              entered.resolve()
              if (held) await release.promise
              order.push('recovery-ready')
              ownerTimer = setInterval(() => { timerTicks++ }, 1)
            }, () => {}, held ? 1 : 60_000)
            stop = recovery.stop
            await recovery.ready
          },
          on_shutdown_start: async () => {
            draining.resolve()
            await stop?.()
          },
          realmode_cleanups: [() => { order.push('cleanup') }],
        }),
      })
      await entered.promise
      const stopping = handle.shutdown({ force: true })
      await draining.promise
      if (held) {
        await Promise.resolve()
        expect(teardown).not.toHaveBeenCalled()
        expect(order).toEqual([])
        expect(passes).toBe(2) // autonomous retry occurred without client traffic
      }
      release.resolve()
      await stopping
      expect(teardown).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['recovery-ready', 'repl-teardown', 'cleanup'])
      const ticksAfterShutdown = timerTicks
      const passesAfterShutdown = passes
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(timerTicks).toBe(ticksAfterShutdown)
      expect(passes).toBe(passesAfterShutdown)
    } finally {
      release.resolve()
      await stop?.()
      await handle?.shutdown({ force: true })
      if (ownerTimer !== undefined) clearInterval(ownerTimer)
      teardown.mockRestore()
      if (previous.db === undefined) delete process.env.NEUTRON_DB_PATH
      else process.env.NEUTRON_DB_PATH = previous.db
      if (previous.slug === undefined) delete process.env.NEUTRON_INSTANCE_SLUG
      else process.env.NEUTRON_INSTANCE_SLUG = previous.slug
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
}

test('Open wires the recovery drain to the early hook, with idempotent direct-composer disposal', () => {
  const composer = readFileSync(new URL('../../open/composer.ts', import.meta.url), 'utf8')
  expect(composer).toContain('on_shutdown_start: quiesceChatRecovery')
  expect(composer).toContain('realmodeCleanups.push(quiesceChatRecovery)')
  expect(composer).toContain('await stopChatRecovery?.()')
  const capture = composer.indexOf('stopChatRecovery = recovery.stop')
  const awaitReady = composer.indexOf('await recovery.ready')
  expect(capture).toBeGreaterThan(-1)
  expect(awaitReady).toBeGreaterThan(capture)
})
