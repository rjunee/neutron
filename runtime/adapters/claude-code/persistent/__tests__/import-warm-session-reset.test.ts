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

import { makeRecordingHost, type Timeline } from './recording-host.ts'
import { withCapturedStderr } from './capture-stderr.ts'
import { CONTEXT_RESET_COMMAND } from '../signatures.ts'
import { describe, it, expect, afterEach } from 'bun:test'
import type { AgentSpec } from '../../../../substrate.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { Event } from '../../../../events.ts'
import type { PtyHost } from '../pty-host.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

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

/** Indices of COMPLETED clears: a `/clear` text write immediately followed by an
 *  `enter` key. Both halves required — a `/clear` with no submit is a command typed
 *  at the prompt and never run, which is exactly the silent no-op herdr's
 *  `pane.send_text` would have produced. */
const CLEAR_IDXS = (t: Timeline): number[] => {
  const out: number[] = []
  for (let i = 0; i < t.length - 1; i++) {
    const e = t[i]
    const next = t[i + 1]
    if (e?.kind === 'write' && e.data === CONTEXT_RESET_COMMAND && next?.kind === 'key' && next.key === 'enter') {
      out.push(i)
    }
  }
  return out
}
const CLEARS = (t: Timeline): number => CLEAR_IDXS(t).length

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
    const firstClearIdx = CLEAR_IDXS(timeline)[0] ?? -1
    const firstMsgIdx = timeline.findIndex((e) => e.kind === 'message')
    expect(firstMsgIdx).toBeGreaterThanOrEqual(0)
    expect(firstClearIdx).toBeGreaterThan(firstMsgIdx) // no clear before turn 1

    // Every clear is the exact command text with NO trailing carriage return — the
    // submit is the `enter` key `CLEAR_IDXS` already required. A `\r` here would be
    // typed as a literal and never fire (measured on the live herdr server).
    for (const i of CLEAR_IDXS(timeline)) {
      const e = timeline[i] as { kind: 'write'; data: string }
      expect(e.data).toBe(CONTEXT_RESET_COMMAND)
      expect(e.data).not.toContain('\r')
    }
  })

  it('a REFUSED /clear is reported and the import proceeds — never silently skipped', async () => {
    // THE POOL PATH'S HALF OF IT. `context-reset.ts` returns `{status:'failed'}`, so
    // a dropped `await` there is caught by the status. HERE the policy is log +
    // proceed (a stranded import is worse than a stale context), so the ONLY thing
    // that distinguishes "cleared" from "failed to clear" is the operator-visible
    // line — which means an unawaited `submitCommand` makes a reset that never
    // happened completely invisible. What a wrong implementation gets right: the
    // import still completes, and the turns still return. So the run succeeding is
    // not the assertion; the diagnostic is.
    let out1 = ''
    const errs = await withCapturedStderr(async () => {
      const { host, timeline } = makeRecordingHost('send_keys refused')
      const sub = createPersistentReplSubstrate(opts(host, { reset_context_per_turn: true }))
      await drain(sub.start(spec('chunk-0')))
      out1 = await drain(sub.start(spec('chunk-1')))
      // Nothing was submitted — the refusal means the REPL never saw the command.
      expect(CLEARS(timeline)).toBe(0)
    })
    // The import was NOT stranded...
    expect(out1).toBe('seen=1 got=chunk-1')
    // ...and the failure was reported, with the backend's reason.
    const reported = errs.filter((e) => e.includes('context-reset /clear failed'))
    expect(reported.length).toBe(1)
    expect(reported[0]).toContain('send_keys refused')
  })

  it('CONTROL — when the submit is accepted, nothing is reported as failed', async () => {
    // Without this the case above is satisfied by a pool that reports EVERY reset as
    // failed, which is just as blind as reporting none.
    const errs = await withCapturedStderr(async () => {
      const { host, timeline } = makeRecordingHost()
      const sub = createPersistentReplSubstrate(opts(host, { reset_context_per_turn: true }))
      await drain(sub.start(spec('chunk-0')))
      await drain(sub.start(spec('chunk-1')))
      expect(CLEARS(timeline)).toBe(1)
    })
    expect(errs.filter((e) => e.includes('context-reset /clear failed'))).toEqual([])
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
