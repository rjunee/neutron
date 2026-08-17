/**
 * substrate-notice-sink.ts — O6: wire the persistent-REPL NOTICE-family DI seams
 * (`onDeadTurnNotice` / `onSizeAlert` / `onRateLimitBanner` /
 * `onModelFloorApplied`) to the gateway's two visibility surfaces.
 *
 * THE GAP: the runtime substrate DETECTS four previously-invisible states — a
 * mid-turn API 5xx that killed a turn (row #11), a warm transcript that crossed a
 * size band (row #13), and a rate-limit / usage-cap banner (row #10) — but in Open
 * those callbacks were UNWIRED, so each state degraded to a stderr line the owner
 * never sees (Codex review, PR #67). A usage-capped session would just… stop
 * replying, silently.
 *
 * THE FIX (no new subsystem): each callback fans to the SAME two surfaces every
 * other deliberate-degrade site already uses —
 *   1. `system_events` — the product-wide degradation journal (O4), via the
 *      ambient sink (`emitSystemEvent`) or an injected {@link SystemEventSink}.
 *   2. an OWNER-TOPIC SYSTEM BUBBLE — a transient `system_notice` pill on the
 *      owner's chat topic, delivered through the SAME {@link Deliver} seam (F5)
 *      the fired-reminder / proactive-brief paths use, so the owner SEES the
 *      state in chat instead of it vanishing. The bubble is a `durability: 'none'`
 *      delivery — a live-only pill (the app-ws adapter skips the durable
 *      chat_log row), so a reload never re-hydrates a stale "rate-limited"
 *      bubble.
 *
 * A FOURTH STATE, added after the model-floor defect: `onModelFloorApplied` — an
 * owner-facing spawn resolved BELOW the configured best model and was held at the
 * floor (`runtime/.../model-floor.ts`). It shares this file for the same reason
 * as the other three: its first implementation was a `log.warn`, so the owner's
 * chat silently ran a lower tier for a working day and the only detector was him
 * noticing the answers were worse.
 *
 * LATCHING: the first three notices are edge-latched UPSTREAM by the substrate (a
 * per-turn dead-turn latch; a per-band size latch; a per-`threadId::severity`
 * rate-limit latch), so a callback fires ONCE per rising edge and a stale banner
 * in an idle pane never re-fires (the hourly-re-fire bug the substrate already
 * closed). This sink therefore does NOT re-latch — adding a second latch here
 * would wrongly suppress a legitimate later rising edge (a size warn→critical
 * escalation, or a recovered-then-recurring rate limit). The fourth is unlatched
 * BY DESIGN at both ends; the reason is at its callback below.
 *
 * DELIVER IS LAZY (`deliver: () => …`) because the {@link Deliver} seam is
 * constructed AFTER the per-instance conversational substrate this sink is wired
 * into — a holder resolved at call time avoids a forward reference without
 * reordering instance setup (mirrors {@link makeRecoveredReplySink}).
 */

import type {
  DeadTurnNotice,
  ModelFloorNotice,
  RateLimitBannerNotice,
  SizeSeverity,
} from '@neutronai/runtime/adapters/claude-code/index.ts'
import {
  emitSystemEventSafe,
  resolveSystemEventSink,
  type SystemEventSink,
} from '@neutronai/persistence/index.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import type { Deliver } from './deliver.ts'

/** The notice callbacks, shaped exactly as the substrate option bag expects
 *  (see `BuildLlmCallSubstrateInput`). */
export interface SubstrateNoticeSinks {
  onDeadTurnNotice: (notice: DeadTurnNotice) => void
  onSizeAlert: (info: { sessionKey: string; severity: SizeSeverity; sizeBytes: number }) => void
  onRateLimitBanner: (notice: RateLimitBannerNotice) => void
  onModelFloorApplied: (notice: ModelFloorNotice) => void
}

export interface MakeSubstrateNoticeSinksDeps {
  /** Lazy owner-chat delivery seam (resolved at call time — see module header). */
  deliver: () => Deliver | undefined
  /** The owner's chat topic the system bubble is delivered on (the app-ws
   *  `app:<owner>` topic in Open — the ONE topic the live client binds). */
  owner_topic_id: string
  /** Instance scope stamped on the `system_events` row (advisory). */
  project_slug?: string
  /** Injected journal sink (tests). Production omits it → the ambient sink the
   *  gateway registered at boot is resolved per call. */
  sink?: SystemEventSink | null
  now?: () => number
}

