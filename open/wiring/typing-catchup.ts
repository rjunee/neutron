import type { AppWsOutboundAgentTyping } from '@neutronai/channels/adapters/app-ws/envelope.ts'

/** Send current typing state to one newly-opened socket without changing it. */
export function sendTypingCatchUp(input: {
  active: ReadonlySet<string>
  key: string
  project_id?: string
  now: () => number
  send: (env: AppWsOutboundAgentTyping) => void
}): boolean {
  if (!input.active.has(input.key)) return false
  const env: AppWsOutboundAgentTyping = {
    v: 1,
    type: 'agent_typing',
    state: 'start',
    ts: input.now(),
  }
  if (input.project_id !== undefined && input.project_id.length > 0) env.project_id = input.project_id
  input.send(env)
  return true
}
