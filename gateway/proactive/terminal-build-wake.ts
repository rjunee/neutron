import type { ToolDef } from '@neutronai/cores-sdk/manifest'
import { getBestModel } from '@neutronai/runtime/models.ts'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import { FIRE_PUBLISHED_REASON_MARKER, FIRE_SETTLE_TIMEOUT_ERROR } from '@neutronai/trident/fire-evidence.ts'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'
import { LIVE_AGENT_TOOL_NAMES } from '../wiring/build-live-agent-turn.ts'
import type { WakeupLlm } from './work-wakeup.ts'

/**
 * Acting-turn budget mirroring `WORK_WAKEUP_TURN_TIMEOUT_MS`: a wakeup turn
 * does real tool work. The compose seam's 90 s default is a nudge-composition
 * budget; aborting at 90 s kills this act turn and, until T2 lands, permanently
 * burns the run's one wake claim.
 */
export const TERMINAL_BUILD_WAKE_TURN_TIMEOUT_MS = 4 * 60_000

export interface TerminalBuildWakeDeps {
  claimWake(id: string): Promise<boolean>
  boardItemIdForRun(run: TridentRun): Promise<string | null>
  llm: WakeupLlm | null
  projectChatScope(run: TridentRun): string
  post(run: TridentRun, reply: string, opts: { loud: boolean }): boolean | Promise<boolean>
  logger: { error(message: string, fields?: Record<string, unknown>): void }
}

export function buildTerminalBuildWakePrompt(args: { run: TridentRun; board_item_id: string | null }): string {
  const { run } = args
  const facts = [
    `Run id: ${run.id}`,
    `Board item id: ${args.board_item_id ?? 'none'}`,
    `Terminal phase: ${run.phase}`,
    `Branch: ${run.branch ?? 'none'}`,
    ...(typeof run.pr === 'number' && run.pr > 0 ? [`PR #${run.pr}`] : []),
    `Task title: ${run.task}`,
  ]
  if (run.failure_reason !== null) facts.push('Failure reason (verbatim):', run.failure_reason)
  // A settle-timeout or published-marker failure_reason does NOT mean the build
  // is dead: the launcher turn timed out or was cancelled, but the workflow it
  // fired may still be running detached (observed: a worktree appeared and wrote
  // a correct resume plan five minutes AFTER the timeout wrote this row), or the
  // run may have already built, pushed and gone green with review simply never
  // run. Inviting `work_board_start` here dispatches a SECOND lane onto a branch
  // the first still holds. Resolve the branch holder before ever re-dispatching.
  //
  // AND `work_board_start` IS NOT A RESUME (Argus r5 blocker). This instruction
  // used to tell the agent that starting the bound item resumes an
  // `outer-published:` head into a review round without rebuilding. It does not:
  // `dispatchBoardBoundBuild` → `store.create` writes `inner_checkpoint: null`
  // unconditionally, so `orchestrator.ts`'s `resume_checkpoint` is null and the
  // workflow REBUILDS — the exact ~2 h this shape exists to save. The review-only
  // path that really does read the published head without building is a
  // `bound_pr` dispatch (`orchestrator.ts` returns through `executeBoundReview`
  // before base resolution and before the build workflow), and `bound_pr` is a
  // `work_board_dispatch_build` argument — `work_board_start` deliberately has
  // none. So name THAT tool, and say plainly what the other one would do.
  // TWO MATCHES, AND ONLY ONE OF THEM NEEDED A TOKEN (Argus r6, nit). The
  // published arm keys on a BRACKETED marker because a reason that merely quoted
  // the English `already built and published` would have SUPPRESSED a genuinely
  // failed build's relaunch — a collision that costs recovery. The settle-timeout
  // arm still keys on its plain-English constant, deliberately: its collision
  // costs the opposite. A reason that happens to contain
  // `fire turn did not settle within the budget` gets the CAUTIOUS instruction —
  // resolve the branch holder before re-dispatching — which is safe advice for
  // any terminal build, where suppressing a relaunch that should have happened
  // is not. Same `includes`, opposite blast radius, so the same hardening is not
  // warranted here.
  const reason = run.failure_reason ?? ''
  const fireShape = reason.includes(FIRE_SETTLE_TIMEOUT_ERROR) || reason.includes(FIRE_PUBLISHED_REASON_MARKER)
  const instruction2 = fireShape
    ? '2. Do NOT relaunch this build yet. The launcher turn timed out, but the workflow it fired may still be running — or the work may already be built and published. Resolve the branch holder first: check `git worktree list --porcelain` for a worktree holding this branch and whether its lock names a live pid, read the `inner_checkpoint` on the run row, and check the PR state. If the failure reason above says the work was already built and published, verify the PR is open at that sha and then run a REVIEW round on it: `work_board_dispatch_build` with `bound_pr` set to that PR number reviews the published head and never builds, which is the cheapest correct recovery. Do NOT use `work_board_start` for that — a fresh dispatch is created with no checkpoint, so it REBUILDS from scratch. Otherwise re-dispatch with `work_board_start` only once nothing live holds the branch.'
    : '2. Take the most valuable concrete action now. To retry or resume a failed build, ask the outer build loop: call `work_board_start` (or `work_board_dispatch_build`) on the bound board item — the outer loop re-dispatches and reuses the existing branch/PR.'
  return [
    '[TERMINAL BUILD WAKE]',
    'Investigate this terminal build and act immediately; do not merely acknowledge it or wait for the owner.',
    '', ...facts, '', 'In THIS turn:',
    '1. Your tools EXECUTE — investigate with Read/Grep/Bash (run record, branch, repo state) and read/update the bound board item with the `work_board_list` / `work_board_update` tools.',
    instruction2,
    '3. Never push to GitHub or mutate remotes yourself (no `git push`, no `gh` mutations) — the outer loop owns GitHub operations.',
    "4. Hand work back to the owner only when no tool can advance it — then report what you measured and the single decision you need, never a bare 'reply to retry'.",
  ].join('\n')
}

export function buildTerminalBuildWakeObserver(deps: TerminalBuildWakeDeps): (run: TridentRun) => Promise<void> {
  return async (run) => {
    if (!isTerminalPhase(run.phase) || run.chat_id == null || deps.llm === null) return
    if (!(await deps.claimWake(run.id))) return
    try {
      const board_item_id = await deps.boardItemIdForRun(run)
      // Names-only ToolDefs are the REPL `--tools` contract. EXECUTABILITY comes
      // from the substrate this observer is wired to: the tool-bridge-enabled
      // background `cc-nudge-*` child with the same grants as a channel turn,
      // pinned by `open-terminal-build-wake-wiring.test.ts`.
      const tools: ToolDef[] = LIVE_AGENT_TOOL_NAMES.map((name) => ({
        name, description: `Built-in Claude Code tool '${name}' (terminal-build wake surface)`,
        input_schema: { type: 'object' }, output_schema: { type: 'object' },
        capability_required: 'fs:project_data',
      }))
      const spec: AgentSpec = {
        prompt: buildTerminalBuildWakePrompt({ run, board_item_id }), tools,
        model_preference: [getBestModel()], max_tokens: 4096,
        metering_context: { project_id: deps.projectChatScope(run) },
      }
      const reply = await deps.llm.compose(spec, { timeout_ms: TERMINAL_BUILD_WAKE_TURN_TIMEOUT_MS })
      await deps.post(run, reply, { loud: run.phase !== 'done' })
    } catch (error) {
      deps.logger.error('terminal_build_wake_failed_after_claim', {
        run_id: run.id, error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
