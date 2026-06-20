/**
 * gateway/boot-helpers.ts — shared boot-time helpers consumed by BOTH
 * the Open boot shell (`gateway/index.ts`) and the injected Managed
 * production composer.
 *
 * Extracted VERBATIM from `gateway/index.ts` (Argus PR #440 r2
 * IMPORTANT 5, 2026-06-12) to break the entry↔composer ESM module cycle
 * STRUCTURALLY. The Managed composer (dynamic-imported via the
 * `NEUTRON_GRAPH_COMPOSER_MODULE` env seam while the entrypoint is
 * suspended at its top-level `await loadGraphComposerFromEnv()`) used
 * to import ~22 helpers back from the ENTRY module — a top-level-await
 * cycle that completes under Bun's current loader but can deadlock
 * under a strict reading of the ESM TLA spec, and prod bun is
 * PATH-pinned, not version-pinned, so a bun upgrade could change the
 * semantics under us. With the helpers in this non-entry module the
 * composer's module graph no longer contains the entry module at all;
 * `gateway/index.ts` re-exports everything here so existing importers
 * (tests, e2e walk boots) are unaffected. The real-entry subprocess
 * test in `gateway/__tests__/graph-composer-env-seam.test.ts` keeps
 * pinning the boot-through-the-seam behaviour either way.
 *
 * Everything in this file is Open-classified and import-clean of
 * Managed dirs — the same boundary contract as gateway/index.ts.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectDb } from '../persistence/index.ts'
// Connect API types come from `runtime/connect-handlers.ts` as
// structural aliases; the Managed concrete types in `connect/api/`
// structurally satisfy them. Keeps this helper module off the
// Managed-tier import edge.
import type {
  ConnectAuthContext,
  ProjectRef,
} from '../runtime/connect-handlers.ts'
import type { MaxOAuthClientConfig } from '../auth/max-oauth.ts'
import type { CompositionInput } from './composition.ts'
// Type-only alias for the canonical task-store shared across the
// production composer (the composer's dynamic `import('../tasks/store.ts')`
// at its surfaces block is unaffected).
import type { TaskStore as TaskStoreType } from '../tasks/store.ts'
import type { CoreBackendFactoryMap } from './cores/install-bundled.ts'
import type {
  TasksChatOwnerDeps,
  TasksChatRouterDepsResolver,
} from './cores/tasks-chat-router.ts'

/**
 * Per-process Tasks Core deps registry. The `tasks_core` factory
 * populates this map as Cores install; the chat-router resolves
 * deps by project_slug at inbound-event time. Public so tests can
 * pre-populate or assert membership.
 */
export interface TasksCoreOwnerRegistry {
  set(project_slug: string, deps: TasksChatOwnerDeps): void
  get(project_slug: string): TasksChatOwnerDeps | undefined
  asResolver(): TasksChatRouterDepsResolver
}

export function createTasksCoreOwnerRegistry(): TasksCoreOwnerRegistry {
  const map = new Map<string, TasksChatOwnerDeps>()
  return {
    set: (slug, deps) => {
      map.set(slug, deps)
    },
    get: (slug) => map.get(slug),
    asResolver: () => ({
      async resolve(slug: string): Promise<TasksChatOwnerDeps | null> {
        return map.get(slug) ?? null
      },
    }),
  }
}

/**
 * Default upstream port used by the per-instance systemd unit when no
 * `--port=N` argv flag and no `NEUTRON_PORT` env override are set. The S5
 * unit template's ExecStart always passes `--port=<allocated>`, so this
 * default only fires under direct `bun run gateway/index.ts` dev runs.
 */
const DEFAULT_LISTEN_PORT = 7_800

/**
 * Resolve the platform instances-registry SQLite path. The per-instance
 * gateway opens this read-only at boot to (a) look up its own
 * `internal_handle` keyed by `url_slug` and (b) wire the JWT
 * slug-history shim against the live `slug_history` table.
 *
 * Resolution order mirrors the provisioning CLI's `defaultRegistryDbPath`
 * (with one extra legacy fallback) so a fresh instance unit picks up the
 * same registry as the orchestrator that provisioned it:
 *
 *   1. `NEUTRON_REGISTRY_DB_PATH` env (explicit override — canonical name)
 *   2. `<NEUTRON_HOME>/registry.db` (production: /srv/neutron/registry.db)
 *   3. `NEUTRON_REGISTRY_DB_PATH_RW` env (legacy pre-2026-05-09 name —
 *      composer-side resolvers also accept this; mirrored here so OLD
 *      instance units that ONLY export `_RW` don't crash at boot before
 *      the composer fallbacks even run. `deploy-update.sh` does not
 *      re-render existing per-instance service unit files, so until an
 *      operator re-provisions every unit we must read this. Emits a
 *      one-shot deprecation warning.)
 *   4. `~/.local/share/neutron/registry.db` (dev fallback)
 */
let warnedLegacyRegistryDbPathRw = false
export function resolveRegistryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['NEUTRON_REGISTRY_DB_PATH']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const home = env['NEUTRON_HOME']
  if (home !== undefined && home !== '') return join(home, 'registry.db')
  const legacy = env['NEUTRON_REGISTRY_DB_PATH_RW']
  if (legacy !== undefined && legacy !== '') {
    if (!warnedLegacyRegistryDbPathRw) {
      warnedLegacyRegistryDbPathRw = true
      console.warn(
        '[gateway] NEUTRON_REGISTRY_DB_PATH unset; using legacy NEUTRON_REGISTRY_DB_PATH_RW. Re-render this instance unit via `owner-create.sh` to drop the legacy var.',
      )
    }
    return legacy
  }
  return join(homedir(), '.local', 'share', 'neutron', 'registry.db')
}

/**
 * Look up the boot instance's registry row with an `internal_handle` fallback.
 *
 * Primary path: `requested_slug` matches the row's `url_slug`. This is the
 * common case — the systemd unit's `NEUTRON_INSTANCE_SLUG` env (or the
 * `<owner_home>/.url_slug` file the rename orchestrator writes) holds the
 * current user-visible slug.
 *
 * Fallback path: the unit was booted with a stale value that still matches
 * the frozen `internal_handle` (e.g. `t-aaaaaaaa`). This happens when an
 * orchestrator slug-rename updates the registry's `url_slug` but the
 * per-instance systemd unit's slug env / .url_slug file is
 * not regenerated in lockstep — the unit's instance name is keyed to
 * `internal_handle` (correctly, since handles are stable across renames),
 * so it can still find the row by handle. The composer canonicalises
 * `project_slug` to the row's `url_slug` and the caller logs a one-line
 * WARN telling the operator to regenerate the drop-in.
 *
 * Both lookups miss → throw. Refuse to boot rather than disable the
 * JWT slug-history shim / connect routing silently.
 *
 * Incident of record: 2026-05-10, live instance renamed from
 * its frozen `internal_handle` to a custom `url_slug`; the per-instance unit's
 * `NEUTRON_INSTANCE_SLUG` (still the handle) was not regenerated, so the gateway
 * crash-looped on every restart for 41+ cycles before a manual
 * `slug-rename.conf` drop-in landed. See
 * `docs/solutions/runtime-errors/instance-slug-rename-systemd-unit-stale.md`.
 */
/**
 * Sprint B (2026-05-20) — structural alias for the subset of the Managed
 * `OwnersRegistry.OwnerRow` this boot shell reads (boot fingerprint,
 * recover handler's owner check). The Managed concrete `OwnerRow` ships
 * additional bookkeeping columns this file never inspects; structural
 * typing closes the gap without a provisioning-module import edge.
 */
export interface BootOwnerRow {
  internal_handle: string
  url_slug: string
  owner_user_id?: string | null
}

/**
 * Structural alias for the registry methods the boot shell actually
 * invokes (`getBySlug` + `getByInternalHandle`). The Managed concrete
 * `OwnersRegistry` (constructed via the dynamic
 * provisioning-module registry import at composer-build time)
 * structurally satisfies this alias.
 */
export interface BootOwnersRegistry {
  getBySlug(url_slug: string): BootOwnerRow | undefined
  getByInternalHandle(internal_handle: string): BootOwnerRow | undefined
}

export interface OwnerRegistryLookupResult {
  /** The canonical user-visible slug. Equal to `requested_slug` on the
   *  primary path; equal to the row's `url_slug` on the fallback path. */
  project_slug: string
  /** The registry row. */
  row: BootOwnerRow
  /** True iff we fell back from `getBySlug` to `getByInternalHandle`. */
  fallback_used: boolean
}

