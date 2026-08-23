/**
 * @neutronai/open — the STANDING DEPLOY WINDOW: one owner tap that authorises
 * deploys of one ref for a bounded stretch of time, instead of one tap per sha.
 *
 * WHY THIS EXISTS. `open/host-deploy.ts` binds every approval to exactly one
 * sha, and that binding is load-bearing (rule 3 of that file): "approve" must
 * never quietly mean "deploy whatever is newest". The cost is that a night of
 * merges is a night of round trips — the owner taps, the ref moves, the next
 * merge needs another tap — and in practice the deploys simply do not happen:
 * the box ran six commits behind for a day, twice, because the agent could not
 * proceed and the owner was asleep.
 *
 * SO THE PERMISSION IS WIDENED DELIBERATELY, ONCE, WITH A CLOCK ON IT. A window
 * is the owner saying "for the next N hours, deploy this ref without asking".
 * That IS the unbounded permission the sha-binding exists to prevent, which is
 * why every part of this file is about keeping it bounded and visible:
 *
 *  1. IT IS ITSELF AN APPROVAL. A window is a `tool_approvals` row under its own
 *     `tool_name`, raised as the same code-rendered Approve/Deny prompt, decided
 *     by the same owner-only affirmative act, carrying the same opaque-token
 *     discipline. There is no second consent mechanism, and no way to open a
 *     window except by the owner tapping one open.
 *  2. IT EXPIRES ON A WALL CLOCK, WRITTEN INTO THE ROW AT GRANT TIME. Liveness
 *     is `now < expires_at_ms` read from the row — never a duration recomputed
 *     from something mutable, and never extended by use. A window cannot be
 *     renewed silently; renewal is another tap.
 *  3. IT IS BOUNDED AT BOTH ENDS. {@link HOST_DEPLOY_WINDOW_MIN_HOURS} to
 *     {@link HOST_DEPLOY_WINDOW_MAX_HOURS}. There is no "forever" and no way to
 *     ask for one — an unbounded window is indistinguishable from removing the
 *     gate, and the gate is the product.
 *  4. IT NAMES ONE REF. A window for `origin/main` authorises nothing about any
 *     other ref, and the prompt says in plain words that ANY commit reaching
 *     that ref during the window may deploy without a further tap — because that
 *     is precisely what is being granted and the owner must read it before he
 *     agrees to it.
 *  5. EVERY DEPLOY IT AUTHORISES ANNOUNCES ITSELF. An auto-approved deploy posts
 *     what went out and when the window closes. A permission whose exercise is
 *     silent is a permission the owner cannot audit, and "I did not notice it
 *     deploying" must never be a thing this makes possible.
 *  6. IT IS REVOCABLE IN ONE MOVE, and revocation is immediate — the next
 *     request finds no live window and goes back to asking per sha.
 *
 * WHAT IT DOES NOT DO. It does not touch the host's own contract gate: the
 * control plane still runs the full suite before it bumps anything, and still
 * refuses on its own terms. A window removes the owner's tap, not the machine's
 * checks.
 */

import type { ButtonOption } from '@neutronai/channels/button-primitive.ts'
import type { ApprovalRow } from '@neutronai/tools/approval.ts'

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * The `tool_approvals.tool_name` namespace for a standing window. DISTINCT from
 * `host-deploy`, and deliberately so: `sweepExpiredGrants()` scans by tool name
 * and expires anything `pending` past five minutes. A window shares the row
 * table but must never share that sweep — the five-minute TTL belongs to the
 * GRANT PROMPT, and a granted window whose whole point is to outlive it would be
 * killed within the minute.
 */
export const HOST_DEPLOY_WINDOW_TOOL_NAME = 'host-deploy-window' as const

/**
 * Button-token prefix. `hdp:` is a single deploy, `hdw:` opens a window; the two
 * decode through the same strict codec and can never be mistaken for each other,
 * so a tap on a stale single-deploy button can never open a window and a tap on
 * a stale window button can never deploy a sha.
 */
export const HOST_DEPLOY_WINDOW_VALUE_PREFIX = 'hdw:' as const

/** Exact shape of a window button value. Anything else is not ours. */
export const HOST_DEPLOY_WINDOW_VALUE_RE = /^hdw:[A-Za-z0-9_-]{22}:(a|d)$/

