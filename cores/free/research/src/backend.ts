/**
 * @neutronai/research-core — research orchestrator + sidecar persistence
 * + substrate port.
 *
 * The Research Core is an Atlas-shape Core: it wraps an LLM-driven
 * synthesis pipeline and emits a structured brief stored in the
 * Core's own sidecar SQLite (`<dataDir>/cores/research_core.db`).
 *
 * This module ships three concerns, all behind narrow interfaces so
 * tests can wire stubs:
 *
 *   1. `ResearchStore` — persistence layer over the sidecar SQLite.
 *      Owns the `research_tasks` table schema and exposes typed
 *      lifecycle methods (`insertPending`, `setRunning`,
 *      `setCompleted`, `setFailed`, `get`). Every row is scoped by
 *      `project_slug` so a single shared sidecar (the runtime's
 *      allocation is per-instance in practice, but the table still
 *      carries the column for defence-in-depth) cannot leak across
 *      instances.
 *
 *   2. `ResearchSubstrate` — port the Core programs against for the
 *      actual LLM call. One method (`synthesize`) that returns a raw
 *      text response. The Core has no awareness of which substrate
 *      adapter is wired — production composes `runtime.Substrate`
 *      under this port; tests pass `buildCannedResearchSubstrate`.
 *
 *   3. `buildResearchOrchestrator({...})` — composes the store +
 *      substrate into a `ResearchBackend` (`start / status / fetch`)
 *      with the parse-once-retry-once lifecycle the brief locks.
 *
 * Synchronous run for v1 (per sprint brief): the LLM call blocks
 * inside `start` and the returned task is already in its terminal
 * state. P5.x will introduce a background worker that decouples
 * `start` (returns `pending`) from the actual synthesis (which
 * `status` then surfaces as `running` until terminal). The state
 * machine is already shaped for that future — `start` writes
 * `pending`, immediately flips to `running` before invoking the
 * substrate, and writes the terminal state once the substrate
 * returns. The seam where async would land is the
 * `projectDb.transaction` boundary inside `start`.
 */

import { randomUUID } from 'node:crypto'

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { parseJsonColumn } from '@neutronai/persistence/index.ts'

import { SONNET_MODEL, FAST_MODEL } from '@neutronai/runtime/models.ts'

/* -----------------------------------------------------------------
 * Brief shape — the public contract
 * ----------------------------------------------------------------- */

/**
 * Structured brief the synthesis pipeline emits. Pinned in the
 * Core's manifest description AND in this module's type system so
 * a drift in either surface trips the next build.
 *
 * Field semantics (mirroring the README):
 * - `topic`            — one-line restatement of the question
 * - `key_findings`     — 3–8 distilled findings (free-form strings)
 * - `sources`          — supporting references; each carries a
 *                        mandatory `title` plus optional `url`/`note`
 * - `confidence_level` — qualitative ranking the LLM assigns based
 *                        on the strength of the supporting evidence
 * - `recommendations`  — 1–5 next-action recommendations the brief
 *                        author surfaces from the findings
 */
export type ConfidenceLevel = 'low' | 'medium' | 'high'

export interface ResearchSource {
  title: string
  url?: string
  note?: string
}

/**
 * S1 — every brief carries a `claims[]` array of fact-with-provenance
 * triples. `key_findings: string[]` is preserved as a derived projection
 * (rendered by walking `claims[]` and emitting the `claim` text — or by
 * the substrate directly for legacy callers). The orchestrator's
 * sources-cited invariant is enforced against `claims[]` BEFORE any
 * brief is `setCompleted`.
 */
export interface ResearchClaimEntry {
  /** The factual assertion (one sentence). */
  claim: string
  /** Direct quote or paraphrase backing the claim (optional). */
  evidence?: string
  /** URL, file path, or other locator. NULL iff confidence='unverified'. */
  citation?: string
  /** Per-claim confidence. Required. */
  confidence: 'low' | 'medium' | 'high' | 'unverified'
}

export interface ResearchBrief {
  topic: string
  key_findings: string[]
  sources: ResearchSource[]
  confidence_level: ConfidenceLevel
  recommendations: string[]
  /** S1 — claim-evidence-citation triples. Optional for back-compat;
   *  v1 substrates emitting only `key_findings: string[]` produce
   *  briefs without `claims[]` and the orchestrator FAILS them (the
   *  sources-cited invariant requires at least one cited-or-unverified
   *  claim). Sub-agent substrates emit `claims[]` natively. */
  claims?: ResearchClaimEntry[]
}

