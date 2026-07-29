/**
 * @neutronai/onboarding — onboarding-state row reader/writer.
 *
 * Per docs/plans/P2-onboarding.md § 2.8 + § 6 S1 deliverables. The
 * `onboarding_state` table itself lands in S2 (migration 0011) per the
 * Pass-2 deepening's "incremental migration safety" rule. S1 ships the
 * interface plus an in-memory implementation so the engine skeleton
 * has a working state-store seam; S2 swaps in a `SqliteOnboardingStateStore`
 * that satisfies the same interface.
 *
 * The interface is locked at S1 so S2 cannot drift. Two implementations
 * land here:
 *
 *   - `OnboardingStateStore`        — interface
 *   - `InMemoryOnboardingStateStore` — process-local; the S1 default
 *
 * S2's SqliteOnboardingStateStore writes the row to `onboarding_state`
 * (table created in migration 0011; PK re-keyed to `(owner_slug, user_id)`
 * in migration 0034 — ISSUES #2). The engine's dependency-injection slot
 * accepts either implementation; the in-memory one stays exported for unit
 * tests forever.
 *
 * 2026-05-19 — ISSUES #2 (project-isolation) — every method now keys on
 * (owner_slug, user_id) per migration 0034. See §§ 2-4 of the
 * onboarding-state isolation brief.
 */

import { randomUUID } from 'node:crypto'

import type { OnboardingPhase } from './phase.ts'

export interface OnboardingState {
  owner_slug: string
  /**
   * ISSUES #2 (2026-05-19) — second PK component. The platform user_id
   * that owns this onboarding journey. Format: `google:<sub>`,
   * `apple:<sub>`, `synthetic:<...>` (E2E), or
   * `legacy:pre-project-isolation` for rows backfilled by migration 0034
   * whose source row had no `phase_state.user_id` to recover.
   */
  user_id: string
  phase: OnboardingPhase
  /** Free-form per-phase scratch JSON. The engine pours partial answers,
   *  draft fragments, and resume-on-reconnect breadcrumbs here. */
  phase_state: Record<string, unknown>
  started_at: number
  last_advanced_at: number
  completed_at: number | null
  import_job_id: string | null
  persona_files_committed: boolean
  wow_fired: boolean
  /**
   * 2026-05-22 (push-deeplink-wow sprint) — ms-epoch timestamp captured
   * the first time the engine fires a wow-moment push for this
   * (instance, user) row, OR `null` if no push has been attempted yet.
   * Used by `dispatchWowAndAdvance` to enforce the 1-shot-per-instance
   * idempotency contract on crash-resume of the `wow_fired` phase.
   * Backed by `onboarding_state.wow_pushed_at` (migration 0043).
   * Mark-on-attempt (not on success) so a Expo outage during the push
   * doesn't cause an infinite retry storm on resume.
   */
  wow_pushed_at: number | null
  /**
   * Sprint 2026-06-03 (onboarding-buttons-only-tweak-later) — ms-epoch
   * timestamp captured the first time the engine emits the
   * post-completion General-topic handoff message for this (instance, user)
   * row, OR `null` if it has not been emitted yet. The
   * `emitFinalHandoffPrompt` path consults + stamps this to enforce the
   * "fires ONCE per instance" idempotency contract on crash-resume of the
   * `wow_fired → completed` transition. Mark-on-emit (not on success) so a
   * channel-send hiccup never causes a re-emit storm on resume. Backed by
   * `onboarding_state.onboarding_handoff_emitted_at` (migration 0052).
   */
  onboarding_handoff_emitted_at: number | null
  /**
   * Sprint 30 — per-attempt correlator. Minted at row-creation time
   * (UUID) so every restart/resume of onboarding for an instance gets its
   * own bucket. The Sprint 30 telemetry resolver reads this column to
   * stamp `gateway_events.attempt_id` for events emitted without an
   * explicit value. Default `'legacy-pre-S30'` matches the migration's
   * NOT NULL DEFAULT for backfill — only relevant on rows that pre-date
   * Sprint 30.
   */
  attempt_id: string
}

