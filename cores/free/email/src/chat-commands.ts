/**
 * @neutronai/email-managed-core — `/email ...` chat-command parser +
 * dispatcher.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.2.
 *
 * Commands:
 *   /email triage                          — daily-top-5 with one-line reasons
 *   /email summarize <thread_or_msg_id>    — 2-3 sentence prose brief
 *   /email search <query>                  — Gmail-style search, top 10
 *   /email draft <to> <subject> <body>     — 4-point-enforced draft creation
 *   /email help | (bare /email)            — cheatsheet
 */

import { applyDraftVisibilityLabels } from './draft-policy.ts'
import type { EmailProjectCache } from './cache.ts'
import type { GmailClient } from './backend.ts'
import {
  composeBriefSummary,
  briefTemplateHash,
} from './summarizer.ts'
import { composeTriage } from './triage.ts'
import { buildStubEmailSummarizer, type EmailSummarizer } from './backend.ts'

export type EmailCommand =
  | { kind: 'triage' }
  | { kind: 'summarize'; id: string }
  | { kind: 'search'; query: string }
  | { kind: 'draft'; to: string; subject: string; body: string }
  | { kind: 'help' }
  | { kind: 'unrecognized'; reason: string }

/**
 * Pure parser. Splits the body after `/email`; the first whitespace-
 * separated token (lowercased) is the verb. Bare `/email` returns
 * help.
 *
 * `/email draft` parses positionally — first token is `to`, second
 * is `subject`, remainder is `body`. Multi-word subjects can be
 * quoted with `"..."`.
 */
export function parseEmailCommand(raw: string): EmailCommand {
  const trimmed = raw.trimStart()
  const lower = trimmed.toLowerCase()
  if (!lower.startsWith('/email')) {
    return { kind: 'unrecognized', reason: 'not an /email command' }
  }
  const afterVerb = trimmed.slice('/email'.length)
  if (afterVerb.length === 0) return { kind: 'help' }
  if (!/^\s/.test(afterVerb)) {
    return { kind: 'unrecognized', reason: 'missing space after /email' }
  }
  const rest = afterVerb.trim()
  if (rest.length === 0) return { kind: 'help' }
  if (rest === 'help' || rest.toLowerCase() === 'help') return { kind: 'help' }

  const firstSpace = rest.indexOf(' ')
  const head = (firstSpace === -1 ? rest : rest.slice(0, firstSpace)).toLowerCase()
  const tail = firstSpace === -1 ? '' : rest.slice(firstSpace + 1).trim()

  if (head === 'triage') {
    return { kind: 'triage' }
  }
  if (head === 'summarize') {
    if (tail.length === 0) {
      return { kind: 'unrecognized', reason: 'usage: /email summarize <thread_id_or_message_id>' }
    }
    // The first token is the id; ignore trailing args.
    const id = tail.split(/\s+/, 1)[0] ?? ''
    if (id.length === 0) {
      return { kind: 'unrecognized', reason: 'usage: /email summarize <thread_id_or_message_id>' }
    }
    return { kind: 'summarize', id }
  }
  if (head === 'search') {
    if (tail.length === 0) {
      return { kind: 'unrecognized', reason: 'usage: /email search <query>' }
    }
    return { kind: 'search', query: tail }
  }
  if (head === 'draft') {
    return parseDraft(tail)
  }
  return { kind: 'unrecognized', reason: `unknown subcommand: ${head}` }
}

function parseDraft(tail: string): EmailCommand {
  if (tail.length === 0) {
    return {
      kind: 'unrecognized',
      reason: 'usage: /email draft <to> <subject> <body>',
    }
  }
  // Pull off the first token (the `to` address).
  const firstSpace = tail.indexOf(' ')
  if (firstSpace === -1) {
    return {
      kind: 'unrecognized',
      reason: 'usage: /email draft <to> <subject> <body>',
    }
  }
  const to = tail.slice(0, firstSpace).trim()
  const after = tail.slice(firstSpace + 1).trimStart()
  if (after.length === 0) {
    return {
      kind: 'unrecognized',
      reason: 'usage: /email draft <to> <subject> <body>',
    }
  }
  let subject: string
  let body: string
  if (after.startsWith('"')) {
    // Quoted subject — consume through the matching closing quote.
    const closing = after.indexOf('"', 1)
    if (closing === -1) {
      return {
        kind: 'unrecognized',
        reason: 'usage: /email draft <to> <"quoted subject"> <body>',
      }
    }
    subject = after.slice(1, closing)
    body = after.slice(closing + 1).trimStart()
  } else {
    const sp = after.indexOf(' ')
    if (sp === -1) {
      return {
        kind: 'unrecognized',
        reason: 'usage: /email draft <to> <subject> <body>',
      }
    }
    subject = after.slice(0, sp)
    body = after.slice(sp + 1).trimStart()
  }
  if (to.length === 0 || subject.length === 0 || body.length === 0) {
    return {
      kind: 'unrecognized',
      reason: 'usage: /email draft <to> <subject> <body>',
    }
  }
  return { kind: 'draft', to, subject, body }
}

