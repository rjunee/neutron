/**
 * @neutronai/channels/app-ws — per-session sender registry.
 *
 * Maps `channel_topic_id` → the set of live WebSocket `send` callbacks for
 * that topic. Mirrors the `WebChatSenderRegistry` shape in
 * `gateway/http/chat-bridge.ts` (which owns the onboarding-chat surface) so
 * a future consolidation can fold both into one cross-channel registry. For
 * P5.1 we keep the file separate so the Expo surface stays composable when
 * the landing surface is unwired.
 *
 * MULTI-DEVICE (chat-sync foundation, Phase 1): a topic is `app:<user_id>`,
 * so "multiple devices on one account" (laptop + phone, both live) map to
 * the SAME topic. The registry therefore holds a `Set<sender>` per topic and
 * FANS OUT every emit to all of them — a `Map<topic, sender>` last-wins
 * registry would silently drop one device. Combined with the server `seq`
 * each device carries its own resume cursor, so both converge on the same
 * ordered transcript. (Research doc §4: "change the registry from
 * Map<topic, sender> (last-wins) to Map<topic, Set<sender>> so the same user
 * on web + phone both receive emits.")
 *
 * Concurrency posture: identity-aware unregister — only delete a specific
 * sender entry when the registered callback is reference-equal to the one
 * being torn down. This prevents a losing-tap's `close` event from
 * accidentally evicting a newer reconnect's sender (Argus Sprint 18 r1
 * pattern — same incident class) AND prevents one device's close from
 * evicting another device on the same account.
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
  /**
   * Track B Phase 4 — the client's device id (from the WS upgrade query
   * string). Lets the adapter (a) record a `delivered` receipt for every
   * device connected at message fan-out time, and (b) attribute a `read`
   * receipt to the right device. Absent for legacy clients that don't report
   * one — those sessions are simply omitted from the delivered set.
   */
  device_id?: string
}

export interface AppWsSessionRegistry {
  register(
    channel_topic_id: string,
    send: (env: AppWsOutbound) => void,
    opts?: AppWsRegisterOptions,
  ): void
  unregister(channel_topic_id: string, send: (env: AppWsOutbound) => void): void
  /** Fan-out: deliver `env` to EVERY live device on the topic. Returns true
   *  if at least one device received it. */
  send(channel_topic_id: string, env: AppWsOutbound): boolean
  has(channel_topic_id: string): boolean
  /** Returns a registered platform for a session, or `null` when the
   *  session is offline / no platform was reported (back-compat with P5.1
   *  clients that don't send the field). When multiple devices are
   *  connected the most-recently-registered platform wins. */
  getPlatform(channel_topic_id: string): AppWsClientPlatform | null
  /** Number of live devices on a topic (0 when offline). */
  deviceCount(channel_topic_id: string): number
  /**
   * Track B Phase 4 — distinct device ids currently connected on a topic
   * (deduped; legacy sessions without a reported device_id are omitted). The
   * adapter records a `delivered` receipt for each at message fan-out time.
   */
  devices(channel_topic_id: string): string[]
  topics(): string[]
}

interface SessionEntry {
  send: (env: AppWsOutbound) => void
  platform?: AppWsClientPlatform
  device_id?: string
}

export class InMemoryAppWsSessionRegistry implements AppWsSessionRegistry {
  // One topic → many devices. Insertion order is preserved by Set, so
  // `getPlatform` can return the most-recent registrant.
  private readonly entries = new Map<string, Set<SessionEntry>>()

  register(
    channel_topic_id: string,
    send: (env: AppWsOutbound) => void,
    opts?: AppWsRegisterOptions,
  ): void {
    const entry: SessionEntry = { send }
    if (opts?.platform !== undefined) entry.platform = opts.platform
    if (opts?.device_id !== undefined) entry.device_id = opts.device_id
    let set = this.entries.get(channel_topic_id)
    if (set === undefined) {
      set = new Set<SessionEntry>()
      this.entries.set(channel_topic_id, set)
    }
    set.add(entry)
  }

  unregister(channel_topic_id: string, send: (env: AppWsOutbound) => void): void {
    const set = this.entries.get(channel_topic_id)
    if (set === undefined) return
    // Identity-aware: evict only the entry whose `send` is reference-equal.
    for (const entry of set) {
      if (entry.send === send) {
        set.delete(entry)
        break
      }
    }
    if (set.size === 0) this.entries.delete(channel_topic_id)
  }

  send(channel_topic_id: string, env: AppWsOutbound): boolean {
    const set = this.entries.get(channel_topic_id)
    if (set === undefined || set.size === 0) return false
    let delivered = false
    // Snapshot so a sweep during iteration (a throwing sender we evict
    // below) can't invalidate the live Set we're walking.
    for (const entry of [...set]) {
      try {
        entry.send(env)
        delivered = true
      } catch (err) {
        // The send lambda throws when the underlying WebSocket has
        // closed (per `gateway/http/app-ws-surface.ts:open`'s T10
        // pattern). Sweep the stale entry — the identity-aware
        // unregister on the next `close` event is a no-op once we evict
        // here. Per Codex P2 review on PR #142. With multi-device we
        // must NOT abort the fan-out: a dead laptop socket can't stop
        // the phone from receiving the emit.
        console.warn(
          `[app-ws-registry] topic=${channel_topic_id} a sender threw — treating as dropped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        set.delete(entry)
      }
    }
    if (set.size === 0) this.entries.delete(channel_topic_id)
    return delivered
  }

  has(channel_topic_id: string): boolean {
    const set = this.entries.get(channel_topic_id)
    return set !== undefined && set.size > 0
  }

  getPlatform(channel_topic_id: string): AppWsClientPlatform | null {
    const set = this.entries.get(channel_topic_id)
    if (set === undefined || set.size === 0) return null
    // Most-recently-registered device wins (Set preserves insertion order).
    let platform: AppWsClientPlatform | null = null
    for (const entry of set) {
      if (entry.platform !== undefined) platform = entry.platform
    }
    return platform
  }

  deviceCount(channel_topic_id: string): number {
    return this.entries.get(channel_topic_id)?.size ?? 0
  }

  devices(channel_topic_id: string): string[] {
    const set = this.entries.get(channel_topic_id)
    if (set === undefined || set.size === 0) return []
    const ids = new Set<string>()
    for (const entry of set) {
      if (entry.device_id !== undefined && entry.device_id.length > 0) ids.add(entry.device_id)
    }
    return [...ids]
  }

  topics(): string[] {
    return [...this.entries.keys()]
  }
}
