/**
 * @neutronai/gateway/realmode-composer — LLM phase-spec resolver factory.
 *
 * Sprint: LLM-driven onboarding prompts (2026-05-09).
 * Architecture: docs/research/onboarding-llm-prompts-architecture-2026-05-09.md
 *
 * Wires a pre-built `Substrate` (from `buildLlmCallSubstrate(...)`) +
 * the `WebChatSenderRegistry` (for typing-indicator emission) into a
 * `PhaseSpecResolver` the engine calls at prompt-emit time.
 *
 * 2026-05-31 (sprint cc-substrate-migration-3-sites) — this file no
 * longer makes direct HTTPS calls to upstream LLM endpoints. Every
 * dispatch flows through the shared `buildLlmCallSubstrate` helper
 * (which spawns `claude -p` subprocesses with the pool-selected
 * credential per ISSUES #49). Direct upstream calls from instance-facing
 * code are forbidden per memory `feedback_cc_subprocess_substrate.md`.
 * The composer now resolves the `Substrate` once at boot and threads
 * it in as `input.substrate`; credential rotation + Max OAuth refresh
 * + cooldown reporting all happen inside the substrate's per-call
 * dispatch path.
 *
 * 2026-05-12 — default rollout flipped to LLM-on for ALL eligible
 * onboarding phases. `resolveEnabledPhases` reads
 * `NEUTRON_LLM_ONBOARDING_DEFAULT` (defaults to ON) and the optional
 * explicit `NEUTRON_LLM_ONBOARDING_PHASES` override. The static
 * `STATIC_PHASE_SPECS` table stays the deterministic fallback for any
 * LLM failure (timeout, parse error, allow-list rejection) per the
 * per-call resilience in `phase-spec-resolver.ts`. Returns `null` when:
 *   - `NEUTRON_LLM_ONBOARDING_PHASES`/`_DEFAULT` opted out of every
 *     phase (e.g. `_PHASES=off` or `_DEFAULT=0`)
 *   - the caller passed `input.substrate === null` (i.e. the instance
 *     had no Anthropic credentials resolved at composer-boot time) —
 *     the engine falls through to the static `PHASE_PROMPTS` table so
 *     onboarding never bricks
 *
 * Model: defaults to `BEST_MODEL` from `runtime/models.ts` (Opus 4.7
 * by default; override via `NEUTRON_BEST_MODEL`) per memory
 * `feedback_default_to_opus.md`. Callers may override via the `model`
 * field. Pre-2026-05-31 the default was `FAST_MODEL` (Haiku 4.5) on
 * the rationale that prompt-rephrase is a cheap task; the migration
 * standardised on Opus across LLM call sites and a future tuning
 * sprint can dial individual sites back down if latency demands.
 */

import {
  buildLlmPhaseSpecResolver,
  resolveEnabledPhases,
  type BuildLlmPhaseSpecResolverInput,
  type LlmCallFn,
  type PhaseContextBundle,
  type PhaseSpecResolver,
} from '../../onboarding/interview/phase-spec-resolver.ts'
import type { WebChatSenderRegistry } from '../http/chat-sender-registry.ts'
import { getBestModel } from '../../runtime/models.ts'
import type { AgentSpec, Substrate } from '../../runtime/substrate.ts'
import { collectTokensToString } from './build-llm-call-substrate.ts'
import { loadSkills } from './skills-loader.ts'
import { composeSystemPrompt } from './index.ts'
import type { PersonaPromptLoader } from './persona-loader.ts'
import type { CommentStore } from '../comments/comment-store.ts'
import {
  loadPendingEscalations,
  markEscalationsConsumed,
} from './escalation-loader.ts'

/**
 * Back-compat type alias. Older importers may still reference this
 * shape via `import type { HttpFetch } from './build-phase-spec-resolver.ts'`;
 * the migration to the CC subprocess substrate dropped the direct
 * `fetch` dependency from THIS factory, but exporting the alias keeps
 * the public surface stable for now. Safe to delete once no consumer
 * imports it.
 */
