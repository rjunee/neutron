/**
 * @neutronai/reminders-core — extra MCP tool wiring for S1.
 *
 * The original `buildTools(...)` in `tools.ts` constructs the five
 * legacy guard-wrapped handlers (create / list / snooze / cancel /
 * convert_to_task). This module ships the SIXTH tool (`reminders_update`)
 * — kept in a sibling module so a future refactor that drops the
 * legacy 5 leaves the new module standing.
 *
 * Same `CapabilityGuard.wrapToolHandler` discipline as `tools.ts`:
 *   - records `op='tool_call' outcome='ok'` on success
 *   - records `op='tool_call' outcome='capability_denied'` + throws
 *     `CapabilityDeniedError` when the manifest's tool/capability
 *     declarations don't match
 *   - records `op='tool_call' outcome='error'` if the inner handler
 *     throws (and re-throws the error)
 */

import {
  CapabilityGuard,
  type SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import { CORE_SLUG, WRITE_CAPABILITY } from './manifest.ts'
import type {
  RemindersBackend,
  RemindersUpdateInput,
  RemindersUpdateResult,
} from './backend.ts'

export interface ExtraToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  backend: RemindersBackend
}

export interface BuiltExtraTools {
  reminders_update: (input: RemindersUpdateInput) => Promise<RemindersUpdateResult>
}

/**
 * Construct the sixth tool handler. Caller registers the returned
 * function alongside the legacy 5 from `buildTools(deps)`.
 *
 * `capability_required` matches the manifest's tool entry (locked at
 * `write:reminders_core.db` since update writes via cancel+create);
 * a drift between this string and the manifest's `tools[].capability_required`
 * trips the guard's `capability_mismatch` check at the FIRST call.
 */
export function buildExtraTools(deps: ExtraToolDeps): BuiltExtraTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    owner_slug: deps.project_slug,
    audit: deps.audit,
  })

  const reminders_update = guard.wrapToolHandler<
    RemindersUpdateInput,
    RemindersUpdateResult
  >({
    tool_name: 'reminders_update',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: RemindersUpdateInput): Promise<RemindersUpdateResult> => {
      return deps.backend.update(input)
    },
  })

  return { reminders_update }
}
