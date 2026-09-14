/**
 * adoption-refuses-a-second-owner.test.ts — #539: what happens AFTER an inconclusive
 * reconciliation, which is where the danger actually lives.
 *
 * THE DEFECT THESE EXIST FOR was one step past every other case in this suite.
 * `boot-adoption.ts` correctly refuses to claim what it cannot establish — a pane it
 * could not inspect, a pid the process table will not vouch for, a close that failed —
 * and reports `undecided`. The pass was then awaited purely for its ORDERING and the
 * verdict thrown away, so the very next statements resolved a resume directive from the
 * registry and started a fresh `claude --resume` on a transcript whose previous owner
 * might still be running it. Two processes, one transcript: the invariant this whole
 * item is built around, defeated by not reading the answer.
 *
 * So every case here drives the REAL entry point (`getOrSpawnSession`) to the end and
 * asserts on the HOST's spawn counter — the only thing that can tell "it refused"
 * apart from "it quietly started a second one".
 *
 * BIDIRECTIONAL, because a gate that refuses everything would pass all four refusals
 * and break the product: the later cases prove a spawn still happens when the
 * reconciliation ends in a POSITIVE statement (the pane is gone; the survivor was
 * closed; the recorded pid is provably dead; the row never had a handle).
 *
 * WHERE THE SEAM IS, stated so the coverage is not overclaimed. `getOrSpawnSession`
 * takes no injection point for the process table, so the INCONCLUSIVE shapes driven
 * end-to-end here are the ones a registry row can express on its own — chiefly "there
 * is no pid to ask about". The other inconclusive producer, "the pid is alive and its
 * command line could not be read", is pinned at the unit layer
 * (`boot-adoption.test.ts`), where the probe IS injectable. Both produce the same
 * `undecided` verdict through the same function, and M21 (making `undecided` permit a
 * spawn) reddens five cases here — so the verdict→refusal half is what this file
 * proves, and the producer→verdict half is proved next door.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '../../../../substrate.ts'
import { getOrSpawnSession } from '../spawn.ts'
import { resetBootAdoptionForTests } from '../boot-adoption.ts'
import { childByKey, pool, sink, supervisedBySessionKey } from '../pool-state.ts'
import type { ReplRegistry, ReplRegistryRecord } from '../repl-registry.ts'
import type { AdoptableHost, HandleInspection, PtyChild, PtyHost, PtySpawnOpts } from '../pty-host.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'

const KEY = 'inst user proj cred'
const SESSION_ID = 'eeeeeeee-1111-2222-3333-444444444444'
const CHANNEL = 'neutron-99998888777766665555444433332222'
const GENERATION = 'gen-second-owner'
const HANDLE = 'w9:p21'

const dirs: string[] = []
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'neutron-539-owner-'))
  dirs.push(d)
  return d
}

/**
 * A pid the kernel will certainly not know: above `pid_max` on every Linux we run, so
 * `kill(pid, 0)` answers ESRCH. Used where a case needs the process table to say
 * POSITIVELY that the recorded child is gone.
 */
const DEAD_PID = 2_147_483_647

/**
 * A host that COUNTS spawns and can be told exactly what it sees under a handle.
 *
 * Its `spawn` throws after counting: every case here either refuses to spawn (the
 * counter must stay 0) or is expected to reach a spawn (the counter must reach 1, and
 * the throw is how the case ends without needing a whole fake `claude`).
 */
class CountingHost implements AdoptableHost {
  spawns = 0
  inspection: HandleInspection = { kind: 'unavailable', reason: 'the herdr socket did not answer' }
  closeError: Error | undefined
  readonly closed: string[] = []

  async spawn(): Promise<PtyChild> {
    this.spawns += 1
    throw new Error('CountingHost: a spawn was attempted')
  }

  /** Held until released, so a case can replace the registry row INSIDE the window
   *  the pass decides in. Without it the race cannot be constructed and a test of it
   *  proves nothing. */
  private inspectHold: Promise<void> | undefined
  private releaseInspect: (() => void) | undefined

