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

import {
  defaultSinkTokenPath,
  deriveChildSinkToken,
  loadOrCreateSinkToken,
  resolveSinkPort,
} from './sink-coordinates.ts'
import { dirname } from 'node:path'
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

/**
 * Late-bound TodoWrite→Work Board reconciler. Written ONLY by the substrate
 * module's `setReplTodoSync`/`clearReplTodoSyncIf` (wired by `composeProductionGraph`,
 * which holds the shared `WorkBoardStore` + owner slug); read by the sink's
 * `/todo-sync` route. The `todos` payload is passed through UNTYPED (the raw JSON
 * array from the hook POST) so this runtime module stays free of any work-board
 * import — the composer-side closure validates + reconciles. Undefined on an
 * LLM-less / board-less boot → the `/todo-sync` route no-ops (503). */
export const todoSyncRef: {
  current:
    | ((input: { project_id: string | null; todos: unknown }) => Promise<void>)
    | undefined
} = { current: undefined }

/**
 * Late-bound ACTIVITY INSPECTOR tool tap. Written ONLY by the substrate module's
 * `setReplActivityTap`/`clearReplActivityTapIf` (wired by
 * `composeProductionGraph`, which holds the in-memory inspector buffer + the
 * app-ws fan); read by the sink's `/activity` route, which the Pre/PostToolUse
 * `activity-tap.ts` hook POSTs to.
 *
 * Mirrors `todoSyncRef` exactly, and for the same reason: the hook runs in a
 * DIFFERENT process from the gateway, so the loopback sink is the only seam, and
 * this runtime module must not import the Open-band inspector store. Undefined on
 * an LLM-less boot → the `/activity` route no-ops (503), and the panel simply
 * shows no tool rows. SYNCHRONOUS + void: recording into a bounded in-memory ring
 * cannot fail or block, and the hook POST must return fast enough that it never
 * shows up as latency on the agent's tool call.
 */
export const activityTapRef: {
  current:
    | ((input: {
        project_id: string | null
        phase: 'pre' | 'post'
        tool_name: string
        detail: string
      }) => void)
    | undefined
} = { current: undefined }

// ---------------------------------------------------------------------------
// Reply sink — one loopback HTTP server the dev-channels POST back to.
// Module singleton so it is shared across every per-turn substrate instance.
// ---------------------------------------------------------------------------

/** Is this bind failure "someone already holds the port"? Bun surfaces it as an
 *  `Error` with `code: 'EADDRINUSE'` and the message `Failed to start server. Is
 *  port N in use?` (verified against the runtime this repo pins); the message
 *  match is the belt-and-suspenders half in case only the text survives. */
function isAddressInUse(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE') return true
  const msg = e instanceof Error ? e.message : ''
  return /EADDRINUSE|address (already )?in use|is port \d+ in use/i.test(msg)
}

/** How the sink is told where to bind and where its token lives. Every field is
 *  optional: an unconfigured sink DERIVES its port from its state dir
 *  (`deriveSinkPort`) and uses the default token path (`sink-coordinates.ts`). It is
 *  not a fixed port — that is the whole point of per-instance coordinates. Production wires both from the substrate options
 *  (`spawn.ts` → `PersistentReplSubstrateOptions.sinkPort`/`sinkTokenPath`). */
export interface ReplSinkConfig {
  /** Loopback port to bind. Goes through `resolveSinkPort` like every other
   *  source; omitted ⇒ the WIRED override if one is installed, else the port DERIVED
   *  from the token path's state dir. "Wired", not environment: `resolveSinkPort`
   *  reads `sinkPortOverrideRef`, which the boot path sets — it does not read
   *  `process.env` itself, and that replacement was deliberate. A `0` is REFUSED,
   *  not honoured — see that function. */
  port?: number
  /** Path of the persisted 0600 token file. Default `defaultSinkTokenPath()`. */
  tokenPath?: string
  /** Bind attempts before failing loudly. Default `SINK_BIND_ATTEMPTS`. */
  bindAttempts?: number
  /** Delay between bind attempts (ms). Default `SINK_BIND_RETRY_DELAY_MS`. */
  bindRetryDelayMs?: number
}

