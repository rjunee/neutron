/**
 * @neutronai/gateway/http — production ChatBridge factory + sender registry.
 *
 * Sprint 18 — per-instance gateway HTTP route composition.
 *
 * `landing/server.ts:createLandingServer` accepts a `ChatBridge` interface
 * for the `/chat` GET + `/ws/chat` upgrade path. P2 S2 shipped a mock
 * bridge for the unit tests; this module ships the production bridge that
 * wires through the locked primitives:
 *
 *   - `signup/start-token.ts:verifyStartToken` — JWT signature + aud + exp.
 *   - `signup/start-token.ts:claimStartTokenJti` — atomic single-use claim
 *     (per Codex r1 P2 from Sprint 13: split verify/claim so a transient
 *     bootstrap failure doesn't burn the token).
 *   - `onboarding/interview/engine.ts:InterviewEngine.start/advance` — the
 *     state-machine entry points.
 *
 * The engine's `SendButtonPromptFn` is channel-agnostic — it routes by
 * `topic_id` prefix:
 *   - `web:<user_id>` → WebChatSenderRegistry (this module)
 *   - `tg:<chat_id>:<thread_id>` → caller-supplied telegram sender
 *
 * Per-session sender threading: the WebChatSenderRegistry holds a Map of
 * topic_id → ws-bound `send` callback. `startSession` registers; the
 * engine's emit then looks up the sender and writes the converted
 * `ChatOutbound` envelope back through the live socket. `handleInbound`
 * re-registers on every inbound so reconnects with a fresh socket route
 * correctly (the cookie-less `?start=<token>` re-validate path on the
 * landing server already drives this — see Codex r5 P2 + landing/server
 * Sprint 13 commit body).
 *
 * Cross-instance safety: `validateStartToken` rejects tokens whose embedded
 * `project_slug` does not match the booted gateway's slug. A token minted
 * for instance A cannot drive an onboarding session against instance B's
 * gateway even if Caddy mis-routes the host header (defense-in-depth —
 * the per-instance systemd unit already pins the slug via
 * `NEUTRON_INSTANCE_SLUG`).
 */

import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import type { KeyLike } from 'jose'
import type { ChatBridge, ChatOutbound, PendingChatClaim } from '../../landing/server.ts'
import { drainRecoveredReplies } from './recovered-reply-store.ts'
// Sprint B (2026-05-20) — start-token verify + JTI claim flow is
// dependency-injected from the platform adapter now. The interface
// types live in `runtime/start-token-types.ts`; the concrete Managed
// implementations stay in `signup/start-token.ts` and are wired through
// the boot shell. Open self-hosted boxes pass `undefined` and the WS
// upgrade rejects every start-token attempt as `verify-failed`.
import type {
  ConsumedTokensStore,
  VerifyStartTokenFn,
  ClaimStartTokenJtiFn,
} from '../../runtime/start-token-types.ts'
import type {
  AdvanceInput,
  InterviewEngine,
  SendButtonPromptFn,
  SlugPickerEngineHook,
} from '../../onboarding/interview/engine.ts'
import type {
  ButtonChoice,
  ButtonPrompt,
  ChannelKindForButton,
} from '../../channels/button-primitive.ts'
// BUG #310 fix (2026-06-19) — value import so the project-topic stub path
// can PERSIST its turns to `button_prompts` (resolve the prior row with the
// user's text + emit the stub reply as a new row), reusing the exact pattern
// build-live-agent-turn uses for live-agent replies.
import { buildButtonPrompt } from '../../channels/button-primitive.ts'
import type { SlugPickerOutcome } from '../../runtime/slug-picker-types.ts'
// Sprint B (2026-05-20) — `PendingRedirectStore` lifted to runtime/ so
// chat-bridge holds the structural type with no edge into the Managed
// provisioning layer. The Managed `SqlitePendingRedirectStore`
// structurally satisfies it.
import {
  type PendingRedirectStore,
  PENDING_REDIRECT_TTL_MS,
} from '../../runtime/pending-redirect-types.ts'
// Sprint B (2026-05-20) — rename orchestrator + driver types lifted
// to `runtime/platform-adapter.ts`. The Managed concrete
// `RenameOrchestratorDeps` structurally satisfies the alias.
import type {
  GatewayRestartDriver,
  RenameOrchestratorDeps,
} from '../../runtime/platform-adapter.ts'
import { ownerSlugMismatch } from './auth-helpers.ts'
// 2026-06-05 (click-button) — the pre-redirect TLS-readiness gate
// (`gateway/http/tls-readiness.ts`, `tlsReadinessProbe` hook option) was
// DELETED. It existed to suppress an instant auto-navigate toward a
// not-yet-TLS-ready host; the click-button model renders an "Open your
// agent →" button (the human click delay covers route + TLS readiness),
// so there is no SSL-error window to suppress and the probe had zero live
// consumers post-refactor. See docs/plans/slug-rename-click-button-2026-06-05.md.
// PR #331 Argus r4 BLOCKER (2026-05-29) — gateway-level reject of
// router-internal sentinels (`__freeform__`, `__timeout__`) on the
// inbound `button_choice` WS event. Defined once at the adapter so
// the same set protects both the structured-envelope parser
// (`parseAppSocketButtonChoice`) and the live WS path here. Killing
// the class at the gateway boundary is cleaner than adding a new
// engine-level guard for every adjacent variant Codex/Argus surfaces
// (r2 unknown-value, r3 empty-payload, r4 unroutable-text — each
// landed a new patch on the same lockout shape). Legit typed text
// goes via `user_message → freeform_text` (engine.ts:5504 freeform
// path, bypasses `buttonStore.resolve()`); no legit caller sends
// `__freeform__` on an inbound `button_choice` event.
import { FORBIDDEN_INBOUND_VALUES } from '../../channels/adapters/app-socket/render-button-prompt.ts'
// ISSUES #69 Argus r1 MINOR 2 (2026-05-30) — single source of truth for
// the `[B] Skip for now` button value emitted by the onboarding-handoff
// no-match fallback. Imported here so the special-case suppression
// branch in `handleProjectTopicInbound` can never drift from the
// composer that writes the value onto the prompt row.
import { ONBOARDING_HANDOFF_SKIP_FOR_NOW_VALUE } from '../realmode-composer/build-onboarding-handoff.ts'
// Connect group-chat engagement mode (spec: connect-agent-engagement-mode-2026-06-26).
// The routing gate + mention detector + inline/delegate classifier are pure and
// live in connect/; the bridge reads the per-project mode and applies the gate
// at the project-topic agent-turn trigger (the live ingress seam, §1.5).
import {
  DEFAULT_AGENT_ENGAGEMENT_MODE,
  classifyTaggedIntent,
  resolveEngagement,
  type AgentEngagementMode,
} from '../../connect/agent-engagement.ts'

/**
 * T10 (2026-05-14) — structured-log tag for the WS upgrade chain.
 *
 * journalctl picks up `console.info` from the per-instance systemd unit by
 * default. The brief's diagnostic gap on prod was "ZERO request logs
 * post-boot": the chat-bridge had no observability at the WS upgrade
 * boundary, so a fresh-instance repro had no actionable trace. Every log
 * line in this file uses this prefix + a JSON-shaped body so an operator
 * can grep the unit journal for `[chat-bridge]` lines
 * and read the WS lifecycle line by line.
 *
 * Fields shape (all optional, included when known):
 *   instance=<slug> topic=<topic_id> jti=<jti> user=<user_id> event=<stage>
 *   delivered=<bool> outcome=<string> err=<string>
 *
 * Why `console.info` (not `console.warn`): warn pollutes operator alerts
 * for the happy path. The per-request volume is one line per WS upgrade
 * + one per inbound message, low even at peak — no log-volume risk.
 *
 * Why ALL fields up-front instead of `console.info({...})`: journalctl's
 * native rendering is line-oriented; embedding key=value pairs in the
 * message string keeps `journalctl -f` outputs human-readable without an
 * extra JSON pretty-printer.
 */
const LOG_TAG = '[chat-bridge]'

/**
 * Per-session sender registry. Production wires the in-memory variant
 * (process-local; per-instance gateway is a single Bun process). A future
 * cross-process variant (Redis pub/sub etc.) can implement the same
 * interface — for now the per-instance boundary keeps the in-memory map
 * sufficient for the M2 cohort scale (single-digit concurrent web
 * sessions per instance).
 */
export interface WebChatSenderRegistry {
  /** Register the per-session send callback for a topic_id. Replaces any
   *  existing registration so reconnect on the same topic_id wins. */
  register(topic_id: string, send: (event: ChatOutbound) => void): void
  /**
   * Identity-aware unregister: only delete the entry when the currently
   * registered sender is reference-equal to `send`. This prevents a
   * losing-tap's catch path or an old socket's close-fire from
   * accidentally deleting a newer registration's sender (Argus
   * Sprint 18 r1 BLOCKING: reconnect / concurrent-tap race).
   */
  unregister(topic_id: string, send: (event: ChatOutbound) => void): void
  /** Returns true when a sender was found and called; false otherwise. */
  send(topic_id: string, event: ChatOutbound): boolean
  /**
   * Trident 6 (2026-05-13) — non-destructive deliverability precheck.
   * Used by the resume-on-reconnect cron to skip a row when the
   * instance's WS is currently offline (no live sender for the topic_id).
   * Returns true iff `send(topic_id, ...)` would deliver right now.
   */
  has(topic_id: string): boolean
}

export class InMemoryWebChatSenderRegistry implements WebChatSenderRegistry {
  private readonly senders = new Map<string, (event: ChatOutbound) => void>()

  register(topic_id: string, send: (event: ChatOutbound) => void): void {
    this.senders.set(topic_id, send)
  }

  unregister(topic_id: string, send: (event: ChatOutbound) => void): void {
    // Compare-and-delete: only erase the entry when it still points at
    // the sender being torn down. A no-op when a newer register has
    // already replaced the entry — that newer socket gets to keep its
    // routing.
    if (this.senders.get(topic_id) === send) {
      this.senders.delete(topic_id)
    }
  }

  send(topic_id: string, event: ChatOutbound): boolean {
    const sender = this.senders.get(topic_id)
    if (sender === undefined) return false
    // T10 — sender throws (e.g. landing-server's per-socket lambda on a
    // closed WS) propagate UP through `sendButtonPrompt` so every emit
    // path's existing try/catch converts to `InterviewError('send_failed')`
    // and the bridge tears down with a 4001. Codex review r1 P1 rationale:
    // catching here would silently downgrade closed-socket failures to
    // `was_new=false` for ALL prompt paths (reuseActivePrompt,
    // emitResumePrompt, advance-time phase emits), but only
    // `InterviewEngine.start()` inspects `was_new` to gate `markDelivered`.
    // Throwing instead lets the existing engine-side error handling work
    // uniformly: every sendButtonPrompt call site is already wrapped in
    // the InterviewError shape, the row's `delivered_at` stays NULL,
    // and reconnect re-emit recovers the user.
    sender(event)
    return true
  }

  has(topic_id: string): boolean {
    return this.senders.has(topic_id)
  }
}

// `webTopicId` now lives in the dependency-free leaf `./web-topic-id.ts`
// (R5 / audit P1-2 — broke the chat-bridge ↔ build-onboarding-handoff
// cycle). Imported for internal use below and re-exported so existing
// `import { webTopicId } from '.../chat-bridge.ts'` callers are unchanged.
import { webTopicId } from './web-topic-id.ts'
export { webTopicId }

/**
 * ISSUE #41 — per-session "current chat project_id" tracker.
 *
 * The chat composer is per-instance (one engine per WS session, NOT
 * per-project), but inline-comment escalations from the docs UI are
 * per-project: a POST against
 * `/api/app/projects/<project_id>/docs/comments/<event_id>/escalate`
 * appends an `escalate_to_chat` event into THAT project's
 * `.comments/comments.db` sidecar. Before this registry the chat
 * composer's escalation-loader was hardcoded to read the `default`
 * project, so any escalation from a non-default project silently
 * disappeared on the next chat turn (UI returned 200; chat had no
 * awareness).
 *
 * The escalate POST handler in `gateway/http/app-docs-surface.ts`
 * calls `setActive(user_id, project_id)` after successfully appending
 * the event. The chat composer's per-turn LLM wrapper invokes the
 * closure built around `getActive(user_id)` so the next chat turn
 * reads pending escalations from the SAME project the user just
 * escalated from. Falls back to `default` when the user has not yet
 * escalated anything in this gateway-process lifetime — same string
 * the pre-#41 hardcode used, so regression-free behaviour for
 * single-project owners is byte-identical.
 *
 * Lifetime: per-instance in-memory map. A gateway restart loses the
 * pointer; the next escalation re-pins it. Acceptable because a) the
 * pre-fix behaviour was a hardcoded `default` constant (no durable
 * non-default state ever existed) and b) escalations are user-driven
 * — the next click re-pins.
 */
export interface WebChatSessionProjectRegistry {
  /**
   * Pin the user's current chat-side project to `project_id`. Called by
   * the docs escalate handler after a successful `escalate_to_chat`
   * event append.
   */
  setActive(user_id: string, project_id: string): void
  /**
   * Returns the currently pinned project_id for this user, or null if
   * the user has not yet escalated anything in this gateway-process
   * lifetime. The chat composer's resolver falls back to `'default'`
   * on a null return.
   */
  getActive(user_id: string): string | null
}

export class InMemoryWebChatSessionProjectRegistry
  implements WebChatSessionProjectRegistry
{
  private readonly active = new Map<string, string>()

  setActive(user_id: string, project_id: string): void {
    this.active.set(user_id, project_id)
  }

  getActive(user_id: string): string | null {
    return this.active.get(user_id) ?? null
  }
}

/**
 * ISSUES #204 — one live-agent chat turn, as the bridge sees it. The
 * runner (`gateway/realmode-composer/build-live-agent-turn.ts`) loads the
 * owner persona, dispatches the warm per-(instance, topic) CC session over
 * the substrate, streams the reply onto `send`, and persists it as a
 * `button_prompts` row. The bridge type is structural so the http layer
 * never takes a static realmode-composer import edge.
 */
export interface LiveAgentTurnRequest {
  project_slug: string
  user_id: string
  /** Wire topic the turn belongs to (`web:<uid>` or `web:<uid>:<project>`). */
  topic_id: string
  /** Set for project topics — parsed from the `web:<uid>:<project>` id. */
  project_id?: string
  user_text: string
  send: (event: ChatOutbound) => void
  observed_at: number
}

export type LiveAgentTurnRunner = (input: LiveAgentTurnRequest) => Promise<unknown>

/**
 * ISSUES #204 — failure bubble for the defensive bridge-side catch. The
 * runner ships its own (richer) failure copy; this only fires if the
 * runner itself throws, which production wiring never does.
 */
const LIVE_AGENT_BRIDGE_FAILURE_BODY =
  'I hit a problem answering that. Give it another try in a moment.'

/**
 * ISSUES #204 — resolve whether this (instance, user) is in live-agent
 * territory: onboarding `phase==completed`. Read-only `stateStore.get`; any
 * failure logs + returns false so the engine path (pre-#204 behaviour) stays
 * the fallback.
 *
 * 2026-06-20 GO-LIVE P0 (owner live-dogfood) — a TYPED message at
 * `phase==completed` is a LIVE CHAT TURN on EVERY topic, General included.
 * The prior model gated General (but NOT project topics) behind
 * `final_handoff_active !== true` so the wow handoff prompt could consume
 * typed keyword replies ("skip"/"telegram"). But an owner who finishes
 * onboarding and never taps the handoff "Done" leaves `final_handoff_active`
 * stuck `true` FOREVER — so every typed General message fell through to the
 * engine's `noop_terminal` and the General topic went DEAD (silent), while
 * project topics (which never respected the flag) worked. The flag-respect
 * was removed: General now mirrors project topics exactly. The wow buttons
 * still work — a `button_choice` TAP bypasses this `user_message` gate and
 * routes to `handleFinalHandoffOnCompleted` unchanged; only TYPED replies
 * now reach the live agent instead of the keyword router.
 */
