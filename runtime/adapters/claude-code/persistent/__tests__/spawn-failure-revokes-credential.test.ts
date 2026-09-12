/**
 * spawn-failure-revokes-credential.test.ts — a registration whose child never existed
 * must not outlive the attempt.
 *
 * `spawnSession` registers the session with the sink immediately before spawning,
 * because the child can POST the moment it starts and an unregistered credential would
 * be refused. Registration grants a CREDENTIAL (`byCredential`), so a spawn that throws
 * would otherwise leave a standing authorization with no process behind it — and the
 * per-session config carrying that credential in plaintext still on disk.
 *
 * The assertions are effects, not call counts: the credential the child WOULD have
 * carried is lifted out of the real `--mcp-config` the spawn was given, and then used
 * against the live sink.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

import { createPersistentReplSubstrate } from '../persistent-repl-substrate.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'
import type { PtyHost } from '../pty-host.ts'
import { getReplSinkInfo } from '../repl-sink.ts'

function mcpConfigPathFrom(argv: readonly string[]): string {
  const i = argv.indexOf('--mcp-config')
  if (i < 0 || argv[i + 1] === undefined) throw new Error(`no --mcp-config in argv: ${argv.join(' ')}`)
  return argv[i + 1] as string
}

describe('a spawn that throws revokes what its registration granted', () => {
  test('the credential is refused afterwards and the config is gone', async () => {
    let capturedConfigPath: string | undefined
    let capturedToken: string | undefined

    // Reads the credential BEFORE the throw propagates, because the cleanup this test
    // exists to verify deletes the file it is read from.
    const throwingHost: PtyHost = {
      spawn: (argv: string[]) => {
        capturedConfigPath = mcpConfigPathFrom(argv)
        const cfg = JSON.parse(readFileSync(capturedConfigPath, 'utf8')) as {
          mcpServers?: Record<string, { env?: Record<string, string> }>
        }
        for (const server of Object.values(cfg.mcpServers ?? {})) {
          const t = server.env?.['SINK_TOKEN']
          if (t !== undefined) capturedToken = t
        }
        throw new Error('spawn refused by the host')
      },
    } as unknown as PtyHost

    const options: PersistentReplSubstrateOptions = {
      substrate_instance_id: 'cc-spawn-failure',
      cwd: '/tmp',
      ptyHost: throwingHost,
      skipTrustSeed: true,
      user_id: 'u-1',
      project_id: 'proj-spawn-failure',
      credential_identity: 'cred-1',
    }

    const sub = createPersistentReplSubstrate(options)
    // The substrate surfaces a failed spawn as an event rather than a rejected stream,
    // so the turn is DRAINED and the outcome recorded. Which shape it takes is not this
    // test's subject — the cleanup afterwards is — but the drain has to complete or the
    // assertions would race the cleanup they are about.
    const events: unknown[] = []
    try {
      const handle = sub.start({ prompt: 'hello', tools: [], model_preference: ['claude-opus-4-7'] })
      for await (const e of handle.events) events.push(e)
    } catch {
      /* a rejected stream is equally acceptable here */
    }
    expect(events.length).toBeGreaterThanOrEqual(0)

    // The spawn really did happen, so the assertions below are about a real attempt.
    expect(capturedConfigPath).toBeDefined()
    expect(capturedToken).toBeDefined()

    // 1 · the config carrying the credential is gone.
    expect(existsSync(capturedConfigPath as string)).toBe(false)

    // 2 · and the credential itself authorizes nothing. Under the defect this is 200:
    // the registration outlives the child that never existed.
    const info = await getReplSinkInfo()
    const res = await fetch(`http://127.0.0.1:${info.port}/tool-call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Sink-Token': capturedToken as string },
      body: JSON.stringify({ session_id: 'anything', name: 'note', arguments: {} }),
    })
    expect(res.status).toBe(401)
  }, 30_000)
})
