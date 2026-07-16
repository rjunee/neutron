/**
 * @neutronai/email-managed-core — capability-guarded MCP tool wiring.
 *
 * Six tools the manifest declares after the S1 sprint:
 *   email_list / email_read / email_search / email_summarize /
 *   email_draft_prepare / email_triage.
 *
 * Each handler is wrapped by the Sprint 31
 * `CapabilityGuard.wrapToolHandler` so every dispatch records an
 * audit row + rejects with `CapabilityDeniedError` when the
 * manifest doesn't declare the matching capability.
 */

import {
  CapabilityGuard,
  type SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import {
  CORE_SLUG,
  READ_CAPABILITY,
  SEND_CAPABILITY,
  WRITE_CAPABILITY,
} from './manifest.ts'
import { applyDraftVisibilityLabels } from './draft-policy.ts'
import {
  DEFAULT_LABEL,
  type EmailSummarizer,
  type EmailSummary,
  type GmailClient,
  type GmailDraftInput,
  type GmailDraftResult,
  type GmailListInput,
  type GmailListResult,
  type GmailMessageFull,
  type GmailMessageMeta,
  type GmailSearchInput,
  type GmailSendInput,
  type GmailSendResult,
  type GmailThreadFull,
} from './backend.ts'
import {
  briefTemplateHash,
  composeBriefSummary,
  type BriefSummary,
} from './summarizer.ts'
import {
  composeTriage,
  DEFAULT_LOOKBACK_MESSAGES,
  type Triage,
} from './triage.ts'
import type { EmailProjectCache } from './cache.ts'

export interface EmailListToolInput extends GmailListInput {}
export interface EmailListToolOutput extends GmailListResult {}

export interface EmailReadToolInput {
  message_id: string
}
export interface EmailReadToolOutput {
  message: GmailMessageFull
}

export interface EmailThreadToolInput {
  thread_id: string
}
export interface EmailThreadToolOutput {
  thread: GmailThreadFull
}

export interface EmailSearchToolInput extends GmailSearchInput {}
export interface EmailSearchToolOutput {
  results: GmailMessageMeta[]
}

export interface EmailSummarizeToolInput {
  message_id: string
  thread_id?: string
  /** When true, compose a 2-3 sentence prose brief over the
   *  structured row. */
  as_brief?: boolean
}
export interface EmailSummarizeToolOutput {
  summary: EmailSummary
  brief?: BriefSummary
}

export interface EmailDraftPrepareToolInput extends GmailDraftInput {}
export interface EmailDraftPrepareToolOutput extends GmailDraftResult {}

export interface EmailSendToolInput extends GmailSendInput {}
export interface EmailSendToolOutput extends GmailSendResult {}

export interface EmailTriageToolInput {
  lookback_messages?: number
  project_id?: string
  dry_run?: boolean
}
export interface EmailTriageToolOutput {
  triage: Triage
  /** Channel-side message id on the project chat surface; `null` on
   *  dry_run or when no project-chat target was supplied. */
  posted_chat_message_id: string | null
}

export type {
  EmailSummary,
  GmailMessageFull,
  GmailMessageMeta,
} from './backend.ts'

/**
 * Bundle of dependencies the tools dispatch against. The runtime
 * composer (P3+) constructs this at install time and passes it into
 * `buildTools` — tests pass mocks directly.
 */
export interface ToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  client: GmailClient
  summarizer: EmailSummarizer
  /** Pluggable LLM call for the prose-brief + triage agents. */
  llm?: (prompt: string) => Promise<string>
  /**
   * Model id stamped onto brief/triage result metadata. Accepts a thunk so a
   * live always-latest accessor (`getBestModel`) resolves PER-CALL — keeping the
   * recorded model aligned with what `llm` actually dispatched after a
   * model-update-watchdog flip (Codex cross-model review).
   */
  model?: string | (() => string)
  /** Optional per-project cache resolver; required for the triage
   *  audit log + summary cache. */
  cacheFor?: (project_id: string) => Promise<EmailProjectCache>
  /** Optional triage-fire hook; production posts to the project chat
   *  surface. */
  triageFire?: (input: { triage: Triage; project_id: string }) => Promise<{
    chat_message_id: string | null
  }>
  /** Wall-clock override. */
  now?: () => number
}

