/**
 * @neutronai/channels — channel router.
 *
 * Resolves an inbound
 * `IncomingEvent` to the matching `topics` row (creating it on first sight),
 * surfaces the resolved `Topic` to a `TopicHandler` callback, and dispatches
 * `OutgoingMessage`s back through the adapter that owns that channel kind.
 *
 * The router is the single seam between channel-agnostic plumbing and
 * channel-specific adapters. Modules above it (gateway/topic-lifecycle,
 * substrate dispatcher, MCP server) only ever talk in `Topic` / `Outgoing
 * Message` shapes.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type {
  ChannelAdapter,
  ChannelKind,
  IncomingEvent,
  IncomingEventReceiver,
  OutgoingMessage,
  Topic,
} from './types.ts'

/** A handler invoked once per resolved topic for an incoming event. */
export interface TopicHandler {
  (topic: Topic, event: IncomingEvent): Promise<void>
}

interface TopicRow {
  id: string
  project_id: string | null
  channel_kind: string
  channel_topic_id: string
  privacy_mode: 'regular' | 'private'
  status: 'active' | 'archived' | 'deleted'
}

export class ChannelRouter implements IncomingEventReceiver {
  private readonly adapters = new Map<ChannelKind, ChannelAdapter>()
  /**
   * Default project to bind newly-created topics to. NULL means "instance-
   * level topic" — the gateway's onboarding flow eventually rebinds.
   */
  private readonly defaultProjectId: string | null

  constructor(
    private readonly db: ProjectDb,
    private readonly project_slug: string,
    private readonly handler: TopicHandler,
    options: { default_project_id?: string | null } = {},
  ) {
    this.defaultProjectId = options.default_project_id ?? null
  }

  /**
   * Register an adapter for a channel kind. Throws if the kind is already
   * bound — channel-kind ownership conflicts at boot are fatal.
   */
  registerAdapter(adapter: ChannelAdapter): void {
    const kind = adapter.manifest.kind
    if (this.adapters.has(kind)) {
      throw new Error(`channel adapter for '${kind}' is already registered`)
    }
    this.adapters.set(kind, adapter)
  }

  /** Look up an adapter by kind. Returns undefined when none registered. */
  getAdapter(kind: ChannelKind): ChannelAdapter | undefined {
    return this.adapters.get(kind)
  }

  /** All adapters in arbitrary insertion order. Used by the gateway lifecycle. */
  listAdapters(): ChannelAdapter[] {
    return [...this.adapters.values()]
  }

  /**
   * Boot-time conformance guard (X5). Assert an adapter is registered for
   * every channel kind an outbound run in THIS composition can carry, so a
   * missing registration fails LOUD at boot — not silently (or as a per-send
   * throw) when a terminal delivery finally fires. This is the seam that makes
   * "adding a channel = one adapter file + one `registerAdapter` call" safe:
   * forget the registration and the composition refuses to boot with a message
   * naming the gap. `'cli'` is a sentinel binding-marker kind (see
   * `types.ts`) that no run delivers to, so it is never passed here.
   */
  assertAdaptersFor(kinds: readonly ChannelKind[]): void {
    const missing = kinds.filter((kind) => !this.adapters.has(kind))
    if (missing.length > 0) {
      const registered = [...this.adapters.keys()].join(', ') || 'none'
      throw new Error(
        `ChannelRouter is missing an adapter for kind(s): ${missing.join(', ')} ` +
          `(registered: ${registered})`,
      )
    }
  }

  /**
   * Resolve (channel_kind, channel_topic_id) → Topic, creating a row if
   * none exists. The router writes the topic row inside a transaction to
   * keep concurrent first-sight events for the same channel topic atomic.
   */
  async resolveOrCreateTopic(event: IncomingEvent): Promise<Topic> {
    const found = this.db
      .prepare<TopicRow, [string, string]>(
        `SELECT id, project_id, channel_kind, channel_topic_id, privacy_mode, status
           FROM topics
          WHERE channel_kind = ? AND channel_topic_id = ?`,
      )
      .get(event.channel_kind, event.channel_topic_id)
    if (found) {
      if (found.status !== 'active') {
        throw new Error(
          `topic ${found.id} for ${event.channel_kind}:${event.channel_topic_id} is ${found.status}`,
        )
      }
      return rowToTopic(found)
    }

    const id = crypto.randomUUID()
    const now = Date.now() / 1000
    await this.db.run(
      `INSERT INTO topics
         (id, project_slug, project_id, channel_kind, channel_topic_id,
          privacy_mode, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'regular', 'active', ?, ?)`,
      [
        id,
        this.project_slug,
        this.defaultProjectId,
        event.channel_kind,
        event.channel_topic_id,
        now,
        now,
      ],
    )
    return {
      topic_id: id,
      channel_kind: event.channel_kind,
      channel_topic_id: event.channel_topic_id,
      project_id: this.defaultProjectId,
      privacy_mode: 'regular',
    }
  }

  /** IncomingEventReceiver — adapters call this with normalised events. */
  async receive(event: IncomingEvent): Promise<void> {
    // Uniform author #0 default (connect-spec §4.1): channel-native owner turns
    // (Telegram / app-socket / CLI) reach the router without an author stamp;
    // default them to author #0 so EVERY event handed downstream carries an
    // author and no consumer needs an "is this the owner?" fork. Connect-routed
    // collaborator turns already carry a server-stamped author (§4.2) — never
    // overwrite it.
    const routed: IncomingEvent =
      event.author !== undefined
        ? event
        : { ...event, author: { id: 'owner', display: 'owner' } }
    const topic = await this.resolveOrCreateTopic(routed)
    await this.handler(topic, routed)
  }

  /** Send a message via the adapter owning `topic.channel_kind`. */
  async send(message: OutgoingMessage): Promise<string> {
    const adapter = this.adapters.get(message.topic.channel_kind)
    if (!adapter) {
      throw new Error(
        `no channel adapter registered for kind='${message.topic.channel_kind}'`,
      )
    }
    return adapter.send(message)
  }

  /**
   * Start every registered adapter that has an ingress loop. Adapters that
   * are pure sinks (CLI, webhook-pushed-to) skip this. Errors propagate.
   */
  async startAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (adapter.start) await adapter.start()
    }
  }

  /** Stop every registered adapter that exposed a stop hook. */
  async stopAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (adapter.stop) await adapter.stop()
    }
  }
}

function rowToTopic(row: TopicRow): Topic {
  if (row.channel_kind !== 'telegram' &&
      row.channel_kind !== 'app_socket' &&
      row.channel_kind !== 'webhook' &&
      row.channel_kind !== 'cli') {
    throw new Error(`topics.channel_kind has unknown value '${row.channel_kind}'`)
  }
  return {
    topic_id: row.id,
    channel_kind: row.channel_kind,
    channel_topic_id: row.channel_topic_id,
    project_id: row.project_id,
    privacy_mode: row.privacy_mode,
  }
}
