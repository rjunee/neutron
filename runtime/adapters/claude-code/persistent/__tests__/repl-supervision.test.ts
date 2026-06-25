/**
 * repl-supervision.test.ts — the LIVE Sprint-2 supervision wiring, exercised
 * end-to-end against the real `PersistentReplSubstrate` with a fake PtyHost +
 * real reply-sink + real persisted registry. Covers four of the five §6
 * acceptance scenarios (heartbeat is `heartbeat-watchdog.test.ts`):
 *
 *   #1 Wedge detected + respawn — a warm REPL whose dev-channel /health is dead
 *      → the watchdog tick fires a --resume respawn.
 *   #2 Crash + respawn — a mid-turn child.exited fails the turn retryably (S1
 *      preserved) AND the next start() re-spawns with --resume + the SAME
 *      sessionId (closes the S1 context-loss gap).
 *   #3 Registry-lock / in-flight gate prevents double-spawn — two respawn calls
 *      for one key → exactly ONE spawn fires.
 *   #4 Resume re-attaches — the respawned REPL's argv carries --resume + the
 *      preserved sessionId (NOT a fresh --session-id).
 *
 * "WIRED LIVE not stub" (brief § 9 #1): every assertion checks an OBSERVABLE —
 * spawn count, the actual argv flags, the registry on disk — not just that a
 * tick ran.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentSpec } from '../../../../substrate.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { Event } from '../../../../events.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import {
  createPersistentReplSubstrate,
  drainPendingRespawns,
  getReplRegistrySnapshot,
  getReplSinkInfo,
  httpHealth,
  registerSupervisedSubstrate,
  respawnReplSession,
  respawnSupervisedSession,
  runCwdDriftWatchdogTick,
  runReplWatchdogTick,
  shutdownAllPersistentRepls,
  startReplWatchdog,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import {
  clearPendingRespawns,
  enqueuePendingRespawn,
  loadPendingRespawns,
} from '../pending-respawns-queue.ts'
import { getRecord, patchRecord } from '../repl-registry.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

interface SpawnRecord {
  sessionId: string
  isResume: boolean
}

function parseSpawn(argv: string[]): SpawnRecord {
  const r = argv.indexOf('--resume')
  if (r >= 0 && argv[r + 1] !== undefined) return { sessionId: argv[r + 1] as string, isResume: true }
  const s = argv.indexOf('--session-id')
  if (s >= 0 && argv[s + 1] !== undefined) return { sessionId: argv[s + 1] as string, isResume: false }
  throw new Error('no session id in argv')
}

/** Fake PtyHost: records every spawn's argv, serves a real loopback dev-channel,
 *  and supports a __DIE__ sentinel to crash mid-turn. The __DIE__ trip is
 *  ONE-SHOT (`dieArmed`): the first inbound carrying it crashes the REPL, then it
 *  disarms so a REPLAY of that same dropped inbound (pending-respawns queue)
 *  succeeds instead of re-crashing. `delivered` records every inbound the live
 *  REPL actually processed (post-resume replays land here too). */
function makeFakeReplHost(): {
  host: PtyHost
  spawns: SpawnRecord[]
  lastChild: () => PtyChild | undefined
  children: PtyChild[]
  /** For each spawn index, whether the PREVIOUS child had already exited at the
   *  moment this spawn fired — proves kill-before-spawn ordering (Argus r3). */
  prevExitedAtSpawn: boolean[]
  delivered: string[]
} {
  const spawns: SpawnRecord[] = []
  let last: PtyChild | undefined
  const children: PtyChild[] = []
  const prevExitedAtSpawn: boolean[] = []
  let dieArmed = true
  const delivered: string[] = []
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      const rec = parseSpawn(argv)
      // Snapshot the prior child's liveness BEFORE this spawn is wired up.
      prevExitedAtSpawn.push(last?.hasExited() ?? false)
      spawns.push(rec)
      const sid = rec.sessionId
      const pid = 200000 + spawns.length
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
            if (body.text.includes('__DIE_INJECT__')) {
              // The REPL dies WHILE the inbound is being injected: mark the child
              // exited and return a non-2xx so `injectMessage` throws into the
              // driver's inject-catch (the crash-during-injection path).
              hasExited = true
              exitResolve(143)
              return new Response('inject-crash', { status: 503 })
            }
            if (body.text.includes('__DIE__') && dieArmed) {
              dieArmed = false // one-shot: a replay of this inbound succeeds
              // The inject SUCCEEDS, then the REPL dies mid-turn (no reply) on
              // the next tick → the death is observed via `onDeath` (which marks
              // the turn `diedMidTurn`), not as an inject failure. This mirrors
              // the real "REPL crashed after accepting the inbound" semantic the
              // enqueue-on-crash path keys on.
              setTimeout(() => {
                hasExited = true
                try {
                  server.stop(true)
                } catch {
                  /* ignore */
                }
                exitResolve(143)
              }, 5)
              return Response.json({ status: 'accepted' })
            }
            delivered.push(body.text)
            // Echo turn_id like the real dev-channel so the substrate's turn-id
            // correlation accepts the reply (Argus r5 fix).
            void post('/reply', { session_id: sid, text: `echo:${body.text}`, turn_id: body.turn_id })
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })

      const child: PtyChild = {
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
      last = child
      children.push(child)
      return child
    },
  }
  return { host, spawns, lastChild: () => last, children, prevExitedAtSpawn, delivered }
}

