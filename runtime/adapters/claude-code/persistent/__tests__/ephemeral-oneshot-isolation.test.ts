/**
 * ephemeral-oneshot-isolation.test.ts — Argus r4 BLOCKER regression.
 *
 * The S3 rip-replace made the persistent interactive REPL the sole substrate and
 * re-keyed its warm pool on (substrate_instance_id, user_id, project_id,
 * credential_identity) — with NO call-PURPOSE dimension. So the SEVEN+ stateless
 * one-shot utility callers that share ONE `cc-llm-*` substrate (scribe, phase-spec
 * resolver, agent-watcher, nudge, research, wow, the onboarding suggesters/persona/
 * seed composers) would collapse into ONE ever-growing Claude transcript per
 * (user, project, cred): cross-purpose semantic bleed (onboarding phase
 * correctness is a CLAUDE.md HARD RULE) + unbounded transcript growth.
 *
 * The `ephemeral` flag restores the pre-S3 "fresh `claude -p` per one-shot"
 * isolation on the persistent substrate: a session-less dispatch on an ephemeral
 * substrate runs on a FRESH disposable REPL that is TERMINATED after its single
 * turn — never pooled, never reused.
 *
 * Covers:
 *  - two distinct session-less one-shots on the SAME ephemeral substrate +
 *    identity do NOT share a transcript (each spawns a fresh REPL that sees only
 *    its own turn) AND each disposable REPL is terminated after its turn;
 *  - a dispatch carrying a real `spec.session` pools even on an ephemeral
 *    substrate (the conversational/multi-turn path keeps its warm REPL);
 *  - the default (non-ephemeral) substrate still warm-reuses across turns (the
 *    flag is opt-in; pre-existing pooling behavior is unchanged).
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentSpec } from '../../../../substrate.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { Event } from '../../../../events.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import {
  createPersistentReplSubstrate,
  drainPendingRespawns,
  getReplSinkInfo,
  registerSupervisedSubstrate,
  shutdownAllPersistentRepls,
  spawnEphemeralSession,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import { clearPendingRespawns, loadPendingRespawns } from '../pending-respawns-queue.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

interface SpawnedChild {
  sid: string
  killed: () => boolean
}

/** A fake `claude`+dev-channel: serves /health, echoes each /message back as a
 *  /reply (turn_id round-tripped). `seen` increments per turn WITHIN one REPL, so
 *  a fresh disposable REPL always replies `seen=0` while a reused warm REPL replies
 *  `seen=1` on its second turn — the signal that distinguishes isolation from
 *  collapse. Tracks every spawn + whether its child was killed (disposed). */
function makeEchoHost(): {
  host: PtyHost
  spawnCount: () => number
  killCount: () => number
  children: () => SpawnedChild[]
} {
  let spawns = 0
  const spawned: SpawnedChild[] = []
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
      spawned.push({ sid, killed: () => hasExited })
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
    killCount: () => spawned.filter((c) => c.killed()).length,
    children: () => spawned,
  }
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

