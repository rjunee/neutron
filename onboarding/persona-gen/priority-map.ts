/**
 * @neutronai/onboarding — priority-map.md generator (P2 S2).
 *
 * Per docs/plans/P2-onboarding.md § 2.6. The priority-map.md captures
 * "which programs matter, ranked." Mirrors the shape of
 * internal design notes — programs by importance, urgency level
 * legend, auto-resolve vs escalation rules.
 */

/**
 * P2 v2 § 7.1 — priority-map.md input extended for v2 collected_data.
 *
 * The Programs section is sourced from `primary_projects` (≥3 per the
 * required-fields audit). Each project is rendered as a top-level
 * bullet; when `work_themes[]` are present they're rendered as a
 * companion sub-bullet block per § 7.3 sample output. The v1
 * `programs` array is preserved as a legacy alternative — when
 * `primary_projects` is empty the generator falls back to the
 * structured `programs` rows.
 */
export interface PriorityMapInput {
  /** v1 — ranked programs from interview's rituals + work-pattern phases (legacy). */
  programs?: ReadonlyArray<{ name: string; tier: 'P0' | 'P1' | 'P2' | 'P3'; rationale: string }>
  /** P2 v2 — primary projects (≥3 per audit). Renders the Programs section. */
  primary_projects?: ReadonlyArray<string>
  /** P2 v2 — optional work themes; rendered as a companion sub-bullet block. */
  work_themes?: ReadonlyArray<string>
  /** Tier-1 people from the inner-circle capture. v2: accepts plain strings OR `{name, relation}`. */
  tier_1_people?: ReadonlyArray<string | { name: string; relation?: string }>
  /** Auto-resolve lanes (default sensible set). */
  auto_lanes?: ReadonlyArray<string>
  /** Escalation lanes (default sensible set). */
  escalation_lanes?: ReadonlyArray<string>
}

const DEFAULT_AUTO_LANES: ReadonlyArray<string> = [
  'Calendar scheduling within the user\'s defaults',
  'Routine follow-ups under 7 days, non-sensitive',
  'Vault backup, health checks, index refresh',
]

const DEFAULT_ESCALATION_LANES: ReadonlyArray<string> = [
  'Anything involving money over $100',
  'External commitments (meetings, deadlines)',
  'Publishing (blog, social, email campaigns)',
  'Any communication sent on the user\'s behalf',
]

export function generatePriorityMapMd(input: PriorityMapInput): string {
  const lines: string[] = []
  lines.push(`# priority-map.md`)
  lines.push('')
  lines.push(`Ranked programs and people. The agent uses this to choose what to surface and what to defer.`)
  lines.push('')
  lines.push(`## Programs`)
  lines.push('')
  const primary = (input.primary_projects ?? []).filter(
    (p) => typeof p === 'string' && p.trim().length > 0,
  )
  if (primary.length > 0) {
    for (let i = 0; i < primary.length; i++) {
      lines.push(`${i + 1}. ${primary[i]}`)
    }
    const themes = (input.work_themes ?? []).filter(
      (t) => typeof t === 'string' && t.trim().length > 0,
    )
    if (themes.length > 0) {
      lines.push('')
      lines.push(`### Work themes`)
      lines.push('')
      for (const theme of themes) {
        lines.push(`- ${theme}`)
      }
    }
  } else if (input.programs !== undefined) {
    for (let i = 0; i < input.programs.length; i++) {
      const p = input.programs[i]
      if (p === undefined) continue
      lines.push(`${i + 1}. **${p.name}** (${p.tier}) ${p.rationale}`)
    }
  }
  lines.push('')
  lines.push(`## Urgency Levels`)
  lines.push('')
  lines.push(`- P0: Drop everything (legal, health, security)`)
  lines.push(`- P1: Today (revenue or time-sensitive)`)
  lines.push(`- P2: This week (important but not urgent)`)
  lines.push(`- P3: Backlog (do when opportune)`)
  lines.push('')
  if (input.tier_1_people !== undefined && input.tier_1_people.length > 0) {
    lines.push(`## People Priority`)
    lines.push('')
    for (const p of input.tier_1_people) {
      lines.push(renderPersonEntry(p))
    }
    lines.push('')
  }
  lines.push(`## Auto-Resolve Lanes`)
  lines.push('')
  for (const lane of input.auto_lanes ?? DEFAULT_AUTO_LANES) {
    lines.push(`- ${lane}`)
  }
  lines.push('')
  lines.push(`## Escalation Lanes`)
  lines.push('')
  for (const lane of input.escalation_lanes ?? DEFAULT_ESCALATION_LANES) {
    lines.push(`- ${lane}`)
  }
  lines.push('')
  return lines.join('\n')
}

function renderPersonEntry(p: string | { name: string; relation?: string }): string {
  if (typeof p === 'string') return `- ${p}`
  const relation =
    typeof p.relation === 'string' && p.relation.length > 0 ? ` (${p.relation})` : ''
  return `- **${p.name}**${relation}`
}
