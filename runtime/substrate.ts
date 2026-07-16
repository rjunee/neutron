/**
 * @neutronai/runtime — Substrate interface + AgentSpec input shape.
 *
 * THESE TYPE SHAPES ARE THE LOCK. Originally transcribed 2026-04-25 from the
 * validator-checked substrate-adapter review (the old "engineering-plan § B.P1"
 * working doc, since retired) — this file, not that doc, is now the source of
 * truth. Do not change a field on `AgentSpec` / `Substrate` without treating it
 * as a contract amendment: every adapter under `runtime/adapters/*` and every
 * Core builds against exactly this shape, so a silent widening ripples through
 * all of them. The living rationale + invariants live in `docs/INVARIANTS.md`
 * and `docs/AS_BUILT.md`.
 *
 * Substrate is the model-execution backend abstraction. Three concrete
 * implementations land in this codebase:
 *
 *   1. `runtime/adapters/claude-code/`        — Anthropic Messages API (P1)
 *   2. `runtime/adapters/codex-cli/`  — Codex CLI shell-out (P1)
 *   3. `runtime/adapters/openai-responses/`        — OpenAI Responses API (P1)
 *
 * The Private/open-weight adapter is deferred to P4 per `engineering-plan.md`
 * line 325. All adapters expose the same `SessionHandle` shape so Cores can be
 * substrate-agnostic. The dispatcher does NOT do model rotation — that lives
 * inside each adapter via `model_preference: string[]`.
 */

import type { ToolDef } from '@neutronai/core-sdk/types.ts'
import type { SessionHandle } from './session-handle.ts'

/**
 * Minimal Anthropic-shape conversation envelope. Used by `AgentSpec.messages`
 * for stateless substrates that need full history replay (open-weight, and as
 * a fallback for CC if the local transcript JSONL is missing). An adapter that
 * maintains its own continuity ignores `messages` once it has a live session:
 * the openai-responses adapter resumes via `previous_response_id`; the shipped
 * persistent-REPL CC adapter keeps continuity through its warm pool +
 * registry-resume and does NOT consume `spec.session.id` (see `AgentSpec.session`).
 *
 * Loose by design: adapters MAY accept richer content shapes (image blocks,
 * tool_use / tool_result blocks). The interface here is the lowest-common
 * denominator every adapter understands.
 */
export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string | unknown[]
}

/**
 * Input to `Substrate.start()`. VERBATIM per § B.P1 lines 406-415.
 *
 * Field semantics (from § B.P1 + the validator notes at lines 428-438):
 *
 * - `prompt` — the new user turn text. For multi-turn flows the adapter
 *   composes this with `messages` / `session` history.
 *
 * - `session?: { id, last_active_at }` — cross-turn continuity hint, honored
 *   per-adapter. The openai-responses adapter resumes via `previous_response_id`.
 *   **The shipped persistent-REPL CC adapter does NOT consume `session.id`** —
 *   its cross-turn continuity is pool-key + registry-driven: a warm REPL keyed
 *   by `poolKeyFor(options)` (substrate_instance_id, user_id, project_id,
 *   credential_identity), respawned via `--resume` off the on-disk REPL registry,
 *   never off a caller-supplied id. No caller passes `spec.session` today
 *   (continuity is achieved entirely through the pool key, suite-verified); the
 *   field stays in the contract for stateless / other adapters. See ISSUES #111
 *   (closed 2026-06-09 — doc/code reconciled to pool-key continuity). **Always
 *   treated as separate from the prompt cache** — `last_active_at` lets an adapter
 *   that DOES honor `session` decide cache plausibility.
 *
 * - `messages?: Message[]` — full conversation history. Used by stateless
 *   substrates and as a fallback for CC if the transcript JSONL is missing.
 *
 * - `tools` — declared tool surface for this turn. Per Core SDK contract,
 *   tools carry their own `capability_required` so the runtime can fail-closed
 *   on undeclared capabilities.
 *
 * - `model_preference: string[]` — adapter picks first available; multi-model
 *   rotation lives INSIDE the adapter (not in the dispatcher).
 *
 * - `max_tokens?: number` — upper bound on completion tokens.
 *
 * - `turn_timeout_ms?: number` — per-turn INACTIVITY window (ms) BEFORE the
 *   substrate abandons the turn with a retryable `turn timeout` error. Optional +
 *   additive (mirrors `max_tokens`): when unset the persistent CC REPL uses its
 *   construction default (90s idle window). This is NOT a fixed wall clock —
 *   `session.lastDataAt` advances on every PTY byte the child emits (spinner
 *   ticks, streamed tokens, tool output), so an actively-working turn keeps
 *   resetting the idle clock and runs as long as it needs; only a GENUINELY frozen
 *   turn (no PTY activity for this long) trips. The conversational composer raises
 *   it for a COLD first turn / onboarding turn (heavier initial processing) and
 *   keeps it snappy for warm steady-state. Only the persistent-REPL adapter reads
 *   it; other substrates ignore it.
 *
 * - `turn_absolute_ceiling_ms?: number` — per-turn ABSOLUTE-CEILING backstop (ms):
 *   the hard upper bound a single turn can run even while it keeps producing PTY
 *   activity (a live-but-livelocked child). Optional; when unset the persistent CC
 *   REPL uses its construction default (45min). Coerced ≥ the inactivity window.
 *   Only the persistent-REPL adapter reads it; other substrates ignore it.
 *
 * - `metering_context?: { project_id }` — populated ONLY for the
 *   Private substrate (per-instance rented H100), where openai-responses carries
 *   it for the meter writer. The CC adapter does NOT meter off it (Anthropic
 *   bills the owner's own subscription), but it DOES read `project_id` as a
 *   last-resort fallback for warm-pool project keying when the live
 *   project-id resolver yields nothing — see `build-llm-call-substrate.ts`
 *   (`input.projectIdResolver?.() ?? spec.metering_context?.project_id`).
 *   Conversational call sites never populate it, so on CC the fallback is
 *   effectively inert; it only matters for a caller that genuinely sets it.
 */
export interface AgentSpec {
  prompt: string
  session?: { id: string; last_active_at: number }
  messages?: Message[]
  tools: ToolDef[]
  model_preference: string[]
  max_tokens?: number
  /** Per-turn INACTIVITY window (ms): the turn is abandoned with a retryable
   *  `turn timeout` error only after this long with NO PTY activity (an active
   *  turn resets it on every byte). Optional; unset → the substrate's construction
   *  default. NOT a fixed wall clock. Read by the persistent CC REPL adapter only.
   *  See the doc-comment above. */
  turn_timeout_ms?: number
  /** Per-turn ABSOLUTE-CEILING backstop (ms): hard upper bound a turn can run even
   *  while actively producing PTY output. Optional; unset → the substrate's
   *  construction default. Coerced ≥ the inactivity window. Read by the persistent
   *  CC REPL adapter only. See the doc-comment above. */
  turn_absolute_ceiling_ms?: number
  metering_context?: { project_id: string }
}

/**
 * The Substrate abstraction. Locked at one method.
 *
 * Per § B.P1 line 396, `start` is synchronous-returning — it kicks off the
 * underlying call and returns the handle immediately so the caller can begin
 * consuming events. The adapter's `start` MUST NOT block on the first byte of
 * the stream; any latency before the first event is still observable as time
 * spent inside the iterator's first `read`.
 */
export interface Substrate {
  start(spec: AgentSpec): SessionHandle
}
