/**
 * @neutronai/open — the two I/O halves of the host-deploy request path.
 *
 * `open/host-deploy.ts` holds the policy (resolve → approve → execute) behind
 * two narrow seams so every guard in it is testable without a repo or a network.
 * This module supplies the production implementations of those seams:
 *
 *   - {@link createHostDeployRemoteGit} — the control plane's view of the
 *     checkout it deploys, asked for over HTTP. **It used to be local git, and
 *     that is exactly why the owner could not deploy at all.**
 *   - {@link createHostDeployDispatch} — the ONE authenticated call to the
 *     configured control-plane endpoint. The credential goes in the
 *     `Authorization` header and NOWHERE else — not the body, not the URL, not
 *     the returned detail. The URL + token are passed IN per call (resolved at
 *     call time by the service), never captured here.
 *
 * The dispatch NEVER throws for an HTTP refusal. A control plane that says "no"
 * (a contract gate, a locked deploy window, an unknown sha) is a normal outcome
 * the owner should read as a sentence, so it comes back as `ok:false` with a
 * short detail. Only a genuinely unreachable endpoint produces a throw, and the
 * service catches that too.
 *
 * ── WHY RESOLVING MOVED OFF THIS BOX ────────────────────────────────────────
 * The git view here ran `git fetch` against the host checkout — deliberately, so
 * the approval renders the real commits rather than a name. **But a fetch always
 * writes `FETCH_HEAD`, and this process is not allowed to write there.** The
 * checkout belongs to the host and this service runs unprivileged, which is the
 * whole point: it may ASK for a deploy and may never perform one. So the resolve
 * failed with `Permission denied` and the owner could not deploy at all — while
 * the control plane's own endpoint, correctly, would only accept a sha this
 * process had no way to produce.
 *
 * Neither of those rules was wrong. **The resolve step was simply on the side of
 * the boundary with no write access**, so it moved across to join the deploy it
 * informs. 📌 The lesson generalises: when a privilege boundary is drawn, every
 * step that NEEDS the privilege has to move — not just the obviously dangerous
 * one. The innocuous-looking read ("what does this ref point at?") had a hidden
 * write inside it, which is why it was left behind and why nothing noticed until
 * a real deploy was attempted.
 */

import {
  HOST_DEPLOY_CALL_TIMEOUT_MS,
  HOST_DEPLOY_DETAIL_CAP,
  HOST_DEPLOY_REMOTE_TIMEOUT_MS,
  scrubHostDeploySecrets,
  type HostDeployCommit,
  type HostDeployCommitRange,
  type HostDeployConfigState,
  type HostDeployDispatch,
  type HostDeployGit,
} from './host-deploy.ts'

/**
 * The narrow slice of `fetch` this module calls — declared as its own type
 * rather than `typeof fetch` so a test double is a plain function, not an
 * object that also has to carry the runtime's `fetch.preconnect`.
 */
export type HostDeployFetch = (input: string, init: RequestInit) => Promise<Response>

/**
 * A {@link HostDeployGit} answered by the control plane instead of by local git.
 *
 * ── EVERY CALL RESOLVES ITS OWN CONFIG ──────────────────────────────────────
 * `resolveConfig` is invoked per request, never captured, for the same reason the
 * service resolves it per request: reading the endpoint and credential once at
 * construction bakes in whatever the store held at boot.
 *
 * ── ONE CONFIGURED URL, NOT TWO ─────────────────────────────────────────────
 * The preview lives at `<the configured deploy url>/preview`. Asking the owner to
 * configure a second URL adds a way for the pair to be half-set — an instance
 * that can deploy but not resolve, or the reverse, both of which surface as an
 * unexplainable refusal. One value cannot disagree with itself.
 *
 * ── AN UNCONFIGURED INSTANCE NEVER GETS HERE, AND STILL FAILS LOUDLY ────────
 * `host-deploy.ts` checks `configured` before it touches this seam, so a missing
 * endpoint is already answered as "disabled, and here is why". If that order ever
 * changes, a throw is the correct outcome: silently returning `null` would read
 * as "this checkout does not know that ref", which is a lie about the owner's
 * input rather than the truth about our own configuration.
 */
