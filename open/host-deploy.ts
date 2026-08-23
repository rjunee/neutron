/**
 * @neutronai/open — owner-approved deploy of the HOST this instance runs on.
 *
 * THE SHAPE: A REQUEST CROSSES THE PRIVILEGE BOUNDARY, A CAPABILITY NEVER DOES.
 * The instance gains no deploy rights, no host filesystem access and no
 * privileged credential. It gains the ability to ASK. The answer is a human's
 * explicit affirmative act, so asking is not an escalation.
 *
 * WHY THIS EXISTS. Work merged into Open does not reach the box the owner is
 * actually using, and NOTHING on that box deploys on its own — the host's only
 * timers are a lane sweeper, a credential rotator, a CLI update doctor and a
 * backup. A deploy happens when a human runs one. That total absence looks
 * exactly like "deploys land on their own and just lag" from the inside, which
 * is how it went unnoticed. This module gives the agent one thing: a way to put
 * the deploy in front of the owner with the actual commit list attached.
 *
 * SECOND CALLER, NOT A NEW SUBSYSTEM. Everything here rides the approval path
 * that already exists:
 *   - `ApprovalManager` (`tools/approval.ts`), composed at
 *     `gateway/composition/build-core-modules.ts:277` from the composer's
 *     `approval_notifier`, persists the request into `tool_approvals`
 *     (migration 0004) and fires the notifier on every `prompt-user` request.
 *   - `open/wiring/approval-notifier.ts` broadcasts the "an approval is waiting"
 *     push to every live app-ws topic.
 *   - The rich, itemized, CODE-rendered prompt with Approve/Deny buttons and the
 *     affirmative-act binding is the `reminders/ritual-registration.ts:768-806`
 *     shape, reproduced here for a deploy. Same opaque-token discipline, same
 *     `prior_option_values` eligibility rule, same owner-only gate.
 * There is NO parallel approval mechanism in this file.
 *
 * THE SEVEN THINGS THIS FILE IS RESPONSIBLE FOR
 *
 *  1. IT NEVER DEPLOYS ON REQUEST. `request()` resolves what WOULD be deployed,
 *     raises an approval, and returns `pending_approval`. Nothing is dispatched.
 *  2. THE APPROVAL RENDERS THE ACTUAL COMMIT LIST — the current pin, the target
 *     sha, and the commits between them. An approval whose content the approver
 *     cannot see is a rubber stamp with extra steps.
 *  3. THE APPROVAL BINDS TO A SPECIFIC SHA. The target is RE-RESOLVED at approve
 *     time; if it moved, the approval is STALE and is refused with the new sha
 *     named. Otherwise "approve" quietly means "deploy whatever is newest when
 *     this runs", which is a different and unbounded permission.
 *  4. APPROVAL IS AN EXPLICIT AFFIRMATIVE ACT by the OWNER. Only an exact opaque
 *     token that was a real offered button on a recent prompt is eligible, and
 *     only from `owner_user_id`. Silence, a timeout, "yes", a paraphrase, an
 *     unrelated reply, or any non-owner speaker (the agent included) can never
 *     flip the row — so an agent can never approve its own request.
 *  5. THE OUTCOME POSTS BACK TO THE SAME CHAT — success with what landed,
 *     failure with why. A REFUSED contract gate is a NORMAL outcome and reads as
 *     one sentence, not as a crash.
 *  6. NO CONTROL PLANE CONFIGURED → VISIBLE AND DISABLED WITH A REASON. A
 *     self-hoster has no endpoint to call; the capability still answers, naming
 *     the Settings fields that would enable it. It is never hidden and never invents a
 *     default endpoint.
 *  7. THE ENDPOINT AND CREDENTIAL ARE RESOLVED AT CALL TIME, never captured at
 *     composition time — a credential read at composition time is a credential
 *     that is never there (Decisions Log 2026-08-07). Neither ever enters a
 *     prompt. The credential is scrubbed from every control-plane detail before
 *     it is shown or logged; the non-secret URL remains useful diagnostic context.
 */

import type { ButtonOption } from '@neutronai/channels/button-primitive.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import type { ApprovalManager } from '@neutronai/tools/approval.ts'
import { PROJECT_CREDENTIAL_MIN_SECRET_CHARS } from '@neutronai/project-credentials/store.ts'
// The opaque approval-token codec, reused verbatim from the ritual approval
// surface (`reminders/ritual-registration.ts:110-137`) rather than re-derived:
// it is a STRICT inverse pair (a malformed/forged token can never decode to a
// live row) and a second private copy of that property is a second place for it
// to be wrong. Only the PREFIX differs — `hdp:` here, `rap:` there.
import { tokenToUuid, uuidToToken } from '@neutronai/reminders/index.ts'
import {
  describeRemaining,
  HOST_DEPLOY_WINDOW_TOOL_NAME,
  HOST_DEPLOY_WINDOW_VALUE_PREFIX,
  HOST_DEPLOY_WINDOW_VALUE_RE,
  parseWindowArgs,
  pickLiveWindow,
  readLiveWindow,
  renderAutoDeployNotice,
  renderWindowApprovalBody,
  validateWindowHours,
  windowApprovalOptions,
  windowExpiryMs,
  type HostDeployWindow,
} from './host-deploy-window.ts'

// ── Constants ────────────────────────────────────────────────────────────────

/** The `tool_approvals.tool_name` namespace for a host-deploy request. */
export const HOST_DEPLOY_APPROVAL_TOOL_NAME = 'host-deploy' as const

/** The opaque approval-token option-value prefix. */
export const HOST_DEPLOY_VALUE_PREFIX = 'hdp:' as const

/**
 * The full opaque option value: `hdp:<22-char base64url of the row UUID>:a|d`
 * (28 bytes ≤ `VALUE_BYTE_CAP` 37). `:a` = approve, `:d` = deny. The token IS
 * the routing — no side table. Eligibility is BOTH this regex AND membership in
 * a recent prompt's persisted option set.
 */
export const HOST_DEPLOY_VALUE_RE = /^hdp:[A-Za-z0-9_-]{22}:(a|d)$/

/** The ref deployed when the caller names none. */
export const HOST_DEPLOY_DEFAULT_REF = 'origin/main' as const

/**
 * Ref charset guard — refs are shelled to `git`, so keep them boring.
 *
 * The leading `-` is rejected STRUCTURALLY, not left to the output check. A ref
 * the agent chose is `argv` to `git rev-parse`, and `--parseopt`,
 * `--local-env-vars` and `-h` all match the charset — they were previously
 * contained only incidentally, by the `/^[0-9a-f]{40}$/` shape check on stdout
 * (Argus r1 nit). Containment that depends on what a subcommand happens to print
 * is containment a future git release can revoke.
 */
export const HOST_DEPLOY_REF_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/

/** How many commits the approval body itemizes before it says "and N more". */
export const HOST_DEPLOY_COMMIT_RENDER_CAP = 40

/** Longest commit subject rendered; longer ones are elided with a `…`. */
export const HOST_DEPLOY_SUBJECT_CAP = 120

/** Generic named-key entries consumed by this capability. They appear only after an owner adds them. */
export const HOST_DEPLOY_URL_SERVICE = 'host_deploy_url' as const
export const HOST_DEPLOY_TOKEN_SERVICE = 'host_deploy_token' as const

/**
 * Hard ceiling on the ONE authenticated control-plane call.
 *
 * MEASURED, not guessed. A real deploy is not a request/response — the control
 * plane checks out the new Open ref, runs its ENTIRE test suite as the contract
 * gate, installs both dependency trees, and only then restarts with health
 * waits. Measured on a real deployment (2026-08-15): the checkout landed at
 * 00:33:44 and the instance came back at 00:34:39 — about 60-90 seconds
 * end-to-end, on a warm cache.
 *
 * At 30s this timer therefore expired on EVERY REAL DEPLOY, without exception,
 * while the deploy itself went on to succeed. The owner saw "the operation timed
 * out" and a message telling him nothing had happened, at 00:34, for a deploy
 * that was at that moment finishing. Three minutes clears the measured envelope
 * with room for a colder cache or a larger fleet.
 *
 * ⚠️ AND IT STILL DOES NOT MAKE A TIMEOUT MEAN "IT FAILED" — see the timeout
 * branch in `answer()`. A longer wait reduces how often we stop listening; it
 * cannot turn not-listening into knowledge. Raising this without fixing that
 * message would have made the lie rarer and therefore harder to catch.
 */
export const HOST_DEPLOY_CALL_TIMEOUT_MS = 180_000

/** Hard ceiling on resolving a remote deploy target. */
export const HOST_DEPLOY_REMOTE_TIMEOUT_MS = 30_000

/**
 * Did this dispatch failure mean "I stopped waiting", rather than "it failed"?
 *
 * `createHostDeployDispatch` aborts with `AbortSignal.timeout(...)`, which
 * rejects with a `TimeoutError` — the DOMException whose message is literally
 * "The operation timed out." That is the string the owner was shown.
 *
 * MATCHED ON `name`, NOT ON THE MESSAGE. The message is human-facing text that
 * varies by runtime and locale; `name` is the contract. A `.includes('timed
 * out')` check would look equivalent, pass every test written against one
 * runtime, and quietly stop recognising a timeout on another — turning this
 * branch back into the confident falsehood it exists to remove.
 *
 * `AbortError` is deliberately NOT treated as a timeout: that is a deliberate
 * cancellation by a caller, which is a different fact about the world.
 */
export function isDispatchTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'TimeoutError'
  )
}

/** Longest slice of a control-plane response body echoed into chat. */
export const HOST_DEPLOY_DETAIL_CAP = 400

/**
 * Shortest credential {@link resolveHostDeployConfig} will accept, and the floor
 * {@link scrubHostDeploySecrets} redacts down to. ONE constant on purpose: when
 * the config minimum sat below the scrubber's floor, a short deploy token was
 * accepted as a live credential and then printed
 * verbatim into the owner's chat and the log, because the scrubber skipped it as
 * "too short to be a secret" (Argus r1 major). Whatever the scrubber refuses to
 * hide, the config must refuse to accept. A credential this short is not a
 * credential anyway, so rejecting it costs nothing real.
 */
