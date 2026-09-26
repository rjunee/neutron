import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { createProjectControlStdioTransport } from './project-control-broker-transport.ts'

test('stdio retirement proof waits for the exact spawned process to exit after SIGTERM', async () => {
  const transport = createProjectControlStdioTransport({
    binary: join(import.meta.dir, 'fixtures', 'retirement-child.ts'), cwd: import.meta.dir,
    codexHome: import.meta.dir, env: { PATH: process.env.PATH ?? '' },
  })
  try {
    await new Promise<void>((resolve, reject) => transport.listen(value => {
      if ((value as { method?: string }).method === 'fixture/ready') resolve()
    }, reject))
    let exited = false
    void transport.exited!.then(() => { exited = true })
    transport.close()
    expect(exited).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(exited).toBe(false)
    const receipt = await transport.exited!
    expect(receipt.pid).toBeGreaterThan(0)
    expect(receipt.boot).not.toBe('')
    expect(receipt.start).toMatch(/^\d+$/)
    expect(receipt.code).toBe(0)
    expect(receipt.signal).toBeNull()
    expect(() => process.kill(receipt.pid, 0)).toThrow()
  } finally { transport.close() }
})