let keyCounter = 0
function baseOptions(host: PtyHost, registryPath: string): PersistentReplSubstrateOptions {
  keyCounter += 1
  // A real cwd: the respawn actuation pre-checks cwd existence (rejects ghost
  // cwds with invalid-cwd) before re-spawning.
  const cwd = mkdtempSync(join(tmpdir(), `neutron-sup-cwd-${keyCounter}-`))
  return {
    substrate_instance_id: `instance-${keyCounter}-${Math.floor(performance.now())}`,
    cwd,
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    replRegistryPath: registryPath,
    jsonlExistsProbe: () => true, // pretend the transcript landed → has_session flips
  }
}

function spec(prompt: string): AgentSpec {
  return { prompt, tools: [], model_preference: ['claude-opus-4-7'] }
}

async function drain(handle: SessionHandle): Promise<{ text: string; events: Event[] }> {
  let text = ''
  const events: Event[] = []
  try {
    for await (const ev of handle.events) {
      events.push(ev)
      if (ev.kind === 'token') text += ev.text
      else if (ev.kind === 'completion') return { text, events }
      else if (ev.kind === 'error') return { text, events }
    }
  } catch {
    /* iterator ended */
  }
  return { text, events }
}

function tmpRegistry(): string {
  return join(mkdtempSync(join(tmpdir(), 'neutron-sup-')), 'repl-registry.json')
}

async function waitForHasSession(path: string, key: string, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (getReplRegistrySnapshot(path)[key]?.has_session === true) return true
    await Bun.sleep(15)
  }
  return false
}

/** Poll until at least `target` spawns have been recorded. The respawn actuation
 *  now AWAITS the wedged child's exit before launching the `--resume` replacement
 *  (Argus r3 BLOCKER 1), so the resume spawn lands a few ticks after the
 *  synchronous `respawnReplSession` / tick call returns. */
async function waitForSpawnCount(spawns: SpawnRecord[], target: number, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (spawns.length >= target) return true
    await Bun.sleep(10)
  }
  return spawns.length >= target
}

function onlyKey(path: string): string {
  const keys = Object.keys(getReplRegistrySnapshot(path))
  if (keys.length !== 1) throw new Error(`expected 1 registry key, got ${keys.length}`)
  return keys[0] as string
}

describe('S2 supervision — #2 crash + respawn re-attaches the same session', () => {
  it('after a mid-turn crash, the next start() --resumes the SAME sessionId', async () => {
    const { host, spawns } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    const sub = createPersistentReplSubstrate(opts)

    // Turn 1: fresh spawn (S1 — --session-id, resume:false).
    await drain(sub.start(spec('hello')))
    expect(spawns.length).toBe(1)
    expect(spawns[0]?.isResume).toBe(false)
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)
    const originalSessionId = spawns[0]?.sessionId

    // Turn 2: crash mid-turn → retryable error, pool evicted (S1 behavior).
    const crash = await drain(sub.start(spec('please __DIE__')))
    const err = crash.events.find((e) => e.kind === 'error')
    expect(err).toBeDefined()
    if (err && err.kind === 'error') expect(err.retryable).toBe(true)
    expect(spawns.length).toBe(1) // crash reused the warm REPL; no new spawn

    // Turn 3: the next start() must RESUME the captured session, not cold-spawn.
    await drain(sub.start(spec('are you still there?')))
    expect(spawns.length).toBe(2)
    expect(spawns[1]?.isResume).toBe(true)
    expect(spawns[1]?.sessionId).toBe(originalSessionId as string)
  })
})

describe('S2 supervision — #1 watchdog tick respawns a wedged (health-dead) REPL', () => {
  it('a warm REPL with dead /health is respawned with --resume by the tick', async () => {
    const { host, spawns } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    registerSupervisedSubstrate(opts) // selector registers before the watchdog runs
    const sub = createPersistentReplSubstrate(opts)

    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)
    const originalSessionId = spawns[0]?.sessionId

    const alerts: string[] = []
    // /health dead + clock past the 60s boot-grace → detect no-port-listener →
    // respawn-and-alert.
    const results = await runReplWatchdogTick(opts, {
      healthProbe: async () => false,
      now: () => Date.now() + 120_000,
      postAlert: (t) => alerts.push(t),
    })

    const r = results.find((x) => x.sessionKey === key)
    expect(r?.action).toBe('respawn-and-alert')
    expect(r?.respawned).toBe(true)
    expect(alerts.length).toBe(1)
    // The respawn re-attached the captured session (the resume spawn lands after
    // the wedged child's awaited exit — Argus r3 BLOCKER 1).
    expect(await waitForSpawnCount(spawns, 2)).toBe(true)
    expect(spawns.length).toBe(2)
    expect(spawns[1]?.isResume).toBe(true)
    expect(spawns[1]?.sessionId).toBe(originalSessionId as string)
  })

  it('inside the boot-grace window the tick ignores (no premature respawn)', async () => {
    const { host, spawns } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    const sub = createPersistentReplSubstrate(opts)
    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    await waitForHasSession(registryPath, key)

    const results = await runReplWatchdogTick(opts, {
      healthProbe: async () => false,
      now: () => Date.now(), // within grace of first_ready_at
    })
    expect(results.find((x) => x.sessionKey === key)?.action).toBe('boot-window')
    expect(spawns.length).toBe(1) // untouched
  })

  it('an alive-but-wedged respawn KILLS the old child before the --resume spawn (one owner per transcript)', async () => {
    // Argus r3 BLOCKER 1: in the alive-but-wedged case the pool still holds the
    // old child handle. The respawn must terminate it AND await its exit before
    // launching the `--resume` replacement, so two processes never co-own one
    // session transcript.
    const { host, spawns, children, prevExitedAtSpawn } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    registerSupervisedSubstrate(opts)
    const sub = createPersistentReplSubstrate(opts)

    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)
    const oldChild = children[0]
    expect(oldChild).toBeDefined()
    expect(oldChild?.hasExited()).toBe(false) // ALIVE — not a crash; a wedge

    // /health dead + past boot-grace → wedge → respawn-and-alert.
    const results = await runReplWatchdogTick(opts, {
      healthProbe: async () => false,
      now: () => Date.now() + 120_000,
      postAlert: () => {},
    })
    expect(results.find((x) => x.sessionKey === key)?.action).toBe('respawn-and-alert')

    // The resume spawn lands only AFTER the old child's awaited exit.
    expect(await waitForSpawnCount(spawns, 2)).toBe(true)
    expect(spawns[1]?.isResume).toBe(true)

    // Ordering proof: at the moment spawn #1 (the resume) fired, the previous
    // (old) child had ALREADY exited.
    expect(prevExitedAtSpawn[1]).toBe(true)

    // The old child is terminated; exactly one live child remains (the new one).
    expect(oldChild?.hasExited()).toBe(true)
    const live = children.filter((c) => !c.hasExited())
    expect(live.length).toBe(1)
    expect(live[0]).toBe(children[1] as PtyChild)
    expect(children[1]?.pid).not.toBe(oldChild?.pid)
  })
})

