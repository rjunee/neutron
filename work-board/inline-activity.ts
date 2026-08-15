/**
 * Aligned with `WEDGE_AFTER_MS` in `open/activity-inspector.ts`: a session with no
 * real (non-keepalive) activity for 90 s is not visibly working. The two constants
 * are pinned equal by a test in `open/activity-inspector.test.ts` — this module is
 * a dependency-free leaf on purpose and cannot import the inspector.
 *
 * WHAT COUNTS AS EVIDENCE. The inspector's WRITE clock only
 * (`lastWriteActivityAt`): a write-class tool call — a file write/edit, a mutating
 * shell command. Deliberately NOT its `last_real_activity_at`, which any turn
 * advances; wiring the board to that clock would mean asking the agent a question
 * marks cards as being worked on, which is the stored flag's original lie with an
 * extra step. That applies to the stored flag too: a flagged card is NOT believed
 * because the session is alive, only because something was written. "The evidence
 * wins" has to hold in the direction that costs something, or it holds nowhere.
 *
 * WHAT THE WRITE CLOCK THEREFORE CANNOT SEE (stated, not hidden): read-only inline
 * work. A research/analysis card, or a card whose inline turn is ten minutes of
 * `bun test`, records no write and reads NOT active — and after 90 s of reads a
 * genuinely live inline card goes quiet again, even with the flag set. This is the
 * deliberate direction to fail in: acceptance (c) — quiet means quiet — is worth
 * more than catching every live card, because a false "working" is the exact lie
 * this card exists to kill. Two consequences the callers MUST honour: describe the
 * signal as RECENT WRITE ACTIVITY, never as "an inline action is executing"; and
 * never let it lock anything, because it will be wrong in the quiet direction.
 *
 * Evidence is deliberately tier 1 only: the in-process ActivityInspector clock is
 * an O(1) Map read per project scope. Tiers 2–3 (branch commits and a dirty
 * worktree) would shell out per row per render and are non-goals on this read path.
 * The stored `inline_active` flag is only a hint; when it disagrees with evidence,
 * evidence wins. This module must remain display-only and never grow a blocking or
 * gating branch.
 *
 * GRANULARITY, AND WHY IT IS CAPPED AT ONE ROW. The clock is per PROJECT, because a
 * card carries no session binding — a write cannot say WHICH of two in-progress
 * cards it belongs to. Left unbounded that lights every runless in-progress card of
 * the project (and, because clients suppress ▶ on `inline_active`, hides Start/Retry
 * board-wide for the whole window). So status-only derivation is rationed: at most
 * ONE card per board may go active on project evidence alone — the most recently
 * touched eligible in-progress card, which is the card the agent moved into
 * `in_progress` before it started writing. Cards whose stored flag is set are
 * unaffected (an explicit claim, still corroborated by evidence). A real card↔session
 * binding on the row would replace the heuristic; that is a separate change.
 */
export const INLINE_EVIDENCE_WINDOW_MS = 90_000

export interface InlineActivityScanItem {
  status: string
  inline_active: boolean
  linked_run_id: string | null
  /** ISO-8601 UTC mutation stamp (lexicographically ordered). Used ONLY to pick
   *  the single status-only evidence candidate; absent ⇒ oldest. */
  updated_at?: string
}

export interface InlineEvidence {
  /**
   * ms epoch of the last WRITE-CLASS tool call for the item's project scope;
   * 0 = none ever recorded (including after a process restart, which is correct:
   * a crashed session's stale flag must read not-active).
   */
  last_write_activity_at: number
  /** Server clock (ms) at derivation time. */
  now: number
  /** Test override; defaults to {@link INLINE_EVIDENCE_WINDOW_MS}. */
  window_ms?: number
}

/** The two facts that are PER ROW rather than per board. Both default to the
 *  conservative value, so a caller that knows neither gets the old behaviour. */
export interface InlineDerivationContext {
  /**
   * May status-only evidence (no stored flag) activate THIS row? The board-level
   * mapper sets it true for at most one row — see the header. Defaults to true so
   * a single-item direct call still exercises the rule.
   */
  evidence_candidate?: boolean
  /**
   * Is the bound run still LIVE? Defaults to TRUE (fail closed to the fork lane)
   * because a caller with no run store cannot tell. Mirrors `isLinkedRunning` in
   * `app/lib/work-board-helpers.ts`: a card bound to a TERMINAL run is not being
   * worked by the fork lane, so its inline evidence is the only signal there is.
   */
  linked_run_live?: boolean
}

export function deriveInlineActive(
  item: InlineActivityScanItem,
  evidence: InlineEvidence,
  ctx: InlineDerivationContext = {},
): boolean {
  // R1 mutant: terminal cards must never claim live inline work.
  if (item.status === 'done' || item.status === 'failed') return false
  // R2 mutant: a card bound to a LIVE run gets its activity from the fork lane,
  // not from chat evidence. `linked_run_id` is typed `string | null` by the store
  // but this is an exported dependency-free leaf — every other rule is total, so
  // this one is too (an `undefined` link is simply no link).
  const linked = typeof item.linked_run_id === 'string' && item.linked_run_id.length > 0
  if (linked && ctx.linked_run_live !== false) return false

  const windowMs = evidence.window_ms ?? INLINE_EVIDENCE_WINDOW_MS
  /** 0 ⇒ never recorded ⇒ never fresh (the post-crash/post-restart reading). The
   *  lower bound is the backwards-clock clamp: a stamp more than a window in the
   *  FUTURE is an NTP step, not work, and without it the row would read active for
   *  the whole skew. */
  const fresh = (at: number): boolean => {
    if (at === 0) return false
    const elapsed = evidence.now - at
    return elapsed < windowMs && elapsed >= -windowMs
  }

  // R3 mutant: absent/stale evidence beats the stored hint — the crashed-session
  // heal (acceptance (b)) and the whole "evidence wins" claim. The flag gets no
  // exemption: it is checked BELOW this line, never above it.
  if (!fresh(evidence.last_write_activity_at)) return false

  // R4 mutant: fresh evidence corroborates an explicit claim.
  if (item.inline_active === true) return true
  // R5 mutant: fresh evidence activates current inline work without requiring a
  // flag write — but only for the board's single candidate row (see the header).
  return item.status === 'in_progress' && ctx.evidence_candidate !== false
}

