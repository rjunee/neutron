/**
 * Sprint 19 Phase 1 — `CompositionInput.channel_router` reuse tests.
 *
 * The production composer pre-builds a `ChannelRouter` so the Telegram
 * webhook handler can hold a reference to the SAME router the graph
 * exposes. `composeProductionGraph` must reuse the supplied instance
 * (Object.is on `graph.get('channels')`) when set, and fall back to
 * constructing its own from `(db, project_slug, topic_handler)` when
 * unset (preserves the legacy P1 path).
 *
 * See `docs/plans/2026-05-05-002-feat-sprint-19-wiring-wiring-plan.md`
 * § Architectural revision: drop `DeferredEventReceiver` + `on_graph_composed`.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ChannelRouter } from '@neutronai/channels/router.ts'
import type { IncomingEvent, Topic } from '@neutronai/channels/types.ts'
import {
  composeProductionGraph,
  type CompositionInput,
} from '../../composition.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop()!, { recursive: true, force: true })
  }
})

function makeTempDb(): { db: ProjectDb; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'neutron-comp-channel-router-'))
  cleanups.push(root)
  const path = join(root, 'owner.db')
  const db = ProjectDb.open(path)
  applyMigrations(db.raw())
  return { db, root }
}

function makeBaseInput(
  db: ProjectDb,
  topic_handler: (t: Topic, e: IncomingEvent) => Promise<void>,
): CompositionInput {
  return {
    db,
    project_slug: 'alice',
    topic_handler,
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
  }
}

describe('CompositionInput.channel_router', () => {
  test('graph.get("channels") returns the SAME instance when channel_router is supplied', async () => {
    const { db } = makeTempDb()
    try {
      const supplied = new ChannelRouter(db, 'alice', async () => {})
      const input: CompositionInput = {
        ...makeBaseInput(db, async () => {}),
        channel_router: supplied,
      }

      const graph = await composeProductionGraph(input)
      try {
        const fromGraph = graph.get<ChannelRouter>('channels')
        // Reference-equality: composeProductionGraph reused the supplied
        // instance instead of constructing its own.
        expect(Object.is(fromGraph, supplied)).toBe(true)
      } finally {
        await graph.shutdown()
      }
    } finally {
      db.close()
    }
  })

  test('graph.get("channels") returns a fresh ChannelRouter when channel_router is unset', async () => {
    const { db } = makeTempDb()
    try {
      // Spy on topic_handler so we can observe the freshly-constructed
      // router routing an event.
      const seenTopics: Topic[] = []
      const seenEvents: IncomingEvent[] = []
      const topic_handler = async (t: Topic, e: IncomingEvent): Promise<void> => {
        seenTopics.push(t)
        seenEvents.push(e)
      }
      const input = makeBaseInput(db, topic_handler)

      const graph = await composeProductionGraph(input)
      try {
        const router = graph.get<ChannelRouter>('channels')
        // The fallback path constructed a real ChannelRouter from
        // (db, project_slug, topic_handler).
        expect(router).toBeInstanceOf(ChannelRouter)

        // Drive an inbound event end-to-end to confirm the spy fires —
        // proves the router was wired with the supplied topic_handler.
        const event: IncomingEvent = {
          channel_kind: 'webhook',
          channel_topic_id: 't-fresh-1',
          user: { channel_user_id: 'u-1', display_name: 'U1' },
          body: { text: 'hello' },
          event_id: 'e-1',
          received_at: Date.now(),
        }
        await router.receive(event)
        expect(seenEvents).toHaveLength(1)
        expect(seenEvents[0]?.event_id).toBe('e-1')
        expect(seenTopics[0]?.channel_topic_id).toBe('t-fresh-1')
        // Owner-default author #0 (connect-spec §4.1): a channel-native event
        // with no author stamp is defaulted to author #0 by ChannelRouter so
        // every downstream consumer sees a uniform author.
        expect(seenEvents[0]?.author).toEqual({ id: 'owner', display: 'owner' })
      } finally {
        await graph.shutdown()
      }
    } finally {
      db.close()
    }
  })

  test('ChannelRouter preserves a pre-stamped collaborator author (never overwrites §4.2)', async () => {
    const { db } = makeTempDb()
    try {
      const seenEvents: IncomingEvent[] = []
      const topic_handler = async (_t: Topic, e: IncomingEvent): Promise<void> => {
        seenEvents.push(e)
      }
      const router = new ChannelRouter(db, 'alice', topic_handler)
      const event: IncomingEvent = {
        channel_kind: 'app_socket',
        channel_topic_id: 't-collab',
        user: { channel_user_id: 'u-2', display_name: 'Mona' },
        body: { text: 'hi' },
        event_id: 'e-2',
        received_at: Date.now(),
        author: { id: 'mona', display: 'Mona' },
      }
      await router.receive(event)
      expect(seenEvents[0]?.author).toEqual({ id: 'mona', display: 'Mona' })
    } finally {
      db.close()
    }
  })
})