/**
 * Bind budget for the one case that matters: a gateway restarting while the
 * previous process still holds the port for a few hundred milliseconds.
 *
 * The wait is `await Bun.sleep`, the MECHANISM `persistence/retry.ts` requires,
 * not a blocking one. An earlier revision used `Bun.sleepSync` and argued the rule
 * was satisfied "by budget, once, at sink start, because making `ensureStarted`
 * async would ripple through ~30 call sites". A reviewer measured all three claims
 * false: the early return only fires once the server is BOUND, so a failing bind
 * re-ran the whole budget on every call — 603/602/601/601 ms across four calls,
 * once per turn attempt, against a rule that caps the BLOCKING window at 100 ms
 * per attempt; and `ensureStarted` had exactly TWO call sites (`spawn.ts`, already
 * inside an async function, and the test-only `getReplSinkInfo`), the ~30 being
 * `getReplSinkInfo`'s own callers, every one of them in an async body or at ESM
 * top level. It would also have been the tree's first production `Bun.sleepSync`.
 * So the cost of doing it properly was one `await` per call site.
 */
export const SINK_BIND_ATTEMPTS = 5
export const SINK_BIND_RETRY_DELAY_MS = 150

export class ReplSink {
  private server: ReturnType<typeof Bun.serve> | undefined
  /** The start currently in flight, shared by every concurrent `ensureStarted`
   *  caller (see that method's contract). Undefined when no start is running. */
  private startup: Promise<void> | undefined
  private boundPort: number | undefined
  private tokenValue: string | undefined
  private tokenPathValue: string | undefined
  private readonly sessions = new Map<string, ReplSession>()

  /** Includes booting sessions, which have not yet resolved their pool promise. */
  registeredSessions(): readonly ReplSession[] { return [...this.sessions.values()] }
  /** THE AUTHORIZATION INDEX: the credential a child presents → the session it IS.
   *  Keyed by `deriveChildSinkToken(rootToken, childGeneration)`, so a lookup answers
   *  "whose call is this", which a `session_id` lookup cannot (see `handle`). */
  private readonly byCredential = new Map<string, ReplSession>()
  /** Divergences already reported by `reportLateConfig`, so the warning is one line
   *  per distinct value rather than one per spawn. */
  private readonly reportedLateConfig = new Set<string>()

  /**
   * The token every dev-channel authenticates with, loaded from disk on first
   * read and created 0600 on first use (ISSUES #537 — it used to be a fresh
   * `randomBytes(24)` per process, which is why a restarted gateway could not be
   * reached by a REPL that outlived it). Lazily loaded rather than loaded in the
   * constructor because the module singleton is constructed at IMPORT time,
   * before any caller has said which instance state dir it belongs to.
   *
   * The full security reasoning for persisting it — and the exposure window that
   * persistence deliberately widens — is in `sink-coordinates.ts`'s header.
   */
  get token(): string {
    if (this.tokenValue === undefined) {
      this.tokenPathValue ??= defaultSinkTokenPath()
      this.tokenValue = loadOrCreateSinkToken(this.tokenPathValue)
    }
    return this.tokenValue
  }

  /** The token file this sink read (or created). Undefined until the token is
   *  first resolved. */
  get tokenPath(): string | undefined {
    return this.tokenPathValue
  }