function spec(prompt: string, sessionId?: string): AgentSpec {
  const s: AgentSpec = { prompt, tools: [], model_preference: ['claude-opus-4-7'] }
  if (sessionId !== undefined) s.session = { id: sessionId, last_active_at: 1 }
  return s
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

/** Poll until `cond()` or the deadline — disposal is fire-and-forget in the
 *  driver's finally, so it completes a few microtasks after `drain()` returns. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await Bun.sleep(10)
  }
}

const identity = {
  user_id: 'u-1',
  project_id: 'default',
  credential_identity: 'cred-1',
} as const

describe('PersistentReplSubstrate — ephemeral one-shot isolation (Argus r4 BLOCKER)', () => {
  it('two session-less one-shots on ONE ephemeral substrate do NOT share a transcript', async () => {
    const { host, spawnCount, killCount } = makeEchoHost()
    // ONE shared substrate, exactly like the gateway's `cc-llm-*` that every
    // stateless utility caller dispatches through.
    const shared = createPersistentReplSubstrate(opts(host, { ...identity, ephemeral: true }))

    // Two DISTINCT one-shot purposes (e.g. scribe then phase-spec resolver),
    // both session-less, same (user, project, cred).
    const first = await drain(shared.start(spec('scribe-purpose')))
    const second = await drain(shared.start(spec('phase-spec-purpose')))

    // Each landed on its OWN fresh REPL — neither sees the other's turn (no
    // cross-purpose bleed). A collapsed warm REPL would have answered the second
    // call `seen=1` and carried the first turn in-context.
    expect(first).toBe('seen=0 got=scribe-purpose')
    expect(second).toBe('seen=0 got=phase-spec-purpose')
    expect(spawnCount()).toBe(2)

    // Both disposable REPLs are terminated after their single turn (no warm
    // lingering → no unbounded transcript growth).
    await waitFor(() => killCount() === 2)
    expect(killCount()).toBe(2)
  })

  it('a third one-shot still spawns fresh (no accumulation across many calls)', async () => {
    const { host, spawnCount, killCount } = makeEchoHost()
    const shared = createPersistentReplSubstrate(opts(host, { ...identity, ephemeral: true }))
    for (let n = 0; n < 3; n += 1) {
      const out = await drain(shared.start(spec(`call-${n}`)))
      expect(out).toBe(`seen=0 got=call-${n}`)
    }
    expect(spawnCount()).toBe(3)
    await waitFor(() => killCount() === 3)
  })

  it('a dispatch carrying a real spec.session pools even on an ephemeral substrate (warm multi-turn)', async () => {
    const { host, spawnCount, killCount } = makeEchoHost()
    const shared = createPersistentReplSubstrate(opts(host, { ...identity, ephemeral: true }))

    // A genuine multi-turn resume (the conversational path) supplies `spec.session`
    // → it pools by poolKeyFor and reuses the warm REPL, even though the substrate
    // is marked ephemeral. The flag only changes the SESSION-LESS path.
    const t1 = await drain(shared.start(spec('chat-1', 'sess-abc')))
    const t2 = await drain(shared.start(spec('chat-2', 'sess-abc')))

    expect(t1).toBe('seen=0 got=chat-1')
    // Turn 2 reused the warm REPL → it saw turn 1 (seen=1).
    expect(t2).toBe('seen=1 got=chat-2')
    expect(spawnCount()).toBe(1)
    // The warm pooled REPL is NOT disposed mid-conversation.
    expect(killCount()).toBe(0)
  })

  it('#112 invariant: the disposable ephemeral path fails fast on a resumable spec.session', async () => {
    // The `start()` ephemeral gate guarantees this is unreachable through the
    // public API (a session-ful dispatch pools instead of spawning ephemeral —
    // proven by the "pools even on an ephemeral substrate" test above). The
    // defensive assert guards the impossible input directly: if a future edit
    // ever routes a resumable session onto the disposable path, it throws rather
    // than silently `--resume`-ing and replaying a transcript a one-shot must
    // never share. The assert fires before any spawn, so no live REPL is needed.
    const { host, spawnCount } = makeEchoHost()
    await expect(
      spawnEphemeralSession(opts(host, { ...identity, ephemeral: true }), spec('one-shot', 'sess-leak')),
    ).rejects.toThrow(/invariant violation \(#112\)/)
    // It threw before spawning anything — no disposable REPL leaked.
    expect(spawnCount()).toBe(0)
  })

  it('the default (non-ephemeral) substrate still warm-reuses across session-less turns', async () => {
    const { host, spawnCount, killCount } = makeEchoHost()
    // No `ephemeral` flag — the conversational/router substrates' behavior.
    const warm = createPersistentReplSubstrate(opts(host, { ...identity }))

    const t1 = await drain(warm.start(spec('one')))
    const t2 = await drain(warm.start(spec('two')))

    expect(t1).toBe('seen=0 got=one')
    expect(t2).toBe('seen=1 got=two')
    expect(spawnCount()).toBe(1)
    expect(killCount()).toBe(0)
  })
})

/**
 * Argus r5 BLOCKER + IMPORTANT-1 regression — the CRASH PATH.
 *
 * The r4 ephemeral fix isolated the NORMAL (clean-completion) path, but the
 * regression suite only covered clean completions, so the crash-path hole shipped
 * green (CLAUDE.md happy-path-only anti-pattern). On a MID-TURN CRASH the
 * enqueue-on-crash block used the POOLED `options`/`sessionKey` (still carrying
 * `pendingRespawnsPath` + `delivery_topic_id` + the `cc-llm-*` pooled key that
 * `registerSupervisedSubstrate` registered), NOT the stripped ephemeral session —
 * so a crashed disposable one-shot's INTERNAL prompt got persisted to the
 * pending-respawns queue, replayed by the drain, and routed to the USER's chat
 * topic. These tests pin the fix: an ephemeral crash NEVER enqueues/replays, while
 * a non-ephemeral crash still does (proving the enqueue path is genuinely
 * exercised, not vacuously absent). Plus: ephemeral dispose unlinks its temp config
 * files (IMPORTANT-1, the unbounded tmp-file leak).
 */

interface ProbeHost {
  host: PtyHost
  spawnCount: () => number
  killCount: () => number
  /** The `--mcp-config` + `--settings` paths of the FIRST spawn (the one-shot). */
  firstConfigPaths: () => { mcp: string; settings: string; existedAtSpawn: boolean } | undefined
}

/** A fake `claude`+dev-channel that CRASHES mid-turn: it serves /health, accepts
 *  the /message inject (returns `delivered` so the inject succeeds), then kills its
 *  own child a tick later WITHOUT ever sending a /reply — exactly the
 *  REPL-died-mid-turn shape that drives the enqueue-on-crash block. Also records
 *  each spawn's temp config paths (extracted from argv) + whether they existed on
 *  disk at spawn time, so the dispose-unlink test can assert before/after. */
function makeCrashHost(): ProbeHost {
  let spawns = 0
  const spawned: { killed: () => boolean }[] = []
  const configs: { mcp: string; settings: string; existedAtSpawn: boolean }[] = []
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      const pid = 200000 + spawns
      const i = argv.indexOf('--session-id')
      const r = argv.indexOf('--resume')
      const sid = (i >= 0 ? argv[i + 1] : r >= 0 ? argv[r + 1] : undefined) as string
      const mcp = argv[argv.indexOf('--mcp-config') + 1] as string
      const settings = argv[argv.indexOf('--settings') + 1] as string
      // The substrate writes both temp configs SYNCHRONOUSLY before spawning, so
      // they exist on disk right now — captured to prove the later unlink.
      configs.push({ mcp, settings, existedAtSpawn: existsSync(mcp) && existsSync(settings) })
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
      const crash = (): void => {
        if (hasExited) return
        hasExited = true
        try {
          server.stop(true)
        } catch {
          /* ignore */
        }
        exitResolve(139)
      }
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true })
          if (req.method === 'POST' && url.pathname === '/message') {
            // Accept the inject so it succeeds, then crash a tick later WITHOUT
            // replying → the turn dies mid-flight (REPL exited mid-turn).
            setTimeout(crash, 15)
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
      spawned.push({ killed: () => hasExited })
      return {
        pid,
        write() {},
        resize() {},
        kill() {
          crash()
        },
        exited,
        hasExited: () => hasExited,
      }
    },
  }
  return {
    host,
    spawnCount: () => spawns,
    killCount: () => spawned.filter((c) => c.killed()).length,
    firstConfigPaths: () => configs[0],
  }
}

