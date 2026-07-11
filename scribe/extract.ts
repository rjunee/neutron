/**
 * @neutronai/scribe — chat-time extraction (LLM call + parse).
 *
 * The extraction step is an LLM call. It MUST dispatch through Neutron's
 * CC-spawn substrate (`runtime/substrate.ts` — the shared `llmCallSubstrate`
 * built at composer boot), NEVER a direct `api.anthropic.com` POST. This is the
 * hard rule from `feedback_cc_subprocess_substrate.md`: all owner LLM work
 * spawns a `claude` subprocess against the per-instance credential pool.
 *
 * The prompt persona is LIFTED from Nova's `prompts/scribe.md` (silent
 * log-keeper, extraction-only, dedup-minded, over-creation is worse than
 * under-creation) but the OUTPUT contract is adapted: Nova's scribe wrote
 * markdown files directly; Neutron's scribe returns a structured JSON document
 * that `write-to-gbrain.ts` fans through the entity-writer → GBrain. The KG-write
 * boundary moved from "the sub-agent does file ops" to "the extractor returns
 * data; the writer owns persistence".
 */

import type { Substrate } from '@neutronai/runtime/substrate.ts'
import { getBestModel } from '@neutronai/runtime/models.ts'
import { drainToText } from '@neutronai/runtime/substrate-text.ts'

export type ExtractedEntityKind = 'person' | 'company' | 'concept'

export interface ExtractedEntity {
  /** Canonical display name as it appeared in the turn. */
  name: string
  kind: ExtractedEntityKind
  /** One-line compiled-truth statement about the entity. Optional. */
  fact?: string
}

export interface ExtractedRelation {
  /** Subject display name (must match an entity in `entities`). */
  subject: string
  /** One of the entity-writer's predicate vocabulary (auto-link.ts PREDICATES). */
  predicate: string
  /** Object display name (the related entity). */
  object: string
}

export interface ScribeExtraction {
  entities: ExtractedEntity[]
  relations: ExtractedRelation[]
}

const EMPTY: ScribeExtraction = Object.freeze({ entities: [], relations: [] }) as ScribeExtraction

/**
 * Lifted-and-adapted Nova scribe persona. The structural rules (extraction
 * only, dedup, skip non-notable mentions, never invent) are carried verbatim
 * in spirit; the output contract is a single JSON object instead of file ops.
 */
export const SCRIBE_EXTRACTION_PROMPT = `You are the scribe — a silent, extraction-only knowledge log-keeper. You read one chat turn and pull out the durable knowledge worth remembering. You are not a writer, summarizer, or assistant. The user never sees your output.

Extract two things from the message below and return them as a SINGLE JSON object — no preamble, no markdown fence, JSON only:

{
  "entities": [
    { "name": "<canonical name>", "kind": "person" | "company" | "concept", "fact": "<one-line durable fact about them stated in the message>" }
  ],
  "relations": [
    { "subject": "<entity name>", "predicate": "<one of: founded, invested_in, advises, works_at, attended, met, mentions>", "object": "<entity name>" }
  ]
}

Hard rules:
- Extract ONLY what the message states or clearly implies. Never invent facts, never enrich from outside knowledge.
- People and companies that are spoken of as real, notable entities. SKIP passing role-nouns ("the doctor", "my manager"), generic references, and first names with no context. When in doubt, skip — over-extraction is worse than under-extraction.
- Concepts: durable ideas, projects, frameworks, or topics the user is working on — not transient chit-chat.
- "fact" is one short line; omit it if the message states no durable fact about the entity.
- Every relation's subject and object SHOULD also appear in "entities". predicate MUST be one of the seven listed.
- If the message contains nothing worth remembering, return {"entities": [], "relations": []}.

MESSAGE:
`

export function composeExtractionPrompt(text: string): string {
  return `${SCRIBE_EXTRACTION_PROMPT}${text.trim()}\n`
}

export interface RunExtractionDeps {
  /** The shared CC-spawn LLM-call substrate (per-instance credential pool). */
  substrate: Substrate
  /** Model preference. Defaults to `[BEST_MODEL]` (Opus) per feedback_default_to_opus. */
  model_preference?: ReadonlyArray<string>
  /** Output token budget. Defaults to 2048 — extraction JSON is small. */
  max_tokens?: number
}

