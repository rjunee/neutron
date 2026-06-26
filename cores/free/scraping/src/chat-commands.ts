/**
 * @neutronai/scraping-core — `/scrape ...` chat-command parser + dispatcher.
 *
 * Pure parser (`parseScrapeCommand`) splits a raw chat body into a typed
 * command; the dispatcher (`executeScrapeCommand`) calls the shared
 * `ScrapingBackend` and returns a chat-render-ready envelope. Mirrors
 * `cores/free/research/src/chat-commands.ts`.
 *
 * Grammar:
 *   /scrape <url>                  — auto-detect IG vs X, default mode
 *   /scrape <url> summary          — choose an output mode
 *   /scrape <url> text --thread    — X thread, plain text
 *   /scrape help | (bare)          — cheatsheet
 *
 * Modes: json | caption | summary  (Instagram)
 *        json | text | summary | article  (X)
 * The backend falls back to `json` if a mode doesn't apply to the
 * detected platform, so the parser accepts any of them.
 */

import type { ScrapeResult, ScrapingBackend } from './backend.ts'

const MODE_TOKENS = new Set([
  'json',
  'caption',
  'summary',
  'text',
  'article',
])

export type ScrapeCommand =
  | { kind: 'scrape'; url: string; mode?: string; thread: boolean }
  | { kind: 'help' }
  | { kind: 'unrecognized'; reason: string }

/** Pure parser. Bare `/scrape` (or `/scrape help`) returns help. */
export function parseScrapeCommand(raw: string): ScrapeCommand {
  const trimmed = raw.trimStart()
  if (!trimmed.toLowerCase().startsWith('/scrape')) {
    return { kind: 'unrecognized', reason: 'not a /scrape command' }
  }
  const afterVerb = trimmed.slice('/scrape'.length)
  if (afterVerb.length === 0) return { kind: 'help' }
  if (!/^\s/.test(afterVerb)) {
    return { kind: 'unrecognized', reason: 'missing space after /scrape' }
  }
  const rest = afterVerb.trim()
  if (rest.length === 0 || rest.toLowerCase() === 'help') return { kind: 'help' }

  const tokens = rest.split(/\s+/)
  let url: string | undefined
  let mode: string | undefined
  let thread = false
  for (const tok of tokens) {
    const lower = tok.toLowerCase()
    if (lower === '--thread' || lower === 'thread') {
      thread = true
      continue
    }
    if (/^https?:\/\//i.test(tok)) {
      if (url === undefined) url = tok
      continue
    }
    if (MODE_TOKENS.has(lower)) {
      mode = lower
      continue
    }
    // Unknown bare token — ignore (keeps the parser forgiving).
  }
  if (url === undefined) {
    return {
      kind: 'unrecognized',
      reason: 'usage: /scrape <instagram-or-x-url> [json|caption|summary|text|article] [--thread]',
    }
  }
  const cmd: ScrapeCommand = { kind: 'scrape', url, thread }
  if (mode !== undefined) cmd.mode = mode
  return cmd
}

export interface ScrapeCommandResponse {
  text: string
  data?: unknown
  error?: { code: string; message: string }
}

export interface ScrapeCommandContext {
  backend: ScrapingBackend
}

export async function executeScrapeCommand(
  cmd: ScrapeCommand,
  ctx: ScrapeCommandContext,
): Promise<ScrapeCommandResponse> {
  switch (cmd.kind) {
    case 'help':
      return helpResponse()
    case 'unrecognized':
      return {
        text: `Scrape command not understood: ${cmd.reason}`,
        error: { code: 'malformed', message: cmd.reason },
      }
    case 'scrape': {
      const input: { url: string; mode?: string; thread?: boolean } = {
        url: cmd.url,
      }
      if (cmd.mode !== undefined) input.mode = cmd.mode
      if (cmd.thread) input.thread = true
      const result = await ctx.backend.scrapeUrl(input)
      return renderResult(result)
    }
  }
}

function helpResponse(): ScrapeCommandResponse {
  return {
    text:
      'Scrape Core: `/scrape <url>` fetches an Instagram or X/Twitter URL via Apify. ' +
      'Modes — IG: `json·caption·summary`; X: `json·text·summary·article`. ' +
      'Add `--thread` for an X conversation. ' +
      'Needs an Apify token in admin → Integrations → Apify (optional until added).',
  }
}

function renderResult(result: ScrapeResult): ScrapeCommandResponse {
  if (result.ok) {
    return {
      text: result.text,
      data: { platform: result.platform, mode: result.mode, url: result.url },
    }
  }
  if (result.code === 'no_token') {
    return {
      text: result.guidance ?? result.message,
      error: { code: result.code, message: result.message },
    }
  }
  return {
    text: `Scrape failed (${result.code}): ${result.message}`,
    error: { code: result.code, message: result.message },
  }
}
