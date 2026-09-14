import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptionPermitsSpawn, reconcileOwnRepl } from '../boot-adoption.ts'
import { herdrHost } from '../herdr-host.ts'
import type { ReplRegistry } from '../repl-registry.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'

const KEY = 'inst user proj cred'
const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444'
const CHANNEL = 'neutron-0123456789abcdef0123456789abcdef'
const dirs: string[] = []

function fixture(): { options: PersistentReplSubstrateOptions; registryPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-540-'))
  dirs.push(dir)
  const registryPath = join(dir, 'repl-registry.json')
  const registry: ReplRegistry = {
    [KEY]: {
      sessionKey: KEY,
      sessionId: SESSION_ID,
      cwd: '/tmp',
      channelName: CHANNEL,
      has_session: true,
      pid: 4242,
      devchannel_port: 45555,
      child_generation: 'gen-1111-2222',
      reuse: { tool_surface: 'Read,Bash', tool_bridge: false, auth_fingerprint: 'fp-abc' },
    },
  }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2))
  return {
    registryPath,
    options: {
      substrate_instance_id: 'inst',
      replRegistryPath: registryPath,
      project_id: 'proj',
      cwd: '/tmp',
    },
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('a setting change cannot orphan a live Bun REPL', () => {
  it('refuses a herdr restart while the handle-less Bun child still owns the transcript', async () => {
    const f = fixture()
    const before = readFileSync(f.registryPath, 'utf8')
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      host: herdrHost,
      listProcesses: () => [{ pid: 4242, cmdline: `claude --resume ${SESSION_ID}` }],
      log: () => {},
    })
    expect(outcome.kind).toBe('undecided')
    expect(adoptionPermitsSpawn(outcome).ok).toBe(false)
    expect(readFileSync(f.registryPath, 'utf8')).toBe(before)
  })

  it('refuses an unavailable scan, then permits a verified empty scan', async () => {
    const f = fixture()
    const refused = await reconcileOwnRepl(f.options, KEY, {
      host: herdrHost,
      listProcesses: () => {
        throw new Error('scan unavailable')
      },
      log: () => {},
    })
    expect(refused.kind).toBe('undecided')
    const ready = await reconcileOwnRepl(f.options, KEY, {
      host: herdrHost,
      listProcesses: () => [],
      log: () => {},
    })
    expect(ready.kind).toBe('no-handle')
    expect(adoptionPermitsSpawn(ready).ok).toBe(true)
  })
})
