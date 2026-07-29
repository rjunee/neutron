/**
 * @neutronai/reflection — shared types for the lightweight reflection +
 * learning layer (diary + corrections-log).
 *
 * This layer COMPLEMENTS the memory subsystems, it does not replace them:
 *   - GBrain / scribe (`scribe/`, `gbrain-memory/`) capture durable ENTITY
 *     knowledge (people / companies / concepts) extracted from chat.
 *   - The entity-writer (`runtime/entity-writer.ts`) is the structured wiki.
 *   - Reflection is the SELF-IMPROVEMENT loop: the agent's own short
 *     reflections (the diary) and the owner's corrections of the agent (the
 *     corrections-log) — read back into context so the agent adapts silently.
 *
 * Storage is deliberately MECHANICAL + deterministic (plain append-only
 * markdown under `<ownerDataDir>/diary/` + `<ownerDataDir>/corrections/`). The
 * ONLY non-deterministic step is the LLM judgement of "was this a correction?"
 * (`detector.ts`); everything else is pure string + filesystem work so it is
 * trivially testable and OSS-friendly (no DB, no service dependency).
 */

/** A single diary entry — the agent's own short reflection. */
export interface DiaryEntry {
  /** ISO-8601 timestamp the entry was recorded (UTC). */
  ts: string
  /** UTC day key (YYYY-MM-DD) the entry was filed under. */
  date: string
  /** Free classification — defaults to `reflection`. */
  kind: string
  /** Optional session / topic the reflection belongs to. */
  session: string | null
  /** The reflection text (single logical line; newlines collapsed on write). */
  text: string
}

/** A single corrections-log entry — a learning the agent must apply going forward. */
export interface Correction {
  /** Stable short id (timestamp-derived, sortable). */
  id: string
  /** ISO-8601 timestamp the correction was recorded (UTC). */
  ts: string
  /** What the agent did / assumed that the owner corrected. */
  wrong: string
  /** What the owner wants instead — the durable learning. */
  right: string
  /** Why — the reason / context, so the learning generalizes. */
  why: string
  /** Scope the correction was observed in (topic id or `general`). */
  scope: string
  /** Short excerpt of the correcting message, for provenance. */
  source: string
}

/** Result of the LLM correction-judgement over one (user, agent) exchange. */
export interface CorrectionJudgment {
  is_correction: boolean
  wrong: string
  right: string
  why: string
}
