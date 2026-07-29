/**
 * @neutronai/onboarding/synthesis — per-project seed-file writer (Step 2).
 *
 * Turns a `ProjectSeed` (synthesis output) into the initial files that
 * populate a project's repo on accept, per the design + the project-folder
 * convention (`docs/plans/project-folder-convention.md` § 3 doc set / § 4
 * STATUS.md frontmatter):
 *
 *   - `STATUS.md` — § 4 frontmatter + status + open threads.
 *   - `docs/history.md` — overview + open threads + the routed conversation list.
 *   - `research/transcripts/<conversation_id>.md` — the bucketed RAW transcripts
 *     (the project's source corpus + the gbrain feed when that's wired).
 *
 * For the no-import (interview-only) path a seed simply carries no
 * conversation_ids, so no raw transcripts are written — the STATUS + history
 * still stand the project up (a minimal-but-real wow).
 *
 * Discipline: create-if-missing only (never clobber a file the user edited),
 * best-effort, failure-isolated (one project's failure never blocks another),
 * and NO em dashes in generated prose (house style). The git init/commit
 * for the repo is owned by the project materializer; this writer only lays
 * down the seed files.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createLogger } from '@neutronai/logger'
import { join } from 'node:path'
import type { RawTranscriptStore } from './raw-store.ts'
import { rawFilenameFor } from './raw-store.ts'
import type { ConversationSignal, ProjectSeed } from './types.ts'

/** § 3.1 subdirs created when seeding a project. */
export const SEED_SUBDIRS = ['docs', 'research', join('research', 'transcripts')] as const

export interface WriteProjectSeedDeps {
  /** OWNER_ROOT — projects land under `<owner_home>/Projects/<slug>/`. */
  owner_home: string
  /** Raw-transcript corpus the routed conversation_ids resolve against. */
  rawStore: RawTranscriptStore
  now(): number
  /** Optional signal lookup so the history doc can title each routed transcript. */
  signalsById?: ReadonlyMap<string, ConversationSignal>
  logFailure?: (owner_slug: string, stage: string, err: unknown) => void
}

export interface WriteProjectSeedOutcome {
  owner_slug: string
  reason: 'created' | 'already_seeded' | 'failed'
  /** Repo-relative paths written this run. */
  docs_written: string[]
  /** Raw transcripts written under research/transcripts/. */
  transcripts_written: number
  error?: string
}

/**
 * Write one project's seed files. Idempotent: an existing `STATUS.md` marks
 * the project seeded and the call is a no-op (never clobber user edits).
 */
export function writeProjectSeed(
  deps: WriteProjectSeedDeps,
  seed: ProjectSeed,
): WriteProjectSeedOutcome {
  const logFailure = deps.logFailure ?? defaultLogFailure
  const out: WriteProjectSeedOutcome = {
    owner_slug: seed.slug,
    reason: 'created',
    docs_written: [],
    transcripts_written: 0,
  }
  const root = join(deps.owner_home, 'Projects', seed.slug)
  try {
    if (existsSync(join(root, 'STATUS.md'))) {
      out.reason = 'already_seeded'
      return out
    }
    mkdirSync(root, { recursive: true })
    for (const sub of SEED_SUBDIRS) mkdirSync(join(root, sub), { recursive: true })

    // 1) Routed raw transcripts (the project's source corpus).
    for (const convId of seed.conversation_ids) {
      const text = deps.rawStore.get(convId)
      if (text === null || text.trim().length === 0) continue
      const rel = join('research', 'transcripts', rawFilenameFor(convId))
      writeDocIfMissing(root, rel, `${ensureTrailingNewline(text)}`, out)
      out.transcripts_written += 1
    }

    // 2) docs/history.md — overview + open threads + routed conversation list.
    writeDocIfMissing(root, join('docs', 'history.md'), renderHistory(seed, deps.signalsById), out)

    // 3) STATUS.md LAST — the § 4 frontmatter + completion marker.
    writeDocIfMissing(root, 'STATUS.md', renderStatus(seed, deps.now()), out)

    return out
  } catch (err) {
    out.reason = 'failed'
    out.error = err instanceof Error ? err.message : String(err)
    logFailure(seed.slug, 'write_seed', err)
    return out
  }
}