/**
 * The floor and ceiling on a window, in hours.
 *
 * The ceiling is the substantive one: 72 hours covers "I am away for the
 * weekend", which is the case that motivated this, and stops well short of the
 * standing permission that would make the gate ceremonial. A request outside the
 * range is REFUSED with the range named — never silently clamped, because a
 * clamp means the owner approves a body saying one duration while the row holds
 * another, and the body is the thing he consented to.
 */
export const HOST_DEPLOY_WINDOW_MIN_HOURS = 1
export const HOST_DEPLOY_WINDOW_MAX_HOURS = 72

/** Milliseconds per hour, named so the arithmetic below reads as intent. */
const HOUR_MS = 60 * 60_000

// ── The row payload ──────────────────────────────────────────────────────────

/** The `tool_approvals.args_json` payload for a window grant. */
export interface HostDeployWindowArgs {
  ref?: unknown
  /** Absolute wall-clock expiry, ms since epoch, fixed at GRANT time. */
  expires_at_ms?: unknown
  /** What the owner was shown, kept so a report can restate it exactly. */
  hours?: unknown
  /** Rendered by the notifier as the "an approval is waiting" one-liner. */
  description?: unknown
  /** The `button_prompts` row this grant was rendered as. */
  prompt_id?: unknown
  /**
   * EVERY DEPLOY THIS GRANT AUTHORISED, appended as it happens. The audit half
   * of the feature: a deploy nobody tapped has no other durable record of WHICH
   * permission allowed it, so the permission carries the record itself.
   */
  uses?: unknown
}

/** Read a window row's stored arguments. A row that will not parse reads empty. */
export function parseWindowArgs(args_json: string): HostDeployWindowArgs {
  try {
    return (JSON.parse(args_json) as HostDeployWindowArgs | null) ?? {}
  } catch {
    return {}
  }
}

/** A window as the rest of the system consumes it. */
export interface HostDeployWindow {
  /** The approval row id — the handle for revocation. */
  id: string
  ref: string
  expires_at_ms: number
  /** The duration the owner actually approved, for restating it. */
  hours: number
}

/**
 * Is this row a LIVE window for `ref` right now?
 *
 * FAIL-CLOSED ON EVERY AXIS. A row that is not `approved`, not for this ref, or
 * whose expiry is absent, unparseable, non-finite or in the past is not a
 * window. There is no default duration and no "assume live" branch: a window
 * that cannot prove it is open is closed, and the caller falls back to asking
 * per sha — the pre-existing, safe behaviour.
 */
export function readLiveWindow(
  row: ApprovalRow,
  ref: string,
  now_ms: number,
): HostDeployWindow | null {
  if (row.status !== 'approved') return null
  if (row.tool_name !== HOST_DEPLOY_WINDOW_TOOL_NAME) return null
  const args = parseWindowArgs(row.args_json)
  if (typeof args.ref !== 'string' || args.ref !== ref) return null
  const expires = args.expires_at_ms
  if (typeof expires !== 'number' || !Number.isFinite(expires)) return null
  if (now_ms >= expires) return null
  const hours = typeof args.hours === 'number' && Number.isFinite(args.hours) ? args.hours : 0
  return { id: row.id, ref, expires_at_ms: expires, hours }
}

/**
 * The one live window for `ref`, or null. When several are somehow live at once
 * — two grants tapped open in the same stretch — the LATEST expiry wins, since
 * that is the permission the owner most recently gave and the one he would
 * expect to be in force. Revocation closes them all, so the choice here can
 * never leave a straggler open.
 */
export function pickLiveWindow(
  rows: readonly ApprovalRow[],
  ref: string,
  now_ms: number,
): HostDeployWindow | null {
  let best: HostDeployWindow | null = null
  for (const row of rows) {
    const w = readLiveWindow(row, ref, now_ms)
    if (w === null) continue
    if (best === null || w.expires_at_ms > best.expires_at_ms) best = w
  }
  return best
}

/** Validated hours, or the refusal reason naming the range. */
export function validateWindowHours(hours: unknown): { hours: number } | { reason: string } {
  if (typeof hours !== 'number' || !Number.isFinite(hours)) {
    return {
      reason:
        `a deploy window needs a number of hours between ${HOST_DEPLOY_WINDOW_MIN_HOURS} ` +
        `and ${HOST_DEPLOY_WINDOW_MAX_HOURS}`,
    }
  }
  // Whole hours only. A fractional window renders as "3.5 hours" in one place
  // and "3 hours" in another the moment anything rounds for display, and the
  // body the owner reads must be the duration the row holds.
  if (!Number.isInteger(hours)) {
    return { reason: `a deploy window is a whole number of hours (asked for ${hours})` }
  }
  if (hours < HOST_DEPLOY_WINDOW_MIN_HOURS || hours > HOST_DEPLOY_WINDOW_MAX_HOURS) {
    return {
      reason:
        `${hours} is outside the allowed deploy-window range of ` +
        `${HOST_DEPLOY_WINDOW_MIN_HOURS}-${HOST_DEPLOY_WINDOW_MAX_HOURS} hours — nothing was requested`,
    }
  }
  return { hours }
}

