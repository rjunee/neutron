/**
 * ACTIVITY INSPECTOR — the DONE-MEANS-SERVED test (SPEC § WAVE 3.5).
 *
 * The repo's single most recurring defect is a module whose own tests pass while no
 * composer ever calls it (persona-gen: built, never wired, shipped placeholders for
 * months). So this test refuses to mock the middle. It boots the REAL Open composer
 * and drives the full chain a live tool call takes:
 *
 *   the tool-tap hook's POST  →  the loopback sink's `/activity` route
 *                             →  the closure the COMPOSER registered via
 *                                `setReplActivityTap`
 *                             →  the in-memory inspector ring
 *                             →  `GET /api/app/projects/<id>/activity`
 *
 * Nothing in that path is stubbed. If the composer stops constructing the inspector,
 * stops registering the tap, or stops handing the surface to the graph, this fails —
 * which is exactly what "wired but not served does not count" has to mean mechanically.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { drainRealmodeCleanups } from '@neutronai/gateway/index.ts'
import { ChunkedUploadSweeper } from '@neutronai/gateway/upload/chunked-upload-sweeper.ts'
import { SqliteUploadSessionStore } from '@neutronai/gateway/upload/upload-session-store.ts'
import { SupervisedLoop } from '@neutronai/loop'
import type { LoopDescriptor } from '@neutronai/loop'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { getReplSinkInfo } from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import { sink } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { ReplSession } from '@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts'

import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string | undefined

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-actin-served-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-actin-served'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

function cannedHandle(instanceId: string): SessionHandle {
  const events = (async function* (): AsyncGenerator<Event, void, void> {
    yield { kind: 'token', text: 'ready' }
    yield {
      kind: 'completion',
      usage: { input_tokens: 1, output_tokens: 1 },
      substrate_instance_id: instanceId,
    }
  })()
  return {
    events,
    async respondToTool(): Promise<void> {},
    async cancel(): Promise<void> {},
    tool_resolution: 'internal',
  }
}

interface ActivityBody {
  scope_key: string
  project_id: string | null
  events: Array<{
    seq: number
    kind: string
    label: string
    detail?: string
    /** The expanded content — assistant words, full arguments, tool output. */
    body?: string
    /** The MCP server qualifier, incarnation stripped. */
    source?: string
    synthetic?: boolean
  }>
  state: string
  last_event_age_ms: number | null
  last_real_activity_age_ms: number | null
  turn_in_flight: boolean
}

/** The composition the REAL Open composer returns for this fixture. */
type OpenComposition = Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>

async function withComposition(
  body: (c: {
    handler: (req: Request) => Promise<Response | null>
    get: (path: string) => Promise<Response | null>
    /** The fixture-owned DB this composition runs on (closed by the fixture). */
    db: ProjectDb
    /** The composed object, including its `realmode_cleanups` + `loop_registry`. */
    composition: OpenComposition
  }) => Promise<void>,
): Promise<void> {
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start: () => cannedHandle(opts.substrate_instance_id),
  })
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  const composer = buildOpenGraphComposer({ env: process.env, substrateFactory })
  const composition = await composer({ db, project_slug: 'owner' })
  try {
    const surface = (composition as unknown as Record<string, unknown>)['app_activity_surface'] as
      | { handler: (req: Request) => Promise<Response | null> }
      | undefined
    // The composer MUST have constructed + supplied the surface. This is the
    // done-means-served gate, not a nicety.
    expect(surface).toBeDefined()
    await body({
      handler: surface!.handler,
      get: (path) =>
        surface!.handler(
          new Request(`http://127.0.0.1${path}`, {
            // The surface is bearer-gated exactly like tabs/work-board; the
            // single-owner dev path accepts the instance slug.
            headers: { authorization: 'Bearer owner' },
          }),
        ),
      db,
      composition,
    })
  } finally {
    // Quiesce BEFORE close: the production drain awaits every registered
    // cleanup in forward order (each loop's quiescing stop() waits for its
    // in-flight tick) and continues past a rejecting one, so no composed loop
    // can still be writing when the DB closes. A body failure still propagates
    // after this finally completes.
    await drainRealmodeCleanups(composition.realmode_cleanups ?? [])
    db.close()
  }
}

