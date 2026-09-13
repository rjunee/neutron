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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { claimShutdownSurvival, shutdownSurvivalVerdict } from '../gateway-shutdown-survival.ts'
import { pool, sink, supervisedBySessionKey } from '../pool-state.ts'
import { shutdownAllPersistentRepls } from '../pool.ts'
import { ReplSession } from '../repl-session.ts'
import type { ReplRegistry, ReplRegistryRecord } from '../repl-registry.ts'
import { withRegistryRead } from '../repl-registry.ts'
import { setFlockImplForTests } from '../registry-lock.ts'
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


describe('the survival decision is taken UNDER THE LOCK, against the row that is there now', () => {
  /**
   * ARGUS r7 BLOCKER. The shutdown path took an unlocked `getRecord` snapshot and then
   * decided from it. A registry is shared across PROCESSES — that is why every writer
   * takes a flock — so an unlocked read orders this decision against a concurrent
   * writer by nothing at all:
   *
   *   A writes (H1,G1) → A snapshots (H1,G1) → B writes (H2,G2) → A leaves H1 alive.
   *
   * The only durable row then names H2, so nothing will ever look for H1 again. That is
   * the 2026-06-11 orphan in its herdr-shaped form, and it is the same defect this
   * branch already fixed in `clearPaneHandleIfUnchanged` and `claimRowOrUnwind`.
   *
   * THE DECISION IS HELD OPEN, which is the only way to construct the race. The
   * injected reader replaces the row on disk and THEN delegates to the REAL
   * `withRegistryRead`, so the row the decision sees genuinely comes off disk under the
   * real flock — a mock returning a literal would prove only that a mock was called.
   */
  it('KILLS when another incarnation replaced the row inside the decision', () => {
    const registryPath = registryWith(row())
    let replaced = false
    const verdict = claimShutdownSurvival({
      registryPath,
      sessionKey: KEY,
      paneHandle: HANDLE,
      childGeneration: GENERATION,
      deps: {
        withRegistryRead: (path, read, onOutcome) => {
          // B wins the lock immediately before us and takes the key for its own child.
          writeFileSync(
            path,
            JSON.stringify({ [KEY]: { ...row(), pane_handle: 'w9:p-NEWER', child_generation: 'gen-newer' } }),
          )
          replaced = true
          // The outcome is FORWARDED, not swallowed: a wrapper that dropped it would
          // report "lock not acquired" and this case would pass for the wrong reason.
          return withRegistryRead(path, read, onOutcome)
        },
      },
    })
    expect(replaced).toBe(true)
    expect(verdict.kind).toBe('kill')
    // The reason must name the ROW's pane, not ours — that is what shows the decision
    // read the new row rather than the snapshot it started from.
    expect(verdict.kind === 'kill' && verdict.reason).toMatch(/w9:p-NEWER/)
  })

  it('and KILLS when the replacement keeps the pane but moves the generation', () => {
    // A pane id the herdr server reissued is the same recycling hazard a pid has: the
    // handle alone cannot tell two children apart, so the generation is compared too.
    const registryPath = registryWith(row())
    const verdict = claimShutdownSurvival({
      registryPath,
      sessionKey: KEY,
      paneHandle: HANDLE,
      childGeneration: GENERATION,
      deps: {
        withRegistryRead: (path, read, onOutcome) => {
          writeFileSync(path, JSON.stringify({ [KEY]: { ...row(), child_generation: 'gen-newer' } }))
          return withRegistryRead(path, read, onOutcome)
        },
      },
    })
    expect(verdict.kind).toBe('kill')
    expect(verdict.kind === 'kill' && verdict.reason).toMatch(/generation/i)
  })

  it('THE POSITIVE CONTROL: an uncontended decision still survives', () => {
    // A gate that killed unconditionally would satisfy both cases above and deliver
    // nothing. With nobody racing, the same call must leave the child alive.
    const registryPath = registryWith(row())
    const verdict = claimShutdownSurvival({
      registryPath,
      sessionKey: KEY,
      paneHandle: HANDLE,
      childGeneration: GENERATION,
    })
    expect(verdict).toEqual({ kind: 'survive', handle: HANDLE })
  })

  it('a child with no handle never takes the lock, and a missing registry is still a kill', () => {
    let took = 0
    const noHandle = claimShutdownSurvival({
      registryPath: registryWith(row()),
      sessionKey: KEY,
      paneHandle: undefined,
      childGeneration: GENERATION,
      deps: {
        withRegistryRead: (path, read, onOutcome) => {
          took += 1
          return withRegistryRead(path, read, onOutcome)
        },
      },
    })
    expect(noHandle.kind).toBe('kill')
    expect(took).toBe(0)
    // No registry configured is not an empty registry, and both are a kill.
    const noRegistry = claimShutdownSurvival({
      registryPath: undefined,
      sessionKey: KEY,
      paneHandle: HANDLE,
      childGeneration: GENERATION,
    })
    expect(noRegistry.kind).toBe('kill')
  })

  it('withRegistryRead does NOT write the registry back', () => {
    // The reason it exists rather than a `withRegistry` whose mutate returns its input:
    // a byte-identical rewrite of every row is a write the shutdown path has no business
    // performing. Byte comparison, because a re-serialised file can differ in whitespace
    // alone and still be a write.
    // WRITTEN COMPACTLY ON PURPOSE. `saveRegistry` pretty-prints, so a fixture that is
    // already pretty-printed would survive a stray save byte-for-byte and this case
    // would pass against a helper that writes. The formatting is the witness.
    const registryPath = registryWith(row())
    writeFileSync(registryPath, JSON.stringify({ [KEY]: row() }))
    const bytesBefore = readFileSync(registryPath, 'utf8')
    expect(bytesBefore).not.toContain('\n')
    const seen = withRegistryRead(registryPath, (registry) => registry[KEY]?.pane_handle)
    expect(seen).toBe(HANDLE)
    expect(readFileSync(registryPath, 'utf8')).toBe(bytesBefore)
  })
})


