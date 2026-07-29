/**
 * @neutronai/tasks-core — LLM-driven pick-next service.
 *
 * Three call sites converge here:
 *   1. `/task focus` chat command (chat-commands.ts)
 *   2. `tasks_pick_next` MCP tool (mcp-tools-extra.ts)
 *   3. Launcher long-press → emits `/task focus` (back to #1)
 *
 * Algorithm:
 *   1. Fetch focus_score-ranked top-N open tasks via
 *      `store.pickNextCandidates({project_id?, limit})`.
 *   2. If empty, return `{candidate: null, rationale: 'No open tasks
 *      ...'}` WITHOUT calling the LLM.
 *   3. Otherwise hand the candidates to the LLM client with the locked
 *      prompt; the client returns `{chosen_index, rationale}`.
 *   4. Candidate is `candidates[chosen_index]`; alternatives are the
 *      runner-ups (focus_score order, capped by `limit_alternatives`).
 *   5. Capture an audit envelope (candidates_considered, model id).
 *
 * Spec input: docs/plans/tasks-core-tier1-brief.md § 3.5.
 *
 * Out of scope (S2): learning loop, per-user prompt override, scheduled
 * morning auto-fire, persistence of past picks.
 */

import type { TaskRow, TaskStore } from './backend.ts'

export interface PickNextInput {
  /** When omitted picks cross-project. Pass to narrow. */
  project_id?: string
  /** Audit + future preference seeding. */
  user_id: string
  /** Default 3, cap 5. */
  limit_alternatives?: number
}

export interface PickNextResult {
  /** Chosen task. null when the owner has zero open tasks. */
  candidate: TaskRow | null
  /**
   * 2-5 line owner-style framing: WHY this one, WHAT to do next.
   * Style lock: terse, engineering-first, no validating openings
   * (SOUL.md hard rule); start with the verb.
   */
  rationale: string
  /** Up to N runner-ups (focus_score order after the candidate). */
  alternatives: TaskRow[]
  /** Deterministic input the LLM call was made against. */
  audit: {
    candidates_considered: number
    focus_score_used: boolean
    llm_model: string
  }
}

/**
 * The LLM client interface. Tests inject a deterministic stub; the
 * production composer wires the same `claude-runner` Sonnet 4.6 with
 * Haiku 4.5 fallback path the onboarding agent uses.
 */
export interface PickNextLlmClient {
  /**
   * Returns the chosen index (0-based into the candidates array) +
   * a one-paragraph rationale. The label `model_id` is surfaced on
   * the audit envelope for observability.
   */
  rank(input: {
    prompt: string
    candidates: TaskRow[]
  }): Promise<{
    chosen_index: number
    rationale: string
    model_id: string
  }>
}

export interface PickNextDeps {
  store: TaskStore
  llm: PickNextLlmClient
  /** Wall-clock override for tests. */
  now?: () => Date
}

export interface PickNextService {
  pick(input: PickNextInput): Promise<PickNextResult>
}

/** Default candidate window — keeps the prompt small + the latency budget tight. */
const DEFAULT_CANDIDATE_LIMIT = 20

/** Default alternatives count shown next to the chosen candidate. */
const DEFAULT_ALTERNATIVE_LIMIT = 3
const MAX_ALTERNATIVE_LIMIT = 5

/**
 * Locked v1 prompt. The owner-voice rules are deliberately repeated in
 * the prompt body so the LLM doesn't need access to SOUL.md to honour
 * them.
 */
