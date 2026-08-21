import type { ToolDef } from '@neutronai/cores-sdk/manifest'
import { getBestModel } from '@neutronai/runtime/models.ts'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
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
  return [
    '[TERMINAL BUILD WAKE]',
    'Investigate this terminal build and act immediately; do not merely acknowledge it or wait for the owner.',
    '', ...facts, '', 'In THIS turn:',
    '1. Your tools EXECUTE — investigate with Read/Grep/Bash (run record, branch, repo state) and read/update the bound board item with the `work_board_list` / `work_board_update` tools.',
    '2. Take the most valuable concrete action now. To retry or resume a failed build, ask the outer build loop: call `work_board_start` (or `work_board_dispatch_build`) on the bound board item — the outer loop re-dispatches and reuses the existing branch/PR.',
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
