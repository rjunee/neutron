/**
 * #1226 — the project liveness census, THROUGH THE OPEN WIRING, recognises the parent
 * REPL's own MCP services by SPAWN-CORRELATED provenance and by nothing else.
 *
 * The census used to exempt a direct child of the parent only when its argv named the
 * dev channel or the tools bridge. An owner-installed server had no exemption at all,
 * so a project with one installed could never read idle, and an `npx -y pkg` / `uvx pkg`
 * install starts its real server as a GRANDCHILD, which no direct-child rule reaches.
 * Matching the configured argv instead was rejected: any process can run the configured
 * command with the exact args without being the service this parent spawned.
 *
 * The spawn writes `OWN_SERVICE_PROVENANCE_ENV = childGeneration` into every mcp-config
 * entry; the census reads it back from `/proc/<pid>/environ` against the generation of
 * the parent it observed. These cases drive the REAL probes (`buildProjectLivenessProbes`
 * / `buildProjectLiveness`, and once the composed app's `project_liveness`) over the
 * real module-level pool state and a real process tree standing in for the REPL:
 *
 *   - POSITIVE: a marked wrapper and the grandchild it starts read idle;
 *   - NEGATIVE CONTROL: the IDENTICAL argv without the marker reads busy, and so does a
 *     marker from another generation;
 *   - a process started the way the REPL's Bash tool starts one (the REPL's own env,
 *     which never carries the marker) is a shell even beside marked services;
 *   - a parent whose generation is empty (provenance unknown) exempts nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { openAdmission } from '@neutronai/gateway/wiring/__tests__/project-admission-fixture.ts'
import { childByKey, pool, supervisedBySessionKey } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import type { PtyChild } from '@neutronai/runtime/adapters/claude-code/persistent/pty-host.ts'
import type { ReplSession } from '@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts'
import type { PersistentReplSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/persistent/types.ts'
import { OWN_SERVICE_PROVENANCE_ENV } from '@neutronai/runtime/mcp-servers.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { buildProjectLiveness } from '../wiring/project-liveness.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const MARKER = OWN_SERVICE_PROVENANCE_ENV
const GEN = `gen-wiring-${process.pid}`
const PROJECT = 'liveness-wiring-project'
const KEY = 'liveness-wiring-probe'

let tmpDir: string
const spawned: Array<ReturnType<typeof Bun.spawn>> = []

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'liveness-wiring-'))
})

afterEach(async () => {
  for (const p of spawned.splice(0)) await killTree(p)
  supervisedBySessionKey.delete(KEY)
  pool.delete(KEY)
  childByKey.delete(KEY)
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Every descendant pid of `pid`, read from `/proc`. */
async function descendantsOf(pid: number): Promise<number[]> {
  const out: number[] = []
  const queue = [pid]
  while (queue.length > 0) {
    const p = queue.shift()!
    const raw = (await readFile(`/proc/${p}/task/${p}/children`, 'utf8').catch(() => '')).trim()
    for (const token of raw === '' ? [] : raw.split(/\s+/)) {
      const child = Number.parseInt(token, 10)
      out.push(child)
      queue.push(child)
    }
  }
  return out
}

async function killTree(p: ReturnType<typeof Bun.spawn>): Promise<void> {
  for (const pid of (await descendantsOf(p.pid)).reverse()) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  p.kill('SIGKILL')
  await p.exited
}

/** The REPL's own environment: what it hands its Bash tool. Never carries the marker. */
function replEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env[MARKER]
  return env
}

/** An `npx`-shaped service: a wrapper that starts the real server as its child. */
const service = (marker: string | null): string =>
  `${marker === null ? '' : `${MARKER}=${marker} `}/bin/sh -c 'sleep 30 & wait' &`

/**
 * A stand-in for the parent REPL: a real process whose children are `script`'s
 * background jobs, spawned with the REPL's env. Resolves once `expected` descendants
 * exist, so a verdict is about the whole tree and never a race with its start.
 */
async function fakeRepl(script: string, expected: number): Promise<ReturnType<typeof Bun.spawn>> {
  const repl = Bun.spawn(['/bin/sh', '-c', `${script} wait`], { env: replEnv(), stdout: 'ignore', stderr: 'ignore' })
  spawned.push(repl)
  for (let i = 0; i < 250 && (await descendantsOf(repl.pid)).length < expected; i++) await Bun.sleep(20)
  expect((await descendantsOf(repl.pid)).length).toBe(expected)
  return repl
}

