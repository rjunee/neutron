/**
 * @neutronai/reminders — the content-hash-bound ritual APPROVAL gate (plan task 3).
 *
 * This module implements the {@link RitualApprovalCheck} seam that
 * `reminders/rituals.ts` (task 2) leaves open, and the request path that mints a
 * durable grant. Design decisions locked in the deepened spec header
 * (`docs/plans/executor-mode-reminders-2026-07-20.md`) and re-verified against the
 * code this pass:
 *
 *  - EXTEND, never parallel. Durable grants are ordinary `tool_approvals` rows
 *    (migration 0004 — `migrations/0004_gateway_core.sql:66-79`), NOT a new
 *    table. We namespace `tool_name` — `ritual:<id>` for the content grant and
 *    `ritual-egress:<id>` for the separately-approved egress capability. Both the
 *    ritual id charset (`RITUAL_ID_RE`) and tool tokens forbid `:`, so these
 *    namespaces never collide with a real tool grant. The row's
 *    `(status='approved', decided_by, decided_at)` IS the
 *    `(ritual_id, content_hash, approved_by, approved_at)` record the header asks
 *    for; `args_json.content_hash` carries the binding.
 *
 *  - CADENCE-IN-HASH is the chosen re-approval arm (deepened header): the cadence
 *    string is a hash input, so a cadence change (weekly → `* * * * *`) drops the
 *    grant and forces re-approval. No hard floor / daily fire cap in v1.
 *    `reminders_update` is atomic cancel+create and mints a NEW ritual id
 *    (`cores/free/reminders/src/mcp-tools-extra.ts:64`), so an update ALSO drops
 *    approval by construction — the two arms compound.
 *
 *  - RE-VERIFIED AT EVERY FIRE. `createRitualApprovalCheck().isApproved` recomputes
 *    the hash from the LIVE prompt bytes on every call (no caching) — ported Vajra
 *    prompts are mutable files, and a scheduled actor's risk is in fire #500, not
 *    fire #1.
 *
 *  - EGRESS IS A SEPARATE CAPABILITY CLASS. A `egress:'web'` ritual (WebSearch /
 *    WebFetch — an exfiltration channel) requires a SECOND approved grant under
 *    `ritual-egress:<id>` bound to the SAME content_hash. Approving the content
 *    does not implicitly approve egress.
 *
 *  - NO auto-approval anywhere. `requestRitualApproval` always submits
 *    policy `'prompt-user'`; there is no `policy:'auto'` path and no
 *    pre-approved bundled ritual. Approval is an explicit affirmative act
 *    (`respondApproval`), never inferred from silence — the no-self-approval
 *    enforcement (`resolution_speaker_user_id` binding) arrives with task 8's
 *    ButtonStore surface.
 *
 * Layering: this module lives in `reminders` (services) and imports
 * `@neutronai/tools` (platform) — a legal services→platform edge. The generic
 * `ApprovalManager.findApproved` query knows nothing about rituals; ALL
 * ritual-specific logic lives here, so `.dependency-cruiser.cjs`'s
 * `platform-stays-low` (tools must not import reminders) holds.
 */

import { createHash } from 'node:crypto'
import type {
  ApprovalDecision,
  ApprovalManager,
} from '@neutronai/tools/approval.ts'
import {
  RITUAL_MODEL_TIER,
  RITUAL_TIMEOUT_MS,
  type RitualApprovalCheck,
  type RitualDef,
} from './rituals.ts'

/**
 * The exact tuple bound into a ritual approval. A change in ANY field
 * invalidates the grant (the header's "bind approval to a CONTENT HASH of
 * (prompt bytes ‖ tool surface ‖ scope root ‖ cadence ‖ model tier ‖ timeout)").
 */
export interface RitualContentHashInput {
  /** The LIVE prompt file bytes at hash time (mutable after approval). */
  prompt: string
  /** The granted tool surface — order-insensitive (sorted before hashing). */
  tool_surface: readonly string[]
  /** cwd + write-containment root class ('project' | 'instance'). */
  scope: string
  /** Canonical cadence string ({@link ritualCadenceString}). */
  cadence: string
  /** Model tier ({@link RITUAL_MODEL_TIER}). */
  model_tier: string
  /** Spawn timeout ({@link RITUAL_TIMEOUT_MS}). */
  timeout_ms: number
}

/**
 * SHA-256 hex digest over a canonical JSON ARRAY of the six binding fields.
 * A JSON array (not a delimiter-joined string) is delimiter-injection-proof —
 * no field's contents can forge a boundary. `tool_surface` is sorted so grant
 * order does not matter; every other field is positional.
 */