/**
 * POST to the loopback sink exactly as the Pre/PostToolUse hook does — INCLUDING the
 * part where the hook belongs to a session the gateway is driving.
 *
 * The `session_id` these cases send used to be `'unregistered'`, and the sink
 * recorded the row anyway under the General scope. ISSUES #537 made the sink token
 * durable, so an unregistered session id stopped meaning "a row we might as well
 * keep" and started meaning "an orphaned child from a previous incarnation, holding
 * a credential nothing rotates" — the sink refuses those now. A real hook always has
 * a live session (`spawnSession` registers it BEFORE spawning the child), so
 * registering one here is what makes this test post what the hook posts.
 */
const TAP_SESSION_ID = 'activity-served-live-session'

/** Register the session AND return the credential that child would present. The route
 *  authorizes credential → session, so the instance root token is not a way in: a
 *  session id is published to the process table and proves nothing on its own. */
function registerTapSession(): string {
  const session = new ReplSession('k', 'gen', TAP_SESSION_ID, 'chan', '/tmp')
  sink.register(TAP_SESSION_ID, session)
  return sink.credentialFor(session)
}

async function tapPost(payload: Record<string, unknown>): Promise<Response> {
  const info = await getReplSinkInfo()
  const credential = registerTapSession()
  return fetch(`http://127.0.0.1:${info.port}/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Sink-Token': credential },
    body: JSON.stringify({ session_id: TAP_SESSION_ID, ...payload }),
  })
}

describe('Activity Inspector — served end-to-end through the real Open composer', () => {
  test('the surface answers for a project scope AND the General scope', async () => {
    await withComposition(async ({ get }) => {
      const proj = await get('/api/app/projects/proj-1/activity')
      expect(proj?.status).toBe(200)
      const pb = (await proj!.json()) as ActivityBody
      expect(pb.scope_key).toBe('proj-1')
      expect(pb.project_id).toBe('proj-1')
      // A never-touched scope is empty + idle, never an error and never "wedged".
      expect(pb.events).toEqual([])
      expect(pb.state).toBe('idle')
      expect(pb.last_event_age_ms).toBeNull()

      // General is a first-class scope — mobile and web both model a no-project
      // General chat with its own warm session, so it must be inspectable without a
      // project row existing anywhere.
      const gen = await get('/api/app/activity')
      expect(gen?.status).toBe(200)
      const gb = (await gen!.json()) as ActivityBody
      expect(gb.scope_key).toBe('~general')
      expect(gb.project_id).toBeNull()
    })
  })

  test('a tool-tap POST reaches the HTTP snapshot — the whole chain, unmocked', async () => {
    await withComposition(async ({ get }) => {
      // This is what the CC subprocess hook does on a real `Bash` call.
      const pre = await tapPost({
        phase: 'pre',
        tool_name: 'Bash',
        detail: 'bun test open/',
      })
      expect(pre.status).toBe(200)

      // A session carrying no project scope records against the General scope —
      // assert the row landed THERE, so the test pins real behaviour rather than a
      // hoped-for scope.
      const res = await get('/api/app/activity')
      const body = (await res!.json()) as ActivityBody
      expect(body.events).toHaveLength(1)
      expect(body.events[0]?.kind).toBe('tool_start')
      expect(body.events[0]?.label).toBe('Bash')
      expect(body.events[0]?.detail).toBe('bun test open/')
      // A tool row is REAL activity, so both clocks moved.
      expect(body.last_event_age_ms).not.toBeNull()
      expect(body.last_real_activity_age_ms).not.toBeNull()

      // The finish half arrives as its own row: a `pre` with no `post` is the hang
      // signal, so they must be distinct rows, not a mutation of one.
      await tapPost({ phase: 'post', tool_name: 'Bash', detail: '' })
      const res2 = await get('/api/app/activity')
      const body2 = (await res2!.json()) as ActivityBody
      expect(body2.events.map((e) => e.kind)).toEqual(['tool_start', 'tool_end'])
      expect(body2.events.map((e) => e.seq)).toEqual([1, 2])
    })
  })

  test('ARGUMENTS and RESULTS survive the whole unmocked chain to the snapshot', async () => {
    // The content the first build could not show at all: a finished tool row said
    // nothing about what came back. Fixtures synthesised — public repo.
    await withComposition(async ({ get }) => {
      await tapPost({
        phase: 'post',
        tool_name: 'Bash',
        detail: 'a-command',
        args: 'a-command --flag',
        result: 'first output line\nsecond output line',
      })
      const body = (await (await get('/api/app/activity'))!.json()) as ActivityBody
      const row = body.events[0]
      expect(row?.kind).toBe('tool_end')
      expect(row?.label).toBe('Bash')
      // The RETURN is what a post row leads with.
      expect(row?.body).toContain('second output line')
      // Newlines survive: the shape of a listing is most of its meaning.
      expect(row?.body).toContain('\n')
    })
  })

  test('a namespaced MCP tool reaches the client HUMANISED, never as a transport id', async () => {
    // `spawn.ts` names the dev-channel server with a per-spawn random suffix, so the
    // raw form is both unreadable and unstable. It must not survive to the wire.
    await withComposition(async ({ get }) => {
      await tapPost({
        phase: 'pre',
        tool_name: `mcp__neutron-${'ab'.repeat(16)}__memory_search`,
        detail: 'a-query',
        args: 'a-query',
      })
      const body = (await (await get('/api/app/activity'))!.json()) as ActivityBody
      const row = body.events[0]
      expect(row?.label).toBe('memory_search')
      expect(row?.label).not.toContain('mcp__')
      expect(row?.source).toBe('neutron')
    })
  })

  test('the reply tool call arrives as the ASSISTANT MESSAGE, and its ack is dropped', async () => {
    // The interleave, end to end: the agent's words are a tool call on the wire.
    await withComposition(async ({ get }) => {
      const words = 'a synthesised assistant sentence'
      const server = `mcp__neutron-${'cd'.repeat(16)}__reply`
      await tapPost({
        phase: 'pre',
        tool_name: server,
        detail: words,
        args: words,
      })
      await tapPost({ phase: 'post', tool_name: server, detail: '' })
      const body = (await (await get('/api/app/activity'))!.json()) as ActivityBody
      // Exactly ONE row: the message. The post-ack is noise and never lands.
      expect(body.events).toHaveLength(1)
      expect(body.events[0]?.kind).toBe('token')
      expect(body.events[0]?.label).toBe('assistant')
      expect(body.events[0]?.detail).toBe(words)
    })
  })

  test('the surface is bearer-gated and read-only', async () => {
    await withComposition(async ({ handler }) => {
      const noAuth = await handler(new Request('http://127.0.0.1/api/app/activity'))
      expect(noAuth?.status).toBe(401)

      const write = await handler(
        new Request('http://127.0.0.1/api/app/activity', {
          method: 'POST',
          headers: { authorization: 'Bearer owner' },
        }),
      )
      // Read-only: the buffer is produced by the server's own taps, never a client.
      expect(write?.status).toBe(405)
    })
  })

  test('returns null (falls through the ladder) for an unrelated path', async () => {
    await withComposition(async ({ handler }) => {
      const other = await handler(
        new Request('http://127.0.0.1/api/app/projects/p/work-board', {
          headers: { authorization: 'Bearer owner' },
        }),
      )
      expect(other).toBeNull()
    })
  })

  test('rejects a malformed project id rather than mis-scoping the buffer', async () => {
    await withComposition(async ({ get }) => {
      const bad = await get('/api/app/projects/has%20a%20space/activity')
      expect(bad?.status).toBe(400)
    })
  })
})

// ─── Teardown quiescence: the fixture drains BEFORE it closes its DB ───────────
//
// `withComposition` boots the REAL composer, which arms real DB-using loops. Its
// teardown must await the production drain (`drainRealmodeCleanups`) so every
// loop's quiescing stop() lets an in-flight tick finish its DB write BEFORE
// `db.close()`. These cases hold a real composed tick behind an explicit barrier
// and observe the teardown's ordered progress — no fixed microtask flushing, no
// synthetic loop. All instrumentation is local to this file on purpose.

/** The composed upload sweeper's SupervisedLoop identity (open/wiring/uploads.ts). */
const SWEEPER_LOOP = 'chunked-upload-sweeper'
/** The seeded, already-expired `uploading` row the held tick must process. */
const HELD_UPLOAD_ID = 'held-expired-1'
/** Labelled guard deadline: a hang reports as a NAMED wait, not a test timeout. */
const WAIT_GUARD_MS = 10_000

interface Deferred {
  promise: Promise<void>
  release: () => void
}

function deferred(): Deferred {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

/** A pending wait plus a way to abandon it (clears its guard timer and waker). */
interface Wait {
  promise: Promise<void>
  cancel(): void
}

/** Ordered event log whose waits are resolved by the push itself (no polling). */
interface Recorder {
  events: string[]
  push(event: string): void
  has(event: string): boolean
  count(event: string): number
  waitFor(event: string): Promise<void>
  /** Like `waitFor`, but cancellable by a caller that stops waiting early. */
  wait(event: string): Wait
}

function recorder(): Recorder {
  const events: string[] = []
  const waiters = new Map<string, Array<() => void>>()
  return {
    events,
    push(event) {
      events.push(event)
      const pending = waiters.get(event)
      if (pending === undefined) return
      waiters.delete(event)
      for (const wake of pending) wake()
    },
    has: (event) => events.includes(event),
    count: (event) => events.filter((e) => e === event).length,
    waitFor(event) {
      return this.wait(event).promise
    },
    wait(event) {
      if (events.includes(event)) return { promise: Promise.resolve(), cancel: () => {} }
      let guard: ReturnType<typeof setTimeout> | undefined
      let wake: (() => void) | undefined
      const promise = new Promise<void>((resolve, reject) => {
        guard = setTimeout(() => {
          reject(
            new Error(
              `waitFor('${event}') passed its ${WAIT_GUARD_MS}ms guard deadline; events so far: ${events.join(' > ')}`,
            ),
          )
        }, WAIT_GUARD_MS)
        wake = () => {
          clearTimeout(guard)
          resolve()
        }
        const list = waiters.get(event) ?? []
        list.push(wake)
        waiters.set(event, list)
      })
      return {
        promise,
        // Abandoned (e.g. it lost the race in untilOrRunFailure): stop the guard
        // timer and drop the waker, so no stale deadline outlives the test.
        cancel() {
          clearTimeout(guard)
          const list = waiters.get(event)
          if (list === undefined || wake === undefined) return
          const rest = list.filter((w) => w !== wake)
          if (rest.length === 0) waiters.delete(event)
          else waiters.set(event, rest)
        },
      }
    },
  }
}

/** Instance-level close probe: records WHEN the fixture closes its DB. */
function armDbClose(db: ProjectDb, rec: Recorder): void {
  const realClose = db.close.bind(db)
  db.close = () => {
    rec.push('db:closed')
    realClose()
  }
}

/**
 * Wait for `event`, but if the composition run REJECTS first with anything other
 * than the body's own `expected` failure (an in-body assertion, or the composer
 * itself), throw that error: the real cause, not a later guard-deadline timeout
 * that hides it. Whichever way the race goes, the wait is cancelled afterwards,
 * so a wait that lost the race leaves no guard timer running.
 */
async function untilOrRunFailure(
  rec: Recorder,
  event: string,
  run: Promise<void>,
  expected?: unknown,
): Promise<void> {
  const waiting = rec.wait(event)
  try {
    await Promise.race([
      waiting.promise,
      run.then(
        () => waiting.promise,
        (err: unknown) => {
          if (expected !== undefined && err === expected) return waiting.promise
          throw err
        },
      ),
    ])
  } finally {
    waiting.cancel()
  }
}

/**
 * A rejecting cleanup whose rejection is OBSERVABLY consumed. It returns a
 * thenable (which `await` adopts by calling its `then`) that records
 * `<label>:handled` only when a consumer attaches a rejection handler, and
 * delivers its error only through that handler, so it can never surface as an
 * unhandled rejection. `<label>:handled` proves only that SOME consumer attached
 * a rejection handler and received the error; a consumer that then drops the
 * error records it too (see the test's controls). That the drain then CONTINUED
 * is proven separately, by the later cleanup entering and by the ordered events
 * after it. A process-level
 * `unhandledRejection` listener cannot provide this evidence under `bun test`,
 * whose runner fails the running test on an unhandled rejection before any such
 * listener can observe it.
 */
function observedRejection(rec: Recorder, label: string): Promise<void> {
  rec.push(`${label}:ran`)
  const err = new Error(label)
  const thenable = {
    then(_onFulfilled?: unknown, onRejected?: (reason: unknown) => unknown): void {
      if (typeof onRejected !== 'function') return
      rec.push(`${label}:handled`)
      onRejected(err)
    },
  }
  return thenable as unknown as Promise<void>
}

/**
 * Replace every REGISTERED cleanup IN PLACE with a counting wrapper, before
 * teardown begins, so the fixture's own drain is what is counted. Positive
 * control: a composition with no registered cleanup would make the count vacuous.
 */
function countCleanups(composition: OpenComposition): number[] {
  const cleanups = composition.realmode_cleanups
  expect(cleanups).toBeDefined()
  const counts: number[] = []
  cleanups!.forEach((orig, i) => {
    counts[i] = 0
    cleanups![i] = () => {
      counts[i] = (counts[i] ?? 0) + 1
      return orig()
    }
  })
  expect(counts.length).toBeGreaterThan(0)
  return counts
}

/**
 * Prototype instrumentation for the composed upload sweeper, installed BEFORE the
 * composer runs (module identity matches what open/wiring/uploads.ts imports):
 *  - captures the sweeper's SupervisedLoop by its public descriptor name;
 *  - holds the real `SqliteUploadSessionStore.markExpired` write for the seeded
 *    row behind `gate`, then runs the original and records its real result;
 *  - records the sweeper's quiescing stop() start/end as teardown progress.
 * `restore()` is idempotent. The test calls it FIRST in its finally, before it
 * awaits teardown, and the suite's `afterEach` calls it again for any probe still
 * installed, so the prototypes are restored even when teardown hangs and the test
 * is abandoned at its timeout without its finally completing.
 */
interface SweeperProbe {
  loop(): SupervisedLoop | null
  restore(): void
}

/** Probes not yet restored; the describe's `afterEach` restores any left over. */
const installedProbes = new Set<SweeperProbe>()

function installSweeperProbe(rec: Recorder, gate: Promise<void>): SweeperProbe {
  const realStart = SupervisedLoop.prototype.start
  const realMarkExpired = SqliteUploadSessionStore.prototype.markExpired
  const realStop = ChunkedUploadSweeper.prototype.stop
  let captured: SupervisedLoop | null = null

  SupervisedLoop.prototype.start = function probedStart(this: SupervisedLoop): void {
    // Identify the loop through its PUBLIC descriptor name (`describe()`), not the
    // TS-private `name` field.
    if (this.describe().name === SWEEPER_LOOP) captured = this
    return realStart.call(this)
  }
  SqliteUploadSessionStore.prototype.markExpired = async function probedMarkExpired(
    this: SqliteUploadSessionStore,
    upload_id: string,
  ): Promise<boolean> {
    if (upload_id !== HELD_UPLOAD_ID) return realMarkExpired.call(this, upload_id)
    rec.push('markExpired:entered')
    await gate
    try {
      const result = await realMarkExpired.call(this, upload_id)
      rec.push(`markExpired:wrote:${String(result)}`)
      return result
    } catch (err) {
      rec.push('markExpired:threw')
      throw err
    }
  }
  ChunkedUploadSweeper.prototype.stop = async function probedStop(
    this: ChunkedUploadSweeper,
  ): Promise<void> {
    rec.push('sweeper.stop:start')
    await realStop.call(this)
    rec.push('sweeper.stop:end')
  }

  const probe: SweeperProbe = {
    loop: () => captured,
    restore() {
      if (!installedProbes.delete(probe)) return
      SupervisedLoop.prototype.start = realStart
      SqliteUploadSessionStore.prototype.markExpired = realMarkExpired
      ChunkedUploadSweeper.prototype.stop = realStop
    },
  }
  installedProbes.add(probe)
  return probe
}

function heldRowStatus(db: ProjectDb): string | undefined {
  return db.get<{ status: string }, [string]>(
    'SELECT status FROM upload_sessions WHERE upload_id = ?',
    [HELD_UPLOAD_ID],
  )?.status
}

describe('withComposition quiesces the composed loops before it closes the DB', () => {
  // Safety net: a test abandoned at its timeout (a hung teardown) never finishes
  // its finally, so restore any probe it left installed before the next test.
  afterEach(() => {
    for (const probe of [...installedProbes]) probe.restore()
  })

  for (const outcome of ['returns', 'throws'] as const) {
    test(
      `a held real sweeper tick finishes its DB write before close (body ${outcome})`,
      async () => {
        const rec = recorder()
        const tick = deferred()
        const probe = installSweeperProbe(rec, tick.promise)
        const bodyFailure = new Error('body-failure')
        let bodyErr: unknown = null
        let inBodyErr: unknown = null
        // An in-body assertion failure is the REAL cause; surface it before any
        // later teardown assertion can fail on its consequences instead.
        const surfaceUnexpected = (err: unknown): void => {
          if (err !== null && err !== bodyFailure) throw err
        }
        let heldDb: ProjectDb | null = null
        let sweeperDescriptor: LoopDescriptor | undefined
        let counts: number[] = []
        let settled: Promise<void> = Promise.resolve()
        try {
          const run = withComposition(async ({ db, composition }) => {
            try {
              heldDb = db
              armDbClose(db, rec)
              counts = countCleanups(composition)

              // The composed loop is live and is the one the probe captured.
              sweeperDescriptor = composition.loop_registry?.get(SWEEPER_LOOP)
              expect(sweeperDescriptor?.isActive?.()).toBe(true)
              const loop = probe.loop()
              expect(loop).not.toBeNull()

              // Seed a KNOWN expired row that is still `uploading`.
              const store = new SqliteUploadSessionStore(db)
              const now = Date.now()
              await store.create({
                upload_id: HELD_UPLOAD_ID,
                project_slug: 'owner',
                source: 'chatgpt',
                filename: 'x.zip',
                total_bytes: 10,
                mime_type: 'application/zip',
                created_at: now - 120_000,
                expires_at: now - 60_000,
              })
              expect((await store.get(HELD_UPLOAD_ID))?.status).toBe('uploading')
              const expired = await store.listExpiredUploading(Date.now(), 100)
              expect(expired.map((r) => r.upload_id)).toContain(HELD_UPLOAD_ID)

              // Drive the REAL composed loop tick; it enters the held write.
              void loop!.runOnce()
              await rec.waitFor('markExpired:entered')
            } catch (err) {
              inBodyErr = err
              throw err
            }
            if (outcome === 'throws') throw bodyFailure
          })
          settled = run.then(
            () => rec.push('teardown:settled'),
            (err: unknown) => {
              bodyErr = err
              rec.push('teardown:settled')
            },
          )

          // Teardown has reached the sweeper's quiescing stop() while the tick is held.
          await untilOrRunFailure(rec, 'sweeper.stop:start', run, bodyFailure)
          surfaceUnexpected(inBodyErr)
          expect(rec.has('markExpired:entered')).toBe(true)
          expect({
            teardownSettledWhileHeld: rec.has('teardown:settled'),
            dbClosedWhileHeld: rec.has('db:closed'),
          }).toEqual({ teardownSettledWhileHeld: false, dbClosedWhileHeld: false })
          // The DB is still open and usable while the tick is held.
          expect(heldRowStatus(heldDb!)).toBe('uploading')

          tick.release()
          await settled
          // The body's own outcome first: the original failure survived cleanup.
          surfaceUnexpected(bodyErr)
          if (outcome === 'throws') expect(bodyErr).toBe(bodyFailure)
          else expect(bodyErr).toBeNull()

          // The held write committed before close, and close preceded settlement.
          const order = [
            'markExpired:entered',
            'sweeper.stop:start',
            'markExpired:wrote:true',
            'sweeper.stop:end',
            'db:closed',
            'teardown:settled',
          ]
          const positions = order.map((e) => rec.events.indexOf(e))
          expect({ teardownOrder: positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!)) }).toEqual({
            teardownOrder: true,
          })
          expect(rec.has('markExpired:threw')).toBe(false)
          expect(rec.count('db:closed')).toBe(1)

          // The loop is inactive, and each registered cleanup ran exactly once.
          expect(sweeperDescriptor?.isActive?.()).toBe(false)
          expect({ cleanupRunsPerTeardown: counts }).toEqual({
            cleanupRunsPerTeardown: counts.map(() => 1),
          })

          // The real write landed: reopen the file and read the row.
          const verify = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
          try {
            expect(heldRowStatus(verify)).toBe('expired')
          } finally {
            verify.close()
          }
        } finally {
          // Restore the prototypes BEFORE awaiting teardown, so a hung or failing
          // teardown cannot leave them patched. In-flight probed calls keep the
          // originals they captured, so restoring here cannot strand the held tick.
          probe.restore()
          tick.release()
          await settled
        }
      },
      30_000,
    )
  }

  test('a rejecting cleanup does not skip a later held one or close early', async () => {
    const rec = recorder()
    const gate = deferred()
    let heldDb: ProjectDb | null = null
    let counts: number[] = []
    const appended = { reject: 0, held: 0 }
    let settled: Promise<void> = Promise.resolve()
    let runErr: unknown = null
    try {
      // Controls for the handled-rejection probe. (1) A rejection nobody consumes
      // records no handler, so `reject:handled` below is not vacuous. (2) A caller
      // that attaches a handler and then DROPS the error records `handled` too, and
      // its handler receives the probe's own error. So `handled` proves only that a
      // handler consumed the rejection; it cannot tell a drain that continues from
      // one that stops, which is why continuation is asserted from event order.
      const control = recorder()
      observedRejection(control, 'unconsumed')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(control.events).toEqual(['unconsumed:ran'])
      const dropping = recorder()
      let dropped: unknown = null
      try {
        await observedRejection(dropping, 'dropped')
      } catch (err) {
        dropped = err
      }
      expect(dropping.events).toEqual(['dropped:ran', 'dropped:handled'])
      expect(dropped).toBeInstanceOf(Error)
      expect((dropped as Error).message).toBe('dropped')

      const run = withComposition(async ({ db, composition }) => {
        heldDb = db
        armDbClose(db, rec)
        counts = countCleanups(composition)
        composition.realmode_cleanups!.push(() => {
          appended.reject++
          return observedRejection(rec, 'reject')
        })
        composition.realmode_cleanups!.push(async () => {
          appended.held++
          rec.push('held:entered')
          await gate.promise
          rec.push('held:released')
        })
      })
      settled = run.then(
        () => rec.push('teardown:settled'),
        (err: unknown) => {
          runErr = err
          rec.push('teardown:settled')
        },
      )

      await untilOrRunFailure(rec, 'held:entered', run)
      expect(rec.events.indexOf('reject:ran')).toBeGreaterThanOrEqual(0)
      expect(rec.events.indexOf('reject:ran')).toBeLessThan(rec.events.indexOf('held:entered'))
      expect({
        teardownSettledWhileHeld: rec.has('teardown:settled'),
        dbClosedWhileHeld: rec.has('db:closed'),
      }).toEqual({ teardownSettledWhileHeld: false, dbClosedWhileHeld: false })
      expect(heldDb!.get<{ one: number }>('SELECT 1 AS one')?.one).toBe(1)

      gate.release()
      await settled
      if (runErr !== null) throw runErr

      const order = ['reject:ran', 'held:entered', 'held:released', 'db:closed', 'teardown:settled']
      const positions = order.map((e) => rec.events.indexOf(e))
      expect({ teardownOrder: positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!)) }).toEqual({
        teardownOrder: true,
      })
      expect({ cleanupRunsPerTeardown: counts }).toEqual({
        cleanupRunsPerTeardown: counts.map(() => 1),
      })
      expect(appended).toEqual({ reject: 1, held: 1 })
      expect(rec.count('db:closed')).toBe(1)

      // The drain consumed the rejection (a handler was attached and the error
      // was delivered there). That it then continued is what the held cleanup
      // entering, and the order asserted above, prove.
      expect(rec.count('reject:handled')).toBe(1)
      expect(rec.events.indexOf('reject:handled')).toBeLessThan(rec.events.indexOf('held:entered'))
    } finally {
      gate.release()
      await settled
    }
  }, 30_000)

  test('control: with no registered cleanup the fixture still closes normally', async () => {
    const rec = recorder()
    let sweeperDescriptor: LoopDescriptor | undefined
    await withComposition(async ({ db, composition }) => {
      armDbClose(db, rec)
      sweeperDescriptor = composition.loop_registry?.get(SWEEPER_LOOP)
      expect(sweeperDescriptor?.isActive?.()).toBe(true)
      // Take every registered cleanup off the list and dispose of them here, so
      // the fixture's own drain sees an empty list and no loop is live at close.
      const saved = composition.realmode_cleanups!.splice(0)
      try {
        expect(saved.length).toBeGreaterThan(0)
        expect(composition.realmode_cleanups).toEqual([])
      } finally {
        // Disposed even when an assertion above fails, so no loop outlives close.
        await drainRealmodeCleanups(saved)
      }
    })
    expect(rec.count('db:closed')).toBe(1)
    expect(sweeperDescriptor?.isActive?.()).toBe(false)
  }, 30_000)
})
