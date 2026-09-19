/** Explicit durable-host entry point; never spawn this as a gateway child. */
import { readFileSync } from 'node:fs'
import { HerdrHost } from '../../claude-code/persistent/herdr-host.ts'
import { createHerdrRpc } from '../../claude-code/persistent/herdr-client.ts'
import { privatePath } from './project-owner-helper-protocol.ts'
import { startCodexOwnerHelper } from './project-owner-helper.ts'

if (import.meta.main) {
  const path = process.argv[2]
  const socketPath = process.env.HERDR_SOCKET_PATH
  if (!path || process.env.HERDR_ENV !== '1' || !socketPath || !process.env.HERDR_PANE_ID) throw new Error('Owner helper requires an explicit Herdr pane and private launch file')
  privatePath(path, 'file')
  const options = JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof startCodexOwnerHelper>[0]
  const terminalHost = new HerdrHost({ connect: async () => createHerdrRpc({ socketPath }) })
  const helper = await startCodexOwnerHelper({ ...options, terminalHost })
  process.stdout.write('Native Codex owner helper ready; gateway clients may attach.\n')
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void helper.destroy().then(() => process.exit(0), () => process.exit(1))
  }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
}
