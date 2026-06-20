/**
 * @neutronai/channels — Telegram self-message filter.
 *
 * Lift target: Hermes
 * `gateway/platforms/telegram.py` "sync filter" — under certain proxy
 * configurations Telegram delivers our own outgoing messages back as
 * incoming events. Without filtering, the gateway would respond to itself
 * in an infinite loop.
 *
 * Detection: every message we send carries a sentinel marker via the
 * adapter's outbound bookkeeping. On ingress, an event whose `from.id`
 * matches the bot's own id AND whose text is a recently-sent body is a
 * self-echo and is dropped.
 *
 * The filter is an in-memory ring buffer keyed by message text (hashed) +
 * outgoing message id. Default capacity 256 — enough for a chatty session
 * even at high QPS.
 */

export interface OutgoingFingerprint {
  message_id: string
  /** Channel-native chat / topic id. */
  channel_topic_id: string
  text_hash: string
  sent_at: number
}

export interface IncomingFingerprintProbe {
  channel_topic_id: string
  text_hash: string
  /** Optional: if the channel echoes our message_id, match by that first. */
  message_id?: string
}

/**
 * FNV-1a hash. Same primitive as `runtime/tool-loop-detection.ts` so we keep
 * a single deterministic hash family across the codebase. Collisions are
 * acceptable here — false positives would only drop a real user message
 * matching a recent self-echo, which the next user retry recovers.
 */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export interface SyncFilterOptions {
  capacity?: number
  /** Self-echo TTL — older fingerprints are evicted regardless of capacity. */
  ttl_ms?: number
  now?: () => number
}

/**
 * In-memory ring buffer of recently-sent messages. Insertion is O(1)
 * amortised; lookup is O(n) within the capacity (256 is small enough that
 * the constant overhead is well under microseconds).
 */
export class SelfEchoFilter {
  private readonly buffer: OutgoingFingerprint[] = []
  private readonly capacity: number
  private readonly ttl_ms: number
  private readonly now: () => number

  constructor(options: SyncFilterOptions = {}) {
    this.capacity = options.capacity ?? 256
    this.ttl_ms = options.ttl_ms ?? 60_000
    this.now = options.now ?? Date.now
  }

  recordSent(fp: OutgoingFingerprint): void {
    this.buffer.push(fp)
    if (this.buffer.length > this.capacity) {
      this.buffer.shift()
    }
  }

  /**
   * Returns true if `probe` matches a recently-sent fingerprint AND the
   * fingerprint is still inside the TTL window. Side effect: matched
   * entries are dropped (a self-echo is always one-shot).
   */
  isSelfEcho(probe: IncomingFingerprintProbe): boolean {
    const cutoff = this.now() - this.ttl_ms
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const fp = this.buffer[i]
      if (!fp) continue
      if (fp.sent_at < cutoff) {
        // expired entries: prune in-place
        this.buffer.splice(i, 1)
        continue
      }
      if (fp.channel_topic_id !== probe.channel_topic_id) continue
      if (probe.message_id !== undefined && fp.message_id === probe.message_id) {
        this.buffer.splice(i, 1)
        return true
      }
      if (fp.text_hash === probe.text_hash) {
        this.buffer.splice(i, 1)
        return true
      }
    }
    return false
  }

  /** Snapshot for tests / observability. */
  size(): number {
    return this.buffer.length
  }
}
