import assert from 'node:assert/strict'
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertProcessTestIsolation } from '../../../../../trident/process-test-isolation.ts'
import { acquireCodexAccountWriteLease } from '../../account-writer-lock.ts'
import { createProjectControlStdioTransport } from '../../persistent/project-control-broker-transport.ts'

// Keep a defective runtime's descriptor corruption inside this fixture process.
assertProcessTestIsolation()
const root = mkdtempSync(join(tmpdir(), 'account-descriptor-lifetime-'))
let sentinel: number | undefined

async function retireTransport() {
  const home = join(root, 'account')
  const lease = acquireCodexAccountWriteLease(home)
  const transport = createProjectControlStdioTransport({
    binary: process.argv[2]!, cwd: root, codexHome: home,
    env: { PATH: process.env.PATH! }, accountWriteLease: lease,
  })
  let readyDeadline: ReturnType<typeof setTimeout> | undefined
  try {
    sentinel = openSync(join(root, 'sentinel'), 'w+')
    assert.equal(sentinel, lease.fd, 'The sentinel must reuse the inherited descriptor')
    const before = fstatSync(sentinel)
    const ready = await new Promise<{ pid: number; locks: number }>((resolve, reject) => {
      readyDeadline = setTimeout(() => reject(new Error('Native fixture did not become ready')), 5000)
      transport.listen(value => resolve(value as { pid: number; locks: number }), reject)
    })
    clearTimeout(readyDeadline)
    assert.equal(ready.pid, transport.processIdentity?.pid)
    assert.ok(ready.locks > 0, 'The native fixture must actually hold its account lock')
    transport.close()
    const exit = await transport.exited
    assert.equal(exit.pid, ready.pid)
    return {
      transport: new WeakRef(transport), close: new WeakRef(transport.close),
      before: { dev: before.dev, ino: before.ino },
    }
  } finally {
    clearTimeout(readyDeadline)
    transport.close()
    await transport.exited
    lease.close()
  }
}

let failure: unknown
try {
  const retired = await retireTransport()
  let collected = false
  for (let round = 0; round < 64; round++) {
    // A WeakRef dereference keeps its target alive until the current job ends.
    await Bun.sleep(5)
    Bun.gc(true)
    await Bun.sleep(5)
    if (retired.transport.deref() === undefined && retired.close.deref() === undefined) {
      collected = true
      break
    }
  }
  assert.ok(collected, 'The retired transport and its child-owning closure must be collected')
  const after = fstatSync(sentinel!)
  assert.deepEqual({ dev: after.dev, ino: after.ino }, retired.before)
  assert.equal(writeSync(sentinel!, 'still owned'), 11)
  console.log(JSON.stringify({ collected, descriptorPreserved: true, nativeExitObserved: true }))
} catch (error) {
  failure = error
} finally {
  // Keep the first failing assertion when the defective runtime has already
  // closed the sentinel; a cleanup EBADF must not replace the observed failure.
  try { if (sentinel !== undefined) closeSync(sentinel) } catch (error) { failure ??= error }
  rmSync(root, { recursive: true, force: true })
}
if (failure) throw failure
