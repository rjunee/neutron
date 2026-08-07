/**
 * @neutronai/github — GitHub OAuth **device flow**, the credential path for a
 * headless instance.
 *
 * WHY DEVICE FLOW AND NOT A PASTED TOKEN. An instance does the owner's coding
 * work, so it needs to push and open pull requests on the owner's repos. The
 * obvious shortcut is a Personal Access Token pasted into a config file, and it
 * is the wrong shape three times over: it is long-lived, nobody rotates it, and
 * on a self-hosted box it sits on disk indefinitely with no record of what
 * minted it. Device flow asks the owner to approve a short code in a browser and
 * hands the instance a token bound to a real OAuth app — the same shape as the
 * existing install-token handoff, and the same shape Google's grant already
 * uses. Nothing is copy-pasted and nothing long-lived is written by a
 * provisioning script.
 *
 * WHY THIS FILE HAS NO NETWORK, CLOCK OR STORE OF ITS OWN. `fetch`, `now` and
 * `sleep` are injected. The polling loop below is the part with real edge cases
 * — `slow_down` mutates the interval, `expired_token` must stop, a pending
 * response must NOT be mistaken for a failure — and none of that is testable
 * against a live GitHub. Keeping the protocol pure means the loop is exercised
 * directly rather than inferred from a working demo.
 *
 * WHAT THIS FILE NEVER DOES: log, print, or return a token in any error path.
 * The token is the return value of exactly one function and nothing else in here
 * touches it. A token in a log is a credential in a log.
 *
 * Protocol reference: GitHub "Device flow" —
 * `POST https://github.com/login/device/code` then poll
 * `POST https://github.com/login/oauth/access_token` with
 * `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
 */

/** Minimal `fetch` shape, so a test needs no network and no DOM types. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export const DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'

/**
 * Scopes the instance asks for. `repo` covers private-repo clone/push and pull
 * requests, which is the whole point; `read:org` lets a repo inside an org
 * resolve. Deliberately NOT `workflow` (editing CI from an agent loop is a
 * privilege nobody asked for) and NOT `delete_repo`.
 */
export const DEFAULT_SCOPES = 'repo read:org' as const

/** What GitHub returns from the first call, plus what the owner must be shown. */
export interface DeviceCodeGrant {
  /** Opaque; used only when polling. Never shown to the owner. */
  device_code: string
  /** The SHORT code the owner types into the browser (e.g. `ABCD-1234`). */
  user_code: string
  /** Where the owner goes to enter it. */
  verification_uri: string
  /** Seconds between polls, per GitHub. Treated as a FLOOR, never a constant. */
  interval_seconds: number
  /** Seconds until `device_code` expires. */
  expires_in_seconds: number
}

export type DeviceFlowFailure =
  /** The owner declined in the browser. Terminal. */
  | 'access_denied'
  /** The device code expired before approval. Terminal; start over. */
  | 'expired_token'
  /** Our own deadline elapsed while GitHub still said pending. Terminal here. */
  | 'timeout'
  /** Non-2xx, unparseable body, or an error code GitHub did not document. */
  | 'protocol_error'