/**
 * Validate an unknown payload against the brief shape. Returns
 * `{ok: true, brief}` on success; `{ok: false, error}` on any
 * structural mismatch (missing field, wrong type, invalid enum).
 *
 * The validator is intentionally hand-written rather than Zod-driven
 * — the shape is tight, the error messages need to be substrate-
 * digestible (they feed back into the retry-prompt body), and the
 * Core has no other Zod dependency to amortise.
 */
export function validateResearchBrief(
  payload: unknown,
): { ok: true; brief: ResearchBrief } | { ok: false; error: string } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'brief must be a JSON object' }
  }
  const obj = payload as Record<string, unknown>

  if (typeof obj['topic'] !== 'string' || obj['topic'].trim() === '') {
    return { ok: false, error: 'brief.topic must be a non-empty string' }
  }
  const topic = obj['topic']

  const key_findings = obj['key_findings']
  if (!Array.isArray(key_findings) || key_findings.some((v) => typeof v !== 'string')) {
    return { ok: false, error: 'brief.key_findings must be an array of strings' }
  }

  const sourcesIn = obj['sources']
  if (!Array.isArray(sourcesIn)) {
    return { ok: false, error: 'brief.sources must be an array' }
  }
  const sources: ResearchSource[] = []
  for (let i = 0; i < sourcesIn.length; i++) {
    const s = sourcesIn[i]
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      return { ok: false, error: `brief.sources[${i}] must be an object` }
    }
    const sObj = s as Record<string, unknown>
    if (typeof sObj['title'] !== 'string' || sObj['title'].trim() === '') {
      return { ok: false, error: `brief.sources[${i}].title must be a non-empty string` }
    }
    const out: ResearchSource = { title: sObj['title'] }
    if (sObj['url'] !== undefined) {
      if (typeof sObj['url'] !== 'string') {
        return { ok: false, error: `brief.sources[${i}].url must be a string when set` }
      }
      out.url = sObj['url']
    }
    if (sObj['note'] !== undefined) {
      if (typeof sObj['note'] !== 'string') {
        return { ok: false, error: `brief.sources[${i}].note must be a string when set` }
      }
      out.note = sObj['note']
    }
    sources.push(out)
  }

  const confidence = obj['confidence_level']
  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') {
    return {
      ok: false,
      error: 'brief.confidence_level must be one of "low" | "medium" | "high"',
    }
  }

  const recommendations = obj['recommendations']
  if (!Array.isArray(recommendations) || recommendations.some((v) => typeof v !== 'string')) {
    return { ok: false, error: 'brief.recommendations must be an array of strings' }
  }

  // S1 — optional `claims[]` field. Each entry must carry `claim` +
  // `confidence`; `evidence` and `citation` are optional strings; the
  // sources-cited invariant is enforced LATER by
  // `assertSourcesCited(...)` (the validator only enforces structure).
  const claimsRaw = obj['claims']
  const claims: ResearchClaimEntry[] = []
  if (claimsRaw !== undefined) {
    if (!Array.isArray(claimsRaw)) {
      return { ok: false, error: 'brief.claims must be an array when set' }
    }
    for (let i = 0; i < claimsRaw.length; i++) {
      const c = claimsRaw[i]
      if (c === null || typeof c !== 'object' || Array.isArray(c)) {
        return { ok: false, error: `brief.claims[${i}] must be an object` }
      }
      const cObj = c as Record<string, unknown>
      if (typeof cObj['claim'] !== 'string' || cObj['claim'].trim() === '') {
        return { ok: false, error: `brief.claims[${i}].claim must be a non-empty string` }
      }
      const confidenceRaw = cObj['confidence']
      if (
        confidenceRaw !== 'low' &&
        confidenceRaw !== 'medium' &&
        confidenceRaw !== 'high' &&
        confidenceRaw !== 'unverified'
      ) {
        return {
          ok: false,
          error: `brief.claims[${i}].confidence must be one of low | medium | high | unverified`,
        }
      }
      const entry: ResearchClaimEntry = {
        claim: cObj['claim'],
        confidence: confidenceRaw,
      }
      if (cObj['evidence'] !== undefined) {
        if (typeof cObj['evidence'] !== 'string') {
          return { ok: false, error: `brief.claims[${i}].evidence must be a string when set` }
        }
        entry.evidence = cObj['evidence']
      }
      if (cObj['citation'] !== undefined && cObj['citation'] !== null) {
        if (typeof cObj['citation'] !== 'string') {
          return { ok: false, error: `brief.claims[${i}].citation must be a string when set` }
        }
        entry.citation = cObj['citation']
      }
      claims.push(entry)
    }
  }

  const briefOut: ResearchBrief = {
    topic,
    key_findings: key_findings as string[],
    sources,
    confidence_level: confidence,
    recommendations: recommendations as string[],
  }
  if (claims.length > 0) briefOut.claims = claims

  return { ok: true, brief: briefOut }
}

