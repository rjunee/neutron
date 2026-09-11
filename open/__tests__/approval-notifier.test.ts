/**
 * Task 3 — the app-ws ApprovalNotifier (`open/wiring/approval-notifier.ts`).
 *
 * Proves the composer's real approval surface: a persisted `ApprovalRow` fans a
 * plain-text `agent_message` out to every live app-ws topic, carries only the id
 * + tool_name + description (never prompt bytes), and is fail-soft — one dead
 * socket never stops the rest and `notify` never throws into `ApprovalManager`.
 *
 * 2026-09-11: the push is now OPT-IN per tool (`announce_tools`) and SCOPED to the
 * approval's own topic. Production announces nothing, because every `prompt-user`
 * approval renders its own Approve/Deny prompt — see the notifier's header.
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

/** The fixture row's tool, opted in so the legacy cases still exercise a send. */
const ANNOUNCED: ReadonlySet<string> = new Set(['ritual:morning-brief'])

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
    const notifier = buildAppWsApprovalNotifier({ registry: reg, announce_tools: ANNOUNCED })
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
    const notifier = buildAppWsApprovalNotifier({ registry: reg, announce_tools: ANNOUNCED })
    await notifier.notify(row({ args_json: '{not json' }))

    expect(reg.sent.length).toBe(1)
    expect(reg.sent[0]!.env.body).toBe('Approval requested [appr-1]: ritual:morning-brief')
  })

  // T5 — the TTL guard. This banner is a one-shot frame with no retraction, so
  // one born pointing at an already-dead grant can only be cleared by reloading
  // the page. It must never be born.
  test('a row already past ttl_ms broadcasts to nobody', async () => {
    const reg = recordingRegistry(['app:owner', 'app:owner:proj-1'])
    const now = 10_000_000
    const notifier = buildAppWsApprovalNotifier({
      registry: reg,
      announce_tools: ANNOUNCED,
      ttl_ms: 5 * 60_000,
      now: () => now,
    })
    // `requested_at` is SECONDS — six minutes ago against a five-minute TTL.
    await notifier.notify(row({ requested_at: (now - 6 * 60_000) / 1000 }))

    expect(reg.sent).toEqual([])
  })

  test('a fresh row still broadcasts under the same guard', async () => {
    const reg = recordingRegistry(['app:owner'])
    const now = 10_000_000
    const notifier = buildAppWsApprovalNotifier({
      registry: reg,
      announce_tools: ANNOUNCED,
      ttl_ms: 5 * 60_000,
      now: () => now,
    })
    await notifier.notify(row({ requested_at: (now - 60_000) / 1000 }))

    expect(reg.sent).toHaveLength(1)
  })

  test('omitting ttl_ms keeps the legacy always-broadcast behaviour', async () => {
    const reg = recordingRegistry(['app:owner'])
    const notifier = buildAppWsApprovalNotifier({ registry: reg, announce_tools: ANNOUNCED })
    // A row from 1970 — ancient by any clock, and still announced.
    await notifier.notify(row({ requested_at: 1_000 }))

    expect(reg.sent).toHaveLength(1)
  })

  // THE OWNER-REPORTED DEFECT (reported twice: 2026-05-13 "useless messages that
  // are pinned to the bottom of the chat that I can't get rid of", and again
  // 2026-09-11 with a screenshot of four stacked host-deploy pushes). Every
  // `prompt-user` approval renders its own Approve/Deny prompt, so this push was
  // a second, unactionable copy of it.
  test('a tool that is NOT announce-listed pushes nothing at all', async () => {
    const reg = recordingRegistry(['app:owner', 'app:owner:proj-1'])
    const notifier = buildAppWsApprovalNotifier({ registry: reg, announce_tools: new Set() })
    await notifier.notify(row({ tool_name: 'host-deploy' }))

    // Red mutation: drop the `announce_tools.has(row.tool_name)` gate and both
    // topics get the buttonless copy back.
    expect(reg.sent).toEqual([])
  })

  test('PRODUCTION WIRING: the empty set the composer passes announces nothing, for any tool', async () => {
    const reg = recordingRegistry(['app:owner', 'app:owner:neutron-open'])
    const notifier = buildAppWsApprovalNotifier({ registry: reg, announce_tools: new Set() })
    for (const tool of ['host-deploy', 'ritual:morning-brief', 'ritual-egress:kaizen']) {
      await notifier.notify(row({ tool_name: tool }))
    }
    expect(reg.sent).toEqual([])
  })

  // POSITIVE CONTROL for the two tests above: an empty result must mean "the gate
  // held", never "the fixture never sends". Same registry, same rows, one tool
  // opted in — and it lands.
  test('control: an announce-listed tool DOES push', async () => {
    const reg = recordingRegistry(['app:owner'])
    const notifier = buildAppWsApprovalNotifier({
      registry: reg,
      announce_tools: new Set(['host-deploy']),
    })
    await notifier.notify(row({ tool_name: 'host-deploy' }))

    expect(reg.sent).toHaveLength(1)
    expect(reg.sent[0]!.env.body).toContain('host-deploy')
  })

  // The cross-project leak: a neutron-open deploy prompt landed in every other
  // project's chat, because the fan-out ignored the row's own topic.
  test('an announced row goes ONLY to its own topic, not to every live topic', async () => {
    const reg = recordingRegistry(['app:owner', 'app:owner:neutron-open', 'app:owner:other'])
    const notifier = buildAppWsApprovalNotifier({
      registry: reg,
      announce_tools: new Set(['host-deploy']),
    })
    await notifier.notify(row({ tool_name: 'host-deploy', topic_id: 'app:owner:neutron-open' }))

    // Red mutation: restore the unconditional `for (const topic of registry.topics())`
    // and this reads all three.
    expect(reg.sent.map((s) => s.topic)).toEqual(['app:owner:neutron-open'])
  })

  test('a row whose topic is not live falls back to the broadcast — it still has to reach someone', async () => {
    const reg = recordingRegistry(['app:owner', 'app:owner:other'])
    const notifier = buildAppWsApprovalNotifier({
      registry: reg,
      announce_tools: new Set(['host-deploy']),
    })
    await notifier.notify(row({ tool_name: 'host-deploy', topic_id: 'app:owner:closed-tab' }))

    expect(reg.sent.map((s) => s.topic)).toEqual(['app:owner', 'app:owner:other'])
  })

  // 15. a throwing topic does not stop the rest, and notify never throws
  test('a dead socket on topic 1 still delivers topic 2; notify resolves', async () => {
    const reg = recordingRegistry(['dead', 'alive'], (t) => t === 'dead')
    const notifier = buildAppWsApprovalNotifier({ registry: reg, announce_tools: ANNOUNCED })
    await expect(notifier.notify(row())).resolves.toBeUndefined()
    expect(reg.sent.map((s) => s.topic)).toEqual(['alive'])
  })
})
