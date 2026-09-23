import { afterEach, expect, spyOn, test } from 'bun:test'
import { appendFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimReviewReceipt, readReviewReceipt } from './project-review-receipt.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-receipt-read-')); roots.push(root)
  const directory = join(root, 'attempt')
  await claimReviewReceipt(directory, 'owned-identity')
  return { directory, path: join(directory, 'receipt.json') }
}

test('receipt reader accepts an owned regular file and refuses FIFO without waiting for a writer', async () => {
  const f = await fixture()
  expect(await readReviewReceipt(f.directory, 'owned-identity')).toMatchObject({ state: 'pending' })
  await rm(f.path)
  expect(Bun.spawnSync(['mkfifo', f.path]).exitCode).toBe(0)
  await expect(readReviewReceipt(f.directory, 'owned-identity')).rejects.toThrow('bounded regular file')
}, 1000)

test('receipt reader rejects oversized files and detects growth after its bounded read', async () => {
  const f = await fixture()
  await writeFile(f.path, ' '.repeat(8 * 1024 * 1024 + 1))
  await expect(readReviewReceipt(f.directory, 'owned-identity')).rejects.toThrow('bounded regular file')
  await writeFile(f.path, JSON.stringify({ version: 1, identity: 'owned-identity', state: 'pending' }))
  const handle = await open(f.path, 'r')
  const prototype = Object.getPrototypeOf(handle)
  await handle.close()
  const original = prototype.read
  let grew = false
  let maximumRequested = 0
  const read = spyOn(prototype, 'read').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    maximumRequested = Math.max(maximumRequested, args[2] as number)
    const result = await original.apply(this, args)
    if (!grew) { grew = true; await appendFile(f.path, ' ') }
    return result
  })
  try {
    await expect(readReviewReceipt(f.directory, 'owned-identity')).rejects.toThrow('changed while being read')
    expect(grew).toBe(true)
    expect(maximumRequested).toBeLessThan(100)
  } finally { read.mockRestore() }
})
