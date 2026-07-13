#!/usr/bin/env bun
/**
 * tools-bridge.ts — per-session stdio-MCP bridge that fronts the gateway's
 * IN-PROCESS `ToolRegistry` / `McpServer` to the spawned `claude` REPL.
 *
 * This is the "stdio / Unix-socket transport layer" that `mcp/server.ts:4-7`
 * deferred to "P1 S5+". It is the native-MCP payload that P0-1 lifts from
 * Vajra's `generateMcpConfig` (`~/vajra/gateway/index.ts:949-968`), which
 * writes a MULTI-server mcp.json (channel + `mempalace` + `qmd`). Where Neutron
 * previously wired `--mcp-config` to the dev-channel REPLY SINK ONLY
 * (`persistent-repl-substrate.ts`, "ONLY that one server"), the substrate now
 * adds a SECOND `mcpServers` entry pointing here, so the agent can make
 * structured, chainable, self-initiated tool calls (search → reason → act →
 * reply) and receive a `tool_result` it can act on in the same turn — without
 * the user typing a `/cmd`.
 *
 * Architecture (mirrors `dev-channel.ts`, the sibling HTTP-to-MCP bridge):
 *   • MCP server (stdio) — talks to Claude Code. Exposes every registry tool.
 *   • The tool LIST is read from a manifest file the substrate writes at spawn
 *     time (`TOOLS_MANIFEST_PATH`) — a snapshot of `McpServer.listToolSchemas()`
 *     taken AFTER the gateway module-graph registered all Cores/doc-search/etc.
 *     A file (not a runtime fetch) keeps discovery deterministic and race-free.
 *   • A tool CALL POSTs to the substrate's in-process reply-sink HTTP server
 *     (`SINK_PORT` + `/tool-call`), exactly the loopback the dev-channel uses
 *     for `/reply`. The sink dispatches against the live `McpServer` (the global
 *     `ReplToolBridge` set by `composeProductionGraph`) and returns the
 *     structured result.
 *
 * Env (set by the substrate in the generated `--mcp-config`):
 *   SINK_PORT            — the substrate's reply-sink HTTP port
 *   SINK_TOKEN           — shared secret for sink POSTs
 *   SESSION_ID           — echoed on the dispatch (logging / future topic-bind)
 *   TOOLS_MANIFEST_PATH  — path to the JSON tool-schema manifest
 *   BRIDGE_SERVER_NAME   — the MCP server name (tools surface as
 *                          `mcp__<name>__<tool>`); defaults to `neutron`
 *
 * Security: this bridge is attached ONLY to substrates that opt in via
 * `enableToolBridge` (the owner's WARM conversational REPL). The untrusted
 * history-import REPL and the disposable Trident build REPLs never enable it,
 * so a prompt-injection in imported data can never reach a Core tool.
 */

import { readFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { installProcessSafetyNet } from '@neutronai/logger/fire-and-forget.ts'

// F3 — standalone entrypoint (spawned tools-bridge MCP process, sibling to
// dev-channel.ts): arm the process-level rejection/exception net as the VERY
// FIRST statement, before any env read / init / top-level `await mcp.connect`,
// so a startup failure is logged-then-crashed with structure.
installProcessSafetyNet()

const SINK_PORT = parseInt(process.env['SINK_PORT'] || '0', 10)
const SINK_TOKEN = process.env['SINK_TOKEN'] || ''
const SESSION_ID = process.env['SESSION_ID'] || ''
const MANIFEST_PATH = process.env['TOOLS_MANIFEST_PATH'] || ''
const SERVER_NAME = process.env['BRIDGE_SERVER_NAME'] || 'neutron'

interface ManifestTool {
  name: string
  description: string
  input_schema?: unknown
}

/** Load the tool manifest the substrate wrote at spawn time. A missing/corrupt
 *  manifest degrades to an EMPTY tool list (the agent simply sees no Neutron
 *  tools) rather than crashing the bridge — fail-soft, never fail-loud. */
function loadManifest(): ManifestTool[] {
  if (MANIFEST_PATH === '') return []
  try {
    const raw = readFileSync(MANIFEST_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is ManifestTool =>
        typeof t === 'object' && t !== null && typeof (t as ManifestTool).name === 'string',
    )
  } catch (e) {
    process.stderr.write(`neutron-tools-bridge: manifest load failed: ${e}\n`)
    return []
  }
}

const MANIFEST = loadManifest()

const mcp = new Server(
  { name: SERVER_NAME, version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      `These are this user's Neutron tools (calendar, reminders, notes, memory,`,
      `document + conversation search, project management, and more). They are`,
      `NATIVE tool calls: invoke them yourself, mid-reasoning, whenever they help`,
      `answer the turn — do NOT wait for the user to type a slash-command. You may`,
      `chain them (search → reason → act) and use each structured tool_result`,
      `directly in your reply.`,
    ].join(' '),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: MANIFEST.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema:
      t.input_schema !== undefined && t.input_schema !== null
        ? (t.input_schema as Record<string, unknown>)
        : { type: 'object', properties: {}, additionalProperties: true },
  })),
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const toolName = req.params.name
  const args = req.params.arguments ?? {}
  try {
    const respText = await postToSink('/tool-call', {
      session_id: SESSION_ID,
      tool_name: toolName,
      args,
      call_id: `${SESSION_ID}:${toolName}`,
    })
    let parsed: { ok?: boolean; result?: unknown; error?: string }
    try {
      parsed = JSON.parse(respText) as typeof parsed
    } catch {
      // The sink always answers JSON; a non-JSON body is an infra fault.
      return {
        content: [{ type: 'text', text: `error: tool bridge got non-JSON response: ${respText}` }],
        isError: true,
      }
    }
    if (parsed.ok === false || parsed.error !== undefined) {
      return {
        content: [{ type: 'text', text: `error: ${parsed.error ?? 'tool dispatch failed'}` }],
        isError: true,
      }
    }
    // Return the structured result as a JSON text block so the model gets the
    // full payload (arrays/objects) it can reason over, not a lossy summary. A
    // handler that returns undefined (the sink's `Response.json` drops the key,
    // so `parsed.result` is `undefined`) coalesces to the literal `null` — never
    // a `text: undefined` block, which would serialise to MCP content with no
    // `text` field and hand the model an empty/degraded result.
    const payload =
      parsed.result === undefined
        ? 'null'
        : typeof parsed.result === 'string'
          ? parsed.result
          : JSON.stringify(parsed.result, null, 2)
    return { content: [{ type: 'text', text: payload }] }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`neutron-tools-bridge: tool ${toolName} failed: ${msg}\n`)
    return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
  }
})

// --- Helper: POST to the substrate reply-sink (same loopback as dev-channel) ---

/**
 * SINGLE attempt — NO retry. Tool calls are NON-idempotent: a write tool
 * (reminder_create, note, dispatch_agent, …) ran by the sink handler must not
 * be re-executed if the loopback connection drops AFTER the handler ran but
 * BEFORE the response is read (fetch would reject and a retry would double-write).
 * `/tool-call` carries no idempotency key, so a failed POST surfaces as an
 * `isError` tool_result the model can retry DELIBERATELY (vs. a silent duplicate).
 * This is the deliberate divergence from the dev-channel's retried `/reply`
 * (which is idempotent — turn-id correlated, and a stale re-post is rejected).
 */
async function postToSink(path: string, body: Record<string, unknown>): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${SINK_PORT}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(SINK_TOKEN ? { 'X-Sink-Token': SINK_TOKEN } : {}),
    },
    body: JSON.stringify(body),
  })
  return await resp.text()
}

// --- Graceful + orphan-safe shutdown (ported from dev-channel ISSUES #217) ---
// When the spawning `claude` dies, the stdio transport closes; without these
// hooks a loopback-less bun process could linger. A bridge whose claude is gone
// can never serve a call again (the substrate always spawns a fresh bridge per
// REPL incarnation), so exit is unconditionally correct.
function shutdownBridge(reason: string): void {
  process.stderr.write(`neutron-tools-bridge: shutting down (${reason})\n`)
  process.exit(0)
}

process.on('SIGTERM', () => shutdownBridge('SIGTERM'))
process.on('SIGINT', () => shutdownBridge('SIGINT'))

const transport = new StdioServerTransport()
await mcp.connect(transport)
process.stderr.write(
  `neutron-tools-bridge: MCP connected as '${SERVER_NAME}' (${MANIFEST.length} tools), sink at ${SINK_PORT}\n`,
)

mcp.onclose = () => shutdownBridge('mcp transport closed')
process.stdin.on('end', () => shutdownBridge('stdin EOF (parent gone)'))
process.stdin.on('close', () => shutdownBridge('stdin closed (parent gone)'))
