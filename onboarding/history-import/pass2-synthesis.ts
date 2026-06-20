/**
 * @neutronai/onboarding/history-import — Pass-2 synthesis (P2 S3).
 *
 * Per docs/plans/P2-onboarding.md § 2.3 — Opus-4.7 reduce step. Takes
 * the aggregated Pass-1 output (deduplicated + summarized) and proposes:
 *   - 3-7 project shells
 *   - 5-15 task seeds
 *   - 3-5 reminder seeds
 *   - 5-20 entity pages
 * Plus voice_signals + facts (user_role / companies / key_people).
 *
 * Aggregation happens BEFORE the LLM call. We take all `Pass1ChunkResult`
 * rows from `import_pass1_chunks`, dedupe entities by canonical-name,
 * merge topics by name overlap, score by (recurrence + recency), and
 * pass that compressed summary as the LLM's input. This keeps Pass-2's
 * prompt under ~80K input tokens even when the export was 5M+ tokens.
 *
 * The LLM call is deliberately substrate-shaped so tests can mock cost
 * + output deterministically.
 */

import type {
  ImportResult,
  InferenceConfidence,
  Pass1ChunkResult,
  CandidateEntity,
  CandidateTopic,
  CandidateTask,
  VoiceSignals,
} from './types.ts'

export interface Pass2LlmCall {
  (input: {
    aggregated: AggregatedPass1
    prompt: string
    /**
     * P2-v2 S22 — current import source (`chatgpt-zip` / `claude-zip`
     * / etc.). Threaded by the runner so the substrate caller's
     * onSonnetFallback hook can populate the `source` field of the
     * `onboarding.pass2_sonnet_fallback_used` telemetry event. Optional
     * for back-compat: existing test mocks that omit `{source}` keep
     * working; the substrate caller's hook simply emits without the
     * source field set (downstream consumers tolerate `source:
     * undefined` and the runner-emitted `import_*` events already
     * carry the canonical source).
     */
    source?: string
  }): Promise<{
    result: unknown
    dollars_billed: number
    /**
     * P2-v2 S21 — optional annotation surfacing which model produced
     * the synthesis. The substrate-backed caller stamps this with
     * `BEST_MODEL` on a primary-model success or `SONNET_MODEL` when
     * the Sonnet 4.6 fallback kicked in after a 429 on Opus 4.7.
     * Omitted by callers that don't care to differentiate (existing
     * S13 retry-on-429 test mocks); consumers default to `BEST_MODEL`.
     */
    synthesizer_model?: string
  }>
}

export interface Pass2Deps {
  llm: Pass2LlmCall
  prompt: string
}

/**
 * Compressed Pass-1 summary the Opus call sees. Trimmed by `aggregatePass1`
 * to keep the input prompt under ~80K tokens for Opus 4.7's typical pricing.
 */
export interface AggregatedPass1 {
  /** Top entities by sum(mention_count). */
  entities: Array<{ name: string; kind: 'person' | 'company' | 'concept'; mention_count: number }>
  /** Top topics by recurrence × recency (oldest dropped first). */
  topics: Array<{ name: string; recurrence_score: number; recency_score: number; summaries: string[] }>
  /** All candidate tasks as-is (dedup + sort by due_at). */
  tasks: CandidateTask[]
  /** Aggregated voice signals — most-frequent value wins per dimension. */
  voice_signals: VoiceSignals
  /** Pass-1 totals for the prompt header. */
  totals: {
    chunks: number
    entities_seen: number
    topics_seen: number
    tasks_seen: number
  }
}

const TOP_ENTITIES = 50
const TOP_TOPICS = 30

/**
 * Reduce N Pass-1 results to the AggregatedPass1 shape that Pass-2 sees.
 * Pure / deterministic / testable — no LLM call here.
 */
