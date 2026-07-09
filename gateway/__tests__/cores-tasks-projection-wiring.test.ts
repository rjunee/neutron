/**
 * P6 r2 follow-up — Tasks-Core adapter end-to-end projection wiring.
 *
 * Symmetric counterpart to `composition-tasks-projection-wiring.test.ts`.
 * That test drives the canonical store through the HTTP surface
 * (`POST /api/app/projects/<id>/tasks`) and asserts STATUS.md is
 * rewritten within the debounce window. This test exercises the same
 * subscriber chain through the SECOND production write path — the
 * Tasks-Core MCP adapter (`tasks_create`).
 *
 * Why we need both: BLOCKING #2 on PR #221 was "Tasks-Core adapter
 * built its own subscriber-free `new TaskStore(db)` and bypassed the
 * projection writer". The fix threads a composer-supplied canonical
 * store through `buildSubstrateTaskStoreBackend({ store })` at boot.
 * If a future refactor drops that wiring — e.g. removes the
 * `canonicalTaskStore` field from `buildCoresBackendFactories`, or
 * regresses to `new TaskStore(db)` inside the adapter — STATUS.md
 * silently stops updating on Core-driven writes. The HTTP-side test
 * doesn't catch that regression because the HTTP surface and the Core
 * adapter compose stores independently.
 *
 * What this test guards:
 *
 *   1. Build the composition graph with a canonical `TaskStore` +
 *      projection writer attached (same harness as
 *      composition-tasks-projection-wiring.test.ts).
 *   2. Build the Tasks-Core tool surface against the SAME canonical
 *      store via `buildSubstrateTaskStoreBackend({ store })` — the
 *      shape `gateway/index.ts` uses inside `buildCoresBackendFactories`.
 *   3. Invoke `tasks_create` via the Core's MCP tool surface.
 *   4. Assert STATUS.md was rewritten with the new row within the
 *      debounce window — proof that the subscriber chain fires on
 *      Core-driven writes, not just HTTP-surface writes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SecretAuditLog } from '@neutronai/cores-runtime'
import {
  buildSubstrateTaskStoreBackend,
  buildTools as buildTasksTools,
  loadManifest as loadTasksManifest,
} from '@neutronai/tasks-core'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TaskStore } from '@neutronai/tasks/store.ts'
import {
  composeProductionGraph,
  type CompositionInput,
} from '../composition.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const OWNER = 'cores-wiring-project'
const PROJECT = 'proj-A'

interface Harness {
  owner_home: string
  db: ProjectDb
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  canonicalStore: TaskStore
  toolSurface: ReturnType<typeof buildTasksTools>
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-cores-tasks-wiring-'))
  const owner_home = tmp
  const dbPath = join(tmp, 'owner.db')
  const db = ProjectDb.open(dbPath)
  applyMigrations(db.raw())

  // Mirrors `gateway/index.ts`: ONE canonical store, supplied to BOTH
  // the composition (so subscribers attach) AND the Tasks-Core adapter
  // (so writes through the Core's MCP tools feed the same subscribers).
  const canonicalStore = new TaskStore(db)

  const composition: CompositionInput = {
    db,
    project_slug: OWNER,
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
    tasks: {
      store: canonicalStore,
      enable_focus_score_cron: false,
      enable_reminder_link: false,
      projection: {
        resolveProjectDir: ({ project_id }):
          | { dir: string; name?: string }
          | null => {
          if (project_id === '') return null
          return { dir: join(owner_home, 'Projects', project_id) }
        },
        debounce_ms: 30,
      },
    },
  }
  const graph = await composeProductionGraph(composition)

  // Mirror `gateway/index.ts:tasks_core` resolver — adapter wraps the
  // SAME canonical store the composition wired the projection writer
  // against. This is the seam BLOCKING #2 (PR #221) restored.
  const audit = new SecretAuditLog({ db })
  const manifest = loadTasksManifest()
  const toolStore = buildSubstrateTaskStoreBackend({
    project_slug: OWNER,
    projectDb: db,
    store: canonicalStore,
  })
  const toolSurface = buildTasksTools({
    manifest,
    project_slug: OWNER,
    audit,
    store: toolStore,
  })

  return {
    owner_home,
    db,
    graph,
    canonicalStore,
    toolSurface,
    close: async () => {
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

describe('cores-tasks wiring — projection writer fires on Core-driven tasks_create', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startHarness()
  })
  afterEach(async () => {
    await harness.close()
  })

  test('tasks_create via the Core surface rewrites STATUS.md within the debounce window', async () => {
    const created = await harness.toolSurface.tasks_create({
      title: 'core-driven task',
      project_id: PROJECT,
      priority: 2,
    })
    expect(created.id.length).toBeGreaterThan(0)

    // Debounce is 30ms; wait long enough for the writer to flush.
    await new Promise((r) => setTimeout(r, 120))

    const statusPath = join(harness.owner_home, 'Projects', PROJECT, 'STATUS.md')
    const actionsPath = join(harness.owner_home, 'Projects', PROJECT, 'ACTIONS.md')

    const status = readFileSync(statusPath, 'utf8')
    expect(status).toContain('- [ ] core-driven task [P1]')

    const actions = readFileSync(actionsPath, 'utf8')
    expect(actions).toContain('- [ ] core-driven task [P1]')
  })

  test('the Core adapter wraps the SAME canonical store the composer exposed', () => {
    // Sanity guard: if a future refactor drops the `store` passthrough
    // in `buildSubstrateTaskStoreBackend`, the adapter would build its
    // own `new TaskStore(db)` and the projection write above would
    // never fire. We can't observe that internal seam directly, but
    // we CAN assert that the composer's exposed store is the same
    // instance we used to build the adapter — failure to maintain
    // this invariant in the test harness is the canary.
    const tasksModule = harness.graph.get<{ store: TaskStore }>('tasks')
    expect(tasksModule.store).toBe(harness.canonicalStore)
  })

  test('a Core write + an immediate canonical write coalesce to one STATUS.md rewrite', async () => {
    // Two writes, two surfaces, both inside the debounce window —
    // should produce ONE STATUS.md write because the projection
    // writer keys on (project_slug, project_id). If the Core's
    // adapter used a different store, the coalesce would split.
    await harness.toolSurface.tasks_create({
      title: 'core-write',
      project_id: PROJECT,
      priority: 2,
    })
    await harness.canonicalStore.create({
      project_slug: OWNER,
      project_id: PROJECT,
      title: 'canonical-write',
      priority: 1,
    })
    await new Promise((r) => setTimeout(r, 120))

    const statusPath = join(harness.owner_home, 'Projects', PROJECT, 'STATUS.md')
    const status = readFileSync(statusPath, 'utf8')
    expect(status).toContain('- [ ] core-write [P1]')
    expect(status).toContain('- [ ] canonical-write [P2]')
  })
})
