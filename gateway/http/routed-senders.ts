/**
 * @neutronai/gateway/http — channel-agnostic routed onboarding senders.
 *
 * D3 (2026-07) — extracted out of `chat-bridge.ts` as a pure move (no
 * behavior change). `chat-bridge.ts` re-exports these symbols so existing
 * internal + external `import ... from '.../chat-bridge.ts'` callers keep
 * resolving unchanged; new/repointed callers should import directly from
 * this sibling leaf module instead.
 *
 * The two factories build the `SendButtonPromptFn` / `sendImportProgress`
 * fan-out the engine emits onboarding through: `web:` → the sender
 * registry, `tg:` → the telegram sender, `app:` → the composer-filled
 * app-ws holder.
 *
 * ---
 *
 * T10 (2026-05-14) — structured-log tag for the WS upgrade chain.
 *
 * journalctl picks up `console.info` from the per-instance systemd unit by
 * default. The brief's diagnostic gap on prod was "ZERO request logs
 * post-boot": the chat-bridge had no observability at the WS upgrade
 * boundary, so a fresh-instance repro had no actionable trace. Every log
 * line in this file uses the `[chat-bridge]` prefix + a JSON-shaped body so
 * an operator can grep the unit journal for `[chat-bridge]` lines and read
 * the WS lifecycle line by line.
 *
 * Fields shape (all optional, included when known):
 *   instance=<slug> topic=<topic_id> jti=<jti> user=<user_id> event=<stage>
 *   delivered=<bool> outcome=<string> err=<string>
 *
 * Why `console.info` (not `console.warn`): warn pollutes operator alerts
 * for the happy path. The per-request volume is one line per WS upgrade
 * + one per inbound message, low even at peak — no log-volume risk.
 */

import { createHash } from 'node:crypto'
import type { SendButtonPromptFn } from '@neutronai/onboarding/interview/engine.ts'
import type { WebChatSenderRegistry } from './chat-sender-registry.ts'
import { renderButtonPromptForWeb } from './render-outbound.ts'

/**
 * Onboarding consolidation (2026-06-26) — a late-bound app-socket sender holder.
 *
 * The Open composer builds the app-ws registry AFTER `buildLandingStack`
 * constructs the engine (the engine's `sendButtonPrompt` is fixed at
 * construction), so the `app:` route can't be a concrete function at engine
 * build time. The composer passes this MUTABLE holder into the routed sender and
 * fills `.send` once the app-ws adapter/registry exist. The routed closure reads
 * `holder.send` at CALL time, so the late binding is safe — the first socket
 * connects long after boot fills the holder. This keeps ONE engine + ONE routed
 * sender across web/telegram/app-socket (no second onboarding path).
 */
export interface AppSocketButtonPromptRouter {
  send?: SendButtonPromptFn
}

export interface BuildRoutedSendButtonPromptOptions {
  webRegistry: WebChatSenderRegistry
  /**
   * Telegram sender wired by the gateway boot when a TelegramAdapter is
   * composed. When omitted (web-only deploy), prompts addressed to a
   * `tg:` topic_id are returned was_new=false so the engine's retry
   * path stays consistent.
   */
  telegramSender?: SendButtonPromptFn
  /**
   * Onboarding consolidation — app-socket (`app:<user_id>`) route. The Open
   * composer fills the holder's `.send` after the app-ws registry is built so
   * onboarding prompts emit over the SAME `/ws/app/chat` socket the steady-state
   * chat uses. Absent on the Managed/web-only path (prompts to an `app:` topic
   * return was_new=false; the engine retries).
   */
  appSocketRouter?: AppSocketButtonPromptRouter
}

