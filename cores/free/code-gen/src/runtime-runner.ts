/**
 * @neutronai/codegen-core — production `RuntimeCodegenRunner`.
 *
 * Composes the proven Forge → Argus → (gated) merge trident pattern
 * IN-PROCESS via:
 *
 *   - `runtime/subagent/spawn.ts` (substrate-agnostic; first
 *     production caller — see brief § 5).
 *   - Host `gh` / `git` / `bun test` CLIs via the gateway's
 *     capability-gated host-runner adapters (`host-runners.ts`).
 *   - Per-project worktree at `<OWNER_HOME>/Projects/<id>/code/`
 *     (resolved by `worktree-resolver.ts`).
 *   - Per-project sidecar at `<OWNER_HOME>/Projects/<id>/code-gen/
 *     code-gen.db` (via the `CodegenSidecar` handle).
 *
 * Awaits sub-agent completions directly via the caller-supplied
 * dispatch surface; no ScheduleWakeup-style polling loop (the trident
 * skill's re-entry model is a CC-side primitive — see brief § 9
 * out-of-scope).
 *
 * Auto-merge is the default in S2 (owner 2026-05-22). On an Argus
 * `APPROVE` the orchestrator merges inline via `gh pr merge` and
 * records the audit row with `who_confirmed='autonomous'`. The per-
 * project `automerge_enabled` gate (with three call-site enforcement)
 * was removed in S2 — see
 * docs/plans/2026-05-22-002-feat-code-gen-core-s2-autonomous-plan.md
 * § "Phase 3 — Auto-merge default ON; drop the gate (Part E)".
 */

import { createHash } from 'node:crypto'

import {
  CodegenMaxRoundsReachedError,
  CodegenRunError,
  CodegenSubagentTimeoutError,
  type CodegenRunInput,
  type CodegenRunResult,
  type CodegenRunner,
} from './backend.ts'
import type {
  HostBunTestRunner,
  HostGhRunner,
  HostGitRunner,
} from './host-runners.ts'
import {
  parseArgusFindings,
  parseArgusVerdict,
  renderArgusPrompt,
} from './prompts/argus-system.ts'
import {
  renderForgeFixPrompt,
  renderForgePrompt,
  FORGE_SYSTEM_PROMPT,
} from './prompts/forge-system.ts'
import { ARGUS_SYSTEM_PROMPT } from './prompts/argus-system.ts'
import type { CodegenSidecar } from './sidecar/store.ts'
import { resolveWorktree, sluggifyBranch } from './worktree-resolver.ts'

/** Default models — overridable via env or RuntimeCodegenRunnerOptions. */
export const DEFAULT_FORGE_MODEL = 'claude-sonnet-4-6'
export const DEFAULT_ARGUS_MODEL = 'claude-sonnet-4-6'

/**
 * Callable surface for sub-agent dispatch. The runner takes a single
 * function — `dispatch_subagent` — that accepts the sub-agent kind +
 * model + system prompt + user message + worktree path and resolves
 * with the sub-agent's terminal output text. Internally the gateway
 * wires this to `runtime/subagent/spawn.ts:spawnSubagent` +
 * `runtime/subagent/control.ts:waitForCompletion`; tests pass a
 * canned-responses stub.
 *
 * Keeping the registry + delegation-token plumbing OUT of the
 * runner's signature lets the unit tests cover the full pipeline
 * without dragging Hermes-style signed-delegation tokens through
 * every test fixture. The brief's § 5.2 describes the lower-level
 * surface; this is the higher-level abstraction the runner consumes.
 */
export interface SubagentDispatch {
  (input: SubagentDispatchInput): Promise<SubagentDispatchResult>
}

export interface SubagentDispatchInput {
  /** Instance key (passed through to the registry). */
  instance_key: string
  /** Sub-agent kind — 'forge' or 'argus'. */
  kind: 'forge' | 'argus'
  /** Sub-agent model id. */
  model: string
  /** Fully-rendered system prompt. */
  system: string
  /** Fully-rendered user message. */
  user_message: string
  /** The per-project worktree path the sub-agent operates in. */
  worktree_path: string
  /** Parent task id (used for sub-agent registry book-keeping). */
  parent_task_id: string
  /** Wall-clock budget for this sub-agent. */
  timeout_ms: number
}

export interface SubagentDispatchResult {
  /** The sub-agent's terminal output text. */
  result: string
  /** The opaque sub-agent run_id (used for cancellation + audit). */
  subagent_run_id: string
  /** Terminal status — 'completed' | 'failed' | 'cancelled' | 'timed_out'. */
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out'
}

