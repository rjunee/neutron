import { constants } from 'node:fs'
import { mkdir, open, lstat, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SeatObservation } from './gates/review-panel.ts'

/** Only the host writes this directory. Worker trailers and accounting telemetry
 * are deliberately not inputs to a completed panel receipt. */
export interface ReviewReceipt {
  version: 1
  identity: string
  state: 'pending' | 'settled'
  observation?: SeatObservation
}

async function readJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw Error('Review receipt is not a bounded regular file')
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}

export async function readReviewReceipt(directory: string, identity: string): Promise<ReviewReceipt | null> {
  try {
    if (!(await lstat(directory)).isDirectory()) throw Error('Review receipt directory is not owned storage')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  try {
    const row = await readJson(join(directory, 'receipt.json')) as ReviewReceipt
    if (!row || row.version !== 1 || row.identity !== identity || !['pending', 'settled'].includes(row.state)
      || (row.state === 'pending' && row.observation !== undefined)
      || (row.state === 'settled' && (!row.observation || !['completed', 'deferred', 'unavailable', 'rate-limited'].includes(row.observation.status)))) {
      throw Error('Review receipt identity or state is invalid')
    }
    return row
  } catch (error) {
    // An existing directory without its claim could be a crashed/in-flight host.
    // It is not proof that another caller may purchase this attempt.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Error('Review receipt claim is missing')
    throw error
  }
}

export async function claimReviewReceipt(directory: string, identity: string): Promise<void> {
  // mkdir is the atomic claim, including the interval before receipt.json exists.
  await mkdir(directory, { mode: 0o700 })
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ version: 1, identity, state: 'pending' }), { flag: 'wx', mode: 0o600 })
}

export async function settleReviewReceipt(directory: string, identity: string, observation: SeatObservation): Promise<void> {
  const current = await readReviewReceipt(directory, identity)
  if (!current || current.state !== 'pending') throw Error('Review receipt has no owned pending attempt')
  const temporary = join(directory, `receipt-${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify({ version: 1, identity, state: 'settled', observation }), { flag: 'wx', mode: 0o600 })
  await rename(temporary, join(directory, 'receipt.json'))
}
