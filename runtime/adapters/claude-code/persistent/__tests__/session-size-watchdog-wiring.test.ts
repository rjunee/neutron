/**
 * session-size-watchdog-wiring.test.ts — proves the row #13 size watchdog is
 * actually WIRED into the substrate spawn path (anti-pattern #1: no built-but-
 * not-wired core). A warm session whose POST-COMPACT transcript on disk is ≥5 MB
 * must surface a warn via the injected `onSizeAlert`, and the surfaced Compact
 * affordance (`requestSessionCompact`) must actuate `escape` + `/compact\r`
 * through the live PTY child.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import type { Key } from '../keystrokes.ts'
import { encodeKey } from '../keystrokes.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  poolKeyFor,
  peekSizeWatchdogForTest,
  requestSessionCompact,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import { sessionJsonlPath, SIZE_WARN_BYTES } from '../session-size-watchdog.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

/** A fake `claude` + dev-channel host that ALSO records raw PTY writes (so we can
 *  assert the Compact actuation bytes). */
function makeHost(): { host: PtyHost; writes: () => string[] } {
  const writes: string[] = []
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      const i = argv.indexOf('--session-id')
      const sid = (i >= 0 ? argv[i + 1] : argv[argv.indexOf('--resume') + 1]) as string
      const { port: sinkPort, token } = getReplSinkInfo()
      let hasExited = false
      let exitResolve: (c: number | null) => void = () => {}
      const exited = new Promise<number | null>((res) => (exitResolve = res))
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
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid: 4242 })
      return {
        pid: 4242,
        write: (d) => writes.push(typeof d === 'string' ? d : Buffer.from(d).toString('utf8')),
        writeKey: (k: Key) => writes.push(`KEY:${encodeKey(k)}`),
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
  return { host, writes: () => writes }
}

let n = 0
function optsWith(host: PtyHost, extra: Partial<PersistentReplSubstrateOptions>): PersistentReplSubstrateOptions {
  n += 1
  return {
    substrate_instance_id: `size-wire-${n}-${Math.floor(performance.now())}`,
    cwd: `/tmp/neutron-size-wire-cwd-${n}`,
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    ...extra,
  }
}

/** Pre-seed a transcript JSONL whose POST-COMPACT region is `bytes` long. */
function seedJsonl(projectsDir: string, sessionId: string, cwd: string, bytes: number): void {
  const p = sessionJsonlPath(sessionId, cwd, projectsDir)
  mkdirSync(dirname(p), { recursive: true })
  // A compact-summary marker followed by `bytes` of live context. (No marker
  // would also work, but this also exercises the post-compact measurement.)
  const post = JSON.stringify({ type: 'assistant', pad: 'x'.repeat(Math.max(0, bytes - 40)) }) + '\n'
  writeFileSync(p, `{"isCompactSummary":true}\n` + post)
}

async function drainOK(handle: { events: AsyncIterable<{ kind: string; text?: string }> }): Promise<void> {
  for await (const ev of handle.events) {
    if (ev.kind === 'completion' || ev.kind === 'error') return
  }
}

describe('session-size watchdog — substrate wiring (row #13)', () => {
  it('a warm session with a ≥5MB post-compact transcript surfaces a warn', async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), 'neutron-size-wire-'))
    try {
      const { host } = makeHost()
      const alerts: Array<{ severity: string; sizeBytes: number }> = []
      const sessionId = '11111111-1111-4111-8111-111111111111'
      const opts = optsWith(host, {
        projectsDir,
        idGen: () => sessionId,
        onSizeAlert: (info) => alerts.push({ severity: info.severity, sizeBytes: info.sizeBytes }),
      })
      // Seed a >5MB post-compact transcript at the session's on-disk path.
      seedJsonl(projectsDir, sessionId, opts.cwd as string, SIZE_WARN_BYTES + 4096)

      const sub = createPersistentReplSubstrate(opts)
      await drainOK(sub.start({ prompt: 'hi', tools: [], model_preference: ['claude-opus-4-7'] }))

      // The watchdog is wired + running; drive one tick deterministically.
      const wd = await peekSizeWatchdogForTest(poolKeyFor(opts))
      expect(wd).toBeDefined()
      wd?.tick()

      expect(alerts).toHaveLength(1)
      expect(alerts[0]?.severity).toBe('warn')
      expect(alerts[0]?.sizeBytes).toBeGreaterThanOrEqual(SIZE_WARN_BYTES)
    } finally {
      rmSync(projectsDir, { recursive: true, force: true })
    }
  })

  it('requestSessionCompact actuates escape + /compact\\r on the live child', async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), 'neutron-size-wire-'))
    try {
      const { host, writes } = makeHost()
      const sessionId = '22222222-2222-4222-8222-222222222222'
      const opts = optsWith(host, { projectsDir, idGen: () => sessionId })
      seedJsonl(projectsDir, sessionId, opts.cwd as string, 1024) // small; not the point

      const sub = createPersistentReplSubstrate(opts)
      await drainOK(sub.start({ prompt: 'hi', tools: [], model_preference: ['claude-opus-4-7'] }))

      const fired = await requestSessionCompact(poolKeyFor(opts))
      expect(fired).toBe(true)
      // escape THEN /compact\r, in order, exactly once.
      const idxEsc = writes().indexOf(`KEY:${encodeKey('escape')}`)
      const idxCompact = writes().indexOf('/compact\r')
      expect(idxEsc).toBeGreaterThanOrEqual(0)
      expect(idxCompact).toBeGreaterThan(idxEsc)
      expect(writes().filter((w) => w === '/compact\r')).toHaveLength(1)

      // A second press while mid-compact is a no-op (fire-once).
      expect(await requestSessionCompact(poolKeyFor(opts))).toBe(false)
      expect(writes().filter((w) => w === '/compact\r')).toHaveLength(1)
    } finally {
      rmSync(projectsDir, { recursive: true, force: true })
    }
  })

  it('requestSessionCompact returns false for an unknown session key', async () => {
    expect(await requestSessionCompact('no-such-key')).toBe(false)
  })
})
