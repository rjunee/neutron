// rjunee/neutron#1094 — the MCP stdio REGISTRATION is observed.
//
// `createToolCallHandler` (tools-bridge-handler.ts) and the dev-channel's
// reply/typing switch are both well tested as functions. What no test drove was
// the line that hands each of them to the running MCP server —
// `tools-bridge-impl.ts:111` and `dev-channel-impl.ts:152`. Replacing either
// registered callback with one that answers `{ text: 'null' }` for every call
// compiled and left every suite green: the tested handler and the running
// bridge were connected by a line nothing looked at.
//
// So these tests spawn the REAL entry points as subprocesses (the pattern of
// dev-channel-exit-on-close.test.ts) and speak MCP to them through the SDK's
// own stdio client. Each asserts on an outcome ONLY the registered handler can
// produce. Under the registration mutation both go red; see the mutation table
// in the as-built record.

import { afterEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TOOLS_BRIDGE = join(__dirname, '..', 'tools-bridge.ts')
const DEV_CHANNEL = join(__dirname, '..', 'dev-channel.ts')

interface Spawned {
  client: Client
  transport: StdioClientTransport
  stderr: () => string
}

/** Spawn a real MCP stdio entry point and complete the initialize handshake. */
async function spawnMcp(entry: string, env: Record<string, string>): Promise<Spawned> {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [entry],
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: 'pipe',
  })
  let captured = ''
  transport.stderr?.on('data', (chunk: Buffer) => {
    captured += chunk.toString('utf8')
  })
  const client = new Client({ name: 'registration-test', version: '0.0.0' }, { capabilities: {} })
  // connect() resolves only after the server answered `initialize`, which the
  // bridge can do only once `mcp.connect(transport)` ran — i.e. after every
  // setRequestHandler call above it in the module body.
  await client.connect(transport)
  return { client, transport, stderr: () => captured }
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content.map((c) => c.text ?? '').join('')
}

const open: Spawned[] = []
afterEach(async () => {
  for (const s of open.splice(0)) await s.transport.close()
})

describe('MCP stdio registration is observed (#1094)', () => {
  test('tools-bridge: a tools/call reaches the REGISTERED handler, which POSTs the sink and maps its 401 to isError', async () => {
    const posts: string[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: (req) => {
        posts.push(new URL(req.url).pathname)
        return new Response(JSON.stringify({ status: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })
    try {
      const s = await spawnMcp(TOOLS_BRIDGE, {
        SINK_PORT: String(sink.port),
        SINK_TOKEN: '',
        SESSION_ID: 'test-session-1094',
        TOOLS_MANIFEST_PATH: '',
      })
      open.push(s)
      expect(s.stderr()).toContain('MCP connected')

      const result = await s.client.callTool({ name: 'work_board_list', arguments: {} })

      // Only the registered handler POSTs the sink; the mutation never does.
      expect(posts).toEqual(['/tool-call'])
      expect(result.isError).toBe(true)
      const text = textOf(result)
      expect(text).not.toBe('null')
      expect(text).toContain('tool dispatch refused (HTTP 401)')
    } finally {
      sink.stop(true)
    }
  }, 20_000)

  test('dev-channel: a tools/call reaches the REGISTERED handler, which refuses an empty reply with isError', async () => {
    const s = await spawnMcp(DEV_CHANNEL, {
      // Unreachable sink, exactly as dev-channel-exit-on-close.test.ts: the
      // /channel-ready announce fails (caught + logged). The empty-reply refusal
      // is decided before any sink traffic, so the assertion needs none.
      SINK_PORT: '59999',
      SINK_TOKEN: '',
      SESSION_ID: 'test-session-1094',
      CHANNEL_NAME: 'test-channel-1094',
    })
    open.push(s)
    expect(s.stderr()).toContain('MCP connected')

    const result = await s.client.callTool({ name: 'reply', arguments: {} })

    expect(result.isError).toBe(true)
    const text = textOf(result)
    expect(text).not.toBe('null')
    expect(text).toContain('reply requires a non-empty `text`')
  }, 20_000)
})