export function resolveOwnerRegistryRow(input: {
  requested_slug: string
  registry: BootOwnersRegistry
  registry_db_path: string
  /** Override logger for tests. Defaults to console.warn. */
  warn?: (msg: string) => void
}): OwnerRegistryLookupResult {
  const bySlug = input.registry.getBySlug(input.requested_slug)
  if (bySlug !== undefined) {
    return { project_slug: input.requested_slug, row: bySlug, fallback_used: false }
  }
  const byHandle = input.registry.getByInternalHandle(input.requested_slug)
  if (byHandle !== undefined) {
    const canonical = byHandle.url_slug
    const warn = input.warn ?? ((m: string) => console.warn(m))
    warn(
      `[gateway] project_slug arg was internal_handle, resolved to url_slug=${canonical}; the systemd unit's NEUTRON_INSTANCE_SLUG env / .url_slug file should be regenerated to match — see scripts/install/regenerate-owner-slug-dropin.sh`,
    )
    return { project_slug: canonical, row: byHandle, fallback_used: true }
  }
  throw new Error(
    `[composer] project=${input.requested_slug} not found in registry at ${input.registry_db_path} — refuse to boot rather than disable the JWT slug-history shim silently. Tried getBySlug + getByInternalHandle fallback; both missed.`,
  )
}

/**
 * Resolve the listening port. Precedence (highest wins):
 *   1. explicit `BootOptions.port` (test injection — `0` requests random).
 *   2. `--port=<N>` on `process.argv` (the S5 systemd unit ExecStart shape).
 *   3. `NEUTRON_PORT` env var.
 *   4. fallback `DEFAULT_LISTEN_PORT`.
 *
 * NaN / non-integer / out-of-range values throw at boot — better to brick
 * loudly here than let systemd Restart-loop a misconfigured unit.
 */
export function resolveListenPort(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  override?: number,
): number {
  if (override !== undefined) return assertPort(override, '<BootOptions.port>')
  for (const a of argv) {
    if (a.startsWith('--port=')) {
      const raw = a.slice('--port='.length)
      const parsed = Number.parseInt(raw, 10)
      if (Number.isNaN(parsed) || String(parsed) !== raw.trim()) {
        throw new Error(`invalid --port=${raw}: not an integer`)
      }
      return assertPort(parsed, '--port')
    }
  }
  const fromEnv = env['NEUTRON_PORT']
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = Number.parseInt(fromEnv, 10)
    if (Number.isNaN(parsed) || String(parsed) !== fromEnv.trim()) {
      throw new Error(`invalid NEUTRON_PORT=${fromEnv}: not an integer`)
    }
    return assertPort(parsed, 'NEUTRON_PORT')
  }
  return DEFAULT_LISTEN_PORT
}

function assertPort(p: number, label: string): number {
  if (!Number.isInteger(p) || p < 0 || p > 65_535) {
    throw new Error(`invalid ${label}=${p}: must be an integer in [0, 65535]`)
  }
  return p
}

/** Default window to retry an EADDRINUSE on a configured port before failing
 *  loud. Sized to ride out a previous server still releasing the socket during
 *  a restart (graceful-drain + supervisor relaunch overlap), not to mask a
 *  genuinely-occupied port. */
const DEFAULT_PORT_BIND_RETRY_WINDOW_MS = 8_000
/** Delay between EADDRINUSE retries within the window. */
const DEFAULT_PORT_BIND_RETRY_INTERVAL_MS = 200

/** Minimal structural surface of a bound `Bun.serve` server the bind helper
 *  hands back. `port` is `number | undefined` only because Bun's typed surface
 *  marks it so for non-TCP transports; a port-bound HTTP server always sets it. */
export interface BoundHttpServer {
  port?: number | undefined
  stop: (force?: boolean) => void | Promise<void>
}

function isAddrInUse(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  if ((err as { code?: unknown }).code === 'EADDRINUSE') return true
  const msg = (err as { message?: unknown }).message
  return (
    typeof msg === 'string' &&
    /EADDRINUSE|address already in use|is port .*in use/i.test(msg)
  )
}

/**
 * Bind the HTTP listener DETERMINISTICALLY (#314).
 *
 * `serve` is a thunk that performs the actual `Bun.serve({ port, … })` (kept a
 * thunk so the caller retains full inline typing of the fetch/websocket
 * handlers). Behaviour by `port`:
 *
 *   - `port === 0` — the genuine "pick any free port" case (dev/tests pass
 *     `--port=0` / `BootOptions.port = 0`). Single attempt; the OS auto-selects.
 *
 *   - `port !== 0` — an explicitly-resolved port (NEUTRON_PORT / --port, or the
 *     fixed 7800 default). Bind it and ONLY it: on EADDRINUSE, retry on a short
 *     backoff through a bounded window — the common cause is the prior process
 *     still releasing the socket during a restart — then FAIL LOUD with a clear,
 *     actionable error if it is still held. We NEVER silently fall back to a
 *     random port, because the owner's bookmarked URL is pinned to this port.
 *
 * Non-EADDRINUSE errors are rethrown immediately (never retried) so real boot
 * faults surface fast instead of being masked by the retry window.
 */
export async function bindHttpListener(opts: {
  port: number
  serve: () => BoundHttpServer
  retryWindowMs?: number
  retryIntervalMs?: number
  /** Injectable sleep (tests). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable monotonic clock in ms (tests). Defaults to `Date.now`. */
  now?: () => number
  /** Retry-notice logger. Defaults to `console.warn`. */
  warn?: (msg: string) => void
}): Promise<BoundHttpServer> {
  // No port explicitly configured: auto-select. dev/tests rely on this.
  if (opts.port === 0) return opts.serve()

  const windowMs = opts.retryWindowMs ?? DEFAULT_PORT_BIND_RETRY_WINDOW_MS
  const intervalMs = opts.retryIntervalMs ?? DEFAULT_PORT_BIND_RETRY_INTERVAL_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? ((): number => Date.now())
  const warn = opts.warn ?? ((m: string): void => console.warn(m))

  const startedAt = now()
  let attempts = 0
  for (;;) {
    attempts += 1
    try {
      return opts.serve()
    } catch (err) {
      if (!isAddrInUse(err)) throw err
      if (now() - startedAt >= windowMs) {
        throw new Error(
          `[gateway] port ${opts.port} is already in use after retrying for ` +
            `${windowMs}ms (${attempts} attempts). Another process is bound to it — ` +
            `stop it (e.g. \`neutron stop\`, or kill the old server) or set NEUTRON_PORT ` +
            `to a free port. Refusing to silently bind a different port (#314).`,
        )
      }
      warn(
        `[gateway] port ${opts.port} in use (EADDRINUSE) — likely the previous server ` +
          `still releasing the socket; retrying for up to ${windowMs}ms…`,
      )
      await sleep(intervalMs)
    }
  }
}

/**
 * Optional per-boot composition hook — production callers pass a function
 * that returns the modules + supplied dependencies (notifier shims, topic
 * handler, etc.). When omitted, boot only opens the DB + sends READY=1 +
 * starts the watchdog tick — same shape as Sprint 4 — so the boot shell
 * stays minimal in dev.
 *
 * The hook receives the live `ProjectDb` + the resolved `project_slug` and
 * returns a `CompositionInput` that has its dispatcher / notifier shims
 * wired. The shape lets the test harness (and S5+ production) compose a
 * graph without changing the boot shell.
 */
export type GraphComposer = (input: { db: ProjectDb; project_slug: string }) =>
  | CompositionInput
  | Promise<CompositionInput>

/**
 * The HTTP handler signature shared by the default healthz stub and the
 * production composition's wired surfaces (connect API, identity
 * callback, channels webhook).
 */
export type HttpHandler = (req: Request) => Response | Promise<Response>

/**
 * Per-instance `list_projects` resolver: returns the real ProjectRef[]
 * surfaced via `GET /connect/v1/projects`. The default scans the
 * local `topics` table for distinct non-null `project_id`s — the only
 * place per-instance project metadata exists in P1 (the dedicated projects
 * table lands in P3 alongside Cores). Each row maps to a ProjectRef
 * owned by THIS instance. Open is single-owner, so the resolver is
 * always `kind:'solo'`; the Managed composer wraps this for its
 * workspace-instances (where the surface advertises `kind:'group'`).
 *
 * Tests inject a fake to assert the wired path is reached without
 * standing up a real per-instance DB with seed topics.
 */
export type ListProjectsResolver = (
  ctx: ConnectAuthContext,
  deps: { db: ProjectDb; project_slug: string },
) => Promise<ProjectRef[]>

/**
 * Default real-mode resolver. Scans the per-instance `topics` table for
 * DISTINCT non-null `project_id`s where at least one topic is `active`
 * and projects them into the connect API's `ProjectRef` shape.
 * P1 schema (migration 0004) gives each topic an optional `project_id`
 * column populated by the solo→group promotion path; that column is
 * the canonical source of truth for "which projects does this instance
 * own" until P3 ships a dedicated table.
 *
 * Codex r1 P1 fix (Sprint 10): filter out `status IN ('archived',
 * 'deleted')` topics. Promote/reverse-promote intentionally leaves
 * the source-side topic rows behind with `status='archived'` so the
 * old id mapping survives for stable audit; without the filter, those
 * archived rows would surface a project_id whose only remaining
 * topics are tombstones (e.g. a solo project after it's been promoted
 * into a workspace). The active-projection avoids advertising those
 * ghosts.
 *
 * ISSUES #95 (2026-06-05): resolve `display_name` from the canonical
 * `projects` table (LEFT JOIN on `project_id = projects.id`) instead of
 * echoing the opaque `project_id` back as the name. Onboarding's
 * `03-project-shells` now writes a real `projects` row (named) per
 * confirmed project, so the sidebar shows "Northwind" / "Topline" rather
 * than a UUID. `COALESCE` falls back to the `project_id` for legacy
 * promote-path topics that have no `projects` row yet, and the join
 * filters out projects the Settings Core soft-deleted
 * (`deleted_at` non-null, migration 0053) so a deleted project doesn't
 * linger in the sidebar.
 */