  /**
   * Start the sink (idempotent): resolve the coordinates, then bind.
   *
   * ASYNC because the bind retries, and a retry wait must not block the event
   * loop — see the budget constants above. Two call sites: `spawnSession` and the
   * test-only `getReplSinkInfo`.
   *
   * CONCURRENT CALLERS SHARE ONE ATTEMPT. This is a window the synchronous version
   * did not have and the async fix opened: `Bun.sleepSync` never yielded, so no
   * second caller could interleave, whereas `await Bun.sleep` lets two
   * `spawnSession`s sit in the retry loop together. If both retried independently,
   * the moment one of them BOUND the port the other's next attempt would see ITS
   * OWN process's healthy listener as EADDRINUSE, exhaust its budget and reject —
   * reporting the fatal, non-retryable `channel_wedged` while the singleton sink is
   * perfectly fine. So the first caller runs the start and every concurrent caller
   * awaits THAT promise: the same shape `pool.ts` uses for `Promise<ReplSession>`
   * and `pendingChildKills` (store the in-flight promise, let the others await it),
   * rather than the boolean `InFlightGate`, whose loser SKIPS — a caller that
   * skipped would return with no sink started, which is the opposite of what it
   * asked for.
   *
   * With startup serialised this way, `this.server` cannot become set while the
   * retry loop is between attempts, so the loop needs no re-check: nothing else in
   * the process can bind it. (A re-check would be a branch no test could reach,
   * which this file's other comments are careful not to pretend is a guard.)
   */
  async ensureStarted(config: ReplSinkConfig = {}): Promise<void> {
    if (this.server !== undefined) {
      this.reportLateConfig(config)
      return
    }
    const inFlight = this.startup
    if (inFlight !== undefined) {
      // Adopt the outcome of the start already running: its success is ours, and so
      // is its failure (we wanted a started sink; there is not one).
      await inFlight
      this.reportLateConfig(config)
      return
    }
    const attempt = this.startOnce(config)
    // Assigned BEFORE the first await below, so a caller arriving in this same tick
    // sees it. Cleared in `finally` so a failed start never latches the sink shut.
    this.startup = attempt
    try {
      await attempt
    } finally {
      this.startup = undefined
    }
  }

  private async startOnce(config: ReplSinkConfig): Promise<void> {
    // IDENTITY FIRST — which instance's state dir do these coordinates belong to?
    // Both coordinates come from it: the token is the file in it, and the port is
    // derived from it (`deriveSinkPort`), which is what makes the port per-instance
    // rather than per-box.
    if (config.tokenPath !== undefined && config.tokenPath !== this.tokenPathValue) {
      if (this.tokenValue === undefined) this.tokenPathValue = config.tokenPath
      else this.reportLateConfig(config)
    }
    this.tokenPathValue ??= defaultSinkTokenPath()
    // THE PORT IS RESOLVED AND VALIDATED NEXT, through the ONE chokepoint that sees
    // every configuration source (the `sinkPort` option, `NEUTRON_REPL_SINK_PORT`,
    // and the per-instance derivation). Before the token and before the socket: an
    // unusable value — above all a `0`, which asks the kernel for an ephemeral port
    // and so cannot be reproduced by the next gateway — must fail with NOTHING
    // observable done yet, no token file created and no port bound.
    const port = resolveSinkPort({
      ...(config.port !== undefined ? { explicit: config.port } : {}),
      stateDir: dirname(this.tokenPathValue),
    })
    // Resolve the token BEFORE binding so an unusable token file fails before the
    // port is occupied, and so `this.server !== undefined` always means "fully
    // started". The debug line reports the token's PATH and LENGTH, never the
    // token — a secret this durable does not belong in a log.
    const token = this.token
    if (REPL_DEBUG) {
      process.stderr.write(
        `[repl-sink] port ${port} + token from ${this.tokenPathValue} (${token.length} chars)\n`,
      )
    }
    const attempts = config.bindAttempts ?? SINK_BIND_ATTEMPTS
    const delayMs = config.bindRetryDelayMs ?? SINK_BIND_RETRY_DELAY_MS
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const server = Bun.serve({
          port,
          hostname: '127.0.0.1',
          fetch: async (req) => this.handle(req),
        })
        this.server = server
        // Read the bound port ONCE, here: `Bun.serve`'s `.port` reverts to 0 once
        // the server is stopped, so a getter that read it live would report 0 for
        // a stopped sink instead of the coordinate the children were baked with.
        this.boundPort = server.port ?? port
        return
      } catch (e) {
        lastError = e
        if (!isAddressInUse(e)) break
        // THE BUG THIS MUST NOT REINTRODUCE: falling back to `port: 0` here would
        // "work", invisibly, and every child spawned afterwards would be baked
        // with a coordinate that the next restart cannot reproduce — exactly the
        // failure #537 exists to close. So the only outcomes are the resolved port
        // or a loud throw.
        if (attempt < attempts) await Bun.sleep(delayMs)
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(
      `repl-sink: could not bind the reply sink on 127.0.0.1:${port} after ${attempts} attempt(s): ${detail}. ` +
        `The sink port is DERIVED from this instance's state dir so a REPL can survive a gateway restart, ` +
        `so there is no fallback port: find the process holding 127.0.0.1:${port} (a previous gateway that ` +
        `has not exited, or another instance whose state dir hashed to the same port) and stop it, or give ` +
        `this instance its own port via NEUTRON_REPL_SINK_PORT / the substrate's sinkPort option.`,
    )
  }