/**
 * Did this advance of the write clock turn the board's inline signal OFF→ON?
 *
 * The board's live frame is fanned by store writes and run transitions, and
 * inline work makes NEITHER — which is the whole reason this card exists. So the
 * tool tap pushes one frame on the rising edge, and only on the rising edge:
 * `before === 0` is the first write ever seen for the scope, and a gap of a full
 * window means the signal had already expired. Everything in between is a write
 * during an already-active window, where the clients are already polling and a
 * frame per tool call would be pure noise.
 */
export function isInlineEvidenceEdge(
  before: number,
  after: number,
  windowMs: number = INLINE_EVIDENCE_WINDOW_MS,
): boolean {
  if (after === before) return false
  if (before === 0) return true
  return after - before >= windowMs
}

/** Late-bound evidence seam. The composer defines this holder BEFORE the
 *  ActivityInspector exists and binds `lastWriteActivityAt` after construction;
 *  an unset holder reads as evidence 0 => never active (fail-soft, and exactly
 *  the correct post-restart semantics: a crashed session's stale flag heals). */
export interface InlineEvidenceReader {
  lastWriteActivityAt?: (scope: string) => number
}

/** The single row that project-wide evidence is allowed to activate on status
 *  alone: the most recently touched in-progress card that is neither flagged
 *  (those activate anyway) nor owned by a live run. -1 ⇒ none eligible. */
function evidenceCandidateIndex(
  items: readonly InlineActivityScanItem[],
  linkedRunLive: readonly boolean[],
): number {
  let best = -1
  let bestStamp = ''
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i]
    if (it === undefined || it.status !== 'in_progress') continue
    if (it.inline_active === true) continue
    if (linkedRunLive[i] === true) continue
    const stamp = it.updated_at ?? ''
    if (best === -1 || stamp > bestStamp) {
      best = i
      bestStamp = stamp
    }
  }
  return best
}

/** Map a board's items to carry the DERIVED `inline_active` on the wire.
 *  Cost bound (acceptance e): ONE O(1) evidence read per board, zero per extra
 *  row, no I/O — never call the reader inside the per-item loop. `isRunLive` is
 *  the composer's O(1) run-store `get`, consulted only for rows that actually
 *  carry a `linked_run_id`; omitted ⇒ every bound row is assumed live. */
export function withDerivedInlineActive<T extends InlineActivityScanItem>(
  items: readonly T[],
  reader: InlineEvidenceReader,
  scope: string,
  now: number,
  isRunLive?: (run_id: string) => boolean,
): T[] {
  const last_write_activity_at = reader.lastWriteActivityAt?.(scope) ?? 0
  const linkedRunLive = items.map((it) => {
    const id = typeof it.linked_run_id === 'string' ? it.linked_run_id : ''
    if (id === '') return false
    if (isRunLive === undefined) return true
    try {
      return isRunLive(id)
    } catch {
      // A throwing run store must not brick a board read; assume live (the
      // pre-existing behaviour) rather than inventing activity.
      return true
    }
  })
  const candidate = evidenceCandidateIndex(items, linkedRunLive)
  return items.map((it, i) => ({
    ...it,
    inline_active: deriveInlineActive(
      it,
      { last_write_activity_at, now },
      { evidence_candidate: i === candidate, linked_run_live: linkedRunLive[i] === true },
    ),
  }))
}

export interface InlineActivityDeriverDeps {
  reader: InlineEvidenceReader
  /** Maps a nullable project id onto the evidence scope key (the composer passes
   *  `inspectorScopeKey`). Held ONCE for every read boundary — see below. */
  scopeKey: (project_id: string | null | undefined) => string
  /** Injectable clock; defaults to `Date.now`. Read PER CALL, never captured. */
  now?: () => number
  /** Is a bound trident run still live? The composer passes the SAME predicate
   *  the store's `isRunLive` safety invariant uses, so "bound and running" means
   *  one thing everywhere. Omitted ⇒ every bound row is assumed live. */
  isRunLive?: (run_id: string) => boolean
}

/** The shape every read boundary calls: items in, items with derived
 *  `inline_active` out. Generic so each caller keeps its own row type. */
export interface InlineActivityDeriver {
  <T extends InlineActivityScanItem>(items: readonly T[], project_id: string | null | undefined): T[]
}

/**
 * Build the ONE deriver every read boundary shares.
 *
 * Why a factory rather than calling {@link withDerivedInlineActive} at each site:
 * the two things a call site can get wrong — passing the wrong scope key, or
 * capturing `now` once at composition instead of reading it per call — are then
 * decided in exactly one place and covered by a real behavioural test, instead of
 * being repeated at five deeply nested composer sites where only a source-text
 * regex could see them.
 */
export function makeInlineActivityDeriver(deps: InlineActivityDeriverDeps): InlineActivityDeriver {
  const clock = deps.now ?? ((): number => Date.now())
  return <T extends InlineActivityScanItem>(
    items: readonly T[],
    project_id: string | null | undefined,
  ): T[] =>
    withDerivedInlineActive(items, deps.reader, deps.scopeKey(project_id), clock(), deps.isRunLive)
}
