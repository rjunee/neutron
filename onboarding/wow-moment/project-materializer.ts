/**
 * @neutronai/onboarding/wow-moment — project materializer (Item 4).
 *
 * Per docs/plans/post-onboarding-experience-spec-2026-06-10.md § ITEM 4 +
 * docs/plans/project-folder-convention.md § 3 (standard doc set) / § 4
 * (STATUS.md frontmatter schema): a confirmed project is not just a
 * `projects` DB row — it is a REAL self-contained git repo at
 * `<OWNER_ROOT>/Projects/<id>/` carrying the standard doc set the
 * post-onboarding agent (Item 1) and the opening-message generator
 * (Item 5) draw on.
 *
 * What `materialize()` produces per project:
 *
 *   1. The § 3.1 layout — `README.md`, `CLAUDE.md`, `STATUS.md` (with the
 *      § 4 required frontmatter), plus `docs/` `research/` `notes/`
 *      `archive/` subdirs, `git init`ed + committed (§ 3.3 mandatory git).
 *   2. Per-project transcript slices — raw `import_pass1_chunks.chunk_text`
 *      rows (retained since migration 0063) whose Pass-1 candidate
 *      entities/topics relate to the project, written to
 *      `research/transcripts/imported-transcript-slices.md`.
 *   3. `docs/transcript-summary.md` — LLM-synthesized from the slices via
 *      the injected composer (CC substrate in production — NO direct
 *      api.anthropic.com, hard rule), deterministic fallback otherwise.
 *   4. A memory-index call via the injected indexer (production: project
 *      page through `writeEntity(kind='project')` + the GBrain sync hook)
 *      so the Item-1 agent's `memoryStore.query` surfaces the project.
 *
 * Discipline (spec § 4.2): materialization is BEST-EFFORT and
 * failure-isolated — a project's failure never throws out of
 * `materialize()`, never blocks sibling projects, and never rolls back
 * the `projects`/`topics` rows `03-project-shells` already committed.
 * Idempotent: an existing `STATUS.md` marks the project materialized and
 * the run is a no-op (the overnight wow pass re-fires DAILY; user edits
 * must never be clobbered). Individual doc writes are
 * create-if-missing-only so a partial prior failure self-heals without
 * overwriting anything a user touched.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProjectDb } from '../../persistence/index.ts'
import type { ImportResult } from '../history-import/types.ts'
import type { CapturedProject } from './action-types.ts'
import { OVERNIGHT_OPT_IN_KEY } from '../overnight/status-md-sync.ts'
import {
  findRelatedImportSignal,
  hasRealProjectContext,
  namesRelate,
  synthesizeProjectContext,
  weaveRelatedSignal,
  type RelatedImportSignal,
} from './project-identity.ts'

const execFileAsync = promisify(execFile)

/** Relative path (inside the project repo) of the raw-slices doc. */
export const TRANSCRIPT_SLICES_RELPATH = join(
  'research',
  'transcripts',
  'imported-transcript-slices.md',
)
/** Relative path (inside the project repo) of the summary doc. */
export const TRANSCRIPT_SUMMARY_RELPATH = join('docs', 'transcript-summary.md')

/** § 3.1 subdirs created on materialization (besides the repo root). */
export const PROJECT_SUBDIRS = ['docs', 'research', 'notes', 'archive'] as const

/**
 * Hard cap on raw slice bytes written per project. A 200MB ChatGPT
 * export sliced into one hot project must not produce an unboundedly
 * large markdown file; past the cap the doc notes the truncation and
 * points at the import tables.
 */
export const MAX_SLICE_BYTES = 1_000_000

/**
 * Hard cap on the transcript excerpt handed to the LLM composer for the
 * summary doc. Bounded so a summary call stays one well-sized prompt.
 */
export const MAX_COMPOSER_EXCERPT_CHARS = 48_000

