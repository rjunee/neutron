/**
 * @neutronai/gateway/nexus — the RC2 emitter side of the agent-nexus log.
 *
 * Per docs/plans/2026-07-02-world-class-refactor-plan.md § RC2 ([BEHAVIOR]).
 *
 * RC1 landed the append-only store with NO producers. RC2 wires the producers
 * at three existing seams, additively — each writes ONE nexus event through the
 * store's single `appendEvent` surface without disturbing the mutable-state
 * store it hangs off:
 *
 *   - trident's inner→outer harvest (`trident/orchestrator.ts` `applyResult`,
 *     the `inner_result` path)  → a `handoff` event (actor `orchestrator`)
 *   - the Argus verdict on that same harvest                → a `decision`
 *     event (actor `argus`)
 *   - the reflection `onTurnComplete` correction writer      → a `learning`
 *     event (actor `reflection`), so owner corrections reach build agents
 *
 * This module owns the PURE parts (flag + event builders + the fire-and-forget
 * append) so they are unit-testable against a real `NexusStore` with no mock
 * past the seam. The seam-side glue (map a `TridentRun` / a `Correction` onto
 * these builders + choose the project scope) lives at the wiring sites — the
 * trident composition input (`open/composer.ts` → `build-core-modules.ts`) and
 * the reflection wiring (`open/wiring/memory.ts`) — which is where `owner_home`
 * and the per-turn / per-run project scope are known.
 *
 * The whole R-behavior block (RB1/RB2/RC2/RC3/RB3/RB4 — the perfect-recall +
 * agent-coordination uplift) sits behind ONE shared flag so it enables/rolls
 * back atomically (plan §14.6). `isPerfectRecallEnabled` is that shared gate;
 * when it is off the wiring sites construct no store and pass no emitter, so
 * every seam behaves exactly as it does today (no `.nexus/` sidecar is ever
 * touched).
 */

import { createLogger } from '@neutronai/logger'
import { describeRejection, fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

import {
  MAX_NEXUS_BODY_BYTES,
  type AppendNexusEventInput,
  type NexusRef,
  type NexusStore,
} from './nexus-store.ts'

const log = createLogger('nexus-emit')

/**
 * The ONE shared feature gate for the R-behavior block (plan §14.6). Off by
 * default: the recall/coordination uplift ships DARK until an operator opts in,
 * so RC2's emitters — and RC3's reader — are inert on an un-flagged instance.
 * Accepts `1` / `true` (case-insensitive) as on; anything else is off.
 */
export function isPerfectRecallEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const raw = env['NEUTRON_PERFECT_RECALL']
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true'
}

/** Keep a nexus body pointers-lean AND under the store's hard cap. Long content
 *  belongs behind a `ref`, never inlined; this is a belt so a runaway task
 *  title can never trip `appendEvent`'s `body_too_large` reject. The budget is
 *  a conservative char count well inside `MAX_NEXUS_BODY_BYTES` (which counts
 *  UTF-8 bytes, so byte-cap / 4 is safe for any input). */
const BODY_CHAR_BUDGET = Math.floor(MAX_NEXUS_BODY_BYTES / 4)

function truncate(s: string, max = BODY_CHAR_BUDGET): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** Short, single-line task label for a nexus body (never the full task text —
 *  the run itself is the `ref`). */
function taskLabel(task: string): string {
  return truncate(task, 120)
}

/* ─── event builders (pure — RC2 producers map onto these) ───────────── */

export interface TridentHandoffFields {
  /** The run's stable slug (→ a `run` ref + the event actor_id). */
  slug: string
  /** The run's human task text (label only; truncated). */
  task: string
  /** The reviewed verdict on the harvested result (null = exhausted rounds). */
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | null
  /** Inner-loop round the result was produced on. */
  round: number
  /** PR number when the run merges a remote PR (→ a `pr` ref). */
  pr?: number | null
}

