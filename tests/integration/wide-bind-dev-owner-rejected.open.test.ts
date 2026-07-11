/**
 * S2 (b) e2e — the heart of the unit: a WIDE-bound Open composition must REJECT
 * an Origin-less `dev:owner` connection (the predictable bearer anyone on the
 * network could present), while the SAME flow on a LOOPBACK bind ACCEPTS it
 * (the 127.0.0.1 dogfood is byte-for-byte unchanged). Driven through the real
 * composed graph's `/ws/app/chat` upgrade handler.
 *
 * Mutation-verify: revert the composer's loopback-gating of `bypass` (make it
 * unconditionally `true`) → the wide-bind REJECT case goes red.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

let home: IsolatedHome

function recordingSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'mock' }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

/** A fake Bun server whose `upgrade` always succeeds (→ handler returns 101). */
const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>

/** An ORIGIN-LESS (native-style) `/ws/app/chat` upgrade request. */
function originlessUpgrade(token: string): Request {
  return new Request(
    `http://127.0.0.1:7800/ws/app/chat?token=${encodeURIComponent(token)}`,
    { method: 'GET', headers: { host: '127.0.0.1:7800' } },
  )
}

/** A `/api/app/chat/send` POST carrying a Bearer token (the HTTP surface path,
 *  NOT behind the WS Origin/token gate — it authenticates via the resolver). */
function httpSend(token: string): Request {
  return new Request('http://127.0.0.1:7800/api/app/chat/send', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:7800',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ body: 'hi' }),
  })
}

interface Built {
  db: ProjectDb
  close: () => Promise<void>
  fetch: (req: Request, srv: import('bun').Server<unknown>) => Response | Promise<Response>
}

async function buildGraph(host: string): Promise<Built> {
  process.env['NEUTRON_HOST'] = host
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => recordingSubstrate()) as any,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined) throw new Error('graph has no fetch handler')
  return {
    db,
    fetch: graph.fetch,
    close: async () => {
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* best-effort */
        }
      }
      await graph.shutdown()
      db.close()
    },
  }
}

beforeEach(() => {
  home = createIsolatedHome({
    extraEnvKeys: [
      'NEUTRON_LANDING_STATIC_DIR',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'ANTHROPIC_API_KEY',
      'NEUTRON_HOST',
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-wide-bind-test',
    },
  })
})

afterEach(() => {
  home.restore()
})

describe('S2 (b) e2e — wide bind rejects the predictable dev:owner; loopback accepts it', () => {
  test('WIDE bind (NEUTRON_HOST=0.0.0.0): Origin-less dev:owner is REJECTED', async () => {
    const built = await buildGraph('0.0.0.0')
    try {
      // WS surface gate: Origin-less client can't ride dev:owner on a wide bind.
      const ws = await built.fetch(originlessUpgrade('dev:owner'), fakeServer)
      expect(ws.status).toBe(401)
      expect(((await ws.json()) as { code: string }).code).toBe('bad_app_ws_token')

      // HTTP Bearer path (resolver gate): the composer built the resolver WITHOUT
      // bypass on a wide bind, so a dev:owner Bearer is rejected too.
      const http = await built.fetch(httpSend('dev:owner'), fakeServer)
      expect(http.status).toBe(401)
    } finally {
      await built.close()
    }
  })

  test('LOOPBACK bind (NEUTRON_HOST=127.0.0.1): Origin-less dev:owner is ACCEPTED', async () => {
    const built = await buildGraph('127.0.0.1')
    try {
      // Byte-identical to today's dogfood: native dev:owner connects…
      const ws = await built.fetch(originlessUpgrade('dev:owner'), fakeServer)
      expect(ws.status).toBe(101)
      // …and the HTTP Bearer dev:owner path is accepted (not 401).
      const http = await built.fetch(httpSend('dev:owner'), fakeServer)
      expect(http.status).not.toBe(401)
    } finally {
      await built.close()
    }
  })
})
