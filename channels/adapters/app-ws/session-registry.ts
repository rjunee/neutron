/**
 * @neutronai/channels/app-ws — per-session sender registry.
 *
 * Maps `channel_topic_id` → live WebSocket `send` callback. Mirrors the
 * `WebChatSenderRegistry` shape in `gateway/http/chat-bridge.ts` (which
 * owns the onboarding-chat surface) so a future consolidation can fold
 * both into one cross-channel registry. For P5.1 we keep the file
 * separate so the Expo surface stays composable when the landing
 * surface is unwired.
 *
 * Concurrency posture: identity-aware unregister — only delete a
 * topic's sender entry when the currently registered callback is
 * reference-equal to the one being torn down. This prevents a
 * losing-tap's `close` event from accidentally evicting a newer
 * reconnect's sender (Argus Sprint 18 r1 pattern — same incident
 * class).
 */

import type { AppWsOutbound } from './envelope.ts'

/**
 * Client platform reported at WS upgrade time. Used by
 * `AppWsAdapter.outgoingToEnvelope` to pick the right
 * `DocLinkChannel` per session — web clients get
 * `https://app.example.test/projects/<id>/docs?path=...` URLs
 * (Linking.openURL on web → window.open, which can't dispatch
 * `neutron://` schemes); native clients keep the custom-scheme deep
 * link. Argus BLOCKING #2 + r4 BLOCKING #1.
 */
export type AppWsClientPlatform = 'web' | 'native'

export interface AppWsRegisterOptions {
  platform?: AppWsClientPlatform
}

export interface AppWsSessionRegistry {
  register(
    channel_topic_id: string,
    send: (env: AppWsOutbound) => void,
    opts?: AppWsRegisterOptions,
  ): void
  unregister(channel_topic_id: string, send: (env: AppWsOutbound) => void): void
  send(channel_topic_id: string, env: AppWsOutbound): boolean
  has(channel_topic_id: string): boolean
  /** Returns the registered platform for a session, or `null` when
   * the session is offline / no platform was reported (back-compat
   * with P5.1 clients that don't send the field). */
  getPlatform(channel_topic_id: string): AppWsClientPlatform | null
  topics(): string[]
}

interface SessionEntry {
  send: (env: AppWsOutbound) => void
  platform?: AppWsClientPlatform
}

export class InMemoryAppWsSessionRegistry implements AppWsSessionRegistry {
  private readonly entries = new Map<string, SessionEntry>()

  register(
    channel_topic_id: string,
    send: (env: AppWsOutbound) => void,
    opts?: AppWsRegisterOptions,
  ): void {
    const entry: SessionEntry = { send }
    if (opts?.platform !== undefined) entry.platform = opts.platform
    this.entries.set(channel_topic_id, entry)
  }

  unregister(channel_topic_id: string, send: (env: AppWsOutbound) => void): void {
    const existing = this.entries.get(channel_topic_id)
    if (existing !== undefined && existing.send === send) {
      this.entries.delete(channel_topic_id)
    }
  }

  send(channel_topic_id: string, env: AppWsOutbound): boolean {
    const entry = this.entries.get(channel_topic_id)
    if (entry === undefined) return false
    try {
      entry.send(env)
    } catch (err) {
      // The send lambda throws when the underlying WebSocket has
      // closed (per `gateway/http/app-ws-surface.ts:open`'s T10
      // pattern). Downgrade to a dropped-marker so the channel
      // router knows the emit was not delivered. Sweep the stale
      // entry — the identity-aware unregister on the next `close`
      // event is a no-op once we evict here. Per Codex P2 review
      // on PR #142.
      console.warn(
        `[app-ws-registry] topic=${channel_topic_id} sender threw — treating as dropped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      this.entries.delete(channel_topic_id)
      return false
    }
    return true
  }

  has(channel_topic_id: string): boolean {
    return this.entries.has(channel_topic_id)
  }

  getPlatform(channel_topic_id: string): AppWsClientPlatform | null {
    return this.entries.get(channel_topic_id)?.platform ?? null
  }

  topics(): string[] {
    return [...this.entries.keys()]
  }
}
