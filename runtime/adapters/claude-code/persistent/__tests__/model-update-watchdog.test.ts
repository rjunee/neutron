/**
 * model-update-watchdog.test.ts — pure-core + cadence tests for the model-update
 * watchdog + graceful upgrade (Vajra port row #16).
 *
 * The load-bearing invariants pinned here:
 *   • The probe NEVER passes `--fallback-model` (the 2026-04-16 Opus-outage →
 *     Haiku silent-downgrade trap) — pinned on both `buildProbeArgs` and the
 *     args `realProbeModel` actually hands the spawner.
 *   • A known-fallback id is treated as an OUTAGE, never a new model.
 *   • New-id detection is EDGE-triggered (notify once, then suppress within the
 *     renotify window).
 *   • The graceful upgrade respawns an idle session, leaves a busy one, and
 *     times a never-idle one out — never hard-bouncing an active turn.
 */

import { describe, it, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  buildProbeArgs,
  extractModelId,
  normalizeModelId,
  isFallbackModel,
  shouldRunModelUpdateCheck,
  decideModelUpdate,
  isSessionIdleForUpgrade,
  buildModelUpdateNoticeText,
  realProbeModel,
  runGracefulUpgrade,
  startModelUpdateWatchdog,
  loadModelUpdateState,
  saveModelUpdateState,
  MODEL_CHECK_INTERVAL_MS,
  MODEL_RENOTIFY_INTERVAL_MS,
  IDLE_QUIESCE_MS,
  JSONL_FRESH_MS,
  type ModelUpdateState,
  type ProbeResult,
  type SessionIdleSignals,
} from '../model-update-watchdog.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FALLBACKS = new Set(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-haiku-4-5'])

describe('buildProbeArgs — the --fallback-model invariant', () => {
  it('NEVER includes --fallback-model (the Opus-outage→Haiku trap)', () => {
    const args = buildProbeArgs()
    expect(args).not.toContain('--fallback-model')
  })
  it('asks the opus alias for its MODEL_ID, one-shot (-p)', () => {
    const args = buildProbeArgs()
    expect(args).toContain('-p')
    expect(args).toContain('--model')
    expect(args).toContain('opus')
    expect(args.some((a) => a.includes('MODEL_ID'))).toBe(true)
  })
})