/** Bounded concurrency for materializing N projects (spec § 4.2c). */
export const MATERIALIZE_CONCURRENCY = 2

/** What the LLM composer is asked to write. */
export interface ComposeProjectDocInput {
  kind: 'readme' | 'transcript_summary'
  project_name: string
  slug: string
  /** Synthesized at-rest context paragraph (always non-empty). */
  context: string
  /** Cross-project import signal related to this project by name. */
  related: RelatedImportSignal
  /** Raw transcript excerpt ('' when no slices matched). */
  transcript_excerpt: string
}

/**
 * LLM doc composer. Production wires the CC-substrate-backed messages
 * client (gateway/realmode-composer/build-project-doc-composer.ts);
 * tests inject a deterministic stub. Throw → caller falls back to the
 * deterministic template (failure-isolated per spec § 4.2c).
 */
export type ProjectDocComposer = (input: ComposeProjectDocInput) => Promise<string>

/**
 * Memory-layer index hook. Production writes the project's canonical
 * page through `writeEntity(kind='project')` with the GBrain sync hook
 * (spec § 4.2d); tests inject a recorder. Failures are swallowed + logged.
 */
export type ProjectPageIndexFn = (input: {
  /** The project id (folder name under Projects/). */
  project_slug: string
  name: string
  /** Rendered page body (project overview + transcript summary digest). */
  body: string
  /** Instance-root-relative folder, e.g. `Projects/topline`. */
  source_path: string
}) => Promise<void>

export interface ProjectMaterializerDeps {
  /** OWNER_ROOT (per project-folder-convention § 2.0). */
  owner_home: string
  project_slug: string
  /** Project DB — read-only here (import_pass1_chunks slicing). */
  db: ProjectDb
  now(): number
  composer?: ProjectDocComposer | null
  indexer?: ProjectPageIndexFn | null
  /** Test seam — git subprocess runner. Default shells out to `git`. */
  runGit?: (args: string[], cwd: string) => Promise<void>
  /** Failure sink. Default console.warn. */
  logFailure?: (stage: string, project_slug: string, err: unknown) => void
}

export interface MaterializeProjectInput {
  project: CapturedProject
  /** Resolved project id == folder name (the `projects.id` the row binds to). */
  slug: string
  import_result: ImportResult | null
}

export interface MaterializeOutcome {
  project_slug: string
  reason: 'created' | 'already_materialized' | 'failed'
  /** Repo-relative doc paths written THIS run. */
  docs_written: string[]
  /** Matched retained chunks sliced into the project. */
  slice_chunk_count: number
  summary_written: boolean
  /** True iff the composer's content was used (vs deterministic templates). */
  llm_docs: boolean
  git_ok: boolean
  indexed: boolean
  /**
   * True iff the project has REAL grounding — matched transcript slices OR
   * import/project-derived context (`hasRealProjectContext`). Drives the
   * "better nothing than a bad job" data-sufficiency gate (2026-07-01 SEV1):
   * a no-context project (`has_context:false`) gets a MINIMAL STATUS.md (no
   * autonomous-overnight opt-in, no seeded overnight task) and an HONEST opening
   * ("I don't have any context on X yet ...") instead of a fabricated status.
   * A project WITH context is materialized fully as before.
   */
  has_context: boolean
  error?: string
}

export interface ProjectMaterializer {
  materialize(input: MaterializeProjectInput): Promise<MaterializeOutcome>
}

/** Retained Pass-1 chunk row relevant to slicing. */
interface RetainedChunkRow {
  source: string
  conversation_id: string
  chunk_index: number
  chunk_text: string
  candidate_entities_json: string
  candidate_topics_json: string
}

