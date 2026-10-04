import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import * as childProcess from 'node:child_process'
import * as authority from './native-host-recovery-authority.ts'
import * as processIdentity from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import { verifyMaintenanceDeployment, type MaintenanceDeployment } from './operator-maintenance-evidence.ts'

test('served release proof binds tree, process start, entrypoint, listener and health in both directions', async () => {
  const target: MaintenanceDeployment = { codeRoot: '/protected/tree', entrypoint: '/protected/tree/open/server.ts', revision: 'a'.repeat(40), port: 8080, ownerHandle: 'owner' }
  const prior = { pid: 10, identity: { boot_id: 'boot', start_ticks: 1 } }
  const current = { boot_id: 'boot', start_ticks: 1000 }
  let identity = current, revision = target.revision, mtimeMs = 1, inode = '123', healthOwner = 'owner', argvEntry = target.entrypoint
  const protection = spyOn(authority, 'assertRootProtectedPath').mockImplementation(() => {})
  const proc = spyOn(processIdentity, 'readProcessIdentity').mockImplementation(() => identity)
  const git = spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, args?: unknown) => {
    if (file === 'getconf') return '100'
    switch ((args as string[])[2]) {
      case 'rev-parse': return revision
      case 'status': return ''
      case 'ls-files': return 'open/server.ts\0runtime/workers/claude-capacity-client.ts\0runtime/adapters/claude-code/persistent/native-request-relay.ts\0'
      default: throw new Error('Unexpected process query')
    }
  }) as typeof childProcess.execFileSync)
  const stat = spyOn(fs, 'lstatSync').mockImplementation((() => ({ mtimeMs, ctimeMs: mtimeMs, isSymbolicLink: () => false })) as unknown as typeof fs.lstatSync)
  const real = spyOn(fs, 'realpathSync').mockImplementation(((path: fs.PathLike) => String(path)) as typeof fs.realpathSync)
  const links = spyOn(fs, 'readlinkSync').mockImplementation(((path: fs.PathLike) => String(path).endsWith('/cwd') ? '/protected/tree' : `socket:[${inode}]`) as typeof fs.readlinkSync)
  const dirs = spyOn(fs, 'readdirSync').mockImplementation(() => ['3'] as never)
  const files = spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor) => {
    const name = String(path)
    if (name.endsWith('/cmdline')) return `bun\0${argvEntry}\0`
    if (name === '/proc/stat') return 'btime 1000\n'
    if (name === '/proc/net/tcp') return 'header\n0: 0100007F:1F90 00000000:0000 0A 0 0 0 0 0 123\n'
    if (name === '/proc/net/tcp6') return 'header\n'
    if (name.endsWith('claude-capacity-client.ts')) return 'native-relay-v3: http://127.0.0.1:0'
    if (name.endsWith('native-request-relay.ts')) return 'routed.ANTHROPIC_BASE_URL = NATIVE_RELAY_BASE_URL'
    throw new Error('Unexpected evidence read')
  }) as typeof fs.readFileSync)
  const health = spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ status: 'ok', project_slug: healthOwner })) as unknown as typeof fetch)
  try {
    expect(await verifyMaintenanceDeployment(target, 20, prior)).toEqual({ pid: 20, identity: current })
    argvEntry = '/protected/old/open/server.ts'
    await expect(verifyMaintenanceDeployment({ ...target, entrypoint: argvEntry }, 20, prior)).rejects.toThrow()
    argvEntry = target.entrypoint
    revision = 'b'.repeat(40); await expect(verifyMaintenanceDeployment(target, 20, prior)).rejects.toThrow(); revision = target.revision
    mtimeMs = 2_000_000; await expect(verifyMaintenanceDeployment(target, 20, prior)).rejects.toThrow(); mtimeMs = 1
    inode = '999'; await expect(verifyMaintenanceDeployment(target, 20, prior)).rejects.toThrow(); inode = '123'
    argvEntry = '/protected/old/open/server.ts'; await expect(verifyMaintenanceDeployment(target, 20, prior)).rejects.toThrow(); argvEntry = target.entrypoint
    healthOwner = 'foreign'; await expect(verifyMaintenanceDeployment(target, 20, prior)).rejects.toThrow(); healthOwner = 'owner'
    health.mockImplementation((async () => { identity = { ...current, start_ticks: current.start_ticks + 1 }; return Response.json({ status: 'ok', project_slug: 'owner' }) }) as unknown as typeof fetch)
    await expect(verifyMaintenanceDeployment(target, 20, prior)).rejects.toThrow('changed during verification')
  } finally {
    for (const mock of [protection, proc, git, stat, real, links, dirs, files, health]) mock.mockRestore()
  }
})
