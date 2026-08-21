/**
 * Cutover readiness: the box must SAY its Claude credential has lapsed, before
 * the owner discovers it by typing.
 *
 * THE GAP. The only credential notice was reactive — it fires from the
 * terminal-failure handler of a real user TURN
 * (`gateway/wiring/build-live-agent-turn.ts`), so it needs him to have already
 * sent a message and watched it fail. A lapse does not present that way. It
 * kills the PROACTIVE surfaces first (morning brief, rituals, nudges, fired
 * reminders), and those produce no turn to fail, so the box goes quiet while
 * still serving and booting cleanly. Meanwhile the probe that would have noticed
 * was already running on a 60 s loop and had classified 401/403 as
 * `unauthorized` all along — it just blanked a utilization bar and told nobody.
 *
 * WHAT THESE PIN. Two layers, because the two failures are different:
 *   • WIRED — booting the REAL `buildOpenGraphComposer` with upstream answering
 *     401 must put the durable, tappable reconnect bubble in the owner's chat
 *     with no client connected and nobody typing. Answering 503 instead must
 *     leave the transcript empty. A hand-built config literal would prove the
 *     notifier's body and nothing about whether anything constructs it — which
 *     is the failure mode this repo keeps shipping.
 *   • BEHAVED — the latch, driven tick by tick through `measureOnce`: once per
 *     lapse, never twice, a blip in the middle is not a second lapse, and a real
 *     recovery re-arms it.
 *
 * The alarm-fatigue assertions are the load-bearing ones. A false "reconnect
 * your account" is worse than silence: it teaches him to swipe past the message,
 * and then the real one lands on a reader who has already learned it means
 * nothing.
 *
 * MUTATION-TESTED — see the PR body for the three deletions and the exact
 * failure each produced.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CredentialUsageProbeOutcome } from '@neutronai/auth/credential-usage-probe.ts'
import { appWsTopicId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import { createDeliver } from '@neutronai/gateway/http/deliver.ts'
import {
  AUTH_RECONNECT_BODY,
  RECONNECT_AUTH_VALUE,
} from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import { buildOpenGraphComposer } from '../composer.ts'
import { createCredentialLapseNotifier } from '../credential-lapse-notice.ts'
import { CredentialUsageMonitor } from '../credential-usage-monitor.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** Synthetic. Never a real credential — this repo is public. */
const TOKEN = 'sk-ant-oat01-synthetic-lapse-test-token-not-real'

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NOTIFY_SOCKET',
  'TZ',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let db: ProjectDb

const OWNER_TOPIC = appWsTopicId(OWNER_USER_ID)

interface PromptRow {
  topic_id: string
  body: string
  options_json: string
  resolved_at: number | null
}

function reconnectRows(): PromptRow[] {
  return db
    .raw()
    .query<PromptRow, [string]>(
      `SELECT topic_id, body, options_json, resolved_at
         FROM button_prompts
        WHERE body = ?
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all(AUTH_RECONNECT_BODY)
}

// ── the upstream stub ────────────────────────────────────────────────────────
// The composer builds the monitor with the REAL probe, so the only seam a
// composition-level test has is the network itself. Non-Anthropic traffic passes
// straight through so nothing else about the boot changes.

const realFetch = globalThis.fetch
let anthropicResponse: (() => Response) | null = null

const ANTHROPIC_HOST = 'api.anthropic.com'

/**
 * Match on the parsed HOSTNAME, never a substring of the URL. A substring test
 * says yes to `https://evil.example/?x=api.anthropic.com`, and a stub that
 * intercepts by accident is a test asserting something other than what it reads
 * as. An unparseable URL matches nothing and falls through to the real fetch.
 */
function isAnthropic(url: string): boolean {
  try {
    return new URL(url).hostname === ANTHROPIC_HOST
  } catch {
    return false
  }
}

function installFetchStub(): void {
  globalThis.fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown })?.url ?? '')
    if (isAnthropic(url) && anthropicResponse !== null) {
      return anthropicResponse()
    }
    return (realFetch as (i: unknown, ii?: unknown) => Promise<Response>)(input, init)
  }) as typeof fetch
}