export function buildProjectMaterializer(deps: ProjectMaterializerDeps): ProjectMaterializer {
  const logFailure =
    deps.logFailure ??
    ((stage: string, project_slug: string, err: unknown): void => {
      // eslint-disable-next-line no-console
      console.warn(
        `[project-materializer] project=${deps.project_slug} project=${project_slug} stage=${stage}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
  const runGit = deps.runGit ?? defaultRunGit

  return {
    async materialize(input: MaterializeProjectInput): Promise<MaterializeOutcome> {
      const slug = input.slug
      const out: MaterializeOutcome = {
        project_slug: slug,
        reason: 'created',
        docs_written: [],
        slice_chunk_count: 0,
        summary_written: false,
        llm_docs: false,
        git_ok: false,
        indexed: false,
        has_context: false,
      }
      // Import/project-derived grounding (DB-free). OR-ed with matched transcript
      // slices below to decide `has_context` — the data-sufficiency gate for the
      // minimal no-context STATUS.md + honest opening (2026-07-01 SEV1).
      const importCtx = hasRealProjectContext(input.project, input.import_result)
      const root = join(deps.owner_home, 'Projects', slug)
      try {
        // Idempotency marker — STATUS.md is written LAST among the doc
        // set, so its presence means a prior run completed the docs. The
        // daily overnight re-fire lands here and must never clobber user
        // edits — but the two TRAILING best-effort steps (git, index) are
        // retried so a transient failure on the first run self-heals
        // (Codex r1 P2): git repairs only when the repo/initial commit is
        // missing (a daily auto-commit of the user's stray edits would be
        // surprising); the indexer re-runs unconditionally because
        // writeEntity short-circuits byte-identical pages (changed:false
        // → no GBrain traffic), so a healthy project re-index is free.
        if (existsSync(join(root, 'STATUS.md'))) {
          out.reason = 'already_materialized'
          out.summary_written = existsSync(join(root, TRANSCRIPT_SUMMARY_RELPATH))
          // A prior run wrote a transcript-summary only when it matched slices,
          // so `summary_written` stands in for "had slices" on the re-fire path.
          out.has_context = importCtx || out.summary_written
          await repairGitIfNeeded(root, slug, runGit, out, logFailure)
          await runIndexerStep(deps, input, root, out, logFailure)
          return out
        }

        // 1) Folder + § 3.1 subdirs.
        mkdirSync(root, { recursive: true })
        for (const sub of PROJECT_SUBDIRS) {
          mkdirSync(join(root, sub), { recursive: true })
        }

        // 2) Content inputs.
        const name = input.project.name.trim()
        const context = synthesizeProjectContext(input.project, input.import_result)
        const related = findRelatedImportSignal(name, input.import_result)

        // 3) Transcript slices from retained raw chunks (migration 0063).
        const slices = gatherTranscriptSlices(deps.db, name, related, (err) =>
          logFailure('slice_query', slug, err),
        )
        out.slice_chunk_count = slices.chunks.length
        // Data-sufficiency: real grounding is matched transcript slices OR
        // import/project-derived context. A no-context project (thin chat answer,
        // no import match, no related signal) gets the minimal STATUS.md + no
        // overnight opt-in below (2026-07-01 SEV1 — "better nothing than a bad
        // job").
        const hasContext = importCtx || slices.chunks.length > 0
        out.has_context = hasContext
        if (slices.chunks.length > 0) {
          mkdirSync(join(root, 'research', 'transcripts'), { recursive: true })
          writeDocIfMissing(
            root,
            TRANSCRIPT_SLICES_RELPATH,
            renderSlicesDoc(name, slices),
            out,
          )
        }

        // 4) README — composer first, deterministic fallback.
        const excerpt = slices.chunks
          .map((c) => c.chunk_text)
          .join('\n\n')
          .slice(0, MAX_COMPOSER_EXCERPT_CHARS)
        const readmeBody = await composeOrFallback(
          deps.composer ?? null,
          {
            kind: 'readme',
            project_name: name,
            slug,
            context,
            related,
            transcript_excerpt: excerpt,
          },
          () => renderReadmeFallback(name, context, related, slices.chunks.length > 0),
          (err) => logFailure('compose_readme', slug, err),
          out,
        )
        writeDocIfMissing(root, 'README.md', readmeBody, out)

        // 5) CLAUDE.md — deterministic template (agent instructions).
        writeDocIfMissing(
          root,
          'CLAUDE.md',
          renderClaudeMd(name, context, slices.chunks.length > 0),
          out,
        )

        // 6) docs/transcript-summary.md — only when slices matched.
        if (slices.chunks.length > 0) {
          const summaryBody = await composeOrFallback(
            deps.composer ?? null,
            {
              kind: 'transcript_summary',
              project_name: name,
              slug,
              context,
              related,
              transcript_excerpt: excerpt,
            },
            () => renderSummaryFallback(name, slices),
            (err) => logFailure('compose_summary', slug, err),
            out,
          )
          writeDocIfMissing(root, TRANSCRIPT_SUMMARY_RELPATH, summaryBody, out)
          out.summary_written = true
        }

        // 6.5) Overnight seed context — the synthesized project context as a
        // real on-disk file the seeded `## Autonomous Overnight Work` bullet
        // points at via `[context:]`. This makes onboarding's "I've queued
        // these to work on overnight" TRUE: the engine's scan reconcile
        // adopts the seeded bullet into a real `overnight_queue` row, the
        // `[context:]` hard gate passes (the file exists), and the item runs
        // as a Trident run whose REAL result lands in the morning brief.
        //
        // NO-CONTEXT GATE (2026-07-01 SEV1): only for a project with real
        // grounding. Seeding a "Deepen + analyze X from imported context"
        // overnight task for a project that HAS no imported context (thin chat
        // answer) is the exact phantom-work bug Ryan hit — it would run atlas
        // against an empty seed doc. A no-context project gets neither the seed
        // doc nor the overnight opt-in (see renderStatusMd below).
        if (hasContext) {
          mkdirSync(join(root, 'docs', 'overnight'), { recursive: true })
          writeDocIfMissing(
            root,
            SEED_CONTEXT_RELPATH,
            renderSeedContext(name, context, weaveRelatedSignal(name, related)),
            out,
          )
        }

        // 7) STATUS.md LAST — the completion marker (§ 4 frontmatter). A project
        // with context gets the full STATUS (overnight opt-in + seeded bullet
        // pointing at the context doc above); a no-context project gets a MINIMAL
        // STATUS (clean frontmatter, one-line body, NO overnight machinery).
        writeDocIfMissing(
          root,
          'STATUS.md',
          hasContext
            ? renderStatusMd(slug, name, context, deps.now())
            : renderMinimalStatusMd(slug, deps.now()),
          out,
        )

        // 8) git init + commit (§ 3.3). Failure-isolated: the docs are
        // already on disk; a box without git still gets the doc set.
        await gitInitAndCommit(root, slug, runGit, out, logFailure)

        // 9) Memory-layer index (GBrain via writeEntity in production).
        await runIndexerStep(deps, input, root, out, logFailure)

        return out
      } catch (err) {
        out.reason = 'failed'
        out.error = err instanceof Error ? err.message : String(err)
        logFailure('materialize', slug, err)
        return out
      }
    },
  }
}