/** Human, concise system-bubble copy per state — what the owner reads in chat. */
const DEAD_TURN_BODY =
  "⚠️ That last turn hit a temporary Claude API error and didn't finish. Please send your message again."
const SIZE_WARN_BODY =
  'ℹ️ This conversation has gotten large, which can slow replies. You can reset or compact it any time.'
const SIZE_CRITICAL_BODY =
  '⚠️ This conversation is very large and may start slowing or dropping replies. Consider resetting or compacting it.'
const RATE_LIMIT_USAGE_CAP_BODY =
  "🚧 Claude usage limit reached — your subscription window is capped and won't recover until it resets."
const RATE_LIMIT_TEMPORARY_BODY =
  '⏳ Claude is briefly rate-limited or overloaded. It will retry on its own — no action needed.'
/**
 * Longest run of a registry-sourced value that may reach the bubble. Chat copy,
 * not a log line: a pathological row should not be able to push the readable part
 * of the sentence off the screen.
 */
const NOTICE_VALUE_MAX = 64

/**
 * Make a registry-sourced value safe to interpolate into chat markdown.
 *
 * WHY THIS EXISTS AT ALL. `repl-registry.ts:74` declares `model?: string` and
 * never schema-checks it, and this bubble is the one place that value is rendered
 * to the owner. Dropped straight into a backtick span it could carry its own
 * backtick and break out of the code span, or arrive long enough to bury the
 * sentence. Neither is dangerous — the client renders chat markdown, not HTML —
 * but the value's whole job here is to be READ, and a notice that renders as
 * garbage is a notice that failed.
 *
 * ALLOW-LIST RATHER THAN DENY-LIST, and that choice is the point: a model id and
 * a pool key are both drawn from `[A-Za-z0-9._:/@-]`, so naming what may pass
 * needs no guess about what a corrupt row might contain. Anything else — a
 * backtick, a newline, a control byte, an emoji — collapses to a space.
 *
 * The truncation is marked with `…` so a clipped id is never mistaken for a
 * complete one; the failure this file exists to end is a wrong model id being
 * believed. An empty result is SAID rather than rendered as an empty span, so a
 * blank never reads as "no problem here".
 */
const noticeValue = (raw: unknown): string => {
  const text = typeof raw === 'string' ? raw : ''
  const flat = text.replace(/[^A-Za-z0-9._:/@-]+/g, ' ').trim()
  if (flat === '') return '(empty)'
  return flat.length > NOTICE_VALUE_MAX ? `${flat.slice(0, NOTICE_VALUE_MAX)}…` : flat
}

/** The floor-clamp bubble NAMES BOTH MODELS AND THE SESSION. The owner's only
 *  symptom last time was that the answers got worse, and when he asked, the chat
 *  told him the lower tier was the environment default — which `runtime/models.ts`
 *  contradicts. A notice that says only "a model was corrected" would leave that
 *  same guessing game in place, so the requested id and the floor both go in.
 *
 *  ⚠️ THE SESSION KEY IS IN THE COPY BECAUSE THE BUBBLE DOES NOT LAND ON THE
 *  DEGRADED CHAT. `deps.owner_topic_id` is one pinned topic, while a project chat
 *  binds its own (`gateway/http/app-ws-surface.ts`), so a clamp on a project
 *  session surfaces on the owner's main topic instead. Routing it to the right
 *  topic is a real improvement and is NOT done here (see `docs/AS_BUILT.md`);
 *  what is not acceptable meanwhile is copy that says "this chat" while pointing
 *  at a different one, so it names the session it is actually talking about. */
const modelFloorBody = (sessionKey: string, requested: string, floor: string): string =>
  `⚠️ Session \`${noticeValue(sessionKey)}\` resumed asking for \`${noticeValue(requested)}\`, which is below the best model. ` +
  `It was held at \`${noticeValue(floor)}\` instead — no action needed, but if it keeps happening something is rewriting that session's model.`

