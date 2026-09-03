/**
 * poison-eviction-live-work-guard.test.ts — the 2026-09-03 root cause of 33% of
 * trident run deaths, at the eviction.
 *
 * THE BUG. Trident inner workflows run as CC subagents INSIDE one shared warm
 * `cc-trident-fire-*` claude child. When an unrelated run's fire turn was
 * abandoned (the settle-timeout used to `cancel()` it), the session was
 * abandon-poisoned, and the NEXT fire on that key evicted the child
 * (`getOrSpawnSession`: SIGTERM, 2 s grace, SIGKILL) — taking the whole Argus
 * panel, the arbiter and every workflow's terminal/cleanup steps with it. Only
 * the codex forge build is detached. Nothing latched the death; the 90-min hang
 * watchdog reaped the corpse ~170 min later.
 *
 * THE GUARD. Before evicting a poisoned session, `getOrSpawnSession` consults
 * `options.hostsLiveWork(childGeneration)`. > 0 → the eviction is DEFERRED: the
 * poison is cleared, the child stays warm, the next turn lands on it. 0 (or the
 * option unwired, or a throw) → evict exactly as before, AND the `onChildCrash`
 * sink is told about the EVICTED generation so crash recovery runs on the next
 * tick instead of after the reaper.
 *
 * The fake host below: REPL incarnation #1 ignores its FIRST inject (the
 * abandoned/runaway turn) and answers every later one; incarnation #2+ answer
 * everything. So "which child served turn 2" is observable from `spawnCount()`
 * AND from the reply text.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import type { AgentSpec } from '../../../../substrate.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { Event } from '../../../../events.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

function makeWedgeOnceHost(): { host: PtyHost; spawnCount: () => number; messagesSeen: () => number } {
  let spawns = 0
  let messages = 0
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      const incarnation = spawns
      let messagesOnThisChild = 0
      const pid = 430000 + spawns
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
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { text: string; turn_id?: string }
            messages += 1
            messagesOnThisChild += 1
            // Incarnation #1 wedges on its FIRST inject only (the abandoned turn);
            // everything else is answered, tagged with the replying child.
            if (!(incarnation === 1 && messagesOnThisChild === 1)) {
              void post('/reply', {
                session_id: sid,
                text: `repl-${incarnation}:${body.text}`,
                turn_id: body.turn_id,
              })
            }
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
  return { host, spawnCount: () => spawns, messagesSeen: () => messages }
}

function opts(host: PtyHost, extra: Partial<PersistentReplSubstrateOptions> = {}): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-trident-fire-acme',
    user_id: 'u-1',
    project_id: 'default',
    credential_identity: 'cred-1',
    cwd: '/tmp/neutron-poison-guard',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    idleMaxMs: 50,
    turnTimeoutMs: 30_000,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    ...extra,
  }
}

function spec(prompt: string): AgentSpec {
  return { prompt, tools: [], model_preference: ['claude-opus-4-7'] }
}

async function drain(handle: SessionHandle): Promise<{ text: string; errored: boolean }> {
  let text = ''
  for await (const ev of handle.events as AsyncIterable<Event>) {
    if (ev.kind === 'token') text += ev.text
    else if (ev.kind === 'completion') return { text, errored: false }
    else if (ev.kind === 'error') return { text, errored: true }
  }
  return { text, errored: false }
}

async function waitUntil(pred: () => boolean, budgetMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (pred()) return
    await Bun.sleep(5)
  }
  throw new Error('waitUntil: condition not met within budget')
}

/** Capture `[repl] …` stderr lines for the duration of `fn`. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write
  try {
    const result = await fn()
    return { result, lines }
  } finally {
    process.stderr.write = original
  }
}

/** Abandon turn 1 the way a budget-elapsed caller does, once the REPL has taken it. */
async function abandonFirstTurn(
  sub: ReturnType<typeof createPersistentReplSubstrate>,
  messagesSeen: () => number,
): Promise<void> {
  const h1 = sub.start(spec('turn-1'))
  await waitUntil(() => messagesSeen() >= 1)
  await h1.cancel()
}

