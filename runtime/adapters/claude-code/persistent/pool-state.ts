/**
 * Pool-runtime state — the per-process mutable singletons behind the
 * persistent-REPL substrate pool (world-class-refactor plan § D1).
 *
 * `persistent-repl-substrate.ts` holds the pool's LOGIC; this module holds its
 * STATE, extracted verbatim so the D2 split modules can all share it. Every
 * declaration here is semantically ONE per-process pool runtime — the object
 * identities and lifetimes are exactly what they were when these lived inline
 * in the substrate module (the substrate imports them back, so every existing
 * reader/writer mutates the SAME instances).
 *
 * Runtime imports here are leaf-only (node builtins + sibling leaf modules).
 * `ReplSession` / `ReplWatchdog` / `PersistentReplSubstrateOptions` are
 * imported TYPE-ONLY from the substrate module: those imports are erased at
 * compile time, so the emitted module graph has no cycle — this module stays a
 * leaf the substrate (and later the D2 splits) depend on.
 *
 * The one mutable-primitive global (`replToolBridge`, a `let` reassigned by
 * `setReplToolBridge`/`clearReplToolBridgeIf` in the substrate module) crosses
 * the module boundary as the `replToolBridgeRef` holder object: a bare `let`
 * cannot be reassigned from another module, so reassignments go through
 * `.current` (the `prewarmSettledRef` pattern from `open/wiring/substrates.ts`).
 */

import { randomBytes } from 'node:crypto'

import type { PtyChild } from './pty-host.ts'
import type { InFlightGate } from './in-flight-gate.ts'
import type { ModelUpdateWatchdog } from './model-update-watchdog.ts'
import type {
  ReplSession,
  ReplWatchdog,
  PersistentReplSubstrateOptions,
} from './persistent-repl-substrate.ts'

export const REPL_DEBUG = process.env['NEUTRON_REPL_DEBUG'] === '1'

// ---------------------------------------------------------------------------
// P0-1 native-MCP tool bridge — late-bound dispatcher.
//
// The spawned `claude`'s tools-bridge POSTs tool calls to the reply sink, which
// forwards them to this `ReplToolBridge`. The bridge IS the gateway's in-process
// `McpServer` (it satisfies `listToolSchemas` + `dispatch`). It is set LATE —
// the substrate is built in the composer BEFORE `composeProductionGraph` builds
// the `McpServer` + registers the Cores/doc-search/etc. — so the module holds a
// mutable singleton wired by `composeProductionGraph` once the graph exists. A
// turn dispatched before it is set (or on an LLM-less box that never composes
// the graph) simply sees no Neutron tools (fail-soft).
// ---------------------------------------------------------------------------

export interface ReplToolBridge {
  /** Discovery half — the per-session tools manifest the bridge advertises. */
  listToolSchemas(): { name: string; description: string; input_schema: unknown }[]
  /** Invocation half — dispatch a tool call against the in-process registry.
   *  `project_id` carries the active project of the session that made the call
   *  (the warm REPL is keyed per-project, so the sink resolves it from the
   *  originating `ReplSession`) — the `McpServer` binds it into the tool's
   *  `ToolCallContext.project_id` so a per-project tool scopes to the right board. */
  dispatch(input: {
    tool_name: string
    args: unknown
    call_id: string
    project_id?: string | null
  }): Promise<unknown>
}

/** Holder for the mutable `replToolBridge` singleton. Written ONLY by the
 *  substrate module's `setReplToolBridge`/`clearReplToolBridgeIf`; read by the
 *  sink's `/tools` + `/tool-call` routes and the spawn-time bridge attach. */
export const replToolBridgeRef: { current: ReplToolBridge | undefined } = {
  current: undefined,
}

// ---------------------------------------------------------------------------
// Reply sink — one loopback HTTP server the dev-channels POST back to.
// Module singleton so it is shared across every per-turn substrate instance.
// ---------------------------------------------------------------------------

class ReplSink {
  private server: ReturnType<typeof Bun.serve> | undefined
  readonly token: string = randomBytes(24).toString('hex')
  private readonly sessions = new Map<string, ReplSession>()