export type HttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface BuildPhaseSpecResolverInput {
  /**
   * Pre-built substrate from `buildLlmCallSubstrate(...)`. Pass `null`
   * when no Anthropic credentials are available — this factory then
   * returns `null` and the engine walks the static `PHASE_PROMPTS`
   * fallback for every phase.
   */
  substrate: Substrate | null
  env: NodeJS.ProcessEnv
  /** Web sender registry — used to emit `agent_typing_start` /
   *  `agent_typing_end` envelopes around the LLM call. May be omitted
   *  for Telegram-only tests; typing indicators are then no-ops. */
  webRegistry?: WebChatSenderRegistry
  /** Override the LLM call timeout for warm turns (default
   *  `CONVERSATIONAL_TIMEOUT_MS_DEFAULT`, 12s). */
  timeout_ms?: number
  /**
   * ONE-TIME elevated budget for the FIRST conversational dispatch only
   * (2026-06-18 cold-start fix). Sized to cover a cold CC spawn so the first
   * onboarding turn doesn't degrade to static purely from spawn latency even when
   * the pre-warm hasn't fully settled. The Open composer wires
   * `FIRST_CONVERSATIONAL_TIMEOUT_MS_DEFAULT`; omit on the managed gateway / tests
   * to apply `timeout_ms` to every call. Forwarded to `buildLlmPhaseSpecResolver`.
   */
  first_call_timeout_ms?: number
  /**
   * Override the model id. Defaults to `BEST_MODEL` (Opus 4.7) per
   * memory `feedback_default_to_opus.md`.
   */
  model?: string
  /**
   * Optional log-slug used in `console.warn` / `console.info` lines
   * surfaced from inside the factory (skills-loader warnings, the
   * no-credential info line, escalation-load warnings). Defaults to
   * 'unknown' when omitted.
   */
  log_slug?: string
  /**
   * Sprint A — GBrain methodology integration v2 (2026-05-12).
   *
   * Absolute path to the owner's data-dir. When set, the factory
   * reads `<owner_data_dir>/skills/conventions/*.md` once and wraps
   * the LLM call so every system prompt has the loaded conventions
   * spliced in via `composeSystemPrompt`.
   *
   * Resolves to the instance data path under `NEUTRON_HOME` (defaulting to
   * `/srv/neutron`) when omitted AND `internal_handle` is supplied (production default).
   * Tests pass an explicit path.
   *
   * Pass `null` to skip skills loading entirely (back-compat for
   * pre-Sprint-A instances or for unit tests that care only about the
   * LLM contract). Skills loader failures are NEVER fatal — on error
   * the factory logs a warning and falls back to the un-conventions
   * code path.
   */
  owner_data_dir?: string | null
  /**
   * 2026-05-31 — only consulted when `owner_data_dir` is undefined
   * (i.e. the factory must fall back to the instance skills path under
   * `NEUTRON_HOME` to find the conventions dir). When `owner_data_dir` is explicitly set
   * (string or null), this field is ignored. Defaults to 'unknown'
   * if needed for the fallback path.
   */
  internal_handle?: string
  /**
   * ISSUE #30 (v0.1.85) — persona-file loader. When supplied, the LLM
   * wrapper reads `<owner_home>/persona/{SOUL,USER,priority-map}.md`
   * via the loader's mtime-keyed cache and splices the bodies above any
   * conventions block on every call. The production composer
   * (`gateway/index.ts:3296-3324`) constructs one `PersonaPromptLoader`
   * per instance + wires its `invalidate` into
   * `createAdminPersonalitySurface({ onReload })` so admin-tab PATCH
   * lands on the very next agent turn. Pass `null`/`undefined` to skip
   * persona splicing entirely (legacy boot paths, unit tests that care
   * only about the conventions code path). Loader read failures are
   * NEVER fatal — the loader logs + skips the affected file.
   */
  personaLoader?: PersonaPromptLoader | null
  /**
   * P7.2 S3 — inline-comments store. When supplied alongside
   * `escalation_project_id`, the LLM wrapper reads any pending
   * `escalate_to_chat` events on every agent turn and splices the
   * rendered thread history into the system prompt above the persona
   * + conventions blocks. Pass `null`/`undefined` to skip escalation
   * splicing entirely (legacy boot paths, the onboarding interview
   * resolver before a per-project chat surface exists).
   *
   * Failures inside `loadPendingEscalations` are NEVER fatal — the
   * wrapper logs + falls back to the un-escalation code path.
   */
  commentStore?: CommentStore | null
  /**
   * P7.2 S3 — the project the chat surface lives in. The escalation
   * loader needs a project_id to read the per-project comments
   * sidecar. When `commentStore` is non-null and this is null, the
   * splicing is silently skipped (no project context => nothing to
   * load). The onboarding interview resolver passes null today; a
   * future per-project chat composer will thread the canonical
   * project_id through here.
   *
   * ISSUE #41 (2026-05-23) — accepts either a string (back-compat for
   * unit tests + legacy boot paths) OR a `() => string | null` closure
   * that is invoked at LLM-call time. The closure shape lets the chat
   * composer thread a live "current chat project_id" pointer through
   * without re-building the resolver every time the user escalates from
   * a different project. The production boot wires the closure against
   * a `WebChatSessionProjectRegistry` updated by the docs surface's
   * escalate POST handler (see `gateway/http/chat-bridge.ts`
   * `InMemoryWebChatSessionProjectRegistry`). A closure that returns
   * null is treated the same as the string-null branch: escalation
   * splicing is silently skipped for that turn.
   */
  escalation_project_id?: string | (() => string | null) | null
  /**
   * Pre-warm readiness gate (2026-06-18 synthesis-completes fix). When set, the
   * resolver awaits it ONCE (bounded + best-effort, OUTSIDE the conversational
   * timeout) before its FIRST LLM dispatch, so the first real onboarding turn
   * doesn't time out into the static fallback purely from the composer's cold CC
   * spawn latency. The Open composer wires a bounded awaiter over its fire-and-
   * forget pre-warm promise. Omit (managed gateway / tests) to skip the gate.
   */
  awaitReady?: () => Promise<void>
  /**
   * Warm-readiness probe (2026-06-18 cold-start fix, round 2). Reports whether the
   * pre-warm has settled so the resolver can apply the elevated `first_call_timeout_ms`
   * budget to EVERY dispatch in the cold window (not just the first) — the live
   * owner-signup raced the first two conversational turns against the cold spawn and
   * both timed out at 12 s. The Open composer wires a flag flipped when its pre-warm
   * promise resolves. Omit (managed gateway / tests) to keep first-call-only.
   */
  isWarmReady?: () => boolean
}