export interface UpsertOnboardingStateInput {
  owner_slug: string
  /** ISSUES #2 — second PK component. See OnboardingState.user_id. */
  user_id: string
  phase: OnboardingPhase
  /** Optional patch over phase_state. Fields not in the patch are preserved. */
  phase_state_patch?: Record<string, unknown>
  /** Wall-clock ms; defaults to `now()` of the implementation. */
  advanced_at?: number
  /**
   * Background / patch-only write guard (Argus r2 blocker, 2026-07-22). When true
   * AND the row already exists, `upsert` PRESERVES the row's CURRENT `phase` and
   * `last_advanced_at` — read inside the same write — instead of stamping the
   * caller-supplied `phase` / `advanced_at`. A fire-and-forget writer that read
   * state seconds ago (the live personality suggester's up-to-45 s LLM call) can
   * then persist a `phase_state_patch` WITHOUT regressing a phase transition or
   * resetting the resume-window timer that a concurrent turn committed while the
   * call was in flight — the lost-update the plain unconditional UPDATE caused.
   * `phase` / `advanced_at` are still used when the row must be INSERTed (no current
   * value to preserve). Omit / false on every foreground write (which owns the phase
   * transition and intends to advance the timer).
   */
  preservePhaseAndTimer?: boolean
  /** Set when the engine reaches a terminal phase. */
  completed_at?: number
  import_job_id?: string | null
  persona_files_committed?: boolean
  wow_fired?: boolean
  /**
   * 2026-05-22 (push-deeplink-wow sprint) — stamp the row's
   * `wow_pushed_at`. Pass `null` to clear (admin reset / replay
   * fixtures); pass an ms-epoch number to mark as pushed; omit to
   * leave unchanged. See `OnboardingState.wow_pushed_at` for the
   * idempotency contract.
   */
  wow_pushed_at?: number | null
  /**
   * Sprint 2026-06-03 (onboarding-buttons-only-tweak-later) — stamp the
   * row's `onboarding_handoff_emitted_at`. Pass an ms-epoch number to mark
   * the General-topic handoff as emitted; pass `null` to clear (admin
   * reset / replay fixtures); omit to leave unchanged. See
   * `OnboardingState.onboarding_handoff_emitted_at` for the idempotency
   * contract.
   */
  onboarding_handoff_emitted_at?: number | null
}

export interface OnboardingStateStore {
  /** Returns the row, or null if this (instance, user) has not started onboarding. */
  get(owner_slug: string, user_id: string): Promise<OnboardingState | null>

  /**
   * Atomically upsert. If absent, the row is created with the given phase
   * + scratch patch + `started_at = advanced_at`. If present, the row's
   * `phase` is updated and `phase_state` is merged with the patch (shallow
   * merge — caller controls deeper structure). The implementation MUST
   * advance `last_advanced_at` to the supplied (or current) wall clock.
   *
   * Keyed on (input.owner_slug, input.user_id).
   */
  upsert(input: UpsertOnboardingStateInput): Promise<OnboardingState>

  /**
   * P1.5 / Sprint 21 — re-key every row whose `owner_slug = old` to
   * `new`. A slug rename is instance-scoped: every user's onboarding row
   * on the renamed instance moves to the new slug in one atomic step.
   * Returns the rekeyed state for the caller's `user_id` if it had a
   * row, else null. Implementations must be atomic w.r.t. concurrent
   * reads + must preserve `started_at`, `phase`, `phase_state`, and
   * all other per-row fields (including each row's user_id).
   *
   * Collision policy: if any row already exists under the new slug for
   * a user_id that ALSO has a row under the old slug, the implementation
   * must throw — the caller must guarantee uniqueness via the rename
   * orchestrator's slug-availability pre-flight. (Existing rows under
   * `new_owner_slug` for DIFFERENT user_ids are fine; the rebuild
   * preserves them.)
   */
  rekey(
    old_owner_slug: string,
    new_owner_slug: string,
    user_id: string,
  ): Promise<OnboardingState | null>

  /**
   * Patch the `phase_state` of an EXISTING row, preserving the current `phase`
   * and `last_advanced_at` (update-if-present / CAS semantics). If the row does
   * not exist — e.g. an admin reset deleted it between the caller's re-read and
   * this write — returns **null** and skips the write entirely, never inserting.
   *
   * Use this instead of `upsert({preservePhaseAndTimer:true})` when the caller
   * must NOT resurrect a deleted row (Argus r2 blocker, 2026-07-22).
   */
  patchPhaseState(
    owner_slug: string,
    user_id: string,
    patch: Record<string, unknown>,
  ): Promise<OnboardingState | null>

  /** Drop a single (instance, user) row. Used in tests + by `/admin/.../onboarding/reset`. */
  delete(owner_slug: string, user_id: string): Promise<void>

  /**
   * ISSUES #2 (2026-05-19) — drop EVERY row for an instance. Used by admin
   * tooling that wants to wipe a whole instance's onboarding rows in one
   * shot (replacing the pre-isolation `delete(owner_slug)` semantics).
   */
  deleteByOwner(owner_slug: string): Promise<void>

