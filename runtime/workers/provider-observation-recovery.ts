import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { ProviderObservation } from '../bounded-work.ts'
import { readProviderObservation } from './provider-observation.ts'

/** Existing evidence only. A fixed regular-file snapshot plus a deadline keeps
 * reconciliation telemetry from extending a pending call without bound. */
export async function recoverProviderObservation(reservation: string, identity: string,
  path: string, source: ProviderObservation['source'],
  verify?: (read: (path: string) => Promise<string>) => Promise<boolean>,
  decode: (bytes: string) => ProviderObservation | undefined = bytes => readProviderObservation(bytes, source)): Promise<ProviderObservation | undefined> {
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
