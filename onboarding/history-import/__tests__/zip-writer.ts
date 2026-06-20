/**
 * Test helper — minimal ZIP writer for fixture construction. Produces
 * either stored (method=0) or deflate (method=8) entries. Pure-Node, no
 * external deps. Used by both __tests__ and onboarding/history-import/__fixtures__/build.ts.
 *
 * NOT used in production code. The runner only ever reads zip; writing
 * is fixture-construction only.
 */

import { crc32 } from 'node:zlib'
import { deflateRawSync } from 'node:zlib'

export interface ZipWriteEntry {
  name: string
  data: Buffer
  /** 0 = stored, 8 = deflate. Default 8. */
  method?: 0 | 8
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50
const CENTRAL_DIR_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

export function writeZip(entries: ReadonlyArray<ZipWriteEntry>): Buffer {
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let cursor = 0
  for (const entry of entries) {
    const method = entry.method ?? 8
    const uncompressed = entry.data
    const crc = crc32(uncompressed)
    const compressed = method === 0 ? uncompressed : deflateRawSync(uncompressed)
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0)
    localHeader.writeUInt16LE(20, 4) // version needed
    localHeader.writeUInt16LE(0, 6) // gp flag
    localHeader.writeUInt16LE(method, 8) // method
    localHeader.writeUInt16LE(0, 10) // mod time
    localHeader.writeUInt16LE(0, 12) // mod date
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(uncompressed.length, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    localHeader.writeUInt16LE(0, 28) // extra
    const localChunk = Buffer.concat([localHeader, nameBytes, compressed])
    localChunks.push(localChunk)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(CENTRAL_DIR_SIG, 0)
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0, 8) // gp flag
    centralHeader.writeUInt16LE(method, 10) // method
    centralHeader.writeUInt16LE(0, 12) // mod time
    centralHeader.writeUInt16LE(0, 14) // mod date
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(uncompressed.length, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra
    centralHeader.writeUInt16LE(0, 32) // comment
    centralHeader.writeUInt16LE(0, 34) // disk
    centralHeader.writeUInt16LE(0, 36) // internal attrs
    centralHeader.writeUInt32LE(0, 38) // external attrs
    centralHeader.writeUInt32LE(cursor, 42) // local header offset
    const centralChunk = Buffer.concat([centralHeader, nameBytes])
    centralChunks.push(centralChunk)
    cursor += localChunk.length
  }

  const localBuf = Buffer.concat(localChunks)
  const centralBuf = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4) // disk
  eocd.writeUInt16LE(0, 6) // disk with cd
  eocd.writeUInt16LE(entries.length, 8) // entries on disk
  eocd.writeUInt16LE(entries.length, 10) // total entries
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16) // central dir offset
  eocd.writeUInt16LE(0, 20) // comment len
  return Buffer.concat([localBuf, centralBuf, eocd])
}