export interface RuntimeCodegenRunnerOptions {
  /** Sub-agent dispatch surface (see above). */
  dispatch_subagent: SubagentDispatch
  /** Worktree resolver dep — owner_home for the per-project worktree. */
  owner_home: string
  /** Instance key (passed through to sub-agent dispatch + sidecar resolver). */
  instance_key: string
  /** Per-project sidecar resolver. */
  resolve_sidecar: (input: { project_id: string }) => Promise<CodegenSidecar>
  /** Host CLI runners. */
  gh_runner: HostGhRunner
  git_runner: HostGitRunner
  bun_test_runner: HostBunTestRunner
  /** Default project_id when CodegenRunInput.repo_path is unset. */
  default_project_id?: string
  /** Resolve project_id from a CodegenRunInput. Defaults to
   *  `input.repo_path` if it looks like a project id, else
   *  `default_project_id`. */
  resolve_project_id?: (input: CodegenRunInput) => string
  /** Forge model id. Default 'claude-sonnet-4-6'. */
  forge_model?: string
  /** Argus model id. Default 'claude-sonnet-4-6'. */
  argus_model?: string
  /** Forge prompt body. Defaults to FORGE_SYSTEM_PROMPT. */
  forge_system_prompt?: string
  /** Argus prompt body. Defaults to ARGUS_SYSTEM_PROMPT. */
  argus_system_prompt?: string
  /** Max Argus rounds. Default 8 (matches /trident skill cap). */
  max_argus_rounds?: number
  /** Per-sub-agent wall-clock budget. Default 30 min. */
  subagent_timeout_ms?: number
  /** Override the project-root resolution (testing seam). */
  resolveProjectRoot?: (project_id: string) => string
}

/** Parsed terminal output of a Forge sub-agent run. */
export interface ParsedForgeOutput {
  pr_number: number
  branch: string
  worktree: string
  summary: string
}

/**
 * Parse the locked terminal output lines emitted by the Forge sub-
 * agent. Forge emits the LAST THREE LINES as:
 *
 *   PR_NUMBER=<integer>
 *   BRANCH=<branch name>
 *   WORKTREE=<worktree path>
 *
 * Throws CodegenRunError if any of the three lines are missing or
 * malformed — Forge is supposed to emit them verbatim per the prompt.
 */
export function parseForgeOutput(response: string): ParsedForgeOutput {
  const lines = response.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  let pr_number: number | undefined
  let branch: string | undefined
  let worktree: string | undefined
  // Walk from the end — the locked contract puts these as the LAST
  // three lines, so the back-walk is robust against extra preamble.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (worktree === undefined && line.startsWith('WORKTREE=')) {
      worktree = line.slice('WORKTREE='.length).trim()
      continue
    }
    if (branch === undefined && line.startsWith('BRANCH=')) {
      branch = line.slice('BRANCH='.length).trim()
      continue
    }
    if (pr_number === undefined && line.startsWith('PR_NUMBER=')) {
      const n = parseInt(line.slice('PR_NUMBER='.length).trim(), 10)
      if (!Number.isFinite(n) || n <= 0) {
        throw new CodegenRunError(
          'forge_output_malformed',
          `Forge PR_NUMBER line was not a positive integer: ${line}`,
        )
      }
      pr_number = n
      continue
    }
    // Stop scanning once all three are found.
    if (pr_number !== undefined && branch !== undefined && worktree !== undefined) break
  }
  if (pr_number === undefined) {
    throw new CodegenRunError(
      'forge_output_missing_pr',
      'Forge response did not include a PR_NUMBER=<n> terminal line',
    )
  }
  if (branch === undefined) {
    throw new CodegenRunError(
      'forge_output_missing_branch',
      'Forge response did not include a BRANCH=<name> terminal line',
    )
  }
  if (worktree === undefined) {
    throw new CodegenRunError(
      'forge_output_missing_worktree',
      'Forge response did not include a WORKTREE=<path> terminal line',
    )
  }
  // Summary is the first non-empty line that ISN'T one of the three
  // terminal markers. Fallback to a generic line if nothing useful
  // appears in the response.
  const summaryLine = lines.find(
    (l) =>
      !l.startsWith('PR_NUMBER=') &&
      !l.startsWith('BRANCH=') &&
      !l.startsWith('WORKTREE='),
  )
  const summary = summaryLine !== undefined && summaryLine.length > 0
    ? summaryLine.slice(0, 200)
    : `PR #${pr_number} opened`
  return { pr_number, branch, worktree, summary }
}

/**
 * Build the production runner. The returned `CodegenRunner` is shape-
 * compatible with `CodegenOrchestrator`'s `runner` option, so the
 * existing dispatch / status / fetch surface still works — wrap-via-
 * orchestrator stays the integration point.
 */
