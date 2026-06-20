/**
 * @neutronai/research-core — chat-bridge wiring.
 *
 * Factory that adapts the Research Core's pure `parseResearchCommand` +
 * `executeResearchCommand` into the gateway's `ChatCommandFilter`
 * contract (see `gateway/http/app-ws-surface.ts`). The gateway holds
 * exactly one filter instance per boot; the filter resolves
 * the per-project research backend lazily on first `/research` for
 * each (instance, project) pair.
 *
 * Per docs/plans/research-core-tier1-brief.md § 3.2.
 */

import {
  executeResearchCommand,
  parseResearchCommand,
  type ResearchCommandCard,
  type ResearchCommandResponse,
} from './chat-commands.ts'
import type { ResearchProjectBackend } from './research-orchestrator.ts'

export interface ResearchChatCommandFilterInput {
  user_id: string
  project_slug: string
  channel_topic_id: string
  project_id?: string
  body: string
}

export interface ResearchChatCommandFilterResult {
  text: string
  data?: unknown
  card?: ResearchCommandCard
  deep_link?: string
  error?: { code: string; message: string }
}

export interface ResearchChatCommandFilter {
  match(
    input: ResearchChatCommandFilterInput,
  ): Promise<ResearchChatCommandFilterResult | null>
}

export interface CreateResearchChatCommandFilterOptions {
  backend: ResearchProjectBackend
  /** Project_id fallback when the inbound's envelope didn't carry one. */
  default_project_id?: string
}

/**
 * Build the `/research` chat-command filter. Routes inbound bodies whose
 * trimmed text starts with `/research` through `parseResearchCommand` +
 * `executeResearchCommand`; returns `null` for any other inbound so the
 * gateway's chat surface falls through to the LLM dispatch path.
 */
export function createResearchChatCommandFilter(
  opts: CreateResearchChatCommandFilterOptions,
): ResearchChatCommandFilter {
  const default_project_id = opts.default_project_id ?? 'default'
  return {
    async match(input) {
      const trimmed = input.body.trimStart()
      if (!trimmed.toLowerCase().startsWith('/research')) return null
      const cmd = parseResearchCommand(trimmed)
      const project_id = input.project_id ?? default_project_id
      const response: ResearchCommandResponse = await executeResearchCommand(
        cmd,
        {
          backend: opts.backend,
          project_slug: input.project_slug,
          project_id,
          user_id: input.user_id,
        },
      )
      const out: ResearchChatCommandFilterResult = { text: response.text }
      if (response.data !== undefined) out.data = response.data
      if (response.card !== undefined) out.card = response.card
      if (response.error !== undefined) out.error = response.error
      return out
    },
  }
}
