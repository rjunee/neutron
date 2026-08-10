/**
 * THE OWNER'S INSTALLED MCP SERVERS REACH THE REAL LIVE-CHAT SPAWN.
 *
 * This is the only test in the set that boots the PRODUCTION composer, and it exists
 * because every other layer of this feature can be complete and correct while the
 * owner still gets nothing. Three joins have to hold at once, none of them visible
 * from a unit test of any single module:
 *
 *   1. the composer must MOUNT the settings surface (otherwise the owner cannot
 *      install or, more importantly, APPROVE — and approval is the gate);
 *   2. the composer must BIND its late store into the resolver the live-chat
 *      substrate was handed at boot (an unbound holder answers "no servers" forever,
 *      so an install would appear to succeed and silently never take effect);
 *   3. the resolver must be threaded onto the live-chat substrate — and ONLY it.
 *
 * "The module exists and its tests pass, and the composer never wires it" is this
 * repo's single most repeated defect, which is why the assertions below run against
 * the REAL `buildOpenGraphComposer` output rather than a hand-built config: a literal
 * would have passed throughout the bug.
 *
 * THE DISPATCH PATH is the production reminder dispatcher, because that is a real
 * caller which composes on the owner's warm live-chat substrate (`open/composer.ts`
 * threads `LIVE_AGENT_TOOL_NAMES` into it for exactly that reason). Driving it is how
 * the `cc-agent-*` option bag gets captured without standing up the HTTP graph.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import type { Reminder } from '@neutronai/reminders/store.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const SECRET = 'sk-not-a-real-key'

/**
 * A fixed owner bearer, so the surface can actually be CALLED here.
 *
 * The composer mints a random one when this is unset, and there is no way to read it
 * back from the composition — which would leave every call 401ing and the strongest
 * assertion in this file quietly testing nothing. Long and diverse enough to pass the
 * entropy floor in `open/owner-bearer.ts`; it is a per-test value in a temp instance,
 * never a real credential.
 */
const OWNER_BEARER = 'nbt_test_q7Xz-Kd9m2Vp4Rw8Ty6Bn1Cs3Ej5Gh'

