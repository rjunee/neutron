/**
 * @neutronai/scribe — reflect: the MERGE ARCHIVE (undo for an auto-merge).
 *
 * The reflect pass's dedup step fuses near-duplicate entity pages into one
 * survivor and then removes the losers from disk. Jaccard similarity is a
 * heuristic, so that judgement can be WRONG — and until this module existed the
 * removal was irreversible: a mis-clustered page was simply gone, with no way to
 * get the original back and no record that it had ever existed.
 *
 * This module makes the removal RECOVERABLE. Before a loser is unlinked, its
 * EXACT on-disk bytes are copied to
 *
 *   <ownerDataDir>/memory-archive/<kind-dir>/<slug>.<stamp>.md
 *
 * and one line describing the merge is appended to
 *
 *   <ownerDataDir>/memory-archive/merges.jsonl
 *
 * `memory-archive/` is a SIBLING of `entities/` (like `diary/` and
 * `corrections/`), deliberately OUTSIDE the tree the reflect pass and the memory
 * index enumerate — an archived page is inert: it is never scanned, never
 * re-merged, and never surfaces as live memory until the owner restores it.
 *
 * DESIGN INVARIANTS
 *
 *  1. ARCHIVE BEFORE DELETE, and a FAILED archive BLOCKS the delete. If this
 *     module throws, the caller keeps the loser on disk. There is no path that
 *     removes a page without a recoverable copy — that is the whole point.
 *  2. BYTE-EXACT. The archived file is the loser's raw body verbatim: no
 *     injected frontmatter, no header, no reformatting. Restoring it reproduces
 *     the page that was removed, byte for byte. All merge context lives in the
 *     ledger and in the filename, never in the copy.
 *  3. CONTENT-IDEMPOTENT. Re-archiving bytes already present for that
 *     (kind, slug) reuses the existing file instead of writing a second copy —
 *     so a loser whose delete keeps failing (and is therefore re-archived every
 *     pass, every 6h) cannot accrete duplicates.
 *  4. BOUNDED. `pruneMergeArchive` deletes archived copies older than
 *     `MERGE_ARCHIVE_RETENTION_MS` and drops their ledger rows, so the archive
 *     cannot grow without limit alongside the corpus it protects.
 *
 * Recovery is a first-class, non-programmer surface: `neutron memory-restore`
 * lists what was merged away and puts a page back. `README.md` is written into
 * the archive dir on first use so the same instructions are readable by anyone
 * who simply opens the folder.
 */

