#!/usr/bin/env bun
/**
 * dev-channel.ts — per-session HTTP-to-MCP bridge, spawned by `claude` via
 * `--mcp-config` + `--dangerously-load-development-channels`.
 *
 * LIFTED from Nova `gateway/webhook-channel.ts` (§ 1 #4, ◆ ADAPTED-AT-BOUNDARY).
 * The MCP-server + loopback-HTTP-bridge pattern, the `notifications/claude/channel`
 * injection, and the `reply` / `send_typing` tool defs are the Nova logic.
 *
 * THE SINK SWAP (the crux, brief § 3 #4): Nova's `reply` tool POSTed to a
 * Telegram gateway's `/reply` endpoint. Here it POSTs to the Neutron
 * substrate's in-process REPLY SINK (`SINK_PORT`), which resolves the
 * in-flight turn's `completion` Event. There is no Telegram — the reply text
 * becomes the substrate turn result.
 *
 * Dual-server process:
 *   • MCP server (stdio) — talks to Claude Code. Exposes `reply` + `send_typing`.
 *   • HTTP server (127.0.0.1:<ephemeral>) — receives `/message` injections from
 *     the substrate; reports its bound port back via `/channel-ready`.
 *
 * Flow:
 *   substrate → POST channelPort/message {text,turn_id} → mcp.notification → CC turn
 *   CC → reply(text) tool → POST SINK/reply {session_id,text,turn_id} → completion Event
 *
 * TURN-ID CORRELATION (S3 #107 — stateless turn-id-echo; replaces the FIFO):
 * each `/message` carries a per-turn `turn_id`. The reply that answers it ECHOES
 * that id back, so the dev-channel holds NO cross-call positional queue whose
 * order can desync (the FIFO's fragility — "off-by-one forever" — is structurally
 * gone). Two echo mechanisms, both stateless:
 *
 *   (Primary, MCP-meta round-trip) the originating message's `meta.turn_id` is
 *   echoed on the `reply` tool-call context (`req.params._meta.turn_id`); read it
 *   directly off the in-flight tool call. Zero stored state. UNVERIFIED against a
 *   live REPL until the channel contract is proven to surface it — so it is the
 *   PREFERRED-when-present path, not the sole path.
 *
 *   (Guaranteed fallback) a single `currentTurnId` scalar: written on `/message`,
 *   read-and-cleared on `reply`, OVERWRITTEN every turn. Safe because the
 *   substrate serializes injects (`acquireTurn` — one turn in flight per session)
 *   AND the Stop hook enforces exactly one reply per message, so there is never
 *   more than one un-replied message. A missed reply is reset by the next inject;
 *   it cannot accumulate, so the FIFO's "off-by-one forever" class is impossible.
 *   This is NOT a positional queue.
 *
 * The substrate's `onReply` still accepts a reply ONLY when its `turn_id` equals
 * the in-flight turn's `<incarnation>:<seq>` — kept as defense-in-depth so a
 * mis-echo is REJECTED (warned, never silent-dropped), never misattributed.
 * `turn_id` is opaque here; we only round-trip it.
 *
 * Env (set by the substrate in the generated `--mcp-config`):
 *   SINK_PORT     — the substrate's reply-sink HTTP port
 *   SINK_TOKEN    — shared secret for sink POSTs
 *   SESSION_ID    — routes replies to the right in-flight turn
 *   CHANNEL_NAME  — echoed in /health (port-recycle guard, Nova invariant)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { TurnIdEcho } from './turn-id-echo.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

const SINK_PORT = parseInt(process.env['SINK_PORT'] || '0', 10)
const SINK_TOKEN = process.env['SINK_TOKEN'] || ''
const SESSION_ID = process.env['SESSION_ID'] || ''
const CHANNEL_NAME = process.env['CHANNEL_NAME'] || ''

/** S3 #107 — stateless reply correlation (the shared-mutable FIFO is gone): a
 *  reset-per-turn scalar + a stale-reply debt counter, NOT a positional id-queue.
 *  Logic + rationale (incl. the Codex-r1-P1 abandoned-turn fix) live in the
 *  unit-tested `TurnIdEcho`. */
