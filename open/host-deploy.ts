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
 * `APPROVAL_DEFAULT_TTL_MS` (`tools/approval.ts:67`), but is enforced HERE, on
 * the answer, rather than relying on the expire sweep: `expireStale()` has no
 * production caller on this box, so a grant's documented lifetime was inert and
 * a day-old Approve on an unmoved ref would still have deployed (Argus r1
 * minor). Checked against the row's own `requested_at`, so it holds whether or
 * not anything ever sweeps.
 */
export const HOST_DEPLOY_APPROVAL_TTL_MS = 5 * 60_000

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
  | { status: 'unavailable'; reason: string }
  | { status: 'up_to_date'; ref: string; target_sha: string }
  | { status: 'refused'; reason: string }

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
  emit: (p: HostDeployEmit) => Promise<void>
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
}

/** The `tool_approvals.args_json` payload for a host-deploy request. */
interface HostDeployApprovalArgs {
  ref?: unknown
  target_sha?: unknown
  current_sha?: unknown
  /** Rendered by the notifier as the "an approval is waiting" one-liner. */
  description?: unknown
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
  } = opts
  const log = opts.log ?? ((): void => undefined)
  const default_ref = opts.default_ref ?? HOST_DEPLOY_DEFAULT_REF
  const now = opts.now ?? Date.now

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
      await emit({
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

  async function handleOwnerButtonAnswer(
    input: HostDeployOwnerAnswerInput,
  ): Promise<{ body: string } | null> {
    const value = input.user_text.trim()

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

    // ── (b2) THE GRANT'S OWN AGE. `requested_at` is seconds since epoch. This is
    // enforced on the ANSWER rather than left to `ApprovalManager.expireStale()`,
    // which nothing on this box calls — the documented 5-minute window was inert,
    // so a grant tapped the next morning on an unmoved ref still deployed (Argus
    // r1 minor). The row is expired as it is refused, so the same tap cannot be
    // repeated into a race with a sweep that may never come.
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

    // ── (e) RESOLVE THE ENDPOINT + CREDENTIAL NOW, not at composition time.
    const cfg = resolveConfig()
    if (!cfg.configured) {
      return { body: `Approved, but nothing was deployed: ${cfg.reason}` }
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
        sha: approved_sha,
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
        log(`host-deploy call TIMED OUT ref=${ref} sha=${shortSha(approved_sha)}: ${detail}`)
        return {
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
      log(`host-deploy call failed ref=${ref} sha=${shortSha(approved_sha)}: ${detail}`)
      return {
        body: `Approved, but the deploy request did not go through: ${detail}. Nothing was deployed; ask again to retry.`,
      }
    }

    const detail = scrubHostDeploySecrets(result.detail, secrets).slice(0, HOST_DEPLOY_DETAIL_CAP)
    log(
      `host-deploy call ${result.ok ? 'accepted' : 'refused'} ref=${ref} sha=${shortSha(approved_sha)}: ${detail}`,
    )
    if (result.ok) {
      return {
        body: `Deploy requested: ${ref} at ${shortSha(approved_sha)}. ${detail}`,
      }
    }
    // A REFUSED contract gate is a normal outcome here — the host said no, which
    // is the system working. It reads as a sentence, not as a crash.
    return {
      body: `The host refused the deploy of ${ref} at ${shortSha(approved_sha)}: ${detail}. Nothing was deployed.`,
    }
  }

  async function cancel(id: string): Promise<void> {
    try {
      await approvals.cancelPending(id)
    } catch {
      /* best-effort — the TTL sweep is the backstop */
    }
  }

  return { status, request, handleOwnerButtonAnswer }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
