/**
 * ritual-auto-approve-gate.test.ts — task 6 (T5 write-containment) FAKE-HOST
 * unit proof that the production wiring takes effect.
 *
 * The T5 spike's whole security argument is: a ritual `permissions.deny` rule is
 * THEATER unless the `tool-use-approve` auto-approver (`spawn.ts` — presses
 * `['1','enter']` = "Yes" on any tool-use permission prompt, incl. Bash via
 * `runthiscommand`) is DISABLED for that session. This test proves the
 * `disableToolUseAutoApprove` option actually removes that ONE detector from the
 * spawned session's scanner while leaving the rest (the wedged-prompt
 * deadlock-recovery ladder, the disclaimer dismiss, rate-limit, resume/compact
 * pickers, banners) unconditionally registered — so a genuine wedge still
 * self-clears.
 *
 * Mirrors `tool-restriction.test.ts`'s capturing-fake-host pattern (no real
 * `claude`); it introspects the pooled `ReplSession.scanner` via the new
 * `OutputScanner.has(id)` seam.
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
import { pool } from '../pool-state.ts'
import type { ReplSession } from '../repl-session.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

/** Minimal echo host — one warm session, replies to /message, stays pooled. */
function makeEchoHost(): { host: PtyHost } {
  let spawns = 0
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      const pid = 310000 + spawns
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
            void post('/reply', { session_id: sid, text: `ok=${body.text}`, turn_id: body.turn_id })
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
  return { host }
}

function opts(extra: Partial<PersistentReplSubstrateOptions>, host: PtyHost): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-ritual-acme',
    cwd: '/tmp/neutron-ritual-gate',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    skip_permissions: false,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    ...extra,
  }
}

function spec(prompt: string, tools: ReadonlyArray<string>): AgentSpec {
  return {
    prompt,
    tools: tools.map((name) => ({ name })) as AgentSpec['tools'],
    model_preference: ['claude-opus-4-8'],
  }
}

async function drain(handle: SessionHandle): Promise<void> {
  for await (const ev of handle.events as AsyncIterable<Event>) {
    if (ev.kind === 'completion') return
    if (ev.kind === 'error') throw new Error(`drain error: ${ev.message}`)
  }
}

/** The single pooled session (each test spawns exactly one). */
async function onlyPooledSession(): Promise<ReplSession> {
  const sessions = await Promise.all([...pool.values()])
  expect(sessions.length).toBe(1)
  return sessions[0]!
}

describe('ritual auto-approve gate (task 6 / T5 write-containment)', () => {
  it('DEFAULT (flag unset): the `tool-use-approve` auto-approver IS registered', async () => {
    const { host } = makeEchoHost()
    const sub = createPersistentReplSubstrate(
      opts({ user_id: 'u-1', project_id: 'default', credential_identity: 'c-1' }, host),
    )
    await drain(sub.start(spec('hello', ['Write', 'Edit'])))
    const session = await onlyPooledSession()
    expect(session.scanner.has('tool-use-approve')).toBe(true)
    // The no-hang backstop + core detectors are present too.
    expect(session.scanner.has('wedged-interactive-prompt')).toBe(true)
    expect(session.scanner.has('dev-channel-disclaimer')).toBe(true)
  })

  it('disableToolUseAutoApprove: true — the auto-approver is ABSENT, wedge-recovery stays', async () => {
    const { host } = makeEchoHost()
    const sub = createPersistentReplSubstrate(
      opts(
        {
          user_id: 'u-2',
          project_id: 'default',
          credential_identity: 'c-1',
          disableToolUseAutoApprove: true,
          permissions: { deny: ['Write(/tmp/outside/**)', 'Bash'] },
        },
        host,
      ),
    )
    await drain(sub.start(spec('write ritual', ['Write', 'Edit'])))
    const session = await onlyPooledSession()
    // The load-bearing assertion: NO auto-approver → a deny rule is not theater.
    expect(session.scanner.has('tool-use-approve')).toBe(false)
    // Every OTHER detector still registered — a genuine wedge self-clears.
    expect(session.scanner.has('wedged-interactive-prompt')).toBe(true)
    expect(session.scanner.has('dev-channel-disclaimer')).toBe(true)
    expect(session.scanner.has('rate-limit-options-stop')).toBe(true)
    expect(session.scanner.has('compact-resume-picker')).toBe(true)
  })
})
