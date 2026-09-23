import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { clearTrailerSlot, readArmedTrailerReservation, reconcileStoppedTrailerReservations, reserveTrailerSlot } from './trailer-slot.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function slot() {
  const dir = await mkdtemp(join(tmpdir(), 'trailer-slot-'))
  directories.push(dir)
  return { reservation: join(dir, `claude-step-${'a'.repeat(64)}.json`), result: join(dir, 'build.result'), identity: 'the-request' }
}

test('recovery reads only exact armed authority and leaves missing or invalid reservations untouched', async () => {
  const s = await slot()
  await writeFile(s.result, 'retained result')
  expect((await readArmedTrailerReservation(s.reservation, s.identity)).kind).toBe('unknown')
  expect(await readFile(s.reservation, 'utf8').catch((error: NodeJS.ErrnoException) => error.code)).toBe('ENOENT')
  for (const bytes of [s.identity, 'foreign\n#dispatch-armed\n', 'corrupt']) {
    await writeFile(s.reservation, bytes)
    expect((await readArmedTrailerReservation(s.reservation, s.identity)).kind).toBe('unknown')
    expect(await readFile(s.reservation, 'utf8')).toBe(bytes)
  }
  const armed = s.identity + '\n#dispatch-armed\n'
  await writeFile(s.reservation, armed)
  expect(await readArmedTrailerReservation(s.reservation, s.identity)).toEqual({ kind: 'resume' })
  expect(await readFile(s.reservation, 'utf8')).toBe(armed)
  expect(await readFile(s.result, 'utf8')).toBe('retained result')
})

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

test('a step whose owner died between create and arm recovers on a later attempt, and never dispatches twice', async () => {
  // Protocol-level fixture only: this bypasses launcher admission and does not close #1122.
  // the exclusive `wx` create writes the bare identity, and the owner dies before
  // `identity + ARMED` is written, so this IS the byte state it leaves behind.
  const s = await slot()
  await writeFile(s.reservation, s.identity, { flag: 'wx', mode: 0o600 })

  // The wedge #1122 reports. A replacement cannot tell a dead owner from one that is
  // microseconds away from arming, so it refuses instead of dispatching the bounded task
  // a second time against one shared trailer. Refusing is correct and is not recovery.
  const wedged = await reserveTrailerSlot(s.reservation, s.identity, s.result)
  expect(wedged.kind).toBe('unknown')

  // The host is the only party that knows the run stopped, so it is the only one that may
  // clear this. Nothing about the worker-side rules above changed.
  expect(await reconcileStoppedTrailerReservations(dirname(s.reservation))).toEqual({ ok: true })

  // After explicit cleanup the slot permits a dispatch.
  expect(await reserveTrailerSlot(s.reservation, s.identity, s.result)).toEqual({ kind: 'dispatch' })

  // A second reservation must not grant another dispatch. This does not exercise
  // the driver or its launcher admission guard.
  const sibling = await reserveTrailerSlot(s.reservation, s.identity, s.result)
  expect(sibling.kind).not.toBe('dispatch')
})
