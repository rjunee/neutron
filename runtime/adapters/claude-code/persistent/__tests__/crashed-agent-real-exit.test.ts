/**
 * crashed-agent-real-exit.test.ts — proves the F4 crashed-agent watchdog can
 * ACTUALLY observe a crash in production, driven by the REAL spawn exit handler
 * (`child.exited.then(...)` in spawn.ts) rather than a manually-inserted dead PID.
 *
 * The regression this guards: the exit handler used to unconditionally unregister
 * the live-process record the instant the child exited, so a child that died
 * between 30 s detector ticks was gone before CrashedAgentDetector ran → NO crash
 * alert ever fired. The fix classifies the exit: an ABNORMAL exit (non-zero code /
 * an external signal we did not send) LEAVES the record marked `crashed` for the
 * detector to report once; a CLEAN (code 0) or intentional (`wasKilledByUs`)
 * termination unregisters outright.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import {
  ProcessRegistry,
  pushAmbientProcessRegistry,
} from '@neutronai/tools/process-registry.ts'
import { CrashedAgentDetector } from '@neutronai/watchdog/detectors.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

/** A fake `claude` + dev-channel host whose most-recent child exposes hooks to
 *  resolve its real exit (spontaneous crash) or to be intentionally killed. */
function makeHost(): {
  host: PtyHost
  exitLast: (code: number | null) => void
  killLast: () => void
  pidLast: () => number
} {
  let lastExitResolve: (c: number | null) => void = () => {}
  let lastKilledByUs = false
  let lastHasExited = false
  const PID = 4242
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      const i = argv.indexOf('--session-id')
      const sid = (i >= 0 ? argv[i + 1] : argv[argv.indexOf('--resume') + 1]) as string
      const { port: sinkPort, token } = getReplSinkInfo()
      lastKilledByUs = false
      lastHasExited = false
      const exited = new Promise<number | null>((res) => (lastExitResolve = res))
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
            void post('/reply', { session_id: sid, text: `ok:${body.text}`, turn_id: body.turn_id })
            return Response.json({ status: 'delivered' })
          }
          return new Response('not found', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid: PID })
      void post('/channel-bound', { session_id: sid })
      const finish = (code: number | null): void => {
        if (lastHasExited) return
        lastHasExited = true
        try {
          server.stop(true)
        } catch {
          /* ignore */
        }
        lastExitResolve(code)
      }
      return {
        pid: PID,
        write() {},
        resize() {},
        kill() {
          // Intentional termination — record intent, exit by signal (code null).
          lastKilledByUs = true
          finish(null)
        },
        exited,
        hasExited: () => lastHasExited,
        wasKilledByUs: () => lastKilledByUs,
      }
    },
  }
  return {
    host,
    exitLast: (code) => lastExitResolve(code),
    killLast: () => {
      lastKilledByUs = true
      lastHasExited = true
      lastExitResolve(null)
    },
    pidLast: () => PID,
  }
}

let n = 0
function optsWith(host: PtyHost): PersistentReplSubstrateOptions {
  n += 1
  return {
    substrate_instance_id: `crash-exit-${n}-${Math.floor(performance.now())}`,
    cwd: `/tmp/neutron-crash-exit-cwd-${n}`,
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
  }
}

async function drainOK(handle: { events: AsyncIterable<{ kind: string }> }): Promise<void> {
  for await (const ev of handle.events) {
    if (ev.kind === 'completion' || ev.kind === 'error') return
  }
}

/** Let the async `child.exited.then` handler run to completion. */
async function settle(): Promise<void> {
  await Bun.sleep(30)
}

describe('crashed-agent watchdog — real spawn exit handler (F4)', () => {
  it('an ABNORMAL exit (non-zero code, not killed by us) is REPORTED by the detector', async () => {
    const reg = new ProcessRegistry()
    const clear = pushAmbientProcessRegistry(reg)
    try {
      const { host, exitLast } = makeHost()
      const sub = createPersistentReplSubstrate(optsWith(host))
      await drainOK(sub.start({ prompt: 'hi', tools: [], model_preference: ['claude-opus-4-7'] }))

      // The live child registered into the ambient registry the detector reads.
      expect(reg.size()).toBe(1)

      // The child CRASHES on its own with a non-zero code (NOT killed by us).
      exitLast(1)
      await settle()

      // The real exit handler LEFT the record, marked crashed (not unregistered).
      expect(reg.size()).toBe(1)
      expect(reg.list()[0]!.exit_status).toBe('crashed')

      // The detector reports it — pid probe forced alive so ONLY the crash mark
      // can drive the alert (proving the mark, not pid-liveness, is what fires).
      const detector = new CrashedAgentDetector({
        project_slug: 'owner',
        process_registry: reg,
        pid_probe: { isAlive: () => true },
      })
      const alerts = await detector.detect()
      expect(alerts.length).toBe(1)
      expect(alerts[0]?.kind).toBe('crashed_agent')

      // Commit reaps the crashed record.
      detector.commit(alerts[0]!)
      expect(reg.size()).toBe(0)
    } finally {
      clear()
    }
  })

  it('a CLEAN exit (code 0) is unregistered — the detector reports nothing', async () => {
    const reg = new ProcessRegistry()
    const clear = pushAmbientProcessRegistry(reg)
    try {
      const { host, exitLast } = makeHost()
      const sub = createPersistentReplSubstrate(optsWith(host))
      await drainOK(sub.start({ prompt: 'hi', tools: [], model_preference: ['claude-opus-4-7'] }))
      expect(reg.size()).toBe(1)

      exitLast(0) // graceful self-exit
      await settle()

      // Unregistered outright — nothing for the detector to see.
      expect(reg.size()).toBe(0)
      const detector = new CrashedAgentDetector({
        project_slug: 'owner',
        process_registry: reg,
        pid_probe: { isAlive: () => true },
      })
      expect((await detector.detect()).length).toBe(0)
    } finally {
      clear()
    }
  })

  it('an INTENTIONAL kill (signal, wasKilledByUs) is NOT a crash — unregistered, no alert', async () => {
    const reg = new ProcessRegistry()
    const clear = pushAmbientProcessRegistry(reg)
    try {
      const { host, killLast } = makeHost()
      const sub = createPersistentReplSubstrate(optsWith(host))
      await drainOK(sub.start({ prompt: 'hi', tools: [], model_preference: ['claude-opus-4-7'] }))
      expect(reg.size()).toBe(1)

      // We terminate it (evict/respawn/shutdown): signal-kill, but expected.
      killLast()
      await settle()

      expect(reg.size()).toBe(0) // dropped, NOT marked crashed
      const detector = new CrashedAgentDetector({
        project_slug: 'owner',
        process_registry: reg,
        pid_probe: { isAlive: () => true },
      })
      expect((await detector.detect()).length).toBe(0)
    } finally {
      clear()
    }
  })
})
