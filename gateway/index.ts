import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WebSocketHandler } from 'bun'
import { applyMigrationsToProjectDb } from '@neutronai/migrations/runner.ts'
import { shutdownAllPersistentRepls } from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import {
  ProjectDb,
  SystemEventsStore,
  registerSystemEventSink,
  resolveSystemEventSink,
} from '@neutronai/persistence/index.ts'
import { MAX_UPLOAD_BYTES_DEFAULT } from './upload/import-upload-handler.ts'
// C2 OSS-split (2026-06-10) — the Managed production composer
// (`buildDefaultRealModeComposer`, formerly ~4800 lines of this file)
// now lives in the Managed provisioning module (`realmode-composer.ts`) and reaches
// this boot shell ONLY via the `NEUTRON_GRAPH_COMPOSER_MODULE` env seam
// (see `loadGraphComposerFromEnv` at the bottom of this file). This
// file holds ZERO imports — static OR dynamic — into Managed dirs
// (signup/, provisioning/, identity/, proxy/).
import { composeProductionGraph } from './composition.ts'
import { resolveBootConfig, type BootConfig } from '@neutronai/config/index.ts'


// Shared boot-time helpers — extracted to `./boot-helpers.ts` (Argus
// PR #440 r2 IMPORTANT 5) so the injected Managed composer imports a
// NON-ENTRY module instead of this entry module (which would form a
// top-level-await cycle through the NEUTRON_GRAPH_COMPOSER_MODULE
// dynamic import below). This file re-exports the full helper surface
// for back-compat; boot() itself only needs the two value imports.
import {
  bindHttpListener,
  resolveListenPort,
  resolveRepoRoot,
  type GraphComposer,
  type HttpHandler,
} from './boot-helpers.ts'
export {
  resolveRegistryDbPath,
  resolveOwnerRegistryRow,
  resolveListenPort,
  resolveOwnerHome,
  resolveRepoRoot,
  buildChainedChatCommandFilter,
  buildRemindersChatCommandFilter,
  buildTridentCodeChatCommandFilter,
  buildCalendarChatCommandFilter,
  readPatternFromPrompts,
  buildCoresBackendFactories,
  wrapResearchBackendWithDefaultProjectId,
  buildResearchLlmCallForOwner,
} from './boot-helpers.ts'
export type {
  TasksCoreOwnerRegistry,
  BootOwnerRow,
  BootOwnersRegistry,
  OwnerRegistryLookupResult,
  GraphComposer,
  HttpHandler,
  ListProjectsResolver,
} from './boot-helpers.ts'
import type { GatewayModuleGraph } from './module-graph.ts'
import { sdNotify } from './sd-notify.ts'

// 5-second tick interval pairs with the systemd unit's WatchdogSec=10 — 50%
// safety margin per `man sd_notify(3)` recommendations. If the gateway misses
// two ticks systemd's watchdog fires and Restart=always brings up a fresh
// process within RestartSec=5s.
const WATCHDOG_INTERVAL_MS = 5_000


export interface BootHandle {
  db: ProjectDb
  graph: GatewayModuleGraph | null
  /**
   * Live HTTP listener wrapping `Bun.serve`. Always set; we always open a
   * port. `port: 0` is allowed at boot for a random free port (tests); the
   * resolved port is exposed on `server.port` post-boot. `stop()` closes the
   * listener and is idempotent — `shutdown()` calls it.
   */
  server: BootServer
  /**
   * Idempotent graceful shutdown. Stops accepting new requests, drains
   * in-flight ones up to systemd's TimeoutStopSec, then closes the DB.
   *
   * `force: true` is for in-process callers (tests, embedded runs) that
   * need the event loop to drain immediately — it forwards to
   * `server.stop(true)` so idle keep-alive sockets are closed alongside
   * the listener. WITHOUT this, `bun test` hangs at suite end on the
   * keep-alive idle timer for any test that fetched against the gateway.
   * Production callers (the SIGTERM handler) leave `force` unset so
   * in-flight requests get the graceful drain window.
   */
  shutdown: (opts?: { force?: boolean }) => Promise<void>
}

export interface BootServer {
  /** The actual port the listener bound. */
  port: number
  /**
   * Idempotent close. `force: true` forwards to `Bun.serve.stop(true)`,
   * which closes idle keep-alive sockets immediately instead of waiting
   * for them to drain. Tests pass force=true so `bun test` can exit
   * cleanly; production callers leave it unset so in-flight requests
   * complete within `TimeoutStopSec`.
   */
  stop: (opts?: { force?: boolean }) => Promise<void>
}

