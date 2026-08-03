/**
 * @neutronai/reminders — BOOT ENABLE of the bundled rituals.
 *
 * THE DEFECT THIS CLOSES. Three rituals ship bundled (`morning-brief`,
 * `evening-wrap`, `kaizen`). At boot the composer seeds their templates
 * copy-if-absent and calls {@link registerBundledRituals}, which makes them
 * KNOWN to the registry — and that is where it stopped. Registration is not
 * approval, and nothing ever REQUESTED approval for them:
 * `requestApprovalAndEmit` (`ritual-registration.ts`) is reached only from
 * `propose()` (agent-authored rituals) and `enable()` (which nothing at boot
 * called). An unapproved ritual can never fire, so the owner's ritual layer was
 * inert on every install — and, worse, it read as "awaiting your approval" when
 * no approvable prompt had ever been emitted. There was no path at all, for
 * anyone, to turn a bundled ritual on.
 *
 * WHAT THIS DOES. At boot, for each bundled def that is registered but has NO
 * persisted `<id>.def.json`, it calls the EXISTING
 * {@link RitualRegistrationService.enable} with a default schedule. `enable()`
 * is already designed for exactly this case: `register:false` (the bundled def
 * is registered already), it writes ONLY the `<id>.def.json`, requests the
 * content-hash-bound grant(s), and emits the CODE-rendered approval prompt the
 * owner taps.
 *
 * WHAT THIS DOES NOT DO — and must never do. It does NOT approve anything. No
 * grant is written, no approval check is weakened, and the ritual stays
 * UNAPPROVED (and therefore unschedulable and unfireable) until the owner's
 * affirmative tap. This fixes REACHABILITY, not consent
 * (`ritual-approval.ts`: "NO auto-approval anywhere").
 *
 * IDEMPOTENCY. Boot happens constantly, so each ritual must be prompted AT MOST
 * ONCE. `<id>.def.json` is the durable "already enabled" marker and the guard is
 * layered: this module skips an id whose def.json exists, `enable()` itself
 * refuses one with `already_enabled`, and its write uses `flag:'wx'`. A denied
 * ritual keeps its def.json and is therefore never re-prompted either — a
 * decline stays declined across reboots.
 *
 * FAIL-SOFT. Every per-ritual failure is caught and logged; the sweep continues
 * to the next id and always resolves. Nothing here can block or crash boot (the
 * `seedBundledRituals` contract). A failed enable rolls its own def.json back
 * inside `enable()`, so the NEXT boot simply retries.
 *
 * SCHEDULE. Cron (`recurrence_spec`), not a coarse label: cron is wall-clock
 * anchored and DST-correct in the owner's zone, so "07:00" stays 07:00 across a
 * DST boundary, whereas a coarse label is a timezone-agnostic fixed delta. Only
 * the FIRST `fire_at` is resolved here; from the first fire on, the tick loop
 * recomputes each next occurrence against the zone read fresh at fire time
 * (`tick.ts` `computeNextFire` / `resolve_time_zone`), so a zone the owner's
 * client reports after boot self-corrects without a restart.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { nextCronFireFromExpression } from '@neutronai/cron'

import { BUNDLED_RITUAL_DEFS } from './bundled-rituals.ts'
import {
  RitualProposalError,
  type RitualRegistrationService,
} from './ritual-registration.ts'
import type { RitualRegistry } from './rituals.ts'

/**
 * The default cadence for each bundled ritual, as a 5-field cron resolved in the
 * OWNER's timezone. Daily for the two book-end briefs, weekly for the
 * improvement pass. These are DEFAULTS the owner sees spelled out in the
 * approval prompt before deciding — nothing runs on them until he taps Approve.
 *
 * Keyed by ritual id; an id absent here is left alone (a bundled def with no
 * stated default is not something this sweep should invent a schedule for).
 */
