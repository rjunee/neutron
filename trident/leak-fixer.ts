/**
 * @neutronai/trident — the agent-backed REWORD turn behind the purity preflight.
 *
 * WHY THIS EXISTS. On 2026-08-31, 3 of 4 trident PRs opened that night were red
 * on exactly one check — the repository's public leak gate — and every finding
 * sat in the branch's OWN plan doc under `.trident/plans/`, prose the builder
 * regenerates each run. `./leak-preflight.ts` is the deterministic half: it runs
 * the gate in a throwaway worktree, classifies the verdict, loops a bounded fix
 * seam and commits under a compare-and-swap. THIS file is the other half — the
 * agent that actually performs the reword the seam asks for. Model-authored
 * prose can only be corrected by something that reads prose, so the fix seam is
 * an agent; everything around it stays mechanical.
 *
 * ONE BOUNDED TURN, modelled line for line on `./conflict-resolver.ts`: a single
 * ephemeral CC-subprocess rooted in the preflight's scratch worktree, a
 * wall-clock timeout (default 8 min), no conversation state, and a terminal
 * marker protocol — `REWORDED` or `CANNOT-FIX: <reason>`. Every non-marker
 * outcome (start failure, error event, timeout, crash, silence) is `fixed:
 * false` with a short note; this function NEVER throws, because a fixer bug must
 * not wedge a publish lane. `CANNOT-FIX` beats a stray `REWORDED` for the same
 * reason `ESCALATE` beats `RESOLVED`: a turn that asked to stop is not a
 * success.
 *
 * TOOL GRANT (#361, same class as #175). The ephemeral REPL maps
 * `spec.tools.map(t => t.name)` straight onto the spawned `claude`'s `--tools`
 * flag, default-DENY — an empty `tools` ships `--tools ""`, a subprocess that
 * cannot open, edit or `git add` a single file. This module therefore reuses the
 * resolver's exported `RESOLVER_TOOL_NAMES` rather than re-listing them, so
 * "same surface as the resolver" is a fact the type system carries instead of a
 * comment that can drift.
 *
 * WORD DISCIPLINE FOR THIS FILE. The vocabulary rules at
 * `scripts/ci/leak-gate.sh:367` and `:387` match a six-letter retired multi-org
 * word ANYWHERE in a committed file — source, comment or prompt template. This
 * file is the one most at risk of re-seeding the violation it fixes, so the
 * banned root is never written here, and neither is any gate rule id (the ids
 * embed that root). Rule ids reach the prompt ONLY as RUNTIME data interpolated
 * from the findings the gate produced; the static template below is silent under
 * the very gate it serves, and a test pins that. Absolute host filesystem paths
 * are banned the same way.
 */

import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import { getBestModel } from '@neutronai/runtime/models.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { DEFAULT_TIMEOUT_MS } from './liveness.ts'
import {
  NO_INTERACTIVE_RULE,
  NO_PATTERN_KILL_RULE,
  REDIRECT_RULE,
  RESOLVER_TOOL_NAMES,
} from './conflict-resolver.ts'
import {
  LEAK_PREFLIGHT_MAX_FIX_ATTEMPTS,
  type LeakFinding,
  type LeakPreflightFixer,
} from './leak-preflight.ts'

export interface BuildLeakPreflightFixerOptions {
  /**
   * The per-worktree substrate factory — built ONCE PER FIX ATTEMPT with the
   * preflight's throwaway scratch worktree as cwd, so the turn edits the tree
   * the gate actually scanned. Production passes
   * `makeEphemeralSubstrate('cc-trident-leakfix', PROFILE_LEAK_FIXER)` — the disposable build
   * profile MINUS the GitHub grant, because this turn commits nothing and pushes nothing.
   */
  build_substrate: (cwd: string) => Substrate
  /** Model preference for the reword turn. Defaults to `[getBestModel()]`. */
  model_preference?: string[]
  /** Wall-clock ceiling for the single reword turn (ms). Default 8 min. */
  timeout_ms?: number
  /** Timer seam (tests). Defaults to `setTimeout`. */
  set_timer?: (fn: () => void, ms: number) => unknown
  /** Timer-clear seam (tests). Defaults to `clearTimeout`. */
  clear_timer?: (handle: unknown) => void
}

/**
 * The declared `AgentSpec.tools` surface for the reword turn — the SAME
 * file+shell grant the conflict resolver carries, built from its exported names
 * so the two cannot drift apart. Mapped 1:1 onto the spawned REPL's `--tools`
 * flag (see the file header) — an empty grant would spawn a toolless
 * subprocess (#361/#175).
 */
const FIXER_TOOLS: AgentSpec['tools'] = RESOLVER_TOOL_NAMES.map((name) => ({
  name,
  description: `Built-in Claude Code tool '${name}' (trident leak-fixer surface)`,
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  capability_required: 'fs:project_data',
}))

/**
 * The Forge contract for one reword attempt.
 *
 * THE STATIC TEXT BELOW MUST STAY SILENT UNDER THE GATE. The only place a rule
 * id (or the vocabulary it names) appears is the FINDINGS block, interpolated
 * from runtime data — never a literal in this source.
 */
