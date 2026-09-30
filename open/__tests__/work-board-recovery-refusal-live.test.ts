/** The real Open board onChange fan must retain a refusal through the socket
 * snapshot. Both clients replace their local boards with that snapshot. */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { decodeWorkBoardFrame } from '@neutronai/app/lib/work-board-live.ts'
import { parseWorkBoardItems as parseWebItems } from '@neutronai/landing/chat-react/work-board-client.ts'
import type { AppWsSocketData } from '@neutronai/gateway/http/app-ws-surface.ts'
import { buildOpenGraphComposer } from '../composer.ts'

let home: string
let db: ProjectDb | null = null
let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const stop of cleanup) await stop()
  cleanup = []
  db?.close()
  db = null
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
})

test('a real board refusal reaches a scoped WebSocket and survives both client snapshot decoders', async () => {
  home = mkdtempSync(join(tmpdir(), 'board-refusal-live-'))
  const path = join(home, 'project.db')
  seedMigratedDb(path)
  db = ProjectDb.open(path)
  const compose = buildOpenGraphComposer({ env: {
    PATH: process.env['PATH'] ?? '',
    NEUTRON_HOME: home,
    NEUTRON_DB_PATH: path,
    NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: '1',
    NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'synthetic-refusal-test-cookie',
  } })
  const composition = await compose({ db, project_slug: 'owner' })
  cleanup = composition.realmode_cleanups ?? []
  const rawFrames: Array<Record<string, unknown>> = []
  const socket = {
    data: {
      surface: 'app_ws', user_id: 'owner', project_slug: 'owner',
      channel_topic_id: 'app:owner:project', conn_id: 'socket-1', project_id: 'project',
    },
    send: (data: string) => { rawFrames.push(JSON.parse(data) as Record<string, unknown>); return 1 },
  } as unknown as ServerWebSocket<AppWsSocketData>
  await composition.app_ws_surface!.websocket.open!(socket)
  try {
    const board = composition.work_board!.store
    const card = await board.create('project', { title: 'Recovery source' })
    const before = rawFrames.filter(frame => frame['type'] === 'work_board_changed').at(-1)!
    expect(before['project_id']).toBe('project')
    expect(decodeWorkBoardFrame(before, 'project')?.[0]?.recovery_refusal).toBeNull()
    expect(parseWebItems(before['items'])[0]?.recovery_refusal).toBeNull()

    const reason = 'Recovery refused: published head moved.'
    expect(await board.recordRecoveryRefusal('project', card.id, {
      linked_run_id: card.linked_run_id, status: 'upcoming', updated_at: card.updated_at,
    }, reason)).toBe(true)
    const live = rawFrames.filter(frame => frame['type'] === 'work_board_changed').at(-1)!
    expect(live['project_id']).toBe('project')
    expect(decodeWorkBoardFrame(live, 'project')?.[0]).toMatchObject({ status: 'blocked', recovery_refusal: reason })
    expect(parseWebItems(live['items'])[0]).toMatchObject({ status: 'blocked', recovery_refusal: reason })
    expect(decodeWorkBoardFrame(live, 'sibling')).toBeNull()

    const frameCount = rawFrames.filter(frame => frame['type'] === 'work_board_changed').length
    expect(await board.recordRecoveryRefusal('project', card.id, {
      linked_run_id: card.linked_run_id, status: 'upcoming', updated_at: card.updated_at,
    }, 'Late fabricated refusal')).toBe(false)
    expect(rawFrames.filter(frame => frame['type'] === 'work_board_changed')).toHaveLength(frameCount)

    // A sibling frame cannot clobber this board, and an ordinary card must
    // not acquire a fabricated refusal from an earlier snapshot.
    const sibling = await board.create('sibling', { title: 'Ordinary work' })
    expect(sibling.recovery_refusal).toBeNull()
    const foreign = rawFrames.filter(frame => frame['type'] === 'work_board_changed').at(-1)!
    expect(foreign['project_id']).toBe('sibling')
    expect(decodeWorkBoardFrame(foreign, 'project')).toBeNull()
    expect(parseWebItems(foreign['items'])[0]?.recovery_refusal).toBeNull()
  } finally {
    await composition.app_ws_surface!.websocket.close!(socket, 1000, 'done')
  }
})