export const HOST_DEPLOY_MIN_SECRET_CHARS = PROJECT_CREDENTIAL_MIN_SECRET_CHARS

/**
 * How long a pending host-deploy grant stays tappable. Mirrors
 * `APPROVAL_DEFAULT_TTL_MS` (`tools/approval.ts`), and is enforced from BOTH
 * ends:
 *
 *   - {@link HostDeployService.sweepExpiredGrants}, driven by the composer's
 *     `host-deploy-approval-sweeper` loop, retires a dead grant WITHOUT a tap —
 *     so the row stops being `pending`, its still-rendered button is retired and
 *     the topic is told it expired. The sweep is HOST-DEPLOY-SCOPED on purpose
 *     and is NOT a caller of `ApprovalManager.expireStale()`: that global sweep
 *     would also expire pending RITUAL grants (`reminders/ritual-registration.ts`),
 *     which the owner may legitimately answer days later and which have no
 *     re-raise path.
 *   - the ANSWER-path age gate below, which stays as the backstop for a tap that
 *     races the tick (and for any box whose sweeper never armed). Checked against
 *     the row's own `requested_at`, so it holds whether or not anything sweeps.
 */
export const HOST_DEPLOY_APPROVAL_TTL_MS = 5 * 60_000

/**
 * How often the composer's `host-deploy-approval-sweeper` loop asks
 * {@link HostDeployService.sweepExpiredGrants} to retire dead grants. A dead
 * grant therefore lingers at most TTL + one tick before its banner, its button
 * and its row are all retired.
 */
export const HOST_DEPLOY_APPROVAL_SWEEP_INTERVAL_MS = 60_000

/**
 * Characters stripped from a git commit subject before it is rendered into the
 * approval body: bidi controls, zero-width/format characters and C0 controls.
 * A commit subject is attacker-influenceable (anyone who can land a commit can
 * choose it), and the approval body is Markdown-rendered by the button surface
 * (`channels/button-primitive.ts:194`), so an RTL-override or zero-width payload
 * could otherwise hide what is about to be deployed from the person approving
 * it. STRIPPED, not refused — unlike a ritual prompt (which has one author and
 * can be fixed), refusing here would let any commit subject make the host
 * undeployable.
 *
 * EVERY C0 control except TAB is in the range, and that specifically includes CR
 * and LF. CR is the classic line-overwrite hiding character — a subject of
 * `ok<CR>DEPLOYING NOTHING AT ALL` reads as its second half on any renderer that
 * honours it — and LF forges an extra line inside the fenced commit list. An
 * earlier revision of this range skipped both, which defeated the exact purpose
 * the paragraph above claims for it (Argus r1 minor). TAB is deliberately kept:
 * it can neither hide a line nor forge one, and it is legitimate in a subject.
 */
export const HOST_DEPLOY_BANNED_SUBJECT_CHARS_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000A-\u001F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

// ── Seams ────────────────────────────────────────────────────────────────────

/** One commit in the list the owner approves. */
export interface HostDeployCommit {
  /** Full 40-char sha. */
  sha: string
  /** First line of the commit message. */
  subject: string
}

/** What is between the host's current pin and the requested ref. */
export interface HostDeployCommitRange {
  /** Newest first, capped at the caller's limit. */
  commits: HostDeployCommit[]
  /** TOTAL commits in the range — may exceed `commits.length`. */
  total: number
}

/**
 * The git surface this module needs against the checkout the host runs.
 * READ-ONLY means it cannot mutate the working tree, HEAD, or deployed state.
 * Resolving a remote-tracking ref may fetch remote objects and tracking metadata
 * so the target and its approval commit list describe the remote truthfully.
 */
export interface HostDeployGit {
  /** Full sha for `ref`, or null when this checkout does not know the ref. */
  revParse(ref: string): Promise<string | null>
  /** Resolve a deploy target, consulting its remote only for a remote-tracking ref. */
  resolveTarget(ref: string): Promise<string | null>
  /** Commits in `from..to`, newest first, rendered set capped at `limit`. */
  commitsBetween(from: string, to: string, limit: number): Promise<HostDeployCommitRange>
}

/** Resolved instance configuration for the control-plane call. */
export interface HostDeployEndpoint {
  url: string
  token: string
}

/**
 * Configuration state, resolved AT CALL TIME. `configured:false` carries the
 * owner-facing reason naming what would enable it — never the endpoint value.
 */
export type HostDeployConfigState =
  | { configured: true; endpoint: HostDeployEndpoint }
  | { configured: false; reason: string }

/** The ONE authenticated call. Returns a secret-free sentence either way. */
export interface HostDeployDispatchInput {
  url: string
  token: string
  ref: string
  sha: string
}

export interface HostDeployDispatchResult {
  ok: boolean
  /** Short description of what the control plane said. Scrubbed by the caller. */
  detail: string
}

export type HostDeployDispatch = (
  input: HostDeployDispatchInput,
) => Promise<HostDeployDispatchResult>

/** The button prompt emission seam — the composer's durable `deliver`. */
export interface HostDeployEmit {
  /**
   * The chat topic the prompt MUST be delivered to — the topic that asked for
   * the deploy, or the install's fallback topic when there is no calling topic.
   * The emitter delivers HERE; a destination hard-coded in the emitter is the
   * defect this field exists to prevent (2026-08-15).
   */
  topic_id: string
  body: string
  options: ButtonOption[]
  idempotency_key: string
  metadata: Record<string, unknown>
}

// ── Results ──────────────────────────────────────────────────────────────────

/** What `status()` reports — present ALWAYS, enabled only when configured. */
export interface HostDeployStatus {
  /** True only when both the endpoint and its credential resolve right now. */
  enabled: boolean
  /** Why it is disabled, naming what would enable it. Null when enabled. */
  reason: string | null
  /** The ref a `request()` with no `ref` argument would target. */
  default_ref: string
}

export type HostDeployRequestResult =
  | {
      status: 'pending_approval'
      /** Opaque handle for the agent — base64url of the approval row id. */
      request_id: string
      ref: string
      target_sha: string
      current_sha: string
      commit_count: number
      /**
       * The topic the Approve/Deny prompt ACTUALLY landed on. Always present so
       * the agent can never say "a button is waiting" without saying where.
       */
      approval_topic_id: string
      /**
       * Set ONLY when the prompt could not be raised on the requesting topic
       * (no calling topic — cron/system callers) and fell back to the install's
       * owner topic. Absent when the prompt landed where it was asked for.
       */
      note?: string
    }
  | {
      /**
       * A STANDING WINDOW WAS OPEN, SO THIS ALREADY DEPLOYED. The distinct
       * status is the point: `pending_approval` and `auto_approved` differ in
       * whether the host was touched, and an agent that cannot tell them apart
       * would report a completed deploy as a waiting button (or worse, the
       * reverse). See `open/host-deploy-window.ts`.
       */
      status: 'auto_approved'
      ref: string
      target_sha: string
      current_sha: string
      commit_count: number
      /** Whether the control plane ACCEPTED the deploy — it may still refuse. */
      accepted: boolean
      /** What the control plane said, secret-scrubbed. */
      detail: string
      /** When the authorising window closes, ms since epoch. */
      window_expires_at_ms: number
    }
  | { status: 'unavailable'; reason: string }
  | { status: 'up_to_date'; ref: string; target_sha: string }
  | { status: 'refused'; reason: string }

/** What `requestWindow()` reports. Opening a window is itself an owner tap. */
export type HostDeployWindowRequestResult =
  | {
      status: 'pending_approval'
      request_id: string
      ref: string
      hours: number
      expires_at_ms: number
      approval_topic_id: string
      note?: string
    }
  | { status: 'unavailable'; reason: string }
  | { status: 'refused'; reason: string }

/** The live window for a ref, as reported to the agent. */
export interface HostDeployWindowStatus {
  open: boolean
  ref: string
  /** Null when no window is open. */
  expires_at_ms: number | null
  /** Human phrase for how long is left — null when nothing is open. */
  remaining: string | null
}

// ── Configuration (CALL TIME) ────────────────────────────────────────────────

export interface HostDeployNamedValues {
  url?: string | null
  token?: string | null
}

/**
 * Resolve the control-plane endpoint from generic named values. Called on
 * EVERY request/approve — never memoized, never captured at composition time
 * (Decisions Log 2026-08-07: a credential read at composition time is a
 * credential that is never there). BOTH the URL and the credential are
 * required; there is NO default endpoint, because inventing one would point a
 * self-hoster's deploy at somebody else's control plane.
 */
export function resolveHostDeployConfig(values: HostDeployNamedValues): HostDeployConfigState {
  const url = (values.url ?? '').trim()
  const token = (values.token ?? '').trim()
  if (url.length === 0) {
    return {
      configured: false,
      reason:
        `No host-deploy endpoint is configured on this instance, so it cannot ask anything to deploy. ` +
        `Add ${HOST_DEPLOY_URL_SERVICE} and ${HOST_DEPLOY_TOKEN_SERVICE} in Settings → Integrations to enable it. ` +
        `A self-hosted box has no endpoint to call — deploy it the way you always have.`,
    }
  }
  if (token.length === 0) {
    return {
      configured: false,
      reason:
        `${HOST_DEPLOY_URL_SERVICE} exists but ${HOST_DEPLOY_TOKEN_SERVICE} is missing, so a deploy request could not be ` +
        `authenticated. Add it in Settings → Integrations to enable it.`,
    }
  }
  if (!/^https:\/\//i.test(url)) {
    return {
      configured: false,
      reason:
        `${HOST_DEPLOY_URL_SERVICE} must be an https:// URL — the deploy credential is sent on that call, ` +
        `so a plaintext endpoint is refused.`,
    }
  }
  if (token.length < HOST_DEPLOY_MIN_SECRET_CHARS) {
    // A credential the scrubber would decline to redact must never become a live
    // credential: the control plane echoes error bodies back into chat, and a
    // 5-character token would ride through `scrubHostDeploySecrets` untouched and
    // be printed verbatim to the owner (Argus r1 major). Disabled WITH the
    // reason, like every other unconfigured state — never silently.
    return {
      configured: false,
      reason:
        `${HOST_DEPLOY_TOKEN_SERVICE} is shorter than ${HOST_DEPLOY_MIN_SECRET_CHARS} characters, which is too ` +
        `short to be treated as a credential — a value that short cannot be reliably kept out of an error ` +
        `message. Save a longer value in Settings → Integrations to enable it.`,
    }
  }
  return { configured: true, endpoint: { url, token } }
}