describe('the survival decision FAILS CLOSED — a lock it cannot take is not a lock', () => {
  /**
   * ARGUS r8 BLOCKERS, and they are one defect in two places: the lock path can fail,
   * and on failure the decision must not stay permissive.
   *
   * THE TWO OUTCOMES ARE NOT SYMMETRIC, which is the whole argument. The child here is
   * OURS and we hold its handle, so killing it carries none of the recycled-identifier
   * risk this module family exists to guard — the cost is one respawn at the next boot.
   * The cost of a wrong `survive` is a process nothing will ever look for again, writing
   * a second stream into a transcript another owner holds. When one outcome is
   * recoverable and the other is not, the tie does not go to the permissive branch.
   */
  afterEach(() => setFlockImplForTests(undefined))

  it('a READ THAT THROWS is a kill, and says so in words a row-mismatch never uses', () => {
    const verdict = claimShutdownSurvival({
      registryPath: registryWith(row()),
      sessionKey: KEY,
      paneHandle: HANDLE,
      childGeneration: GENERATION,
      deps: {
        withRegistryRead: () => {
          // The real shape: `openSync` on the lock raises ENXIO / ELOOP / EACCES, and
          // the lock throws outright when its path is not a regular file.
          throw new Error('registry-lock: lock path is not a regular file: /x/.registry.lock')
        },
      },
    })
    expect(verdict.kind).toBe('kill')
    const reason = verdict.kind === 'kill' ? verdict.reason : ''
    // "could not read the registry" and "no row names this pane" are different facts.
    // Unknown must not print false's sentence.
    expect(reason).toMatch(/could NOT BE READ/)
    expect(reason).not.toMatch(/no persisted row names/)
  })

  it('AND THE POOL ACTS ON IT: teardown kills that child instead of skipping past it', async () => {
    // The unit verdict alone cannot prove this. The bug was that the exception never
    // REACHED a verdict: it escaped into teardown's own `catch {}`, which swallowed it
    // and skipped the kill, the sink unregister and the config unlink. So the case has
    // to be driven through the real `shutdownAllPersistentRepls`.
    //
    // The lock is made to throw the way production would — the lock path is a DIRECTORY,
    // so `openSync` fails on it — rather than by injecting a fake, because the seam the
    // pool uses has no dependency injection at all.
    const registryPath = registryWith(row())
    mkdirSync(join(dirname(registryPath), '.registry.lock'), { recursive: true })
    const configPath = join(dirname(registryPath), 'session-mcp.json')
    writeFileSync(configPath, '{}')
    const { session, child } = pooledSession(HANDLE, configPath)
    pool.set(KEY, Promise.resolve(session))
    supervisedBySessionKey.set(KEY, { replRegistryPath: registryPath } as unknown as PersistentReplSubstrateOptions)

    await shutdownAllPersistentRepls()

    expect(child.killed).toBe(true)
    // And the teardown it used to skip past ran too.
    expect(await Bun.file(configPath).exists()).toBe(false)
  })

  it('a REAL flock that does not grant the lock is a kill, on a row that would otherwise survive', () => {
    // THE ROW MATCHES. That is what makes this case about the lock and not about the
    // row: without the override the very same call returns `survive` — the positive
    // control below runs it. The fake is the flock SYSCALL only; `withFlockSync` and
    // `withRegistryRead` are the real ones, so this distinguishes "decided under the
    // lock" from "decided", which a mocked reader could not.
    const registryPath = registryWith(row())
    setFlockImplForTests(() => 1)
    const verdict = claimShutdownSurvival({
      registryPath,
      sessionKey: KEY,
      paneHandle: HANDLE,
      childGeneration: GENERATION,
    })
    expect(verdict.kind).toBe('kill')
    const reason = verdict.kind === 'kill' ? verdict.reason : ''
    expect(reason).toMatch(/LOCK WAS NOT ACQUIRED/)
    // Again: not the sentence a missing row prints.
    expect(reason).not.toMatch(/no persisted row names/)
  })

  it('THE POSITIVE CONTROL: the same row, with the lock actually granted, survives', () => {
    // Two jobs. It stops "kill everything" from passing the three cases above, and it
    // proves the survive branch is REACHABLE in this environment — if flock or FFI were
    // unavailable here, every case above would pass for a reason that had nothing to do
    // with the code under test.
    const registryPath = registryWith(row())
    const verdict = claimShutdownSurvival({
      registryPath,
      sessionKey: KEY,
      paneHandle: HANDLE,
      childGeneration: GENERATION,
    })
    expect(verdict).toEqual({ kind: 'survive', handle: HANDLE })
  })
})
