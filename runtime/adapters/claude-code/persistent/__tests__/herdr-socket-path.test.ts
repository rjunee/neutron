/**
 * herdr-socket-path.test.ts — where the client looks for herdr's socket.
 *
 * THIS FILE EXISTS BECAUSE THE OLD RULE TOOK AN INSTANCE DOWN. `HERDR_SOCKET_PATH` is
 * injected by herdr into panes it manages, and the client read "unset" as "we are not
 * under a pane" and refused. That inference is wrong for the caller that matters most:
 * the gateway runs as a system service, never under a pane, and it is the process that
 * must reach herdr to host a REPL at all. Measured on a live box: every turn failed in
 * ~56 ms with `cc-llm-call: herdr: no socket path` while herdr was running and its
 * socket was reachable the whole time.
 *
 * So absence of the env var is evidence of nothing, and the question the client must
 * ask is whether a socket is THERE.
 */

import { describe, expect, it, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { herdrCall, defaultHerdrSocketPath } from '../herdr-client.ts'

const ENV = 'HERDR_SOCKET_PATH'
const scratch: string[] = []

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'herdr-sock-'))
  scratch.push(d)
  return d
}

/** A connect that never really connects — it only RECORDS the path it was handed, which
 *  is the entire subject of this file. Resolution happens before any I/O. */
function recordingConnect(seen: string[]) {
  return async (path: string) => {
    seen.push(path)
    throw new Error('probe: resolution recorded, no connection attempted')
  }
}

async function pathHandedToConnect(opts: Record<string, unknown>): Promise<string | Error> {
  const seen: string[] = []
  try {
    await herdrCall('ping', {}, { ...opts, connect: recordingConnect(seen) } as never)
  } catch (e) {
    if (seen.length > 0) return seen[0] as string
    return e as Error
  }
  return seen[0] as string
}

afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env[ENV]
})

describe('resolving herdr\'s socket path', () => {
  it('an EXPLICIT socketPath wins over the environment', async () => {
    process.env[ENV] = '/from/env.sock'
    expect(await pathHandedToConnect({ socketPath: '/explicit.sock' })).toBe('/explicit.sock')
  })

  it('the injected env var is used when no explicit path is given', async () => {
    process.env[ENV] = '/from/env.sock'
    expect(await pathHandedToConnect({})).toBe('/from/env.sock')
  })

  it('AN EMPTY env var is not a path — it falls through rather than connecting to ""', async () => {
    const home = tree()
    mkdirSync(join(home, 'herdr'), { recursive: true })
    writeFileSync(join(home, 'herdr', 'herdr.sock'), '')
    process.env[ENV] = ''
    process.env['XDG_CONFIG_HOME'] = home
    try {
      expect(await pathHandedToConnect({})).toBe(join(home, 'herdr', 'herdr.sock'))
    } finally {
      delete process.env['XDG_CONFIG_HOME']
    }
  })

  it('WITH THE ENV VAR UNSET it uses the default location when a socket is there', async () => {
    // The regression case. Before the fix this threw instead of resolving, which is
    // exactly what happened to the gateway in production.
    const home = tree()
    mkdirSync(join(home, 'herdr'), { recursive: true })
    writeFileSync(join(home, 'herdr', 'herdr.sock'), '')
    process.env['XDG_CONFIG_HOME'] = home
    try {
      expect(await pathHandedToConnect({})).toBe(join(home, 'herdr', 'herdr.sock'))
    } finally {
      delete process.env['XDG_CONFIG_HOME']
    }
  })

  it('refuses when NOTHING is there, and names the path it tried', async () => {
    // The other direction: the fix must not make an unreachable herdr look fine.
    const home = tree()
    process.env['XDG_CONFIG_HOME'] = home
    try {
      const r = await pathHandedToConnect({})
      expect(r).toBeInstanceOf(Error)
      expect((r as Error).message).toContain(join(home, 'herdr', 'herdr.sock'))
      expect((r as Error).message).toContain(ENV)
    } finally {
      delete process.env['XDG_CONFIG_HOME']
    }
  })

  it('refuses when there is no home to derive a default from', async () => {
    const savedX = process.env['XDG_CONFIG_HOME']
    const savedH = process.env['HOME']
    delete process.env['XDG_CONFIG_HOME']
    delete process.env['HOME']
    try {
      const r = await pathHandedToConnect({})
      expect(r).toBeInstanceOf(Error)
      expect((r as Error).message).toContain('no default location')
    } finally {
      if (savedX !== undefined) process.env['XDG_CONFIG_HOME'] = savedX
      if (savedH !== undefined) process.env['HOME'] = savedH
    }
  })

  it('XDG_CONFIG_HOME wins over HOME, and HOME is the fallback base', () => {
    expect(defaultHerdrSocketPath({ XDG_CONFIG_HOME: '/x', HOME: '/h' })).toBe('/x/herdr/herdr.sock')
    expect(defaultHerdrSocketPath({ HOME: '/h' })).toBe('/h/.config/herdr/herdr.sock')
    expect(defaultHerdrSocketPath({ XDG_CONFIG_HOME: '', HOME: '/h' })).toBe('/h/.config/herdr/herdr.sock')
    expect(defaultHerdrSocketPath({})).toBeUndefined()
  })
})
