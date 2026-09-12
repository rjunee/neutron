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
  bakedChildSinkInfo,
  registerSupervisedSubstrate,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import { quarantinedChildCount, sweepQuarantinedChildren } from '../spawn.ts'
import {
  deliverShutdownKillReports,
  gatewayShutdownKillEntryFor,
  observationOf,
  recordGatewayShutdownOutcome,
  wasKilledByGatewayShutdown,
  type PendingShutdownKillReport,
} from '../gateway-shutdown-kill.ts'
import { childByKey } from '../pool-state.ts'
import type { ReplRegistryRecord } from '../repl-registry.ts'

/** The generations a row records as killed by a gateway shutdown. */
const killedGenerations = (record: ReplRegistryRecord | undefined): string[] =>
  (record?.killed_by_gateway_shutdown ?? []).map((e) => e.generation)
import { probeLauncherGenerationAlive, runReplWatchdogTick } from '../supervision.ts'
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
      const { port: sinkPort, token } = bakedChildSinkInfo(argv)
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

  it('a later dispatch reaps the drained quarantined child on its own — nothing else calls the sweep in production', async () => {
    const { host, messagesSeen, childAlive } = makeWedgeOnceHost()
    let hosted = 4
    const sub = createPersistentReplSubstrate(opts(host, { hostsLiveWork: () => hosted }))

    await abandonFirstTurn(sub, messagesSeen)
    await drain(sub.start(spec('turn-2')))
    expect(quarantinedChildCount()).toBe(1)

    // Still hosting: dispatching does not reap it.
    await drain(sub.start(spec('turn-3')))
    expect(quarantinedChildCount()).toBe(1)
    expect(childAlive(1)).toBe(true)

    // Drained. `sweepQuarantinedChildren()` is exported for the test above, but in
    // production NOTHING calls it except the heartbeat at the top of
    // `getOrSpawnSession` — so a plain dispatch must be enough. Red mutation:
    // delete that `fireAndForget('persistent-repl.quarantine-sweep', ...)` line and
    // the child below stays alive forever (it is outside the pool, so the
    // supervision watchdog cannot see it either).
    hosted = 0
    await drain(sub.start(spec('turn-4')))
    // The sweep is FIRED, not awaited, by the dispatch path.
    await waitUntil(() => quarantinedChildCount() === 0)
    expect(quarantinedChildCount()).toBe(0)
    expect(childAlive(1)).toBe(false)
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

/**
 * #518 — THE DEPLOY ITSELF. `shutdownAllPersistentRepls` is what the gateway's
 * SIGTERM handler calls (`gateway/index.ts`), so `systemctl restart` — which is how a
 * deploy ends — reaches `session.child.kill()` and takes every detached workflow with
 * it. These cases pin that each kill is REPORTED as the restart it was, on both sites:
 * the pooled child, and the QUARANTINED child, which was reporting nothing at all.
 */
describe('a gateway shutdown reports its own kills as a deploy, never as a crash', () => {
  it('a POOLED child is reported with cause gateway-shutdown before it is killed', async () => {
    // RED-mutation: delete the `reportGatewayShutdownKill` call from the pool loop in
    // `shutdownAllPersistentRepls`. The child still dies, the run still ends up
    // crashed — reported by the NEXT boot as "pooled child exited".
    const { host, childAlive, messagesSeen } = makeWedgeOnceHost()
    const registryPath = join(mkdtempSync(join(tmpdir(), 'neutron-shutdown-')), 'repl-registry.json')
    const seen: Array<{ cause: string; generation: string; detail: string; markedAlready: boolean }> = []
    const options = opts(host, {
      replRegistryPath: registryPath,
      onChildCrash: (info) => {
        // ORDER IS THE CLAIM, not just the call: the report has to be written while the
        // child is still alive, because after the kill this process may get no further
        // turn and the gateway closes its database moments later.
        seen.push({
          cause: info.cause,
          generation: info.generationKey,
          detail: info.detail,
          // THE ORDERING THAT MATTERS, observed from inside the sink: the durable
          // marker is ALREADY on disk by the time the live report is attempted. The
          // report is the optional half and runs last, so it must never be the thing
          // that puts the marker there.
          markedAlready: killedGenerations(
            loadRegistry(registryPath)[Object.keys(loadRegistry(registryPath))[0] as string],
          ).includes(info.generationKey),
        })
      },
    })
    registerSupervisedSubstrate(options)
    const sub = createPersistentReplSubstrate(options)
    // Incarnation #1 of this host never answers, so the turn is abandoned rather than
    // drained — which is also the live shape: the child is POOLED and still alive when
    // the deploy's SIGTERM arrives, with work running inside it.
    await abandonFirstTurn(sub, messagesSeen)
    expect(childAlive(1)).toBe(true)

    await shutdownAllPersistentRepls()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.cause).toBe('gateway-shutdown')
    expect(seen[0]?.detail).toContain('deploy')
    // MARK BEFORE REPORT. RED-mutation: move the `recordGatewayShutdownOutcome` call
    // out of `recordGatewayShutdownKill` and into the delivery phase — the marker then
    // depends on the sink, which is the dependency this whole structure removes.
    expect(seen[0]?.markedAlready).toBe(true)
    // And the child is already dead by the time its report is attempted — deliberately.
    // The kill is cheap and local and must not queue behind a sink; the report is the
    // bounded, optional half and goes last. RED-mutation: await the report inline in
    // the pool loop and this flips.
    expect(childAlive(1)).toBe(false)
    // And the durable marker is on the row for the next boot's watchdog, naming the
    // generation it describes.
    const record = Object.values(loadRegistry(registryPath))[0]
    expect(killedGenerations(record)).toEqual([seen[0]!.generation])
    // The crash edge is stamped too, so the next boot does not fire a SECOND, bare
    // notification that would overwrite the deploy attribution in the store.
    expect(record?.child_crash_notified_at).toBeGreaterThan(0)
    expect(childAlive(1)).toBe(false)
  })

  it('a QUARANTINED child — the one that certainly hosts live work — is reported too', async () => {
    // A child is quarantined precisely BECAUSE it still hosts running workflows, and at
    // shutdown it reported NOTHING: the `child.exited` hook `quarantineChild` installs
    // returns early once the entry is gone from the map, and `shutdownQuarantinedChildren`
    // deleted it first. So the single class of child most likely to be hosting a live
    // build died silently on every deploy.
    //
    // RED-mutation: delete the `reportGatewayShutdownKill` call from
    // `shutdownQuarantinedChildren` — `seen` comes back empty.
    const { host, messagesSeen, childAlive } = makeWedgeOnceHost()
    const registryPath = join(mkdtempSync(join(tmpdir(), 'neutron-shutdown-q-')), 'repl-registry.json')
    const seen: Array<{ cause: string; detail: string; generation: string }> = []
    const options = opts(host, {
      replRegistryPath: registryPath,
      hostsLiveWork: () => 3,
      onChildCrash: (info) => {
        seen.push({ cause: info.cause, detail: info.detail, generation: info.generationKey })
      },
    })
    registerSupervisedSubstrate(options)
    const sub = createPersistentReplSubstrate(options)

    // Poison turn 1, then let turn 2 quarantine child #1 (spared because it hosts work).
    await abandonFirstTurn(sub, messagesSeen)
    const quarantinedGeneration = loadRegistry(registryPath)[
      Object.keys(loadRegistry(registryPath))[0] as string
    ]?.child_generation as string
    expect(quarantinedGeneration).toBeDefined()
    await captureStderr(() => drain(sub.start(spec('turn-2'))))
    expect(quarantinedChildCount()).toBe(1)
    expect(childAlive(1)).toBe(true)
    // Turn 2's fresh child rewrote the row, so the two generations are distinct — which
    // is what lets the assertion below name the QUARANTINED one specifically rather than
    // being satisfied by the pooled child's report.
    const pooledGeneration = loadRegistry(registryPath)[
      Object.keys(loadRegistry(registryPath))[0] as string
    ]?.child_generation as string
    expect(pooledGeneration).not.toBe(quarantinedGeneration)
    expect(seen).toEqual([])

    await shutdownAllPersistentRepls()

    // BOTH children are reported, and the quarantined generation is named explicitly.
    // Asserting only "at least one report, all of them deploys" would be satisfied by
    // the pooled child alone — the quarantine call could be deleted and the test would
    // stay green, which is exactly what the mutation run caught.
    expect(seen.map((s) => s.generation).sort()).toEqual([quarantinedGeneration, pooledGeneration].sort())
    expect(seen.every((s) => s.cause === 'gateway-shutdown')).toBe(true)
    expect(seen.every((s) => s.detail.includes('deploy'))).toBe(true)
    expect(seen.some((s) => s.detail.includes('pooled child exited'))).toBe(false)
    expect(childAlive(1)).toBe(false)

    // AND NOW THE DURABLE HALF, which the emitted callbacks say nothing about. The two
    // generations SHARE ONE session-keyed registry row, and the quarantined write lands
    // SECOND (`pool.ts` walks the pool before `shutdownQuarantinedChildren`). Asserting
    // only the callbacks left this unverified while reading as though it were covered.
    //
    // RED-mutation: drop the `child_generation !== childGeneration` guard in
    // `recordGatewayShutdownOutcome`. The quarantined write then replaces the pooled
    // one, so the row names the POOLED generation beside a marker naming the
    // QUARANTINED one — `wasKilledByGatewayShutdown` goes false, the next boot
    // attributes nothing, and `child_crash_notified_at` is left set so the watchdog
    // will not even fire the honest bare report. The backstop breaks in both halves at
    // once, in exactly the case it exists for.
    const finalRow = loadRegistry(registryPath)[Object.keys(loadRegistry(registryPath))[0] as string]
    expect(finalRow?.child_generation).toBe(pooledGeneration)
    // BOTH generations are durably recorded on the one session-keyed row. The
    // quarantined one is no longer the row's current generation — a replacement
    // spawned over it — and a single-slot marker therefore had nowhere to put it.
    // RED-mutation: restore the single-slot write; the quarantined generation
    // disappears and this reddens.
    expect(killedGenerations(finalRow).sort()).toEqual([pooledGeneration, quarantinedGeneration].sort())
    expect(wasKilledByGatewayShutdown(finalRow)).toBe(true)
    // The edge is closed for the generation the row describes, and for that one only.
    expect(finalRow?.child_crash_notified_at).toBeGreaterThan(0)
  })

  it('THE COMPLEMENT — an eviction with NO live work still reports cause child-died', async () => {
    // The pool evicting an abandon-poisoned child is a fault response, not a deploy.
    // RED-mutation: change `notifyEvictedChild`'s cause to 'gateway-shutdown' — this
    // reddens while both shutdown cases above stay green.
    const { host, messagesSeen } = makeWedgeOnceHost()
    const causes: string[] = []
    const sub = createPersistentReplSubstrate(
      opts(host, {
        hostsLiveWork: () => 0,
        onChildCrash: (info) => {
          causes.push(info.cause)
        },
      }),
    )
    await abandonFirstTurn(sub, messagesSeen)
    await captureStderr(() => drain(sub.start(spec('turn-2'))))
    expect(causes).toContain('child-died')
    expect(causes).not.toContain('gateway-shutdown')
  })
})

describe('a fresh spawn does not inherit the previous generation\'s excuse (#518)', () => {
  it('a respawn clears the gateway-shutdown marker along with the crash edge', async () => {
    // The registry row is keyed by pool session key and OUTLIVES the child, so a marker
    // left in place would go on excusing deaths forever and the next child's genuine
    // fault would be reported as a deploy. `spawn.ts` drops both marker fields when it
    // writes a new generation, exactly as it already dropped `child_crash_notified_at`.
    //
    // RED-mutation: remove `killed_by_gateway_shutdown_generation` from the destructured
    // drop list in `spawn.ts`. The row then carries the OLD marker beside the NEW
    // generation, and only `wasKilledByGatewayShutdown`'s equality check — the second
    // line of defence, pinned separately — stands between it and a misattributed crash.
    const { host, messagesSeen, spawnCount } = makeWedgeOnceHost()
    const registryPath = join(mkdtempSync(join(tmpdir(), 'neutron-stale-marker-')), 'repl-registry.json')
    const options = opts(host, { replRegistryPath: registryPath, hostsLiveWork: () => 0 })
    registerSupervisedSubstrate(options)
    const sub = createPersistentReplSubstrate(options)

    await abandonFirstTurn(sub, messagesSeen)
    const key = Object.keys(loadRegistry(registryPath))[0] as string
    const firstGeneration = loadRegistry(registryPath)[key]?.child_generation
    expect(firstGeneration).toBeDefined()
    // Pretend a gateway shutdown killed generation #1 and left its marker behind.
    expect(recordGatewayShutdownOutcome(registryPath, key, firstGeneration as string, 1_755_000_000_000, 'alive-and-killed')).toBe(true)

    // Turn 2 evicts the poisoned child (no live work) and spawns a fresh one, which
    // rewrites this row with a new generation.
    await captureStderr(() => drain(sub.start(spec('turn-2'))))
    expect(spawnCount()).toBe(2)

    const after = loadRegistry(registryPath)[key]
    expect(after?.child_generation).not.toBe(firstGeneration)
    // The old generation's entry SURVIVES the respawn — deliberately. It is keyed by
    // generation, so it cannot be read as describing the new child, and it is the only
    // durable record that a deploy killed the old one. RED-mutation: drop it in
    // `spawn.ts`'s registry merge, as an earlier revision did, and a quarantined
    // generation loses its only durable record.
    expect(killedGenerations(after)).toEqual([firstGeneration as string])
    // The crash edge IS still cleared, because it describes the pid edge, not the kill.
    expect(after?.child_crash_notified_at).toBeUndefined()
    // And the NEW generation is reported honestly if it dies — no inherited excuse.
    expect(wasKilledByGatewayShutdown(after)).toBe(false)
  })
})

describe('a child that was ALREADY DEAD when teardown arrived is not a deploy kill (#518)', () => {
  it('reports cause unknown and records it AS undetermined — not as ours, not as a crash', async () => {
    // THE MISATTRIBUTION THIS PR ALMOST SHIPPED. `kill()` is idempotent after exit, so
    // teardown "kills" a child that died of a genuine fault moments earlier exactly as
    // readily as a live one. Reporting that as a deploy is the PR's own thesis running
    // backwards, and it is the worse direction: a bare crash for a deploy sends the
    // owner after a bug that is not there, but a deploy for a real fault stops him
    // looking at a bug that is.
    //
    // RED-mutation: in `reportGatewayShutdownKill`, make `attributed` unconditionally
    // true. This reddens while the live-child case above stays green.
    const { host, messagesSeen, childAlive } = makeWedgeOnceHost()
    const registryPath = join(mkdtempSync(join(tmpdir(), 'neutron-already-dead-')), 'repl-registry.json')
    const seen: Array<{ cause: string; detail: string }> = []
    const options = opts(host, {
      replRegistryPath: registryPath,
      onChildCrash: (info) => {
        seen.push({ cause: info.cause, detail: info.detail })
      },
    })
    registerSupervisedSubstrate(options)
    const sub = createPersistentReplSubstrate(options)
    await abandonFirstTurn(sub, messagesSeen)

    // The child dies on its own, BEFORE teardown — the fault this must not absorb. The
    // session stays in the pool, which is precisely how the race reaches the shutdown
    // walk (the watchdog is stopped first, so nothing has reported it yet).
    const key = Object.keys(loadRegistry(registryPath))[0] as string
    const deadGeneration = loadRegistry(registryPath)[key]?.child_generation as string
    childByKey.get(key)?.kill()
    await waitUntil(() => !childAlive(1))

    await captureStderr(() => shutdownAllPersistentRepls())

    expect(seen).toHaveLength(1)
    expect(seen[0]?.cause).toBe('unknown')
    expect(seen[0]?.detail).toContain('UNDETERMINED')
    expect(seen[0]?.detail).not.toContain('a service restart or a deploy')

    const row = loadRegistry(registryPath)[key]
    // NO EXCUSE ON DISK for a death we did not cause...
    expect(wasKilledByGatewayShutdown(row)).toBe(false)
    // ...but the OUTCOME is durable, which is what lets the retry say "cause not
    // established" instead of inventing a crash. RED-mutation: skip the entry unless we
    // killed the child, and the retry reports `child-died`.
    expect(killedGenerations(row)).toEqual([deadGeneration])
    expect(observationOf(gatewayShutdownKillEntryFor(row, deadGeneration))).toBe('already-gone')
    // ...and the edge IS closed, because the report was DELIVERED. This assertion was
    // inverted, and that was a defect rather than a detail: the edge records that a
    // report happened, not what it said. Left open, the next tick reported the same
    // death as a confident `child-died` and overwrote this honest one — pinned as a
    // SEQUENCE in "a delivered undetermined report is not reported again". What must
    // stay absent is the MARKER, asserted above: no excuse on disk for a death we did
    // not cause.
    expect(row?.child_crash_notified_at).toBeGreaterThan(0)
    expect(deadGeneration).toBeDefined()
  })
})

/**
 * #518 — A TRANSIENT SINK FAILURE MUST NOT BECOME PERMANENT SILENCE.
 *
 * The marker's whole purpose is to be the backstop when the direct report does not
 * land. The first cut wrote `child_crash_notified_at` in the SAME patch as the
 * attribution marker — before the sink ran — so a throwing sink left the edge closed,
 * the next boot's watchdog skipped it, the respawn cleared the marker, and the pull
 * probe answered `unknown` for the dead generation. The owner then received no
 * failure reason AT ALL: not a wrong one, none.
 *
 * The existing throwing-sink case asserts only that the marker exists, which is the
 * artifact rather than the property the artifact is for. This drives the sequence the
 * marker exists to enable.
 */
describe('the durable backstop actually backs up a failed report (#518)', () => {
  it('sink throws at shutdown → the NEXT boot delivers the attributed deploy report', async () => {
    // RED-mutation: restore `child_crash_notified_at: at` to the patch in
    // `recordGatewayShutdownOutcome`. The shutdown half still passes — the marker is
    // there, the throw is caught — and the next-boot tick reports NOTHING, because the
    // watchdog's `record?.child_crash_notified_at === undefined` gate skips the edge.
    const { host, messagesSeen, childAlive } = makeWedgeOnceHost()
    const registryPath = join(mkdtempSync(join(tmpdir(), 'neutron-backstop-')), 'repl-registry.json')

    let sinkWorks = false
    const delivered: Array<{ cause: string; detail: string; generation: string }> = []
    const options = opts(host, {
      replRegistryPath: registryPath,
      onChildCrash: (info) => {
        if (!sinkWorks) throw new Error('sqlite busy')
        delivered.push({ cause: info.cause, detail: info.detail, generation: info.generationKey })
      },
    })
    registerSupervisedSubstrate(options)
    const sub = createPersistentReplSubstrate(options)
    await abandonFirstTurn(sub, messagesSeen)
    const key = Object.keys(loadRegistry(registryPath))[0] as string
    const generation = loadRegistry(registryPath)[key]?.child_generation as string
    expect(childAlive(1)).toBe(true)

    // The deploy. The child is alive, so the death IS ours — and the sink refuses it.
    await captureStderr(() => shutdownAllPersistentRepls())
    expect(delivered).toEqual([])
    expect(childAlive(1)).toBe(false)

    const afterShutdown = loadRegistry(registryPath)[key]
    // The attribution survived: it is a fact about the kill, written before it.
    expect(killedGenerations(afterShutdown)).toEqual([generation])
    // And the crash edge is OPEN, because nothing was reported. This is the assertion
    // the first cut failed: a tombstone must not be written before the thing it
    // attests to.
    expect(afterShutdown?.child_crash_notified_at).toBeUndefined()

    // The next boot. The recorded pid is dead and the watchdog reaches the edge.
    sinkWorks = true
    await runReplWatchdogTick(options, {
      healthProbe: async () => false,
      isPidAlive: () => false,
      now: () => Date.now() + 120_000,
      postAlert: () => {},
    })

    // THE PROPERTY: the owner is told, and told the ATTRIBUTED thing. A late generic
    // crash would be a lesser failure of the same kind — the retry carries the
    // attribution because the attribution is on disk.
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.generation).toBe(generation)
    expect(delivered[0]?.cause).toBe('gateway-shutdown')
    expect(delivered[0]?.detail).toContain('deploy')
    expect(delivered[0]?.detail).not.toContain('pooled child exited')
    // ...and NOW the edge is closed, so a third pass says nothing further.
    expect(loadRegistry(registryPath)[key]?.child_crash_notified_at).toBeGreaterThan(0)
  })

  it('THE COMPLEMENT — a sink that SUCCEEDS at shutdown is not reported twice', async () => {
    // Moving the write must not lose the de-duplication it provided. RED-mutation:
    // delete the `closeCrashReportEdge` call after the successful sink commit — the
    // next boot re-reports the same death and this reddens.
    const { host, messagesSeen } = makeWedgeOnceHost()
    const registryPath = join(mkdtempSync(join(tmpdir(), 'neutron-backstop-ok-')), 'repl-registry.json')
    const delivered: string[] = []
    const options = opts(host, {
      replRegistryPath: registryPath,
      onChildCrash: (info) => {
        delivered.push(info.cause)
      },
    })
    registerSupervisedSubstrate(options)
    const sub = createPersistentReplSubstrate(options)
    await abandonFirstTurn(sub, messagesSeen)
    const key = Object.keys(loadRegistry(registryPath))[0] as string

    await captureStderr(() => shutdownAllPersistentRepls())
    expect(delivered).toEqual(['gateway-shutdown'])
    expect(loadRegistry(registryPath)[key]?.child_crash_notified_at).toBeGreaterThan(0)

    await runReplWatchdogTick(options, {
      healthProbe: async () => false,
      isPidAlive: () => false,
      now: () => Date.now() + 120_000,
      postAlert: () => {},
    })
    expect(delivered).toEqual(['gateway-shutdown'])
  })
})

