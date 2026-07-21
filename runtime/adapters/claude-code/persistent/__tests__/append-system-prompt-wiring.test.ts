/**
 * append-system-prompt-wiring.test.ts — executor-mode reminders (plan task 4/5),
 * Argus r1 BLOCKER fix.
 *
 * BACKGROUND (the bug this test guards): the `append_system_prompt_file` threading
 * was previously proven ONLY at the `build-llm-call-substrate` layer against a FAKE
 * `substrateFactory` (`gateway/wiring/__tests__/substrate-profiles.test.ts`). That
 * asserted the value landed on the intermediate `ClaudeCodeSubstrateOptions` bag —
 * but the REAL default anthropic factory (`createClaudeCodeSubstrateAuto`) DROPPED
 * it when mapping onto `PersistentReplSubstrateOptions`, so the ritual REPL spawned
 * with the CHAT persona (`repl-agent-base.md`) instead of the executor persona. The
 * suite stayed green while the open typecheck failed and the value never reached
 * the spawned argv.
 *
 * This test proves the WHOLE chain END-TO-END, the way `tool-restriction.test.ts`
 * proves `spec.tools → spawned argv`:
 *   1. The real `createClaudeCodeSubstrateAuto` factory FORWARDS
 *      `appendSystemPromptFile` from `ClaudeCodeSubstrateOptions` onto the mapped
 *      `PersistentReplSubstrateOptions` (observed via the supervised-options
 *      registry the factory populates). This is the exact seam that dropped it.
 *   2. The spawned REPL argv carries `--append-system-prompt-file <path>` — a
 *      custom executor prompt when set, and the `repl-agent-base.md` default when
 *      unset (`DEFAULT_AGENT_BASE_PROMPT`).
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '../../../../substrate.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { Event } from '../../../../events.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import { createClaudeCodeSubstrateAuto } from '../../index.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import { supervisedBySessionKey } from '../pool-state.ts'
import { DEFAULT_AGENT_BASE_PROMPT } from '../signatures.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

/** Echo host that captures the argv of every spawn (for `--append-system-prompt-file`). */
function makeCapturingHost(): { host: PtyHost; argvs: string[][] } {
  const argvs: string[][] = []
  let spawns = 0
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      argvs.push(argv)
      const pid = 210000 + spawns
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
  return { host, argvs }
}

function opts(
  host: PtyHost,
  extra: Partial<PersistentReplSubstrateOptions>,
): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-ritual-acme',
    cwd: '/tmp/neutron-acme-ritual',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    ...extra,
  }
}

function spec(prompt: string): AgentSpec {
  return { prompt, tools: [], model_preference: ['claude-opus-4-7'] }
}

async function drain(handle: SessionHandle): Promise<void> {
  for await (const ev of handle.events as AsyncIterable<Event>) {
    if (ev.kind === 'completion') return
    if (ev.kind === 'error') throw new Error(`drain error: ${ev.message}`)
  }
}

function appendPromptValue(argv: string[]): string | undefined {
  const i = argv.indexOf('--append-system-prompt-file')
  return i >= 0 ? argv[i + 1] : undefined
}

// ---------------------------------------------------------------------------
// 1. The spawned REPL argv carries the prompt file end-to-end.
// ---------------------------------------------------------------------------

describe('persistent REPL — --append-system-prompt-file reaches the spawned argv', () => {
  it('a ritual caller spawns the REPL with its executor prompt file (not the chat default)', async () => {
    const { host, argvs } = makeCapturingHost()
    const ritualPrompt = '/pkg/reminders/ritual-agent-base.md'
    const sub = createPersistentReplSubstrate(
      opts(host, {
        user_id: 'u-1',
        project_id: 'default',
        credential_identity: 'cred-1',
        appendSystemPromptFile: ritualPrompt,
      }),
    )
    await drain(sub.start(spec('run the daily digest ritual')))
    expect(argvs.length).toBe(1)
    expect(appendPromptValue(argvs[0]!)).toBe(ritualPrompt)
    // NOT the chat persona default.
    expect(appendPromptValue(argvs[0]!)).not.toBe(DEFAULT_AGENT_BASE_PROMPT)
  })

  it('an unset appendSystemPromptFile spawns with the chat default (repl-agent-base.md)', async () => {
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { user_id: 'u-2', project_id: 'default', credential_identity: 'cred-1' }),
    )
    await drain(sub.start(spec('hi')))
    expect(appendPromptValue(argvs[0]!)).toBe(DEFAULT_AGENT_BASE_PROMPT)
  })
})

// ---------------------------------------------------------------------------
// 2. The DEFAULT anthropic factory forwards the field (the exact dropped seam).
//    createClaudeCodeSubstrateAuto registers its mapped PersistentReplSubstrate-
//    Options in `supervisedBySessionKey`; assert the value survived the mapping.
// ---------------------------------------------------------------------------

describe('createClaudeCodeSubstrateAuto forwards appendSystemPromptFile', () => {
  function registeredFor(instanceId: string): PersistentReplSubstrateOptions | undefined {
    for (const o of supervisedBySessionKey.values()) {
      if (o.substrate_instance_id === instanceId) return o
    }
    return undefined
  }

  it('maps ClaudeCodeSubstrateOptions.appendSystemPromptFile onto the persistent options', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'neutron-append-fwd-'))
    const ritualPrompt = '/pkg/reminders/ritual-agent-base.md'
    const instanceId = `cc-ritual-fwd-${Date.now()}`
    createClaudeCodeSubstrateAuto({
      substrate_instance_id: instanceId,
      cwd,
      appendSystemPromptFile: ritualPrompt,
    })
    const reg = registeredFor(instanceId)
    expect(reg).toBeDefined()
    expect(reg!.appendSystemPromptFile).toBe(ritualPrompt)
  })

  it('leaves appendSystemPromptFile unset when the caller omits it (chat default)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'neutron-append-fwd-'))
    const instanceId = `cc-chat-fwd-${Date.now()}`
    createClaudeCodeSubstrateAuto({ substrate_instance_id: instanceId, cwd })
    const reg = registeredFor(instanceId)
    expect(reg).toBeDefined()
    expect(reg!.appendSystemPromptFile).toBeUndefined()
  })
})