export function buildRuntimeCodegenRunner(
  opts: RuntimeCodegenRunnerOptions,
): CodegenRunner {
  const forge_model = opts.forge_model ?? DEFAULT_FORGE_MODEL
  const argus_model = opts.argus_model ?? DEFAULT_ARGUS_MODEL
  const forge_system = opts.forge_system_prompt ?? FORGE_SYSTEM_PROMPT
  const argus_system = opts.argus_system_prompt ?? ARGUS_SYSTEM_PROMPT
  const max_rounds = opts.max_argus_rounds ?? 8
  const subagent_timeout_ms = opts.subagent_timeout_ms ?? 30 * 60_000
  const default_project_id = opts.default_project_id ?? 'default'
  const resolveProjectId =
    opts.resolve_project_id ??
    ((input: CodegenRunInput): string => {
      const fromInput = (input as CodegenRunInput & { project_id?: string }).project_id
      if (typeof fromInput === 'string' && fromInput.length > 0) return fromInput
      if (
        typeof input.repo_path === 'string' &&
        input.repo_path.length > 0 &&
        !input.repo_path.includes('/')
      ) {
        return input.repo_path
      }
      return default_project_id
    })

  return {
    async run(input: CodegenRunInput): Promise<CodegenRunResult> {
      const project_id = resolveProjectId(input)
      // 1. Resolve the per-project sidecar (lazy-init + lazy-migrate).
      const sidecar = await opts.resolve_sidecar({ project_id })
      // 2. Resolve the per-project worktree (idempotent — git init +
      //    gh repo create on first call).
      const resolveWorktreeInput: Parameters<typeof resolveWorktree>[0] = {
        owner_home: opts.owner_home,
        project_id,
        gh_runner: opts.gh_runner,
        git_runner: opts.git_runner,
        sidecar,
      }
      if (opts.resolveProjectRoot !== undefined) {
        resolveWorktreeInput.resolveProjectRoot = opts.resolveProjectRoot
      }
      const worktree = await resolveWorktree(resolveWorktreeInput)
      // 3. Persist a task row + flip status to running.
      const branchSuffix = input.task_id.slice(0, 8)
      const branch = input.target_branch ?? sluggifyBranch(input.task, branchSuffix)
      const existing = sidecar.tasks.get(input.task_id)
      if (existing === null) {
        sidecar.tasks.insert({
          task_id: input.task_id,
          request: input.task,
          status: 'running',
          runner_kind: 'runtime',
        })
      } else {
        sidecar.tasks.update(input.task_id, { status: 'running' })
      }
      // 4. Spawn Forge.
      const forgePrompt = renderForgePrompt({
        worktree_path: worktree.worktree_path,
        default_branch: worktree.default_branch,
        branch,
        task: input.task,
      })
      const forgeOutcome = await opts.dispatch_subagent({
        instance_key: opts.instance_key,
        kind: 'forge',
        model: forge_model,
        system: forge_system,
        user_message: forgePrompt,
        worktree_path: worktree.worktree_path,
        parent_task_id: input.task_id,
        timeout_ms: subagent_timeout_ms,
      })
      sidecar.transcripts.append({
        task_id: input.task_id,
        role: 'forge',
        round: 1,
        prompt_hash: sha256(forge_system + forgePrompt),
        response_excerpt: forgeOutcome.result.slice(0, 4 * 1024),
        model: forge_model,
        completed_at: Date.now(),
        outcome: forgeOutcome.status,
        subagent_run_id: forgeOutcome.subagent_run_id,
      })
      sidecar.tasks.update(input.task_id, { subagent_run_id: forgeOutcome.subagent_run_id })
      if (forgeOutcome.status === 'timed_out') {
        throw new CodegenSubagentTimeoutError(forgeOutcome.subagent_run_id, subagent_timeout_ms)
      }
      if (forgeOutcome.status !== 'completed') {
        throw new CodegenRunError(
          'forge_failed',
          `Forge sub-agent ${forgeOutcome.status} (run_id=${forgeOutcome.subagent_run_id})`,
        )
      }
      const forgeOut = parseForgeOutput(forgeOutcome.result)
      const { pr_number } = forgeOut
      sidecar.tasks.update(input.task_id, {
        pr_number,
        branch: forgeOut.branch,
        worktree: forgeOut.worktree,
        summary: forgeOut.summary,
      })

      // 5. Argus-rounds loop.
      for (let round = 1; round <= max_rounds; round++) {
        const argusPrompt = renderArgusPrompt({
          branch: forgeOut.branch,
          pr_number,
          round,
          max_rounds,
          default_branch: worktree.default_branch,
        })
        const argusOutcome = await opts.dispatch_subagent({
          instance_key: opts.instance_key,
          kind: 'argus',
          model: argus_model,
          system: argus_system,
          user_message: argusPrompt,
          worktree_path: worktree.worktree_path,
          parent_task_id: input.task_id,
          timeout_ms: subagent_timeout_ms,
        })
        sidecar.transcripts.append({
          task_id: input.task_id,
          role: 'argus',
          round,
          prompt_hash: sha256(argus_system + argusPrompt),
          response_excerpt: argusOutcome.result.slice(0, 4 * 1024),
          model: argus_model,
          completed_at: Date.now(),
          outcome: argusOutcome.status,
          subagent_run_id: argusOutcome.subagent_run_id,
        })
        if (argusOutcome.status === 'timed_out') {
          throw new CodegenSubagentTimeoutError(argusOutcome.subagent_run_id, subagent_timeout_ms)
        }
        if (argusOutcome.status !== 'completed') {
          throw new CodegenRunError(
            'argus_failed',
            `Argus sub-agent ${argusOutcome.status} (run_id=${argusOutcome.subagent_run_id})`,
          )
        }
        const verdict = parseArgusVerdict(argusOutcome.result)
        if (verdict === 'APPROVE') {
          // S2: auto-merge default ON; no per-project gate. The S1
          // three-call-site gate (sidecar.settings.automerge_enabled
          // checked in runtime-runner + mergePrViaGh + chat-command)
          // was removed in this sprint — see
          // docs/plans/2026-05-22-002-feat-code-gen-core-s2-autonomous-plan.md
          // § "Phase 3 — Auto-merge default ON; drop the gate (Part E)".
          const mergeRes = await opts.gh_runner.prMerge({
            cwd: forgeOut.worktree,
            pr_number,
            strategy: 'squash',
          })
          sidecar.audit.append({
            task_id: input.task_id,
            pr_number,
            merge_strategy: 'squash',
            who_confirmed: 'autonomous',
            gh_response_excerpt: mergeRes.stdout.slice(0, 1024),
          })
          if (!mergeRes.ok) {
            throw new CodegenRunError(
              'merge_failed',
              `gh pr merge ${pr_number} failed: ${mergeRes.stderr || mergeRes.stdout || `exit ${mergeRes.exit_code}`}`,
            )
          }
          return {
            pr_number,
            branch: forgeOut.branch,
            worktree: forgeOut.worktree,
            summary: `${forgeOut.summary} — Argus APPROVE, auto-merged PR #${pr_number}`,
          }
        }
        // REQUEST_CHANGES — spawn Forge-fix and continue.
        const findings = parseArgusFindings(argusOutcome.result)
        const fixPrompt = renderForgeFixPrompt({
          worktree_path: worktree.worktree_path,
          default_branch: worktree.default_branch,
          branch: forgeOut.branch,
          task: input.task,
          argus_findings: findings.map((f, i) => `${i + 1}. ${f}`).join('\n'),
          round,
        })
        const fixOutcome = await opts.dispatch_subagent({
          instance_key: opts.instance_key,
          kind: 'forge',
          model: forge_model,
          system: forge_system,
          user_message: fixPrompt,
          worktree_path: worktree.worktree_path,
          parent_task_id: input.task_id,
          timeout_ms: subagent_timeout_ms,
        })
        sidecar.transcripts.append({
          task_id: input.task_id,
          role: 'forge_fix',
          round,
          prompt_hash: sha256(forge_system + fixPrompt),
          response_excerpt: fixOutcome.result.slice(0, 4 * 1024),
          model: forge_model,
          completed_at: Date.now(),
          outcome: fixOutcome.status,
          subagent_run_id: fixOutcome.subagent_run_id,
        })
        if (fixOutcome.status === 'timed_out') {
          throw new CodegenSubagentTimeoutError(fixOutcome.subagent_run_id, subagent_timeout_ms)
        }
        if (fixOutcome.status !== 'completed') {
          throw new CodegenRunError(
            'forge_fix_failed',
            `Forge-fix sub-agent ${fixOutcome.status} (round=${round}, run_id=${fixOutcome.subagent_run_id})`,
          )
        }
      }
      throw new CodegenMaxRoundsReachedError(input.task_id, max_rounds)
    },
  }
}

// S2: `reviewPrViaArgus` (standalone `/code review` helper) and
// `mergePrViaGh` (standalone `/code merge` helper) were REMOVED in this
// sprint. The chat surface collapsed to `/code <task>` + `/code stop`
// only — see chat-commands.ts. The orchestrator merges inline above on
// Argus APPROVE; there is no separate standalone-review or standalone-
// merge entry-point anymore.
//
// `mcp-tools-extra.ts` + `index.ts` re-exports clean up in Wave 2 of
// this sprint.

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}