/**
 * #518 — A HUNG SINK COSTS A LATE REPORT AND NOTHING ELSE.
 *
 * Shutdown runs against a deadline this process does not control: systemd SIGKILLs the
 * cgroup at `TimeoutStopSec` whatever we are in the middle of. An earlier revision
 * awaited the unrestricted `onChildCrash` promise BETWEEN one child's kill and the
 * next child's marker, so a single sink that never settled took the whole deadline
 * away from every child behind it — and each of those then died unmarked and was
 * reported on the next boot as a bare crash. That is this change's own purpose,
 * defeated by this change, and worse than the original defect because it took out
 * every remaining child rather than one.
 *
 * The fix is phase separation, so these cases assert the phases rather than the
 * timing: mark everything, kill everything, then attempt the reports under a bound.
 */
describe('no child’s marker or kill sits behind another child’s sink (#518)', () => {
  // 30s: this case deliberately goes through the PRODUCTION budgets rather than injected
  // ones, so it really waits out `SHUTDOWN_REPORT_PER_SINK_MS` twice. The default 5s
  // timeout made it a report on event-loop load in a large run rather than on the
  // property.
  it('a sink that NEVER settles still leaves every child marked and killed', async () => {
    // RED-mutation: revert `shutdownAllPersistentRepls` to awaiting
    // `reportGatewayShutdownKill` inline in the pool loop. This test then hangs until
    // the suite's own timeout — the shutdown never reaches the second child at all.
    const hostA = makeWedgeOnceHost()
    const hostB = makeWedgeOnceHost()
    const dir = mkdtempSync(join(tmpdir(), 'neutron-hung-sink-'))
    const registryA = join(dir, 'a.json')
    const registryB = join(dir, 'b.json')

    // Child A's sink never answers. Child B's records.
    const deliveredB: string[] = []
    const optionsA = opts(hostA.host, {
      substrate_instance_id: 'cc-trident-fire-A',
      cwd: '/tmp/neutron-hung-a',
      replRegistryPath: registryA,
      onChildCrash: () => new Promise<void>(() => {}),
    })
    const optionsB = opts(hostB.host, {
      substrate_instance_id: 'cc-trident-fire-B',
      cwd: '/tmp/neutron-hung-b',
      replRegistryPath: registryB,
      onChildCrash: (info) => {
        deliveredB.push(info.cause)
      },
    })
    registerSupervisedSubstrate(optionsA)
    registerSupervisedSubstrate(optionsB)
    const subA = createPersistentReplSubstrate(optionsA)
    const subB = createPersistentReplSubstrate(optionsB)
    await abandonFirstTurn(subA, hostA.messagesSeen)
    await abandonFirstTurn(subB, hostB.messagesSeen)
    expect(hostA.childAlive(1)).toBe(true)
    expect(hostB.childAlive(1)).toBe(true)

    const keyA = Object.keys(loadRegistry(registryA))[0] as string
    const keyB = Object.keys(loadRegistry(registryB))[0] as string
    const genA = loadRegistry(registryA)[keyA]?.child_generation as string
    const genB = loadRegistry(registryB)[keyB]?.child_generation as string

    // Bounded so the phase cannot outlive the case even if the fix regresses in a way
    // the structure does not catch.
    await captureStderr(() => shutdownAllPersistentRepls())

    // BOTH children are dead. Neither kill waited on a sink.
    expect(hostA.childAlive(1)).toBe(false)
    expect(hostB.childAlive(1)).toBe(false)

    // BOTH children are MARKED — which is what lets the next boot attribute them even
    // though one report never landed and the other may have been abandoned.
    expect(killedGenerations(loadRegistry(registryA)[keyA])).toEqual([genA])
    expect(killedGenerations(loadRegistry(registryB)[keyB])).toEqual([genB])

    // The hung sink never committed, so ITS edge stays open for the next boot.
    expect(loadRegistry(registryA)[keyA]?.child_crash_notified_at).toBeUndefined()
    // And the child behind it was still reported live — the hang cost a late report
    // for A, not B's report and not anybody's marker.
    expect(deliveredB).toEqual(['gateway-shutdown'])
    expect(loadRegistry(registryB)[keyB]?.child_crash_notified_at).toBeGreaterThan(0)
  }, 30_000)

  it('THE COMPLEMENT — a fast sink is still reported INLINE, not deferred away', async () => {
    // The fix must not degrade into "never wait". A sink that answers promptly still
    // commits during the shutdown, and its edge is closed before we return — so the
    // next boot does not re-report a death the owner has already been told about.
    //
    // RED-mutation: make `deliverShutdownKillReports` skip every report (treat the
    // phase budget as 0). This reddens while the hung-sink case above stays green.
    const { host, messagesSeen } = makeWedgeOnceHost()
    const registryPath = join(mkdtempSync(join(tmpdir(), 'neutron-fast-sink-')), 'repl-registry.json')
    const delivered: string[] = []
    const options = opts(host, {
      replRegistryPath: registryPath,
      onChildCrash: (info) => {
        delivered.push(info.cause)
      },
    })
    registerSupervisedSubstrate(options)
    const sub = createPersistentReplSubstrate(options)
    await abandonFirstTurn(sub, messagesSeen)
    const key = Object.keys(loadRegistry(registryPath))[0] as string

    await captureStderr(() => shutdownAllPersistentRepls())

    expect(delivered).toEqual(['gateway-shutdown'])
    expect(loadRegistry(registryPath)[key]?.child_crash_notified_at).toBeGreaterThan(0)
  })
})