/* -----------------------------------------------------------------
 * Substrate port
 * ----------------------------------------------------------------- */

export interface ResearchSubstrateInput {
  /** The prompt text the synthesis pass should respond to. */
  prompt: string
  /** Adapter picks the first available model. Optional. */
  model_preference?: readonly string[]
}

export interface ResearchSubstrateResult {
  /** Raw assistant text — the orchestrator parses this as JSON. */
  text: string
  /** Model id that actually produced the response. */
  model: string
}

export interface ResearchSubstrate {
  synthesize(input: ResearchSubstrateInput): Promise<ResearchSubstrateResult>
}

/**
 * Test substrate. Returns canned text per `synthesize` call so the
 * Core's tests can exercise the success path, the parse-failure-
 * then-retry path, and the synthesis-failure path without making a
 * real LLM call.
 *
 * Usage:
 *   const sub = buildCannedResearchSubstrate({
 *     responses: ['<first call body>', '<retry body>'],
 *   })
 *
 * Or to throw on the Nth call:
 *   const sub = buildCannedResearchSubstrate({
 *     responses: [
 *       { kind: 'throw', error: new Error('boom') },
 *       { kind: 'text', text: '<retry body>' },
 *     ],
 *   })
 */
export type CannedResponse =
  | string
  | { kind: 'text'; text: string; model?: string }
  | { kind: 'throw'; error: Error }

export interface CannedSubstrateOptions {
  responses: readonly CannedResponse[]
  /** Default model id reported back when a canned response omits it. */
  default_model?: string
}

export interface CannedSubstrate extends ResearchSubstrate {
  /** Number of `synthesize` calls observed. */
  readonly call_count: number
  /** Prompts seen, in order. */
  readonly prompts: readonly string[]
}

export function buildCannedResearchSubstrate(
  opts: CannedSubstrateOptions,
): CannedSubstrate {
  const responses = [...opts.responses]
  const default_model = opts.default_model ?? SONNET_MODEL
  let n = 0
  const prompts: string[] = []

  const sub: CannedSubstrate = {
    get call_count(): number {
      return n
    },
    get prompts(): readonly string[] {
      return prompts
    },
    async synthesize(input: ResearchSubstrateInput): Promise<ResearchSubstrateResult> {
      const i = n++
      prompts.push(input.prompt)
      if (i >= responses.length) {
        throw new Error(
          `buildCannedResearchSubstrate: no canned response for call #${i + 1}`,
        )
      }
      const r = responses[i]!
      if (typeof r === 'string') {
        return { text: r, model: default_model }
      }
      if (r.kind === 'throw') {
        throw r.error
      }
      return { text: r.text, model: r.model ?? default_model }
    },
  }
  return sub
}

/* -----------------------------------------------------------------
 * Prompt + parser
 * ----------------------------------------------------------------- */

export interface BuildPromptInput {
  query: string
  depth: ResearchDepth
  sources: readonly string[]
  /** Set on the retry pass — the parser error from the first attempt. */
  retry_parse_error?: string
  /** Set on the retry pass — the raw text from the first attempt. */
  retry_raw_response?: string
  /** S1 — set when the first attempt failed the sources-cited invariant.
   *  The retry prompt riders this so the model corrects to add citations
   *  or unverified tags. */
  retry_sources_cited_violation?: string
}

const DEPTH_GUIDANCE: Record<ResearchDepth, string> = {
  quick:
    'Aim for a tight brief: 3 key findings, 2 sources, 1–2 recommendations.',
  standard:
    'Aim for a balanced brief: 4–6 key findings, 3–5 sources, 2–3 recommendations.',
  deep:
    'Aim for a thorough brief: 6–8 key findings, 5+ sources, 3–5 recommendations.',
}