const turnEcho = new TurnIdEcho()

/** Primary echo path (S3 #107): pull the originating message's `turn_id` off the
 *  reply tool-call's `_meta` if the channel runtime surfaces it. Returns undefined
 *  when absent (→ the `currentTurnId` scalar fallback). Defensive about the shape
 *  (`_meta.turn_id` or a nested `_meta.meta.turn_id`) since the contract is
 *  UNVERIFIED against a live REPL. */
function readMetaTurnId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const meta = (params as { _meta?: unknown })._meta
  if (typeof meta !== 'object' || meta === null) return undefined
  const direct = (meta as { turn_id?: unknown }).turn_id
  if (typeof direct === 'string' && direct.length > 0) return direct
  const nested = (meta as { meta?: { turn_id?: unknown } }).meta
  if (nested !== undefined && typeof nested === 'object' && nested !== null) {
    const t = (nested as { turn_id?: unknown }).turn_id
    if (typeof t === 'string' && t.length > 0) return t
  }
  return undefined
}

// --- MCP Server (stdio transport, talks to Claude Code) ---

const mcp = new Server(
  { name: 'neutron-channel', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: [
      'This is a Neutron session channel. User turns arrive as <channel> messages.',
      '',
      '=== CRITICAL: THE REPLY TOOL IS THE ONLY WAY TO RETURN YOUR RESPONSE ===',
      '',
      'You are running headless. Terminal output is INVISIBLE — it is never read.',
      'The ONLY way to return your response is the reply() tool. There is no other path.',
      'Every turn triggered by a <channel> message MUST end with exactly one reply() call,',
      'carrying your COMPLETE response as the `text` argument.',
      'This applies on EVERY turn — including follow-ups, confirmations, and short replies.',
      'A Stop hook will block turn termination if you end without calling reply().',
      '',
      'Tools:',
      'reply: Return your complete response for the current turn. Call it exactly once.',
      'send_typing: Optionally signal that a long operation is in progress.',
    ].join('\n'),
  },
)

// --- Tools ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Return your complete response for the current turn. Call this exactly once per turn with your full answer as `text`.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Your complete response for this turn.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'send_typing',
      description: 'Signal that a long operation is in progress (optional, non-terminal).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        // Coalesce the reply body across the param names agents actually use.
        // The tool def is `reply(text:…)`, but an agent that calls
        // `reply(message:…)` / `reply(content:…)` / `reply(body:…)` would
        // otherwise read undefined → post an EMPTY turn silently (ported Vajra
        // fix #153 / f99bfd9 — verified still present here). Accept the common
        // aliases; reject an all-empty call with `isError` so the agent sees the
        // failure instead of the user getting a blank message.
        const pickStr = (v: unknown): string | undefined =>
          typeof v === 'string' && v.trim() !== '' ? v : undefined
        const text =
          pickStr(args['text']) ??
          pickStr(args['message']) ??
          pickStr(args['content']) ??
          pickStr(args['body'])
        if (text === undefined) {
          process.stderr.write(
            'neutron-channel: reply called with no non-empty body (text/message/content/body all missing or blank)\n',
          )
          return {
            content: [
              {
                type: 'text',
                text: 'error: reply requires a non-empty `text` (also accepts message/content/body)',
              },
            ],
            isError: true,
          }
        }
        // S3 #107 — stateless turn-id-echo (see header). Primary: the originating
        // message's `meta.turn_id` echoed on the reply tool-call context. Fallback:
        // the reset-per-turn `currentTurnId` scalar (read-and-clear so a second
        // spurious reply for the same turn gets NO id and the substrate rejects it —
        // no silent drop). On a missing echo we warn + omit `turn_id`; the
        // substrate's `<incarnation>:<seq>` check then rejects, never misattributes.
        // Correlate via `TurnIdEcho` — primary `_meta.turn_id` echo when surfaced,
        // else the reset-per-turn scalar with the abandoned-turn debt skip (Codex
        // r1 P1). `undefined` ⇒ no turn_id attached ⇒ the substrate rejects.
        const turnId = turnEcho.onReply(readMetaTurnId(req.params))
        if (turnId === undefined) {
          process.stderr.write(
            'neutron-channel: reply with no echoed/pending turn-id (unmatched/stale); substrate will reject\n',
          )
        }
        const replyBody: Record<string, unknown> = { session_id: SESSION_ID, text }
        if (turnId !== undefined) replyBody['turn_id'] = turnId
        await postToSink('/reply', replyBody)
        return { content: [{ type: 'text', text: 'delivered' }] }
      }
      case 'send_typing': {
        await postToSink('/typing', { session_id: SESSION_ID })
        return { content: [{ type: 'text', text: 'typing' }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }] }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`neutron-channel: tool ${req.params.name} failed: ${msg}\n`)
    return { content: [{ type: 'text', text: `error: ${msg}` }] }
  }
})

