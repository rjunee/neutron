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
 *     the env vars that would enable it. It is never hidden and never invents a
 *     default endpoint.
 *  7. THE ENDPOINT AND CREDENTIAL ARE RESOLVED AT CALL TIME, never captured at
 *     composition time — a credential read at composition time is a credential
 *     that is never there (Decisions Log 2026-08-07). Neither ever enters a
 *     prompt, a log line or a chat message: everything the control plane says is
 *     run through {@link scrubHostDeploySecrets} before it is shown or logged.
 */

import type { ButtonOption } from '@neutronai/channels/button-primitive.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import type { ApprovalManager } from '@neutronai/tools/approval.ts'
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

/** Ref charset guard — refs are shelled to `git`, so keep them boring. */
export const HOST_DEPLOY_REF_RE = /^[A-Za-z0-9._/-]{1,200}$/

/** How many commits the approval body itemizes before it says "and N more". */
export const HOST_DEPLOY_COMMIT_RENDER_CAP = 40

/** Longest commit subject rendered; longer ones are elided with a `…`. */
export const HOST_DEPLOY_SUBJECT_CAP = 120

/** The instance-configuration env var naming the control-plane endpoint. */
export const HOST_DEPLOY_URL_ENV = 'NEUTRON_HOST_DEPLOY_URL' as const

/** The instance-configuration env var carrying the endpoint credential. */
export const HOST_DEPLOY_TOKEN_ENV = 'NEUTRON_HOST_DEPLOY_TOKEN' as const

/** Hard ceiling on the ONE authenticated control-plane call. */
export const HOST_DEPLOY_CALL_TIMEOUT_MS = 30_000

/** Longest slice of a control-plane response body echoed into chat. */
export const HOST_DEPLOY_DETAIL_CAP = 400

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
 */
export const HOST_DEPLOY_BANNED_SUBJECT_CHARS_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

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
 * The read-only git surface this module needs against the checkout the host
 * runs. READ-ONLY by construction: there is no fetch, no checkout and no write
 * here, because the instance does not deploy — it describes.
 */
export interface HostDeployGit {
  /** Full sha for `ref`, or null when this checkout does not know the ref. */
  revParse(ref: string): Promise<string | null>
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
    }
  | { status: 'unavailable'; reason: string }
  | { status: 'up_to_date'; ref: string; target_sha: string }
  | { status: 'refused'; reason: string }

// ── Configuration (CALL TIME) ────────────────────────────────────────────────

export type EnvBag = Record<string, string | undefined>

/**
 * Resolve the control-plane endpoint from the process environment. Called on
 * EVERY request/approve — never memoized, never captured at composition time
 * (Decisions Log 2026-08-07: a credential read at composition time is a
 * credential that is never there). BOTH the URL and the credential are
 * required; there is NO default endpoint, because inventing one would point a
 * self-hoster's deploy at somebody else's control plane.
 */
