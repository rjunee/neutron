/**
 * @neutronai/email-managed-core — manifest loader + locked constants.
 *
 * Mirrors the Tier 1 Calendar / Notes / Tasks Cores: thin wrapper on
 * top of the Sprint 24 `parseManifest`. Reads `package.json` from a
 * path (default: this Core's own `package.json`), extracts the
 * `"neutron"` block, and returns the parsed `NeutronManifest`. The
 * runtime loader catches Zod validation errors and surfaces them as
 * `CoreInstallError`.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseManifest, type NeutronManifest } from '@neutronai/cores-sdk'

/**
 * Slug derived from the package name. Mirrors Sprint 31
 * `packageNameToSlug('@neutronai/email-managed-core')` so the runtime's
 * namespace allocator keys all on-disk state under
 * `email_managed_core`.
 */
export const CORE_SLUG = 'email_managed_core' as const

/** Stable package name. */
export const CORE_PACKAGE_NAME = '@neutronai/email-managed-core' as const

/**
 * Manifest secret name + label — the `(kind, label)` pair the runtime
 * store + capability gate use to address the user's Gmail OAuth
 * refresh/access token row.
 *
 * The label `gmail_compose` is the stable storage key for the token
 * across this Core's lifecycle. The actual OAuth grant covers
 * THREE scopes (per Argus r1 BLOCKER #2 fix, 2026-05-21):
 *
 *   - `gmail.readonly`  — list/read/search/summarize/triage paths
 *   - `gmail.modify`    — threads.modify for the owner 4-point label
 *                         policy (INBOX + IMPORTANT + UNREAD applied
 *                         to every drafted thread atomically)
 *   - `gmail.compose`   — drafts.create
 *
 * `gmail.send` is INTENTIONALLY EXCLUDED. The Tier 1 "never sends"
 * guarantee is enforced at THREE layers: product surface (no send
 * tool, no send method on `GmailClient`), OAuth grant (gmail.send
 * absent from the scope set, so the persisted token cannot send),
 * and audit (every dispatch goes through `CapabilityGuard.
 * wrapToolHandler`). Tier 2 Email-Private Core will request
 * gmail.send separately under a distinct secret label.
 */
export const OAUTH_SECRET_LABEL = 'gmail_compose' as const

/**
 * MCP tool names declared in the manifest. Exposed as a `const` tuple
 * so capability-guard wiring + tests iterate without re-reading the
 * manifest body. The first five are the v0.1.0 surface (list / read /
 * search / summarize / draft_prepare); `email_triage` is the v0.2.0
 * addition wiring the Haiku-fast triage agent into the MCP surface.
 */
export const TOOL_NAMES = [
  'email_list',
  'email_read',
  'email_search',
  'email_summarize',
  'email_draft_prepare',
  'email_triage',
] as const
export type EmailToolName = typeof TOOL_NAMES[number]

/**
 * Capability strings the manifest declares.
 */
export const READ_CAPABILITY = 'read:email_managed_core.messages' as const
export const WRITE_CAPABILITY = 'write:email_managed_core.drafts' as const

/**
 * Per-project Gmail user-label namespace. v1 ships the literal
 * `Neutron/<project_id>` namespace; `ensureProjectLabel` creates the
 * label on first use (idempotent). The Core's `list` / `search` /
 * `triage` paths filter by this label when invoked inside a project
 * scope; the `email_draft_prepare` path auto-applies it alongside
 * the owner 4-point labels.
 */
export const PROJECT_LABEL_PREFIX = 'Neutron/' as const

/**
 * the owner's load-bearing 4-point email-draft requirement (codified per
 * internal design notes "owner email-draft 4-point requirement"). Every
 * drafted email this Core creates MUST end up with INBOX + IMPORTANT
 * + UNREAD on its thread BEFORE `createDraft` returns success — the owner's
 * inbox surfaces them next to live mail. The atomic 2-call sequence
 * (drafts.create → threads.modify) lives in `src/draft-policy.ts`;
 * the constant lives here so the backend, the dispatcher, and the
 * unit test all reference one source of truth.
 */
export const DEFAULT_DRAFT_LABEL_IDS = ['INBOX', 'IMPORTANT', 'UNREAD'] as const
export type OwnerDraftLabel = typeof DEFAULT_DRAFT_LABEL_IDS[number]

/**
 * Compose the per-project Gmail user-label name for a project slug.
 * Pure helper; no I/O. Mirrors `${PROJECT_LABEL_PREFIX}${project_id}`
 * but exists so callers don't string-concat the prefix in three places.
 */
export function projectLabelName(project_id: string): string {
  return `${PROJECT_LABEL_PREFIX}${project_id}`
}

function defaultPackageJsonPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'package.json')
}

/**
 * Load + parse the Core's manifest. Defaults to this package's own
 * `package.json`; tests can override via `package_json_path`.
 */
export function loadManifest(options: {
  package_json_path?: string
} = {}): NeutronManifest {
  const path = options.package_json_path ?? defaultPackageJsonPath()
  const raw = readFileSync(path, 'utf8')
  const pkg: unknown = JSON.parse(raw)
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new Error(`package.json at ${path} is not an object`)
  }
  const block = (pkg as Record<string, unknown>)['neutron']
  if (block === undefined) {
    throw new Error(`package.json at ${path} has no "neutron" section`)
  }
  return parseManifest(block)
}