/**
 * Build the notice-family sinks the gateway wires into the owner's conversational
 * substrate. Each callback (a) journals a `system_events` row and (b) delivers a
 * transient owner-topic system bubble. Both surfaces are best-effort: a journal
 * failure is swallowed by {@link emitSystemEventSafe}, and a closed-socket send is
 * caught here — a notice must never crash the scan tick that fired it.
 */
export function makeSubstrateNoticeSinks(
  deps: MakeSubstrateNoticeSinksDeps,
): SubstrateNoticeSinks {
  const journal = (
    event: 'dead_turn_notice' | 'session_size_alert' | 'rate_limit_banner' | 'model_floor_applied',
    level: 'info' | 'warn',
    payload: Record<string, unknown>,
  ): void => {
    const sink = deps.sink !== undefined ? deps.sink : resolveSystemEventSink()
    // Fire-and-forget: emitSystemEventSafe is contracted never to throw/reject
    // (O4), so this is a best-effort journal — fireAndForget is the sanctioned
    // wrapper (a defensive backstop that logs should the contract ever break).
    fireAndForget(
      'substrate-notice.journal',
      emitSystemEventSafe(sink, {
        event,
        module: 'substrate-notice',
        level,
        project_slug: deps.project_slug ?? null,
        payload,
        ...(deps.now !== undefined ? { ts: deps.now() } : {}),
      }),
    )
  }

  const bubble = (body: string): void => {
    const deliver = deps.deliver()
    if (deliver === undefined) return
    // A `durability: 'none'` delivery — a transient live-only `system_notice`
    // pill (the app-ws adapter skips the durable chat_log row, matching the
    // cold-start "Waking up…" ack), so a reload can't re-hydrate a stale state
    // notice as a stray chat bubble. `deliver` builds the system_notice envelope
    // and PUSHES SYNCHRONOUSLY for the 'none' path (no await before the push), so
    // the bubble reaches the socket within this tick; it swallows a closed-socket
    // throw internally (best-effort — the journal row is the durable record).
    // fireAndForget backstops the result promise so a notice never crashes the
    // scan tick that fired it; the surrounding try/catch is belt-and-suspenders
    // against a deliver impl that throws synchronously.
    try {
      fireAndForget(
        'substrate-notice.bubble',
        deliver(deps.owner_topic_id, { body, durability: 'none' }),
      )
    } catch {
      /* a notice bubble is best-effort (the journal row is the durable record) */
    }
  }

  return {
    onDeadTurnNotice: (notice: DeadTurnNotice): void => {
      journal('dead_turn_notice', 'warn', { matched: notice.matched })
      bubble(DEAD_TURN_BODY)
    },
    onSizeAlert: (info: { sessionKey: string; severity: SizeSeverity; sizeBytes: number }): void => {
      journal('session_size_alert', info.severity === 'critical' ? 'warn' : 'info', {
        severity: info.severity,
        size_bytes: info.sizeBytes,
      })
      bubble(info.severity === 'critical' ? SIZE_CRITICAL_BODY : SIZE_WARN_BODY)
    },
    onRateLimitBanner: (notice: RateLimitBannerNotice): void => {
      const usageCap = notice.severity === 'usage-cap'
      journal('rate_limit_banner', 'warn', { severity: notice.severity, matched: notice.matched })
      bubble(usageCap ? RATE_LIMIT_USAGE_CAP_BODY : RATE_LIMIT_TEMPORARY_BODY)
    },
    // UNLATCHED, unlike the three above — see `applyModelFloor`'s docblock. Their
    // upstream condition persists and would re-fire on every scan; a clamp cannot
    // repeat for the same cause, because it rewrites the offending registry row
    // with the floored value. A SECOND clamp therefore means a live re-poisoner,
    // which is the one thing that must not be suppressed.
    onModelFloorApplied: (notice: ModelFloorNotice): void => {
      journal('model_floor_applied', 'warn', {
        session_key: notice.sessionKey,
        source: notice.source,
        requested_model: notice.requested,
        floor_model: notice.floor,
      })
      bubble(modelFloorBody(notice.sessionKey, notice.requested, notice.floor))
    },
  }
}
