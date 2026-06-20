/**
 * @neutronai/onboarding/history-import — Pass-1 triage (P2 S3).
 *
 * Per docs/plans/P2-onboarding.md § 2.3 — fast Haiku-4.5 map-only over
 * 50K-token chunks. Per chunk, the LLM extracts:
 *   - candidate_entities (names mentioned ≥2× — person | company | concept)
 *   - candidate_topics (recurring multi-message threads)
 *   - candidate_tasks (verb-direct-object statements that look actionable)
 *   - voice_signals (tone / verbosity / structure preference / signature
 *     phrases — used by S2's persona-gen if Pass-2 imports lands before
 *     persona compose runs)
 *
 * The function takes a substrate-shaped LLM caller (so tests can mock)
 * and returns the parsed `Pass1ChunkResult` plus the dollars billed.
 * On parse failure the function yields a degraded result with empty
 * arrays + a non-zero `dollars_billed` (we still owe Anthropic for the
 * call); the runner persists this so re-runs see the chunk_hash and
 * skip even though the prior result was empty.
 *
 * NOTE on dollars accounting: the LLM caller returns the actual
 * billed cost; we don't compute it locally. This matches the way
 * runtime/credential-pool.ts pairs with the substrate's billing
 * report.
 */

import type { Chunk, Pass1ChunkResult } from './types.ts'

/**
 * Substrate-shaped LLM caller for Pass-1. The real implementation
 * dispatches a Haiku-4.5 message; tests inject a deterministic mock.
 *
 * The caller MUST return:
 *   - `result`: the parsed JSON output (the prompt instructs the LLM
 *     to emit a single JSON object). May be null on LLM error.
 *   - `dollars_billed`: actual cost. Tests use the same number for
 *     deterministic budget assertions.
 */
export interface Pass1LlmCall {
  (input: { chunk: Chunk; prompt: string }): Promise<{
    result: unknown
    dollars_billed: number
  }>
}

export interface Pass1Deps {
  llm: Pass1LlmCall
  prompt: string
}

/**
 * Run Pass-1 triage on a single chunk. Returns `Pass1ChunkResult` ready
 * to land on the `import_pass1_chunks` row.
 */
export async function pass1Triage(
  chunk: Chunk,
  deps: Pass1Deps,
): Promise<Pass1ChunkResult> {
  const { result, dollars_billed } = await deps.llm({ chunk, prompt: deps.prompt })
  return parsePass1Result(chunk, result, dollars_billed)
}

/**
 * Parse the LLM's JSON output into a Pass1ChunkResult. Handles:
 *   - already-an-object input (mock pattern)
 *   - JSON-string input (real LLM output)
 *   - garbage input (returns empty arrays so the chunk still costs $)
 *
 * Exported for unit-test seam testing.
 */
export function parsePass1Result(
  chunk: Chunk,
  raw: unknown,
  dollars_billed: number,
): Pass1ChunkResult {
  let parsed: Record<string, unknown> | null = null
  if (raw === null || raw === undefined) {
    parsed = null
  } else if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      parsed = null
    }
  } else if (typeof raw === 'object') {
    parsed = raw as Record<string, unknown>
  }

  const out: Pass1ChunkResult = {
    chunk_hash: chunk.chunk_hash,
    candidate_entities: [],
    candidate_topics: [],
    candidate_tasks: [],
    voice_signals: {},
    dollars_billed,
  }

  if (parsed === null) return out

  const ents = parsed['candidate_entities']
  if (Array.isArray(ents)) {
    for (const e of ents) {
      if (
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { name?: unknown }).name === 'string'
      ) {
        const ee = e as { name: string; kind?: unknown; mention_count?: unknown }
        const kind =
          ee.kind === 'person' || ee.kind === 'company' || ee.kind === 'concept'
            ? ee.kind
            : 'concept'
        const mention_count =
          typeof ee.mention_count === 'number' && Number.isFinite(ee.mention_count)
            ? Math.max(1, Math.floor(ee.mention_count))
            : 1
        out.candidate_entities.push({ name: ee.name, kind, mention_count })
      }
    }
  }

  const topics = parsed['candidate_topics']
  if (Array.isArray(topics)) {
    for (const t of topics) {
      if (
        typeof t === 'object' &&
        t !== null &&
        typeof (t as { name?: unknown }).name === 'string'
      ) {
        const tt = t as { name: string; summary?: unknown; recency_at?: unknown }
        const ct: { name: string; summary?: string; recency_at?: number } = { name: tt.name }
        if (typeof tt.summary === 'string') ct.summary = tt.summary
        if (typeof tt.recency_at === 'number' && Number.isFinite(tt.recency_at))
          ct.recency_at = tt.recency_at
        out.candidate_topics.push(ct)
      }
    }
  }

  const tasks = parsed['candidate_tasks']
  if (Array.isArray(tasks)) {
    for (const t of tasks) {
      if (
        typeof t === 'object' &&
        t !== null &&
        typeof (t as { title?: unknown }).title === 'string'
      ) {
        const tt = t as { title: string; due_at?: unknown; priority_hint?: unknown }
        const ct: {
          title: string
          due_at?: number
          priority_hint?: 'P0' | 'P1' | 'P2' | 'P3'
        } = { title: tt.title }
        if (typeof tt.due_at === 'number' && Number.isFinite(tt.due_at)) ct.due_at = tt.due_at
        if (
          tt.priority_hint === 'P0' ||
          tt.priority_hint === 'P1' ||
          tt.priority_hint === 'P2' ||
          tt.priority_hint === 'P3'
        )
          ct.priority_hint = tt.priority_hint
        out.candidate_tasks.push(ct)
      }
    }
  }

  const vs = parsed['voice_signals']
  if (typeof vs === 'object' && vs !== null) {
    const v = vs as Record<string, unknown>
    if (v['tone'] === 'terse' || v['tone'] === 'expansive' || v['tone'] === 'neutral') {
      out.voice_signals.tone = v['tone']
    }
    if (v['verbosity'] === 'low' || v['verbosity'] === 'medium' || v['verbosity'] === 'high') {
      out.voice_signals.verbosity = v['verbosity']
    }
    if (
      v['structure_pref'] === 'bullets' ||
      v['structure_pref'] === 'prose' ||
      v['structure_pref'] === 'mixed'
    ) {
      out.voice_signals.structure_pref = v['structure_pref']
    }
    if (Array.isArray(v['signature_phrases'])) {
      const sigs = v['signature_phrases'].filter((s): s is string => typeof s === 'string')
      if (sigs.length > 0) out.voice_signals.signature_phrases = sigs
    }
  }

  return out
}
