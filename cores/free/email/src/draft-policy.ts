/**
 * @neutronai/email-managed-core — the owner's load-bearing 4-point draft
 * policy.
 *
 * Per internal design notes "owner email-draft 4-point requirement" +
 * docs/plans/email-managed-core-tier1-brief.md § 3.6. Every drafted
 * email this Core creates MUST end up with INBOX + IMPORTANT + UNREAD
 * on its thread BEFORE `createDraft` returns success — the owner's hard
 * rule. The default (`DEFAULT_DRAFT_LABEL_IDS`) is the codified version
 * of the rule the `gog gmail` daily-driver shape currently enforces
 * by hand (`gog gmail drafts create` followed by `gog gmail thread
 * modify <threadId> --add "INBOX,IMPORTANT,UNREAD"`).
 *
 * `applyDraftVisibilityLabels` is the orchestration wrapper every code
 * path that creates drafts goes through:
 *   - The chat-command surface for `/email draft <to> <subject> <body>`.
 *   - The MCP `email_draft_prepare` tool.
 *   - The onboarding wow-moment (engineering-plan § P2 wow action 5 —
 *     "drafts a follow-up email") when wired in a future sprint.
 *
 * The atomic 2-call sequence — `drafts.create` followed by
 * `users.threads.modify(addLabelIds=DEFAULT_DRAFT_LABEL_IDS)` — already
 * lives in `GmailClient.createDraft` (both backends). This wrapper
 * exists for:
 *   1. A standalone unit test (`__tests__/draft-policy.test.ts`) that
 *      pins the call order + arguments + the `DraftLabelingError`
 *      partial-completion path against a mocked `GmailClient`.
 *   2. The idempotent-retry contract — when a partial completion
 *      throws `DraftLabelingError`, the caller can re-invoke
 *      `retryDraftLabels(draft_id, thread_id, ...)` with the same
 *      arguments and the Gmail API treats it as a no-op.
 *   3. A single grep-target for "where is the 4-point requirement
 *      enforced" — the regex `applyDraftVisibilityLabels|retryDraftLabels`
 *      lands every call site in one query.
 */

import {
  DraftLabelingError,
  type GmailClient,
  type GmailDraftInput,
  type GmailDraftResult,
} from './backend.ts'
import { DEFAULT_DRAFT_LABEL_IDS, projectLabelName } from './manifest.ts'

/** Re-export DEFAULT_DRAFT_LABEL_IDS from the manifest so callers that
 *  reach for the constant from `draft-policy` find it (the unit test
 *  imports from here so it pins the policy to this module). */
export { DEFAULT_DRAFT_LABEL_IDS, DraftLabelingError }

/**
 * Orchestrate the atomic 2-call sequence. Returns the augmented
 * `GmailDraftResult` (carrying the post-modify `applied_labels` echo
 * from the backend's `createDraft`). When the post-create
 * `threads.modify` fails, the backend itself throws
 * `DraftLabelingError`; this wrapper bubbles it up unmodified.
 */
export async function applyDraftVisibilityLabels(input: {
  client: GmailClient
  draft: GmailDraftInput
}): Promise<GmailDraftResult> {
  // The backend's `createDraft` IS the atomic sequence — it issues
  // `drafts.create` then `users.threads.modify(addLabelIds=
  // DEFAULT_DRAFT_LABEL_IDS)` (+ `Neutron/<project_id>` when
  // `input.project_id` is set), and throws `DraftLabelingError` on
  // partial completion. This wrapper is the named-policy entry point
  // so callers don't reach `client.createDraft` directly.
  return await input.client.createDraft(input.draft)
}

/**
 * Retry the labelling step after a `DraftLabelingError`. Gmail's
 * `users.threads.modify(addLabelIds=...)` is idempotent — calling it
 * twice with the same labels is a no-op when the labels are already
 * present — so the caller can safely retry without re-creating the
 * draft.
 */
export async function retryDraftLabels(input: {
  client: GmailClient
  draft_id: string
  thread_id: string
  message_id: string
  project_id?: string
}): Promise<GmailDraftResult> {
  const addLabels: string[] = [...DEFAULT_DRAFT_LABEL_IDS]
  if (input.project_id !== undefined) {
    const ensure = await input.client.ensureProjectLabel({
      project_id: input.project_id,
    })
    addLabels.push(ensure.label_id)
  }
  try {
    const modify = await input.client.modifyThread({
      thread_id: input.thread_id,
      add_label_ids: addLabels,
    })
    const echoed = addLabels.filter((l) => modify.label_ids.includes(l))
    return {
      draft_id: input.draft_id,
      message_id: input.message_id,
      thread_id: input.thread_id,
      applied_labels: echoed,
    }
  } catch (err) {
    const underlying = err instanceof Error ? err : new Error(String(err))
    throw new DraftLabelingError(
      input.draft_id,
      input.thread_id,
      input.message_id,
      underlying,
    )
  }
}

/**
 * Compute the labels that WILL be applied to a draft for the given
 * input. Pure (no I/O); used by the chat-command surface to preview
 * the labels in the confirmation chip + by the audit logger to
 * record what was attempted.
 *
 * When `project_id` is supplied, the returned list includes the
 * label NAME `Neutron/<project_id>` (NOT the Gmail label_id — the
 * caller resolves that lazily via `ensureProjectLabel`).
 */
export function plannedDraftLabels(project_id?: string): string[] {
  const out: string[] = [...DEFAULT_DRAFT_LABEL_IDS]
  if (project_id !== undefined) {
    out.push(projectLabelName(project_id))
  }
  return out
}