/** Shared git step: init when missing, stage, commit (identity pinned). */
async function gitInitAndCommit(
  root: string,
  slug: string,
  runGit: (args: string[], cwd: string) => Promise<void>,
  out: MaterializeOutcome,
  logFailure: (stage: string, project_slug: string, err: unknown) => void,
): Promise<void> {
  try {
    if (!existsSync(join(root, '.git'))) {
      await runGit(['init', '-q'], root)
    }
    await runGit(['add', '-A'], root)
    await runGit(
      [
        '-c',
        'user.name=Neutron',
        '-c',
        'user.email=neutron@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        `materialize: ${slug}`,
      ],
      root,
    )
    out.git_ok = true
  } catch (err) {
    // "nothing to commit" on a re-run with a pre-existing repo is
    // benign; everything else is logged. Either way the docs stand.
    const msg = err instanceof Error ? err.message : String(err)
    if (/nothing to commit|nothing added to commit/.test(msg)) {
      out.git_ok = true
    } else {
      logFailure('git', slug, err)
    }
  }
}

/**
 * Repair path (Codex r1 P2) — on an already-materialized project, redo
 * the git step ONLY when the repo or its initial commit is missing (a
 * prior run's transient git failure). A healthy repo is left strictly
 * alone: auto-committing the user's stray working-tree edits on every
 * daily overnight re-fire would be surprising.
 */
