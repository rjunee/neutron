import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
 * Write launcher-held brief segments by path so they never transit a model.
 * This manifest is consumed by T3 and `NEUTRON_CODEX_BUILD_BRIEF_PARTS` in
 * `codex-build.sh`; it addresses defect 2026-08-13 run `000cedc8`, where a
 * bridge model deterministically dropped about 1,660 bytes while retyping a
 * 26 KB brief. Node's `utf8` encoder also replaces lone surrogates with U+FFFD,
 * so the bytes on disk match the integrity byte count even for malformed input;
 * tests assert that contract.
 */
export function writeBriefParts(opts: {
  runId: string
  task: string
  reflectionGuidance: string
  dir?: string
}): BriefParts | null {
  try {
    if (typeof opts.task !== 'string' || opts.task === '') return null
    const dir = opts.dir ?? '/tmp'
    const safeRunId = String(opts.runId).replace(/[^A-Za-z0-9._-]/g, '-')
    const taskFile = join(dir, `trident-brief-${safeRunId}-task.part`)
    const reflectionFile = join(dir, `trident-brief-${safeRunId}-reflection.part`)

    writeFileSync(taskFile, opts.task, 'utf8')
    if (typeof opts.reflectionGuidance === 'string' && opts.reflectionGuidance !== '') {
      writeFileSync(reflectionFile, opts.reflectionGuidance, 'utf8')
      return {
        taskFile,
        taskIntegrity: briefIntegrity(opts.task),
        reflectionFile,
        reflectionIntegrity: briefIntegrity(opts.reflectionGuidance),
      }
    }
    return {
      taskFile,
      taskIntegrity: briefIntegrity(opts.task),
      reflectionFile: null,
      reflectionIntegrity: null,
    }
  } catch {
    return null
  }
}
