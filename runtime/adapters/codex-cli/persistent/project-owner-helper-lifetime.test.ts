import { expect, test } from 'bun:test'
import { finishOwnerHelperLifetime, ownerNativeStopObservation } from './project-owner-helper-lifetime.ts'

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('native-first and terminal-first failure close the helper only after both exit observations', async () => {
  for (const first of ['native', 'terminal']) {
    const native = deferred(), terminal = deferred(), retired = deferred()
    const observation = ownerNativeStopObservation(), events: string[] = []
    const done = finishOwnerHelperLifetime({ retired: retired.promise, nativeStopped: observation.stopped,
      async finishRetirement() { events.push('retirement-listener-closed') },
      async finishNativeStop() { events.push('failed-owner-listener-closed') },
    }, code => events.push(`helper-exit-${code}`))
    observation.observe(false, native.promise, terminal.promise)
    ;(first === 'native' ? native : terminal).resolve()
    await flush()
    expect(events).toEqual([])
    ;(first === 'native' ? terminal : native).resolve()
    await done
    expect(events).toEqual(['failed-owner-listener-closed', 'helper-exit-1'])
    // A late retirement promise cannot select another exit path.
    retired.resolve(); await flush()
    expect(events).toHaveLength(2)
  }
})

test('planned retirement does not race the crash shutdown ahead of its completed receipt', async () => {
  const observation = ownerNativeStopObservation(), retired = deferred(), events: string[] = []
  const done = finishOwnerHelperLifetime({ retired: retired.promise, nativeStopped: observation.stopped,
    async finishRetirement() { events.push('retirement-listener-closed') },
    async finishNativeStop() { events.push('wrong-crash-close') },
  }, code => events.push(`helper-exit-${code}`))
  observation.observe(true, Promise.resolve(), Promise.resolve())
  await flush()
  expect(events).toEqual([])
  events.push('completed-retirement-receipt')
  retired.resolve(); await done
  expect(events).toEqual(['completed-retirement-receipt', 'retirement-listener-closed', 'helper-exit-0'])
})

test('missing or rejected exit observations never become successful native-stop evidence', async () => {
  const missing = ownerNativeStopObservation()
  missing.observe(false, undefined, Promise.resolve())
  await expect(missing.stopped).rejects.toThrow('incomplete')
  const rejected = ownerNativeStopObservation(), native = deferred()
  rejected.observe(false, native.promise, Promise.resolve())
  native.reject(new Error('unknown native identity'))
  await expect(rejected.stopped).rejects.toThrow('unknown native identity')
  const events: string[] = []
  await expect(finishOwnerHelperLifetime({ retired: new Promise<void>(() => {}), nativeStopped: rejected.stopped,
    async finishRetirement() { events.push('retired') }, async finishNativeStop() { events.push('native-stopped') },
  }, code => events.push(`exit-${code}`))).rejects.toThrow('unknown native identity')
  expect(events).toEqual([])
})