  private inspectEntered: (() => void) | undefined

  /** Hold the next inspection, and hand back a HANDSHAKE as well as a release.
   *  `entered` resolves inside the held method, so a case knows the window was entered
   *  rather than sleeping and hoping. See `boot-adoption-host.ts` for the full argument;
   *  resolving it here at construction time would restore the guess exactly. */
  holdInspect(): { entered: Promise<void>; release: () => void } {
    const entered = new Promise<void>((res) => {
      this.inspectEntered = res
    })
    this.inspectHold = new Promise<void>((res) => {
      this.releaseInspect = res
    })
    return {
      entered,
      release: () => {
        this.inspectHold = undefined
        this.releaseInspect?.()
      },
    }
  }

  /** Every `inspectHandle` entry, so a case can assert it is INSIDE the window rather
   *  than assuming it. */
  inspectEntries = 0

  async inspectHandle(): Promise<HandleInspection> {
    this.inspectEntries += 1
    if (this.inspectHold !== undefined) {
      // RESOLVED HERE, inside the held method — the only position that proves the pass
      // reached this boundary.
      this.inspectEntered?.()
      await this.inspectHold
    }
    return this.inspection
  }

  async attach(_handle: string, _opts: PtySpawnOpts): Promise<PtyChild> {
    throw new Error('CountingHost: attach is not part of these cases')
  }

  async closeHandle(handle: string): Promise<void> {
    if (this.closeError !== undefined) throw this.closeError
    this.closed.push(handle)
  }
}

/** A host with NO adoption surface — the supported herdr → in-process switch. */
class NonAdoptingHost implements PtyHost {
  spawns = 0
  async spawn(): Promise<PtyChild> {
    this.spawns += 1
    throw new Error('NonAdoptingHost: a spawn was attempted')
  }
}

/** An override that may explicitly set a field to `undefined` — how a case says "this
 *  row does not carry that field" under exact-optional types. */
type RowOverride = { [K in keyof ReplRegistryRecord]?: ReplRegistryRecord[K] | undefined }

function writeRow(registryPath: string, over: RowOverride = {}): void {
  const row = {
    sessionKey: KEY,
    sessionId: SESSION_ID,
    cwd: '/tmp',
    channelName: CHANNEL,
    has_session: true,
    pid: 4242,
    devchannel_port: 45777,
    child_generation: GENERATION,
    pane_handle: HANDLE,
    reuse: { tool_surface: '', tool_bridge: false, auth_fingerprint: '' },
    ...over,
  }
  const registry: ReplRegistry = { [KEY]: row as ReplRegistryRecord }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2))
}

function optionsFor(host: PtyHost, registryPath: string): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'inst',
    cwd: '/tmp',
    ptyHost: host,
    skipTrustSeed: true,
    replRegistryPath: registryPath,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
  } as unknown as PersistentReplSubstrateOptions
}

const spec: AgentSpec = { prompt: 'hello', tools: [], model_preference: ['claude-opus-5'] }

/** Run a turn's spawn path and report what happened, without throwing. */
async function attemptSpawn(
  options: PersistentReplSubstrateOptions,
): Promise<{ threw: boolean; message: string }> {
  try {
    await getOrSpawnSession(KEY, options, spec)
    return { threw: false, message: '' }
  } catch (e) {
    return { threw: true, message: e instanceof Error ? e.message : String(e) }
  }
}

beforeAll(async () => {
  await sink.ensureStarted({ tokenPath: join(scratch(), 'sink-token') })
})


// CLEARED BEFORE EACH CASE, NOT ONLY AFTER IT. The shutdown latch and the pass map are
// module-global, and bun runs many test FILES in one process — so a suite that shuts a
// gateway down leaves adoption latched off for whatever file runs next. Clearing after
// each case protects this file's own cases from each other; clearing before each one also
// protects them from every other file. The failure mode is silent and green-looking: the
// first case passes and the rest adopt nothing.
beforeEach(() => resetBootAdoptionForTests())

