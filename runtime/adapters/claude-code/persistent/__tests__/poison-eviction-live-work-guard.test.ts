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
 * `options.hostsLiveWork(childGeneration)`. 0 (or the option unwired, or a throw)
 * → evict exactly as before, AND the `onChildCrash` sink is told about the
 * EVICTED generation so crash recovery runs on the next tick instead of after the
 * reaper. > 0 → the child is QUARANTINED: unhooked from the pool so it serves no
 * further turn, left RUNNING so its hosted workflows finish, and reaped once they
 * do. This turn falls through to a clean, FRESH spawn.
 *
 * WHY QUARANTINE AND NOT REUSE (cross-model review blocker #2, 2026-09-04). The
 * first cut cleared `session.poisoned` and returned the same child, which is what
 * the poison exists to forbid — the abandoned turn is still running on that REPL
 * and its stale-reply debt strips the next reply's turn_id. Its regression test
 * could not see that, because the fake host answered turn 2 on the wedged child:
 * a real desynced REPL does not. So the host below models the real thing —
 * **incarnation #1 answers NOTHING, ever**. A test that expects the wedged child
 * to serve the next turn cannot pass against it.
 *
 * "Which child served turn 2" is therefore observable from `spawnCount()`, from
 * the reply text (`repl-<incarnation>:…`), and — new — from `childAlive(1)`,
 * which separates *spared* from *reused*.
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
import { quarantinedChildCount, sweepQuarantinedChildren } from '../spawn.ts'
import { loadRegistry, patchRecord } from '../repl-registry.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

function makeWedgeOnceHost(): {
  host: PtyHost
  spawnCount: () => number
  messagesSeen: () => number
  childAlive: (incarnation: number) => boolean
  argvOf: (incarnation: number) => string[]
} {
  let spawns = 0
  let messages = 0
  const alive = new Map<number, () => boolean>()
  const argvs = new Map<number, string[]>()
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      const incarnation = spawns
      argvs.set(incarnation, [...argv])
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
            // Incarnation #1 is the WEDGED child: its first inject is the runaway
            // turn and it never regains correlation, so it answers NOTHING — the
            // behaviour a real abandon-poisoned REPL has. Everything from a later
            // incarnation is answered, tagged with the replying child.
            void messagesOnThisChild
            if (incarnation !== 1) {
              // A real child answers AFTER the inject POST has returned; reply on
              // the next tick so the pool's post-inject status precedes the completion.
              setTimeout(() => {
                void post('/reply', {
                  session_id: sid,
                  text: `repl-${incarnation}:${body.text}`,
                  turn_id: body.turn_id,
                })
              }, 20)
            }
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      alive.set(incarnation, () => !hasExited)
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
  return {
    host,
    spawnCount: () => spawns,
    messagesSeen: () => messages,
    childAlive: (incarnation) => alive.get(incarnation)?.() === true,
    argvOf: (incarnation) => argvs.get(incarnation) ?? [],
  }
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

describe('the post-inject `working` status names the child generation (the eviction guard key)', () => {
  it('exactly one non-keepalive status carries launcher_session_key, equal to the completion generation', async () => {
    const { host, messagesSeen } = makeWedgeOnceHost()
    const sub = createPersistentReplSubstrate(opts(host))

    // The wedge-once host ignores the first inject; abandon it and observe the
    // answered second turn (served by the respawned child after the eviction).
    await abandonFirstTurn(sub, messagesSeen)

    const statuses: Array<{ message: string; keepalive: boolean; key: string | undefined }> = []
    let completionKey: string | undefined
    for await (const ev of sub.start(spec('turn-2')).events as AsyncIterable<Event>) {
      if (ev.kind === 'status') {
        statuses.push({ message: ev.message, keepalive: ev.keepalive === true, key: ev.launcher_session_key })
      } else if (ev.kind === 'completion') {
        completionKey = ev.launcher_session_key
        break
      } else if (ev.kind === 'error') {
        throw new Error(`turn errored: ${ev.message}`)
      }
    }
    const stamped = statuses.filter((s) => s.key !== undefined)
    // Red mutation: dropping the stamp in pool.ts leaves this empty and the
    // unconfirmed-fire row without a generation until (unless) the turn settles.
    expect(stamped).toHaveLength(1)
    expect(stamped[0]!.message).toBe('working')
    expect(stamped[0]!.keepalive).toBe(false)
    expect(completionKey).toBeDefined()
    expect(stamped[0]!.key).toBe(completionKey!)
    expect(statuses.filter((s) => s.keepalive).every((s) => s.key === undefined)).toBe(true)
  })
})

describe('abandon-poison eviction guard — a poisoned launcher hosting live work is QUARANTINED, not killed and not reused', () => {
  it('REGRESSION: with hostsLiveWork > 0 the child is SPARED (still running) but NOT reused — the next turn gets a fresh child', async () => {
    const { host, spawnCount, messagesSeen, childAlive } = makeWedgeOnceHost()
    const askedFor: string[] = []
    const crashes: string[] = []
    const sub = createPersistentReplSubstrate(
      opts(host, {
        hostsLiveWork: (generation) => {
          askedFor.push(generation)
          return 3
        },
        onChildCrash: (info) => {
          crashes.push(info.generationKey)
        },
      }),
    )

    await abandonFirstTurn(sub, messagesSeen)
    expect(spawnCount()).toBe(1)
    expect(childAlive(1)).toBe(true)

    const { result: r2, lines } = await captureStderr(() => drain(sub.start(spec('turn-2'))))
    expect(r2.errored).toBe(false)

    // BOTH halves, and they are separate claims:
    //  (a) SPARED — child #1 is still running, so the Argus panels, arbiter and
    //      terminal steps it hosts are still running. Red mutation: delete the
    //      `hosted > 0` branch and child #1 is SIGKILLed here.
    expect(childAlive(1)).toBe(true)
    //  (b) NOT REUSED — turn 2 is served by a FRESH child. Red mutation: restore
    //      `session.poisoned = false; return session` and this reads `repl-1:…`
    //      against a host that models the wedge honestly — i.e. it hangs and the
    //      turn never completes.
    expect(r2.text).toBe('repl-2:turn-2')
    expect(spawnCount()).toBe(2)

    // The guard was asked about the exact child generation (a per-spawn UUID).
    expect(askedFor.length).toBeGreaterThanOrEqual(1)
    expect(askedFor[0]).toMatch(/^[0-9a-f-]{36}$/)

    const quarantines = lines.filter((l) => l.includes('[repl] QUARANTINED'))
    expect(quarantines).toHaveLength(1)
    expect(quarantines[0]).toContain('hosts 3 live workflows')
    expect(quarantines[0]).toContain(`generation=${askedFor[0]!.slice(0, 8)}`)
    expect(lines.some((l) => l.includes('evicting abandon-poisoned'))).toBe(false)

    // A spared child is NOT a dead child: nothing may report it crashed while its
    // hosted workflows are still running, or crash recovery kills them by proxy.
    expect(crashes).toEqual([])

    // And it stays out of the pool: turn 3 also lands on the fresh child, with no
    // second quarantine (there is nothing poisoned left to quarantine).
    const { result: r3, lines: lines3 } = await captureStderr(() => drain(sub.start(spec('turn-3'))))
    expect(r3.text).toBe('repl-2:turn-3')
    expect(spawnCount()).toBe(2)
    expect(lines3.some((l) => l.includes('[repl] QUARANTINED'))).toBe(false)
  })

  /** A registry whose record for the live session is marked resumable — what a
   *  real capture writes once the transcript JSONL lands. Without it every
   *  respawn in this file is cold, and a `--resume` assertion proves nothing. */
  async function resumableRegistry(
    sub: ReturnType<typeof createPersistentReplSubstrate>,
    registryPath: string,
    messagesSeen: () => number,
  ): Promise<void> {
    await abandonFirstTurn(sub, messagesSeen)
    const keys = Object.keys(loadRegistry(registryPath))
    expect(keys).toHaveLength(1)
    patchRecord(registryPath, keys[0]!, { has_session: true })
  }

  function registryPath(): string {
    return join(mkdtempSync(join(tmpdir(), 'neutron-quarantine-')), 'repl-registry.json')
  }

  it('POSITIVE CONTROL: an ordinary eviction DOES --resume the dead child\'s transcript', async () => {
    const { host, messagesSeen, argvOf } = makeWedgeOnceHost()
    const path = registryPath()
    const sub = createPersistentReplSubstrate(
      opts(host, { hostsLiveWork: () => 0, replRegistryPath: path }),
    )
    await resumableRegistry(sub, path, messagesSeen)
    await drain(sub.start(spec('turn-2')))

    // This is what makes the quarantine assertion below meaningful: the fixture
    // resumes when nothing forbids it. Were this cold, `not.toContain('--resume')`
    // would pass for the wrong reason.
    expect(argvOf(2)).toContain('--resume')
    expect(argvOf(2)[argvOf(2).indexOf('--resume') + 1]).toBe(
      argvOf(1)[argvOf(1).indexOf('--session-id') + 1],
    )
  })

  it('the replacement does NOT --resume the quarantined transcript (the one-owner invariant a live child cannot give us)', async () => {
    const { host, messagesSeen, argvOf, childAlive } = makeWedgeOnceHost()
    const path = registryPath()
    const sub = createPersistentReplSubstrate(
      opts(host, { hostsLiveWork: () => 2, replRegistryPath: path }),
    )
    await resumableRegistry(sub, path, messagesSeen)
    await drain(sub.start(spec('turn-2')))

    // Same registry state as the control, opposite outcome — because the first
    // owner of that transcript is deliberately STILL ALIVE. Red mutation: drop
    // `evictedForceFresh = true` from the quarantine branch and this resumes it.
    expect(childAlive(1)).toBe(true)
    expect(argvOf(2)).not.toContain('--resume')
    expect(argvOf(2)).toContain('--session-id')
    expect(argvOf(2)[argvOf(2).indexOf('--session-id') + 1]).not.toBe(
      argvOf(1)[argvOf(1).indexOf('--session-id') + 1],
    )
  })

  it('the quarantined child is reaped once its hosted work drains — and never before', async () => {
    const { host, messagesSeen, childAlive } = makeWedgeOnceHost()
    let hosted = 4
    const sub = createPersistentReplSubstrate(opts(host, { hostsLiveWork: () => hosted }))

    await abandonFirstTurn(sub, messagesSeen)
    await drain(sub.start(spec('turn-2')))
    expect(quarantinedChildCount()).toBe(1)

    // Still hosting: a sweep must not touch it. Red mutation: drop the
    // `countHostedLiveWork(...) > 0` continue and this kills live workflows — the
    // exact 33%-of-deaths bug, moved into the reaper.
    expect(await sweepQuarantinedChildren()).toBe(0)
    expect(childAlive(1)).toBe(true)
    expect(quarantinedChildCount()).toBe(1)

    // Drained: now it is reaped, and only now.
    hosted = 0
    expect(await sweepQuarantinedChildren()).toBe(1)
    expect(childAlive(1)).toBe(false)
    expect(quarantinedChildCount()).toBe(0)

    // Idempotent — a second sweep has nothing to do.
    expect(await sweepQuarantinedChildren()).toBe(0)
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