export interface EmailCommandResponse {
  text: string
  data?: unknown
  deep_link?: string
  error?: {
    code:
      | 'malformed'
      | 'unknown_id'
      | 'oauth_missing'
      | 'capability_denied'
      | 'draft_labeling_failed'
      | 'gmail_api_error'
    message: string
    draft_id?: string
  }
}

export interface EmailCommandContext {
  client: GmailClient
  cache: EmailProjectCache
  project_id: string | null
  user_id: string
  user_tz: string
  now: Date
  /** Pluggable LLM call for triage + summarizer agents. */
  llm: (prompt: string) => Promise<string>
  /** Resolved Haiku-fast model id. */
  model: string
  /** Structured-row summarizer; tests pass a deterministic stub. */
  summarizer?: EmailSummarizer
}

export async function executeEmailCommand(
  cmd: EmailCommand,
  ctx: EmailCommandContext,
): Promise<EmailCommandResponse> {
  try {
    switch (cmd.kind) {
      case 'help':
        return helpResponse()
      case 'unrecognized':
        return {
          text: `Email command not understood: ${cmd.reason}`,
          error: { code: 'malformed', message: cmd.reason },
        }
      case 'triage':
        return await runTriage(ctx)
      case 'summarize':
        return await runSummarize(cmd.id, ctx)
      case 'search':
        return await runSearch(cmd.query, ctx)
      case 'draft':
        return await runDraft(cmd, ctx)
    }
  } catch (err) {
    return classifyError(err)
  }
}

function helpResponse(): EmailCommandResponse {
  return {
    text:
      'Email Core commands: ' +
      '`/email triage` daily-top-5 · ' +
      '`/email summarize <thread_or_msg>` brief · ' +
      '`/email search <query>` Gmail-style · ' +
      '`/email draft <to> <subject> <body>` (drafts.create + INBOX+IMPORTANT+UNREAD).',
  }
}

function classifyError(err: unknown): EmailCommandResponse {
  if (err === null || err === undefined) {
    return {
      text: 'Email Core: unknown error.',
      error: { code: 'gmail_api_error', message: 'unknown error' },
    }
  }
  if (typeof err !== 'object') {
    return {
      text: `Email Core: ${String(err)}`,
      error: { code: 'gmail_api_error', message: String(err) },
    }
  }
  const e = err as { code?: string; message?: string; draft_id?: string; name?: string }
  const code = e.code
  if (code === 'draft_labeling_failed') {
    const out: EmailCommandResponse = {
      text: `Email Core: draft created but label step failed — ${e.message ?? 'unknown'}`,
      error: {
        code: 'draft_labeling_failed',
        message: e.message ?? 'draft_labeling_failed',
      },
    }
    if (typeof e.draft_id === 'string') {
      out.error!.draft_id = e.draft_id
    }
    return out
  }
  if (code === 'oauth_missing') {
    return {
      text: 'Email Core: Gmail OAuth token unavailable — reconnect via the Integrations admin tab.',
      error: { code: 'oauth_missing', message: 'oauth_missing' },
    }
  }
  if (code === 'message_not_found') {
    return {
      text: 'Email Core: message id not found.',
      error: { code: 'unknown_id', message: e.message ?? 'message_not_found' },
    }
  }
  if (code === 'capability_denied') {
    return {
      text: 'Email Core: capability denied.',
      error: { code: 'capability_denied', message: e.message ?? 'capability_denied' },
    }
  }
  const message = typeof e.message === 'string' ? e.message : String(err)
  return {
    text: `Email Core: ${message}`,
    error: { code: 'gmail_api_error', message },
  }
}

