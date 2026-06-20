/**
 * import-warm-session-reset.test.ts — `reset_context_per_turn` warm-import mode
 * (2026-06-17 import warm-session sprint).
 *
 * The history-import substrate (`cc-import-*`) must run ALL Pass-1/Pass-2 chunk
 * analyses through ONE warm `claude` process (pay the heavy spawn ONCE, not once
 * per chunk) WHILE keeping each chunk's context isolated (no ballooning
 * transcript). `reset_context_per_turn` delivers that: the warm pooled REPL is
 * reused across session-less turns, but every reused turn is preceded by a
 * `/clear` slash command written to the REPL's PTY so the prior chunk's transcript
 * is wiped first.
 *
 * Covers:
 *  - N session-less turns on a `reset_context_per_turn` substrate land on ONE
 *    warm REPL (spawnCount === 1) — warm reuse, NOT spawn-per-chunk;
 *  - a `/clear` is written to the PTY before every REUSED turn (turns 2..N) and
 *    NOT before the first turn (fresh REPL ⇒ empty context, nothing to clear);
 *  - the default (no flag) warm substrate writes NO `/clear` (opt-in; unchanged).
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

/** Ordered transcript of what the substrate did to the REPL: each PTY `write`
 *  (captures the `/clear`) and each dev-channel `/message` inject, in order. */
type Timeline = Array<{ kind: 'write'; data: string } | { kind: 'message'; text: string }>

/** A fake `claude`+dev-channel that (a) echoes each /message back as a /reply and
 *  (b) records every raw PTY `write()` into a shared timeline, so a test can assert
 *  a `/clear` was written before a reused turn's inject. `seen` increments per turn
 *  within one REPL (the warm-reuse signal). */
function makeRecordingHost(): {
  host: PtyHost
  spawnCount: () => number
  timeline: Timeline
} {
  let spawns = 0
  const timeline: Timeline = []
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      const pid = 200000 + spawns
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
            timeline.push({ kind: 'message', text: body.text })
            const reply = `seen=${seen} got=${body.text}`
            seen += 1
            void post('/reply', { session_id: sid, text: reply, turn_id: body.turn_id })
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
      return {
        pid,
        write(data: string | Uint8Array) {
          timeline.push({
            kind: 'write',
            data: typeof data === 'string' ? data : Buffer.from(data).toString('utf8'),
          })
        },
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
  return { host, spawnCount: () => spawns, timeline }
}

function opts(
  host: PtyHost,
  extra: Partial<PersistentReplSubstrateOptions>,
): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-import-acme',
    cwd: '/tmp/neutron-import-acme',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    idleMaxMs: 50,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    user_id: 'u-1',
    project_id: 'default',
    credential_identity: 'cred-1',
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

const CLEARS = (t: Timeline): number => t.filter((e) => e.kind === 'write' && e.data.includes('/clear')).length

describe('PersistentReplSubstrate — reset_context_per_turn (import warm-session)', () => {
  it('reuses ONE warm REPL across chunks and writes /clear before each REUSED turn', async () => {
    const { host, spawnCount, timeline } = makeRecordingHost()
    // ONE import substrate, exactly like the Open composer's `cc-import-*`.
    const sub = createPersistentReplSubstrate(opts(host, { reset_context_per_turn: true }))

    // Three session-less "chunks" — the import Pass-1 dispatch shape.
    const c0 = await drain(sub.start(spec('chunk-0')))
    const c1 = await drain(sub.start(spec('chunk-1')))
    const c2 = await drain(sub.start(spec('chunk-2')))

    // All three landed on the SAME warm REPL — the heavy spawn is paid ONCE,
    // NOT once per chunk (the defect this sprint fixes).
    expect(spawnCount()).toBe(1)
    expect(c0).toBe('seen=0 got=chunk-0')

    // A `/clear` was written to the PTY before each REUSED turn (chunks 1 + 2)
    // and NOT before the first (fresh REPL ⇒ empty context). Two reused turns ⇒
    // exactly two clears.
    expect(CLEARS(timeline)).toBe(2)

    // Ordering: the first message is NOT preceded by a clear; every later
    // message IS immediately preceded by a clear (per-chunk isolation).
    const firstClearIdx = timeline.findIndex((e) => e.kind === 'write' && e.data.includes('/clear'))
    const firstMsgIdx = timeline.findIndex((e) => e.kind === 'message')
    expect(firstMsgIdx).toBeGreaterThanOrEqual(0)
    expect(firstClearIdx).toBeGreaterThan(firstMsgIdx) // no clear before turn 1

    // The clear command terminates with a carriage return so the TUI runs it.
    const clears = timeline.filter(
      (e): e is { kind: 'write'; data: string } => e.kind === 'write' && e.data.includes('/clear'),
    )
    for (const clr of clears) expect(clr.data).toBe('/clear\r')
  })

  it('the default warm substrate (no flag) writes NO /clear — opt-in only', async () => {
    const { host, spawnCount, timeline } = makeRecordingHost()
    const sub = createPersistentReplSubstrate(opts(host, {}))

    const c0 = await drain(sub.start(spec('chunk-0')))
    const c1 = await drain(sub.start(spec('chunk-1')))

    // Still ONE warm REPL (pre-existing pooling), but NO context reset — turn 2
    // sees turn 1 (seen=1) and no `/clear` was written. Proves the reset is
    // strictly opt-in and doesn't perturb the default warm path.
    expect(spawnCount()).toBe(1)
    expect(c0).toBe('seen=0 got=chunk-0')
    expect(c1).toBe('seen=1 got=chunk-1')
    expect(CLEARS(timeline)).toBe(0)
  })
})