  /**
   * Report a configuration that arrived after the coordinates were already fixed.
   *
   * ONE SINK PER PROCESS, AND THE SECOND HOME BORROWS THE FIRST'S COORDINATES.
   * The live values WIN — they are already baked into every child spawned so far,
   * and adopting a newcomer's port/token would strand those children. So a second
   * instance composed in the SAME process serves its REPLs over the FIRST
   * instance's sink, which works for as long as that process lives and then does
   * not: on the next start the second instance derives its OWN port and reads its
   * OWN token file, and the children baked with the first one's coordinates are
   * unreachable. That is #537 again, scoped to a case #537 does not fix.
   *
   * It is documented rather than refused, deliberately. Production hosts ONE
   * instance per process (the composer builds one; its several substrates share a
   * home), so the condition is a test-suite shape today, and making a second home
   * throw would fail a great many tests for something harmless in-process. A
   * process that genuinely hosts two instances needs a sink PER INSTANCE keyed by
   * state dir — the natural extension of the per-instance port, and work for
   * whoever needs it. Until then this is said out loud on every divergence, because
   * a silent one is the shape of the bug this whole change exists to end.
   *
   * Deduped by value so a suite that spawns hundreds of times reports each distinct
   * divergence once rather than per spawn.
   */
  private reportLateConfig(config: ReplSinkConfig): void {
    const livePort = this.boundPort
    if (config.port !== undefined && livePort !== undefined && config.port !== livePort) {
      this.reportOnce(
        `port:${config.port}`,
        `[repl-sink] already bound on 127.0.0.1:${livePort}; ignoring a later request for port ${config.port}. ` +
          `REPLs spawned from here reach the sink on ${livePort} and will not be reachable after a restart.\n`,
      )
    }
    if (
      config.tokenPath !== undefined &&
      this.tokenPathValue !== undefined &&
      config.tokenPath !== this.tokenPathValue
    ) {
      this.reportOnce(
        `token:${config.tokenPath}`,
        `[repl-sink] already using the token at ${this.tokenPathValue}; ignoring a later request for ` +
          `${config.tokenPath}. REPLs spawned from here carry the first token and will not be reachable ` +
          `after a restart.\n`,
      )
    }
  }

  /** One stderr line per distinct divergence, not per spawn. */
  private reportOnce(key: string, line: string): void {
    if (this.reportedLateConfig.has(key)) return
    this.reportedLateConfig.add(key)
    process.stderr.write(line)
  }

  get port(): number {
    // `boundPort` is assigned in the same breath as `server`, and never undefined
    // while the server is live — so "not started" is the ONLY failure mode here. An
    // earlier revision also threw a `server has no bound port` error below this
    // line, which no input could reach.
    if (this.server === undefined || this.boundPort === undefined) {
      throw new Error('repl-sink: not started')
    }
    return this.boundPort
  }

  /**
   * Stop listening (idempotent). The token is KEPT: it is on disk and every child
   * ever spawned carries it, so a sink that starts again — the next gateway —
   * must present the same one.
   */
  stop(): void {
    this.server?.stop(true)
    this.server = undefined
    this.boundPort = undefined
  }

  /**
   * The credential THIS child presents — derived, never stored, so the value the sink
   * indexes and the value `spawnSession` bakes into the child cannot drift: both come
   * from here. Per incarnation, because it keys on `childGeneration`.
   */
  credentialFor(session: ReplSession): string {
    return deriveChildSinkToken(this.token, session.childGeneration)
  }