/**
 * Replace every occurrence of each secret with `[redacted]`. Applied to
 * EVERYTHING the control plane says before it reaches a chat message or a log
 * line, so an endpoint that echoes its own Authorization header (or its URL)
 * back in an error body cannot leak it into the owner's transcript. `split`/
 * `join` rather than a regex so no escaping of the secret is required.
 *
 * Values below {@link HOST_DEPLOY_MIN_SECRET_CHARS} are skipped — redacting a
 * 2-character "secret" would blank out unrelated prose without protecting
 * anything. That floor is only safe because {@link resolveHostDeployConfig}
 * REFUSES a credential shorter than the SAME constant, so nothing this function
 * declines to hide can ever be a live credential. The two used to disagree, and
 * the gap was a 5-character token printed verbatim into chat (Argus r1 major).
 */
export function scrubHostDeploySecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < HOST_DEPLOY_MIN_SECRET_CHARS) continue
    out = out.split(secret).join('[redacted]')
  }
  return out
}

// ── Rendering (PURE, code-built) ─────────────────────────────────────────────

/** Short sha for the human-readable lines. */
function shortSha(sha: string): string {
  return sha.slice(0, 8)
}

/**
 * The length of the backtick fence that safely wraps `body`: one longer than the
 * longest run of backticks inside it, floored at 3. No commit subject can then
 * close the fence. Same defense as `reminders/ritual-registration.ts:301-306`
 * (the button body IS Markdown-rendered today).
 */