/**
 * The trident inner→outer HARVEST as a `handoff` event: the inner build loop
 * (forge→argus→fix, one detached Workflow) finished and handed its typed result
 * up to the outer orchestrator. Attributed to `orchestrator` — the actor at
 * this seam that performs the harvest and records the handoff.
 */
export function tridentHandoffEvent(f: TridentHandoffFields): AppendNexusEventInput {
  const verdict = f.verdict ?? 'no-verdict'
  const refs: NexusRef[] = [{ kind: 'run', ref: f.slug }]
  if (typeof f.pr === 'number' && f.pr > 0) {
    refs.push({ kind: 'pr', ref: `#${f.pr}` })
  }
  return {
    actor_kind: 'orchestrator',
    actor_id: f.slug,
    kind: 'handoff',
    body: truncate(
      `Trident inner→outer handoff for "${taskLabel(f.task)}": verdict ${verdict}, round ${f.round}`,
    ),
    refs,
  }
}

export interface TridentDecisionFields {
  slug: string
  task: string
  /** The reviewed verdict (null upstream = the inner loop exhausted rounds → the
   *  caller normalizes it to REQUEST_CHANGES for the decision). */
  verdict: 'APPROVE' | 'REQUEST_CHANGES'
  /** Short, human-readable outcome note (e.g. the failure reason). */
  note?: string
  pr?: number | null
}

/**
 * The Argus VERDICT on a harvested result as a `decision` event — the citeable
 * "a choice was made" record a later chat turn (RC3) re-grounds on. Attributed
 * to `argus`, the reviewer that made the call.
 */
export function tridentDecisionEvent(f: TridentDecisionFields): AppendNexusEventInput {
  const refs: NexusRef[] = [{ kind: 'run', ref: f.slug }]
  if (typeof f.pr === 'number' && f.pr > 0) {
    refs.push({ kind: 'pr', ref: `#${f.pr}` })
  }
  const note = f.note !== undefined && f.note.trim().length > 0 ? ` — ${f.note}` : ''
  return {
    actor_kind: 'argus',
    actor_id: f.slug,
    kind: 'decision',
    body: truncate(`Argus verdict for "${taskLabel(f.task)}": ${f.verdict}${note}`),
    refs,
  }
}

export interface ReflectionLearningFields {
  /** Stable correction id (→ the actor_id, for provenance). */
  id: string
  /** The durable learning — what the owner wants instead. */
  right: string
  /** Why the learning generalizes (optional context). */
  why?: string
}

/**
 * An owner correction captured by reflection's `onTurnComplete` writer as a
 * `learning` event, so a build agent re-grounding on the project's nexus sees
 * the owner's recent corrections. Attributed to `reflection`, the writer.
 */
export function reflectionLearningEvent(f: ReflectionLearningFields): AppendNexusEventInput {
  const why = f.why !== undefined && f.why.trim().length > 0 ? ` (${f.why})` : ''
  return {
    actor_kind: 'reflection',
    actor_id: f.id,
    kind: 'learning',
    body: truncate(`Owner correction: ${f.right}${why}`),
    refs: null,
  }
}

/* ─── fire-and-forget append ─────────────────────────────────────────── */

/** OPTIONAL contextual sink for an append rejection. Runs AFTER `fireAndForget`
 *  has already made the rejection visible (structured log + counter), so it is
 *  purely additive — a producer that wants site-specific context (or a test
 *  that wants to observe the failure) supplies one; production callers omit it
 *  and rely on the structured logger. */
export interface NexusEmitLog {
  warn(message: string): void
}

/**
 * Append one event to a project's nexus, FIRE-AND-FORGET. Returns immediately;
 * the store write runs on its own microtask and any error (a bad `project_id`,
 * a busy sidecar, a closed store) is made visible via `fireAndForget` then
 * swallowed — it never rejects into the caller. This is what keeps every RC2
 * producer "additive — never disturbs the mutable-state store it hangs off":
 * the harvest / verdict / correction path is never blocked on, and never fails
 * because of, a nexus write. `appendEvent` is `async`, so even its synchronous
 * validation surfaces as a rejection the wrapper catches (never a sync throw).
 */