export const BUNDLED_RITUAL_DEFAULT_CRONS: Readonly<Record<string, string>> = Object.freeze({
  /** Daily, early morning — the start-of-day brief. */
  'morning-brief': '0 7 * * *',
  /** Daily, evening — the end-of-day wrap. */
  'evening-wrap': '0 21 * * *',
  /** Weekly, Sunday evening — the improvement pass. */
  kaizen: '0 17 * * 0',
})

/** Per-id outcome of one {@link enableBundledRitualsAtBoot} sweep. */
export interface EnableBundledRitualsResult {
  /** Ids newly enabled — a def.json was written and an approval prompt emitted. */
  enabled: string[]
  /** Ids that already had a `<id>.def.json` — NOT re-prompted. */
  already_enabled: string[]
  /** Ids whose enable failed (logged, rolled back by `enable()`, retried next boot). */
  failed: string[]
}

export interface EnableBundledRitualsInput {
  /** The registration service built over the graph's ApprovalManager. */
  service: Pick<RitualRegistrationService, 'enable'>
  /** The registry the bundled defs were registered into. */
  registry: RitualRegistry
  /** `<owner_home>/rituals` — where `<id>.def.json` lives. */
  rituals_dir: string
  /** The owner's IANA zone; the caller resolves it and its fallback. */
  time_zone: string
  /** Clock seam (epoch ms). Defaults to `Date.now`. */
  now?: () => number
  /** Structured-log sink. Never throws out of the sweep. */
  log?: (msg: string) => void
}

/**
 * Enable every bundled ritual that has never been enabled, so its approval
 * prompt actually reaches the owner. Idempotent, fail-soft, and NEVER approves.
 * Resolves with the per-id outcome (returned for tests + the boot log; the
 * composer treats it as fire-and-forget).
 */
export async function enableBundledRitualsAtBoot(
  input: EnableBundledRitualsInput,
): Promise<EnableBundledRitualsResult> {
  const { service, registry, rituals_dir, time_zone } = input
  const now = input.now ?? ((): number => Date.now())
  const log = input.log ?? ((): void => undefined)
  const result: EnableBundledRitualsResult = { enabled: [], already_enabled: [], failed: [] }

  for (const def of BUNDLED_RITUAL_DEFS) {
    const cron = BUNDLED_RITUAL_DEFAULT_CRONS[def.id]
    if (cron === undefined) continue
    try {
      // Only ever act on a def this boot actually registered. A missing one is a
      // seeding/registration failure that has already been logged upstream.
      if (registry.get(def.id) === undefined) {
        result.failed.push(def.id)
        log(`enableBundledRituals: ${def.id} is not registered — skipped`)
        continue
      }

      // THE IDEMPOTENCY GUARD. `<id>.def.json` means the ritual has already been
      // enabled once: its approval prompt was emitted and is pending, approved,
      // or declined. Re-prompting on every restart is exactly the noise this
      // must never produce, so an existing def.json ends the work for this id.
      if (existsSync(join(rituals_dir, `${def.id}.def.json`))) {
        result.already_enabled.push(def.id)
        continue
      }

      const fire_at = Math.floor(nextCronFireFromExpression(cron, now(), time_zone) / 1000)
      await service.enable({ id: def.id, schedule: { fire_at, recurrence_spec: cron } })
      result.enabled.push(def.id)
      log(`enableBundledRituals: ${def.id} enabled, awaiting owner approval (cron ${cron})`)
    } catch (err) {
      // A concurrent/duplicate enable is the idempotent outcome, not a failure:
      // `enable()`'s own `already_enabled` guard fired between our check and the
      // write. Everything else is a real failure — logged, never fatal, retried
      // on the next boot (enable() already rolled its def.json back).
      if (err instanceof RitualProposalError && err.code === 'already_enabled') {
        result.already_enabled.push(def.id)
        continue
      }
      result.failed.push(def.id)
      log(`enableBundledRituals: ${def.id} failed: ${(err as Error).message}`)
    }
  }

  return result
}