export function createHostDeployRemoteGit(opts: {
  resolveConfig: () => HostDeployConfigState
  timeout_ms?: number
  fetchImpl?: HostDeployFetch
}): HostDeployGit {
  const timeout_ms = opts.timeout_ms ?? HOST_DEPLOY_REMOTE_TIMEOUT_MS
  const doFetch = opts.fetchImpl ?? fetch

  async function ask(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    const cfg = opts.resolveConfig()
    if (!cfg.configured) throw new Error(`host deploy is not configured: ${cfg.reason}`)
    const { url, token } = cfg.endpoint
    const res = await doFetch(previewUrl(url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The credential appears HERE and nowhere else — not the body, not the
        // URL, not anything this function returns or throws.
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout_ms),
    })
    let parsed: unknown = null
    try {
      const text = (await res.text()).trim()
      parsed = text.length > 0 ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    return { status: res.status, json: parsed }
  }

  /**
   * A refusal that means "this checkout does not know that ref" is `null`, which
   * is what the interface documents. **Everything else throws**, and the
   * distinction is load-bearing: `host-deploy.ts` renders `null` as the owner's
   * ref being wrong and a throw as the machinery being wrong. Collapsing them
   * sends him hunting for a typo that is not there.
   */
  function shaOrNull(status: number, json: unknown, what: string): string | null {
    if (status === 404) return null
    if (status !== 200) throw new Error(`${what} failed (${status}): ${detailOf(json)}`)
    const sha = typeof json === 'object' && json !== null ? (json as { target_sha?: unknown }).target_sha : null
    return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null
  }

  return {
    async revParse(ref: string): Promise<string | null> {
      // `HEAD` is a ref like any other to the control plane — it rev-parses its
      // own checkout, which is the pin this instance is running.
      const { status, json } = await ask({ ref })
      if (ref === 'HEAD' && status === 200) {
        const cur =
          typeof json === 'object' && json !== null ? (json as { current_sha?: unknown }).current_sha : null
        if (typeof cur === 'string' && /^[0-9a-f]{40}$/.test(cur)) return cur
      }
      return shaOrNull(status, json, `resolving ${JSON.stringify(ref)}`)
    },

    async resolveTarget(ref: string): Promise<string | null> {
      const { status, json } = await ask({ ref })
      return shaOrNull(status, json, `resolving ${JSON.stringify(ref)}`)
    },

    async commitsBetween(from: string, to: string, limit: number): Promise<HostDeployCommitRange> {
      // BOTH ENDS ARE SENT. The control plane answers the range directly rather
      // than slicing a cached preview, so the REVERSED range — the check that
      // says a deploy would move sideways or backward — is a first-class answer
      // and not something reconstructed here.
      const { status, json } = await ask({ from, to, limit })
      if (status !== 200) {
        // NOT an empty range. An empty list renders as "nothing would change",
        // which is the opposite of the truth when the call merely failed — and
        // the owner would approve a deploy on the strength of it.
        throw new Error(`listing ${from}..${to} failed (${status}): ${detailOf(json)}`)
      }
      const body = (json ?? {}) as { commits?: unknown; total?: unknown }
      const commits: HostDeployCommit[] = Array.isArray(body.commits)
        ? body.commits.flatMap((c) => {
            const sha = typeof c === 'object' && c !== null ? (c as { sha?: unknown }).sha : null
            const subject = typeof c === 'object' && c !== null ? (c as { subject?: unknown }).subject : null
            if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return []
            return [{ sha, subject: typeof subject === 'string' ? subject : '' }]
          })
        : []
      const total = typeof body.total === 'number' && Number.isFinite(body.total) ? body.total : 0
      // Never claim fewer commits than are rendered — the same rule the control
      // plane applies, restated here because a malformed body must not break it.
      return { commits, total: Math.max(total, commits.length) }
    },
  }
}

/**
 * `<deploy url>/preview`. A trailing slash on the configured value is the
 * likeliest way for this to be written by hand, so it is normalised rather than
 * producing a `//preview` that 404s with no clue why.
 */
function previewUrl(url: string): string {
  return `${url.replace(/\/+$/, '')}/preview`
}

/** The control plane's `error` sentence when it sent one; never the raw body. */
function detailOf(json: unknown): string {
  const err = typeof json === 'object' && json !== null ? (json as { error?: unknown }).error : null
  return typeof err === 'string' && err.length > 0 ? err.slice(0, HOST_DEPLOY_DETAIL_CAP) : 'no detail'
}

/**
 * The ONE authenticated control-plane call. `POST { ref, sha }` with the
 * credential in `Authorization: Bearer`. Returns a short, caller-scrubbed
 * detail for BOTH outcomes — an HTTP refusal is data, not an exception.
 */
export function createHostDeployDispatch(
  opts: { timeout_ms?: number; fetchImpl?: HostDeployFetch } = {},
): HostDeployDispatch {
  const timeout_ms = opts.timeout_ms ?? HOST_DEPLOY_CALL_TIMEOUT_MS
  const doFetch = opts.fetchImpl ?? fetch
  return async ({ url, token, ref, sha }) => {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The credential appears HERE and nowhere else in this function.
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ref, sha }),
      signal: AbortSignal.timeout(timeout_ms),
    })
    let text = ''
    try {
      // SCRUB THE WHOLE BODY, THEN TRUNCATE — never the other way round. Slicing
      // first cuts the body at a fixed offset, and a credential straddling that
      // offset leaves a PREFIX of itself behind: the scrubber is a `split`/
      // `join` on the FULL secret, so a partial match is not a match and the
      // fragment rode into the owner's chat and the log intact (Argus r1 major,
      // reproduced independently by two reviewers). This function is the right
      // place for it because it is the only one holding both the url and the
      // token at the moment the bytes arrive; the service scrubs again on the
      // way out, which is cheap and keeps the guarantee local to each layer.
      const body = (await res.text()).trim()
      text = scrubHostDeploySecrets(body, [token, url]).slice(0, HOST_DEPLOY_DETAIL_CAP)
    } catch {
      // A body we cannot read is not a failure signal — the status is.
    }
    if (res.ok) {
      return { ok: true, detail: text.length > 0 ? text : `accepted (HTTP ${res.status})` }
    }
    return {
      ok: false,
      detail: text.length > 0 ? `HTTP ${res.status} — ${text}` : `HTTP ${res.status}`,
    }
  }
}