/**
 * Compose the synthesis prompt. Asks the LLM for a JSON object of the
 * locked brief shape. The retry pass appends the parser error so the
 * second attempt has a concrete diagnostic to correct.
 */
export function buildSynthesisPrompt(input: BuildPromptInput): string {
  const lines: string[] = []
  lines.push('You are Atlas, a research synthesist.')
  lines.push(
    'Produce a structured research brief for the question below.',
    'Return a SINGLE JSON object — no surrounding prose, no markdown fences.',
    'The JSON MUST match this shape exactly:',
    '{',
    '  "topic":            string,           // 1-line restatement of the question',
    '  "key_findings":     string[],         // distilled bullet findings',
    '  "sources":          [ { "title": string, "url"?: string, "note"?: string } ],',
    '  "confidence_level": "low" | "medium" | "high",',
    '  "recommendations":  string[],',
    '  "claims": [                           // REQUIRED — claim/evidence/citation triples',
    '    {',
    '      "claim":      string,              // one-sentence factual assertion',
    '      "evidence":   string?,             // direct quote or paraphrase from a source',
    '      "citation":   string?,             // URL, file path, or DOI — REQUIRED unless confidence:"unverified"',
    '      "confidence": "low"|"medium"|"high"|"unverified"',
    '    }',
    '  ]',
    '}',
    '',
    'SOURCES-CITED INVARIANT (HARD RULE): every claim row MUST EITHER',
    'carry a non-empty `citation` (URL or file path), OR be tagged',
    '`"confidence": "unverified"`. There is NO third path. Inventing',
    'citations is worse than tagging unverified — be honest about what',
    'you have not verified.',
    '',
    `Depth hint: ${input.depth}. ${DEPTH_GUIDANCE[input.depth]}`,
  )
  if (input.sources.length > 0) {
    lines.push(
      '',
      'Caller-provided source hints (weigh these alongside your own sourcing):',
    )
    for (const s of input.sources) {
      lines.push(`  - ${s}`)
    }
  }
  lines.push('', 'Question:', input.query)
  if (input.retry_parse_error !== undefined && input.retry_raw_response !== undefined) {
    lines.push(
      '',
      'NOTE: a previous attempt at this brief produced output that could not be parsed.',
      `Parser error: ${input.retry_parse_error}`,
      'Previous output:',
      input.retry_raw_response.slice(0, 2_000),
      '',
      'Return ONLY a single valid JSON object that matches the shape above.',
    )
  }
  if (input.retry_sources_cited_violation !== undefined) {
    lines.push(
      '',
      'NOTE: a previous attempt at this brief failed the sources-cited invariant.',
      `Violation: ${input.retry_sources_cited_violation}`,
      '',
      'Every claim MUST carry a citation OR be tagged confidence:"unverified".',
      'Re-emit the brief with every claim properly cited or tagged.',
    )
  }
  return lines.join('\n')
}

/**
 * Best-effort JSON extraction. Some substrates wrap responses in
 * ```json ... ``` fences; some prepend a few words of prose despite
 * the instructions. We strip a leading code fence (if any) and a
 * trailing one, then scan for the outermost balanced `{...}` block.
 * Anything more aggressive than that risks silently mis-parsing — if
 * the substrate emits garbage, we want the parser error surfaced so
 * the retry pass can correct.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  // Strip a fenced block first.
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i)
  const body = fenceMatch !== null ? fenceMatch[1]!.trim() : trimmed
  // Find first { and matching balanced close.
  const firstBrace = body.indexOf('{')
  if (firstBrace === -1) {
    throw new Error('no JSON object found in substrate response')
  }
  let depth = 0
  let inString = false
  let escape = false
  for (let i = firstBrace; i < body.length; i++) {
    const ch = body[i]!
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const slice = body.slice(firstBrace, i + 1)
        return JSON.parse(slice)
      }
    }
  }
  throw new Error('unbalanced JSON object in substrate response')
}

/* -----------------------------------------------------------------
 * Sidecar persistence
 * ----------------------------------------------------------------- */

export type ResearchDepth = 'quick' | 'standard' | 'deep'
export type ResearchStatus = 'pending' | 'running' | 'completed' | 'failed'

