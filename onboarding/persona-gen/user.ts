/**
 * @neutronai/onboarding — USER.md generator (P2 S2).
 *
 * Per docs/plans/P2-onboarding.md § 2.6. Composes the user's USER.md
 * from interview-captured facts + optional Pass-2 import-derived facts.
 *
 * USER.md is the @-import that gives every session the lookup of "who
 * is this person, what do they care about." Mirrors the shape of
 * internal design notes — name, role, key relationships, preferences.
 */

/**
 * P2 v2 § 7.1 — UserFacts shape extended for v2 collected_data.
 *
 * Additions: `companies` (free-text array, one bullet per entry),
 * `primary_projects` (≥3 entries per audit), `non_work_interests` (≥1
 * required), and a v2 `inner_circle` shape that accepts plain strings
 * (the gap-fill driver writes strings; the v1 structured `{ name,
 * relation }` shape is still accepted for backwards compat).
 */
export type InnerCircleEntry = string | { name: string; relation?: string }

export interface UserFacts {
  display_name: string
  preferred_call_name?: string
  timezone?: string
  email?: string
  role?: string
  companies?: ReadonlyArray<string>
  primary_projects?: ReadonlyArray<string>
  non_work_interests?: ReadonlyArray<string>
  inner_circle?: ReadonlyArray<InnerCircleEntry>
  preferences?: ReadonlyArray<{ key: string; value: string }>
}

export function generateUserMd(facts: UserFacts): string {
  const lines: string[] = []
  lines.push(`# USER.md`)
  lines.push('')
  lines.push(composePreamble(facts))
  lines.push('')
  lines.push(`## Identity`)
  lines.push('')
  lines.push(`- **Name:** ${facts.display_name}`)
  if (facts.preferred_call_name !== undefined && facts.preferred_call_name.length > 0) {
    lines.push(`- **Call them:** ${facts.preferred_call_name}`)
  }
  if (facts.timezone !== undefined && facts.timezone.length > 0) {
    lines.push(`- **Timezone:** ${facts.timezone}`)
  }
  if (facts.email !== undefined && facts.email.length > 0) {
    lines.push(`- **Email:** ${facts.email}`)
  }
  if (facts.role !== undefined && facts.role.length > 0) {
    lines.push(`- **Role:** ${facts.role}`)
  }
  if (facts.companies !== undefined && facts.companies.length > 0) {
    lines.push('')
    lines.push(`## Companies`)
    lines.push('')
    for (const c of facts.companies) {
      lines.push(`- ${c}`)
    }
  }
  if (facts.primary_projects !== undefined && facts.primary_projects.length > 0) {
    lines.push('')
    lines.push(`## Key Projects`)
    lines.push('')
    for (const p of facts.primary_projects) {
      lines.push(`- ${p}`)
    }
  }
  if (facts.inner_circle !== undefined && facts.inner_circle.length > 0) {
    lines.push('')
    lines.push(`## Inner Circle`)
    lines.push('')
    for (const p of facts.inner_circle) {
      lines.push(renderInnerCircleEntry(p))
    }
  }
  if (facts.non_work_interests !== undefined && facts.non_work_interests.length > 0) {
    lines.push('')
    lines.push(`## Outside Interests`)
    lines.push('')
    for (const i of facts.non_work_interests) {
      lines.push(`- ${i}`)
    }
  }
  if (facts.preferences !== undefined && facts.preferences.length > 0) {
    lines.push('')
    lines.push(`## Preferences`)
    lines.push('')
    for (const pref of facts.preferences) {
      lines.push(`- **${pref.key}:** ${pref.value}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function renderInnerCircleEntry(entry: InnerCircleEntry): string {
  if (typeof entry === 'string') return `- ${entry}`
  const relation =
    typeof entry.relation === 'string' && entry.relation.length > 0
      ? ` (${entry.relation})`
      : ''
  return `- **${entry.name}**${relation}`
}

/**
 * P2 v2 § 7.3 — the preamble sentence is what makes USER.md feel like
 * "captures a real person" instead of a generic template. Render a
 * concise 1-sentence anchor that names the person plus their most-
 * salient context (first company OR first project). Falls back to a
 * neutral sentence when no context is captured.
 */
function composePreamble(facts: UserFacts): string {
  const name = facts.display_name.trim()
  const company = (facts.companies ?? []).find(
    (c) => typeof c === 'string' && c.trim().length > 0,
  )
  const project = (facts.primary_projects ?? []).find(
    (p) => typeof p === 'string' && p.trim().length > 0,
  )
  if (company !== undefined) {
    return `${name} works on ${company.trim()}. Facts below stay stable; update as life changes.`
  }
  if (project !== undefined) {
    return `${name} is currently focused on ${project.trim()}. Facts below stay stable; update as life changes.`
  }
  return `Facts about ${name}. Stable. Update as life changes.`
}
