/**
 * tool-bridge.test.ts — P0-1 native-MCP tool bridge.
 *
 * Proves the END-TO-END spawn wiring (the SECOND `mcpServers` entry + the tools
 * manifest + the `--allowedTools` grant appear ONLY for an opted-in substrate),
 * the SECURITY default-off (an untrusted/import REPL gets neither), and the
 * reply-sink `/tools` + `/tool-call` dispatch routes that front the in-process
 * registry. Also asserts `McpServer.listToolSchemas()` carries input schemas.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import type { AgentSpec } from '../../../../substrate.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { Event } from '../../../../events.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  setReplToolBridge,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
  type ReplToolBridge,
} from '../persistent-repl-substrate.ts'
import { McpServer } from '@neutronai/mcp/server.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
  setReplToolBridge(undefined) // never leak the global across tests
})

/** Echo host that captures the argv of every spawn. */
function makeCapturingHost(): { host: PtyHost; argvs: string[][] } {
  const argvs: string[][] = []
  let spawns = 0
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      argvs.push(argv)
      const pid = 300000 + spawns
      const i = argv.indexOf('--session-id')
      const r = argv.indexOf('--resume')
      const sid = (i >= 0 ? argv[i + 1] : r >= 0 ? argv[r + 1] : undefined) as string
      const { port: sinkPort, token } = getReplSinkInfo()
      let hasExited = false
      let exitResolve: (code: number | null) => void = () => {}
      const exited = new Promise<number | null>((res) => {
        exitResolve = res
      })
      const post = (path: string, body: unknown): Promise<unknown> =>
        fetch(`http://127.0.0.1:${sinkPort}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
          body: JSON.stringify(body),
        }).catch(() => undefined)
      let seen = 0
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { text: string; turn_id?: string }
            void post('/reply', { session_id: sid, text: `seen=${seen} got=${body.text}`, turn_id: body.turn_id })
            seen += 1
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
      void post('/channel-bound', { session_id: sid })
      return {
        pid,
        write() {},
        resize() {},
        kill() {
          if (hasExited) return
          hasExited = true
          try {
            server.stop(true)
          } catch {
            /* ignore */
          }
          exitResolve(143)
        },
        exited,
        hasExited: () => hasExited,
      }
    },
  }
  return { host, argvs }
}

function opts(
  host: PtyHost,
  extra: Partial<PersistentReplSubstrateOptions>,
): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-agent-acme',
    cwd: '/tmp/neutron-acme-bridge',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    skip_permissions: true,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    ...extra,
  }
}

function spec(prompt: string): AgentSpec {
  return { prompt, tools: [{ name: 'Read' }] as AgentSpec['tools'], model_preference: ['claude-opus-4-7'] }
}

async function drain(handle: SessionHandle): Promise<string> {
  let text = ''
  for await (const ev of handle.events as AsyncIterable<Event>) {
    if (ev.kind === 'token') text += ev.text
    else if (ev.kind === 'completion') return text
    else if (ev.kind === 'error') throw new Error(`drain error: ${ev.message}`)
  }
  return text
}

/** A fake bridge advertising one tool whose dispatch echoes its args. */
function fakeBridge(calls: Array<{ tool_name: string; args: unknown }>): ReplToolBridge {
  return {
    listToolSchemas: () => [
      {
        name: 'doc_search',
        description: 'Search the owner project docs',
        input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    ],
    dispatch: async (input) => {
      calls.push({ tool_name: input.tool_name, args: input.args })
      if (input.tool_name === 'boom') throw new Error('handler exploded')
      return { results: [{ id: 'doc-1', score: 0.9 }], echoed: input.args }
    },
  }
}

function readMcpConfig(argv: string[]): { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> } {
  const p = argv[argv.indexOf('--mcp-config') + 1]!
  return JSON.parse(readFileSync(p, 'utf8'))
}

describe('P0-1 native-MCP tool bridge — spawn wiring', () => {
  it('attaches a SECOND mcpServers entry + manifest + --allowedTools when enabled', async () => {
    setReplToolBridge(fakeBridge([]))
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, user_id: 'u-1', project_id: 'default', credential_identity: 'cred-1' }),
    )
    await drain(sub.start(spec('hi')))

    const argv = argvs[0]!
    // 1. The MCP namespace is permitted.
    expect(argv).toContain('--allowedTools')
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('mcp__neutron')
    // 2. The mcp.json has BOTH the dev-channel AND the `neutron` bridge.
    const cfg = readMcpConfig(argv)
    const names = Object.keys(cfg.mcpServers)
    expect(names.some((n) => n.startsWith('neutron-'))).toBe(true) // dev-channel
    expect(cfg.mcpServers['neutron']).toBeDefined()
    expect(cfg.mcpServers['neutron']!.args.some((a) => a.endsWith('tools-bridge.ts'))).toBe(true)
    // 3. The manifest the bridge reads exists + carries the schemas.
    const manifestPath = cfg.mcpServers['neutron']!.env['TOOLS_MANIFEST_PATH']!
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest[0].name).toBe('doc_search')
    expect(manifest[0].input_schema.required).toEqual(['query'])
  })

  it('SECURITY: an opted-OUT substrate gets NO bridge even when one is wired', async () => {
    setReplToolBridge(fakeBridge([]))
    const { host, argvs } = makeCapturingHost()
    // enableToolBridge omitted → the untrusted-import/Trident default.
    const sub = createPersistentReplSubstrate(
      opts(host, { substrate_instance_id: 'cc-import-acme', user_id: '_p', project_id: 'import', credential_identity: 'c' }),
    )
    await drain(sub.start(spec('untrusted chunk')))
    const argv = argvs[0]!
    expect(argv).not.toContain('--allowedTools')
    expect(readMcpConfig(argv).mcpServers['neutron']).toBeUndefined()
  })

  it('SECURITY (ISSUES #378 r2): spec.suppress_tool_bridge denies the bridge on an enabled substrate', async () => {
    // A prose-synthesis dispatch (`buildGatewayAnthropicMessagesClient` sets
    // `suppress_tool_bridge` + `tools: []`) over the owner's warm `cc-agent-*`
    // chat substrate must NOT inherit the live `mcp__neutron` tool surface, so a
    // malicious user-editable document composed there can never drive tools.
    setReplToolBridge(fakeBridge([]))
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, user_id: 'u-3', project_id: 'amascence', credential_identity: 'cred-3' }),
    )
    const proseSpec: AgentSpec = {
      prompt: 'compose a README',
      tools: [],
      model_preference: ['claude-opus-4-7'],
      suppress_tool_bridge: true,
    }
    await drain(sub.start(proseSpec))
    const argv = argvs[0]!
    // No MCP namespace permitted, and no `neutron` bridge server in the config.
    expect(argv).not.toContain('--allowedTools')
    expect(readMcpConfig(argv).mcpServers['neutron']).toBeUndefined()
  })

  it('no-op when enabled but no bridge is wired (LLM-less / pre-compose)', async () => {
    setReplToolBridge(undefined)
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(opts(host, { enableToolBridge: true, user_id: 'u-2', project_id: 'default', credential_identity: 'c' }))
    await drain(sub.start(spec('hi')))
    const argv = argvs[0]!
    expect(argv).not.toContain('--allowedTools')
    expect(readMcpConfig(argv).mcpServers['neutron']).toBeUndefined()
  })
})

describe('P0-1 native-MCP tool bridge — reply-sink dispatch routes', () => {
  async function sinkPost(path: string, body: unknown): Promise<{ status: number; json: any }> {
    const { port, token } = getReplSinkInfo()
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
      body: JSON.stringify(body),
    })
    return { status: resp.status, json: await resp.json() }
  }

  it('/tools returns the wired bridge schemas (empty when unwired)', async () => {
    getReplSinkInfo() // ensure sink is up
    setReplToolBridge(undefined)
    expect((await sinkPost('/tools', {})).json.tools).toEqual([])
    setReplToolBridge(fakeBridge([]))
    const tools = (await sinkPost('/tools', {})).json.tools
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('doc_search')
  })

  it('/tool-call dispatches against the registry and returns a structured result', async () => {
    const calls: Array<{ tool_name: string; args: unknown }> = []
    setReplToolBridge(fakeBridge(calls))
    const { json } = await sinkPost('/tool-call', { session_id: 's', tool_name: 'doc_search', args: { query: 'taxes' }, call_id: 'c1' })
    expect(json.ok).toBe(true)
    expect(json.result.results[0].id).toBe('doc-1')
    expect(json.result.echoed).toEqual({ query: 'taxes' })
    expect(calls).toEqual([{ tool_name: 'doc_search', args: { query: 'taxes' } }])
  })

  it('/tool-call returns ok:false (not an HTTP fault) when the handler throws', async () => {
    setReplToolBridge(fakeBridge([]))
    const { status, json } = await sinkPost('/tool-call', { session_id: 's', tool_name: 'boom', args: {}, call_id: 'c2' })
    expect(status).toBe(200)
    expect(json.ok).toBe(false)
    expect(json.error).toContain('handler exploded')
  })

  it('/tool-call 503s when no bridge is wired; 400s on a missing tool_name', async () => {
    setReplToolBridge(undefined)
    expect((await sinkPost('/tool-call', { tool_name: 'x', args: {} })).status).toBe(503)
    setReplToolBridge(fakeBridge([]))
    expect((await sinkPost('/tool-call', { args: {} })).status).toBe(400)
  })

  it('threads the calling session’s ACTIVE project scope into dispatch.project_id (P0 work-board fix)', async () => {
    // A bridge that records the project_id it was dispatched with.
    const seen: Array<string | null | undefined> = []
    setReplToolBridge({
      listToolSchemas: () => [
        { name: 'work_board_add', description: 'add', input_schema: { type: 'object', properties: {} } },
      ],
      dispatch: async (input) => {
        seen.push(input.project_id)
        return { ok: true }
      },
    })
    // Spawn a warm REPL bound to project "acme" (project_id folds into the pool
    // key, so this session serves exactly the acme scope).
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, user_id: 'u-scope', project_id: 'acme', credential_identity: 'cred-scope' }),
    )
    await drain(sub.start(spec('hi')))
    // Recover the session_id the spawn used (the tools-bridge POSTs it verbatim).
    const argv = argvs[0]!
    const sidIdx = argv.indexOf('--session-id')
    const sessionId = argv[sidIdx + 1]!
    // A tool call from THAT session must carry project_id = 'acme'.
    await sinkPost('/tool-call', { session_id: sessionId, tool_name: 'work_board_add', args: { title: 'x' }, call_id: 'k' })
    expect(seen).toEqual(['acme'])
    // A tool call from an UNKNOWN session degrades to null (General / owner slug).
    await sinkPost('/tool-call', { session_id: 'no-such-session', tool_name: 'work_board_add', args: {}, call_id: 'k2' })
    expect(seen).toEqual(['acme', null])
  })
})

describe('P0-1 — McpServer satisfies ReplToolBridge', () => {
  it('listToolSchemas() carries name + description + input_schema, and HIDES agent_hidden tools', () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'reminder_create',
      description: 'Create a reminder',
      input_schema: { type: 'object', properties: { when: { type: 'string' } } },
      output_schema: { type: 'object' },
      capability_required: 'write:project_data',
      approval_policy: 'auto',
      handler: async () => ({ ok: true }),
    })
    // A stub-surface tool the agent must NOT be offered (Codex review: the
    // neutron-tools Hermes stubs all throw "lands in a later sprint").
    reg.register({
      name: 'messages_send',
      description: 'stub',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      capability_required: 'write:project_data',
      approval_policy: 'auto',
      handler: async () => {
        throw new Error('not implemented yet')
      },
      agent_hidden: true,
    })
    const server = new McpServer({ project_slug: 'acme', registry: reg })
    // Structural: an McpServer IS a ReplToolBridge.
    const bridge: ReplToolBridge = server
    const schemas = bridge.listToolSchemas()
    expect(schemas.map((s) => s.name)).toEqual(['reminder_create']) // messages_send hidden
    expect(schemas[0]).toMatchObject({
      name: 'reminder_create',
      description: 'Create a reminder',
      input_schema: { type: 'object', properties: { when: { type: 'string' } } },
    })
  })
})
