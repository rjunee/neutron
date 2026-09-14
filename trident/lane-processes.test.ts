import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test('real lane process lifecycle and pidfd refusal proofs', async () => {
  // unittest's verbose stream names the exact lifecycle proof before running it.
  // Keep successful output quiet, but preserve that stream verbatim on failure.
  const child = Bun.spawn(['python3', '-B', fileURLToPath(new URL('./lane-processes-test.py', import.meta.url)), '-v'], {
    stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect({ code, stdout, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stdout: '', stderr: '' })
}, 30_000)