export function resolveHostDeployConfig(env: EnvBag): HostDeployConfigState {
  const url = (env[HOST_DEPLOY_URL_ENV] ?? '').trim()
  const token = (env[HOST_DEPLOY_TOKEN_ENV] ?? '').trim()
  if (url.length === 0) {
    return {
      configured: false,
      reason:
        `No host-deploy endpoint is configured on this instance, so it cannot ask anything to deploy. ` +
        `Set ${HOST_DEPLOY_URL_ENV} and ${HOST_DEPLOY_TOKEN_ENV} to enable it. ` +
        `A self-hosted box has no endpoint to call — deploy it the way you always have.`,
    }
  }
  if (token.length === 0) {
    return {
      configured: false,
      reason:
        `${HOST_DEPLOY_URL_ENV} is set but ${HOST_DEPLOY_TOKEN_ENV} is empty, so a deploy request could not be ` +
        `authenticated. Set ${HOST_DEPLOY_TOKEN_ENV} to enable it.`,
    }
  }
  if (!/^https:\/\//i.test(url)) {
    return {
      configured: false,
      reason:
        `${HOST_DEPLOY_URL_ENV} must be an https:// URL — the deploy credential is sent on that call, ` +
        `so a plaintext endpoint is refused.`,
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
 * Short values are skipped — redacting a 2-character "secret" would blank out
 * unrelated prose without protecting anything.
 */
export function scrubHostDeploySecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 6) continue
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
}): string {
  const { ref, current_sha, target_sha, commits, total } = input
  const lines = commits.map(
    (c) => `${shortSha(c.sha)}  ${sanitizeCommitSubject(c.subject)}`,
  )
  const hidden = total - commits.length
  if (hidden > 0) lines.push(`… and ${hidden} more commit${hidden === 1 ? '' : 's'}`)
  const listing = lines.length > 0 ? lines.join('\n') : '(no new commits)'
  const fence = safeFence(listing)

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
  } else {
    parts.push(
      'No new commits are between these two — approving would move the host SIDEWAYS or BACKWARD to a different sha:',
    )
  }
  parts.push(`${fence}\n${listing}\n${fence}`)
  parts.push('')
  parts.push(
    'Nothing is deployed unless you tap Approve. This approval is bound to ' +
      `${shortSha(target_sha)} — if ${ref} moves before you answer, it is refused and you are asked again.`,
  )
  parts.push('Tap Approve or Deny. Typing anything else will NOT approve this deploy.')
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
  approval_topic_id: string
  emit: (p: HostDeployEmit) => Promise<void>
  log?: (msg: string) => void
  default_ref?: string
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
  /** Resolve + raise an approval. Deploys NOTHING. */
  request(input: { ref?: string }): Promise<HostDeployRequestResult>
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

  function status(): HostDeployStatus {
    const cfg = resolveConfig()
    return {
      enabled: cfg.configured,
      reason: cfg.configured ? null : cfg.reason,
      default_ref,
    }
  }

  async function request(input: { ref?: string }): Promise<HostDeployRequestResult> {
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

    // ── (b) resolve what WOULD be deployed. Read-only; nothing is fetched.
    let target_sha: string | null
    let current_sha: string | null
    try {
      target_sha = await git.revParse(ref)
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
    try {
      range = await git.commitsBetween(current_sha, target_sha, HOST_DEPLOY_COMMIT_RENDER_CAP)
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
      topic_id: approval_topic_id,
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
      const options: ButtonOption[] = [
        {
          label: 'Approve',
          body: 'Approve this host deploy',
          value: `${HOST_DEPLOY_VALUE_PREFIX}${uuidToToken(approval_id)}:a`,
        },
        {
          label: 'Deny',
          body: 'Deny this host deploy',
          value: `${HOST_DEPLOY_VALUE_PREFIX}${uuidToToken(approval_id)}:d`,
        },
      ]
      await emit({
        body: renderHostDeployApprovalBody({
          ref,
          current_sha,
          target_sha,
          commits: range.commits,
          total: range.total,
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

    log(`host-deploy pending_approval ref=${ref} target=${shortSha(target_sha)} commits=${range.total}`)
    return {
      status: 'pending_approval',
      request_id: uuidToToken(approval_id),
      ref,
      target_sha,
      current_sha,
      commit_count: range.total,
    }
  }

  async function handleOwnerButtonAnswer(
    input: HostDeployOwnerAnswerInput,
  ): Promise<{ body: string } | null> {
    const value = input.user_text.trim()

    // ── (a) ELIGIBILITY. An EXACT opaque token AND membership in the persisted
    // option set of a recent prompt. Silence, a timeout, "yes", a paraphrase or
    // any unrelated reply is not an approval and never reaches a row — the same
    // discipline as `onboarding/interview/button-backed-answer.ts:207-209`.
    if (!HOST_DEPLOY_VALUE_RE.test(value)) return null
    if (!input.prior_option_values.includes(value)) return null

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
    if (row.status !== 'pending') {
      // Includes 'expired' — an approval that timed out is NOT an approval, and
      // re-tapping a decided row never re-runs a deploy.
      return {
        body: `That deploy request was already ${row.status} — nothing was deployed. Ask again to see the current commit list.`,
      }
    }

    let args: HostDeployApprovalArgs
    try {
      args = JSON.parse(row.args_json) as HostDeployApprovalArgs
    } catch {
      args = {}
    }
    const ref = typeof args.ref === 'string' ? args.ref : null
    const approved_sha = typeof args.target_sha === 'string' ? args.target_sha : null
    if (ref === null || approved_sha === null) {
      await cancel(id)
      return { body: 'That deploy request could not be read back — nothing was deployed. Ask again.' }
    }

    if (value.endsWith(':d')) {
      try {
        await approvals.respondApproval(id, 'denied', input.user_id)
      } catch (err) {
        log(`host-deploy deny not recorded id=${id}: ${errText(err)}`)
        return { body: 'That deny could not be recorded — but nothing was deployed either way.' }
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
      live_sha = await git.revParse(ref)
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
      // replayable against the new target.
      await cancel(id)
      return {
        body:
          `Stale approval — nothing was deployed. ${ref} moved from ${shortSha(approved_sha)} ` +
          `(what you approved) to ${shortSha(live_sha)} while this was waiting. ` +
          `Ask again to see the new commit list and approve that.`,
      }
    }

    // ── (d) record the owner's decision durably BEFORE the call goes out.
    try {
      await approvals.respondApproval(id, 'approved', input.user_id)
    } catch (err) {
      log(`host-deploy approval not recorded id=${id}: ${errText(err)}`)
      return { body: 'Approval could not be recorded, so nothing was deployed. Ask again.' }
    }

    // ── (e) RESOLVE THE ENDPOINT + CREDENTIAL NOW, not at composition time.
    const cfg = resolveConfig()
    if (!cfg.configured) {
      return { body: `Approved, but nothing was deployed: ${cfg.reason}` }
    }
    const secrets = [cfg.endpoint.token, cfg.endpoint.url]

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
