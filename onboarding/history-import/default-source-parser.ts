/**
 * @neutronai/onboarding/history-import — default SourceParser dispatcher.
 *
 * Wires every supported source to its parser. The runner injects this
 * via `ImportJobRunnerDeps.parse`; tests substitute their own.
 */

import { parseChatgptExport } from './chatgpt-export.ts'
import { parseClaudeExport } from './claude-export.ts'
import { fetchGmailThreads, type GmailClient } from './oauth-gmail.ts'
import { fetchCalendarEvents, type CalendarClient } from './oauth-calendar.ts'
import {
  ImportError,
  type ChunkerInput,
  type ConversationRecord,
  type ImportSource,
  type OAuthRefs,
} from './types.ts'
import { DRIVE_STUB_MESSAGE } from './oauth-drive.ts'
import { NOTION_STUB_MESSAGE } from './oauth-notion.ts'
import { SLACK_STUB_MESSAGE } from './oauth-slack.ts'

export interface DefaultParserDeps {
  gmailClient: GmailClient
  calendarClient: CalendarClient
}

/**
 * Build a `SourceParser` that dispatches on source. Bot the OAuth
 * variants need a real Google client wired in; production injects via
 * gateway/composition.ts. Stub sources throw with a typed message the
 * onboarding engine can show.
 */
export function buildDefaultSourceParser(deps: DefaultParserDeps): (
  source: ImportSource,
  payload: ChunkerInput,
) => AsyncIterable<ConversationRecord> {
  return (source, payload) => {
    switch (source) {
      case 'chatgpt-zip':
        return parseChatgptExport(asBuffer(source, payload))
      case 'claude-zip':
        return parseClaudeExport(asBuffer(source, payload))
      case 'gmail-oauth': {
        const oauth = asOAuth(source, payload)
        const userAddr = oauth.options?.['user_email_address']
        const args: { oauth: typeof oauth; client: typeof deps.gmailClient; user_email_address?: string } = {
          oauth,
          client: deps.gmailClient,
        }
        if (typeof userAddr === 'string') args.user_email_address = userAddr
        return fetchGmailThreads(args)
      }
      case 'calendar-oauth':
        return fetchCalendarEvents({
          oauth: asOAuth(source, payload),
          client: deps.calendarClient,
        })
      case 'drive-oauth':
        return throwingIterable('drive-oauth', DRIVE_STUB_MESSAGE)
      case 'notion-oauth':
        return throwingIterable('notion-oauth', NOTION_STUB_MESSAGE)
      case 'slack-oauth':
        return throwingIterable('slack-oauth', SLACK_STUB_MESSAGE)
    }
  }
}

function asBuffer(source: ImportSource, payload: ChunkerInput): Buffer {
  if (Buffer.isBuffer(payload)) return payload
  throw new ImportError(
    'parse_failed',
    source,
    `expected Buffer payload for source=${source}, got ${typeof payload}`,
  )
}

function asOAuth(source: ImportSource, payload: ChunkerInput): OAuthRefs {
  if (Buffer.isBuffer(payload)) {
    throw new ImportError(
      'oauth_scope_missing',
      source,
      `expected OAuthRefs payload for source=${source}, got Buffer`,
    )
  }
  return payload
}

async function* throwingIterable(
  source: ImportSource,
  message: string,
): AsyncIterable<ConversationRecord> {
  throw new ImportError('oauth_scope_missing', source, message)
  // eslint-disable-next-line @typescript-eslint/no-unreachable
  yield {} as never
}