export function computeRitualContentHash(input: RitualContentHashInput): string {
  const canonical = JSON.stringify([
    input.prompt,
    [...input.tool_surface].sort(),
    input.scope,
    input.cadence,
    input.model_tier,
    input.timeout_ms,
  ])
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * The canonical cadence string for a reminder row. `recurrence_spec` and
 * `recurrence` are mutually exclusive (`reminders/store.ts:41-49`):
 *   - `recurrence_spec` set → `spec:<cron>` (e.g. `spec:0 9 * * *`)
 *   - else `recurrence` set → `legacy:<coarse>` (e.g. `legacy:weekly`)
 *   - else → `once`
 * Task 4's tick calls this with the live row before building the checker.
 */
export function ritualCadenceString(row: {
  recurrence: string | null
  recurrence_spec: string | null
}): string {
  if (row.recurrence_spec !== null) return `spec:${row.recurrence_spec}`
  if (row.recurrence !== null) return `legacy:${row.recurrence}`
  return 'once'
}

/** The `tool_approvals.tool_name` for a ritual's CONTENT grant. */
export function ritualApprovalToolName(id: string): string {
  return `ritual:${id}`
}

/** The `tool_approvals.tool_name` for a ritual's EGRESS grant (web defs only). */
export function ritualEgressApprovalToolName(id: string): string {
  return `ritual-egress:${id}`
}

/**
 * The result of submitting a ritual approval request. `content` resolves when
 * the owner decides the content grant; `egress` (present only for `egress:'web'`
 * defs) resolves when the owner decides the egress grant. Neither is awaited by
 * `requestRitualApproval` — the caller (task 8's UX) surfaces the prompts and
 * awaits at its own pace.
 */
export interface RitualApprovalRequestResult {
  content_hash: string
  content: Promise<ApprovalDecision>
  egress?: Promise<ApprovalDecision>
}

/**
 * Submit an approval request for a ritual. Computes the content hash from the
 * def surface/scope + the supplied prompt + cadence + the tier/timeout
 * constants, then submits a `prompt-user` request under `ritual:<id>` carrying
 * that hash. For `egress:'web'` defs, submits a SECOND `prompt-user` request
 * under `ritual-egress:<id>` bound to the SAME hash — approving the content
 * never implicitly approves egress. Returns both decision promises WITHOUT
 * awaiting them (fire the prompts, resolve later).
 */
export function requestRitualApproval(
  manager: ApprovalManager,
  opts: {
    project_slug: string
    topic_id: string | null
    def: RitualDef
    prompt: string
    cadence: string
  },
): RitualApprovalRequestResult {
  const { project_slug, topic_id, def, prompt, cadence } = opts
  const content_hash = computeRitualContentHash({
    prompt,
    tool_surface: def.tool_surface,
    scope: def.scope,
    cadence,
    model_tier: RITUAL_MODEL_TIER,
    timeout_ms: RITUAL_TIMEOUT_MS,
  })

  const content = manager.requestApproval({
    project_slug,
    topic_id,
    tool_name: ritualApprovalToolName(def.id),
    policy: 'prompt-user',
    args: {
      ritual_id: def.id,
      content_hash,
      capability: 'fire',
      description: def.description,
      tool_surface: [...def.tool_surface],
      scope: def.scope,
      egress: def.egress,
      cadence,
      model_tier: RITUAL_MODEL_TIER,
      timeout_ms: RITUAL_TIMEOUT_MS,
    },
  })

  if (def.egress === 'web') {
    const egress = manager.requestApproval({
      project_slug,
      topic_id,
      tool_name: ritualEgressApprovalToolName(def.id),
      policy: 'prompt-user',
      args: {
        ritual_id: def.id,
        content_hash,
        capability: 'egress',
      },
    })
    return { content_hash, content, egress }
  }

  return { content_hash, content }
}

/**
 * Build the {@link RitualApprovalCheck} the fire-time validator
 * (`validateRitualFire`) consumes. `cadence` is closed over here (task 4 derives
 * it from the live row via {@link ritualCadenceString}), so the seam signature
 * `isApproved(def, promptBytes)` stays unchanged.
 *
 * `isApproved` RECOMPUTES the hash from the live prompt bytes on EVERY call
 * (no caching), then requires a matching approved `ritual:<id>` row and — for
 * `egress:'web'` defs — a matching approved `ritual-egress:<id>` row. A malformed
 * `args_json` row is skipped (never a match, never a throw). Manager / DB errors
 * PROPAGATE — `validateRitualFire` converts the throw into a fail-closed
 * 'unapproved' skip, so a broken approval store never fires a ritual.
 */
export function createRitualApprovalCheck(opts: {
  manager: ApprovalManager
  project_slug: string
  cadence: string
}): RitualApprovalCheck {
  const { manager, project_slug, cadence } = opts
  return {
    isApproved(def: RitualDef, promptBytes: string): boolean {
      const hash = computeRitualContentHash({
        prompt: promptBytes,
        tool_surface: def.tool_surface,
        scope: def.scope,
        cadence,
        model_tier: RITUAL_MODEL_TIER,
        timeout_ms: RITUAL_TIMEOUT_MS,
      })

      const matchesHash = (tool_name: string): boolean => {
        for (const row of manager.findApproved(project_slug, tool_name)) {
          try {
            const parsed = JSON.parse(row.args_json) as { content_hash?: unknown }
            if (parsed.content_hash === hash) return true
          } catch {
            // A malformed args_json row is NOT a match — never crash the fire.
          }
        }
        return false
      }

      const contentOk = matchesHash(ritualApprovalToolName(def.id))
      if (!contentOk) return false
      if (def.egress === 'web') {
        return matchesHash(ritualEgressApprovalToolName(def.id))
      }
      return true
    },
  }
}
