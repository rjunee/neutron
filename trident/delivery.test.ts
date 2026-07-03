/**
 * @neutronai/trident — async result delivery (gap-audit P0-1).
 *
 * Unit coverage for the terminal-result composer + the channel-posting
 * hook: the right copy per terminal state, the chat_id/thread_id →
 * channel_topic_id mapping, the no-originating-chat no-op, and the
 * outbound `send` payload.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildTridentDelivery,
  composeTerminalDelivery,
  interpretFailure,
  topicForRun,
  type OutboundSink,
} from './delivery.ts'
import type { OutgoingMessage } from '../channels/types.ts'
import type { MergeMode, TridentPhase, TridentRun } from './store.ts'

function runWith(overrides: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'run-1',
    slug: 'add-flag',
    project_slug: 'proj-1',
    phase: 'done',
    round: 1,
    max_rounds: 8,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: 'trident/add-flag',
    pr: null,
    merge_mode: 'local' as MergeMode,
    subagent_run_id: null,
    subagent_status: 'completed',
    repo_path: '/repo',
    worktree: null,
    task: 'add a feature flag',
    chat_id: '12345',
    thread_id: '678',
    channel_kind: 'telegram',
    failure_reason: null,
    workflow_run_id: null,
    inner_checkpoint: null,
    inner_verdict: null,
    inner_result: null,
    started_at: '2026-01-01T00:00:00.000Z',
    last_advanced_at: '2026-01-01T01:00:00.000Z',
    ...overrides,
  }
}

/** A recording outbound sink — captures every message the hook sends. */
function recordingSink(): { sink: OutboundSink; sent: OutgoingMessage[] } {
  const sent: OutgoingMessage[] = []
  return {
    sent,
    sink: {
      async send(message) {
        sent.push(message)
        return `msg-${sent.length}`
      },
    },
  }
}

describe('composeTerminalDelivery', () => {
  test('done / pr mode → reports the merged PR number + branch (slug-forward)', () => {
    const out = composeTerminalDelivery(runWith({ phase: 'done', merge_mode: 'pr', pr: 42 }))
    expect(out).not.toBeNull()
    expect(out!.text).toContain('✅')
    // #339 — leads with the build slug + "build done, merged".
    expect(out!.text).toContain('`add-flag`')
    expect(out!.text).toContain('build done, merged')
    expect(out!.text).toContain('add a feature flag')
    expect(out!.text).toContain('PR #42')
  })

  test('done / local mode → reports the merged branch', () => {
    const out = composeTerminalDelivery(runWith({ phase: 'done', merge_mode: 'local' }))
    expect(out!.text).toContain('merged `trident/add-flag` locally')
    expect(out!.text).not.toContain('PR #')
  })

  test('done after multiple rounds → mentions the review-round count', () => {
    const out = composeTerminalDelivery(runWith({ phase: 'done', round: 3 }))
    expect(out!.text).toContain('after 3 review rounds')
  })

  test('done on the first round → omits the round suffix', () => {
    const out = composeTerminalDelivery(runWith({ phase: 'done', round: 1 }))
    expect(out!.text).not.toContain('review round')
  })

  test('failed (exhausted rounds) → plain-language review outcome, no raw reason paste (#352)', () => {
    const out = composeTerminalDelivery(
      runWith({
        phase: 'failed',
        branch: 'trident/add-flag',
        failure_reason: 'inner loop exhausted 8 round(s) without Argus APPROVE',
      }),
    )
    expect(out!.text).toContain('❌')
    // Plain language — NOT the raw internal reason string.
    expect(out!.text).toContain('blocking findings')
    expect(out!.text).not.toContain('inner loop exhausted')
    expect(out!.text).toContain('`trident/add-flag`') // names the branch to review
  })

  test('failed / pr mode → points at the open PR', () => {
    const out = composeTerminalDelivery(
      runWith({ phase: 'failed', merge_mode: 'pr', pr: 7, failure_reason: 'merge failed: conflict' }),
    )
    expect(out!.text).toContain('PR #7 left open for review')
  })

  test('failed (merge-mechanics) → NEVER pastes raw git stderr (#352)', () => {
    const out = composeTerminalDelivery(
      runWith({
        phase: 'failed',
        branch: 'trident/add-flag',
        failure_reason:
          'merge failed: git checkout base failed: error: you need to resolve your current index first',
      }),
    )
    expect(out!.text).toContain('❌')
    // The raw git stderr is DISCARDED — plain language only.
    expect(out!.text).not.toContain('resolve your current index')
    expect(out!.text).not.toContain('git checkout')
    expect(out!.text.toLowerCase()).toContain('git step failed')
  })

  test('failed → an authored merge-conflict question rides the message verbatim (specific input needed)', () => {
    const question =
      "couldn't auto-resolve the merge conflict in flush.ts for `trident/x` — it needs your call before I can land it."
    const out = composeTerminalDelivery(runWith({ phase: 'failed', failure_reason: question }))
    expect(out!.text).toContain('❌')
    // The specific decision the operator must make is surfaced verbatim.
    expect(out!.text).toContain(question)
    // ...framed with a plain-language summary of what happened.
    expect(out!.text).toContain('edited the same code')
  })

  test('stopped → a plain stopped notice', () => {
    const out = composeTerminalDelivery(runWith({ phase: 'stopped' }))
    expect(out!.text).toContain('🛑')
    expect(out!.text).toContain('stopped')
  })

  test('a non-terminal run composes nothing (defensive null)', () => {
    for (const phase of ['forge-init', 'ralph-plan', 'ralph-task', 'argus', 'forge-fix'] as TridentPhase[]) {
      expect(composeTerminalDelivery(runWith({ phase }))).toBeNull()
    }
  })

  test('a long task is truncated in the header', () => {
    const longTask = 'x'.repeat(200)
    const out = composeTerminalDelivery(runWith({ phase: 'done', task: longTask }))
    expect(out!.text).toContain('…')
    // the truncated task is ≤ 60 chars
    expect(out!.text.includes('x'.repeat(61))).toBe(false)
  })
})