/** A bounded wait that RECORDS what it was asked to wait for and resolves at once,
 *  plus a clock that advances by exactly that much. The bound is then asserted from
 *  what the code computed, deterministically — an earlier version raced a real
 *  `Bun.sleep` against a never-settling sink and failed only inside a 206-file
 *  process, which made the assertion a report on event-loop load rather than on the
 *  bound. */
function fakeClock(): { sleep: (ms: number) => Promise<void>; now: () => number; waits: number[] } {
  const waits: number[] = []
  let t = 1_000_000
  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms)
      t += ms
      await Promise.resolve()
    },
  }
}

describe('deliverShutdownKillReports is bounded per sink AND across the phase', () => {

  const pending = (id: string, sink: () => Promise<void>): PendingShutdownKillReport => ({
    options: { substrate_instance_id: id, cwd: '/x', onChildCrash: sink } as PersistentReplSubstrateOptions,
    sessionKey: `key-${id}`,
    childGeneration: `gen-${id}`,
    at: 1_000,
    observed: 'alive-and-killed',
    liveness: 'alive',
    durablyRecorded: 'alive-and-killed',
  })

  it('one hung sink is abandoned and the NEXT report still goes out', async () => {
    // The per-sink bound. RED-mutation: await the sink without the race — the case
    // never finishes.
    const seen: string[] = []
    const clock = fakeClock()
    const { result } = await captureStderr(() =>
      deliverShutdownKillReports(
        [
          pending('hung', () => new Promise<void>(() => {})),
          pending('ok', async () => {
            seen.push('ok')
          }),
        ],
        { perSinkMs: 20, phaseBudgetMs: 5_000, now: clock.now, sleep: clock.sleep },
      ),
    )
    expect(result.timedOut).toBe(1)
    expect(result.delivered).toBe(1)
    expect(seen).toEqual(['ok'])
    // The hung sink was waited on for exactly the per-sink bound, and no longer.
    expect(clock.waits[0]).toBe(20)
  })

  it('the PHASE stops once its budget is spent, instead of paying the per-sink bound N times', async () => {
    // The second bound, and it is not the same as the first: without it, ten hung
    // sinks at the per-sink bound would spend ten times that out of a deadline the
    // rest of the teardown shares. RED-mutation: drop the `remaining <= 0` check —
    // every one of the ten then times out instead of most being skipped.
    const hung = Array.from({ length: 10 }, (_, i) => pending(`h${i}`, () => new Promise<void>(() => {})))
    const clock = fakeClock()
    const { result } = await captureStderr(() =>
      deliverShutdownKillReports(hung, { perSinkMs: 20, phaseBudgetMs: 45, now: clock.now, sleep: clock.sleep }),
    )
    expect(result.timedOut + result.skipped).toBe(10)
    // The phase gave up rather than paying 10 × 20ms: most were never attempted.
    expect(result.skipped).toBeGreaterThanOrEqual(6)
    expect(result.delivered).toBe(0)
    // TOTAL waited is the phase budget, not 10 × the per-sink bound.
    expect(clock.waits.reduce((a, b) => a + b, 0)).toBe(45)
  })

  it('the LAST report before the deadline is clamped to what is left of the budget', () => {
    // The `Math.min(perSinkMs, remaining)` clamp. Without it the phase overruns its own
    // budget by up to one per-sink bound, which makes `phaseBudgetMs` a suggestion
    // rather than a bound in the one situation that matters: a shutdown already close to
    // the cgroup SIGKILL deadline.
    //
    // ASSERTED FROM THE REQUESTED BUDGETS, not from elapsed time. An earlier version
    // measured wall-clock and carried a `WALL-CLOCK-BOUND-OK` opt-out, on the reasoning
    // that the clamp's only observable effect IS elapsed time. Injecting the wait made
    // it directly observable, so the opt-out was removed rather than justified — a
    // deterministic assertion is available after all, which is what that gate asks
    // anyone claiming otherwise to check.
    //
    // RED-mutation: `const budget = perSinkMs` — the second wait becomes 500, not 20.
    const clock = fakeClock()
    return captureStderr(() =>
      deliverShutdownKillReports(
        [
          pending('a', () => new Promise<void>(() => {})),
          pending('b', () => new Promise<void>(() => {})),
        ],
        { perSinkMs: 500, phaseBudgetMs: 520, now: clock.now, sleep: clock.sleep },
      ),
    ).then(() => {
      // First gets the full per-sink bound; the second is clamped to what is left.
      expect(clock.waits).toEqual([500, 20])
    })
  })

  it('a throwing sink is counted as failed, and does not stop the ones behind it', async () => {
    const seen: string[] = []
    const { result } = await captureStderr(() =>
      deliverShutdownKillReports([
        pending('throws', async () => {
          throw new Error('sqlite busy')
        }),
        pending('ok', async () => {
          seen.push('ok')
        }),
      ]),
    )
    expect(result.failed).toBe(1)
    expect(result.delivered).toBe(1)
    expect(seen).toEqual(['ok'])
  })
})

