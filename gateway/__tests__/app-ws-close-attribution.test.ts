import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'

import {
  AppWsAdapter,
  InMemoryAppWsSessionRegistry,
  createAppWsAuthResolver,
} from '@neutronai/channels/index.ts'
import {
  createAppWsSurface,
  type AppWsSocketData,
} from '../http/app-ws-surface.ts'

let lines: string[]
let originalLog: typeof console.log

function field(line: string, name: string): string {
  return new RegExp(`(?:^| )${name}=([^ ]+)`).exec(line)?.[1] ?? ''
}

function harness(): {
  surface: ReturnType<typeof createAppWsSurface>
  ws: ServerWebSocket<AppWsSocketData>
  closes: Array<{ code: number | undefined; reason: string | undefined }>
} {
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async () => undefined },
  })
  const surface = createAppWsSurface({
    adapter,
    registry,
    auth: createAppWsAuthResolver({ project_slug: 'demo', bypass: true }),
    project_slug: 'demo',
  })
  const closes: Array<{ code: number | undefined; reason: string | undefined }> = []
  const data: AppWsSocketData = {
    surface: 'app_ws',
    user_id: 'owner',
    project_slug: 'demo',
    channel_topic_id: 'app:owner',
    device_id: 'device-1',
    conn_id: 'connection-1',
  }
  const ws = {
    data,
    send: () => 1,
    close: (code?: number, reason?: string) => { closes.push({ code, reason }) },
  } as unknown as ServerWebSocket<AppWsSocketData>
  return { surface, ws, closes }
}

async function open(
  surface: ReturnType<typeof createAppWsSurface>,
  ws: ServerWebSocket<AppWsSocketData>,
): Promise<void> {
  await surface.websocket.open?.(ws)
  lines = []
}

beforeEach(() => {
  lines = []
  originalLog = console.log
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
})

afterEach(() => {
  console.log = originalLog
})

describe('app-ws close attribution', () => {
  it('refuses to report an uptime when close precedes open', async () => {
    const { surface, ws } = harness()

    await expect(surface.websocket.close?.(ws, 1006, '')).rejects.toThrow(
      'app-ws: close callback preceded open callback',
    )
    expect(lines).toEqual([])
  })

  it('records a peer close as client-initiated and deliberate', async () => {
    const { surface, ws } = harness()
    await open(surface, ws)

    await surface.websocket.close?.(ws, 1000, 'page_navigation')

    const line = lines[0] as string
    expect(field(line, 'initiated_by')).toBe('client')
    expect(field(line, 'close_code')).toBe('1000')
    expect(field(line, 'close_reason')).toBe('page_navigation')
    expect(field(line, 'close_kind')).toBe('deliberate')
    expect(Number(field(line, 'uptime_ms'))).toBeGreaterThanOrEqual(0)
  })

  it('marks a locally requested close as server-initiated', async () => {
    const { surface, ws, closes } = harness()
    await open(surface, ws)

    surface.closeConnections('service_restart')
    expect(closes).toEqual([{ code: 1012, reason: 'service_restart' }])
    await surface.websocket.close?.(ws, 1012, 'service_restart')

    const line = lines[0] as string
    expect(field(line, 'initiated_by')).toBe('server')
    expect(field(line, 'close_code')).toBe('1012')
    expect(field(line, 'close_reason')).toBe('service_restart')
    expect(field(line, 'close_kind')).toBe('deliberate')
  })

  it('does not mislabel an abnormal no-frame close as either side', async () => {
    const { surface, ws } = harness()
    await open(surface, ws)

    await surface.websocket.close?.(ws, 1006, '')

    const line = lines[0] as string
    expect(field(line, 'initiated_by')).toBe('unknown')
    expect(field(line, 'close_reason')).toBe('-')
    expect(field(line, 'close_kind')).toBe('unexpected')
  })
})
