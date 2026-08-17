/**
 * @neutronai/trident — bounded Fable build-escalation arbiter.
 *
 * This is the ARBITER TIER mandated by the 2026-08-15 owner rule: "if you
 * can't solve a problem, escape to a Fable agent to arbitrate; only owner-only
 * questions block on the owner". It sits ABOVE the #342 conflict resolver:
 * resolver fails → arbiter decides (resolve differently / rebuild / genuinely
 * stop) → only then chat.
 *
 * It ARBITRATES; it does not build. The turn has read-only tools, produces only
 * a decision, cannot approve/merge/skip review, and is capped per run. The
 * owner-only test is verbatim: "is the owner the only entity in the world who
 * can answer this? If a capable engineer with repository access could answer
 * it, it is not owner-only."
 */

import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import { FABLE_MODEL } from '@neutronai/runtime/models.ts'
import type { TridentRun } from './store.ts'
import { DEFAULT_TIMEOUT_MS } from './liveness.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import {
  NO_INTERACTIVE_RULE,
  REDIRECT_RULE,
  NO_PATTERN_KILL_RULE,
} from './conflict-resolver.ts'

export interface ArbitrationOption {
  id: string
  description: string
}

export interface ArbitrationInput {
  run: TridentRun
  /** Read-only inspection root (the run's repo/worktree). */
  repo_path: string
  /** ONE specific technical question. */
  question: string
  /** What happened: conflict paths, resolver outcome, git output excerpts. */
  evidence: string
  /** Non-empty; the arbiter picks exactly one or declares owner-only. */
  options: ArbitrationOption[]
}

export type ArbitrationOutcome =
  | { kind: 'decision'; option_id: string; reasoning: string }
  | { kind: 'owner-only'; question: string }
  /**
   * The caller MUST fall back to its existing escalation behaviour (today's
   * chat path). An unavailable arbiter never blocks a run and never guesses.
   */
  | { kind: 'unavailable'; reason: string }

export interface ArbitrationRecord {
  /** ISO-8601 UTC. */
  at: string
  question: string
  evidence: string
  options: ArbitrationOption[]
  outcome: ArbitrationOutcome
}

export type TridentArbiter = (input: ArbitrationInput) => Promise<ArbitrationOutcome>

export const FORBIDDEN_OPTION_IDS = [
  'approve',
  'merge',
  'skip-review',
  'bypass-review',
  'self-approve',
] as const

const FORBIDDEN_OPTIONS = new Set<string>(FORBIDDEN_OPTION_IDS)

/**
 * Structural authority boundary: forbidden actions cannot even enter the set
 * from which an arbiter is allowed to select.
 */
export function assertArbitrableOptions(options: ArbitrationOption[]): void {
  if (options.length === 0) {
    throw new TypeError('arbitration options must not be empty')
  }

  for (const option of options) {
    const normalized = option.id.trim().toLowerCase()
    if (FORBIDDEN_OPTIONS.has(normalized)) {
      throw new TypeError(`arbitration option '${option.id}' is forbidden`)
    }
  }
}

/**
 * A narrow, deterministic pre-guard for decisions that only the owner can
 * authorize. In particular, trident's "publish the branch" vocabulary is an
 * internal git operation and MUST NOT be mistaken for publishing a release.
 */
export function isOwnerOnlyQuestion(question: string): boolean {
  return [
    /\$\d/i,
    /\b(?:spend|pay for|purchase|buy|subscription|billing|budget)\b/i,
    /\bdeploy(?:s|ing|ment)?\b.*\b(?:prod|production|live)\b/i,
    /\bproduction deploy/i,
    /\bsend\b.*\b(?:email|invoice|message)\b/i,
    /\bon (?:the )?owner'?s behalf\b/i,
    /\bpublish\b.*\b(?:release|package|npm|app store|announcement)\b/i,
    /\bsign\b.*\bcontract\b/i,
    /\bcommit(?:ment)? to (?:the )?(?:client|customer)\b/i,
  ].some((pattern) => pattern.test(question))
}

export const ARBITER_TOOL_NAMES = ['Read', 'Glob', 'Grep', 'Bash'] as const

/**
 * The arbiter is read-only, but it still needs an explicit inspection surface.
 * The #361/#175 lesson applies here too: an empty grant spawns a toolless
 * subprocess, so Read/Glob/Grep/read-only Bash must be declared explicitly.
 */
const ARBITER_TOOLS: AgentSpec['tools'] = ARBITER_TOOL_NAMES.map((name) => ({
  name,
  description: `Built-in Claude Code tool '${name}' (trident arbiter surface)`,
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  capability_required: 'fs:project_data',
}))

function arbiterPrompt(input: ArbitrationInput): string {
  const options = input.options
    .map((option) => `- ${option.id}: ${option.description}`)
    .join('\n')

  return `You are a FABLE ARBITER — Neutron's build-escalation judge. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE} ${NO_PATTERN_KILL_RULE}

READ-ONLY — you may Read/Glob/Grep and run READ-ONLY Bash (git log/diff/show, ls, test inspection) inside ${input.repo_path}; you must NEVER edit a file, run \`git add\`, \`git commit\`, \`git rebase\`, \`git merge\`, or \`git push\`, approve work, or waive review. Your decision only SELECTS among the options below; the caller applies it. STAY INSIDE YOUR CWD. Every path you Read, Glob, Grep, or inspect from Bash must be under ${input.repo_path}. Other builds are running against other checkouts of this same repository on this machine; a stack trace, an import error, or a tool suggestion that points somewhere else is pointing at someone else's working tree — do not follow it and never modify it.

QUESTION: ${input.question}
EVIDENCE: ${input.evidence}
OPTIONS:
${options}

Decide like a competent reviewer with repository access would; inspect the repo as needed. Then emit as your FINAL TWO LINES exactly:
DECISION: <one option id from the list>
REASONING: <2-4 sentences: why, and what you verified>

OR, if the question is genuinely owner-only (spending money, external commitments, deploying, publishing a release, sending on the owner's behalf, a product/priority call, anything irreversible outside the repository — the test: is the owner the only entity in the world who can answer this?), emit as your FINAL line exactly:
OWNER_ONLY: <one well-formed question for the owner, with the options already worked out>

BUILD TASK CONTEXT (what this run was building):
${input.run.task}`
}