describe('S2 supervision — #12 cwd-drift watchdog respawns a child pinned to canonical', () => {
  it('a child whose live cwd drifted off canonical is respawned with --resume', async () => {
    const { host, spawns } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    registerSupervisedSubstrate(opts)
    const sub = createPersistentReplSubstrate(opts)

    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)
    const originalSessionId = spawns[0]?.sessionId

    const alerts: string[] = []
    // lsof reports the child rooted in an unrelated dir (e.g. a since-merged
    // worktree); the canonical record.cwd still exists → respawn pinned back.
    const results = await runCwdDriftWatchdogTick(opts, {
      cwdDriftProbeCwd: async () => '/private/tmp/since-merged-worktree',
      cwdDriftCanonicalExists: () => true,
      postAlert: (t) => alerts.push(t),
    })
    const r = results.find((x) => x.sessionKey === key)
    expect(r?.action).toBe('respawn')
    expect(r?.respawned).toBe(true)
    expect(alerts).toEqual([]) // a respawn (not the missing-canonical alert)

    // The respawn re-attached the SAME captured session, spawned from canonical.
    expect(await waitForSpawnCount(spawns, 2)).toBe(true)
    expect(spawns.length).toBe(2)
    expect(spawns[1]?.isResume).toBe(true)
    expect(spawns[1]?.sessionId).toBe(originalSessionId as string)
  })

  it('a child whose live cwd matches canonical (descendant) is left alone', async () => {
    const { host, spawns } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    registerSupervisedSubstrate(opts)
    const sub = createPersistentReplSubstrate(opts)

    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)
    const canonicalCwd = getReplRegistrySnapshot(registryPath)[key]?.cwd as string

    const results = await runCwdDriftWatchdogTick(opts, {
      cwdDriftProbeCwd: async () => `${canonicalCwd}/src`, // descendant — tolerated
    })
    expect(results.find((x) => x.sessionKey === key)?.action).toBe('not-drifted')
    expect(spawns.length).toBe(1) // untouched
  })

  it('drift BUT canonical missing on disk → NO respawn, alert fired', async () => {
    const { host, spawns } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    registerSupervisedSubstrate(opts)
    const sub = createPersistentReplSubstrate(opts)

    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)

    const alerts: string[] = []
    const results = await runCwdDriftWatchdogTick(opts, {
      cwdDriftProbeCwd: async () => '/private/tmp/since-merged-worktree',
      cwdDriftCanonicalExists: () => false, // canonical gone → respawn into nothing
      postAlert: (t) => alerts.push(t),
    })
    expect(results.find((x) => x.sessionKey === key)?.action).toBe('alert-missing-canonical')
    expect(alerts.length).toBe(1)
    expect(spawns.length).toBe(1) // NEVER respawned
  })

  it('a second drift within the 1h throttle does not re-respawn', async () => {
    const { host, spawns } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    registerSupervisedSubstrate(opts)
    const sub = createPersistentReplSubstrate(opts)

    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)

    const probe = { cwdDriftProbeCwd: async () => '/private/tmp/drifted', cwdDriftCanonicalExists: () => true }
    const first = await runCwdDriftWatchdogTick(opts, probe)
    expect(first.find((x) => x.sessionKey === key)?.action).toBe('respawn')
    expect(await waitForSpawnCount(spawns, 2)).toBe(true)

    // Second tick, still drifted, inside the 1h throttle → throttled, no 3rd spawn.
    const second = await runCwdDriftWatchdogTick(opts, probe)
    expect(second.find((x) => x.sessionKey === key)?.action).toBe('throttled')
    await Bun.sleep(50)
    expect(spawns.length).toBe(2)
  })
})

describe('S2 supervision — #3 no double-spawn under concurrent respawn', () => {
  it('two respawn calls for one key fire exactly ONE spawn (in-flight guard)', async () => {
    const { host, spawns } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    const sub = createPersistentReplSubstrate(opts)
    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)
    const baseline = spawns.length

    const first = respawnReplSession(opts, key, 'wedge-watchdog', 'health-dead')
    const second = respawnReplSession(opts, key, 'wedge-watchdog', 'health-dead')

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false) // the in-flight stamp blocks the second
    // Exactly ONE respawn fires: wait for it to land, then settle to prove the
    // refused second never spawns a phantom.
    expect(await waitForSpawnCount(spawns, baseline + 1)).toBe(true)
    await Bun.sleep(60)
    expect(spawns.length - baseline).toBe(1)
  })
})