/**
 * #518 — THE INTERSECTION NEITHER EXISTING TEST VISITED: a QUARANTINED child whose
 * live report does not land, recovered across a restart.
 *
 * The quarantine cases used an always-successful sink; the throwing and hung-sink
 * cases covered pooled children only. In between sat the case that matters most — a
 * child is quarantined precisely BECAUSE it hosts running workflows — and it was the
 * one with no durable record, because the row is session-keyed and a replacement
 * generation had already spawned over it.
 */
describe('a quarantined child whose report fails is still recoverable on the next boot', () => {
  it('sink throws → the quarantined generation is durably recorded and the probe finds it', async () => {
    // RED-mutation: restore the single-slot marker (refuse any generation the row does
    // not currently name). The quarantined generation then has NO durable record, the
    // probe answers 'unknown', and its build waits out the 90-minute reaper with no
    // reason ever delivered — which is the silence this whole change exists to remove,
    // reappearing for the one child most likely to be hosting real work.
    const { host, messagesSeen, childAlive } = makeWedgeOnceHost()
    const registryPath = join(mkdtempSync(join(tmpdir(), 'neutron-quarantine-fail-')), 'repl-registry.json')
    const options = opts(host, {
      replRegistryPath: registryPath,
      hostsLiveWork: () => 3,
      onChildCrash: () => {
        throw new Error('sqlite busy')
      },
    })
    registerSupervisedSubstrate(options)
    const sub = createPersistentReplSubstrate(options)

    // Turn 1 poisons child #1; turn 2 quarantines it (it hosts live work) and spawns a
    // replacement, which rewrites the session-keyed row with a NEW generation.
    await abandonFirstTurn(sub, messagesSeen)
    const key = Object.keys(loadRegistry(registryPath))[0] as string
    const quarantinedGeneration = loadRegistry(registryPath)[key]?.child_generation as string
    await captureStderr(() => drain(sub.start(spec('turn-2'))))
    expect(quarantinedChildCount()).toBe(1)
    const pooledGeneration = loadRegistry(registryPath)[key]?.child_generation as string
    expect(pooledGeneration).not.toBe(quarantinedGeneration)
    expect(childAlive(1)).toBe(true)

    // The deploy. Every sink call throws, so nothing is delivered live.
    await captureStderr(() => shutdownAllPersistentRepls())
    expect(childAlive(1)).toBe(false)

    // BOTH generations are durably recorded on the one row — the pooled child the row
    // names, and the quarantined child it does not.
    const row = loadRegistry(registryPath)[key]
    expect(killedGenerations(row).sort()).toEqual([pooledGeneration, quarantinedGeneration].sort())

    // AND THE PROBE FINDS THE QUARANTINED ONE, which is what a still-running build on
    // that launcher asks. Before this it answered 'unknown' forever.
    expect(probeLauncherGenerationAlive(quarantinedGeneration, registryPath)).toBe('killed-by-gateway-shutdown')
    // The pooled generation answers the same way, by its own entry.
    expect(probeLauncherGenerationAlive(pooledGeneration, registryPath)).toBe('killed-by-gateway-shutdown')
    // Nothing was delivered live, so no edge was closed: the next boot is free to report.
    expect(row?.child_crash_notified_at).toBeUndefined()
  })

  it('THE COMPLEMENT — a generation no shutdown killed is still unknown, not a deploy', async () => {
    // The recovery arm must not turn "I have never heard of this" into an attribution.
    // RED-mutation: have the entry scan return `killed-by-gateway-shutdown` whenever the
    // row has ANY entry, rather than one naming this generation.
    const { host, messagesSeen } = makeWedgeOnceHost()
    const registryPath = join(mkdtempSync(join(tmpdir(), 'neutron-quarantine-ok-')), 'repl-registry.json')
    const options = opts(host, { replRegistryPath: registryPath, hostsLiveWork: () => 3 })
    registerSupervisedSubstrate(options)
    const sub = createPersistentReplSubstrate(options)
    await abandonFirstTurn(sub, messagesSeen)
    await captureStderr(() => drain(sub.start(spec('turn-2'))))
    await captureStderr(() => shutdownAllPersistentRepls())

    expect(probeLauncherGenerationAlive('a-generation-nobody-killed', registryPath)).toBe('unknown')
  })
})

