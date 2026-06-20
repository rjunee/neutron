/**
 * build-gbrain-memory — per-instance GBrain memory wiring.
 *
 * Covers the scoping logic (`resolveGbrainClientOptions`) and that
 * `buildGBrainMemory` returns the live trio (client + memoryStore + syncHook +
 * close) that the composer threads into the admin surface (browse) and the
 * landing stack (`importGbrainSyncHook`).
 */

import { describe, test, expect } from 'bun:test'
import {
  buildGBrainMemory,
  resolveGbrainClientOptions,
} from '../build-gbrain-memory.ts'

describe('resolveGbrainClientOptions', () => {
  test('GBRAIN_HOME is the per-project <owner_home>/gbrain boundary', () => {
    const opts = resolveGbrainClientOptions({ owner_home: '/srv/owners/acme', env: {} })
    expect(opts.env).toEqual({ GBRAIN_HOME: '/srv/owners/acme/gbrain' })
  })

  test('source defaults to "default" and brainId is omitted when env is unset', () => {
    const opts = resolveGbrainClientOptions({ owner_home: '/t', env: {} })
    expect(opts.source).toBe('default')
    expect(opts.brainId).toBeUndefined()
  })

  test('honors operator-provided GBRAIN_SOURCE + GBRAIN_BRAIN_ID', () => {
    const opts = resolveGbrainClientOptions({
      owner_home: '/t',
      env: { GBRAIN_SOURCE: 'projects', GBRAIN_BRAIN_ID: 'acme-brain' },
    })
    expect(opts.source).toBe('projects')
    expect(opts.brainId).toBe('acme-brain')
  })

  test('blank GBRAIN_SOURCE falls back to "default"', () => {
    const opts = resolveGbrainClientOptions({ owner_home: '/t', env: { GBRAIN_SOURCE: '' } })
    expect(opts.source).toBe('default')
  })
})

describe('buildGBrainMemory', () => {
  test('returns the live trio + a close() that resolves', async () => {
    const wiring = buildGBrainMemory({
      owner_home: '/srv/owners/acme',
      project_slug: 'acme',
      env: {},
    })
    expect(wiring.client).toBeDefined()
    expect(typeof wiring.memoryStore.query).toBe('function')
    expect(typeof wiring.syncHook.onEntityWrite).toBe('function')
    // close() never spawned a child (lazy connect), so it resolves cleanly.
    await expect(wiring.close()).resolves.toBeUndefined()
  })
})
