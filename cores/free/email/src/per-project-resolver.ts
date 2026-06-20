/**
 * @neutronai/email-managed-core — per-project Gmail label resolver.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.5. Resolves a
 * project_id → Gmail label_id pair, creating the Gmail user-label
 * `Neutron/<project_id>` on first use via
 * `GmailClient.ensureProjectLabel` and caching the resolution in the
 * per-project sidecar's `email_project_label_cache` table to avoid a
 * `users.labels.list` round-trip on every per-project list/search/
 * triage call.
 */

import type { EmailProjectCache } from './cache.ts'
import type { GmailClient } from './backend.ts'
import { projectLabelName } from './manifest.ts'

export interface ResolvedProjectLabel {
  project_id: string
  gmail_label_id: string
  label_name: string
  source: 'cache' | 'gmail_existing' | 'gmail_created'
}

/**
 * Resolve the per-project Gmail label_id. Reads the local cache
 * first; on cache miss, calls `GmailClient.ensureProjectLabel`
 * (which is idempotent — creates the label only when absent on the
 * Gmail side) and writes the result to the cache.
 */
export async function resolveProjectLabel(input: {
  cache: EmailProjectCache
  client: GmailClient
  project_id: string
}): Promise<ResolvedProjectLabel> {
  const cached = input.cache.getProjectLabelId(input.project_id)
  if (cached !== null) {
    return {
      project_id: input.project_id,
      gmail_label_id: cached.gmail_label_id,
      label_name: cached.label_name,
      source: 'cache',
    }
  }
  const ensured = await input.client.ensureProjectLabel({
    project_id: input.project_id,
  })
  input.cache.setProjectLabelId({
    project_id: input.project_id,
    gmail_label_id: ensured.label_id,
    label_name: ensured.label_name,
  })
  return {
    project_id: input.project_id,
    gmail_label_id: ensured.label_id,
    label_name: ensured.label_name,
    source: ensured.created ? 'gmail_created' : 'gmail_existing',
  }
}

/**
 * Convenience helper — return the expected label name for a
 * project_id without any I/O. Used by the chat-command surface to
 * preview the label name in confirmation chips.
 */
export function previewProjectLabelName(project_id: string): string {
  return projectLabelName(project_id)
}
