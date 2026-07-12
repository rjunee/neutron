/**
 * @neutronai/trident — bounded Forge merge-conflict resolver (#342).
 *
 * THE parallel-build enabler. N concurrent builds in the SAME project each build
 * in their own worktree and merge in SERIALIZED order (`merge.ts`
 * `withLocalMergeLock`). The 2nd/3rd build's branch was cut from the pre-1st
 * base, so after build-1 lands, `mergeLocal` REBASES build-2's branch onto the
 * new base before merging. A rebase that hits a real content conflict used to
 * hard-fail the run (this killed the live-test's `dagcore` after `walstore`
 * merged); now `mergeLocal` calls THIS resolver, which dispatches a fresh,
 * bounded Forge INTO the conflicted working tree to resolve it, so the build
 * still lands cleanly.
 *
 * The resolver runs ONE ephemeral CC-subprocess turn rooted at the repo's
 * working tree (mid-rebase, conflict markers present), reusing the SAME
 * `(cwd) => Substrate` factory the trident dispatch family uses
 * (`makeEphemeralSubstrate` in the composer). Its contract: resolve every
 * conflict keeping BOTH intents where possible, run the tests, `git add` the
 * resolutions — but NEVER `git rebase --continue` / commit / push (the OUTER
 * `mergeLocal` advances the rebase). It reports a terminal marker:
 *   - `RESOLVED`         → conflicts staged, tests green → `{ resolved: true }`.
 *   - `ESCALATE: <q>`    → the conflict is genuinely ambiguous (two builds
 *                          changed the SAME behaviour incompatibly) → the merge
 *                          fails with that SPECIFIC question, which the terminal
 *                          delivery posts to chat (never a raw "merge failed").
 *
 * BOUNDED: a single turn with a wall-clock timeout (default 8 min, safely under
 * the merge path's own budget), a FILE+SHELL tool grant (Read/Glob/Grep/Edit/
 * Write/Bash), and NO conversation state — a crashed / timed-out / marker-less
 * turn escalates conservatively rather than guessing a resolution.
 *
 * TOOL GRANT (#361, same class as #175). The resolver runs on an EPHEMERAL
 * `cc-trident-resolve` REPL that the composer launches WITHOUT any built-in
 * tools unless this AgentSpec declares them: the persistent-REPL substrate maps
 * `spec.tools.map(t => t.name)` straight onto the spawned `claude`'s `--tools`
 * flag (default-DENY — an empty surface becomes `--tools ""`, disabling EVERY
 * built-in). An earlier `tools: []` therefore shipped a toolless subprocess that
 * could not open, edit, or `git add` a single conflicted file, so every real
 * rebase conflict hard-failed the build. The resolver MUST carry the file+shell
 * surface below so the CC subprocess can actually resolve + stage the conflicts.
 */

import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import { getBestModel } from '@neutronai/runtime/models.ts'
import type { MergeConflictResolver } from './merge.ts'
import { DEFAULT_TIMEOUT_MS } from './liveness.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

export interface BuildForgeConflictResolverOptions {
  /**
   * The per-worktree substrate factory — built ONCE PER RESOLUTION with the
   * repo's working tree (the mid-rebase cwd) so the Forge turn runs IN the
   * conflicted tree. Production passes `makeEphemeralSubstrate('cc-trident-resolve')`.
   */
  build_substrate: (cwd: string) => Substrate
  /** Model preference for the resolution turn. Defaults to `[getBestModel()]`. */
  model_preference?: string[]
  /** Wall-clock ceiling for the single resolution turn (ms). Default 8 min. */
  timeout_ms?: number
  /** Timer seam (tests). Defaults to `setTimeout`. */
  set_timer?: (fn: () => void, ms: number) => unknown
  /** Timer-clear seam (tests). Defaults to `clearTimeout`. */
  clear_timer?: (handle: unknown) => void
}

/**
 * The built-in tool surface the resolver's CC subprocess needs to actually
 * resolve a conflict: Read/Glob/Grep to inspect the conflicted files, Edit/Write
 * to rewrite the resolutions, and Bash to run tests + `git add` the results.
 * Mapped 1:1 onto the spawned REPL's `--tools` flag (see the file header) — an
 * empty grant would spawn a toolless subprocess (#361/#175). Exported so the
 * boundary test can assert the EXACT surface reaches the substrate.
 */
export const RESOLVER_TOOL_NAMES = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] as const

/** The declared `AgentSpec.tools` surface for the resolver turn — the ToolDef
 *  shape the substrate consumes, built from `RESOLVER_TOOL_NAMES`. Mirrors the
 *  inner-loop fire surface (`WORKFLOW_FIRE_TOOL_NAMES`). */
const RESOLVER_TOOLS: AgentSpec['tools'] = RESOLVER_TOOL_NAMES.map((name) => ({
  name,
  description: `Built-in Claude Code tool '${name}' (trident conflict-resolver surface)`,
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  capability_required: 'fs:project_data',
}))

const NO_INTERACTIVE_RULE =
  'You run UNATTENDED. NEVER call AskUserQuestion or any interactive prompt — if you would need to ask, ESCALATE (below) instead of hanging.'

