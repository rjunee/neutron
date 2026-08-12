/**
 * The export verifier, driven against REAL directory trees (ISSUES #518).
 *
 * A Metro/Watchman failure produced a broken export and `eas update` published it
 * anyway — exit 0, an update id, a permalink. The OTA reached the owner's phone
 * dead, because nothing in the pipeline had ever looked at the bundle.
 *
 * EVERY CASE BELOW WRITES AN ACTUAL DIRECTORY. Not a mocked fs: the failure being
 * guarded is "the bytes on disk are not what anyone assumed", and a fake
 * filesystem is exactly the layer that would let a wrong assumption pass. The
 * Hermes magic used here is the one read off this app's own export.
 *
 * The positive control matters as much as the failures — a verifier that rejects
 * everything would "pass" a suite of only-negative tests while blocking every real
 * publish. The first test builds a well-formed export and requires it to be
 * accepted.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { verifyExpoExport } from '../verify-expo-export.ts'

const HERMES_MAGIC = Buffer.from('c61fbc03c103191f', 'hex')

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

interface BuildOptions {
  /** Override the bytes written for a platform's bundle. */
  bundleBytes?: Partial<Record<'ios' | 'android', Buffer>>
  /** Drop a platform from metadata entirely. */
  omitPlatform?: 'ios' | 'android'
  /** Declare an asset in metadata without writing it. */
  missingAsset?: boolean
  /** Point metadata at a bundle path that is never written. */
  danglingBundle?: boolean
  /** Write invalid JSON instead of metadata. */
  corruptMetadata?: boolean
}

/** A realistic Hermes bundle: the true magic plus enough bytes to clear the floor. */
function realBundle(): Buffer {
  return Buffer.concat([HERMES_MAGIC, Buffer.alloc(32 * 1024, 0x41)])
}

function buildExport(opts: BuildOptions = {}): string {
  const dist = mkdtempSync(join(tmpdir(), 'verify-export-'))
  dirs.push(dist)
  if (opts.corruptMetadata === true) {
    writeFileSync(join(dist, 'metadata.json'), '{ this is not json')
    return dist
  }
  const fileMetadata: Record<string, unknown> = {}
  for (const platform of ['ios', 'android'] as const) {
    if (opts.omitPlatform === platform) continue
    const rel = `_expo/static/js/${platform}/entry-deadbeef.hbc`
    const assetRel = `assets/${platform}-icon.png`
    fileMetadata[platform] = { bundle: rel, assets: [{ path: assetRel, ext: 'png' }] }
    if (opts.danglingBundle !== true) {
      const abs = join(dist, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, opts.bundleBytes?.[platform] ?? realBundle())
    }
    if (opts.missingAsset !== true) {
      const absAsset = join(dist, assetRel)
      mkdirSync(dirname(absAsset), { recursive: true })
      writeFileSync(absAsset, Buffer.alloc(64, 0x89))
    }
  }
  writeFileSync(join(dist, 'metadata.json'), JSON.stringify({ version: 0, bundler: 'metro', fileMetadata }))
  return dist
}

describe('a well-formed export is ACCEPTED', () => {
  test('the positive control — otherwise a reject-everything verifier looks correct', () => {
    const result = verifyExpoExport(buildExport())
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    // And it reports what it actually checked, so a passing run is auditable.
    expect(result.checked.some((c) => c.includes('magic ok'))).toBe(true)
  })
})

describe('the shapes a broken export actually takes', () => {
  test('no metadata.json at all — the export never completed', () => {
    const empty = mkdtempSync(join(tmpdir(), 'verify-export-empty-'))
    dirs.push(empty)
    const result = verifyExpoExport(empty)
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toContain('no metadata.json')
  })

  test('metadata.json is not valid JSON — a partial write', () => {
    const result = verifyExpoExport(buildExport({ corruptMetadata: true }))
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toContain('not valid JSON')
  })

  test('a platform is missing — that device would receive nothing', () => {
    const result = verifyExpoExport(buildExport({ omitPlatform: 'android' }))
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toContain('no `android` entry')
  })

  test('metadata points at a bundle that was never written', () => {
    const result = verifyExpoExport(buildExport({ danglingBundle: true }))
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toContain('does not exist on disk')
  })

  test('an HTML ERROR PAGE saved under a .hbc name', () => {
    // The exact shape that fooled a debugging session: an unauthenticated fetch
    // returned a 1.7 KB HTML error page, and it read as an empty bundle. Size
    // alone would catch this one; the magic check catches it even at full size.
    const html = Buffer.concat([
      Buffer.from('<!doctype html><title>Error</title>'),
      Buffer.alloc(32 * 1024, 0x20),
    ])
    const result = verifyExpoExport(buildExport({ bundleBytes: { android: html } }))
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toContain('does not start with the Hermes magic')
  })

  test('a TRUNCATED bundle that still has the right magic', () => {
    // Structurally recognisable and completely useless — the case the magic check
    // alone would wave through, which is why the size floor exists beside it.
    const stub = Buffer.concat([HERMES_MAGIC, Buffer.alloc(64, 0)])
    const result = verifyExpoExport(buildExport({ bundleBytes: { ios: stub } }))
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toContain('under the')
  })

  test('an EMPTY bundle file', () => {
    const result = verifyExpoExport(buildExport({ bundleBytes: { ios: Buffer.alloc(0) } }))
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toContain('bundle is 0 bytes')
  })

  test('a declared asset that is missing from disk', () => {
    const result = verifyExpoExport(buildExport({ missingAsset: true }))
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toContain('asset(s) missing')
  })
})

describe('the failure message is usable at 3am', () => {
  test('it names the platform, the file, and what it found instead', () => {
    const html = Buffer.concat([Buffer.from('<html>'), Buffer.alloc(32 * 1024, 0x20)])
    const result = verifyExpoExport(buildExport({ bundleBytes: { android: html } }))
    const problem = result.problems.join(' ')
    expect(problem).toContain('android')
    expect(problem).toContain('.hbc')
    // The bytes it actually saw — without them the reader cannot tell a truncated
    // write from an error page from a wrong-format file.
    expect(problem).toContain('found 3c68746d6c3e')
  })
})
