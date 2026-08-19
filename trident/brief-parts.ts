import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@neutronai/logger'

const log = createLogger('trident-brief-parts')

/**
 * Launcher-side twin of `briefIntegrity` in `inner-workflow.mjs`, pinned by a
 * parity test and MUST NOT drift. The receipt enforced by the codex wrapper is
 * computed by the `.mjs` function over the same string.
 */
export function briefIntegrity(text: string): string {
  let bytes = 0
  let h = 0x811c9dc5
  const push = (b: number) => {
    bytes++
    h = Math.imul(h ^ b, 0x01000193) >>> 0
  }
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
        i++
      } else {
        cp = 0xfffd
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd
    }
    if (cp < 0x80) {
      push(cp)
    } else if (cp < 0x800) {
      push(0xc0 | (cp >> 6))
      push(0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      push(0xe0 | (cp >> 12))
      push(0x80 | ((cp >> 6) & 0x3f))
      push(0x80 | (cp & 0x3f))
    } else {
      push(0xf0 | (cp >> 18))
      push(0x80 | ((cp >> 12) & 0x3f))
      push(0x80 | ((cp >> 6) & 0x3f))
      push(0x80 | (cp & 0x3f))
    }
  }
  return `${bytes}:${h.toString(16).padStart(8, '0')}`
}

/**
 * Byte-domain twin of `briefIntegrity` and `codex-build.sh`'s `fnv_receipt`.
 * For every string, including lone surrogates, this invariant holds:
 * `bufferIntegrity(Buffer.from(s, 'utf8')) === briefIntegrity(s)`. Node replaces
 * lone surrogates with U+FFFD before exposing their UTF-8 bytes.
 */
export function bufferIntegrity(data: Uint8Array): string {
  let h = 0x811c9dc5
  for (const byte of data) h = Math.imul(h ^ byte, 0x01000193) >>> 0
  return `${data.length}:${h.toString(16).padStart(8, '0')}`
}

/**
 * By-path manifest for launcher-held brief segments. These files never transit
 * a model: T3 consumes the manifest with `NEUTRON_CODEX_BUILD_BRIEF_PARTS` in
 * `codex-build.sh`, fixing defect 2026-08-13 run `000cedc8` where a bridge model
 * deterministically dropped about 1,660 bytes while retyping a 26 KB brief.
 */
export interface BriefParts {
  taskFile: string
  taskIntegrity: string
  reflectionFile: string | null
  reflectionIntegrity: string | null
}

/**
 * Write the authoritative launcher-held brief segments by path so they never
 * transit a model. Every receipt is returned only after the file has been read
 * back and its persisted bytes match the composed text's receipt. A mismatch is
 * rewritten once, then the whole manifest is refused rather than describing
 * bytes that are not readable at its paths. `codex-build.sh` independently
 * verifies the same receipt before assembly. Node's `utf8` encoder replaces
 * lone surrogates with U+FFFD; parity tests pin that byte contract.
 */
export function writeBriefParts(opts: {
  runId: string
  task: string
  reflectionGuidance: string
  dir?: string
  io?: {
    write_file?: (path: string, data: Uint8Array) => void
    read_file?: (path: string) => Buffer
  }
  warn?: (message: string) => void
}): BriefParts | null {
  if (typeof opts.task !== 'string' || opts.task === '') return null
  const warn = opts.warn ?? ((message: string) => log.warn('brief_part_write_failed', { message }))
  const safeRunId = String(opts.runId).replace(/[^A-Za-z0-9._-]/g, '-')
  try {
    const dir = opts.dir ?? '/tmp'
    const taskFile = join(dir, `trident-brief-${safeRunId}-task.part`)
    const reflectionFile = join(dir, `trident-brief-${safeRunId}-reflection.part`)
    const writeFile = opts.io?.write_file ?? writeFileSync
    const readFile = opts.io?.read_file ?? readFileSync

    const writeVerified = (file: string, text: string): string | null => {
      const data = Buffer.from(text, 'utf8')
      const expected = briefIntegrity(text)
      writeFile(file, data)
      let measured = bufferIntegrity(readFile(file))
      if (measured === expected) return expected

      writeFile(file, data)
      measured = bufferIntegrity(readFile(file))
      if (measured === expected) return expected

      warn(
        `brief-parts: ${file} persisted ${measured} but composed ${expected} (<bytes>:<fnv32>) after one rewrite — refusing to emit a receipt the bytes on disk do not match`,
      )
      return null
    }

    const taskIntegrity = writeVerified(taskFile, opts.task)
    if (taskIntegrity === null) return null
    if (typeof opts.reflectionGuidance === 'string' && opts.reflectionGuidance !== '') {
      const reflectionIntegrity = writeVerified(reflectionFile, opts.reflectionGuidance)
      // A task-only manifest here would silently omit non-empty owner guidance.
      if (reflectionIntegrity === null) return null
      return {
        taskFile,
        taskIntegrity,
        reflectionFile,
        reflectionIntegrity,
      }
    }
    return {
      taskFile,
      taskIntegrity,
      reflectionFile: null,
      reflectionIntegrity: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warn(`brief-parts: write failed for run ${safeRunId}: ${message}`)
    return null
  }
}