import { mkdir, open as fsOpen, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { ENTITY_KINDS, KIND_TO_DIR, type EntityKind } from '@neutronai/runtime/entity-format.ts'
import { SLUG_REGEX } from '@neutronai/runtime/entity-slug.ts'

/** Directory (under the owner data dir) that holds merged-away page copies. */
export const MERGE_ARCHIVE_DIRNAME = 'memory-archive'

/** Ledger filename inside the archive dir — one JSON object per line. */
export const MERGE_LEDGER_FILENAME = 'merges.jsonl'

/**
 * RETENTION POSTURE — 90 days.
 *
 * An archived copy exists to survive a WRONG merge, and a wrong merge is noticed
 * when the owner next reads (or fails to find) the page — days to weeks, not
 * months. 90 days covers that with a wide margin while keeping the guarantee
 * bounded: the archive is a fixed-horizon safety net, not a second permanent
 * copy of the corpus. Unbounded retention would silently double a growing memory
 * corpus on disk and in every backup, which is its own data problem.
 *
 * Copies are only ever created by a merge (a rare event), so 90 days of them is
 * small in practice.
 */
export const MERGE_ARCHIVE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** One archived merge — the ledger row, and what `neutron memory-restore` lists. */
export interface ArchivedMerge {
  /** ISO-8601 UTC instant the loser was archived (immediately before its delete). */
  archived_at: string
  /** Entity kind of the merged-away page. */
  kind: EntityKind
  /** Slug of the merged-away page — the identity that disappeared from `entities/`. */
  slug: string
  /** Slug of the survivor the page's content was folded INTO. */
  merged_into: string
  /** Kind of the survivor (always equal to `kind` today — dedup is within-kind). */
  merged_into_kind: EntityKind
  /** Archive-root-RELATIVE path of the byte-exact copy (e.g. `people/alice.2026-….md`). */
  file: string
  /** Size of the archived body in bytes — a cheap "is this the page I meant?" signal. */
  bytes: number
}

export interface ArchiveMergedPageInput {
  ownerDataDir: string
  /** Kind of the LOSER being archived. */
  kind: EntityKind
  /** Slug of the LOSER being archived. */
  slug: string
  /** The loser's EXACT on-disk body — the same snapshot the delete's CAS is keyed on. */
  raw: string
  /** Survivor kind/slug, recorded so a recovered page says what swallowed it. */
  mergedIntoKind: EntityKind
  mergedIntoSlug: string
  /** Injected clock (ms). Defaults to `Date.now()`. */
  now?: number
}

export interface ArchiveMergedPageResult {
  /** Archive-root-relative path of the copy. */
  file: string
  /** Absolute path of the copy. */
  path: string
  /** True when identical bytes were already archived and were reused (no new file). */
  reused: boolean
}

/**
 * The archive seam the reflect pass calls before deleting a merged-away loser.
 * Defaults to `archiveMergedPage`; tests inject a failing implementation to
 * prove a failed archive RETAINS the loser rather than deleting it.
 */
export type ReflectArchivePage = (input: ArchiveMergedPageInput) => Promise<ArchiveMergedPageResult>

/** Absolute path of the archive root for an owner data dir. */
export function mergeArchiveRoot(ownerDataDir: string): string {
  return join(ownerDataDir, MERGE_ARCHIVE_DIRNAME)
}

/** True iff canonical `child` is `root` or nested under it. */
function isUnder(root: string, child: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** `2026-08-01T12:34:56.789Z` → `2026-08-01T12-34-56-789Z` (filename-safe, sorts). */
function stampFor(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-')
}

function assertKind(kind: EntityKind): void {
  if (!ENTITY_KINDS.includes(kind)) throw new Error(`merge-archive: unknown kind: ${kind}`)
}

function assertSlug(slug: string): void {
  if (typeof slug !== 'string' || !SLUG_REGEX.test(slug)) {
    throw new Error(`merge-archive: slug must match [a-z0-9][a-z0-9-]*, got "${slug}"`)
  }
}

/**
 * Copy a merged-away loser page into the archive and record the merge in the
 * ledger. THROWS on any failure — the caller must treat a throw as "do not
 * delete this page".
 */
export async function archiveMergedPage(
  input: ArchiveMergedPageInput,
): Promise<ArchiveMergedPageResult> {
  assertKind(input.kind)
  assertKind(input.mergedIntoKind)
  assertSlug(input.slug)
  assertSlug(input.mergedIntoSlug)

  const root = mergeArchiveRoot(input.ownerDataDir)
  const kindDirName = KIND_TO_DIR[input.kind]
  const kindDir = join(root, kindDirName)
  await mkdir(kindDir, { recursive: true })
  await ensureArchiveReadme(root)

  // CONTENT-IDEMPOTENT reuse: identical bytes already archived for this page →
  // reuse that copy. Keeps a repeatedly-retried merge (a loser whose delete keeps
  // conflicting) from writing one copy per pass, forever.
  const existing = await findIdenticalArchive(kindDir, input.slug, input.raw)
  if (existing !== null) {
    return { file: `${kindDirName}/${existing}`, path: join(kindDir, existing), reused: true }
  }

  const ms = input.now ?? Date.now()
  const base = stampFor(ms)
  let name = `${input.slug}.${base}.md`
  let path = join(kindDir, name)
  // O_EXCL: never overwrite an existing archived copy. A same-millisecond
  // collision (two losers of one cluster) gets a `-2`, `-3`, … suffix.
  for (let attempt = 2; ; attempt += 1) {
    try {
      const fh = await fsOpen(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
      try {
        await fh.writeFile(input.raw, 'utf8')
      } finally {
        await fh.close().catch(() => undefined)
      }
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 50) throw err
      name = `${input.slug}.${base}-${attempt}.md`
      path = join(kindDir, name)
    }
  }

  const entry: ArchivedMerge = {
    archived_at: new Date(ms).toISOString(),
    kind: input.kind,
    slug: input.slug,
    merged_into: input.mergedIntoSlug,
    merged_into_kind: input.mergedIntoKind,
    file: `${kindDirName}/${name}`,
    bytes: Buffer.byteLength(input.raw, 'utf8'),
  }
  await appendLedger(root, entry)
  return { file: entry.file, path, reused: false }
}

/** An already-archived copy of `slug` whose bytes equal `raw`, or null. */
async function findIdenticalArchive(
  kindDir: string,
  slug: string,
  raw: string,
): Promise<string | null> {
  let names: string[]
  try {
    names = await readdir(kindDir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.startsWith(`${slug}.`) || !name.endsWith('.md')) continue
    try {
      if ((await readFile(join(kindDir, name), 'utf8')) === raw) return name
    } catch {
      // unreadable candidate → not a usable reuse target; fall through to a new copy
    }
  }
  return null
}

async function appendLedger(root: string, entry: ArchivedMerge): Promise<void> {
  const fh = await fsOpen(join(root, MERGE_LEDGER_FILENAME), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600)
  try {
    await fh.writeFile(`${JSON.stringify(entry)}\n`, 'utf8')
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/**
 * Every archived merge, oldest first. Malformed lines are skipped (the ledger is
 * an append-only log — a torn tail must never make the rest unreadable).
 */
export async function readMergeLedger(ownerDataDir: string): Promise<ArchivedMerge[]> {
  let text: string
  try {
    text = await readFile(join(mergeArchiveRoot(ownerDataDir), MERGE_LEDGER_FILENAME), 'utf8')
  } catch {
    return []
  }
  const out: ArchivedMerge[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const parsed = parseLedgerLine(trimmed)
    if (parsed !== null) out.push(parsed)
  }
  return out
}

/** Archive-relative file paths are `<kind-dir>/<slug>.<stamp>.md` — nothing else. */
const ARCHIVE_FILE_RE = /^[a-z][a-z-]*\/[a-z0-9][a-z0-9-]*\.[0-9A-Za-z-]+\.md$/

function parseLedgerLine(line: string): ArchivedMerge | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const kind = r['kind']
  const mergedIntoKind = r['merged_into_kind']
  if (typeof kind !== 'string' || !ENTITY_KINDS.includes(kind as EntityKind)) return null
  if (typeof mergedIntoKind !== 'string' || !ENTITY_KINDS.includes(mergedIntoKind as EntityKind)) return null
  if (typeof r['slug'] !== 'string' || !SLUG_REGEX.test(r['slug'])) return null
  if (typeof r['merged_into'] !== 'string' || !SLUG_REGEX.test(r['merged_into'])) return null
  if (typeof r['file'] !== 'string' || !ARCHIVE_FILE_RE.test(r['file'])) return null
  if (typeof r['archived_at'] !== 'string') return null
  return {
    archived_at: r['archived_at'],
    kind: kind as EntityKind,
    slug: r['slug'],
    merged_into: r['merged_into'],
    merged_into_kind: mergedIntoKind as EntityKind,
    file: r['file'],
    bytes: typeof r['bytes'] === 'number' ? r['bytes'] : 0,
  }
}

export interface RestoreArchivedPageInput {
  ownerDataDir: string
  /** Slug of the merged-away page to bring back. */
  slug: string
  /** Narrow to one kind when the same slug was archived under several. Optional. */
  kind?: EntityKind
  /**
   * Restore this exact archive-relative file instead of the newest copy for the
   * slug — the way to recover an OLDER snapshot when a page was merged twice.
   */
  file?: string
  /** Replace a live page that already occupies the slug. Default false (refuses). */
  overwrite?: boolean
}

export type RestoreArchivedPageResult =
  | { restored: true; path: string; entry: ArchivedMerge; body: string }
  | { restored: false; reason: 'not_found' | 'live_page_exists' | 'archive_missing'; path?: string }

/**
 * Put a merged-away page back at `entities/<kind>/<slug>.md`, byte-for-byte.
 *
 * Refuses to clobber a live page unless `overwrite` is set — recovering a bad
 * merge must never be able to destroy a good page (the exact failure mode the
 * archive exists to fix, pointed the other way).
 */
export async function restoreArchivedPage(
  input: RestoreArchivedPageInput,
): Promise<RestoreArchivedPageResult> {
  assertSlug(input.slug)
  if (input.kind !== undefined) assertKind(input.kind)

  const ledger = await readMergeLedger(input.ownerDataDir)
  const matches = ledger.filter(
    (e) =>
      e.slug === input.slug &&
      (input.kind === undefined || e.kind === input.kind) &&
      (input.file === undefined || e.file === input.file),
  )
  const entry = matches[matches.length - 1]
  if (entry === undefined) return { restored: false, reason: 'not_found' }

  const root = mergeArchiveRoot(input.ownerDataDir)
  const archivePath = resolve(root, entry.file)
  if (!isUnder(resolve(root), archivePath)) return { restored: false, reason: 'archive_missing' }
  let body: string
  try {
    body = await readFile(archivePath, 'utf8')
  } catch {
    return { restored: false, reason: 'archive_missing', path: archivePath }
  }

  const targetDir = join(input.ownerDataDir, 'entities', KIND_TO_DIR[entry.kind])
  const targetPath = join(targetDir, `${entry.slug}.md`)
  await mkdir(targetDir, { recursive: true })

  // Write to a temp sibling then rename — a restore is either fully there or not
  // at all, never a half-written page.
  const tmpPath = `${targetPath}.restore-${Date.now().toString(36)}.tmp`
  if (input.overwrite !== true) {
    try {
      await stat(targetPath)
      return { restored: false, reason: 'live_page_exists', path: targetPath }
    } catch {
      // absent → proceed
    }
  }
  await writeFile(tmpPath, body, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(tmpPath, targetPath)
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined)
    throw err
  }
  return { restored: true, path: targetPath, entry, body }
}

/**
 * Enforce the retention posture: unlink archived copies older than
 * `retentionMs` and drop the ledger rows whose file is gone. Best-effort — a
 * failure here must never sink a reflect pass.
 */
export async function pruneMergeArchive(input: {
  ownerDataDir: string
  now?: number
  retentionMs?: number
}): Promise<{ pruned: number }> {
  const root = mergeArchiveRoot(input.ownerDataDir)
  const now = input.now ?? Date.now()
  const retentionMs = input.retentionMs ?? MERGE_ARCHIVE_RETENTION_MS
  const cutoff = now - retentionMs
  let pruned = 0

  for (const kind of ENTITY_KINDS) {
    const kindDir = join(root, KIND_TO_DIR[kind])
    let names: string[]
    try {
      names = await readdir(kindDir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const p = join(kindDir, name)
      try {
        const st = await stat(p)
        if (st.mtimeMs >= cutoff) continue
        await unlink(p)
        pruned += 1
      } catch {
        // unreadable / already gone → nothing to prune
      }
    }
  }
  if (pruned > 0) await compactLedger(root, input.ownerDataDir)
  return { pruned }
}

/** Rewrite the ledger keeping only rows whose archived file still exists. */
async function compactLedger(root: string, ownerDataDir: string): Promise<void> {
  const entries = await readMergeLedger(ownerDataDir)
  const kept: ArchivedMerge[] = []
  for (const e of entries) {
    try {
      await stat(resolve(root, e.file))
      kept.push(e)
    } catch {
      // file pruned → drop the row
    }
  }
  const tmp = join(root, `${MERGE_LEDGER_FILENAME}.tmp`)
  const body = kept.map((e) => JSON.stringify(e)).join('\n')
  await writeFile(tmp, body.length > 0 ? `${body}\n` : '', { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, join(root, MERGE_LEDGER_FILENAME))
}

/**
 * The human-facing restore instructions, dropped into the archive dir the first
 * time anything is archived. Someone who opens this folder — with no access to
 * the code — must be able to work out what these files are and how to get one
 * back. Written once; never overwritten (so owner notes in it survive).
 */
const ARCHIVE_README = `# memory-archive — pages your assistant merged away

Every few hours a consolidation pass looks for near-duplicate memory pages and
merges each group into ONE page. The page that "loses" that merge is removed
from \`entities/\` — but a byte-exact copy is saved in here first, so a merge that
got it wrong can always be undone.

## What is in here

- \`<kind>/<slug>.<timestamp>.md\` — an exact copy of a page as it was, the moment
  before it was removed. Nothing was added, reformatted, or trimmed.
- \`merges.jsonl\` — one line per merge: when it happened, which page was removed,
  and which page absorbed it.

## Getting a page back

List what has been merged away:

    neutron memory-restore

Put one back:

    neutron memory-restore <slug>

That writes the page back to \`entities/<kind>/<slug>.md\` exactly as it was. It
refuses if a live page already uses that slug; add \`--force\` to replace it.

You can also just do it by hand: copy the \`.md\` file out of this folder into
\`entities/<kind>/\` and rename it to \`<slug>.md\`.

## After you restore

The page that absorbed it still carries a copy of its text, usually under a
\`## Merged\` heading. Delete that section from the surviving page — otherwise the
two pages are still near-duplicates and the next consolidation pass will merge
them again.

## How long copies are kept

90 days, then they are deleted automatically. If you think a merge was wrong,
restore it inside that window.
`

async function ensureArchiveReadme(root: string): Promise<void> {
  const path = join(root, 'README.md')
  try {
    const fh = await fsOpen(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    try {
      await fh.writeFile(ARCHIVE_README, 'utf8')
    } finally {
      await fh.close().catch(() => undefined)
    }
  } catch {
    // already there (or unwritable) — the README is a convenience, never a gate
  }
}