describe('an undelivered report does not promise a recovery it cannot make', () => {
  it('says the death is LOST when nothing durable records it, and not otherwise', async () => {
    // The delivery phase is best-effort because a durable record sits behind it — but
    // that is a property of the individual report. A report with no record behind it is
    // the only one this module can truly lose, and the operator line must say so rather
    // than repeat the reassurance that applies to its neighbours.
    //
    // RED-mutation: hard-code `recoveryConsequence` to the durable sentence — the
    // undurable case then claims a recovery with nothing to recover from, which is the
    // promise-that-does-not-apply-to-a-subset this asserts against.
    const hung = (): Promise<void> => new Promise<void>(() => {})
    const base = {
      options: { substrate_instance_id: 'x', cwd: '/x', onChildCrash: hung } as PersistentReplSubstrateOptions,
      at: 1_000,
      observed: 'alive-and-killed' as const,
      liveness: 'alive' as const,
    }
    const clock = fakeClock()
    const { lines } = await captureStderr(() =>
      deliverShutdownKillReports(
        [
          { ...base, sessionKey: 'k1', childGeneration: 'gen-durable', durablyRecorded: 'alive-and-killed' as const },
          { ...base, sessionKey: 'k2', childGeneration: 'gen-lost', durablyRecorded: null },
        ],
        { perSinkMs: 5, phaseBudgetMs: 5_000, now: clock.now, sleep: clock.sleep },
      ),
    )
    const all = lines.join('')
    expect(all).toContain('gen-dura')
    expect(all).toContain('gen-lost')
    // The one with a record behind it promises the recovery...
    const durableLine = lines.find((l) => l.includes('gen-dura')) ?? ''
    expect(durableLine).toContain('the next boot reports it from the durable record')
    // ...and the one without says it is lost, rather than promising the same thing.
    const lostLine = lines.find((l) => l.includes('gen-lost')) ?? ''
    expect(lostLine).toContain('NOTHING durable records this death')
    expect(lostLine).not.toContain('the next boot reports it from the durable record')
  })

  it('a record WEAKER than the report promises the weaker recovery, not this one', async () => {
    // THE THIRD ARM, and it is the one the post-kill promotion can produce: the row holds
    // the pre-kill `alive-when-reached` because the promotion failed, while the report
    // says `alive-and-killed`. Telling the operator "recovered" would promise the deploy
    // attribution and deliver the undetermined one.
    //
    // RED-mutation: compare `durablyRecorded` as a boolean again (`report.durablyRecorded
    // ? recovered : lost`) — this line then claims a recovery that does not match.
    const clock = fakeClock()
    const { lines } = await captureStderr(() =>
      deliverShutdownKillReports(
        [
          {
            options: { substrate_instance_id: 'x', cwd: '/x', onChildCrash: () => new Promise<void>(() => {}) } as PersistentReplSubstrateOptions,
            sessionKey: 'k',
            childGeneration: 'gen-weaker',
            at: 1_000,
            observed: 'alive-and-killed' as const,
            liveness: 'alive' as const,
            durablyRecorded: 'alive-when-reached' as const,
          },
        ],
        { perSinkMs: 5, phaseBudgetMs: 5_000, now: clock.now, sleep: clock.sleep },
      ),
    )
    const line = lines.find((l) => l.includes('gen-weak')) ?? ''
    expect(line).toContain('WEAKER than this report')
    expect(line).toContain('alive-when-reached')
    expect(line).not.toContain('the next boot reports it from the durable record')
    expect(line).not.toContain('NOTHING durable records this death')
  })
})