describe('extractModelId', () => {
  it('parses the MODEL_ID line', () => {
    expect(extractModelId('blah\nMODEL_ID=claude-opus-4-8\nok')).toBe('claude-opus-4-8')
  })
  it('handles dotted/underscored/snapshot ids', () => {
    expect(extractModelId('MODEL_ID=claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
  })
  it('returns undefined when absent', () => {
    expect(extractModelId('I am Claude, an AI assistant.')).toBeUndefined()
  })
})

describe('normalizeModelId', () => {
  it('strips a trailing -YYYYMMDD snapshot suffix', () => {
    expect(normalizeModelId('claude-opus-4-7-20260101')).toBe('claude-opus-4-7')
    expect(normalizeModelId('claude-opus-4-7')).toBe('claude-opus-4-7')
  })
})

describe('isFallbackModel', () => {
  it('recognizes a known fallback (the downgrade guard)', () => {
    expect(isFallbackModel('claude-haiku-4-5-20251001', FALLBACKS)).toBe(true)
    expect(isFallbackModel('claude-sonnet-4-6', FALLBACKS)).toBe(true)
  })
  it('recognizes a snapshot variant of a fallback', () => {
    expect(isFallbackModel('claude-sonnet-4-6-20260101', FALLBACKS)).toBe(true)
  })
  it('does NOT flag a genuine top-tier id', () => {
    expect(isFallbackModel('claude-opus-4-8', FALLBACKS)).toBe(false)
  })
})

describe('shouldRunModelUpdateCheck — the 6h gate', () => {
  it('runs when never checked', () => {
    expect(shouldRunModelUpdateCheck(1_000_000, {})).toBe(true)
  })
  it('blocks within the interval', () => {
    const now = 10_000_000
    const state: ModelUpdateState = { last_checked_at: new Date(now - 60_000).toISOString() }
    expect(shouldRunModelUpdateCheck(now, state)).toBe(false)
  })
  it('runs after the interval', () => {
    const now = 10_000_000
    const state: ModelUpdateState = {
      last_checked_at: new Date(now - MODEL_CHECK_INTERVAL_MS - 1).toISOString(),
    }
    expect(shouldRunModelUpdateCheck(now, state)).toBe(true)
  })
  it('fails open on a corrupt timestamp', () => {
    expect(shouldRunModelUpdateCheck(1_000, { last_checked_at: 'not-a-date' })).toBe(true)
  })
})

describe('decideModelUpdate', () => {
  const now = 1_700_000_000_000
  const ok = (model: string): ProbeResult => ({ ok: true, model })

  it('probe failure → probe-failed (retry next tick, no gate advance)', () => {
    const d = decideModelUpdate({
      probe: { ok: false, error: 'boom' },
      configuredModel: 'claude-opus-4-7',
      state: {},
      knownFallbacks: FALLBACKS,
      now,
    })
    expect(d.action).toBe('probe-failed')
  })

  it('THE TRAP: a fallback id (Opus outage leaking Haiku) → skip-outage, NEVER a new model', () => {
    const d = decideModelUpdate({
      probe: ok('claude-haiku-4-5-20251001'),
      configuredModel: 'claude-opus-4-7',
      state: {},
      knownFallbacks: FALLBACKS,
      now,
    })
    expect(d.action).toBe('skip-outage')
  })

  it('probed == configured → no-change (+ seeds last_known on first run)', () => {
    const d = decideModelUpdate({
      probe: ok('claude-opus-4-7'),
      configuredModel: 'claude-opus-4-7',
      state: {},
      knownFallbacks: FALLBACKS,
      now,
    })
    expect(d).toEqual({ action: 'no-change', current: 'claude-opus-4-7', seed: 'claude-opus-4-7' })
  })

  it('THE INCIDENT: configured 4-6 while 4-7 already shipped → notify on the FIRST probe', () => {
    const d = decideModelUpdate({
      probe: ok('claude-opus-4-7'),
      configuredModel: 'claude-opus-4-6',
      state: {},
      knownFallbacks: FALLBACKS,
      now,
    })
    expect(d).toMatchObject({ action: 'notify', kind: 'initial', newModel: 'claude-opus-4-7', oldModel: 'claude-opus-4-6' })
  })

  it('snapshot variant of the configured model is NOT a new model', () => {
    const d = decideModelUpdate({
      probe: ok('claude-opus-4-7-20260101'),
      configuredModel: 'claude-opus-4-7',
      state: { last_known_model: 'claude-opus-4-7' },
      knownFallbacks: FALLBACKS,
      now,
    })
    expect(d.action).toBe('no-change')
  })

  it('EDGE: same new id already notified within the window → suppress (fires once)', () => {
    const d = decideModelUpdate({
      probe: ok('claude-opus-4-8'),
      configuredModel: 'claude-opus-4-7',
      state: {
        last_known_model: 'claude-opus-4-7',
        last_notified_model: 'claude-opus-4-8',
        last_notified_at: new Date(now - 60_000).toISOString(),
      },
      knownFallbacks: FALLBACKS,
      now,
    })
    expect(d.action).toBe('suppress')
  })

  it('re-nags (renotify) after the renotify interval', () => {
    const d = decideModelUpdate({
      probe: ok('claude-opus-4-8'),
      configuredModel: 'claude-opus-4-7',
      state: {
        last_known_model: 'claude-opus-4-7',
        last_notified_model: 'claude-opus-4-8',
        last_notified_at: new Date(now - MODEL_RENOTIFY_INTERVAL_MS - 1).toISOString(),
      },
      knownFallbacks: FALLBACKS,
      now,
    })
    expect(d).toMatchObject({ action: 'notify', kind: 'renotify' })
  })

  it('a SECOND newer model inside the window notifies immediately (no stale ack)', () => {
    const d = decideModelUpdate({
      probe: ok('claude-opus-4-9'),
      configuredModel: 'claude-opus-4-7',
      state: {
        last_known_model: 'claude-opus-4-7',
        last_notified_model: 'claude-opus-4-8',
        last_notified_at: new Date(now - 60_000).toISOString(),
      },
      knownFallbacks: FALLBACKS,
      now,
    })
    expect(d).toMatchObject({ action: 'notify', kind: 'initial', newModel: 'claude-opus-4-9' })
  })
})

describe('isSessionIdleForUpgrade — the idle gate', () => {
  const now = 2_000_000
  const base: SessionIdleSignals = {
    isTyping: false,
    hasToolPromptPending: false,
    lastDataAt: now - IDLE_QUIESCE_MS - 1,
    jsonlMtimeMs: now - JSONL_FRESH_MS - 1,
  }
  it('all four gates satisfied → idle', () => {
    expect(isSessionIdleForUpgrade(base, now)).toBe(true)
  })
  it('mid-turn (typing) → NOT idle (never hard-bounce an active turn)', () => {
    expect(isSessionIdleForUpgrade({ ...base, isTyping: true }, now)).toBe(false)
  })
  it('a tool-use prompt pending → NOT idle', () => {
    expect(isSessionIdleForUpgrade({ ...base, hasToolPromptPending: true }, now)).toBe(false)
  })
  it('assistant not quiet long enough → NOT idle', () => {
    expect(isSessionIdleForUpgrade({ ...base, lastDataAt: now - 1_000 }, now)).toBe(false)
  })
  it('JSONL still fresh → NOT idle', () => {
    expect(isSessionIdleForUpgrade({ ...base, jsonlMtimeMs: now - 1_000 }, now)).toBe(false)
  })
  it('unknown (null) signals are treated as satisfied', () => {
    expect(isSessionIdleForUpgrade({ ...base, lastDataAt: null, jsonlMtimeMs: null }, now)).toBe(true)
  })
})

describe('buildModelUpdateNoticeText', () => {
  it('names the new model and prior model', () => {
    const t = buildModelUpdateNoticeText('claude-opus-4-8', 'claude-opus-4-7')
    expect(t).toContain('claude-opus-4-8')
    expect(t).toContain('claude-opus-4-7')
  })
})

// A fake `child_process.spawn` that emits `stdout` then closes.
function fakeSpawn(
  stdout: string,
  opts?: { exitCode?: number; capture?: (args: readonly string[]) => void },
): typeof import('node:child_process').spawn {
  return ((_bin: string, args: readonly string[]) => {
    opts?.capture?.(args)
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', opts?.exitCode ?? 0)
    })
    return child
  }) as unknown as typeof import('node:child_process').spawn
}

