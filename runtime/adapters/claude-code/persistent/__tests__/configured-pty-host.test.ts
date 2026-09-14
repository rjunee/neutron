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
  const before = process.env['NEUTRON_REPL_HOST']
  try {
    process.env['NEUTRON_REPL_HOST'] = configuredPtyHost === bunTerminalHost ? 'herdr' : 'bun'
    expect(configuredPtyHost).toBe(before === 'bun' ? bunTerminalHost : herdrHost)
  } finally {
    if (before === undefined) delete process.env['NEUTRON_REPL_HOST']
    else process.env['NEUTRON_REPL_HOST'] = before
  }
})

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