describe('S2 supervision — in-flight stamp lifecycle (Codex P2-3 / P2-4 regressions)', () => {
  it('clears the in-flight stamp once the resumed REPL is confirmed alive', async () => {
    const { host } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    const sub = createPersistentReplSubstrate(opts)
    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)

    const out = respawnReplSession(opts, key, 'wedge-watchdog', 'x')
    expect(out.ok).toBe(true)
    // The resume spawn completes asynchronously; once it writes its fresh record
    // the transient respawn_in_flight_at stamp must be GONE (else the next tick
    // would see a phantom "respawn in progress" and only alert).
    const start = Date.now()
    let cleared = false
    while (Date.now() - start < 2000) {
      if (getReplRegistrySnapshot(registryPath)[key]?.respawn_in_flight_at === undefined) {
        cleared = true
        break
      }
      await Bun.sleep(15)
    }
    expect(cleared).toBe(true)
  })

  it('a ghost cwd refuses with spawn-cwd-invalid and does NOT latch in-flight', async () => {
    const { host, spawns } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    const sub = createPersistentReplSubstrate(opts)
    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)
    const baseline = spawns.length

    // The cwd vanishes (ghost-cwd) → the respawn must refuse honestly, not
    // report success, and must not leave a latched in-flight stamp.
    rmSync(opts.cwd as string, { recursive: true, force: true })
    const out = respawnReplSession(opts, key, 'wedge-watchdog', 'x')
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('spawn-cwd-invalid')
    expect(spawns.length).toBe(baseline) // no spawn fired
    expect(getReplRegistrySnapshot(registryPath)[key]?.respawn_in_flight_at).toBeUndefined()
  })
})

/** Pending-respawns queue path alongside a registry path. */
function pendingPathFor(registryPath: string): string {
  return join(dirname(registryPath), '.pending-respawns.json')
}

async function waitForQueueEntry(path: string, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const loaded = loadPendingRespawns(path)
    if (loaded.kind === 'loaded' && loaded.entries.length > 0) return true
    await Bun.sleep(15)
  }
  return false
}

describe('S2 supervision — pending-respawns: inbound dropped during the respawn gap is queued + replayed', () => {
  it('a mid-turn crash enqueues the dropped inbound, then the drain replays it via /message after resume', async () => {
    const { host, spawns, delivered } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const pendingRespawnsPath = pendingPathFor(registryPath)
    const opts: PersistentReplSubstrateOptions = { ...baseOptions(host, registryPath), pendingRespawnsPath }
    registerSupervisedSubstrate(opts) // selector registers before any drain
    const sub = createPersistentReplSubstrate(opts)

    // Turn 1: fresh spawn; the session becomes resumable.
    await drain(sub.start(spec('seed')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)
    expect(spawns.length).toBe(1)

    // Turn 2: the REPL dies mid-turn while processing an inbound. The caller
    // only sees a retryable error; the inbound is DROPPED — and must be enqueued
    // for replay-after-resume (the §6 acceptance #1 replay clause).
    const droppedInbound = 'please remember this __DIE__'
    const crash = await drain(sub.start(spec(droppedInbound)))
    expect(crash.events.find((e) => e.kind === 'error')?.kind).toBe('error')

    // Enqueue-on-crash happened (the driver records it after the turn settles).
    expect(await waitForQueueEntry(pendingRespawnsPath)).toBe(true)
    const queued = loadPendingRespawns(pendingRespawnsPath)
    expect(queued.kind).toBe('loaded')
    if (queued.kind === 'loaded') {
      expect(queued.entries).toHaveLength(1)
      expect(queued.entries[0]?.sessionKey).toBe(key)
      expect(queued.entries[0]?.droppedInbound).toBe(droppedInbound)
    }
    const spawnsBeforeReplay = spawns.length
    const deliveredBeforeReplay = delivered.length

    // Drain (what the watchdog tick + boot both call): replays each queued
    // inbound after resuming the session. No stagger for the test.
    const results = await drainPendingRespawns(opts, { baseDelayMs: 0, sleep: async () => {} })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ sessionKey: key, replayed: true })

    // OBSERVABLES (wired-live, not stub): the queue is now empty (single-shot
    // claim), the replay --resumed the captured session, and the dropped inbound
    // was actually re-delivered through the dev-channel /message path.
    expect(loadPendingRespawns(pendingRespawnsPath).kind).toBe('absent')
    expect(spawns.length).toBe(spawnsBeforeReplay + 1)
    expect(spawns[spawns.length - 1]?.isResume).toBe(true)
    expect(delivered.length).toBe(deliveredBeforeReplay + 1)
    expect(delivered[delivered.length - 1]).toBe(droppedInbound)
  })
})

