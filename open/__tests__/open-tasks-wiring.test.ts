/**
 * ISSUES #440 — the tasks composition block, asserted against what the REAL
 * composer emits.
 *
 * `gateway/composition/input/tasks-input.ts` declares six task capabilities and
 * `build-core-modules.ts` gates each on a `=== true` flag. Five of them
 * (`enable_focus_score_cron`, `enable_task_prioritize_cron`,
 * `enable_reminder_link`, `store`, `projection`) were never set by any
 * composer, so every one shipped as a guaranteed no-op — while the input's own
 * doc comment claimed "production wires all three."
 *
 * The reason nobody caught it: every existing wiring test HAND-BUILDS the config
 * literal the composer should have produced and then asserts the gate works.
 * That proves the consumer, never the producer. So these assertions run
 * `buildOpenGraphComposer` — the actual production composer, the only one Open
 * has — and read its actual output. Delete a line from `open/composer.ts`'s
 * `tasksConfig` and the matching test here reds.
 *
 * The store-identity tests go further than reading a field: they attach a
 * subscriber to `composition.tasks.store` and then drive a write through the
 * OTHER two surfaces (the app HTTP handler and the Tasks Core adapter). A
 * `TaskStore` carries the subscriber list, so a surface holding a different
 * instance over the same db passes any "the row is in the table" check and
 * fails these. That is the actual defect being guarded: Open used to build
 * three separate stores.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { TaskMutationEvent } from '@neutronai/tasks/store.ts'
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
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let db: ProjectDb

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-tasks-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-tasks-test-secret-0123456789'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH'])
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

function cleanup(composition: { realmode_cleanups?: Array<() => void> }): void {
  for (const c of composition.realmode_cleanups ?? []) {
    try {
      c()
    } catch {
      /* best-effort */
    }
  }
}

describe('Open tasks composition wiring (ISSUES #440)', () => {
  test('the composer supplies THE canonical TaskStore — not the private fallback', async () => {
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    // Absent this, `build-core-modules.ts` builds `new TaskStore(input.db)` and
    // attaches every subscriber to an object no surface holds.
    expect(composition.tasks?.store).toBeDefined()
    expect(typeof composition.tasks?.store?.subscribe).toBe('function')

    cleanup(composition)
  }, 20_000)

  test('the focus-score recompute cron is ON — with or without a credential', async () => {
    // No LLM, no network: the pass is a read plus one transaction, and the
    // time-derived half of every focus score goes stale without it.
    delete process.env['ANTHROPIC_API_KEY']
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    expect(composition.tasks?.enable_focus_score_cron).toBe(true)

    cleanup(composition)
  }, 20_000)

  test('the LLM prioritization cron is ON on a credentialed boot, with a real llm', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-tasks-wiring-test'
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    expect(composition.tasks?.enable_task_prioritize_cron).toBe(true)
    expect(typeof composition.tasks?.task_prioritizer?.llm).toBe('function')

    cleanup(composition)
  }, 20_000)

  test('the prioritization cron stays ON with NO credential — its deterministic fallback is real', async () => {
    // Unlike the nudge engine (whose llm-less tick decays scores and writes no
    // pick), this pass computes the full deterministic order and stamps
    // `prioritized_by: 'deterministic'` before attempting any call. So the llm
    // is a plain value here, not a gate — an uncredentialed box still gets a
    // ranked backlog.
    delete process.env['ANTHROPIC_API_KEY']
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    expect(composition.tasks?.enable_task_prioritize_cron).toBe(true)
    expect(composition.tasks?.task_prioritizer).toBeDefined()
    expect(composition.tasks?.task_prioritizer?.llm).toBeNull()

    cleanup(composition)
  }, 20_000)

  test('the task → reminder auto-link is ON', async () => {
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    expect(composition.tasks?.enable_reminder_link).toBe(true)

    cleanup(composition)
  }, 20_000)

  test('the STATUS.md / ACTIONS.md projection is ON and resolves the real project folder', async () => {
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    const resolve = composition.tasks?.projection?.resolveProjectDir
    expect(typeof resolve).toBe('function')

    // The SAME `<owner_home>/Projects/<id>` convention doc-search walks and the
    // onboarding materializer creates — otherwise the block lands somewhere
    // nothing reads.
    expect(resolve!({ project_slug: 'owner', project_id: 'apollo' })).toEqual({
      dir: join(tmpDir, 'Projects', 'apollo'),
    })
    // NO_PROJECT (the empty-string sentinel) has no folder to project into.
    expect(resolve!({ project_slug: 'owner', project_id: '' })).toBeNull()

    cleanup(composition)
  }, 20_000)

  test('ONE store, not two: a write through the app Tasks HTTP surface fires the canonical store subscribers', async () => {
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    const store = composition.tasks?.store
    expect(store).toBeDefined()
    const seen: TaskMutationEvent[] = []
    const unsubscribe = store!.subscribe((event) => {
      seen.push(event)
    })

    // Loopback bind ⇒ dev-bypass auth ⇒ the `dev:owner` bearer resolves to the
    // single owner. Same route the React Tasks tab calls.
    const res = await composition.app_tasks_surface!.handler(
      new Request('http://127.0.0.1/api/app/projects/apollo/tasks', {
        method: 'POST',
        headers: {
          authorization: 'Bearer dev:owner',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'wired through the shared store' }),
      }),
    )
    expect(res?.status).toBe(201)

    // The row would be in the table either way — both stores wrap the same db.
    // The SUBSCRIBER is what proves they are the same OBJECT, and the
    // subscribers are the whole point (reminder link, projection writer).
    expect(seen.map((e) => e.kind)).toEqual(['create'])
    expect(seen[0]?.task.title).toBe('wired through the shared store')

    unsubscribe()
    cleanup(composition)
  }, 20_000)

  test('ONE store, not three: a write through the Tasks Core adapter fires the same subscribers', async () => {
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    const store = composition.tasks?.store
    expect(store).toBeDefined()
    const seen: TaskMutationEvent[] = []
    const unsubscribe = store!.subscribe((event) => {
      seen.push(event)
    })

    // The agent-facing path: `tasks_create` runs through this backend. Without
    // `canonicalTaskStore` threaded into `mountOpenCores`, the adapter builds
    // its own substrate store and an agent-created task fires nothing.
    const factory = composition.cores?.backends?.['tasks_core']
    expect(factory).toBeDefined()
    const backend = (await factory!({ project_slug: 'owner' })) as {
      store: { create: (i: { title: string }) => Promise<unknown> }
    }
    await backend.store.create({ title: 'created by the agent' })

    expect(seen.map((e) => e.kind)).toEqual(['create'])
    expect(seen[0]?.task.title).toBe('created by the agent')

    unsubscribe()
    cleanup(composition)
  }, 20_000)
})