/** Drain that TOLERATES a terminal error event (the crash surfaces as a retryable
 *  error on the channel). Returns when the channel ends, however it ends. */
async function drainToEnd(handle: SessionHandle): Promise<{ text: string; errored: boolean }> {
  let text = ''
  for await (const ev of handle.events as AsyncIterable<Event>) {
    if (ev.kind === 'token') text += ev.text
    else if (ev.kind === 'completion') return { text, errored: false }
    else if (ev.kind === 'error') return { text, errored: true }
  }
  return { text, errored: false }
}

describe('PersistentReplSubstrate — ephemeral CRASH-path isolation (Argus r5 BLOCKER)', () => {
  it('an ephemeral one-shot that crashes mid-turn does NOT enqueue to pending-respawns and does NOT replay to the user', async () => {
    const { host, spawnCount, killCount } = makeCrashHost()
    const pendingPath = join(tmpdir(), `neutron-pending-${randomUUID()}.json`)
    const registryPath = join(tmpdir(), `neutron-registry-${randomUUID()}.json`)
    const recoveredReplies: unknown[] = []
    const o = opts(host, {
      ...identity,
      ephemeral: true,
      // Full supervision wiring present — exactly the pooled `cc-llm-*` options the
      // BLOCKER mis-used. If the guard regressed, the crash WOULD persist + replay.
      replRegistryPath: registryPath,
      pendingRespawnsPath: pendingPath,
      delivery_topic_id: 'user-chat-topic-999',
      instance_slug: 'acme',
      onRecoveredReply: (r) => {
        recoveredReplies.push(r)
      },
    })
    // Register the supervised substrate so the replay path is FULLY wired — proving
    // nothing flows is meaningful only when a drain COULD route an entry if present.
    registerSupervisedSubstrate(o)
    const sub = createPersistentReplSubstrate(o)

    const { errored } = await drainToEnd(sub.start(spec('internal-scribe-prompt')))
    expect(errored).toBe(true) // the crash surfaced as a retryable error to the caller
    await waitFor(() => killCount() === 1)
    expect(spawnCount()).toBe(1)

    // BLOCKER: nothing was persisted to the pending-respawns queue.
    expect(loadPendingRespawns(pendingPath).kind).toBe('absent')

    // …and a drain has nothing to replay → the internal prompt never reaches the
    // user's chat topic via `deliverRecoveredReply`.
    const drained = await drainPendingRespawns(o, { baseDelayMs: 0 })
    expect(drained).toEqual([])
    expect(recoveredReplies).toEqual([])

    clearPendingRespawns(pendingPath)
  })

  it('CONTROL: a NON-ephemeral one-shot that crashes mid-turn DOES enqueue (proves the enqueue path is exercised)', async () => {
    const { host, killCount } = makeCrashHost()
    const pendingPath = join(tmpdir(), `neutron-pending-${randomUUID()}.json`)
    const o = opts(host, {
      ...identity,
      // No `ephemeral` flag → the warm-pool path → a mid-turn crash MUST enqueue.
      pendingRespawnsPath: pendingPath,
      delivery_topic_id: 'user-chat-topic-999',
      instance_slug: 'acme',
    })
    const sub = createPersistentReplSubstrate(o)

    const { errored } = await drainToEnd(sub.start(spec('conversational-prompt')))
    expect(errored).toBe(true)
    await waitFor(() => killCount() === 1)

    const loaded = loadPendingRespawns(pendingPath)
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind === 'loaded') {
      expect(loaded.entries).toHaveLength(1)
      expect(loaded.entries[0]?.droppedInbound).toBe('conversational-prompt')
      expect(loaded.entries[0]?.topic_id).toBe('user-chat-topic-999')
    }

    clearPendingRespawns(pendingPath)
  })

  it('ephemeral dispose unlinks its temp config files (IMPORTANT-1: no unbounded tmp-file leak)', async () => {
    const { host, firstConfigPaths, killCount } = makeEchoHostCapturingConfigs()
    const sub = createPersistentReplSubstrate(opts(host, { ...identity, ephemeral: true }))

    const out = await drain(sub.start(spec('one-shot')))
    expect(out).toBe('seen=0 got=one-shot')
    await waitFor(() => killCount() === 1)

    const cfg = firstConfigPaths()
    expect(cfg).toBeDefined()
    if (cfg === undefined) return
    // They existed at spawn (written synchronously before the child started)…
    expect(cfg.existedAtSpawn).toBe(true)
    // …and are gone once the disposable REPL was torn down (no permanent leak).
    await waitFor(() => !existsSync(cfg.mcp) && !existsSync(cfg.settings))
    expect(existsSync(cfg.mcp)).toBe(false)
    expect(existsSync(cfg.settings)).toBe(false)
  })
})

/** Clean-completion echo host (like `makeEchoHost`) that additionally records the
 *  temp config paths of the first spawn + whether they existed on disk at spawn
 *  time — for the dispose-unlink assertion. */
function makeEchoHostCapturingConfigs(): ProbeHost {
  let spawns = 0
  const spawned: { killed: () => boolean }[] = []
  const configs: { mcp: string; settings: string; existedAtSpawn: boolean }[] = []
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      const pid = 300000 + spawns
      const i = argv.indexOf('--session-id')
      const r = argv.indexOf('--resume')
      const sid = (i >= 0 ? argv[i + 1] : r >= 0 ? argv[r + 1] : undefined) as string
      const mcp = argv[argv.indexOf('--mcp-config') + 1] as string
      const settings = argv[argv.indexOf('--settings') + 1] as string
      configs.push({ mcp, settings, existedAtSpawn: existsSync(mcp) && existsSync(settings) })
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
      spawned.push({ killed: () => hasExited })
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
    killCount: () => spawned.filter((c) => c.killed()).length,
    firstConfigPaths: () => configs[0],
  }
}
