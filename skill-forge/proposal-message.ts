/**
 * @neutronai/skill-forge — proposal message.
 *
 * Renders the user-facing PROPOSAL: the message Skill Forge surfaces when it
 * detects a skill-worthy workflow. It states the four things the acceptance
 * criteria require — name, triggers, what it does, artifacts — and the
 * approve/decline affordance. Pure (id + record in → string out) so the
 * channel layer just delivers it.
 *
 * The project conversation decides whether to offer the persisted proposal.
 * The closing line names the actual approve/decline command surface; a bare
 * "approve" reply is an ordinary conversation turn, not a proposal decision.
 */

import type { ProposalRecord } from './types.ts'

export function composeProposalMessage(proposal: ProposalRecord): string {
  const lines: string[] = []
  lines.push('💡 *Skill Forge* — I can save this workflow as a re-usable skill.')
  lines.push('')
  lines.push(`*Name:* \`${proposal.proposed_name}\``)
  lines.push('')
  lines.push('*Triggers* (what would re-invoke it):')
  for (const t of proposal.triggers) lines.push(`• "${t}"`)
  lines.push('')
  lines.push('*What it does:*')
  lines.push(proposal.what_it_does)
  if (proposal.artifacts.length > 0) {
    lines.push('')
    lines.push('*Artifacts it touches:*')
    for (const a of proposal.artifacts) lines.push(`• ${a}`)
  }
  lines.push('')
  lines.push(
    `Approve with \`/skills approve ${proposal.id}\` (append a name to rename it) or decline with \`/skills decline ${proposal.id}\`. Nothing is written until you approve.`,
  )
  return lines.join('\n')
}
