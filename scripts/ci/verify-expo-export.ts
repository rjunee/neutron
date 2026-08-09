/**
 * PROVE AN EXPO EXPORT IS REAL BEFORE IT IS PUBLISHED AS AN OTA (ISSUES #518).
 *
 * WHAT HAPPENED. A Metro/Watchman failure produced a broken export and
 * `eas update` published it anyway — exit 0, an update id, a permalink, all the
 * signals of success. The OTA reached the owner's phone DEAD. Nothing in the
 * pipeline had ever looked at what was being shipped.
 *
 * WHY THE OBVIOUS CHECKS DON'T WORK, learned the hard way while debugging that
 * same incident. The bundle is Hermes BYTECODE, so `grep` for a symbol you know
 * you just added returns nothing — and reads as "the code is missing" rather than
 * "this tool cannot read this format". Three wrong diagnoses came out of that in
 * one session. A text search over a binary is not a check; it is a coin flip that
 * always lands the same way.
 *
 * SO THIS CHECKS THE FORMAT, NOT THE CONTENT. A Hermes bundle begins with a fixed
 * 8-byte magic. Truncated output, an empty file, an HTML error page saved under a
 * `.hbc` name — every shape the broken export can take fails that check
 * immediately and for a legible reason. The magic below was read off a REAL
 * bundle produced by this app's own export (`c61fbc03c103191f`, bytecode version
 * 96), not recalled.
 *
 * The size floor is the second half. A structurally valid but nearly empty bundle
 * would pass the magic check; a real export of this app is ~2.6 MB, so a floor
 * three hundred times smaller than that still catches a stub while never firing on
 * a legitimately shrinking app.
 *
 * Run: `bun run scripts/ci/verify-expo-export.ts <dist-dir>`
 * Exit 0 = safe to publish. Exit 1 = do NOT publish, with the reason on stderr.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The first eight bytes of every Hermes bytecode file. Read off a real export
 * rather than remembered — see the note above.
 */
const HERMES_MAGIC = Buffer.from('c61fbc03c103191f', 'hex')

/**
 * The floor a real bundle must clear. This app's export is ~2.6 MB; 8 KB is small
 * enough never to fire on a genuine shrink and large enough to catch a stub, an
 * error page, or a truncated write.
 */
const MIN_BUNDLE_BYTES = 8 * 1024

/** Platforms an OTA must carry. Publishing one without the other strands a device. */
const REQUIRED_PLATFORMS = ['ios', 'android'] as const

export interface VerifyResult {
  ok: boolean
  /** Human-readable reasons, one per failed check. Empty when ok. */
  problems: string[]
  /** What was checked, for the caller to print on success. */
  checked: string[]
}

interface FileMetadata {
  bundle?: unknown
  assets?: unknown
}

/**
 * Verify an export directory. PURE apart from filesystem reads, so the test can
 * build real trees on disk and drive every failure shape.
 */
export function verifyExpoExport(distDir: string): VerifyResult {
  const problems: string[] = []
  const checked: string[] = []

  const metadataPath = join(distDir, 'metadata.json')
  if (!existsSync(metadataPath)) {
    return {
      ok: false,
      problems: [`no metadata.json in ${distDir} — the export did not complete`],
      checked,
    }
  }

  let metadata: { fileMetadata?: Record<string, FileMetadata> }
  try {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as typeof metadata
  } catch (err) {
    return {
      ok: false,
      problems: [`metadata.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`],
      checked,
    }
  }
  checked.push('metadata.json parses')

  const fileMetadata = metadata.fileMetadata ?? {}
  for (const platform of REQUIRED_PLATFORMS) {
    const entry = fileMetadata[platform]
    if (entry === undefined) {
      problems.push(`metadata.json has no \`${platform}\` entry — that platform would ship nothing`)
      continue
    }
    const bundleRel = typeof entry.bundle === 'string' ? entry.bundle : null
    if (bundleRel === null || bundleRel.length === 0) {
      problems.push(`${platform}: metadata declares no bundle path`)
      continue
    }
    const bundlePath = join(distDir, bundleRel)
    if (!existsSync(bundlePath)) {
      problems.push(`${platform}: metadata points at ${bundleRel}, which does not exist on disk`)
      continue
    }

    const size = statSync(bundlePath).size
    if (size < MIN_BUNDLE_BYTES) {
      problems.push(
        `${platform}: bundle is ${size} bytes, under the ${MIN_BUNDLE_BYTES}-byte floor — ` +
          'a stub, an error page, or a truncated write, not a real bundle',
      )
      continue
    }

    // FORMAT, not content. A `.hbc` must actually be Hermes bytecode; anything
    // else — HTML, a partial write, plain text — fails here with a legible reason
    // instead of shipping and failing on the device.
    if (bundlePath.endsWith('.hbc')) {
      const head = Buffer.alloc(HERMES_MAGIC.length)
      const fd = readFileSync(bundlePath)
      fd.copy(head, 0, 0, HERMES_MAGIC.length)
      if (!head.equals(HERMES_MAGIC)) {
        problems.push(
          `${platform}: ${bundleRel} is named .hbc but does not start with the Hermes magic ` +
            `(found ${head.toString('hex')}, expected ${HERMES_MAGIC.toString('hex')})`,
        )
        continue
      }
      checked.push(`${platform}: Hermes bundle, ${size} bytes, magic ok`)
    } else {
      // A JSC/plain-JS export is legitimate if the app is configured that way, so
      // this is not a failure — but it gets the size floor and nothing more, and
      // says so rather than implying it was format-checked.
      checked.push(`${platform}: non-Hermes bundle, ${size} bytes, size-checked only`)
    }

    const assets = Array.isArray(entry.assets) ? entry.assets : []
    const missing = assets
      .map((a) => (typeof a === 'object' && a !== null ? (a as { path?: unknown }).path : null))
      .filter((p): p is string => typeof p === 'string')
      .filter((p) => !existsSync(join(distDir, p)))
    if (missing.length > 0) {
      problems.push(
        `${platform}: ${missing.length} declared asset(s) missing from disk, e.g. ${missing[0]}`,
      )
      continue
    }
    checked.push(`${platform}: ${assets.length} declared assets all present`)
  }

  return { ok: problems.length === 0, problems, checked }
}

if (import.meta.main) {
  const distDir = process.argv[2]
  if (distDir === undefined || distDir.length === 0) {
    process.stderr.write('usage: bun run scripts/ci/verify-expo-export.ts <dist-dir>\n')
    process.exit(2)
  }
  const result = verifyExpoExport(distDir)
  for (const line of result.checked) process.stdout.write(`  ok  ${line}\n`)
  if (result.ok) {
    process.stdout.write('EXPORT VERIFIED — safe to publish\n')
    process.exit(0)
  }
  for (const p of result.problems) process.stderr.write(`  FAIL  ${p}\n`)
  process.stderr.write('EXPORT NOT VERIFIED — refusing to publish\n')
  process.exit(1)
}
