import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { createPersistentReplSubstrate, shutdownAllPersistentRepls } from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import { pool, ephemeralSessions } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { createIsolatedHome } from '../support/test-isolation.ts'
import { seedMigratedDb } from '../support/migrated-db.ts'
import { lifecycleReplHost } from '@neutronai/runtime/adapters/claude-code/persistent/__tests__/lifecycle-repl-host.ts'

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  expect(check()).toBe(true)
}

test.each([false, true])('Open due reminders spawn isolated workers, exit, and spawn again (onboarded=%s)', async onboarded => {
  const home = createIsolatedHome({
    extraEnvKeys: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'],
    env: { ANTHROPIC_API_KEY: 'sk-test-on-demand', CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NEUTRON_LANDING_STATIC_DIR: join(import.meta.dir, '../../landing'),
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'test-secret-0123456789' },
  })
  const peer = lifecycleReplHost()
  const reservation = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
  const sinkPort = reservation.port!
  await reservation.stop(true)
  const errors: string[] = []
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  if (onboarded) db.raw().run(`INSERT INTO onboarding_state
    (project_slug, user_id, phase, phase_state_json, started_at, last_advanced_at,
     completed_at, persona_files_committed, wow_fired)
    VALUES ('owner', 'owner', 'completed', '{}', ?, ?, ?, 1, 1)`,
  [Date.now(), Date.now(), Date.now()])
  let graph: Awaited<ReturnType<typeof composeProductionGraph>> | undefined
  let cleanups: Array<() => void> = []
  try {
    const composition = await buildOpenGraphComposer({ env: process.env,
      substrateFactory: opts => {
        const substrate = createPersistentReplSubstrate({ ...opts,
          ptyHost: peer.host, skipTrustSeed: true, idleQuietMs: 0, sinkPort })
        return { start(spec) {
          const handle = substrate.start(spec)
          return { ...handle, events: (async function* () {
            for await (const event of handle.events) {
              if (event.kind === 'error') errors.push(event.message)
              yield event
            }
          })() }
        } }
      },
    })({ db, project_slug: 'owner' })
    cleanups = composition.realmode_cleanups ?? []
    graph = await composeProductionGraph(composition)
    // A positive control follows: the same host must see a real fired reminder.
    expect(peer.children).toHaveLength(0)
    const dispatcher = composition.reminder_dispatcher!
    const fire = (id: string) => dispatcher.dispatch({
      id, owner_slug: 'owner', topic_id: null, fire_at: 1_700_000_000,
      message: 'stretch', status: 'fired', recurrence: null, recurrence_spec: null,
      ritual_id: null, source: null, created_at: 1_699_999_000,
      fired_at: 1_700_000_000, cancelled_at: null,
    })
    await fire('first')
    expect(errors).toEqual([])
    await until(() => peer.children.length === 1)
    await until(() => peer.children[0]!.child.hasExited())
    expect(peer.children[0]!.prompts[0]).toContain('stretch')
    expect(pool.size).toBe(0)
    expect(ephemeralSessions.size).toBe(0)
    await fire('second')
    await until(() => peer.children.length === 2)
    await until(() => peer.children[1]!.child.hasExited())
    expect(peer.children[1]!.sessionId).not.toBe(peer.children[0]!.sessionId)
    expect(ephemeralSessions.size).toBe(0)
  } finally {
    for (const cleanup of cleanups) cleanup()
    await graph?.shutdown()
    await shutdownAllPersistentRepls()
    db.close()
    home.restore()
  }
}, 30_000)