export const PICK_NEXT_PROMPT_TEMPLATE = `You are the owner's task-priority assistant. Below is a focus-score-ranked
list of their open tasks. Pick ONE to do RIGHT NOW. Optimize for:
- Highest impact toward the owner's current revenue / customer-growth work
  (priority-map.md: Revenue > Creative > Health > Operations).
- Honor any explicit due_date that's <24h away (bump above lower-
  scored revenue tasks if the due_date hits today).
- Avoid context switches — if the owner was last working on project X
  (per the focus_score ordering already), prefer tasks in the same
  project unless a higher-priority deadline overrides.
- Return the chosen index (0-based) and a 2-5 sentence rationale in
  the owner's voice: terse, engineering-first, no validating openings
  (no "Great question", "Fair call"; no exclamation marks). Start
  with a verb. Example: "Ship the auth-gate PR. It blocks new-customer
  onboarding and the merge gate is the only thing keeping us from
  the launch demo."

Candidates (focus_score DESC, top {count}):
{candidates_json}`

export function buildPickNextService(deps: PickNextDeps): PickNextService {
  return {
    async pick(input: PickNextInput): Promise<PickNextResult> {
      const altCap = Math.max(0, Math.min(
        input.limit_alternatives ?? DEFAULT_ALTERNATIVE_LIMIT,
        MAX_ALTERNATIVE_LIMIT,
      ))
      const candidatesInput: Parameters<TaskStore['pickNextCandidates']>[0] = {
        limit: DEFAULT_CANDIDATE_LIMIT,
      }
      if (input.project_id !== undefined) candidatesInput.project_id = input.project_id
      const candidates = await deps.store.pickNextCandidates(candidatesInput)

      if (candidates.length === 0) {
        return {
          candidate: null,
          rationale: 'No open tasks — pick a project or capture one with `/task <body>`.',
          alternatives: [],
          audit: {
            candidates_considered: 0,
            focus_score_used: true,
            llm_model: 'none',
          },
        }
      }

      const prompt = PICK_NEXT_PROMPT_TEMPLATE
        .replace('{count}', String(candidates.length))
        .replace('{candidates_json}', JSON.stringify(candidates.map(toPromptCandidate), null, 2))

      const result = await deps.llm.rank({ prompt, candidates })
      const chosenIdx = clampIndex(result.chosen_index, candidates.length)
      const chosen = candidates[chosenIdx]
      if (chosen === undefined) {
        // Shouldn't be possible (clamped), but defensive.
        return {
          candidate: null,
          rationale: 'Internal error: LLM returned out-of-range index.',
          alternatives: [],
          audit: {
            candidates_considered: candidates.length,
            focus_score_used: true,
            llm_model: result.model_id,
          },
        }
      }
      const alternatives = candidates
        .filter((c) => c.id !== chosen.id)
        .slice(0, altCap)

      return {
        candidate: chosen,
        rationale: result.rationale.trim() || `Top focus-score: ${chosen.title}.`,
        alternatives,
        audit: {
          candidates_considered: candidates.length,
          focus_score_used: true,
          llm_model: result.model_id,
        },
      }
    },
  }
}

/**
 * Strip TaskRow fields the prompt doesn't need (created_at /
 * updated_at noise) so the LLM sees a compact, decision-relevant view.
 */
function toPromptCandidate(t: TaskRow): Record<string, unknown> {
  const c: Record<string, unknown> = { id: t.id, title: t.title }
  if (t.due_date !== undefined) c['due_date'] = t.due_date
  if (t.priority !== undefined) c['priority'] = t.priority
  if (t.project_id !== undefined) c['project_id'] = t.project_id
  return c
}

function clampIndex(i: number, len: number): number {
  if (!Number.isFinite(i) || Number.isNaN(i)) return 0
  if (i < 0) return 0
  if (i >= len) return len - 1
  return Math.floor(i)
}

/**
 * Deterministic stub for tests + dev composer when no live LLM client
 * is configured. Always returns index 0 with a deterministic rationale
 * derived from the chosen candidate's title.
 */
export function buildStubPickNextLlmClient(): PickNextLlmClient {
  return {
    async rank({ candidates }) {
      const top = candidates[0]
      return {
        chosen_index: 0,
        rationale: top !== undefined
          ? `Top focus-score candidate: "${top.title}". Stub rationale — production composer wires the live Sonnet client.`
          : 'No candidates.',
        model_id: 'stub-pick-next',
      }
    },
  }
}
