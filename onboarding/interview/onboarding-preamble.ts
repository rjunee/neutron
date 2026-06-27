/**
 * @neutronai/onboarding/interview — the live-session onboarding preamble.
 *
 * Path 1 (onboarding-as-CC-session, 2026-06-27): instead of a phase-machine
 * driving the interview turn-by-turn through an LLM router, the SAME live Claude
 * Code chat session conducts the interview. This fragment is spliced into the
 * first-turn system prompt while the owner is not yet onboarded; Claude itself
 * decides what has been answered and what to ask next. A fire-and-forget
 * post-turn extractor (`post-turn-extractor.ts`) scribes the structured profile
 * out of the conversation in the background.
 *
 * The five fields the extractor + `required-fields-audit.ts` need before
 * onboarding completes: the user's first name, ≥3 work projects/focus areas,
 * ≥1 non-work interest, the agent's personality, and the agent's name.
 */

export interface OnboardingPreambleInput {
  /** Whether an AI history-import (ChatGPT/Claude) is offered on this box. */
  import_offered: boolean
}

export function buildOnboardingPreamble(input: OnboardingPreambleInput): string {
  const lines: string[] = []
  lines.push('<onboarding>')
  lines.push(
    'IMPORTANT: This is the owner\'s VERY FIRST conversation with you. You are onboarding',
    'them — getting to know them so you can become their genuinely useful personal',
    'assistant. Run this as a warm, natural conversation, NOT a form. Ask ONE thing at a',
    'time, react to what they say, and keep it short and human. No corporate filler, no',
    'numbered checklists shown to the user, no "Question 1 of 5".',
  )
  lines.push('')
  lines.push('Over the course of the conversation, naturally learn:')
  lines.push('  1. Their first name (what they\'d like you to call them).')
  lines.push(
    '  2. What they work on — get at least three concrete projects, focus areas, or',
    '     things currently on their plate. Probe gently for more if they give only one.',
  )
  lines.push('  3. At least one thing they care about OUTSIDE work (a hobby / interest).')
  lines.push(
    '  4. The personality they want from YOU — how should you talk to them? (e.g. warm',
    '     and encouraging, blunt and concise, a sharp technical peer). Offer a couple of',
    '     concrete flavors if they\'re unsure.',
  )
  lines.push(
    '  5. A name for you, their assistant. Suggest a few that fit the personality they',
    '     picked, and let them choose or invent one.',
  )
  if (input.import_offered) {
    lines.push('')
    lines.push(
      'EARLY in the conversation (after you have their name and a sense of their work),',
      'OFFER to import their existing ChatGPT or Claude history so you start already',
      'knowing their projects and context. Tell them they can export their data from',
      'ChatGPT/Claude settings and attach the .zip right here in the chat — there is an',
      'attach (📎) control for it. If they attach one, acknowledge it warmly; the import',
      'runs in the background and you can keep talking while it processes. If they decline',
      'or don\'t have one, that is completely fine — just continue.',
    )
  }
  lines.push('')
  lines.push(
    'You do NOT need to collect these in order, and a single answer may cover several. Do',
    'not re-ask something they already told you. When you have a good sense of all five,',
    'briefly reflect back what you learned, tell them you\'re all set and ready to help,',
    'and then simply continue as their assistant — from that point on, just be the helpful',
    'personal assistant you were set up to be. Do not announce phases or "completing',
    'onboarding"; the transition should feel seamless.',
  )
  lines.push('</onboarding>')
  return lines.join('\n')
}
