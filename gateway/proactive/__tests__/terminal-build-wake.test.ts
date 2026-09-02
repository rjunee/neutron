import { describe, expect, test } from 'bun:test'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import { FIRE_PUBLISHED_REASON_MARKER, FIRE_SETTLE_TIMEOUT_ERROR, publishedFailureReason } from '@neutronai/trident/fire-evidence.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'
import { makeTridentRun } from '@neutronai/trident/testing/make-trident-run.ts'
import { LIVE_AGENT_TOOL_NAMES } from '../../wiring/build-live-agent-turn.ts'
import {
  buildTerminalBuildWakeObserver,
  buildTerminalBuildWakePrompt,
  TERMINAL_BUILD_WAKE_TURN_TIMEOUT_MS,
  type TerminalBuildWakeDeps,
} from '../terminal-build-wake.ts'

function run(over: Partial<TridentRun> = {}): TridentRun {
  return makeTridentRun({
    id: 'run-123', slug: 'wake', project_slug: 'acme', phase: 'done', max_rounds: 3,
    max_ralph_rounds: 0, branch: 'trident/wake', pr: 42, merge_mode: 'pr',
    subagent_run_id: null, subagent_status: null, repo_path: '/repo', worktree: '/worktree',
    task: 'Repair terminal delivery', chat_id: 'chat-1', channel_kind: 'app_socket',
    started_at: 'T', last_advanced_at: 'T', ...over,
  })
}

function harness(error?: Error) {
  const specs: AgentSpec[] = [], optsSeen: Array<{ timeout_ms?: number } | undefined> = []
  const claims: string[] = [], posts: boolean[] = [], logs: unknown[] = []
  const deps: TerminalBuildWakeDeps = {
    claimWake: async (id) => { claims.push(id); return true }, boardItemIdForRun: async () => 'board-9',
    llm: { compose: async (spec, opts) => { specs.push(spec); optsSeen.push(opts); if (error) throw error; return 'Acted.' } },
    projectChatScope: () => 'acme-scope',
    post: async (_run, _reply, opts) => { posts.push(opts.loud); return true },
    logger: { error: (_message, fields) => logs.push(fields) },
  }
  return { deps, specs, optsSeen, claims, posts, logs }
}