// --- HTTP Server (receives injections from the substrate) ---

const httpServer = Bun.serve({
  port: 0, // ephemeral; reported back via /channel-ready
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)

    // Health — no auth. Echoes CHANNEL_NAME so the substrate can verify a
    // port-recycle didn't misattribute liveness to the wrong session.
    if (url.pathname === '/health') {
      return Response.json({ ok: true, session_id: SESSION_ID, channel: CHANNEL_NAME })
    }

    // Auth for POST endpoints.
    if (req.method === 'POST' && SINK_TOKEN) {
      const token = req.headers.get('X-Sink-Token')
      if (token !== SINK_TOKEN) {
        return Response.json({ status: 'unauthorized' }, { status: 401 })
      }
    }

    // Inbound user turn → inject into the CC session as a <channel> message.
    if (req.method === 'POST' && url.pathname === '/message') {
      try {
        const body = (await req.json()) as {
          text: string
          turn_id?: string
          meta?: Record<string, string>
        }
        // Carry the turn_id in the notification `meta` so the PRIMARY echo path
        // (the reply tool reading `_meta.turn_id`) has it; the substrate also
        // injects it explicitly (`/message {turn_id}`) for the scalar fallback.
        const meta: Record<string, string> = body.meta
          ? { ...body.meta }
          : { session_id: SESSION_ID, user: 'neutron' }
        if (typeof body.turn_id === 'string') meta['turn_id'] = body.turn_id
        const notify = (): Promise<unknown> =>
          mcp.notification({
            method: 'notifications/claude/channel',
            params: { content: body.text, meta },
          })
        // S3 #107 — set the reset-per-turn scalar ONLY AFTER the notification
        // resolves: if it throws, the catch below returns 500 and the scalar is
        // left untouched, and since it is overwritten every turn (not a queue) a
        // single MCP hiccup cannot desync later replies. No turn_id ⇒ plain notify
        // (no correlation) and the scalar is cleared.
        await notify()
        // Record the injected turn AFTER the notify resolves (poison-free). A prior
        // un-replied (abandoned) turn banks one unit of stale-reply debt inside
        // `onInject` so its in-order late reply is skipped, not mis-tagged.
        turnEcho.onInject(typeof body.turn_id === 'string' ? body.turn_id : undefined)
        return Response.json({ status: 'delivered' })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        process.stderr.write(`neutron-channel: message delivery failed: ${msg}\n`)
        return Response.json({ status: 'error', error: msg }, { status: 500 })
      }
    }

    // System inject (notice turn — exempt from the reply requirement).
    if (req.method === 'POST' && url.pathname === '/system') {
      try {
        const body = (await req.json()) as { text: string }
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: body.text,
            meta: { session_id: SESSION_ID, user: 'neutron', system: 'notice' },
          },
        })
        return Response.json({ status: 'delivered' })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return Response.json({ status: 'error', error: msg }, { status: 500 })
      }
    }

    return new Response('not found', { status: 404 })
  },
})

process.stderr.write(`neutron-channel: HTTP on port ${httpServer.port}, sink at ${SINK_PORT}\n`)

// --- Helper: POST to the substrate reply-sink ---