export class GitHubDeviceFlowError extends Error {
  constructor(
    readonly reason: DeviceFlowFailure,
    message: string,
  ) {
    super(message)
    this.name = 'GitHubDeviceFlowError'
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function str(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Step 1 — ask GitHub for a device code. Returns what the owner must be shown.
 *
 * A missing field here is a `protocol_error` rather than a defaulted value: if
 * GitHub did not give us a `user_code` there is nothing to show the owner, and
 * inventing an interval would make the poll loop misbehave against a server that
 * just told us something unexpected.
 */
export async function requestDeviceCode(input: {
  client_id: string
  fetchImpl: FetchLike
  scopes?: string
}): Promise<DeviceCodeGrant> {
  const body = new URLSearchParams({
    client_id: input.client_id,
    scope: input.scopes ?? DEFAULT_SCOPES,
  }).toString()
  const res = await input.fetchImpl(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    throw new GitHubDeviceFlowError('protocol_error', `device-code request failed: HTTP ${res.status}`)
  }
  const rec = asRecord(await res.json())
  const device_code = str(rec, 'device_code')
  const user_code = str(rec, 'user_code')
  const verification_uri = str(rec, 'verification_uri')
  if (device_code === null || user_code === null || verification_uri === null) {
    throw new GitHubDeviceFlowError(
      'protocol_error',
      'device-code response missing device_code / user_code / verification_uri',
    )
  }
  return {
    device_code,
    user_code,
    verification_uri,
    // GitHub documents 5s; treat a missing/blank value as that floor rather
    // than polling as fast as the loop can spin, which earns a `slow_down`.
    interval_seconds: num(rec, 'interval') ?? 5,
    expires_in_seconds: num(rec, 'expires_in') ?? 900,
  }
}

export interface PollDeps {
  fetchImpl: FetchLike
  /** Milliseconds. Injected so a test controls the deadline exactly. */
  now: () => number
  /** Injected so a test does not actually wait. */
  sleep: (ms: number) => Promise<void>
}

/**
 * Step 2 — poll until the owner approves, GitHub refuses, or we run out of time.
 *
 * Returns the access token. **This is the only function in this module that
 * returns token material, and no error path includes it.**
 *
 * The three behaviours worth stating, because each is a way to get this subtly
 * wrong:
 *
 *  * `authorization_pending` is the NORMAL case, not a failure. It means the
 *    owner has not finished typing the code yet. Treating it as an error would
 *    make the flow fail for every owner who takes more than one interval.
 *  * `slow_down` REQUIRES backing off. GitHub's contract is that the interval
 *    increases by 5 seconds, and continuing at the old rate earns escalating
 *    rejections. The new interval persists for the rest of the loop — it is not
 *    a one-off pause.
 *  * `expired_token` and `access_denied` are TERMINAL. Retrying either is
 *    pointless traffic against a decision already made.
 */
export async function pollForAccessToken(input: {
  client_id: string
  grant: DeviceCodeGrant
  deps: PollDeps
  /** Overall budget. Defaults to the grant's own expiry. */
  deadline_ms?: number
}): Promise<string> {
  const { deps, grant } = input
  const started = deps.now()
  const budget = input.deadline_ms ?? grant.expires_in_seconds * 1000
  let interval_ms = grant.interval_seconds * 1000

  const body = new URLSearchParams({
    client_id: input.client_id,
    device_code: grant.device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  }).toString()

  for (;;) {
    if (deps.now() - started >= budget) {
      throw new GitHubDeviceFlowError('timeout', 'device flow was not approved before the deadline')
    }
    await deps.sleep(interval_ms)
    const res = await deps.fetchImpl(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    // A non-2xx here is NOT automatically fatal: GitHub answers 200 with an
    // `error` field for the pending case, but a transient 5xx should be retried
    // rather than ending a flow the owner may already have approved.
    if (!res.ok && res.status < 500) {
      throw new GitHubDeviceFlowError('protocol_error', `token poll failed: HTTP ${res.status}`)
    }
    if (res.ok) {
      const rec = asRecord(await res.json())
      const token = str(rec, 'access_token')
      if (token !== null) return token
      const error = str(rec, 'error')
      switch (error) {
        case 'authorization_pending':
          break
        case 'slow_down': {
          // Per GitHub: back off by 5s, and KEEP the new interval.
          const bumped = num(rec, 'interval')
          interval_ms = bumped !== null ? bumped * 1000 : interval_ms + 5_000
          break
        }
        case 'access_denied':
          throw new GitHubDeviceFlowError('access_denied', 'the owner declined the authorization')
        case 'expired_token':
          throw new GitHubDeviceFlowError('expired_token', 'the device code expired before approval')
        default:
          throw new GitHubDeviceFlowError(
            'protocol_error',
            `token poll returned an unrecognized error: ${error ?? '(none)'}`,
          )
      }
    }
    // 5xx falls through to the next iteration, subject to the deadline.
  }
}