afterEach(() => {
  resetBootAdoptionForTests()
  pool.clear()
  childByKey.clear()
  supervisedBySessionKey.clear()
  sink.unregister(SESSION_ID)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('an inconclusive reconciliation refuses the spawn', () => {
  it('the host could not be asked and there is no pid to fall back to → NO second process', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    // No pid: the process table cannot be asked either, so NOTHING can establish
    // whether the pane is still running our claude.
    writeRow(registryPath, { pid: undefined })
    const host = new CountingHost()
    host.inspection = { kind: 'unavailable', reason: 'the herdr socket did not answer' }
    const result = await attemptSpawn(optionsFor(host, registryPath))
    expect(result.threw).toBe(true)
    expect(result.message).toMatch(/refusing to resume/i)
    expect(host.spawns).toBe(0)
  })

  it('the pane is live but nothing identifies what is in it → NO second process', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    writeRow(registryPath, { pid: undefined })
    const host = new CountingHost()
    host.inspection = { kind: 'live', argv: [] }
    const result = await attemptSpawn(optionsFor(host, registryPath))
    expect(result.threw).toBe(true)
    expect(result.message).toMatch(/refusing to resume/i)
    expect(host.spawns).toBe(0)
  })

  it('a FOREIGN owner whose close FAILED → NO second process', async () => {
    // The sharpest one: we KNOW a claude is on this transcript and we KNOW our attempt
    // to end it did not land. Spawning here is knowingly creating the second owner.
    const registryPath = join(scratch(), 'repl-registry.json')
    writeRow(registryPath)
    const host = new CountingHost()
    host.inspection = { kind: 'live', argv: ['claude', '--resume', SESSION_ID] }
    host.closeError = new Error('herdr refused the close')
    const result = await attemptSpawn(optionsFor(host, registryPath))
    expect(result.threw).toBe(true)
    expect(result.message).toMatch(/refusing to resume/i)
    expect(result.message).toMatch(/close FAILED/i)
    expect(host.spawns).toBe(0)
  })

  it('the HOST SWITCHED under a live pane and the pid cannot be verified → NO second process', async () => {
    // #540 keeps the in-process PTY host selectable, so this is a supported
    // configuration change rather than a corner case. The pane may still be running
    // our claude under a herdr server this process is not talking to.
    const registryPath = join(scratch(), 'repl-registry.json')
    writeRow(registryPath, { pid: undefined })
    const host = new NonAdoptingHost()
    const result = await attemptSpawn(optionsFor(host, registryPath))
    expect(result.threw).toBe(true)
    expect(result.message).toMatch(/refusing to resume/i)
    expect(host.spawns).toBe(0)
  })

  it('...but the SAME switch with a provably dead pid lets the spawn through', async () => {
    // The positive control for the case above, and the realistic recovery: the process
    // table answers positively that the recorded child is gone, so nothing owns the
    // transcript and the in-process host may start one.
    const registryPath = join(scratch(), 'repl-registry.json')
    writeRow(registryPath, { pid: DEAD_PID })
    const host = new NonAdoptingHost()
    const result = await attemptSpawn(optionsFor(host, registryPath))
    expect(host.spawns).toBe(1)
    expect(result.message).not.toMatch(/refusing to resume/i)
  })
})

