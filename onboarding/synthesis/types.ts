/**
 * @neutronai/onboarding/synthesis — shared types (Step 2, 2026-06-17).
 *
 * The single-session accumulating onboarding architecture. Authoritative
 * design: `docs/plans/onboarding-single-session-architecture-2026-06-17.md`
 * (referenced from SPEC.md Decisions Log 2026-06-17).
 *
 * This module SUPERSEDES the per-chunk import job-runner path
 * (`onboarding/history-import/job-runner.ts` + the `/clear`-per-chunk
 * `reset_context_per_turn` mode, #79). Where the old path made one heavy
 * LLM call PER 150K-token chunk (then `/clear`'d the context — the exact
 * opposite of building an accumulating model of the user), the synthesis
 * session reads the organized history progressively through ONE warm
 * `claude` session that NEVER clears, holding a running user-model in its
 * working context and routing each conversation into a per-project bucket.
 *
 * Shapes here are the public surface of the module — every other
 * synthesis file imports from this one. The `VoiceSignals` shape is reused
 * verbatim from history-import so the interview's persona path and the
 * synthesis path speak the same "voice" language.
 */

import type { VoiceSignals } from '../history-import/types.ts'

export type { VoiceSignals }

/**
 * Per-conversation signal extracted by the DETERMINISTIC (no-LLM) pre-pass.
 * Cheap to compute over a 3.6M-token export so the synthesis session reads
 * in a handful of passes instead of ~170 per-chunk spawns. The raw
 * transcript text is NOT carried here — it lives in the `RawTranscriptStore`
 * (on disk in production) and is loaded only when a project seed needs it.
 */
export interface ConversationSignal {
  conversation_id: string
  /** Source title (Claude `name` / ChatGPT `title`); '' when the source had none. */
  title: string
  /** Unix-ms of the conversation; null when the source carried no timestamp. */
  created_at: number | null
  /** Total message count (all roles). */
  message_count: number
  /** ~4-chars-per-token estimate over the full transcript text. */
  approx_tokens: number
  /** Top content terms by frequency (drives entity surfacing + routing hints). */
  top_terms: string[]
  /** Short snippet of the first substantive user message (read-prompt context). */
  snippet: string
}

/**
 * A grouping of conversations the synthesis session reads in ONE pass.
 * Sized so the batch's summaries fit comfortably in the session's working
 * context alongside the running user-model (the raw transcripts never enter
 * the LLM context — only the cheap signals do).
 */
export interface ReadingBatch {
  index: number
  conversation_ids: string[]
  /** Sum of member-signal `approx_tokens`. */
  approx_tokens: number
}

/** Deterministic pre-pass output. NO LLM was involved in producing this. */
export interface PrepassResult {
  total_conversations: number
  total_approx_tokens: number
  /** All conversation signals, sorted by recency (most-recent first). */
  conversations: ConversationSignal[]
  /** Reading batches over `conversations`, in read order. */
  reading_batches: ReadingBatch[]
  /** Global top terms across the whole export (frequency-ranked). */
  top_terms: Array<{ term: string; count: number }>
}

/**
 * A project the synthesis session detected (or the interview-only path
 * stood up from answers). Accumulates across read passes — the running
 * model the session holds in context.
 */
export interface ProjectModel {
  /** Stable kebab-case id == project folder name under `Projects/`. */
  slug: string
  name: string
  /** One-line status ("active", "launching in 3 weeks", …). */
  status: string
  /** 1-3 sentence overview of what the project is + where it stands. */
  overview: string
  /** Open threads / next steps surfaced from the history. */
  open_threads: string[]
  /** conversation_ids routed to this project (the per-project transcript bucket). */
  conversation_ids: string[]
}

/**
 * The "here's what I know about you" model the interview presents and the
 * informed questions draw on. Built by the synthesis session; source is
 * either an import (transcripts) or interview answers alone.
 */
export interface UserModel {
  /** 2-4 sentence "here's what I know about you" summary. */
  summary: string
  projects: ProjectModel[]
  people: string[]
  open_threads: string[]
  tasks: string[]
  style: VoiceSignals
}

/**
 * Per-project seed material the project repo is populated from on accept.
 * The seed-writer turns this into `STATUS.md` + a history doc + the bucketed
 * raw transcripts under `Projects/<slug>/`.
 */
export interface ProjectSeed {
  slug: string
  name: string
  status: string
  overview: string
  open_threads: string[]
  /** conversation_ids whose raw transcript routes into this project. */
  conversation_ids: string[]
}

export type SynthesisSource = 'import' | 'interview'

/** Output of a synthesis run. */
export interface SynthesisResult {
  source: SynthesisSource
  user_model: UserModel
  project_seeds: ProjectSeed[]
  /** How many read passes the session ran (0 for interview-only). */
  batches_read: number
  /**
   * How many non-empty read passes were DISPATCHED to the session (excludes
   * skipped empty batches). 0 for interview-only. With `read_passes_succeeded`
   * this lets the caller distinguish "honestly empty export" (attempted === 0)
   * from "every read pass failed" (attempted > 0, succeeded === 0 — the
   * production hang signature) so it can surface an honest failure instead of a
   * blank wow. (2026-06-18 synthesis-completes fix.)
   */
  read_passes_attempted: number
  /**
   * How many dispatched read passes produced usable (non-empty) text, AFTER the
   * single timeout-retry. (2026-06-18.)
   */
  read_passes_succeeded: number
  /**
   * How many times the substrate FACTORY was constructed during this run.
   * MUST be 1 — the whole point of the rework is ONE accumulating session.
   * Surfaced so callers + tests can assert the factory-once contract without
   * reaching into the substrate internals.
   */
  factory_constructions: number
}

/**
 * One interview answer fed to the no-import (interview-only) synthesis path.
 * `prompt` is the question the agent asked; `answer` is what the user said.
 */
export interface InterviewAnswer {
  prompt: string
  answer: string
}
