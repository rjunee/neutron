/**
 * @neutronai/research-core — `/research ...` chat-command parser + dispatcher.
 *
 * Per docs/plans/research-core-tier1-brief.md § 3.2.
 *
 * Pure parser (`parseResearchCommand`) splits a raw chat-send body
 * into a typed command shape; the dispatcher
 * (`executeResearchCommand`) calls the matching ResearchProjectBackend
 * method and returns a chat-render-ready envelope.
 *
 * Commands:
 *   /research <topic>            — synchronous standard-depth brief
 *   /research deep <topic>       — kick off Haiku-4.5 sub-agent harness
 *   /research list               — list recent briefs for this project
 *   /research find <query>       — lex+vec hybrid search over prior briefs
 *   /research help | (bare)      — surface cheatsheet
 *
 * The parser is side-effect-free; the dispatcher does I/O.
 *
 * Inline buttons: per the brief's HARD CONSTRAINTS, when the dispatcher
 * emits inline buttons their `value` MUST start with `/research`. The
 * `card.buttons[]` shape mirrors Tasks Core's pattern. S1 ships them
 * declaratively in the response; the chat surface renders them.
 */

import { ResearchInputError, ResearchTaskNotFoundError } from './backend.ts'
import type { ResearchProjectBackend } from './research-orchestrator.ts'

export type ResearchCommand =
  | { kind: 'capture'; topic: string }
  | { kind: 'deep'; topic: string }
  | { kind: 'list' }
  | { kind: 'find'; query: string }
  | { kind: 'help' }
  | { kind: 'unrecognized'; reason: string }

/**
 * Pure parser. The first whitespace-separated token after `/research`
 * (lowercased) selects the subcommand. Bare `/research` returns help.
 */
export function parseResearchCommand(raw: string): ResearchCommand {
  const trimmed = raw.trimStart()
  if (!trimmed.toLowerCase().startsWith('/research')) {
    return { kind: 'unrecognized', reason: 'not a /research command' }
  }
  const afterVerb = trimmed.slice('/research'.length)
  if (afterVerb.length === 0) return { kind: 'help' }
  if (!/^\s/.test(afterVerb)) {
    return { kind: 'unrecognized', reason: 'missing space after /research' }
  }
  const rest = afterVerb.trim()
  if (rest.length === 0) return { kind: 'help' }
  if (rest.toLowerCase() === 'help') return { kind: 'help' }

  const firstSpace = rest.indexOf(' ')
  const head = (firstSpace === -1 ? rest : rest.slice(0, firstSpace)).toLowerCase()
  const tail = firstSpace === -1 ? '' : rest.slice(firstSpace + 1).trim()

  if (head === 'list') {
    return { kind: 'list' }
  }
  if (head === 'deep') {
    if (tail.length === 0) {
      return { kind: 'unrecognized', reason: 'usage: /research deep <topic>' }
    }
    return { kind: 'deep', topic: tail }
  }
  if (head === 'find') {
    if (tail.length === 0) {
      return { kind: 'unrecognized', reason: 'usage: /research find <query>' }
    }
    return { kind: 'find', query: tail }
  }
  // Otherwise: capture the entire remainder as a standard-depth topic.
  return { kind: 'capture', topic: rest }
}

export interface ResearchCommandCardButton {
  /** Render label on the button face. */
  label: string
  /** Value emitted to the chat send-pipeline on tap. MUST start with
   *  `/research` per the brief's HARD CONSTRAINTS — the router envelopes
   *  `body: value` (not `body: label`). */
  value: string
}

export interface ResearchCommandCard {
  /** Render-ready markdown table (briefs / hits). */
  body_md?: string
  /** Inline button row — appears below the body. */
  buttons?: ResearchCommandCardButton[]
}

export interface ResearchCommandResponse {
  text: string
  data?: unknown
  card?: ResearchCommandCard
  error?: { code: string; message: string }
}

export interface ResearchCommandContext {
  backend: ResearchProjectBackend
  project_slug: string
  project_id: string
  user_id: string
}

export async function executeResearchCommand(
  cmd: ResearchCommand,
  ctx: ResearchCommandContext,
): Promise<ResearchCommandResponse> {
  try {
    switch (cmd.kind) {
      case 'help':
        return helpResponse()
      case 'unrecognized':
        return {
          text: `Research command not understood: ${cmd.reason}`,
          error: { code: 'malformed', message: cmd.reason },
        }
      case 'capture':
        return await captureTopic(cmd.topic, ctx)
      case 'deep':
        return await deepTopic(cmd.topic, ctx)
      case 'list':
        return await listBriefs(ctx)
      case 'find':
        return await findBriefs(cmd.query, ctx)
    }
  } catch (err) {
    if (err instanceof ResearchInputError) {
      return {
        text: `Research Core: ${err.message}`,
        error: { code: err.code, message: err.message },
      }
    }
    if (err instanceof ResearchTaskNotFoundError) {
      return {
        text: `Research Core: ${err.message}`,
        error: { code: err.code, message: err.message },
      }
    }
    const message = err instanceof Error ? err.message : 'unknown error'
    return {
      text: `Research Core: ${message}`,
      error: { code: 'backend_error', message },
    }
  }
}

