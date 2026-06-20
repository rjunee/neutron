/**
 * @neutronai/onboarding/synthesis — barrel.
 *
 * The single-session accumulating onboarding architecture (Step 2, 2026-06-17).
 * Authoritative design:
 * `docs/plans/onboarding-single-session-architecture-2026-06-17.md`.
 *
 * Pipeline:
 *   1. `runDeterministicPrepass` — NO-LLM export pre-pass → organized signals
 *      + read batches; raw transcripts persisted to a `RawTranscriptStore`.
 *   2. `runImportSynthesis` / `runInterviewOnlySynthesis` — ONE accumulating
 *      Claude session (factory constructed once, never `/clear`'d) builds the
 *      user-model + per-project seed material.
 *   3. `buildInformedQuestion[Queue]` — informed interview questions grounded
 *      in the synthesized user-model.
 *   4. `writeProjectSeed` / `writeAllProjectSeeds` — populate a project repo
 *      from the seed material on accept (STATUS + history + raw transcripts).
 *
 * This module SUPERSEDES the per-chunk import job-runner + the `/clear`-per-
 * chunk `reset_context_per_turn` import mode (#79).
 */

export * from './types.ts'
export * from './raw-store.ts'
export * from './prepass.ts'
export * from './synthesis-session.ts'
export * from './informed-interview.ts'
export * from './seed-writer.ts'
