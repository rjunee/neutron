/**
 * @neutronai/skill-forge — proposal message.
 *
 * Renders the user-facing PROPOSAL: the message Skill Forge surfaces when it
 * detects a skill-worthy workflow. It states the four things the acceptance
 * criteria require — name, triggers, what it does, artifacts — and the
 * approve/decline affordance. Pure (id + record in → string out) so the
 * channel layer just delivers it.
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
    `Reply *approve* to register it (you can edit the name/triggers first), or *decline* to skip. Nothing is saved until you approve. (proposal \`${proposal.id}\`)`,
  )
  return lines.join('\n')
}
