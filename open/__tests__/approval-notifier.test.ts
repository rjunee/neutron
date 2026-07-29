/**
 * Task 3 — the app-ws ApprovalNotifier (`open/wiring/approval-notifier.ts`).
 *
 * Proves the composer's real approval surface: a persisted `ApprovalRow` fans a
 * plain-text `agent_message` out to every live app-ws topic, carries only the id
 * + tool_name + description (never prompt bytes), and is fail-soft — one dead
 * socket never stops the rest and `notify` never throws into `ApprovalManager`.
 */
import { describe, expect, test } from 'bun:test'
import type { ApprovalRow } from '@neutronai/tools/approval.ts'
import type { AppWsOutboundAgentMessage } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import {
  buildAppWsApprovalNotifier,
  type ApprovalNotifierRegistry,
} from '../wiring/approval-notifier.ts'

type SendCall = { topic: string; env: AppWsOutboundAgentMessage }

function recordingRegistry(
  topicList: string[],
  throwOn: (topic: string) => boolean = () => false,
): ApprovalNotifierRegistry & { sent: SendCall[] } {
  const sent: SendCall[] = []
  return {
    sent,
    topics: () => topicList,
    send: (topic, env) => {
      if (throwOn(topic)) throw new Error(`dead socket: ${topic}`)
      sent.push({ topic, env })
      return true
    },
  }
}

function row(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: 'appr-1',
    project_slug: 't1',
    topic_id: null,
    tool_name: 'ritual:morning-brief',
    args_json: JSON.stringify({ description: 'read STATUS.md and summarise' }),
    status: 'pending',
    requested_at: 1_000,
    decided_at: null,
    decided_by: null,
    ...overrides,
  }
}

describe('buildAppWsApprovalNotifier', () => {
  // 13. one send per topic; body carries id + description; envelope shape
  test('broadcasts one agent_message per topic with id + description', async () => {
    const reg = recordingRegistry(['app:owner', 'app:owner:proj-1'])
    const notifier = buildAppWsApprovalNotifier({ registry: reg })
    await notifier.notify(row())

    expect(reg.sent.map((s) => s.topic)).toEqual(['app:owner', 'app:owner:proj-1'])
    for (const s of reg.sent) {
      expect(s.env.type).toBe('agent_message')
      expect(s.env.message_id).toBe('approval:appr-1')
      expect(s.env.body).toContain('appr-1')
      expect(s.env.body).toContain('ritual:morning-brief')
      expect(s.env.body).toContain('read STATUS.md and summarise')
    }
  })

  // 14. malformed args_json → still notifies with a tool_name-only body
  test('malformed args_json falls back to a tool_name-only body', async () => {
    const reg = recordingRegistry(['app:owner'])
    const notifier = buildAppWsApprovalNotifier({ registry: reg })
    await notifier.notify(row({ args_json: '{not json' }))

    expect(reg.sent.length).toBe(1)
    expect(reg.sent[0]!.env.body).toBe('Approval requested [appr-1]: ritual:morning-brief')
  })

  // 15. a throwing topic does not stop the rest, and notify never throws
  test('a dead socket on topic 1 still delivers topic 2; notify resolves', async () => {
    const reg = recordingRegistry(['dead', 'alive'], (t) => t === 'dead')
    const notifier = buildAppWsApprovalNotifier({ registry: reg })
    await expect(notifier.notify(row())).resolves.toBeUndefined()
    expect(reg.sent.map((s) => s.topic)).toEqual(['alive'])
  })
})