function fixerPrompt(input: {
  worktree: string
  branch: string
  findings: LeakFinding[]
  attempt: number
}): string {
  const findings = input.findings.map((f) => `  [${f.rule}] ${f.file}:${f.line}`).join('\n')
  return `You are FORGE — Neutron's autonomous build sub-agent — REWORDING text that this repository's public leak gate flagged, before a PR opens. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE} ${NO_PATTERN_KILL_RULE}

Your cwd (${input.worktree}) is a THROWAWAY, DETACHED git worktree at the tip of branch \`${input.branch}\`. There is NO rebase, merge or cherry-pick in progress. It has NO node_modules. Do NOT run the project's test suite and do NOT install dependencies — verify by re-reading the files you change. The outer preflight commits this tree itself and moves the branch ref under a compare-and-swap.

This is self-correction attempt ${input.attempt} of at most ${LEAK_PREFLIGHT_MAX_FIX_ATTEMPTS}.

FINDINGS (rule id, file, line — the gate quotes no excerpt by design):
${findings}

CONTRACT — do EXACTLY this, nothing more:
1. For EACH finding, open the file, go to the flagged line, and REWORD the flagged text IN PLACE so the pattern the rule bans is gone while the sentence keeps its meaning. The rule id names the banned vocabulary — treat it as the hint for what must go. A reword, not an excision: never delete a file, never remove a whole section (in particular never drop a plan doc's "Do not" section), never change what the text is FOR.
2. Do not write the flagged text or the rule id anywhere except inside the file you are fixing — not in shell commands that would echo into logs, and never in your final message.
3. Never touch \`scripts/ci/leak-gate.sh\` or \`scripts/ci/leak-gate-allowlist.txt\`. The gate is right; the prose is wrong. Fix the TEXT, never the scanner.
4. A finding whose file is \`COMMIT-MESSAGE\` or \`PR-TITLE-BODY\` cannot be fixed by editing this tree — that text is already-recorded history. If EVERY finding is such a pseudo-file, emit CANNOT-FIX (below) saying so.
5. \`git add\` EVERY reworded file. Do NOT \`git commit\`, do NOT push, do NOT create branches — the outer preflight commits.
6. STAY INSIDE YOUR CWD. Every path you Read, Edit, Write or touch from Bash must be under ${input.worktree}. Other build lanes share this machine; never follow a path that points outside.
7. Emit as your FINAL line exactly one of:
   REWORDED
   (every tree-file finding reworded and staged), or
   CANNOT-FIX: <one-line reason>
   (a finding cannot be reworded without destroying meaning, or all findings are immutable pseudo-files).

THE CALLER AUDITS THE INDEX, so these are checks and not requests: it accepts ONLY in-place modifications of the files named above. A staged deletion, a staged new file, a staged rename, a staged file the gate did not flag, or any staged change under \`scripts/ci/\` is REJECTED — the reword is discarded, nothing is committed, and the findings are reported unfixed.

PARTIAL WORK IS THE FAILURE MODE. Emitting REWORDED with a finding left in place sends the gate around an identical loop and burns the bounded attempt budget; staging nothing while claiming REWORDED is detected by the caller (it checks the staged bytes) and treated as not fixed. If you cannot finish, say CANNOT-FIX.`
}

/**
 * Build a `LeakPreflightFixer` over a per-worktree substrate factory. Each call
 * runs ONE bounded Forge turn in the preflight's scratch worktree and maps its
 * terminal marker onto the seam's `{ fixed, note }` outcome. Never throws — a
 * fixer that cannot run reports "not fixed", and the preflight proceeds with the
 * findings named.
 */
export function buildLeakPreflightFixer(opts: BuildLeakPreflightFixerOptions): LeakPreflightFixer {
  const timeoutMs = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const modelPreference = opts.model_preference ?? [getBestModel()]
  const setTimer = opts.set_timer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    opts.clear_timer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))

  return async (input) => {
    const spec: AgentSpec = {
      prompt: fixerPrompt(input),
      tools: FIXER_TOOLS,
      model_preference: modelPreference,
    }

    let handle: SessionHandle
    try {
      handle = opts.build_substrate(input.worktree).start(spec)
    } catch {
      // A substrate that can't even start the turn → not fixed (never claim a
      // reword we never attempted).
      return { fixed: false, note: 'the leak fixer could not start' }
    }

    let text = ''
    let timedOut = false
    let timer: unknown = null
    if (timeoutMs > 0) {
      timer = setTimer(() => {
        timedOut = true
        fireAndForget('leak-fixer.cancel', handle.cancel())
      }, timeoutMs)
    }

    try {
      for await (const ev of handle.events) {
        if (ev.kind === 'token') {
          text += ev.text
        } else if (ev.kind === 'completion') {
          break
        } else if (ev.kind === 'error') {
          fireAndForget('leak-fixer.cancel', handle.cancel())
          return { fixed: false, note: 'the leak fixer turn errored' }
        }
      }
    } catch {
      return { fixed: false, note: timedOut ? 'the leak fixer timed out' : 'the leak fixer turn crashed' }
    } finally {
      if (timer !== null) clearTimer(timer)
    }

    if (timedOut) return { fixed: false, note: 'the leak fixer timed out' }

    // CANNOT-FIX wins over a stray REWORDED — a turn that asked to stop is not a
    // success. The reason lands only in the preflight's outcome note and lane
    // logs (the PR annotation writes sanitized rule/file/line only), but cap it.
    const decline = /CANNOT-FIX:\s*([^\n]+)/i.exec(text)
    if (decline !== null && decline[1] !== undefined) {
      const reason = decline[1].trim()
      return {
        fixed: false,
        note: reason.length > 0 ? reason.slice(0, 300) : 'the leak fixer declined without a reason',
      }
    }
    if (/(^|\n)\s*REWORDED\s*$/i.test(text) || /\bREWORDED\b/.test(text.trimEnd().split('\n').pop() ?? '')) {
      // The preflight core still verifies the STAGED BYTES before committing, so
      // a claim without a stage is caught one layer out.
      return { fixed: true }
    }
    // No clear terminal marker → not fixed, conservatively (silence ≠ done).
    return { fixed: false, note: 'the leak fixer returned no clear result' }
  }
}