  /**
   * F8 — ATOMIC compare-and-set completion. Flip this (instance, user) row to
   * `completed` (+ `completed_at`, `wow_fired: true`) ONLY IF its CURRENT `phase` is
   * exactly `expected_phase` AND its `phase_state` is IDENTICAL to `expected_phase_state`
   * — i.e. nothing has mutated EITHER the phase or the scratch state since the caller
   * read + processed it. Returns true iff it completed.
   *
   * The phase guard is load-bearing, not just the phase_state: a concurrent transition to
   * another non-terminal phase (e.g. `import_running`) can leave `phase_state` untouched,
   * and completing over it would violate "never finalize on top of a live import". The
   * caller passes the phase it validated + processed, so a mid-run transition to ANY other
   * phase fails the CAS.
   *
   * A false return means the row changed underneath the caller (phase or state), was
   * already terminal, or is gone: the caller must re-read and reconcile before retrying.
   * This is the finalizer's ONLY safe terminal write — the read → compose persona →
   * materialize projects → complete sequence is otherwise NOT atomic, so a plain
   * `upsert(completed)` could stamp `completed` over a durable mutation that landed mid-run
   * and permanently suppress it. The CAS makes that impossible: `completed` is stamped only
   * against the exact (phase, phase_state) that was composed + materialized.
   */
  completeIfPhaseStateMatches(input: {
    owner_slug: string
    user_id: string
    expected_phase: string
    expected_phase_state: Record<string, unknown>
    completed_at: number
    /**
     * Set the `persona_files_committed` flag as part of this SAME atomic terminal
     * write (2026-07-18). Nothing on the finalize path used to persist it, so the
     * column sat at its schema DEFAULT 0 forever even though the persona files were
     * on disk. MONOTONIC: `true` raises the flag, `false`/omitted LEAVE it alone —
     * a later finalize whose persona compose failed must never clear a genuinely
     * committed persona.
     */
    persona_files_committed?: boolean
  }): Promise<boolean>
}

export interface InMemoryOnboardingStateStoreOptions {
  now?: () => number
  /** Test seam — override the per-row attempt_id minter. */
  newAttemptId?: () => string
}

function compositeKey(owner_slug: string, user_id: string): string {
  return `${owner_slug}\x00${user_id}`
}

export class InMemoryOnboardingStateStore implements OnboardingStateStore {
  private readonly rows = new Map<string, OnboardingState>()
  private readonly now: () => number
  private readonly newAttemptId: () => string

  constructor(opts: InMemoryOnboardingStateStoreOptions = {}) {
    this.now = opts.now ?? ((): number => Date.now())
    this.newAttemptId = opts.newAttemptId ?? ((): string => randomUUID())
  }

  async get(owner_slug: string, user_id: string): Promise<OnboardingState | null> {
    const row = this.rows.get(compositeKey(owner_slug, user_id))
    if (row === undefined) return null
    // Defensive copy — callers must not mutate stored state directly.
    return cloneState(row)
  }

  async upsert(input: UpsertOnboardingStateInput): Promise<OnboardingState> {
    const advanced_at = input.advanced_at ?? this.now()
    const key = compositeKey(input.owner_slug, input.user_id)
    const existing = this.rows.get(key)
    const merged_phase_state: Record<string, unknown> = existing
      ? { ...existing.phase_state, ...(input.phase_state_patch ?? {}) }
      : { ...(input.phase_state_patch ?? {}) }

    // Preserve the CURRENT phase + resume-window timer on a background patch-only
    // write, so a stale-read fire-and-forget upsert can't regress a phase transition
    // (Argus r2 blocker). Only meaningful when the row exists.
    const preserve = input.preservePhaseAndTimer === true && existing !== undefined
    const next: OnboardingState = existing
      ? {
          ...existing,
          phase: preserve ? existing.phase : input.phase,
          phase_state: merged_phase_state,
          last_advanced_at: preserve ? existing.last_advanced_at : advanced_at,
          completed_at: input.completed_at !== undefined ? input.completed_at : existing.completed_at,
          import_job_id:
            input.import_job_id !== undefined ? input.import_job_id : existing.import_job_id,
          persona_files_committed:
            input.persona_files_committed !== undefined
              ? input.persona_files_committed
              : existing.persona_files_committed,
          wow_fired: input.wow_fired !== undefined ? input.wow_fired : existing.wow_fired,
          wow_pushed_at:
            input.wow_pushed_at !== undefined ? input.wow_pushed_at : existing.wow_pushed_at,
          onboarding_handoff_emitted_at:
            input.onboarding_handoff_emitted_at !== undefined
              ? input.onboarding_handoff_emitted_at
              : existing.onboarding_handoff_emitted_at,
        }
      : {
          owner_slug: input.owner_slug,
          user_id: input.user_id,
          phase: input.phase,
          phase_state: merged_phase_state,
          started_at: advanced_at,
          last_advanced_at: advanced_at,
          completed_at: input.completed_at ?? null,
          import_job_id: input.import_job_id ?? null,
          persona_files_committed: input.persona_files_committed ?? false,
          wow_fired: input.wow_fired ?? false,
          wow_pushed_at: input.wow_pushed_at ?? null,
          onboarding_handoff_emitted_at: input.onboarding_handoff_emitted_at ?? null,
          attempt_id: this.newAttemptId(),
        }
    this.rows.set(key, next)
    return cloneState(next)
  }

