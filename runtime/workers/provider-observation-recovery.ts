import { constants } from 'node:fs'
import { open, rename, writeFile } from 'node:fs/promises'
import type { ProviderObservation } from '../bounded-work.ts'
import { readProviderObservation } from './provider-observation.ts'

export function decodeObservationReceipt(bytes: string, identity: string, source: ProviderObservation['source']): ProviderObservation | undefined {
  try {
    const value = JSON.parse(bytes)
    if (value && Object.hasOwn(value, 'identity')) {
      return value.identity === identity ? readProviderObservation(JSON.stringify(value.observation), source) : undefined
    }
    // Existing immutable CLI receipts are still bound by their armed reservation.
    return readProviderObservation(bytes, source)
  } catch { return undefined }
}

/** One dispatch owns this path. Publish absolute observations atomically during
 * execution, then make one bounded final retry. Failed persistence never replaces
 * newer in-memory measurements with an older durable snapshot. */
export function createObservationPublisher(path: string, identity: string) {
  let latest: ProviderObservation | undefined
  let signature = ''
  let writes = Promise.resolve()
  let pending: ProviderObservation | undefined
  let writing = false
  const publish = (next: ProviderObservation, force = false): ProviderObservation => {
    if (latest && (latest.source !== next.source || (latest.thread_id && next.thread_id && latest.thread_id !== next.thread_id))) return latest
    const usage = { ...next.usage }
    for (const key of Object.keys(usage) as (keyof typeof usage)[]) {
      const prior = latest?.usage[key] ?? null
      if (prior !== null) usage[key] = usage[key] === null ? prior : Math.max(prior, usage[key]!)
    }
    const observation = { ...next, usage, thread_id: next.thread_id ?? latest?.thread_id ?? null,
      model_reported: next.model_reported ?? latest?.model_reported ?? null }
    latest = observation
    const serialized = JSON.stringify([observation.thread_id, observation.model_reported, usage])
    if (!force && serialized === signature) return observation
    signature = serialized
    // Coalesce absolute updates behind one writer; a slow disk cannot grow an
    // unbounded queue of receipt copies. The last cumulative snapshot suffices.
    pending = observation
    if (!writing) {
      writing = true
      writes = (async () => {
        try {
          while (pending) {
            const current = pending; pending = undefined
            try {
              const temporary = `${path}.tmp`
              await writeFile(temporary, JSON.stringify({ identity, observation: current }), { mode: 0o600 })
              await rename(temporary, path)
            } catch { /* Keep memory measurements; terminal settlement retries. */ }
          }
        } finally { writing = false }
      })()
    }
    return observation
  }
  return { publish,
    async settle(next: ProviderObservation): Promise<ProviderObservation> {
      const result = publish(next, true)
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([writes, new Promise<void>(resolve => { timer = setTimeout(resolve, 250) })]) }
      finally { clearTimeout(timer) }
      return result
    },
  }
}

/** Existing evidence only. A fixed regular-file snapshot plus a deadline keeps
 * reconciliation telemetry from extending a pending call without bound. */
export async function recoverProviderObservation(reservation: string, identity: string,
  path: string, source: ProviderObservation['source'],
  verify?: (read: (path: string) => Promise<string>) => Promise<boolean>,
  decode: (bytes: string) => ProviderObservation | undefined = bytes => decodeObservationReceipt(bytes, identity, source)): Promise<ProviderObservation | undefined> {
  const controller = new AbortController()
  const read = async (path: string): Promise<string> => {
    controller.signal.throwIfAborted()
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      controller.signal.throwIfAborted()
      const info = await file.stat()
      if (!info.isFile() || info.size > 256 * 1024) throw new Error('Unbounded observation recovery evidence')
      const bytes = Buffer.alloc(info.size)
      let offset = 0
      while (offset < bytes.length) {
        controller.signal.throwIfAborted()
        const result = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!result.bytesRead) throw new Error('Observation evidence truncated')
        offset += result.bytesRead
      }
      controller.signal.throwIfAborted()
      return bytes.toString('utf8')
    } finally { await file.close() }
  }
  const collect = async () => {
    try {
      if (await read(reservation) !== identity + '\n#dispatch-armed\n') return undefined
      if (verify && !await verify(read)) return undefined
      return decode(await read(path))
    } catch { return undefined }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(undefined) }, 250)
  })
  try { return await Promise.race([collect(), timeout]) }
  finally { clearTimeout(timer); controller.abort() }
}