/**
 * Build a `SendButtonPromptFn` that routes by `topic_id` prefix. The
 * engine constructs with one sender; this factory hides the per-channel
 * fan-out so the engine code itself stays channel-agnostic.
 *
 * Routing:
 *   - `web:<user_id>`               → web registry (this module)
 *   - `tg:<chat_id>[:<thread_id>]`  → telegramSender (optional)
 *   - everything else               → was_new=false (the engine retries
 *                                      next emit; telemetry sees the gap)
 */
/**
 * 2026-05-21 (Bug 1, v0.1.75) — `sendImportProgress` factory.
 *
 * Mirrors `buildRoutedSendButtonPrompt` shape but routes the UI-only
 * `import_progress` envelope. Web: through `WebChatSenderRegistry`.
 * Telegram: silent drop today (no `telegramSender` wired for progress;
 * Telegram users get the import-completion `agent_message` once the
 * runner terminates — no mid-flight progress UX). Unknown channels:
 * dropped with a warn log.
 *
 * The progress envelope carries no audit identity, so repeat sends on a
 * closed WS are benign — the registry returns false, the engine ignores
 * the return value, and the next 5 s tick re-emits.
 */
/**
 * Onboarding consolidation (2026-06-26) — app-socket import-progress holder.
 * Same late-bind rationale as {@link AppSocketButtonPromptRouter}. The composer
 * fills `.send` to translate the UI-only `import_progress` event onto the
 * `/ws/app/chat` socket so the onboarding import phase renders live progress in
 * the React client.
 */
export interface AppSocketImportProgressRouter {
  send?: (input: SendImportProgressArgs) => Promise<{ delivered: boolean }>
}

export interface BuildRoutedSendImportProgressOptions {
  webRegistry: WebChatSenderRegistry
  /** Onboarding consolidation — `app:<user_id>` route (composer-filled holder). */
  appSocketRouter?: AppSocketImportProgressRouter
}

export interface SendImportProgressArgs {
  project_slug: string
  topic_id: string
  event: {
    type: 'import_progress'
    job_id: string
    status:
      | 'queued'
      | 'pass1-running'
      | 'pass2-running'
      | 'rate_limit_cooling_off'
      | 'rate_limit_paused'
      | 'completed'
      | 'failed'
      | 'cancelled'
    pass: 1 | 2
    pct: number
    /**
     * 2026-05-22 — pre-count fix follow-up to PR #264. Disambiguates
     * "stable denominator, render N/M" from "still streaming, render
     * count-only". Mirrors `ImportJob.chunks_total_known` end-to-end:
     * runner row → engine envelope → gateway route → server WS frame →
     * client bubble.
     */
    chunks_total_known: boolean
    body?: string
  }
}

export function buildRoutedSendImportProgress(
  opts: BuildRoutedSendImportProgressOptions,
): (input: SendImportProgressArgs) => Promise<{ delivered: boolean }> {
  return async ({ project_slug, topic_id, event }) => {
    if (topic_id.startsWith('web:')) {
      const ok = opts.webRegistry.send(topic_id, event)
      // Light-touch observability — no body content, just shape +
      // delivery boolean. Surfaces in journalctl as
      // `[chat-bridge] sendImportProgress event=route ...`.
      console.info(
        `[chat-bridge] sendImportProgress event=route channel=web project=${project_slug} topic=${topic_id} job=${event.job_id} status=${event.status} pass=${event.pass} pct=${event.pct.toFixed(2)} known=${event.chunks_total_known} delivered=${ok}`,
      )
      return { delivered: ok }
    }
    // Onboarding consolidation (2026-06-26) — app-socket route.
    if (topic_id.startsWith('app:') && opts.appSocketRouter?.send !== undefined) {
      return await opts.appSocketRouter.send({ project_slug, topic_id, event })
    }
    // Telegram + unknown channels: silent drop. The terminal-state
    // agent_message still lands on these channels via the regular
    // `sendButtonPrompt` path.
    if (!topic_id.startsWith('tg:') && !topic_id.startsWith('app:')) {
      console.warn(
        `[chat-bridge] sendImportProgress event=drop reason=unknown-channel project=${project_slug} topic=${topic_id} job=${event.job_id}`,
      )
    }
    return { delivered: false }
  }
}