function helpResponse(): ResearchCommandResponse {
  return {
    text:
      'Research Core commands: ' +
      '`/research <topic>` quick brief · ' +
      '`/research deep <topic>` sub-agent run · ' +
      '`/research list` recent · ' +
      '`/research find <q>` search prior briefs.',
  }
}

async function captureTopic(
  topic: string,
  ctx: ResearchCommandContext,
): Promise<ResearchCommandResponse> {
  const result = await ctx.backend.start({
    query: topic,
    depth: 'standard',
    project_id: ctx.project_id,
  })
  if (result.status === 'completed') {
    const fetched = await ctx.backend.fetch({
      task_id: result.task_id,
      project_id: ctx.project_id,
    })
    const claims = fetched.brief?.claims?.length ?? 0
    return {
      text:
        `Research brief ready (${result.task_id.slice(0, 8)}). ` +
        `${claims} claim${claims === 1 ? '' : 's'} captured. ` +
        `Task: ${result.task_id}`,
      data: { task_id: result.task_id, brief: fetched.brief ?? null },
      card: {
        buttons: [
          { label: 'Show prior', value: '/research list' },
          { label: 'Rerun', value: `/research ${topic}` },
        ],
      },
    }
  }
  if (result.status === 'failed') {
    const status = await ctx.backend.status({
      task_id: result.task_id,
      project_id: ctx.project_id,
    })
    return {
      text:
        `Research brief failed (${result.task_id.slice(0, 8)}). ` +
        `${status.error ?? '<no error message>'}`,
      data: { task_id: result.task_id, error: status.error ?? null },
      error: { code: 'task_failed', message: status.error ?? 'failed' },
    }
  }
  return {
    text: `Task ${result.task_id} status: ${result.status}.`,
    data: { task_id: result.task_id, status: result.status },
  }
}

async function deepTopic(
  topic: string,
  ctx: ResearchCommandContext,
): Promise<ResearchCommandResponse> {
  const result = await ctx.backend.deep({
    query: topic,
    project_id: ctx.project_id,
  })
  if (result.status === 'completed') {
    const fetched = await ctx.backend.fetch({
      task_id: result.task_id,
      project_id: ctx.project_id,
    })
    const claims = fetched.brief?.claims?.length ?? 0
    return {
      text:
        `Deep research complete (${result.task_id.slice(0, 8)}). ` +
        `${claims} claim${claims === 1 ? '' : 's'} captured via Haiku 4.5 sub-agent. ` +
        `Task: ${result.task_id}`,
      data: { task_id: result.task_id, brief: fetched.brief ?? null },
      card: {
        buttons: [
          { label: 'Show prior', value: '/research list' },
          { label: 'Rerun deep', value: `/research deep ${topic}` },
        ],
      },
    }
  }
  if (result.status === 'failed') {
    const status = await ctx.backend.status({
      task_id: result.task_id,
      project_id: ctx.project_id,
    })
    return {
      text:
        `Deep research failed (${result.task_id.slice(0, 8)}). ` +
        `${status.error ?? '<no error message>'}`,
      data: { task_id: result.task_id, error: status.error ?? null },
      error: { code: 'task_failed', message: status.error ?? 'failed' },
    }
  }
  return {
    text:
      `Deep research kicked off (${result.task_id.slice(0, 8)}); ` +
      `Haiku 4.5 sub-agent running (~5min budget). Task: ${result.task_id}`,
    data: { task_id: result.task_id, status: result.status },
  }
}

async function listBriefs(
  ctx: ResearchCommandContext,
): Promise<ResearchCommandResponse> {
  const result = await ctx.backend.list({
    project_id: ctx.project_id,
    limit: 20,
  })
  if (result.briefs.length === 0) {
    return {
      text: 'No research briefs in this project yet.',
      data: result,
    }
  }
  const headerRow = '| Task | Topic | Status | Claims | Confidence | Completed |'
  const sepRow = '|------|-------|--------|-------:|------------|-----------|'
  const dataRows = result.briefs.map((b) => {
    const task = b.task_id.slice(0, 8)
    const topic = (b.topic ?? '<no topic>').replace(/\|/g, '\\|').slice(0, 60)
    const completed =
      b.completed_at !== null
        ? new Date(b.completed_at).toISOString().slice(0, 10)
        : '—'
    return `| \`${task}\` | ${topic} | ${b.status} | ${b.claim_count} | ${b.confidence_level ?? '—'} | ${completed} |`
  })
  const body_md = [headerRow, sepRow, ...dataRows].join('\n')
  return {
    text: `${result.briefs.length} research brief${result.briefs.length === 1 ? '' : 's'} in this project.`,
    data: result,
    card: { body_md },
  }
}

async function findBriefs(
  query: string,
  ctx: ResearchCommandContext,
): Promise<ResearchCommandResponse> {
  const result = await ctx.backend.find({
    project_id: ctx.project_id,
    query,
    limit: 10,
  })
  if (result.hits.length === 0) {
    return {
      text: `No research briefs match "${query}".`,
      data: result,
    }
  }
  const lines = result.hits
    .slice(0, 5)
    .map((h) => `- \`${h.task_id.slice(0, 8)}\` ${h.topic} _(${h.matched_in}, ${h.claim_count} claims)_`)
  return {
    text: `${result.hits.length} brief${result.hits.length === 1 ? '' : 's'} match "${query}":\n${lines.join('\n')}`,
    data: result,
  }
}
