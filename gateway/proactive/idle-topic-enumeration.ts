/**
 * @neutronai/gateway/proactive — production idle-topic enumeration.
 *
 * The idle-nudge sweep (`idle-nudge-sweep.ts`) is pure policy: it takes a list
 * of candidate topics plus a last-activity watermark and decides whether to
 * post. The ENUMERATION — which topics exist, and when the owner was last
 * actually present in them — is host-specific, so the composer supplies it.
 * This module is the single-owner (Neutron Open) implementation.
 *
 * Two things it has to get right, both of which kept the sweep switched off
 * until now:
 *
 *  1. BOTH NAMESPACES. The owner's chat history is split across two topic
 *     roots — `web:<owner>` (React web client) and `app:<owner>` (Expo app-ws
 *     client) — and they are genuinely independent: a conversation handled on
 *     the phone leaves no trace under `web:`. Enumerating one root means the
 *     sweep nudges about work the owner just dealt with on the other device.
 *     So the watermark is the MAX across every root, General and per-project
 *     descendants alike.
 *
 *  2. GENUINE USER ACTIVITY ONLY. The nudge posts through
 *     `buildButtonStoreProactiveSink`, which persists a durable row into the
 *     SAME `button_prompts` table the watermark is read from. Against a naive
 *     `MAX(created_at)` the sweep's own bubble advances the watermark past the
 *     value it stored at the last nudge, the dedupe branch reads that as "the
 *     user came back", and the nudge repeats every idle cycle forever. We read
 *     `last_user_activity_at` instead — the timestamp of the most recent turn a
 *     REAL PERSON took (see `ButtonStore.listTopicsByUser`), which no
 *     system-authored row can move.
 *
 * SHAPE: exactly ONE candidate, never a fan-out. Neutron Open is single-owner
 * and the P6 ranker writes ONE `current_focus_pick` row per instance per day
 * (`gateway/tasks/p6/nudge-engine.ts` keys it by the instance slug, not by
 * project). Emitting one candidate per project topic would therefore post the
 * SAME pick into every idle topic — a fan-out of one thought. One pick, one
 * nudge, delivered to the owner's General topic: "if General is idle, ping with
 * a single question on the highest-leverage blocker."
 */

import type { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ProactiveTopicCandidate } from './idle-nudge-sweep.ts'

export interface OwnerIdleTopicEnumeratorInput {
  /** Per-instance ButtonStore — the chat-history source both clients write to. */
  store: Pick<ButtonStore, 'listTopicsByUser'>
  /** The instance slug the P6 ranker keys `current_focus_pick` by. */
  project_slug: string
  /** Where the nudge is DELIVERED (the owner's General app-ws topic). */
  topic_id: string
  /**
   * Every topic ROOT the owner speaks under — `webTopicId(owner)` +
   * `appWsTopicId(owner)`. Activity under ANY of them counts as the owner
   * being present.
   */
  topic_roots: readonly string[]
  now(): number
  log?(msg: string): void
}

/**
 * Build the single-owner `listIdleTopics` seam for `tasks.proactive`.
 *
 * Returns one candidate whose `last_activity_ms` is the most recent GENUINE
 * user turn anywhere in the owner's chat footprint, or `null` when a person has
 * never spoken (the sweep treats null as idle — correct for a fresh install,
 * and the dedupe ledger still stops a second nudge because a null watermark
 * cannot advance).
 *
 * Never throws: an enumeration failure yields zero candidates (no nudge this
 * tick) rather than killing the cron.
 */
export function buildOwnerIdleTopicEnumerator(
  input: OwnerIdleTopicEnumeratorInput,
): () => Promise<ProactiveTopicCandidate[]> {
  return async (): Promise<ProactiveTopicCandidate[]> => {
    let lastActivityMs: number | null = null
    try {
      const rows = await input.store.listTopicsByUser({
        user_id_prefix: input.topic_roots,
        now: input.now(),
      })
      for (const row of rows) {
        const at = row.last_user_activity_at
        if (at === null) continue
        if (lastActivityMs === null || at > lastActivityMs) lastActivityMs = at
      }
    } catch (err) {
      input.log?.(`[proactive] idle-topic enumeration failed: ${err}`)
      return []
    }
    return [
      {
        topic_id: input.topic_id,
        project_slug: input.project_slug,
        last_activity_ms: lastActivityMs,
      },
    ]
  }
}