async function runTriage(ctx: EmailCommandContext): Promise<EmailCommandResponse> {
  const listInput: Parameters<GmailClient['listMessages']>[0] = {
    label: 'INBOX',
    max_results: 50,
  }
  if (ctx.project_id !== null) listInput.project_id = ctx.project_id
  const { results: inbox } = await ctx.client.listMessages(listInput)
  const triage = await composeTriage({
    inbox,
    userTz: ctx.user_tz,
    llm: ctx.llm,
    model: ctx.model,
  })
  ctx.cache.upsertTriage({
    fired_at: ctx.now.getTime(),
    model: triage.model,
    outcome: triage.outcome,
    prompt_hash: triage.prompt_hash,
    top5_json: JSON.stringify(triage.items),
  })
  if (triage.items.length === 0) {
    return { text: 'Email triage: inbox is empty.', data: { triage } }
  }
  const lines = triage.items.map(
    (it) => `${it.rank}. ${it.from} — ${it.subject}: ${it.reason}`,
  )
  return {
    text: `Top ${triage.items.length} for today:\n${lines.join('\n')}`,
    data: { triage },
  }
}

async function runSummarize(
  id: string,
  ctx: EmailCommandContext,
): Promise<EmailCommandResponse> {
  // v1 treats the id as a Gmail message_id. A thread-walk variant is
  // a follow-up sprint.
  const message = await ctx.client.getMessage({ message_id: id })
  const summarizer = ctx.summarizer ?? buildStubEmailSummarizer()
  const structuredRow = await summarizer.summarize({ message })
  // Cache check / write.
  const tmplHash = briefTemplateHash()
  const cached = ctx.cache.getSummary({
    message_id: id,
    template_hash: tmplHash,
  })
  if (cached !== null) {
    return {
      text: cached.brief_text,
      data: {
        summary: structuredRow,
        brief: {
          text: cached.brief_text,
          prompt_hash: cached.prompt_hash,
          model: cached.model,
          outcome: 'ok',
        },
      },
    }
  }
  const brief = await composeBriefSummary({
    structuredRow,
    rawMessage: message,
    llm: ctx.llm,
    model: ctx.model,
  })
  if (brief.outcome === 'ok') {
    ctx.cache.upsertSummary({
      message_id: id,
      template_hash: tmplHash,
      brief_text: brief.text,
      model: brief.model,
      prompt_hash: brief.prompt_hash,
    })
  }
  return {
    text: brief.text,
    data: { summary: structuredRow, brief },
  }
}

async function runSearch(
  query: string,
  ctx: EmailCommandContext,
): Promise<EmailCommandResponse> {
  const searchInput: Parameters<GmailClient['search']>[0] = {
    query,
    max_results: 10,
  }
  if (ctx.project_id !== null) searchInput.project_id = ctx.project_id
  const { results } = await ctx.client.search(searchInput)
  if (results.length === 0) {
    return { text: `No messages match "${query}".`, data: { results } }
  }
  const lines = results
    .slice(0, 5)
    .map((m) => `• ${m.from} — ${m.subject}`)
    .join('\n')
  return {
    text: `${results.length} match${results.length === 1 ? '' : 'es'} for "${query}":\n${lines}`,
    data: { results },
  }
}

async function runDraft(
  cmd: { to: string; subject: string; body: string },
  ctx: EmailCommandContext,
): Promise<EmailCommandResponse> {
  const draftInput: Parameters<GmailClient['createDraft']>[0] = {
    to: [cmd.to],
    subject: cmd.subject,
    body: cmd.body,
  }
  if (ctx.project_id !== null) draftInput.project_id = ctx.project_id
  let result: Awaited<ReturnType<GmailClient['createDraft']>>
  try {
    result = await applyDraftVisibilityLabels({ client: ctx.client, draft: draftInput })
  } catch (err) {
    // Record audit row capturing the partial completion BEFORE
    // bubbling up — ops needs to find the orphaned draft.
    if (
      err !== null &&
      typeof err === 'object' &&
      (err as { code?: string }).code === 'draft_labeling_failed'
    ) {
      const e = err as {
        draft_id: string
        thread_id: string
        message_id: string
        message?: string
      }
      ctx.cache.recordDraftAudit({
        draft_id: e.draft_id,
        thread_id: e.thread_id,
        message_id: e.message_id,
        project_id: ctx.project_id,
        applied_labels: [],
        outcome: 'labeling_failed',
        response_excerpt: cmd.body.slice(0, 240),
      })
    }
    throw err
  }
  ctx.cache.recordDraftAudit({
    draft_id: result.draft_id,
    thread_id: result.thread_id,
    message_id: result.message_id,
    project_id: ctx.project_id,
    applied_labels: result.applied_labels,
    outcome: 'ok',
    response_excerpt: cmd.body.slice(0, 240),
  })
  return {
    text: `Draft prepared (${result.draft_id}). Labels: ${result.applied_labels.join(', ')}.`,
    data: {
      draft_id: result.draft_id,
      thread_id: result.thread_id,
      message_id: result.message_id,
      applied_labels: result.applied_labels,
    },
    deep_link: 'https://mail.google.com/mail/u/0/#drafts',
  }
}
