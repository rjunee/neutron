/**
 * @neutronai/trident — IS THE CODEX SEAT ACTUALLY ALIVE? The one question the
 * stored bundle cannot answer.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `deriveCodexStatus` reads the stored `auth.json` and nothing else. Its only
 * liveness test is the access token's own `exp` claim, which is A NUMBER THE
 * SERVER WROTE DOWN BEFORE IT CHANGED ITS MIND. A subscription revoked
 * server-side — the owner logged the same ChatGPT account in somewhere else and
 * the CLI rotated the refresh token out from under this copy — leaves every
 * local field untouched: the JWT still parses, `exp` is still days away, the
 * refresh token is still present. So the status said `connected` while every
 * build died on `refresh_token_invalidated`, and a lane spent ~15 minutes
 * assembling a brief before finding out.
 *
 * There is no local fix for that, because the fact is not local. The only way to
 * learn a token was revoked is to ASK, so this module asks: one authenticated GET
 * against the endpoint the CLI itself calls first, which costs no quota and
 * answers in ~200ms.
 *
 * ── CLASSIFY ON THE STATUS CODE AND THE CLOCK, NEVER ON THE BODY ─────────────
 * The error CODE in the body is NOT stable. Measured 2026-08-20 on one box, one
 * URL, one credential: 19:07 returned `token_invalidated`, 21:29 returned
 * `token_revoked`. Both were HTTP 401. So the verdict is a function of (HTTP
 * status) and (whether the token's own `exp` is still in the future) — the second
 * half is what separates "the server disowned a token that should still be good"
 * (revoked; only a reconnect fixes it) from "the token simply aged out" (expired;
 * already reported from the stored bytes, no probe needed).
 *
 * ── EVERY UNCERTAIN ANSWER IS TRANSIENT, ON PURPOSE ─────────────────────────
 * The caller turns `revoked` into the `unauthorized` cooldown, which NEVER
 * expires on a timer and is cleared only by a reconnect. That makes a false
 * `revoked` the worst outcome this module can produce: it would brick a healthy
 * seat on a box that merely lost its network for a second. So a timeout, a
 * transport failure, a 5xx, a 429 and an unexpected 4xx are ALL distinct
 * non-verdicts, and none of them is `revoked`. A network-isolated self-hosted box
 * probes forever, always gets `unreachable`, and keeps working exactly as it does
 * today.
 */

/** The endpoint the codex CLI authenticates against first. */
export const CODEX_PROBE_BASE_URL = 'https://chatgpt.com/backend-api/codex/models'

/**
 * The `client_version` the probe presents.
 *
 * Cosmetic to the auth decision — a 401 for a revoked token is a 401 whatever the
 * version — but the parameter is on every real call the CLI makes, so sending it
 * keeps the probe indistinguishable from ordinary traffic.
 */
export const CODEX_PROBE_CLIENT_VERSION = '0.147.0'

/**
 * Bounded HARD, because a status GET is a POLLED surface.
 *
 * The settings pane polls codex status; a probe on that path with a generous
 * timeout would add a network round-trip per seat per poll and could earn a 429
 * of its own. Three seconds is enough for an endpoint that normally answers in
 * ~200ms and short enough that a wedged upstream costs the poll nothing it
 * notices. The per-seat TTL cache in `CodexCredentialService` is the other half.
 */
export const CODEX_PROBE_TIMEOUT_MS = 3_000

export type CodexProbeOutcome =
  /** The endpoint accepted the token. The seat is alive. */
  | { kind: 'ok'; httpStatus: number }
  /**
   * 401/403 while the token's own `exp` is STILL IN THE FUTURE — the server has
   * disowned a credential that looks perfectly good locally. PERMANENT: a revoked
   * refresh token does not heal by waiting, only by reconnecting.
   */
  | { kind: 'revoked'; httpStatus: number }
  /**
   * 401/403 on a token that had ALREADY expired by the caller's clock. Not a new
   * fact — the stored bytes say this — and deliberately NOT `revoked`, so the two
   * can never collapse into one owner-facing message.
   */
  | { kind: 'expired'; httpStatus: number }
  /** 429/408 — the seat is capped or throttled, which is cooling, not dead. */
  | { kind: 'rate_limited'; httpStatus: number }
  /**
   * Any OTHER 4xx (400/404/410/422). This endpoint is undocumented ChatGPT-backend
   * surface: if OpenAI moves it, EVERY seat starts 404ing at once, and folding that
   * into `revoked` would disconnect an entire install in one deploy. Loud and
   * separate, never a verdict on the credential.
   */
  | { kind: 'rejected'; httpStatus: number }
  /** Timeout, transport failure, 5xx, or no token to send. Transient. Never a verdict. */
  | { kind: 'unreachable'; message: string }