export function emitNexusEvent(
  store: NexusStore,
  project_id: string,
  input: AppendNexusEventInput,
  onErr?: NexusEmitLog,
): void {
  fireAndForget(
    'nexus-emit.append',
    store.appendEvent(project_id, input),
    onErr !== undefined
      ? (err): void =>
          onErr.warn(
            `append failed project=${project_id} kind=${input.kind}: ${describeRejection(err)}`,
          )
      : undefined,
  )
}

/**
 * DURABLE append — AWAIT the write, swallowing (never throwing) any error. Used
 * by the terminal producer below, which runs on the tick's awaited post-commit
 * `on_terminal` path: awaiting means the event is durably written BEFORE the
 * terminal hook resolves (a graceful shutdown that drains the hook does not lose
 * it), unlike the fire-and-forget `emitNexusEvent` used off the chat hot path.
 * Still never throws — a nexus outage must not break terminal delivery.
 */
async function appendNexusEventDurable(
  store: NexusStore,
  project_id: string,
  input: AppendNexusEventInput,
  onErr?: NexusEmitLog,
): Promise<void> {
  try {
    await store.appendEvent(project_id, input)
  } catch (err) {
    const msg = `append failed project=${project_id} kind=${input.kind}: ${describeRejection(err)}`
    if (onErr !== undefined) onErr.warn(msg)
    else log.warn('append_failed', { project_id, kind: input.kind, error: describeRejection(err) })
  }
}

/* ─── the trident terminal-run producer (post-commit) ────────────────── */

/**
 * The committed-row projection the trident terminal producer reads. A structural
 * subset of `TridentRun` (every field exists there), kept LOCAL so this module
 * never imports trident — the composer passes a `TridentRun` straight in.
 */
export interface TridentTerminalRun {
  slug: string
  task: string
  /** The run's project dir under `Projects/` — the nexus scope. */
  project_slug: string
  /** The SERVER-GATED verdict recorded on the committed row (also the verdict
   *  the inner workflow wrote — see `isTridentHarvestTerminal` for why the
   *  harvest gate below does NOT rely on this being non-null). */
  inner_verdict: 'APPROVE' | 'REQUEST_CHANGES' | null
  /** The SERVER-recorded Argus provenance checkpoint. An Argus VERDICT exists
   *  only when this is `argus-approved` / `argus-request-changes`. */
  inner_checkpoint: string | null
  round: number
  pr: number | null
  failure_reason: string | null
}

/** Whether this terminal transition was produced by a genuine OUTER harvest.
 *  The caller computes it with `trident`'s `isTridentHarvestTerminal` (which the
 *  nexus package can't import); it is what distinguishes a real inner→outer
 *  handoff from a stopped/garbled/reaped row that merely carries an
 *  inner-written `inner_verdict`. */
export interface TridentTerminalEmitOpts {
  harvested: boolean
}

const ARGUS_CHECKPOINTS = new Set(['argus-approved', 'argus-request-changes'])