  /**
   * Bind a session to its id AND to the credential its child presents.
   *
   * REPLACING a session REVOKES the one it displaces. Without that, registering B
   * under an id A still holds leaves `credentialFor(A)` in `byCredential` forever:
   * `unregisterIf` is identity-guarded, so A's own death handler then no-ops
   * (`sessions.get(id)` is already B) and nothing else ever evicts it. A dead
   * incarnation would keep reaching every privileged route — the orphan this route's
   * whole design exists to refuse, arriving through the replacement path instead of
   * through a lifted session id.
   *
   * Order matters: the displaced credential is dropped BEFORE the new one is stored,
   * so a replacement that happens to share a `childGeneration` — and therefore the
   * same derived credential — ends up mapped to the NEW session rather than deleted.
   */
  register(sessionId: string, session: ReplSession): void {
    const displaced = this.sessions.get(sessionId)
    // A REGISTRATION MAY NOT REVOKE A LIVE SESSION'S AUTHORIZATION (#539, Argus r63).
    //
    // Registering does not merely ADD an ability — displacement DELETES the credential of
    // whatever held this id, so a session that never wins anything can still take the
    // winner's authorization away. That is what happened: a losing adoption contender
    // registered under an id the winner already held, wiping its credential; the contender's
    // own release then unregistered what was left, and the winner's first reply got a 401
    // from a sink that had never heard of it.
    //
    // The ordering fix (register only behind a successful claim or reservation) is the
    // primary remedy; this is the guard that makes the rule structural rather than a property
    // of two call sites. A displaced session whose CHILD IS STILL ALIVE is a session that has
    // not stopped serving, so taking its credential is a revocation, not a replacement — and
    // every legitimate replacement on this branch displaces a child that has already exited
    // (a resume respawn awaits the old child's termination; an eviction awaits it; a
    // quarantined child is replaced under a FRESH session id, not this one).
    //
    // WHAT THE GUARD IS, AND WHAT IT IS NOT — because the first version of this fix refused to
    // displace a LIVE session and that was wrong, caught by three existing cases within the
    // hour. A legitimate TAKEOVER displaces a live session by construction: the winner of the
    // row claim is entitled to this transcript id, and the loser it displaces is still alive
    // until its own renewal fences it. Refusing there would make a claim unwinnable whenever
    // the previous owner was merely stalled — which is the case the takeover threshold exists
    // to serve.
    //
    // So the rule is not "never revoke": it is **only an owner may register**, and that is
    // enforced by ORDERING at the two call sites (behind the claim, behind the reservation),
    // which is where ownership is established. What this method still owes is that a
    // displacement removes only what belongs to the session it displaces — the identity rule
    // the pool entry and the handle mirror carry.
    if (displaced !== undefined && displaced !== session) this.deleteCredentialIf(displaced)
    this.sessions.set(sessionId, session)
    this.byCredential.set(this.credentialFor(session), session)
  }

  /** Drop a credential entry only if it still points at `session` — the same identity rule the
   *  pool entry and the handle mirror carry (r63). Two sessions can derive the SAME credential
   *  when they share a `childGeneration` (an adoption of the same pane), and an unguarded
   *  delete then strips the mapping that belongs to whoever holds it now. */
  private deleteCredentialIf(session: ReplSession): void {
    const credential = this.credentialFor(session)
    if (this.byCredential.get(credential) === session) this.byCredential.delete(credential)
  }