export function aggregatePass1(
  pass1Results: ReadonlyArray<Pass1ChunkResult>,
): AggregatedPass1 {
  const entityMap = new Map<string, CandidateEntity & { canonical: string }>()
  const topicMap = new Map<
    string,
    { name: string; recurrence_score: number; recency_score: number; summaries: string[] }
  >()
  const tasks: CandidateTask[] = []
  const voiceCounts: Record<string, Record<string, number>> = {
    tone: {},
    verbosity: {},
    structure_pref: {},
  }
  const sigPhrases: Map<string, number> = new Map()
  let mostRecent = 0
  for (const r of pass1Results) {
    for (const e of r.candidate_entities) {
      const canonical = e.name.trim().toLowerCase()
      if (canonical.length === 0) continue
      const existing = entityMap.get(canonical)
      if (existing !== undefined) {
        existing.mention_count += e.mention_count
        // Prefer the longer / more-properly-cased version of the name.
        if (e.name.length > existing.name.length) existing.name = e.name
      } else {
        entityMap.set(canonical, {
          canonical,
          name: e.name,
          kind: e.kind,
          mention_count: e.mention_count,
        })
      }
    }
    for (const t of r.candidate_topics) {
      const canonical = t.name.trim().toLowerCase()
      if (canonical.length === 0) continue
      const existing = topicMap.get(canonical)
      if (t.recency_at !== undefined && t.recency_at > mostRecent) mostRecent = t.recency_at
      if (existing !== undefined) {
        existing.recurrence_score += 1
        if (t.recency_at !== undefined && t.recency_at > existing.recency_score) {
          existing.recency_score = t.recency_at
        }
        if (t.summary !== undefined && existing.summaries.length < 5)
          existing.summaries.push(t.summary)
      } else {
        topicMap.set(canonical, {
          name: t.name,
          recurrence_score: 1,
          recency_score: t.recency_at ?? 0,
          summaries: t.summary !== undefined ? [t.summary] : [],
        })
      }
    }
    for (const t of r.candidate_tasks) tasks.push(t)
    if (r.voice_signals.tone !== undefined) {
      voiceCounts['tone']![r.voice_signals.tone] =
        (voiceCounts['tone']![r.voice_signals.tone] ?? 0) + 1
    }
    if (r.voice_signals.verbosity !== undefined) {
      voiceCounts['verbosity']![r.voice_signals.verbosity] =
        (voiceCounts['verbosity']![r.voice_signals.verbosity] ?? 0) + 1
    }
    if (r.voice_signals.structure_pref !== undefined) {
      voiceCounts['structure_pref']![r.voice_signals.structure_pref] =
        (voiceCounts['structure_pref']![r.voice_signals.structure_pref] ?? 0) + 1
    }
    if (Array.isArray(r.voice_signals.signature_phrases)) {
      for (const p of r.voice_signals.signature_phrases) {
        sigPhrases.set(p, (sigPhrases.get(p) ?? 0) + 1)
      }
    }
  }

  // Normalize topic recency to a 0..1 score relative to most-recent. If
  // we have no timestamps, every topic gets 0 (recurrence still drives ranking).
  const topics = [...topicMap.values()].map((t) => ({
    name: t.name,
    recurrence_score: t.recurrence_score,
    recency_score: mostRecent > 0 ? t.recency_score / mostRecent : 0,
    summaries: t.summaries,
  }))
  topics.sort((a, b) => b.recurrence_score - a.recurrence_score || b.recency_score - a.recency_score)

  const entities = [...entityMap.values()]
    .sort((a, b) => b.mention_count - a.mention_count)
    .slice(0, TOP_ENTITIES)
    .map((e) => ({ name: e.name, kind: e.kind, mention_count: e.mention_count }))

  // Dedupe tasks by lowercased title.
  const taskSet = new Map<string, CandidateTask>()
  for (const t of tasks) {
    const key = t.title.trim().toLowerCase()
    if (key.length === 0) continue
    if (!taskSet.has(key)) taskSet.set(key, t)
  }
  const dedupedTasks = [...taskSet.values()]
  dedupedTasks.sort((a, b) => (a.due_at ?? Infinity) - (b.due_at ?? Infinity))

  // Pick most-frequent dimension value
  const voice_signals: VoiceSignals = {}
  const tone = pickMostFrequent(voiceCounts['tone'] ?? {})
  if (tone === 'terse' || tone === 'expansive' || tone === 'neutral') voice_signals.tone = tone
  const verbosity = pickMostFrequent(voiceCounts['verbosity'] ?? {})
  if (verbosity === 'low' || verbosity === 'medium' || verbosity === 'high')
    voice_signals.verbosity = verbosity
  const structure = pickMostFrequent(voiceCounts['structure_pref'] ?? {})
  if (structure === 'bullets' || structure === 'prose' || structure === 'mixed')
    voice_signals.structure_pref = structure
  if (sigPhrases.size > 0) {
    voice_signals.signature_phrases = [...sigPhrases.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([p]) => p)
  }

  return {
    entities,
    topics: topics.slice(0, TOP_TOPICS),
    tasks: dedupedTasks,
    voice_signals,
    totals: {
      chunks: pass1Results.length,
      entities_seen: entityMap.size,
      topics_seen: topicMap.size,
      tasks_seen: tasks.length,
    },
  }
}