/**
 * #518 — A DELIVERED "I COULD NOT TELL" MUST NOT BE OVERWRITTEN BY A CONFIDENT GUESS.
 *
 * The crash edge records that a death's report HAPPENED. An earlier revision closed it
 * only for the ATTRIBUTED case, so a successfully delivered `cause: 'unknown'` left it
 * open — the next watchdog tick then passed the reporting gate and reported the same
 * death as `cause: 'child-died'`, and `crashRunningByLauncher` writes over the
 * tombstone's reason unconditionally. The honest answer was replaced by a confident
 * one, which is the misattribution this whole change exists to prevent, reached by a
 * new route.
 *
 * These cases assert the SEQUENCE rather than the field, because asserting the field is
 * what codified the defect: both undetermined cases explicitly expected the edge to
 * stay open.
 */
describe('a delivered undetermined report is not reported again (#518)', () => {
  it('successful unknown → the next watchdog tick says NOTHING further', async () => {
    // RED-mutation: restore `report.attributed &&` on the close condition in
    // `deliverShutdownKillReports`. The shutdown half still passes — the report is
    // delivered and says "undetermined" — and the tick then emits a SECOND report with
    // `cause: 'child-died'`, which is what this asserts against.
    const { host, messagesSeen, childAlive } = makeWedgeOnceHost()
    const registryPath = join(mkdtempSync(join(tmpdir(), 'neutron-unknown-once-')), 'repl-registry.json')
    const delivered: Array<{ cause: string; detail: string }> = []
    const options = opts(host, {
      replRegistryPath: registryPath,
      onChildCrash: (info) => {
        delivered.push({ cause: info.cause, detail: info.detail })
      },
    })
    registerSupervisedSubstrate(options)
    const sub = createPersistentReplSubstrate(options)
    await abandonFirstTurn(sub, messagesSeen)
    const key = Object.keys(loadRegistry(registryPath))[0] as string

    // The child dies of a fault BEFORE teardown, so the shutdown refuses to claim it
    // and reports `unknown` — the honest answer this must not let anything overwrite.
    childByKey.get(key)?.kill()
    await waitUntil(() => !childAlive(1))

    await captureStderr(() => shutdownAllPersistentRepls())
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.cause).toBe('unknown')
    // The edge is CLOSED — the report happened, whatever it said.
    expect(loadRegistry(registryPath)[key]?.child_crash_notified_at).toBeGreaterThan(0)

    // The next boot's watchdog finds the dead pid and must add nothing.
    await runReplWatchdogTick(options, {
      healthProbe: async () => false,
      isPidAlive: () => false,
      now: () => Date.now() + 120_000,
      postAlert: () => {},
    })

    // STILL ONE REPORT, and it still says undetermined. A second one would have said
    // `child-died` and replaced the honest reason in the store's tombstone.
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.cause).toBe('unknown')
    expect(delivered.some((d) => d.cause === 'child-died')).toBe(false)
  })

  it('THE COMPLEMENT — an UNDELIVERED unknown still leaves the edge open for retry', async () => {
    // The fix must not degrade into "always close". A report that never landed has to
    // stay reportable, or the round-4 backstop is gone for the undetermined case too.
    // RED-mutation: close the edge before the sink call, or unconditionally.
    const { host, messagesSeen, childAlive } = makeWedgeOnceHost()
    const registryPath = join(mkdtempSync(join(tmpdir(), 'neutron-unknown-retry-')), 'repl-registry.json')
    let sinkWorks = false
    const delivered: Array<{ cause: string; detail: string }> = []
    const options = opts(host, {
      replRegistryPath: registryPath,
      onChildCrash: (info) => {
        if (!sinkWorks) throw new Error('sqlite busy')
        delivered.push({ cause: info.cause, detail: info.detail })
      },
    })
    registerSupervisedSubstrate(options)
    const sub = createPersistentReplSubstrate(options)
    await abandonFirstTurn(sub, messagesSeen)
    const key = Object.keys(loadRegistry(registryPath))[0] as string
    childByKey.get(key)?.kill()
    await waitUntil(() => !childAlive(1))

    await captureStderr(() => shutdownAllPersistentRepls())
    expect(delivered).toEqual([])
    // NOT closed: nothing was reported.
    expect(loadRegistry(registryPath)[key]?.child_crash_notified_at).toBeUndefined()

    // So the next boot is free to report it — and does.
    sinkWorks = true
    await runReplWatchdogTick(options, {
      healthProbe: async () => false,
      isPidAlive: () => false,
      now: () => Date.now() + 120_000,
      postAlert: () => {},
    })

    // AND IT REPORTS WHAT WAS ESTABLISHED, not merely something. Counting the reports
    // was the defect in this assertion: a retry that FIRES is not a retry that says the
    // right thing, and this one used to fire with a confident `child-died` for a death
    // nobody observed — the honest uncertainty could not survive to the retry because
    // nothing recorded it.
    //
    // RED-mutation: map every non-deploy dead-child reason to `'child-died'` in
    // `supervision.ts` (drop the `pid-dead-cause-undetermined` arm), or write no entry
    // for the undetermined outcome. Either way this reddens and the count still passes.
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.cause).toBe('unknown')
    expect(delivered[0]?.detail).toContain('UNDETERMINED')
    expect(delivered[0]?.detail).toContain('ALREADY gone')
    expect(delivered[0]?.cause).not.toBe('child-died')
    expect(delivered[0]?.detail).not.toBe('pooled child exited')
  })
})

