/**
 * pool-key-namespace.test.ts — S3 §2 acceptance #1.
 *
 * The warm-pool key is re-namespaced from `(substrate_instance_id, cwd)` to
 * `(substrate_instance_id, user_id, project_id, credential_identity)` so the
 * persistent REPL is instance-isolation-SAFE (the precondition for the flag flip).
 * `substrate_instance_id` (`cc-{role}-{instance}`) keeps the instance+role boundary;
 * `user_id` + `project_id` split what used to collapse; `credential_identity`
 * folds the selected credential (#104). `cwd` is DERIVED, never keyed.
 *
 * Covers: distinct identities → distinct keys/REPLs; same identity → one warm
 * REPL (persistence preserved); a different `cwd` for the same identity does NOT
 * fork; the router (`cc-llm-router-*`) never collapses into the conversational
 * (`cc-llm-*`) REPL; the key never contains a credential SECRET; legacy fallback
 * for callers that thread no conversational identity.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import type { AgentSpec } from '../../../../substrate.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { Event } from '../../../../events.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  poolKeyFor,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

/** A fake `claude`+dev-channel: serves /health, echoes each /message back as a
 *  /reply (turn_id round-tripped like the real dev-channel scalar). Counts the
 *  number of distinct REPLs spawned. */
function makeEchoHost(): { host: PtyHost; spawnCount: () => number } {
  let spawns = 0
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      const pid = 100000 + spawns
      const i = argv.indexOf('--session-id')
      const r = argv.indexOf('--resume')
      const sid = (i >= 0 ? argv[i + 1] : r >= 0 ? argv[r + 1] : undefined) as string
      const { port: sinkPort, token } = getReplSinkInfo()
      let hasExited = false
      let exitResolve: (code: number | null) => void = () => {}
      const exited = new Promise<number | null>((res) => {
        exitResolve = res
      })
      const post = (path: string, body: unknown): Promise<unknown> =>
        fetch(`http://127.0.0.1:${sinkPort}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
          body: JSON.stringify(body),
        }).catch(() => undefined)
      let seen = 0
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { text: string; turn_id?: string }
            const reply = `seen=${seen} got=${body.text}`
            seen += 1
            void post('/reply', { session_id: sid, text: reply, turn_id: body.turn_id })
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
      void post('/channel-bound', { session_id: sid })
      return {
        pid,
        write() {},
        resize() {},
        kill() {
          if (hasExited) return
          hasExited = true
          try {
            server.stop(true)
          } catch {
            /* ignore */
          }
          exitResolve(143)
        },
        exited,
        hasExited: () => hasExited,
      }
    },
  }
  return { host, spawnCount: () => spawns }
}

function opts(
  host: PtyHost,
  extra: Partial<PersistentReplSubstrateOptions>,
): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-llm-acme',
    cwd: '/tmp/neutron-acme',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    ...extra,
  }
}

function spec(prompt: string): AgentSpec {
  return { prompt, tools: [], model_preference: ['claude-opus-4-7'] }
}

async function drain(handle: SessionHandle): Promise<string> {
  let text = ''
  for await (const ev of handle.events as AsyncIterable<Event>) {
    if (ev.kind === 'token') text += ev.text
    else if (ev.kind === 'completion') return text
    else if (ev.kind === 'error') throw new Error(`drain error: ${ev.message}`)
  }
  return text
}

describe('poolKeyFor — S3 namespace composition', () => {
  const base = {
    substrate_instance_id: 'cc-llm-acme',
    user_id: 'u-1',
    project_id: 'default',
    credential_identity: 'cred-1',
  } as const

  it('same (instance, user, project, credential) → same key', () => {
    expect(poolKeyFor({ ...base, cwd: '/a' })).toBe(poolKeyFor({ ...base, cwd: '/b' }))
  })

  it('cwd is DERIVED, not keyed — a different cwd for the same identity does not fork', () => {
    const k1 = poolKeyFor({ ...base, cwd: '/home/acme' })
    const k2 = poolKeyFor({ ...base, cwd: '/var/lib/acme' })
    expect(k1).toBe(k2)
  })

  it('a different user_id → a different key', () => {
    expect(poolKeyFor({ ...base })).not.toBe(poolKeyFor({ ...base, user_id: 'u-2' }))
  })

  it('a different project_id → a different key', () => {
    expect(poolKeyFor({ ...base })).not.toBe(poolKeyFor({ ...base, project_id: 'northwind' }))
  })

  it('a different credential_identity → a different key (closes #104)', () => {
    expect(poolKeyFor({ ...base })).not.toBe(poolKeyFor({ ...base, credential_identity: 'cred-2' }))
  })

  it('the router substrate (cc-llm-router-*) never shares the conversational key', () => {
    const conversational = poolKeyFor({ ...base })
    const router = poolKeyFor({ ...base, substrate_instance_id: 'cc-llm-router-acme' })
    expect(router).not.toBe(conversational)
  })

  it('the key contains the credential ID, never the secret', () => {
    const secret = 'sk-ant-SECRET-TOKEN-zzz'
    const key = poolKeyFor({ ...base, credential_identity: 'cred-1' })
    expect(key).toContain('cred-1')
    expect(key).not.toContain(secret)
  })

  it('legacy fallback: with no conversational identity, keys on (instance, cwd)', () => {
    const legacy = poolKeyFor({ substrate_instance_id: 'cc-llm-acme', cwd: '/home/acme' })
    expect(legacy).toContain('cc-llm-acme')
    expect(legacy).toContain('/home/acme')
    // distinct cwd DOES fork on the legacy path (back-compat with S1/S2 fixtures).
    expect(legacy).not.toBe(poolKeyFor({ substrate_instance_id: 'cc-llm-acme', cwd: '/other' }))
  })
})

describe('PersistentReplSubstrate — per-(user,project) isolation + persistence (behavioral)', () => {
  it('two distinct (user, project) triples spawn two REPLs; the same triple reuses one', async () => {
    const { host, spawnCount } = makeEchoHost()
    const userA = createPersistentReplSubstrate(
      opts(host, { user_id: 'u-A', project_id: 'default', credential_identity: 'cred-1' }),
    )
    const userB = createPersistentReplSubstrate(
      opts(host, { user_id: 'u-B', project_id: 'default', credential_identity: 'cred-1' }),
    )

    const a1 = await drain(userA.start(spec('a-first')))
    const a2 = await drain(userA.start(spec('a-second')))
    const b1 = await drain(userB.start(spec('b-first')))

    expect(a1).toBe('seen=0 got=a-first')
    // Same (user, project, credential) across turns → ONE warm REPL: turn 2 sees turn 1.
    expect(a2).toBe('seen=1 got=a-second')
    // A distinct user → a fresh REPL, independent state.
    expect(b1).toBe('seen=0 got=b-first')
    expect(spawnCount()).toBe(2)
  })

  it('a different cwd for the same identity does NOT fork the REPL', async () => {
    const { host, spawnCount } = makeEchoHost()
    const turn1 = createPersistentReplSubstrate(
      opts(host, { user_id: 'u-1', project_id: 'default', credential_identity: 'cred-1', cwd: '/tmp/a' }),
    )
    const turn2 = createPersistentReplSubstrate(
      opts(host, { user_id: 'u-1', project_id: 'default', credential_identity: 'cred-1', cwd: '/tmp/b' }),
    )
    await drain(turn1.start(spec('one')))
    const r2 = await drain(turn2.start(spec('two')))
    // The second turn (computed a different cwd) lands on the SAME warm REPL.
    expect(r2).toBe('seen=1 got=two')
    expect(spawnCount()).toBe(1)
  })

  it('a router turn and a conversational turn for the same identity do NOT collapse', async () => {
    const { host, spawnCount } = makeEchoHost()
    const conversational = createPersistentReplSubstrate(
      opts(host, {
        substrate_instance_id: 'cc-llm-acme',
        user_id: 'u-1',
        project_id: 'default',
        credential_identity: 'cred-1',
      }),
    )
    const router = createPersistentReplSubstrate(
      opts(host, {
        substrate_instance_id: 'cc-llm-router-acme',
        user_id: 'u-1',
        project_id: 'default',
        credential_identity: 'cred-1',
      }),
    )
    await drain(conversational.start(spec('chat')))
    await drain(router.start(spec('classify')))
    expect(spawnCount()).toBe(2)
  })
})