/** A credential upstream no longer accepts. */
const unauthorized = (): Response => new Response('{}', { status: 401 })
/** A 5xx — the network having a bad minute, which is NOT a lapsed credential. */
const upstreamOutage = (): Response => new Response('{}', { status: 503 })

/** Wait for a condition the async tick loop satisfies out of band. */
async function until(pred: () => boolean, ms = 6_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-cred-lapse-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  // Points the on-disk credential tier at an empty dir, so the env token below
  // is unambiguously the credential under test.
  process.env['HOME'] = tmpDir
  process.env['CLAUDE_CONFIG_DIR'] = join(tmpDir, '.claude')
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-cred-lapse-test-secret-0123456789'
  // A subscription token is the ONLY credential shape that can lapse: an API key
  // resolves to `unmeasurable` and is never probed at all.
  process.env['CLAUDE_CODE_OAUTH_TOKEN'] = TOKEN
  delete process.env['ANTHROPIC_API_KEY']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']
  seedMigratedDb(process.env['NEUTRON_DB_PATH'])
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH'])
  anthropicResponse = null
  installFetchStub()
})

afterEach(() => {
  globalThis.fetch = realFetch
  anthropicResponse = null
  db.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

async function composeOpen(): Promise<{
  composition: Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>
  cleanup: () => void
}> {
  const composer = buildOpenGraphComposer({ env: process.env })
  const composition = await composer({ db, project_slug: 'owner' })
  return {
    composition,
    cleanup: (): void => {
      for (const c of composition.realmode_cleanups ?? []) {
        try {
          c()
        } catch {
          /* best-effort */
        }
      }
    },
  }
}

describe('the production composer proactively reports a lapsed credential', () => {
  test('a 401 from the periodic probe puts a durable, tappable reconnect bubble in chat — with nobody typing and nothing connected', async () => {
    anthropicResponse = unauthorized
    const { cleanup } = await composeOpen()
    try {
      // The monitor's loop is armed at the end of composition with
      // `immediate: true`, so the first measurement is the boot tick. Nothing in
      // this test sends a message, opens a socket, or touches a turn.
      await until(() => reconnectRows().length > 0)
      const rows = reconnectRows()
      expect(rows).toHaveLength(1)

      const row = rows[0]!
      // The topic the app client actually binds and hydrates. A row on any other
      // topic is the #105 deliver-to-nobody shape: persisted and never replayed.
      expect(row.topic_id).toBe(OWNER_TOPIC)
      // durability 'none' would persist NOTHING and 'inert' would leave no
      // resolvable prompt to tap. 'reply' is what makes the button live and the
      // message survive until he next opens the app.
      expect(row.resolved_at).toBeNull()
      // The SAME affordance the reactive bubble carries — same words, same
      // routing value — so the tap mints a fresh install-token handoff exactly
      // as it already does, and the two notices read as one problem.
      expect(JSON.parse(row.options_json)).toEqual([
        { label: 'A', body: 'Reconnect', value: RECONNECT_AUTH_VALUE },
      ])
    } finally {
      cleanup()
    }
  }, 60_000)

  test('an upstream OUTAGE says nothing at all — a bad minute on the network is not a dead credential', async () => {
    anthropicResponse = upstreamOutage
    const { cleanup } = await composeOpen()
    try {
      // Give the boot tick the same room the lapse test needed to produce a row.
      await until(() => reconnectRows().length > 0, 1_500)
      // The assertion that protects him from alarm fatigue: a 5xx must not read
      // as "reconnect your account".
      expect(reconnectRows()).toHaveLength(0)
    } finally {
      cleanup()
    }
  }, 60_000)
})

describe('the lapse latch, driven tick by tick', () => {
  interface Harness {
    monitor: CredentialUsageMonitor
    setOutcome: (o: CredentialUsageProbeOutcome) => void
  }

  const HEALTHY: CredentialUsageProbeOutcome = {
    kind: 'ok',
    reading: { session: 0.1, weekly: 0.2 },
  }
  const LAPSED: CredentialUsageProbeOutcome = { kind: 'unauthorized', httpStatus: 401 }
  const BLIP: CredentialUsageProbeOutcome = { kind: 'error', message: 'socket hang up' }

  /**
   * The production notice path over the production delivery seam
   * (`createDeliver` + a real `ButtonStore` on the real schema), with only the
   * probe faked — so every assertion below lands on real rows.
   */
  function harness(deliverOverride?: Parameters<typeof createCredentialLapseNotifier>[0]['deliver']): Harness {
    const buttonStore = new ButtonStore({ db })
    const deliver = deliverOverride ?? createDeliver({ buttonStore, push: {} })
    let outcome: CredentialUsageProbeOutcome = HEALTHY
    const monitor = new CredentialUsageMonitor({
      env: { HOME: tmpDir, CLAUDE_CONFIG_DIR: join(tmpDir, '.claude'), CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      probe: async () => outcome,
      onStanding: createCredentialLapseNotifier({ deliver, topic_id: OWNER_TOPIC }),
    })
    return {
      monitor,
      setOutcome: (o): void => {
        outcome = o
      },
    }
  }

  test('a lapse that persists across ticks is told once, not once a minute', async () => {
    const { monitor, setOutcome } = harness()
    setOutcome(LAPSED)
    await monitor.measureOnce()
    await monitor.measureOnce()
    await monitor.measureOnce()
    // The probe runs every 60 s and a lapse holds until he acts on it. Without a
    // latch this is 60 identical bubbles an hour.
    expect(reconnectRows()).toHaveLength(1)
  })

  test('a network blip in the MIDDLE of a lapse is not a second lapse', async () => {
    const { monitor, setOutcome } = harness()
    setOutcome(LAPSED)
    await monitor.measureOnce()
    // An indeterminate reading must neither alert nor count as recovery. If it
    // cleared the latch, one lapse plus one dropped packet would become two
    // identical bubbles.
    setOutcome(BLIP)
    await monitor.measureOnce()
    setOutcome(LAPSED)
    await monitor.measureOnce()
    expect(reconnectRows()).toHaveLength(1)
  })

  test('a REAL recovery re-arms it — a later, separate lapse is told again', async () => {
    const { monitor, setOutcome } = harness()
    setOutcome(LAPSED)
    await monitor.measureOnce()
    expect(reconnectRows()).toHaveLength(1)

    // He reconnected. The latch must reset, or the next lapse is silent forever.
    setOutcome(HEALTHY)
    await monitor.measureOnce()

    setOutcome(LAPSED)
    await monitor.measureOnce()
    expect(reconnectRows()).toHaveLength(2)
  })

  test('a windowless API key counts as ALIVE, not lapsed — swapping credential shape must not alarm', async () => {
    const { monitor, setOutcome } = harness()
    setOutcome({ kind: 'no-windows' })
    await monitor.measureOnce()
    expect(reconnectRows()).toHaveLength(0)
    // And it genuinely resets the latch rather than merely staying quiet.
    setOutcome(LAPSED)
    await monitor.measureOnce()
    setOutcome({ kind: 'no-windows' })
    await monitor.measureOnce()
    setOutcome(LAPSED)
    await monitor.measureOnce()
    expect(reconnectRows()).toHaveLength(2)
  })

  test('a throwing delivery seam neither kills the tick nor swallows the notice', async () => {
    let throwNext = true
    const flaky: Parameters<typeof createCredentialLapseNotifier>[0]['deliver'] = async (
      topic_id,
      envelope,
    ) => {
      if (throwNext) throw new Error('durable store unavailable')
      return createDeliver({ buttonStore: new ButtonStore({ db }), push: {} })(topic_id, envelope)
    }
    const { monitor, setOutcome } = harness(flaky)
    setOutcome(LAPSED)

    // Fail-soft: the tick completes and the meter still updates, so the loop's
    // failure budget is never spent on a notification problem.
    await monitor.measureOnce()
    expect(monitor.snapshot()).toEqual({ available: false, reason: 'no_credential' })
    expect(reconnectRows()).toHaveLength(0)

    // Commit-on-success: the incident was never latched, so the very next tick
    // re-attempts it instead of the owner silently never being told.
    throwNext = false
    await monitor.measureOnce()
    expect(reconnectRows()).toHaveLength(1)
    // …and it is still exactly once thereafter.
    await monitor.measureOnce()
    expect(reconnectRows()).toHaveLength(1)
  })
})
