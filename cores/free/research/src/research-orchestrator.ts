/**
 * @neutronai/research-core — per-project research orchestrator.
 *
 * Wraps the existing parse-once-retry-once `buildResearchOrchestrator`
 * pipeline (from backend.ts) with per-project storage, the claim-store
 * + sources-cited invariant, the deep-research sub-agent harness, the
 * list + find surfaces, and the markdown-rendered file output.
 *
 * Per docs/plans/research-core-tier1-brief.md § 3 + § 6.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { NeutronManifest } from '@neutronai/cores-sdk'

import { FAST_MODEL, SONNET_MODEL } from '@neutronai/runtime/models.ts'

import {
  ResearchInputError,
  ResearchTaskNotFoundError,
  buildSynthesisPrompt,
  extractJson,
  validateResearchBrief,
  type ResearchBrief,
  type ResearchClaimEntry,
  type ResearchDepth,
  type ResearchStatus,
  type ResearchSubstrate,
} from './backend.ts'
import {
  ResearchClaimStore,
  type ResearchClaim,
  type ResearchClaimConfidence,
} from './claim-store.ts'
import {
  SourcesCitedViolationError,
  assertSourcesCited,
} from './claim-validator.ts'
import { renderBriefMarkdown } from './render-markdown.ts'
import type {
  ResearchProjectStore,
  ResearchProjectTaskRow,
} from './research-store.ts'
import { searchPriorBriefs, type ResearchSearchHit } from './vault-search.ts'
import {
  dispatchResearchSubAgent,
  type PerOwnerConcurrencyGate,
  type RuntimeSubAgentDispatcher,
} from './sub-agent.ts'

export interface ResearchDeepInput {
  query: string
  project_id: string
  budget_ms?: number
  /** Sub-agent tool whitelist override (advanced). */
  tools?: readonly string[]
}

export interface ResearchListInput {
  project_id: string
  limit?: number
  since?: number
}

export interface ResearchFindInput {
  project_id: string
  query: string
  limit?: number
}

export interface ResearchClaimsListInput {
  task_id: string
  project_id: string
  only_unverified?: boolean
}

export interface ResearchCiteInput {
  claim_id: string
  citation: string
  project_id: string
}

export interface ResearchStartInputV2 {
  query: string
  depth?: ResearchDepth
  sources?: readonly string[]
  project_id: string
}

export interface ResearchStartResult {
  task_id: string
  status: ResearchStatus
}

export interface ResearchListResult {
  briefs: Array<{
    task_id: string
    topic: string | null
    status: ResearchStatus
    claim_count: number
    confidence_level: 'low' | 'medium' | 'high' | null
    completed_at: number | null
    created_at: number
  }>
}

export interface ResearchFindResult {
  hits: ResearchSearchHit[]
}

export interface ResearchCiteResult {
  claim_id: string
  citation: string
  updated_at: number
}

export interface ResearchClaimsListResult {
  claims: ResearchClaim[]
}

export interface ResearchProjectHandleResolver {
  resolve(project_id: string): Promise<{
    store: ResearchProjectStore
    claimStore: ResearchClaimStore
  }>
  outputDirFor(project_id: string): string
}

export interface ResearchOrchestratorOptions {
  resolver: ResearchProjectHandleResolver
  substrate: ResearchSubstrate
  /** Optional — required for `/research deep`. */
  sub_agent_dispatcher?: RuntimeSubAgentDispatcher
  /** Optional — required for `/research deep` (per-instance cap). */
  concurrency_gate?: PerOwnerConcurrencyGate
  /** Optional model preference forwarded to the substrate. */
  model_preference?: readonly string[]
  manifest: NeutronManifest
  /** Instance slug for sub-agent dispatch + claim scoping. */
  project_slug: string
  /** Override clock (testing seam). */
  now?: () => number
  /** Override ULID factory. */
  nextId?: () => string
  /** Override `writeFileSync` for markdown render (testing seam). */
  writeFile?: (path: string, contents: string) => void
}