describe('S2 supervision — pending-respawns: replay targets the entry session, not the drain options (Codex P2)', () => {
  it('a dropped inbound for substrate A replays into A even when drained via substrate B', async () => {
    // One instance registry + one shared pending queue, two substrates (A, B) with
    // distinct identities — the real prod shape (cc-llm-* / cc-import-* share the
    // instance home). The watchdog drains with ONE options bag (B's); the replay
    // must still resume A's session, not deliver A's inbound into B's REPL.
    const { host, spawns, delivered } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const pendingRespawnsPath = pendingPathFor(registryPath)
    const optsA: PersistentReplSubstrateOptions = { ...baseOptions(host, registryPath), pendingRespawnsPath }
    const optsB: PersistentReplSubstrateOptions = { ...baseOptions(host, registryPath), pendingRespawnsPath }
    // Both substrates register (as the selector does) so the drain can resolve
    // the OWNING substrate's options by pool key.
    registerSupervisedSubstrate(optsA)
    registerSupervisedSubstrate(optsB)
    const subA = createPersistentReplSubstrate(optsA)
    const subB = createPersistentReplSubstrate(optsB)

    // Warm both; capture each session's captured UUID.
    await drain(subA.start(spec('seed-A')))
    await drain(subB.start(spec('seed-B')))
    const keys = Object.keys(getReplRegistrySnapshot(registryPath))
    expect(keys).toHaveLength(2)
    // The pool key joins instance-id + cwd with a NUL separator (see
    // SESSION_KEY_SEP in the substrate); the only registry key for substrate A.
    const keyA = Object.keys(getReplRegistrySnapshot(registryPath)).find((k) =>
      k.startsWith(optsA.substrate_instance_id) && k.endsWith(optsA.cwd as string),
    ) as string
    expect(keyA).toBeDefined()
    expect(await waitForHasSession(registryPath, keyA)).toBe(true)
    const sidA = getRecord(registryPath, keyA)?.sessionId
    expect(sidA).toBeDefined()

    // A dies mid-turn → its inbound is enqueued (shared queue) + A's pool evicted.
    const droppedForA = 'remember this for A __DIE__'
    await drain(subA.start(spec(droppedForA)))
    expect(await waitForQueueEntry(pendingRespawnsPath)).toBe(true)
    const spawnsBefore = spawns.length
    const deliveredBefore = delivered.length

    // Drain via B's options (the watchdog owner) — the regression path.
    const results = await drainPendingRespawns(optsB, { baseDelayMs: 0, sleep: async () => {} })
    expect(results).toEqual([{ sessionKey: keyA, replayed: true }])

    // The replay resumed A's captured session (NOT B's), and re-delivered A's
    // inbound. With the bug the spawn would carry B's sessionId.
    expect(spawns.length).toBe(spawnsBefore + 1)
    const replaySpawn = spawns[spawns.length - 1]
    expect(replaySpawn?.isResume).toBe(true)
    expect(replaySpawn?.sessionId).toBe(sidA as string)
    expect(delivered.length).toBe(deliveredBefore + 1)
    expect(delivered[delivered.length - 1]).toBe(droppedForA)
  })
})