export const defaultListProjects: ListProjectsResolver = async (
  _ctx,
  deps,
) => {
  const rows = deps.db
    .raw()
    .prepare(
      `SELECT DISTINCT t.project_id AS project_id, p.name AS name
         FROM topics t
         LEFT JOIN projects p
           ON p.id = t.project_id AND p.deleted_at IS NULL
        WHERE t.project_id IS NOT NULL
          AND t.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM projects d
             WHERE d.id = t.project_id AND d.deleted_at IS NOT NULL
          )
        ORDER BY t.project_id`,
    )
    .all() as Array<{ project_id: string; name: string | null }>
  return rows.map((r) => ({
    project_id: r.project_id,
    display_name:
      typeof r.name === 'string' && r.name.length > 0 ? r.name : r.project_id,
    kind: 'solo' as const,
    owning_instance_slug: deps.project_slug,
  }))
}

/**
 * Resolve the per-instance data dir (`<owner_home>`). Honors `OWNER_HOME`
 * when explicitly set; otherwise derives from `NEUTRON_DB_PATH` via the
 * locked layout `<owner_home>/db/project.db` (so `dirname(dirname(dbPath))`
 * yields owner_home). Dev fallback: `~/.local/share/neutron/` — same shape
 * as `resolveDbPath`'s fallback so the two stay consistent.
 */
export function resolveOwnerHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = env['OWNER_HOME']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const dbPath = env['NEUTRON_DB_PATH']
  if (typeof dbPath === 'string' && dbPath.length > 0) {
    return dirname(dirname(dbPath))
  }
  return join(homedir(), '.local', 'share', 'neutron')
}


/**
 * Resolve the Neutron repo root the bundled-Cores registry walks at
 * boot. Honors `NEUTRON_REPO_ROOT` when explicitly set; otherwise falls
 * back to `process.cwd()` so a local `bun run gateway/index.ts` from
 * the repo top resolves naturally. Per
 * `docs/research/neutron-cores-marketplace-split-2026-05-17.md § 3`
 * (multi-root registry shape — Open returns `[<publicRoot>]`).
 */
export function resolveRepoRoot(env: NodeJS.ProcessEnv): string {
  const fromEnv = env['NEUTRON_REPO_ROOT']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return process.cwd()
}

/**
 * P3 cores wire-up — per-slug backend factories. Each factory builds
 * the `ToolDeps` backend value for the Core's `buildTools(...)`. The
 * production wiring chooses canonical per-instance primitives when
 * available (per-instance TaskStore on project.db, per-instance
 * ReminderStore) and the Core's in-memory reference adapter when the
 * substrate-side primitive isn't yet plumbed (Calendar, Email-Managed
 * — substrate-backed Gmail / Google Calendar clients land in P3+
 * follow-up sprints).
 *
 * The Cores' tool dispatch flows through the runtime's
 * `CapabilityGuard`, so even the in-memory adapter is safe — the
 * audit log records every call, and a tool whose backend hasn't been
 * upgraded surfaces deterministic shape (the test substrate is the
 * exact same code path the unit tests in
 * `cores/free/<slug>/__tests__/` verify).
 */
// `buildEphemeralMemoryStore` (v0.1.0 helper) was deleted when Notes
// Core S1 (2026-05-20) replaced the MemoryStore-adapter backend with a
// per-project NotesStore + resolver. The factory above now constructs
// a single per-instance `NotesStoreResolver` keyed on `owner_home`, so
// Notes writes land in real per-project SQLite sidecars under
// `<owner_home>/Projects/<project_id>/notes/notes.db` and survive
// reboots without further wiring.

/**
 * S1 — load a named Shape-C pattern body from `prompts/reminder-patterns.md`.
 * Threaded into the Reminders Core's smart-wrap composer via the
 * factory map below. Tests inject stubs; production reads from disk.
 *
 * Locked names match `REMINDER_PATTERN_NAMES` in
 * `@neutronai/reminders-core/smart-wrap`. The patterns file lays each
 * named pattern out as a `## Pattern: <name>` section with the template
 * body inside a triple-backtick code block whose first line is
 * `PATTERN: <name>`. We extract everything from the `PATTERN: <name>`
 * line through the closing ``` of that block.
 */
/**
 * S1 — chain multiple `ChatCommandFilter` instances into one. Each
 * inner filter peeks at the inbound; the first to claim ownership (by
 * returning a non-null result) wins, the rest fall through. New Tier 1
 * Cores append their per-Core filter to the chain in
 * `gateway/index.ts` as they ship — Notes ships `createNotesChatCommandFilter`,
 * Reminders ships `buildRemindersChatCommandFilter` (below), Tasks Core
 * S1 will ship its own follow-up.
 */