export interface ResearchProjectBackend {
  start(input: ResearchStartInputV2): Promise<ResearchStartResult>
  deep(input: ResearchDeepInput): Promise<ResearchStartResult>
  list(input: ResearchListInput): Promise<ResearchListResult>
  find(input: ResearchFindInput): Promise<ResearchFindResult>
  cite(input: ResearchCiteInput): Promise<ResearchCiteResult>
  claimsForTask(input: ResearchClaimsListInput): Promise<ResearchClaimsListResult>
  status(input: { task_id: string; project_id: string }): Promise<{
    task_id: string
    status: ResearchStatus
    error?: string
    created_at: number
    updated_at: number
    completed_at?: number
  }>
  fetch(input: { task_id: string; project_id: string }): Promise<{
    task_id: string
    status: ResearchStatus
    brief?: ResearchBrief
    error?: string
  }>
}

// Argus r2 MINOR #1 (2026-05-21) — import the central aliases from
// runtime/models.ts so `NEUTRON_SONNET_MODEL` / `NEUTRON_FAST_MODEL`
// env overrides fire here too. The forwarded preference flows through
// `runSubstratePipeline` → `substrate.synthesize({model_preference})`.
const DEFAULT_MODEL_PREFERENCE = [SONNET_MODEL, FAST_MODEL] as const

/**
 * Build the per-project research backend. The backend resolves the
 * per-project sidecar lazily on each call so a single backend instance
 * services every (instance, project) pair.
 */
