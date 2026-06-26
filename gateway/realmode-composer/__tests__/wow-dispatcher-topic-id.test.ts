/**
 * P1a (2026-06-26) — every outbound web envelope must carry `topic_id` so the
 * client's per-topic drop-guard routes a notification to ITS topic, not whatever
 * is focused. A wow-moment fires asynchronously (cron / overnight) and is the
 * canonical misrouting case: it can land while the user is on a different topic.
 *
 * These assert the `WowChannelAdapter`'s two outbound envelopes
 * (`sendText` agent_message + `emitPrompt` button-prompt) stamp the destination
 * topic_id.
 */
import { expect, test } from 'bun:test'

import type { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import type { ChatOutbound } from '../../../landing/server.ts'
import { buildWowChannelAdapter } from '../build-wow-dispatcher.ts'
import type { WebChatSenderRegistry } from '../../http/chat-bridge.ts'

const TOPIC = 'web:owner:project-x'

function captureRegistry(): { sent: Array<{ topic_id: string; event: ChatOutbound }>; reg: WebChatSenderRegistry } {
  const sent: Array<{ topic_id: string; event: ChatOutbound }> = []
  const reg = {
    register: () => {},
    unregister: () => {},
    has: () => true,
    send: (topic_id: string, event: ChatOutbound): boolean => {
      sent.push({ topic_id, event })
      return true
    },
  } as unknown as WebChatSenderRegistry
  return { sent, reg }
}

test('WowChannelAdapter.sendText stamps topic_id on the agent_message envelope', async () => {
  const { sent, reg } = captureRegistry()
  const buttonStore = {
    persistInertAgentTurn: async () => undefined,
  } as unknown as ButtonStore
  const adapter = buildWowChannelAdapter({ webRegistry: reg, buttonStore })
  await adapter.sendText({ topic_id: TOPIC, body: 'your first-week brief' })
  expect(sent).toHaveLength(1)
  expect(sent[0]!.event).toEqual({
    type: 'agent_message',
    body: 'your first-week brief',
    topic_id: TOPIC,
  })
})

test('WowChannelAdapter.emitPrompt stamps topic_id on the button-prompt envelope', async () => {
  const { sent, reg } = captureRegistry()
  const prompt: ButtonPrompt = {
    prompt_id: 'p-1',
    body: 'pick one',
    options: [{ label: 'A', body: 'A', value: 'a' }],
    allow_freeform: false,
  } as unknown as ButtonPrompt
  const buttonStore = {
    emit: async (p: ButtonPrompt) => ({ prompt: p, prompt_id: p.prompt_id }),
    markDelivered: async () => undefined,
  } as unknown as ButtonStore
  const adapter = buildWowChannelAdapter({ webRegistry: reg, buttonStore })
  await adapter.emitPrompt({ prompt, topic_id: TOPIC })
  expect(sent).toHaveLength(1)
  const ev = sent[0]!.event
  expect(ev.type).toBe('agent_message')
  expect((ev as { topic_id?: string }).topic_id).toBe(TOPIC)
})