/**
 * Resolve the per-instance url_slug used by every JWT-claim equality check
 * inside the gateway (chat-bridge.validateStartToken etc.). Resolution
 * order:
 *
 *   1. `<OWNER_HOME>/.url_slug` — written by the rename orchestrator on
 *      every successful slug rename. This file-based override is what
 *      makes a `systemctl restart` after rename pick up the new slug
 *      without re-rendering the unit's hardcoded env block.
 *   2. `NEUTRON_INSTANCE_SLUG` env — the systemd unit's install-time
 *      Environment= block (canonical name as of C4-a2, SD1). Pre-rename /
 *      first-boot path. Pre-P1.5 instances stay on this until their first
 *      rename.
 *   3. `'dev'` — direct `bun run gateway/index.ts` fallback.
 *
 * Argus r1 [IMPORTANT]: without (1), a per-instance gateway booted at
 * url_slug=A still pins `expected_project_slug=A` in memory after the
 * orchestrator renames to B. New JWTs minted with `project_slug=B` then
 * 401 on every connect because the slug-history shim only knows about
 * OLD slugs (B is the NEW slug, not in slug_history). The orchestrator
 * pairs the file write with a systemctl restart so this resolver
 * returns the new value on the next boot.
 */
export function resolveOwnerSlug(env: NodeJS.ProcessEnv = process.env): string {
  const ownerHome = env['OWNER_HOME']
  if (ownerHome !== undefined && ownerHome !== '') {
    const slugFile = join(ownerHome, '.url_slug')
    if (existsSync(slugFile)) {
      const fromFile = readFileSync(slugFile, 'utf8').trim()
      if (fromFile.length > 0) return fromFile
    }
  }
  return env['NEUTRON_INSTANCE_SLUG'] ?? 'dev'
}

/**
 * C1 — the BootConfig-threaded owner-slug resolver `boot()` uses. Identical
 * precedence to {@link resolveOwnerSlug} above (file `.url_slug` >
 * `NEUTRON_INSTANCE_SLUG` > `'dev'`), preserved BIT-FOR-BIT: the `.url_slug`
 * FILE read (a filesystem read, not an env read) stays, while `OWNER_HOME` +
 * `NEUTRON_INSTANCE_SLUG` now come from the frozen config instead of a second
 * independent `process.env` read. This keeps the composer + boot from
 * desyncing on the resolved slug (the hazard the C1 brief flags).
 *
 * The `.url_slug` lookup uses the EFFECTIVE owner home — `config.ownerHome ??
 * config.neutronHome` — i.e. the exact value {@link envShimFromBootConfig}
 * publishes to `OWNER_HOME`. This preserves the old Open flow bit-for-bit: the
 * legacy `open/server.ts` mutated `process.env.OWNER_HOME ||= neutronHome`
 * BEFORE `boot()` read it, so an `OWNER_HOME`-unset box with `<NEUTRON_HOME>/
 * .url_slug` resolved the slug from that file. Reading raw `config.ownerHome`
 * alone would silently ignore the rename file on such a box.
 */
export function resolveOwnerSlugFromConfig(config: BootConfig): string {
  const ownerHome = config.ownerHome ?? config.neutronHome
  if (ownerHome !== undefined && ownerHome !== '') {
    const slugFile = join(ownerHome, '.url_slug')
    if (existsSync(slugFile)) {
      const fromFile = readFileSync(slugFile, 'utf8').trim()
      if (fromFile.length > 0) return fromFile
    }
  }
  return config.instanceSlug ?? 'dev'
}


export interface BootOptions {
  composer?: GraphComposer
  /**
   * Optional explicit HTTP handler. When set, used for every inbound
   * request; both the composer's `http_handler` and the default
   * `/healthz`-only handler are bypassed. The integration tests inject one
   * here to wire a cross-instance API server without standing up the full
   * production composition.
   */
  httpHandler?: HttpHandler
  /**
   * Override port resolution. `0` requests a random free port (tests).
   * Otherwise CLI flag > env > default-7800 wins.
   */
  port?: number
  /**
   * C1 — the frozen, validated {@link BootConfig}. When omitted, `boot()`
   * resolves it once from `process.env` via `resolveBootConfig`. The
   * entrypoints (`open/server.ts`, `gateway/index.ts`) resolve it themselves
   * and thread it here so boot(), the composer, and the process.env shim all
   * read the SAME resolution — no divergent second `process.env` read.
   */
  config?: BootConfig
}

