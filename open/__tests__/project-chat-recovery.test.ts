import { expect, test } from 'bun:test'
import { startProjectChatRecovery } from '../wiring/project-chat-recovery.ts'

test('unavailable host retries without a client turn; recovery serializes and stop drains', async () => {
  let calls = 0
  const errors: unknown[] = []
  let entered!: () => void
  let release!: () => void
  const second = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const stop = await startProjectChatRecovery(async () => {
    calls++
    if (calls === 1) throw new Error('terminal host unavailable')
    entered(); await held
  }, error => errors.push(error), 1)
  expect(calls).toBe(1)
  await second
  expect(errors).toHaveLength(1)
  let stopped = false
  const stopping = stop().then(() => { stopped = true })
  await Promise.resolve()
  expect(stopped).toBe(false)
  expect(calls).toBe(2)
  release(); await stopping
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(calls).toBe(2)
})
