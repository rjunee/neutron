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

  test('failed → surfaces the failure reason and leaves the branch for review', () => {
    const out = composeTerminalDelivery(
      runWith({ phase: 'failed', failure_reason: 'reached max_rounds (8) without Argus APPROVE' }),
    )
    expect(out!.text).toContain('❌')
    expect(out!.text).toContain('build failed')
    expect(out!.text).toContain('reached max_rounds (8)')
    expect(out!.text).toContain('left in place for review')
  })

  test('failed / pr mode → points at the open PR', () => {
    const out = composeTerminalDelivery(
      runWith({ phase: 'failed', merge_mode: 'pr', pr: 7, failure_reason: 'merge failed: conflict' }),
    )
    expect(out!.text).toContain('PR #7 left open for review')
  })

  test('failed → the failure reason (e.g. a merge-conflict question) rides the message verbatim', () => {
    const question =
      'ringbuf and walstore both changed flush() — drop-oldest vs block; which do you want?'
    const out = composeTerminalDelivery(runWith({ phase: 'failed', failure_reason: question }))
    expect(out!.text).toContain('❌')
    expect(out!.text).toContain(question)
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
