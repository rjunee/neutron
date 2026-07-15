/**
 * @neutronai/open — app-ws receiver + delivery-sink wiring (C3d, carve #6).
 *
 * Behavior-preserving extraction of the app-ws (React / Expo transport) receiver
 * + delivery cluster of `createOpenComposition` (old `open/composer.ts` lines
 * ~2263-3058): the `appWsHolder` adapter construction, the live-agent reply
 * translator (`buildAppWsSendReply`), the Path-1 closing/opening delivery
 * (`onboardingMsg.emit`), the ephemeral typing + onboarding-prompt + import-
 * progress translators, the engine button-prompt router bind
 * (`appWsButtonPromptRouter.send`), the inbound receiver (`appWsReceiver`), the
 * `createAppWsSurface(...)` construction with its `on_session_open` /
 * `on_button_choice` hooks, the clarifying-question poster bind
 * (`buildClarifyPoster.post`), and the trident terminal-result durable sink
 * (`tridentDeliverySink`, #339).
 *
 * The composer keeps consuming the returned `appWsSurface` verbatim
 * (`app_ws_surface`) + `tridentDeliverySink` (`trident.delivery_sink`).
 *
 * C3d `late<T>` seams (the sanctioned semantic amendment — see `./late.ts`):
 *   - `appWs` (`Late<AppWsAdapter>`) is CREATED BY THE COMPOSER (the composer-
 *     owned `buildAppWsSendReply` — shared with the reminder/brief push registry
 *     — also derefs it), passed in, and BOUND here after `new AppWsAdapter`.
 *     Inside this module, the two `appWsHolder.adapter !== undefined`
 *     presence-checks map onto `appWs.isBound()` + a guarded `appWs.get()!`; the
 *     `?.` fire-paths (`buildClarifyPoster.post`, `tridentDeliverySink`) map onto
 *     `appWs.deref`; the post-bind direct read passed to `createAppWsSurface`
 *     uses the local `appWsAdapter` const.
 *   - `onboardingMsg` (`Late<OnboardingMsgEmit>`) is CREATED BY THE COMPOSER
 *     (it is also deref'd there from `buildOnboardingFinalize`), passed in, and
 *     BOUND here at the SAME sequence point as before. `ensureProjectOpeningOnEntry`
 *     derefs it via `onboardingMsg.deref`.
 *
 * CARE — invariants that MUST survive (pinned by
 * `open/__tests__/open-wiring-app-ws.test.ts` + the composition-fields
 * characterization + the app-ws-scribe/chat-history suites):
 *   - Prod behaviour byte-identical: every `late<T>` deref is still a no-op when
 *     unbound (prod), identical after bind. All binds fire synchronously during
 *     composition, so no runtime path derefs before bind.
 *   - Every side-effect ORDER is preserved: the router/poster/onboarding-emit
 *     binds fire in the same sequence, the adapter is bound only after
 *     `new AppWsAdapter(...)`, and `createAppWsSurface` is constructed after.
 *   - `importWatchHolder` stays a plain composer-owned object (C3b contract with
 *     `wireUploads` is untouched) — threaded in and read verbatim in
 *     `on_session_open`.
 *   - `appWsButtonPromptRouter` / `appWsImportProgressRouter` / `buildClarifyPoster`
 *     stay plain composer-owned holders; this wiring binds their `.send`/`.post`.
 *
 * This is a NEW leaf the composer imports DOWNWARD — it never imports back into
 * `open/composer.ts`. The two pure Open-mode routing helpers
 * (`resolveOpenImportPromptEmission` / `resolveImportRunningStatusDelivery`) MOVED
 * here from the composer (they are app-ws-only); the composer re-exports them for
 * the existing `open-import-analysis-delivery.test.ts`.
 */

import { randomUUID } from 'node:crypto'
import { join as joinPath } from 'node:path'

