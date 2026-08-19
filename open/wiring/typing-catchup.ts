import type { AppWsOutboundAgentTyping } from '@neutronai/channels/adapters/app-ws/envelope.ts'

/** Read the live-turn state shared by reconnect catch-up and the project rail. */
export function turnIsActive(active: ReadonlySet<string>, key: string): boolean {
  return active.has(key)
}

/** Send the current turn snapshot to one newly-opened socket without changing it. */
export function sendTurnStateSnapshot(input: {
  active: ReadonlySet<string>
  key: string
  project_id?: string
  now: () => number
  send: (env: AppWsOutboundAgentTyping) => void
}): boolean {
  const active = turnIsActive(input.active, input.key)
  const env: AppWsOutboundAgentTyping = {
    v: 1,
    type: 'agent_typing',
    state: active ? 'start' : 'end',
    ts: input.now(),
  }
  if (input.project_id !== undefined && input.project_id.length > 0) env.project_id = input.project_id
  input.send(env)
  return active
}