describe('S2 supervision — pending-respawns: a crash DURING injection still enqueues the dropped inbound (Codex P2)', () => {
  it('the inject-time-crash path enqueues for replay, not just a retryable error', async () => {
    const { host } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const pendingRespawnsPath = pendingPathFor(registryPath)
    const opts: PersistentReplSubstrateOptions = { ...baseOptions(host, registryPath), pendingRespawnsPath }
    registerSupervisedSubstrate(opts)
    const sub = createPersistentReplSubstrate(opts)
    await drain(sub.start(spec('seed')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)

    // Turn 2: the REPL dies WHILE the inbound is being injected → injectMessage
    // throws → the driver's inject-catch must still enqueue the dropped inbound.
    const dropped = 'lost mid-inject __DIE_INJECT__'
    const r = await drain(sub.start(spec(dropped)))
    expect(r.events.find((e) => e.kind === 'error')?.kind).toBe('error')
    expect(await waitForQueueEntry(pendingRespawnsPath)).toBe(true)
    const q = loadPendingRespawns(pendingRespawnsPath)
    expect(q.kind).toBe('loaded')
    if (q.kind === 'loaded') {
      expect(q.entries).toHaveLength(1)
      expect(q.entries[0]?.droppedInbound).toBe(dropped)
    }
  })
})

describe('S2 supervision — watchdog tick is scoped to its instance registry (Codex P2)', () => {
  it("instance A's tick does not scan or respawn instance B's pooled session", async () => {
    const a = makeFakeReplHost()
    const b = makeFakeReplHost()
    const regA = tmpRegistry()
    const regB = tmpRegistry()
    const optsA = baseOptions(a.host, regA)
    const optsB = baseOptions(b.host, regB)
    registerSupervisedSubstrate(optsA)
    registerSupervisedSubstrate(optsB)
    const subA = createPersistentReplSubstrate(optsA)
    const subB = createPersistentReplSubstrate(optsB)
    await drain(subA.start(spec('a')))
    await drain(subB.start(spec('b')))
    const keyB = onlyKey(regB)
    expect(await waitForHasSession(regB, keyB)).toBe(true)
    const bSpawnsBefore = b.spawns.length

    // A's tick with an all-dead probe + clock past boot-grace WOULD respawn any
    // wedged key it SCANS. It must not scan B's pooled (other-registry) key.
    const results = await runReplWatchdogTick(optsA, {
      healthProbe: async () => false,
      now: () => Date.now() + 120_000,
    })
    expect(results.find((x) => x.sessionKey === keyB)).toBeUndefined()
    expect(b.spawns.length).toBe(bSpawnsBefore) // B untouched
  })
})

describe('S2 supervision — pending-respawns: an unregistered owner is skipped + retained, not replayed with fallback opts (Codex P2)', () => {
  it('an entry whose owning substrate has not re-registered is skipped and left on disk', async () => {
    const { host } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const pendingRespawnsPath = pendingPathFor(registryPath)
    const opts: PersistentReplSubstrateOptions = { ...baseOptions(host, registryPath), pendingRespawnsPath }
    // A queued entry for a DIFFERENT substrate identity that is NOT registered
    // (the cross-restart-before-first-turn case). `opts` is also unregistered.
    const ghostKey = `cc-import-ghost\0/tmp/ghost-cwd`
    enqueuePendingRespawn(pendingRespawnsPath, {
      sessionKey: ghostKey,
      sessionId: 'sid-ghost',
      cwd: '/tmp/ghost-cwd',
      substrate_instance_id: 'cc-import-ghost',
      droppedInbound: 'recover me later',
    })
    const results = await drainPendingRespawns(opts, { baseDelayMs: 0, sleep: async () => {} })
    // Skipped (never respawned with the drain's own env), and retained on disk.
    expect(results).toEqual([{ sessionKey: ghostKey, replayed: false, skipped: 'unregistered' }])
    const after = loadPendingRespawns(pendingRespawnsPath)
    expect(after.kind).toBe('loaded')
    if (after.kind === 'loaded') {
      expect(after.entries).toHaveLength(1)
      expect(after.entries[0]?.sessionKey).toBe(ghostKey)
    }
  })
})

describe('S2 supervision — pending-respawns: overlapping drains do not double-replay an entry (Codex P2)', () => {
  it('an entry claimed by a concurrent drain is re-checked and skipped, not replayed twice', async () => {
    const { host } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const pendingRespawnsPath = pendingPathFor(registryPath)
    const opts: PersistentReplSubstrateOptions = { ...baseOptions(host, registryPath), pendingRespawnsPath }
    registerSupervisedSubstrate(opts) // owner registered so the entry passes the unregistered gate
    const ownerKey = `${opts.substrate_instance_id}\0${opts.cwd}`
    enqueuePendingRespawn(pendingRespawnsPath, {
      sessionKey: ownerKey,
      sessionId: 'sid-x',
      cwd: opts.cwd as string,
      substrate_instance_id: opts.substrate_instance_id,
      droppedInbound: 'do not replay me twice',
    })
    // Simulate a CONCURRENT drain claiming the entry during this drain's stagger
    // sleep (the boot-drain-vs-tick overlap). The re-check after the sleep must
    // see the entry gone and skip the replay rather than re-process it.
    const results = await drainPendingRespawns(opts, {
      baseDelayMs: 1,
      sleep: async () => {
        clearPendingRespawns(pendingRespawnsPath)
      },
    })
    expect(results).toEqual([{ sessionKey: ownerKey, replayed: false, skipped: 'already-drained' }])
  })
})

describe('S2 supervision — pending-respawns: a same-key replacement enqueued mid-drain is not lost (Codex GPT-5 r4 BLOCKER)', () => {
  it('replays the CURRENT queued entry (newer inbound B), never the stale snapshot (A)', async () => {
    const { host, spawns, delivered } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const pendingRespawnsPath = pendingPathFor(registryPath)
    const opts: PersistentReplSubstrateOptions = { ...baseOptions(host, registryPath), pendingRespawnsPath }
    registerSupervisedSubstrate(opts)
    const sub = createPersistentReplSubstrate(opts)

    // Warm a session (so the key has a resumable session) then crash mid-turn so
    // entry A — the STALE snapshot the drain will plan from — is enqueued.
    await drain(sub.start(spec('seed')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)
    const inboundA = 'older inbound A __DIE__'
    await drain(sub.start(spec(inboundA)))
    expect(await waitForQueueEntry(pendingRespawnsPath)).toBe(true)
    const queuedA = loadPendingRespawns(pendingRespawnsPath)
    if (queuedA.kind === 'loaded') {
      expect(queuedA.entries[0]?.droppedInbound).toBe(inboundA)
    }
    const deliveredBefore = delivered.length
    const inboundB = 'NEWER inbound B — must survive'

    // During the stagger sleep a SECOND crash on the same REPL upserts a same-key
    // replacement B (enqueuePendingRespawn removes A, pushes B). The pre-fix drain
    // would replay the stale snapshot A AND removeEntryBySessionKey would delete B
    // — silently losing B's newer inbound. The fix replays the CURRENT entry (B).
    const results = await drainPendingRespawns(opts, {
      baseDelayMs: 1,
      sleep: async () => {
        enqueuePendingRespawn(pendingRespawnsPath, {
          sessionKey: key,
          sessionId: 'sid-b',
          cwd: opts.cwd as string,
          substrate_instance_id: opts.substrate_instance_id,
          droppedInbound: inboundB,
        })
      },
    })

    // B (the current queue entry) is replayed; A (the stale snapshot) is NOT, and
    // B is never dropped. The queue ends empty (B claimed + replayed once).
    expect(results).toEqual([{ sessionKey: key, replayed: true }])
    expect(delivered.length).toBe(deliveredBefore + 1)
    expect(delivered[delivered.length - 1]).toBe(inboundB)
    expect(delivered).not.toContain(inboundA)
    expect(loadPendingRespawns(pendingRespawnsPath).kind).toBe('absent')
  })
})

describe('S2 supervision — health probe has a deadline (Codex P2)', () => {
  it('a dev-channel that accepts but never answers /health resolves false within the timeout', async () => {
    // A wedged dev-channel: connection accepted, /health never responds. Without
    // a probe deadline this would hang the watchdog tick (it awaits the probe
    // under the global tick gate). With the deadline it resolves false → the tick
    // treats it as health-dead and proceeds to respawn.
    let hang: ((v: Response) => void) | undefined
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Promise<Response>((res) => { hang = res }), // never resolves
    })
    try {
      const start = Date.now()
      const ok = await httpHealth(server.port as number, { timeoutMs: 150 })
      const elapsed = Date.now() - start
      expect(ok).toBe(false)
      expect(elapsed).toBeLessThan(2000) // bounded by the deadline, not hung
    } finally {
      hang?.(new Response('late'))
      server.stop(true)
    }
  })

  it('a healthy /health resolves true', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ ok: true, session_id: 'sid-1' }),
    })
    try {
      expect(await httpHealth(server.port as number, { timeoutMs: 1000 })).toBe(true)
      // Identity match passes.
      expect(
        await httpHealth(server.port as number, { expectedSessionId: 'sid-1', timeoutMs: 1000 }),
      ).toBe(true)
      // Port-recycle guard: a DIFFERENT session id on this port reads as unhealthy.
      expect(
        await httpHealth(server.port as number, { expectedSessionId: 'sid-OTHER', timeoutMs: 1000 }),
      ).toBe(false)
    } finally {
      server.stop(true)
    }
  })
})