describe('realProbeModel', () => {
  it('parses MODEL_ID from stdout AND passes NO --fallback-model to the spawner', async () => {
    let captured: readonly string[] = []
    const res = await realProbeModel({
      spawn: fakeSpawn('MODEL_ID=claude-opus-4-8\n', { capture: (a) => (captured = a) }),
    })
    expect(res).toEqual({ ok: true, model: 'claude-opus-4-8' })
    expect(captured).not.toContain('--fallback-model')
    expect(captured).toContain('opus')
  })
  it('reports failure when no MODEL_ID is present', async () => {
    const res = await realProbeModel({ spawn: fakeSpawn('I am Claude.\n', { exitCode: 0 }) })
    expect(res.ok).toBe(false)
  })
})

describe('runGracefulUpgrade — round-robin, idle-gated, bounded', () => {
  const noSleep = (_ms: number) => Promise.resolve()

  it('respawns sessions that are idle', async () => {
    const upgraded: string[] = []
    const res = await runGracefulUpgrade({
      listSessionKeys: () => ['a', 'b'],
      idleSignals: () => ({ isTyping: false, hasToolPromptPending: false, lastDataAt: null, jsonlMtimeMs: null }),
      upgradeSession: (k) => {
        upgraded.push(k)
        return true
      },
      sleep: noSleep,
      now: () => 0,
    })
    expect(res.upgraded.sort()).toEqual(['a', 'b'])
    expect(upgraded.sort()).toEqual(['a', 'b'])
  })

  it('waits for a busy session to go idle, then upgrades it (no head-of-line block)', async () => {
    let t = 0
    let bIdleAfter = 3
    let polls = 0
    const fired: string[] = []
    const res = await runGracefulUpgrade({
      listSessionKeys: () => ['a', 'b'],
      idleSignals: (k) => {
        if (k === 'a') return { isTyping: false, hasToolPromptPending: false, lastDataAt: null, jsonlMtimeMs: null }
        // 'b' is busy for the first few polls.
        return { isTyping: polls < bIdleAfter, hasToolPromptPending: false, lastDataAt: null, jsonlMtimeMs: null }
      },
      upgradeSession: (k) => {
        fired.push(k)
        return true
      },
      sleep: async () => {
        polls += 1
        t += 5
      },
      now: () => t,
      perSessionTimeoutMs: 1_000_000,
    })
    expect(res.upgraded).toContain('a')
    expect(res.upgraded).toContain('b')
    // 'a' (idle from the start) upgraded before 'b' went idle.
    expect(fired[0]).toBe('a')
  })

  it('leaves a never-idle session on the old model (timed out, not force-killed)', async () => {
    let t = 0
    const res = await runGracefulUpgrade({
      listSessionKeys: () => ['stuck'],
      idleSignals: () => ({ isTyping: true, hasToolPromptPending: false, lastDataAt: null, jsonlMtimeMs: null }),
      upgradeSession: () => {
        throw new Error('should not upgrade a busy session')
      },
      sleep: async () => {
        t += 100
      },
      now: () => t,
      perSessionTimeoutMs: 250,
    })
    expect(res.timedOut).toEqual(['stuck'])
    expect(res.upgraded).toEqual([])
  })

  it('skips a session that vanishes before upgrade', async () => {
    const res = await runGracefulUpgrade({
      listSessionKeys: () => ['gone'],
      idleSignals: () => null,
      upgradeSession: () => true,
      sleep: noSleep,
      now: () => 0,
    })
    expect(res.skipped).toEqual(['gone'])
  })
})