/** Seed the real pool state exactly as a live `cc-agent-*` parent occupies it. */
function seedParent(pid: number, childGeneration: string, projectId: string | undefined): void {
  const child = { pid, hasExited: () => false, kill: () => {}, exited: new Promise<number | null>(() => {}) }
  const session = {
    sessionKey: KEY,
    sessionId: 'liveness-wiring-session',
    cwd: join(tmpDir, 'cwd'),
    child,
    childGeneration,
    admissionGeneration: 0,
    activeTurn: undefined,
    turnSlotHeld: 0,
    poisoned: false,
    hasChildExited: () => false,
  }
  supervisedBySessionKey.set(KEY, {
    project_id: projectId,
    substrate_instance_id: 'cc-agent-liveness-wiring',
    // Resolved under the scratch dir: the transcript's `subagents` directory does not
    // exist, which the census reads as no native-child activity (ENOENT → idle).
    projectsDir: join(tmpDir, 'projects'),
  } as unknown as PersistentReplSubstrateOptions)
  pool.set(KEY, Promise.resolve(session as unknown as ReplSession))
  childByKey.set(KEY, child as unknown as PtyChild)
}

function liveness() {
  return buildProjectLiveness({ admission: openAdmission({ projects: [PROJECT] }).service, turnInFlight: () => false })
}

describe.if(process.platform === 'linux')('the census through the Open wiring', () => {
  test('POSITIVE: a marked npx-shaped wrapper and its grandchild are the parent\'s own service — idle', async () => {
    const repl = await fakeRepl(service(GEN), 2)
    seedParent(repl.pid, GEN, PROJECT)
    const out = await liveness().census(PROJECT)
    expect(out.parent).toMatchObject({ kind: 'participating', childGeneration: GEN, pid: repl.pid })
    expect(out.shells).toBe('idle')
    expect(out.verdict).toBe('idle')
  })

  test('NEGATIVE CONTROL: the identical argv with no provenance is a shell — busy', async () => {
    const repl = await fakeRepl(service(null), 2)
    seedParent(repl.pid, GEN, PROJECT)
    const out = await liveness().census(PROJECT)
    expect(out.parent.kind).toBe('participating')
    expect(out.shells).toBe('busy')
    expect(out.verdict).toBe('busy')
    expect(out.reasons.join('\n')).toContain('parent descendants running: 2 (sh, sleep)')
  })

  test('NEGATIVE CONTROL: a marker from ANOTHER generation is not this parent\'s — busy', async () => {
    const repl = await fakeRepl(service('gen-stale'), 2)
    seedParent(repl.pid, GEN, PROJECT)
    const out = await liveness().census(PROJECT)
    expect(out.shells).toBe('busy')
    expect(out.reasons.join('\n')).toContain('parent descendants running: 2 (sh, sleep)')
  })

  test('what the REPL starts through its Bash tool is a shell, even beside its marked services', async () => {
    // The REPL's env never carries the marker (the spawn scrubs it), so this `sleep`
    // is exactly what a Bash-tool command looks like to the census.
    const repl = await fakeRepl(`${service(GEN)} sleep 31 &`, 3)
    seedParent(repl.pid, GEN, PROJECT)
    const out = await liveness().census(PROJECT)
    expect(out.shells).toBe('busy')
    expect(out.reasons.join('\n')).toContain('parent descendants running: 1 (sleep)')
  })

  test('PROVENANCE UNKNOWN: a parent whose generation is empty exempts nothing', async () => {
    const repl = await fakeRepl(`${MARKER}= /bin/sh -c 'sleep 30 & wait' &`, 2)
    seedParent(repl.pid, '', PROJECT)
    const out = await liveness().census(PROJECT)
    expect(out.shells).toBe('busy')
    expect(out.verdict).toBe('busy')
  })
})

// ── the composed app ────────────────────────────────────────────────────────────

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG', 'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET',
] as const

function mockSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'mock' }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> { throw new Error('mock substrate: no external tools') },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

test.if(process.platform === 'linux')('the COMPOSED app\'s census reads provenance, not argv', async () => {
  const saved: Record<string, string | undefined> = {}
  for (const k of SAVED_ENV_KEYS) saved[k] = process.env[k]
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-liveness-test'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  const composition = await buildOpenGraphComposer({ env: process.env, substrateFactory: () => mockSubstrate() })(
    { db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  try {
    const census = composition.project_liveness
    if (census === undefined) throw new Error('composition did not expose project_liveness')

    // General: the pool names it 'general'.
    const marked = await fakeRepl(service(GEN), 2)
    seedParent(marked.pid, GEN, 'general')
    const idle = await census.census(null)
    expect(idle.parent).toMatchObject({ kind: 'participating', childGeneration: GEN })
    expect(idle.shells).toBe('idle')
    expect(idle.verdict).toBe('idle')

    // The same argv, no provenance, under the same composed census: busy.
    const unmarked = await fakeRepl(service(null), 2)
    seedParent(unmarked.pid, GEN, 'general')
    const busy = await census.census(null)
    expect(busy.shells).toBe('busy')
    expect(busy.reasons.join('\n')).toContain('parent descendants running: 2 (sh, sleep)')
  } finally {
    for (const cleanup of composition.realmode_cleanups ?? []) { try { await cleanup() } catch { /* best-effort */ } }
    await graph.shutdown()
    db.close()
    for (const k of SAVED_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}, 30_000)