function safeFence(body: string): string {
  let longest = 0
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Strip the hiding characters + cap the length of one commit subject. */
export function sanitizeCommitSubject(subject: string): string {
  const stripped = subject.normalize('NFC').replace(HOST_DEPLOY_BANNED_SUBJECT_CHARS_RE, '').trim()
  if (stripped.length <= HOST_DEPLOY_SUBJECT_CAP) return stripped
  return `${stripped.slice(0, HOST_DEPLOY_SUBJECT_CAP)}…`
}

/**
 * The CODE-rendered host-deploy approval body. PURE, fixed structure, and it
 * CARRIES THE COMMIT LIST — the current pin, the target sha, and every commit
 * between them (capped, with the remainder counted, never silently truncated).
 * This is the whole security of the feature: the owner is the only gate, so the
 * thing he is gating has to be legible in the message he taps.
 */
export function renderHostDeployApprovalBody(input: {
  ref: string
  current_sha: string
  target_sha: string
  commits: readonly HostDeployCommit[]
  total: number
  /** `target..current` — what a rollback/sideways move would REMOVE. */
  removed?: readonly HostDeployCommit[]
  removed_total?: number
  /** The EXACT option value that approves — printed in the body as the typed fallback. */
  approve_value: string
  /** The EXACT option value that denies. */
  deny_value: string
}): string {
  const { ref, current_sha, target_sha, commits, total } = input
  const removed = input.removed ?? []
  const removed_total = input.removed_total ?? removed.length

  /** One fenced block of `<short sha>  <subject>`, with the remainder counted. */
  const renderList = (list: readonly HostDeployCommit[], count: number, empty: string): string => {
    const lines = list.map((c) => `${shortSha(c.sha)}  ${sanitizeCommitSubject(c.subject)}`)
    const hidden = count - list.length
    if (hidden > 0) lines.push(`… and ${hidden} more commit${hidden === 1 ? '' : 's'}`)
    const listing = lines.length > 0 ? lines.join('\n') : empty
    const fence = safeFence(listing)
    return `${fence}\n${listing}\n${fence}`
  }

  const parts: string[] = []
  parts.push('Host deploy approval needed')
  parts.push('')
  parts.push(`Deploy the host this instance runs on, from \`${ref}\`.`)
  parts.push('')
  parts.push(`  Now running: ${shortSha(current_sha)}`)
  parts.push(`  Would run:   ${shortSha(target_sha)}`)
  parts.push('')
  if (total > 0) {
    parts.push(`${total} commit${total === 1 ? '' : 's'} would land:`)
    parts.push(renderList(commits, total, '(no new commits)'))
  } else {
    parts.push(
      'No new commits are between these two — approving would move the host SIDEWAYS or BACKWARD to a different sha:',
    )
    parts.push(renderList(commits, total, '(no new commits)'))
    // A ROLLBACK'S CONTENT IS THE COMMITS IT TAKES AWAY. `current..target` is
    // empty in that direction, so rendering only that range asked the owner to
    // approve the removal of N commits sight-unseen — the exact rubber stamp
    // requirement 2 exists to prevent (Argus r1 minor). Show the other
    // direction, which is what is actually at stake.
    parts.push('')
    parts.push(
      removed_total > 0
        ? `${removed_total} commit${removed_total === 1 ? '' : 's'} the host is running now would be ROLLED BACK:`
        : 'Nothing would be rolled back either — these two shas share no commits in either direction.',
    )
    if (removed_total > 0) parts.push(renderList(removed, removed_total, '(none)'))
  }
  parts.push('')
  parts.push(
    'Nothing is deployed unless you tap Approve. This approval is bound to ' +
      `${shortSha(target_sha)} — if ${ref} moves before you answer, it is refused and you are asked again.`,
  )
  // The token alphabet is `[A-Za-z0-9_-]` (HOST_DEPLOY_VALUE_RE), so a single
  // backtick inline code span can never be escaped by it — no safeFence needed.
  // Inline code stops Markdown from mangling the `_`/`-` characters and makes
  // the string copy-typable. These MUST be the same strings the buttons carry
  // (computed once in `request()`) — that identity is the whole point: both
  // resolve through the same `handleOwnerButtonAnswer` exact-match path.
  parts.push(
    'Tap Approve or Deny. If the buttons are not visible where you are reading this, type one of these exact lines instead:',
  )
  parts.push(`- \`${input.approve_value}\` — approves this deploy`)
  parts.push(`- \`${input.deny_value}\` — denies it`)
  parts.push('Any other text will NOT approve this deploy.')
  return parts.join('\n')
}

// ── Service ──────────────────────────────────────────────────────────────────

export interface HostDeployServiceOptions {
  approvals: ApprovalManager
  git: HostDeployGit
  /** CALL-TIME configuration resolver. Never a captured value. */
  resolveConfig: () => HostDeployConfigState
  /** The ONE authenticated call. */
  dispatch: HostDeployDispatch
  project_slug: string
  owner_user_id: string
  /**
   * FALLBACK approval destination, used ONLY when a request carries no calling
   * topic (cron/system callers). A request that names its topic raises the
   * prompt THERE — the owner asked from a project topic and was sent to General
   * to find a button, which is the defect fixed on 2026-08-15.
   */
  approval_topic_id: string
  /**
   * Deliver the prompt. Returns the id of the `button_prompts` row it created,
   * or null when the emitter raised no durable prompt — {@link
   * HostDeployService.sweepExpiredGrants} needs that id to retire the button of
   * a grant it expires, and a prompt the sweep cannot name is a button that
   * outlives its grant.
   */
  emit: (p: HostDeployEmit) => Promise<{ prompt_id: string | null }>
  /**
   * Retire the still-rendered button prompt of a grant the sweep just expired.
   * OPTIONAL: a box that wires no prompt surface simply keeps the current
   * behaviour (the grant expires, the button goes stale). Never called from any
   * path that could deploy.
   */
  retire_prompt?: (input: { prompt_id: string; topic_id: string }) => Promise<void>
  /**
   * Post an INERT sentence on the grant's own topic saying it expired. OPTIONAL
   * for the same reason. "It timed out" and "I never answered" must be
   * distinguishable, and the only surface that can say so is the topic the
   * prompt landed on.
   */
  post_notice?: (topic_id: string, body: string) => Promise<void>
  /**
   * THE PER-SHA SAFETY CHECK A STANDING WINDOW MAY NEVER SKIP.
   *
   * A window authorises the DECISION — the owner's tap — and nothing else. The
   * plan for this feature states it as a hard constraint: the grant replaces the
   * human tap, never the guard. The guard that matters is migration drift: a
   * duplicate ordinal is SILENTLY SKIPPED by the runner, so a deploy can ship
   * code that writes columns which do not exist and take the instance down on
   * boot (2026-08-17, and armed again at ordinal 125 on 2026-08-20).
   *
   * FAIL-CLOSED, AND CLOSED IS THE DEFAULT. When this seam is absent the service
   * cannot prove the target is safe, so a window NEVER auto-deploys: the request
   * falls back to the ordinary per-sha approval and the owner decides, because
   * his tap is his own judgement and this constrains the STANDING grant, not him.
   * The absence is a refusal rather than a skip because an unchecked auto-deploy
   * is precisely the outcome the constraint forbids, and a permissive default
   * would produce it silently on exactly the boxes where nothing wired a check.
   */
  check_preconditions?: (input: {
    ref: string
    sha: string
  }) => Promise<{ ok: boolean; reason: string }>
  log?: (msg: string) => void
  default_ref?: string
  /**
   * Injectable clock, used ONLY by the grant-age gate. Defaults to `Date.now`,
   * matching `ApprovalManager`'s own `now` seam so a test can roll the clock past
   * {@link HOST_DEPLOY_APPROVAL_TTL_MS} without sleeping.
   */
  now?: () => number
}

/** The input shape the live-agent capture seam hands `handleOwnerButtonAnswer`. */
export interface HostDeployOwnerAnswerInput {
  user_id: string
  user_text: string
  topic_id: string
  prior_option_values: readonly string[]
}

export interface HostDeployService {
  /** Present ALWAYS; `enabled:false` carries the reason. */
  status(): HostDeployStatus
  /**
   * Resolve + raise an approval. Deploys NOTHING. `topic_id` is the topic the
   * request came from (`ToolCallContext.topic_id`); the prompt is raised there.
   * Null/omitted — a cron or system caller — falls back to the install's
   * `approval_topic_id`.
   */
  request(input: { ref?: string; topic_id?: string | null }): Promise<HostDeployRequestResult>
  /** The owner's affirmative act. Returns null when the reply is not one. */
  handleOwnerButtonAnswer(
    input: HostDeployOwnerAnswerInput,
  ): Promise<{ body: string } | null>
  /**
   * Retire every host-deploy grant that is still `pending` past
   * {@link HOST_DEPLOY_APPROVAL_TTL_MS} — WITHOUT a tap. Returns how many rows
   * THIS call transitioned (claim-gated, so a concurrent tap and a tick can
   * never both count the same row). Deploys NOTHING on any path.
   */
  sweepExpiredGrants(): Promise<number>
  /**
   * Ask the owner to open a STANDING WINDOW: deploys of `ref` need no further
   * tap until it closes. Opens NOTHING by itself — it raises the same kind of
   * Approve/Deny prompt `request()` does, and only the owner's tap opens it.
   */
  requestWindow(input: {
    hours: number
    ref?: string
    topic_id?: string | null
  }): Promise<HostDeployWindowRequestResult>
  /** Is a window open for `ref` right now? Reads only; never deploys. */
  windowStatus(ref?: string): HostDeployWindowStatus
  /**
   * Close every live window for `ref` immediately. Returns how many THIS call
   * closed, so "there was nothing open" and "I closed it" stay distinguishable.
   */
  revokeWindow(ref?: string): Promise<number>
}

/** The `tool_approvals.args_json` payload for a host-deploy request. */
interface HostDeployApprovalArgs {
  ref?: unknown
  target_sha?: unknown
  current_sha?: unknown
  /** Rendered by the notifier as the "an approval is waiting" one-liner. */
  description?: unknown
  /**
   * The `button_prompts` row this grant was rendered as, written post-emit by
   * `ApprovalManager.recordPromptLink`. The sweep uses it to retire the button
   * of a grant it expires; absent on a grant raised before this link existed
   * (the sweep still expires the row, it just cannot retire the button).
   */
  prompt_id?: unknown
}

/** Read a grant's stored arguments. A row that will not parse reads as empty. */
function parseApprovalArgs(args_json: string): HostDeployApprovalArgs {
  try {
    return (JSON.parse(args_json) as HostDeployApprovalArgs | null) ?? {}
  } catch {
    return {}
  }
}

export function createHostDeployService(
  opts: HostDeployServiceOptions,
): HostDeployService {
  const {
    approvals,
    git,
    resolveConfig,
    dispatch,
    project_slug,
    owner_user_id,
    approval_topic_id,
    emit,
    retire_prompt,
    post_notice,
    check_preconditions,
  } = opts
  const log = opts.log ?? ((): void => undefined)
  const default_ref = opts.default_ref ?? HOST_DEPLOY_DEFAULT_REF
  const now = opts.now ?? Date.now

  /**
   * (ref@sha) pairs a standing window is dispatching RIGHT NOW. See the guard in
   * `request()`: it exists so two turns inside one open window cannot restart the
   * instance twice for the same commit.
   */
  const auto_in_flight = new Set<string>()

  /** The live standing window for `ref`, or null. Reads only. */
  function liveWindow(ref: string): HostDeployWindow | null {
    return pickLiveWindow(
      approvals.findByToolName(project_slug, HOST_DEPLOY_WINDOW_TOOL_NAME),
      ref,
      now(),
    )
  }

  function status(): HostDeployStatus {
    const cfg = resolveConfig()
    return {
      enabled: cfg.configured,
      reason: cfg.configured ? null : cfg.reason,
      default_ref,
    }
  }

  async function request(
    input: { ref?: string; topic_id?: string | null },
  ): Promise<HostDeployRequestResult> {
    // ── WHERE THE BUTTON GOES. The topic that asked for the deploy, every time
    // it named one. `approval_topic_id` is the FALLBACK for callers with no
    // conversation (cron/system) — it used to be the only destination, which is
    // how the owner was told to tap a button in a topic he was not in.
    const requested_topic =
      typeof input.topic_id === 'string' && input.topic_id.length > 0 ? input.topic_id : null
    const approval_topic = requested_topic ?? approval_topic_id

    // ── (a) NO CONTROL PLANE → visible, disabled, WITH THE REASON. Checked
    // FIRST so an unconfigured box never mints an approval the owner could tap
    // into a guaranteed failure. Not a throw: "disabled with a reason" is a
    // normal answer, and an option that silently disappears is how a missing
    // capability stays invisible for weeks.
    const cfg = resolveConfig()
    if (!cfg.configured) return { status: 'unavailable', reason: cfg.reason }

    const ref = (input.ref ?? default_ref).trim()
    if (!HOST_DEPLOY_REF_RE.test(ref)) {
      return {
        status: 'refused',
        reason: `${JSON.stringify(ref)} is not a usable git ref (letters, digits, . _ / - only, 1-200 chars)`,
      }
    }

    // ── (b) resolve what WOULD be deployed. Remote-tracking targets are fetched
    // without changing the working tree or HEAD; the current pin stays local.
    let target_sha: string | null
    let current_sha: string | null
    try {
      target_sha = await git.resolveTarget(ref)
      current_sha = await git.revParse('HEAD')
    } catch (err) {
      return {
        status: 'refused',
        reason: `could not read the host checkout to work out what would deploy: ${errText(err)}`,
      }
    }
    if (target_sha === null) {
      return {
        status: 'refused',
        reason: `the host checkout does not know the ref ${JSON.stringify(ref)} — nothing was requested`,
      }
    }
    if (current_sha === null) {
      return {
        status: 'refused',
        reason: 'the host checkout has no resolvable HEAD, so there is no current pin to compare against',
      }
    }
    if (target_sha === current_sha) {
      // Nothing to approve. Raising a prompt here would train the owner to tap
      // Approve on a message that means nothing.
      return { status: 'up_to_date', ref, target_sha }
    }

    let range: HostDeployCommitRange
    let rolled_back: HostDeployCommitRange = { commits: [], total: 0 }
    try {
      range = await git.commitsBetween(current_sha, target_sha, HOST_DEPLOY_COMMIT_RENDER_CAP)
      if (range.total === 0) {
        // Sideways/backward: the forward range is empty, so the ONLY legible
        // content of this approval is what it would take away. Read the reverse
        // range so the owner is never asked to approve the removal of N commits
        // he cannot see.
        rolled_back = await git.commitsBetween(target_sha, current_sha, HOST_DEPLOY_COMMIT_RENDER_CAP)
      }
    } catch (err) {
      // THE COMMIT LIST IS THE APPROVAL. Without it the owner would be asked to
      // approve "deploy?", which is a rubber stamp with extra steps — so this is
      // a refusal, not a degraded prompt.
      return {
        status: 'refused',
        reason: `could not list the commits between ${shortSha(current_sha)} and ${shortSha(target_sha)}, so there is no approval to show: ${errText(err)}`,
      }
    }

    // ── (b1) A STANDING WINDOW SHORT-CIRCUITS THE TAP. Checked HERE and not
    // earlier on purpose: everything above still runs, so an auto-approved deploy
    // resolves the same shas, refuses on the same unreadable checkout, and stops
    // on the same `up_to_date` as a tapped one. The window replaces the OWNER'S
    // TAP; it replaces none of the checks.
    const window = liveWindow(ref)
    if (window !== null) {
      // ── THE GUARD THE WINDOW MAY NOT REPLACE. Run per sha, every time, before
      // anything is dispatched. No checker wired ⇒ nothing is proven ⇒ the window
      // does not act, and the owner is asked the ordinary way.
      const verdict =
        check_preconditions === undefined
          ? {
              ok: false,
              reason:
                'no deploy precondition check is wired on this instance, so a standing window ' +
                'cannot prove the target is safe to deploy',
            }
          : await check_preconditions({ ref, sha: target_sha }).catch((err: unknown) => ({
              ok: false,
              // A checker that THREW proved nothing. Treating a crash as a pass
              // is how a guard becomes decoration.
              reason: `the deploy precondition check could not be run: ${errText(err)}`,
            }))
      if (!verdict.ok) {
        log(
          `host-deploy window HELD ref=${ref} target=${shortSha(target_sha)} window=${window.id}: ${verdict.reason}`,
        )
        if (post_notice !== undefined) {
          try {
            await post_notice(
              approval_topic,
              `Your standing deploy window covers ${ref} at ${shortSha(target_sha)}, but it was NOT ` +
                `deployed: ${verdict.reason}. Asking you per commit instead.`,
            )
          } catch (err) {
            log(`host-deploy hold notice not posted on ${approval_topic}: ${errText(err)}`)
          }
        }
        // FALL THROUGH to the ordinary approval below — held, not refused. The
        // owner can still look at the commit list and decide for himself.
      } else {
        // ONE AUTO-DEPLOY PER (ref, sha) AT A TIME. Two agent turns that both ask
        // inside the window would otherwise both dispatch the same sha and restart
        // the instance twice. Process-local, which is enough: the dispatch site is
        // this one function in this one process, and a cross-process guard would
        // need state the control plane already owns (it is the thing that refuses
        // a redundant deploy).
        const flight_key = `${ref}@${target_sha}`
        if (auto_in_flight.has(flight_key)) {
          return {
            status: 'refused',
            reason: `a deploy of ${ref} at ${shortSha(target_sha)} is already in flight under the standing window — nothing new was requested`,
          }
        }
        auto_in_flight.add(flight_key)
        let outcome: Awaited<ReturnType<typeof performDeploy>>
        try {
          outcome = await performDeploy(ref, target_sha)
        } finally {
          auto_in_flight.delete(flight_key)
        }
        log(
          `host-deploy auto_approved ref=${ref} target=${shortSha(target_sha)} commits=${range.total} ` +
            `window=${window.id} kind=${outcome.kind}`,
        )

        // ── AUDITED ON THE GRANT ITSELF. "Which permission authorised this
        // deploy, and what else did it authorise" must be answerable after the
        // fact, and the only durable record of a deploy nobody tapped is the row
        // that authorised it. Best-effort: a failed audit write must never
        // un-deploy or re-deploy anything, so it is logged and the outcome
        // stands.
        try {
          const prior = parseWindowArgs(approvals.get(window.id)?.args_json ?? '{}')
          const uses = Array.isArray(prior.uses) ? prior.uses : []
          await approvals.mergeArgs(window.id, {
            uses: [
              ...uses,
              { sha: target_sha, at_ms: now(), kind: outcome.kind, commits: range.total },
            ],
          })
        } catch (err) {
          log(`host-deploy window use not recorded window=${window.id}: ${errText(err)}`)
        }

        // THE OWNER DID NOT TAP, SO HE MUST BE TOLD. This is the only record he
        // sees of a deploy he did not personally authorise sha-by-sha; a silent
        // one would make the window impossible to audit and "I never saw it
        // deploy" true.
        if (post_notice !== undefined) {
          try {
            await post_notice(
              approval_topic,
              outcome.kind === 'accepted'
                ? renderAutoDeployNotice({
                    ref,
                    sha: target_sha,
                    commit_count: range.total,
                    expires_at_ms: window.expires_at_ms,
                    now_ms: now(),
                    detail: outcome.detail,
                  })
                : `A deploy of ${ref} at ${shortSha(target_sha)} was authorised by your standing deploy ` +
                  `window and did NOT go out: ${outcome.detail || outcome.kind}.`,
            )
          } catch (err) {
            log(`host-deploy auto notice not posted on ${approval_topic}: ${errText(err)}`)
          }
        }
        return {
          status: 'auto_approved',
          ref,
          target_sha,
          current_sha,
          commit_count: range.total,
          accepted: outcome.kind === 'accepted',
          detail: outcome.detail,
          window_expires_at_ms: window.expires_at_ms,
        }
      }
    }

    // ── (c) mint the approval row id up front so it can be encoded into the
    // button token with no side-table lookup (the ritual-approval discipline,
    // `reminders/ritual-approval.ts:140-150`).
    const approval_id = crypto.randomUUID()
    const decision = approvals.requestApproval({
      id: approval_id,
      project_slug,
      topic_id: approval_topic,
      tool_name: HOST_DEPLOY_APPROVAL_TOOL_NAME,
      policy: 'prompt-user',
      args: {
        ref,
        target_sha,
        current_sha,
        // Read by `open/wiring/approval-notifier.ts` for the plain-text push.
        // Shas and a ref only — no endpoint, no credential.
        description: `deploy the host from ${ref} at ${shortSha(target_sha)} (${range.total} commit${range.total === 1 ? '' : 's'})`,
      },
    })
    // The decision promise is resolved by the owner's button tap through
    // `handleOwnerButtonAnswer`, never awaited here — so it needs a terminal
    // handler, or a persistence failure becomes an unhandled rejection that
    // tears the process down. `fireAndForget` makes it visible + non-fatal.
    fireAndForget('host-deploy.approval', decision, (err: unknown) => {
      log(`host-deploy approval ${approval_id} did not resolve: ${errText(err)}`)
    })

    // ── (d) emit the CODE-rendered approval prompt carrying the commit list.
    let emitted: { prompt_id: string | null }
    try {
      // Computed ONCE so the buttons and the typed fallback printed in the body
      // can never drift apart — both resolve through the same exact-match path.
      const approve_value = `${HOST_DEPLOY_VALUE_PREFIX}${uuidToToken(approval_id)}:a`
      const deny_value = `${HOST_DEPLOY_VALUE_PREFIX}${uuidToToken(approval_id)}:d`
      const options: ButtonOption[] = [
        {
          label: 'Approve',
          body: 'Approve this host deploy',
          value: approve_value,
        },
        {
          label: 'Deny',
          body: 'Deny this host deploy',
          value: deny_value,
        },
      ]
      emitted = await emit({
        topic_id: approval_topic,
        body: renderHostDeployApprovalBody({
          ref,
          current_sha,
          target_sha,
          commits: range.commits,
          total: range.total,
          removed: rolled_back.commits,
          removed_total: rolled_back.total,
          approve_value,
          deny_value,
        }),
        options,
        idempotency_key: `host-deploy-approval:${approval_id}`,
        metadata: { kind: 'host-deploy-approval', ref },
      })
    } catch (err) {
      // A grant with no tappable prompt is an orphan that lingers until the TTL
      // sweep — cancel it so the owner can simply ask again.
      try {
        await approvals.cancelPending(approval_id)
      } catch {
        /* best-effort */
      }
      return {
        status: 'refused',
        reason: `the approval prompt could not be posted, so nothing is pending — ask again: ${errText(err)}`,
      }
    }

    // ── (d1) LINK THE GRANT TO ITS PROMPT, so the sweep can retire the button of
    // a grant it expires. BEST-EFFORT: a failure here costs only that retirement
    // (the grant still expires on time, on both the sweep and the answer path),
    // and it must never turn a raised prompt into a refused request.
    if (emitted.prompt_id !== null) {
      try {
        await approvals.recordPromptLink(approval_id, emitted.prompt_id)
      } catch (err) {
        log(`host-deploy prompt link not recorded id=${approval_id}: ${errText(err)}`)
      }
    }

    log(
      `host-deploy pending_approval ref=${ref} target=${shortSha(target_sha)} commits=${range.total} topic=${approval_topic}`,
    )
    return {
      status: 'pending_approval',
      request_id: uuidToToken(approval_id),
      ref,
      target_sha,
      current_sha,
      commit_count: range.total,
      approval_topic_id: approval_topic,
      // Only the fallback needs saying out loud: the prompt is somewhere other
      // than the conversation this was asked in, and the owner has to be told
      // where or he is hunting for a button that is not on his screen.
      ...(requested_topic === null
        ? {
            note:
              `The Approve/Deny prompt was posted to the owner's General chat topic (${approval_topic}). ` +
              'Tell the owner where to find it.',
          }
        : {}),
    }
  }

  /**
   * A DEAD GRANT IS NOT A DEAD END. Raise a REPLACEMENT approval on the topic the
   * owner just tapped in — demonstrably where he is — and return the one sentence
   * that names it. Deploys NOTHING and approves NOTHING: the fresh grant is a new
   * pending row with new `hdp:` tokens that needs its own owner tap. Called from
   * the TTL/stale/swept-expired refusals, which used to end at "Ask again" and
   * leave a five-minute window the owner could not win (2026-08-15).
   */
  async function reraise(ref: string | null, topic_id: string): Promise<string> {
    if (ref === null) return 'Ask again to see the current commit list.'
    let fresh: HostDeployRequestResult
    try {
      fresh = await request({ ref, topic_id })
    } catch (err) {
      return `A fresh approval could not be raised (${errText(err)}) — ask again.`
    }
    if (fresh.status === 'pending_approval') {
      return (
        `A fresh approval for ${ref} at ${shortSha(fresh.target_sha)} ` +
        `(${fresh.commit_count} commit${fresh.commit_count === 1 ? '' : 's'}) was just posted in ` +
        'this chat — tap Approve on that one to deploy.'
      )
    }
    if (fresh.status === 'up_to_date') {
      return `And nothing is left to deploy — the host is already at ${shortSha(fresh.target_sha)}.`
    }
    // A window opened between the dead tap and this re-raise, so there was no
    // approval to raise: the deploy the owner was chasing has ALREADY gone out.
    // Saying "a fresh approval is waiting" here would send him hunting for a
    // button that does not exist, for work that is already done.
    if (fresh.status === 'auto_approved') {
      return fresh.accepted
        ? `Your standing deploy window covered it, so ${ref} at ${shortSha(fresh.target_sha)} ` +
            `has just been deployed without a further tap. ${fresh.detail}`
        : `Your standing deploy window covered it, but the deploy did not go out: ${fresh.detail}`
    }
    return `A fresh approval could not be raised: ${fresh.reason}`
  }

  /**
   * Is a host-deploy grant for `ref` ALREADY waiting? The dedupe guard on the
   * re-raise: repeat taps on the same dead button must point at the prompt that
   * is already there rather than mint a new one per tap.
   */
  function pendingGrantForRef(ref: string | null): boolean {
    if (ref === null) return false
    return approvals
      .findByToolName(project_slug, HOST_DEPLOY_APPROVAL_TOOL_NAME)
      .some((r) => {
        if (r.status !== 'pending') return false
        const r_ref = parseApprovalArgs(r.args_json).ref
        return typeof r_ref === 'string' && r_ref === ref
      })
  }

  /**
   * The `hdw:` half of the tap surface — the owner opening or refusing a standing
   * window. Kept as its own function rather than another branch inside the
   * single-deploy handler: the two grants share a token codec and NOTHING else,
   * and the single-deploy path's stale-sha gate is meaningless for a permission
   * that is deliberately not bound to a sha.
   *
   * FAIL-SAFE IN THE SAME DIRECTION: a token that is not an offered button, not
   * from the owner, not pending, or older than the prompt TTL opens no window.
   */
  async function handleWindowAnswer(
    input: HostDeployOwnerAnswerInput,
    value: string,
  ): Promise<{ body: string }> {
    if (input.user_id !== owner_user_id) {
      return { body: 'Only the owner can open a deploy window. Nothing was changed.' }
    }
    if (!input.prior_option_values.includes(value)) {
      return {
        body:
          'That deploy-window prompt has aged out of the answer window, so it can no longer be ' +
          'answered — no window was opened. Ask again for a fresh one.',
      }
    }
    const token = value.slice(
      HOST_DEPLOY_WINDOW_VALUE_PREFIX.length,
      HOST_DEPLOY_WINDOW_VALUE_PREFIX.length + 22,
    )
    const id = tokenToUuid(token)
    if (id === null) {
      return { body: 'That deploy-window token is not recognized — no window was opened.' }
    }
    const row = approvals.get(id)
    if (
      row === null ||
      row.project_slug !== project_slug ||
      row.tool_name !== HOST_DEPLOY_WINDOW_TOOL_NAME
    ) {
      return { body: 'That deploy-window request is unknown or no longer valid — no window was opened.' }
    }
    if (row.status !== 'pending') {
      return {
        body: `That deploy-window request was already ${row.status} — this tap changed nothing.`,
      }
    }
    // The GRANT PROMPT's own TTL — five minutes, the same as a single deploy's.
    // This is not the window's length; it is how long the offer to open one stays
    // tappable, and a prompt answered hours later is answering a question the
    // owner no longer has in front of him.
    if (now() - row.requested_at * 1000 > HOST_DEPLOY_APPROVAL_TTL_MS) {
      await cancel(id)
      return {
        body:
          `That deploy-window request is older than ${Math.round(HOST_DEPLOY_APPROVAL_TTL_MS / 60_000)} ` +
          'minutes, so it has expired — no window was opened. Ask again.',
      }
    }

    const args = parseWindowArgs(row.args_json)
    const ref = typeof args.ref === 'string' ? args.ref : null
    const expires_at_ms = typeof args.expires_at_ms === 'number' ? args.expires_at_ms : null
    if (ref === null || expires_at_ms === null) {
      await cancel(id)
      return { body: 'That deploy-window request could not be read back — no window was opened. Ask again.' }
    }

    if (value.endsWith(':d')) {
      let denied: boolean
      try {
        denied = await approvals.respondApproval(id, 'denied', input.user_id)
      } catch (err) {
        log(`host-deploy window deny not recorded id=${id}: ${errText(err)}`)
        return { body: 'That deny could not be recorded — but no window was opened either way.' }
      }
      if (!denied) {
        const settled = approvals.get(id)?.status ?? 'decided'
        return { body: `That deploy-window request was already ${settled} — this tap changed nothing.` }
      }
      return { body: 'No deploy window opened. Every deploy will keep asking you per commit.' }
    }

    let claimed: boolean
    try {
      claimed = await approvals.respondApproval(id, 'approved', input.user_id)
    } catch (err) {
      log(`host-deploy window approval not recorded id=${id}: ${errText(err)}`)
      return { body: 'That could not be recorded, so no window was opened. Ask again.' }
    }
    if (!claimed) {
      const settled = approvals.get(id)?.status ?? 'decided'
      return { body: `That deploy-window request was already ${settled} — this tap changed nothing.` }
    }

    // ── THE WINDOW IS NOW OPEN, so the deploy that is already waiting should go.
    // He opened it BECAUSE work is queued; making him then ask for the very
    // deploy he just pre-authorised would be the round trip this removes. It runs
    // through `request()`, which finds the window it just opened and takes the
    // ordinary auto-approved path — no second dispatch site, no bypass.
    const remaining = describeRemaining(expires_at_ms, now())
    const opened = `Deploy window open for ${remaining}: I can deploy \`${ref}\` without asking until it closes.`
    let follow: HostDeployRequestResult
    try {
      follow = await request({ ref, topic_id: input.topic_id })
    } catch (err) {
      return { body: `${opened} (Checking for anything waiting to deploy failed: ${errText(err)}.)` }
    }
    if (follow.status === 'up_to_date') {
      return { body: `${opened} Nothing is waiting — the host is already at ${shortSha(follow.target_sha)}.` }
    }
    if (follow.status === 'auto_approved') {
      return {
        body: follow.accepted
          ? `${opened}\n\nDeployed ${follow.ref} at ${shortSha(follow.target_sha)} ` +
            `(${follow.commit_count} commit${follow.commit_count === 1 ? '' : 's'}) straight away. ${follow.detail}`
          : `${opened}\n\nThe deploy of ${follow.ref} at ${shortSha(follow.target_sha)} did NOT go out: ${follow.detail}`,
      }
    }
    if (follow.status === 'refused' || follow.status === 'unavailable') {
      return { body: `${opened} Nothing was deployed just now: ${follow.reason}` }
    }
    return { body: opened }
  }

  async function handleOwnerButtonAnswer(
    input: HostDeployOwnerAnswerInput,
  ): Promise<{ body: string } | null> {
    const value = input.user_text.trim()

    // The window grant is a DIFFERENT token namespace with a different handler.
    // Routed first so an `hdw:` value can never fall through the `hdp:` regex
    // into the single-deploy path (it cannot — the prefixes are disjoint — but
    // the ordering makes that a property of the code rather than of the regex).
    if (HOST_DEPLOY_WINDOW_VALUE_RE.test(value)) return await handleWindowAnswer(input, value)

    // ── (a) ELIGIBILITY. An EXACT opaque token AND membership in the persisted
    // option set of a recent prompt. Silence, a timeout, "yes", a paraphrase or
    // any unrelated reply is not an approval and never reaches a row — the same
    // discipline as `onboarding/interview/button-backed-answer.ts:207-209`.
    //
    // ELIGIBILITY IS TWO CONDITIONS: the regex AND membership in
    // `prior_option_values` (the caller's recent-prompt window — four prompts on
    // the topic, per `gateway/wiring/build-live-agent-turn.ts`). They no longer
    // have the same consequence. A value that FAILS THE REGEX is not ours:
    // ordinary text and cross-service ritual tokens (`rap:`) still return null so
    // the ritual service and the LLM keep their routing. A value that MATCHES the
    // regex but FAILS MEMBERSHIP is an `hdp:` token whose prompt aged out of the
    // window — it used to return null too, and the raw token then fell through to
    // the LLM as unexplained text, a silence the owner had to interpret. It is
    // now carried through the gates below as `evicted`: the tap is ANSWERED with
    // an explanation and, for a still-pending grant, a claim-gated replacement
    // prompt raised on the topic the owner just typed in. Still FAIL-SAFE in the
    // direction that matters — an evicted button deploys nothing, on any path.
    if (!HOST_DEPLOY_VALUE_RE.test(value)) return null
    const evicted = !input.prior_option_values.includes(value)

    // ── (b) OWNER ONLY. This is the no-self-approval guard: the requester is
    // the agent, whose turns never carry the owner's user_id, so an agent can
    // never answer its own request. No row is touched.
    if (input.user_id !== owner_user_id) {
      return { body: 'Only the owner can approve a host deploy. Nothing was deployed.' }
    }

    const token = value.slice(
      HOST_DEPLOY_VALUE_PREFIX.length,
      HOST_DEPLOY_VALUE_PREFIX.length + 22,
    )
    const id = tokenToUuid(token)
    if (id === null) {
      return { body: 'That deploy token is not recognized (stale or malformed) — nothing was deployed.' }
    }

    const row = approvals.get(id)
    if (
      row === null ||
      row.project_slug !== project_slug ||
      row.tool_name !== HOST_DEPLOY_APPROVAL_TOOL_NAME
    ) {
      return { body: 'That deploy request is unknown or no longer valid — nothing was deployed.' }
    }
    // ── (b1) WHAT WAS APPROVED, read PURELY. Parsed before the status and age
    // gates because every dead-end branch below now needs the `ref` to raise a
    // replacement grant; this read has no side effect of its own, so a branch that
    // does not re-raise is unaffected by it.
    const args = parseApprovalArgs(row.args_json)
    const ref = typeof args.ref === 'string' ? args.ref : null
    const approved_sha = typeof args.target_sha === 'string' ? args.target_sha : null

    if (row.status !== 'pending') {
      // On an already-APPROVED row a deploy DID go out on the earlier tap, so
      // "nothing was deployed" would be a lie in the only record the owner keeps
      // — and it is the sentence a late Deny tap would read.
      if (row.status === 'approved') {
        return {
          body: `That deploy request was already approved and the deploy already went out — this tap changed nothing. Ask again to deploy anything newer.`,
        }
      }
      // An approval that timed out (or was swept) is NOT an approval — but it is
      // also not a dead end. Re-raise, UNLESS a grant for the same ref is already
      // waiting: repeat taps on one dead button must not spam prompts.
      if (row.status === 'expired') {
        return {
          body:
            'That deploy request had already expired — nothing was deployed. ' +
            (pendingGrantForRef(ref)
              ? 'A fresh approval is already waiting — tap Approve on the newest prompt.'
              : await reraise(ref, input.topic_id)),
        }
      }
      return {
        body: `That deploy request was already ${row.status} — nothing was deployed. Ask again to see the current commit list.`,
      }
    }

    if (evicted) {
      // The prompt aged out of the four-prompt answer window on this topic
      // (or the token was typed in a different topic than carried the prompt).
      // The grant is real and pending but its button can never be eligible
      // again, so retire it and raise a replacement where the owner just
      // typed. CLAIM-GATED like the age gate below: of two taps racing one
      // evicted grant, exactly one re-raises; the loser reads the settled
      // status. An evicted tap NEVER dispatches.
      let claimed: boolean
      try {
        claimed = await approvals.cancelPending(id)
      } catch {
        claimed = false
      }
      if (!claimed) {
        const settled = approvals.get(id)?.status ?? 'decided'
        return { body: `That deploy request was already ${settled} — nothing was deployed.` }
      }
      return {
        body:
          'That approval prompt has aged out of the answer window (newer prompts replaced it), ' +
          'so it can no longer be answered — nothing was deployed. ' +
          (pendingGrantForRef(ref)
            ? 'A fresh approval is already waiting — tap Approve on the newest prompt.'
            : await reraise(ref, input.topic_id)),
      }
    }

    // ── (b2) THE GRANT'S OWN AGE. `requested_at` is seconds since epoch. The
    // production sweep is now `sweepExpiredGrants()`, driven by the composer's
    // `host-deploy-approval-sweeper` loop — host-deploy-SCOPED on purpose, since a
    // global `ApprovalManager.expireStale()` tick would also kill pending ritual
    // grants that have no re-raise path. This gate REMAINS as the backstop: it
    // catches the tap that races the tick (the sweep runs at most once a minute)
    // and it holds on any box whose sweeper never armed. The row is expired as it
    // is refused, so the same tap cannot be repeated into a race with the sweep.
    //
    // CLAIM-GATED, because the refusal now has a side effect (a fresh grant).
    // `cancelPending` reports whether THIS call retired the pending row, so of two
    // taps racing one dead grant exactly one re-raises; the loser reads the status
    // the row actually settled at and raises nothing.
    const age_ms = now() - row.requested_at * 1000
    if (age_ms > HOST_DEPLOY_APPROVAL_TTL_MS) {
      let claimed: boolean
      try {
        claimed = await approvals.cancelPending(id)
      } catch {
        claimed = false
      }
      if (!claimed) {
        const settled = approvals.get(id)?.status ?? 'decided'
        return { body: `That deploy request was already ${settled} — nothing was deployed.` }
      }
      return {
        body:
          `That deploy request is older than ${Math.round(HOST_DEPLOY_APPROVAL_TTL_MS / 60_000)} minutes, ` +
          `so it has expired — nothing was deployed. ` +
          (await reraise(ref, input.topic_id)),
      }
    }

    if (ref === null || approved_sha === null) {
      await cancel(id)
      return { body: 'That deploy request could not be read back — nothing was deployed. Ask again.' }
    }

    if (value.endsWith(':d')) {
      let denied: boolean
      try {
        denied = await approvals.respondApproval(id, 'denied', input.user_id)
      } catch (err) {
        log(`host-deploy deny not recorded id=${id}: ${errText(err)}`)
        return { body: 'That deny could not be recorded — but nothing was deployed either way.' }
      }
      if (!denied) {
        // The claim is a gate on the MESSAGE here, not on a side effect. Saying
        // "Deploy declined. The host stays where it is" to a Deny that lost the
        // race to an Approve would be a flat lie: the deploy already went out.
        // Report the status the row actually settled at.
        const settled = approvals.get(id)?.status ?? 'decided'
        return {
          body: `That deploy request was already ${settled} — this tap changed nothing.`,
        }
      }
      return { body: `Deploy declined. The host stays where it is; nothing was deployed.` }
    }

    // ── (c) STALE-SHA GATE, BEFORE the decision is recorded. The approval is
    // bound to ONE sha. If the ref moved between the ask and the answer, the
    // owner approved a commit list that is no longer what would deploy, and
    // running it anyway would silently convert "approve THIS" into "deploy
    // whatever is newest" — a different and unbounded permission.
    let live_sha: string | null
    try {
      live_sha = await git.resolveTarget(ref)
    } catch (err) {
      await cancel(id)
      return {
        body: `Could not re-check ${ref} to confirm the approval still matches, so nothing was deployed: ${errText(err)}`,
      }
    }
    if (live_sha === null) {
      await cancel(id)
      return {
        body: `The host checkout no longer knows ${ref}, so nothing was deployed. Ask again.`,
      }
    }
    if (live_sha !== approved_sha) {
      // The approval dies with the sha it was bound to — it must never be
      // replayable against the new target. Claim-gated for the same reason the age
      // gate is: the replacement grant must be raised exactly once, and only by
      // the tap that actually retired this row.
      let claimed: boolean
      try {
        claimed = await approvals.cancelPending(id)
      } catch {
        claimed = false
      }
      if (!claimed) {
        const settled = approvals.get(id)?.status ?? 'decided'
        return { body: `That deploy request was already ${settled} — nothing was deployed.` }
      }
      return {
        body:
          `Stale approval — nothing was deployed. ${ref} moved from ${shortSha(approved_sha)} ` +
          `(what you approved) to ${shortSha(live_sha)} while this was waiting. ` +
          // The fresh grant binds to the NEW sha, so the owner is one tap from the
          // deploy he asked for instead of one round trip from re-asking.
          (await reraise(ref, input.topic_id)),
      }
    }

    // ── (d) CLAIM the row, atomically, BEFORE the call goes out. This is the
    // GATE on dispatch, not a bookkeeping step.
    //
    // Everything above this line — reading the row, re-resolving the sha —
    // happens across `await`s, so two taps that arrive in the same tick BOTH see
    // `status:'pending'` and BOTH pass the stale check. Whether either of them
    // may act is decided HERE and only here: `respondApproval` reports whether it
    // was the call that actually transitioned the row out of 'pending'
    // (`tools/approval.ts:145`), and exactly one racer can be told `true`. The
    // loser dispatches NOTHING. That closes both halves of the race: two Approves
    // cannot double-dispatch, and an Approve interleaved behind a Deny cannot
    // deploy something the owner just declined (Argus r1 BLOCKER).
    let claimed: boolean
    try {
      claimed = await approvals.respondApproval(id, 'approved', input.user_id)
    } catch (err) {
      log(`host-deploy approval not recorded id=${id}: ${errText(err)}`)
      return { body: 'Approval could not be recorded, so nothing was deployed. Ask again.' }
    }
    if (!claimed) {
      const settled = approvals.get(id)?.status ?? 'decided'
      log(`host-deploy approval lost the claim id=${id} status=${settled}`)
      return {
        body: `That deploy request was already ${settled} — nothing was deployed a second time.`,
      }
    }

    const outcome = await performDeploy(ref, approved_sha)
    return { body: `${outcome.body}` }
  }

  /**
   * THE ONE AUTHENTICATED CALL, and the only place in this file that makes it.
   *
   * Extracted so the owner's tap and a standing window (`requestWindow`) reach
   * the host through the SAME code — a second dispatch site is a second place
   * for the timeout wording, the secret scrubbing and the refusal handling to
   * drift, and the timeout wording in particular is load-bearing (a deploy
   * reported as "nothing happened" that had in fact succeeded is what taught
   * this file to distinguish silence from failure, 2026-08-15).
   *
   * `body` is written for the TAP path and is returned to it VERBATIM — its
   * wording is the wording that was reviewed, and the extraction must not have
   * reworded a single sentence of it. The window path ignores `body` entirely and
   * composes its own from `kind` + `detail`, because the two are not the same
   * event: one follows an affirmative tap ("Approved, but…"), the other follows a
   * permission granted hours earlier and has to say which.
   */
  async function performDeploy(
    ref: string,
    sha: string,
  ): Promise<{ kind: 'accepted' | 'refused' | 'timeout' | 'error' | 'unconfigured'; body: string; detail: string }> {
    // ── (e) RESOLVE THE ENDPOINT + CREDENTIAL NOW, not at composition time.
    const cfg = resolveConfig()
    if (!cfg.configured) {
      return {
        kind: 'unconfigured',
        detail: cfg.reason,
        body: `Approved, but nothing was deployed: ${cfg.reason}`,
      }
    }
    // The URL is ordinary configuration and useful diagnostic context. Only the
    // credential is secret; treating the URL as one makes real failures opaque.
    const secrets = [cfg.endpoint.token]

    // ── (f) THE ONE authenticated call.
    let result: HostDeployDispatchResult
    try {
      result = await dispatch({
        url: cfg.endpoint.url,
        token: cfg.endpoint.token,
        ref,
        sha,
      })
    } catch (err) {
      const detail = scrubHostDeploySecrets(errText(err), secrets)
      // A TIMEOUT IS NOT A FAILURE REPORT — it is the absence of one, and the two
      // must never share a sentence. The request had already been accepted and
      // authenticated; what expired is OUR patience. The deploy may be running
      // right now, may have finished, or may yet be refused by the gate, and this
      // process cannot tell which.
      //
      // It said "Nothing was deployed; ask again to retry" — an absence claim
      // with no evidence behind it, on top of an invitation to re-run an
      // operation that RESTARTS THE OWNER'S INSTANCE. On 2026-08-15 he got
      // exactly that message for a deploy that succeeded 55 seconds later, and
      // the only reason a second one did not follow is that he asked first.
      //
      // ⇒ report what is true (we stopped waiting), name the state as unknown,
      // and point at the check that CAN answer it. Never invite a blind retry of
      // a non-idempotent action whose outcome is unobserved.
      if (isDispatchTimeout(err)) {
        log(`host-deploy call TIMED OUT ref=${ref} sha=${shortSha(sha)}: ${detail}`)
        return {
          kind: 'timeout',
          detail,
          body:
            `Approved, and the deploy was requested — but I stopped waiting for the answer after ` +
            `${Math.round(HOST_DEPLOY_CALL_TIMEOUT_MS / 1000)}s. ${detail}\n\n` +
            `**It may still be running, and it may already have succeeded.** A deploy takes minutes ` +
            `(the contract gate runs the full test suite before anything is bumped), so a timeout here ` +
            `says only that I gave up listening — not that nothing happened.\n\n` +
            `Ask for the deploy status rather than re-approving: a second deploy would restart the ` +
            `instance again.`,
        }
      }
      log(`host-deploy call failed ref=${ref} sha=${shortSha(sha)}: ${detail}`)
      return {
        kind: 'error',
        detail,
        body: `Approved, but the deploy request did not go through: ${detail}. Nothing was deployed; ask again to retry.`,
      }
    }

    const detail = scrubHostDeploySecrets(result.detail, secrets).slice(0, HOST_DEPLOY_DETAIL_CAP)
    log(
      `host-deploy call ${result.ok ? 'accepted' : 'refused'} ref=${ref} sha=${shortSha(sha)}: ${detail}`,
    )
    if (result.ok) {
      return {
        kind: 'accepted',
        detail,
        body: `Deploy requested: ${ref} at ${shortSha(sha)}. ${detail}`,
      }
    }
    // A REFUSED contract gate is a normal outcome here — the host said no, which
    // is the system working. It reads as a sentence, not as a crash.
    return {
      kind: 'refused',
      detail,
      body: `The host refused the deploy of ${ref} at ${shortSha(sha)}: ${detail}. Nothing was deployed.`,
    }
  }

  /**
   * RAISE the window-grant prompt. Opens nothing: like `request()`, this returns
   * `pending_approval` and the permission exists only after the owner taps.
   *
   * It deliberately does NOT resolve a sha or render a commit list. There is no
   * commit list to render — the commits this authorises have not been written
   * yet, and showing today's would imply a binding to them that a window does not
   * have. What the owner is agreeing to is stated in words instead
   * (`renderWindowApprovalBody`).
   */
  async function requestWindow(input: {
    hours: number
    ref?: string
    topic_id?: string | null
  }): Promise<HostDeployWindowRequestResult> {
    const requested_topic =
      typeof input.topic_id === 'string' && input.topic_id.length > 0 ? input.topic_id : null
    const approval_topic = requested_topic ?? approval_topic_id

    // Same order as `request()`: an unconfigured box never mints a grant the
    // owner could tap into a guaranteed failure.
    const cfg = resolveConfig()
    if (!cfg.configured) return { status: 'unavailable', reason: cfg.reason }

    const ref = (input.ref ?? default_ref).trim()
    if (!HOST_DEPLOY_REF_RE.test(ref)) {
      return {
        status: 'refused',
        reason: `${JSON.stringify(ref)} is not a usable git ref (letters, digits, . _ / - only, 1-200 chars)`,
      }
    }
    // ONE REF MAY BE STOOD DOWN, AND IT IS THE DEFAULT ONE. A standing grant on
    // an arbitrary ref would let the permission be pointed at a branch the owner
    // never reviews — "deploy without asking" is only a bounded promise while
    // the thing being deployed is the trunk he already watches. Every other ref
    // keeps its per-sha tap. (Plan constraint: do not auto-deploy a ref other
    // than the configured default.)
    if (ref !== default_ref) {
      return {
        status: 'refused',
        reason:
          `a standing deploy window is only available for the default ref (${default_ref}); ` +
          `${ref} keeps its per-sha approval`,
      }
    }

    const validated = validateWindowHours(input.hours)
    if ('reason' in validated) return { status: 'refused', reason: validated.reason }
    const { hours } = validated

    // An open window is not extended by asking again — that would let a caller
    // ratchet a 1-hour grant into a permanent one an hour at a time, which is
    // exactly the unbounded permission the ceiling exists to prevent. The owner
    // must close the current one first, so every extension is a decision.
    const open = liveWindow(ref)
    if (open !== null) {
      return {
        status: 'refused',
        reason:
          `a deploy window for ${ref} is already open for another ` +
          `${describeRemaining(open.expires_at_ms, now())} — close it first to change the duration`,
      }
    }

    const granted_at = now()
    const expires_at_ms = windowExpiryMs(granted_at, hours)
    const approval_id = crypto.randomUUID()
    const decision = approvals.requestApproval({
      id: approval_id,
      project_slug,
      topic_id: approval_topic,
      tool_name: HOST_DEPLOY_WINDOW_TOOL_NAME,
      policy: 'prompt-user',
      args: {
        ref,
        hours,
        // FIXED AT GRANT TIME, not at tap time. The owner approves a body that
        // names a closing time; binding the row to that same instant means the
        // permission cannot outlive what he read, and a tap that arrives late
        // simply gets a shorter window rather than a later one.
        expires_at_ms,
        description: `deploy ${ref} without asking for ${hours} hour${hours === 1 ? '' : 's'}`,
      },
    })
    fireAndForget('host-deploy.window', decision, (err: unknown) => {
      log(`host-deploy window ${approval_id} did not resolve: ${errText(err)}`)
    })

    let emitted: { prompt_id: string | null }
    try {
      const approve_value = `${HOST_DEPLOY_WINDOW_VALUE_PREFIX}${uuidToToken(approval_id)}:a`
      const deny_value = `${HOST_DEPLOY_WINDOW_VALUE_PREFIX}${uuidToToken(approval_id)}:d`
      emitted = await emit({
        topic_id: approval_topic,
        body: renderWindowApprovalBody({
          ref,
          hours,
          expires_at_ms,
          now_ms: granted_at,
          approve_value,
          deny_value,
        }),
        options: windowApprovalOptions(approve_value, deny_value),
        idempotency_key: `host-deploy-window:${approval_id}`,
        metadata: { kind: 'host-deploy-window', ref, hours },
      })
    } catch (err) {
      try {
        await approvals.cancelPending(approval_id)
      } catch {
        /* best-effort */
      }
      return {
        status: 'refused',
        reason: `the window prompt could not be posted, so nothing is pending — ask again: ${errText(err)}`,
      }
    }

    if (emitted.prompt_id !== null) {
      try {
        await approvals.recordPromptLink(approval_id, emitted.prompt_id)
      } catch (err) {
        log(`host-deploy window prompt link not recorded id=${approval_id}: ${errText(err)}`)
      }
    }

    log(
      `host-deploy window pending_approval ref=${ref} hours=${hours} topic=${approval_topic}`,
    )
    return {
      status: 'pending_approval',
      request_id: uuidToToken(approval_id),
      ref,
      hours,
      expires_at_ms,
      approval_topic_id: approval_topic,
      ...(requested_topic === null
        ? {
            note:
              `The Approve/Deny prompt was posted to the owner's General chat topic (${approval_topic}). ` +
              'Tell the owner where to find it.',
          }
        : {}),
    }
  }

  function windowStatus(ref?: string): HostDeployWindowStatus {
    const target = (ref ?? default_ref).trim()
    const open = liveWindow(target)
    return {
      open: open !== null,
      ref: target,
      expires_at_ms: open?.expires_at_ms ?? null,
      remaining: open === null ? null : describeRemaining(open.expires_at_ms, now()),
    }
  }

  /**
   * CLOSE every live window for `ref`. Claim-gated per row through
   * `revokeApproved`, so the count is what THIS call closed and two racing
   * revocations cannot both report having done it.
   */
  async function revokeWindow(ref?: string): Promise<number> {
    const target = (ref ?? default_ref).trim()
    const rows = approvals.findByToolName(project_slug, HOST_DEPLOY_WINDOW_TOOL_NAME)
    const at = now()
    let closed = 0
    for (const row of rows) {
      // Only LIVE windows for this ref. An already-lapsed row is left exactly as
      // it is: rewriting its `decided_at` would relabel a permission that ended
      // on its own clock as one the owner took back.
      if (readLiveWindow(row, target, at) === null) continue
      let claimed: boolean
      try {
        claimed = await approvals.revokeApproved(row.id)
      } catch (err) {
        log(`host-deploy window could not be revoked ${row.id}: ${errText(err)}`)
        claimed = false
      }
      if (claimed) closed += 1
    }
    if (closed > 0) log(`host-deploy window revoked ref=${target} closed=${closed}`)
    return closed
  }

  async function cancel(id: string): Promise<void> {
    try {
      await approvals.cancelPending(id)
    } catch {
      /* best-effort — the TTL sweep is the backstop */
    }
  }

  /**
   * A DEAD GRANT IS SWEPT WITHOUT A TAP. Every host-deploy row still `pending`
   * past {@link HOST_DEPLOY_APPROVAL_TTL_MS} is retired here: the row is expired,
   * its still-rendered button prompt is retired, and the topic the prompt landed
   * on is told — in an INERT sentence — that it expired and nothing was deployed.
   *
   * SCOPED TO HOST-DEPLOY ROWS, DELIBERATELY. `findByToolName(project_slug,
   * 'host-deploy')` is the whole scan; `ApprovalManager.expireStale()` is NOT
   * called, and must not be, because a global 5-minute sweep would also expire
   * every pending RITUAL grant — rows the owner may legitimately answer days
   * later, with no re-raise path of their own.
   *
   * CLAIM-GATED PER ROW. `cancelPending(id)` performs the identical
   * pending→'expired' transition, atomically, and reports whether THIS call made
   * it. A row a tap decided between the scan and the claim is skipped: not
   * counted, no button retired, no notice posted. So the owner is told "it
   * expired" exactly once, and never about a grant he just answered.
   *
   * IT NEVER DEPLOYS AND NEVER RE-RAISES. The sweep touches `dispatch` on no
   * path — a tick that could deploy would be an unattended deploy — and it does
   * not mint a replacement grant either: the re-raise belongs to a tap, which is
   * evidence the owner is present.
   */
  async function sweepExpiredGrants(): Promise<number> {
    const rows = approvals.findByToolName(project_slug, HOST_DEPLOY_APPROVAL_TOOL_NAME)
    let swept = 0
    for (const row of rows) {
      if (row.status !== 'pending') continue
      if (now() - row.requested_at * 1000 <= HOST_DEPLOY_APPROVAL_TTL_MS) continue

      let claimed: boolean
      try {
        claimed = await approvals.cancelPending(row.id)
      } catch (err) {
        log(`host-deploy sweep could not expire ${row.id}: ${errText(err)}`)
        claimed = false
      }
      // The loser of a race with a tap says nothing at all: the tap already
      // answered the owner, and a second "it expired" would contradict it.
      if (!claimed) continue
      swept += 1

      const args = parseApprovalArgs(row.args_json)
      const ref = typeof args.ref === 'string' ? args.ref : null
      const target_sha = typeof args.target_sha === 'string' ? args.target_sha : null
      const prompt_id = typeof args.prompt_id === 'string' ? args.prompt_id : null
      // The grant's OWN topic — where its button is actually drawn. The install
      // fallback covers a row minted before the topic was recorded.
      const topic = row.topic_id ?? approval_topic_id

      if (prompt_id !== null && retire_prompt !== undefined) {
        try {
          await retire_prompt({ prompt_id, topic_id: topic })
        } catch (err) {
          // One unretirable button must not stop the rest of the sweep.
          log(`host-deploy sweep could not retire prompt ${prompt_id}: ${errText(err)}`)
        }
      }

      if (post_notice !== undefined) {
        const what =
          ref !== null && target_sha !== null ? ` for ${ref} at ${shortSha(target_sha)}` : ''
        try {
          await post_notice(
            topic,
            `The host-deploy approval${what} sat unanswered for over ` +
              `${Math.round(HOST_DEPLOY_APPROVAL_TTL_MS / 60_000)} minutes and has expired — ` +
              'nothing was deployed. Ask again for a fresh Approve/Deny prompt.',
          )
        } catch (err) {
          log(`host-deploy sweep could not post the expiry notice on ${topic}: ${errText(err)}`)
        }
      }

      log(`host-deploy grant swept id=${row.id} topic=${topic}${ref !== null ? ` ref=${ref}` : ''}`)
    }
    return swept
  }

  return {
    status,
    request,
    handleOwnerButtonAnswer,
    sweepExpiredGrants,
    requestWindow,
    windowStatus,
    revokeWindow,
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
