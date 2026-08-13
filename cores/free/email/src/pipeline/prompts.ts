/**
 * @neutronai/email-managed-core — pipeline prompt templates.
 *
 * The DEFAULT classification prompt: deliberately GENERIC. There is no owner
 * taxonomy, no real sender, no real domain anywhere in this file — the
 * per-owner category set is instance data learned at runtime (P2.5's inbox
 * survey + owner interview writes it), never shipped in the tree.
 *
 * The template asks for strict JSON so `classify.ts` can parse a verdict from
 * a one-shot substrate call without a tool surface. Parsing is defensive on
 * the other side: an unparseable answer degrades to the deterministic default,
 * it never throws into a poll tick.
 */

/** The generic shipped category set. Owner-specific categories arrive as
 *  `sender_rules` rows at runtime and flow through unvalidated. */
export const DEFAULT_CATEGORIES = [
  'important',
  'newsletter',
  'notification',
  'receipt',
  'other',
] as const

export interface ClassifyPromptInput {
  sender: string
  subject: string
  snippet: string
  body_excerpt: string
}

/**
 * Build the one-shot classification prompt. The caller bounds
 * `body_excerpt` before it gets here.
 */
export function buildClassifyPrompt(input: ClassifyPromptInput): string {
  return [
    'You are classifying one email message for a personal assistant.',
    '',
    `From: ${input.sender}`,
    `Subject: ${input.subject}`,
    `Snippet: ${input.snippet}`,
    'Body excerpt:',
    input.body_excerpt,
    '',
    `Choose exactly one category from: ${DEFAULT_CATEGORIES.join(' | ')}.`,
    'Mark `important` true ONLY when the message needs the recipient to act or',
    'to know promptly — an authentication code, a billing problem, a deadline,',
    'or a direct message from a person expecting a reply. Bulk mail, marketing',
    'and automated notifications are never important.',
    '',
    'Answer with STRICT JSON and nothing else:',
    '{"category": "<one of the categories>", "important": true|false, "reason": "<short phrase>"}',
  ].join('\n')
}
