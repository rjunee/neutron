/**
 * @neutronai/onboarding — SQLite-backed onboarding-state store (P2 S2).
 *
 * Per docs/plans/P2-onboarding.md § 2.8. Persists `onboarding_state` rows
 * (migration 0011 created the table; migration 0034 supersedes 0011 for
 * PK shape — composite PK on `(owner_slug, user_id)`) and exposes the
 * same `OnboardingStateStore` interface the InMemoryOnboardingStateStore
 * does so the engine can swap them.
 *
 * Each upsert is a single SQLite write. The phase_state JSON column is
 * shallow-merged: callers pass a partial patch; preserved fields stay
 * untouched. Failure recovery (§ 2.8): every upsert is implicitly atomic
 * because it's one statement; mid-turn crashes leave the row at the prior
 * phase, and the engine re-emits the prompt on the next start/advance.
 *
 * 2026-05-19 — ISSUES #2: keyed on (owner_slug, user_id) per migration
 * 0034. The on-disk PK is composite; every SELECT/INSERT/UPDATE/DELETE
 * threads user_id through.
 */

import { randomUUID } from 'node:crypto'

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { parseJsonColumn } from '@neutronai/persistence/index.ts'
import type {
  OnboardingState,
  OnboardingStateStore,
  UpsertOnboardingStateInput,
} from './state-store.ts'
import type { OnboardingPhase } from './phase.ts'

interface OnboardingStateRow {
  project_slug: string
  user_id: string
  phase: string
  phase_state_json: string
  started_at: number
  last_advanced_at: number
  completed_at: number | null
  import_job_id: string | null
  persona_files_committed: number
  wow_fired: number
  attempt_id: string
  wow_pushed_at: number | null
  onboarding_handoff_emitted_at: number | null
}

export interface SqliteOnboardingStateStoreOptions {
  db: ProjectDb
  now?: () => number
  /** Test seam — override the per-row attempt_id minter. */
  newAttemptId?: () => string
}

export class SqliteOnboardingStateStore implements OnboardingStateStore {
  private readonly db: ProjectDb
  private readonly now: () => number
  private readonly newAttemptId: () => string

  constructor(opts: SqliteOnboardingStateStoreOptions) {
    this.db = opts.db
    this.now = opts.now ?? ((): number => Date.now())
    this.newAttemptId = opts.newAttemptId ?? ((): string => randomUUID())
  }

  async get(owner_slug: string, user_id: string): Promise<OnboardingState | null> {
    const row = this.db
      .prepare<OnboardingStateRow, [string, string]>(
        `SELECT project_slug, user_id, phase, phase_state_json, started_at,
                last_advanced_at, completed_at, import_job_id,
                persona_files_committed, wow_fired, attempt_id,
                wow_pushed_at, onboarding_handoff_emitted_at
           FROM onboarding_state WHERE project_slug = ? AND user_id = ?`,
      )
      .get(owner_slug, user_id)
    // Codex r3 P1: defensive — bun:sqlite returns null on miss but other
    // adapters might surface undefined; check both so a brand-new owner's
    // first request never crashes here.
    if (row === null || row === undefined) return null
    return rowToState(row)
  }

