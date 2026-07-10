/**
 * @neutronai/gateway/nexus — per-project agent-nexus sidecar (RC1).
 *
 * Per docs/plans/2026-07-02-world-class-refactor-plan.md § RC1.
 *
 * The missing cross-agent recall primitive: an APPEND-ONLY decision/
 * observation/learning/handoff log that build agents (forge/argus/
 * orchestrator), the reflection writer, the scribe, the chat agent and
 * the user all write into, and that a later turn can read back to
 * re-ground on other agents' recent decisions. NOT a bus — there is no
 * subscription, no delivery, no ack; just an ordered log with a single
 * write surface and a bounded read.
 *
 * Wraps a per-project SQLite sidecar at
 *   `<owner_home>/Projects/<project_id>/.nexus/nexus.db`
 * with `appendEvent` / `readRecent`.
 *
 * The sidecar idiom is copied verbatim from
 * `gateway/comments/comment-store.ts` (P7.2, Sam locked 2026-05-20):
 *   - Project delete is `rm -rf <project>/` — the nexus log goes with
 *     it, no foreign-key cleanup pass (rm-with-project lifecycle).
 *   - Event writes are bursty + project-scoped, so isolating them from
 *     the cross-cutting `project.db` means a busy overnight trident run
 *     never contends on the busy-retry mutex with reminder ticks.
 *   - Matches the Tier 1 Core sidecar convention.
 *
 * Concurrency: every write is wrapped in `BEGIN IMMEDIATE` so two
 * concurrent appends serialise cleanly. ULIDs guarantee unique ids
 * without coordination, and the per-event INSERT is atomic.
 *
 * RC1 is behavior=false: this module ships with NO emitter and NO
 * reader wiring. RC2 wires the producers (trident harvest → `handoff`,
 * Argus verdict → `decision`, reflection onTurnComplete → `learning`);
 * RC3 wires the per-turn `<agent_nexus>` prompt fragment on top of
 * `readRecent`. The schema + taxonomy below are load-bearing for both.
 */

import type { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sanitizeProjectId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { applyProjectScopedMigrations } from '@neutronai/migrations/runner.ts'
import {
  isBusyError,
  openSidecar,
  resolveNow,
  withBusyRetry,
} from '@neutronai/persistence/index.ts'
import { defaultUlid } from '../comments/comment-store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Default per-project sidecar dir name (sibling of `.comments/` /
 *  `.docs-blobs/`). The leading dot keeps it invisible to the docs
 *  surface — `validateRelativePath` rejects hidden segments. */
const NEXUS_DIR = '.nexus'
const NEXUS_DB = 'nexus.db'

/** Hard cap on an event body. Nexus bodies are pointers-lean by
 *  contract (RC3 injects them into prompts; long content links out via
 *  `refs`, it is not inlined) — mirrors the comments sidecar's 8 KB
 *  body cap. */
export const MAX_NEXUS_BODY_BYTES = 8 * 1024

/** Cap on the serialized `refs_json` — mirrors the comments sidecar's
 *  4 KB `metadata_json` cap. Keeps a malformed (or malicious) appender
 *  from blowing up the row size; `appendEvent` rejects oversize refs
 *  with a `NexusStoreError` instead of silently truncating. */
export const MAX_NEXUS_REFS_JSON_BYTES = 4 * 1024

/** Default location of the per-project nexus migration tree. The
 *  NexusStore looks here at init time. Tests override via the
 *  constructor option. */
export const DEFAULT_NEXUS_MIGRATIONS_DIR = join(
  HERE,
  '..',
  '..',
  'migrations',
  'nexus',
)

/* ─── taxonomy (load-bearing — RC2/RC3 build on these) ───────────── */

