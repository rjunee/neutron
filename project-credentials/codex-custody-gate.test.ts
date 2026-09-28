import { expect, test } from 'bun:test'
import { CodexCustodyAdmissionError, CodexServiceCustodyGate } from './codex-custody-gate.ts'

function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('same-tick maintenance stops new writers and drains admitted persistence', async () => {
  const gate = new CodexServiceCustodyGate(), persistence = pending<void>(), rows: string[] = []
  const oldWriter = gate.run('owner', async () => { await persistence.promise; rows.push('old') })
  expect(gate.inspect('owner')).toEqual({ admission: 'open', writers: 1 })
  const request = gate.beginMaintenance('owner')
  let entered = false
  const maintenance = request.drained.then(lease => { entered = true; return lease })
  await expect(gate.run('owner', () => { rows.push('forbidden') })).rejects.toBeInstanceOf(CodexCustodyAdmissionError)
  expect(gate.inspect('owner')).toEqual({ admission: 'draining', writers: 1 })
  expect(entered).toBe(false)
  expect(rows).toEqual([])
  persistence.resolve()
  await oldWriter
  const lease = await maintenance
  expect(entered).toBe(true)
  expect(rows).toEqual(['old'])
  expect(gate.inspect('owner')).toEqual({ admission: 'held', writers: 0 })
  lease.assertHeld()
  rows.push('reconciled')
  lease.release()
  await gate.run('owner', () => { rows.push('later') })
  expect(rows).toEqual(['old', 'reconciled', 'later'])
})

test('unawaited registered harvest is included in the drain', async () => {
  const gate = new CodexServiceCustodyGate(), diskRead = pending<string>(), persisted: string[] = []
  // A resolver may intentionally not await this promise. Registration still
  // happens now; invoking run only after diskRead resolves would be too late.
  const harvest = gate.run('owner', async () => { persisted.push(await diskRead.promise) })
  const request = gate.beginMaintenance('owner')
  expect(gate.inspect('owner').admission).toBe('draining')
  diskRead.resolve('fresh synthetic bytes')
  const lease = await request.drained
  expect(persisted).toEqual(['fresh synthetic bytes'])
  await harvest
  lease.release()
})

test('all admitted writers must settle, regardless of completion order', async () => {
  const gate = new CodexServiceCustodyGate(), first = pending<void>(), second = pending<void>()
  const a = gate.run('owner', () => first.promise), b = gate.run('owner', () => second.promise)
  const request = gate.beginMaintenance('owner')
  second.resolve(); await b
  expect(gate.inspect('owner')).toEqual({ admission: 'draining', writers: 1 })
  first.resolve(); await a
  const lease = await request.drained
  expect(gate.inspect('owner')).toEqual({ admission: 'held', writers: 0 })
  lease.release()
})

test('writer rejection settles the drain without poisoning later admission', async () => {
  const gate = new CodexServiceCustodyGate(), work = pending<void>()
  const writer = gate.run('owner', () => work.promise)
  // Observe rejection without waiting inside a matcher before resolving the
  // synthetic writer; some Bun matchers drain their promise immediately.
  const rejected = writer.then(() => undefined, error => error as Error)
  const request = gate.beginMaintenance('owner')
  work.reject(new Error('fixture persistence failed'))
  expect((await rejected)?.message).toBe('fixture persistence failed')
  const lease = await request.drained
  lease.release()
  expect(await gate.run('owner', () => 'new write')).toBe('new write')
})

test('synchronous callback failure releases its writer admission', async () => {
  const gate = new CodexServiceCustodyGate()
  await expect(gate.run('owner', () => { throw new Error('fixture failure') })).rejects.toThrow('fixture failure')
  expect(gate.inspect('owner')).toEqual({ admission: 'open', writers: 0 })
  const lease = await gate.beginMaintenance('owner').drained
  lease.release()
})

test('another owner remains writable and can hold its own maintenance', async () => {
  const gate = new CodexServiceCustodyGate(), first = await gate.beginMaintenance('first').drained
  expect(await gate.run('second', () => 7)).toBe(7)
  const second = await gate.beginMaintenance('second').drained
  first.assertHeld(); second.assertHeld()
  first.release()
  expect(await gate.run('first', () => 9)).toBe(9)
  await expect(gate.run('second', () => 0)).rejects.toBeInstanceOf(CodexCustodyAdmissionError)
  second.release()
})

