/**
 * @neutronai/gateway/realmode-composer — synthesis-session composer (Step 2,
 * 2026-06-17). Authoritative design:
 * `docs/plans/onboarding-single-session-architecture-2026-06-17.md`.
 *
 * Wires the `onboarding/synthesis` pipeline onto a production accumulating
 * substrate. SUPERSEDES the per-chunk `buildImportJobRunnerHook` path + the
 * `/clear`-per-chunk `reset_context_per_turn` import mode (#79):
 *
 *   - The synthesis substrate is built NON-ephemeral + WITHOUT
 *     `reset_context_per_turn`, so every read/consolidation `.start()` REUSES
 *     ONE warm `claude` REPL and the user-model ACCUMULATES across passes. The
 *     old import substrate set `reset_context_per_turn: true` (a `/clear`
 *     written to the PTY between chunks) — the exact anti-pattern this rework
 *     removes.
 *   - The whole import flows through ONE session (the deterministic pre-pass
 *     organizes the export so the session reads in a handful of passes), NOT
 *     ~170 per-chunk spawns.
 *
 * Substrate discipline: every LLM turn dispatches through the injected
 * `Substrate` (the CC-spawn interactive REPL — NEVER a direct
 * api.anthropic.com call, hard rule). The composer constructs the substrate
 * ONCE at boot (Open composer / per-instance gateway) and hands it here.
 */

import { join } from 'node:path'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { ConversationRecord } from '@neutronai/onboarding/history-import/types.ts'
import {
  DiskRawTranscriptStore,
  runDeterministicPrepass,
  runImportSynthesis,
  runInterviewOnlySynthesis,
  writeProjectSeed,
  type ConversationSignal,
  type InterviewAnswer,
  type PrepassResult,
  type ProjectSeed,
  type RawTranscriptStore,
  type SynthesisResult,
  type WriteProjectSeedOutcome,
} from '@neutronai/onboarding/synthesis/index.ts'

export interface BuildSynthesisSessionInput {
  /**
   * The ONE accumulating substrate (non-ephemeral, NO reset_context_per_turn).
   * Built once at composer boot via `buildLlmCallSubstrate({ ... })` with a
   * `cc-synthesis-<handle>` instance id so it stays isolated from the
   * conversational (`cc-llm-*`) + live-agent (`cc-agent-*`) warm pools.
   * Null when the box booted LLM-less — synthesis degrades to the
   * deterministic pre-pass + fallback project (no LLM judgment, but the raw
   * corpus is still organized on disk).
   */
  substrate: Substrate | null
  /** OWNER_ROOT — seeds land under `<owner_home>/Projects/<slug>/`. */
  owner_home: string
  /** Raw-transcript corpus dir. Default `<owner_home>/imports/raw-transcripts`. */
  raw_transcript_dir?: string
  model_preference?: ReadonlyArray<string>
  /** Absolute-ceiling backstop for a synthesis turn (env `NEUTRON_SYNTHESIS_CEILING_MS`). */
  timeout_ms?: number
  /**
   * Idle-heartbeat window for a synthesis turn — the PRIMARY wedge detector
   * (2026-06-18). A turn is abandoned only after its stream goes silent this long;
   * defaults via `SYNTHESIS_IDLE_TIMEOUT_MS_DEFAULT` (env `NEUTRON_SYNTHESIS_IDLE_MS`).
   */
  idle_timeout_ms?: number
  now?: () => number
  logFailure?: (stage: string, err: unknown) => void
}

export interface SynthesisRunner {
  /**
   * Full import pipeline: parse → deterministic pre-pass (raw transcripts to
   * disk) → ONE accumulating synthesis session → user-model + per-project seed
   * material. Returns null when no substrate is wired (LLM-less box) so the
   * caller can fall back to the deterministic-only path.
   */
  synthesizeImport(
    records: AsyncIterable<ConversationRecord>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<SynthesisResult | null>
  /** No-import path: synthesize >= 1 project from interview answers alone. */
  synthesizeInterviewOnly(
    answers: ReadonlyArray<InterviewAnswer>,
  ): Promise<SynthesisResult | null>
  /**
   * Populate a project repo from its seed material (STATUS + history + the
   * bucketed raw transcripts). Called on project-accept. `signalsById` titles
   * the routed transcripts in the history doc; pass the pre-pass conversations
   * map when available.
   */
  writeSeed(
    seed: ProjectSeed,
    signalsById?: ReadonlyMap<string, ConversationSignal>,
  ): WriteProjectSeedOutcome
  /** The raw-transcript store, exposed for the gbrain seam + the seed-writer. */
  readonly rawStore: RawTranscriptStore
}

export function buildSynthesisSession(input: BuildSynthesisSessionInput): SynthesisRunner {
  const rawDir = input.raw_transcript_dir ?? join(input.owner_home, 'imports', 'raw-transcripts')
  const rawStore = new DiskRawTranscriptStore(rawDir)
  const now = input.now ?? Date.now
  const logFailure =
    input.logFailure ??
    ((stage: string, err: unknown): void => {
      // eslint-disable-next-line no-console
      console.warn(
        `[synthesis-session] ${stage}: ${err instanceof Error ? err.message : String(err)}`,
      )
    })

  const synthDeps = (): {
    substrate: Substrate
    rawStore: RawTranscriptStore
    model_preference?: ReadonlyArray<string>
    timeout_ms?: number
    idle_timeout_ms?: number
    logFailure: (stage: string, err: unknown) => void
  } => {
    if (input.substrate === null) {
      throw new Error('buildSynthesisSession: no substrate wired (LLM-less box)')
    }
    return {
      substrate: input.substrate,
      rawStore,
      ...(input.model_preference !== undefined ? { model_preference: input.model_preference } : {}),
      ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
      ...(input.idle_timeout_ms !== undefined ? { idle_timeout_ms: input.idle_timeout_ms } : {}),
      logFailure,
    }
  }

  return {
    rawStore,

    async synthesizeImport(
      records: AsyncIterable<ConversationRecord>,
      onProgress?: (done: number, total: number) => void,
    ): Promise<SynthesisResult | null> {
      if (input.substrate === null) return null
      const prepass: PrepassResult = await runDeterministicPrepass(records, { rawStore })
      const deps = synthDeps()
      return runImportSynthesis(
        onProgress !== undefined ? { ...deps, onProgress } : deps,
        { prepass },
      )
    },

    async synthesizeInterviewOnly(
      answers: ReadonlyArray<InterviewAnswer>,
    ): Promise<SynthesisResult | null> {
      if (input.substrate === null) return null
      return runInterviewOnlySynthesis(synthDeps(), { answers })
    },

    writeSeed(
      seed: ProjectSeed,
      signalsById?: ReadonlyMap<string, ConversationSignal>,
    ): WriteProjectSeedOutcome {
      return writeProjectSeed(
        {
          owner_home: input.owner_home,
          rawStore,
          now,
          ...(signalsById !== undefined ? { signalsById } : {}),
          logFailure: (slug, stage, err) => logFailure(`seed:${slug}:${stage}`, err),
        },
        seed,
      )
    },
  }
}