/**
 * WHO wrote the event. Locked per RC1:
 *   - `chat`         — the interactive chat agent
 *   - `reflection`   — the onTurnComplete reflection writer
 *   - `scribe`       — the background scribe
 *   - `forge`        — trident build workers
 *   - `argus`        — trident review workers
 *   - `orchestrator` — the outer trident/dispatch loop
 *   - `user`         — a human-authored entry
 */
export const NEXUS_ACTOR_KINDS = [
  'chat',
  'reflection',
  'scribe',
  'forge',
  'argus',
  'orchestrator',
  'user',
] as const
export type NexusActorKind = (typeof NEXUS_ACTOR_KINDS)[number]

/**
 * WHAT the event is. Locked per RC1:
 *   - `decision`    — a choice was made (e.g. an Argus verdict)
 *   - `observation` — a fact noticed, no commitment implied
 *   - `learning`    — a durable correction/insight (e.g. owner feedback
 *                     captured by reflection)
 *   - `handoff`     — work passed across an agent boundary (e.g. the
 *                     trident inner→outer harvest)
 */
export const NEXUS_EVENT_KINDS = [
  'decision',
  'observation',
  'learning',
  'handoff',
] as const
export type NexusEventKind = (typeof NEXUS_EVENT_KINDS)[number]

/**
 * Typed-reference vocabulary for `refs_json`. Each ref points AT a
 * durable artifact so bodies stay pointers-lean (RC3 contract):
 *   - `doc`         — a project doc path (DocStore-relative, e.g.
 *                     `plans/foo.md`), same shape as comment `doc_path`
 *   - `entity`      — a memory entity slug (the `(kind, slug)` shape
 *                     from gbrain-memory collapses to `kind/slug` here,
 *                     e.g. `people/sam`)
 *   - `work_item`   — a work-board item id
 *   - `run`         — a trident run id/slug
 *   - `pr`          — a pull request, `#<number>` or a full URL
 *   - `nexus_event` — another agent_nexus_events id (chains/threads)
 *   - `url`         — anything addressable outside the instance
 */
export const NEXUS_REF_KINDS = [
  'doc',
  'entity',
  'work_item',
  'run',
  'pr',
  'nexus_event',
  'url',
] as const
export type NexusRefKind = (typeof NEXUS_REF_KINDS)[number]

/** One typed reference inside `refs_json` (stored as a JSON array of
 *  these). `ref` is the kind-scoped identifier; `note` is an optional
 *  human-readable hint (e.g. a doc title). */
export interface NexusRef {
  kind: NexusRefKind
  ref: string
  note?: string
}

/* ─── rows + surfaces ────────────────────────────────────────────── */

/** Canonical row shape — mirrors the `agent_nexus_events` schema
 *  exactly (`refs_json` stays a raw string; parse via
 *  `parseNexusRefs`). */
export interface AgentNexusEvent {
  id: string
  actor_kind: NexusActorKind
  actor_id: string
  kind: NexusEventKind
  body: string
  refs_json: string | null
  created_at: number
}

/** Input to `appendEvent`. The store fills in `id` (ULID) +
 *  `created_at` (ms-epoch) and serializes `refs` so callers never
 *  hand-build `refs_json`. */
export interface AppendNexusEventInput {
  actor_kind: NexusActorKind
  actor_id: string
  kind: NexusEventKind
  body: string
  /** Typed references; `null`/`[]` both persist as `refs_json = NULL`. */
  refs: NexusRef[] | null
}

export interface ReadRecentOptions {
  /** Restrict to these event kinds. Omitted/empty = all kinds. */
  kinds?: NexusEventKind[]
  /** Only events with `created_at >= since` (ms-epoch). */
  since?: number
  /** Max rows (default 50, cap 500). */
  limit?: number
}

export class NexusStoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'NexusStoreError'
    this.code = code
  }
}

