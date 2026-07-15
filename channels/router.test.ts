import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ChannelRouter } from './router.ts'
import type {
  ChannelAdapter,
  IncomingEvent,
  OutgoingMessage,
  Topic,
} from './types.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-router-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const sampleEvent: IncomingEvent = {
  channel_kind: 'telegram',
  channel_topic_id: '12345:7',
  user: { channel_user_id: '99', display_name: 'tester' },
  body: { text: 'hi' },
  event_id: '12345:1',
  received_at: 1000,
}

class RecordingAdapter implements ChannelAdapter {
  manifest = {
    kind: 'telegram' as const,
    display_name: 'test',
    supports_inline_choices: true,
    supports_unprompted_send: true,
  }
  sent: OutgoingMessage[] = []
  startedCount = 0
  stoppedCount = 0
  async send(message: OutgoingMessage): Promise<string> {
    this.sent.push(message)
    return `msg-${this.sent.length}`
  }
  async start(): Promise<void> { this.startedCount++ }
  async stop(): Promise<void> { this.stoppedCount++ }
}

describe('ChannelRouter', () => {
  test('first event creates a topics row + invokes handler', async () => {
    const seen: Array<{ topic: Topic; event: IncomingEvent }> = []
    const router = new ChannelRouter(db, 'project-A', async (topic, event) => {
      seen.push({ topic, event })
    })
    await router.receive(sampleEvent)
    expect(seen.length).toBe(1)
    expect(seen[0]?.topic.channel_topic_id).toBe('12345:7')
    const row = db
      .prepare<{ id: string }, [string, string]>(
        `SELECT id FROM topics WHERE channel_kind = ? AND channel_topic_id = ?`,
      )
      .get('telegram', '12345:7')
    expect(row?.id).toBe(seen[0]?.topic.topic_id ?? '')
  })

  test('second event for the same channel topic re-uses the existing row', async () => {
    const seen: Topic[] = []
    const router = new ChannelRouter(db, 'project-A', async (topic) => { seen.push(topic) })
    await router.receive(sampleEvent)
    await router.receive({ ...sampleEvent, event_id: '12345:2' })
    expect(seen.length).toBe(2)
    expect(seen[0]?.topic_id).toBe(seen[1]?.topic_id)
  })

  // Argus r2 / Codex P1 regression — the router MUST forward
  // origin_instance_slug to the topic handler unchanged. Downstream
  // persistence relies on this field to gate cross-instance writes via
  // privacy quarantine. A router that strips or rewrites it (e.g. always
  // setting it to the receiving instance's own slug) would defeat § 2.4.
  test('preserves origin_instance_slug on the event passed to the topic handler', async () => {
    const seen: IncomingEvent[] = []
    const router = new ChannelRouter(db, 'project-A', async (_t, event) => {
      seen.push(event)
    })
    await router.receive({ ...sampleEvent, origin_instance_slug: 'workspace-foo' })
    expect(seen[0]?.origin_instance_slug).toBe('workspace-foo')
  })

  test('channel-native events have no origin_instance_slug (absent = local)', async () => {
    const seen: IncomingEvent[] = []
    const router = new ChannelRouter(db, 'project-A', async (_t, event) => {
      seen.push(event)
    })
    await router.receive(sampleEvent)
    expect(seen[0]?.origin_instance_slug).toBeUndefined()
  })

  test('different channel_kind/topic_id pairs get distinct topics', async () => {
    const seen: Topic[] = []
    const router = new ChannelRouter(db, 'project-A', async (topic) => { seen.push(topic) })
    await router.receive(sampleEvent)
    await router.receive({ ...sampleEvent, channel_topic_id: 'other' })
    expect(new Set(seen.map((t) => t.topic_id)).size).toBe(2)
  })

  test('send dispatches to the registered adapter', async () => {
    const router = new ChannelRouter(db, 'project-A', async () => {})
    const adapter = new RecordingAdapter()
    router.registerAdapter(adapter)
    const msgId = await router.send({
      topic: {
        topic_id: 'tid',
        channel_kind: 'telegram',
        channel_topic_id: '12345',
        project_id: null,
        privacy_mode: 'regular',
      },
      text: 'reply',
    })
    expect(msgId).toBe('msg-1')
    expect(adapter.sent.length).toBe(1)
  })

  test('send throws when no adapter registered for kind', async () => {
    const router = new ChannelRouter(db, 'project-A', async () => {})
    await expect(
      router.send({
        topic: {
          topic_id: 'tid',
          channel_kind: 'app_socket',
          channel_topic_id: 'sock-1',
          project_id: null,
          privacy_mode: 'regular',
        },
        text: 'reply',
      }),
    ).rejects.toThrow(/no channel adapter/)
  })

  test('startAll/stopAll invoke each adapter\'s lifecycle hook', async () => {
    const router = new ChannelRouter(db, 'project-A', async () => {})
    const adapter = new RecordingAdapter()
    router.registerAdapter(adapter)
    await router.startAll()
    await router.stopAll()
    expect(adapter.startedCount).toBe(1)
    expect(adapter.stoppedCount).toBe(1)
  })

  test('duplicate adapter registration throws', () => {
    const router = new ChannelRouter(db, 'project-A', async () => {})
    router.registerAdapter(new RecordingAdapter())
    expect(() => router.registerAdapter(new RecordingAdapter())).toThrow(/already registered/)
  })

  // X5 — boot-time conformance guard: every kind a run can carry must have an
  // adapter, so a forgotten registration fails LOUD at boot, not at send.
  test('assertAdaptersFor passes when every requested kind has an adapter', () => {
    const router = new ChannelRouter(db, 'project-A', async () => {})
    router.registerAdapter(new RecordingAdapter()) // telegram
    expect(() => router.assertAdaptersFor(['telegram'])).not.toThrow()
    // Empty request is trivially satisfied.
    expect(() => router.assertAdaptersFor([])).not.toThrow()
  })

  test('assertAdaptersFor throws naming the missing kind(s) and what is registered', () => {
    const router = new ChannelRouter(db, 'project-A', async () => {})
    router.registerAdapter(new RecordingAdapter()) // telegram
    expect(() => router.assertAdaptersFor(['telegram', 'app_socket'])).toThrow(
      /missing an adapter for kind\(s\): app_socket/,
    )
    // The message surfaces what IS registered so the boot failure is actionable.
    expect(() => router.assertAdaptersFor(['app_socket'])).toThrow(/registered: telegram/)
  })

  test('assertAdaptersFor on an empty router reports registered: none', () => {
    const router = new ChannelRouter(db, 'project-A', async () => {})
    expect(() => router.assertAdaptersFor(['app_socket'])).toThrow(/registered: none/)
  })
})