/**
 * §F1 — drain the realmode cleanups on shutdown. Each is AWAITED (they may be
 * async — e.g. the upload sweeper's quiescing `stop()`) so its in-flight work
 * finishes BEFORE the caller closes the DB. A cleanup that throws/rejects is
 * logged and does NOT stop the remaining cleanups from running; the returned
 * promise always resolves. `shutdown()` calls this, then `db.close()`, so DB
 * teardown is strictly ordered after every cleanup has settled.
 */
export async function drainRealmodeCleanups(
  cleanups: Array<() => void | Promise<void>>,
): Promise<void> {
  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch (err) {
      console.error('realmode cleanup threw during shutdown:', err)
    }
  }
}

export async function boot(options: BootOptions = {}): Promise<BootHandle> {
  // C1 — resolve+validate env ONCE. When the caller (an entrypoint) already
  // resolved it, thread theirs so we never re-read process.env divergently.
  const config = options.config ?? resolveBootConfig(process.env)
  const dbPath = config.dbPath
  mkdirSync(dirname(dbPath), { recursive: true })

  const db = ProjectDb.open(dbPath)
  applyMigrationsToProjectDb(db)

  // O4 — register the process-wide system_events degradation journal sink
  // ONCE, right after migrations apply (so `system_events` exists). Every
  // silent fail-soft / degrade site reaches this via the ambient registry
  // (persistence/system-events.ts) and emits a VISIBILITY-ONLY row; when this
  // registration hasn't run (unit tests, sidecar tools) each emit is a no-op.
  // Save/restore discipline: capture whatever sink was registered before us so
  // teardown RESTORES it (rather than nulling the registry). This keeps a
  // still-live older boot's sink working when boots overlap and shut down
  // newest-first (LIFO) — B's teardown restores A instead of orphaning it.
  const priorSystemEventSink = resolveSystemEventSink()
  const systemEventSink = new SystemEventsStore({ db })
  registerSystemEventSink(systemEventSink)
  // Ownership-guarded restore: only act when the ambient sink is still the one
  // we registered, so a post-close degrade emit can't target this closed DB and
  // a NEWER boot's sink is never clobbered (its own teardown owns that).
  const clearOwnedSystemEventSink = (): void => {
    if (resolveSystemEventSink() === systemEventSink) registerSystemEventSink(priorSystemEventSink)
  }

  const project_slug = resolveOwnerSlugFromConfig(config)
  const bootedAt = Date.now()

  // Compose the module graph if the caller supplied a composer. We capture
  // the composition output BEFORE composing so we can read any graph-level
  // hooks the production caller wired (e.g. http_handler) without changing
  // the GatewayModuleGraph contract.
  let graph: GatewayModuleGraph | null = null
  // §F1 — a cleanup may be async (the upload sweeper's quiescing `stop()`); the
  // shutdown drain awaits each before `db.close()`.
  let realmode_cleanups: Array<() => void | Promise<void>> = []
  let composedHttpHandler: HttpHandler | undefined
  // Sprint 18: WebSocket handler exposed by the landing server (chat
  // upgrade path). Bun.serve receives it alongside the fetch handler so a
  // single port handles both HTTP and WS. Default no-op stays cold when
  // no landing server is wired (legacy P1 boot path).
  let composedWebsocket: WebSocketHandler<unknown> | undefined
  // Sprint 18: composed `{ fetch, websocket }` from composeHttpHandler.
  // We hold onto the composed.fetch separately so the Bun.serve() arrow
  // can pass the live `server` reference through after its declaration
  // (the landing server's WebSocket upgrade pattern needs `server.upgrade`).
  let composedChainFetch:
    | ((req: Request, server: import('bun').Server<unknown>) => Response | Promise<Response>)
    | undefined
  // Sprint 19 + O4 — release ALL boot-owned resources on ANY init failure after
  // the DB is open + the system_events sink is registered, so a systemd
  // Restart=always loop doesn't race a still-open SQLite handle, dangling
  // timers from a half-composed graph, or an ambient sink pointing at the
  // failed boot's (now-closed) DB. Runs for a composer/compose throw AND for a
  // later failure (listener bind, port assertion, sd_notify) before a
  // BootHandle is returned. Idempotent-safe: only invoked on the failure paths.
  const bootFailureCleanup = async (): Promise<void> => {
    if (graph !== null) {
      try {
        await graph.shutdown()
      } catch (shutdownErr) {
        console.error('graph shutdown during init failure threw:', shutdownErr)
      }
    }
    // §F1 — drain any realmode cleanups the composition wired (auxiliary DB
    // handles, timers) BEFORE db.close(), mirroring the normal shutdown order so
    // a post-composition failure doesn't leak them. No-op when none were wired
    // (composer threw before assignment). Each is awaited; a throwing one is
    // logged and does not stop the rest (drainRealmodeCleanups always resolves).
    await drainRealmodeCleanups(realmode_cleanups)
    // Restore the ambient sink (ownership-guarded) BEFORE closing the DB it holds.
    clearOwnedSystemEventSink()
    db.close()
  }
  if (options.composer !== undefined) {
    try {
      const composition = await options.composer({ db, project_slug })
      if (composition.realmode_cleanups !== undefined) {
        realmode_cleanups = composition.realmode_cleanups
      }
      // ISSUE #32 — the boot shell used to inline the
      // `composition.app_xxx_surface → composeInput.appXxx` mapping
      // here, then call `composeHttpHandler(composeInput)` itself.
      // That left every `*-production-composer.test.ts` re-rolling
      // the same `composeHttpHandler` invocation, which silently
      // bypassed this mapping — a deletion at any
      // `composeInput.appXxx = …` line in the old boot loop passed
      // every reachability test. Mapping now lives in
      // `composition.ts:buildComposedHttpFromComposition`, so a single
      // path produces the composed `fetch` for both boot and tests.
      //
      // We seed `default_handler` here because only the boot shell
      // knows the per-instance `bootedAt` + slug needed for the healthz
      // stub; the composer accepts it via the new `default_handler`
      // field.
      composition.default_handler = defaultHealthzHandler({ project_slug, bootedAt })
      const composed = await composeProductionGraph(composition)
      graph = composed
      if (composition.http_handler !== undefined) {
        composedHttpHandler = composition.http_handler
      } else if (composed.fetch !== undefined) {
        composedChainFetch = composed.fetch
        composedWebsocket = composed.websocket
      }
    } catch (err) {
      // Sprint 19 — release resources on init failure so a systemd restart
      // doesn't race a still-open SQLite handle / dangling timers spawned by a
      // partially-composed graph. This is the composer / composeProductionGraph
      // throw path; the identical guard wraps the post-composition init below.
      await bootFailureCleanup()
      throw err
    }
  }

  // O4 / Sprint 19 — everything from here to the returned BootHandle is guarded:
  // a throw (listener bind, port assertion, sd_notify) runs bootFailureCleanup
  // so the DB handle, a composed graph's timers, and the ambient system_events
  // sink are all released before the error propagates. `boundServerRef` lets the
  // catch also stop a listener that DID bind before a later step threw.
  let boundServerRef: BootServer | null = null
  try {
  // Pick the http handler. Explicit BootOptions wins over composer output;
  // composer output wins over the default healthz stub. The chained-fetch
  // path (Sprint 18) is wired below inside the Bun.serve `fetch` arrow so
  // the live `server` reference is in scope for `server.upgrade(...)` on
  // the unified `/ws/app/chat` chat socket.
  const handler: HttpHandler =
    options.httpHandler ??
    composedHttpHandler ??
    defaultHealthzHandler({ project_slug, bootedAt })

  // Open the listener. This is the carryover fix from S5 Argus r2: prior to
  // this commit boot() never opened any HTTP port, so the systemd unit's
  // ExecStart `--port=<allocated>` had nothing on the other end and Caddy
  // proxied to a closed upstream on every real provision.
  // Port precedence stays argv-coupled (--port > NEUTRON_PORT > default), but
  // the env half is the config's validated `NEUTRON_PORT` rather than a second
  // raw `process.env` read — so a bad NEUTRON_PORT already failed loud upstream.
  const port = resolveListenPort(
    process.argv,
    { NEUTRON_PORT: config.port === undefined ? undefined : String(config.port) },
    options.port,
  )
  // The websocket option is required for `server.upgrade(req, { data })`
  // to work; we always pass one even when no landing server is wired so
  // a future mid-boot composition switch can flip it on without
  // restarting the listener. The no-op handler stays cold when no
  // upgrade path is reachable.
  const websocketHandler: WebSocketHandler<unknown> = composedWebsocket ?? {
    open(): void {},
    message(): void {},
    close(): void {},
  }
  // #314: bind the resolved port DETERMINISTICALLY. A configured port (env /
  // --port / the fixed 7800 default → `port !== 0`) is bound with a bounded
  // EADDRINUSE retry (to ride out the prior process releasing the socket on a
  // restart) and then FAILS LOUD if still held — it is NEVER silently moved to
  // a random port, because the owner's bookmarked URL is pinned to it. Only the
  // genuine "pick anything" case (`port === 0`, dev/tests) auto-selects.
  const server = await bindHttpListener({
    port,
    serve: () =>
      Bun.serve({
        port,
        // Accept request bodies up to the import cap (+ 64MB multipart/protocol
        // slack). Bun.serve defaults maxRequestBodySize to 128MB, which the
        // single-shot history-import upload (`POST /api/upload/<source>`, whole
        // export in one body) exceeds for a large ChatGPT/Claude export → Bun
        // 413s it BEFORE the handler runs (no app log, the handler's own
        // MAX_UPLOAD_BYTES_DEFAULT=5GB check never reached). Align the server
        // cap with the import cap so per-route caps (chat 10MB, import 5GB) do
        // the real enforcement with proper app-level 413s.
        maxRequestBodySize: MAX_UPLOAD_BYTES_DEFAULT + 64 * 1024 * 1024,
        // Default to loopback so an unauthenticated gateway is not LAN-exposed
        // out of the box (S5 Argus security blocker). Self-hosters opt into a
        // wider bind with NEUTRON_HOST=0.0.0.0 once they front it with auth / a
        // trusted network — see .env.example and the Open README's exposure
        // warning.
        hostname: config.host,
        fetch: async (req: Request, srv): Promise<Response> => {
          try {
            // Sprint 18 — when the chain is wired, route through it (it
            // owns the precedence ladder + the live `srv` reference for
            // WebSocket upgrades). Otherwise fall back to the simple
            // single-handler path (P1 default + tests injecting
            // `BootOptions.httpHandler`).
            if (
              options.httpHandler === undefined &&
              composedHttpHandler === undefined &&
              composedChainFetch !== undefined
            ) {
              return await composedChainFetch(req, srv)
            }
            return await handler(req)
          } catch (err) {
          // 500 on any unhandled handler error so the listener stays up.
          // journald collects the trace; the supervisor watchdog uses the
          // instance-process liveness signal, not these handler errors.
          console.error('http handler threw:', err)
          return new Response('Internal Server Error', { status: 500 })
        }
      },
      websocket: websocketHandler,
    }),
  })
  // Bun's typed surface marks `server.port` as `number | undefined` (TCP
  // sockets aren't required for every transport), but for a port-bound HTTP
  // server it's always set post-start. Assert at boot to keep the BootHandle
  // strict.
  if (server.port === undefined) {
    throw new Error('Bun.serve did not bind a port (transport mismatch?)')
  }
  const boundServer: BootServer = {
    port: server.port,
    stop: async (opts) => {
      // Production default: graceful drain. systemd's TimeoutStopSec
      // bounds the window; in-flight HTTP requests complete before the
      // socket is released. opts.force=true forwards
      // closeActiveConnections=true so idle keep-alive sockets are
      // closed alongside the listener.
      //
      // Auto-force when NODE_ENV='test' (bun test sets this for us) so
      // in-process test runners exit cleanly. Without this, idle
      // keep-alive sockets owned by the listener keep Bun's event loop
      // alive on the keep-alive idle timer (~5 min) and `bun test` hangs
      // at suite end. systemd-spawned production processes do not set
      // NODE_ENV, so their semantics are unchanged.
      const force = opts?.force ?? config.nodeEnv === 'test'
      await server.stop(force)
    },
  }
  // Track the bound listener so the init-failure guard can stop it if a later
  // step (sd_notify, watchdog wiring) throws after the socket is already open.
  boundServerRef = boundServer

  // Best-effort READY=1; sdNotify is a no-op when NOTIFY_SOCKET is unset (dev
  // mode / macOS), and throws on real systemd error paths so a bricked notify
  // surfaces loudly at boot rather than silently across the whole watchdog
  // window. We only send READY=1 once the DB is open, the graph is composed,
  // and the listener is bound — so a successful systemd START_TIMEOUT means
  // every subsystem is actually ready to take traffic.
  sdNotify('READY=1')

  let watchdogTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    // Catch transient sd_notify failures (kernel-side `sendto()` errors,
    // recv-side socket teardown during shutdown) so a single hiccup does NOT
    // become an unhandled exception that crashes the process. systemd's
    // WatchdogSec timer will fire on its own if a real outage stops ticks
    // from arriving — that's the intended restart path. We log to stderr
    // (journal) so a sustained pattern is observable.
    try {
      sdNotify('WATCHDOG=1')
    } catch (err) {
      console.error('sd_notify WATCHDOG=1 failed:', err)
    }
  }, WATCHDOG_INTERVAL_MS)

  let shuttingDown = false
  const shutdown = async (opts?: { force?: boolean }): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    // Stop accepting NEW requests first so an SIGTERM doesn't race a freshly
    // arriving Caddy proxy. We stop the listener BEFORE STOPPING=1 so by the
    // time systemd starts the TimeoutStopSec countdown, nothing new can land.
    // opts.force is threaded through to boundServer.stop so test callers can
    // forcefully close idle keep-alive sockets without changing production
    // graceful-drain semantics.
    try {
      await boundServer.stop(opts)
    } catch (err) {
      console.error('http listener stop failed:', err)
    }
    // Same try/catch shape as the watchdog tick above: a transient sd_notify
    // failure (NOTIFY_SOCKET torn down mid-stop, kernel sendto hiccup) must
    // NOT skip the cleanup that follows. Without this guard, a throw here
    // would exit the function before clearInterval + db.close, leaving the
    // watchdog timer alive and the DB open until systemd force-kills.
    try {
      sdNotify('STOPPING=1')
    } catch (err) {
      console.error('sd_notify STOPPING=1 failed:', err)
    }
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer)
      watchdogTimer = null
    }
    if (graph !== null) {
      try {
        await graph.shutdown()
      } catch (err) {
        console.error('module-graph shutdown failed:', err)
      }
    }
    // ISSUES #217 — terminate the persistent-REPL warm pool (the `claude`
    // PTY children + their dev-channel bridges) as part of graceful
    // shutdown. Before this call the function was exported but NEVER
    // invoked in production: under the old KillMode=process units every
    // descendant reparented to init on each restart/deploy/delete and
    // accumulated to RAM exhaustion (632 orphans / ~19 GB, 2026-06-11).
    // systemd's KillMode=control-group is the guarantee layer (covers
    // crash / SIGKILL / hung drain); this is the polite layer that also
    // protects non-systemd deployments (Open self-host on macOS, dev
    // runs). Continuity is unaffected — the next turn `--resume`s the
    // captured session transcript.
    //
    // Timing note (Argus PR#438 minor 9): worst case this drain can
    // exceed the unit's TimeoutStopSec=30 (one wedged spawn promise can
    // hold the pool walk for the spawn timeout, ~40 s) — acceptable under
    // systemd because the cgroup SIGKILL fires at the deadline and reaps
    // whatever the drain hadn't reached. On NON-systemd deployments there
    // is no such backstop and a SIGTERM-ignoring `claude` gets no
    // per-child KILL escalation from this loop — a self-host orphan there
    // is bounded by the dev-channel's exit-on-transport-close (same PR)
    // rather than by an external reaper.
    try {
      await shutdownAllPersistentRepls()
    } catch (err) {
      console.error('persistent-REPL substrate shutdown failed:', err)
    }
    // P1.5 / Sprint 21 (Codex r2 P2) — run realmode cleanups (e.g. the
    // slug-picker resolver's RW registry + identity DB handles) AFTER
    // module-graph shutdown but BEFORE the main `db.close()` so any
    // in-flight queries on the auxiliary connections finish cleanly.
    // §F1 — drain (await) every cleanup, async ones included, BEFORE db.close().
    await drainRealmodeCleanups(realmode_cleanups)
    // O4 — clear the ambient system_events sink BEFORE db.close() so a
    // post-shutdown degrade emit can't reference the closed DB. Ownership-
    // guarded so a sibling boot handle's sink is never clobbered. (Even if one
    // raced in, emitSystemEventSafe swallows the write error — belt-and-braces.)
    clearOwnedSystemEventSink()
    db.close()
  }

  const handleSignal = (): void => {
    // Don't await; node signal handlers are sync. shutdown() stores its own
    // re-entrancy guard so a double signal is harmless.
    void shutdown()
  }
  process.once('SIGTERM', handleSignal)
  process.once('SIGINT', handleSignal)

  return { db, graph, server: boundServer, shutdown }
  } catch (err) {
    // Any failure between the sink registration and the returned BootHandle
    // (listener bind rejection, port assertion, sd_notify READY throw) lands
    // here. Stop a listener that already bound, then release the graph, sink,
    // and DB via the shared cleanup so nothing leaks into a systemd restart.
    if (boundServerRef !== null) {
      try {
        await boundServerRef.stop({ force: true })
      } catch (stopErr) {
        console.error('http listener stop during init failure threw:', stopErr)
      }
    }
    await bootFailureCleanup()
    throw err
  }
}