function pickMostFrequent(counts: Record<string, number>): string | undefined {
  let best: string | undefined
  let bestCount = 0
  for (const [k, v] of Object.entries(counts)) {
    if (v > bestCount) {
      bestCount = v
      best = k
    }
  }
  return best
}

/**
 * Run Pass-2 synthesis over the aggregated Pass-1 results. Returns the
 * final `ImportResult` + the actual dollars billed for this Opus call.
 *
 * Partial-mode: if Pass-1 was cut off by the budget cap, the runner
 * passes a smaller AggregatedPass1 here and `partial=true` lands in the
 * `import_results` row.
 */
export async function pass2Synthesize(
  aggregated: AggregatedPass1,
  deps: Pass2Deps,
  source?: string,
): Promise<{ result: ImportResult; dollars_billed: number; synthesizer_model?: string }> {
  const llmInput: Parameters<Pass2LlmCall>[0] = { aggregated, prompt: deps.prompt }
  if (source !== undefined) llmInput.source = source
  const out = await deps.llm(llmInput)
  const result = parsePass2Result(out.result, aggregated)
  // P2-v2 S21 — pipe the substrate caller's `synthesizer_model`
  // annotation through to the runner so the persisted ImportResult
  // can record which model produced the synthesis (Opus primary vs
  // Sonnet fallback). Pre-S21 callers that don't set it leave the
  // field undefined; the runner defaults to `BEST_MODEL` on persist.
  if (typeof out.synthesizer_model === 'string' && out.synthesizer_model.length > 0) {
    result.synthesizer_model = out.synthesizer_model
  }
  const ret: { result: ImportResult; dollars_billed: number; synthesizer_model?: string } = {
    result,
    dollars_billed: out.dollars_billed,
  }
  if (typeof out.synthesizer_model === 'string' && out.synthesizer_model.length > 0) {
    ret.synthesizer_model = out.synthesizer_model
  }
  return ret
}

/**
 * Parse Pass-2's output. Same defensive tolerance as Pass-1 — degraded
 * input falls back to deriving projects/tasks/etc. from the aggregated
 * Pass-1 summary so the import still produces SOME signal.
 */