/**
 * Build the production phase-spec resolver. Returns `null` when:
 *   - the env opts out of every phase (e.g. `NEUTRON_LLM_ONBOARDING_PHASES=off`
 *     or `NEUTRON_LLM_ONBOARDING_DEFAULT=0` with no explicit phase list),
 *     so the resolver would no-op every call, OR
 *   - the caller passed `input.substrate === null` (i.e. the instance
 *     has no Anthropic credentials resolved — no point wiring a
 *     resolver that will always fail-fast its LLM call)
 *
 * Default policy (2026-05-12 sprint): both env vars unset → resolver
 * wires every LLM-eligible phase. Per-call LLM failures (timeout / parse
 * error / allow-list reject) still fall back to the static spec inside
 * the resolver itself — operator-level opt-out is for "no LLM at all,
 * even when healthy."
 *
 * The engine's `phaseSpecResolver` dep is optional — passing `null`
 * here cleanly disables the LLM path for that instance.
 */
export async function buildPhaseSpecResolver(
  input: BuildPhaseSpecResolverInput,
): Promise<PhaseSpecResolver | null> {
  const enabled_phases = resolveEnabledPhases(input.env)
  if (enabled_phases.size === 0) {
    return null
  }

  const log_slug = input.log_slug ?? input.internal_handle ?? 'unknown'

  if (input.substrate === null) {
    console.info(
      `[phase-spec-resolver] project=${log_slug} no Anthropic substrate supplied; LLM path disabled (engine will use static fallback)`,
    )
    return null
  }

  const baseLlm = buildAnthropicLlmCall({
    substrate: input.substrate,
    // Pass an explicit override through; otherwise `buildAnthropicLlmCall`
    // resolves `getBestModel()` PER-CALL so a watchdog flip reaches dispatches.
    ...(input.model !== undefined ? { model: input.model } : {}),
  })

  // Sprint A — GBrain methodology integration v2 (2026-05-12).
  // Load the owner's `skills/conventions/*.md` on EVERY LLM call so a
  // hot-edit to a convention file lands on the very next turn instead
  // of waiting for a gateway restart. `loadSkills` caches per
  // (skillsDir, mtimes) — when the files have not changed since the
  // last call, the second + subsequent calls return a referentially
  // equal `LoadedSkills` object (no re-read, no allocation), so the
  // per-turn overhead is bounded by a handful of `lstat` syscalls.
  //
  // ISSUE #30 (v0.1.85) — additionally load the owner's
  // `<owner_home>/persona/{SOUL,USER,priority-map}.md` via
  // `personaLoader.load()` (mtime-keyed cache) and splice the bodies
  // above the conventions block. Admin-tab PATCH fires
  // `loader.invalidate(filename)` via the surface's `onReload` hook so
  // the very next agent turn rebuilds the cache entry.
  //
  // When BOTH `owner_data_dir === null` AND `personaLoader` is unset,
  // we skip the wrap entirely so callers can byte-identically test the
  // pre-Sprint-A / pre-#30 code path. When both inputs resolve to empty
  // at call time (no conventions on disk + no persona files), the
  // wrapper short-circuits to `baseLlm(call)` and `composeSystemPrompt`
  // would have returned `base` byte-identical anyway — both shapes are
  // kept as defense-in-depth + a clearer test seam.
  const personaLoader = input.personaLoader ?? null
  const commentStore = input.commentStore ?? null
  // ISSUE #41 (2026-05-23) — escalation_project_id may be a string
  // (back-compat shape: pinned at composer-build time) OR a closure
  // that returns the LIVE current project_id at LLM-call time. The
  // closure shape lets the production chat composer thread a per-
  // session "current chat project_id" pointer through without rebuilding
  // the resolver every time the user escalates from a different
  // project (the docs surface's escalate POST handler updates a
  // WebChatSessionProjectRegistry; the closure reads from it). Null
  // (or a closure that returns null) skips splicing for that turn.
  const escalationProjectIdSource = input.escalation_project_id ?? null
  const resolveEscalationProjectId: (() => string | null) | null =
    escalationProjectIdSource === null
      ? null
      : typeof escalationProjectIdSource === 'function'
        ? escalationProjectIdSource
        : (): string => escalationProjectIdSource
  // P7.2 S3 — escalation splicing is wired ONLY when BOTH the
  // comment-store and an escalation_project_id source are supplied.
  // Either alone is a no-op (matches the persona-loader null-safety
  // convention). A closure that returns null on a given turn ALSO
  // short-circuits — checked per-call inside the wrapper below.
  const escalationEnabled = commentStore !== null && resolveEscalationProjectId !== null
  const llm: LlmCallFn =
    input.owner_data_dir === null && personaLoader === null && !escalationEnabled
      ? baseLlm
      : async (call) => {
          // Per-turn resolution: a closure-shaped escalation_project_id
          // can return a fresh value each call (e.g. the user escalated
          // from project 'foo' for turn N and project 'bar' for turn N+1).
          // Null means "no current chat project" → skip splicing for
          // this turn (same as the build-time null-source branch).
          const currentEscalationProjectId: string | null = escalationEnabled
            ? (resolveEscalationProjectId as () => string | null)()
            : null
          const escalationActive =
            escalationEnabled &&
            currentEscalationProjectId !== null &&
            currentEscalationProjectId.length > 0
          const [conventions, persona, escalation] = await Promise.all([
            loadConventionsForResolver({
              owner_data_dir: input.owner_data_dir,
              internal_handle: input.internal_handle,
              env: input.env,
              log_slug,
            }),
            personaLoader === null ? Promise.resolve('') : personaLoader.load(),
            !escalationActive
              ? Promise.resolve({ rendered: '', consumed_event_ids: [] })
              : loadPendingEscalations(
                  commentStore as CommentStore,
                  currentEscalationProjectId as string,
                ).catch((err) => {
                  console.warn(
                    `[phase-spec-resolver] instance=${log_slug} project=${currentEscalationProjectId} escalation_load_failed:`,
                    err,
                  )
                  return { rendered: '', consumed_event_ids: [] as string[] }
                }),
          ])
          if (
            conventions.length === 0 &&
            persona.length === 0 &&
            escalation.rendered.length === 0
          ) {
            return baseLlm(call)
          }
          // P7.2 S3 — concatenate the escalation block ABOVE the
          // upstream system prompt BEFORE composing. composeSystemPrompt
          // is untouched; the escalation block rides on top of `base`
          // and persona/conventions then splice above it. This matches
          // plan part C "Chat composer wire-in" — no `prepend` field
          // on composeSystemPrompt.
          const base_with_escalation =
            escalation.rendered.length === 0
              ? call.system
              : `${escalation.rendered}\n\n${call.system}`
          const result = await baseLlm({
            ...call,
            system: composeSystemPrompt({
              base: base_with_escalation,
              conventions,
              persona,
            }),
          })
          // Confirm consumption AFTER LLM success. Under the atomic
          // consumed-on-read scheme in escalation-loader.ts the rows
          // are already marked consumed by `loadPendingEscalations`;
          // this call is an idempotent no-op confirm that preserves
          // the persona-loader-style "load then confirm-after-LLM"
          // seam shape for future use (e.g. rollback on LLM failure).
          if (
            escalation.consumed_event_ids.length > 0 &&
            commentStore !== null &&
            currentEscalationProjectId !== null
          ) {
            await markEscalationsConsumed(
              commentStore,
              currentEscalationProjectId,
              escalation.consumed_event_ids,
            ).catch((err) => {
              console.warn(
                `[phase-spec-resolver] instance=${log_slug} project=${currentEscalationProjectId} mark_consumed_failed:`,
                err,
              )
            })
          }
          return result
        }

  const builderInput: BuildLlmPhaseSpecResolverInput = {
    llm,
    enabled_phases,
  }
  if (input.timeout_ms !== undefined) {
    builderInput.timeout_ms = input.timeout_ms
  }
  if (input.first_call_timeout_ms !== undefined) {
    builderInput.first_call_timeout_ms = input.first_call_timeout_ms
  }
  if (input.awaitReady !== undefined) {
    builderInput.awaitReady = input.awaitReady
  }
  if (input.isWarmReady !== undefined) {
    builderInput.isWarmReady = input.isWarmReady
  }
  const start = makeTypingIndicatorStart(input.webRegistry)
  const end = makeTypingIndicatorEnd(input.webRegistry)
  if (start !== undefined) builderInput.onLlmStart = start
  if (end !== undefined) builderInput.onLlmEnd = end
  return buildLlmPhaseSpecResolver(builderInput)
}