export function buildChainedChatCommandFilter(
  filters: ReadonlyArray<import('./http/app-ws-surface.ts').ChatCommandFilter>,
): import('./http/app-ws-surface.ts').ChatCommandFilter {
  return {
    async match(input) {
      for (const filter of filters) {
        try {
          const result = await filter.match(input)
          if (result !== null) return result
        } catch (err) {
          // Single filter throwing must NOT poison the chain — fall
          // through to the next so a Notes-side bug never blocks the
          // /remind path (and vice versa). The surface itself catches
          // throws from the chain root too; this catch belt-and-
          // suspenders the per-filter boundary.
          console.warn(
            `[chat-command-filter] chained filter threw — falling through: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
      return null
    },
  }
}

/**
 * S1 — Reminders-Core `/remind` filter. Mirrors Notes Core's
 * `createNotesChatCommandFilter` shape (interface with a `match()`
 * method) so the chain composer above can treat both filters
 * interchangeably. The factory binds the substrate-backed adapter +
 * the smart-wrap composer; the closure handles every `/remind`
 * sub-command via `parseAndExecuteRemindCommand` from
 * `@neutronai/reminders-core`.
 */
export function buildRemindersChatCommandFilter(deps: {
  backend: import('@neutronai/reminders-core').RemindersBackend
  smartWrap: import('@neutronai/reminders-core').SmartWrapComposer
}): import('./http/app-ws-surface.ts').ChatCommandFilter {
  return {
    async match(input) {
      const trimmed = input.body.trimStart()
      if (!trimmed.startsWith('/remind')) return null
      const { parseAndExecuteRemindCommand } = await import('@neutronai/reminders-core')
      const response = await parseAndExecuteRemindCommand(input.body, {
        backend: deps.backend,
        ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
        user_id: input.user_id,
        smartWrap: deps.smartWrap,
      })
      if (response === null) return null
      const out: import('./http/app-ws-surface.ts').ChatCommandFilterResult = {
        text: response.text,
      }
      if (response.data !== undefined) out.data = response.data
      if (response.deep_link !== undefined) out.deep_link = response.deep_link
      if (response.error !== undefined) out.error = response.error
      return out
    },
  }
}

/**
 * Trident-port PR-5 — the `/code` chat-command filter, REWIRED onto
 * foundational Trident. This supersedes `buildCodegenChatCommandFilter`
 * (below): instead of dispatching into the Code-Gen Core's separate
 * `CodegenOrchestrator` + in-memory tracker + sidecar, `/code <task>`
 * simply CREATES a `code_trident_runs` row via the per-instance
 * `TridentRunStore` and returns — the foundational tick loop
 * (`buildTridentOrchestrator`, wired in `build-core-modules.ts` from
 * `input.trident.dispatch`) picks the row up and drives it through
 * forge-init → argus → fix loop → merge (per git-mode) → done. State
 * lives in SQLite, so a `/code` build survives a control-plane restart
 * and resumes from its persisted phase.
 *
 * The composer threads `resolve_context(input)` — given the inbound
 * envelope (project_id / user_id / project_slug), it returns the
 * `TridentCodeContext` (store + project_slug + repo_path + the git-mode /
 * Ralph detection seams). Returning `null` means "no `/code` build target
 * for this project" → the filter replies with a friendly unavailable
 * message rather than throwing.
 */
export function buildTridentCodeChatCommandFilter(deps: {
  resolve_context: (input: {
    project_id: string
    project_slug: string
    user_id: string
    channel_topic_id: string
  }) =>
    | import('../trident/code-command.ts').TridentCodeContext
    | null
    | Promise<import('../trident/code-command.ts').TridentCodeContext | null>
  default_project_id?: string
  /** Message when `resolve_context` yields null (no build target wired). */
  unavailable_message?: string
}): import('./http/app-ws-surface.ts').ChatCommandFilter {
  const default_pid = deps.default_project_id ?? 'default'
  const unavailable =
    deps.unavailable_message ??
    '`/code` is not available for this project — no repository is wired for autonomous builds here.'
  return {
    async match(input) {
      const trimmed = input.body.trimStart()
      if (!trimmed.startsWith('/code')) return null
      const { parseAndExecuteCodeCommand, parseCodeCommand } = await import('../trident/code-command.ts')
      const ctx = await deps.resolve_context({
        project_id: input.project_id ?? default_pid,
        project_slug: input.project_slug,
        user_id: input.user_id,
        channel_topic_id: input.channel_topic_id,
      })
      if (ctx === null) {
        // Still claim the `/code` command (don't fall through to the LLM)
        // but answer honestly. `/code help` works with no context too.
        const parsed = parseCodeCommand(input.body)
        if (parsed.kind === 'help') return { text: unavailable }
        return { text: unavailable, error: { code: 'unavailable', message: 'no build target' } }
      }
      const response = await parseAndExecuteCodeCommand(input.body, ctx)
      if (response === null) return null
      const out: import('./http/app-ws-surface.ts').ChatCommandFilterResult = {
        text: response.text,
      }
      if (response.data !== undefined) out.data = response.data
      if (response.error !== undefined) out.error = response.error
      return out
    },
  }
}

/**
 * S2 (Code-Gen Core, 2026-05-22) — `/code` chat-command filter.
 *
 * SUPERSEDED by `buildTridentCodeChatCommandFilter` (Trident-port PR-5):
 * `/code` is now a thin entry into foundational Trident, not the Code-Gen
 * Core wrapper's separate orchestration path. Retained only for the
 * Core's legacy MCP-tool path + its existing tests; new production `/code`
 * wiring routes through the Trident filter above.
 *
 * The production composer assembles the orchestrator + sidecar + chat
 * notifier via `buildCodegenWiring(...)` (in
 * `cores/free/code-gen/src/wiring-production.ts`) and threads the
 * resulting `build_chat_command_context` factory through here. The
 * filter peeks at the inbound body, mints a per-request context via
 * the factory, and dispatches through `parseAndExecuteCodeCommand`.
 *
 * The pre-S2 deps surface (reviewer / merger / llm / gh_runner /
 * orchestrator-passed-directly) was removed when the wiring layer
 * landed — the factory owns all of those now.
 */
export function buildCodegenChatCommandFilter(deps: {
  build_chat_command_context: (input: {
    project_id: string
    user_id: string
  }) => import('@neutronai/codegen-core').CodeCommandContext
  default_project_id?: string
}): import('./http/app-ws-surface.ts').ChatCommandFilter {
  const default_pid = deps.default_project_id ?? 'default'
  return {
    async match(input) {
      const trimmed = input.body.trimStart()
      if (!trimmed.startsWith('/code')) return null
      const { parseAndExecuteCodeCommand } = await import('@neutronai/codegen-core')
      const ctx = deps.build_chat_command_context({
        project_id: input.project_id ?? default_pid,
        user_id: input.user_id,
      })
      const response = await parseAndExecuteCodeCommand(input.body, ctx)
      if (response === null) return null
      const out: import('./http/app-ws-surface.ts').ChatCommandFilterResult = {
        text: response.text,
      }
      if (response.data !== undefined) out.data = response.data
      if (response.deep_link !== undefined) out.deep_link = response.deep_link
      if (response.error !== undefined) out.error = response.error
      return out
    },
  }
}

export function readPatternFromPrompts(name: string): string {
  // We deliberately read the RAW file (no substituteTemplate call)
  // so `{{OWNER_HOME}}` tokens survive into the persisted message
  // body — preserving forward-compat with home-token renames (exactly
  // what saved us at the C4-a2 {{OWNER_HOME}}→{{OWNER_HOME}} rename:
  // pre-rename bodies still resolve via the template alias) and
  // matching the brief § 3.5 "composer stores the un-substituted
  // literal" lock. The fire-time agent's prompt loader substitutes at
  // fire time via @neutronai/prompts/template.ts.
  const promptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')
  const content = readFileSync(join(promptsDir, 'reminder-patterns.md'), 'utf8')
  const header = `PATTERN: ${name}`
  const idx = content.indexOf(header)
  if (idx === -1) {
    throw new Error(`unknown reminder pattern '${name}'`)
  }
  // Walk backwards to the opening ```; forwards to the closing ```.
  // The pattern body lives between (exclusive of) these fences.
  const openFence = content.lastIndexOf('```', idx)
  const closeFence = content.indexOf('\n```', idx)
  if (openFence === -1 || closeFence === -1 || closeFence < idx) {
    throw new Error(`malformed pattern block for '${name}'`)
  }
  const start = content.indexOf('\n', openFence) + 1
  return content.slice(start, closeFence).trimEnd()
}

export async function buildCoresBackendFactories(
  opts: {
    projectDb: ProjectDb
    /**
     * Canonical `TaskStore` shared across the production composer.
     * When provided, the Tasks-Core adapter binds to THIS instance so
     * Core-driven writes fire the projection writer + reminder-link
     * subscribers attached by `tasksModule.init`.
     */
    canonicalTaskStore?: TaskStoreType
    /**
     * Per-instance data dir. Notes Core uses this to resolve the per-
     * project sidecar path
     * `<owner_home>/Projects/<project_id>/notes/notes.db`.
     */
    owner_home: string
    /**
     * Notes Core's per-instance store resolver. Shared between the
     * Core's MCP-tool factory + the drawer-browser HTTP surface so a
     * single set of SQLite handles serves every request (so chat
     * `/note` captures and drawer-browser reads land on the same
     * SQLite file).
     */
    notesResolver: import('../cores/free/notes/index.ts').NotesStoreResolver
    /**
     * Default project_id used by the legacy 4 `notes_*` MCP tools
     * when the caller omits `project_id`. v1 uses the literal
     * `default` slug; the per-project router (P5.4 pattern) will swap
     * this in once tool-call context carries the active project.
     */
    notesDefaultProjectId: string
    /**
     * Email-Managed Core's per-instance per-project cache resolver.
     * Shared with the chat-command filter so triage audits and draft
     * audits captured via `/email ...` land in the same SQLite file
     * the Core's MCP tools read from.
     */
    emailResolver: import('../cores/free/email/index.ts').EmailProjectCacheResolver
    /**
     * Email-Managed Core's OAuth token accessor. When present, the
     * backend factory wires the production Gmail v1 REST client with
     * lazy bearer-token resolution via this closure (the same
     * OAuthTokenManager instance the Cores OAuth surface writes to).
     * When `undefined`, the factory falls back to the in-memory
     * Gmail client so install still succeeds for dev / Open-tier
     * instances without OAuth client envs threaded through.
     */
    emailOAuthTokens?: import('./cores/oauth-token-manager.ts').OAuthTokenManager
    /**
     * Pluggable LLM call for the Email-Managed Core's Haiku-driven
     * triage + summarizer agents. v1 ships a deterministic stub
     * (the in-process composer + chat-bridge supplies the real
     * Haiku-fast call when wired); tests inject their own.
     */
    emailLlm?: (prompt: string) => Promise<string>
    /** Resolved Haiku-fast model id (from `@neutronai/runtime`). */
    emailModel?: string
    /**
     * Tasks Core S1 — per-process Tasks Core deps registry. The
     * `tasks_core` factory stashes the wrapped `{store, pickNext}`
     * here so the chat-router can resolve deps at inbound-event time
     * by project_slug.
     */
    tasksCoreRegistry?: TasksCoreOwnerRegistry
    /**
     * Tasks Core S1 — LLM client for the pick-next service. The
     * production composer wires the `claude-runner` Sonnet 4.6 with
     * Haiku 4.5 fallback path; tests inject `buildStubPickNextLlmClient`.
     */
    pickNextLlmClient?: import('@neutronai/tasks-core').PickNextLlmClient
    /**
     * Calendar Core S1 (2026-05-20) — lazy OAuth access-token
     * resolver. When supplied AND non-null, the `calendar_core` +
     * future Google-backed factories wire `buildGoogleCalendarClient`
     * with this accessor; transparent refresh flows through the
     * shared `OAuthTokenManager`. When omitted OR null (Managed
     * instances without Google OAuth setup, Open self-host without
     * `NEUTRON_CORES_GOOGLE_CLIENT_ID`), the factory falls back to
     * `buildInMemoryCalendarClient` so dev boot + install lifecycle
     * tests continue to install the Core (it just dispatches against
     * an empty calendar).
     */
    googleOAuthAccessToken?:
      | null
      | ((label: string) => Promise<string | null>)
    /**
     * Calendar Core S1 (Argus r2 BLOCKER #1 follow-up) — pre-built
     * `CalendarClient` instance. When supplied, the `calendar_core`
     * factory returns THIS instance verbatim instead of constructing
     * its own. The gateway boot uses this seam so the same client
     * powers (a) the Core's MCP tool surface, (b) the `/cal`
     * chat-command filter, and (c) the pre-meeting-brief scheduler —
     * all three reach the same underlying Google v3 REST wrapper (or
     * in-memory fallback).
     */
    calendarClient?: import('@neutronai/calendar-core').CalendarClient
    /**
     * Research Core S1 — pre-built per-instance project backend. The
     * production composer constructs ONE
     * `buildProjectResearchOrchestrator(...)` instance against the
     * shared `ResearchStoreResolver`, runtime substrate, sub-agent
     * dispatcher, and concurrency gate; the install-bundled factory
     * MUST reuse it so the MCP-tool surface and the chat-bridge
     * `/research` filter land on the SAME per-project SQLite files +
     * the SAME runtime LLM call. Closes Argus r1 BLOCKER #4 (canned
     * substrate would otherwise throw on the first synthesize()).
     */
    researchProjectBackend?: import('@neutronai/research-core').ResearchProjectBackend
    /**
     * Code-Gen Core S2 — pre-built `CodegenOrchestrator` from
     * `buildCodegenWiring(...)`. When supplied, the `codegen_core`
     * factory returns THIS instance so the MCP tools + the `/code`
     * chat-command filter share one runner + one per-project sidecar
     * resolver. When omitted, the factory falls back to a skeleton
     * runner-backed orchestrator (Tier 1 safe-install behavior).
     */
    codegenOrchestrator?: import('@neutronai/codegen-core').CodegenOrchestrator
    /**
     * Settings Core (2026-06-03) — agent profile read/write seam
     * for `update_personality` / `update_agent_name`. The per-instance
     * gateway opens registry.db READ-ONLY at boot, so the production
     * composer threads an RW-backed `AgentProfileBackend` here (built
     * against `NEUTRON_REGISTRY_DB_PATH`, the same seam the persona-sync
     * onboarding hook uses). When omitted (registry RW path unavailable),
     * the factory wires a no-op profile so the project tools still
     * install + work and the profile tools fail soft.
     */
    agentSettingsProfile?: import('@neutronai/agent-settings').AgentProfileBackend
    /**
     * Settings Core (2026-06-03) — Telegram side-effect sink for
     * confirmations + forum-topic retitle/archive. Best-effort; a
     * Telegram failure never rolls back the committed DB mutation. When
     * omitted, the factory wires a no-op sink (the DB mutation still
     * lands; no confirmation is sent).
     */
    agentSettingsTelegram?: import('@neutronai/agent-settings').AgentSettingsTelegram
    /**
     * Settings Core — Item 3 (2026-06-10) resumable Telegram
     * connect. Mints a fresh one-time bind deep link for the
     * `connect_telegram` tool via the SAME mint path the wow handoff
     * uses. When omitted (NEUTRON_TELEGRAM_BIND_SECRET unwired), the
     * tool reports the honest CONNECT_TELEGRAM_UNAVAILABLE_ERROR.
     */
    agentSettingsBindLink?: import('@neutronai/agent-settings').TelegramBindLinkMinter
  },
): Promise<CoreBackendFactoryMap> {
  const {
    projectDb,
    canonicalTaskStore,
    notesResolver,
    notesDefaultProjectId,
    emailResolver,
    emailOAuthTokens,
    emailLlm,
    emailModel,
    tasksCoreRegistry,
    pickNextLlmClient,
    researchProjectBackend,
    codegenOrchestrator: codegenOrchestratorFromOpts,
  } = opts
  const googleOAuthAccessToken = opts.googleOAuthAccessToken ?? null
  const preBuiltCalendarClient = opts.calendarClient ?? null
  return {
    // Notes — Notes Core S1 (2026-05-20): per-project SQLite sidecar
    // at `<owner_home>/Projects/<project_id>/notes/notes.db`. The
    // legacy `notes_*` MCP tools route through `buildNotesStoreBackend`
    // against the per-instance resolver; new tools (drawer/search/etc.)
    // resolve project scope explicitly via the same resolver instance.
    notes: async () => {
      const mod = await import('@neutronai/notes')
      return {
        backend: mod.buildNotesStoreBackend({
          resolver: notesResolver,
          default_project_id: notesDefaultProjectId,
        }),
      }
    },
    tasks_core: async ({ project_slug }) => {
      // Wire the Core's tool surface to the SAME canonical task store
      // that backs the app's `/api/app/projects/<id>/tasks` and
      // `/api/app/focus` HTTP surfaces, AND attach the projection /
      // reminder-link subscribers `tasksModule.init` registered against
      // that store. Without both seams, `tasks_create` writes through
      // the Core would either land in a process-local in-memory store
      // invisible to the HTTP surfaces, or in a subscriber-free store
      // that bypasses STATUS.md projection entirely. Same pattern
      // Reminders Core uses (`buildReminderStoreBackend` below).
      const mod = await import('@neutronai/tasks-core')
      const store = mod.buildSubstrateTaskStoreBackend({
        project_slug,
        projectDb,
        ...(canonicalTaskStore !== undefined ? { store: canonicalTaskStore } : {}),
      })
      // Tasks Core S1 — build the LLM-driven pick-next service. Tests
      // inject the deterministic stub; the production composer wires
      // the live Sonnet-fallback client. `pickNext` rides through
      // `normalizeBackend` because `'store'` is in the canonical
      // backend-key list (see gateway/cores/install-bundled.ts:861) —
      // the object is passed through verbatim to `buildTools(deps)`.
      const llm = pickNextLlmClient ?? mod.buildStubPickNextLlmClient()
      const pickNext = mod.buildPickNextService({ store, llm })
      if (tasksCoreRegistry !== undefined) {
        tasksCoreRegistry.set(project_slug, { store, pickNext })
      }
      return { store, pickNext }
    },
    reminders_core: async ({ project_slug }) => {
      const mod = await import('@neutronai/reminders-core')
      return {
        backend: mod.buildReminderStoreBackend({
          project_slug,
          projectDb,
        }),
        // S1 — Shape A / B / C composer threaded into the production
        // wiring so the chat-command dispatcher can compose the
        // `message` body BEFORE persisting (deterministic prelude
        // prepend for Shape B; pattern body load + FILL: slot
        // substitution for Shape C; NO LLM call at create time).
        smartWrap: mod.buildSmartWrapComposer({
          loadPattern: (name) => readPatternFromPrompts(name),
        }),
      }
    },
    calendar_core: async () => {
      // Argus r2 BLOCKER #1 — when the gateway boot pre-built a
      // CalendarClient (so the same instance powers the chat-command
      // dispatcher + the pre-meeting-brief scheduler), return it
      // verbatim instead of constructing a second one. Without this
      // seam the Core's MCP tools would dispatch against a SEPARATE
      // in-memory store from the one /cal show / scheduler observe.
      if (preBuiltCalendarClient !== null) {
        return { client: preBuiltCalendarClient }
      }
      const mod = await import('@neutronai/calendar-core')
      // Calendar Core S1 (2026-05-20) — wire the production Google v3
      // REST client whose access-token accessor reads through the
      // shared OAuthTokenManager for transparent refresh. The
      // accessor argument is supplied to this factory ONLY when the
      // Cores OAuth surface mounts (i.e. all four envs were resolved
      // at boot — see gateway/index.ts:3079-3106). Otherwise fall
      // back to the in-memory client so the install pipeline still
      // installs the Core (dispatches against an empty calendar) —
      // preserves the existing __tests__/install-lifecycle.test.ts
      // shape + the dev boot.
      if (googleOAuthAccessToken !== null) {
        return {
          client: mod.buildGoogleCalendarClient({
            accessToken: () => googleOAuthAccessToken(mod.OAUTH_SECRET_LABEL),
          }),
        }
      }
      return { client: mod.buildInMemoryCalendarClient() }
    },
    email_managed_core: async () => {
      // Email-Managed Core S1 (2026-05-20) — wires the production
      // Gmail v1 REST client whose lazy access-token accessor reads
      // through the OAuthTokenManager for transparent refresh. When
      // the Cores OAuth surface is unmounted (envs absent), falls
      // back to the in-memory Gmail client so install pipeline still
      // installs the Core. Identical dual-mode shape Calendar Core
      // mirrors in PR #248's sibling sprint. Per
      // docs/plans/email-managed-core-tier1-brief.md § 4.
      const mod = await import('@neutronai/email-managed-core')
      const client =
        emailOAuthTokens !== undefined
          ? mod.buildGoogleGmailClient({
              accessToken: async () => {
                try {
                  return await emailOAuthTokens.getAccessToken(mod.OAUTH_SECRET_LABEL)
                } catch {
                  return null
                }
              },
            })
          : mod.buildInMemoryGmailClient()
      const factoryDeps: {
        client: import('@neutronai/email-managed-core').GmailClient
        summarizer: import('@neutronai/email-managed-core').EmailSummarizer
        cacheFor: (project_id: string) => Promise<import('@neutronai/email-managed-core').EmailProjectCache>
        llm?: (prompt: string) => Promise<string>
        model?: string
      } = {
        client,
        summarizer: mod.buildStubEmailSummarizer(),
        cacheFor: (project_id) => emailResolver.resolve(project_id),
      }
      if (emailLlm !== undefined) factoryDeps.llm = emailLlm
      if (emailModel !== undefined) factoryDeps.model = emailModel
      return factoryDeps
    },
    research_core: async () => {
      // Argus r1 BLOCKER #3 + #4: the composer ALWAYS threads the real
      // per-instance project backend through here so the MCP tools
      // (`research_deep`/`research_list`/...) share the SAME
      // `ResearchStoreResolver` + runtime substrate + sub-agent
      // dispatcher the chat-bridge `/research` filter uses. Without
      // this share the MCP path lands on a different (per-call,
      // process-local) backend and the on-disk SQLite divergence
      // surfaces as "I just captured this brief but research_list
      // returns nothing".
      //
      // Argus r2 MINOR #2 (2026-05-21): the previous canned-empty
      // substrate fallback was unreachable in production but matched
      // the Email-Core r1 anti-pattern Sam called out as forbidden in
      // CLAUDE.md ("placeholder phase-prompt bodies that ship as
      // no-ops"). Hard-required `researchProjectBackend` instead;
      // tests inject via the `backends:` override map (which bypasses
      // this factory entirely), production wires the real one via
      // `buildProductionResearchCoreWiring`.
      //
      // Argus r2 BLOCKER (2026-05-21): the legacy `research_start` /
      // `research_status` / `research_fetch` MCP tools take inputs
      // WITHOUT `project_id` (the manifest declares it optional with
      // "defaults to 'default'" semantics). The
      // `ResearchProjectBackend` methods all require `project_id` and
      // throw `ResearchInputError` on the empty string. Wrap the
      // shared backend so omitted/empty `project_id` defaults to
      // `'default'` at the MCP boundary — keeps the orchestrator
      // strict while honoring the documented MCP-tool contract.
      if (researchProjectBackend === undefined) {
        throw new Error(
          '[research_core] composer must thread `researchProjectBackend` ' +
            'into buildCoresBackendFactories. Use ' +
            '`buildProductionResearchCoreWiring(...)` in production and ' +
            'pass `project_backend` through; tests inject via the ' +
            '`backends:` override map.',
        )
      }
      return { backend: wrapResearchBackendWithDefaultProjectId(researchProjectBackend) }
    },
    codegen_core: async () => {
      // S2 (2026-05-22) — when the production composer threads its
      // wiring-built orchestrator, reuse it so the Core's MCP tools
      // share the SAME runner + per-project sidecar resolver as the
      // `/code` chat-command filter. When omitted (legacy / tests),
      // fall back to a skeleton-runner orchestrator that fails
      // dispatches loudly + actionably — install_ok stays TRUE.
      if (codegenOrchestratorFromOpts !== undefined) {
        return { orchestrator: codegenOrchestratorFromOpts }
      }
      // Trident-port PR-1 (2026-06-19) — OBSERVABILITY GUARDRAIL.
      // Reaching here in PRODUCTION means the composer never threaded a
      // real `codegenOrchestrator`, so BOTH the four `codegen_*` MCP
      // tools AND `/code <task>` dispatch into `buildSkeletonCodegenRunner`,
      // whose `run(...)` throws `CodegenNotConfiguredError` ("install the
      // Tier 2 Coding Core") — even on a credentialed instance where the
      // real Forge → Argus → merge loop COULD run. That silent drift is
      // exactly the failure the Trident-port diagnostic flagged. Mirror
      // the Tasks-composer guardrail (Argus r2 BLOCKING #2, PR #221):
      // warn LOUDLY so a future composer regression surfaces at boot
      // instead of as a quiet user-visible "/code says install Tier 2".
      // The skeleton STAYS — it is the legitimate Tier-1 safe-install
      // shape for Open self-hosts that never wire Code-Gen (install_ok
      // must stay TRUE); we only make the fall-through observable.
      console.warn(
        '[codegen_core] WARNING: no `codegenOrchestrator` threaded into ' +
          'buildCoresBackendFactories — `/code` + the codegen_* MCP tools ' +
          'will dispatch into the SKELETON runner (every task fails with ' +
          'CodegenNotConfiguredError). Production composers MUST build the ' +
          'real orchestrator via `buildProductionCodegenCoreWiring(...)` ' +
          '(gateway/cores/build-production-codegen-wiring.ts) and thread ' +
          'its `codegen_orchestrator` here + its `chat_command_filter` into ' +
          'the app-WS surface. See Trident-port PR-1 (AS-BUILT 2026-06-19).',
      )
      const mod = await import('@neutronai/codegen-core')
      const runner = mod.buildSkeletonCodegenRunner()
      return { orchestrator: new mod.CodegenOrchestrator({ runner }) }
    },
    agent_settings: async () => {
      // Settings Core (2026-06-03) — the six "tweak later" tools.
      // Project ops (list/rename/delete/merge) hit the per-instance
      // canonical `projects` table directly via `projectDb`. Personality
      // + agent-name ops route through the injected `AgentProfileBackend`
      // (registry RW); Telegram confirmations + topic retitle/archive
      // route through the injected sink. Both are best-effort: when the
      // composer didn't thread them, a no-op stands in so install +
      // project ops still work.
      const mod = await import('@neutronai/agent-settings')
      const profile: import('@neutronai/agent-settings').AgentProfileBackend =
        opts.agentSettingsProfile ?? {
          // Argus r5 IMPORTANT (2026-06-03): mark the no-op fallback
          // `available:false` so update_personality / update_agent_name
          // report an honest failure instead of a success that silently
          // no-ops. The fallback can STAY (non-Managed deploys without a
          // registry writer); it just must signal honestly.
          available: false,
          async get() {
            return { agent_name: null, agent_personality: null }
          },
          async setAgentName() {
            /* no-op: registry RW unavailable */
          },
          async setAgentPersonality() {
            /* no-op: registry RW unavailable */
          },
        }
      const telegram: import('@neutronai/agent-settings').AgentSettingsTelegram =
        opts.agentSettingsTelegram ?? {
          async sendConfirmation() {
            /* no-op: telegram sink unavailable */
          },
          async renameTopic() {
            /* no-op */
          },
          async archiveTopic() {
            /* no-op */
          },
        }
      return {
        backend: mod.buildAgentSettingsBackend({
          projectDb,
          profile,
          telegram,
          // Item 3 (2026-06-10) — resumable Telegram connect. When the
          // composer didn't thread a minter (bind secret unwired), omit
          // it so `connect_telegram` reports the honest unavailable
          // error instead of pretending to mint.
          ...(opts.agentSettingsBindLink !== undefined
            ? { bindLink: opts.agentSettingsBindLink }
            : {}),
        }),
      }
    },
  }
}


/**
 * Argus r2 BLOCKER close (2026-05-21) — wrap a `ResearchProjectBackend`
 * so the legacy MCP tool inputs (`research_start` / `research_status` /
 * `research_fetch`) work without a caller-supplied `project_id`. The
 * manifest declares `project_id` OPTIONAL on those three tools with
 * "defaults to 'default'" semantics; the production orchestrator
 * requires it and throws `ResearchInputError('project_id', ...)` on the
 * empty string. The chat-bridge `/research` filter applies the same
 * default at its boundary; this wrapper does it at the MCP boundary so
 * an LLM agent calling `research_start({query:'foo'})` per the
 * documented schema lands on the canonical 'default' sidecar instead of
 * 500'ing. Keeps the orchestrator strict (the wrapper is the seam) and
 * matches the chat-path behavior exactly.
 */
export function wrapResearchBackendWithDefaultProjectId(
  backend: import('@neutronai/research-core').ResearchProjectBackend,
): import('@neutronai/research-core').ResearchProjectBackend {
  const DEFAULT_PROJECT_ID = 'default'
  const withProjectId = <T extends { project_id?: string }>(input: T): T & { project_id: string } => {
    const project_id =
      typeof input.project_id === 'string' && input.project_id.trim().length > 0
        ? input.project_id
        : DEFAULT_PROJECT_ID
    return { ...input, project_id }
  }
  return {
    start: (input) => backend.start(withProjectId(input)),
    deep: (input) => backend.deep(withProjectId(input)),
    list: (input) => backend.list(withProjectId(input)),
    find: (input) => backend.find(withProjectId(input)),
    cite: (input) => backend.cite(withProjectId(input)),
    claimsForTask: (input) => backend.claimsForTask(withProjectId(input)),
    status: (input) => backend.status(withProjectId(input)),
    fetch: (input) => backend.fetch(withProjectId(input)),
  }
}

/**
 * Sprint 23 — load Anthropic Max paste-token client config from env.
 * The per-instance gateway uses `MaxOAuthClient.getAccessToken` to read
 * the stored paste token from the SecretsStore; the only env-tunable
 * is the API base URL (overridden by tests / staging) since paste
 * tokens have no upstream OAuth surface to refresh against.
 *
 *   NEUTRON_ANTHROPIC_API_BASE_URL — defaults to
 *     `https://api.anthropic.com`. Tests inject a mock base URL.
 */
export function loadAnthropicOAuthConfigFromEnv(
  env: NodeJS.ProcessEnv,
): MaxOAuthClientConfig | undefined {
  const cfg: MaxOAuthClientConfig = {}
  const apiBase = env['NEUTRON_ANTHROPIC_API_BASE_URL']
  if (apiBase !== undefined && apiBase !== '') cfg.api_base_url = apiBase
  return Object.keys(cfg).length === 0 ? undefined : cfg
}

/**
 * Build the Research Core's per-instance `ResearchLlmCall` closure
 * against the instance's Anthropic credential pool. The pool is read
 * via a getter rather than captured by value so a no-restart Max
 * OAuth re-paste (or env-var rotation) lands the next /research
 * dispatch on the fresh credentials.
 *
 * Throws on invocation when the instance has no credentials — the
 * orchestrator catches the error and surfaces the task as `failed`
 * with `substrate error: ...` rather than crashing the gateway. The
 * user-visible chat reply explains the gap.
 *
 * Argus r1 BLOCKER #4 close. The previous wiring shipped
 * `buildCannedResearchSubstrate({responses: []})` which threw
 * `no canned response for call #1` on every real /research dispatch.
 */
export function buildResearchLlmCallForOwner(opts: {
  project_slug: string
  slug_suffix: string
  /**
   * Sprint cc-substrate-migration-3-sites (2026-05-31) — Research Core
   * now dispatches through the shared CC subprocess substrate (same
   * `Substrate` instance the phase-spec resolver / LLM router / agent
   * watcher / wow picker / nudge engine consume). Per memory
   * `feedback_cc_subprocess_substrate.md`, direct HTTPS calls to
   * upstream LLM endpoints from instance-facing code are forbidden;
   * the `claude` binary owns wire-level auth + OAuth refresh.
   *
   * Pass `null` when no Anthropic credentials are available; the
   * returned closure then throws a substrate-error per call so the
   * orchestrator surfaces `failed` with the user-visible "reconnect Max"
   * message rather than crashing the gateway. Pre-cc-substrate the
   * call site was `get_anthropic_pool: () => Promise<CredentialPool | null>`
   * (re-resolved per-dispatch); the substrate's internal lazy
   * `resolvePool` now owns the same per-call freshness guarantee, so a
   * an instance that re-pastes Max OAuth mid-session is honoured on the next
   * `/research` dispatch without a gateway restart.
   */
  substrate: import('../runtime/substrate.ts').Substrate | null
}): import('@neutronai/research-core').ResearchLlmCall {
  return async (input) => {
    if (opts.substrate === null) {
      throw new Error(
        `[research-core] project=${opts.project_slug} has no anthropic credentials; ` +
          `reconnect Max OAuth or set ANTHROPIC_API_KEY_${opts.slug_suffix} ` +
          `to enable /research`,
      )
    }
    const { collectTokensToString } = await import(
      './realmode-composer/build-llm-call-substrate.ts'
    )
    const prompt = input.system.length > 0
      ? `${input.system}\n\n${input.user}`
      : input.user
    if (prompt.length === 0) {
      throw new Error('[research-core] empty prompt — refusing to dispatch')
    }
    const spec: import('../runtime/substrate.ts').AgentSpec = {
      prompt,
      tools: [],
      model_preference: [input.model],
      max_tokens: input.max_tokens,
    }
    const handle = opts.substrate.start(spec)
    try {
      return await collectTokensToString(handle)
    } catch (err) {
      throw new Error(
        `[research-core] ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

/**
 * Sprint 22 — resolve the identity service's public base URL. Used by
 * the Max OAuth gate page to build the `/oauth/max/start` link (with
 * slug + return URL params). Configured via `NEUTRON_AUTH_PUBLIC_BASE_URL`;
 * if unset it is derived as `https://auth.<base_domain>` only when a base
 * domain is configured. With no base domain configured, returns `''`
 * (the affordance/link is simply absent). Tests inject explicit env override.
 */
export function resolveIdentityPublicBaseUrl(env: NodeJS.ProcessEnv): string {
  const fromEnv = env['NEUTRON_AUTH_PUBLIC_BASE_URL']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const baseDomain = resolveBaseDomain(env)
  if (baseDomain.length === 0) return ''
  return `https://auth.${baseDomain}`
}

export function resolveBaseDomain(env: NodeJS.ProcessEnv): string {
  const fromEnv = env['NEUTRON_BASE_DOMAIN']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return ''
}

/**
 * Sprint 22 → Sprint 23 — minimal HTTP handler that renders a
 * "Connect Anthropic Max" gate page on `GET /chat` when the
 * per-instance gateway has no Anthropic credentials. The page links to
 * the identity service's `/oauth/max/start` endpoint with the instance
 * slug and the chat URL as the post-callback return target. Sprint
 * 23: that endpoint now serves a paste-token form (replacing the
 * Sprint 22 redirect to the fictional `auth.anthropic.com` host).
 *
 * `?max=skipped` arrives when the user clicked "skip for now" on the
 * paste form; we render the gate page with a banner explaining the
 * chat surface is disabled until they revisit and paste a token.
 *
 * This replaces the prior "chat surface DISABLED" 404 with a clear UX
 * for the edge case where a user lands on `/chat` after their Max OAuth
 * tokens were revoked / never connected.
 *
 * Codex r3 P2 fix — the post-callback return URL is derived from the
 * INCOMING REQUEST origin (with `X-Forwarded-{Proto,Host}` honored for
 * the production Caddy proxy chain), NOT a hardcoded
 * `https://<slug>.<base_domain>/chat`. Staging / localhost / custom
 * host deploys now redirect back to where the user actually was; the
 * `base_domain` parameter is retained as a fallback for callers that
 * truly want the canonical production shape.
 */
export function buildMaxOAuthGateHandler(opts: {
  project_slug: string
  identity_public_base_url: string
  base_domain: string
}): HttpHandler {
  return (req: Request): Response => {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          project_slug: opts.project_slug,
          chat_surface: 'authorize_required',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.pathname === '/chat' && req.method === 'GET') {
      // Codex r4 P1 — the gate page must forward the user's existing
      // start_token JWT (carried as `?start=<jwt>` on the chat URL by
      // the identity service's post-signin redirect) to
      // `/oauth/max/start?start_token=<jwt>`. The identity handler
      // verifies the start_token's `project_slug` claim against the
      // URL slug parameter so an unauthenticated caller can't
      // drive Max OAuth into a victim's SecretsStore. Without a
      // start_token in the URL, the gate page renders the "sign in
      // first" branch instead of a Connect button.
      const startTokenFromUrl = url.searchParams.get('start') ?? ''
      const chatUrl = resolveRequestOriginChatUrl(req, opts)
      // Sprint 23 — `?max=skipped` arrives when the user clicked
      // "skip for now" on the paste-token form. The chat surface
      // is intentionally disabled until they revisit and paste a
      // token. Surface that explicitly so the user knows why /chat
      // looks empty rather than thinking the platform is broken.
      const skippedFromUrl = url.searchParams.get('max') === 'skipped'
      if (startTokenFromUrl.length === 0) {
        const html = renderSignInRequiredPage({
          project_slug: opts.project_slug,
          identity_public_base_url: opts.identity_public_base_url,
        })
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      const startUrl = new URL('/oauth/max/start', opts.identity_public_base_url)
      startUrl.searchParams.set('owner', opts.project_slug)
      startUrl.searchParams.set('return', chatUrl)
      startUrl.searchParams.set('start_token', startTokenFromUrl)
      const html = renderMaxOAuthGatePage({
        authorizeHref: startUrl.toString(),
        skipped: skippedFromUrl,
      })
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    return new Response('Not Found', { status: 404 })
  }
}

/**
 * Argus r1 BLOCKER (2026-05-28) — pure URL builder for the in-chat
 * "Connect Claude Max" CTA. The identity service's
 * `/oauth/max/start` handler requires three query params: slug,
 * `return`, and `start_token` (it returns HTTP 400 "missing
 * start_token" without the third). Centralising the construction here
 * lets the engine-side hook AND the static gate page agree on the
 * exact URL shape — and a regression test can pin the shape by hand
 * without spinning up the full composer.
 */
export function buildMaxOauthHandoffUrl(opts: {
  project_slug: string
  identity_public_base_url: string
  base_domain: string
  start_token: string
}): string {
  const startUrl = new URL('/oauth/max/start', opts.identity_public_base_url)
  startUrl.searchParams.set('owner', opts.project_slug)
  startUrl.searchParams.set(
    'return',
    `https://${opts.project_slug}.${opts.base_domain}/chat`,
  )
  startUrl.searchParams.set('start_token', opts.start_token)
  return startUrl.toString()
}

/**
 * Codex r4 P1 — when /chat is hit without `?start=<jwt>`, the user
 * needs to sign in before the Connect button is safe to present
 * (otherwise an unauthenticated caller could complete Max OAuth
 * into a victim's account). Render a "Sign in" page with a link to
 * the identity service's signup flow.
 *
 * Codex r5 P1 #2 (M1 limitation) — a returning user with revoked
 * Max tokens lands here without a start_token. Re-doing Google
 * OAuth (the "Sign in" link below) does NOT currently produce a
 * fresh `?start=<jwt>` redirect for returning users; only first-
 * signins fire the post-signin trigger that mints the start_token.
 * The button below kicks off Google OAuth as a courtesy entry
 * point; full revoked-token recovery requires the operator to
 * issue a new sign-in link (a follow-up sprint will add an
 * authenticated `/oauth/max/recover` endpoint that mints a fresh
 * start_token from the user's existing identity-service refresh
 * token).
 */
function renderSignInRequiredPage(opts: {
  project_slug: string
  identity_public_base_url: string
}): string {
  const signInUrl = new URL('/oauth/google/start', opts.identity_public_base_url)
  signInUrl.searchParams.set('via', 'web')
  const escapedHref = escapeHtmlAttr(signInUrl.toString())
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in required — Neutron</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 480px; margin: 64px auto; padding: 0 24px; color: #111; }
    h1 { font-size: 22px; margin: 0 0 12px; }
    p { color: #444; }
    a.btn { display: inline-block; margin-top: 24px; padding: 12px 20px; background: #111; color: #fff;
            text-decoration: none; border-radius: 8px; font-weight: 600; }
    a.btn:hover { background: #000; }
    .hint { font-size: 13px; color: #888; margin-top: 24px; }
  </style>
</head>
<body>
  <h1>Sign in to ${escapeHtmlAttr(opts.project_slug)}</h1>
  <p>To connect your Anthropic Max subscription, sign in first so we can confirm this project belongs to you.</p>
  <a class="btn" href="${escapedHref}">Sign in with Google</a>
  <p class="hint">If you previously connected and your Max tokens were revoked, contact the operator for a fresh sign-in link — automated revoked-token recovery lands in a follow-up release.</p>
</body>
</html>`
}

/**
 * Codex r3 P2 + r5 P1 — derive the post-callback return URL from the
 * request origin so non-production deploys (localhost, staging,
 * custom host) land users back where they came from, AND preserve
 * the user's existing `?start=<jwt>` so the chat surface can
 * authenticate the WebSocket on the post-OAuth round-trip. Without
 * the preservation, the browser lands on bare `/chat` after OAuth
 * completes and `landing/chat.ts` has nothing to authenticate with,
 * silently breaking the post-OAuth reconnect.
 *
 * Honors the standard `X-Forwarded-Proto` + `X-Forwarded-Host`
 * headers Caddy / nginx / Cloudflare set so an instance gateway behind
 * a TLS-terminating proxy still produces the correct
 * https://<slug>.<base_domain>/chat URL.
 *
 * Falls back to `https://<slug>.<base_domain>/chat` only if both the
 * request URL parse + the X-Forwarded headers fail — that's the
 * dev-fallback shape, not the documented production path.
 */
function resolveRequestOriginChatUrl(
  req: Request,
  opts: { project_slug: string; base_domain: string },
): string {
  try {
    const reqUrl = new URL(req.url)
    const xfp = req.headers.get('x-forwarded-proto')
    const xfh = req.headers.get('x-forwarded-host')
    const proto = (xfp ?? reqUrl.protocol.replace(/:$/, '')).split(',')[0]!.trim()
    const host = (xfh ?? reqUrl.host).split(',')[0]!.trim()
    if (proto.length > 0 && host.length > 0) {
      const startToken = reqUrl.searchParams.get('start') ?? ''
      const suffix = startToken.length > 0
        ? `?start=${encodeURIComponent(startToken)}`
        : ''
      return `${proto}://${host}/chat${suffix}`
    }
  } catch {
    // fall through to canonical fallback
  }
  return `https://${opts.project_slug}.${opts.base_domain}/chat`
}

function renderMaxOAuthGatePage(opts: {
  authorizeHref: string
  /** Sprint 23 — true when the user just clicked "skip for now". */
  skipped?: boolean
}): string {
  // Sprint 23 — static, single-page HTML. The "Connect" button takes
  // the user to the identity service's paste-token form (NOT a
  // redirect to anthropic.com). When `skipped=true` we add a banner
  // explaining the chat surface is disabled until the user pastes
  // a token.
  const escapedHref = escapeHtmlAttr(opts.authorizeHref)
  const banner = opts.skipped
    ? `<div class="banner" role="status">Chat is disabled until you connect Anthropic Max. Paste a token below or come back later.</div>`
    : ''
  const intro = opts.skipped
    ? `<p>You skipped earlier. Whenever you're ready, paste your <code>claude setup-token</code> output to enable the chat surface.</p>`
    : `<p>Neutron uses your Claude Max subscription to power your agent. Click below to paste a long-lived token from <code>claude setup-token</code>.</p>`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Anthropic Max — Neutron</title>
  <style>
    :root { color-scheme: dark; }
    body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
           max-width: 520px; margin: 64px auto; padding: 0 24px;
           color: #e8e8ea; background: #0b0b0f; }
    h1 { font-size: 24px; margin: 0 0 16px; letter-spacing: -0.01em; font-weight: 600; }
    p { color: #b9b9c1; margin: 0 0 12px; }
    code { background: #1c1c22; padding: 2px 6px; border-radius: 4px; font-size: 13px;
           font-family: "SF Mono", ui-monospace, "Menlo", monospace; color: #f1f1f4; }
    a.btn { display: inline-block; margin-top: 24px; padding: 12px 22px;
            background: #4a7fff; color: #fff; text-decoration: none;
            border-radius: 8px; font-weight: 600; }
    a.btn:hover { background: #3b6dec; }
    .hint { font-size: 13px; color: #7e7e89; margin-top: 24px; }
    .banner { background: #2a230f; border: 1px solid #5a4a1c; color: #ffd58a;
              padding: 12px 14px; border-radius: 8px; margin: 0 0 20px;
              font-size: 14px; }
  </style>
</head>
<body>
  ${banner}
  <h1>Connect your Anthropic Max subscription</h1>
  ${intro}
  <a class="btn" href="${escapedHref}">Paste your Anthropic Max token</a>
  <p class="hint">Your token is stored encrypted in your per-project store. The operator never sees the plaintext. To rotate later, re-run <code>claude setup-token</code> and paste the new value.</p>
</body>
</html>`
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Codex r2 P1 — wrap the gate handler as a landing-server-shaped object
 * (`{ fetch, websocket }`) so the boot's `composeHttpHandler` chain can
 * mount it via the `landing` slot. That keeps the connect API +
 * telegram-webhook + slug-check + internal-cache-invalidate routes
 * dispatching through their normal handlers; only `/chat` and the
 * other landing-route prefixes route to the gate.
 *
 * `/ws/chat` upgrades are explicitly closed with status 503 because
 * there's no chat-surface to bridge to until the user authorizes Max.
 *
 * Codex r7 P2 — `/api/v1/sign-up` and `/invite*` need sensible
 * responses too. The gate handler ONLY handles `/chat` + `/healthz`;
 * other landing-route paths used to fall through to its 404 default.
 * For invite-related paths we return a 503 with an explanation; for
 * `/api/v1/sign-up` we redirect to the identity service's signup
 * trampoline (matches the production landing-server behavior so the
 * sign-up CTA still works while the chat surface is gated).
 */
export function buildGateLandingServer(
  gateHandler: HttpHandler,
  opts: { project_slug: string; identity_public_base_url: string; base_domain: string },
): NonNullable<CompositionInput['landing_server']> {
  return {
    fetch: async (req): Promise<Response> => {
      const url = new URL(req.url)
      // /ws/chat upgrades have no chat surface to bridge — close cleanly.
      if (url.pathname === '/ws/chat') {
        return new Response('chat surface unavailable — authorize Max first', {
          status: 503,
        })
      }
      // Sign-up trampoline still works while the chat surface is
      // gated — redirects to identity's `/oauth/<provider>/start`.
      if (url.pathname === '/api/v1/sign-up' && req.method === 'GET') {
        const viaRaw = url.searchParams.get('via') ?? ''
        const via: 'tg' | 'web' = viaRaw === 'tg' || viaRaw === 'telegram' ? 'tg' : 'web'
        const target = new URL('/oauth/google/start', opts.identity_public_base_url)
        target.searchParams.set('via', via)
        return new Response(null, {
          status: 302,
          headers: { location: target.toString() },
        })
      }
      // Invite-related routes: the workspace owner can't add members
      // until the instance has Anthropic credentials. Return 503 with
      // a clear message so the invite flow doesn't silently 404.
      if (
        url.pathname === '/invite' ||
        url.pathname === '/invite.js' ||
        url.pathname === '/onboarding/invite-accept' ||
        (url.pathname === '/' && url.searchParams.has('invite'))
      ) {
        const body =
          url.pathname === '/onboarding/invite-accept'
            ? JSON.stringify({
                status: 'error',
                reason: 'project inactive — owner must complete Max OAuth before invites can resolve',
              })
            : `<!doctype html><meta charset="utf-8"><title>Owner not yet active</title>` +
              `<body style="font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 24px">` +
              `<h1>Owner not yet active</h1>` +
              `<p>The owner of <strong>${opts.project_slug}</strong> needs to complete Anthropic Max OAuth before invites can be accepted. Please retry after a few minutes.</p>` +
              `</body>`
        const ct =
          url.pathname === '/onboarding/invite-accept'
            ? 'application/json'
            : 'text/html; charset=utf-8'
        return new Response(body, { status: 503, headers: { 'content-type': ct } })
      }
      return await gateHandler(req)
    },
    websocket: {
      message(): void {},
      open(): void {},
      close(): void {},
    },
  }
}