export function parsePass2Result(
  raw: unknown,
  aggregated: AggregatedPass1,
): ImportResult {
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

  const out: ImportResult = {
    entities: aggregated.entities,
    topics: aggregated.topics.map((t) => ({
      name: t.name,
      recurrence_score: t.recurrence_score,
      recency_score: t.recency_score,
    })),
    proposed_projects: [],
    proposed_tasks: aggregated.tasks,
    proposed_reminders: [],
    voice_signals: aggregated.voice_signals,
    facts: {},
  }
  // P2 v2 S5 / Codex r1 P2 — stamp the honest Pass-1 chunk count
  // here so the body builder doesn't fall back to entities.length
  // (deduped top-50, NOT one row per conversation). The aggregator
  // already counted them — surface the count along the canonical
  // ImportResult shape.
  if (aggregated.totals.chunks > 0) {
    out.conversation_count = aggregated.totals.chunks
  }

  if (parsed !== null) {
    if (Array.isArray(parsed['proposed_projects'])) {
      for (const p of parsed['proposed_projects']) {
        if (
          typeof p === 'object' &&
          p !== null &&
          typeof (p as { name?: unknown }).name === 'string' &&
          typeof (p as { rationale?: unknown }).rationale === 'string'
        ) {
          const pp = p as { name: string; rationale: string; suggested_topics?: unknown }
          const suggested = Array.isArray(pp.suggested_topics)
            ? pp.suggested_topics.filter((s): s is string => typeof s === 'string')
            : []
          out.proposed_projects.push({
            name: pp.name,
            rationale: pp.rationale,
            suggested_topics: suggested,
          })
        }
      }
    }
    if (Array.isArray(parsed['proposed_tasks'])) {
      const llmTasks: CandidateTask[] = []
      for (const t of parsed['proposed_tasks']) {
        if (
          typeof t === 'object' &&
          t !== null &&
          typeof (t as { title?: unknown }).title === 'string'
        ) {
          const tt = t as {
            title: string
            due_at?: unknown
            priority_hint?: unknown
          }
          const out2: CandidateTask = { title: tt.title }
          if (typeof tt.due_at === 'number' && Number.isFinite(tt.due_at)) out2.due_at = tt.due_at
          if (
            tt.priority_hint === 'P0' ||
            tt.priority_hint === 'P1' ||
            tt.priority_hint === 'P2' ||
            tt.priority_hint === 'P3'
          )
            out2.priority_hint = tt.priority_hint
          llmTasks.push(out2)
        }
      }
      if (llmTasks.length > 0) out.proposed_tasks = llmTasks
    }
    if (Array.isArray(parsed['proposed_reminders'])) {
      for (const r of parsed['proposed_reminders']) {
        if (
          typeof r === 'object' &&
          r !== null &&
          typeof (r as { pattern?: unknown }).pattern === 'string' &&
          typeof (r as { body?: unknown }).body === 'string'
        ) {
          const rr = r as { pattern: string; body: string }
          out.proposed_reminders.push({ pattern: rr.pattern, body: rr.body })
        }
      }
    }
    const f = parsed['facts']
    if (typeof f === 'object' && f !== null) {
      const ff = f as Record<string, unknown>
      if (typeof ff['user_role'] === 'string') out.facts.user_role = ff['user_role']
      if (Array.isArray(ff['companies']))
        out.facts.companies = ff['companies'].filter((s): s is string => typeof s === 'string')
      if (Array.isArray(ff['key_people']))
        out.facts.key_people = ff['key_people'].filter((s): s is string => typeof s === 'string')
    }
    const vs = parsed['voice_signals']
    if (typeof vs === 'object' && vs !== null) {
      const v = vs as Record<string, unknown>
      if (v['tone'] === 'terse' || v['tone'] === 'expansive' || v['tone'] === 'neutral')
        out.voice_signals.tone = v['tone']
      if (v['verbosity'] === 'low' || v['verbosity'] === 'medium' || v['verbosity'] === 'high')
        out.voice_signals.verbosity = v['verbosity']
      if (
        v['structure_pref'] === 'bullets' ||
        v['structure_pref'] === 'prose' ||
        v['structure_pref'] === 'mixed'
      )
        out.voice_signals.structure_pref = v['structure_pref']
      if (Array.isArray(v['signature_phrases'])) {
        out.voice_signals.signature_phrases = v['signature_phrases'].filter(
          (s): s is string => typeof s === 'string',
        )
      }
    }
    // P2 v2 § 2.3 / S5 — inferred_interests (non-work bullets).
    // Optional, schema-additive: missing field → field absent on out.
    // Each element accepted in two shapes for tolerance — plain string
    // ("climbing") or full object ({name, basis?, cadence_hint?}).
    if (Array.isArray(parsed['inferred_interests'])) {
      const interests: Array<{
        name: string
        basis?: string
        cadence_hint?: 'weekly' | 'monthly' | 'occasional'
      }> = []
      for (const i of parsed['inferred_interests']) {
        if (typeof i === 'string' && i.trim().length > 0) {
          interests.push({ name: i.trim() })
          continue
        }
        if (typeof i !== 'object' || i === null) continue
        const ii = i as Record<string, unknown>
        if (typeof ii['name'] !== 'string' || ii['name'].trim().length === 0) {
          continue
        }
        const entry: { name: string; basis?: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' } = {
          name: (ii['name'] as string).trim(),
        }
        if (typeof ii['basis'] === 'string' && ii['basis'].length > 0) {
          entry.basis = ii['basis']
        }
        if (
          ii['cadence_hint'] === 'weekly' ||
          ii['cadence_hint'] === 'monthly' ||
          ii['cadence_hint'] === 'occasional'
        ) {
          entry.cadence_hint = ii['cadence_hint']
        }
        interests.push(entry)
      }
      if (interests.length > 0) out.inferred_interests = interests
    }
    // P2 v2 § 2.5 / S5 — confidence_by_inference scores. Accepts the
    // flat-array shape (the LLM-prompt format) AND a tolerant
    // grouped shape (per-kind sub-arrays under projects/themes/
    // interests keys) since older Atlas drafts used the grouped form.
    // Each accepted entry must have a `field` string + a numeric
    // `score`; bogus entries (missing field, NaN, out-of-range score)
    // are silently dropped.
    const confidence_entries: InferenceConfidence[] = []
    const rawConfidence = parsed['confidence_by_inference']
    if (Array.isArray(rawConfidence)) {
      for (const c of rawConfidence) {
        const entry = parseConfidenceEntry(c)
        if (entry !== null) confidence_entries.push(entry)
      }
    } else if (typeof rawConfidence === 'object' && rawConfidence !== null) {
      const grouped = rawConfidence as Record<string, unknown>
      for (const kind of ['projects', 'interests'] as const) {
        const arr = grouped[kind]
        if (!Array.isArray(arr)) continue
        const prefix = kind === 'projects' ? 'project:' : 'interest:'
        for (const c of arr) {
          // Grouped entries may use `name` instead of `field`; the
          // parser falls back to `name` and prefixes the kind.
          if (typeof c === 'object' && c !== null) {
            const cc = c as Record<string, unknown>
            if (typeof cc['field'] !== 'string' && typeof cc['name'] === 'string') {
              const synthesized = { ...cc, field: `${prefix}${cc['name']}` }
              const entry = parseConfidenceEntry(synthesized)
              if (entry !== null) confidence_entries.push(entry)
              continue
            }
          }
          const entry = parseConfidenceEntry(c)
          if (entry !== null) confidence_entries.push(entry)
        }
      }
    }
    if (confidence_entries.length > 0) {
      out.confidence_by_inference = confidence_entries
    }
  }

  return out
}

function parseConfidenceEntry(raw: unknown): InferenceConfidence | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r['field'] !== 'string' || r['field'].length === 0) return null
  if (typeof r['score'] !== 'number' || !Number.isFinite(r['score'])) return null
  const score = Math.max(0, Math.min(1, r['score']))
  const entry: InferenceConfidence = { field: r['field'], score }
  if (typeof r['basis'] === 'string' && r['basis'].length > 0) {
    entry.basis = r['basis']
  }
  return entry
}