export interface NexusStoreOptions {
  /** Absolute path to the per-instance `<owner_home>` dir. */
  owner_home: string
  /** Override per-project root resolution (default:
   *  `<owner_home>/Projects/<project_id>/`). */
  resolveProjectRoot?: (project_id: string) => string
  /** Override the nexus migration dir. Defaults to the
   *  `migrations/nexus/` tree shipped with the gateway. */
  migrations_dir?: string
  /** Override the ULID factory. Tests inject a deterministic generator
   *  so ids are stable. */
  ulid?: () => string
  /** Override the wall clock. Tests inject a monotonic stub so
   *  `created_at` is deterministic. */
  now?: () => number
}

interface ProjectHandle {
  db: Database
  nexus_db_path: string
  /** Flipped by `closeAll()` before the underlying db is closed. An
   *  operation that obtained this handle across an `await` boundary
   *  re-checks it (synchronously, immediately before touching the db)
   *  so a `closeAll()` landing in that gap aborts the op with a typed
   *  error instead of running SQL on a closed connection. */
  closed: boolean
}

export class NexusStore {
  private readonly owner_home: string
  private readonly resolveProjectRoot: (project_id: string) => string
  private readonly migrations_dir: string
  private readonly ulid: () => string
  private readonly now: () => number
  private readonly handles = new Map<string, ProjectHandle>()
  private readonly initPromises = new Map<string, Promise<ProjectHandle>>()
  /** Lifecycle generation, bumped by `closeAll()`. EVERY `openHandle`
   *  caller — the one that starts the init AND every waiter that joins
   *  the same in-flight init — captures the generation when it commits
   *  to the shared init, then re-checks `(generation unchanged) AND
   *  (handle not closed)` after the init resolves. A caller whose
   *  generation moved (a `closeAll()` tore down the store mid-init)
   *  rejects with `store_closed` and never touches the handle. Because
   *  `closeAll()` also clears `initPromises`, any caller that joins
   *  AFTER a `closeAll()` starts a fresh init rather than waiting on a
   *  torn-down one, so all waiters on one promise share the owner's
   *  captured generation. Without the waiter-inclusive gate a waiter
   *  would receive the owner's freshly-closed handle (the owner is the
   *  sole closer) and run SQL on a closed connection. */
  private generation = 0

  constructor(opts: NexusStoreOptions) {
    this.owner_home = opts.owner_home
    this.resolveProjectRoot =
      opts.resolveProjectRoot ??
      ((project_id) => join(opts.owner_home, 'Projects', project_id))
    this.migrations_dir = opts.migrations_dir ?? DEFAULT_NEXUS_MIGRATIONS_DIR
    this.ulid = opts.ulid ?? defaultUlid
    this.now = resolveNow(opts.now)
  }

  /** Force-close every per-project DB handle. Useful for tests that
   *  swap fixture roots between cases. Bumping `generation` invalidates
   *  any init already in flight: its continuation observes the changed
   *  generation, closes the connection it just opened, and does not
   *  cache it (see `openHandle`), so `closeAll()` racing an in-flight
   *  `ensureInit` never leaks a handle. */
  closeAll(): void {
    this.generation++
    for (const handle of this.handles.values()) {
      // Flag BEFORE closing so an in-flight op that already holds this
      // handle (obtained across an `await`, e.g. `appendEvent` past its
      // `await openHandle`) sees `closed` and aborts rather than issuing
      // SQL on the closed connection.
      handle.closed = true
      try {
        handle.db.close()
      } catch {
        /* ignore */
      }
    }
    this.handles.clear()
    this.initPromises.clear()
  }

  /**
   * Idempotent lazy-init for `<project>/.nexus/`. Creates the dir,
   * opens the sidecar SQLite, applies migrations. The `initPromises`
   * cache mirrors the P7.4 `ensureInit` shape so two concurrent
   * first-writes both wait on the same init promise.
   */
  async ensureInit(project_id: string): Promise<void> {
    await this.openHandle(project_id)
  }