const REDIRECT_RULE =
  'For ANY long or verbose command (a full test run), redirect stdout+stderr to a log file and read ONLY the summary tail — never let raw output flood your context.'

/** The Forge contract for a mid-rebase conflict resolution. */
function conflictPrompt(input: {
  repo_path: string
  branch: string
  base_branch: string
  conflicted_files: string[]
  task: string
}): string {
  const files = input.conflicted_files.length > 0 ? input.conflicted_files.join(', ') : '(run `git status` to find them)'
  return `You are FORGE — Neutron's autonomous build sub-agent — resolving a git REBASE CONFLICT. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE}

Your cwd (${input.repo_path}) is a git working tree PART-WAY THROUGH \`git rebase ${input.base_branch}\` of branch \`${input.branch}\`. Another build in this same project merged first; your branch is being replayed on top of it and hit conflicts.

CONFLICTED FILES: ${files}

CONTRACT — do EXACTLY this, nothing more:
1. For EACH conflicted file, open it and resolve every conflict marker (<<<<<<< / ======= / >>>>>>>). KEEP BOTH intents wherever they are compatible (two independent changes → include both). Preserve the code's conventions.
2. If the two sides changed the SAME behaviour in INCOMPATIBLE ways so that no correct merge exists without a human decision, do NOT guess. Emit as your FINAL line exactly:
   ESCALATE: <one specific question naming the file + the exact conflicting behaviours>
   (e.g. "ESCALATE: ringbuf.ts and walstore.ts both redefined flush() — drop-oldest vs block-until-space; which do you want?")
3. Otherwise, once every marker is resolved: run the project's tests if it has any (redirect verbose output to a log, read the tail) and iterate until they pass.
4. \`git add\` EVERY resolved file so the rebase can continue. Do NOT run \`git rebase --continue\`, do NOT \`git commit\`, do NOT \`git push\` — the outer loop advances the rebase.
5. Emit as your FINAL line exactly:
   RESOLVED
   (only after every conflict is staged and tests pass).

BUILD TASK CONTEXT (what this branch was building):
${input.task}`
}

/**
 * Build a `MergeConflictResolver` over a per-worktree substrate factory. Each
 * call runs ONE bounded Forge turn in the conflicted working tree and maps its
 * terminal marker to a resolution outcome.
 */
export function buildForgeConflictResolver(
  opts: BuildForgeConflictResolverOptions,
): MergeConflictResolver {
  const timeoutMs = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const modelPreference = opts.model_preference ?? [getBestModel()]
  const setTimer = opts.set_timer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    opts.clear_timer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))

  return async (input) => {
    const question = (extra?: string): { resolved: false; question: string } => ({
      resolved: false,
      question:
        `couldn't auto-resolve the merge conflict in ${input.conflicted_files.join(', ') || 'the branch'} ` +
        `for \`${input.branch}\`${extra !== undefined ? ` (${extra})` : ''} — it needs your call before I can land it.`,
    })

    const spec: AgentSpec = {
      prompt: conflictPrompt({
        repo_path: input.repo_path,
        branch: input.branch,
        base_branch: input.base_branch,
        conflicted_files: input.conflicted_files,
        task: input.run.task,
      }),
      tools: RESOLVER_TOOLS,
      model_preference: modelPreference,
    }

    let handle: SessionHandle
    try {
      handle = opts.build_substrate(input.repo_path).start(spec)
    } catch {
      // A substrate that can't even start the turn → escalate (never silently
      // "resolve" a conflict we never touched).
      return question('the resolver could not start')
    }

    let text = ''
    let timedOut = false
    let timer: unknown = null
    if (timeoutMs > 0) {
      timer = setTimer(() => {
        timedOut = true
        fireAndForget('conflict-resolver.cancel', handle.cancel().catch(() => {}))
      }, timeoutMs)
    }

    try {
      for await (const ev of handle.events) {
        if (ev.kind === 'token') {
          text += ev.text
        } else if (ev.kind === 'completion') {
          break
        } else if (ev.kind === 'error') {
          fireAndForget('conflict-resolver.cancel', handle.cancel().catch(() => {}))
          return question('the resolver turn errored')
        }
      }
    } catch {
      return question(timedOut ? 'the resolver timed out' : 'the resolver turn crashed')
    } finally {
      if (timer !== null) clearTimer(timer)
    }

    if (timedOut) return question('the resolver timed out')

    // ESCALATE wins over a stray RESOLVED (the contract puts the marker LAST, but
    // never treat a turn that asked to escalate as resolved).
    const esc = /ESCALATE:\s*([^\n]+)/i.exec(text)
    if (esc !== null && esc[1] !== undefined) {
      const q = esc[1].trim()
      return { resolved: false, question: q.length > 0 ? q.slice(0, 500) : question().question }
    }
    if (/(^|\n)\s*RESOLVED\s*$/i.test(text) || /\bRESOLVED\b/.test(text.trimEnd().split('\n').pop() ?? '')) {
      return { resolved: true }
    }
    // No clear terminal marker → escalate conservatively (paused ≠ resolved).
    return question('the resolver returned no clear result')
  }
}