import { AppWsAdapter } from '@neutronai/channels/adapters/app-ws/adapter.ts'
import { ChannelRouter } from '@neutronai/channels/router.ts'
import {
  createAppWsSurface,
  type AppWsSurface,
} from '@neutronai/gateway/http/app-ws-surface.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { AppWsSessionRegistry } from '@neutronai/channels/adapters/app-ws/session-registry.ts'
import type { ChatCommandFilter } from '@neutronai/contracts/chat-command-filter.ts'
import { buildButtonPrompt, type ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import {
  AppChatStore,
  AppChatReceiptStore,
  AppChatReactionStore,
  AppChatEditStore,
} from '@neutronai/persistence/index.ts'
import {
  appWsTopicId,
  type AppWsOutboundAgentMessage,
  type AppWsOutboundAgentTyping,
  type AppWsOutboundImportProgress,
  type AppWsOutboundOnboardingCompleted,
} from '@neutronai/channels/adapters/app-ws/envelope.ts'
import {
  buildProjectDocReader,
  buildDeterministicProjectOpening,
  finalizeOpeningBody,
  type ProjectOpeningDocs,
} from '@neutronai/gateway/wiring/build-onboarding-handoff.ts'
import type { IncomingEvent, OutgoingMessage } from '@neutronai/channels/types.ts'
import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'
import type { LandingStackWithEngine } from '@neutronai/gateway/wiring/build-landing-stack.ts'
import type { LiveAgentTurnRequest } from '@neutronai/gateway/http/chat-bridge.ts'
import type { LiveAgentTurnResult } from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import type {
  AppSocketButtonPromptRouter,
  AppSocketImportProgressRouter,
} from '@neutronai/gateway/http/chat-bridge.ts'
import type { UserTurnInput } from '@neutronai/scribe/index.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'
import type { Late } from './late.ts'
import type { OpenWiringContext } from './context.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { createLogger } from '@neutronai/logger'
import type { ChannelKind } from '@neutronai/channels/types.ts'

/**
 * X5 — the single `ChannelKind` every Open outbound run carries. Open is
 * single-owner WEB: `work_board_dispatch_build` stamps `app_socket` and the
 * `/code` chat-command filter defaults it, so a terminal delivery always routes
 * to the app-ws adapter. The boot-time `assertAdaptersFor([...])` guard uses
 * this so a dropped adapter registration fails the boot instead of a build's
 * completion silently vanishing.
 */
const OPEN_RUN_CHANNEL_KIND: ChannelKind = 'app_socket'

/**
 * Open-mode app-ws routing decision for an engine-emitted onboarding
 * `ButtonPrompt`. In Path-1/Open the engine no longer drives the conversation
 * (the live CC session does) — it only emits IMPORT-side prompts on this socket.
 *
 * The successful `import_analysis_presented` prompt is special: its accept/resume
 * BUTTON is redundant (the import-completion watcher auto-advances the phase) and
 * a tap would dangle (button choices route to the engine store, not the live
 * session). A prior version suppressed the WHOLE prompt — body included — which
 * meant a real install's import would complete (e.g. 175 conversations, 8
 * projects) but the rich analysis "wow moment" NEVER reached the React chat
 * (2026-06-29 render-gap). The fix: still deliver the analysis BODY (the bulleted
 * project list IS the picker; the user confirms in freeform), but STRIP the
 * dangling button options. Every OTHER prompt — including a FAILED-import
 * analysis / rate-limit / resume prompt the user genuinely needs — emits as-is.
 *
 * Pure + exported for unit coverage; the router (in {@link wireAppWs}) calls this
 * then fans the result over the app-ws registry.
 */
const log = createLogger('open-app-ws')

export function resolveOpenImportPromptEmission(
  prompt: ButtonPrompt,
  phase: string | null,
  importFailed: boolean,
): ButtonPrompt {
  if (phase === 'import_analysis_presented' && !importFailed) {
    return { ...prompt, options: [], allow_freeform: true }
  }
  return prompt
}

export type ImportRunningStatusDelivery = 'durable' | 'suppress' | 'ephemeral'

/**
 * Open-mode delivery decision for the ephemeral import_running "Reading through
 * your export now…" STATUS bubble.
 *
 * Emitted via `emitOnboardingPrompt` it carries NO chat_log `seq`, so chat-core
 * `compareForDisplay` sorts it to the TAIL — it floats below every later
 * real-seq message and stays pinned at the bottom even after the import
 * completes and the analysis + later turns arrive (M1 verify, 2026-06-30; the
 * same ordering seam #130 fixed for the analysis body). The decision:
 *   - 'durable'   — persist the FIRST status bubble through the durable adapter
 *                   (chat_log → monotonic seq) so it orders chronologically,
 *                   mirroring the `import_analysis_presented` body.
 *   - 'suppress'  — drop the engine cron's RE-EMITS (attempt_count > 1): a fresh
 *                   prompt is built each poll, so persisting every one would stack
 *                   duplicate durable bubbles. The single durable bubble plus the
 *                   live `import_progress` banner already cover the running state.
 *   - 'ephemeral' — everything else (failure / rate-limit / resume prompts the
 *                   user must act on, and non-import_running prompts) keeps the
 *                   existing ephemeral path; the engine owns their durability +
 *                   reconnect re-emit.
 *
 * Only the plain no-button progress bubble (`sub_step === 'status'`, zero
 * options) is ever persisted/suppressed; a status variant carrying a button
 * falls through to 'ephemeral'. Pure + exported for unit coverage.
 */
export function resolveImportRunningStatusDelivery(args: {
  phase: string | null
  sub_step: unknown
  attempt_count: unknown
  option_count: number
}): ImportRunningStatusDelivery {
  const { phase, sub_step, attempt_count, option_count } = args
  if (phase !== 'import_running') return 'ephemeral'
  if (sub_step !== 'status') return 'ephemeral'
  if (option_count !== 0) return 'ephemeral'
  const attempts =
    typeof attempt_count === 'number' && Number.isFinite(attempt_count) ? attempt_count : 1
  return attempts <= 1 ? 'durable' : 'suppress'
}

/** The Path-1 closing / per-project opening delivery seam value (`onboardingMsg`). */
export type OnboardingMsgEmit = (input: {
  user_id: string
  project_id: string | null
  body: string
  dedupe_key: string
}) => Promise<void>

/** The rail-row shape the opening-recovery reads (only `id` + `label` consumed). */
type ProjectRailRowLite = { id: string; label: string }

/**
 * The composed dependencies the app-ws cluster reads that the narrow wiring
 * context does NOT carry. Each is threaded verbatim from the composer local of
 * the same name (or a `late<T>` seam / plain holder created upstream).
 */
export interface WireAppWsDeps {
  /**
   * The app-ws adapter `late<T>` seam — CREATED BY THE COMPOSER (its
   * `buildAppWsSendReply` + the reminder/brief push registry deref it too),
   * BOUND here once `new AppWsAdapter` exists.
   */
  appWs: Late<AppWsAdapter>
  /**
   * The composer-owned live-agent reply translator (`ChatOutbound` →
   * `OutgoingMessage` → `appWs.deref(a => a.send)`). STAYS composer-owned because
   * the reminder/brief `appWsAgentPushRegistry` also forwards through it; passed
   * here so the receiver / seed / button-choice / opening paths share one path.
   */
  buildAppWsSendReply: (
    channel_topic_id: string,
    project_id?: string,
  ) => (out: ChatOutbound) => void
  /**
   * The Path-1 closing/opening delivery seam — CREATED BY THE COMPOSER (also
   * deref'd there from `buildOnboardingFinalize.emitChatMessage`), bound here.
   */
  onboardingMsg: Late<OnboardingMsgEmit>
  /**
   * The Path-1 late-bound import-completion watcher holder — a plain
   * composer-owned object shared with `wireUploads` (C3b). Read verbatim in
   * `on_session_open` (restart-resilience re-arm); never converted.
   */
  importWatchHolder: { watch?: (user_id: string) => void }
  /** Composer-owned onboarding button-prompt router; this wiring binds `.send`. */
  appWsButtonPromptRouter: AppSocketButtonPromptRouter
  /** Composer-owned import-progress router; this wiring binds `.send`. */
  appWsImportProgressRouter: AppSocketImportProgressRouter
  /** Composer-owned clarifying-question poster; this wiring binds `.post` (#337). */
  buildClarifyPoster: { post?: (chatId: string, text: string) => void }
  /** The single-owner app-ws session registry (socket fan-out). */
  appWsRegistry: AppWsSessionRegistry
  /** The live-agent turn runner, or null on an LLM-less box. */
  appWsChatTurn: ((turn: LiveAgentTurnRequest) => Promise<LiveAgentTurnResult>) | null
  /** The entity-scribe user-turn hook (undefined on an LLM-less box). */
  scribeOnUserTurn: ((input: UserTurnInput) => void) | undefined
  /** The chained chat-command filter (/note, /remind, /skills, …). */
  chatCommandFilter: ChatCommandFilter
  /** The single-owner localhost-trust app-ws auth resolver (Path A). */
  appOwnerAuth: AppWsAuthResolver
  /**
   * S0 security quick-patch (b) — the per-boot app-ws token. Threaded into
   * `createAppWsSurface` so a BROWSER-origin `/ws/app/chat` upgrade must present
   * exactly it (the guessable `dev:<owner>` bearer is no longer accepted from
   * the web). Native clients (no Origin) are exempt. Same value the owner-gate
   * injects into the page bootstrap.
   */
  appWsToken: string
  /**
   * S2 (b) — TRUE when the gateway binds LOOPBACK (127.0.0.1 dogfood). Loopback
   * keeps today's ergonomics (Origin-less native clients skip the per-boot token
   * gate); a WIDE bind flips it so an Origin-less client on the network must
   * present the token too (it cannot ride the predictable `dev:owner` bearer,
   * which the composer's resolver also refuses on a wide bind).
   */
  bindIsLoopback: boolean
  /** The landing stack — supplies `buttonStore` + `stateStore`. */
  landing: LandingStackWithEngine
  /** Diff-gated rail refresh (no-ops when the snapshot is unchanged). */
  emitProjectsChangedIfChanged: (user_id: string) => void
  /** Build the current `projects_changed` frame for a targeted seed on connect. */
  buildProjectsChangedFrame: () => import('@neutronai/channels/adapters/app-ws/envelope.ts').AppWsOutboundProjectsChanged
  /** True while the owner is still onboarding. */
  isOnboardingActive: (user_id: string) => Promise<boolean>
  /**
   * Authoritative post-import finalize (idempotent). Threaded because it closes
   * over the extractor + probe locals that stay composer-owned.
   */
  finalizeImportOnboardingIfReady: (
    user_id: string,
    st: Awaited<ReturnType<LandingStackWithEngine['stateStore']['get']>>,
  ) => Promise<boolean>
  /** The canonical project-list reader (opening-recovery lookup). */
  readProjectRows: () => ProjectRailRowLite[]
  /** M1 rail `working`-state set of active chat topics (keyed by `railChatKey`). */
  activeChatProjects: Set<string>
  /** Rail-key for a chat topic (General → owner slug; else the project id). */
  railChatKey: (project_id?: string) => string
  /**
   * O6 / #106 — drain any undelivered recovered replies for the just-connected
   * topic, re-emitting each once (deduped in the `RecoveredReplyStore`). Wired by
   * the composer over the SAME `RecoveredReplyStore` the live-agent substrate's
   * `onRecoveredReply` sink persists into, so a reply a crash dropped while the
   * owner was offline is re-pushed the moment they reconnect (the offline
   * counterpart to the sink's live-delivery branch). Omitted on an LLM-less box.
   */
  recoveredReplyDrain?: (channel_topic_id: string) => void
}

export interface WiredAppWs {
  /** The app-ws chat surface; consumed as `app_ws_surface`. */
  appWsSurface: AppWsSurface
  /**
   * X5 — the Open composition's `ChannelRouter` with the durable `AppWsAdapter`
   * registered for `app_socket` (the kind every Open run carries). This is the
   * ONE delivery seam: the composer passes it as `composition.channel_router`
   * (so the graph's `channels` module IS this instance) and uses it as the
   * trident terminal-delivery + board-terminator sink, so a completion posts
   * through `router.send` → the app-ws adapter (durable chat-log persist + live
   * fan-out — the proven steady-state reply path). Replaces the bespoke #339
   * `tridentDeliverySink`, which existed only because the bare router had no
   * adapter registered.
   */
  channelRouter: ChannelRouter
  /** Teardown hooks in registration order (re-registered at the carve site). */
  cleanups: Array<() => void>
}

/**
 * Construct the Open composition's app-ws receiver + delivery cluster from the
 * wiring context plus the composed `deps`. The composer appends the returned
 * `cleanups` onto its `realmodeCleanups` at the carve site and consumes
 * `appWsSurface` + `tridentDeliverySink` verbatim.
 */
export function wireAppWs(ctx: OpenWiringContext, deps: WireAppWsDeps): WiredAppWs {
  const { db, project_slug, owner_home, env } = ctx
  const {
    appWs,
    buildAppWsSendReply,
    onboardingMsg,
    importWatchHolder,
    appWsButtonPromptRouter,
    appWsImportProgressRouter,
    buildClarifyPoster,
    appWsRegistry,
    appWsChatTurn,
    scribeOnUserTurn,
    chatCommandFilter,
    appOwnerAuth,
    appWsToken,
    bindIsLoopback,
    landing,
    emitProjectsChangedIfChanged,
    buildProjectsChangedFrame,
    isOnboardingActive,
    finalizeImportOnboardingIfReady,
    readProjectRows,
    activeChatProjects,
    railChatKey,
    recoveredReplyDrain,
  } = deps
  const cleanups: Array<() => void> = []
  const onboardingStateStore = landing.stateStore

  // Path 1 auto-start de-dupe: topics whose onboarding opener we've already
  // seeded THIS process, so a quick reconnect doesn't double-open the
  // interview. Mirrors the live runner's own per-process `contextSent` guard.
  const seededOnboardingTopics = new Set<string>()
  // Path-1 closing + per-project opening delivery (items 6/7). Deliver a
  // finalize-composed agent message the SAME way a live-agent reply is
  // delivered: persist a durable `button_prompts` history row on the topic
  // (`app:<user>` for the General closing, `app:<user>:<project>` for a
  // project opening) — the topic `chat_history_surface` hydrates from — AND
  // fan it live via `buildAppWsSendReply` (→ adapter durable chat_log + socket
  // push). So the message renders live when the owner is connected and
  // hydrates on reload, exactly like every other agent turn. Best-effort: a
  // persistence failure still ships the live message; nothing throws back into
  // finalize. NOTE (sibling client PR coordination): the React client reads a
  // project's chat off this `app:<user>:<project>` topic — the same key the
  // live-agent reply path uses — so the opening lands where the client subscribes.
  onboardingMsg.bind(async ({ user_id, project_id, body, dedupe_key }): Promise<void> => {
    const channelTopic = appWsTopicId(user_id)
    const turnTopic =
      project_id !== null && project_id.length > 0
        ? `${channelTopic}:${project_id}`
        : channelTopic
    let prompt_id: string | undefined
    // Idempotency: finalize is reachable from several overlapping recovery
    // paths, so key the durable row on (instance, topic, dedupe_key). A
    // re-finalize collapses onto the SAME row (was_new=false) and we SKIP the
    // live re-send below — no duplicate closing / opening bubble. Default to
    // sending (fail-open) only when persistence itself failed (no key written).
    let wasNew = true
    try {
      const prompt = buildButtonPrompt({
        body,
        options: [],
        allow_freeform: true,
        // Long TTL so the history row never hits the unresolved-prompt ghost
        // filter (mirrors the live-agent reply row's REPLY_ROW_TTL_MS).
        expires_in_ms: 10 * 365 * 24 * 60 * 60 * 1_000,
        idempotency: { project_slug, topic_id: turnTopic, seed: dedupe_key },
        uuid: randomUUID,
      })
      const emitted = await landing.buttonStore.emit(prompt, { topic_id: turnTopic })
      prompt_id = emitted.prompt_id
      wasNew = emitted.was_new
    } catch (err) {
      log.warn('onboarding_msg_persist_failed', {
        project: project_slug,
        topic: turnTopic,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    // A duplicate finalize already delivered this message — don't re-post it live.
    if (!wasNew) return
    const out: ChatOutbound = {
      type: 'agent_message',
      body,
      topic_id: turnTopic,
      options: [],
      allow_freeform: true,
      ...(prompt_id !== undefined ? { prompt_id } : {}),
    }
    // Live-fan on the SAME topic the durable row landed on: a per-project opening
    // must reach the PROJECT socket (`app:<user>:<project>`), not General — the
    // app-ws adapter routes + appends chat_log by `topic.channel_topic_id`, and a
    // project tab is registered under the project topic (Codex r1 P2, 2026-06-30).
    // Sending on General delivered the durable row but NEVER live-rendered to the
    // just-connected project socket, so the project-opening RECOVERY (which fires
    // from a project-topic `on_session_open`, AFTER its `session_ready` history
    // replay) left the tab empty until yet another reload. The General closing
    // (`project_id === null`) still fans on the General channel, unchanged.
    const liveChannel =
      project_id !== null && project_id.length > 0 ? turnTopic : channelTopic
    buildAppWsSendReply(liveChannel, project_id ?? undefined)(out)
  })
  // Item 1 / 4b (2026-06-30 fresh-install fix) — make a materialized project's
  // deterministic OPENING a reliable property of ENTERING the project, not a
  // fire-once side effect of finalize. finalize emits each opening eagerly at
  // onboarding completion, but that emit can race the project-tab socket, be
  // swallowed, or (under cold-turn load) the whole finalize can be delayed —
  // leaving the project topic with ZERO history rows (DB-confirmed on the live
  // box: 6 projects, 0 `app:<user>:<project>` rows) so the client wedges on its
  // empty state and a reload never recovers it (reload only regenerated the
  // GENERAL welcome). On every steady-state connect to a PROJECT topic that has
  // no message yet, regenerate + persist the SAME deterministic opening
  // (STATUS.md / README summary + one next move) finalize would have produced.
  // Idempotent: keyed on `onboarding_opening:<project_id>`, so if finalize (or a
  // prior entry) already delivered it, `buttonStore.emit` collapses onto the
  // existing row and nothing double-posts. Best-effort + non-throwing — a
  // project chat must NEVER be blocked by opening recovery.
  const onboardingOpeningDocReader = buildProjectDocReader({ owner_home })
  const ensureProjectOpeningOnEntry = async (
    user_id: string,
    channel_topic_id: string,
  ): Promise<void> => {
    try {
      const prefix = `${appWsTopicId(user_id)}:`
      // Only a per-project topic (`app:<user>:<project_id>`) — the General topic
      // has no per-project opening.
      if (!channel_topic_id.startsWith(prefix)) return
      const project_id = channel_topic_id.slice(prefix.length)
      if (project_id.length === 0) return
      // Only for a MATERIALIZED, non-deleted project — never seed an arbitrary
      // or soft-deleted topic. `readProjectRows` is the same `projects`-table
      // snapshot the rail + bootstrap use, so the id + name align exactly.
      const row = readProjectRows().find((p) => p.id === project_id)
      if (row === undefined) return
      // Only when the topic has NO message yet — never retro-inject an opening
      // above an existing conversation.
      const now = Date.now()
      const latest = await landing.buttonStore.latestTurnByTopic({
        topic_id: channel_topic_id,
        before: now,
        now,
      })
      if (latest !== null) return
      // Compose the SAME deterministic opening finalize uses, from the
      // materialized docs (STATUS.md is the highest-signal source; README is the
      // fallback; the composer degrades to a usable "added to your projects"
      // line when neither exists — so the body is NEVER empty).
      const docs: ProjectOpeningDocs = {
        readme: onboardingOpeningDocReader(project_id, 'README.md'),
        transcript_summary: onboardingOpeningDocReader(
          project_id,
          joinPath('docs', 'transcript-summary.md'),
        ),
        status_md: onboardingOpeningDocReader(project_id, 'STATUS.md'),
      }
      const composition = buildDeterministicProjectOpening(row.label, null, docs)
      const body = finalizeOpeningBody(composition.body)
      if (body.trim().length === 0) return
      await onboardingMsg.deref((emit) =>
        emit({
          user_id,
          project_id,
          body,
          dedupe_key: `onboarding_opening:${project_id}`,
        }),
      )
    } catch (err) {
      log.warn('project_opening_recovery_failed', {
        project: project_slug,
        topic: channel_topic_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // Chat transport — server-authoritative typing indicator. Fan an ephemeral
  // `agent_typing` frame (start/end) directly to the socket topic's live
  // devices around every live-agent turn. NOT routed through the adapter's
  // `send` (which persists + assigns a seq) — typing is ephemeral and must
  // never land in the durable log or a `resume` replay. Best-effort: a closed
  // socket / registry miss is a silent no-op (the client clears typing on the
  // next agent_message regardless, so a lost `end` can't wedge the dots).
  const emitAppWsTyping = (
    channel_topic_id: string,
    state: 'start' | 'end',
    project_id?: string,
  ): void => {
    // M1 UX REDESIGN — track the live chat turn for the rail's `working` state.
    // `start`/`end` bracket every live-agent turn, so this is the composer-known
    // "chat turn in progress" signal `readProjectRailExtras` reads.
    if (state === 'start') activeChatProjects.add(railChatKey(project_id))
    else activeChatProjects.delete(railChatKey(project_id))
    const env: AppWsOutboundAgentTyping = {
      v: 1,
      type: 'agent_typing',
      state,
      ts: Date.now(),
    }
    if (project_id !== undefined && project_id.length > 0) env.project_id = project_id
    try {
      appWsRegistry.send(channel_topic_id, env)
    } catch {
      /* socket closed mid-turn; the start/end pair is best-effort */
    }
    // M1 UX REDESIGN — the chat turn just started/ended, so this project's rail
    // `activity` flipped working↔idle. Fan a fresh `projects_changed` (diff-gated
    // — no-ops when the rail snapshot is unchanged) so the rail updates live.
    try {
      emitProjectsChangedIfChanged(OWNER_USER_ID)
    } catch {
      /* rail refresh is best-effort — never let it break the typing emit */
    }
  }
  // Translate an engine `ButtonPrompt` → the app-ws `agent_message` envelope
  // (a superset already carrying options/prompt_id/allow_freeform/kind/
  // upload_affordance) and fan it out over the socket. Ephemeral by design:
  // the engine owns durability via `button_prompts` + an idempotent re-emit on
  // the next connect (`on_session_open` below), so we do NOT persist onboarding
  // prompts into the steady-state app chat log (which would double-render on a
  // `resume` replay).
  const emitOnboardingPrompt = (topic_id: string, prompt: ButtonPrompt): boolean => {
    const env: AppWsOutboundAgentMessage = {
      v: 1,
      type: 'agent_message',
      body: prompt.body,
      message_id: prompt.prompt_id,
      ts: Date.now(),
      prompt_id: prompt.prompt_id,
      options: prompt.options.map((o) => ({
        label: o.label,
        body: o.body,
        value: o.value,
        ...(o.image_url !== undefined ? { image_url: o.image_url } : {}),
      })),
      allow_freeform: prompt.allow_freeform,
    }
    if (prompt.kind !== undefined) env.kind = prompt.kind
    const rawAff = (prompt.metadata as Record<string, unknown> | undefined)?.['upload_affordance']
    if (rawAff !== null && typeof rawAff === 'object') {
      const src = (rawAff as { source?: unknown }).source
      if (src === 'chatgpt' || src === 'claude') env.upload_affordance = { source: src }
      // Legacy two-upload 'both' normalizes to 'chatgpt' (mirrors chat-bridge).
      else if (src === 'both') env.upload_affordance = { source: 'chatgpt' }
    }
    return appWsRegistry.send(topic_id, env)
  }
  // Path 1: onboarding conversational turns no longer go through
  // `engine.advance` — they run on the live session (see `appWsReceiver` /
  // `on_button_choice` below). The engine is retained ONLY for the import
  // subsystem (`notifyImportUpload`), so its button-prompt router is still
  // wired below for any import-side prompt it may emit.
  // Fill the late-bound onboarding button-prompt router NOW that the registry
  // exists. The engine's `sendButtonPrompt` reads this holder at call time
  // (see buildRoutedSendButtonPrompt) — `app:<user>` topics route here.
  //
  // Path 1: the engine no longer drives the conversation. Its prompts on this
  // socket are import-side only. We SUPPRESS exactly one: the SUCCESSFUL
  // `import_analysis_presented` accept button — that flow is auto-consumed by
  // the import-completion watcher (materialize without a tap), so a stray
  // "accept these projects" button would dangle (its tap routes to the live
  // session, not the engine). Every OTHER engine prompt — an import
  // parse-failure / rate-limit / resume prompt the user genuinely needs to see
  // — is emitted normally (Codex r1 [P1]). Single-owner Open has exactly one
  // onboarding user, so we key the phase lookup on the owner.
  appWsButtonPromptRouter.send = async ({ topic_id, prompt }) => {
    try {
      const st = await onboardingStateStore.get(project_slug, OWNER_USER_ID)
      const importFailed = st?.phase_state?.['import_failed'] === true
      // 2026-06-29 render-gap fix — for the successful import_analysis_presented
      // prompt, emit the rich analysis BODY (the "wow moment") with the dangling
      // accept/resume button STRIPPED, instead of suppressing the whole prompt
      // (which left the owner never seeing their import result). See
      // resolveOpenImportPromptEmission for the rationale.
      const toEmit = resolveOpenImportPromptEmission(prompt, st?.phase ?? null, importFailed)
      // Ordering fix (import-curation handoff, 2026-06-29): the SUCCESSFUL
      // import_analysis_presented body is a plain "wow moment" agent message
      // (its dangling button is stripped above, and the watcher auto-consumes
      // the phase). Delivered ephemerally via emitOnboardingPrompt it carries NO
      // chat_log `seq`, so the client sorts it to the tail and a later real-seq
      // user message renders ABOVE it (newest-at-bottom broken) — and it
      // vanishes on resume. Persist THIS one through the durable adapter
      // (chat_log → monotonic seq, replayable) so it orders with live chat.
      // Safe from double-render: on_session_open never re-sends the body, and
      // the watcher resolves the phase (active_prompt_id→null) so the engine's
      // reconnect re-emit won't re-fire it. Every OTHER onboarding prompt
      // (import failure / rate-limit / resume — real buttons) stays ephemeral,
      // since the engine owns their durability + reconnect re-emit.
      if (
        st?.phase === 'import_analysis_presented' &&
        !importFailed &&
        toEmit.options.length === 0 &&
        appWs.isBound()
      ) {
        const msg: OutgoingMessage = {
          topic: {
            topic_id: '',
            channel_kind: 'app_socket',
            channel_topic_id: topic_id,
            project_id: null,
            privacy_mode: 'regular',
          },
          text: toEmit.body,
        }
        const id = await appWs.get()!.send(msg)
        return {
          message_id: prompt.prompt_id,
          // Neither a `dropped` (persisted-but-offline) nor a `lost` (captured
          // nowhere) marker is a live delivery.
          was_new: !id.startsWith('app-ws:dropped:') && !id.startsWith('app-ws:lost:'),
        }
      }
      // Ordering + de-dupe fix (import_running status bubble, M1 2026-06-30):
      // the "Reading through your export now…" progress bubble is buttonless
      // and ephemeral, so it sorts to the chat tail and floats below later
      // messages (same seam as the analysis body above). Persist the FIRST one
      // durably (chronological seq); suppress the engine cron's re-emits so we
      // don't stack duplicates — the live import_progress banner covers ongoing
      // progress and the durable analysis body lands after on completion.
      const statusDelivery = resolveImportRunningStatusDelivery({
        phase: st?.phase ?? null,
        sub_step: st?.phase_state?.['import_running_sub_step'],
        attempt_count: st?.phase_state?.['import_running_attempt_count'],
        option_count: toEmit.options.length,
      })
      if (statusDelivery === 'suppress') {
        return { message_id: prompt.prompt_id, was_new: false }
      }
      if (statusDelivery === 'durable' && appWs.isBound()) {
        const msg: OutgoingMessage = {
          topic: {
            topic_id: '',
            channel_kind: 'app_socket',
            channel_topic_id: topic_id,
            project_id: null,
            privacy_mode: 'regular',
          },
          text: toEmit.body,
        }
        const id = await appWs.get()!.send(msg)
        return {
          message_id: prompt.prompt_id,
          // Neither a `dropped` (persisted-but-offline) nor a `lost` (captured
          // nowhere) marker is a live delivery.
          was_new: !id.startsWith('app-ws:dropped:') && !id.startsWith('app-ws:lost:'),
        }
      }
      const ok = emitOnboardingPrompt(topic_id, toEmit)
      return { message_id: prompt.prompt_id, was_new: ok }
    } catch {
      // Any lookup failure → fall through and emit (fail open, user sees it).
    }
    const ok = emitOnboardingPrompt(topic_id, prompt)
    return { message_id: prompt.prompt_id, was_new: ok }
  }
  // Import-progress over app-ws (2026-06-29): the engine's import-running cron
  // emits an `import_progress` event every ~5s while a history import runs, and
  // `buildRoutedSendImportProgress` routes `app:<user>` topics to this holder.
  // Fan it to the owner's live socket as an ephemeral `import_progress` frame
  // (mirrors `emitAppWsTyping` / `work_board_changed`): the React client renders
  // a live spinner + per-pass progress line off it, so a long import visibly
  // works instead of stalling on the one-shot "received" banner. UI-only — NOT
  // persisted, no `seq`, never replayed on `resume`. Terminal statuses still
  // deliver their analysis body via the button-prompt path above; a terminal
  // frame here just clears the client's spinner defensively. Best-effort: a
  // closed socket / registry miss is a silent non-delivery (re-emitted next tick).
  appWsImportProgressRouter.send = async ({ topic_id, event }) => {
    const env: AppWsOutboundImportProgress = {
      v: 1,
      type: 'import_progress',
      job_id: event.job_id,
      status: event.status,
      pass: event.pass,
      pct: event.pct,
      chunks_total_known: event.chunks_total_known,
      ts: Date.now(),
    }
    if (event.body !== undefined) env.body = event.body
    try {
      return { delivered: appWsRegistry.send(topic_id, env) }
    } catch {
      return { delivered: false }
    }
  }

  const appWsReceiver = {
    receive: async (event: IncomingEvent): Promise<void> => {
      if (event.channel_kind !== 'app_socket') return
      const text = event.body.text.trim()
      // Codex r1 [P2]: an attachment-only send arrives with empty text but
      // non-empty `adapter_metadata.attachments`; dropping on empty text alone
      // would swallow the turn after the echo/read-receipt (user sees no
      // reply). Only drop a TRULY empty inbound (no text AND no attachments);
      // for attachment-only, run the turn with a minimal placeholder so the
      // agent responds. (Full attachment content isn't yet threaded into
      // `LiveAgentTurnRequest` — its interface carries only `user_text`; that
      // deeper wiring is a separate follow-up, but we no longer silently drop.)
      const attachments = Array.isArray(event.adapter_metadata?.['attachments'])
        ? (event.adapter_metadata!['attachments'] as unknown[])
        : []
      if (text.length === 0 && attachments.length === 0) return
      const userText = text.length > 0 ? text : 'Sent an attachment.'
      // Path 1: ONE path. Every typed turn — onboarding OR steady-state — runs
      // through the SAME live CC session (`appWsChatTurn`). While the owner
      // isn't onboarded the live agent's onboarding seam carries the interview
      // preamble + zip affordance and the fire-and-forget post-turn extractor
      // scribes the profile. No `engine.advance`, no freeform router gate.
      const project_id =
        typeof event.adapter_metadata?.['project_id'] === 'string'
          ? (event.adapter_metadata['project_id'] as string)
          : undefined
      // The live-agent turn is keyed on a PROJECT-SCOPED warm-session topic
      // (`app:<owner>:<project_id>`) so each project gets its own warm REPL +
      // persona + button-store history (sharing the bare channel topic across
      // projects would cross-ground them).
      //   - The WEB client now binds the SOCKET per-project, so
      //     `event.channel_topic_id` is ALREADY `app:<owner>:<project_id>` —
      //     re-appending would double the suffix, so skip it when the topic
      //     already ends with `:<project_id>`.
      //   - MOBILE keeps ONE `app:<owner>` socket + a `project_id` FIELD, so
      //     the suffix IS appended there (the topic is the bare `app:<owner>`).
      // The REPLY is still delivered to the socket's real `channel_topic_id`
      // (below), since that's where the client listens.
      const turnTopicId =
        project_id !== undefined &&
        project_id.length > 0 &&
        !event.channel_topic_id.endsWith(`:${project_id}`)
          ? `${event.channel_topic_id}:${project_id}`
          : event.channel_topic_id
      const sendReply = buildAppWsSendReply(event.channel_topic_id, project_id)
      if (appWsChatTurn === null) {
        sendReply({
          type: 'agent_message',
          body:
            "I can't answer yet — this box has no AI credential configured. Add one in settings, then try again.",
        })
        // FIX 1 (#85) — still surface any project-set change (e.g. an import
        // that landed) so the rail refreshes even on the LLM-less path.
        emitProjectsChangedIfChanged(event.user.channel_user_id)
        return
      }
      // Chat transport — server-authoritative typing. Show the indicator the
      // moment the gateway picks up the turn; clear it when the turn settles
      // (finally → fires on success AND failure so the dots never wedge).
      emitAppWsTyping(event.channel_topic_id, 'start', project_id)
      try {
        await appWsChatTurn({
          project_slug,
          user_id: event.user.channel_user_id,
          // Project-scoped for warm-session/persona/history keying (Codex [P2]).
          topic_id: turnTopicId,
          ...(project_id !== undefined ? { project_id } : {}),
          user_text: userText,
          send: sendReply,
          observed_at: event.received_at,
        })
      } finally {
        emitAppWsTyping(event.channel_topic_id, 'end', project_id)
      }
      // Entity scribe → GBrain (Vajra parity) — fan the user's turn into the
      // extract→memory path, fire-and-forget + guarded, EXACTLY like the legacy
      // web chat-bridge does (chat-bridge.ts §scribe-phase-1). This was the ONLY
      // surface missing it: `/ws/app/chat` (the sole chat surface the React owner
      // UI uses) dispatches here, so without this call NO post-onboarding chat
      // turn ever extracted facts to gbrain — the store stayed empty and "recall"
      // silently fell back to in-session CC context only (fullpipe-e2e 2026-06-28
      // Stage 2 root-cause). NOTE: the onboarding seam's `onTurnComplete` (inside
      // `appWsChatTurn`) extracts the 5 PROFILE fields; this is the GENERAL entity
      // scribe (people/companies/concepts → gbrain), a distinct layer. Short turns
      // and slash commands are dropped by the scribe's own `shouldExtract` filter,
      // so seed/utility turns cost nothing. `scribeOnUserTurn` is omitted on
      // LLM-less boxes (no extractor) → this no-ops, chat path unaffected.
      if (scribeOnUserTurn !== undefined) {
        try {
          scribeOnUserTurn({
            project_slug,
            user_id: event.user.channel_user_id,
            topic_id: turnTopicId,
            text: userText,
            observed_at: event.received_at,
            // Owner-native web-chat turn → author #0 (connect-spec §4.1).
            author: { id: 'owner', display: 'owner' },
          })
        } catch (err) {
          log.warn('scribe_hook_threw', {
            project: project_slug,
            topic: turnTopicId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      // FIX 1 (#85) — re-wired into Path 1: after every turn, fan a
      // projects_changed frame if the set changed. Onboarding completion +
      // import materialize projects out-of-band (the fire-and-forget finalize
      // also emits directly when it creates them), so this per-turn snapshot
      // diff catches anything not already pushed — the rail refreshes live.
      emitProjectsChangedIfChanged(event.user.channel_user_id)
    },
  }
  // Chat transport (Ryan-directed best-in-class) — wire the durable per-topic
  // logs onto the app-ws adapter. ALL four back the single-owner project.db
  // (migrations 0079/0082/0083/0087). Passing them flips `hasChatLog` /
  // `hasReceipts` / `hasReactions` / `hasEdits` true, which lights up the
  // already-built surface machinery that was inert in M1:
  //   • durable chat_log + monotonic per-topic seq on every echo/agent_message
  //   • idempotent ingest on client_msg_id → the retry button + WS↔HTTP race
  //     NEVER re-run the agent turn (the `if (!was_new) return` guards trip)
  //   • `resume`/`session_ready.last_seen_seq` gap-free reconnect replay
  //   • delivered/read receipts, reactions, and edit/delete — persisted + fanned
  const appWsAdapter = new AppWsAdapter({
    registry: appWsRegistry,
    receiver: appWsReceiver,
    chat_log: new AppChatStore({ db }),
    receipt_log: new AppChatReceiptStore({ db }),
    reaction_log: new AppChatReactionStore({ db }),
    edit_log: new AppChatEditStore({ db }),
  })
  appWs.bind(appWsAdapter)
  // X5 — the ONE delivery seam. Register the durable app-ws adapter on a real
  // `ChannelRouter` so `router.send` is LIVE for Open (previously the bare router
  // had zero adapters and every `send` threw "no channel adapter registered" —
  // masked only because no Open path set `run.chat_id` on a non-app_socket kind).
  // The composer passes this instance as `composition.channel_router` (the graph
  // reuses it) and routes trident terminal delivery + the board terminator through
  // it. `topic_handler` is a no-op: Open's app-ws INBOUND path runs through
  // `appWsReceiver` directly (above), never `router.receive`, so the router is a
  // pure OUTBOUND sink here.
  const channelRouter = new ChannelRouter(db, project_slug, async () => undefined)
  channelRouter.registerAdapter(appWsAdapter)
  // Boot-time conformance guard: every Open trident run is stamped `app_socket`
  // (`work_board_dispatch_build` + the `/code` chat-command filter), so assert an
  // adapter exists for it — a dropped registration fails LOUD here instead of
  // silently dropping a build's completion announce.
  channelRouter.assertAdaptersFor([OPEN_RUN_CHANNEL_KIND])
  // #337 — bind the clarifying-question poster now the app-ws adapter exists.
  // `AppWsAdapter.send` persists the message (durable, survives reconnect) AND
  // fans it live, so the ▶ route's clarifying question lands in the chat topic
  // exactly like a normal agent reply.
  buildClarifyPoster.post = (chatId: string, text: string): void => {
    fireAndForget('app-ws.deref', appWs.deref((adapter) =>
      adapter.send({
        topic: {
          topic_id: '',
          channel_kind: 'app_socket',
          channel_topic_id: chatId,
          project_id: null,
          privacy_mode: 'regular',
        },
        text,
      }),
    ))
  }
  const appWsSurface = createAppWsSurface({
    adapter: appWsAdapter,
    registry: appWsRegistry,
    auth: appOwnerAuth,
    project_slug,
    // S0 (b) — require the per-boot token on browser-origin WS upgrades.
    app_ws_token: appWsToken,
    // S2 (b) — on a WIDE bind, Origin-less clients must present the token too
    // (they cannot ride the predictable `dev:owner` bearer from the network).
    // Loopback keeps native dev clients token-free.
    require_token_without_origin: !bindIsLoopback,
    // S2 (a) — also allow the configured owner web origin (NEUTRON_WEB_APP_BASE)
    // so a reverse-proxied deploy (web app served from a different origin than
    // the gateway Host) still connects; a bare same-origin check would reject
    // it. Empty entry is dropped by the surface, so a loopback dogfood box
    // (NEUTRON_WEB_APP_BASE unset) stays same-origin-only.
    allowed_web_origins: [env['NEUTRON_WEB_APP_BASE'] ?? ''],
    // Codex r1 [P2]: route slash commands (/note, /remind, /skills, …) through
    // the SAME chained filter the web chat uses — parity, not a second path.
    chat_command_filter: chatCommandFilter,
    // Path 1 auto-start — when the owner hasn't finished onboarding, SEED the
    // first onboarding turn through the live session on connect so Claude opens
    // with the first question under the client's auto-start loader (no user
    // message needed). The seed is a synthetic system-origin turn
    // (`seed_turn: true`) — it is NOT persisted as a user bubble and is NOT
    // scribed. The warm session is keyed per-process, so a reconnect within the
    // same process won't re-seed a duplicate opener (`contextSent` guard in the
    // live-agent runner); a fresh process re-seeds, which only repaints the
    // opening question — acceptable and idempotent enough for the loader.
    on_session_open: async ({ user_id, channel_topic_id }) => {
      // FIX 1 (#85) — seed the projects rail baseline on connect (only records
      // the pre-existing set; the post-emit below catches a seed-driven change).
      emitProjectsChangedIfChanged(user_id)
      // M1 UX REDESIGN PR-6 — the diff-gated seed above only SENDS on a real
      // change, so a freshly-connected client (notably the mobile project rail)
      // would show stale rail state (no activity dots / Work-tab badge) whenever
      // another session already consumed the current snapshot. Push the current
      // snapshot straight to the just-connected topic so its rail is correct on
      // open. Targeted to this one topic (not a broadcast) and an idempotent
      // full-list apply, so a redundant delivery to a co-topic session is a
      // harmless no-op — it never disturbs the diff baseline.
      appWsRegistry.send(channel_topic_id, buildProjectsChangedFrame())
      // O6 / #106 — drain any recovered replies buffered for this topic while the
      // owner was offline (the offline counterpart to the substrate's live-delivery
      // sink). Idempotent + a no-op when the store is empty, so it is safe on EVERY
      // reconnect (General or project topic) regardless of onboarding state.
      recoveredReplyDrain?.(channel_topic_id)
      if (await isOnboardingActive(user_id)) {
        // RECOVERY (M1 E2E Round 4, 2026-06-29) — finalize a post-import
        // onboarding that was consumed back into the conversational marker but
        // never finalized: the owner answered every field while the import was
        // synthesizing, the import landed, and they went idle (or a restart
        // landed between the watcher's consume and a finalize). On-reconnect is
        // the natural recovery point. No-op unless every required field is
        // present and no import is in flight; finalize is idempotent.
        const recoverSt = await onboardingStateStore.get(project_slug, user_id)
        if (await finalizeImportOnboardingIfReady(user_id, recoverSt)) {
          emitProjectsChangedIfChanged(user_id)
          return
        }
        // RESTART RESILIENCE (M1 E2E Round 2, 2026-06-29) — re-arm the import-
        // completion watcher on reconnect. The watcher is a purely in-memory
        // `setTimeout` chain armed ONLY inside `notifyImportUpload` (the upload
        // request). It is the single consumer of `import_analysis_presented`:
        // it transitions that phase back to `work_interview_gap_fill` so the
        // interview can finish + materialize the imported projects, and the
        // accept button for that phase is deliberately SUPPRESSED on the
        // assumption the watcher auto-consumes it. So if the server restarts
        // mid-import (redeploy / crash / `launchctl kickstart`), the watcher is
        // gone, the import-running cron (which DOES re-arm on boot) drives the
        // persisted row into `import_analysis_presented`, and nothing ever
        // consumes it — the button is hidden and the post-turn extractor refuses
        // to finalize on top of an import phase. Onboarding wedges PERMANENTLY.
        // Re-arm here (idempotent — `importWatchActive` guards a double-arm)
        // whenever the persisted phase is import-active, so a reconnect after a
        // restart resumes the consume. No-op when no import is in flight.
        if (importWatchHolder.watch !== undefined) {
          const st = await onboardingStateStore.get(project_slug, user_id)
          if (
            st !== null &&
            (st.phase === 'import_running' || st.phase === 'import_analysis_presented')
          ) {
            importWatchHolder.watch(user_id)
          }
        }
        // Onboarding is a GENERAL-TOPIC-ONLY mode: the welcome seed belongs to
        // the owner's General topic (`app:<user>`). The web client opens a
        // fresh socket per PROJECT tab (`app:<user>:<project>`), which also
        // lands here — and a project tab opened while `isOnboardingActive` is
        // still true (fire-and-forget finalize slow, or its terminal
        // `completed` upsert raced/failed) would otherwise seed the generic
        // "…what should I call you?" welcome INTO the project topic, masking
        // the deterministic per-project opening finalize already delivered. A
        // materialized project is always steady-state, so never seed it.
        const isGeneralTopic = channel_topic_id === appWsTopicId(user_id)
        if (
          isGeneralTopic &&
          appWsChatTurn !== null &&
          !seededOnboardingTopics.has(channel_topic_id)
        ) {
          seededOnboardingTopics.add(channel_topic_id)
          // Typing while the agent composes its onboarding opener.
          emitAppWsTyping(channel_topic_id, 'start')
          try {
            const seedResult = await appWsChatTurn({
              project_slug,
              user_id,
              topic_id: channel_topic_id,
              user_text:
                '(The owner just opened the chat to begin onboarding. Greet them warmly by opening the conversation and asking your very first question now — start by asking what they would like you to call them. Do not wait for them to speak first.)',
              send: buildAppWsSendReply(channel_topic_id),
              observed_at: Date.now(),
              seed_turn: true,
            })
            // Self-heal a FAILED welcome seed (e.g. a cold spawn that still
            // timed out): the live runner stays silent on a seed failure (no
            // persisted error bubble), so CLEAR the per-process seeded mark
            // here too — otherwise this topic stays "seeded" for the process
            // and a reload/re-subscribe would skip re-firing, stranding the
            // owner on the empty "Setting things up…" loader. Dropping the mark
            // makes the next on_session_open regenerate the welcome.
            if (
              seedResult !== null &&
              typeof seedResult === 'object' &&
              (seedResult as { outcome?: unknown }).outcome === 'failed'
            ) {
              seededOnboardingTopics.delete(channel_topic_id)
            }
          } catch {
            // A throw (defensive — the runner owns its failures) must also not
            // leave the topic falsely marked seeded; let reload re-fire.
            seededOnboardingTopics.delete(channel_topic_id)
          } finally {
            emitAppWsTyping(channel_topic_id, 'end')
          }
        }
      } else {
        // STEADY STATE (onboarding done). If this connect is to a materialized
        // PROJECT topic that has no message yet, regenerate + persist its
        // deterministic opening (item 1 / 4b). No-op for the General topic, an
        // unmaterialized topic, or a project that already has chat history.
        await ensureProjectOpeningOnEntry(user_id, channel_topic_id)
        // RECOVERY (Managed post-onboarding claim redirect) — replay the one-
        // shot `onboarding_completed` signal on connect for an already-completed
        // owner when a claim URL is configured. The live frame fanned at
        // finalize is DROPPED if no socket was registered then (e.g. a
        // background import-completion watcher finalizes while the tab is
        // closed/reloading), and a reconnect sees an already-`completed` row so
        // nothing re-signals — the redirect would be lost forever. Deriving it
        // from the persisted completed state here makes it recoverable. Gated on
        // the env so it is a strict NO-OP on Open self-host; sent only to the
        // connecting topic. The client's `claimRedirected` latch keeps it at-
        // most-once per load, and once the owner claims they move to a host
        // without the env, so this never loops post-claim.
        const claimUrl = env['NEUTRON_POST_ONBOARDING_CLAIM_URL']
        if (typeof claimUrl === 'string' && claimUrl.length > 0) {
          // This branch is reached for BOTH terminal phases (`isOnboardingActive`
          // is false for `completed` AND `failed`), so gate strictly on the
          // persisted phase being exactly `completed` — a `failed` onboarding
          // never had the completion transition and must NOT redirect to claim.
          const st = await onboardingStateStore.get(project_slug, user_id)
          if (st !== null && st.phase === 'completed') {
            const completedFrame: AppWsOutboundOnboardingCompleted = {
              v: 1,
              type: 'onboarding_completed',
              ts: Date.now(),
            }
            appWsRegistry.send(channel_topic_id, completedFrame)
          }
        }
      }
      // Emit if the seed turn (or anything since the pre-seed) changed the set.
      emitProjectsChangedIfChanged(user_id)
    },
    // Path 1: ONE path — a tapped quick-reply button feeds the live session as
    // the owner's selection (its freeform text, else the choice value),
    // onboarding OR steady-state. No `engine.advance` branch (the engine no
    // longer drives conversational turns). `prompt_id` is unused now that taps
    // don't resolve engine button rows; the live runner persists the turn.
    on_button_choice: async ({
      user_id,
      channel_topic_id,
      project_id,
      choice_value,
      freeform_text,
    }) => {
      const now = Date.now()
      if (appWsChatTurn === null) return
      const turnTopicId =
        project_id !== undefined && project_id.length > 0
          ? `${appWsTopicId(user_id)}:${project_id}`
          : appWsTopicId(user_id)
      const replyText =
        freeform_text !== undefined && freeform_text.length > 0 ? freeform_text : choice_value
      // Typing while the agent works the tapped quick-reply as a turn.
      emitAppWsTyping(channel_topic_id, 'start', project_id)
      try {
        await appWsChatTurn({
          project_slug,
          user_id,
          topic_id: turnTopicId,
          ...(project_id !== undefined ? { project_id } : {}),
          user_text: replyText,
          send: buildAppWsSendReply(channel_topic_id, project_id),
          observed_at: now,
        })
      } finally {
        emitAppWsTyping(channel_topic_id, 'end', project_id)
      }
      // Entity scribe → GBrain (parity with the typed-message receiver above):
      // a freeform quick-reply answer is owner text worth extracting too, so a
      // long freeform reply doesn't silently skip memory just because it arrived
      // via a button prompt instead of the composer. Short choice values are
      // dropped by the scribe's own `shouldExtract` floor, so a bare tap costs
      // nothing. Fire-and-forget + guarded; omitted on LLM-less boxes.
      if (scribeOnUserTurn !== undefined) {
        try {
          scribeOnUserTurn({
            project_slug,
            user_id,
            topic_id: turnTopicId,
            text: replyText,
            observed_at: now,
            author: { id: 'owner', display: 'owner' },
          })
        } catch (err) {
          log.warn('scribe_hook_threw', {
            project: project_slug,
            topic: turnTopicId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      // FIX 1 (#85) — refresh the rail if this turn changed the project set.
      emitProjectsChangedIfChanged(user_id)
    },
  })

  // X5 — trident terminal delivery + the board terminator now post through
  // `channelRouter.send` (built above with the app-ws adapter registered).
  // `router.send` for an `app_socket` topic dispatches to the SAME
  // `AppWsAdapter.send` the bespoke #339 sink deref'd — durable chat-log persist
  // (survives reconnect) + live fan-out — so a build's completion still announces
  // in chat exactly as before, now through the one real seam.
  return { appWsSurface, channelRouter, cleanups }
}