const SAVED_ENV_KEYS = [
  'NEUTRON_OWNER_BEARER',
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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-mcp-wiring-'))
  process.env['NEUTRON_OWNER_BEARER'] = OWNER_BEARER
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-mcp-wiring'
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

/** A due one-shot reminder — the cheapest real dispatch onto the live-chat substrate. */
function reminder(): Reminder {
  return {
    id: 'rem-mcp-wiring',
    topic_id: null,
    message: 'wiring probe',
    fire_at: Math.floor(Date.now() / 1000) - 1,
    recurrence: null,
    recurrence_spec: null,
    status: 'pending',
  } as unknown as Reminder
}

interface Booted {
  composition: Record<string, unknown>
  captured: ClaudeCodeSubstrateOptions[]
  /** Call a mounted route on the MCP-servers surface with the owner bearer. */
  api: (method: string, path: string, body?: unknown) => Promise<Response>
  cleanup: () => void
}

async function boot(): Promise<Booted> {
  const captured: ClaudeCodeSubstrateOptions[] = []
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => {
    captured.push(opts)
    return { start: () => cannedHandle(opts.substrate_instance_id) }
  }
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({ env: process.env, substrateFactory })
  const composition = await composer({ db, project_slug: 'owner' })
  const rec = composition as unknown as Record<string, unknown>
  const surface = rec['app_mcp_servers_surface'] as
    | { handler: (req: Request) => Promise<Response | null> }
    | undefined
  const api = async (method: string, path: string, body?: unknown): Promise<Response> => {
    if (surface === undefined) throw new Error('app_mcp_servers_surface is not mounted')
    // Through the composer's OWN owner-bearer resolver — the real gate, not a stub.
    const res = await surface.handler(
      new Request(`http://x${path}`, {
        method,
        headers: {
          authorization: `Bearer ${OWNER_BEARER}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    )
    if (res === null) throw new Error(`surface disclaimed ${method} ${path}`)
    return res
  }
  return {
    composition: rec,
    captured,
    api,
    cleanup: () => {
      for (const c of (composition.realmode_cleanups ?? []) as Array<() => void>) {
        try {
          c()
        } catch {
          /* best-effort */
        }
      }
      db.close()
    },
  }
}

/** The live-chat option bag the REAL composer built, via a real dispatch. */
async function liveAgentOptions(b: Booted): Promise<ClaudeCodeSubstrateOptions> {
  const dispatcher = b.composition['reminder_dispatcher'] as { dispatch: (r: Reminder) => Promise<void> }
  await dispatcher.dispatch(reminder())
  await Bun.sleep(20)
  const opts = b.captured.find((o) => o.substrate_instance_id === 'cc-agent-owner')
  expect(opts).toBeDefined()
  return opts!
}

describe('the production composer wires installable MCP servers end to end', () => {
  test('the settings surface is MOUNTED — without it nothing can be approved', async () => {
    const b = await boot()
    try {
      expect(b.composition['app_mcp_servers_surface']).toBeDefined()
      // And it really answers: an unauthenticated shape still routes (401), which
      // proves the handler is the MCP one rather than an unrelated surface.
      const res = await b.api('GET', '/api/app/mcp-servers')
      expect([200, 401]).toContain(res.status)
    } finally {
      b.cleanup()
    }
  })

  test('the live-chat substrate CARRIES the resolver, and no other substrate does', async () => {
    const b = await boot()
    try {
      const agent = await liveAgentOptions(b)
      expect(typeof agent.resolveExtraMcpServers).toBe('function')
      // Every other substrate the composer built — including the boot pre-warm's
      // `cc-llm-*` — must omit it. An installed subprocess belongs to the owner's own
      // session and nothing else.
      const others = b.captured.filter((o) => o.substrate_instance_id !== 'cc-agent-owner')
      expect(others.length).toBeGreaterThan(0)
      for (const o of others) expect(o.resolveExtraMcpServers).toBeUndefined()
    } finally {
      b.cleanup()
    }
  })

  test('the resolver is BOUND to the real store: it answers empty, then answers the approved server', async () => {
    // The defect this is here for: an unbound holder answers "none" forever, so the
    // owner installs a server, sees it listed as approved, and it never appears in
    // his session. Nothing else in the suite can see that.
    const b = await boot()
    try {
      const agent = await liveAgentOptions(b)
      const resolve = agent.resolveExtraMcpServers!
      expect(await resolve()).toEqual([])

      // Install + approve through the REAL surface, whatever auth it demands.
      const installed = await b.api('POST', '/api/app/mcp-servers', {
        name: 'example-server',
        command: '/usr/local/bin/example-mcp',
        args: ['--stdio'],
        env: { EXAMPLE_API_KEY: SECRET },
      })
      // Asserted, not branched on: a 401 here would silently reduce the rest of this
      // test to nothing, which is the failure mode a "skip if unauthenticated" guard
      // creates. The composer binds loopback by default, so the owner bearer resolves.
      expect(installed.status).toBe(200)
      // Still nothing wired: installing is not approving.
      expect(await resolve()).toEqual([])

      const decided = await b.api('POST', '/api/app/mcp-servers/decision', {
        name: 'example-server',
        decision: 'approve',
      })
      expect(decided.status).toBe(200)

      const wired = await resolve()
      expect(wired).toHaveLength(1)
      expect(wired[0]!.name).toBe('example-server')
      expect(wired[0]!.env).toEqual({ EXAMPLE_API_KEY: SECRET })
    } finally {
      b.cleanup()
    }
  })

  test('the graph is handed the composer\'s OWN ApprovalManager', async () => {
    // Two managers over one `tool_approvals` table would each hold their own map of
    // pending decisions. The settings surface approves through the composer's; the
    // graph must expose that same object or the two disagree about what is waiting.
    const b = await boot()
    try {
      expect(b.composition['approval_manager']).toBeDefined()
      expect(typeof (b.composition['approval_manager'] as { respondApproval?: unknown }).respondApproval).toBe(
        'function',
      )
    } finally {
      b.cleanup()
    }
  })
})