export interface BuiltTools {
  email_list: (input: EmailListToolInput) => Promise<EmailListToolOutput>
  email_read: (input: EmailReadToolInput) => Promise<EmailReadToolOutput>
  email_thread: (input: EmailThreadToolInput) => Promise<EmailThreadToolOutput>
  email_search: (input: EmailSearchToolInput) => Promise<EmailSearchToolOutput>
  email_summarize: (
    input: EmailSummarizeToolInput,
  ) => Promise<EmailSummarizeToolOutput>
  email_draft_prepare: (
    input: EmailDraftPrepareToolInput,
  ) => Promise<EmailDraftPrepareToolOutput>
  email_triage: (input: EmailTriageToolInput) => Promise<EmailTriageToolOutput>
  email_send: (input: EmailSendToolInput) => Promise<EmailSendToolOutput>
}

const NULL_LLM: (prompt: string) => Promise<string> = () =>
  Promise.reject(new Error('email_managed_core: llm dep not wired'))

export function buildTools(deps: ToolDeps): BuiltTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    owner_slug: deps.project_slug,
    audit: deps.audit,
  })
  const llm = deps.llm ?? NULL_LLM
  // Resolve PER-CALL (thunk → live accessor) so the stamped model tracks a
  // watchdog flip; a plain string pins a fixed id. Default Haiku-fast.
  const resolveModel = (): string => {
    const m = typeof deps.model === 'function' ? deps.model() : deps.model
    return m ?? 'claude-haiku-4-5-20251001'
  }
  const now = deps.now ?? ((): number => Date.now())

  const email_list = guard.wrapToolHandler<EmailListToolInput, EmailListToolOutput>({
    tool_name: 'email_list',
    capability_required: READ_CAPABILITY,
    fn: async (input: EmailListToolInput): Promise<EmailListToolOutput> => {
      return deps.client.listMessages(input)
    },
  })

  const email_read = guard.wrapToolHandler<EmailReadToolInput, EmailReadToolOutput>({
    tool_name: 'email_read',
    capability_required: READ_CAPABILITY,
    fn: async (input: EmailReadToolInput): Promise<EmailReadToolOutput> => {
      const message = await deps.client.getMessage({ message_id: input.message_id })
      return { message }
    },
  })

  const email_thread = guard.wrapToolHandler<EmailThreadToolInput, EmailThreadToolOutput>({
    tool_name: 'email_thread',
    capability_required: READ_CAPABILITY,
    fn: async (input: EmailThreadToolInput): Promise<EmailThreadToolOutput> => {
      const thread = await deps.client.getThread({ thread_id: input.thread_id })
      return { thread }
    },
  })

  const email_search = guard.wrapToolHandler<EmailSearchToolInput, EmailSearchToolOutput>({
    tool_name: 'email_search',
    capability_required: READ_CAPABILITY,
    fn: async (input: EmailSearchToolInput): Promise<EmailSearchToolOutput> => {
      const { results } = await deps.client.search(input)
      return { results }
    },
  })

  const email_summarize = guard.wrapToolHandler<
    EmailSummarizeToolInput,
    EmailSummarizeToolOutput
  >({
    tool_name: 'email_summarize',
    capability_required: READ_CAPABILITY,
    fn: async (input: EmailSummarizeToolInput): Promise<EmailSummarizeToolOutput> => {
      const message = await deps.client.getMessage({ message_id: input.message_id })
      const summary = await deps.summarizer.summarize({ message })
      if (input.as_brief === true) {
        const brief = await composeBriefSummary({
          structuredRow: summary,
          rawMessage: message,
          llm,
          model: resolveModel(),
        })
        // Cache when the call succeeded; the chat-command path also
        // populates the cache, so the MCP-tool path keeps parity.
        if (brief.outcome === 'ok' && deps.cacheFor !== undefined) {
          // The MCP tool can't resolve a project_id here without
          // explicit input — we use a `__null__` bucket so the cache
          // remains key-stable; the chat-command path supplies the
          // real project_id.
          try {
            const cache = await deps.cacheFor('__null__')
            cache.upsertSummary({
              message_id: input.message_id,
              template_hash: briefTemplateHash(),
              brief_text: brief.text,
              model: brief.model,
              prompt_hash: brief.prompt_hash,
            })
          } catch {
            /* best-effort */
          }
        }
        return { summary, brief }
      }
      return { summary }
    },
  })

  const email_draft_prepare = guard.wrapToolHandler<
    EmailDraftPrepareToolInput,
    EmailDraftPrepareToolOutput
  >({
    tool_name: 'email_draft_prepare',
    capability_required: WRITE_CAPABILITY,
    fn: async (
      input: EmailDraftPrepareToolInput,
    ): Promise<EmailDraftPrepareToolOutput> => {
      // The atomic 2-call sequence (drafts.create →
      // threads.modify(INBOX+IMPORTANT+UNREAD + Neutron/<project>))
      // is enforced inside `applyDraftVisibilityLabels`, which in turn
      // calls the backend's `createDraft` (where the 4-point step
      // lives). Calling through the policy wrapper here keeps the
      // grep-line `applyDraftVisibilityLabels|retryDraftLabels` covering
      // every draft creation path.
      const result = await applyDraftVisibilityLabels({
        client: deps.client,
        draft: input,
      })
      if (deps.cacheFor !== undefined && input.project_id !== undefined) {
        try {
          const cache = await deps.cacheFor(input.project_id)
          cache.recordDraftAudit({
            draft_id: result.draft_id,
            thread_id: result.thread_id,
            message_id: result.message_id,
            project_id: input.project_id,
            applied_labels: result.applied_labels,
            outcome: 'ok',
            response_excerpt: input.body.slice(0, 240),
          })
        } catch {
          /* best-effort */
        }
      }
      return result
    },
  })

  const email_triage = guard.wrapToolHandler<
    EmailTriageToolInput,
    EmailTriageToolOutput
  >({
    tool_name: 'email_triage',
    capability_required: READ_CAPABILITY,
    fn: async (input: EmailTriageToolInput): Promise<EmailTriageToolOutput> => {
      const lookback = input.lookback_messages ?? DEFAULT_LOOKBACK_MESSAGES
      const listInput: GmailListInput = {
        label: 'INBOX',
        max_results: lookback,
      }
      if (input.project_id !== undefined) listInput.project_id = input.project_id
      const { results: inbox } = await deps.client.listMessages(listInput)
      const triage = await composeTriage({
        inbox,
        userTz: 'America/Los_Angeles',
        llm,
        model: resolveModel(),
      })
      let posted_chat_message_id: string | null = null
      const isDryRun = input.dry_run === true
      const project_id = input.project_id
      if (!isDryRun && deps.triageFire !== undefined && project_id !== undefined) {
        const fired = await deps.triageFire({ triage, project_id })
        posted_chat_message_id = fired.chat_message_id
      }
      if (deps.cacheFor !== undefined && project_id !== undefined) {
        try {
          const cache = await deps.cacheFor(project_id)
          cache.upsertTriage({
            fired_at: now(),
            model: triage.model,
            outcome: triage.outcome,
            prompt_hash: triage.prompt_hash,
            top5_json: JSON.stringify(triage.items),
            chat_message_id: posted_chat_message_id,
          })
        } catch {
          /* best-effort */
        }
      }
      return { triage, posted_chat_message_id }
    },
  })

  const email_send = guard.wrapToolHandler<EmailSendToolInput, EmailSendToolOutput>({
    tool_name: 'email_send',
    capability_required: SEND_CAPABILITY,
    fn: async (input: EmailSendToolInput): Promise<EmailSendToolOutput> => {
      // messages.send + the post-send owner visibility-label apply
      // (INBOX + IMPORTANT + UNREAD, + Neutron/<project_id>) live inside
      // the backend's `sendMessage`; header-injection is blocked at the
      // shared `buildRawMessage` MIME layer. Record a draft-audit-style
      // row when a project cache is wired so sends are observable
      // alongside drafts.
      const result = await deps.client.sendMessage(input)
      if (deps.cacheFor !== undefined && input.project_id !== undefined) {
        try {
          const cache = await deps.cacheFor(input.project_id)
          cache.recordDraftAudit({
            draft_id: `sent:${result.message_id}`,
            thread_id: result.thread_id,
            message_id: result.message_id,
            project_id: input.project_id,
            applied_labels: result.applied_labels,
            outcome: 'ok',
            response_excerpt: input.body.slice(0, 240),
          })
        } catch {
          /* best-effort */
        }
      }
      return result
    },
  })

  void DEFAULT_LABEL

  return {
    email_list,
    email_read,
    email_thread,
    email_search,
    email_summarize,
    email_draft_prepare,
    email_triage,
    email_send,
  }
}
