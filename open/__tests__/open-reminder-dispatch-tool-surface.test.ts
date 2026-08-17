/**
 * COMPOSITION-LEVEL guard (ISSUES #504): the reminder dispatcher the Open composer
 * builds must compose fired reminders with the OWNER'S LIVE-CHAT tool surface.
 *
 * A fired reminder composes on `liveAgentSubstrate` — the owner's WARM `cc-agent-*`
 * REPL, and the ONLY substrate wiring the native-MCP tool bridge, which is what lets
 * a ritual reach a Core at all. The persistent pool evicts and respawns a warm child
 * whose requested `--tools` surface differs from the one it was spawned with
 * (`runtime/adapters/claude-code/persistent/spawn.ts:824,837`), so composing with a
 * NARROWER surface does not sandbox the reminder — it destroys the owner's live chat
 * session on every fire, and his next chat turn destroys it right back.
 *
 * The wiring is ONE argument in `open/composer.ts` (`tool_names:
 * LIVE_AGENT_TOOL_NAMES`), and dropping it is invisible to every single-package
 * test: `reminders` cannot import the gateway constant (the barrel refuses that
 * edge), and the dispatcher silently falls back to its own narrower
 * `['Read','Glob','Grep']` default. So this test walks the REAL composer, captures
 * the `AgentSpec` that actually reaches the substrate, and asserts the surface.
 *
 * MUTATION-KILL: delete `tool_names: LIVE_AGENT_TOOL_NAMES` from the
 * `buildReminderDispatcher({...})` call in `open/composer.ts` → the captured spec
 * carries the 3-tool fallback and this goes RED.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { LIVE_AGENT_TOOL_NAMES } from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import { ReminderStore } from '@neutronai/reminders/store.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-reminder-surface-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-reminder-surface-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-reminder-surface-test'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']
  db = openMigratedDbAt(process.env['NEUTRON_DB_PATH'])
})

afterEach(() => {
  db.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

test('the composed reminder dispatcher requests the LIVE-CHAT tool surface', async () => {
  const specs: AgentSpec[] = []
  /** Captures the spec, then yields one token so the compose resolves. */
  const fakeSubstrate: Substrate = {
    start: (spec: AgentSpec) => {
      specs.push(spec)
      return {
        async *tokens() {
          yield { kind: 'token' as const, text: 'composed body' }
        },
        cancel: () => undefined,
      } as unknown as ReturnType<Substrate['start']>
    },
  } as unknown as Substrate

  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: () => fakeSubstrate,
  })
  const composition = await composer({ db, project_slug: 'owner' })

  // A plain, non-ritual reminder — the surface is a property of the SESSION, so it
  // must be right for every fired row, not only for rituals.
  const store = new ReminderStore(db)
  const row = await store.create({
    owner_slug: 'owner',
    topic_id: null,
    fire_at: 1,
    message: 'take a walk',
  })

  // Composition itself starts turns on other substrates (onboarding phase-spec,
  // pre-warm), and the fake above is shared by all of them. Drop everything captured
  // before the dispatch so the assertion can only see the REMINDER's turn.
  specs.length = 0
  await composition.reminder_dispatcher.dispatch(row)

  expect(specs.length).toBeGreaterThanOrEqual(1)
  const names = specs[0]!.tools.map((t) => t.name)
  expect([...names]).toEqual([...LIVE_AGENT_TOOL_NAMES])

  for (const cleanup of composition.realmode_cleanups ?? []) {
    try {
      cleanup()
    } catch {
      /* best-effort */
    }
  }
})