/**
 * Emit the RC2 trident events for a TERMINAL run, called from the tick's
 * POST-COMMIT `on_terminal` seam (never from inside the transition, so a
 * discarded/retried transition can neither leave orphan events nor duplicate
 * them). Reconstructs both events from the COMMITTED row.
 *
 * DELIVERY GUARANTEE — at-most-once, fired exactly once per committed terminal
 * transition while the process stays live (the same guarantee the sibling
 * `on_terminal` observers — terminal chat delivery, board reconcile, skill-forge
 * — have; this seam does NOT re-sweep terminal rows). A hard crash in the window
 * between the row commit and this callback drops the events for that run, exactly
 * as it would drop that run's terminal chat message. That is acceptable by
 * design: the nexus is a BEST-EFFORT coordination log (RC1: "NOT a bus — no
 * delivery, no ack; just an ordered log"), not a guaranteed-delivery outbox.
 * Crash-safe exactly-once (deterministic ids / an outbox + boot reconciliation)
 * would require RC1 substrate changes and is a tracked follow-up, out of RC2's
 * additive-emitter scope.
 *
 * Events:
 *
 *   - `handoff` (actor `orchestrator`) — the inner build loop handed a result up
 *     to the outer loop. Emitted ONLY when `opts.harvested` (the outer loop
 *     genuinely harvested a parseable result into a `done`/`failed` transition);
 *     a stopped/garbled/reaped row — which may still carry an inner-written
 *     `inner_verdict` — is NOT a handoff.
 *   - `decision` (actor `argus`) — the reviewed verdict, emitted ONLY with
 *     genuine Argus provenance (see the two reliable signals below). A
 *     pre-verdict failure (`inner-error`, Forge crash) has NO Argus verdict, so
 *     no `argus` decision is fabricated — RC3 can trust a `decision` event's
 *     provenance. The verdict is `inner_verdict` verbatim: a committed `APPROVE`
 *     is only ever produced by the server provenance gate on a recorded
 *     `argus-approved`, so it is trustworthy.
 *
 * AWAITED appends (each guarded) — the caller (`on_terminal`) awaits this so the
 * events are persisted before the hook resolves (a GRACEFUL drain won't lose
 * them); a nexus write still never throws into (nor disturbs) the
 * terminal-delivery path it rides.
 */
export async function emitTridentTerminalEvents(
  store: NexusStore,
  run: TridentTerminalRun,
  opts: TridentTerminalEmitOpts,
  onErr?: NexusEmitLog,
): Promise<void> {
  // Not a genuine outer harvest (reaped/stalled/orphaned/stopped/garbled) → no
  // handoff, no verdict — even if an inner-written `inner_verdict` lingers.
  if (!opts.harvested || run.inner_verdict === null) return
  await appendNexusEventDurable(
    store,
    run.project_slug,
    tridentHandoffEvent({
      slug: run.slug,
      task: run.task,
      verdict: run.inner_verdict,
      round: run.round,
      pr: run.pr,
    }),
    onErr,
  )
  // A `decision` is an ARGUS verdict — emit only with genuine Argus provenance.
  // Two independent, RELIABLE signals (the committed `inner_checkpoint` alone is
  // NOT reliable: `applyResult` overwrites it with the loosely-parsed
  // `result.checkpoint` on the APPROVE→done / merge branches, so a genuine
  // approve can land a non-argus checkpoint like `merging`):
  //   - `inner_verdict === 'APPROVE'` is ITSELF proof of argus-approved — the
  //     server provenance gate forces any APPROVE NOT backed by a recorded
  //     `argus-approved` checkpoint down to REQUEST_CHANGES, so a committed
  //     `APPROVE` can only have come from a real Argus approval; OR
  //   - the committed `inner_checkpoint` is an Argus checkpoint (the
  //     REQUEST_CHANGES branches PRESERVE the server-recorded checkpoint, so
  //     this correctly separates an argus-reviewed REQUEST_CHANGES from a
  //     pre-verdict `inner-error` / Forge crash, which carries neither).
  const argusReviewed =
    run.inner_verdict === 'APPROVE' ||
    (run.inner_checkpoint !== null && ARGUS_CHECKPOINTS.has(run.inner_checkpoint))
  if (argusReviewed) {
    await appendNexusEventDurable(
      store,
      run.project_slug,
      tridentDecisionEvent({
        slug: run.slug,
        task: run.task,
        verdict: run.inner_verdict,
        // A failed run carries the reason; a merged run has none.
        note: run.failure_reason ?? `verdict ${run.inner_verdict}`,
        pr: run.pr,
      }),
      onErr,
    )
  }
}