  /**
   * Append one event — the SINGLE write surface. Returns the canonical
   * row.
   *
   * Server-side guarantees:
   *   - `id` is freshly minted (ULID).
   *   - `created_at` is the server clock.
   *   - `actor_kind` / `kind` are validated against the locked
   *     taxonomy (belt) on top of the schema CHECKs (braces).
   *   - `refs` entries are shape-validated + serialized here; callers
   *     never hand-build `refs_json`.
   *   - Body / refs_json size caps are enforced.
   *   - The INSERT runs inside `BEGIN IMMEDIATE` so concurrent appends
   *     serialise cleanly, and the whole transaction goes through the
   *     sanctioned `withBusyRetry` ladder (persistence/retry.ts) — the
   *     nexus writers are cross-PROCESS by design (forge/argus/
   *     orchestrator emitters in RC2), so a competing connection can
   *     hold the write lock past the 100 ms C-level busy_timeout; the
   *     jittered async retries absorb that without pinning the event
   *     loop. The callback is safe to re-run: a failed attempt rolls
   *     back (or never acquired the lock), leaving no partial state.
   */
  async appendEvent(
    project_id: string,
    input: AppendNexusEventInput,
  ): Promise<AgentNexusEvent> {
    // Validate + serialize BEFORE opening the handle: `openHandle`
    // creates + migrates the `<project>/.nexus/` sidecar on first
    // touch, so validating after it would let a stream of rejected
    // payloads (distinct valid project_ids) spawn unbounded sidecars.
    // assertInput + serializeRefs are pure, so this reorder is safe.
    this.assertInput(input)
    const refs_json = serializeRefs(input.refs)
    if (
      refs_json !== null &&
      byteLen(refs_json) > MAX_NEXUS_REFS_JSON_BYTES
    ) {
      throw new NexusStoreError(
        'refs_json_too_large',
        `refs_json exceeds ${MAX_NEXUS_REFS_JSON_BYTES} bytes`,
      )
    }

    const handle = await this.openHandle(project_id)
    const row: AgentNexusEvent = {
      id: this.ulid(),
      actor_kind: input.actor_kind,
      actor_id: input.actor_id,
      kind: input.kind,
      body: input.body,
      refs_json,
      created_at: this.now(),
    }

    const db = handle.db
    await withBusyRetry(() => {
      // Re-check at the TOP OF EVERY ATTEMPT, not just once before the
      // loop: `withBusyRetry` yields (`await Bun.sleep`) between busy
      // retries, and a `closeAll()` landing in that yield closes `db`.
      // Each attempt runs synchronously from here through COMMIT, so
      // this guard + the write are one uninterrupted unit — a closure
      // between attempts is caught here and aborts with a typed error
      // instead of issuing `BEGIN IMMEDIATE` on a closed connection.
      // `store_closed` is non-busy, so `withBusyRetry` propagates it
      // immediately rather than retrying.
      this.assertHandleLive(handle)
      db.exec('BEGIN IMMEDIATE')
      try {
        db.run(
          `INSERT INTO agent_nexus_events (
             id, actor_kind, actor_id, kind, body, refs_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.actor_kind,
            row.actor_id,
            row.kind,
            row.body,
            row.refs_json,
            row.created_at,
          ],
        )
        db.exec('COMMIT')
      } catch (err) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* a failed BEGIN never opened a txn — nothing to roll back */
        }
        throw err
      }
    })
    return row
  }

  /**
   * Read the most recent events, optionally restricted by `kinds`
   * and/or `since` (ms-epoch `created_at` lower bound, inclusive).
   *
   * Selects the newest `limit` matches by `(created_at, id)` — NOT by
   * id alone: ids are ULIDs and normally sort by creation time, but
   * `created_at` comes from the injected `now()` while the default
   * ULID factory reads `Date.now()` directly, so an injected clock, a
   * clock rollback, or a custom ULID factory can make the two orders
   * disagree; `created_at` is the recency truth, id is the tiebreak
   * (Codex r2). Returns the slice in CHRONOLOGICAL (oldest-first)
   * order — the shape the RC3 prompt fragment splices directly.
   */
  async readRecent(
    project_id: string,
    opts: ReadRecentOptions = {},
  ): Promise<AgentNexusEvent[]> {
    // Validate ALL options BEFORE opening the handle — like appendEvent,
    // `openHandle` creates + migrates the sidecar on first touch, so a
    // stream of rejected reads on distinct project_ids would otherwise
    // spawn unbounded .nexus/ dbs (Codex).
    if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
      throw new NexusStoreError('invalid_input', 'readRecent options must be an object')
    }
    const limit = clampLimit(opts.limit, 50, 500)
    if (opts.kinds !== undefined && !Array.isArray(opts.kinds)) {
      throw new NexusStoreError('invalid_event_kind', 'kinds must be an array')
    }
    const kinds = opts.kinds ?? []
    for (const k of kinds) {
      if (!isNexusEventKind(k)) {
        throw new NexusStoreError(
          'invalid_event_kind',
          `kind must be one of ${NEXUS_EVENT_KINDS.join('|')}; got ${String(k)}`,
        )
      }
    }
    if (opts.since !== undefined && !Number.isFinite(opts.since)) {
      // `since` reaches SQLite as a bound parameter; a non-finite value
      // (NaN/Infinity from an untyped caller) would bind as NULL and
      // silently drop the filter, so reject it with a typed error.
      throw new NexusStoreError(
        'invalid_since',
        'since must be a finite ms-epoch number',
      )
    }

    const handle = await this.openHandle(project_id)
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (kinds.length > 0) {
      conditions.push(`kind IN (${kinds.map(() => '?').join(',')})`)
      params.push(...kinds)
    }
    if (opts.since !== undefined) {
      conditions.push('created_at >= ?')
      params.push(opts.since)
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    // Same closed-during-await guard as appendEvent — the query below
    // is synchronous, so this check makes read + query one unit.
    this.assertHandleLive(handle)
    const rows = handle.db
      .prepare<AgentNexusEvent, Array<string | number>>(
        `SELECT id, actor_kind, actor_id, kind, body, refs_json, created_at
           FROM agent_nexus_events
           ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(...params, limit)
    rows.reverse()
    return rows
  }

  /* ─── internals ──────────────────────────────────────────────── */

  /** Throw `store_closed` if `closeAll()` has retired this handle.
   *  Called synchronously immediately before any db access so a
   *  `closeAll()` that raced the preceding `await openHandle` aborts
   *  the operation cleanly. */
  private assertHandleLive(handle: ProjectHandle): void {
    if (handle.closed) {
      throw new NexusStoreError(
        'store_closed',
        'store was closed during the operation; aborted',
      )
    }
  }

  private async openHandle(project_id: string): Promise<ProjectHandle> {
    const cleaned = sanitizeProjectId(project_id)
    if (cleaned === null) {
      throw new NexusStoreError(
        'invalid_project_id',
        'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
      )
    }
    // sanitizeProjectId's charset allows dots, and the two dot-only
    // names special to path resolution would escape the per-project
    // root: `Projects/..` is `<owner_home>` itself and `Projects/.` is
    // the shared Projects dir — either would plant a `.nexus/` OUTSIDE
    // the project whose rm-with-project lifecycle this store relies on
    // (Codex r3 HIGH).
    if (cleaned === '.' || cleaned === '..') {
      throw new NexusStoreError(
        'invalid_project_id',
        'project_id must not be "." or ".."',
      )
    }
    const cached = this.handles.get(cleaned)
    // A handle in the map is always current-generation: `closeAll()`
    // clears the map AND flips `closed` in the same synchronous pass,
    // and there is no `await` between this `get` and the `return`, so a
    // non-closed cached handle cannot have been torn down under us.
    if (cached !== undefined && !cached.closed) return cached

    // Capture the generation at the moment THIS caller commits to the
    // shared init — whether it starts the init (owner) or joins one
    // already in flight (waiter). The post-resolve gate below then
    // rejects if a `closeAll()` advanced the generation while we were
    // awaiting. Capturing here (not only at init start) is what makes
    // the gate correct for waiters that join late.
    const captured = this.generation
    let promise = this.initPromises.get(cleaned)
    const isOwner = promise === undefined
    if (promise === undefined) {
      promise = this.initHandle(cleaned)
      this.initPromises.set(cleaned, promise)
    }

    let handle: ProjectHandle
    try {
      handle = await promise
    } catch (err) {
      // Init itself failed. Only the owner installed the marker, so
      // only the owner retracts it (if still ours — a `closeAll()`
      // mid-init may have cleared it and let a fresh init install its
      // own under this key).
      if (isOwner && this.initPromises.get(cleaned) === promise) {
        this.initPromises.delete(cleaned)
      }
      throw err
    }
    if (isOwner && this.initPromises.get(cleaned) === promise) {
      this.initPromises.delete(cleaned)
    }

    // THE GATE — run by EVERY caller (owner AND every waiter), not just
    // the one that created the promise. A waiter that received the
    // shared handle must independently verify `(generation unchanged)
    // AND (handle not closed)` before touching the db; otherwise a
    // `closeAll()` that resolved between init and here would let the
    // waiter run SQL on a closed connection.
    if (this.generation !== captured || handle.closed) {
      // Responsibility split: the OWNER (the generation-relevant path
      // that created this handle) is the sole closer of the orphaned
      // connection — `closeAll()` couldn't close it because it wasn't
      // in `this.handles` yet. A stale WAITER merely rejects; it must
      // NOT double-close. Flipping `closed` keeps the invariant "a
      // closed db always has handle.closed === true" so any later
      // `assertHandleLive` on this object is also correct.
      if (isOwner && !handle.closed) {
        handle.closed = true
        try {
          handle.db.close()
        } catch {
          /* ignore */
        }
      }
      throw new NexusStoreError(
        'store_closed',
        'store was closed during initialization; operation aborted',
      )
    }

    // Fresh. Only the OWNER caches — a waiter caching could clobber a
    // newer-generation handle installed after a `closeAll()`/re-init
    // (the waiter's own gen check guarantees the cache still holds the
    // owner's handle, so it just returns it).
    if (isOwner) {
      this.handles.set(cleaned, handle)
    }
    return handle
  }

  /**
   * Open + migrate the sidecar, retrying the failure modes a
   * CONCURRENT FIRST-INIT produces. Nexus writers are cross-PROCESS by
   * design (RC2's forge/argus/orchestrator emitters), so several
   * connections can race a fresh `<project>/.nexus/` init:
   *
   *   1. `openSidecar` startup pragmas — `PRAGMA journal_mode = WAL`
   *      needs an exclusive lock and runs BEFORE busy_timeout is set
   *      on the new connection, so a sibling's in-flight open/write
   *      makes it throw (PersistenceError with SQLITE_BUSY as cause).
   *   2. SQLITE_BUSY out of the migration transaction itself.
   *   3. `UNIQUE constraint failed: _migrations.version` — two
   *      connections both read an empty `_migrations` snapshot, the
   *      competitor commits first, and the loser's bookkeeping INSERT
   *      collides (migrations/runner.ts records versions AFTER the
   *      stale `seen` read).
   *
   * All three self-heal on re-run: the pragma set is idempotent, and
   * the runner re-reads `_migrations` and skips the competitor's
   * committed version (the 0001 body is additionally CREATE-IF-NOT-
   * EXISTS idempotent). Any OTHER error — corrupt file, bad SQL —
   * propagates immediately. Each attempt opens a FRESH connection
   * (the failed one is closed), and the sleep is `await Bun.sleep`
   * (never sleepSync) per the persistence/retry.ts convention so the
   * gateway watchdog tick keeps firing.
   */
  private async initHandle(project_id: string): Promise<ProjectHandle> {
    const dir = join(this.resolveProjectRoot(project_id), NEXUS_DIR)
    mkdirSync(dir, { recursive: true })
    const nexus_db_path = join(dir, NEXUS_DB)
    for (let attempt = 0; ; attempt++) {
      let db: Database
      try {
        db = openSidecar(nexus_db_path)
      } catch (err) {
        if (isInitRaceError(err) && attempt < INIT_MAX_RETRIES) {
          await Bun.sleep(initRaceJitterMs())
          continue
        }
        throw new NexusStoreError(
          'nexus_unavailable',
          `failed to open ${nexus_db_path}: ${stringifyError(err)}`,
        )
      }
      try {
        applyProjectScopedMigrations(db, this.migrations_dir)
        return { db, nexus_db_path, closed: false }
      } catch (err) {
        try {
          db.close()
        } catch {
          /* ignore */
        }
        if (isInitRaceError(err) && attempt < INIT_MAX_RETRIES) {
          await Bun.sleep(initRaceJitterMs())
          continue
        }
        throw new NexusStoreError(
          'nexus_unavailable',
          `failed to apply nexus migrations: ${stringifyError(err)}`,
        )
      }
    }
  }

  private assertInput(input: AppendNexusEventInput): void {
    // Top-level container guard BEFORE any field access — a null,
    // undefined, array, or primitive payload (untyped caller / future
    // JSON boundary) must be a typed error, not a raw TypeError from
    // dereferencing `.actor_kind`.
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new NexusStoreError(
        'invalid_input',
        'appendEvent input must be an object',
      )
    }
    if (!isNexusActorKind(input.actor_kind)) {
      throw new NexusStoreError(
        'invalid_actor_kind',
        `actor_kind must be one of ${NEXUS_ACTOR_KINDS.join('|')}; got ${String(input.actor_kind)}`,
      )
    }
    if (!isNexusEventKind(input.kind)) {
      throw new NexusStoreError(
        'invalid_event_kind',
        `kind must be one of ${NEXUS_EVENT_KINDS.join('|')}; got ${String(input.kind)}`,
      )
    }
    // Runtime shape checks (not just the TS types): the store is the
    // validated seam, so a malformed caller (`as any`, an untyped JSON
    // boundary in a future RC2 emitter) must get a typed NexusStoreError
    // — never a raw TypeError from dereferencing `.length` on a non-
    // string.
    if (typeof input.actor_id !== 'string' || input.actor_id.length === 0) {
      throw new NexusStoreError(
        'invalid_actor_id',
        'actor_id must be a non-empty string',
      )
    }
    if (typeof input.body !== 'string' || input.body.length === 0) {
      throw new NexusStoreError('invalid_body', 'body must be a non-empty string')
    }
    if (byteLen(input.body) > MAX_NEXUS_BODY_BYTES) {
      throw new NexusStoreError(
        'body_too_large',
        `body exceeds ${MAX_NEXUS_BODY_BYTES} bytes`,
      )
    }
  }
}

/** Attempts for the fresh-sidecar init race (see `initHandle`).
 *  10 × ~20-60 ms of jitter comfortably outlasts a sibling process's
 *  full open+migrate window while keeping a genuinely broken sidecar
 *  failing fast (worst case well under a second). */
const INIT_MAX_RETRIES = 10

function initRaceJitterMs(): number {
  return 20 + Math.random() * 40
}

/**
 * Classify an init failure as the concurrent-first-init race (see
 * `initHandle` for the three modes). Busy errors can hide one level
 * down — `openSidecar` wraps the driver's SQLITE_BUSY in a
 * `PersistenceError` whose `cause` carries the real error — so the
 * check walks a short cause chain.
 */
function isInitRaceError(err: unknown): boolean {
  for (let depth = 0; err !== null && err !== undefined && depth < 4; depth++) {
    if (isBusyError(err)) return true
    if (
      err instanceof Error &&
      /UNIQUE constraint failed: _migrations\.version/i.test(err.message)
    ) {
      return true
    }
    err = err instanceof Error ? err.cause : null
  }
  return false
}

/* ─── refs helpers ───────────────────────────────────────────────── */

export function isNexusActorKind(v: unknown): v is NexusActorKind {
  return (
    typeof v === 'string' &&
    (NEXUS_ACTOR_KINDS as readonly string[]).includes(v)
  )
}

export function isNexusEventKind(v: unknown): v is NexusEventKind {
  return (
    typeof v === 'string' &&
    (NEXUS_EVENT_KINDS as readonly string[]).includes(v)
  )
}

export function isNexusRefKind(v: unknown): v is NexusRefKind {
  return (
    typeof v === 'string' && (NEXUS_REF_KINDS as readonly string[]).includes(v)
  )
}

/** Validate + serialize a refs array. `null`/`[]` → `null` (the column
 *  is NULL when an event carries no refs). Throws `NexusStoreError` on
 *  a malformed entry so bad shapes never reach the log. */
function serializeRefs(refs: NexusRef[] | null): string | null {
  if (refs === null) return null
  // Runtime shape check on the container before we index it — a
  // non-array `refs` (untyped caller) must be a typed error, not a
  // `.length`/iteration TypeError.
  if (!Array.isArray(refs)) {
    throw new NexusStoreError('invalid_ref', 'refs must be an array or null')
  }
  if (refs.length === 0) return null
  const cleaned: NexusRef[] = []
  for (const r of refs) {
    if (typeof r !== 'object' || r === null) {
      throw new NexusStoreError(
        'invalid_ref',
        'each ref must be a { kind, ref, note? } object',
      )
    }
    if (!isNexusRefKind(r.kind)) {
      throw new NexusStoreError(
        'invalid_ref_kind',
        `ref kind must be one of ${NEXUS_REF_KINDS.join('|')}; got ${String(r.kind)}`,
      )
    }
    if (typeof r.ref !== 'string' || r.ref.length === 0) {
      throw new NexusStoreError('invalid_ref', 'ref must be a non-empty string')
    }
    if (r.note !== undefined && typeof r.note !== 'string') {
      throw new NexusStoreError('invalid_ref', 'ref note must be a string')
    }
    cleaned.push(
      r.note === undefined
        ? { kind: r.kind, ref: r.ref }
        : { kind: r.kind, ref: r.ref, note: r.note },
    )
  }
  return JSON.stringify(cleaned)
}

/**
 * Parse a row's `refs_json` back into typed refs. Tolerant by design —
 * the log is append-only and long-lived, so a row written by a future
 * (or buggy) writer must never make a reader throw: malformed JSON or
 * non-conforming entries degrade to being skipped, `null` → `[]`.
 */
export function parseNexusRefs(refs_json: string | null): NexusRef[] {
  if (refs_json === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(refs_json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: NexusRef[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const kind = (entry as Record<string, unknown>)['kind']
    const ref = (entry as Record<string, unknown>)['ref']
    const note = (entry as Record<string, unknown>)['note']
    if (!isNexusRefKind(kind)) continue
    if (typeof ref !== 'string' || ref.length === 0) continue
    if (note !== undefined && typeof note !== 'string') continue
    out.push(note === undefined ? { kind, ref } : { kind, ref, note })
  }
  return out
}

/* ─── small utils (mirrors comment-store) ────────────────────────── */

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function clampLimit(
  raw: number | undefined,
  fallback: number,
  cap: number,
): number {
  if (raw === undefined) return fallback
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.floor(raw), cap)
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return String(err)
  } catch {
    return '<unstringifiable>'
  }
}
