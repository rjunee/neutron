/**
 * @neutronai/onboarding/wow-moment — LLM selector.
 *
 * Per docs/plans/P2-onboarding-v2.md § 5.3 + § 9.8. Picks 2-3 wow
 * actions out of the candidate set based on collected_data +
 * (optional) import_result. The dispatcher always fires 07
 * (overnight-pass) FIRST and 01 (first-week-brief) LAST around the
 * LLM-selected middle.
 *
 * Algorithm:
 *   1. Build a compact, redacted user-context summary.
 *   2. Call the substrate (Haiku 4.5 in production) with the system
 *      prompt from `prompts/onboarding/wow-action-picker.md`.
 *   3. Parse JSON `{"pick":[...], "explanations":{...}}`. Validate every
 *      id is in `candidates` and `2 <= pick.length <= 3`.
 *   4. On parse error / timeout / API error / invalid pick:
 *      fall back to the deterministic predicate set (every candidate
 *      whose trigger fires, capped at 3, preserving catalogue order).
 *
 * The selector is pure (no DB / channel side effects). The caller
 * (dispatcher) is responsible for telemetry — it receives the selection
 * + a `fallback_used` flag and emits `onboarding.wow_action_selected`.
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ImportResult } from '../history-import/types.ts'
import type { LlmCallFn } from '../interview/phase-spec-resolver.ts'
import type { WowActionContext, WowActionModule } from './action-types.ts'
import type { WowActionId } from './telemetry.ts'

/**
 * The (redacted) user-context summary handed to the LLM. The picker
 * decides on these signals — never raw conversation transcript, never
 * email content. `agent_personality` may quote user-supplied free text;
 * the prompt instructs the model not to repeat it back verbatim.
 */
export interface WowSelectorCollectedData {
  user_first_name?: string
  agent_personality?: string
  work_themes?: ReadonlyArray<string>
  primary_projects?: ReadonlyArray<string>
  non_work_interests?: ReadonlyArray<{ name: string; cadence_hint?: string }>
  rituals?: ReadonlyArray<string>
  inner_circle?: ReadonlyArray<string>
}

export interface WowSelectorInput {
  project_slug: string
  collected_data: WowSelectorCollectedData
  import_result: ImportResult | null
  candidates: ReadonlyArray<WowActionId>
}

export interface WowSelectorResult {
  /** 2-3 ids in dispatch order. Empty only if no candidate's predicate fires AND the LLM returned nothing usable. */
  pick: ReadonlyArray<WowActionId>
  /** action_id → short explanation. May be empty for fallback ids the LLM didn't speak to. */
  explanations: Readonly<Record<string, string>>
  /** True iff we fell back to deterministic predicates. */
  is_fallback: boolean
}

export type WowSelectorLogger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  meta?: Record<string, unknown>,
) => void

export interface WowSelectorDeps {
  llm: LlmCallFn
  log?: WowSelectorLogger
  /**
   * Hard timeout for the LLM call. Defaults to 4000ms — matches the
   * onboarding LLM-driver timeout so behavior is consistent across the
   * onboarding pipeline.
   */
  timeout_ms?: number
  /** System prompt override. Production reads from disk on first use. */
  system_prompt?: string
  /**
   * Optional registry of candidate action modules. The selector uses these
   * only on the FALLBACK path (when the LLM call fails or produces invalid
   * output) to evaluate trigger predicates. The dispatcher always passes
   * the real catalogue here.
   */
  candidate_modules?: Readonly<Record<string, WowActionModule>>
  /**
   * Optional context the FALLBACK path needs to evaluate trigger
   * predicates (rituals, captured_projects, stalled_threads, etc.).
   * Without this, the fallback path returns an empty pick.
   */
  fallback_ctx?: WowActionContext
  /** Max picks. Defaults to 3 per spec § 5.3. */
  max_picks?: number
  /** Min picks. Defaults to 2 per spec § 5.3. */
  min_picks?: number
}

const DEFAULT_TIMEOUT_MS = 4000
const DEFAULT_MIN_PICKS = 2
const DEFAULT_MAX_PICKS = 3

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = join(HERE, '..', '..', 'prompts', 'onboarding', 'wow-action-picker.md')

let cachedSystemPrompt: string | null = null

async function loadSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt
  cachedSystemPrompt = await fs.readFile(PROMPT_PATH, 'utf8')
  return cachedSystemPrompt
}

/** Expose for tests that want to swap the prompt without touching disk. */
export function _setCachedSystemPromptForTests(value: string | null): void {
  cachedSystemPrompt = value
}

/**
 * Select 2-3 wow actions to fire between always-fire 07 and 01. Returns
 * `is_fallback: true` when the LLM path failed at any stage.
 */