describe('startModelUpdateWatchdog — the cadence + adopt path', () => {
  function harness(probe: ProbeResult, state: ModelUpdateState = {}) {
    let saved: ModelUpdateState = { ...state }
    const notices: Array<{ newModel: string; oldModel: string }> = []
    const adopted: string[] = []
    const upgrades: string[] = []
    const wd = startModelUpdateWatchdog({
      probeModel: () => Promise.resolve(probe),
      loadState: () => saved,
      saveState: (s) => (saved = s),
      getConfiguredModel: () => 'claude-opus-4-7',
      adoptModel: (m) => adopted.push(m),
      knownFallbacks: () => FALLBACKS,
      postNotice: (n) => notices.push({ newModel: n.newModel, oldModel: n.oldModel }),
      runUpgrade: (m) => {
        upgrades.push(m)
      },
      checkIntervalMs: 0, // gate always open so we can drive ticks directly
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
      now: () => 1_700_000_000_000,
    })
    return { wd, notices, adopted, upgrades, getState: () => saved }
  }

  it('on a new model: notifies once, adopts it, kicks the upgrade, persists state', async () => {
    const h = harness({ ok: true, model: 'claude-opus-4-8' })
    await h.wd.tick()
    expect(h.notices).toEqual([{ newModel: 'claude-opus-4-8', oldModel: 'claude-opus-4-7' }])
    expect(h.adopted).toEqual(['claude-opus-4-8'])
    expect(h.upgrades).toEqual(['claude-opus-4-8'])
    expect(h.getState().last_known_model).toBe('claude-opus-4-8')
    expect(h.getState().last_notified_model).toBe('claude-opus-4-8')
    h.wd.stop()
  })

  it('EDGE: a second tick after adoption does NOT re-notify', async () => {
    const h = harness({ ok: true, model: 'claude-opus-4-8' })
    await h.wd.tick()
    await h.wd.tick()
    expect(h.notices).toHaveLength(1)
    expect(h.adopted).toHaveLength(1)
    h.wd.stop()
  })

  it('a probe failure does NOT advance last_checked_at (so the next tick retries)', async () => {
    const h = harness({ ok: false, error: 'opus down' })
    await h.wd.tick()
    expect(h.getState().last_checked_at).toBeUndefined()
    expect(h.notices).toEqual([])
    h.wd.stop()
  })

  it('a fallback id (outage) does NOT advance the gate and never adopts', async () => {
    const h = harness({ ok: true, model: 'claude-haiku-4-5-20251001' })
    await h.wd.tick()
    expect(h.getState().last_checked_at).toBeUndefined()
    expect(h.adopted).toEqual([])
    expect(h.notices).toEqual([])
    h.wd.stop()
  })

  it('RESTART: re-applies a persisted adopted model on start (Codex P1)', async () => {
    // Simulate a restart after a prior adoption: state has last_known_model set to
    // the newer model, but the process-local override is back to undefined.
    const h = harness(
      { ok: true, model: 'claude-opus-4-8' },
      { last_known_model: 'claude-opus-4-8', last_checked_at: new Date(1_700_000_000_000).toISOString() },
    )
    // The override was re-applied at startup (before any tick fired).
    expect(h.adopted).toEqual(['claude-opus-4-8'])
    h.wd.stop()
  })

  it('RESTART: a plain seed (persisted == configured) does NOT pin an override', async () => {
    const h = harness(
      { ok: true, model: 'claude-opus-4-7' },
      { last_known_model: 'claude-opus-4-7' },
    )
    expect(h.adopted).toEqual([]) // last_known == configured → no-op
    h.wd.stop()
  })

  it('RESTART: never re-applies a persisted FALLBACK id', async () => {
    const h = harness(
      { ok: true, model: 'claude-opus-4-7' },
      { last_known_model: 'claude-haiku-4-5-20251001' },
    )
    expect(h.adopted).toEqual([])
    h.wd.stop()
  })

  it('no-change advances the gate + seeds last_known', async () => {
    const h = harness({ ok: true, model: 'claude-opus-4-7' })
    await h.wd.tick()
    expect(h.getState().last_checked_at).toBeDefined()
    expect(h.getState().last_known_model).toBe('claude-opus-4-7')
    expect(h.notices).toEqual([])
    h.wd.stop()
  })
})

describe('state persistence', () => {
  it('round-trips through disk and tolerates an absent file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neutron-mu-state-'))
    try {
      const p = join(dir, 'state.json')
      expect(loadModelUpdateState(p)).toEqual({})
      const s: ModelUpdateState = { last_known_model: 'claude-opus-4-8', last_checked_at: 'x' }
      saveModelUpdateState(p, s)
      expect(loadModelUpdateState(p)).toEqual(s)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
