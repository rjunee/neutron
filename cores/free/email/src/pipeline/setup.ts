/**
 * Classification setup for a newly installed Email Core.
 *
 * The Core owns the mechanism, never the classes: this pass reads a bounded
 * inbox sample and turns the sender domains and observable message shapes into
 * questions. Only the owner's answers become rules in the instance sidecar.
 */

import type { GmailClient, GmailMessageMeta } from '../contract.ts'
import { ClassificationSetupError } from '../errors.ts'
import { addressDomain, bareAddress, PROMOTIONS_LABEL } from './classify.ts'
import type { EmailPipelineStore, SenderRule, SenderRuleHandling } from './store.ts'

export const CLASSIFICATION_SURVEY_LIMIT = 100

export type ClassificationSetupAction = 'brief' | 'escalate' | 'ignore'

export interface ClassificationProposal {
  id: string
  category: string
  shape: string
  senders: string[]
  message_count: number
  question: string
}

export interface ClassificationSetupAnswer {
  proposal_id: string
  action: ClassificationSetupAction
  /** Optional owner wording; the observed class remains the fallback. */
  category?: string
}

export interface ClassificationSurvey {
  sampled_messages: number
  proposals: ClassificationProposal[]
}

function messageShape(message: GmailMessageMeta): string {
  const text = `${message.subject}\n${message.snippet}`.toLowerCase()
  const sender = bareAddress(message.from)
  if (message.label_ids.includes(PROMOTIONS_LABEL) || text.includes('unsubscribe')) return 'bulk-mail'
  if (/\b(receipt|invoice|order|payment|purchase)\b/.test(text)) return 'transaction'
  if (/\b(alert|notification|update|report|digest)\b/.test(text) || /(^|[._-])no-?reply@/.test(sender)) {
    return 'notification'
  }
  return 'conversation'
}

function className(domain: string, shape: string): string {
  const domainLabel = domain
    .split('.')[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `${domainLabel || 'unknown'}-${shape}`
}

/** Read one bounded inbox window and derive every proposed class from it. */
export async function surveyClassificationSetup(
  gmail: Pick<GmailClient, 'listMessages'>,
  sample_limit = CLASSIFICATION_SURVEY_LIMIT,
): Promise<ClassificationSurvey> {
  if (!Number.isInteger(sample_limit) || sample_limit < 1 || sample_limit > CLASSIFICATION_SURVEY_LIMIT) {
    throw new ClassificationSetupError(
      'classification_survey_invalid',
      `classification survey limit must be an integer from 1 to ${CLASSIFICATION_SURVEY_LIMIT}`,
    )
  }
  const page = await gmail.listMessages({ label: 'INBOX', max_results: sample_limit })
  if (page.truncated === true || page.accounts?.some((account) => !account.ok)) {
    throw new ClassificationSetupError(
      'classification_survey_incomplete',
      'classification survey could not read a complete sample',
    )
  }

  const groups = new Map<string, { domain: string; shape: string; senders: Set<string>; count: number }>()
  for (const message of page.results) {
    const sender = bareAddress(message.from)
    const domain = addressDomain(sender)
    const shape = messageShape(message)
    const key = `${domain}\u0000${shape}`
    const group = groups.get(key) ?? { domain, shape, senders: new Set<string>(), count: 0 }
    group.senders.add(sender)
    group.count += 1
    groups.set(key, group)
  }

  const proposals = [...groups.values()]
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.shape.localeCompare(b.shape))
    .map((group) => {
      const senders = [...group.senders].sort()
      const category = className(group.domain, group.shape)
      const id = `${group.domain}:${group.shape}`
      return {
        id,
        category,
        shape: group.shape,
        senders,
        message_count: group.count,
        question: `Mail from ${senders.join(', ')} looks like ${group.shape}. Brief it, escalate it, or ignore it?`,
      }
    })

  return { sampled_messages: page.results.length, proposals }
}

/** Persist one complete interview. Validation happens before the first write. */
export function applyClassificationSetup(
  store: EmailPipelineStore,
  survey: ClassificationSurvey,
  answers: readonly ClassificationSetupAnswer[],
): SenderRule[] {
  const proposals = new Map(survey.proposals.map((proposal) => [proposal.id, proposal]))
  const byProposal = new Map<string, ClassificationSetupAnswer>()
  for (const answer of answers) {
    if (!proposals.has(answer.proposal_id)) {
      throw new ClassificationSetupError(
        'classification_answer_unknown',
        `unknown classification proposal: ${answer.proposal_id}`,
      )
    }
    if (byProposal.has(answer.proposal_id)) {
      throw new ClassificationSetupError(
        'classification_answer_duplicate',
        `duplicate classification answer: ${answer.proposal_id}`,
      )
    }
    byProposal.set(answer.proposal_id, answer)
  }
  if (byProposal.size !== proposals.size) {
    throw new ClassificationSetupError(
      'classification_answers_incomplete',
      'classification setup requires an answer for every proposal',
    )
  }

  const planned = survey.proposals.flatMap((proposal) => {
    const answer = byProposal.get(proposal.id) as ClassificationSetupAnswer
    const category = answer.category?.trim() || proposal.category
    const handling: SenderRuleHandling = answer.action === 'escalate' ? 'escalate' : 'archive'
    return proposal.senders.map((pattern) => ({
      pattern,
      kind: 'sender' as const,
      category,
      handling,
      protected: answer.action === 'escalate',
    }))
  })

  return store.db.transaction(() => planned.map((rule) => store.addSenderRule(rule)))()
}
