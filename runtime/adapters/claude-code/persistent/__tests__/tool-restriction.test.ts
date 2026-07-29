/**
 * tool-restriction.test.ts — Codex-r1-P1 (SECURITY).
 *
 * The persistent interactive-REPL substrate is now the SOLE spawn shape, so it
 * MUST honor `spec.tools` exactly like the retired per-turn path did — default-
 * deny via `--tools`. A `tools: []` caller (e.g. the history-import substrate,
 * which processes UNTRUSTED ChatGPT-export content under
 * `--dangerously-skip-permissions`) must get `--tools ""` (no built-in tools) so
 * a prompt-injection cannot reach Bash/Read/Write to exfiltrate credentials.
 *
 * Proves the END-TO-END wiring (spec.tools → spawned REPL argv), not just the
 * argv builder, plus the reuse guard that prevents a less-privileged turn from
 * inheriting a more-privileged warm REPL.
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

/** Echo host that ALSO captures the argv of every spawn (for `--tools` asserts). */
function makeCapturingHost(): { host: PtyHost; argvs: string[][]; spawnCount: () => number } {
  const argvs: string[][] = []
  let spawns = 0
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      argvs.push(argv)
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
  return { host, argvs, spawnCount: () => spawns }
}

function opts(
  host: PtyHost,
  extra: Partial<PersistentReplSubstrateOptions>,
): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-import-acme',
    cwd: '/tmp/neutron-acme-tools',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    skip_permissions: true,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    ...extra,
  }
}

function spec(prompt: string, tools: ReadonlyArray<string>): AgentSpec {
  return { prompt, tools: tools.map((name) => ({ name })) as AgentSpec['tools'], model_preference: ['claude-opus-4-7'] }
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

function toolsValue(argv: string[]): string | undefined {
  const i = argv.indexOf('--tools')
  return i >= 0 ? argv[i + 1] : undefined
}

describe('persistent REPL — tool restriction (Codex-r1-P1 SECURITY)', () => {
  it('a tools:[] caller spawns the REPL with --tools "" (no built-in tools)', async () => {
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { user_id: '_platform', project_id: 'import', credential_identity: 'cred-1' }),
    )
    await drain(sub.start(spec('untrusted export chunk', [])))
    expect(argvs.length).toBe(1)
    expect(toolsValue(argvs[0]!)).toBe('')
    // No built-in tool name leaks into the spawned argv.
    expect(argvs[0]).not.toContain('Bash')
    expect(argvs[0]).not.toContain('Read')
  })

  it('a tools:[Read,Grep] caller spawns with --tools Read,Grep', async () => {
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, {
        substrate_instance_id: 'cc-llm-acme',
        user_id: 'u-1',
        project_id: 'default',
        credential_identity: 'cred-1',
      }),
    )
    await drain(sub.start(spec('hi', ['Read', 'Grep'])))
    expect(toolsValue(argvs[0]!)).toBe('Read,Grep')
  })

  it('reuse guard: a tools:[] turn never inherits a more-privileged warm REPL', async () => {
    const { host, argvs, spawnCount } = makeCapturingHost()
    const sharedKey = {
      substrate_instance_id: 'cc-llm-acme',
      user_id: 'u-1',
      project_id: 'default',
      credential_identity: 'cred-1',
    } as const
    // Turn 1 spawns a REPL WITH tools.
    await drain(createPersistentReplSubstrate(opts(host, sharedKey)).start(spec('one', ['Read'])))
    // Turn 2 on the SAME key but tools:[] must NOT reuse the Read-enabled REPL —
    // the guard evicts + respawns under --tools "".
    await drain(createPersistentReplSubstrate(opts(host, sharedKey)).start(spec('two', [])))
    expect(spawnCount()).toBe(2)
    expect(toolsValue(argvs[0]!)).toBe('Read')
    expect(toolsValue(argvs[1]!)).toBe('')
  })

  it('reuse: same tool surface across turns reuses the one warm REPL', async () => {
    const { host, spawnCount } = makeCapturingHost()
    const sharedKey = {
      substrate_instance_id: 'cc-llm-acme',
      user_id: 'u-2',
      project_id: 'default',
      credential_identity: 'cred-1',
    } as const
    const r1 = await drain(createPersistentReplSubstrate(opts(host, sharedKey)).start(spec('one', ['Read'])))
    const r2 = await drain(createPersistentReplSubstrate(opts(host, sharedKey)).start(spec('two', ['Read'])))
    expect(r1).toBe('seen=0 got=one')
    expect(r2).toBe('seen=1 got=two')
    expect(spawnCount()).toBe(1)
  })
})
