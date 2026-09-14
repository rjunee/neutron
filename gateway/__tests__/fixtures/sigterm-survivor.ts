import { boot } from '../../index.ts'
import { HerdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { HERDR_PROTOCOL_VERSION } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-protocol.ts'
import { pool, sink, supervisedBySessionKey } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { ReplSession } from '@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts'
import type { PersistentReplSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/persistent/types.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The test runner owns the long-lived process, as the external pane server would.
// RPC is scripted; close really signals that process, so a kill mutation is visible.
const dir = process.argv[2]!
const pid = Number(process.argv[3])
const registryPath = join(dir, 'repl-registry.json')
const key = 'shutdown-survivor'
const record = JSON.parse(readFileSync(registryPath, 'utf8'))[key]
const host = new HerdrHost({
  pollIntervalMs: 10,
  connect: async () => ({
    async call(method) {
      process.kill(pid, 0)
      switch (method) {
        case 'ping': return { protocol: HERDR_PROTOCOL_VERSION, version: 'test' }
        case 'pane.get': return { pane: { scroll: { viewport_rows: 62 } } }
        case 'pane.process_info': return { process_info: { shell_pid: pid } }
        case 'pane.read': return { read: { text: 'ready' } }
        case 'pane.close': process.kill(pid, 'SIGTERM'); return {}
        default: throw new Error(`unexpected RPC: ${method}`)
      }
    },
  }),
})
const child = await host.attach(record.pane_handle, { cwd: dir, env: {} })
const session = new ReplSession(key, record.child_generation, record.sessionId, record.channelName, dir)
session.attachChild(child)
child.beginOutput?.()
await sink.ensureStarted({ tokenPath: join(dir, 'sink-token') })
sink.register(session.sessionId, session)
pool.set(key, Promise.resolve(session))
supervisedBySessionKey.set(key, { replRegistryPath: registryPath } as PersistentReplSubstrateOptions)
const gateway = await boot({ port: 0 })
// Observe a cleanup after the pool drain: a successful exit must reach DB close.
const close = gateway.db.close.bind(gateway.db)
gateway.db.close = () => {
  close()
  writeFileSync(join(dir, 'closed'), 'closed')
}
writeFileSync(join(dir, 'ready'), JSON.stringify({ pid: child.pid, port: sink.port }))