export function buildProjectResearchOrchestrator(
  opts: ResearchOrchestratorOptions,
): ResearchProjectBackend {
  const writeFile = opts.writeFile ?? defaultWriteFile
  const model_preference = opts.model_preference ?? DEFAULT_MODEL_PREFERENCE

  async function runSubstratePipeline(
    project_id: string,
    query: string,
    depth: ResearchDepth,
    sources: readonly string[],
  ): Promise<ResearchStartResult> {
    if (typeof project_id !== 'string' || project_id.trim().length === 0) {
      throw new ResearchInputError('project_id', 'must be a non-empty string')
    }
    const handle = await opts.resolver.resolve(project_id)
    const row = handle.store.insertPending({ query, depth, sources })
    handle.store.setRunning(row.id)

    let firstParseError: string | undefined
    let firstRaw: string | undefined
    let firstSourcesError: string | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      handle.store.bumpAttempt(row.id)
      const prompt = buildSynthesisPrompt({
        query,
        depth,
        sources,
        ...(attempt === 1 && firstParseError !== undefined && firstRaw !== undefined
          ? { retry_parse_error: firstParseError, retry_raw_response: firstRaw }
          : {}),
        ...(attempt === 1 && firstSourcesError !== undefined
          ? { retry_sources_cited_violation: firstSourcesError }
          : {}),
      })
      let response: { text: string; model: string }
      try {
        response = await opts.substrate.synthesize({
          prompt,
          model_preference,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        handle.store.setFailed(row.id, `substrate error: ${msg}`)
        return { task_id: row.id, status: 'failed' }
      }

      let parsed: unknown
      try {
        parsed = extractJson(response.text)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (attempt === 0) {
          firstParseError = msg
          firstRaw = response.text
          continue
        }
        handle.store.setFailed(row.id, `parse error on retry: ${msg}`)
        return { task_id: row.id, status: 'failed' }
      }

      const validated = validateResearchBrief(parsed)
      if (!validated.ok) {
        if (attempt === 0) {
          firstParseError = validated.error
          firstRaw = response.text
          continue
        }
        handle.store.setFailed(row.id, `schema error on retry: ${validated.error}`)
        return { task_id: row.id, status: 'failed' }
      }

      // Sources-cited invariant — insert claim rows + run the
      // predicate. On violation, fail the task (after retry).
      const claims = (validated.brief.claims ?? []).map(toClaimRowInput)
      const claimRows: ResearchClaim[] = []
      try {
        for (const c of claims) {
          claimRows.push(handle.claimStore.insertClaim({ task_id: row.id, ...c }))
        }
        assertSourcesCited(row.id, claimRows)
      } catch (err) {
        if (err instanceof SourcesCitedViolationError && attempt === 0) {
          firstSourcesError = err.message
          // Roll the just-inserted claims back so the retry pass starts
          // clean. Tiny in count (1-10); no transaction needed.
          handle.store.database().run(`DELETE FROM research_claims WHERE task_id = ?`, [row.id])
          continue
        }
        if (err instanceof SourcesCitedViolationError) {
          // Final-failure cleanup — drop the claim rows we just inserted
          // before flagging the task failed so the persisted row count
          // matches the user-visible "failed task has no claims" model.
          handle.store.database().run(`DELETE FROM research_claims WHERE task_id = ?`, [row.id])
          handle.store.setFailed(row.id, `sources-cited violation: ${err.message}`)
          return { task_id: row.id, status: 'failed' }
        }
        const msg = err instanceof Error ? err.message : String(err)
        handle.store.setFailed(row.id, `claim insert error: ${msg}`)
        return { task_id: row.id, status: 'failed' }
      }

      handle.store.setCompleted(row.id, validated.brief, claimRows.length)
      writeBriefMarkdown(opts.resolver, project_id, row.id, validated.brief, writeFile)
      return { task_id: row.id, status: 'completed' }
    }
    handle.store.setFailed(row.id, 'orchestrator exited without terminal state')
    return { task_id: row.id, status: 'failed' }
  }

  return {
    async start(input: ResearchStartInputV2): Promise<ResearchStartResult> {
      validateStartInput(input)
      const depth = input.depth ?? 'standard'
      return runSubstratePipeline(
        input.project_id,
        input.query.trim(),
        depth,
        input.sources ?? [],
      )
    },

    async deep(input: ResearchDeepInput): Promise<ResearchStartResult> {
      if (opts.sub_agent_dispatcher === undefined || opts.concurrency_gate === undefined) {
        throw new ResearchInputError(
          'config',
          'sub_agent_dispatcher + concurrency_gate must be configured for /research deep',
          'research_deep',
        )
      }
      if (typeof input.query !== 'string' || input.query.trim().length === 0) {
        throw new ResearchInputError('query', 'must be a non-empty string', 'research_deep')
      }
      if (typeof input.project_id !== 'string' || input.project_id.trim().length === 0) {
        throw new ResearchInputError('project_id', 'must be a non-empty string', 'research_deep')
      }
      const handle = await opts.resolver.resolve(input.project_id)
      const query = input.query.trim()
      const row = handle.store.insertPending({
        query,
        depth: 'deep',
        sources: [],
      })
      handle.store.setRunning(row.id)

      // 2-attempt retry loop mirroring start()'s parse-error-fed-back
      // pattern. Attempt 0 failures (parse / schema / zero-tool grounding)
      // feed specific feedback into the sub-agent's user prompt and retry
      // once; the same failure on attempt 1 is terminal. Dispatch-level
      // errors (concurrency / timeout / transport) are NOT retried.
      let retryFeedback: string | undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        handle.store.bumpAttempt(row.id)
        let subResult
        try {
          subResult = await dispatchResearchSubAgent(
            {
              query,
              project_id: input.project_id,
              project_slug: opts.project_slug,
              // Supply the model EXPLICITLY from this module's legitimate
              // `SONNET_MODEL` import (env-overridable via NEUTRON_SONNET_MODEL)
              // so the live dispatch tracks the override. sub-agent.ts (a bundled
              // Core) may not import runtime/models.ts, so its own
              // DEFAULT_SUB_AGENT_MODEL is a last-resort literal only; the real
              // production dispatch resolves its model here, at the host-legit
              // caller layer.
              model: SONNET_MODEL,
              ...(input.budget_ms !== undefined ? { budget_ms: input.budget_ms } : {}),
              ...(input.tools !== undefined ? { tools: input.tools } : {}),
              ...(retryFeedback !== undefined ? { retry_feedback: retryFeedback } : {}),
            },
            {
              runtime_sub_agent: opts.sub_agent_dispatcher,
              concurrency_gate: opts.concurrency_gate,
            },
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const code =
            (err as { code?: string }).code === 'sub_agent_concurrency_exceeded'
              ? 'concurrency_rejected'
              : (err as { code?: string }).code === 'sub_agent_timeout'
                ? 'timeout'
                : 'error'
          handle.store.recordSubAgentRun({
            task_id: row.id,
            model: SONNET_MODEL,
            budget_ms: input.budget_ms ?? 5 * 60 * 1000,
            elapsed_ms: 0,
            tool_call_count: 0,
            outcome: code,
            error: msg,
          })
          handle.store.setFailed(row.id, `sub-agent ${code}: ${msg}`)
          return { task_id: row.id, status: 'failed' }
        }

        // One run row per attempt (research-store INSERT is multi-row-safe).
        handle.store.recordSubAgentRun({
          task_id: row.id,
          model: subResult.model,
          budget_ms: input.budget_ms ?? 5 * 60 * 1000,
          elapsed_ms: subResult.elapsed_ms,
          tool_call_count: subResult.tool_calls.length,
          outcome: 'ok',
        })

        // Zero-tool grounding gate — BEFORE parse. Fires ONLY when tools
        // were requested AND the dispatcher reported them available AND the
        // sub-agent made zero tool calls. Inert when tools_available is
        // false/undefined (the v1 production dispatcher shape) so production
        // deep runs are not bricked.
        const toolsRequested = input.tools === undefined || input.tools.length > 0
        if (toolsRequested && subResult.tools_available && subResult.tool_calls.length === 0) {
          if (attempt === 0) {
            retryFeedback = ZERO_TOOL_FEEDBACK
            continue
          }
          handle.store.setFailed(
            row.id,
            'sub-agent made zero tool calls on retry - ungrounded brief rejected',
          )
          return { task_id: row.id, status: 'failed' }
        }

        // Parse with retry.
        let parsed: unknown
        try {
          parsed = extractJson(subResult.raw_brief_text)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (attempt === 0) {
            retryFeedback = buildParseRetryFeedback(msg, subResult.raw_brief_text)
            continue
          }
          handle.store.setFailed(row.id, `parse error on retry: ${msg}`)
          return { task_id: row.id, status: 'failed' }
        }
        const validated = validateResearchBrief(parsed)
        if (!validated.ok) {
          if (attempt === 0) {
            retryFeedback = buildSchemaRetryFeedback(validated.error, subResult.raw_brief_text)
            continue
          }
          handle.store.setFailed(row.id, `schema error on retry: ${validated.error}`)
          return { task_id: row.id, status: 'failed' }
        }

        // Claim-insert + sources-cited assertion — UNCHANGED single-shot
        // (sources-cited retry is an explicit non-goal for this task).
        const claims = (validated.brief.claims ?? []).map(toClaimRowInput)
        const claimRows: ResearchClaim[] = []
        try {
          for (const c of claims) {
            claimRows.push(handle.claimStore.insertClaim({ task_id: row.id, ...c }))
          }
          assertSourcesCited(row.id, claimRows)
        } catch (err) {
          // Drop the just-inserted claims on failure to match the "failed
          // task has no claims" persisted-row invariant.
          handle.store.database().run(`DELETE FROM research_claims WHERE task_id = ?`, [row.id])
          if (err instanceof SourcesCitedViolationError) {
            handle.store.setFailed(row.id, `sources-cited violation: ${err.message}`)
          } else {
            const msg = err instanceof Error ? err.message : String(err)
            handle.store.setFailed(row.id, `claim insert error: ${msg}`)
          }
          return { task_id: row.id, status: 'failed' }
        }
        handle.store.setCompleted(row.id, validated.brief, claimRows.length)
        writeBriefMarkdown(opts.resolver, input.project_id, row.id, validated.brief, writeFile)
        return { task_id: row.id, status: 'completed' }
      }
      // Unreachable guard, mirrors start()'s exited-without-terminal path.
      handle.store.setFailed(row.id, 'deep orchestrator exited without terminal state')
      return { task_id: row.id, status: 'failed' }
    },

    async list(input: ResearchListInput): Promise<ResearchListResult> {
      if (typeof input.project_id !== 'string' || input.project_id.trim().length === 0) {
        throw new ResearchInputError('project_id', 'must be a non-empty string', 'research_list')
      }
      const handle = await opts.resolver.resolve(input.project_id)
      const listOpts: Parameters<ResearchProjectStore['list']>[0] = {}
      if (input.limit !== undefined) listOpts.limit = input.limit
      if (input.since !== undefined) listOpts.since = input.since
      const rows = handle.store.list(listOpts)
      return {
        briefs: rows.map((r) => ({
          task_id: r.id,
          topic: r.topic,
          status: r.status,
          claim_count: r.claim_count,
          confidence_level: r.confidence_level,
          completed_at: r.completed_at,
          created_at: r.created_at,
        })),
      }
    },

    async find(input: ResearchFindInput): Promise<ResearchFindResult> {
      if (typeof input.project_id !== 'string' || input.project_id.trim().length === 0) {
        throw new ResearchInputError('project_id', 'must be a non-empty string', 'research_find')
      }
      if (typeof input.query !== 'string' || input.query.trim().length === 0) {
        throw new ResearchInputError('query', 'must be a non-empty string', 'research_find')
      }
      const handle = await opts.resolver.resolve(input.project_id)
      const searchOpts: SearchInputAdapter = { query: input.query }
      if (input.limit !== undefined) searchOpts.limit = input.limit
      const hits = searchPriorBriefs(searchOpts, { store: handle.store })
      return { hits }
    },

    async cite(input: ResearchCiteInput): Promise<ResearchCiteResult> {
      if (typeof input.project_id !== 'string' || input.project_id.trim().length === 0) {
        throw new ResearchInputError('project_id', 'must be a non-empty string', 'research_cite')
      }
      if (typeof input.claim_id !== 'string' || input.claim_id.trim().length === 0) {
        throw new ResearchInputError('claim_id', 'must be a non-empty string', 'research_cite')
      }
      if (typeof input.citation !== 'string' || input.citation.trim().length === 0) {
        throw new ResearchInputError('citation', 'must be a non-empty string', 'research_cite')
      }
      const handle = await opts.resolver.resolve(input.project_id)
      const updated = handle.claimStore.cite(input.claim_id, input.citation)
      if (updated === null) {
        throw new ResearchTaskNotFoundError(input.claim_id)
      }
      return {
        claim_id: updated.id,
        citation: updated.citation ?? input.citation,
        updated_at: updated.created_at,
      }
    },

    async claimsForTask(
      input: ResearchClaimsListInput,
    ): Promise<ResearchClaimsListResult> {
      if (typeof input.task_id !== 'string' || input.task_id.trim().length === 0) {
        throw new ResearchInputError('task_id', 'must be a non-empty string', 'research_claims_list')
      }
      const handle = await opts.resolver.resolve(input.project_id)
      const all = handle.claimStore.listForTask(input.task_id)
      const filtered = input.only_unverified
        ? all.filter((c) => c.confidence === 'unverified')
        : all
      return { claims: filtered }
    },

    async status(input) {
      if (typeof input.project_id !== 'string' || input.project_id.trim().length === 0) {
        throw new ResearchInputError('project_id', 'must be a non-empty string', 'research_status')
      }
      const handle = await opts.resolver.resolve(input.project_id)
      const row = handle.store.get(input.task_id)
      if (row === null) throw new ResearchTaskNotFoundError(input.task_id)
      const result: {
        task_id: string
        status: ResearchStatus
        error?: string
        created_at: number
        updated_at: number
        completed_at?: number
      } = {
        task_id: row.id,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
      if (row.error !== null) result.error = row.error
      if (row.completed_at !== null) result.completed_at = row.completed_at
      return result
    },

    async fetch(input) {
      if (typeof input.project_id !== 'string' || input.project_id.trim().length === 0) {
        throw new ResearchInputError('project_id', 'must be a non-empty string', 'research_fetch')
      }
      const handle = await opts.resolver.resolve(input.project_id)
      const row = handle.store.get(input.task_id)
      if (row === null) throw new ResearchTaskNotFoundError(input.task_id)
      const result: {
        task_id: string
        status: ResearchStatus
        brief?: ResearchBrief
        error?: string
      } = { task_id: row.id, status: row.status }
      if (row.brief !== null) result.brief = row.brief
      if (row.error !== null) result.error = row.error
      return result
    },
  }
}

interface SearchInputAdapter {
  query: string
  limit?: number
}

function toClaimRowInput(
  entry: ResearchClaimEntry,
): {
  claim: string
  evidence?: string
  citation?: string
  confidence: ResearchClaimConfidence
} {
  const out: {
    claim: string
    evidence?: string
    citation?: string
    confidence: ResearchClaimConfidence
  } = {
    claim: entry.claim,
    confidence: entry.confidence as ResearchClaimConfidence,
  }
  if (entry.evidence !== undefined) out.evidence = entry.evidence
  if (entry.citation !== undefined) out.citation = entry.citation
  return out
}

function validateStartInput(input: ResearchStartInputV2): void {
  if (input === null || typeof input !== 'object') {
    throw new ResearchInputError('input', 'must be an object', 'research_start')
  }
  if (typeof input.query !== 'string') {
    throw new ResearchInputError('query', 'must be a string', 'research_start')
  }
  if (input.query.trim().length === 0) {
    throw new ResearchInputError('query', 'must be a non-empty string', 'research_start')
  }
  if (typeof input.project_id !== 'string' || input.project_id.trim().length === 0) {
    throw new ResearchInputError('project_id', 'must be a non-empty string', 'research_start')
  }
  if (input.depth !== undefined && !['quick', 'standard', 'deep'].includes(input.depth)) {
    throw new ResearchInputError(
      'depth',
      'must be one of quick | standard | deep when set',
      'research_start',
    )
  }
  if (input.sources !== undefined && input.sources !== null) {
    if (!Array.isArray(input.sources)) {
      throw new ResearchInputError(
        'sources',
        'must be an array of strings when set',
        'research_start',
      )
    }
    for (const s of input.sources) {
      if (typeof s !== 'string') {
        throw new ResearchInputError('sources', 'entries must be strings', 'research_start')
      }
    }
  }
}

function writeBriefMarkdown(
  resolver: ResearchProjectHandleResolver,
  project_id: string,
  task_id: string,
  brief: ResearchBrief,
  writeFile: (path: string, contents: string) => void,
): void {
  const outDir = resolver.outputDirFor(project_id)
  const slug = slugify(brief.topic) || task_id
  const path = join(outDir, `${slug}__${task_id.slice(0, 8)}.md`)
  const contents = renderBriefMarkdown(brief, {
    task_id,
    project_id,
    written_at: new Date(),
  })
  writeFile(path, contents)
}

function defaultWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 })
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

// Retry feedback strings fed back into the sub-agent's user prompt on the
// 2nd attempt (behind `RETRY_FEEDBACK_MARKER`). No em dashes.
const RETRY_JSON_CONTRACT =
  'Return EXACTLY one JSON object matching the ResearchBrief shape from your ' +
  'system prompt. No prose, no markdown fences, no commentary.'

function buildParseRetryFeedback(msg: string, raw: string): string {
  return (
    `Your previous response could not be parsed as JSON (${msg}). ` +
    `It began: ${raw.slice(0, 2000)}\n` +
    RETRY_JSON_CONTRACT
  )
}

function buildSchemaRetryFeedback(msg: string, raw: string): string {
  return (
    `Your previous response parsed as JSON but failed schema validation: ${msg}. ` +
    `It began: ${raw.slice(0, 2000)}\n` +
    RETRY_JSON_CONTRACT
  )
}

const ZERO_TOOL_FEEDBACK =
  'Your previous attempt made ZERO tool calls, so the brief was rejected as ' +
  'ungrounded. You MUST ground the brief in real tool results: call ' +
  'research_vault_search first, then research_web_search and research_web_fetch ' +
  'as needed, BEFORE emitting the final JSON.'