describe('interpretFailure (#352) — plain-language classification, never a raw error paste', () => {
  const RAW_GIT_TOKENS = [
    'resolve your current index',
    'CONFLICT (content)',
    'error: ',
    'fatal: ',
    'exit code',
    'stderr',
    'MERGE_HEAD',
    'rebase --continue',
  ]

  // Every class'd message must be free of raw git/tool leakage.
  function assertNoRawLeak(text: string): void {
    for (const tok of RAW_GIT_TOKENS) {
      expect(text.toLowerCase()).not.toContain(tok.toLowerCase())
    }
  }

  test('hang → plain "stopped making progress" + retry', () => {
    const interp = interpretFailure(
      runWith({ phase: 'failed', failure_reason: 'no progress for 25 min — suspected agent hang (inner workflow stopped advancing)' }),
    )
    expect(interp.klass).toBe('hang')
    expect(interp.summary.toLowerCase()).toContain('progress')
    expect(interp.input_needed.toLowerCase()).toContain('retry')
    assertNoRawLeak(interp.summary + ' ' + interp.input_needed)
  })

  test('review-unresolved → plain "blocking findings" + review the branch', () => {
    const interp = interpretFailure(
      runWith({ phase: 'failed', failure_reason: 'inner loop exhausted 8 round(s) without Argus APPROVE' }),
    )
    expect(interp.klass).toBe('review-unresolved')
    expect(interp.summary.toLowerCase()).toContain('blocking findings')
    assertNoRawLeak(interp.summary + ' ' + interp.input_needed)
  })

  test('merge-conflict (authored question) → surfaces the specific question as the input needed', () => {
    const q = "couldn't auto-resolve the merge conflict in flush.ts for `trident/x` — it needs your call before I can land it."
    const interp = interpretFailure(runWith({ phase: 'failed', failure_reason: q }))
    expect(interp.klass).toBe('merge-conflict')
    expect(interp.input_needed).toBe(q)
    expect(interp.summary.toLowerCase()).toContain('same code')
  })

  test('merge-mechanics (raw git stderr) → the raw stderr is DISCARDED', () => {
    const interp = interpretFailure(
      runWith({
        phase: 'failed',
        failure_reason:
          'merge failed: git checkout base failed: error: you need to resolve your current index first',
      }),
    )
    expect(interp.klass).toBe('merge-mechanics')
    assertNoRawLeak(interp.summary + ' ' + interp.input_needed)
    expect(interp.summary.toLowerCase()).toContain('git step failed')
  })

  test('stale-state → plain, never surfaces "resolve your current index first"', () => {
    const interp = interpretFailure(
      runWith({ phase: 'failed', failure_reason: 'error: you need to resolve your current index first' }),
    )
    expect(interp.klass).toBe('stale-state')
    assertNoRawLeak(interp.summary + ' ' + interp.input_needed)
    expect(interp.input_needed.toLowerCase()).toContain('retry')
  })

  test('infra → plain internal-error + retry (provenance gate etc.)', () => {
    const interp = interpretFailure(
      runWith({ phase: 'failed', failure_reason: 'inner workflow reported APPROVE but no recorded argus-approved checkpoint (provenance gate)' }),
    )
    expect(interp.klass).toBe('infra')
    assertNoRawLeak(interp.summary + ' ' + interp.input_needed)
  })

  test('underspecified → surfaces the (already plain) guidance', () => {
    const interp = interpretFailure(
      runWith({ phase: 'failed', failure_reason: 'Plan item is underspecified — add a design doc or a detailed title.' }),
    )
    expect(interp.klass).toBe('underspecified')
    expect(interp.input_needed.length).toBeGreaterThan(0)
  })

  test('unknown/empty → a safe generic message, never a multi-line raw paste', () => {
    const interp = interpretFailure(runWith({ phase: 'failed', failure_reason: null }))
    expect(interp.klass).toBe('unknown')
    expect(interp.summary.length).toBeGreaterThan(0)
    assertNoRawLeak(interp.summary + ' ' + interp.input_needed)
  })
})