/**
 * Dispatch one extraction turn through the substrate and return the parsed
 * structured result. The optional `signal` is the watchdog abort — when it
 * fires the underlying substrate handle is cancelled and this throws.
 *
 * A malformed / empty LLM response yields the empty extraction (a single bad
 * turn never throws past the parser); only a substrate `error` event or a
 * watchdog abort throws.
 */
export async function runExtraction(
  deps: RunExtractionDeps,
  text: string,
  signal?: AbortSignal,
): Promise<ScribeExtraction> {
  const handle = deps.substrate.start({
    prompt: composeExtractionPrompt(text),
    tools: [],
    model_preference:
      deps.model_preference !== undefined && deps.model_preference.length > 0
        ? [...deps.model_preference]
        : [getBestModel()],
    max_tokens: deps.max_tokens ?? 2048,
  })
  // O8 — the drain loop is now the ONE `drainToText`. `keepAliveExempt` preserves
  // scribe's watchdog divergence: a fired `signal` cancels the handle (abandon-
  // poisoning the warm session so the next dispatch respawns clean). Error/abort
  // prose is byte-identical to the pre-O8 local `drainToString`.
  const raw = await drainToText(handle, {
    ...(signal !== undefined ? { signal } : {}),
    errorPrefix: 'scribe extract: substrate error: ',
    abortMessage: 'scribe extract: aborted (watchdog)',
    abortBeforeDispatchMessage: 'scribe extract: aborted before dispatch (watchdog)',
    keepAliveExempt: true,
  })
  return parseExtraction(raw)
}

/**
 * Parse the extractor's JSON document, tolerating a markdown code-fence wrapper
 * (a recurring Anthropic quirk) and leading preamble. Returns the empty
 * extraction for anything unparseable so a single bad emit never tanks the
 * chat turn.
 */
export function parseExtraction(text: string): ScribeExtraction {
  const obj = extractJsonObject(text)
  if (obj === null || typeof obj !== 'object') return EMPTY
  const o = obj as Record<string, unknown>
  return {
    entities: normEntities(o['entities']),
    relations: normRelations(o['relations']),
  }
}

const VALID_KINDS: ReadonlySet<string> = new Set(['person', 'company', 'concept'])
const VALID_PREDICATES: ReadonlySet<string> = new Set([
  'founded',
  'invested_in',
  'advises',
  'works_at',
  'attended',
  'met',
  'mentions',
])

function normEntities(v: unknown): ExtractedEntity[] {
  if (!Array.isArray(v)) return []
  const out: ExtractedEntity[] = []
  for (const row of v) {
    if (row === null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const name = typeof r['name'] === 'string' ? r['name'].trim() : ''
    const kind = typeof r['kind'] === 'string' ? r['kind'].trim() : ''
    if (name.length === 0 || !VALID_KINDS.has(kind)) continue
    const entity: ExtractedEntity = { name, kind: kind as ExtractedEntityKind }
    const fact = typeof r['fact'] === 'string' ? r['fact'].trim() : ''
    if (fact.length > 0) entity.fact = fact
    out.push(entity)
  }
  return out
}

function normRelations(v: unknown): ExtractedRelation[] {
  if (!Array.isArray(v)) return []
  const out: ExtractedRelation[] = []
  for (const row of v) {
    if (row === null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const subject = typeof r['subject'] === 'string' ? r['subject'].trim() : ''
    const predicate = typeof r['predicate'] === 'string' ? r['predicate'].trim() : ''
    const object = typeof r['object'] === 'string' ? r['object'].trim() : ''
    if (subject.length === 0 || object.length === 0) continue
    if (!VALID_PREDICATES.has(predicate)) continue
    out.push({ subject, predicate, object })
  }
  return out
}

/**
 * Best-effort JSON-object extraction from LLM text: direct parse, then
 * markdown-fence strip, then first-balanced-object substring. Returns null
 * when nothing parses.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/)
  if (fence !== null && typeof fence[1] === 'string') {
    try {
      return JSON.parse(fence[1].trim())
    } catch {
      // fall through
    }
  }
  const firstBrace = trimmed.indexOf('{')
  if (firstBrace !== -1) {
    const slice = sliceBalancedObject(trimmed, firstBrace)
    if (slice !== null) {
      try {
        return JSON.parse(slice)
      } catch {
        // fall through
      }
    }
  }
  return null
}

function sliceBalancedObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
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
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}
