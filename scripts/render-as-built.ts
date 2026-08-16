#!/usr/bin/env bun
/**
 * `bun scripts/render-as-built.ts [--out <path>]` — render the whole as-built log,
 * newest-first, from the per-entry files in `docs/as-built/` plus the frozen
 * `docs/AS_BUILT.md` archive.
 *
 * The log is STORED as one file per entry so that two concurrent builds never write
 * the same bytes (see `scripts/as-built-log.ts` for why). This is how you read it as
 * one document again. It is a render, not a source: writing the output back over
 * `docs/AS_BUILT.md` would re-create the shared file the split exists to remove, so
 * `--out` deliberately refuses that path.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { AS_BUILT_ARCHIVE, AS_BUILT_ENTRY_DIR, orderEntryFiles, renderLog } from './as-built-log.ts'

const repoRoot = resolve(import.meta.dir, '..')

function collect(): string {
  const dir = join(repoRoot, AS_BUILT_ENTRY_DIR)
  const names = existsSync(dir) ? orderEntryFiles(readdirSync(dir)) : []
  const entries = names.map((name) => ({ name, body: readFileSync(join(dir, name), 'utf8') }))
  const archivePath = join(repoRoot, AS_BUILT_ARCHIVE)
  const archive = existsSync(archivePath) ? readFileSync(archivePath, 'utf8') : ''
  return renderLog({ entries, archive })
}

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const rendered = collect()

if (outIdx === -1) {
  process.stdout.write(rendered)
} else {
  const out = args[outIdx + 1]
  if (!out) {
    process.stderr.write('--out needs a path\n')
    process.exit(2)
  }
  if (resolve(out) === join(repoRoot, AS_BUILT_ARCHIVE)) {
    process.stderr.write(
      `refusing to write the render over ${AS_BUILT_ARCHIVE}: that file is the frozen archive, and a build that appends to it re-creates the shared-offset conflict this layout removed\n`,
    )
    process.exit(2)
  }
  writeFileSync(out, rendered)
}
