/**
 * gateway-shutdown-survival.test.ts — #539 seam 4: which children outlive a shutdown.
 *
 * THE KILL BEING GATED IS NOT DECORATIVE. `shutdownAllPersistentRepls` terminates the
 * whole warm pool because, under the old unit config, every descendant reparented to
 * init on each restart and accumulated — 632 processes, ~19 GB, 2026-06-11. A herdr
 * pane is not in the gateway's cgroup, so for those children this polite kill was the
 * ONLY thing ending them: removing it without a replacement recreates the incident
 * exactly. The replacement is the requirement these cases pin — a child may be left
 * running ONLY when a persisted row names its pane and its generation, which is
 * precisely the state that lets the next boot find it and decide about it.
 *
 * Both directions, because a gate that survives nothing passes every "it kills" case:
 * the survive arm is asserted by the absence of a kill AND the absence of a config
 * unlink (deleting a live child's `--mcp-config` would leave it wired to nothing).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shutdownSurvivalVerdict } from '../gateway-shutdown-survival.ts'
import { pool, sink, supervisedBySessionKey } from '../pool-state.ts'
import { shutdownAllPersistentRepls } from '../pool.ts'
import { ReplSession } from '../repl-session.ts'
import type { ReplRegistry, ReplRegistryRecord } from '../repl-registry.ts'
import type { PtyChild } from '../pty-host.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'

const KEY = 'inst user proj cred'
const SESSION_ID = 'dddddddd-1111-2222-3333-444444444444'
const CHANNEL = 'neutron-aaaabbbbccccddddeeeeffff00001111'
const GENERATION = 'gen-shutdown-1'
const HANDLE = 'w9:p5'

const row = (over: Partial<ReplRegistryRecord> = {}): ReplRegistryRecord => ({
  sessionKey: KEY,
  sessionId: SESSION_ID,
  cwd: '/tmp',
  channelName: CHANNEL,
  has_session: true,
  child_generation: GENERATION,
  pane_handle: HANDLE,
  ...over,
})

describe('shutdownSurvivalVerdict', () => {
  it('SURVIVES when a row names this exact pane and this exact generation', () => {
    const v = shutdownSurvivalVerdict({
      paneHandle: HANDLE,
      childGeneration: GENERATION,
      record: row(),
    })
    expect(v).toEqual({ kind: 'survive', handle: HANDLE })
  })

  it('kills a child with no durable handle — it dies with us either way', () => {
    const v = shutdownSurvivalVerdict({
      paneHandle: undefined,
      childGeneration: GENERATION,
      record: row(),
    })
    expect(v.kind).toBe('kill')
    expect(v.kind === 'kill' && v.reason).toContain('no durable handle')
  })

  it('kills a child no row names — nothing would ever look for it again', () => {
    const v = shutdownSurvivalVerdict({
      paneHandle: HANDLE,
      childGeneration: GENERATION,
      record: undefined,
    })
    expect(v.kind).toBe('kill')
  })

  it('kills a child whose row names a DIFFERENT pane', () => {
    const v = shutdownSurvivalVerdict({
      paneHandle: HANDLE,
      childGeneration: GENERATION,
      record: row({ pane_handle: 'w9:p999' }),
    })
    expect(v.kind).toBe('kill')
  })

  it('kills a child whose row carries no pane handle at all', () => {
    const { pane_handle: _dropped, ...withoutHandle } = row()
    const v = shutdownSurvivalVerdict({
      paneHandle: HANDLE,
      childGeneration: GENERATION,
      record: withoutHandle as ReplRegistryRecord,
    })
    expect(v.kind).toBe('kill')
  })

  it('kills a child whose row describes a DIFFERENT generation — its credential could not be reproduced', () => {
    const v = shutdownSurvivalVerdict({
      paneHandle: HANDLE,
      childGeneration: GENERATION,
      record: row({ child_generation: 'some-older-generation' }),
    })
    expect(v.kind).toBe('kill')
    expect(v.kind === 'kill' && v.reason).toContain('credential')
  })
})

// ─── Through the real teardown ───────────────────────────────────────────────

const dirs: string[] = []
function registryWith(record: ReplRegistryRecord | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-539-shutdown-'))
  dirs.push(dir)
  const path = join(dir, 'repl-registry.json')
  const registry: ReplRegistry = record === undefined ? {} : { [KEY]: record }
  writeFileSync(path, JSON.stringify(registry, null, 2))
  return path
}

interface FakeChild extends PtyChild {
  killed: boolean
}

function pooledSession(paneHandle: string | undefined, configPath: string): { session: ReplSession; child: FakeChild } {
  const session = new ReplSession(KEY, GENERATION, SESSION_ID, CHANNEL, '/tmp')
  session.configPaths = [configPath]
  const child = {
    pid: 4242,
    ...(paneHandle !== undefined ? { paneHandle } : {}),
    killed: false,
    write() {},
    kill() {
      ;(child as FakeChild).killed = true
    },
    exited: new Promise<number | null>(() => {}),
    hasExited: () => false,
  } as unknown as FakeChild
  session.attachChild(child)
  return { session, child }
}

afterEach(() => {
  supervisedBySessionKey.clear()
  pool.clear()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('shutdownAllPersistentRepls', () => {
  it('LEAVES a findable herdr-hosted child alive, and leaves its config files in place', async () => {
    const registryPath = registryWith(row())
    const configPath = join(dirs[dirs.length - 1] as string, 'session-mcp.json')
    writeFileSync(configPath, '{}')
    const { session, child } = pooledSession(HANDLE, configPath)
    pool.set(KEY, Promise.resolve(session))
    supervisedBySessionKey.set(KEY, { replRegistryPath: registryPath } as unknown as PersistentReplSubstrateOptions)
    sink.register(SESSION_ID, session)

    await shutdownAllPersistentRepls()

    expect(child.killed).toBe(false)
    // The live child's `--mcp-config` must still exist: it is still using it.
    expect(await Bun.file(configPath).exists()).toBe(true)
  })

  it('KILLS the same child when no row names its pane', async () => {
    const registryPath = registryWith(undefined)
    const configPath = join(dirs[dirs.length - 1] as string, 'session-mcp.json')
    writeFileSync(configPath, '{}')
    const { session, child } = pooledSession(HANDLE, configPath)
    pool.set(KEY, Promise.resolve(session))
    supervisedBySessionKey.set(KEY, { replRegistryPath: registryPath } as unknown as PersistentReplSubstrateOptions)

    await shutdownAllPersistentRepls()

    expect(child.killed).toBe(true)
    expect(await Bun.file(configPath).exists()).toBe(false)
  })

  it('KILLS a child whose host issued no handle, however good the row is', async () => {
    const registryPath = registryWith(row())
    const configPath = join(dirs[dirs.length - 1] as string, 'session-mcp.json')
    writeFileSync(configPath, '{}')
    const { session, child } = pooledSession(undefined, configPath)
    pool.set(KEY, Promise.resolve(session))
    supervisedBySessionKey.set(KEY, { replRegistryPath: registryPath } as unknown as PersistentReplSubstrateOptions)

    await shutdownAllPersistentRepls()

    expect(child.killed).toBe(true)
  })
})
