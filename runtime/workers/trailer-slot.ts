import { constants } from 'node:fs'
import { open, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Clear the result slot a step is about to dispatch against.
 *
 * The trailer path is keyed by ROLE, not by step: `open/wiring/project-build.ts:366`
 * composes `<state>/<role>.result` once at prepare time, before any round exists, while
 * `trident/build-run.ts:319` gives every round of that role its own `step_id`. A second
 * round therefore dispatches against a path that STILL HOLDS the previous round's
 * trailer. That USED to be taken for this round's answer by both readers, and was the
 * defect this clear was written for.
 *
 * Both readers are now step-aware as well (#1123): `decodeProjectTrailer` returns
 * `not-current-step` for a well-formed identity belonging to another request rather than
 * a terminal `unknown`, and the acting turns continue past a trailer that is not theirs
 * instead of reporting the dispatch ended. The two guards are deliberately independent —
 * the reader means a missed clear cannot produce a WRONG ANSWER, only a wait; this clear
 * means the wait is not spent on a slot that will never be overwritten. Neither replaces
 * the other, and removing either re-opens a real failure.
 *
 * Absence is the ordinary first-round case and is success. Any other failure leaves a
 * foreign trailer in place, which the caller would otherwise read as its own result, so
 * it is reported rather than swallowed — "there was nothing to clear" and "the earlier
 * trailer is still there" must not share a signal. */
export async function clearTrailerSlot(path: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await unlink(path)
    return { ok: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true }
    return { ok: false, detail: `Result slot ${path} may still hold an earlier round's trailer and could not be cleared (${code ?? String(error)}); this step's outcome is unknown.` }
  }
}

/** A step either dispatches, resumes, or cannot establish which. */
export type SlotReservation =
  | { kind: 'dispatch' }
  | { kind: 'resume' }
  | { kind: 'unknown'; detail: string }

/** Marks a reservation whose slot has been cleared AND whose work was about to be
 * submitted. It is written as a suffix so the identity comparison below still
 * recognises the request, and so the armed and unarmed states are distinguishable
 * from the file alone after any restart. */
const ARMED = '\n#dispatch-armed\n'
const MAX_RESERVATION_BYTES = 256 * 1024
const MAX_RESERVATION_READ_MS = 250

/** Recovery has no authority to reserve work. Only an existing exact armed
 * reservation proves this request may have been dispatched. This reader never
 * creates, clears, arms, or takes over a slot, even when the file is missing.
 * Read one bounded, stable regular-file snapshot within the caller's deadline
 * and cancellation signal; unsafe or stalled evidence remains unknown. */
export async function readArmedTrailerReservation(
  reservation: string,
  identity: string,
  bounds: { signal?: AbortSignal; deadline?: number } = {},
): Promise<Exclude<SlotReservation, { kind: 'dispatch' }>> {
  type Retained = Exclude<SlotReservation, { kind: 'dispatch' }>
  const unavailable = (): Retained => ({ kind: 'unknown', detail: 'Step reservation is unavailable or unsafe; recovery cannot dispatch work.' })
  const deadline = Math.min(bounds.deadline ?? Infinity, Date.now() + MAX_RESERVATION_READ_MS)
  if (bounds.signal?.aborted || !Number.isFinite(deadline) || deadline <= Date.now()) return unavailable()
  const controller = new AbortController()
  const check = () => {
    controller.signal.throwIfAborted()
    if (Date.now() >= deadline) throw new Error('Reservation observation expired')
  }
  const collect = async (): Promise<Retained> => {
    try {
      check()
      // Opening a FIFO must itself be nonblocking. Refuse symlinks and every
      // non-regular descriptor before reading even one byte from it.
      const file = await open(reservation, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      try {
        check()
        const before = await file.stat()
        if (!before.isFile() || before.size > MAX_RESERVATION_BYTES) return unavailable()
        const bytes = Buffer.alloc(before.size + 1)
        let offset = 0
        while (offset < bytes.length) {
          check()
          const part = await file.read(bytes, offset, bytes.length - offset, offset)
          if (!part.bytesRead) break
          offset += part.bytesRead
        }
        check()
        const after = await file.stat()
        check()
        if (!after.isFile() || offset !== before.size || after.size !== before.size
          || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return unavailable()
        if (bytes.subarray(0, offset).toString('utf8') === identity + ARMED) return { kind: 'resume' }
        return { kind: 'unknown', detail: 'Recovery requires an existing exact armed step reservation.' }
      } finally { await file.close() }
    } catch { return unavailable() }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop = () => {}
  const interrupted = new Promise<Retained>(resolve => {
    stop = () => { controller.abort(); resolve(unavailable()) }
    bounds.signal?.addEventListener('abort', stop, { once: true })
    timer = setTimeout(stop, Math.max(0, deadline - Date.now()))
    if (bounds.signal?.aborted) stop()
  })
  try { return await Promise.race([collect(), interrupted]) }
  finally {
    clearTimeout(timer)
    bounds.signal?.removeEventListener('abort', stop)
    controller.abort()
  }
}

const RESERVATION_FILE = /^(?:claude|codex|pi|codex-headless)-step-[a-f0-9]{64}\.json$/

/** Reconcile reservations after the host has observed that the prior run attempt stopped.
 *
 * The containing directory is exclusively bound to one run by `createProjectRunners`, so a
 * recognised reservation without the armed suffix can only describe work that was never
 * submitted. Armed reservations are durable evidence of a possibly submitted task and are
 * never removed here. This is intentionally a host action: a competing dispatcher cannot
 * establish that the owner is dead. The caller must establish exclusive admission first;
 * this helper does not authorize restarting a pending or terminal driver. */
export async function reconcileStoppedTrailerReservations(stateDir: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  let names: string[]
  try {
    names = await readdir(stateDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { ok: false, detail: `Stopped-run reservations in ${stateDir} could not be listed (${code ?? String(error)}); dispatch ownership is unknown.` }
  }
  for (const name of names) {
    if (!RESERVATION_FILE.test(name)) continue
    const path = join(stateDir, name)
    let bytes: string
    try {
      bytes = await readFile(path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') continue
      return { ok: false, detail: `Stopped-run reservation ${path} could not be read (${code ?? String(error)}); dispatch ownership is unknown.` }
    }
    if (bytes.endsWith(ARMED)) continue
    try {
      await unlink(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') continue
      return { ok: false, detail: `Unarmed stopped-run reservation ${path} could not be cleared (${code ?? String(error)}); the step was not recovered.` }
    }
  }
  return { ok: true }
}

/** Take ownership of a step, clearing its result slot exactly once.
 *
 * Neither ordering of "reserve" and "clear" is correct on its own, and both were tried:
 *
 * - Reserve, then clear: a replacement arriving in that window finds the reservation,
 *   calls it a resume, skips the clear and reads the PREVIOUS round's trailer. This is
 *   the original defect, reached through a narrower door.
 * - Clear, then reserve: a genuine resume — the worker wrote its trailer and the gateway
 *   was then replaced — has its own completed receipt destroyed, and the step is replayed
 *   with its outcome already lost.
 *
 * So the clear is made part of taking ownership. The exclusive `wx` create is the only
 * thing that confers it: exactly one caller can create the reservation, and only that
 * caller clears the slot, arms the reservation and dispatches. Arming happens after the
 * clear and immediately before the work is submitted, so an ARMED reservation proves the
 * slot was already cleared for this step and anything in it now belongs to this step.
 *
 * A reservation that exists but is UNARMED is NOT taken over. A second caller cannot tell
 * "the owner died between creating and arming" from "the owner is a few milliseconds from
 * arming", and taking over on that guess dispatches the bounded task twice against one
 * shared trailer. It is reported as unknown instead, which is what it is, and matches the
 * standing contract that an uncertain dispatch is never replayed — the host reconciles the
 * original step. Crucially the stale slot is still never read as this step's answer. */
export async function reserveTrailerSlot(
  reservation: string,
  identity: string,
  resultPath: string,
  beforeArm?: () => Promise<void>,
): Promise<SlotReservation> {
  try {
    await writeFile(reservation, identity, { flag: 'wx', mode: 0o600 })
  } catch {
    let existing: string
    try {
      existing = await readFile(reservation, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return { kind: 'unknown', detail: `Step reservation ${reservation} could not be created or read (${code ?? String(error)}); whether this step was already dispatched is unknown.` }
    }
    if (existing === identity + ARMED) return { kind: 'resume' }
    if (existing === identity) {
      return { kind: 'unknown', detail: `Step ${reservation} is held by another instance that has not yet dispatched it; its dispatch state is unknown and it is not replayed here.` }
    }
    return { kind: 'unknown', detail: 'Step is reserved for a different request.' }
  }
  const cleared = await clearTrailerSlot(resultPath)
  if (!cleared.ok) return { kind: 'unknown', detail: cleared.detail }
  try {
    // Only the exclusive creator can clear an additional child-facing slot.
    // A failure stays UNARMED; resume and concurrent losers never run this hook.
    await beforeArm?.()
  } catch {
    return { kind: 'unknown', detail: 'Child result slot could not be cleared before arming; this step was not dispatched.' }
  }
  try {
    await writeFile(reservation, identity + ARMED, { mode: 0o600 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // The slot is clear but the arming is not durable. Dispatching now would let a
    // replacement clear the slot a second time, under a worker already writing to it.
    return { kind: 'unknown', detail: `Step reservation ${reservation} could not be armed (${code ?? String(error)}); this step was not dispatched.` }
  }
  return { kind: 'dispatch' }
}