export async function pickWowActions(
  input: WowSelectorInput,
  deps: WowSelectorDeps,
): Promise<WowSelectorResult> {
  const min_picks = deps.min_picks ?? DEFAULT_MIN_PICKS
  const max_picks = deps.max_picks ?? DEFAULT_MAX_PICKS
  const timeout_ms = deps.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const log = deps.log ?? (() => undefined)
  const candidate_set = new Set<string>(input.candidates)

  let system_prompt: string
  if (deps.system_prompt !== undefined) {
    system_prompt = deps.system_prompt
  } else {
    try {
      system_prompt = await loadSystemPrompt()
    } catch (err) {
      log('warn', 'wow-selector failed to read system prompt; using deterministic fallback', {
        error: errorMessage(err),
      })
      return fallbackPick({ input, deps, reason: 'prompt_load_failed', max_picks })
    }
  }

  const user_payload = buildUserPayload(input)

  let raw: string
  try {
    raw = await withTimeout(
      deps.llm({ system: system_prompt, user: user_payload, max_tokens: 600 }),
      timeout_ms,
    )
  } catch (err) {
    log('warn', 'wow-selector LLM call failed; falling back to deterministic predicates', {
      error: errorMessage(err),
      project_slug: input.project_slug,
    })
    return fallbackPick({ input, deps, reason: 'llm_error', max_picks })
  }

  const parsed = parseLlmEnvelope(raw)
  if (parsed === null) {
    log('warn', 'wow-selector LLM returned unparseable JSON; falling back', {
      raw_preview: raw.slice(0, 200),
      project_slug: input.project_slug,
    })
    return fallbackPick({ input, deps, reason: 'parse_error', max_picks })
  }

  const validated = validatePick({
    pick: parsed.pick,
    explanations: parsed.explanations,
    candidate_set,
    min_picks,
    max_picks,
  })
  if (validated === null) {
    log('warn', 'wow-selector pick failed validation; falling back', {
      raw_preview: raw.slice(0, 200),
      project_slug: input.project_slug,
    })
    return fallbackPick({ input, deps, reason: 'invalid_pick', max_picks })
  }

  return {
    pick: validated.pick as ReadonlyArray<WowActionId>,
    explanations: validated.explanations,
    is_fallback: false,
  }
}

interface LlmEnvelope {
  pick: string[]
  explanations: Record<string, string>
}

function parseLlmEnvelope(raw: string): LlmEnvelope | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  // Tolerate ```json ... ``` fences the model sometimes emits.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenceMatch !== null ? (fenceMatch[1]?.trim() ?? trimmed) : trimmed
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof json !== 'object' || json === null) return null
  const obj = json as Record<string, unknown>
  const pickRaw = obj['pick']
  if (!Array.isArray(pickRaw)) return null
  const pick: string[] = []
  for (const item of pickRaw) {
    if (typeof item !== 'string') return null
    pick.push(item)
  }
  const explanationsRaw = obj['explanations']
  const explanations: Record<string, string> = {}
  if (explanationsRaw !== undefined && explanationsRaw !== null) {
    if (typeof explanationsRaw !== 'object') return null
    for (const [k, v] of Object.entries(explanationsRaw as Record<string, unknown>)) {
      if (typeof v === 'string') explanations[k] = v
    }
  }
  return { pick, explanations }
}

function validatePick(input: {
  pick: string[]
  explanations: Record<string, string>
  candidate_set: Set<string>
  min_picks: number
  max_picks: number
}): { pick: string[]; explanations: Record<string, string> } | null {
  const seen = new Set<string>()
  const dedup: string[] = []
  for (const id of input.pick) {
    if (!input.candidate_set.has(id)) return null
    if (!seen.has(id)) {
      seen.add(id)
      dedup.push(id)
    }
  }
  if (dedup.length < input.min_picks) return null
  const final = dedup.slice(0, input.max_picks)
  return { pick: final, explanations: input.explanations }
}

interface FallbackArgs {
  input: WowSelectorInput
  deps: WowSelectorDeps
  reason: string
  max_picks: number
}

function fallbackPick(args: FallbackArgs): WowSelectorResult {
  const fallback_ctx = args.deps.fallback_ctx
  const modules = args.deps.candidate_modules
  if (fallback_ctx === undefined || modules === undefined) {
    return { pick: [], explanations: {}, is_fallback: true }
  }
  const pick: WowActionId[] = []
  for (const id of args.input.candidates) {
    if (pick.length >= args.max_picks) break
    const mod = modules[id]
    if (mod === undefined) continue
    let triggered = false
    try {
      triggered = mod.triggerCondition(fallback_ctx)
    } catch {
      triggered = false
    }
    if (triggered) pick.push(id as WowActionId)
  }
  const explanations: Record<string, string> = {}
  for (const id of pick) {
    explanations[id] = `deterministic fallback (${args.reason}): trigger predicate fired`
  }
  return { pick, explanations, is_fallback: true }
}

interface UserPayload {
  project_slug: string
  candidates: ReadonlyArray<string>
  collected_data: WowSelectorCollectedData
  import_summary?: {
    proposed_project_count: number
    proposed_task_count: number
    overdue_task_count: number
    inferred_interest_count: number
  }
}

function buildUserPayload(input: WowSelectorInput): string {
  const payload: UserPayload = {
    project_slug: input.project_slug,
    candidates: input.candidates,
    collected_data: input.collected_data,
  }
  if (input.import_result !== null) {
    payload.import_summary = summarizeImport(input.import_result)
  }
  return JSON.stringify(payload, null, 2)
}

function summarizeImport(r: ImportResult): {
  proposed_project_count: number
  proposed_task_count: number
  overdue_task_count: number
  inferred_interest_count: number
} {
  const now = Date.now()
  const overdue = r.proposed_tasks.filter(
    (t) => typeof t.due_at === 'number' && t.due_at < now,
  ).length
  return {
    proposed_project_count: r.proposed_projects.length,
    proposed_task_count: r.proposed_tasks.length,
    overdue_task_count: overdue,
    inferred_interest_count: r.inferred_interests?.length ?? 0,
  }
}

async function withTimeout<T>(p: Promise<T>, timeout_ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('llm_timeout')), timeout_ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

function errorMessage(err: unknown): string {
  if (err === null || err === undefined) return 'unknown'
  if (err instanceof Error) return err.message
  return String(err)
}
