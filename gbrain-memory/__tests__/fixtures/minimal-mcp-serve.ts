/**
 * Minimal live MCP stdio server — a test double for `gbrain serve`.
 *
 * RA3: the per-spawn activation cadence (init guard latches on a LIVE connect,
 * re-arms on close/reconnect) can only be asserted against a connection that
 * ACTUALLY comes up. The real `gbrain` binary is not a workspace dep (CI hosts
 * skip the real-serve test), so this tiny server stands in: it completes the MCP
 * handshake and answers any tool call with an empty result, giving
 * `GBrainStdioMcpClient` a real live `this.client` without needing gbrain.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'minimal-mcp-serve', version: '0.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: '[]' }],
}))

await server.connect(new StdioServerTransport())
