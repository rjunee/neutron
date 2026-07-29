/**
 * @neutronai/work-board — server-side task_type auto-classifier (#429 task 3).
 *
 * The ONE place a Work Board card title is classified into how it will be
 * executed — `build` (code/artifact work → Trident) vs `research`
 * (investigation → Atlas). It replaces the manual Build/Research picker the web
 * add-form used to render: an omitted `task_type` on create is classified here.
 *
 * FAST_MODEL is NOT hardcoded here. `LlmCallFn` carries no model id — the
 * composer picks the model when it builds the call
 * (`buildAnthropicLlmCall({ substrate, model: FAST_MODEL })`), so this file adds
 * NO Claude model literal (coordinates with the plan's model-centralization
 * task). An LLM-less boot (`llm: null`) classifies by keyword only.
 *
 * CONTRACT: `classifyWorkBoardTaskType` is total — it NEVER rejects. Any LLM
 * throw / timeout / junk / ambiguous response degrades to the deterministic
 * `keywordTaskTypeFallback`, which always returns a valid type.
 */

import type { LlmCallFn } from '@neutronai/contracts/llm-call.ts'
import type { WorkBoardTaskType } from './store.ts'
import { createLogger } from '@neutronai/logger'

/** Default LLM timeout — a stuck classify call must never block a create. */
export const DEFAULT_TASK_TYPE_CLASSIFY_TIMEOUT_MS = 2_500

/**
 * Verbs/phrases that signal INVESTIGATION work. A title matching any of these
 * (or starting with an interrogative) is classified `research`; otherwise
 * `build`. The deterministic fallback + the LLM-junk backstop.
 */
const RESEARCH_VERB_RE =
  /\b(research|investigate|analy[sz]e|analysis|compare|comparison|evaluate|explore|summari[sz]e|survey|look into|find out|dig into|deep dive)\b/i
const INTERROGATIVE_START_RE =
  /^\s*(what|why|how|which|when|where|who|whether|should|is|are|does|do|can|could|would)\b/i

/**
 * Deterministic title → task_type heuristic. `research` iff the title carries a
 * research verb/phrase OR opens with an interrogative; else `build`. Total.
 */
export function keywordTaskTypeFallback(title: string): WorkBoardTaskType {
  if (RESEARCH_VERB_RE.test(title) || INTERROGATIVE_START_RE.test(title)) {
    return 'research'
  }
  return 'build'
}

export interface ClassifyWorkBoardTaskTypeInput {
  title: string
  llm: LlmCallFn | null
  timeout_ms?: number
}

/**
 * Locked classify prompt. One-word reply; the model picks the execution shape.
 */
export const CLASSIFY_SYSTEM_PROMPT = `You classify a work-board card title into how the work will be executed. Reply with exactly one word.
build — code or artifact work: implement, fix, add, refactor, wire, ship, create something.
research — investigation work: research, analyze, compare, evaluate, summarize, gather information, answer a question.
If ambiguous, reply build.`

/**
 * Classify a card title into `build` | `research`. LLM-primary with a
 * deterministic keyword fallback baked in — NEVER rejects.
 *
 * - `llm === null` → keyword fallback, no call attempted.
 * - LLM returns exactly one of build/research → that type.
 * - LLM returns both / neither / junk / throws / times out → keyword fallback.
 */
export async function classifyWorkBoardTaskType(
  input: ClassifyWorkBoardTaskTypeInput,
): Promise<WorkBoardTaskType> {
  if (input.llm === null) return keywordTaskTypeFallback(input.title)
  const timeout_ms = input.timeout_ms ?? DEFAULT_TASK_TYPE_CLASSIFY_TIMEOUT_MS
  try {
    const raw = await callWithTimeout(
      input.llm,
      { system: CLASSIFY_SYSTEM_PROMPT, user: input.title, max_tokens: 16 },
      timeout_ms,
    )
    const text = raw.toLowerCase().trim()
    const hasResearch = /\bresearch\b/.test(text)
    const hasBuild = /\bbuild\b/.test(text)
    if (hasResearch && !hasBuild) return 'research'
    if (hasBuild && !hasResearch) return 'build'
    // Both or neither → junk; fall through to the keyword fallback.
    return keywordTaskTypeFallback(input.title)
  } catch (error) {
    createLogger('work-board-task-type').warn('classify_fell_back_keyword', {
      error: error instanceof Error ? error.message : String(error),
    })
    return keywordTaskTypeFallback(input.title)
  }
}

/**
 * Wrap `llm` in a timeout so a stuck classify call can never block a create.
 * Rejects with an Error on expiry; clears the timer on settle. Mirrors
 * `tasks/prioritize-llm.ts` `callWithTimeout`.
 */
async function callWithTimeout(
  llm: LlmCallFn,
  call: { system: string; user: string; max_tokens: number },
  timeout_ms: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('work_board_task_type_classify_timeout')),
      timeout_ms,
    )
    llm(call)
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
  })
}
