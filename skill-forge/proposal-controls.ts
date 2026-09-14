/** Opaque, owner-only controls for a persisted Skill Forge proposal. */

import type { ButtonOption } from '@neutronai/channels/button-primitive.ts'
import type { SkillForgeBackend } from './backend.ts'

const VALUE_PREFIX = 'sfp:'
const VALUE_RE = /^sfp:[A-Za-z0-9_-]{22}:[aed]$/

export interface SkillForgeOwnerAnswerInput {
  user_id: string
  user_text: string
  prior_option_values: readonly string[]
}

export function buildSkillForgeProposalOptions(proposal_id: string): ButtonOption[] {
  const token = uuidToToken(proposal_id)
  return [
    { label: 'Approve', body: 'Save this proposed skill', value: `${VALUE_PREFIX}${token}:a` },
    { label: 'Edit', body: 'Edit before saving', value: `${VALUE_PREFIX}${token}:e` },
    { label: 'Decline', body: 'Decline this proposed skill', value: `${VALUE_PREFIX}${token}:d` },
  ]
}

export function buildSkillForgeProposalCapture(input: {
  backend: SkillForgeBackend
  owner_user_id: string
}): (answer: SkillForgeOwnerAnswerInput) => Promise<{ body: string } | null> {
  return async (answer) => {
    const value = answer.user_text.trim()
    if (!VALUE_RE.test(value)) return null
    if (!answer.prior_option_values.includes(value)) return null
    if (answer.user_id !== input.owner_user_id) {
      return { body: 'Only the owner can decide Skill Forge proposals.' }
    }

    const id = tokenToUuid(value.slice(VALUE_PREFIX.length, VALUE_PREFIX.length + 22))
    if (id === null) return { body: 'That Skill Forge proposal control is invalid. Nothing changed.' }

    if (value.endsWith(':e')) {
      return {
        body:
          `Proposal \`${id}\` is still pending. Edit its name while approving with ` +
          `\`/skills approve ${id} <new-name>\`, or use its Approve or Decline control.`,
      }
    }

    try {
      if (value.endsWith(':a')) {
        const result = await input.backend.approve(id)
        return {
          body: `🛠 Approved proposal \`${id}\` → saved skill *${result.proposal.proposed_name}*. It's now agent-discoverable on every turn.`,
        }
      }
      await input.backend.decline(id)
      return { body: `🛠 Declined proposal \`${id}\`. Nothing was saved.` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { body: `🛠 Proposal \`${id}\` was already answered or could not be decided: ${message}` }
    }
  }
}

function uuidToToken(id: string): string {
  const hex = id.replaceAll('-', '')
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`skill-forge proposal id is not a UUID: ${id}`)
  return Buffer.from(hex, 'hex').toString('base64url')
}

function tokenToUuid(token: string): string | null {
  try {
    const bytes = Buffer.from(token, 'base64url')
    if (bytes.length !== 16 || bytes.toString('base64url') !== token) return null
    const hex = bytes.toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  } catch {
    return null
  }
}