/**
 * Build the substrate-shaped LLM call. Dispatches every request through
 * the supplied CC-subprocess `Substrate` — credential rotation +
 * Max OAuth refresh + cooldown reporting happen inside the substrate's
 * own per-call path (see `build-llm-call-substrate.ts`). The closure
 * returns the raw text body; the resolver's downstream `parseLlmSpec`
 * consumes the text on success and errors propagate up to the
 * resolver's `Promise.race`-style timeout wrapper.
 *
 * AgentSpec carries a single `prompt: string` field (no separate
 * `system_prompt`) — locked § B.P1. We pack `<system>\n\n<user>` into
 * `spec.prompt` so the prompt body the resolver builds (with its strict
 * JSON contract) reaches the model intact.
 */
export function buildAnthropicLlmCall(input: {
  substrate: Substrate
  /** Explicit model override. Omit to resolve `getBestModel()` PER-CALL. */
  model?: string
}): LlmCallFn {
  return async (call): Promise<string> => {
    const prompt =
      call.system.length > 0 ? `${call.system}\n\n${call.user}` : call.user
    if (prompt.length === 0) {
      throw new Error('phase-spec-resolver: empty prompt')
    }
    const spec: AgentSpec = {
      prompt,
      tools: [],
      model_preference: [input.model ?? getBestModel()],
      max_tokens: call.max_tokens,
    }
    try {
      const handle = input.substrate.start(spec)
      const text = await collectTokensToString(handle)
      return text
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`phase-spec-resolver: ${message}`)
    }
  }
}