async function repairGitIfNeeded(
  root: string,
  slug: string,
  runGit: (args: string[], cwd: string) => Promise<void>,
  out: MaterializeOutcome,
  logFailure: (stage: string, project_slug: string, err: unknown) => void,
): Promise<void> {
  if (existsSync(join(root, '.git'))) {
    try {
      await runGit(['rev-parse', '--verify', 'HEAD'], root)
      out.git_ok = true
      return
    } catch {
      // .git exists but no commit landed — fall through to commit.
    }
  }
  await gitInitAndCommit(root, slug, runGit, out, logFailure)
}

/**
 * Shared index step. Safe to re-run on every pass: the production
 * indexer goes through `writeEntity`, which short-circuits
 * byte-identical pages (`changed: false` → sync hook suppressed), so a
 * healthy project re-index costs one file render and no GBrain traffic
 * — and a prior run's transient index failure self-heals.
 */
async function runIndexerStep(
  deps: ProjectMaterializerDeps,
  input: MaterializeProjectInput,
  root: string,
  out: MaterializeOutcome,
  logFailure: (stage: string, project_slug: string, err: unknown) => void,
): Promise<void> {
  if (deps.indexer === null || deps.indexer === undefined) return
  const name = input.project.name.trim()
  const context = synthesizeProjectContext(input.project, input.import_result)
  const related = findRelatedImportSignal(name, input.import_result)
  try {
    await deps.indexer({
      project_slug: out.project_slug,
      name,
      body: renderIndexPageBody(name, context, related, out, root),
      source_path: `Projects/${out.project_slug}`,
    })
    out.indexed = true
  } catch (err) {
    logFailure('index', out.project_slug, err)
  }
}

/**
 * Bounded-concurrency map (spec § 4.2c — N projects materialize in
 * parallel under a cap; one project's failure never blocks siblings).
 * Local implementation: the gateway's `mapWithBoundedConcurrency` lives
 * above this layer (onboarding/ must not import gateway/).
 */
export async function mapBounded<T, R>(
  items: ReadonlyArray<T>,
  cap: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(cap, items.length)) }, async () => {
    while (true) {
      const i = next
      next += 1
      if (i >= items.length) return
      results[i] = await fn(items[i] as T, i)
    }
  })
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Slicing
// ---------------------------------------------------------------------------

interface GatheredSlices {
  chunks: RetainedChunkRow[]
  conversation_count: number
  truncated: boolean
}

/**
 * Select retained chunks whose Pass-1 candidates relate to the project.
 * Relevance = any candidate entity/topic name relates (token match per
 * `namesRelate`) to the project name OR to any related-signal name the
 * import surfaced for this project (spec § 4.2b step 2).
 */