  async upsert(input: UpsertOnboardingStateInput): Promise<OnboardingState> {
    const advanced_at = input.advanced_at ?? this.now()
    return await this.db.transaction(async (tx) => {
      const existing_row = tx
        .prepare<OnboardingStateRow, [string, string]>(
          `SELECT project_slug, user_id, phase, phase_state_json, started_at,
                  last_advanced_at, completed_at, import_job_id,
                  persona_files_committed, wow_fired, attempt_id,
                  wow_pushed_at, onboarding_handoff_emitted_at
             FROM onboarding_state WHERE project_slug = ? AND user_id = ?`,
        )
        .get(input.owner_slug, input.user_id)
      // Codex r3 P1: guard both null and undefined misses.
      const existing: OnboardingStateRow | null =
        existing_row === null || existing_row === undefined ? null : existing_row

      const merged_phase_state: Record<string, unknown> =
        existing !== null
          ? { ...(parseJson(existing.phase_state_json) ?? {}), ...(input.phase_state_patch ?? {}) }
          : { ...(input.phase_state_patch ?? {}) }
      const phase_state_json = JSON.stringify(merged_phase_state)

      if (existing === null) {
        const next: OnboardingState = {
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
        await tx.run(
          `INSERT INTO onboarding_state
             (project_slug, user_id, phase, phase_state_json, started_at,
              last_advanced_at, completed_at, import_job_id,
              persona_files_committed, wow_fired, attempt_id,
              wow_pushed_at, onboarding_handoff_emitted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            next.owner_slug,
            next.user_id,
            next.phase,
            phase_state_json,
            next.started_at,
            next.last_advanced_at,
            next.completed_at,
            next.import_job_id,
            next.persona_files_committed ? 1 : 0,
            next.wow_fired ? 1 : 0,
            next.attempt_id,
            next.wow_pushed_at,
            next.onboarding_handoff_emitted_at,
          ],
        )
        return next
      }

      const completed_at =
        input.completed_at !== undefined ? input.completed_at : existing.completed_at
      const import_job_id =
        input.import_job_id !== undefined ? input.import_job_id : existing.import_job_id
      const persona_files_committed_int =
        input.persona_files_committed !== undefined
          ? input.persona_files_committed
            ? 1
            : 0
          : existing.persona_files_committed
      const wow_fired_int =
        input.wow_fired !== undefined ? (input.wow_fired ? 1 : 0) : existing.wow_fired
      // 2026-05-22 — `wow_pushed_at` patch semantics mirror
      // `completed_at`: explicit `null` clears, explicit number stamps,
      // `undefined` leaves the existing value. `existing.wow_pushed_at`
      // is `number | null` straight off the row reader so the
      // assignment is safe.
      const wow_pushed_at =
        input.wow_pushed_at !== undefined ? input.wow_pushed_at : existing.wow_pushed_at
      // 2026-06-03 — `onboarding_handoff_emitted_at` patch semantics mirror
      // `wow_pushed_at`: explicit `null` clears, explicit number stamps,
      // `undefined` leaves the existing value untouched.
      const onboarding_handoff_emitted_at =
        input.onboarding_handoff_emitted_at !== undefined
          ? input.onboarding_handoff_emitted_at
          : existing.onboarding_handoff_emitted_at

      // Background patch-only write (Argus r2 blocker): PRESERVE the row's CURRENT
      // phase + resume-window timer, read here inside the transaction, instead of
      // stamping the caller's stale `input.phase` / `advanced_at`. A fire-and-forget
      // writer (the live personality suggester) reads state, then upserts up to 45 s
      // later; without this, its unconditional `SET phase=?, last_advanced_at=?`
      // would clobber a phase transition a concurrent turn committed in between (a
      // lost update). The phase_state MERGE is already safe — it folds the patch over
      // the freshly-read `existing.phase_state_json` above — so only phase + timer
      // need preserving.
      const next_phase = input.preservePhaseAndTimer === true ? existing.phase : input.phase
      const next_last_advanced_at =
        input.preservePhaseAndTimer === true ? existing.last_advanced_at : advanced_at

      await tx.run(
        `UPDATE onboarding_state
            SET phase = ?, phase_state_json = ?, last_advanced_at = ?,
                completed_at = ?, import_job_id = ?,
                persona_files_committed = ?, wow_fired = ?,
                wow_pushed_at = ?, onboarding_handoff_emitted_at = ?
          WHERE project_slug = ? AND user_id = ?`,
        [
          next_phase,
          phase_state_json,
          next_last_advanced_at,
          completed_at,
          import_job_id,
          persona_files_committed_int,
          wow_fired_int,
          wow_pushed_at,
          onboarding_handoff_emitted_at,
          input.owner_slug,
          input.user_id,
        ],
      )
      return {
        owner_slug: existing.project_slug,
        user_id: existing.user_id,
        phase: next_phase as OnboardingPhase,
        phase_state: merged_phase_state,
        started_at: existing.started_at,
        last_advanced_at: next_last_advanced_at,
        completed_at,
        import_job_id,
        persona_files_committed: persona_files_committed_int === 1,
        wow_fired: wow_fired_int === 1,
        wow_pushed_at,
        onboarding_handoff_emitted_at,
        attempt_id: existing.attempt_id,
      }
    })
  }

  async rekey(
    old_owner_slug: string,
    new_owner_slug: string,
    user_id: string,
  ): Promise<OnboardingState | null> {
    if (old_owner_slug === new_owner_slug) {
      return await this.get(old_owner_slug, user_id)
    }
    return await this.db.transaction(async (tx) => {
      // Collision check across the whole rekey: for every row whose
      // owner_slug=old, ensure no (new, user_id) row already exists.
      // (Different user_ids under `new` that ALSO have rows under `old`
      // would each collide; the rename orchestrator guarantees this
      // doesn't happen via slug-availability pre-flight.)
      const collisions = tx
        .prepare<{ user_id: string }, [string, string]>(
          `SELECT o.user_id
             FROM onboarding_state o
             JOIN onboarding_state n
               ON n.project_slug = ?
              AND n.user_id = o.user_id
            WHERE o.project_slug = ?`,
        )
        .all(new_owner_slug, old_owner_slug)
      if (collisions.length > 0) {
        const ids = collisions.map((c) => c.user_id).join(', ')
        throw new Error(
          `SqliteOnboardingStateStore.rekey: collision — row already exists under new_project_slug=${new_owner_slug} for user_id(s) ${ids}`,
        )
      }
      await tx.run(
        `UPDATE onboarding_state SET project_slug = ? WHERE project_slug = ?`,
        [new_owner_slug, old_owner_slug],
      )
      const row = tx
        .prepare<OnboardingStateRow, [string, string]>(
          `SELECT project_slug, user_id, phase, phase_state_json, started_at,
                  last_advanced_at, completed_at, import_job_id,
                  persona_files_committed, wow_fired, attempt_id,
                  wow_pushed_at, onboarding_handoff_emitted_at
             FROM onboarding_state WHERE project_slug = ? AND user_id = ?`,
        )
        .get(new_owner_slug, user_id)
      if (row === null || row === undefined) return null
      return rowToState(row)
    })
  }

  /**
   * P4 (table-ownership, 2026-07) — resolve the instance's `attempt_id`,
   * minting a fresh `onboarding_state` row when none exists. Moved VERBATIM
   * (SQL byte-identical) from
   * `onboarding/telemetry/event-emitter.ts:buildProductionOnboardingTelemetry`
   * so this store stays the single writer of `onboarding_state`
   * (migrations/table-ownership.json). Semantics unchanged: signup.* events
   * that fire BEFORE the engine's first upsert mint the row so they share the
   * same attempt_id bucket as the later interview events; the engine's
   * subsequent start() upsert merges over it (INSERT OR IGNORE keeps the
   * engine's row authoritative on a race).
   *
   * `this.newAttemptId` / `this.now` default to the exact expressions the
   * telemetry inlined (`randomUUID()` / `Date.now()`), so production behaviour
   * is identical while the store's existing test seams now apply.
   */
  async resolveOrMintAttemptId(owner_slug: string, user_id: string): Promise<string> {
    return this.db.transaction(async (tx) => {
      const existing = tx
        .prepare<{ attempt_id: string }, [string, string]>(
          `SELECT attempt_id FROM onboarding_state WHERE project_slug = ? AND user_id = ?`,
        )
        .get(owner_slug, user_id)
      if (existing !== null && existing.attempt_id.length > 0) {
        return existing.attempt_id
      }
      const fresh = this.newAttemptId()
      const ts = this.now()
      // ISSUES #2 (2026-05-19) — onboarding_state PK is (owner_slug,
      // user_id) per migration 0034. Mint-on-miss inserts a row for
      // this (instance, user) pair; the engine's subsequent start()
      // upsert merges over it.
      await tx.run(
        `INSERT OR IGNORE INTO onboarding_state
           (project_slug, user_id, phase, phase_state_json, started_at,
            last_advanced_at, completed_at, import_job_id,
            persona_files_committed, wow_fired, attempt_id)
         VALUES (?, ?, 'signup', '{}', ?, ?, NULL, NULL, 0, 0, ?)`,
        [owner_slug, user_id, ts, ts, fresh],
      )
      const reread = tx
        .prepare<{ attempt_id: string }, [string, string]>(
          `SELECT attempt_id FROM onboarding_state WHERE project_slug = ? AND user_id = ?`,
        )
        .get(owner_slug, user_id)
      return reread?.attempt_id ?? fresh
    })
  }

  async delete(owner_slug: string, user_id: string): Promise<void> {
    await this.db.run(
      `DELETE FROM onboarding_state WHERE project_slug = ? AND user_id = ?`,
      [owner_slug, user_id],
    )
  }

  async deleteByOwner(owner_slug: string): Promise<void> {
    await this.db.run(
      `DELETE FROM onboarding_state WHERE project_slug = ?`,
      [owner_slug],
    )
  }

  async completeIfPhaseStateMatches(input: {
    owner_slug: string
    user_id: string
    expected_phase: string
    expected_phase_state: Record<string, unknown>
    completed_at: number
    persona_files_committed?: boolean
  }): Promise<boolean> {
    // ATOMIC CAS in a SINGLE guarded UPDATE: flip to `completed` iff the row's CURRENT
    // `phase` equals the phase the caller processed AND its stored `phase_state_json` is
    // byte-identical to the caller's processed snapshot. The phase guard blocks a
    // concurrent transition to another non-terminal phase (e.g. `import_running`) that
    // leaves phase_state untouched — completing over that would finalize a live import.
    // `expected_phase_state` is a value the caller read via get() (so it was `JSON.parse`d
    // from this exact column); `JSON.stringify` of it round-trips to the stored compact
    // JSON when nothing has changed, and diverges the moment any upsert rewrites the row.
    // `.changes === 1` ⇒ we won the race and completed; `0` ⇒ the row moved (phase or
    // state) or is gone, and the caller must re-read + reconcile.
    const expected_json = JSON.stringify(input.expected_phase_state)
    const res = this.db.runSync(
      `UPDATE onboarding_state
          SET phase = 'completed', completed_at = ?, wow_fired = 1, last_advanced_at = ?,
              persona_files_committed = MAX(persona_files_committed, ?)
        WHERE project_slug = ? AND user_id = ?
          AND phase = ?
          AND phase NOT IN ('completed', 'failed')
          AND phase_state_json = ?`,
      [
        input.completed_at,
        this.now(),
        // `MAX(col, ?)` raises the flag when the caller committed persona and is a
        // no-op otherwise — the terminal write can never CLEAR an already-committed
        // persona (see the `OnboardingStateStore` interface doc). Before this the
        // UPDATE touched only phase/completed_at/wow_fired, so the column stayed at
        // its DEFAULT 0 for the whole Path-1 lifetime even with the files on disk.
        input.persona_files_committed === true ? 1 : 0,
        input.owner_slug,
        input.user_id,
        input.expected_phase,
        expected_json,
      ],
    )
    return res.changes === 1
  }
}

function rowToState(row: OnboardingStateRow): OnboardingState {
  return {
    owner_slug: row.project_slug,
    user_id: row.user_id,
    phase: row.phase as OnboardingPhase,
    phase_state: parseJson(row.phase_state_json) ?? {},
    started_at: row.started_at,
    last_advanced_at: row.last_advanced_at,
    completed_at: row.completed_at,
    import_job_id: row.import_job_id,
    persona_files_committed: row.persona_files_committed === 1,
    wow_fired: row.wow_fired === 1,
    wow_pushed_at: row.wow_pushed_at,
    onboarding_handoff_emitted_at: row.onboarding_handoff_emitted_at,
    attempt_id: row.attempt_id,
  }
}

function parseJson(s: string): Record<string, unknown> | null {
  // Corrupt-policy: silent reset to null (callers apply `?? {}`), matching the
  // onboarding sub-state reset-to-`{}` behaviour called out in the refactor plan.
  const v = parseJsonColumn(s, { onCorrupt: 'fallback', fallback: null })
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>
  }
  return null
}