/**
 * Resolve + load the owner's `skills/conventions/*.md` body. Returns
 * an empty string when:
 *   - caller explicitly passed `owner_data_dir: null` (opt-out)
 *   - the resolved path's `skills/conventions/` directory is empty or
 *     missing (back-compat for pre-Sprint-A instances)
 *   - the skills-loader throws (defensive — never block the resolver)
 *
 * Sprint A — GBrain methodology integration v2 (2026-05-12).
 *
 * 2026-05-31 — `internal_handle` made optional. Only consulted by the
 * instance-skills fallback path (under `NEUTRON_HOME`),
 * which fires when `owner_data_dir` is undefined. Defaults to
 * 'unknown' for that fallback when omitted — production wires it
 * properly; tests/unit-call sites that pass `owner_data_dir`
 * explicitly never hit the fallback.
 */
async function loadConventionsForResolver(input: {
  owner_data_dir: string | null | undefined
  internal_handle: string | undefined
  env: NodeJS.ProcessEnv
  log_slug: string
}): Promise<string> {
  if (input.owner_data_dir === null) return ''
  const skillsDir = resolveSkillsDir({
    owner_data_dir: input.owner_data_dir,
    internal_handle: input.internal_handle ?? 'unknown',
    env: input.env,
  })
  try {
    const loaded = await loadSkills({ skillsDir })
    return loaded.body
  } catch (err) {
    console.warn(
      `[phase-spec-resolver] project=${input.log_slug} skills-loader failed at ${skillsDir}: ${
        err instanceof Error ? err.message : String(err)
      } — proceeding without conventions`,
    )
    return ''
  }
}

