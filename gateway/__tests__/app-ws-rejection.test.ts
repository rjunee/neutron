import { expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { AppWsAdapter, InMemoryAppWsSessionRegistry, createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { createAppWsSurface, type AppWsSocketData } from '../http/app-ws-surface.ts'

it('correlates pre-ingest refusals; accepts retry; post-ingest errors are not rejection', async () => {
  const frames: Record<string, unknown>[] = []
  let dispatched = 0
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({ registry, receiver: { receive: async () => {
    dispatched++
    throw new Error('dispatch unavailable')
  } } })
  const surface = createAppWsSurface({ adapter, registry,
    auth: createAppWsAuthResolver({ project_slug: 'demo', bypass: true }), project_slug: 'demo' })
  const ws = { data: { surface: 'app_ws', user_id: 'owner', project_slug: 'demo', channel_topic_id: 'app:owner' },
    send: (raw: string) => { frames.push(JSON.parse(raw)); return 1 } } as unknown as ServerWebSocket<AppWsSocketData>
  registry.register('app:owner', env => { frames.push(env as unknown as Record<string, unknown>) })
  const send = async (frame: unknown) => { await surface.websocket.message(ws, JSON.stringify(frame)) }
  for (const id of ['reject-1', '', 'x'.repeat(129), 7, null]) {
    await send({ v: 1, type: 'user_message', body: '', client_msg_id: id })
    expect(frames.at(-1)).toMatchObject(id === 'reject-1'
      ? { type: 'message_rejected', client_msg_id: id, code: 'malformed_envelope' }
      : { type: 'error', code: 'malformed_envelope' })
  }
  await send({ v: 1, type: 'unknown_frame', client_msg_id: 'reject-1' })
  expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'malformed_envelope' })
  await send(null)
  expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'malformed_envelope' })
  expect(dispatched).toBe(0)
  await send({ v: 1, type: 'user_message', body: 'valid retry', client_msg_id: 'reject-1' })
  expect(frames.find(e => e.type === 'user_message')).toMatchObject({ client_msg_id: 'reject-1', body: 'valid retry' })
  expect(dispatched).toBe(1)
  expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'dispatch_failed' })
  expect(frames.at(-1)).not.toHaveProperty('client_msg_id')
})