/** Write every seed; failure-isolated (one project never blocks the rest). */
export function writeAllProjectSeeds(
  deps: WriteProjectSeedDeps,
  seeds: ReadonlyArray<ProjectSeed>,
): WriteProjectSeedOutcome[] {
  return seeds.map((seed) => writeProjectSeed(deps, seed))
}

// ── Rendering (deterministic; NO em dashes) ─────────────────────────────────

function renderStatus(seed: ProjectSeed, nowMs: number): string {
  const date = new Date(nowMs).toISOString().slice(0, 10)
  const oneLiner = firstSentence(seed.overview.length > 0 ? seed.overview : seed.name, 160)
  const threads =
    seed.open_threads.length > 0
      ? seed.open_threads.map((t) => `- ${t}`).join('\n')
      : '- No open threads captured yet.'
  return (
    `---\n` +
    `name: ${seed.slug}\n` +
    `status: active\n` +
    `priority: P2\n` +
    `one_liner: ${JSON.stringify(oneLiner)}\n` +
    `remote: local\n` +
    `last_updated: ${date}\n` +
    `---\n` +
    `\n` +
    `# ${seed.name}\n` +
    `\n` +
    `${seed.overview.length > 0 ? seed.overview : 'Created from your onboarding synthesis.'}\n` +
    `\n` +
    `Current status: ${seed.status.length > 0 ? seed.status : 'active'}\n` +
    `\n` +
    `## Open threads\n` +
    `\n` +
    `${threads}\n`
  )
}

function renderHistory(
  seed: ProjectSeed,
  signalsById: ReadonlyMap<string, ConversationSignal> | undefined,
): string {
  const lines: string[] = [
    `# ${seed.name} - history`,
    '',
    'Synthesized from your onboarding history import. Treat the raw transcripts in',
    '`research/transcripts/` as read-only source material and cite them when drawing',
    'on imported context.',
    '',
    '## Overview',
    '',
    seed.overview.length > 0 ? seed.overview : 'No overview was synthesized for this project.',
    '',
  ]
  if (seed.open_threads.length > 0) {
    lines.push('## Open threads', '')
    for (const t of seed.open_threads) lines.push(`- ${t}`)
    lines.push('')
  }
  if (seed.conversation_ids.length > 0) {
    lines.push(
      `## Source conversations (${seed.conversation_ids.length})`,
      '',
      'Raw transcripts routed to this project during synthesis:',
      '',
    )
    for (const convId of seed.conversation_ids) {
      const sig = signalsById?.get(convId)
      const title = sig !== undefined && sig.title.length > 0 ? sig.title : '(untitled)'
      lines.push(`- ${title} (\`research/transcripts/${rawFilenameFor(convId)}\`)`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function writeDocIfMissing(
  root: string,
  relpath: string,
  body: string,
  out: WriteProjectSeedOutcome,
): void {
  const abs = join(root, relpath)
  if (existsSync(abs)) return
  writeFileSync(abs, body, 'utf8')
  out.docs_written.push(relpath)
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`
}

function firstSentence(s: string, maxChars: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  const boundary = flat.search(/[.!?](\s|$)/)
  const sentence = boundary === -1 ? flat : flat.slice(0, boundary + 1)
  return sentence.length <= maxChars ? sentence : `${sentence.slice(0, maxChars - 3).trimEnd()}...`
}

const log = createLogger('seed-writer')

function defaultLogFailure(owner_slug: string, stage: string, err: unknown): void {
  log.warn('failure', {
    project: owner_slug,
    stage,
    error: err instanceof Error ? err.message : String(err),
  })
}