describe('abandon-poison eviction guard — a poisoned launcher hosting live work is NOT evicted', () => {
  it('REGRESSION: with hostsLiveWork > 0 the next turn reuses the SAME child (no respawn), the poison is cleared, and the deferral is logged', async () => {
    const { host, spawnCount, messagesSeen } = makeWedgeOnceHost()
    const askedFor: string[] = []
    const sub = createPersistentReplSubstrate(
      opts(host, {
        hostsLiveWork: (generation) => {
          askedFor.push(generation)
          return 3
        },
      }),
    )

    await abandonFirstTurn(sub, messagesSeen)
    expect(spawnCount()).toBe(1)

    const { result: r2, lines } = await captureStderr(() => drain(sub.start(spec('turn-2'))))
    // Red mutation: dropping the guard evicts REPL #1 here (spawnCount 2, reply from repl-2).
    expect(r2.errored).toBe(false)
    expect(r2.text).toBe('repl-1:turn-2')
    expect(spawnCount()).toBe(1)
    // The guard was asked about the exact child generation (a per-spawn UUID).
    expect(askedFor).toHaveLength(1)
    expect(askedFor[0]).toMatch(/^[0-9a-f-]{36}$/)
    const deferred = lines.filter((l) => l.includes('[repl] poison eviction DEFERRED'))
    expect(deferred).toHaveLength(1)
    expect(deferred[0]).toContain('hosts 3 live workflows')
    expect(deferred[0]).toContain(`generation=${askedFor[0]!.slice(0, 8)}`)
    expect(lines.some((l) => l.includes('evicting abandon-poisoned'))).toBe(false)

    // The poison was CLEARED, not merely skipped: turn 3 neither re-consults the
    // guard nor logs a second deferral, and still lands on REPL #1.
    const { result: r3, lines: lines3 } = await captureStderr(() => drain(sub.start(spec('turn-3'))))
    expect(r3.text).toBe('repl-1:turn-3')
    expect(spawnCount()).toBe(1)
    expect(askedFor).toHaveLength(1)
    expect(lines3.some((l) => l.includes('poison eviction DEFERRED'))).toBe(false)
  })

  it('control: with hostsLiveWork → 0 the poisoned child IS evicted, and onChildCrash is told the EVICTED generation', async () => {
    const { host, spawnCount, messagesSeen } = makeWedgeOnceHost()
    const askedFor: string[] = []
    const crashes: Array<{ sessionKey: string; generationKey: string; detail: string }> = []
    const sub = createPersistentReplSubstrate(
      opts(host, {
        hostsLiveWork: (generation) => {
          askedFor.push(generation)
          return 0
        },
        onChildCrash: (info) => {
          crashes.push(info)
        },
      }),
    )

    await abandonFirstTurn(sub, messagesSeen)

    const { result: r2, lines } = await captureStderr(() => drain(sub.start(spec('turn-2'))))
    expect(r2.errored).toBe(false)
    expect(r2.text).toBe('repl-2:turn-2')
    expect(spawnCount()).toBe(2)
    expect(lines.some((l) => l.includes('evicting abandon-poisoned'))).toBe(true)
    expect(lines.some((l) => l.includes('poison eviction DEFERRED'))).toBe(false)

    // THE LATCH. The supervision watchdog structurally cannot see an eviction (the
    // registry is repointed at the replacement child before its next tick); the
    // eviction path itself now reports the dead generation. Red mutation: removing
    // `notifyEvictedChild` leaves `crashes` empty and the owner learns of the death
    // from the 90-min hang watchdog, ~170 min later.
    expect(crashes).toHaveLength(1)
    expect(crashes[0]!.generationKey).toBe(askedFor[0]!)
    expect(crashes[0]!.detail).toContain('evicted')
    expect(crashes[0]!.detail).toContain('abandon-poison')
    expect(crashes[0]!.sessionKey).toContain('cc-trident-fire-acme')
  })

  it('a throwing hostsLiveWork fails SAFE to the old behaviour (evict); the guard can only ever spare a child', async () => {
    const { host, spawnCount, messagesSeen } = makeWedgeOnceHost()
    const sub = createPersistentReplSubstrate(
      opts(host, {
        hostsLiveWork: () => {
          throw new Error('store unavailable')
        },
      }),
    )
    await abandonFirstTurn(sub, messagesSeen)
    const r2 = await drain(sub.start(spec('turn-2')))
    expect(r2.text).toBe('repl-2:turn-2')
    expect(spawnCount()).toBe(2)
  })

  it('unwired hostsLiveWork (every chat / synthesis substrate) keeps the 2026-06-18 cascade fix byte-for-byte: evict + respawn', async () => {
    const { host, spawnCount, messagesSeen } = makeWedgeOnceHost()
    const sub = createPersistentReplSubstrate(opts(host))
    await abandonFirstTurn(sub, messagesSeen)
    const r2 = await drain(sub.start(spec('turn-2')))
    expect(r2.text).toBe('repl-2:turn-2')
    expect(spawnCount()).toBe(2)
  })
})