function gatherTranscriptSlices(
  db: ProjectDb,
  project_name: string,
  related: RelatedImportSignal,
  logError: (err: unknown) => void,
): GatheredSlices {
  const empty: GatheredSlices = { chunks: [], conversation_count: 0, truncated: false }
  let rows: RetainedChunkRow[]
  try {
    rows = db
      .prepare<RetainedChunkRow, []>(
        `SELECT source, conversation_id, chunk_index, chunk_text,
                candidate_entities_json, candidate_topics_json
           FROM import_pass1_chunks
          WHERE chunk_text IS NOT NULL AND analyzed = 1
          ORDER BY conversation_id, chunk_index`,
      )
      .all()
  } catch (err) {
    // Defensive: a sidecar DB that pre-dates migration 0063 (or a test
    // fixture with a trimmed schema) must not break materialization.
    logError(err)
    return empty
  }
  const terms = [project_name, ...related.entities, ...related.topics, ...related.interests]
  const matched: RetainedChunkRow[] = []
  const conversations = new Set<string>()
  let bytes = 0
  let truncated = false
  for (const row of rows) {
    if (!chunkMatchesTerms(row, terms)) continue
    const size = Buffer.byteLength(row.chunk_text, 'utf8')
    if (bytes + size > MAX_SLICE_BYTES) {
      truncated = true
      break
    }
    bytes += size
    matched.push(row)
    conversations.add(`${row.source}:${row.conversation_id}`)
  }
  return { chunks: matched, conversation_count: conversations.size, truncated }
}

/** True iff any Pass-1 candidate name on the chunk relates to any term. */
function chunkMatchesTerms(row: RetainedChunkRow, terms: ReadonlyArray<string>): boolean {
  const candidates = [
    ...parseCandidateNames(row.candidate_entities_json),
    ...parseCandidateNames(row.candidate_topics_json),
  ]
  for (const candidate of candidates) {
    for (const term of terms) {
      if (namesRelate(candidate, term)) return true
    }
  }
  return false
}