describe('S2 supervision — watchdog timers are stopped on shutdown + start is idempotent (Codex P2)', () => {
  it('shutdownAllPersistentRepls clears the interval; a second start does not arm a second timer', async () => {
    const { host } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    let armed = 0
    let cleared = 0
    const di = {
      intervalMs: 10_000,
      setIntervalFn: () => { armed += 1; return `h${armed}` },
      clearIntervalFn: () => { cleared += 1 },
    }
    const wd = startReplWatchdog(opts, di)
    // Two timers per start: the wedge/crash tick + the cwd-drift tick.
    expect(armed).toBe(2)
    // Idempotent per registry: returns the live handle, no second pair of intervals.
    const wd2 = startReplWatchdog(opts, di)
    expect(wd2).toBe(wd)
    expect(armed).toBe(2)
    // Shutdown stops BOTH timers exactly once (no leak).
    await shutdownAllPersistentRepls()
    expect(cleared).toBe(2)
    // After shutdown the registry is free to re-arm (post-restart cleanliness).
    startReplWatchdog(opts, di)
    expect(armed).toBe(4)
  })
})

describe('S2 supervision — operator respawn uses the OWNING substrate options, not last-registered (Codex P2)', () => {
  it('respawning session A actuates on A\'s substrate even when B registered last under the same registry', async () => {
    // Two substrates share ONE instance registry but have distinct identities +
    // distinct PtyHosts (the real shape: cc-llm-* and cc-import-* differ). Keying
    // supervised options by registry path alone would force-respawn A using B's
    // options (last-write-wins) → spawn on the WRONG host. Keying by session key
    // routes the respawn to A's own host.
    const a = makeFakeReplHost()
    const b = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const optsA = baseOptions(a.host, registryPath)
    const optsB = baseOptions(b.host, registryPath)
    const subA = createPersistentReplSubstrate(optsA)
    const subB = createPersistentReplSubstrate(optsB)
    await drain(subA.start(spec('hi-A')))
    await drain(subB.start(spec('hi-B')))
    const keyA = `${optsA.substrate_instance_id}\0${optsA.cwd}`
    const keyB = `${optsB.substrate_instance_id}\0${optsB.cwd}`
    expect(await waitForHasSession(registryPath, keyA)).toBe(true)
    expect(await waitForHasSession(registryPath, keyB)).toBe(true)

    // Register A first, B last (B would win under per-registry keying).
    registerSupervisedSubstrate(optsA)
    registerSupervisedSubstrate(optsB)
    patchRecord(registryPath, keyA, { capped_at: Date.now() })
    const aSpawnsBefore = a.spawns.length
    const bSpawnsBefore = b.spawns.length

    const out = respawnSupervisedSession(registryPath, keyA)
    expect(out.ok).toBe(true)
    // The respawn fired on A's host (A owns keyA), NOT on B's.
    expect(await waitForSpawnCount(a.spawns, aSpawnsBefore + 1)).toBe(true)
    await Bun.sleep(60)
    expect(a.spawns.length).toBe(aSpawnsBefore + 1)
    expect(b.spawns.length).toBe(bSpawnsBefore)
  })

  it('a session is not recoverable via a different instance registry path', async () => {
    const { host } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    registerSupervisedSubstrate(opts)
    const sub = createPersistentReplSubstrate(opts)
    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)
    // Right key, WRONG registry path → scoped out (session-not-found).
    const out = respawnSupervisedSession('/some/other/instance/repl-registry.json', key)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('session-not-found')
  })
})

describe('S2 supervision — operator force path (admin endpoint) clears capped_at + is double-spawn-safe', () => {
  it('respawnSupervisedSession force-recovers a hard-capped REPL and clears capped_at', async () => {
    const { host, spawns } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    // Register the live substrate exactly as the runtime selector does, so the
    // operator endpoint can resolve it by registry path (boot has only the path).
    registerSupervisedSubstrate(opts)
    const sub = createPersistentReplSubstrate(opts)
    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)

    // Auto-watchdog gave up: the record is hard-capped. The ONLY release path is
    // the operator force respawn (admin endpoint → respawnSupervisedSession).
    patchRecord(registryPath, key, { capped_at: Date.now() })
    expect(getRecord(registryPath, key)?.capped_at).toBeDefined()
    const baseline = spawns.length

    const out = respawnSupervisedSession(registryPath, key)
    expect(out.ok).toBe(true)
    expect(await waitForSpawnCount(spawns, baseline + 1)).toBe(true) // the force respawn fired
    expect(spawns.length).toBe(baseline + 1)
    expect(spawns[spawns.length - 1]?.isResume).toBe(true)
    expect(getRecord(registryPath, key)?.capped_at).toBeUndefined() // cap cleared
  })

  it('two rapid operator force requests spawn EXACTLY ONCE (force honors the in-flight gate)', async () => {
    const { host, spawns } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    const opts = baseOptions(host, registryPath)
    registerSupervisedSubstrate(opts)
    const sub = createPersistentReplSubstrate(opts)
    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)
    patchRecord(registryPath, key, { capped_at: Date.now() })
    const baseline = spawns.length

    // Two back-to-back force requests (the operator double-tap). force clears the
    // cap/cooldown but must STILL honor the in-flight serialization — acceptance
    // #3 "exactly ONE spawn per sessionKey" on the operator path (Argus r1
    // IMPORTANT #3 / Codex P2).
    const first = respawnSupervisedSession(registryPath, key)
    const second = respawnSupervisedSession(registryPath, key)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    // Exactly ONE spawn: wait for it, then settle to prove no phantom second.
    expect(await waitForSpawnCount(spawns, baseline + 1)).toBe(true)
    await Bun.sleep(60)
    expect(spawns.length - baseline).toBe(1)
  })

  it('returns session-not-found when no supervised substrate is registered for the path', () => {
    const out = respawnSupervisedSession('/no/such/registry.json', 'ghost-key')
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('session-not-found')
  })
})