  ensureStarted(): void {
    if (this.server !== undefined) return
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => this.handle(req),
    })
  }

  get port(): number {
    if (this.server === undefined) throw new Error('repl-sink: not started')
    const p = this.server.port
    if (p === undefined) throw new Error('repl-sink: server has no bound port')
    return p
  }

  register(sessionId: string, session: ReplSession): void {
    this.sessions.set(sessionId, session)
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Identity-guarded unregister: only drop the mapping if it STILL points at
   *  `session`. A respawn re-attaches the SAME sessionId via `--resume`, so the
   *  dying OLD child's death handler must not evict the NEW session that already
   *  re-registered under that id (the resume race the P2-3 regression caught). */
  unregisterIf(sessionId: string, session: ReplSession): void {
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (req.method === 'POST') {
      const token = req.headers.get('X-Sink-Token')
      if (token !== this.token) {
        return Response.json({ status: 'unauthorized' }, { status: 401 })
      }
      let body: Record<string, unknown> = {}
      try {
        body = (await req.json()) as Record<string, unknown>
      } catch {
        return Response.json({ status: 'bad-json' }, { status: 400 })
      }
      const sessionId = typeof body['session_id'] === 'string' ? (body['session_id'] as string) : ''
      if (REPL_DEBUG) {
        process.stderr.write(`[repl-sink] ${url.pathname} session=${sessionId.slice(0, 8)} active=${this.sessions.get(sessionId)?.activeTurn !== undefined}\n`)
      }
      // P0-1 native-MCP tool bridge — these two routes are dispatched against the
      // process-global `ReplToolBridge` (the gateway's in-process `McpServer`),
      // NOT a per-session driver, so they are handled BEFORE the session lookup
      // (a tool call carries no in-flight turn). Token-gated like every sink POST.
      //
      // TOPIC CONTEXT (Codex r1 [P2]): `McpServer.dispatch` resolves `project_slug`
      // from its own instance slug (correct for every project/owner-scoped tool —
      // doc_search, reminders, cal, email, note, research, skill_forge,
      // dispatch_agent, project_*), but binds `topic_id: null` because the warm
      // substrate is topic-AGNOSTIC by design (one REPL multiplexes topics over
      // the dev-channel; the locked `AgentSpec` carries no per-turn topic). The
      // ONLY tool that wants the originating topic is `message_search`'s
      // current-conversation default — and Open's per-topic `HistorySource`
      // runtime can't search globally anyway, so an agent-initiated
      // `message_search` returns []. Binding the live turn's topic into this
      // dispatch (so `message_search` scopes to the active conversation) needs
      // per-turn topic threading through the turn lifecycle — a follow-up beyond
      // P0-1's transport. The agent can still recall via `doc_search`. See
      // docs/research/AS-BUILT-archive-2026-07.md "P0-1 known follow-up".
      if (url.pathname === '/tools') {
        return Response.json({ tools: replToolBridgeRef.current?.listToolSchemas() ?? [] })
      }
      if (url.pathname === '/tool-call') {
        const bridge = replToolBridgeRef.current
        if (bridge === undefined) {
          return Response.json({ ok: false, error: 'no tool bridge wired' }, { status: 503 })
        }
        const toolName = typeof body['tool_name'] === 'string' ? (body['tool_name'] as string) : ''
        const callId =
          typeof body['call_id'] === 'string' ? (body['call_id'] as string) : sessionId || 'tool'
        if (toolName === '') {
          return Response.json({ ok: false, error: 'tool_name required' }, { status: 400 })
        }
        // ACTIVE-PROJECT SCOPE: the warm REPL is topic-agnostic (no bound
        // `TopicContext`), so `McpServer.dispatch` would otherwise resolve every
        // work-board write to the owner/instance slug (the General board). The
        // pool is keyed per-project, so THIS session serves exactly one project
        // scope — thread it in so a per-project tool (`work_board_*`, the trident
        // build-dispatch tools) scopes to the composing turn's project. A miss
        // (unregistered session / General scope) degrades to the owner slug =
        // General, the prior behaviour.
        const toolProjectId = this.sessions.get(sessionId)?.projectId ?? null
        try {
          const result = await bridge.dispatch({
            tool_name: toolName,
            args: body['args'] ?? {},
            call_id: callId,
            project_id: toolProjectId,
          })
          return Response.json({ ok: true, result })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          // A tool error is a NORMAL outcome the agent should see + recover from
          // (unknown tool, capability denied, handler threw) — 200 with ok:false
          // so the bridge returns it as a `tool_result` isError, not an HTTP fault.
          return Response.json({ ok: false, error: msg })
        }
      }
      const session = this.sessions.get(sessionId)
      if (session === undefined) {
        return Response.json({ status: 'no-session' }, { status: 404 })
      }
      if (url.pathname === '/channel-ready') {
        const port = typeof body['channel_port'] === 'number' ? (body['channel_port'] as number) : 0
        session.onChannelReady(port)
        return Response.json({ status: 'ok' })
      }
      if (url.pathname === '/channel-bound') {
        // True MCP-handshake-complete signal (dev-channel `mcp.oninitialized`):
        // the post-spawn assertion Stage 4 gates the first inject on this.
        session.onChannelBound()
        return Response.json({ status: 'ok' })
      }
      if (url.pathname === '/reply') {
        const text = typeof body['text'] === 'string' ? (body['text'] as string) : ''
        const turnId = typeof body['turn_id'] === 'string' ? (body['turn_id'] as string) : undefined
        session.onReply(text, turnId)
        return Response.json({ status: 'ok' })
      }
      if (url.pathname === '/typing') {
        session.onTyping()
        return Response.json({ status: 'ok' })
      }
    }
    return new Response('not found', { status: 404 })
  }
}