export function buildRoutedSendButtonPrompt(
  opts: BuildRoutedSendButtonPromptOptions,
): SendButtonPromptFn {
  return async ({ project_slug, topic_id, prompt }) => {
    if (topic_id.startsWith('web:')) {
      // NOTE (D3, 2026-07) — the web route intentionally renders WITHOUT the
      // optional `topic_id` stamp, preserving the exact pre-split behavior
      // (chat-bridge.ts:414 on origin/main called `renderButtonPromptForWeb(prompt)`
      // single-arg). An independent Codex pass flagged that a web-routed
      // envelope therefore carries `topic_id === undefined`, which would let
      // the per-topic client drop-guard misroute if a web session ever
      // multiplexed topics. Stamping it (`renderButtonPromptForWeb(prompt, topic_id)`)
      // is a WIRE-FORMAT behavior change — deferred to a behavior unit with its
      // own cross-channel parity verification, NOT folded into this pure
      // structural split.
      const ok = opts.webRegistry.send(topic_id, renderButtonPromptForWeb(prompt))
      // T10 — observability for the welcome-emit chain. `delivered=false`
      // is the smoking-gun trace for the "engine emitted but registry had
      // no sender" silent-drop scenario (T10 bug class).
      //
      // T10 r4 (Codex P1, 2026-05-15) — body bytes MUST NOT enter logs.
      // The prior excerpt-style field leaked user-derived content because
      // re-emit branches (e.g. reEmitImportOfferedPaste) echo the user's
      // pasted text into `prompt.body`. Operators only need a content-
      // free fingerprint to correlate "is this the static fallback vs.
      // an LLM-rephrased body" across log lines; `body_sha8` (first 8
      // hex of sha256) is deterministic, content-free, and matches the
      // static spec's hash exactly when the fallback fires. `body_len`
      // is included as a cheap secondary signal (length variance also
      // distinguishes static vs LLM-rephrased without leaking bytes).
      const body_sha8 = createHash('sha256').update(prompt.body).digest('hex').slice(0, 8)
      console.info(
        `[chat-bridge] sendButtonPrompt event=route channel=web project=${project_slug} topic=${topic_id} prompt=${prompt.prompt_id} options=${prompt.options.length} delivered=${ok} body_len=${prompt.body.length} body_sha8=${body_sha8}`,
      )
      return { message_id: prompt.prompt_id, was_new: ok }
    }
    if (topic_id.startsWith('tg:') && opts.telegramSender !== undefined) {
      return await opts.telegramSender({ project_slug, topic_id, prompt })
    }
    // Onboarding consolidation (2026-06-26) — app-socket route. Onboarding
    // prompts addressed to `app:<user_id>` fan out over the unified
    // `/ws/app/chat` socket via the composer-supplied holder. The holder
    // translates the ButtonPrompt → the app-ws `agent_message` envelope (which
    // already carries options/prompt_id/allow_freeform/kind/upload_affordance).
    if (topic_id.startsWith('app:') && opts.appSocketRouter?.send !== undefined) {
      return await opts.appSocketRouter.send({ project_slug, topic_id, prompt })
    }
    // No sender for this topic_id. Surface explicitly so a misrouted
    // prefix (Telegram instance on a web-only deploy, or a future
    // app-socket prefix not wired here) doesn't silently drop the
    // emit. The engine treats was_new=false as "delivered, no need
    // to re-send" which is misleading when there's nothing on the
    // far side — this log line gives the operator a foothold.
    console.warn(
      `[chat-bridge] sendButtonPrompt event=drop reason=unknown-channel-or-no-sender project=${project_slug} topic=${topic_id} prompt=${prompt.prompt_id}`,
    )
    return { message_id: prompt.prompt_id, was_new: false }
  }
}