describe('topicForRun', () => {
  test('chat_id + thread_id → `<chat>:<thread>` channel_topic_id (telegram)', () => {
    const topic = topicForRun(runWith({ chat_id: '12345', thread_id: '678' }), 'telegram')
    expect(topic).not.toBeNull()
    expect(topic!.channel_kind).toBe('telegram')
    expect(topic!.channel_topic_id).toBe('12345:678')
  })

  test('chat_id only → bare `<chat>` channel_topic_id', () => {
    const topic = topicForRun(runWith({ chat_id: '12345', thread_id: null }), 'telegram')
    expect(topic!.channel_topic_id).toBe('12345')
  })

  test('no chat_id → null (nothing to deliver to)', () => {
    expect(topicForRun(runWith({ chat_id: null }), 'telegram')).toBeNull()
    expect(topicForRun(runWith({ chat_id: '' }), 'telegram')).toBeNull()
  })

  test('honours a non-default channel kind', () => {
    const topic = topicForRun(runWith({ chat_id: 'web:u1', thread_id: null }), 'app_socket')
    expect(topic!.channel_kind).toBe('app_socket')
  })
})

describe('buildTridentDelivery.onTerminal', () => {
  test('posts the composed result to the run’s originating topic', async () => {
    const { sink, sent } = recordingSink()
    const hook = buildTridentDelivery({ sink })
    await hook.onTerminal(runWith({ phase: 'done', merge_mode: 'pr', pr: 99, chat_id: '500', thread_id: '12' }))

    expect(sent.length).toBe(1)
    expect(sent[0]!.topic.channel_topic_id).toBe('500:12')
    expect(sent[0]!.topic.channel_kind).toBe('telegram')
    expect(sent[0]!.text).toContain('PR #99')
  })

  test('no-ops when the run has no originating chat', async () => {
    const { sink, sent } = recordingSink()
    const hook = buildTridentDelivery({ sink })
    await hook.onTerminal(runWith({ phase: 'done', chat_id: null }))
    expect(sent.length).toBe(0)
  })

  // #317 — the delivery channel is derived PER RUN from `run.channel_kind`,
  // not hard-coded to telegram. A `/code` build dispatched from the app-WS
  // surface delivers its result back to that surface.
  test('#317 derives the delivery channel from the run record (app_socket)', async () => {
    const { sink, sent } = recordingSink()
    const hook = buildTridentDelivery({ sink }) // no channel_kind override
    await hook.onTerminal(
      runWith({ phase: 'done', chat_id: 'web:u1', thread_id: null, channel_kind: 'app_socket' }),
    )
    expect(sent.length).toBe(1)
    expect(sent[0]!.topic.channel_kind).toBe('app_socket')
    expect(sent[0]!.topic.channel_topic_id).toBe('web:u1')
  })

  test('#317 a Telegram-origin run still delivers to telegram', async () => {
    const { sink, sent } = recordingSink()
    const hook = buildTridentDelivery({ sink })
    await hook.onTerminal(runWith({ phase: 'done', chat_id: '500', channel_kind: 'telegram' }))
    expect(sent[0]!.topic.channel_kind).toBe('telegram')
  })

  test('#317 the run record wins over the build-time fallback channel', async () => {
    const { sink, sent } = recordingSink()
    // Even with a telegram fallback, an app_socket run routes to app_socket.
    const hook = buildTridentDelivery({ sink, channel_kind: 'telegram' })
    await hook.onTerminal(
      runWith({ phase: 'done', chat_id: 'web:u9', channel_kind: 'app_socket' }),
    )
    expect(sent[0]!.topic.channel_kind).toBe('app_socket')
  })

  test('a custom composer returning null suppresses the post', async () => {
    const { sink, sent } = recordingSink()
    const hook = buildTridentDelivery({ sink, compose: () => null })
    await hook.onTerminal(runWith({ phase: 'failed', chat_id: '1' }))
    expect(sent.length).toBe(0)
  })

  test('propagates a sink failure to the caller (the loop logs + continues)', async () => {
    const hook = buildTridentDelivery({
      sink: { async send() { throw new Error('telegram 502') } },
    })
    await expect(hook.onTerminal(runWith({ phase: 'done', chat_id: '1' }))).rejects.toThrow('telegram 502')
  })

  test('forwards inline_choices when a custom composer supplies them', async () => {
    const { sink, sent } = recordingSink()
    const hook = buildTridentDelivery({
      sink,
      compose: () => ({ text: 'done', inline_choices: [{ label: 'View', callback_data: 'v' }] }),
    })
    await hook.onTerminal(runWith({ phase: 'done', chat_id: '1' }))
    expect(sent[0]!.inline_choices).toEqual([{ label: 'View', callback_data: 'v' }])
  })
})