export const DEFAULT_DEPTH: ResearchDepth = 'standard'

export interface ResearchTaskRow {
  id: string
  project_slug: string
  query: string
  depth: ResearchDepth
  sources: string[]
  status: ResearchStatus
  brief: ResearchBrief | null
  error: string | null
  attempt_count: number
  created_at: number
  updated_at: number
  completed_at: number | null
}

/**
 * Apply the `research_tasks` schema to a ProjectDb-backed SQLite.
 * Idempotent — uses `CREATE TABLE IF NOT EXISTS` so a Core that has
 * already booted once on a sidecar can re-apply the schema without
 * tripping migrations. Called by the store constructor.
 *
 * The schema lives in the Core (not under `migrations/`) because the
 * Research Core owns its own sidecar DB; the substrate-level
 * `migrations/` runner targets the instance's primary project DB.
 */
export async function applyResearchSchema(db: ProjectDb): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS research_tasks (
      id            TEXT PRIMARY KEY,
      project_slug   TEXT NOT NULL,
      query         TEXT NOT NULL,
      depth         TEXT NOT NULL CHECK(depth IN ('quick','standard','deep')),
      sources_json  TEXT NOT NULL,
      status        TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
      brief_json    TEXT,
      error         TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      completed_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS research_tasks_owner_status_idx
      ON research_tasks(project_slug, status, created_at DESC);
  `)
}

interface ResearchTaskColumns {
  id: string
  project_slug: string
  query: string
  depth: string
  sources_json: string
  status: string
  brief_json: string | null
  error: string | null
  attempt_count: number
  created_at: number
  updated_at: number
  completed_at: number | null
}

function rowFromColumns(c: ResearchTaskColumns): ResearchTaskRow {
  const depth = c.depth as ResearchDepth
  const status = c.status as ResearchStatus
  // Corrupt-policy: throw propagates (mirrors research-store.ts).
  const sourcesRaw: unknown = parseJsonColumn(c.sources_json, { onCorrupt: 'throw' })
  const sources = Array.isArray(sourcesRaw)
    ? (sourcesRaw.filter((v) => typeof v === 'string') as string[])
    : []
  let brief: ResearchBrief | null = null
  if (c.brief_json !== null) {
    const parsed: unknown = parseJsonColumn(c.brief_json, { onCorrupt: 'throw' })
    const validated = validateResearchBrief(parsed)
    brief = validated.ok ? validated.brief : null
  }
  return {
    id: c.id,
    project_slug: c.project_slug,
    query: c.query,
    depth,
    sources,
    status,
    brief,
    error: c.error,
    attempt_count: c.attempt_count,
    created_at: c.created_at,
    updated_at: c.updated_at,
    completed_at: c.completed_at,
  }
}

export interface ResearchStoreOptions {
  project_slug: string
  db: ProjectDb
  /** Wall-clock override for tests; defaults to `Date.now()`. */
  now?: () => number
  /** Id minter override for tests; defaults to `randomUUID()`. */
  nextId?: () => string
}

/**
 * Sidecar-backed persistence for the Research Core. Owns the
 * `research_tasks` table and exposes typed lifecycle methods.
 *
 * Every query scopes by `project_slug`; cross-project lookups surface
 * as `null` from `get` so an attacker who learned another instance's
 * task_id gets the same shape as a non-existent id.
 */
export class ResearchStore {
  private readonly project_slug: string
  private readonly db: ProjectDb
  private readonly now: () => number
  private readonly nextId: () => string
  private schema_applied = false

  constructor(options: ResearchStoreOptions) {
    this.project_slug = options.project_slug
    this.db = options.db
    this.now = options.now ?? ((): number => Date.now())
    this.nextId = options.nextId ?? ((): string => randomUUID())
  }

  /**
   * Apply the schema exactly once per instance. Cheap to call on
   * every public method since the inner `CREATE TABLE IF NOT EXISTS`
   * is idempotent and the guard amortises away the SQLite roundtrip.
   */
  private async ensureSchema(): Promise<void> {
    if (this.schema_applied) return
    await applyResearchSchema(this.db)
    this.schema_applied = true
  }

  async insertPending(input: {
    query: string
    depth: ResearchDepth
    sources: readonly string[]
  }): Promise<ResearchTaskRow> {
    await this.ensureSchema()
    const id = this.nextId()
    const ts = this.now()
    const sources_json = JSON.stringify([...input.sources])
    await this.db.run(
      `INSERT INTO research_tasks
         (id, project_slug, query, depth, sources_json, status, brief_json, error,
          attempt_count, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, ?, ?, NULL)`,
      [id, this.project_slug, input.query, input.depth, sources_json, ts, ts],
    )
    return {
      id,
      project_slug: this.project_slug,
      query: input.query,
      depth: input.depth,
      sources: [...input.sources],
      status: 'pending',
      brief: null,
      error: null,
      attempt_count: 0,
      created_at: ts,
      updated_at: ts,
      completed_at: null,
    }
  }

  async setRunning(task_id: string): Promise<void> {
    await this.ensureSchema()
    const ts = this.now()
    await this.db.run(
      `UPDATE research_tasks
          SET status = 'running', updated_at = ?
        WHERE id = ? AND project_slug = ?`,
      [ts, task_id, this.project_slug],
    )
  }

  async bumpAttempt(task_id: string): Promise<void> {
    await this.ensureSchema()
    const ts = this.now()
    await this.db.run(
      `UPDATE research_tasks
          SET attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND project_slug = ?`,
      [ts, task_id, this.project_slug],
    )
  }

  async setCompleted(task_id: string, brief: ResearchBrief): Promise<void> {
    await this.ensureSchema()
    const ts = this.now()
    const brief_json = JSON.stringify(brief)
    await this.db.run(
      `UPDATE research_tasks
          SET status = 'completed', brief_json = ?, error = NULL,
              updated_at = ?, completed_at = ?
        WHERE id = ? AND project_slug = ?`,
      [brief_json, ts, ts, task_id, this.project_slug],
    )
  }

  async setFailed(task_id: string, error: string): Promise<void> {
    await this.ensureSchema()
    const ts = this.now()
    await this.db.run(
      `UPDATE research_tasks
          SET status = 'failed', error = ?,
              updated_at = ?, completed_at = ?
        WHERE id = ? AND project_slug = ?`,
      [error, ts, ts, task_id, this.project_slug],
    )
  }

  async get(task_id: string): Promise<ResearchTaskRow | null> {
    await this.ensureSchema()
    const stmt = this.db.prepare<ResearchTaskColumns, [string, string]>(
      `SELECT id, project_slug, query, depth, sources_json, status,
              brief_json, error, attempt_count,
              created_at, updated_at, completed_at
         FROM research_tasks
        WHERE id = ? AND project_slug = ?`,
    )
    const row = stmt.get(task_id, this.project_slug)
    if (row === null || row === undefined) return null
    return rowFromColumns(row)
  }
}

/* -----------------------------------------------------------------
 * Orchestrator
 * ----------------------------------------------------------------- */

export class ResearchTaskNotFoundError extends Error {
  readonly code = 'research_task_not_found' as const
  readonly task_id: string
  constructor(task_id: string) {
    super(`research task not found: ${task_id}`)
    this.name = 'ResearchTaskNotFoundError'
    this.task_id = task_id
  }
}

/**
 * Thrown when `research_start` receives a payload that cannot be coerced
 * into the documented input shape. Wrapped around MCP dispatch boundary —
 * the McpServer passes JSON through to handlers without enforcing the
 * tool's manifest input_schema, so the orchestrator must reject malformed
 * payloads BEFORE they reach `insertPending` (where an invalid `depth`
 * would otherwise trip the SQLite CHECK constraint) or the prompt builder
 * (where a non-iterable `sources` would throw a low-level TypeError).
 *
 * Surfaced via the `CapabilityGuard` wrapper as `outcome='error'` in the
 * audit log; the caller sees the message verbatim so the LLM/tool client
 * can self-correct.
 */
export class ResearchInputError extends Error {
  readonly code = 'research_invalid_input' as const
  readonly field: string
  readonly tool: string
  constructor(field: string, message: string, tool: string = 'research_start') {
    super(`${tool}: ${field}: ${message}`)
    this.name = 'ResearchInputError'
    this.field = field
    this.tool = tool
  }
}

/**
 * Coerce an unknown runtime payload to a `{task_id}` pair. Used by
 * `research_status` / `research_fetch` so a malformed payload (no
 * `task_id`, wrong type, empty string) surfaces as a typed
 * `ResearchInputError` distinguishable from `ResearchTaskNotFoundError`
 * — a tool-call client (LLM, MCP inspector) can self-correct on the
 * former but not the latter.
 */
function validateTaskIdInput(input: unknown, tool: string): { task_id: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ResearchInputError('input', 'must be an object', tool)
  }
  const obj = input as Record<string, unknown>
  if (typeof obj['task_id'] !== 'string') {
    throw new ResearchInputError('task_id', 'must be a string', tool)
  }
  if ((obj['task_id'] as string).trim() === '') {
    throw new ResearchInputError('task_id', 'must be a non-empty string', tool)
  }
  return { task_id: obj['task_id'] as string }
}

const VALID_DEPTHS: readonly ResearchDepth[] = ['quick', 'standard', 'deep']

/**
 * Coerce an unknown runtime payload to a typed `ResearchStartInput`.
 * Throws `ResearchInputError` on any structural mismatch — the message
 * names the offending field + reason so a tool-call client (LLM, MCP
 * inspector, test harness) can correct and retry.
 */
function validateStartInput(input: unknown): {
  query: string
  depth: ResearchDepth
  sources: readonly string[]
} {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ResearchInputError('input', 'must be an object')
  }
  const obj = input as Record<string, unknown>

  if (typeof obj['query'] !== 'string') {
    throw new ResearchInputError('query', 'must be a string')
  }
  const trimmed = (obj['query'] as string).trim()
  if (trimmed === '') {
    throw new ResearchInputError('query', 'must be a non-empty string')
  }

  let depth: ResearchDepth = DEFAULT_DEPTH
  if (obj['depth'] !== undefined && obj['depth'] !== null) {
    if (typeof obj['depth'] !== 'string') {
      throw new ResearchInputError('depth', 'must be a string when set')
    }
    if (!(VALID_DEPTHS as readonly string[]).includes(obj['depth'])) {
      throw new ResearchInputError(
        'depth',
        `must be one of ${VALID_DEPTHS.join(' | ')} when set`,
      )
    }
    depth = obj['depth'] as ResearchDepth
  }

  let sources: readonly string[] = []
  if (obj['sources'] !== undefined && obj['sources'] !== null) {
    if (!Array.isArray(obj['sources'])) {
      throw new ResearchInputError('sources', 'must be an array of strings when set')
    }
    for (let i = 0; i < obj['sources'].length; i++) {
      if (typeof obj['sources'][i] !== 'string') {
        throw new ResearchInputError(
          'sources',
          `entry [${i}] must be a string`,
        )
      }
    }
    sources = obj['sources'] as string[]
  }

  return { query: trimmed, depth, sources }
}

export interface ResearchStartInput {
  query: string
  depth?: ResearchDepth
  sources?: readonly string[]
}

export interface ResearchStartResult {
  task_id: string
  status: ResearchStatus
}

export interface ResearchStatusInput {
  task_id: string
}

export interface ResearchStatusResult {
  task_id: string
  status: ResearchStatus
  error?: string
  created_at: number
  updated_at: number
  completed_at?: number
}

export interface ResearchFetchInput {
  task_id: string
}

export interface ResearchFetchResult {
  task_id: string
  status: ResearchStatus
  brief?: ResearchBrief
  error?: string
}

export interface ResearchBackend {
  start(input: ResearchStartInput): Promise<ResearchStartResult>
  status(input: ResearchStatusInput): Promise<ResearchStatusResult>
  fetch(input: ResearchFetchInput): Promise<ResearchFetchResult>
}

export interface BuildOrchestratorOptions {
  store: ResearchStore
  substrate: ResearchSubstrate
  /**
   * Model preference passed through to the substrate. Defaults to
   * `[SONNET_MODEL, FAST_MODEL]` — Sonnet 4.6 for the primary
   * synthesis pass with Haiku 4.5 as the fallback when Sonnet's
   * bucket is exhausted. The substrate adapter ultimately decides
   * which model to use; this is the hint the Core surfaces.
   */
  model_preference?: readonly string[]
}

/**
 * Build the synchronous research orchestrator. v1 contract:
 *
 *   `start` inserts a `pending` row, flips it to `running`, calls
 *   the substrate once, parses the response, retries once with the
 *   parser error if the first attempt couldn't be parsed, then
 *   writes the terminal state (`completed` or `failed`) before
 *   returning. The returned `status` reflects the terminal state.
 *
 *   `status` reads the row; missing → `ResearchTaskNotFoundError`.
 *
 *   `fetch` reads the row; missing → `ResearchTaskNotFoundError`.
 *   For completed rows the brief is included; for failed rows the
 *   error is included; for pending/running (unreachable in v1, but
 *   shaped for forward compat) both are omitted.
 *
 * If the substrate itself throws (network error, auth error, etc.),
 * we mark the task `failed` with the substrate's error message and
 * surface that via `fetch` rather than re-throwing — the brief locks
 * this behaviour so callers see consistent failure semantics whether
 * the LLM produced unparseable text or no text at all.
 */
export function buildResearchOrchestrator(
  opts: BuildOrchestratorOptions,
): ResearchBackend {
  const default_model_preference =
    opts.model_preference ?? ([SONNET_MODEL, FAST_MODEL] as const)

  return {
    async start(input: ResearchStartInput): Promise<ResearchStartResult> {
      // Runtime input validation — McpServer.dispatch passes raw JSON
      // through to tool handlers without enforcing the manifest's
      // input_schema, so the orchestrator must reject malformed payloads
      // BEFORE persistence / prompt building. Throws ResearchInputError
      // (captured by the CapabilityGuard wrapper as outcome='error').
      const { query, depth, sources } = validateStartInput(input)

      const row = await opts.store.insertPending({ query, depth, sources })
      await opts.store.setRunning(row.id)

      let firstError: string | undefined
      let firstRaw: string | undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        await opts.store.bumpAttempt(row.id)
        const prompt = buildSynthesisPrompt({
          query,
          depth,
          sources,
          ...(attempt === 1 && firstError !== undefined && firstRaw !== undefined
            ? { retry_parse_error: firstError, retry_raw_response: firstRaw }
            : {}),
        })
        let response: ResearchSubstrateResult
        try {
          response = await opts.substrate.synthesize({
            prompt,
            model_preference: default_model_preference,
          })
        } catch (err) {
          // Substrate-level failure (network, auth, quota). We don't
          // retry these — the parse-error retry is for malformed LLM
          // output, not transport failures. Surface as `failed`.
          const msg = err instanceof Error ? err.message : String(err)
          await opts.store.setFailed(row.id, `substrate error: ${msg}`)
          return { task_id: row.id, status: 'failed' }
        }

        let parsed: unknown
        try {
          parsed = extractJson(response.text)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (attempt === 0) {
            firstError = msg
            firstRaw = response.text
            continue
          }
          await opts.store.setFailed(
            row.id,
            `parse error on retry: ${msg}`,
          )
          return { task_id: row.id, status: 'failed' }
        }

        const validated = validateResearchBrief(parsed)
        if (!validated.ok) {
          if (attempt === 0) {
            firstError = validated.error
            firstRaw = response.text
            continue
          }
          await opts.store.setFailed(
            row.id,
            `schema error on retry: ${validated.error}`,
          )
          return { task_id: row.id, status: 'failed' }
        }

        await opts.store.setCompleted(row.id, validated.brief)
        return { task_id: row.id, status: 'completed' }
      }
      // Unreachable — the loop always returns or sets failed inside.
      // Defensive fallthrough: mark failed and surface so the caller
      // never sees a row stuck in `running`.
      await opts.store.setFailed(row.id, 'orchestrator exited without terminal state')
      return { task_id: row.id, status: 'failed' }
    },

    async status(input: ResearchStatusInput): Promise<ResearchStatusResult> {
      const { task_id } = validateTaskIdInput(input, 'research_status')
      const row = await opts.store.get(task_id)
      if (row === null) throw new ResearchTaskNotFoundError(task_id)
      const result: ResearchStatusResult = {
        task_id: row.id,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
      if (row.error !== null) result.error = row.error
      if (row.completed_at !== null) result.completed_at = row.completed_at
      return result
    },

    async fetch(input: ResearchFetchInput): Promise<ResearchFetchResult> {
      const { task_id } = validateTaskIdInput(input, 'research_fetch')
      const row = await opts.store.get(task_id)
      if (row === null) throw new ResearchTaskNotFoundError(task_id)
      const result: ResearchFetchResult = {
        task_id: row.id,
        status: row.status,
      }
      if (row.brief !== null) result.brief = row.brief
      if (row.error !== null) result.error = row.error
      return result
    },
  }
}
