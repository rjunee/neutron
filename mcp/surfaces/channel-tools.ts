/**
 * @neutronai/mcp — channel-tools surface.
 *
 * Tools that let a Core directly address a channel (e.g. `channel_send_message`
 * to push without going through the topic-lifecycle reply path). P1 S4 ships
 * two tools:
 * `channel_send_message` and `channel_acknowledge_choice`. Both resolve
 * via the supplied `ChannelRouter`.
 */

import type { ChannelRouter } from '@neutronai/channels/router.ts'
import type { OutgoingMessage, Topic } from '@neutronai/channels/types.ts'
import type { ToolHandler, ToolRegistry } from '@neutronai/tools/registry.ts'

const sendInputSchema = {
  type: 'object',
  required: ['topic', 'text'],
  properties: {
    topic: { type: 'object' },
    text: { type: 'string' },
    inline_choices: { type: 'array' },
    adapter_options: { type: 'object' },
  },
} as const

const ackInputSchema = {
  type: 'object',
  required: ['channel_topic_id', 'callback_id'],
  properties: {
    channel_topic_id: { type: 'string' },
    callback_id: { type: 'string' },
  },
} as const

const stringOutputSchema = { type: 'object', properties: { id: { type: 'string' } } } as const

interface SendArgs {
  topic: Topic
  text: string
  inline_choices?: OutgoingMessage['inline_choices']
  adapter_options?: OutgoingMessage['adapter_options']
}

interface AckArgs {
  channel_topic_id: string
  callback_id: string
}

/**
 * Register the channel-tools surface. The router is captured by closure
 * so handlers can dispatch without re-resolution.
 */
export function registerChannelToolsSurface(
  registry: ToolRegistry,
  router: ChannelRouter,
): string[] {
  const sendHandler: ToolHandler = async (rawArgs) => {
    const args = rawArgs as SendArgs
    const message: OutgoingMessage = {
      topic: args.topic,
      text: args.text,
    }
    if (args.inline_choices !== undefined) message.inline_choices = args.inline_choices
    if (args.adapter_options !== undefined) message.adapter_options = args.adapter_options
    return { id: await router.send(message) }
  }
  const ackHandler: ToolHandler = async (rawArgs) => {
    const args = rawArgs as AckArgs
    // The adapter is looked up through the router; ChannelRouter.acknowledge
    // is not a method, so we resolve via getAdapter from the topic's kind.
    // Channel-tools is opinionated to telegram for now; a Core that wants
    // multi-channel ack needs the topic shape.
    const adapter = router.getAdapter('telegram')
    if (!adapter || !adapter.acknowledgeChoice) {
      throw new Error('channel-tools: telegram adapter not registered or does not support acknowledgeChoice')
    }
    await adapter.acknowledgeChoice(args.channel_topic_id, args.callback_id)
    return { id: args.callback_id }
  }

  registry.register({
    name: 'channel_send_message',
    description: 'Send a message to a topic on its bound channel',
    input_schema: sendInputSchema,
    output_schema: stringOutputSchema,
    capability_required: 'write:project_data',
    approval_policy: 'auto',
    handler: sendHandler,
  })
  registry.register({
    name: 'channel_acknowledge_choice',
    description: 'Acknowledge an inline-keyboard callback (Telegram answerCallbackQuery)',
    input_schema: ackInputSchema,
    output_schema: stringOutputSchema,
    capability_required: 'write:project_data',
    approval_policy: 'auto',
    handler: ackHandler,
  })
  return ['channel_send_message', 'channel_acknowledge_choice']
}
