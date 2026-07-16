/**
 * @neutronai/scribe — reflect: reserved-kind extraction (RB3 job 3).
 *
 * Chat-time Scribe (`scribe/extract.ts`) only ever emits person / company /
 * concept — it RESERVES the `meeting` / `project` / `original` kinds in the
 * entity-writer's kind space but never writes them (`scribe/index.ts` header:
 * "`meeting` stays a reserved trigger"; `scribe-budget.ts`: the reserved
 * union). The reflect batch pass closes that gap: it re-reads the accumulated
 * corpus and extracts the durable meetings / projects / notes it evidences, then
 * writes them through the SAME entity-writer → GBrain path Scribe uses.
 *
 * This module owns only the LLM CONTRACT for that extraction (prompt + parse).
 * Cost lives entirely in the reflect pass (one batched call over the corpus) —
 * NOTHING here runs on a normal save. The parser is the same tolerant
 * JSON-object recovery Scribe uses, so a fenced / preamble-wrapped emit still
 * parses and a garbage emit degrades to the empty set (a bad batch never throws).
 */

import { extractJsonObject } from '../extract.ts'

/** The three kinds Scribe reserves but never writes — the reflect pass's remit. */
export type ReservedKind = 'meeting' | 'project' | 'original'

const RESERVED_KINDS: ReadonlySet<string> = new Set<ReservedKind>(['meeting', 'project', 'original'])

/** One extracted reserved-kind entity. */
export interface ReservedEntity {
  /** Canonical display name. */
  name: string
  kind: ReservedKind
  /** One-line durable fact grounding the entity in the corpus. Optional. */
  fact?: string
}

/**
 * The reserved-kind extraction persona. Deliberately NARROW: it extracts ONLY
 * meetings / projects / notes, never people / companies / concepts (Scribe
 * already owns those on every save — re-extracting them here would double-write
 * and cost tokens for nothing). Grounded-only, over-creation-averse — the same
 * Nova-scribe discipline, scoped to the reserved kinds.
 */
export const RESERVED_EXTRACTION_PROMPT = `You are the reflect pass — a periodic, silent consolidation step over an accumulated knowledge base. You read a digest of what is already known (entity pages + their timelines) and pull out the durable MEETINGS, PROJECTS, and NOTES it evidences. People, companies, and concepts are already captured elsewhere — do NOT extract those.

Return a SINGLE JSON object — no preamble, no markdown fence, JSON only:

{
  "entities": [
    { "name": "<canonical name>", "kind": "meeting" | "project" | "original", "fact": "<one-line durable fact grounded in the digest>" }
  ]
}

Kinds:
- "meeting": a specific, real meeting / call / event that took place or is scheduled — named or clearly identifiable (e.g. "Q3 Board Meeting", "Acme kickoff call"). NOT a generic "a meeting".
- "project": a concrete initiative / effort / deliverable the owner is working on — with a name or a clear identity (e.g. "Perfect Recall", "website redesign"). NOT a passing topic.
- "original": a durable note / idea / artifact worth remembering on its own (e.g. a decision, a principle, a saved write-up).

Hard rules:
- Extract ONLY what the digest states or clearly implies. Never invent, never enrich from outside knowledge.
- Prefer named, specific, durable entities. When in doubt, skip — over-extraction is worse than under-extraction.
- "fact" is one short line grounded in the digest; omit it if there is no durable fact.
- If the digest evidences no durable meeting / project / note, return {"entities": []}.

DIGEST:
`

/** Compose the reserved-kind prompt for a corpus digest. */
export function composeReservedPrompt(digest: string): string {
  return `${RESERVED_EXTRACTION_PROMPT}${digest.trim()}\n`
}

/**
 * Parse the reserved-kind extraction JSON. Tolerates fenced / preamble-wrapped
 * emits (same recovery as `scribe/extract.ts`), drops rows with a missing name
 * or a kind outside the reserved set, and returns the empty array for anything
 * unparseable — a single bad batch never throws.
 */
export function parseReservedExtraction(text: string): ReservedEntity[] {
  const obj = extractJsonObject(text)
  if (obj === null || typeof obj !== 'object') return []
  const rows = (obj as Record<string, unknown>)['entities']
  if (!Array.isArray(rows)) return []
  const out: ReservedEntity[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const name = typeof r['name'] === 'string' ? r['name'].trim() : ''
    const kind = typeof r['kind'] === 'string' ? r['kind'].trim() : ''
    if (name.length === 0 || !RESERVED_KINDS.has(kind)) continue
    const entity: ReservedEntity = { name, kind: kind as ReservedKind }
    const fact = typeof r['fact'] === 'string' ? r['fact'].trim() : ''
    if (fact.length > 0) entity.fact = fact
    out.push(entity)
  }
  return out
}
