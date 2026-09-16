import { expect, it } from 'bun:test'
import { selectPtyHost, configuredPtyHost } from '../configured-pty-host.ts'
import { herdrHost, HerdrHost } from '../herdr-host.ts'
import { bunTerminalHost } from '../bun-terminal-host.ts'
import { FakeHerdrServer } from './herdr-fake-server.ts'

it('selects exactly the requested host and defaults to herdr', () => {
  expect(selectPtyHost(undefined)).toBe(herdrHost)
  expect(selectPtyHost('herdr')).toBe(herdrHost)
  expect(selectPtyHost('bun')).toBe(bunTerminalHost)
})

it('rejects unknown and empty settings', () => {
  expect(() => selectPtyHost('other')).toThrow('NEUTRON_REPL_HOST')
  expect(() => selectPtyHost('')).toThrow('NEUTRON_REPL_HOST')
})

it('keeps the startup choice after environment changes', () => {
  // The property is that the constant is PINNED at import, not that it holds any
  // particular host — which it no longer does unconditionally, since a test runner
  // now defaults to bun. Reading the pinned value first and comparing against it
  // tests the immutability itself rather than restating the default.
  const pinned = configuredPtyHost
  const before = process.env['NEUTRON_REPL_HOST']
  try {
    process.env['NEUTRON_REPL_HOST'] = pinned === bunTerminalHost ? 'herdr' : 'bun'
    expect(configuredPtyHost).toBe(pinned)
  } finally {
    if (before === undefined) delete process.env['NEUTRON_REPL_HOST']
    else process.env['NEUTRON_REPL_HOST'] = before
  }
})

// A TEST RUN MUST NOT GET THE OWNER'S HERDR SESSION BY DEFAULT.
//
// Measured in CHILD PROCESSES, because `configuredPtyHost` is pinned at import and
// this process has already imported it — mutating env here proves nothing (the test
// directly above is the reason why). Each child imports the module fresh under the
// env it is given and prints which host it bound.
//
// The third row is the positive control that keeps this honest: if the child harness
// were broken and always printed "bun", that row would fail, because an EXPLICIT
// herdr must still be honoured under a test — `persistent-repl-substrate.test.ts`
// relies on exactly that to cover the herdr transport on purpose.
for (const [label, env, expected] of [
  ['an unset host under a test runner', { NODE_ENV: 'test' }, 'bun'],
  ['an unset host outside a test runner', { NODE_ENV: 'production' }, 'herdr'],
  ['an explicit herdr under a test runner', { NODE_ENV: 'test', NEUTRON_REPL_HOST: 'herdr' }, 'herdr'],
  ['an explicit bun outside a test runner', { NODE_ENV: 'production', NEUTRON_REPL_HOST: 'bun' }, 'bun'],
] as Array<[string, Record<string, string>, string]>) {
  it(`binds ${label} to ${expected}`, async () => {
    const child = Bun.spawn([process.execPath, '-e',
      `const m = await import('./runtime/adapters/claude-code/persistent/configured-pty-host.ts')
       const b = await import('./runtime/adapters/claude-code/persistent/bun-terminal-host.ts')
       console.log(m.configuredPtyHost === b.bunTerminalHost ? 'bun' : 'herdr')`,
    ], {
      cwd: new URL('../../../../../', import.meta.url).pathname,
      env: { ...process.env, NEUTRON_REPL_HOST: undefined, ...env },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ code, host: out.trim(), err: code === 0 ? '' : err }).toEqual({ code: 0, host: expected, err: '' })
  }, 20000)
}

it('selected Bun reports a real kernel exit status through both exit surfaces', async () => {
  const exits: Array<number | null> = []
  const child = await selectPtyHost('bun').spawn(['/bin/sh', '-c', 'exit 23'], {
    cwd: '/tmp', env: {}, onExit: code => { exits.push(code) },
  })
  expect(await child.exited).toBe(23)
  expect(exits).toEqual([23])
  expect(child.exitCause?.()).toBeUndefined()
})

for (const cause of ['closed-by-us', 'pane-vanished'] as const) {
  it(`herdr collapses exit to ${cause} with no kernel status`, async () => {
    const server = new FakeHerdrServer()
    const host = new HerdrHost({ connect: async () => server, workspaceId: 'w9', pollIntervalMs: 5 })
    const exits: Array<number | null> = []
    const child = await host.spawn(['claude'], { cwd: '/tmp', env: {}, onExit: code => { exits.push(code) } })
    try {
      child.beginOutput?.()
      if (cause === 'closed-by-us') child.kill()
      else server.exitPane()
      expect(await child.exited).toBeNull()
      expect(exits).toEqual([null])
      expect(child.exitCause?.()).toBe(cause)
      expect(child.wasKilledByUs?.()).toBe(cause === 'closed-by-us')
    } finally {
      child.kill()
    }
  })
}

for (const value of ['herdr', 'bun']) {
  it(`production spawn uses ${value} for a complete turn`, async () => {
    const proc = Bun.spawn([process.execPath, 'test',
      'runtime/adapters/claude-code/persistent/__tests__/persistent-repl-substrate.test.ts',
      '--test-name-pattern', 'configured production host carries'], {
      env: { ...process.env, NEUTRON_REPL_HOST: value }, stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    expect({ code, output: code === 0 ? '' : stdout + stderr }).toEqual({ code: 0, output: '' })
  }, 15000)
}
