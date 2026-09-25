/**
 * #1226 round 2 — the production liveness probes (`open/wiring/project-liveness.ts`).
 *
 *   - A handoff census (`excludePendingDispatch`) never consults the scope-wide
 *     ActivityInspector signal (the requesting dispatch's own turn); the default
 *     census still does, so sleep and maintenance keep the scope-wide view.
 *   - The owner's installed stdio MCP servers are the parent's own services, read
 *     against REAL processes: an exact configured launch is idle, the same binary
 *     unconfigured is a busy shell, and an unreadable registry proves nothing.
 */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { openAdmission } from '@neutronai/gateway/wiring/__tests__/project-admission-fixture.ts'
import { buildProjectLiveness, buildProjectLivenessProbes } from '../wiring/project-liveness.ts'

const spawned: Array<ReturnType<typeof Bun.spawn>> = []
afterEach(async () => {
  for (const child of spawned.splice(0)) { child.kill(); await child.exited }
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
async function parentOfSleep(): Promise<{ pid: number; sleep: string }> {
  const sleep = Bun.which('sleep')
  if (sleep === null) throw new Error('sleep is required')
  const parent = Bun.spawn(['/bin/sh', '-c', `'${sleep}' 30 & wait`], { stdout: 'ignore', stderr: 'ignore' })
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
  return { pid: parent.pid, sleep }
}

test.if(process.platform === 'linux')('an installed server launched exactly as configured is an own service; unconfigured it is a shell', async () => {
  const { pid, sleep } = await parentOfSleep()
  const admission = openAdmission({ projects: [] })
  const probesWith = (ownServices?: () => Promise<ReadonlyArray<{ command: string; args?: readonly string[] }>>) =>
    buildProjectLivenessProbes({ admission: admission.service, turnInFlight: () => false,
      ...(ownServices === undefined ? {} : { ownServices }) })
  expect((await probesWith(async () => [{ command: sleep, args: ['30'] }]).descendants(pid)))
    .toEqual({ verdict: 'idle', reasons: [] })
  // No registry, the same binary with other args, or an unreadable registry: a busy shell.
  expect((await probesWith().descendants(pid)).verdict).toBe('busy')
  expect((await probesWith(async () => [{ command: sleep, args: ['31'] }]).descendants(pid)).verdict).toBe('busy')
  expect((await probesWith(async () => { throw new Error('registry unreadable') }).descendants(pid)).verdict).toBe('busy')
})
