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
 * NOT BEFORE ONBOARDING COMPLETES. These prompts are owner-facing chat messages
 * on the General topic, emitted with durability 'reply' — each one becomes the
 * topic's ACTIVE prompt. Fired on a brand-new instance they would (a) make the
 * owner's very first screen four ritual approval walls instead of the welcome
 * opener, and (b) capture his next message as an answer to a ritual approval
 * instead of an onboarding answer. So the sweep waits for a terminal
 * `onboarding_state`; on the first boot after onboarding completes it runs
 * exactly as described above. (Found by `tests/integration/
 * onboarding-welcome-seed-once.open.test.ts` + the `last_seen_seq:0` fresh-topic
 * assertion in `open/__tests__/open-app-ws-durable-chatlog.test.ts`, which an
 * ungated first draft of this sweep broke — the durable rows made a "fresh"
 * topic non-empty.)
 *
 * FAIL-SOFT. Every per-ritual failure is caught and logged; the sweep continues
 * to the next id and always resolves. Nothing here can block or crash boot (the
 * `seedBundledRituals` contract). A failed enable rolls its own def.json back
 * inside `enable()`, so the NEXT boot simply retries. A GATE read that throws is
 * treated as "still onboarding" — fail-closed, because a spurious prompt storm
 * over a live onboarding is worse than one more restart's delay.
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
  /**
   * Ids already enabled AND still holding a usable approval state (approved,
   * pending, or deliberately denied) — NOT re-prompted.
   */
  already_enabled: string[]
  /**
   * Ids already enabled whose LIVE content hash had NO grant, so a fresh approval
   * prompt was emitted (ISSUES #504). This is the state that used to be silent: a
   * def.json made the sweep skip the ritual while every fire refused 'unapproved'.
   */
  reapproved: string[]
  /** Ids whose enable failed (logged, rolled back by `enable()`, retried next boot). */
  failed: string[]
  /**
   * True when the whole sweep was deferred because the owner is still
   * onboarding. Nothing was written, nothing was prompted; the next boot after
   * onboarding reaches a terminal state runs it.
   */
  deferred_onboarding: boolean
}

export interface EnableBundledRitualsInput {
  /** The registration service built over the graph's ApprovalManager. */
  service: Pick<RitualRegistrationService, 'enable' | 'reapprove' | 'status'>
  /** The registry the bundled defs were registered into. */
  registry: RitualRegistry
  /** `<owner_home>/rituals` — where `<id>.def.json` lives. */
  rituals_dir: string
  /** The owner's IANA zone; the caller resolves it and its fallback. */
  time_zone: string
  /**
   * "Is the owner STILL onboarding?" — the composer's single onboarding-active
   * predicate. `true` (or a throw) defers the whole sweep; see the file header.
   */
  is_onboarding_active: () => Promise<boolean>
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
  const result: EnableBundledRitualsResult = {
    enabled: [],
    already_enabled: [],
    reapproved: [],
    failed: [],
    deferred_onboarding: false,
  }

  // THE ONBOARDING GATE. Fail-CLOSED: a throwing read defers rather than
  // prompting, because a prompt storm over a live onboarding is worse than
  // waiting for the next restart.
  let onboarding_active: boolean
  try {
    onboarding_active = await input.is_onboarding_active()
  } catch (err) {
    onboarding_active = true
    log(`enableBundledRituals: onboarding check failed, deferring: ${(err as Error).message}`)
  }
  if (onboarding_active) {
    result.deferred_onboarding = true
    log('enableBundledRituals: owner is still onboarding — deferred to the next boot')
    return result
  }

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
      // enabled once. Re-prompting on every restart is exactly the noise this must
      // never produce — but "already enabled" is NOT the same as "still approvable",
      // and conflating them made rituals die silently (ISSUES #504).
      //
      // The approval grant is bound to a CONTENT HASH (prompt bytes ‖ tool surface ‖
      // scope ‖ cadence ‖ tier ‖ timeout). Anything that moves that hash correctly
      // drops approval — an owner editing `<id>.md`, or a change to a hashed
      // constant. Before this, such a ritual had a def.json (so the sweep skipped
      // it) and no valid grant (so every fire refused 'unapproved'): no prompt, no
      // brief, and nothing the owner could see. `status()` recomputes approval
      // against the LIVE bytes, so it distinguishes the four states, and only
      // 'none' — no grant for the live hash, nothing pending, nothing denied —
      // earns a fresh prompt.
      //
      // 'pending' is left alone (the prompt is already in front of him) and
      // 'denied' STAYS denied (re-asking a ritual the owner declined would be the
      // sweep arguing with him).
      if (existsSync(join(rituals_dir, `${def.id}.def.json`))) {
        const approval = service.status().find((r) => r.ritual_id === def.id)?.approval ?? 'none'
        if (approval !== 'none') {
          result.already_enabled.push(def.id)
          continue
        }
        await service.reapprove(def.id)
        result.reapproved.push(def.id)
        log(`enableBundledRituals: ${def.id} approval is stale — re-requested`)
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