  async patchPhaseState(
    owner_slug: string,
    user_id: string,
    patch: Record<string, unknown>,
  ): Promise<OnboardingState | null> {
    const key = compositeKey(owner_slug, user_id)
    const existing = this.rows.get(key)
    if (existing === undefined) return null
    const next: OnboardingState = {
      ...existing,
      phase_state: { ...existing.phase_state, ...patch },
    }
    this.rows.set(key, next)
    return cloneState(next)
  }

  async rekey(
    old_owner_slug: string,
    new_owner_slug: string,
    user_id: string,
  ): Promise<OnboardingState | null> {
    if (old_owner_slug === new_owner_slug) {
      const existing = this.rows.get(compositeKey(old_owner_slug, user_id))
      return existing === undefined ? null : cloneState(existing)
    }
    // Snapshot the entries to rekey (every row whose owner_slug=old).
    const toMove: Array<{ user_id: string; row: OnboardingState }> = []
    for (const [k, row] of this.rows) {
      if (row.owner_slug === old_owner_slug) {
        toMove.push({ user_id: row.user_id, row })
        void k
      }
    }
    // Per-(new, user_id) collision check across the entire migrated set
    // (so two users on the same instance aren't false-positive collided
    // when only one is being rekeyed).
    for (const { user_id: u } of toMove) {
      if (this.rows.has(compositeKey(new_owner_slug, u))) {
        throw new Error(
          `OnboardingStateStore.rekey: collision — row already exists under new_project_slug=${new_owner_slug} user_id=${u}`,
        )
      }
    }
    let returnRow: OnboardingState | null = null
    for (const { user_id: u, row } of toMove) {
      const rekeyed: OnboardingState = { ...row, owner_slug: new_owner_slug }
      this.rows.delete(compositeKey(old_owner_slug, u))
      this.rows.set(compositeKey(new_owner_slug, u), rekeyed)
      if (u === user_id) returnRow = rekeyed
    }
    return returnRow === null ? null : cloneState(returnRow)
  }

  async delete(owner_slug: string, user_id: string): Promise<void> {
    this.rows.delete(compositeKey(owner_slug, user_id))
  }

  async deleteByOwner(owner_slug: string): Promise<void> {
    for (const [k, row] of Array.from(this.rows)) {
      if (row.owner_slug === owner_slug) {
        this.rows.delete(k)
      }
    }
  }

  async completeIfPhaseStateMatches(input: {
    owner_slug: string
    user_id: string
    expected_phase: string
    expected_phase_state: Record<string, unknown>
    completed_at: number
    persona_files_committed?: boolean
  }): Promise<boolean> {
    const key = compositeKey(input.owner_slug, input.user_id)
    const existing = this.rows.get(key)
    if (existing === undefined) return false
    // Never re-complete a terminal row (defense-in-depth; expected_phase would normally
    // exclude these already).
    if (existing.phase === 'completed' || existing.phase === 'failed') return false
    // Phase guard: complete ONLY from the exact phase the caller processed (a concurrent
    // transition — e.g. to `import_running` — must fail even when phase_state is untouched).
    if (existing.phase !== input.expected_phase) return false
    // Structural equality via canonical stringify (both objects share insertion order
    // when the caller's expected snapshot is an unmutated read of this row).
    if (JSON.stringify(existing.phase_state) !== JSON.stringify(input.expected_phase_state)) {
      return false
    }
    this.rows.set(key, {
      ...existing,
      phase: 'completed',
      completed_at: input.completed_at,
      wow_fired: true,
      last_advanced_at: this.now(),
      // Monotonic raise — never clear an already-committed persona (see the
      // interface doc on `persona_files_committed`).
      persona_files_committed:
        existing.persona_files_committed || input.persona_files_committed === true,
    })
    return true
  }
}

function cloneState(state: OnboardingState): OnboardingState {
  return {
    ...state,
    phase_state: { ...state.phase_state },
  }
}