  unregister(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session !== undefined) this.deleteCredentialIf(session)
    this.sessions.delete(sessionId)
  }

  /** Identity-guarded unregister: only drop the mapping if it STILL points at
   *  `session`. A respawn re-attaches the SAME sessionId via `--resume`, so the
   *  dying OLD child's death handler must not evict the NEW session that already
   *  re-registered under that id (the resume race the P2-3 regression caught). */
  unregisterIf(sessionId: string, session: ReplSession): void {
    if (this.sessions.get(sessionId) !== session) return
    this.sessions.delete(sessionId)
    // IDENTITY-GUARDED ON THE CREDENTIAL TOO (r63): the id mapping being ours does not make
    // the credential mapping ours. Same derived credential, different session — see
    // `deleteCredentialIf`.
    this.deleteCredentialIf(session)
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (req.method === 'POST') {
      // AUTHORIZATION RUNS CREDENTIAL → SESSION, NOT SESSION-ID → REGISTRY.
      //
      // Every child used to carry the instance's ROOT token, and this route then
      // authorized any `session_id` that happened to be registered. That is not a
      // check on WHO is calling, because a session id is an IDENTIFIER, not a
      // credential: `--session-id` / `--resume` put it in the process table by design
      // (this tree's own `orphan-adoption.ts` parses exactly that), so an orphan
      // holding the shared token could read a live child's `/proc/<pid>/cmdline`, lift
      // its id, and be authorized AS that child. No check that consults only an
      // identifier can distinguish its owner from a reader.
      //
      // So the caller presents a per-child credential — `HMAC(root, childGeneration)`,
      // handed only into its own 0600 config — and the sink DERIVES which session that
      // is. An orphan's credential belongs to a dead incarnation, which is why the
      // lookup fails even when the session id it once owned has been re-attached by a
      // replacement child: respawn reuses the ID, never the GENERATION.
      const credential = req.headers.get('X-Sink-Token')
      const session = credential === null ? undefined : this.byCredential.get(credential)
      if (session === undefined) {
        if (REPL_DEBUG) {
          process.stderr.write(
            `[repl-sink] refusing ${url.pathname}: credential matches no live session\n`,
          )
        }
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
        process.stderr.write(
          `[repl-sink] ${url.pathname} session=${session.sessionId.slice(0, 8)} ` +
            `claimed=${sessionId.slice(0, 8)} active=${session.activeTurn !== undefined}\n`,
        )
      }
      // The body's `session_id` is now advisory only — a debugging aid in the log
      // line above. It is NOT consulted for routing or authorization, because it is
      // the value an orphan can read out of the process table; the credential above
      // already said which session this is.
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
        // A live child credential also serves the dev-channel; it does not grant
        // access to the tool bridge. Enforce the spawn-time attachment here.
        if (!session.toolBridgeActive) {
          return Response.json({ ok: false, error: 'tool bridge not granted' }, { status: 403 })
        }
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
        // build-dispatch tools) scopes to the composing turn's project. There is no
        // longer an unregistered-session case to degrade: the guard above refused it.
        const toolProjectId = session.projectId ?? null
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
      if (url.pathname === '/activity') {
        // ACTIVITY INSPECTOR tool tap (Pre/PostToolUse hook → `activity-tap.ts`).
        // Gated on the registered session like every other route — see the header
        // above for why that trade was re-made once the token became durable. A row
        // from an orphan is not a row worth keeping.
        const tap = activityTapRef.current
        if (tap === undefined) {
          return Response.json({ status: 'no-tap' }, { status: 503 })
        }
        const phase = body['phase'] === 'pre' ? 'pre' : body['phase'] === 'post' ? 'post' : undefined
        const toolName = typeof body['tool_name'] === 'string' ? (body['tool_name'] as string) : ''
        if (phase === undefined || toolName === '') {
          return Response.json({ status: 'bad-input' }, { status: 400 })
        }
        try {
          const str = (k: string): string | undefined =>
            typeof body[k] === 'string' && (body[k] as string) !== ''
              ? (body[k] as string)
              : undefined
          tap({
            project_id: session.projectId ?? null,
            phase,
            tool_name: toolName,
            detail: typeof body['detail'] === 'string' ? (body['detail'] as string) : '',
            // The expanded view's content (arguments + returned output). Optional:
            // a hook from an older build posts neither, and the row degrades to the
            // one-liner rather than failing.
            ...(str('args') !== undefined ? { args: str('args') as string } : {}),
            ...(str('result') !== undefined ? { result: str('result') as string } : {}),
          })
          return Response.json({ status: 'ok' })
        } catch (e) {
          // A recording fault is a best-effort miss the hook ignores — 200 so the
          // agent's tool call never sees an HTTP fault from the inspector.
          return Response.json({ status: 'error', error: String(e) })
        }
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
      if (url.pathname === '/todo-sync') {
        // Hook installation is not authorization: a child can POST directly.
        // Board writes require the same bridge attachment as tool dispatch.
        if (!session.toolBridgeActive) {
          return Response.json({ status: 'forbidden', error: 'tool bridge not granted' }, { status: 403 })
        }
        // TodoWrite→Work Board sync (WAVE 3.5 task B). The PostToolUse hook POSTs
        // the agent's TodoWrite list; reconcile it into THIS session's active
        // project scope through the shared store (one onChange live-push). The
        // reconciler is late-bound (composer-wired); absent on an LLM-less/
        // board-less boot → 503, same fail-soft shape the hook swallows.
        const sync = todoSyncRef.current
        if (sync === undefined) {
          return Response.json({ status: 'no-sync' }, { status: 503 })
        }
        const todos = Array.isArray(body['todos']) ? body['todos'] : []
        try {
          await sync({ project_id: session.projectId ?? null, todos })
          return Response.json({ status: 'ok' })
        } catch (e) {
          // A reconcile fault is a NORMAL best-effort miss the hook ignores — 200
          // with ok:false rather than an HTTP fault.
          return Response.json({ status: 'error', error: String(e) })
        }
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

/**
 * Pool entries whose spawn has NOT resolved yet, keyed the same way `pool` is and
 * holding the IDENTICAL promise object so a stale delete cannot clear a newer spawn's
 * pendingness (the `unregisterIf` identity-guard discipline).
 *
 * WHY A SEPARATE MAP AND NOT `pool` ITSELF: a `Promise` cannot be asked whether it has
 * settled, and asking by awaiting it is exactly the observation that changes the answer.
 * `evictWarmReplsForMcpSurfaceChange` has to distinguish "a warm child sitting idle"
 * (kill it now) from "a child a COMMITTED dispatch is about to inject into" (do not) —
 * and a cold spawn is the second case even though the session it resolves to has no
 * active turn and holds no turn slot YET. It cannot: the caller takes the slot in the
 * continuation AFTER `getOrSpawnSession` resolves, and the evictor's `await` on the same
 * promise resumes three await-hops earlier, so it read the brand-new session as idle and
 * killed the child out from under the dispatch. This map is the synchronous answer, in
 * the same spirit as `childByKey` one entry above.
 *
 * Added at the single `pool.set` in `spawn.ts`; deleted when that promise settles,
 * either way.
 *
 * NOT SUFFICIENT ON ITS OWN, and deliberately kept alongside {@link committedDispatches}
 * rather than folded into it: this map is the only signal for a spawn that NO dispatch is
 * waiting on — the supervision crash/wedge respawn in `supervision.ts` calls
 * `getOrSpawnSession` directly, with no turn behind it. Without this entry the evictor
 * would `await` that unresolved promise and block a revocation for the whole 30 s ready
 * budget before killing the child it just waited for.
 */
export const pendingSpawns = new Map<string, Promise<ReplSession>>()

/**
 * How many dispatches are COMMITTED to a pool key but do not yet hold its turn slot —
 * the span from "asked `getOrSpawnSession` for a session" to "`acquireTurn()` returned".
 * A count, not a flag, because dispatches queue on the same key.
 *
 * WHY THE TWO SESSION FIELDS CANNOT ANSWER THIS. `session.activeTurn` is assigned late,
 * and `session.turnSlotHeld` is taken at `acquireTurn()` — which is in the CALLER's
 * continuation, after `getOrSpawnSession` has already resolved. For the whole span before
 * that, a warm session reads as perfectly idle to
 * {@link evictWarmReplsForMcpSurfaceChange}, which duly killed the child the dispatch was
 * about to inject into, failing the turn.
 *
 * WHY THE SPAN IS NOT MICROSCOPIC, which is what made this worth a map. An earlier
 * revision wrote the residual window off as "a handful of microtasks — the async unwind
 * out of `getOrSpawnSession`". It is not: the warm-reuse branch computes the MCP
 * freshness fingerprint with `await options.resolveExtraMcpServers()`, and in the real
 * composition that resolver reads the installed list out of the database and DECRYPTS
 * every env value through the secrets store. So the window contains real I/O, on the
 * exact code path a revocation runs concurrently with — a reviewer reproduced a failed
 * dispatch by gating that one resolver. Sized by what it contains, not by how it reads.
 *
 * Incremented in the turn driver before the get-or-spawn, decremented in the same
 * driver's `finally`, so every unwind — return, throw, cancel, timeout — settles it.
 * Ephemeral dispatches are excluded: they are never pooled, so counting them would mark a
 * key busy on behalf of a session that does not live under it.
 */
export const committedDispatches = new Map<string, number>()

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

/** Live per-instance model-update watchdog handles (the legacy harness port row #16), keyed by
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
