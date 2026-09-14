/**
 * @neutronai/skill-forge — proposal message.
 *
 * Renders the user-facing PROPOSAL: the message Skill Forge surfaces when it
 * detects a skill-worthy workflow. It states the four things the acceptance
 * criteria require — name, triggers, what it does, artifacts — and the
 * approve/decline affordance. Pure (id + record in → string out) so the
 * channel layer just delivers it.
 *
 * THE CLOSING LINE NAMES A REAL SURFACE. It used to read "Reply *approve* …",
 * which was harmless only while this message went nowhere but a log line. Now
 * that the composer delivers it into the owner's chat (`open/composer.ts`, the
 * skill-forge notifier), that instruction is live — and replying the bare word
 * "approve" does NOT approve anything: it is an ordinary chat message that
 * falls through to the LLM turn. The one surface that decides a proposal is the
 * `/skills` command filter (`./command.ts` — `approve|decline <id>`, shared with
 * the `skill_forge_*` MCP tools through one `SkillForgeBackend`), so the message
 * quotes that verbatim, in the SAME wording `/skills list` already uses
 * (`command.ts` list output). An offer whose acceptance instruction doesn't work
 * is worse than no offer.
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