test('uncertain reconciliation remains closed until an explicit safe release', async () => {
  const gate = new CodexServiceCustodyGate(), lease = await gate.beginMaintenance('owner').drained
  const uncertainNativeRetirement = async () => { throw new Error('native exit unknown') }
  await expect(uncertainNativeRetirement()).rejects.toThrow('native exit unknown')
  await Promise.resolve()
  expect(gate.inspect('owner')).toEqual({ admission: 'held', writers: 0 })
  await expect(gate.run('owner', () => 'must not resume')).rejects.toBeInstanceOf(CodexCustodyAdmissionError)
  lease.assertHeld()
  // Only the coordinator's later independent resolution may release it.
  lease.release()
})

test('competing maintenance cannot queue behind or replace the active lease', async () => {
  const gate = new CodexServiceCustodyGate(), writer = gate.admit('owner')
  const request = gate.beginMaintenance('owner')
  expect(() => gate.beginMaintenance('owner')).toThrow(CodexCustodyAdmissionError)
  writer.release()
  const lease = await request.drained
  expect(() => gate.beginMaintenance('owner')).toThrow(CodexCustodyAdmissionError)
  lease.assertHeld(); lease.release()
})

test('stale writer and maintenance releases cannot unblock a newer lease', async () => {
  const gate = new CodexServiceCustodyGate(), writer = gate.admit('owner')
  const request = gate.beginMaintenance('owner')
  writer.release()
  const old = await request.drained
  old.release()
  const current = await gate.beginMaintenance('owner').drained
  writer.release(); old.release()
  expect(() => old.assertHeld()).toThrow(CodexCustodyAdmissionError)
  current.assertHeld()
  expect(() => gate.admit('owner')).toThrow(CodexCustodyAdmissionError)
  current.release()
})

test('missing owner is refused without running the writer', async () => {
  const gate = new CodexServiceCustodyGate(); let writes = 0
  await expect(gate.run('', () => writes++)).rejects.toThrow('owner is required')
  expect(() => gate.beginMaintenance('')).toThrow('owner is required')
  expect(writes).toBe(0)
})

test('already admitted queued work can finish nested writes after admission closes', async () => {
  const gate = new CodexServiceCustodyGate(), queued = pending<void>(), rows: number[] = []
  const work = gate.run('owner', async () => { await queued.promise; await gate.run('owner', () => { rows.push(1) }) })
  const request = gate.beginMaintenance('owner')
  queued.resolve(); await work
  const lease = await request.drained
  expect(rows).toEqual([1]); lease.release()
})

test('detached async context cannot reuse a settled writer admission', async () => {
  const gate = new CodexServiceCustodyGate(), deferred = pending<void>()
  let later!: Promise<unknown>
  await gate.run('owner', () => {
    later = deferred.promise.then(() => gate.run('owner', () => 'forbidden')).catch(error => error)
  })
  const lease = await gate.beginMaintenance('owner').drained
  deferred.resolve()
  expect(await later).toBeInstanceOf(CodexCustodyAdmissionError)
  lease.assertHeld(); lease.release()
})

test('nested fire-and-forget operation outlives its synchronous resolver lease', async () => {
  const gate = new CodexServiceCustodyGate(), write = pending<void>()
  let result!: Promise<void>
  gate.runSync('owner', () => { result = gate.run('owner', () => write.promise) })
  const request = gate.beginMaintenance('owner')
  expect(gate.inspect('owner')).toEqual({ admission: 'draining', writers: 1 })
  write.resolve(); await result
  const lease = await request.drained; lease.release()
})

test('a writer cannot deadlock itself by requesting its own maintenance drain', async () => {
  const gate = new CodexServiceCustodyGate()
  await expect(gate.run('owner', () => gate.beginMaintenance('owner'))).rejects.toThrow('Cannot drain')
  expect(gate.inspect('owner')).toEqual({ admission: 'open', writers: 0 })
})
