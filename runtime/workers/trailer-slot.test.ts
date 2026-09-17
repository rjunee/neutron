import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { clearTrailerSlot, reconcileStoppedTrailerReservations, reserveTrailerSlot } from './trailer-slot.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function slot() {
  const dir = await mkdtemp(join(tmpdir(), 'trailer-slot-'))
  directories.push(dir)
  return { reservation: join(dir, `claude-step-${'a'.repeat(64)}.json`), result: join(dir, 'build.result'), identity: 'the-request' }
}

test('exactly one of many concurrent callers may dispatch a step', async () => {
  // The bounded task must run ONCE. Two owners both dispatching would run the work
  // twice against one shared trailer, either of them free to overwrite the other.
  for (let attempt = 0; attempt < 25; attempt++) {
    const s = await slot()
    const held = await Promise.all(
      Array.from({ length: 4 }, () => reserveTrailerSlot(s.reservation, s.identity, s.result)),
    )
    // A sibling that reads AFTER the winner arms legitimately sees a resume; what may
    // never happen is a second dispatch.
    expect(held.filter(one => one.kind === 'dispatch')).toHaveLength(1)
  }
})

test('the dispatcher clears an earlier round left in the slot', async () => {
  const s = await slot()
  await writeFile(s.result, 'the previous round')
  expect(await reserveTrailerSlot(s.reservation, s.identity, s.result)).toEqual({ kind: 'dispatch' })
  expect(await readFile(s.result, 'utf8').catch((error: NodeJS.ErrnoException) => error.code)).toBe('ENOENT')
})

test('a dispatched step resumes without clearing the trailer it produced', async () => {
  const s = await slot()
  expect(await reserveTrailerSlot(s.reservation, s.identity, s.result)).toEqual({ kind: 'dispatch' })
  await writeFile(s.result, 'this round\'s own receipt')
  expect(await reserveTrailerSlot(s.reservation, s.identity, s.result)).toEqual({ kind: 'resume' })
  expect(await readFile(s.result, 'utf8')).toBe('this round\'s own receipt')
})

test('a step held but never armed is unknown, and its stale slot is not read', async () => {
  const s = await slot()
  // Its owner created the reservation and did not arm it. A second caller cannot tell a
  // dead owner from one a millisecond away from arming, so it must not take the step
  // over — but it must also never hand back what is sitting in the slot.
  await writeFile(s.reservation, s.identity)
  await writeFile(s.result, 'the previous round')
  const held = await reserveTrailerSlot(s.reservation, s.identity, s.result)
  expect(held.kind).toBe('unknown')
  expect(held).toHaveProperty('detail', expect.stringContaining('not yet dispatched'))
  expect(await readFile(s.result, 'utf8')).toBe('the previous round')
})

test('a stopped host clears an unarmed reservation so a later attempt dispatches once', async () => {
  const s = await slot()
  // The first owner died after exclusive create and before arming or dispatch.
  await writeFile(s.reservation, s.identity)
  expect((await reserveTrailerSlot(s.reservation, s.identity, s.result)).kind).toBe('unknown')

  expect(await reconcileStoppedTrailerReservations(dirname(s.reservation))).toEqual({ ok: true })
  expect(await reserveTrailerSlot(s.reservation, s.identity, s.result)).toEqual({ kind: 'dispatch' })
  expect(await reserveTrailerSlot(s.reservation, s.identity, s.result)).toEqual({ kind: 'resume' })
})

test('stopped-host reconciliation preserves an armed reservation', async () => {
  const s = await slot()
  expect(await reserveTrailerSlot(s.reservation, s.identity, s.result)).toEqual({ kind: 'dispatch' })
  expect(await reconcileStoppedTrailerReservations(dirname(s.reservation))).toEqual({ ok: true })
  expect(await reserveTrailerSlot(s.reservation, s.identity, s.result)).toEqual({ kind: 'resume' })
})

test('a reservation for a different request is refused, not adopted', async () => {
  const s = await slot()
  await writeFile(s.reservation, 'a different request')
  const held = await reserveTrailerSlot(s.reservation, s.identity, s.result)
  expect(held).toEqual({ kind: 'unknown', detail: 'Step is reserved for a different request.' })
})

test('an absent slot is cleared successfully; an unclearable one is reported', async () => {
  const s = await slot()
  expect(await clearTrailerSlot(s.result)).toEqual({ ok: true })
  // A directory can never hold a trailer and cannot be unlinked: that is not absence.
  const asDirectory = join(s.result, '..')
  const outcome = await clearTrailerSlot(asDirectory)
  expect(outcome.ok).toBe(false)
  expect(outcome).toHaveProperty('detail', expect.stringContaining(asDirectory))
})