/**
 * Default `/healthz` handler used when no composer + no explicit
 * `BootOptions.httpHandler` are wired. Returns
 * `{status:'ok', project_slug, uptime_ms}` for liveness; everything else is
 * 404. Production wires a real handler via the composer.
 */
export function defaultHealthzHandler(opts: {
  project_slug: string
  bootedAt: number
}): HttpHandler {
  return (req: Request): Response => {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') {
      const body = {
        status: 'ok' as const,
        project_slug: opts.project_slug,
        uptime_ms: Date.now() - opts.bootedAt,
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('Not Found', { status: 404 })
  }
}



/**
 * C2 OSS-split boundary closure (2026-06-10) — the graph-composer module
 * seam. The Managed production composer (`buildDefaultRealModeComposer`)
 * lived in this file until C2; it carried 24 open-not-to-managed import
 * edges (signup/, provisioning/, identity/, proxy/), so it moved
 * to the Managed provisioning module (`realmode-composer.ts`, Managed-side,
 * those imports are legal). This Open boot shell now takes the composer
 * as DEPLOY-CONFIG INJECTION: the per-instance systemd unit sets
 *
 *   Environment=NEUTRON_GRAPH_COMPOSER_MODULE=provisioning/realmode-composer.ts
 *
 * and the entrypoint dynamic-imports that path (resolved against the
 * repo root for relative values) and calls its exported
 * `buildGraphComposer()`. Open self-hosted boxes never set the env and
 * boot the same `/healthz`-only dev shape as before. Open code never
 * names a Managed path — the unit template (a Managed `scripts/install/`
 * artifact) is what knows where the composer lives. Post-carve the env
 * points into the private repo's composer while this file ships public.
 *
 * Fail-fast: `NEUTRON_AUTH_JWKS_URL` set (realmode requested) WITHOUT a
 * composer module is a misconfigured Managed unit — exit 1 loudly rather
 * than silently booting an instance with no chat surface. The deploy
 * pipeline splices the env into existing units before the fleet restart
 * (scripts/install/migrate-instances-graph-composer.sh).
 *
 * MODULE-CYCLE NOTE (Codex C2-round P1 2026-06-10; CLOSED structurally
 * at Argus PR #440 r2, 2026-06-12): the composer module used to import
 * its ~22 shared helpers back from THIS entry module while it was still
 * mid-evaluation (the entrypoint suspends at its top-level
 * `await loadGraphComposerFromEnv()`) — a TLA cycle that completed under
 * Bun's loader but could deadlock under a strict ESM-TLA implementation,
 * and prod bun is path-pinned, not version-pinned. The helpers now live
 * in `gateway/boot-helpers.ts` (a non-entry module the composer imports
 * directly), so the composer's module graph no longer contains this
 * entry module at all. The real-entry subprocess test in
 * `gateway/__tests__/graph-composer-env-seam.test.ts` keeps pinning the
 * boot-through-the-seam behaviour so any future reintroduction of the
 * cycle (or a Bun loader regression / Node port) surfaces as a test
 * failure, not a prod boot hang.
 */
export async function loadGraphComposerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GraphComposer | undefined> {
  const modulePath = env['NEUTRON_GRAPH_COMPOSER_MODULE']
  const jwksUrl = env['NEUTRON_AUTH_JWKS_URL']
  if (typeof modulePath !== 'string' || modulePath.length === 0) {
    if (typeof jwksUrl === 'string' && jwksUrl.length > 0) {
      console.error(
        '[boot] FATAL: NEUTRON_AUTH_JWKS_URL is set (realmode requested) but ' +
          'NEUTRON_GRAPH_COMPOSER_MODULE is not — the graph composer is ' +
          'deploy-config injection since C2. Managed units set it to ' +
          'owner-provisioning/realmode-composer.ts; run ' +
          'scripts/install/migrate-owners-graph-composer.sh for pre-C2 units.',
      )
      process.exit(1)
    }
    return undefined
  }
  const resolved = modulePath.startsWith('/')
    ? modulePath
    : join(resolveRepoRoot(env), modulePath)
  // `() => unknown`, not `() => GraphComposer`: the module is arbitrary
  // deploy config — the return shape is a runtime claim we VERIFY below,
  // not a compile-time fact we can assert here.
  const mod = (await import(resolved)) as {
    buildGraphComposer?: () => unknown
  }
  if (typeof mod.buildGraphComposer !== 'function') {
    console.error(
      `[boot] FATAL: NEUTRON_GRAPH_COMPOSER_MODULE=${modulePath} does not export buildGraphComposer()`,
    )
    process.exit(1)
  }
  // Argus PR #440 r2 (minor 8): validate the factory's RETURN value too.
  // A GraphComposer is itself a function (see the type above); a module
  // whose buildGraphComposer() returns undefined/an object would
  // otherwise slip through here and explode later inside boot() with a
  // far less actionable stack than this fail-fast.
  const composer = mod.buildGraphComposer()
  if (typeof composer !== 'function') {
    console.error(
      `[boot] FATAL: NEUTRON_GRAPH_COMPOSER_MODULE=${modulePath} buildGraphComposer() ` +
        `returned ${composer === null ? 'null' : typeof composer} — expected a GraphComposer function`,
    )
    process.exit(1)
  }
  return composer as GraphComposer
}

if (import.meta.main) {
  // Top-level await: Bun supports TLA in entry modules. An unhandled rejection
  // exits non-zero, which systemd's Restart=always policy converts into a
  // respawn after RestartSec=5s.
  //
  // When `NEUTRON_GRAPH_COMPOSER_MODULE` is set (Managed production
  // install path), the injected composer mounts the cross-instance API on
  // the per-instance port. Without it (dev / smoke / Open self-host), the
  // boot shell only opens /healthz — same dev shape as Sprint 4.
  // C1 dual-entrypoint fix — resolve+validate env ONCE and thread it into
  // boot(). This unifies the DB path: boot() now opens `config.dbPath`
  // (`NEUTRON_DB_PATH` else `<NEUTRON_HOME>/project.db`, the single-source
  // `migrations/db-path.ts` precedence) instead of the old divergent
  // `~/.local/share/neutron/owner.db` fallback. So `bun start:gateway` on a box
  // whose Open DB lives at `<NEUTRON_HOME>/project.db` opens the RIGHT DB, not a
  // fresh empty one.
  const config = resolveBootConfig(process.env)
  const composer = await loadGraphComposerFromEnv()
  // …and it must not SILENTLY serve a healthz-only shell where a real product
  // is expected. With no injected composer module the gateway entrypoint only
  // exposes /healthz — legitimate for a bare dev gateway, but a footgun on an
  // Open self-host box (which should run `bun start` → open/server.ts for the
  // full onboarding+chat product). If the resolved DB already exists on disk
  // (an installed Open box), say so loudly rather than booting a bare shell.
  if (composer === undefined && config.role === 'open' && existsSync(config.dbPath)) {
    console.warn(
      `[boot] gateway entrypoint: role=open, no NEUTRON_GRAPH_COMPOSER_MODULE, but an ` +
        `existing DB was found at ${config.dbPath}. This entrypoint serves ONLY /healthz. ` +
        `For the full Open onboarding+chat product run \`bun start\` (open/server.ts). ` +
        `Booting the /healthz shell against ${config.dbPath}.`,
    )
  }
  await boot(composer !== undefined ? { composer, config } : { config })
  // The Bun.serve listener + watchdog setInterval both keep the event loop
  // alive until shutdown() clears them from inside the SIGTERM handler. No
  // additional keep-alive needed.
}
