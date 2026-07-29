/**
 * @neutronai/research-core — render a ResearchBrief into a markdown file.
 *
 * Per docs/plans/research-core-tier1-brief.md § 2.3 (render-markdown.ts).
 *
 * Deterministic — same brief in, same markdown out. Front-matter
 * (date / topic / task_id / claim_count / confidence distribution),
 * then optional 5-line spec-conformance diff (engineering-shape
 * topics), then `## Key findings` (bullet projection over claims),
 * then `## Sources` (citation list dedup'd), then `## Recommendations`.
 */

import type { ResearchBrief } from './backend.ts'
import { isEngineeringShapeQuery } from './sub-agent-prompt.ts'

export interface RenderOptions {
  task_id: string
  project_id: string
  /** Override clock — `new Date()` by default. */
  written_at?: Date
}

export function renderBriefMarkdown(
  brief: ResearchBrief,
  opts: RenderOptions,
): string {
  const written = opts.written_at ?? new Date()
  const claims = brief.claims ?? []
  const confidenceDist = {
    low: claims.filter((c) => c.confidence === 'low').length,
    medium: claims.filter((c) => c.confidence === 'medium').length,
    high: claims.filter((c) => c.confidence === 'high').length,
    unverified: claims.filter((c) => c.confidence === 'unverified').length,
  }

  const lines: string[] = []
  // YAML front-matter
  lines.push('---')
  lines.push(`title: ${yamlString(brief.topic)}`)
  lines.push(`date: ${written.toISOString().slice(0, 10)}`)
  lines.push(`task_id: ${opts.task_id}`)
  lines.push(`project_id: ${yamlString(opts.project_id)}`)
  lines.push(`confidence_level: ${brief.confidence_level}`)
  lines.push(`claim_count: ${claims.length}`)
  lines.push(`confidence_distribution:`)
  lines.push(`  low: ${confidenceDist.low}`)
  lines.push(`  medium: ${confidenceDist.medium}`)
  lines.push(`  high: ${confidenceDist.high}`)
  lines.push(`  unverified: ${confidenceDist.unverified}`)
  lines.push('---')
  lines.push('')

  // Engineering-shape topics get the 5-line spec-conformance-diff
  // template seeded. Pure heuristic — the brief author may overwrite.
  if (isEngineeringShapeQuery(brief.topic)) {
    lines.push('## 5-line spec-conformance diff')
    lines.push('')
    lines.push('```')
    lines.push('SPEC: <one line>')
    lines.push('CURRENT: <one line>')
    lines.push('GAP: <one line>')
    lines.push('THIS BRIEF RECOMMENDS: <one line>')
    lines.push('OUT OF SCOPE: <one line>')
    lines.push('```')
    lines.push('')
  }

  lines.push('## Key findings')
  lines.push('')
  if (claims.length > 0) {
    for (const c of claims) {
      const tag = c.confidence === 'unverified' ? ' _(unverified)_' : ''
      lines.push(`- ${c.claim}${tag}`)
    }
  } else if (brief.key_findings.length > 0) {
    for (const f of brief.key_findings) {
      lines.push(`- ${f}`)
    }
  } else {
    lines.push('- _(no findings recorded)_')
  }
  lines.push('')

  lines.push('## Sources')
  lines.push('')
  const citations = dedupCitations(brief, claims)
  if (citations.length === 0) {
    lines.push('- _(no citations)_')
  } else {
    for (const cite of citations) {
      lines.push(`- ${cite}`)
    }
  }
  lines.push('')

  if (brief.recommendations.length > 0) {
    lines.push('## Recommendations')
    lines.push('')
    for (const r of brief.recommendations) {
      lines.push(`- ${r}`)
    }
    lines.push('')
  }

  // Detail section — every claim with its evidence + citation, for
  // the user who wants the receipts.
  if (claims.length > 0) {
    lines.push('## Claims (full)')
    lines.push('')
    for (const c of claims) {
      lines.push(`### ${c.claim}`)
      lines.push('')
      lines.push(`- confidence: \`${c.confidence}\``)
      if (c.evidence !== undefined) {
        lines.push(`- evidence: ${c.evidence}`)
      }
      if (c.citation !== undefined) {
        lines.push(`- citation: ${c.citation}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

function yamlString(s: string): string {
  // Quote when the value contains anything that could be misinterpreted
  // as YAML structure. Keep simple alphanumeric/space topics unquoted.
  if (/^[A-Za-z0-9 _.,/-]+$/.test(s) && !/^[\d-]/.test(s)) return s
  return JSON.stringify(s)
}

function dedupCitations(
  brief: ResearchBrief,
  claims: ResearchBrief['claims'] extends ReadonlyArray<infer T> | undefined ? readonly T[] : never[],
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  // Pull from claims first (the authoritative source post-S1).
  for (const c of claims ?? []) {
    if (c.citation !== undefined && c.citation.trim().length > 0) {
      if (!seen.has(c.citation)) {
        seen.add(c.citation)
        out.push(c.citation)
      }
    }
  }
  // Then from the legacy sources[] block (titles + URLs).
  for (const s of brief.sources) {
    const display =
      s.url !== undefined ? `[${s.title}](${s.url})` : s.title
    if (!seen.has(display)) {
      seen.add(display)
      out.push(display)
    }
  }
  return out
}