/** Absolute expiry for a window of `hours` granted at `now_ms`. */
export function windowExpiryMs(now_ms: number, hours: number): number {
  return now_ms + hours * HOUR_MS
}

/**
 * "in 3 hours" / "in 2 days, 4 hours" — the remaining life of a window, for the
 * sentence that reports an auto-approved deploy. Always rounds DOWN to the unit
 * shown, so it can never overstate how long the permission has left.
 */
export function describeRemaining(expires_at_ms: number, now_ms: number): string {
  const ms = expires_at_ms - now_ms
  if (ms <= 0) return 'now'
  const total_minutes = Math.floor(ms / 60_000)
  const days = Math.floor(total_minutes / (60 * 24))
  const hours = Math.floor((total_minutes - days * 60 * 24) / 60)
  const minutes = total_minutes - days * 60 * 24 - hours * 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`)
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`)
  if (parts.length === 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`)
  return parts.join(', ')
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * The body of the window-grant prompt.
 *
 * IT MUST SAY WHAT IS BEING GIVEN UP, not just what is being gained. The whole
 * risk of this feature is an owner who reads "deploy window" as "deploy the
 * commits I just looked at" — so the body states, in its own line, that any
 * commit reaching the ref during the window deploys without a further tap, and
 * that a deploy restarts the instance. No commit list is rendered here on
 * purpose: there is none to render, because the commits this authorises have not
 * been written yet, and showing today's list would imply a binding that does not
 * exist.
 */
export function renderWindowApprovalBody(input: {
  ref: string
  hours: number
  expires_at_ms: number
  now_ms: number
  approve_value: string
  deny_value: string
}): string {
  const { ref, hours, expires_at_ms, now_ms, approve_value, deny_value } = input
  const until = new Date(expires_at_ms).toISOString().replace('T', ' ').slice(0, 16)
  return [
    `**Deploy without asking, for ${hours} hour${hours === 1 ? '' : 's'}?**`,
    '',
    `Ref: \`${ref}\``,
    `Window closes: ${until} UTC (${describeRemaining(expires_at_ms, now_ms)} from now)`,
    '',
    `While this window is open, **any commit that reaches \`${ref}\` can be deployed to this host ` +
      'without a further tap from you** — including commits nobody has written yet. Each deploy ' +
      'restarts the instance, and each one posts here saying what went out.',
    '',
    'The host still runs its own contract gate on every deploy and can still refuse. ' +
      'You can close the window at any time.',
    '',
    `Approve: \`${approve_value}\``,
    `Deny: \`${deny_value}\``,
  ].join('\n')
}

/** The Approve/Deny pair for a window grant. */
export function windowApprovalOptions(
  approve_value: string,
  deny_value: string,
): ButtonOption[] {
  return [
    {
      label: 'Open window',
      body: 'Allow deploys without asking for the stated window',
      value: approve_value,
    },
    { label: 'Deny', body: 'Do not open a deploy window', value: deny_value },
  ]
}

/**
 * The sentence an auto-approved deploy posts to the topic. This is the ONLY
 * record the owner gets of a deploy he did not tap, so it names the ref, the
 * sha, how many commits went, and how long the permission has left to run.
 */
export function renderAutoDeployNotice(input: {
  ref: string
  sha: string
  commit_count: number
  expires_at_ms: number
  now_ms: number
  detail: string
}): string {
  const { ref, sha, commit_count, expires_at_ms, now_ms, detail } = input
  return (
    `Deployed **${ref}** at \`${sha.slice(0, 8)}\` ` +
    `(${commit_count} commit${commit_count === 1 ? '' : 's'}) under your standing deploy window — ` +
    `no tap needed. ${detail}\n\n` +
    `The window closes in ${describeRemaining(expires_at_ms, now_ms)}; after that deploys go back to ` +
    'asking per sha. Say the word and I will close it now.'
  )
}
