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

import { CORE_SLUG, READ_CAPABILITY, WRITE_CAPABILITY } from './manifest.ts'
import {
  RitualsUnavailableError,
  type RemindersBackend,
  type RemindersUpdateInput,
  type RemindersUpdateResult,
  type RitualEnableInput,
  type RitualProposeInput,
  type RitualProposeResult,
  type RitualStatusRowResult,
} from './backend.ts'

export interface ExtraToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  backend: RemindersBackend
}

/** Result envelope for `rituals_status` (an array wrapped for the MCP object shape). */
export interface RitualsStatusOutput {
  results: RitualStatusRowResult[]
}

export interface BuiltExtraTools {
  reminders_update: (input: RemindersUpdateInput) => Promise<RemindersUpdateResult>
  /** Plan task 8 — PROPOSE a ritual (requires the owner's in-chat approval to fire). */
  rituals_propose: (input: RitualProposeInput) => Promise<RitualProposeResult>
  /** Argus r2 BLOCKER fix — ENABLE a bundled/registered ritual (owner approval to fire). */
  rituals_enable: (input: RitualEnableInput) => Promise<RitualProposeResult>
  /** Plan task 8 — the ritual approval/schedule status snapshot. */
  rituals_status: (input: Record<string, never>) => Promise<RitualsStatusOutput>
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

  // Plan task 8 — PROPOSE a ritual. The proposal ONLY runs after the OWNER
  // approves it in chat (see the tool description); the backend method throws
  // RitualsUnavailableError (surfaced via the guard's error path) when no ritual
  // service is wired (LLM-less box).
  const rituals_propose = guard.wrapToolHandler<RitualProposeInput, RitualProposeResult>({
    tool_name: 'rituals_propose',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: RitualProposeInput): Promise<RitualProposeResult> => {
      if (deps.backend.proposeRitual === undefined) {
        throw new RitualsUnavailableError(
          'rituals_propose: backend has no proposeRitual wired',
        )
      }
      return deps.backend.proposeRitual(input)
    },
  })

  // Argus r2 BLOCKER fix — ENABLE a bundled/already-registered ritual. The three
  // bundled examples (morning-brief/evening-wrap/daily-delta) are seeded +
  // registered at boot but `rituals_propose` refuses their ids as
  // duplicate/exists-on-disk; this is the path that gives them an approval +
  // schedule. Same owner-approval gate as propose (nothing fires until the owner
  // taps Approve on the code-rendered prompt).
  const rituals_enable = guard.wrapToolHandler<RitualEnableInput, RitualProposeResult>({
    tool_name: 'rituals_enable',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: RitualEnableInput): Promise<RitualProposeResult> => {
      if (deps.backend.enableRitual === undefined) {
        throw new RitualsUnavailableError(
          'rituals_enable: backend has no enableRitual wired',
        )
      }
      return deps.backend.enableRitual(input)
    },
  })

  const rituals_status = guard.wrapToolHandler<Record<string, never>, RitualsStatusOutput>({
    tool_name: 'rituals_status',
    capability_required: READ_CAPABILITY,
    fn: async (): Promise<RitualsStatusOutput> => {
      if (deps.backend.ritualsStatus === undefined) {
        throw new RitualsUnavailableError(
          'rituals_status: backend has no ritualsStatus wired',
        )
      }
      const results = await deps.backend.ritualsStatus()
      return { results }
    },
  })

  return { reminders_update, rituals_propose, rituals_enable, rituals_status }
}