function resolveSkillsDir(input: {
  owner_data_dir: string | undefined
  internal_handle: string
  env: NodeJS.ProcessEnv
}): string {
  if (input.owner_data_dir !== undefined && input.owner_data_dir.length > 0) {
    return `${trimTrailingSlash(input.owner_data_dir)}/skills`
  }
  const neutronHome = input.env['NEUTRON_HOME'] ?? '/srv/neutron'
  return `${trimTrailingSlash(neutronHome)}/owners/${input.internal_handle}/skills`
}

function trimTrailingSlash(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p
}

function makeTypingIndicatorStart(
  registry: WebChatSenderRegistry | undefined,
): ((bundle: PhaseContextBundle) => void) | undefined {
  if (registry === undefined) return undefined
  return (bundle) => {
    if (!bundle.topic_id.startsWith('web:')) return
    registry.send(bundle.topic_id, { type: 'agent_typing_start' })
  }
}

function makeTypingIndicatorEnd(
  registry: WebChatSenderRegistry | undefined,
):
  | ((bundle: PhaseContextBundle, outcome: { ok: boolean; reason?: string }) => void)
  | undefined {
  if (registry === undefined) return undefined
  return (bundle) => {
    if (!bundle.topic_id.startsWith('web:')) return
    registry.send(bundle.topic_id, { type: 'agent_typing_end' })
  }
}