export const sink = new ReplSink()

// ---------------------------------------------------------------------------
// Warm-REPL pool + supervision state.
// ---------------------------------------------------------------------------

export const pool = new Map<string, Promise<ReplSession>>()

/** Synchronous mirror of the warm child handle per pool key. The pool stores a
 *  `Promise<ReplSession>`, so a respawn cannot read the live child out of it
 *  synchronously to decide "is this an alive-but-wedged respawn?". This map lets
 *  `killChild` make that decision without awaiting (Argus r3 BLOCKER 1). Always
 *  overwritten by the newest spawn for the key; deleted on death/kill. */
export const childByKey = new Map<string, PtyChild>()

/** Live disposable one-shot sessions that are NOT in `pool` (the ephemeral path).
 *  Tracked so `shutdownAllPersistentRepls` can terminate in-flight one-shots —
 *  the pool teardown loop only walks `pool`, so without this an ephemeral child
 *  mid-turn at shutdown would orphan (Argus r5 IMPORTANT). Added on spawn,
 *  removed on dispose. */
export const ephemeralSessions = new Set<ReplSession>()

/** Per-key pending graceful-kill promise. Set by `killChild` when it SIGTERMs an
 *  alive-but-wedged child; awaited by `spawnResume` so the `--resume` replacement
 *  is not spawned until the old process has fully exited (one owner per session
 *  transcript). Cleared when consumed. */
export const pendingChildKills = new Map<string, Promise<void>>()

/** Live per-registry watchdog handles. Tracked so shutdown stops their
 *  interval + heartbeat timers (Codex P2 — leaked timers keep the Bun event loop
 *  alive after the gateway/test stops). Populated + cleaned by `startReplWatchdog`. */
export const activeWatchdogs = new Map<string, ReplWatchdog>()

/** Live per-instance model-update watchdog handles (Vajra port row #16), keyed by
 *  the model-update state path. Tracked so shutdown stops the 6h-gated cadence
 *  tick. Populated + cleaned by `startModelUpdateWatchdogForInstance`. */
export const activeModelWatchdogs = new Map<string, ModelUpdateWatchdog>()

/** Live supervised-substrate options keyed by the EXACT pool key (`poolKeyFor`)
 *  — NOT by `replRegistryPath`. One instance registry is shared by multiple
 *  substrates (`cc-llm-*`, `cc-llm-router-*`, `cc-import-*`) whose `env` /
 *  `substrate_instance_id` / spawn options differ; keying by registry path alone
 *  would force-respawn any session in that registry with whichever substrate
 *  registered LAST → wrong credentials/identity (Codex P2). Keying by the pool
 *  key means a respawn always uses the options of the substrate that owns that
 *  exact session. */
export const supervisedBySessionKey = new Map<string, PersistentReplSubstrateOptions>()

/** Per-`sessionKey` process-local respawn mutex — composes with the registry
 *  flock (cross-process) to guarantee no double-spawn (brief § 6 acceptance #3). */
export const respawnGates = new Map<string, InFlightGate>()
/** Per-key last-alert timestamp for the wedge-alert dedupe window. */
export const wedgeAlertState = new Map<string, number>()
/** Per-`sessionKey` last cwd-drift respawn timestamp — the 1h throttle anchor for
 *  the cwd-drift watchdog (separate from the wedge cooldown so a wedge respawn and
 *  a cwd-drift respawn don't share a clock). */
export const cwdDriftRespawnState = new Map<string, number>()
/** Edge-latch for the cwd-drift missing-canonical alert: session keys currently
 *  alerting, so a persistently-missing canonical alerts ONCE (not every tick). */
export const cwdDriftAlertState = new Set<string>()