describe('S2 supervision — #4 respawn refuses when there is no resumable session', () => {
  it('a record with has_session=false refuses with no-session-to-resume (never fresh-spawns)', async () => {
    const { host, spawns } = makeFakeReplHost()
    const registryPath = tmpRegistry()
    // Disable the JSONL gate so has_session NEVER flips true.
    const opts = { ...baseOptions(host, registryPath), jsonlExistsProbe: () => false }
    const sub = createPersistentReplSubstrate(opts)
    await drain(sub.start(spec('hi')))
    const key = onlyKey(registryPath)
    // has_session stays false → resume must be refused, not silently fresh-spawned.
    expect(getReplRegistrySnapshot(registryPath)[key]?.has_session).toBe(false)
    const baseline = spawns.length
    const outcome = respawnReplSession(opts, key, 'admin-endpoint', 'manual', true)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('no-session-to-resume')
    expect(spawns.length).toBe(baseline) // NO fresh spawn happened
  })
})

describe('S2 supervision — cross-incarnation turnId collision (Argus r6)', () => {
  it('a straggler tagged with a KILLED incarnation’s turn-id does not complete the resumed incarnation’s turn', async () => {
    // `turnSeq` RESETS per `ReplSession`, but a resume re-attaches the SAME
    // sessionId. Incarnation A's first turn and incarnation B's first turn both
    // get seq=1; the per-incarnation nonce in the turn-id (`<nonce>:<seq>`) is
    // what stops a straggler from A (still tagged A's id) from completing B's
    // turn. Without the nonce both ids would be a bare `1` and the straggler
    // would be misattributed — the exact dropped/cross-wired-reply class.
    const registryPath = tmpRegistry()
    let sinkPort = 0
    let token = ''
    let sid = ''
    let spawnIndex = 0
    let turnIdA: string | undefined
    const post = (path: string, body: unknown): Promise<unknown> =>
      fetch(`http://127.0.0.1:${sinkPort}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
        body: JSON.stringify(body),
      }).catch(() => undefined)

    const children: PtyChild[] = []
    const host: PtyHost = {
      spawn(argv) {
        const rec = parseSpawn(argv)
        sid = rec.sessionId
        spawnIndex += 1
        const myIndex = spawnIndex
        const info = getReplSinkInfo()
        sinkPort = info.port
        token = info.token
        let hasExited = false
        let exitResolve: (c: number | null) => void = () => {}
        const exited = new Promise<number | null>((r) => {
          exitResolve = r
        })
        const server = Bun.serve({
          port: 0,
          hostname: '127.0.0.1',
          async fetch(req) {
            const url = new URL(req.url)
            if (url.pathname === '/health') return Response.json({ ok: true })
            if (req.method === 'POST' && url.pathname === '/message') {
              const body = (await req.json()) as { text: string; turn_id?: string }
              if (myIndex === 1) {
                // Incarnation A: capture its turn-id, then reply normally.
                turnIdA = body.turn_id
                void post('/reply', { session_id: sid, text: `A:${body.text}`, turn_id: body.turn_id })
                return Response.json({ status: 'delivered' })
              }
              // Incarnation B (resume, same sessionId): a straggler from A lands
              // mid-inject, tagged with A's now-stale id — must be rejected by the
              // nonce. Awaited so the sink fully processes it before this inject
              // resolves; B's turn is active (injected) throughout.
              await post('/reply', { session_id: sid, text: 'STALE-FROM-INCARNATION-A', turn_id: turnIdA })
              // Then B's OWN reply — the only one that may complete the turn.
              void post('/reply', { session_id: sid, text: `B:${body.text}`, turn_id: body.turn_id })
              return Response.json({ status: 'delivered' })
            }
            return new Response('nf', { status: 404 })
          },
        })
        void post('/channel-ready', { session_id: sid, channel_port: server.port, pid: 300000 + myIndex })
        const child: PtyChild = {
          pid: 300000 + myIndex,
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
        children.push(child)
        return child
      },
    }

    const opts = baseOptions(host, registryPath)
    const sub = createPersistentReplSubstrate(opts)

    // Incarnation A: a clean turn, then confirm the session is resumable.
    const a = await drain(sub.start(spec('q1')))
    expect(a.text).toBe('A:q1')
    expect(turnIdA).toBeDefined()
    const key = onlyKey(registryPath)
    expect(await waitForHasSession(registryPath, key)).toBe(true)

    // Kill incarnation A → the pool evicts it; the next start() --resumes the
    // SAME sessionId as a fresh incarnation (new nonce, seq back to 1).
    children[0]?.kill()
    await children[0]?.exited

    // Incarnation B: its turn must complete with ITS OWN reply, never the
    // straggler tagged with incarnation A's stale turn-id.
    const b = await drain(sub.start(spec('q2')))
    expect(spawnIndex).toBe(2)
    expect(b.text).toBe('B:q2')
    expect(b.text).not.toContain('STALE')
  })
})