export const DEFAULT_ARBITER_CAP = 3

export interface BuildFableArbiterOptions {
  /** Production passes `makeEphemeralSubstrate('cc-trident-arbiter')`. */
  build_substrate: (cwd: string) => Substrate
  /** Defaults to `[FABLE_MODEL]`. */
  model_preference?: string[]
  /** Wall-clock ceiling for the single arbitration turn (ms). */
  timeout_ms?: number
  /** Maximum arbitration attempts for one run in this process. */
  max_invocations_per_run?: number
  /** Timer seam (tests). Defaults to `setTimeout`. */
  set_timer?: (fn: () => void, ms: number) => unknown
  /** Timer-clear seam (tests). Defaults to `clearTimeout`. */
  clear_timer?: (handle: unknown) => void
}

/**
 * Build a bounded Fable arbiter. Each eligible call runs ONE read-only turn and
 * maps its terminal marker to a conservative outcome.
 */
export function buildFableArbiter(opts: BuildFableArbiterOptions): TridentArbiter {
  const timeoutMs = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const modelPreference = opts.model_preference ?? [FABLE_MODEL]
  const maxInvocations = opts.max_invocations_per_run ?? DEFAULT_ARBITER_CAP
  const setTimer = opts.set_timer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    opts.clear_timer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))
  // Per-process by design for this contract. Task 2's durable `arbiter_log`
  // ledger will carry the budget across process restarts.
  const invocations = new Map<string, number>()

  return async (input) => {
    try {
      assertArbitrableOptions(input.options)
    } catch (error) {
      // A miswired caller must degrade safely instead of crashing the tick loop.
      return {
        kind: 'unavailable',
        reason: error instanceof Error ? error.message : 'invalid arbitration options',
      }
    }

    const count = invocations.get(input.run.id) ?? 0
    if (count >= maxInvocations) {
      return {
        kind: 'unavailable',
        reason: `arbiter invocation cap (${maxInvocations}) reached for this run`,
      }
    }
    // The cap bounds pathological loops, so it counts ATTEMPTS, not successes:
    // a turn that crashes or cannot start still spends its budget.
    invocations.set(input.run.id, count + 1)

    if (isOwnerOnlyQuestion(input.question)) {
      return { kind: 'owner-only', question: input.question }
    }

    const spec: AgentSpec = {
      prompt: arbiterPrompt(input),
      tools: ARBITER_TOOLS,
      model_preference: modelPreference,
    }

    let handle: SessionHandle
    try {
      handle = opts.build_substrate(input.repo_path).start(spec)
    } catch {
      return { kind: 'unavailable', reason: 'the arbiter could not start' }
    }

    let text = ''
    let timedOut = false
    let timer: unknown = null
    if (timeoutMs > 0) {
      timer = setTimer(() => {
        timedOut = true
        fireAndForget('arbiter.cancel', handle.cancel())
      }, timeoutMs)
    }

    try {
      for await (const ev of handle.events) {
        if (ev.kind === 'token') {
          text += ev.text
        } else if (ev.kind === 'completion') {
          break
        } else if (ev.kind === 'error') {
          fireAndForget('arbiter.cancel', handle.cancel())
          return { kind: 'unavailable', reason: 'the arbiter turn errored' }
        }
      }
    } catch {
      return {
        kind: 'unavailable',
        reason: timedOut ? 'the arbiter timed out' : 'the arbiter turn crashed',
      }
    } finally {
      if (timer !== null) clearTimer(timer)
    }

    if (timedOut) return { kind: 'unavailable', reason: 'the arbiter timed out' }

    // OWNER_ONLY wins over everything: a turn that asked for the owner is never
    // converted into a decision, even if it also printed DECISION.
    const ownerOnly = /OWNER_ONLY:\s*([^\n]+)/i.exec(text)
    if (ownerOnly !== null && ownerOnly[1] !== undefined) {
      const question = ownerOnly[1].trim()
      return {
        kind: 'owner-only',
        question: question.length > 0 ? question.slice(0, 500) : input.question,
      }
    }

    // DECISION may select only an actually offered id. Never coerce a typo or
    // near-match into authority the turn was not given.
    const decision = /DECISION:\s*([^\n]+)/i.exec(text)
    if (decision !== null && decision[1] !== undefined) {
      const selected = decision[1].trim().toLowerCase()
      const offered = input.options.find(
        (option) => option.id.trim().toLowerCase() === selected,
      )
      if (offered === undefined) {
        return {
          kind: 'unavailable',
          reason: 'the arbiter named an option that was not offered',
        }
      }

      const reasoningMatch = /REASONING:\s*([^\n]+)/i.exec(text)
      const reported = reasoningMatch?.[1]?.trim()
      return {
        kind: 'decision',
        option_id: offered.id,
        reasoning:
          reported !== undefined && reported.length > 0
            ? reported.slice(0, 1000)
            : '(no reasoning reported)',
      }
    }

    // No terminal marker means no safe decision; the caller keeps today's
    // escalation path rather than guessing what the model intended.
    return { kind: 'unavailable', reason: 'the arbiter returned no clear result' }
  }
}