async function isLiveAgentEligible(input: {
  stateStore: import('../../onboarding/interview/state-store.ts').OnboardingStateStore
  project_slug: string
  user_id: string
  log_tag: string
}): Promise<boolean> {
  try {
    const state = await input.stateStore.get(input.project_slug, input.user_id)
    if (state === null || state.phase !== 'completed') return false
    return true
  } catch (err) {
    console.warn(
      `${input.log_tag} isLiveAgentEligible event=state_read_failed project=${input.project_slug} user=${input.user_id} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return false
  }
}

/**
 * ISSUES #115 — emit a typing bracket envelope (`agent_typing_start` /
 * `agent_typing_end`) on a turn boundary, swallowing send errors.
 *
 * These envelopes are the SERVER-AUTHORITATIVE turn-active signal that
 * makes the landing typing indicator deterministic. The prior model was
 * client-optimistic only — the dots fired on a visible user send and
 * cleared on the first `agent_message`. That missed turns the user did
 * NOT trigger with a send (proactively-emitted phase prompts) and went
 * dark between messages on multi-`agent_message` turns, so the indicator
 * was INTERMITTENT (Sam, live signup). Bracketing every `engine.advance`
 * / `engine.start` with start/end guarantees the indicator on EVERY turn,
 * from turn-start until the reply renders.
 *
 * `send` throws when the socket has closed (landing/server.ts rejects a
 * write to a dead WS). A typing-indicator emit must NEVER abort the turn
 * it brackets, so a failure is logged and dropped — the client still
 * re-derives liveness from the optimistic on-send dots + the next
 * `agent_message`. The end-bracket runs in a `finally` so it always
 * pairs with its start, on both the success AND throw paths (the client
 * ref-counts starts vs ends, per landing/server.ts AgentTypingEndOutbound).
 */
function emitTypingBracket(
  send: (event: ChatOutbound) => void,
  type: 'agent_typing_start' | 'agent_typing_end',
  log_tag: string,
): void {
  try {
    send({ type })
  } catch (err) {
    console.warn(
      `${log_tag} emitTypingBracket event=send_failed type=${type} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

/**
 * Convert a channel-agnostic ButtonPrompt into the locked web envelope
 * (Sprint 16 P2 S5 § 2.5). Adapters that emit on /ws/chat use this
 * shape so the cross-channel parity test stays satisfied:
 *
 *   { v:1, type:'agent_message', body, prompt_id?, options[]?, allow_freeform? }
 *
 * The landing client (`landing/chat.ts`) parses `type:'agent_message'`
 * + `options` to render the keyboard locally.
 */
export function renderButtonPromptForWeb(prompt: ButtonPrompt, topic_id?: string): ChatOutbound {
  // Sprint 28 Codex r4 P1 — propagate `kind` + per-option `image_url`
  // so the image-gallery picker actually renders thumbnails on the
  // web client. Pre-Sprint-28 prompts have neither field set; the
  // ChatOutbound contract treats both as optional.
  //
  // P2 v2 § 6.2 (S4) — propagate the `upload_affordance` metadata bag
  // so the web client renders a file-picker + drag-drop overlay for
  // the `import_upload_pending` phase. Adapters that don't understand
  // the field (Telegram) skip it.
  const out: ChatOutbound = {
    type: 'agent_message',
    body: prompt.body,
    prompt_id: prompt.prompt_id,
    options: prompt.options.map((o) => {
      const opt: { label: string; body: string; value: string; image_url?: string } = {
        label: o.label,
        body: o.body,
        value: o.value,
      }
      if (o.image_url !== undefined) opt.image_url = o.image_url
      return opt
    }),
    allow_freeform: prompt.allow_freeform,
  }
  if (prompt.kind !== undefined) out.kind = prompt.kind
  const upload = normalizeUploadAffordance(prompt.metadata?.['upload_affordance'])
  if (upload !== null) {
    out.upload_affordance = upload
  }
  // P1a — stamp the owning topic so the per-topic client drop-guard routes this
  // prompt to ITS topic, not whatever is focused (notification misrouting).
  if (topic_id !== undefined) out.topic_id = topic_id
  return out
}

/**
 * Coerce a stored `upload_affordance` metadata bag into the narrowed
 * wire shape. Returns null for anything that doesn't carry a recognised
 * source.
 *
 * remove-both-import-option (2026-06-06, Codex r1): a prompt EMITTED
 * before this deploy in the (removed) two-upload 'both' flow persisted
 * `{source:'both'}`. On a post-deploy reconnect the gateway REPLAYS that
 * stored envelope verbatim via `reEmitActiveSeedPromptIfAny`. Dropping
 * the affordance for a stale 'both' would hide the upload bar while the
 * body still asks for a ZIP — a deploy-window dead-end. Instead we
 * NORMALIZE legacy 'both' to 'chatgpt' (the exact single-source fallback
 * the rebuild path `buildImportUploadPendingPromptSpec` uses for a stale
 * 'both'), so the user keeps a working upload affordance. The next engine
 * turn rebuilds the prompt fresh against the narrowed source.
 */
function normalizeUploadAffordance(
  value: unknown,
): { source: 'chatgpt' | 'claude' } | null {
  if (typeof value !== 'object' || value === null) return null
  const src = (value as { source?: unknown }).source
  if (src === 'chatgpt' || src === 'claude') return { source: src }
  if (src === 'both') return { source: 'chatgpt' }
  return null
}

/**
 * 2026-05-13 — no-restart slug rename: render the agent confirmation
 * message that lands on the live WS the moment the rename commits at
 * the registry / Caddy / identity layers. Replaces the prior
 * `RedirectOutbound` envelope (which forced a `window.location.replace`
 * + new WS connect, which in turn required the per-instance gateway to
 * be `systemctl restart`-ed mid-rename). The new flow keeps the user
 * on the entry URL — the conversation flows directly into the next
 * onboarding phase on the same socket.
 *
 * The body is intentionally chatty (vs. a typed envelope) because the
 * rename is now a side-channel event the user is being informed about,
 * not an action they need to react to. The new URL is included as a
 * bookmarkable hint only.
 */
export function renderSlugRenameConfirmationForWeb(input: {
  new_slug: string
  base_domain: string
  topic_id?: string
}): ChatOutbound {
  const out: ChatOutbound = {
    type: 'agent_message',
    body: `Your URL is set to https://${input.new_slug}.${input.base_domain}/chat — bookmark it for next time. I'll continue our conversation right here.`,
  }
  // P1a — stamp the owning topic so the courtesy notice routes to its topic.
  if (input.topic_id !== undefined) out.topic_id = input.topic_id
  return out
}

/**
 * Narrow registry interface used by the JWT validator (Change 3 — accept
 * a new-slug JWT against a gateway whose `expected_project_slug` is still
 * the OLD slug, by looking up the registry's CURRENT `url_slug` for the
 * frozen `internal_handle` and accepting iff the claim matches it).
 *
 * Implemented by `buildOwnerRegistryLookupFromRegistry(ownersRegistry)`
 * against a `OwnersRegistry`; tests can pass an in-memory stub.
 */
export interface OwnerRegistryLookup {
  /**
   * Returns the CURRENT `url_slug` for the given `internal_handle`, or
   * null when the instance row is missing. Hot-path: every JWT-mismatch
   * connect runs this once; backing store is a single indexed SQLite
   * SELECT.
   */
  getCurrentUrlSlugByInternalHandle(internal_handle: string): string | null
}

/**
 * Adapter from the platform instances registry to the narrow lookup
 * interface above. Keeps `chat-bridge.ts` decoupled from the full
 * registry surface (insert/update/etc.) so a test can pass a tiny
 * stub without instantiating the SQLite-backed registry.
 *
 * Sprint B (2026-05-20) — accepts a structural subset of
 * `OwnersRegistry` so this Open-classified module no longer takes
 * an import edge on the Managed registry concrete. The Managed
 * production `OwnersRegistry` structurally satisfies the parameter
 * shape; tests can pass an in-memory `{ getByInternalHandle: ... }`
 * stub.
 */
export function buildOwnerRegistryLookupFromRegistry(registry: {
  getByInternalHandle(
    internal_handle: string,
  ): { url_slug: string } | undefined
}): OwnerRegistryLookup {
  return {
    getCurrentUrlSlugByInternalHandle(internal_handle: string): string | null {
      const row = registry.getByInternalHandle(internal_handle)
      if (row === undefined) return null
      return row.url_slug
    },
  }
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
export interface BuildRoutedSendImportProgressOptions {
  webRegistry: WebChatSenderRegistry
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
    // Telegram + unknown channels: silent drop. The terminal-state
    // agent_message still lands on these channels via the regular
    // `sendButtonPrompt` path.
    if (!topic_id.startsWith('tg:')) {
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

/**
 * P1.5 § 1.5.5 — slug-history lookup for the JWT shim. Caches positive
 * matches in an LRU; on rename the renameUrlSlug orchestrator pushes a
 * cache-invalidate so the entry refreshes from the DB on next access.
 */
export interface SlugHistoryShimStore {
  /**
   * Returns the row matching (`old_slug`, `internal_handle`) when
   * present and non-expired, else null.
   */
  lookup(input: {
    old_slug: string
    internal_handle: string
    now_ms: number
  }): Promise<{ expires_at_ms: number } | null>
}

export class InMemorySlugHistoryCache implements SlugHistoryShimStore {
  private readonly cache = new Map<string, { expires_at_ms: number; cached_at_ms: number }>()
  private readonly inner: SlugHistoryShimStore
  private readonly ttl_ms: number
  private readonly now: () => number

  constructor(input: {
    inner: SlugHistoryShimStore
    /** Pull-style TTL fallback if push-invalidate misses. Default 5min. */
    ttl_ms?: number
    now?: () => number
  }) {
    this.inner = input.inner
    this.ttl_ms = input.ttl_ms ?? 5 * 60 * 1000
    this.now = input.now ?? ((): number => Date.now())
  }

  async lookup(input: {
    old_slug: string
    internal_handle: string
    now_ms: number
  }): Promise<{ expires_at_ms: number } | null> {
    const key = `${input.old_slug}::${input.internal_handle}`
    const cached = this.cache.get(key)
    if (cached !== undefined && this.now() - cached.cached_at_ms < this.ttl_ms) {
      if (cached.expires_at_ms >= input.now_ms) {
        return { expires_at_ms: cached.expires_at_ms }
      }
      // Expired during cache validity — drop.
      this.cache.delete(key)
      return null
    }
    const fresh = await this.inner.lookup(input)
    if (fresh !== null) {
      this.cache.set(key, {
        expires_at_ms: fresh.expires_at_ms,
        cached_at_ms: this.now(),
      })
    }
    return fresh
  }

  /** Push-style invalidate fired by the rename orchestrator. */
  invalidateInternalHandle(internal_handle: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.endsWith(`::${internal_handle}`)) {
        this.cache.delete(key)
      }
    }
  }

  invalidateAll(): void {
    this.cache.clear()
  }
}

/**
 * Adapter from the registry's SlugHistoryStore (sync, returns expires_at
 * in unix-seconds) to the shim's async expires_at_ms shape.
 */
export function buildSlugHistoryShimFromRegistry(input: {
  /** Function returning a slug_history row (sync, like SlugHistoryStore.lookup). */
  lookup: (
    old_slug: string,
    internal_handle: string,
  ) => { expires_at: number } | undefined
}): SlugHistoryShimStore {
  return {
    async lookup({ old_slug, internal_handle, now_ms }) {
      const row = input.lookup(old_slug, internal_handle)
      if (row === undefined) return null
      const expires_at_ms = row.expires_at * 1000
      if (expires_at_ms < now_ms) return null
      return { expires_at_ms }
    },
  }
}

export interface BuildWebChatBridgeOptions {
  /**
   * The booted gateway's instance slug. validateStartToken rejects tokens
   * whose embedded project_slug differs — defense-in-depth against a
   * mis-routed Caddy upstream. The per-instance systemd unit pins this
   * via `NEUTRON_INSTANCE_SLUG`; tests inject directly.
   */
  expected_project_slug: string
  /**
   * P1.5: the gateway's frozen internal_handle. When a JWT carries an
   * old `project_slug` (post-rename), the shim consults `slugHistoryStore`
   * to verify the old slug matches THIS instance's history (not someone
   * else's). Optional for back-compat — when omitted, no shim runs and
   * mismatched JWTs are rejected as before.
   */
  internal_handle?: string
  /**
   * P1.5 grace-window store for old-slug JWTs. When a token's
   * `project_slug` claim != `expected_project_slug`, the shim queries this
   * store. Match + non-expired → accept. Optional; omit to disable shim.
   */
  slugHistoryStore?: SlugHistoryShimStore
  /**
   * 2026-05-13 — no-restart slug rename. When the per-instance gateway
   * is renamed WITHOUT a `systemctl restart`, `expected_project_slug`
   * stays pinned at the OLD slug because the env block hasn't flipped.
   * Identity-service-minted JWTs for new logins, though, carry the NEW
   * slug (MembershipStore.renameOwnerSlug ran during the orchestrator
   * step). Without this lookup the gateway 401s every NEW-slug JWT it
   * receives until the next process bounce.
   *
   * When set, the validator consults this lookup BEFORE the
   * slug-history shim: if `verified.project_slug` matches the registry's
   * current `url_slug` for `internal_handle`, accept and return the
   * current slug as the downstream `project_slug`. Cross-instance safety
   * is enforced by the `internal_handle` precondition exactly like
   * the slug-history shim.
   *
   * Optional for back-compat — when omitted, validation behaves
   * exactly as before this change.
   */
  ownerRegistry?: OwnerRegistryLookup
  /**
   * Resolves the public key for a given JWT `kid`. Production wires
   * through the identity service's JWKS via
   * `JwksCache.resolveKey(kid)`; tests use an in-memory key map.
   */
  resolveKey: (kid: string) => Promise<KeyLike | null>
  consumedTokens: ConsumedTokensStore
  /**
   * Sprint B (2026-05-20) — start-token verifier function, threaded
   * from the platform adapter (`platform.verifyStartToken`) by the
   * production composer. The Managed implementation is
   * `signup/start-token.ts:verifyStartToken`; Open boxes pass
   * `undefined` and the WS upgrade rejects every `?start=` token with
   * `reason=start-token-auth-unwired`.
   *
   * C2 OSS-split (2026-06-10): INJECTION-ONLY. The Sprint-B lazy
   * dynamic-import fallback was deleted — a dynamic import is still an
   * open→managed edge. Callers that exercise start-token auth (the
   * Managed composer, integration tests, walk harnesses) must pre-bind
   * BOTH this and `claimStartTokenJti`; all-or-nothing, matching the
   * adapter's `start_token_verify` capability derivation.
   */
  verifyStartToken?: VerifyStartTokenFn
  /**
   * Sprint B (2026-05-20) — atomic JTI claim function, threaded from
   * the platform adapter (`platform.claimStartTokenJti`) by the
   * production composer. Pairs with `verifyStartToken`; Managed uses
   * `signup/start-token.ts:claimStartTokenJti`.
   *
   * C2: injection-only, same contract as `verifyStartToken`.
   */
  claimStartTokenJti?: ClaimStartTokenJtiFn
  engine: InterviewEngine
  registry: WebChatSenderRegistry
  /**
   * 2026-05-11 — pending-redirect store. When set, `startSession` checks
   * for a pending redirect at the connecting user's `topic_id` BEFORE
   * driving the engine's opening prompt. If a row is present + non-
   * expired, the bridge emits the `RedirectOutbound` envelope, drops
   * the row, and returns without calling `engine.start` (the user is
   * about to navigate to the new subdomain; there is no point bootstrap-
   * ping onboarding state on a session that's mid-redirect).
   *
   * Wired by the production composer (`build-landing-stack.ts`); tests
   * inject directly. Optional — when undefined, the bridge skips the
   * lookup and behaves exactly as before this sprint.
   */
  pendingRedirects?: PendingRedirectStore
  /**
   * 2026-05-28 sidebar sprint — per-instance button-prompt store. Used by
   * the project-topic inbound stub to resolve the active seed prompt
   * row on the user's first tap so the keyboard reflects the chosen
   * option. Optional — when omitted, project-topic taps still register
   * the sender but no resolve happens (the user sees their bubble but
   * the keyboard stays clickable). Production wires the same
   * `ButtonStore` instance that the engine emits through.
   */
  buttonStore?: import('../../channels/button-store.ts').ButtonStore
  /**
   * Scribe phase 1 (2026-06-06) — chat-time knowledge-extraction hook. When
   * set, the bridge fires it (fire-and-forget, non-blocking) AFTER a real
   * `user_message` advance completes, handing scribe the user's turn text so it
   * can extract entities/facts → GBrain. The hook MUST be non-blocking and
   * failure-safe (the production wiring is `(i) => scribe.handleUserTurn(i)`,
   * which returns void and swallows its own errors); the bridge ALSO guards the
   * call in try/catch so an extraction hiccup can never wedge the chat path.
   * Optional — when omitted (Open self-host without scribe wired, tests), the
   * turn proceeds exactly as before. Closes ISSUES #101 Gap 2: this is the
   * chat-time `writeEntity` trigger that previously did not exist.
   */
  scribeOnUserTurn?: (input: {
    project_slug: string
    user_id: string
    topic_id: string
    text: string
    observed_at: number
    /** Multi-author attribution (connect-spec §4.3). The owner's own web-chat
     *  turns are author #0; the field is uniform so a collaborator turn driving
     *  scribe through the same hook records its own author. */
    author?: { id: string; display: string }
  }) => void
  /**
   * ISSUES #204 (2026-06-11, post-onboarding spec § ITEM 1) — the
   * live-agent turn runner. When BOTH this and `onboardingStateStore`
   * are wired, a `user_message` whose onboarding row is
   * `phase==completed` with no pending final-handoff prompt
   * (`phase_state.final_handoff_active !== true`) routes HERE instead
   * of into `engine.advance()`'s terminal no-op — the engine stays a
   * pure onboarding machine and the bridge owns post-onboarding chat.
   * Project-topic user messages swap their hardcoded stub for the same
   * runner (with `project_id` parsed from the `web:<uid>:<project>`
   * topic id). Optional — when omitted (Open box without LLM creds,
   * legacy tests), every path behaves exactly as before this sprint.
   *
   * The runner owns its own failure messaging (it never throws in
   * production wiring — `build-live-agent-turn.ts` catches + ships a
   * failure bubble); the bridge still guards the call and ships a
   * fallback bubble on a throw so the user is NEVER met with the
   * pre-#204 silence.
   */
  liveAgentTurn?: LiveAgentTurnRunner
  /**
   * ISSUES #204 — onboarding-state reader for the live-agent phase
   * gate. Production threads the SAME store instance the engine
   * drives (`buildLandingStack` pieces); the bridge only ever calls
   * `get()`. Optional — without it the gate never fires.
   */
  onboardingStateStore?: import('../../onboarding/interview/state-store.ts').OnboardingStateStore
  /**
   * Substrate-lift S3 (#106) — replay-redelivery store. When set, a session
   * (re)connect drains any recovered replies a crash dropped for this user's
   * conversational channel (`web:<user_id>`) and re-emits them once (deduped on
   * `turn_id` by the store). One more producer on the EXISTING reconnect re-emit
   * path — no new cron, no new reconnect entry point. Optional — when omitted
   * (Open self-host / tests / the `=0` rollback where no recovered reply is ever
   * produced), the connect path behaves exactly as before. */
  recoveredReplyStore?: import('./recovered-reply-store.ts').RecoveredReplyStore
  /**
   * Parity gap #2 (Cores→Open) — pre-dispatch chat-command filter for the
   * single-owner web chat. Mirrors the Expo `createAppWsSurface`
   * (`gateway/http/app-ws-surface.ts:658-666`): when a typed message is a free-Core
   * slash command (`/cal`, `/email`, `/research`, `/remind`), the chained filter
   * claims it (`match()` returns non-null) and the bridge ships the Core's reply
   * as an `agent_message`, short-circuiting BOTH the live-agent turn and the
   * onboarding engine. When the filter returns null (plain prose, or no Core owns
   * the command) the message flows to the agent exactly as before. Optional —
   * omitted on LLM-less / Core-less boxes, where it is a pure no-op.
   */
  chatCommandFilter?: import('./app-ws-surface.ts').ChatCommandFilter
  /**
   * Connect group-chat engagement mode (spec §2). Resolves the per-project
   * `agent_engagement_mode` for a project-topic message (the `projects` row,
   * migration 0088). When wired, the bridge gates the project-topic agent-turn
   * trigger: `all_messages` (the default) forwards every post to the agent;
   * `tag_gated` forwards ONLY on an `@neutron` mention. The shared transcript
   * ALWAYS persists every message in both modes — only the agent-turn TRIGGER
   * is gated. Optional — when omitted, every project topic behaves as
   * `all_messages` (unchanged pre-feature behaviour).
   */
  resolveEngagementMode?: (project_id: string) => Promise<AgentEngagementMode>
  /**
   * Connect tag-to-delegate (spec §4). When wired AND a `tag_gated` project
   * topic receives an `@neutron`-tagged TASK (not a quick question), the bridge
   * hands it to this hook instead of answering inline — the hook dispatches a
   * background subagent (the gap#3 agent-dispatch family) that reports its
   * result back into the shared thread. Optional — when omitted, a tagged task
   * is answered inline on the shared session like any other engaged turn.
   */
  delegateDispatch?: (input: {
    project_id: string
    topic_id: string
    user_id: string
    task: string
    kind: 'research' | 'review' | 'adhoc'
  }) => Promise<void>
  /**
   * Override the agent handle/alias set used by the `tag_gated` mention
   * detector. Optional — defaults to the canonical handles in
   * `connect/agent-engagement.ts` (`@neutron` + the `@claude` courtesy alias).
   */
  agentHandles?: readonly string[]
  /** Inject for test determinism. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Build the production `ChatBridge` that `createLandingServer` consumes.
 * Idempotent on duplicate `startSession` calls (the engine's `start()`
 * dedups via the active prompt's idempotency key + the in-project
 * onboarding_state row).
 */
export function buildWebChatBridge(opts: BuildWebChatBridgeOptions): ChatBridge {
  const now = opts.now ?? ((): number => Date.now())
  // C2 OSS-split (2026-06-10) — injection-only start-token primitives.
  // The Sprint-B lazy dynamic-import fallback of signup/start-token.ts
  // was DELETED (a dynamic import is still an open→managed
  // edge; execution spec § 4 C2 — which is also why this comment names
  // the module WITHOUT the import-call form: the boundary gate is a
  // text scan and would count the literal as an edge). Managed wires both through the
  // platform adapter (the Managed realmode composer passes
  // them into buildManagedPlatformAdapter; build-landing-stack threads
  // platform.verifyStartToken / platform.claimStartTokenJti here). On
  // Open self-host neither is wired and start-token auth is simply
  // unreachable — validateStartToken rejects every token with
  // `reason=start-token-auth-unwired`.
  const verifier = opts.verifyStartToken
  const claimer = opts.claimStartTokenJti
  return {
    async validateStartToken({ start_token }): Promise<PendingChatClaim | null> {
      if (typeof start_token !== 'string' || start_token.length === 0) {
        // T10 — log the empty-token reject so prod surfaces "WS upgrade
        // requested but the URL was missing ?start=..." vs. "token was
        // present but bad". The two failure modes have different fixes
        // (client-side URL plumbing vs. JWT signing). With no log, both
        // collapse to 400 / 401 with no operator trace.
        console.info(
          `${LOG_TAG} validateStartToken event=reject reason=empty-token project=${opts.expected_project_slug}`,
        )
        return null
      }
      if (verifier === undefined || claimer === undefined) {
        // C2 — start-token auth is Managed-injected (both primitives or
        // none; the adapter capability `start_token_verify` makes the
        // same all-or-nothing call). Open self-host boxes land here for
        // any `?start=` token: reject with a distinct operator trace.
        console.info(
          `${LOG_TAG} validateStartToken event=reject reason=start-token-auth-unwired project=${opts.expected_project_slug}`,
        )
        return null
      }
      let verified
      try {
        verified = await verifier({
          token: start_token,
          resolveKey: opts.resolveKey,
          now,
        })
      } catch (err) {
        // T10 — log the verify failure shape so a regression in JWT
        // signing / JWKS publication / kid rotation surfaces in
        // journalctl without operator instrumentation. Previously this
        // catch was silent — every reject 401 with no trace.
        console.info(
          `${LOG_TAG} validateStartToken event=reject reason=verify-failed project=${opts.expected_project_slug} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        return null
      }
      // Default outbound `project_slug` for a matched JWT — always
      // collapses to `expected_project_slug`. Both shim paths
      // (slug-history below, ownerRegistry below) accept a JWT whose
      // embedded slug differs from `expected_project_slug`, but the
      // downstream value MUST remain the gateway's frozen-at-boot
      // identity so state stores keyed by project_slug (notably
      // SqliteOnboardingStateStore) keep reading and writing the same
      // row across the rename event. See the long-form rationale in the
      // Argus r3 BLOCKING #1 block below the `if` chain.
      const downstreamSlug = opts.expected_project_slug
      if (ownerSlugMismatch(verified.project_slug, opts.expected_project_slug)) {
        const internal_handle = opts.internal_handle
        // 2026-05-13 — no-restart slug rename: when the per-instance
        // gateway hasn't been restarted post-rename, `expected_project_slug`
        // is still the OLD slug. NEW-slug JWTs (minted by the identity
        // service after MembershipStore.renameOwnerSlug flipped the
        // user's row) would normally 401 here. Accept them when the
        // registry confirms the new slug IS the instance's current url_slug.
        // Cross-instance safety: gated on `internal_handle` match the same
        // way the slug-history shim is — a token bound to a different
        // instance whose slug happens to match a name in our registry
        // CANNOT pass because internal_handle is checked indirectly via
        // the registry row (we look up by handle, then compare slug).
        let acceptedViaRegistry = false
        if (internal_handle !== undefined && opts.ownerRegistry !== undefined) {
          try {
            const currentSlug = opts.ownerRegistry.getCurrentUrlSlugByInternalHandle(
              internal_handle,
            )
            if (currentSlug !== null && !ownerSlugMismatch(verified.project_slug, currentSlug)) {
              acceptedViaRegistry = true
              // Symmetric with slug-history shim above: when the gateway
              // has NOT restarted but the registry's url_slug has been
              // updated (post-rename), accept the NEW-slug JWT but
              // collapse to expected_project_slug for downstream
              // uniformity. SqliteOnboardingStateStore is still keyed on
              // expected_project_slug (the gateway's frozen-at-boot
              // identity); reading or writing under currentSlug here
              // would fork engine state and reset resume-on-reconnect.
              // The user is mid-onboarding on the OLD-slug row; the
              // NEW-slug JWT must continue to advance THAT row.
            }
          } catch {
            // Fail-closed on registry unreachable: fall through to
            // slug-history shim. Any future read can retry.
          }
        }
        if (!acceptedViaRegistry) {
          // P1.5 § 1.5.5 — slug-history shim.
          // The booted gateway's url_slug may have changed (rename) but
          // in-flight JWTs minted under the old slug should still work
          // during the grace window. Match the old slug against this
          // instance's slug_history; cross-instance safety is enforced by the
          // internal_handle precondition.
          const store = opts.slugHistoryStore
          if (internal_handle === undefined || store === undefined) {
            return null
          }
          try {
            const match = await store.lookup({
              old_slug: verified.project_slug,
              internal_handle,
              now_ms: now(),
            })
            if (match === null) return null
            if (match.expires_at_ms < now()) return null
          } catch {
            // Fail-closed on DB unreachable — rather reject the JWT than
            // accept under uncertainty.
            return null
          }
        }
      }
      if (verified.signup_via !== 'web') {
        // Telegram-typed tokens drive the /webhook/telegram path via
        // signup/telegram-start-handler.ts. Refuse them here so a
        // mis-clicked Telegram link cannot accidentally open a web
        // socket on the same instance.
        console.info(
          `${LOG_TAG} validateStartToken event=reject reason=wrong-channel project=${opts.expected_project_slug} jwt_signup_via=${verified.signup_via}`,
        )
        return null
      }
      console.info(
        `${LOG_TAG} validateStartToken event=accept project=${opts.expected_project_slug} jwt_project=${verified.project_slug} user=${verified.user_id} jti=${verified.jti}`,
      )
      // Argus r3 [BLOCKING #1] + 2026-05-13 no-restart blocker: emit
      // `expected_project_slug` in the claim, NOT `verified.project_slug`.
      // SqliteOnboardingStateStore keys onboarding rows by project_slug;
      // passing the JWT-embedded slug downstream would fork engine
      // state and reset the user to S1 on the next reconnect.
      //
      //   - slug-history path (old-slug JWT, gateway never restarted):
      //     collapse to expected_project_slug (the still-OLD env value)
      //     so future taps keep advancing the same row.
      //   - ownerRegistry path (new-slug JWT, gateway also never
      //     restarted): collapse to expected_project_slug (still the
      //     OLD value in-memory) for the SAME reason — the engine row
      //     was written under the OLD slug while the user was mid-
      //     onboarding; the NEW-slug JWT must continue to advance THAT
      //     row, not start a fresh one.
      //
      // The symmetry is intentional. Both shims accept a JWT whose
      // embedded slug ≠ expected_project_slug, but neither ever changes
      // the downstream state-store key — that's pinned to the gateway's
      // frozen-at-boot identity until the next process bounce.
      return {
        project_slug: downstreamSlug,
        user_id: verified.user_id,
        jti: verified.jti,
        expires_at_ms: verified.expires_at_ms,
      }
    },

    async startSession({ claim, send, active_topic_id, current_host, browser_timezone }): Promise<boolean> {
      // Codex P1 fix (Sprint 18 r1): order is bootstrap → claim, NOT
      // claim → bootstrap. The verify/claim split exists specifically
      // so a transient bootstrap failure (DB hiccup, transcript write
      // error, button-store race) does NOT burn the start-token. With
      // claim-first, a transient engine.start throw would leave the
      // user with a 401 on retry even though onboarding never actually
      // started. Mirrors the canonical pattern in
      // signup/telegram-start-handler.ts (peek → verify → bootstrap →
      // claim).
      // 2026-05-28 sidebar sprint — the engine's `topic_id` (for state-
      // keyed routing) is ALWAYS the General topic (`webTopicId(user_id)`)
      // because onboarding state is per-user, not per-project. The
      // OUTBOUND sender registration uses `active_topic_id` (defaults to
      // General) so engine emits route to whichever socket the user has
      // active — a user sitting on a project topic doesn't see a fresh
      // onboarding prompt land on the wire (the row still persists to
      // button_prompts so the sidebar's history fetch surfaces it when
      // they switch back to General).
      const topic_id = webTopicId(claim.user_id)
      const wire_topic_id = active_topic_id !== undefined ? active_topic_id : topic_id
      opts.registry.register(wire_topic_id, send)
      console.info(
        `${LOG_TAG} startSession event=open project=${claim.project_slug} topic=${topic_id} wire_topic=${wire_topic_id} user=${claim.user_id} jti=${claim.jti}`,
      )
      // 2026-05-11 — pending-redirect delivery. When the slug-picker
      // hook detected a WS-closed-during-rename condition on a prior
      // turn, it persisted a PendingRedirect row keyed on this topic_id.
      // Deliver it BEFORE bootstrapping onboarding state: the user is
      // about to navigate to the new subdomain via
      // `window.location.replace`, so there is no point starting the
      // engine on a session that will be killed in a few hundred ms.
      //
      // Argus r1 [IMPORTANT] (2026-05-11): use `takeAndClaim` so the
      // pending-redirect take AND the start-token jti claim run in ONE
      // SQLite transaction. The earlier `take()` + post-emit
      // `claimStartTokenJti` shape was racy — a duplicate reconnect
      // with the same start_token could fall through to engine.start
      // between the two steps (engine.start is idempotent so the impact
      // was cushioned, but the cleaner fix is to make the burn atomic).
      if (opts.pendingRedirects !== undefined) {
        let outcome: Awaited<
          ReturnType<typeof opts.pendingRedirects.takeAndClaim>
        > | null = null
        try {
          outcome = await opts.pendingRedirects.takeAndClaim({
            topic_id,
            now_ms: now(),
            jti: claim.jti,
            jti_expires_at_ms: claim.expires_at_ms,
            // 2026-06-05 (click-button, Argus #1 BLOCKER) — pass the host
            // this socket is connected to so takeAndClaim can apply the
            // destination-host self-redirect guard: a reconnect that
            // landed ON the slug-rename destination host (the PRIMARY
            // click path now that the row is persisted unconditionally)
            // must NOT re-emit the redirect to itself nor burn the
            // start-token — it returns `no_redirect` and we fall through
            // to engine.start below. Mirrors the HTTP 302 path's guard in
            // `gateway/index.ts:resolvePendingRedirect`. `undefined` on
            // legacy callers that can't resolve the host (guard no-ops).
            ...(current_host !== undefined ? { current_host } : {}),
          })
        } catch (err) {
          // Fail-open: a pending-redirect lookup failure must NOT
          // block a normal startSession. Log + fall through to the
          // original bootstrap path. Worst case we lose the silent-
          // strand recovery for this connect and the user re-tries.
          console.warn(
            `[chat-bridge] pendingRedirects.takeAndClaim threw for topic_id=${topic_id}:`,
            err instanceof Error ? err.message : err,
          )
        }
        if (outcome !== null) {
          if (outcome.kind === 'claimed') {
            send({
              type: 'redirect',
              new_url: outcome.redirect.target_url,
              new_start_token: outcome.redirect.new_start_token,
              project_slug: outcome.redirect.new_slug,
              reason: 'slug_renamed',
            })
            // The jti was burned inside takeAndClaim — the opening
            // prompt for the renamed instance will be emitted by the
            // engine on the FE's next WS connect (the FE redeems
            // `new_start_token` against the renamed gateway, which
            // fires startSession again with a fresh claim).
            return true
          }
          if (outcome.kind === 'replay') {
            // Concurrent reconnect won the jti claim. We must not
            // emit the redirect on this socket — the winning caller
            // either already shipped its redirect or bootstrapped
            // engine.start. Identity-aware unregister so the winner's
            // sender is not stomped by our earlier register.
            opts.registry.unregister(wire_topic_id, send)
            return false
          }
          // outcome.kind === 'no_redirect' → fall through to the
          // normal engine.start + claim flow below.
        }
      }
      console.info(
        `${LOG_TAG} startSession event=engine-start-invoking project=${claim.project_slug} topic=${topic_id} user=${claim.user_id}`,
      )
      const engineStartT0 = now()
      // ISSUES #115 — bracket the opening turn (engine.start emits the
      // first phase prompt) so the indicator is deterministic from the
      // very first turn, not just the on-open optimistic dots.
      emitTypingBracket(send, 'agent_typing_start', LOG_TAG)
      try {
        await opts.engine.start({
          project_slug: claim.project_slug,
          topic_id,
          user_id: claim.user_id,
          signup_via: 'web',
          // #306 (2026-06-19) — forward the auto-detected browser timezone
          // (from the `?tz=` WS-upgrade param) so the engine stamps it onto
          // `phase_state.timezone` and the interview never asks for it. The
          // engine re-validates; undefined when the client didn't send it.
          ...(browser_timezone !== undefined ? { timezone: browser_timezone } : {}),
        })
      } catch (err) {
        // engine.start failed (transient or fatal). Unregister the
        // sender + propagate. The jti is NOT yet consumed, so a retry
        // with the same start-token can run engine.start again
        // (start() is idempotent per Codex r3 P1 + r5 P2 + r9 P1 in
        // onboarding/interview/engine.ts). Identity-aware unregister
        // (Argus r1 BLOCKING) — pass `send` so a concurrent winner
        // that already re-registered keeps its routing.
        console.info(
          `${LOG_TAG} startSession event=engine-start-failed project=${claim.project_slug} topic=${topic_id} elapsed_ms=${now() - engineStartT0} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        opts.registry.unregister(topic_id, send)
        throw err
      } finally {
        // ISSUES #115 — always close the typing bracket, success or throw,
        // so the client's start/end ref-count never strands the dots on.
        emitTypingBracket(send, 'agent_typing_end', LOG_TAG)
      }
      console.info(
        `${LOG_TAG} startSession event=engine-start-ok project=${claim.project_slug} topic=${topic_id} elapsed_ms=${now() - engineStartT0}`,
      )
      // Bootstrap succeeded; now atomically claim the jti so concurrent
      // taps cannot double-fire engine.start under race.
      if (claimer === undefined) {
        // C2 — defensive: a PendingChatClaim can only come out of
        // validateStartToken, which already rejects when the injected
        // primitives are absent. A caller handing startSession a forged
        // claim without wiring the claimer gets a clean reject, not a
        // silent unclaimed-jti replay window.
        console.info(
          `${LOG_TAG} startSession event=reject reason=start-token-auth-unwired project=${claim.project_slug} topic=${topic_id}`,
        )
        opts.registry.unregister(topic_id, send)
        return false
      }
      try {
        await claimer({
          jti: claim.jti,
          expires_at_ms: claim.expires_at_ms,
          consumedTokens: opts.consumedTokens,
        })
      } catch (err) {
        // Replay / race — another tap (probably a duplicate browser tab)
        // beat this caller to the claim. The competing tap also ran
        // engine.start (idempotent — Codex r3 P1) and won the jti, so
        // the second startSession returns false to let the landing
        // server close this socket cleanly with code 4001. Identity-
        // aware unregister (Argus r1 BLOCKING) so the winner's sender
        // — which the loser briefly overwrote with `register` above —
        // is restored at the registry level: the winner's later
        // register from its own startSession or handleInbound wins,
        // and our unregister here is a no-op once that has happened.
        console.info(
          `${LOG_TAG} startSession event=jti-claim-replay project=${claim.project_slug} topic=${topic_id} jti=${claim.jti} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        opts.registry.unregister(topic_id, send)
        return false
      }
      console.info(
        `${LOG_TAG} startSession event=ok project=${claim.project_slug} topic=${topic_id} jti=${claim.jti}`,
      )
      // 2026-05-29 r2 BLOCKER fix — initial connect that lands on a
      // non-General `active_topic_id` (deep-link, persisted
      // localStorage pointer to a project topic, page reload mid-flow)
      // needs the project seed re-emitted to the wire. The engine's
      // own re-emit path at `engine.start` ships the General active
      // prompt; for project topics, that path drops the emit because
      // the engine's `topic_id` is General (no sender registered
      // there in this branch — the sender is at `wire_topic_id`).
      // The seed row already exists on the project topic from the
      // wow→completed transition; this hook lifts it onto the wire.
      // Best-effort: a re-emit failure does NOT roll back the engine
      // bootstrap or the jti claim.
      if (wire_topic_id !== topic_id) {
        await reEmitActiveSeedPromptIfAny({
          project_slug: claim.project_slug,
          user_id: claim.user_id,
          topic_id: wire_topic_id,
          buttonStore: opts.buttonStore,
          send,
          now: now(),
          log_tag: LOG_TAG,
        })
      }
      // S3 #106 — flush any recovered replies a crash dropped for this user's
      // conversational channel (`web:<user_id>`). One more producer on the
      // existing reconnect re-emit path; deduped on `turn_id` by the store.
      //
      // Argus r6 BLOCKER fix (Codex GPT-5 cross-model) — gate on
      // `wire_topic_id === topic_id`, symmetric with the
      // `reEmitActiveSeedPromptIfAny` guard above. The recovered rows are
      // keyed on the General conversational channel (`web:<user_id>` =
      // `topic_id`), but `send` is the raw closure registered for
      // `wire_topic_id` (chat-bridge.ts:980 — the socket's ACTIVE topic).
      // When a user crashes mid-General-turn then reconnects landing on a
      // PROJECT topic (`wire_topic_id !== topic_id`), pushing the General
      // reply through `send` would render it in the PROJECT chat AND
      // `markDelivered` it against General — cross-topic bleed + silent loss,
      // the exact bug class this PR exists to eliminate. Only flush when this
      // socket is actually rendering General; otherwise the rows stay
      // undelivered and drain on the user's next General-rendering reconnect.
      if (opts.recoveredReplyStore !== undefined && wire_topic_id === topic_id) {
        drainRecoveredReplies({
          topic_id,
          store: opts.recoveredReplyStore,
          send,
          now: () => now(),
          log_tag: LOG_TAG,
        })
      }
      return true
    },

    async resumeCookieSession({ project_slug, user_id, send, active_topic_id }): Promise<void> {
      // 2026-05-29 r2 BLOCKER fix (Codex catch) — cookie-only WS open
      // path. The landing server skips `startSession` entirely when
      // `pending_claim === null` because there's no jti to claim and no
      // welcome envelope to fire. But without registering the sender
      // AND re-emitting the active seed prompt, a refresh on a project
      // topic (`web:<user_id>:<proj>`) renders blank: the engine's
      // sender registry has no entry at the project topic and the
      // history hydration drops unresolved seed rows
      // (chat.ts:1195).
      //
      // Mirrors the post-claim hook in `startSession` (chat-bridge.ts
      // :1059) and the post-switch hook in `handleInbound`
      // `topic_switch` (chat-bridge.ts:1167). All three live-emit
      // paths now run the SAME `reEmitActiveSeedPromptIfAny` helper so
      // a single re-emit policy holds across every entry point.
      const topic_id = webTopicId(user_id)
      const wire_topic_id = active_topic_id !== undefined ? active_topic_id : topic_id
      opts.registry.register(wire_topic_id, send)
      console.info(
        `${LOG_TAG} resumeCookieSession event=open project=${project_slug} topic=${topic_id} wire_topic=${wire_topic_id} user=${user_id}`,
      )
      // Only project topics need the re-emit — General's engine state
      // is driven by inbound user events + engine emits land on the
      // sender we just registered. For project topics the seed row
      // exists in button_prompts but the engine never re-emits per-
      // project seeds.
      if (wire_topic_id !== topic_id) {
        await reEmitActiveSeedPromptIfAny({
          project_slug,
          user_id,
          topic_id: wire_topic_id,
          buttonStore: opts.buttonStore,
          send,
          now: now(),
          log_tag: LOG_TAG,
        })
      }
      // S3 #106 — flush recovered replies for this user's conversational channel
      // on the cookie-only reconnect path too (mirrors `startSession`).
      //
      // Argus r6 BLOCKER fix (Codex GPT-5 cross-model) — same `wire_topic_id
      // === topic_id` gate as `startSession`. `send` here is registered for
      // `wire_topic_id` (the socket's ACTIVE topic, line 1191), but the
      // recovered rows are keyed on General (`web:<user_id>` = `topic_id`). A
      // cookie-resume that lands on a PROJECT topic (`wire_topic_id !==
      // topic_id` — per this file's own header, the most common returning-user
      // entry) must NOT push the General reply through the project send nor
      // markDelivered it against General. Drain only when this socket renders
      // General; otherwise the rows wait for the next General-rendering resume.
      if (opts.recoveredReplyStore !== undefined && wire_topic_id === topic_id) {
        drainRecoveredReplies({
          topic_id,
          store: opts.recoveredReplyStore,
          send,
          now: () => now(),
          log_tag: LOG_TAG,
        })
      }
    },

    async closeSession({ user_id, send, active_topic_id }): Promise<void> {
      // Codex P2 fix (Sprint 18 r1): unregister the per-session sender
      // when the WebSocket closes. Without this, a long-lived instance
      // process accrues a stale `topic_id -> send` entry per past
      // signup; subsequent engine emits would still find a sender and
      // report `was_new=true` even though the client is gone, hiding
      // the disconnect from the engine's retry path.
      //
      // Argus Sprint 18 r1 BLOCKING — identity-aware so an old socket's
      // close fire after a newer reconnect already re-registered does
      // NOT delete the new sender. The landing server captures the
      // per-socket send lambda once in ws.data.send and reuses it for
      // the lifetime of the socket so the reference compares equal.
      //
      // 2026-05-28 sidebar sprint — unregister at the SAME `wire_topic_id`
      // we registered under in startSession so the project-topic
      // entry doesn't leak.
      const wire = active_topic_id !== undefined ? active_topic_id : webTopicId(user_id)
      opts.registry.unregister(wire, send)
    },

    async handleInbound({
      project_slug,
      user_id,
      event,
      send,
      active_topic_id,
      updateActiveTopicId,
      getActiveTopicId,
    }): Promise<void> {
      const topic_id = webTopicId(user_id)
      // 2026-05-28 sidebar sprint — engine-side `topic_id` stays at
      // General (state is per-user), but the OUTBOUND sender registers
      // at the active topic so engine emits land on whichever socket
      // the user has open. When `active_topic_id` is omitted (legacy
      // clients without the sidebar) we fall back to General — byte-
      // identical pre-sprint behaviour.
      const wire_topic_id = active_topic_id !== undefined ? active_topic_id : topic_id
      // 2026-05-29 in-place topic switch sprint — handle the inbound
      // `topic_switch` event BEFORE the sender re-register below so
      // the registry transition (old → new) is atomic on the bridge
      // side. The client's UX gates on the `topic_switched` ack so
      // the scroll-restoration step waits for this to land before
      // it tries to fetch history for the new topic.
      if (event.type === 'topic_switch') {
        const requested = typeof event.new_topic_id === 'string' ? event.new_topic_id : ''
        // Validate against the existing allowlist (same as
        // `validateActiveTopicId` in landing/server.ts): either General
        // exact OR a `web:<user_id>:<descendant>` shape. Anything else
        // is rejected with an error envelope. Defense-in-depth: the
        // client side also validates, but the server side is the
        // authority on cross-user scope.
        const valid =
          requested === topic_id ||
          requested.startsWith(`${topic_id}:`)
        if (!valid) {
          console.warn(
            `${LOG_TAG} handleInbound event=topic_switch_rejected project=${project_slug} user=${user_id} from=${wire_topic_id} to=${requested} reason=invalid_topic_id`,
          )
          send({
            type: 'error',
            message:
              'That topic is not yours to open. Refresh the chat surface and try again.',
            topic_id: wire_topic_id,
          })
          return
        }
        if (requested === wire_topic_id) {
          // No-op switch — client + server already agree. Send the ack
          // anyway so the client's pending-switch state machine
          // (waiting for the server's confirmation before scrolling)
          // doesn't dangle.
          send({ type: 'topic_switched', topic_id: requested })
          return
        }
        // Identity-aware re-bind: unregister at the OLD topic only if
        // our `send` lambda is the currently-registered sender there,
        // then register at the NEW topic. Mirrors the discipline used
        // by `closeSession` / Argus Sprint 18 r1.
        opts.registry.unregister(wire_topic_id, send)
        opts.registry.register(requested, send)
        if (updateActiveTopicId !== undefined) {
          updateActiveTopicId(requested)
        }
        console.info(
          `${LOG_TAG} handleInbound event=topic_switch_ok project=${project_slug} user=${user_id} from=${wire_topic_id} to=${requested}`,
        )
        // 2026-05-29 r2 BLOCKER fix — re-emit the active unresolved seed
        // prompt for the destination topic (if any) BEFORE the ack. The
        // engine never re-emits per-project seeds (engine state lives on
        // General), so without this hook a project topic with one
        // unresolved `onboarding_handoff_seed` row renders blank: the
        // hydration unresolved-skip drops it and there's no live
        // re-emission. Ships through the standard `agent_message`
        // envelope so the client's `renderAgent` path renders it with
        // its full keyboard; subsequent history fetches dedup on
        // `prompt_id`. Best-effort — a failure here MUST NOT block the
        // switch ack (the helper swallows all throws and logs).
        //
        // Order: emit BEFORE the ack so the client's WS handler
        // processes the active prompt while still in pendingTopicSwitch
        // (the prompt renders into the just-cleared #log), then the ack
        // resolves the switch Promise and the hydrate step runs.
        //
        // 2026-05-29 ISSUES #70 — thread `getActiveTopicId` so the
        // helper can detect a rapid double-switch (A → B) that lands
        // between the listHistoryByTopic + buttonStore.get awaits.
        // ws.data.active_topic_id is the live source-of-truth (mutated
        // by `updateActiveTopicId` BEFORE this await and again if a
        // second `topic_switch` reaches handleInbound), so reading it
        // mid-await reflects whether the user has moved on. The helper
        // drops the emit (logging event=seed_reemit_superseded) on
        // mismatch.
        await reEmitActiveSeedPromptIfAny({
          project_slug,
          user_id,
          topic_id: requested,
          buttonStore: opts.buttonStore,
          send,
          now: now(),
          log_tag: LOG_TAG,
          ...(getActiveTopicId !== undefined ? { getActiveTopicId } : {}),
        })
        send({ type: 'topic_switched', topic_id: requested })
        return
      }
      // Re-register every inbound so reconnects with a fresh socket
      // route correctly. The Map.set is O(1) and overwrites the stale
      // sender from a closed socket without leaking memory.
      opts.registry.register(wire_topic_id, send)
      const channel_kind: ChannelKindForButton = 'app-socket'
      const observed_at = now()
      // PR #331 Argus r4 BLOCKER (2026-05-29) — reject router-internal
      // sentinels (`__freeform__`, `__timeout__`) on inbound
      // `button_choice` BEFORE either downstream branch resolves the
      // prompt row. Placed at the gateway boundary (not engine-side)
      // so the protection applies uniformly across:
      //
      //   - the engine path at handleFinalHandoffOnCompleted (r2/r3
      //     engine guards remain as defense-in-depth)
      //   - the project-topic stub path at handleProjectTopicInbound
      //     which calls `buttonStore.resolve` directly
      //   - any future inbound consumer that adds a third resolve
      //     branch — the gateway boundary stays correct without a
      //     new patch
      //
      // Threat model: an app-socket client crafts
      // `{type:'button_choice', choice_value:'__freeform__',
      // freeform_text:'asdf'}` (or any unroutable text). Without this
      // guard the engine's r4 length-check passes, `resolve()` stamps
      // `resolved_at` on the prompt row, the freeform-routing fall-
      // through returns `noop_terminal`, and a subsequent legitimate
      // Mobile/Telegram/Skip retap sees `was_new=false` and silently
      // noops — user locked out for the prompt TTL.
      //
      // Legit typed text goes via `user_message → freeform_text`
      // (engine.ts:5504 path 2, bypasses `buttonStore.resolve()`).
      // No legit caller sends these sentinels on inbound
      // `button_choice` — the freeform reply path on a Telegram
      // callback sets `choice_value:'__freeform__'` synthetically
      // INSIDE the gateway (channels/button-routing.ts:130), not
      // from the client wire.
      if (event.type === 'button_choice' && FORBIDDEN_INBOUND_VALUES.has(event.choice_value)) {
        console.warn(
          `${LOG_TAG} handleInbound event=forbidden_inbound_sentinel project=${project_slug} topic=${wire_topic_id} user=${user_id} choice=${event.choice_value} prompt_id=${event.prompt_id}`,
        )
        send({
          type: 'error',
          message: 'That control isn’t a valid tap. Try typing your reply instead.',
          topic_id: wire_topic_id,
        })
        return
      }
      // Parity gap #2 (Cores→Open) — pre-dispatch chat-command filter. A typed
      // message that a free-Core claims (`/cal`, `/email`, `/research`, `/remind`)
      // is answered by the Core and short-circuits BOTH the project-topic branch
      // below AND the General-topic live-agent/engine path — exactly as the Expo
      // `createAppWsSurface` does (`app-ws-surface.ts:658-666`). Applies on every
      // topic: `channel_topic_id` is the wire topic the message arrived on, and
      // `project_id` is parsed from a `web:<uid>:<project>` topic so a per-project
      // `/cal` lands on the right project cache. Fire-and-fall-through on a null
      // match (plain prose, or no Core owns the slash). Guarded so a filter throw
      // never blocks the chat path — it degrades to the normal agent dispatch.
      if (event.type === 'user_message' && opts.chatCommandFilter !== undefined) {
        const command_project_id =
          wire_topic_id !== topic_id && wire_topic_id.startsWith(`${topic_id}:`)
            ? wire_topic_id.slice(topic_id.length + 1)
            : undefined
        let command_result: import('./app-ws-surface.ts').ChatCommandFilterResult | null =
          null
        try {
          command_result = await opts.chatCommandFilter.match({
            user_id,
            project_slug,
            channel_topic_id: wire_topic_id,
            body: event.body,
            ...(command_project_id !== undefined ? { project_id: command_project_id } : {}),
          })
        } catch (err) {
          console.warn(
            `${LOG_TAG} handleInbound event=chat_command_filter_threw project=${project_slug} topic=${wire_topic_id} err=${
              err instanceof Error ? err.message : String(err)
            }`,
          )
          command_result = null
        }
        if (command_result !== null) {
          console.info(
            `${LOG_TAG} handleInbound event=chat_command_routed project=${project_slug} topic=${wire_topic_id} user=${user_id} chars=${event.body.length}`,
          )
          try {
            send({ type: 'agent_message', body: command_result.text, topic_id: wire_topic_id })
          } catch {
            // dead socket — durable history + reconnect hydration cover it
          }
          // Chat-time knowledge: a Core command is still owner intent worth
          // extracting (same fire-and-forget contract as a normal turn).
          if (opts.scribeOnUserTurn !== undefined) {
            try {
              opts.scribeOnUserTurn({
                project_slug,
                user_id,
                topic_id: wire_topic_id,
                text: event.body,
                observed_at,
                author: { id: 'owner', display: 'owner' },
              })
            } catch (err) {
              console.warn(
                `${LOG_TAG} handleInbound event=scribe_hook_threw project=${project_slug} topic=${wire_topic_id} err=${
                  err instanceof Error ? err.message : String(err)
                }`,
              )
            }
          }
          return
        }
      }
      // 2026-05-28 sidebar sprint — project-topic inbound stub. When the
      // user is sitting on a per-project topic (`web:<user_id>:<proj>`)
      // we DO NOT route the inbound through the onboarding engine
      // (its state is per-user; a `button_choice` against a seed row
      // would mark the seed resolved without firing any project-side
      // handler). For the first sprint we resolve the active prompt
      // (so the user's tap renders as a resolved bubble) and emit a
      // stub acknowledgement so the chat surface doesn't go silent.
      // The real per-project agent comes in a follow-up sprint.
      if (wire_topic_id !== topic_id) {
        await handleProjectTopicInbound({
          project_slug,
          user_id,
          wire_topic_id,
          event,
          send,
          channel_kind,
          observed_at,
          ...(opts.buttonStore !== undefined ? { buttonStore: opts.buttonStore } : {}),
          // ISSUES #204 — the live-agent runner + state reader so a
          // completed-phase project-topic message gets a REAL agent
          // turn instead of the "coming online soon" stub.
          ...(opts.liveAgentTurn !== undefined ? { liveAgentTurn: opts.liveAgentTurn } : {}),
          ...(opts.onboardingStateStore !== undefined
            ? { onboardingStateStore: opts.onboardingStateStore }
            : {}),
          // Connect group-chat engagement gate (spec §2/§4) — per-project mode
          // reader + tag-to-delegate hook + handle override. All optional; when
          // unwired the project topic behaves as `all_messages` (unchanged).
          ...(opts.resolveEngagementMode !== undefined
            ? { resolveEngagementMode: opts.resolveEngagementMode }
            : {}),
          ...(opts.delegateDispatch !== undefined
            ? { delegateDispatch: opts.delegateDispatch }
            : {}),
          ...(opts.agentHandles !== undefined ? { agentHandles: opts.agentHandles } : {}),
          log_tag: LOG_TAG,
        })
        // Scribe phase 1 — a user message on a PROJECT topic is just as much
        // chat-time knowledge as one on General. The project-topic stub doesn't
        // run the onboarding engine, but the user's text still feeds extraction.
        // Fire-and-forget + guarded; same contract as the General-topic call.
        if (event.type === 'user_message' && opts.scribeOnUserTurn !== undefined) {
          try {
            opts.scribeOnUserTurn({
              project_slug,
              user_id,
              topic_id: wire_topic_id,
              text: event.body,
              observed_at,
              // Owner-native web-chat turn → author #0 (connect-spec §4.1).
              author: { id: 'owner', display: 'owner' },
            })
          } catch (err) {
            console.warn(
              `${LOG_TAG} handleInbound event=scribe_hook_threw project=${project_slug} topic=${wire_topic_id} err=${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          }
        }
        return
      }
      console.info(
        `${LOG_TAG} handleInbound event=recv project=${project_slug} topic=${topic_id} kind=${event.type}${
          event.type === 'button_choice' ? ` choice=${event.choice_value}` : ''
        }`,
      )
      if (event.type === 'user_message') {
        // ISSUES #204 (post-onboarding spec § ITEM 1) — live-agent gate.
        // BEFORE the engine: a completed-phase typed message is a LIVE CHAT
        // TURN, not an onboarding advance. Pre-#204 it fell through to
        // `handleFinalHandoffOnCompleted`'s `noop_terminal` — appended
        // to the transcript, NOTHING emitted, typing dots cleared into
        // silence. Gating here (not inside the engine) keeps the engine
        // a pure onboarding machine; the engine's terminal-no-op
        // contract is unchanged.
        //
        // 2026-06-20 GO-LIVE P0 — the General gate no longer respects a
        // pending final-handoff prompt (see isLiveAgentEligible). An owner
        // who never tapped the handoff "Done" left it stuck-active and
        // every typed General message dead-ended in `noop_terminal` (General
        // went silent while project topics worked). Typed General messages
        // now reach the live agent exactly like project topics; the wow
        // handoff buttons still work via the `button_choice` tap path below.
        if (opts.liveAgentTurn !== undefined && opts.onboardingStateStore !== undefined) {
          const eligible = await isLiveAgentEligible({
            stateStore: opts.onboardingStateStore,
            project_slug,
            user_id,
            log_tag: LOG_TAG,
          })
          if (eligible) {
            console.info(
              `${LOG_TAG} handleInbound event=live_agent_turn project=${project_slug} topic=${topic_id} user=${user_id} chars=${event.body.length}`,
            )
            // Same server-deterministic typing bracket as the engine
            // path (ISSUES #115) — the turn can run for many seconds.
            emitTypingBracket(send, 'agent_typing_start', LOG_TAG)
            try {
              await opts.liveAgentTurn({
                project_slug,
                user_id,
                topic_id,
                user_text: event.body,
                send,
                observed_at,
              })
            } catch (err) {
              // The production runner never throws (it owns failure
              // messaging) — this defensive catch guarantees the
              // anti-silence contract even for a broken runner.
              console.warn(
                `${LOG_TAG} handleInbound event=live_agent_turn_threw project=${project_slug} topic=${topic_id} err=${
                  err instanceof Error ? err.message : String(err)
                }`,
              )
              try {
                send({ type: 'agent_message', body: LIVE_AGENT_BRIDGE_FAILURE_BODY, topic_id })
              } catch {
                /* dead socket — reconnect hydration covers it */
              }
            } finally {
              emitTypingBracket(send, 'agent_typing_end', LOG_TAG)
            }
            // Scribe phase 1 — a live-agent turn is chat-time knowledge
            // exactly like an engine turn; same fire-and-forget contract.
            if (opts.scribeOnUserTurn !== undefined) {
              try {
                opts.scribeOnUserTurn({
                  project_slug,
                  user_id,
                  topic_id,
                  text: event.body,
                  observed_at,
                  // Owner-native web-chat turn → author #0 (connect-spec §4.1).
                  author: { id: 'owner', display: 'owner' },
                })
              } catch (err) {
                console.warn(
                  `${LOG_TAG} handleInbound event=scribe_hook_threw project=${project_slug} topic=${topic_id} err=${
                    err instanceof Error ? err.message : String(err)
                  }`,
                )
              }
            }
            return
          }
        }
        // 2026-05-21 (Bug 2, v0.1.75) — write a `last_inbound_received_at`
        // marker BEFORE engine.advance runs. If the WS reconnects mid-
        // advance and a fresh engine.start fires, the re-emit branch
        // reads this marker and skips re-emitting the active prompt so
        // the user's typed reply isn't clobbered by a stale duplicate.
        // Best-effort — failures here are logged inside the method; the
        // bridge always proceeds to engine.advance.
        await opts.engine.recordInboundReceived({
          project_slug,
          user_id,
          received_at: observed_at,
        })
        const advanceInput: AdvanceInput = {
          project_slug,
          topic_id,
          user_id,
          channel_kind,
          freeform_text: event.body,
          observed_at,
        }
        // ISSUES #115 — bracket the turn so the typing indicator is
        // server-deterministic (start before advance, end in finally).
        emitTypingBracket(send, 'agent_typing_start', LOG_TAG)
        try {
          await opts.engine.advance(advanceInput)
        } finally {
          emitTypingBracket(send, 'agent_typing_end', LOG_TAG)
        }
        // Scribe phase 1 — fire chat-time knowledge extraction AFTER the turn
        // advances. Fire-and-forget + guarded: extraction must never block the
        // chat path or surface its failures to the user. Closes #101 Gap 2.
        if (opts.scribeOnUserTurn !== undefined) {
          try {
            opts.scribeOnUserTurn({
              project_slug,
              user_id,
              topic_id,
              text: event.body,
              observed_at,
              // Owner-native web-chat turn → author #0 (connect-spec §4.1).
              author: { id: 'owner', display: 'owner' },
            })
          } catch (err) {
            console.warn(
              `${LOG_TAG} handleInbound event=scribe_hook_threw project=${project_slug} topic=${topic_id} err=${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          }
        }
        return
      }
      if (event.type === 'button_choice') {
        await opts.engine.recordInboundReceived({
          project_slug,
          user_id,
          received_at: observed_at,
        })
        const choice: ButtonChoice = {
          prompt_id: event.prompt_id,
          choice_value: event.choice_value,
          chosen_at: observed_at,
          speaker_user_id: user_id,
          channel_kind,
          ...(event.freeform_text !== undefined ? { freeform_text: event.freeform_text } : {}),
        }
        const advanceInput: AdvanceInput = {
          project_slug,
          topic_id,
          user_id,
          channel_kind,
          choice,
          observed_at,
        }
        // ISSUES #115 — bracket the button-choice turn too (this is the
        // dominant onboarding path: every phase advance is a tap).
        emitTypingBracket(send, 'agent_typing_start', LOG_TAG)
        try {
          await opts.engine.advance(advanceInput)
        } finally {
          emitTypingBracket(send, 'agent_typing_end', LOG_TAG)
        }
        return
      }
      // Unknown event type — defensive no-op so a future protocol bump
      // doesn't crash the bridge.
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// P1.5 / Sprint 21 — slug-picker engine hook
// ─────────────────────────────────────────────────────────────────────

/**
 * Sprint B (2026-05-20) — DI shape for the Managed `processSlugPickerReply`
 * function. Chat-bridge no longer imports the Managed bridge directly; the
 * boot shell (`gateway/index.ts`) threads the function in. The Managed
 * implementation lives in the Managed slug-picker bridge module.
 *
 * The `deps` parameter is typed as `any` deliberately: the Managed
 * concrete `SlugPickerBridgeDeps` is a strict structural intersection
 * (registry + slugHistory + pendingRenames + membershipRenamer + caddy +
 * telegram + reservedSlugs) that TS's contravariant function-parameter
 * rule will not let us widen here without leaking those Managed types
 * into core. Chat-bridge composes its own gateway-restart driver around
 * the caller-supplied `renameDeps` bag and threads the merged value
 * through to `processSlugPickerReply`; only that one call site reads it.
 */
export type ProcessSlugPickerReplyFn = (
  input: {
    internal_handle: string
    current_url_slug: string
    raw_input: string
    agent_name?: string | null
    picker_choice?: 'use-suggested' | 'type-different' | 'skip-slug'
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps: any,
) => Promise<SlugPickerOutcome>

export interface BuildSlugPickerEngineHookOptions {
  /**
   * Frozen `internal_handle` for THIS per-instance gateway. Baked into the
   * hook's closure so the engine doesn't have to re-thread it on every
   * `processReply` call. Same value the chat-bridge holds for the JWT
   * slug-history shim.
   */
  internal_handle: string
  /**
   * Rename-orchestrator deps WITHOUT `gatewayRestart` — the hook supplies
   * its own no-op gatewayRestart driver that emits an agent confirmation
   * message on the live WS and returns `restart_status:'skipped'`. The
   * previous `innerGatewayRestart` option (a `systemctl restart` driver)
   * was deleted as part of the 2026-05-13 no-restart-slug-rename change:
   * killing the per-instance gateway mid-rename tore down the user's WS
   * with no reliable way to deliver the redirect, and the surviving WS
   * is fully sufficient to keep the conversation flowing on the OLD
   * entry URL.
   */
  renameDeps: Omit<RenameOrchestratorDeps, 'gatewayRestart'>
  /**
   * Sprint B (2026-05-20) — DI'd Managed `processSlugPickerReply`
   * callable. The Managed resolver injects `processSlugPickerReply`
   * from the Managed slug-picker bridge;
   * this Open-classified file never imports it directly.
   *
   * C2 OSS-split (2026-06-10): REQUIRED. The Sprint-B lazy dynamic-import
   * fallback was deleted — a dynamic import is still an open→managed
   * edge, and the slug-picker hook is only ever constructed Managed-side
   * (Open self-host has no slug picker; the engine takes the skip-only
   * branch when the hook resolver returns null).
   */
  processSlugPickerReply: ProcessSlugPickerReplyFn
  /**
   * Web-channel sender registry. Used to push the agent confirmation
   * message to the active WS for the renaming user's `topic_id`. Same
   * instance the `ChatBridge` uses, threaded through so the same
   * per-instance gateway holds one source of truth for active WS
   * connections.
   */
  webRegistry: WebChatSenderRegistry
  /** Default: `process.env.NEUTRON_BASE_DOMAIN ?? ''` (no hosted default). */
  baseDomain?: string
  /** Inject for test determinism. Defaults to `Date.now`. */
  now?: () => number
  /**
   * Test seam — overrides the durable `<owner_home>/.url_slug` write
   * the no-restart driver performs after a successful rename. The
   * production default uses `fs.writeFile` with mode 0640. Tests inject
   * a fake (e.g. in-memory map) so they don't need a real tmp dir.
   *
   * Failure is treated like the production driver's failure: returns
   * `file_written:false` from `refreshAfterRename`, which causes the
   * orchestrator's hard-fail path. Without this write the rename does
   * not survive a cold boot — `resolveOwnerSlug()` would read the
   * stale env value (the OLD slug) on next start.
   */
  writeFile?: (path: string, data: string, mode: number) => Promise<void>
  /**
   * 2026-05-22 — start-token minter for the structured `slug_renamed`
   * envelope (`landing/server.ts:SlugRenamedOutbound`). Called after
   * the rename commits to mint a fresh JWT bound to the NEW url_slug;
   * the resulting envelope drives the client's `handleSlugRenamed` →
   * `window.location.replace('https://<new_host>/chat?start=<new_token>')`.
   *
   * Production: wired by `resolve-slug-picker.ts` against the same
   * identity-DB RW handle the rename driver already uses (a fresh
   * `KeyManager` reads the active ed25519 key — same key the identity
   * service mints with). When unset (legacy tests / Open self-hosters
   * without identity-service access), the hook skips the proactive
   * emit and relies on the legacy confirmation message — the user has
   * to navigate to the new subdomain manually.
   */
  mintStartToken?: (new_project_slug: string, user_id: string) => Promise<string>
  /**
   * 2026-06-03 — pending-redirect WRITER. Re-instates the writer half of
   * the 2026-05-11 WS-closed-during-rename recovery mechanism that was
   * wrongly "retired" 2026-05-13 on the assumption the no-restart rename
   * never closes the user's WS. Sam's 2026-06-03 prod incident (instance
   * `t-44444444`, slug `sage`) proves the WS CAN drop mid-slug-pick: the
   * `slug_renamed` envelope emit returned `delivered=false` and the
   * redirect was silently dropped, stranding the user on
   * the old slug host.
   *
   * When set AND the live `slug_renamed` envelope fails to deliver
   * (`webRegistry.send` → false), the hook persists a `PendingRedirect`
   * row keyed on the renaming user's `topic_id`. The chat-bridge's
   * `startSession` reader (already wired) replays it via `takeAndClaim`
   * on the user's next WS connect; the auth-gate's `resolvePendingRedirect`
   * hook serves it as a 302 on a plain page reload. Either path lands
   * the user on `<new_slug>.<base>/chat` automatically.
   *
   * Optional — when omitted (Open self-hosters without slug-rename, or
   * legacy tests) the writer no-ops and behaviour is unchanged.
   */
  pendingRedirects?: PendingRedirectStore
}

/**
 * Build the production slug-picker engine hook.
 *
 * 2026-05-13 — no-restart slug rename.
 *
 * Sequence on a `renamed` outcome:
 *
 *   1. Engine calls `slugPicker.processReply(...)` with the user's
 *      sanitized choice.
 *   2. The hook invokes `processSlugPickerReply` (which drives
 *      `renameUrlSlug` end-to-end through registry / Caddy / identity
 *      / Telegram steps).
 *   3. Inside `renameUrlSlug`, the orchestrator's gateway-refresh step
 *      calls into the no-op driver constructed here, which:
 *        a. Pushes an `agent_message` confirmation envelope to the
 *           user's live WS (so they see "Your URL is set to … —
 *           bookmark it for next time").
 *        b. Returns `{file_written: true, restart_status: 'skipped'}`
 *           so the orchestrator records the step as `skipped` (vs.
 *           `success`).
 *   4. The engine's `consumeSlugChosenChoice` sees
 *      `gateway-refreshed:skipped` and stays on the OLD project_slug
 *      key for onboarding state, then emits the NEXT-phase prompt on
 *      the same live socket. No redirect, no `window.location.replace`,
 *      no new WS connect.
 *
 * Why no restart: the prior production path called `systemctl restart`
 * mid-rename, which SIGTERMed this Bun process and killed the user's
 * WebSocket. The "redirect before restart" race was unreliable
 * (`delivered=false` in prod 2026-05-13T04:53:49Z). Skipping the
 * restart entirely keeps the WS alive; the gateway stays on the OLD
 * slug env value in-memory, but the chat-bridge's
 * ownerRegistry shim accepts NEW-slug JWTs against the live registry
 * row so new logins still authenticate against this unit.
 *
 * The hook is constructed per gateway instance; it shares
 * the registry + rename deps with the rest of the production
 * composition. Tests inject a hook that simulates the same shape
 * against in-process stores.
 */
export function buildSlugPickerEngineHook(
  opts: BuildSlugPickerEngineHookOptions,
): SlugPickerEngineHook {
  const baseDomain = opts.baseDomain ?? process.env.NEUTRON_BASE_DOMAIN ?? ''
  const now = opts.now ?? ((): number => Date.now())
  // Track whether the caller injected a writeFile so the test-mode
  // defensive guard below can distinguish "test stubbed it" from "test
  // forgot to stub it and we're about to hit the real fs.writeFile."
  const userInjectedWriteFile = opts.writeFile !== undefined
  const writeFile =
    opts.writeFile ??
    (async (path: string, data: string, mode: number): Promise<void> => {
      const fs = await import('node:fs/promises')
      await fs.writeFile(path, data, { encoding: 'utf8', mode })
    })
  return {
    async processReply(input): Promise<SlugPickerOutcome> {
      // 2026-06-05 — preflightRedirect closure. The confirmation +
      // structured `slug_renamed` emit + pending-redirect persist logic
      // RELOCATED here from `noRestartGatewayDriver.refreshAfterRename`
      // (step 5) so the redirect is delivered on the LIVE socket BEFORE
      // the orchestrator's destructive step-3 Caddy flip tears it down.
      // The orchestrator additively pre-registers the new host (separate
      // @id → live WS survives), then invokes this hook. All the TLS-
      // readiness gating, prevent-over-recover behaviour, and the #86
      // pending-redirect writer are byte-identical to the prior location;
      // only WHEN they run changed. See
      // docs/plans/slug-rename-onboarding-handoff-2026-06-05.md.
      const preflightRedirect = async (pfInput: {
        internal_handle: string
        old_url_slug: string
        new_url_slug: string
        new_host: string
        port: number
      }): Promise<{ delivered: boolean }> => {
        // Emit the agent confirmation on the live WS. delivered=false
        // on THIS bookmark message is benign — it's a courtesy
        // "bookmark your URL" notice, not the redirect. The
        // authoritative redirect is the structured `slug_renamed`
        // envelope below; when THAT fails to deliver the writer
        // persists a pending-redirect row so the reconnect-replay /
        // auth-gate-302 fallbacks recover it.
        const delivered = opts.webRegistry.send(
          input.topic_id,
          renderSlugRenameConfirmationForWeb({
            new_slug: pfInput.new_url_slug,
            base_domain: baseDomain,
            topic_id: input.topic_id,
          }),
        )
        console.warn(
          `[slug-picker] preflight confirmation emit topic_id=${input.topic_id} internal_handle=${pfInput.internal_handle} new_slug=${pfInput.new_url_slug} delivered=${delivered}`,
        )

        // 2026-05-22 — structured `slug_renamed` envelope. Mints a
        // fresh start_token bound to the NEW url_slug and emits the
        // envelope on the live WS so the client navigates to the
        // personal subdomain WITHOUT going through `/recover` or
        // rendering a "reconnecting..." / "disconnected" banner.
        // Per Sam 2026-05-22 spec: "always engage on their
        // personal URL once it has been selected" + "automatic
        // and invisible to the user."
        //
        // The renamed gateway's `validateStartToken` collapses the
        // JWT's new-slug claim down to the gateway's still-OLD
        // `expected_project_slug` via the ownerRegistry shim — same
        // path the pre-emit confirmation message above relies on.
        // Onboarding state stays under the OLD slug; engine.start
        // on the new-subdomain reconnect picks it up via the
        // slug-history lazy-rekey (`onboarding/interview/engine.ts`
        // line ~1340).
        //
        // `mintStartToken` is undefined when the caller didn't wire
        // the identity-DB signing key (older tests / Open self-
        // hosters without the identity-service edge); the emit
        // falls through silently and the legacy bookmark-message
        // flow stays as the only path.
        let renamedDelivered = false
        if (opts.mintStartToken !== undefined) {
          try {
            const new_token = await opts.mintStartToken(
              pfInput.new_url_slug,
              input.user_id,
            )
            const new_host = pfInput.new_host
            // 2026-06-05 (click-button model) — emit the `slug_renamed`
            //   envelope IMMEDIATELY on the live socket, with NO TLS-
            //   readiness suppression. The client now renders this envelope
            //   as a big "Open your agent →" BUTTON (landing/chat.ts
            //   `handleSlugRenamed`), not an instant `location.replace`. A
            //   button is safe to show against a not-yet-ready host: the
            //   human click delay (seconds) covers the new host's route +
            //   TLS readiness, which the 2026-06-04 prevent-over-recover
            //   gate existed to protect (an instant auto-navigate could
            //   surface a raw SSL error). With a click there is no such
            //   window, so steering at a not-yet-ready host is fine and we
            //   no longer suppress. The orchestrator emits this BEFORE any
            //   Caddy mutation (rename-url-slug.ts step 2.5 reorder), so
            //   the socket is provably alive here. We also DON'T probe TLS
            //   before emitting — a 4s probe poll would delay the button on
            //   a socket that may be racing toward death. See
            //   docs/plans/slug-rename-click-button-2026-06-05.md.
            renamedDelivered = opts.webRegistry.send(input.topic_id, {
              type: 'slug_renamed',
              new_slug: pfInput.new_url_slug,
              new_host,
              new_token,
            })
            console.warn(
              `[slug-picker] slug_renamed button envelope emit topic_id=${input.topic_id} internal_handle=${pfInput.internal_handle} new_slug=${pfInput.new_url_slug} new_host=${new_host} delivered=${renamedDelivered}`,
            )
            // 2026-06-05 (click-button) — there is NO pre-emit TLS probe.
            //   The 2026-06-04 pre-redirect TLS-readiness gate
            //   (`gateway/http/tls-readiness.ts`) was DELETED: it existed to
            //   suppress an instant auto-navigate toward a not-yet-ready host,
            //   but the button defers navigation to the human click (whose
            //   delay covers route + TLS readiness), so there is no SSL-error
            //   window to suppress. It was also actively harmful here —
            //   `preflightRedirect` now runs BEFORE `addOwnerRoute`, so the
            //   new host isn't even routed yet; polling it would burn the full
            //   budget (~4s) and, inside this closure, BLOCK route creation +
            //   the flip + the pending-redirect write below. Removed entirely.
            //   See docs/plans/slug-rename-click-button-2026-06-05.md.
            // 2026-06-05 — pending-redirect WRITER, now UNCONDITIONAL.
            //   Persist the redirect every time so the CTA/redirect is
            //   recoverable when the browser reconnects or reloads — even
            //   when the live button emit delivered. Two recovery shapes:
            //     (a) live emit delivered, user RELOADS chat.<base> instead
            //         of clicking → auth-gate `resolvePendingRedirect` 302s.
            //     (b) live emit did NOT deliver (socket already gone before
            //         we reached here, the rare network-drop case) → next WS
            //         `startSession` → `takeAndClaim` replays it.
            //   Keyed on `topic_id` (PK) so a retry is an idempotent
            //   overwrite, not a duplicate row, and `takeAndClaim` consumes
            //   it exactly once. A row left unclaimed (user clicked the
            //   button, never returned to chat.<base>) simply expires at
            //   PENDING_REDIRECT_TTL_MS. `target_url` is the bare
            //   destination (no `?start=`); both delivery paths append
            //   `?start=<new_start_token>` so the destination's WS upgrade /
            //   auth-gate has a usable JWT bound to the NEW slug.
            if (opts.pendingRedirects !== undefined) {
              const now_ms = now()
              try {
                await opts.pendingRedirects.put({
                  topic_id: input.topic_id,
                  new_slug: pfInput.new_url_slug,
                  target_url: `https://${new_host}/chat`,
                  new_start_token: new_token,
                  expires_at_ms: now_ms + PENDING_REDIRECT_TTL_MS,
                  created_at_ms: now_ms,
                })
                console.warn(
                  `[slug-picker] slug_renamed persisted pending-redirect topic_id=${input.topic_id} new_slug=${pfInput.new_url_slug} new_host=${new_host} delivered=${renamedDelivered} pending=true expires_at_ms=${now_ms + PENDING_REDIRECT_TTL_MS}`,
                )
              } catch (persistErr) {
                // Best-effort: a persistence failure must NOT roll back
                // the rename (already committed durably). Log so ops can
                // grep the dropped-redirect case the way they could
                // before this writer existed.
                console.warn(
                  `[slug-picker] slug_renamed pending-redirect persist FAILED topic_id=${input.topic_id} new_slug=${pfInput.new_url_slug} err=${
                    persistErr instanceof Error ? persistErr.message : String(persistErr)
                  }`,
                )
              }
            }
          } catch (err) {
            // Non-fatal — the legacy confirmation message above
            // already landed (or didn't, with delivered=false either
            // way), the rename committed durably, and the `/recover`
            // composer (when wired) is the still-functional fallback
            // path. Log so ops can spot a degraded mint.
            console.warn(
              `[slug-picker] slug_renamed envelope mint FAILED topic_id=${input.topic_id} new_slug=${pfInput.new_url_slug} err=${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          }
        }
        return { delivered: renamedDelivered }
      }

      const noRestartGatewayDriver: GatewayRestartDriver = {
        async refreshAfterRename(restartInput) {
          // Defensive guard (ISSUES #7): in bun test mode (NODE_ENV='test'
          // is set automatically by `bun test`), refuse to do a REAL write to
          // a production-shaped data root when the caller forgot to inject
          // opts.writeFile. Without this guard the default writer EACCES's on
          // macOS dev boxes — and worse, on a Linux box that happens to have
          // the production data root writable, it would silently stamp a real
          // production-shaped file from a test run. Surface a clear remediation
          // in the wrapped RenameError instead.
          const slugPathProbe = `${restartInput.owner_home}/.url_slug`
          // The hazard exists in BOTH env states: when NEUTRON_HOME is SET the
          // default write lands under it; when it is UNSET the process default
          // still resolves to the canonical managed root. Gating on
          // NEUTRON_HOME-being-set alone would let the common unset (test/CI
          // default) case fall through to a REAL write. So instead of pinning a
          // managed-path literal here (this file is in the Open tree — the
          // leak-gate forbids hardcoded prod roots), we treat any absolute path
          // NOT confined to the OS temp sandbox as dangerous. Tests that
          // legitimately exercise the default writer either inject a writeFile
          // stub or point owner_home at os.tmpdir(); a real prod root is never
          // under tmpdir, so the guard fires in both configured and
          // unconfigured states.
          const tmpRoot = tmpdir()
          const writingToRealRoot =
            slugPathProbe.startsWith('/') && !slugPathProbe.startsWith(`${tmpRoot}/`)
          if (
            process.env['NODE_ENV'] === 'test' &&
            !userInjectedWriteFile &&
            writingToRealRoot
          ) {
            throw new Error(
              `[slug-picker] refusing to write '${slugPathProbe}' under NODE_ENV=test without an injected opts.writeFile — tests must pass buildSlugPickerEngineHook({ writeFile: async () => {} }) so the rename does not touch production paths. See ISSUES #7.`,
            )
          }
          // Durable write FIRST. Even though we don't restart, a future
          //    cold boot (host reboot, supervisor bounce on the next
          //    deploy) calls `resolveOwnerSlug()` which reads from
          //    `<owner_home>/.url_slug` (falling back to the env value).
          //    Without this write the env still carries the OLD slug
          //    and the file is stale, so the gateway boots back on the
          //    OLD slug — silently for new instances whose unit uses
          //    `internal_handle` as the systemd env, hard-failing for
          //    legacy instances whose unit was rendered with a HUMAN slug
          //    (resolveOwnerRegistryRow can no longer find the OLD
          //    slug in the registry since the rename flipped it).
          //
          //    The gateway process runs as `neutron-t-<handle>` which
          //    owns `<owner_home>` (mode 0750), so a direct write
          //    succeeds without sudo. File mode 0640 = owner read+write,
          //    group read — matches the production restart driver.
          //
          //    The redirect (confirmation + `slug_renamed` envelope +
          //    pending-redirect persist) is now delivered PRE-FLIP via
          //    the `preflightRedirect` closure above (step 2.5 in the
          //    orchestrator), so this driver is back to its original
          //    durable-write-only responsibility.
          const slugPath = `${restartInput.owner_home}/.url_slug`
          try {
            await writeFile(slugPath, `${restartInput.new_url_slug}\n`, 0o640)
          } catch (err) {
            console.warn(
              `[slug-picker] no-restart .url_slug write FAILED path=${slugPath} new_slug=${restartInput.new_url_slug} err=${
                err instanceof Error ? err.message : String(err)
              }`,
            )
            // Surface as hard-fail to the orchestrator — symmetric with
            // the production restart driver. The rename's durable
            // contract is the file; without it the rename does not
            // survive a cold boot, so the orchestrator must NOT commit
            // gateway-refreshed.
            return { file_written: false, restart_status: 'failed' }
          }

          // Report `skipped` (not `success`) so the engine's
          //    `advanceFromSlugChosen` decision matrix keeps the
          //    onboarding state under the OLD slug. The slug_renamed
          //    envelope (delivered pre-flip via `preflightRedirect`)
          //    already steered the client toward the new subdomain; the
          //    engine still emits the next-phase prompt on the live
          //    socket as a safety net for the case where the client
          //    missed the envelope. `file_written` is true because the
          //    durable .url_slug write above succeeded (the
          //    orchestrator's hard-fail path is gated on it).
          return { file_written: true, restart_status: 'skipped' }
        },
      }

      const bridgeDeps: RenameOrchestratorDeps & {
        registry: { getByInternalHandle: (h: string) => { url_slug: string } | undefined }
      } = {
        ...opts.renameDeps,
        gatewayRestart: noRestartGatewayDriver,
        preflightRedirect,
        registry: opts.renameDeps.registry as RenameOrchestratorDeps['registry'] & {
          getByInternalHandle: (h: string) => { url_slug: string } | undefined
        },
        slugHistory: opts.renameDeps.slugHistory,
      }
      // Resolve current_url_slug from the registry by internal_handle so
      // a stale `project_slug` claim (post-rename) does NOT trip the
      // optimistic-lock check inside renameUrlSlug.
      const ownerRow = (
        opts.renameDeps.registry as {
          getByInternalHandle: (h: string) => { url_slug: string } | undefined
        }
      ).getByInternalHandle(opts.internal_handle)
      const current_url_slug = ownerRow?.url_slug ?? input.project_slug
      // C2 OSS-split (2026-06-10) — injection-only. The Sprint-B lazy
      // dynamic import of the Managed bridge was deleted; the caller
      // (always the Managed slug-picker resolver) pre-binds the fn.
      const outcome = await opts.processSlugPickerReply(
        {
          internal_handle: opts.internal_handle,
          current_url_slug,
          raw_input: input.raw_input,
          agent_name: input.agent_name,
          ...(input.picker_choice !== undefined ? { picker_choice: input.picker_choice } : {}),
        },
        bridgeDeps,
      )
      return outcome
    },
  }
}

/**
 * 2026-05-28 sidebar sprint — stub inbound handler for taps + freeform on
 * a per-project topic (`web:<user_id>:<project_id>`). The onboarding
 * engine is still keyed on (`project_slug`, `user_id`) and routes
 * outbound to the General topic only, so a tap against a project-topic
 * seed prompt must NOT drive the engine. Instead:
 *
 *   1. Resolve the active button_prompts row (if this is a
 *      button_choice referencing a row on the project topic) so the
 *      keyboard collapses to the chosen option in the chat surface's
 *      next history fetch.
 *   2. Emit a stub `agent_message` acknowledgement so the chat surface
 *      doesn't go silent — the chat client renders the acknowledgement
 *      below the user's bubble. Real per-project agent continuation
 *      lands in a follow-up sprint.
 *
 * Failures inside the resolve are caught + logged so a bad inbound
 * never crashes the bridge.
 */
/**
 * BUG #310 fix (2026-06-19, owner live-dogfood) — TTL for persisted
 * project-topic stub rows. Matches `build-live-agent-turn`'s
 * `REPLY_ROW_TTL_MS`: a ~10-year horizon so the row is never swept as an
 * expired "ghost" by `listHistoryByTopic`'s `expires_at > now` filter, and
 * the stub turn survives indefinitely in the per-project chat history.
 */
const PROJECT_STUB_ROW_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1_000

/**
 * BUG #310 fix (2026-06-19) — persist a project-topic stub turn to
 * `button_prompts` so it hydrates on a topic switch / refresh instead of
 * being a live-only paint that vanishes. Mirrors the live-agent turn
 * persistence (`build-live-agent-turn.ts:318,368`):
 *
 *   1. (user_message only) stamp the typed text as the `__freeform__`
 *      resolution of the topic's latest unresolved row (the prior agent
 *      reply or the unanswered project seed), so it renders as the user
 *      bubble following that agent bubble. Skipped for `button_choice`
 *      inbounds — the caller's `buttonStore.resolve()` already stamped the
 *      user side.
 *   2. Emit the stub reply as a NEW unresolved row so it persists as the
 *      agent bubble AND becomes the topic's active prompt (the row the
 *      live re-emit owns; the chat client dedups the returned prompt_id).
 *
 * Best-effort: every DB failure is caught + logged so a persistence miss
 * never eats the live stub reply (the turn still ships to the open socket).
 * Returns the new row's prompt_id (so the caller can stamp the live
 * envelope for client-side dedup), or null if the emit failed.
 */
/**
 * Connect engagement gate (spec §2) — persist a member's turn to the shared
 * transcript WITHOUT emitting any agent reply. Used by `tag_gated` when a post
 * doesn't @-mention the agent: humans still see the message and the agent has
 * it as context the next time it IS tagged, but no agent turn fires. This is
 * the user-turn-stamping half of `persistProjectStubTurn` with NO stub reply —
 * it stamps the typed text onto the latest unresolved `button_prompts` row
 * (the same persistence model live turns use) so chat-history hydration renders
 * the member bubble in order. Best-effort + guarded: a persistence hiccup never
 * wedges the chat path.
 */
async function persistProjectUserTurnOnly(input: {
  buttonStore: import('../../channels/button-store.ts').ButtonStore
  topic_id: string
  user_id: string
  project_slug: string
  channel_kind: ChannelKindForButton
  observed_at: number
  user_text: string
  log_tag: string
}): Promise<void> {
  const { buttonStore, log_tag } = input
  try {
    const { turns } = await buttonStore.listHistoryByTopic({
      topic_id: input.topic_id,
      before: input.observed_at,
      before_prompt_id: null,
      limit: 1,
      now: input.observed_at,
    })
    const latest = turns[0]
    if (latest !== undefined && !latest.resolved) {
      // First quiet message after an agent prompt: stamp onto that unresolved
      // row so history renders [agent prompt][user reply] in order.
      await buttonStore.resolve({
        choice: {
          prompt_id: latest.prompt_id,
          choice_value: '__freeform__',
          freeform_text: input.user_text,
          chosen_at: input.observed_at,
          speaker_user_id: input.user_id,
          channel_kind: input.channel_kind,
        },
      })
      return
    }
    // No unresolved row to attach to — e.g. CONSECUTIVE quiet messages in a
    // `tag_gated` project (the prior one already resolved the last open row).
    // Persist this message as its own durable inert user turn so the shared
    // transcript never drops a gated message (Codex cross-model review,
    // 2026-06-26). Without this, the second+ quiet message in a stretch would
    // silently vanish from hydrated history.
    await buttonStore.persistInertUserTurn({
      topic_id: input.topic_id,
      text: input.user_text,
      speaker_user_id: input.user_id,
      channel_kind: input.channel_kind,
    })
  } catch (err) {
    console.warn(
      `${log_tag} persistProjectUserTurnOnly event=user_turn_persist_skipped project=${input.project_slug} topic=${input.topic_id} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

async function persistProjectStubTurn(input: {
  buttonStore: import('../../channels/button-store.ts').ButtonStore
  topic_id: string
  user_id: string
  project_slug: string
  channel_kind: ChannelKindForButton
  observed_at: number
  /** Typed user text to stamp on the prior unresolved row, or null when
   *  the inbound was a `button_choice` (already resolved upstream). */
  user_text: string | null
  stub_body: string
  log_tag: string
}): Promise<string | null> {
  const { buttonStore, log_tag } = input
  if (input.user_text !== null) {
    try {
      const { turns } = await buttonStore.listHistoryByTopic({
        topic_id: input.topic_id,
        before: input.observed_at,
        before_prompt_id: null,
        limit: 1,
        now: input.observed_at,
      })
      const latest = turns[0]
      if (latest !== undefined && !latest.resolved) {
        await buttonStore.resolve({
          choice: {
            prompt_id: latest.prompt_id,
            choice_value: '__freeform__',
            freeform_text: input.user_text,
            chosen_at: input.observed_at,
            speaker_user_id: input.user_id,
            channel_kind: input.channel_kind,
          },
        })
      }
    } catch (err) {
      console.warn(
        `${log_tag} persistProjectStubTurn event=user_turn_persist_skipped project=${input.project_slug} topic=${input.topic_id} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
  try {
    const replyPrompt = buildButtonPrompt({
      body: input.stub_body,
      options: [],
      allow_freeform: true,
      expires_in_ms: PROJECT_STUB_ROW_TTL_MS,
    })
    const emitted = await buttonStore.emit(replyPrompt, { topic_id: input.topic_id })
    return emitted.prompt_id
  } catch (err) {
    console.warn(
      `${log_tag} persistProjectStubTurn event=stub_reply_persist_failed project=${input.project_slug} topic=${input.topic_id} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return null
  }
}

async function handleProjectTopicInbound(input: {
  project_slug: string
  user_id: string
  wire_topic_id: string
  event: import('../../landing/server.ts').ChatInbound
  send: (event: ChatOutbound) => void
  channel_kind: ChannelKindForButton
  observed_at: number
  buttonStore?: import('../../channels/button-store.ts').ButtonStore
  /** ISSUES #204 — when wired (with the state store) and the owner is
   *  at `phase==completed`, project-topic messages run a real agent
   *  turn instead of the stub. */
  liveAgentTurn?: LiveAgentTurnRunner
  onboardingStateStore?: import('../../onboarding/interview/state-store.ts').OnboardingStateStore
  /** Connect engagement-mode reader (spec §2) — see BuildWebChatBridgeOptions. */
  resolveEngagementMode?: (project_id: string) => Promise<AgentEngagementMode>
  /** Connect tag-to-delegate hook (spec §4) — see BuildWebChatBridgeOptions. */
  delegateDispatch?: (input: {
    project_id: string
    topic_id: string
    user_id: string
    task: string
    kind: 'research' | 'review' | 'adhoc'
  }) => Promise<void>
  /** Mention-detector handle/alias override. */
  agentHandles?: readonly string[]
  log_tag: string
}): Promise<void> {
  const { event, send, log_tag } = input
  console.info(
    `${log_tag} handleInbound event=project_topic_stub project=${input.project_slug} topic=${input.wire_topic_id} user=${input.user_id} kind=${event.type}`,
  )
  // ISSUES #204 — live-agent eligibility for this project topic. The gate
  // is purely `phase==completed` (2026-06-20: General no longer respects a
  // pending final-handoff either — see isLiveAgentEligible). Resolved ONCE
  // per inbound; both the user_message branch and the button_choice
  // fall-through consult it.
  const liveAgentEligible =
    input.liveAgentTurn !== undefined && input.onboardingStateStore !== undefined
      ? await isLiveAgentEligible({
          stateStore: input.onboardingStateStore,
          project_slug: input.project_slug,
          user_id: input.user_id,
          log_tag,
        })
      : false
  // `web:<user_id>:<project_id>` → the per-project scope the agent turn
  // runs under (chat-bridge.ts topic-id shape, 2026-05-28 sidebar sprint).
  const project_id = input.wire_topic_id.slice(`web:${input.user_id}:`.length)
  const runProjectAgentTurn = async (user_text: string): Promise<void> => {
    console.info(
      `${log_tag} handleInbound event=live_agent_turn instance=${input.project_slug} topic=${input.wire_topic_id} user=${input.user_id} project=${project_id} chars=${user_text.length}`,
    )
    emitTypingBracket(send, 'agent_typing_start', log_tag)
    try {
      await input.liveAgentTurn!({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.wire_topic_id,
        ...(project_id.length > 0 ? { project_id } : {}),
        user_text,
        send,
        observed_at: input.observed_at,
      })
    } catch (err) {
      console.warn(
        `${log_tag} handleInbound event=live_agent_turn_threw project=${input.project_slug} topic=${input.wire_topic_id} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      try {
        send({ type: 'agent_message', body: LIVE_AGENT_BRIDGE_FAILURE_BODY, topic_id: input.wire_topic_id })
      } catch {
        /* dead socket — reconnect hydration covers it */
      }
    } finally {
      emitTypingBracket(send, 'agent_typing_end', log_tag)
    }
  }
  if (event.type === 'user_message' && liveAgentEligible) {
    // Connect group-chat engagement gate (spec §2). Read the per-project
    // `agent_engagement_mode`; in `tag_gated` a post that doesn't @-mention the
    // agent persists to the transcript but triggers NO agent turn. The default
    // (and any box without the reader wired) is `all_messages` — every post
    // engages, exactly as before this feature.
    const engagementMode: AgentEngagementMode =
      input.resolveEngagementMode !== undefined && project_id.length > 0
        ? await input
            .resolveEngagementMode(project_id)
            .catch((err: unknown) => {
              console.warn(
                `${log_tag} handleInbound event=engagement_mode_read_failed project=${input.project_slug} topic=${input.wire_topic_id} project_id=${project_id} err=${
                  err instanceof Error ? err.message : String(err)
                }`,
              )
              return DEFAULT_AGENT_ENGAGEMENT_MODE
            })
        : DEFAULT_AGENT_ENGAGEMENT_MODE
    const decision = resolveEngagement({
      mode: engagementMode,
      text: event.body,
      ...(input.agentHandles !== undefined ? { handles: input.agentHandles } : {}),
    })
    if (!decision.engage) {
      // tag_gated + no mention: the transcript MUST still receive the message
      // (humans see each other; the agent has context next time it IS tagged),
      // but there is no agent turn and NO typing indicator. Persist the user
      // turn, then clear the client's optimistic typing dots with a no-render
      // `agent_ack` (same bookkeeping envelope the silent-skip branch uses) so
      // they don't spin forever waiting on a reply that isn't coming.
      console.info(
        `${log_tag} handleInbound event=engagement_gated mode=${engagementMode} reason=${decision.reason} project=${input.project_slug} topic=${input.wire_topic_id}`,
      )
      if (input.buttonStore !== undefined) {
        await persistProjectUserTurnOnly({
          buttonStore: input.buttonStore,
          topic_id: input.wire_topic_id,
          user_id: input.user_id,
          project_slug: input.project_slug,
          channel_kind: input.channel_kind,
          observed_at: input.observed_at,
          user_text: event.body,
          log_tag,
        })
      }
      send({ type: 'agent_ack', topic_id: input.wire_topic_id })
      return
    }
    // Engaged. Tag-to-delegate (spec §4): in `tag_gated` a tagged TASK (vs a
    // quick question) hands off to a background subagent that reports back into
    // the thread, instead of answering inline. Only when the delegate hook is
    // wired; otherwise the task is answered inline like any engaged turn.
    if (
      engagementMode === 'tag_gated' &&
      decision.mentioned &&
      input.delegateDispatch !== undefined &&
      project_id.length > 0
    ) {
      const intent = classifyTaggedIntent(event.body, {
        ...(input.agentHandles !== undefined ? { handles: input.agentHandles } : {}),
      })
      if (intent.intent === 'delegate') {
        console.info(
          `${log_tag} handleInbound event=tag_to_delegate kind=${intent.kind} project=${input.project_slug} topic=${input.wire_topic_id}`,
        )
        // Persist the requester's turn to the transcript, acknowledge inline,
        // then dispatch. The dispatcher's report-back posts the result into the
        // thread (author-stamped as the agent, §4).
        if (input.buttonStore !== undefined) {
          await persistProjectUserTurnOnly({
            buttonStore: input.buttonStore,
            topic_id: input.wire_topic_id,
            user_id: input.user_id,
            project_slug: input.project_slug,
            channel_kind: input.channel_kind,
            observed_at: input.observed_at,
            user_text: event.body,
            log_tag,
          })
        }
        try {
          send({
            type: 'agent_message',
            body: "On it — I'll work on that in the background and post the result here when it's ready.",
            topic_id: input.wire_topic_id,
          })
        } catch {
          /* dead socket — reconnect hydration covers it */
        }
        try {
          await input.delegateDispatch({
            project_id,
            topic_id: input.wire_topic_id,
            user_id: input.user_id,
            task: intent.task,
            kind: intent.kind,
          })
        } catch (err) {
          console.warn(
            `${log_tag} handleInbound event=tag_to_delegate_threw project=${input.project_slug} topic=${input.wire_topic_id} err=${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
        return
      }
    }
    await runProjectAgentTurn(event.body)
    return
  }
  if (event.type === 'button_choice' && input.buttonStore !== undefined) {
    const prompt_id = event.prompt_id
    const choice_value = event.choice_value
    if (typeof prompt_id === 'string' && prompt_id.length > 0 && typeof choice_value === 'string' && choice_value.length > 0) {
      // Argus r1 BLOCKER 1 (2026-05-28) — peek the prompt row BEFORE
      // resolving so a tap arriving on a project topic can never resolve
      // a row that lives on a different topic_id (the General onboarding
      // topic or another project's topic). Without this guard, a client
      // bound to `web:<u>:<projA>` could resolve any prompt_id it knows
      // about — including an active onboarding prompt — silently
      // corrupting state. The peek is read-only and adds one indexed
      // PK lookup; the subsequent resolve runs only when topic_id
      // matches. Mismatch emits a structured `error` envelope so the
      // chat client can surface "this prompt isn't on this topic" and
      // re-route to the correct surface rather than silently swallowing
      // the tap.
      const promptRow = await input.buttonStore.peek(prompt_id)
      if (promptRow === null) {
        console.info(
          `${log_tag} handleInbound event=project_topic_resolve_skip project=${input.project_slug} topic=${input.wire_topic_id} prompt_id=${prompt_id} err=prompt_not_found`,
        )
        send({
          type: 'error',
          message: 'That prompt is no longer available.',
          topic_id: input.wire_topic_id,
        })
        return
      }
      if (promptRow.topic_id !== input.wire_topic_id) {
        console.warn(
          `${log_tag} handleInbound event=project_topic_resolve_cross_topic_reject project=${input.project_slug} wire_topic=${input.wire_topic_id} prompt_topic=${promptRow.topic_id} prompt_id=${prompt_id} user=${input.user_id}`,
        )
        send({
          type: 'error',
          message: 'That prompt belongs to a different chat. Switch back to that conversation to answer it.',
          topic_id: input.wire_topic_id,
        })
        return
      }
      try {
        await input.buttonStore.resolve({
          choice: {
            prompt_id,
            choice_value,
            chosen_at: input.observed_at,
            speaker_user_id: input.user_id,
            channel_kind: input.channel_kind,
            ...(event.freeform_text !== undefined
              ? { freeform_text: event.freeform_text }
              : {}),
          },
        })
      } catch (err) {
        // Already-resolved / expired / missing — log + continue; the
        // stub reply still ships so the user gets feedback.
        console.info(
          `${log_tag} handleInbound event=project_topic_resolve_skip project=${input.project_slug} topic=${input.wire_topic_id} prompt_id=${prompt_id} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      // ISSUES #69 (Codex P3 follow-up on PR #340) — the onboarding-
      // handoff no-match fallback emits `[B] Skip for now` with
      // `value: ONBOARDING_HANDOFF_SKIP_FOR_NOW_VALUE`. The spec
      // calls this out as a SILENT acknowledgement: the seed already
      // asked "what's the context?" and the user explicitly declined.
      // Emitting the generic "full project chat is coming online
      // soon" stub on top of an explicit skip is jarring and
      // contradicts the seed's promise. Special-case this single
      // value to suppress the stub reply while keeping the resolve
      // (so the seed row's `resolved_at` flips and history surfaces
      // it correctly on switch-back).
      //
      // Only this exact string is silenced — every other project-
      // topic button value (including `tell-me-what-you-know`,
      // `show-context`, `not-now` from the onboarding handoff and
      // anything a future composer emits) still gets the stub until
      // the per-project agent loop replaces this whole branch. The
      // resolve runs FIRST so even the silent path stamps
      // `resolved_at`; we return only after that side-effect lands.
      //
      // Argus r1 BLOCKER 1 (2026-05-30) — emit a no-render `agent_ack`
      // envelope BEFORE returning. The landing client bumps
      // `pendingAgentReplies` on every `sendChoice()` and only
      // decrements it when an `agent_message` / `error` / `agent_ack`
      // envelope lands. Project topics have no per-project agent loop
      // yet, so an unanswered `button_choice` leaves the optimistic
      // typing dots stuck on screen forever. The ack envelope is
      // pure-bookkeeping wire signal — it carries no body, renders
      // nothing, and exists solely to clear the dots.
      if (choice_value === ONBOARDING_HANDOFF_SKIP_FOR_NOW_VALUE) {
        console.info(
          `${log_tag} handleInbound event=project_topic_silent_skip project=${input.project_slug} topic=${input.wire_topic_id} prompt_id=${prompt_id}`,
        )
        send({ type: 'agent_ack', topic_id: input.wire_topic_id })
        return
      }
    }
  }
  // ISSUES #204 — a completed-phase button tap (e.g. the wow seed's
  // "Tell me what you know") now gets a REAL agent answer: route the
  // tapped intent (freeform text when present, else the routing value —
  // values like `tell-me-what-you-know` read fine as intents) through
  // the same per-project agent turn. The resolve above already stamped
  // the row, so history renders the tap correctly either way.
  if (liveAgentEligible && event.type === 'button_choice') {
    const intent =
      typeof event.freeform_text === 'string' && event.freeform_text.length > 0
        ? event.freeform_text
        : event.choice_value
    await runProjectAgentTurn(intent)
    return
  }
  // Stub agent reply — pre-#204 behaviour, now only for instances still
  // mid-onboarding (or boxes without a live-agent runner wired). The
  // body is intentionally short + functional.
  const stub_body =
    "I've got that — full project chat is coming online soon. Switch to General if you need to talk through onboarding work."
  // BUG #310 fix (2026-06-19) — PERSIST the stub turn (regardless of
  // `liveAgentEligible`, which is false on this branch) so it survives a
  // topic switch / refresh. Previously this was a live-only `send(...)`
  // that was never written to `button_prompts`, so every stub turn on a
  // project topic was lost on switch-away, leaving the per-project chat
  // showing only whatever single row the live re-emit could repaint. A
  // `user_message` stamps its typed text onto the prior unresolved row;
  // a `button_choice` was already resolved upstream (so user_text=null).
  let stub_prompt_id: string | null = null
  if (input.buttonStore !== undefined) {
    stub_prompt_id = await persistProjectStubTurn({
      buttonStore: input.buttonStore,
      topic_id: input.wire_topic_id,
      user_id: input.user_id,
      project_slug: input.project_slug,
      channel_kind: input.channel_kind,
      observed_at: input.observed_at,
      user_text: event.type === 'user_message' ? event.body : null,
      stub_body,
      log_tag,
    })
  }
  send({
    type: 'agent_message',
    body: stub_body,
    // Stamp the owning topic (cross-project bleed guard, mirrors the
    // live-agent reply envelope) and the persisted row's prompt_id so the
    // client dedups this live paint against the history-hydration re-emit.
    topic_id: input.wire_topic_id,
    ...(stub_prompt_id !== null ? { prompt_id: stub_prompt_id } : {}),
  })
}

/**
 * 2026-05-29 r2 BLOCKER fix — re-emit the active button_prompts row for
 * `topic_id` (if any) as a live `agent_message` on `send`.
 *
 * Why this helper exists. The onboarding handoff hook
 * (`buildOnboardingHandoffHook.emitProjectSeeds`) writes one seed row
 * per project to `web:<user_id>:<project_id>` BEFORE the user ever
 * opens the corresponding sidebar topic. The engine never re-emits
 * those seeds: engine state is per-user and lives on General, so its
 * reconnect re-emit path only fires for the General-topic active
 * prompt. The chat-history hydration path correctly SKIPS unresolved
 * rows (so the engine's live re-emit on General isn't deduped into
 * silence), but that same skip blanks out the project topic — the
 * seed is unresolved at the moment of first switch, the history rows
 * arrive with `resolved:false`, the client renderer drops them, and
 * the user lands on an empty project chat. The sprint's primary goal
 * was undelivered.
 *
 * PATH A from the r2 brief — the seed row IS the active prompt for
 * that topic. On a topic_switch (or an initial connect that lands on
 * a non-General `wire_topic_id`), look up the most recent unresolved
 * row for the destination `topic_id` and ship it through the same
 * `renderButtonPromptForWeb` envelope the engine uses for a live
 * emit. The client's `renderAgent` dedups by `prompt_id`, so the
 * subsequent history-hydration unresolved-skip stays intact (no
 * regression). The history-hydration unresolved-skip behaviour for
 * live prompts is UNCHANGED.
 *
 * Limit=1 because the latest row is what's "active" for the topic:
 *   - If it's resolved, there is nothing pending — bail out.
 *   - If it's unresolved + within TTL, fetch the full prompt (with
 *     options) via `buttonStore.get()` and emit.
 *   - If it's unresolved + expired, `listHistoryByTopic` already
 *     filtered it out via `(resolved_at IS NOT NULL OR expires_at > ?)`,
 *     so we never see it here.
 *
 * Best-effort: every failure is caught + logged + swallowed. A
 * malformed seed row must NEVER block a topic switch / WS connect.
 */
async function reEmitActiveSeedPromptIfAny(input: {
  project_slug: string
  user_id: string
  topic_id: string
  buttonStore: import('../../channels/button-store.ts').ButtonStore | undefined
  send: (event: ChatOutbound) => void
  now: number
  log_tag: string
  /**
   * 2026-05-29 ISSUES #70 — race-safety hook. When provided, the
   * helper invokes it RIGHT BEFORE `send(renderButtonPromptForWeb(...))`
   * and drops the emit (logging `event=seed_reemit_superseded`) if the
   * returned value does not match `input.topic_id`. Used by the
   * `topic_switch` call site to suppress stale seeds when the user
   * rapidly switches topics A → B and the second switch lands between
   * the helper's two DB awaits (`listHistoryByTopic` + `buttonStore.get`).
   *
   * The two non-racing call sites (`startSession`, `resumeCookieSession`)
   * omit this — no prior topic context exists on a fresh WS open, so
   * there is no race surface to protect.
   */
  getActiveTopicId?: () => string | undefined
}): Promise<void> {
  const { buttonStore, send, log_tag } = input
  if (buttonStore === undefined) return
  try {
    const { turns } = await buttonStore.listHistoryByTopic({
      topic_id: input.topic_id,
      before: input.now,
      before_prompt_id: null,
      limit: 1,
      now: input.now,
    })
    if (turns.length === 0) return
    const latest = turns[0]
    if (latest === undefined) return
    if (latest.resolved) return
    const prompt = await buttonStore.get(latest.prompt_id, input.now)
    if (prompt === null) return
    // 2026-05-29 ISSUES #70 — topic-identity guard. Re-read the
    // live `ws.data.active_topic_id` (via the injected callback) and
    // bail if the active topic has moved on while the two DB
    // round-trips above were in flight. Reading the callback at emit
    // time (not at handler entry) is critical — the value is mutated
    // in place by a second `topic_switch` arriving on the same socket.
    if (input.getActiveTopicId !== undefined) {
      const current = input.getActiveTopicId()
      if (current !== undefined && current !== input.topic_id) {
        // console.warn (not info) — a dropped emit matches the
        // convention of `event=fail` rather than `event=emit`; ops
        // will grep this line when chasing UI complaints around
        // rapid-switch flashes.
        console.warn(
          `${log_tag} reEmitActiveSeedPromptIfAny event=seed_reemit_superseded project=${input.project_slug} user=${input.user_id} requested=${input.topic_id} actual=${current} prompt=${latest.prompt_id}`,
        )
        return
      }
    }
    send(renderButtonPromptForWeb(prompt))
    console.info(
      `${log_tag} reEmitActiveSeedPromptIfAny event=emit project=${input.project_slug} user=${input.user_id} topic=${input.topic_id} prompt=${latest.prompt_id}`,
    )
  } catch (err) {
    console.warn(
      `${log_tag} reEmitActiveSeedPromptIfAny event=fail project=${input.project_slug} user=${input.user_id} topic=${input.topic_id} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}