describe('terminal build wake', () => {
  test('done run makes one scoped, quiet turn with all facts', async () => {
    const h = harness(); await buildTerminalBuildWakeObserver(h.deps)(run())
    expect(h.claims).toEqual(['run-123']); expect(h.specs).toHaveLength(1); expect(h.posts).toEqual([false])
    expect(h.optsSeen).toEqual([{ timeout_ms: TERMINAL_BUILD_WAKE_TURN_TIMEOUT_MS }])
    expect(TERMINAL_BUILD_WAKE_TURN_TIMEOUT_MS).toBeGreaterThan(90_000)
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
      expect(prompt).not.toContain('PR #'); expect(prompt).not.toContain('Failure reason'); expect(prompt).toContain('none')
    }
    const prompt = buildTerminalBuildWakePrompt({ run: run(), board_item_id: 'item' })
    expect(prompt).toContain('PR #42'); expect(prompt).toContain('act immediately'); expect(prompt).toContain('concrete action now')
    expect(prompt).toContain('work_board_start'); expect(prompt).toContain('owns GitHub')
  })
  test('settle-timeout failure reason rewrites instruction 2 to resolve the branch holder first', () => {
    const reason = `inner workflow fire failed: ${FIRE_SETTLE_TIMEOUT_ERROR}`
    const prompt = buildTerminalBuildWakePrompt({ run: run({ phase: 'failed', failure_reason: reason }), board_item_id: 'item' })
    expect(prompt).not.toContain('To retry or resume a failed build')
    expect(prompt).toContain('Do NOT relaunch this build yet')
    expect(prompt).toContain('git worktree list --porcelain')
    expect(prompt).toContain('inner_checkpoint')
    expect(prompt).toContain(reason)
    expect(prompt).toContain('Your tools EXECUTE')
    expect(prompt).toContain('owns GitHub operations')
    expect(prompt).toContain('Hand work back to the owner')
  })
  test('published failure reason rewrites instruction 2 and points at a review round', () => {
    const reason = publishedFailureReason(`outer-published:${'a'.repeat(40)}:0:3`)
    const prompt = buildTerminalBuildWakePrompt({ run: run({ phase: 'failed', failure_reason: reason }), board_item_id: 'item' })
    expect(prompt).not.toContain('To retry or resume a failed build')
    expect(prompt).toContain('Do NOT relaunch this build yet')
    expect(prompt).toContain('REVIEW round')
    expect(reason).toContain(FIRE_PUBLISHED_REASON_MARKER)
  })
  // ARGUS r4 (minor): the rewritten instruction ended "…ONLY once nothing live
  // holds the branch and no published work exists" — unsatisfiable for a
  // published row, which steered the agent away from the CHEAPEST correct
  // recovery. The instruction must point at a recovery that exists.
  //
  // ARGUS r5 (BLOCKER): the recovery it then named was the WRONG one, and this
  // test pinned the lie. `work_board_start` does NOT resume an `outer-published:`
  // head — `store.create` writes `inner_checkpoint: null` unconditionally
  // (pinned in `trident/store.test.ts`), so the orchestrator's
  // `resume_checkpoint` is null and the dispatch rebuilds. The review-only path
  // is a `bound_pr` dispatch, which `work_board_start` cannot express.
  test('the published instruction names the review round that actually exists, not a start-as-resume', () => {
    const reason = publishedFailureReason(`outer-published:${'a'.repeat(40)}:0:3`)
    const prompt = buildTerminalBuildWakePrompt({ run: run({ phase: 'failed', failure_reason: reason }), board_item_id: 'item' })
    expect(prompt).not.toContain('no published work exists')
    // The claim that killed it: starting the item resumes instead of rebuilding.
    expect(prompt).not.toContain('resumes an `outer-published:` head into a REVIEW round')
    expect(prompt).toContain('`work_board_dispatch_build` with `bound_pr`')
    expect(prompt).toContain('reviews the published head and never builds')
    expect(prompt).toContain('it REBUILDS from scratch')
  })
  // ARGUS r4 (major): the marker used to be the plain English phrase `already
  // built and published`, matched with `includes()`. Any failure_reason that
  // merely QUOTED that phrase — this is a real forge assertion message — read as
  // published-unreviewed and suppressed the relaunch of a build that never
  // published anything. The marker is now a bracketed token; prose cannot collide.
  test('a failure reason that merely QUOTES the English phrase is NOT read as published', () => {
    const reason =
      'forge assertion failed: expected text already built and published to be absent'
    const prompt = buildTerminalBuildWakePrompt({
      run: run({ phase: 'failed', failure_reason: reason }),
      board_item_id: 'item',
    })
    expect(prompt).not.toContain('Do NOT relaunch this build yet')
    expect(prompt).toContain('To retry or resume a failed build')
  })
  // ARGUS r8 (major): the token fixed the English collision, not the mechanism —
  // `includes()` matched the token wherever it appeared, and a launcher-crash
  // reason embeds substrate output verbatim. Suppressing THIS relaunch is the
  // expensive direction, so the match anchors on the producer's head.
  test('a failure reason that EMBEDS the literal machine token mid-string is NOT read as published', () => {
    const reason =
      'inner workflow fire failed: substrate said: expected reason to contain ' +
      `${FIRE_PUBLISHED_REASON_MARKER} but it did not`
    const prompt = buildTerminalBuildWakePrompt({
      run: run({ phase: 'failed', failure_reason: reason }),
      board_item_id: 'item',
    })
    expect(prompt).not.toContain('Do NOT relaunch this build yet')
    expect(prompt).toContain('To retry or resume a failed build')
  })
  test('every other failure reason keeps instruction 2 byte-identical', () => {
    const ORIGINAL_INSTRUCTION_2 =
      '2. Take the most valuable concrete action now. To retry or resume a failed build, ask the outer build loop: call `work_board_start` (or `work_board_dispatch_build`) on the bound board item — the outer loop re-dispatches and reuses the existing branch/PR.'
    for (const over of [
      { phase: 'failed' as const, failure_reason: 'no progress for 90 min — suspected agent hang' },
      { phase: 'done' as const, failure_reason: null },
    ]) {
      const prompt = buildTerminalBuildWakePrompt({ run: run(over), board_item_id: 'item' })
      expect(prompt.split('\n')).toContain(ORIGINAL_INSTRUCTION_2)
      expect(prompt).not.toContain('Do NOT relaunch this build yet')
    }
  })
})
