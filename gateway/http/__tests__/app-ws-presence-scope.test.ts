import { expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'

import {
  AppWsAdapter,
  InMemoryAppWsSessionRegistry,
  createAppWsAuthResolver,
} from '@neutronai/channels/index.ts'
import { createAppWsSurface, type AppWsSocketData } from '../app-ws-surface.ts'

it('reports the web socket project as part of foreground presence', async () => {
  const reports: Array<{ user_id: string; project_id: string | null; connection_id: string }> = []
  const registry = new InMemoryAppWsSessionRegistry()
  const surface = createAppWsSurface({
    adapter: new AppWsAdapter({
      registry,
      receiver: { receive: async () => undefined },
    }),
    registry,
    auth: createAppWsAuthResolver({ project_slug: 'demo', bypass: true }),
    project_slug: 'demo',
    web_presence: {
      foreground: (user_id, project_id, connection_id) => {
        reports.push({ user_id, project_id, connection_id })
      },
      background: () => undefined,
      drop: () => undefined,
    },
  })
  const ws = {
    data: {
      surface: 'app_ws',
      user_id: 'owner',
      project_slug: 'demo',
      channel_topic_id: 'app:owner:project-a',
      conn_id: 'connection-a',
      device_id: 'device-a',
      platform: 'web',
      project_id: 'project-a',
    },
    send: () => 1,
  } as unknown as ServerWebSocket<AppWsSocketData>

  await surface.websocket.message(ws, JSON.stringify({ v: 1, type: 'presence', state: 'foreground' }))

  expect(reports).toEqual([
    { user_id: 'owner', project_id: 'project-a', connection_id: 'connection-a' },
  ])
})
