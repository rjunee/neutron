import { describe, expect, test } from 'bun:test'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'
import { LIVE_AGENT_TOOL_NAMES } from '../../wiring/build-live-agent-turn.ts'
import { buildTerminalBuildWakeObserver, buildTerminalBuildWakePrompt, type TerminalBuildWakeDeps } from '../terminal-build-wake.ts'

function run(over: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'run-123', slug: 'wake', project_slug: 'acme', phase: 'done', round: 1, max_rounds: 3,
    ralph: false, ralph_round: 0, max_ralph_rounds: 0, branch: 'trident/wake', pr: 42,
    merge_mode: 'pr', subagent_run_id: null, subagent_status: null, repo_path: '/repo',
    worktree: '/worktree', task: 'Repair terminal delivery', chat_id: 'chat-1', thread_id: null,
    channel_kind: 'app_socket', failure_reason: null, workflow_run_id: null, inner_checkpoint: null,
    inner_checkpoint_head: null, inner_checkpoint_findings: null, inner_verdict: null,
    inner_result: null, started_at: 'T', last_advanced_at: 'T', harvested_at: null,
    crash_recoveries: 0, infra_retries: 0,
    reviewed_head: null, bound_pr: null, fenced_paths: null,
    base_sha: null, base_behind: null, ...over,
  }
}

function harness(error?: Error) {
  const specs: AgentSpec[] = [], claims: string[] = [], posts: boolean[] = [], logs: unknown[] = []
  const deps: TerminalBuildWakeDeps = {
    claimWake: async (id) => { claims.push(id); return true }, boardItemIdForRun: async () => 'board-9',
    llm: { compose: async (spec) => { specs.push(spec); if (error) throw error; return 'Acted.' } },
    projectChatScope: () => 'acme-scope',
    post: async (_reply, opts) => { posts.push(opts.loud); return true },
    logger: { error: (_message, fields) => logs.push(fields) },
  }
  return { deps, specs, claims, posts, logs }
}

describe('terminal build wake', () => {
  test('done run makes one scoped, quiet turn with all facts', async () => {
    const h = harness(); await buildTerminalBuildWakeObserver(h.deps)(run())
    expect(h.claims).toEqual(['run-123']); expect(h.specs).toHaveLength(1); expect(h.posts).toEqual([false])
    expect(h.specs[0]!.metering_context?.project_id).toBe('acme-scope')
    expect(h.specs[0]!.tools.map((tool) => tool.name)).toEqual([...LIVE_AGENT_TOOL_NAMES])
    for (const fact of ['run-123', 'board-9', 'done', 'trident/wake', 'Repair terminal delivery']) expect(h.specs[0]!.prompt).toContain(fact)
  })
  test('failed reason is verbatim and loud', async () => {
    const reason = 'line one\n  exact $bytes `${stay}`'; const h = harness()
    await buildTerminalBuildWakeObserver(h.deps)(run({ phase: 'failed', failure_reason: reason }))
    expect(h.specs[0]!.prompt).toContain(reason); expect(h.posts).toEqual([true])
  })
  test('redelivery after lost claim makes no duplicate turn', async () => {
    const h = harness(); let won = true
    h.deps.claimWake = async (id) => { h.claims.push(id); const result = won; won = false; return result }
    const observe = buildTerminalBuildWakeObserver(h.deps), terminal = run()
    await observe(terminal); await observe(terminal)
    expect(h.claims).toHaveLength(2); expect(h.specs).toHaveLength(1); expect(h.posts).toHaveLength(1)
  })
  test('no chat, non-terminal, and unavailable substrate never claim', async () => {
    const h = harness(); const observe = buildTerminalBuildWakeObserver(h.deps)
    await observe(run({ chat_id: null })); await observe(run({ phase: 'argus' })); h.deps.llm = null; await observe(run())
    expect(h.claims).toHaveLength(0); expect(h.specs).toHaveLength(0)
  })
  test('missing board item says none and still composes', async () => {
    const h = harness(); h.deps.boardItemIdForRun = async () => null
    await buildTerminalBuildWakeObserver(h.deps)(run()); expect(h.specs[0]!.prompt).toContain('Board item id: none')
  })
  test('post-claim compose failure is logged, not thrown', async () => {
    const h = harness(new Error('substrate broke'))
    await expect(buildTerminalBuildWakeObserver(h.deps)(run())).resolves.toBeUndefined()
    expect(h.claims).toHaveLength(1); expect(h.posts).toHaveLength(0); expect(h.logs[0]).toMatchObject({ error: 'substrate broke' })
  })
  test('prompt renders only positive PR and omits null failure', () => {
    for (const pr of [0, null]) {
      const prompt = buildTerminalBuildWakePrompt({ run: run({ pr }), board_item_id: null })
      expect(prompt).not.toMatch(/\bPR\b/); expect(prompt).not.toContain('Failure reason'); expect(prompt).toContain('none')
    }
    const prompt = buildTerminalBuildWakePrompt({ run: run(), board_item_id: 'item' })
    expect(prompt).toContain('PR #42'); expect(prompt).toContain('act immediately'); expect(prompt).toContain('concrete action now')
  })
})