/** Defensive parse — accepts `[{name}]` rows or bare string arrays. */
function parseCandidateNames(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    for (const item of parsed) {
      if (typeof item === 'string' && item.trim().length > 0) {
        out.push(item.trim())
      } else if (
        item !== null &&
        typeof item === 'object' &&
        typeof (item as { name?: unknown }).name === 'string'
      ) {
        const name = ((item as { name: string }).name ?? '').trim()
        if (name.length > 0) out.push(name)
      }
    }
    return out
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Doc rendering (deterministic templates — NO em dashes, hard rule)
// ---------------------------------------------------------------------------

function renderSlicesDoc(name: string, slices: GatheredSlices): string {
  const lines: string[] = [
    `# Imported transcript slices - ${name}`,
    '',
    'Raw conversation excerpts from your onboarding history import that the',
    'Pass-1 analysis related to this project. This file is the citation',
    'source for `docs/transcript-summary.md`; treat it as read-only history.',
    '',
  ]
  let currentConv = ''
  for (const chunk of slices.chunks) {
    const convKey = `${chunk.source}:${chunk.conversation_id}`
    if (convKey !== currentConv) {
      currentConv = convKey
      lines.push(`## Conversation ${chunk.conversation_id} (${chunk.source})`, '')
    }
    lines.push(`### Chunk ${chunk.chunk_index}`, '', chunk.chunk_text.trim(), '')
  }
  if (slices.truncated) {
    lines.push(
      '---',
      '',
      `Truncated at ${MAX_SLICE_BYTES} bytes. The full retained chunk set lives in the project import tables (import_pass1_chunks.chunk_text).`,
      '',
    )
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function renderReadmeFallback(
  name: string,
  context: string,
  related: RelatedImportSignal,
  hasSlices: boolean,
): string {
  const lines: string[] = [`# ${name}`, '', context, '']
  const woven = weaveRelatedSignal(name, related)
  if (woven.length > 0) {
    lines.push('## Imported context', '', woven, '')
  }
  if (hasSlices) {
    lines.push(
      'Raw transcript excerpts that informed this project live in',
      '`research/transcripts/imported-transcript-slices.md`; a synthesized',
      'summary lives in `docs/transcript-summary.md`.',
      '',
    )
  }
  lines.push(
    'This project was created during onboarding. Edit this overview as the',
    'project takes shape.',
  )
  return `${lines.join('\n').trimEnd()}\n`
}

function renderClaudeMd(name: string, context: string, hasSlices: boolean): string {
  return (
    `# ${name} - Project Instructions\n` +
    `\n` +
    `${context}\n` +
    `\n` +
    `## Layout\n` +
    `\n` +
    `- \`STATUS.md\` - current state; keep the frontmatter (status/priority/one_liner/last_updated) accurate. Update after meaningful changes.\n` +
    `- \`docs/\` - specs, plans, long-form docs.${hasSlices ? ' `docs/transcript-summary.md` summarizes the imported history relevant to this project.' : ''}\n` +
    `- \`research/\` - research artifacts.${hasSlices ? ' `research/transcripts/` holds raw imported transcript slices; treat them as read-only history and cite them when drawing on imported context.' : ''}\n` +
    `- \`notes/\` - dated free-form notes (e.g. \`notes/2026-06-11-kickoff.md\`).\n` +
    `- \`archive/\` - superseded docs within this project.\n` +
    `\n` +
    `## Working agreements\n` +
    `\n` +
    `- Every meaningful change commits to this project's own git repo.\n` +
    `- Prefer updating existing docs over creating dated copies.\n`
  )
}

/** Relative path of the seeded overnight context doc (repo-root relative). */
const SEED_CONTEXT_RELPATH = 'docs/overnight/seed-context.md'

/**
 * The synthesized project context, written to disk as the `[context:]`
 * target for the seeded overnight bullet. The overnight engine's hard gate
 * requires this file to exist + be non-empty before the item dispatches.
 */
function renderSeedContext(name: string, context: string, related: string | null): string {
  return (
    `# Overnight context — ${name}\n\n` +
    `Seeded at onboarding so the autonomous overnight-work engine has real\n` +
    `grounding for its first pass on this project.\n\n` +
    `## Project context\n\n` +
    `${context}\n` +
    (related ? `\n## Related import signal\n\n${related}\n` : '')
  )
}

function renderStatusMd(slug: string, name: string, context: string, nowMs: number): string {
  const date = new Date(nowMs).toISOString().slice(0, 10)
  const one_liner = firstSentence(context, 160)
  return (
    `---\n` +
    `name: ${slug}\n` +
    `status: active\n` +
    `priority: P2\n` +
    `one_liner: ${JSON.stringify(one_liner)}\n` +
    `remote: local\n` +
    // 2026-06-19 (overnight-engine) — opt EVERY onboarding-materialized
    // project into the Autonomous Overnight-Work engine. Without this flag
    // the engine's `enumerateOptedInProjects` skips the project and the
    // onboarding promise ("I've queued these to work on overnight") is a
    // silent no-op. The agent maintains the `## Autonomous Overnight Work`
    // block below from the `overnight_queue` rows; the user never edits it.
    `${OVERNIGHT_OPT_IN_KEY}: true\n` +
    `last_updated: ${date}\n` +
    `---\n` +
    `\n` +
    `# Status\n` +
    `\n` +
    `${context}\n` +
    `\n` +
    `Created during onboarding. No work has been tracked here yet.\n` +
    `\n` +
    `## Autonomous Overnight Work\n` +
    `\n` +
    `- [ ] Deepen + analyze ${name} from imported context ` +
    `[agent:atlas] [priority:P3] [context:${SEED_CONTEXT_RELPATH}]\n`
  )
}

/**
 * MINIMAL STATUS.md for a NO-CONTEXT project (2026-07-01 SEV1 — "STOP M2" b/c).
 * Clean § 4 frontmatter + a single honest body line. Deliberately OMITS:
 *   - `autonomous_overnight_enabled` (a no-context project must NOT be opted into
 *     the overnight engine — there is nothing real to work on),
 *   - the `## Autonomous Overnight Work` section + its seeded "Deepen + analyze
 *     from imported context" task (phantom work against an empty seed doc),
 *   - a fabricated `one_liner` / status prose (there is no context to summarize).
 * The empty `one_liner` is what makes the opening composer emit the honest "I
 * don't have any context on X yet" prompt instead of a fake "here's where X
 * stands". A project that later gains real context is handled by the full
 * `renderStatusMd`; the agent can also opt this project in by hand later.
 */
function renderMinimalStatusMd(slug: string, nowMs: number): string {
  const date = new Date(nowMs).toISOString().slice(0, 10)
  return (
    `---\n` +
    `name: ${slug}\n` +
    `status: active\n` +
    `priority: P2\n` +
    `one_liner: ""\n` +
    `remote: local\n` +
    `last_updated: ${date}\n` +
    `---\n` +
    `\n` +
    `# Status\n` +
    `\n` +
    `Created during onboarding - no context yet.\n`
  )
}

function renderSummaryFallback(name: string, slices: GatheredSlices): string {
  return (
    `# Transcript summary - ${name}\n` +
    `\n` +
    `${slices.chunks.length} imported transcript excerpt${slices.chunks.length === 1 ? '' : 's'} ` +
    `across ${slices.conversation_count} conversation${slices.conversation_count === 1 ? '' : 's'} ` +
    `relate to this project. The raw excerpts live in\n` +
    `\`research/transcripts/imported-transcript-slices.md\`.\n` +
    `\n` +
    `This placeholder was generated without LLM synthesis (no composer was\n` +
    `available at materialization time). Ask your agent to summarize the\n` +
    `slices to replace this doc with a real synthesis.\n`
  )
}

function renderIndexPageBody(
  name: string,
  context: string,
  related: RelatedImportSignal,
  out: MaterializeOutcome,
  root: string,
): string {
  const lines: string[] = [`# ${name}`, '', context, '']
  const woven = weaveRelatedSignal(name, related)
  if (woven.length > 0) lines.push(woven, '')
  if (out.summary_written) {
    // Index the SUMMARY, not the raw slices — keeps the memory index lean
    // (spec § 4.2d); the raw slices stay on disk as the citation source.
    try {
      const summary = readDoc(join(root, TRANSCRIPT_SUMMARY_RELPATH))
      if (summary !== null) lines.push('## Imported-history summary', '', summary, '')
    } catch {
      // Best-effort — the page body stands without the summary section.
    }
  }
  lines.push(`Project folder: Projects/${out.project_slug}/`)
  return `${lines.join('\n').trimEnd()}\n`
}

function firstSentence(s: string, maxChars: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  const boundary = flat.search(/[.!?](\s|$)/)
  const sentence = boundary === -1 ? flat : flat.slice(0, boundary + 1)
  return sentence.length <= maxChars ? sentence : `${sentence.slice(0, maxChars - 1).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function composeOrFallback(
  composer: ProjectDocComposer | null,
  input: ComposeProjectDocInput,
  fallback: () => string,
  logError: (err: unknown) => void,
  out: MaterializeOutcome,
): Promise<string> {
  if (composer !== null) {
    try {
      const body = (await composer(input)).trim()
      if (body.length > 0) {
        out.llm_docs = true
        return `${body}\n`
      }
    } catch (err) {
      logError(err)
    }
  }
  return fallback()
}

/** Create-if-missing-only — never overwrite a file a user may have edited. */
function writeDocIfMissing(
  root: string,
  relpath: string,
  body: string,
  out: MaterializeOutcome,
): void {
  const abs = join(root, relpath)
  if (existsSync(abs)) return
  writeFileSync(abs, body, 'utf8')
  out.docs_written.push(relpath)
}

function readDoc(abs: string): string | null {
  if (!existsSync(abs)) return null
  return readFileSync(abs, 'utf8')
}

async function defaultRunGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 30_000,
  })
}