describe('a conclusive reconciliation lets the spawn through', () => {
  it('the pane is positively GONE → the spawn proceeds', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    writeRow(registryPath)
    const host = new CountingHost()
    host.inspection = { kind: 'gone' }
    const result = await attemptSpawn(optionsFor(host, registryPath))
    // It reached the host, which is what "permitted" means here; the host then throws
    // because these cases do not build a whole fake `claude`.
    expect(host.spawns).toBe(1)
    expect(result.message).not.toMatch(/refusing to resume/i)
  })

  it('a foreign owner that WAS closed → the spawn proceeds', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    writeRow(registryPath)
    const host = new CountingHost()
    host.inspection = { kind: 'live', argv: ['claude', '--resume', SESSION_ID] }
    const result = await attemptSpawn(optionsFor(host, registryPath))
    expect(host.closed).toEqual([HANDLE])
    expect(host.spawns).toBe(1)
    expect(result.message).not.toMatch(/refusing to resume/i)
  })

  it('a row with no durable handle at all → the spawn proceeds', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    writeRow(registryPath, { pane_handle: undefined })
    const host = new CountingHost()
    const result = await attemptSpawn(optionsFor(host, registryPath))
    expect(host.spawns).toBe(1)
    expect(result.message).not.toMatch(/refusing to resume/i)
  })
})

describe('a row replaced mid-pass refuses the spawn', () => {
  it('starts NO second process on a transcript another incarnation just claimed', async () => {
    // END-TO-END, because row preservation alone was the half that already worked: an
    // earlier revision correctly declined to strip the newer row and then reported a
    // verdict that permits a cold spawn anyway, so the data was intact and the
    // two-owner outcome it was protecting against happened regardless.
    //
    // A inspects (H1, G1); B finishes a spawn and writes (H2, G2) while that inspection
    // is held; A's inspection answers `gone`, which is true of H1 and says nothing
    // about B's live child.
    const registryPath = join(scratch(), 'repl-registry.json')
    writeRow(registryPath)
    const host = new CountingHost()
    host.inspection = { kind: 'gone' }
    const { entered, release } = host.holdInspect()
    const options = optionsFor(host, registryPath)
    const attempt = attemptSpawn(options)

    // AWAITED, NOT SLEPT. The row must be replaced while the inspection is genuinely in
    // flight; a sleep that lost its race would replace it before the pass looked, and
    // the case would assert the refusal against a completely different code path.
    await entered
    // Inside the inspection right now — the handshake's meaning, asserted, so a version
    // that resolved it at construction time (a sleep by another name) reds here.
    expect(host.inspectEntries).toBe(1)
    writeRow(registryPath, { pane_handle: 'w9:p-NEWER', child_generation: 'gen-newer', pid: 5150 })
    release()

    const result = await attempt
    expect(result.threw).toBe(true)
    expect(result.message).toMatch(/refusing to resume/i)
    // THE ASSERTION THAT CARRIES IT.
    expect(host.spawns).toBe(0)
    // And B's row is untouched — both halves, in one case.
    const row = JSON.parse(readFileSync(registryPath, 'utf8'))[KEY] as ReplRegistryRecord
    expect(row.pane_handle).toBe('w9:p-NEWER')
    expect(row.child_generation).toBe('gen-newer')
  })

  it('spawns when the row is still the one the pass decided about', async () => {
    // The positive control: without it, refusing every gone-pane would pass the case
    // above and stop the product recovering from a REPL that simply died.
    const registryPath = join(scratch(), 'repl-registry.json')
    writeRow(registryPath)
    const host = new CountingHost()
    host.inspection = { kind: 'gone' }
    await attemptSpawn(optionsFor(host, registryPath))
    expect(host.spawns).toBe(1)
  })
})

describe('a refusal is not remembered', () => {
  it('re-probes on the next turn, and admits the spawn once the pane is gone', async () => {
    // An `undecided` pass must not be cached: a herdr blip would otherwise freeze one
    // bad moment into a permanent refusal for the life of the process.
    const registryPath = join(scratch(), 'repl-registry.json')
    writeRow(registryPath, { pid: undefined })
    const host = new CountingHost()
    host.inspection = { kind: 'unavailable', reason: 'a blip' }
    const options = optionsFor(host, registryPath)
    expect((await attemptSpawn(options)).threw).toBe(true)
    expect(host.spawns).toBe(0)

    // The blip passes and the pane turns out to be gone.
    host.inspection = { kind: 'gone' }
    await attemptSpawn(options)
    expect(host.spawns).toBe(1)
  })
})
