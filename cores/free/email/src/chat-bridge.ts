/**
 * @neutronai/email-managed-core — chat-bridge wiring.
 *
 * Factory that adapts the Email-Managed Core's
 * `parseEmailCommand` + `executeEmailCommand` into the gateway's
 * `ChatCommandFilter` contract (see `gateway/http/app-ws-surface.ts`).
 * The gateway holds exactly one filter instance per instance boot;
 * the filter resolves the per-project `EmailProjectCache` lazily on
 * first `/email` for each (instance, project) pair.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.2.
 */

import {
  executeEmailCommand,
  parseEmailCommand,
  type EmailCommandResponse,
} from './chat-commands.ts'
import type { EmailProjectCacheResolver } from './cache.ts'
import type { GmailClient } from './backend.ts'
import { buildStubEmailSummarizer, type EmailSummarizer } from './backend.ts'

export interface EmailChatCommandFilterInput {
  user_id: string
  project_slug: string
  channel_topic_id: string
  project_id?: string
  body: string
}

export type EmailChatCommandFilterResult = {
  text: string
  data?: unknown
  deep_link?: string
  error?: { code: string; message: string; draft_id?: string }
}

export interface EmailChatCommandFilter {
  match(
    input: EmailChatCommandFilterInput,
  ): Promise<EmailChatCommandFilterResult | null>
}

export interface CreateEmailChatCommandFilterOptions {
  resolver: EmailProjectCacheResolver
  /** Production Gmail client. Resolved at filter-build time so every
   *  match call uses the same per-instance client (with OAuth refresh
   *  threaded through the `OAuthTokenManager`). */
  client: GmailClient
  /** Pluggable LLM call for triage + summarizer agents. */
  llm: (prompt: string) => Promise<string>
  /** Resolved Haiku-fast model id. */
  model: string
  /** Optional structured-row summarizer. Production uses the stub
   *  (the brief composer wraps with Haiku); tests inject a fake. */
  summarizer?: EmailSummarizer
  /** User-local time zone (defaults to `America/Los_Angeles` — the owner's
   *  USER.md default). */
  default_user_tz?: string
  default_project_id?: string
  /** Wall-clock override for deterministic tests. */
  now?: () => Date
}

export function createEmailChatCommandFilter(
  opts: CreateEmailChatCommandFilterOptions,
): EmailChatCommandFilter {
  const default_project_id = opts.default_project_id ?? 'default'
  const default_user_tz = opts.default_user_tz ?? 'America/Los_Angeles'
  const now = opts.now ?? ((): Date => new Date())
  const summarizer = opts.summarizer ?? buildStubEmailSummarizer()

  return {
    async match(input) {
      const trimmed = input.body.trimStart()
      if (!trimmed.toLowerCase().startsWith('/email')) return null
      const cmd = parseEmailCommand(trimmed)
      const project_id = input.project_id ?? default_project_id
      const cache = await opts.resolver.resolve(project_id)
      const response: EmailCommandResponse = await executeEmailCommand(cmd, {
        client: opts.client,
        cache,
        project_id,
        user_id: input.user_id,
        user_tz: default_user_tz,
        now: now(),
        llm: opts.llm,
        model: opts.model,
        summarizer,
      })
      const out: EmailChatCommandFilterResult = { text: response.text }
      if (response.data !== undefined) out.data = response.data
      if (response.deep_link !== undefined) out.deep_link = response.deep_link
      if (response.error !== undefined) out.error = response.error
      return out
    },
  }
}
