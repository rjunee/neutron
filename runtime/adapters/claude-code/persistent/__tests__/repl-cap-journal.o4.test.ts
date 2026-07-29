/**
 * O4 — repl_session_capped degrade journal (rising edge).
 *
 * When a REPL trips its restart-rate hard cap, auto-recovery latches OFF
 * (capped_at set) and every subsequent respawn attempt returns 'capped'. O4
 * emits ONE `repl_session_capped` row on the healthy→capped TRIP edge only —
 * not on the already-capped short-circuit. VISIBILITY ONLY: the cap decision
 * (return spawn-failed) is unchanged.
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  registerSystemEventSink,
  type SystemEventInput,
  type SystemEventSink,
} from '@neutronai/persistence/index.ts'
import { respawnReplSession } from '../supervision.ts'
import { RESPAWN_CAP_MAX } from '../signatures.ts'
import { getRecord, upsertRecord } from '../repl-registry.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'

function fakeSink(): { rows: SystemEventInput[]; sink: SystemEventSink } {
  const rows: SystemEventInput[] = []
  return {
    rows,
    sink: {
      record(input: SystemEventInput) {
        rows.push(input)
        return { id: String(rows.length) }
      },
    },
  }
}

const dirs: string[] = []
afterEach(() => {
  registerSystemEventSink(null)
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

function seedAtCapThreshold(registryPath: string, sessionKey: string): void {
  const now = Date.now()
  // RESPAWN_CAP_MAX recent respawns inside the window → the next respawn trips.
  const recent = Array.from({ length: RESPAWN_CAP_MAX }, (_v, i) => now - i * 1000)
  upsertRecord(registryPath, {
    sessionKey,
    sessionId: 'sess-1',
    cwd: '/tmp/x',
    channelName: 'chan-1',
    has_session: true,
    recent_respawns: recent,
  })
}

test('O4 — the cap trip emits ONE repl_session_capped row; the already-capped short-circuit emits NOTHING', () => {
  const { rows, sink } = fakeSink()
  registerSystemEventSink(sink)
  const dir = mkdtempSync(join(tmpdir(), 'o4-repl-'))
  dirs.push(dir)
  const registryPath = join(dir, 'repl-registry.json')
  const sessionKey = 'cc-agent-x\0/tmp/x'
  seedAtCapThreshold(registryPath, sessionKey)

  const options = { replRegistryPath: registryPath } as unknown as PersistentReplSubstrateOptions

  // First call — trips the cap (healthy→capped rising edge) → emit #1.
  const r1 = respawnReplSession(options, sessionKey, 'wedge-watchdog', 'health-dead')
  expect(r1.ok).toBe(false)
  expect(getRecord(registryPath, sessionKey)?.capped_at).toBeDefined()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ event: 'repl_session_capped', module: 'repl' })
  expect(rows[0]?.payload).toMatchObject({ session_key: sessionKey })

  // Second call — already capped (capped_at set) → returns capped, NO new emit.
  const r2 = respawnReplSession(options, sessionKey, 'wedge-watchdog', 'health-dead')
  expect(r2.ok).toBe(false)
  expect(rows).toHaveLength(1)
})

test('O4 — a session BELOW the cap threshold does not trip and emits NOTHING', () => {
  const { rows, sink } = fakeSink()
  registerSystemEventSink(sink)
  const dir = mkdtempSync(join(tmpdir(), 'o4-repl-'))
  dirs.push(dir)
  const registryPath = join(dir, 'repl-registry.json')
  const sessionKey = 'cc-agent-y\0/tmp/y'
  // No recent respawns → recentRespawnCount 0 → below cap → 'go' (not capped).
  upsertRecord(registryPath, {
    sessionKey,
    sessionId: 'sess-2',
    cwd: '/tmp/y',
    channelName: 'chan-2',
    has_session: true,
    recent_respawns: [],
  })
  const options = { replRegistryPath: registryPath } as unknown as PersistentReplSubstrateOptions
  // Below-cap path proceeds past the cap gate (it will fail later for lack of a
  // real host, but it must NOT emit repl_session_capped).
  try {
    respawnReplSession(options, sessionKey, 'wedge-watchdog', 'health-dead')
  } catch {
    // downstream spawn machinery is unwired in this minimal harness — irrelevant
    // to the cap-gate assertion below.
  }
  expect(rows.filter((r) => r.event === 'repl_session_capped')).toHaveLength(0)
})
