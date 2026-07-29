/**
 * @neutronai/mcp — public barrel.
 *
 * Exports the per-instance MCP server primitive + the 3 tool surfaces that
 * ship in P1 S4. Cores dispatch in P3 builds the production handlers behind
 * the registered surface stubs.
 */

export const __MODULE__ = '@neutronai/mcp' as const

export { McpServer, type McpServerOptions } from './server.ts'
export {
  withTopicContext,
  currentTopicContext,
  requireTopicContext,
  type TopicContext,
} from './topic-context.ts'

export { registerNeutronToolsSurface, NEUTRON_TOOL_NAMES } from './surfaces/neutron-tools.ts'
export {
  registerCoreTool,
  unregisterCoreTools,
  type CoreToolRegistrationInput,
} from './surfaces/core-tools.ts'
export { registerChannelToolsSurface } from './surfaces/channel-tools.ts'