/**
 * #518 — A KILL THAT FAILED IS NOT A KILL. Tested at the LIVE PUSH PATH, because that is
 * where the harm lands: the production sink crashing a build that is still running.
 *
 * `attributed` used to be computed from the PRE-KILL liveness sample and consumed at
 * delivery as though it described the OUTCOME. The shutdown queues the report before
 * calling `kill()`, swallows a throw, and delivered the queued claim anyway — so an alive
 * child whose kill failed was reported `cause: 'gateway-shutdown'` while it was still
 * serving. A pre-kill sample answers "was it alive"; the report asserts "we killed it".
 *
 * The fix is not to sample again: it is that the claim is no longer DERIVABLE before the
 * act. The pre-kill record says `alive-when-reached`, which attributes nothing, and only
 * `confirmShutdownKill` — after `kill()` returns — promotes it.
 */
describe('a kill that throws never attributes a deploy (#518)', () => {
  /**
   * The working host, with ONE behaviour changed: its child refuses to die. Wrapping
   * rather than re-implementing, because a hand-rolled host has to reproduce the whole
   * channel handshake to get as far as the kill — and a fake that never finishes spawning
   * would pass this test for the wrong reason.
   */
  function makeUnkillableHost(): { host: PtyHost; messagesSeen: () => number } {
    const base = makeWedgeOnceHost()
    let killAttempted = false
    const host: PtyHost = {
      spawn(argv: string[], spawnOpts: Parameters<PtyHost['spawn']>[1]): PtyChild {
        const child = base.host.spawn(argv, spawnOpts)
        return {
          ...child,
          kill() {
            killAttempted = true
            throw new Error('EPERM: cannot signal this child')
          },
          // It is still running: the kill never landed.
          hasExited: () => false,
        }
      },
    }
    void killAttempted
    return { host, messagesSeen: base.messagesSeen }
  }

  it('an ALIVE child whose kill() throws is NOT reported as a deploy kill', async () => {
    // RED-mutation: derive the delivered cause from the pre-kill liveness sample again
    // (`report.liveness === 'alive' ? 'gateway-shutdown' : 'unknown'`). The sink then
    // receives `gateway-shutdown` for a child that is still running, which is the
    // production sink crashing a live build.
    const { host, messagesSeen } = makeUnkillableHost()
    const registryPath = join(mkdtempSync(join(tmpdir(), 'neutron-unkillable-')), 'repl-registry.json')
    const seen: Array<{ cause: string; detail: string }> = []
    const options = opts(host, {
      replRegistryPath: registryPath,
      onChildCrash: (info) => {
        seen.push({ cause: info.cause, detail: info.detail })
      },
    })
    registerSupervisedSubstrate(options)
    const sub = createPersistentReplSubstrate(options)
    await abandonFirstTurn(sub, messagesSeen)
    const key = Object.keys(loadRegistry(registryPath))[0] as string

    await captureStderr(() => shutdownAllPersistentRepls())

    // The child is still running, so nothing may claim we ended it.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.cause).not.toBe('gateway-shutdown')
    expect(seen[0]?.cause).toBe('unknown')
    expect(seen[0]?.detail).toContain('COULD NOT TERMINATE')
    expect(seen[0]?.detail).toContain('UNDETERMINED')

    // And no excuse on disk either: the durable record stops at what was established.
    const row = loadRegistry(registryPath)[key]
    expect(wasKilledByGatewayShutdown(row)).toBe(false)
    expect(observationOf(gatewayShutdownKillEntryFor(row, row?.child_generation as string))).toBe('alive-when-reached')
  }, 20_000)

  it('THE COMPLEMENT — a kill that SUCCEEDS still attributes the deploy', async () => {
    // Without this, "never attribute" would pass the case above and delete the feature.
    // RED-mutation: make `confirmShutdownKill` never promote.
    const { host, messagesSeen, childAlive } = makeWedgeOnceHost()
    const registryPath = join(mkdtempSync(join(tmpdir(), 'neutron-killable-')), 'repl-registry.json')
    const seen: string[] = []
    const options = opts(host, {
      replRegistryPath: registryPath,
      onChildCrash: (info) => {
        seen.push(info.cause)
      },
    })
    registerSupervisedSubstrate(options)
    const sub = createPersistentReplSubstrate(options)
    await abandonFirstTurn(sub, messagesSeen)
    const key = Object.keys(loadRegistry(registryPath))[0] as string

    await captureStderr(() => shutdownAllPersistentRepls())

    expect(childAlive(1)).toBe(false)
    expect(seen).toEqual(['gateway-shutdown'])
    expect(wasKilledByGatewayShutdown(loadRegistry(registryPath)[key])).toBe(true)
  })
})