async function postToSink(path: string, body: Record<string, unknown>): Promise<string> {
  const maxRetries = 3
  const url = `http://127.0.0.1:${SINK_PORT}${path}`
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(SINK_TOKEN ? { 'X-Sink-Token': SINK_TOKEN } : {}),
        },
        body: JSON.stringify(body),
      })
      return await resp.text()
    } catch (e) {
      process.stderr.write(`neutron-channel: POST ${path} FAILED (attempt ${attempt}): ${e}\n`)
      if (attempt === maxRetries) throw e
      await new Promise((r) => setTimeout(r, attempt * 1000))
    }
  }
  throw new Error('unreachable')
}

// --- Graceful shutdown ---

function shutdownChannel(reason: string): void {
  process.stderr.write(`neutron-channel: shutting down (${reason})\n`)
  try {
    httpServer.stop()
  } catch {
    // best-effort
  }
  process.exit(0)
}

process.on('SIGTERM', () => shutdownChannel('SIGTERM'))
process.on('SIGINT', () => shutdownChannel('SIGINT'))

// --- Connect MCP transport, then announce readiness to the sink ---

// TRUE-BIND SIGNAL (P0 channel-wedged false-positive fix): claude 2.1.186
// ALWAYS renders `server:<name> · no MCP server configured with that name` in
// the dev-channel TUI header for an `--mcp-config`-provided channel server, even
// when the channel is fully wired and `reply()` works (verified live under the
// PTY harness). So that TUI string is NOT a wedge signal — gating on it (the now-
// removed PTY-ring "no MCP server configured" scan) false-failed EVERY spawn. The
// only reliable proof that claude actually wired this MCP server is the handshake:
// claude sends `initialize`, we answer, claude sends `notifications/initialized`.
// The SDK fires `oninitialized` on that notification — so we POST `/channel-bound`
// to the sink THEN, giving the post-spawn assertion a real readiness gate. A
// genuine no-bind wedge never reaches `initialized`, so `/channel-bound` never
// fires and the assertion still fast-fails (real wedges stay covered).
mcp.oninitialized = () => {
  fireAndForget('dev-channel.postToSink', postToSink('/channel-bound', { session_id: SESSION_ID, pid: process.pid }).catch((e) => {
    process.stderr.write(`neutron-channel: channel-bound announce failed: ${e}\n`)
    throw e // re-raise so fireAndForget counts it (the .catch only adds context)
  }))
  process.stderr.write('neutron-channel: MCP handshake complete (initialized)\n')
}

const transport = new StdioServerTransport()
await mcp.connect(transport)
process.stderr.write('neutron-channel: MCP connected\n')

// ISSUES #217 — exit when the MCP stdio transport closes. The transport's
// stdin/stdout pipes go to the spawning `claude` REPL; when that parent
// dies (wedge-respawn kill, PTY hangup on gateway exit, crash) the stdio
// stream ends — but the loopback HTTP server above would keep this bun
// process alive FOREVER. That was the dominant prod leak class: 132
// ppid=1 dev-channel orphans accumulated in ~100 min of respawn churn
// alone (632 total / ~19 GB across releases on 2026-06-11). A bridge
// whose claude is gone can never serve a turn again — the substrate
// always spawns a FRESH dev-channel per REPL incarnation — so exit is
// unconditionally correct. Both hooks fire-once via the exit() inside:
// `onclose` is the SDK-level signal; the stdin 'end'/'close' listeners
// are belt-and-suspenders for transports torn down without onclose.
mcp.onclose = () => shutdownChannel('mcp transport closed')
process.stdin.on('end', () => shutdownChannel('stdin EOF (parent gone)'))
process.stdin.on('close', () => shutdownChannel('stdin closed (parent gone)'))

// Race-free handshake: tell the substrate which port we bound. This doubles
// as the post-spawn "dev-channel up + MCP handshake seen" assertion signal.
try {
  await postToSink('/channel-ready', {
    session_id: SESSION_ID,
    channel_port: httpServer.port,
    pid: process.pid,
  })
} catch (e) {
  process.stderr.write(`neutron-channel: channel-ready announce failed: ${e}\n`)
}