export interface CodexProbeDeps {
  /** Injected in tests; production uses the global. */
  fetch?: typeof fetch
  timeoutMs?: number
  /** Override the endpoint — tests point this at a local stub. */
  baseUrl?: string
  clientVersion?: string
}

export interface CodexProbeInput {
  /** The bearer token to present. Never logged, never returned. */
  accessToken: string
  /**
   * Whether the token's own `exp` claim is still in the future by the caller's
   * clock. Decided by the caller because the caller already decoded it; passing
   * the boolean rather than the token's claims keeps this module from growing a
   * second JWT parser that could disagree with `codex-auth.ts`.
   *
   * A token with no decodeable `exp` counts as `true`: an opaque token has no
   * stated expiry, so a 401 on one cannot be explained by age.
   */
  expInFuture: boolean
}

/**
 * Scrub anything token-shaped out of a message before it can be logged.
 *
 * A transport error's message is upstream text this module did not write, and the
 * one thing that must never appear in a log line is the credential. The token is
 * removed whole AND per dot-separated JWT segment, because a partial echo (the
 * header, the payload) is still credential material.
 */
export function redactToken(message: string, accessToken: string): string {
  if (accessToken.length === 0) return message
  let out = message
  const pieces = [accessToken, ...accessToken.split('.')]
  for (const piece of pieces) {
    // Short segments are not credential-bearing and blanket-replacing them would
    // mangle ordinary words; 8 is well below any real JWT segment length.
    if (piece.length < 8) continue
    out = out.split(piece).join('[redacted]')
  }
  return out
}

/**
 * Ask the endpoint whether this token still works. NEVER THROWS.
 *
 * Modelled on `trident/kimi-usage-probe.ts`: injectable `fetch`, an
 * `AbortSignal.timeout` bound, and a tagged outcome for every branch — a probe
 * that threw would have to be caught by a caller on the status path, and a status
 * path that can fail is a status path that reports nothing.
 */
export async function probeCodexSeat(
  input: CodexProbeInput,
  deps: CodexProbeDeps = {},
): Promise<CodexProbeOutcome> {
  const token = input.accessToken
  if (typeof token !== 'string' || token.trim().length === 0) {
    // Nothing to ask WITH. Not a verdict on the seat — the caller's own
    // `not_connected`/`expired` reading already covers a seat with no token, and
    // returning anything permanent here would let an empty string cool a slot.
    return { kind: 'unreachable', message: 'no access token to probe with' }
  }
  const base = deps.baseUrl ?? CODEX_PROBE_BASE_URL
  const version = deps.clientVersion ?? CODEX_PROBE_CLIENT_VERSION
  const url = `${base}${base.includes('?') ? '&' : '?'}client_version=${encodeURIComponent(version)}`
  const doFetch = deps.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(deps.timeoutMs ?? CODEX_PROBE_TIMEOUT_MS),
    })
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    return { kind: 'unreachable', message: redactToken(raw, token) }
  }
  const status = res.status
  if (status === 401 || status === 403) {
    // THE WHOLE CLASSIFICATION, in one line: the server said no, and the token's
    // own clock says it should have said yes. Deliberately NOT keyed on the body's
    // `code` field, which was measured returning two different strings for the
    // same condition two hours apart.
    return input.expInFuture ? { kind: 'revoked', httpStatus: status } : { kind: 'expired', httpStatus: status }
  }
  if (status === 429 || status === 408) return { kind: 'rate_limited', httpStatus: status }
  if (status >= 500) return { kind: 'unreachable', message: `upstream ${status}` }
  if (status >= 400) return { kind: 'rejected', httpStatus: status }
  return { kind: 'ok', httpStatus: status }
}
