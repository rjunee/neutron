/**
 * #1226 round 2 — the production liveness probes (`open/wiring/project-liveness.ts`).
 *
 *   - A handoff census (`excludePendingDispatch`) never consults the scope-wide
 *     ActivityInspector signal (the requesting dispatch's own turn); the default
 *     census still does, so sleep and maintenance keep the scope-wide view.
 *   - A real direct service child is exempt only through its parent's immutable
 *     spawn receipt; missing evidence and other generations never establish idle.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { replSessionConfigPaths } from '@neutronai/runtime/adapters/claude-code/persistent/session-config-paths.ts'
import { recordMcpServiceOwner } from '@neutronai/runtime/adapters/claude-code/persistent/mcp-service-identity.ts'
import { openAdmission } from '@neutronai/gateway/wiring/__tests__/project-admission-fixture.ts'
import { buildProjectLiveness, buildProjectLivenessProbes } from '../wiring/project-liveness.ts'

const spawned: Array<ReturnType<typeof Bun.spawn>> = []
const directories: string[] = []
afterEach(async () => {
  for (const child of spawned.splice(0)) { child.kill(); await child.exited }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('the handoff census never consults the scope-wide turn signal; the default census does', async () => {
  const admission = openAdmission({ projects: ['p-one'] })
  const asked: Array<string | null> = []
  const surface = buildProjectLiveness({
    admission: admission.service,
    turnInFlight: (scope) => { asked.push(scope); return true },
  })
  await surface.census('p-one', { excludePendingDispatch: true })
  expect(asked).toEqual([])
  await surface.census('p-one')
  expect(asked).toEqual(['p-one'])
  await surface.census(null, { excludePendingDispatch: false })
  expect(asked).toEqual(['p-one', null])
})

/** A parent whose ONE direct child runs `sleep 30` exactly (argv `[sleep, 30]`). */
async function parentOfSleep(marker: string): Promise<{ pid: number }> {
  const sleep = Bun.which('sleep')
  if (sleep === null) throw new Error('sleep is required')
  const parent = Bun.spawn(['/bin/sh', '-c',
    'env NEUTRON_MCP_SERVICE_ID="$1" "$2" 30 & child=$!; trap \'kill "$child" 2>/dev/null; wait "$child" 2>/dev/null\' EXIT; trap \'exit 0\' TERM INT; wait "$child"',
    'mcp-fixture', marker, sleep], { stdout: 'ignore', stderr: 'ignore' })
  spawned.push(parent)
  const limit = Date.now() + 5000
  for (;;) {
    try {
      const child = readFileSync(`/proc/${parent.pid}/task/${parent.pid}/children`, 'utf8').trim().split(/\s+/)[0]
      if (child && readFileSync(`/proc/${child}/cmdline`, 'utf8') === `${sleep}\0${'30'}\0`) break
    } catch { /* not started yet */ }
    if (Date.now() > limit) throw new Error('the sleep child never started')
    await Bun.sleep(10)
  }
  return { pid: parent.pid }
}

test.if(process.platform === 'linux')('the production census requires an exact immutable MCP spawn receipt', async () => {
  const marker = randomBytes(32).toString('hex')
  const { pid } = await parentOfSleep(marker)
  const admission = openAdmission({ projects: [] })
  const probes = buildProjectLivenessProbes({ admission: admission.service, turnInFlight: () => false })
  const owner = { pid, sessionKey: 'test-project-session', childGeneration: 'original-generation',
    channelName: `neutron-${randomBytes(16).toString('hex')}` }
  const paths = replSessionConfigPaths(owner.channelName)
  mkdirSync(paths.dir, { mode: 0o700 }); directories.push(paths.dir)
  expect((await probes.descendants(pid)).verdict).toBe('unknown')
  expect((await probes.descendants(pid, owner)).verdict).toBe('unknown')
  recordMcpServiceOwner(owner, [marker])
  expect(await probes.descendants(pid, owner)).toEqual({ verdict: 'idle', reasons: [] })
  expect((await probes.descendants(pid, { ...owner, childGeneration: 'different-generation' })).verdict).toBe('unknown')
  expect(() => recordMcpServiceOwner(owner, [randomBytes(32).toString('hex')])).toThrow()
  expect(await probes.descendants(pid, owner)).toEqual({ verdict: 'idle', reasons: [] })

  // The same command with a foreign marker remains a live descendant.
  const foreign = await parentOfSleep(randomBytes(32).toString('hex'))
  const foreignOwner = { ...owner, pid: foreign.pid, channelName: `neutron-${randomBytes(16).toString('hex')}` }
  const foreignPaths = replSessionConfigPaths(foreignOwner.channelName)
  mkdirSync(foreignPaths.dir, { mode: 0o700 }); directories.push(foreignPaths.dir)
  recordMcpServiceOwner(foreignOwner, [marker])
  expect((await probes.descendants(foreign.pid, foreignOwner)).verdict).toBe('busy')
})
