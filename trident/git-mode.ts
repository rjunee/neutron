/**
 * @neutronai/trident — git integration mode detection + merge/cleanup
 * seam.
 *
 * Ryan-locked decision: Trident supports BOTH a local branch-merge mode
 * and a GitHub PR mode, auto-detected per run with NO user config. A run
 * is `'pr'` mode iff the project repo has a GitHub `origin` remote AND the
 * OUTER PUBLISHER'S OWN CREDENTIAL authenticates; otherwise `'local'` (the
 * safe default — branch + merge with no remote), except that a GitHub origin
 * with an unusable credential REFUSES rather than degrading, because silently
 * choosing local mode would drop the PR and CI gates.
 *
 * "the publisher's own credential", not "ambient `gh` login state on the host",
 * is load-bearing and was the defect: see {@link PublisherCredentialSource}.
 *
 * SCOPE — PR-2 lands the detection helper + the merge/cleanup STUBS. The
 * real branch/merge/PR mechanics (worktree create, `gh pr create`,
 * `gh pr merge`, branch teardown) are PR-3; this PR provides the typed
 * seam + persists the mode so PR-3 only fills in the bodies.
 */

import type { MergeMode, TridentRun } from './store.ts'

export interface HostCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  exit_code: number
  /**
   * Set by `spawnCapture` when IT killed the child on the 60s watchdog.
   *
   * A killed `gh` exits non-zero like a rejected token does, and the exit code
   * alone cannot tell them apart — so without this flag a hung network call was
   * reported to the owner as "your token was REJECTED — expired, revoked, or
   * missing a scope", sending him to rotate a perfectly good credential.
   * Optional so the dozen existing `HostCommandResult` producers (test doubles,
   * the orchestrator's injected runners) are untouched; absent means "not a
   * timeout", which is the correct reading for every one of them.
   */
  timed_out?: boolean
}

/**
 * WHY a publisher-authentication failure carries a CAUSE.
 *
 * "the outer publisher cannot authenticate" is equally true of five different
 * situations, and only two of them are the owner's to fix:
 *
 *   • `no_credential_available` — the credential source was asked and had
 *     nothing, and the host's ambient `gh` could not authenticate either.
 *     GitHub was never connected (or the token is filed under a different
 *     owner handle). NOT an expired token.
 *   • `credential_rejected`     — GitHub ANSWERED and refused the credential:
 *     expired, revoked, or missing a scope. Requires a verdict only a live
 *     response can produce (see {@link looksLikeCredentialRejected}).
 *   • `credential_verdict_unavailable` — `gh` said it could not log in, in
 *     wording that does NOT distinguish "the token was refused" from "GitHub
 *     was never reached". This is not hedging: MEASURED on gh 2.97.0, a dead
 *     proxy and a genuinely invalid token print byte-identical stderr (see
 *     {@link looksLikeAmbiguousLoginFailure}). Naming it honestly is the whole
 *     point of this taxonomy — the alternative is a confident wrong cause.
 *   • `github_rate_limited`     — GitHub answered with a rate limit. That answer
 *     is returned WITH a working credential, so it is evidence the token is
 *     FINE, and the only action is to wait.
 *   • `could_not_reach_github`  — `gh` ran but never got an answer: DNS,
 *     offline, a proxy, a GitHub outage, or our own 60s watchdog killing the
 *     call. NOTHING was learned about the credential, and telling the owner to
 *     rotate it would be wrong.
 *   • `publisher_cli_unavailable` — `gh` itself could not be executed, or is too
 *     old to answer the scoped question, so the credential could not be verified
 *     either way.
 *   • `probe_failed`            — the probe got no verdict: it threw (e.g. the
 *     secrets store could not be opened), or `gh` failed in a way that says
 *     nothing about the credential. Nothing was learned about the credential.
 *
 * The SIXTH cause — "the probe was never handed a credential and so asked a
 * bare `gh` about ambient state" — is deliberately absent from this list. It
 * is now unrepresentable: `defaultGitModeProbe` REQUIRES a
 * {@link PublisherCredentialSource}, so no probe can be built that has no
 * opinion about the publisher's own credential.
 *
 * Note which of these are the owner's to act on: only `no_credential_available`
 * ("connect GitHub") and `credential_rejected` ("reconnect it"). The rest are
 * host conditions or honest non-verdicts, and a taxonomy that folded them into
 * `credential_rejected` — as this one did in round 1 — spends the owner's time
 * on the wrong repair.
 */
export type PublisherAuthFailureCause =
  | 'no_credential_available'
  | 'credential_rejected'
  | 'credential_verdict_unavailable'
  | 'github_rate_limited'
  | 'could_not_reach_github'
  | 'publisher_cli_unavailable'
  | 'probe_failed'

export type PublisherAuthResult =
  | { authenticated: true }
  | { authenticated: false; cause: PublisherAuthFailureCause; detail?: string }

/** Who the publisher credential is looked up for, and where it comes from. */
export interface PublisherIdentity {
  /** The owner handle the credential lookup is scoped to. */
  owner_handle: string
  /** Short human label for the credential's home, e.g. 'the instance secrets store'. */
  source: string
}

/**
 * The credential the outer publisher will actually use, resolved at CALL time.
 *
 * This is the whole fix. The probe used to shell `gh auth status` and report
 * whatever ambient login state the gateway process happened to have — and the
 * gateway process has none by design, because the GitHub token is injected PER
 * SPAWN (`open/composer.ts` `setGithubSpawnEnvResolver`). So the probe
 * truthfully answered "not authenticated" about an environment that
 * structurally cannot be authenticated.
 *
 * That happened two ways, and only naming both keeps this honest. A probe built
 * with NO credential asked a bare `gh` outright. And a probe built with the
 * "credentialed" runner asked exactly the same bare `gh` whenever the token
 * lookup returned nothing, because an empty env makes `spawnCapture` omit `env`
 * altogether — so an owner whose token was filed under a different handle got a
 * refusal that read as an authentication failure rather than as "not connected".
 * Making the source explicit collapses both: the probe now always knows whose
 * credential it asked for, and whether there was one.
 *
 * `load()` returns the `githubProcessEnv`-shaped environment (`{}` when nothing
 * is stored). Resolved per call, never captured at boot, so a credential the
 * owner connects from chat takes effect on the next probe rather than the next
 * restart.
 */
export interface PublisherCredentialSource extends PublisherIdentity {
  load(): Promise<Record<string, string>>
}

/**
 * The honest "nothing was wired here" credential source.
 *
 * A composition that has no GitHub credential to give still has to produce a
 * probe, and the tempting shortcut — let it fall back to a bare `gh` — is
 * precisely the defect this module was rewritten to remove. This source instead
 * reports emptiness AS emptiness, and is greppable back to the composition site
 * that owes a real source.
 *
 * WHY IT TAKES NO OWNER HANDLE. It used to accept one, and the only caller had
 * nothing better to hand it than the PROJECT SLUG — which the refusal then
 * rendered as `owner handle "<project slug>"`, naming an identity that was never
 * looked up and sending the reader to check the wrong row in the secrets store.
 * There is no handle to report here by construction: no lookup ran. So it says
 * `unknown`, and the misuse is unrepresentable rather than merely discouraged.
 *
 * WHAT IT DOES AND DOES NOT PROMISE. It reports that no in-app credential was
 * wired; it does NOT suppress the host's ambient `gh` session. The probe still
 * runs the same command in the same (empty) environment the publisher would, so
 * a host with `gh auth login` done still resolves to `'pr'` mode — the probe is
 * never stricter than the publisher it speaks for. An earlier draft of this
 * comment claimed it "never reads ambient `gh` login state", which the ambient
 * -parity tests in `git-mode.test.ts` directly contradict.
 *
 * NO PRODUCTION CALL SITE CONSTRUCTS THIS, and that is the intended end state
 * rather than dead code: `gateway/composition/build-core-modules.ts` uses it
 * only as the `??` for a composer that supplied no overnight config, and the
 * boot-wiring test uses it as the negative control. If a real composition ever
 * lands on it, the refusal names this function, which is the greppable signal
 * that a composition site owes a real source.
 */
export function unwiredPublisherCredential(): PublisherCredentialSource {
  return {
    owner_handle: 'unknown',
    source: 'no credential source was wired into this composition, so no lookup ran',
    load: async () => ({}),
  }
}

/**
 * Host-process probe used by `detectMergeMode`. Tests inject a stub; the
 * default (`defaultGitModeProbe`) shells out via `Bun.spawn`. Kept narrow
 * — only the two facts detection needs — so the merge-mode decision is
 * statically reasoning-friendly.
 */
export interface GitModeProbe {
  /**
   * The credential source this probe consults — the SOURCE, not a copy of its
   * labels.
   *
   * Its `owner_handle`/`source` are named in EVERY refusal: a refusal that does
   * not say which handle was consulted sends the reader hunting through the
   * secrets store by hand.
   *
   * WHY THE WHOLE SOURCE AND NOT A `PublisherIdentity` SNAPSHOT. A wiring test
   * that can only read labels can only compare labels, and two separately-built
   * sources with equal labels — one of them reading the wrong store — compare
   * equal. Exposing the source means a wiring test can call `load()` against the
   * store the composition root actually built and watch a token it planted come
   * back, which a wrong-store probe cannot fake.
   */
  readonly credential: PublisherCredentialSource
  /** Whether `repoPath` has an `origin` remote pointing at GitHub. */
  hasGithubOrigin(repoPath: string): Promise<boolean>
  /** Whether the outer publisher can authenticate to GitHub, and if not, why. */
  publisherAvailable(): Promise<PublisherAuthResult>
}

/**
 * Upper bound on the rendered detail, so an unbounded `err.message` on the
 * `probe_failed` path cannot turn a refusal into a wall of text.
 */
export const MAX_AUTH_FAILURE_DETAIL_CHARS = 600

/**
 * Render the captured `gh` output into the one-line refusal WITHOUT discarding
 * any of it.
 *
 * WHY THIS IS NOT `split('\n')[0]`, which is what it replaced. `gh auth
 * status`'s failure output is MULTI-LINE and its first line is the bare
 * hostname — measured on gh 2.97.0, a refused token prints four lines:
 *
 *     github.com
 *       X Failed to log in to github.com using token (GH_TOKEN)
 *       - Active account: true
 *       - The token in GH_TOKEN is invalid.
 *
 * Taking `[0]` therefore kept the ONE line carrying no diagnosis and dropped
 * all three that did, so the refusal ended `…missing a scope: github.com`. Every
 * line `gh` bothered to print is a line the owner needs; they are flattened
 * rather than truncated, and only the total length is bounded.
 */
export function renderAuthFailureDetail(detail: string | undefined): string {
  if (detail === undefined) return ''
  const lines = detail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return ''
  const joined = lines.join('; ')
  return `: ${
    joined.length > MAX_AUTH_FAILURE_DETAIL_CHARS
      ? `${joined.slice(0, MAX_AUTH_FAILURE_DETAIL_CHARS)}… (truncated)`
      : joined
  }`
}

/** The refusal text, with the cause and the owner handle spelled out. */
export function describePublisherAuthFailure(
  publisher: PublisherIdentity,
  result: { cause: PublisherAuthFailureCause; detail?: string },
): string {
  const who = `owner handle "${publisher.owner_handle}" (${publisher.source})`
  const detail = renderAuthFailureDetail(result.detail)
  switch (result.cause) {
    case 'no_credential_available':
      return (
        `no GitHub credential is stored for ${who}, and this host's ambient \`gh\` ` +
        `is not logged in either — connect GitHub. ` +
        `The credential source was read and was empty; this is not an expired token${detail}`
      )
    case 'credential_rejected':
      // NOT "the stored credential": this cause is also reached when the store
      // was empty and `gh` fell back to the host's ambient login, and it is that
      // ambient credential GitHub refused. The probe says which in the detail.
      return (
        `the GitHub credential used for ${who} was REJECTED by GitHub ` +
        `— expired, revoked, or missing a scope${detail}`
      )
    case 'credential_verdict_unavailable':
      return (
        `\`gh auth status\` could not log in for ${who}, but its wording does not say ` +
        `WHETHER the credential was refused or GitHub was never reached — measured on ` +
        `gh 2.97.0, a dead proxy and a genuinely invalid token print identical output. ` +
        `Check network/DNS/proxy FIRST; rotate the token only once the network is known ` +
        `good${detail}`
      )
    case 'github_rate_limited':
      return (
        `GitHub rate-limited \`gh auth status\`, so the credential for ${who} was neither ` +
        `accepted nor rejected — GitHub returns a rate limit WITH a working credential, so ` +
        `this is evidence the token is fine. Wait for the limit to reset. ` +
        `Do NOT rotate the token on this signal${detail}`
      )
    case 'could_not_reach_github':
      return (
        `\`gh auth status\` could not reach GitHub, so the credential for ${who} was ` +
        `neither accepted nor rejected — check network/DNS/proxy or GitHub status. ` +
        `Do NOT rotate the token on this signal${detail}`
      )
    case 'publisher_cli_unavailable':
      return (
        `the \`gh\` CLI could not be executed on this host, so the stored credential ` +
        `for ${who} could not be verified either way${detail}`
      )
    case 'probe_failed':
      return (
        `the publisher capability probe itself failed for ${who}, so nothing was ` +
        `learned about the credential. Do NOT rotate the token on this signal${detail}`
      )
  }
}

/**
 * Auto-detect the merge mode for a repo. A non-GitHub repo uses local mode.
 * A GitHub origin requires a publisher that can authenticate; absence or a
 * failed capability probe throws loudly because silently selecting local mode
 * would remove the PR and CI gates.
 */
export async function detectMergeMode(
  repoPath: string,
  probe: GitModeProbe,
): Promise<MergeMode> {
  let hasOrigin: boolean
  try {
    hasOrigin = await probe.hasGithubOrigin(repoPath)
  } catch {
    return 'local'
  }
  if (!hasOrigin) return 'local'
  let result: PublisherAuthResult
  try {
    result = await probe.publisherAvailable()
  } catch (err) {
    // A GitHub-backed run must fail loudly below. Treating a broken capability
    // probe as permission to merge locally would silently remove the PR gate.
    result = {
      authenticated: false,
      cause: 'probe_failed',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  if (!result.authenticated) {
    throw new Error(
      'GitHub origin detected but the outer publisher cannot authenticate; ' +
        'refusing to silently weaken the PR merge gate — ' +
        describePublisherAuthFailure(probe.credential, result),
    )
  }
  return 'pr'
}

/** True when the URL is a GitHub remote (https or ssh form). */
export function isGithubRemoteUrl(url: string): boolean {
  const u = url.trim()
  if (u.length === 0) return false
  return /(^|@|\/\/)github\.com[:/]/i.test(u) || /(^|\b)git@github\.com:/i.test(u)
}

/**
 * A host runner that can carry an environment. `spawnCapture` already has this
 * shape; the probe needs the third parameter because it injects the publisher's
 * credential into the `gh` call itself rather than trusting the ambient one.
 */
export type EnvCapableHostRunner = (
  cmd: string[],
  cwd?: string,
  extraEnv?: Record<string, string>,
) => Promise<HostCommandResult>

/**
 * Whether `gh`'s output describes a failure to REACH GitHub rather than a
 * verdict about the credential.
 *
 * Deliberately conservative: an unrecognised failure falls through to the
 * credential reading, which is the pre-existing behaviour, so this can only
 * move cases OUT of the "rotate your token" advice and never into it. The
 * patterns are Go's `net`/`http` surface (which is what `gh` prints) plus
 * GitHub's own 5xx.
 */
/**
 * The exact `gh` invocation the probe makes, and WHY it carries two flags.
 *
 * MEASURED ROOT CAUSE OF THE REPORTED REFUSAL (reproduced on the host, gh 2.97.0):
 * `gh auth status` with NO flags tests every account on every known host and,
 * per its own `--help`, "if an account on any host … has authentication issues,
 * the command will exit with 1". A host that has a good token AND a stale second
 * account therefore exits 1 while reporting success for the credential we asked
 * about. Run against a VALID publisher token, the unscoped call printed
 *
 *     ✓ Logged in to github.com account <handle> (GH_TOKEN)
 *     X Failed to log in to github.com account <handle> (default)
 *       - The token in default is invalid.
 *
 * and exited 1 — so `res.ok` was false, `detectMergeMode` refused, and every
 * board build was blocked by an account the publisher never uses. The same token
 * with `--hostname github.com --active` exits 0.
 *
 *   • `--hostname github.com` — the only host the publisher ever targets, so an
 *     enterprise or `github.example.com` entry cannot veto it.
 *   • `--active`             — only the account that would actually be used.
 *     With `GH_TOKEN` set that IS the injected credential; with an empty env it
 *     is the host's ambient login, which is exactly what the publisher inherits.
 *
 * Both flags are long-standing (`--active` since gh 2.41); an older CLI reports
 * `unknown flag` and is classified as `publisher_cli_unavailable` rather than as
 * a verdict on the token.
 */
export const PUBLISHER_AUTH_COMMAND: readonly string[] = [
  'gh',
  'auth',
  'status',
  '--hostname',
  'github.com',
  '--active',
]

/**
 * Whether GitHub ANSWERED and refused the credential.
 *
 * Positive evidence is REQUIRED before `credential_rejected` is emitted, because
 * that cause is the one that sends the owner to rotate a token. Round 2 had this
 * backwards: anything unrecognised FELL THROUGH to `credential_rejected`, so an
 * x509/TLS error, a corporate proxy's own wording, or any future `gh` message we
 * had not enumerated all arrived as "expired, revoked, or missing a scope" —
 * confident, specific, and about a token nothing had been learned about.
 *
 * WHAT ROUND 3 STILL HAD WRONG, and the principle that fixes it. The list used
 * to include `is invalid` and `failed to log in`, which are exactly the words
 * `gh` prints when it never reached GitHub at all (see
 * {@link looksLikeAmbiguousLoginFailure}) — so a DNS outage was reported as a
 * bad token. Every string kept below requires a LIVE RESPONSE BODY from GitHub
 * to be produced, which is what makes it a verdict: a transport failure cannot
 * fabricate `Bad credentials` or a scope list, because there was no response to
 * carry them.
 *
 * A rate limit is explicitly NOT a refusal even though GitHub returns it as
 * `403` — it is returned WITH a valid credential, so it is excluded before
 * anything else is considered.
 */
export function looksLikeCredentialRejected(text: string): boolean {
  const t = text.toLowerCase()
  if (t.length === 0) return false
  // A rate-limited 403 arrives with a WORKING token. It must never be read as a
  // refusal, so it is subtracted before the 40x test below can see it.
  if (looksLikeGithubRateLimited(t)) return false
  return (
    t.includes('bad credentials') ||
    t.includes('requires authentication') ||
    // `gh auth status` prints "Missing required token scopes", the API prints
    // "missing required scopes" — the optional word is why this is a regex and
    // not an `includes`, which silently missed gh's own wording.
    /missing required (token )?scopes/.test(t) ||
    t.includes('insufficient oauth scopes') ||
    t.includes('resource not accessible by') ||
    /\bhttp 40[13]\b/.test(t)
  )
}

/**
 * Whether GitHub answered with a RATE LIMIT rather than a verdict.
 *
 * GitHub returns **403** — not 429 — for both the primary and the secondary rate
 * limit, and it returns it to a request whose credential was accepted and
 * counted. `gh auth status` makes a live API round-trip, so it hits this. The
 * blanket `/\bhttp 40[13]\b/` in {@link looksLikeCredentialRejected} therefore
 * told a rate-limited owner that his WORKING token was expired or revoked; the
 * one correct action (wait) was the one action the refusal did not offer.
 */
export function looksLikeGithubRateLimited(text: string): boolean {
  const t = text.toLowerCase()
  if (t.length === 0) return false
  return (
    t.includes('rate limit exceeded') ||
    t.includes('secondary rate limit') ||
    t.includes('api rate limit') ||
    t.includes('exceeded a secondary') ||
    /\bhttp 429\b/.test(t)
  )
}

/**
 * Whether `gh` reported a login failure in wording that CANNOT distinguish a
 * refused credential from a network that never carried the question.
 *
 * THIS IS A MEASUREMENT, NOT A HEDGE. On gh 2.97.0, run against `github.com`
 * with `--active`, these two situations produce BYTE-IDENTICAL stderr:
 *
 *   • a genuinely invalid token, network fine;
 *   • a perfectly good token behind a dead proxy, so GitHub was never reached.
 *
 * Both print:
 *
 *     github.com
 *       X Failed to log in to github.com using token (GH_TOKEN)
 *       - Active account: true
 *       - The token in GH_TOKEN is invalid.
 *
 * The `dial tcp` / `no such host` strings {@link looksLikeGithubUnreachable}
 * looks for appear only under `GH_DEBUG`, so that classifier cannot rescue the
 * transport case from normal output, and `is invalid` matched the REJECTION
 * classifier — which is how a network outage came to tell the owner his token
 * was bad.
 *
 * There is no signal here that separates them, so the honest answer is that
 * there is no verdict. `credential_verdict_unavailable` says exactly that and
 * points at the network first; guessing "rotate your token" is wrong about half
 * the time and expensive in the half it is wrong.
 */
export function looksLikeAmbiguousLoginFailure(text: string): boolean {
  const t = text.toLowerCase()
  if (t.length === 0) return false
  return (
    t.includes('failed to log in') ||
    t.includes('is invalid') ||
    t.includes('invalid token')
  )
}

/**
 * Whether `gh` reports that it had NO credential at all.
 *
 * Used as a canary, not just a classifier. When the probe resolved a token and
 * `gh` nonetheless says it was handed nothing, the credential did not survive
 * the trip — which is a fault in the host runner, not in the token, and must
 * never be reported as a rejection.
 *
 * The `gh auth login` hint is the weakest of the three signals — `gh` also
 * prints it alongside a FAILED login — so it is only believed when the same
 * output carries no verdict and no ambiguous login failure. Both exclusions are
 * load-bearing: the ambiguous one had to be added when
 * {@link looksLikeCredentialRejected} was narrowed, or an "invalid token …
 * run: gh auth login" output would have started reading as "nothing stored".
 */
export function looksLikeNoGithubAuth(text: string): boolean {
  const t = text.toLowerCase()
  if (t.length === 0) return false
  return (
    t.includes('not logged into any github hosts') ||
    t.includes('no accounts') ||
    (t.includes('gh auth login') &&
      !looksLikeCredentialRejected(t) &&
      !looksLikeAmbiguousLoginFailure(t))
  )
}

export function looksLikeGithubUnreachable(text: string): boolean {
  const t = text.toLowerCase()
  if (t.length === 0) return false
  return (
    t.includes('dial tcp') ||
    t.includes('no such host') ||
    t.includes('connection refused') ||
    t.includes('connection reset') ||
    t.includes('network is unreachable') ||
    t.includes('i/o timeout') ||
    t.includes('context deadline exceeded') ||
    t.includes('tls handshake timeout') ||
    t.includes('proxyconnect') ||
    t.includes('temporary failure in name resolution') ||
    /\bhttp 5\d\d\b/.test(t)
  )
}

/**
 * Name WHICH credential `gh` was talking about, so the refusal sends the owner
 * to the right one.
 *
 * An empty store does not mean nothing was tried — `spawnCapture` omits an empty
 * environment, so `gh` falls back to the host's ambient login and it is THAT
 * credential GitHub answered about. Reporting an ambient refusal against the
 * (empty) store would send the owner to reconnect an app credential that was
 * never in play.
 */
export function describeWhichCredential(token: string, stderr: string): string {
  const which =
    token.length > 0
      ? 'the credential resolved from the configured source was used'
      : "no credential was stored for this handle, so `gh` used this host's ambient " +
        'login — that is the credential this is about'
  return stderr.length > 0 ? `${which}: ${stderr}` : which
}

/**
 * Default probe: measures the origin, then asks `gh auth status` UNDER THE
 * PUBLISHER'S OWN CREDENTIAL.
 *
 * `credential` is REQUIRED and has no default. That is the point: the previous
 * signature defaulted its runner to a plain `spawnCapture`, so
 * `defaultGitModeProbe()` compiled, ran a bare `gh auth status` against the
 * gateway's own (deliberately credential-free) environment, and got a truthful
 * "not authenticated" about the wrong process. An optional default is what let
 * that happen, so the uncredentialed probe is now unrepresentable rather than
 * merely unused.
 *
 * MEASURED SCOPE, so this docblock does not overclaim the way its first two
 * drafts did. Two call sites took that default — `onboarding/overnight/register.ts`
 * and `board-dispatch.ts`'s own `??` fallback — but the board path did NOT reach
 * the fallback in production, because `open/composer.ts` already passed a
 * credentialed resolver into `trident_build_dispatch`. So requiring the
 * credential closes a real hole on the OVERNIGHT path and hardens the board one,
 * and it is NOT what was refusing the owner's builds.
 *
 * What refused those is measured in {@link PUBLISHER_AUTH_COMMAND}: the probe
 * asked an UNSCOPED `gh auth status`, which fails when any account on any host
 * is broken — including one the publisher never uses. That is the fix for the
 * reported symptom; the required credential is the fix for the class.
 */
export function defaultGitModeProbe(
  credential: PublisherCredentialSource,
  run: EnvCapableHostRunner = spawnCapture,
): GitModeProbe {
  return {
    credential,
    hasGithubOrigin: async (repoPath) => {
      const res = await run(['git', '-C', repoPath, 'remote', 'get-url', 'origin'], repoPath)
      return res.ok && isGithubRemoteUrl(res.stdout)
    },
    publisherAvailable: async () => {
      const env = await credential.load()
      const token = env['GH_TOKEN'] ?? ''
      // ASK EXACTLY THE QUESTION THE PUBLISHER WILL ASK.
      //
      // The publisher spawns `{ ...process.env, ...env }` and omits `env`
      // entirely when it is empty (`spawnCapture` below), so an empty store
      // means the publisher INHERITS the host's ambient `gh` login. Round 1
      // short-circuited to `no_credential_available` on an empty store without
      // running anything, which made the probe STRICTER than the thing it
      // speaks for: a host with `gh auth login` done and no in-app connection
      // publishes fine today and would have started refusing. The probe must be
      // a faithful mirror — the same command, the same environment — or it is
      // just a second, differently-wrong opinion about publishing.
      //
      // WHAT THIS MIRRORS EXACTLY, AND WHAT IT ONLY MIRRORS IN PRACTICE. The
      // `gh` half is exact: same argv, same env. The `git push` half is not
      // carried by this env when the store is empty — `githubProcessEnv(null)`
      // is `{}`, so no `GIT_CONFIG_*` credential helper is injected
      // (`github/credential.ts`). On the ambient path that push is served by the
      // helper `gh auth login` installs into the user's global config
      // (`credential.https://github.com.helper = !gh auth git-credential`,
      // verified on the host), which is the normal outcome of logging in but is
      // declinable. So an empty store plus an ambient login that skipped git
      // setup can still select 'pr' and then fail at push — with git's own
      // credential error, which is the correct place to learn it. Tightening
      // here instead would refuse the far more common host where it works.
      const res = await run([...PUBLISHER_AUTH_COMMAND], undefined, env)
      if (res.ok) return { authenticated: true }
      const output = `${res.stderr}\n${res.stdout}`
      // ORDER IS THE POINT BELOW: `credential_rejected` is emitted ONLY on
      // positive evidence that `gh` refused the credential, and every other
      // branch is a condition in which NOTHING was learned about it. The one
      // reading that must never be guessed is "rotate your token".
      //
      // `spawnCapture` reports a spawn failure (no `gh` on PATH) as -1, which is
      // a different fact from `gh` running and rejecting the token.
      if (res.exit_code === -1) {
        return { authenticated: false, cause: 'publisher_cli_unavailable', detail: res.stderr }
      }
      // A `gh` too old to understand the scoped flags never evaluated the
      // credential at all. Reporting that as a bad token would send the owner to
      // rotate a good one over a CLI upgrade.
      if (output.toLowerCase().includes('unknown flag')) {
        return {
          authenticated: false,
          cause: 'publisher_cli_unavailable',
          detail: `this \`gh\` does not support \`--hostname/--active\` (needs gh >= 2.41): ${res.stderr}`,
        }
      }
      // Our own 60s watchdog killed it: a hung call, not a verdict. The kill
      // surfaces as an ordinary non-zero exit, so only this flag can tell them
      // apart.
      if (res.timed_out === true) {
        return {
          authenticated: false,
          cause: 'could_not_reach_github',
          detail:
            res.stderr.length > 0
              ? res.stderr
              : `timed out after ${DEFAULT_HOST_COMMAND_TIMEOUT_MS / 1000}s`,
        }
      }
      // `gh auth status` does a live API round-trip, so DNS failure, an offline
      // host, a blocking proxy and a GitHub outage all exit non-zero with a
      // perfectly good token.
      if (looksLikeGithubUnreachable(output)) {
        return { authenticated: false, cause: 'could_not_reach_github', detail: res.stderr }
      }
      // BEFORE any credential verdict: GitHub returns 403 for a rate limit, to a
      // request whose credential it ACCEPTED. Classified here so the blanket 40x
      // test below can never see it.
      if (looksLikeGithubRateLimited(output)) {
        return { authenticated: false, cause: 'github_rate_limited', detail: res.stderr }
      }
      // `gh` says it was handed no credential at all.
      if (looksLikeNoGithubAuth(output)) {
        // CANARY. We resolved a token, and `gh` still saw none — so it did not
        // survive the trip. The host runner dropped it: the probe's third
        // argument is optional on `EnvCapableHostRunner`, so a two-parameter
        // runner satisfies the type and silently discards the environment. That
        // is a wiring fault, and reporting it as a rejected credential would
        // send the owner to rotate a token that never reached `gh`.
        if (token.length > 0) {
          return {
            authenticated: false,
            cause: 'probe_failed',
            detail:
              'a credential was resolved but the host runner did not carry it into `gh`, ' +
              'which reported no authentication at all — the runner is dropping its ' +
              `environment argument: ${res.stderr}`,
          }
        }
        // Nothing stored AND ambient `gh` is not logged in → the honest report is
        // "connect GitHub", not "your token was rejected"; there is no token to
        // reject.
        return { authenticated: false, cause: 'no_credential_available', detail: res.stderr }
      }
      // POSITIVE EVIDENCE ONLY. Reached only when GitHub answered and refused.
      //
      // THE CAUSE IS WHAT HAPPENED, NOT WHAT WAS CONFIGURED. This used to read
      // `token.length === 0 ? 'no_credential_available' : 'credential_rejected'`,
      // which is self-contradicting: control only arrives here on positive
      // evidence that a credential WAS presented and refused, so "no credential
      // available" denies the very observation that selected the branch. It was
      // not hypothetical — a stale ambient account whose `hosts.yml` token is
      // invalid lands exactly here with an empty store, and the owner was told
      // nothing was connected while `gh` was telling us something was, and was
      // bad. An empty store does not mean no credential was tried; it means the
      // one that was tried came from the host's ambient login instead, which is
      // a fact about WHICH credential to go fix, so it belongs in the detail.
      if (looksLikeCredentialRejected(output)) {
        return {
          authenticated: false,
          cause: 'credential_rejected',
          detail: describeWhichCredential(token, res.stderr),
        }
      }
      // GitHub may never have answered at all: `gh` prints the same "failed to
      // log in / token is invalid" text for a refused token and for a network it
      // could not cross. Say so rather than picking the expensive guess.
      if (looksLikeAmbiguousLoginFailure(output)) {
        return {
          authenticated: false,
          cause: 'credential_verdict_unavailable',
          detail: describeWhichCredential(token, res.stderr),
        }
      }
      // `gh` failed for a reason we cannot classify. Nothing was learned about
      // the credential, so say exactly that rather than guessing the one cause
      // that costs the owner a rotation. Round 2 fell through to
      // `credential_rejected` here, which is how an x509/TLS error became
      // "expired, revoked, or missing a scope".
      return {
        authenticated: false,
        cause: 'probe_failed',
        detail:
          `\`${PUBLISHER_AUTH_COMMAND.join(' ')}\` exited ${res.exit_code} with no ` +
          `recognisable verdict about the credential: ${res.stderr}`,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Ralph mode detection
// ---------------------------------------------------------------------------

/**
 * Probe for `detectRalphMode`. Narrow on purpose — the only fact Ralph
 * detection needs is whether the repo is "governed" (its git root has a
 * `SPEC.md`, per the Spec-Drift Guardrails convention). Tests inject a
 * stub; production uses `defaultRalphModeProbe`.
 */
export interface RalphModeProbe {
  /** Whether the git root containing `repoPath` has a `SPEC.md`. */
  hasSpecFile(repoPath: string): Promise<boolean>
}

/**
 * Decide whether a run uses Ralph build mode (the one-task-per-fresh-
 * context loop). Mirrors the legacy harness SKILL.md "Ralph mode detection":
 *
 *   1. EXPLICIT — the caller asked for it (`opts.explicit`) → Ralph.
 *   2. GOVERNED — else the repo's git root contains a `SPEC.md` → Ralph.
 *   3. Else → legacy single-context build.
 *
 * A probe that throws is treated as "not governed" so detection degrades
 * to the legacy path rather than erroring a run at creation time.
 */
export async function detectRalphMode(
  repoPath: string,
  probe: RalphModeProbe,
  opts: { explicit?: boolean } = {},
): Promise<boolean> {
  if (opts.explicit === true) return true
  try {
    return await probe.hasSpecFile(repoPath)
  } catch {
    return false
  }
}

/**
 * Default production probe: resolves the git root via
 * `git rev-parse --show-toplevel` (falling back to `repoPath`), then checks
 * for `<root>/SPEC.md`. The file-existence check is injectable so unit
 * tests need no real filesystem.
 */
export function defaultRalphModeProbe(
  run: (cmd: string[], cwd?: string) => Promise<HostCommandResult> = spawnCapture,
  fileExists: (path: string) => Promise<boolean> = (p) => Bun.file(p).exists(),
): RalphModeProbe {
  return {
    hasSpecFile: async (repoPath) => {
      const res = await run(['git', '-C', repoPath, 'rev-parse', '--show-toplevel'], repoPath)
      const root = res.ok && res.stdout.trim().length > 0 ? res.stdout.trim() : repoPath
      return await fileExists(`${root}/SPEC.md`)
    },
  }
}

/**
 * Default production host-command runner: shells `cmd` via `Bun.spawn`
 * and captures stdout/stderr/exit. Shared by the git-mode/ralph probes
 * AND the trident orchestrator's `run_host` (git/gh/numstat/merge) when a
 * composer doesn't inject its own. Never throws — a spawn failure resolves
 * to `{ ok:false, exit_code:-1 }`.
 */
/** Production watchdog budget for a single host command. */
export const DEFAULT_HOST_COMMAND_TIMEOUT_MS = 60_000

export async function spawnCapture(
  cmd: string[],
  cwd?: string,
  /**
   * Extra environment MERGED over the inherited one. Optional so every existing
   * caller is untouched; `makeCredentialedHostRunner` below is what production
   * uses to carry the GitHub credential into `git push` / `gh pr create`.
   */
  extraEnv?: Record<string, string>,
  /**
   * Watchdog budget. Defaults to the production 60s.
   *
   * A SEAM, not a knob: the 60s was hardcoded inside the closure, so the only
   * way to reach the `timed_out` branch in a test was to stub the whole result —
   * which meant deleting the watchdog left the suite green while the publisher
   * probe went back to reading a hung call as a rejected token. With this,
   * `git-mode.test.ts` kills a real child and asserts the real flag.
   */
  timeoutMs: number = DEFAULT_HOST_COMMAND_TIMEOUT_MS,
): Promise<HostCommandResult> {
  try {
    const proc = Bun.spawn(cmd, {
      // Only set `cwd` when provided — under exactOptionalPropertyTypes an
      // explicit `cwd: undefined` is not assignable to SpawnOptions.
      ...(cwd !== undefined ? { cwd } : {}),
      // MERGE over the inherited environment, never replace it. Passing a bare
      // `{ ...extraEnv }` would drop PATH, HOME and the Claude credential dir,
      // so `git` itself would stop resolving. Omit `env` entirely when there is
      // nothing to add, so the unconnected path is byte-identical to before.
      ...(extraEnv !== undefined && Object.keys(extraEnv).length > 0
        ? { env: { ...process.env, ...extraEnv } }
        : {}),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // Host network and credential-helper calls must not wedge run creation or
    // publication forever. This kills only the exact child started above.
    //
    // A killed child exits non-zero, indistinguishably from a command that ran
    // and failed on its merits — so record that WE were the cause. Without this
    // the publisher probe read a hung `gh auth status` as "your token was
    // rejected" and told the owner to rotate a good credential.
    let timed_out = false
    const timeout = setTimeout(() => {
      timed_out = true
      proc.kill()
    }, timeoutMs)
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exit_code = await proc.exited
    clearTimeout(timeout)
    return {
      ok: exit_code === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exit_code,
      ...(timed_out ? { timed_out: true } : {}),
    }
  } catch (err) {
    return { ok: false, stdout: '', stderr: String(err), exit_code: -1 }
  }
}

/**
 * A `RunHostCommand` with an environment baked in.
 *
 * WHY A FACTORY RATHER THAN AN EXTRA PARAMETER ON `RunHostCommand`. That type is
 * `(cmd, cwd?) => Promise<HostCommandResult>` and is implemented by a dozen test
 * doubles and threaded through the orchestrator, merge, and probe paths. Adding a
 * third parameter would ripple through all of them and — worse — would make
 * carrying the credential the CALLER's job at every single call site, which is
 * exactly how one of them ends up forgetting. Baking it in at the composition
 * seam means every host command a run makes is credentialed by construction, and
 * the type nobody else has to change.
 *
 * With an empty env this is `spawnCapture` verbatim, so an instance with no
 * GitHub connection behaves precisely as it does today.
 */
export function makeCredentialedHostRunner(
  extraEnv: Record<string, string>,
): (cmd: string[], cwd?: string) => Promise<HostCommandResult> {
  return (cmd, cwd) => spawnCapture(cmd, cwd, extraEnv)
}

/**
 * The same thing, but resolving the environment PER COMMAND instead of once.
 *
 * WHY THIS EXISTS AND WHY THE EAGER VARIANT CANNOT BE USED AT THE COMPOSER SEAM.
 * The credential is read out of the `SecretsStore`, which is async, and the owner
 * connects GitHub from chat at some arbitrary point AFTER the gateway booted.
 * Composing `makeCredentialedHostRunner(githubProcessEnv(await readGitHubToken(…)))`
 * at boot therefore bakes in whatever was stored at boot — which on a fresh
 * install is `null`, i.e. an empty env — and the runner then stays uncredentialed
 * for the entire life of the process. The owner would connect, see a success
 * message, and every push would still fail until the next restart. Rotating or
 * re-connecting has the same problem in reverse: the stale token outlives it.
 *
 * Resolving per command makes the connection take effect on the next host
 * command with no restart, which is the behaviour the chat surface promises.
 * This mirrors how the composer already resolves `CODEX_HOME` per run rather
 * than at boot, and for exactly the same reason.
 *
 * A throwing `loadEnv` is NOT swallowed. A secrets store that cannot be read is
 * a real fault, and degrading to an empty env would turn it into a confusing
 * authentication failure several steps later instead of the actual error.
 */
export function makeLazyCredentialedHostRunner(
  loadEnv: () => Promise<Record<string, string>>,
): (cmd: string[], cwd?: string) => Promise<HostCommandResult> {
  return async (cmd, cwd) => spawnCapture(cmd, cwd, await loadEnv())
}

/**
 * PR-3 seam — post-merge cleanup, branching on the run's `merge_mode`.
 * Both modes get a stub now so the state machine's `done` transition has a
 * concrete call site; PR-3 fills in the bodies:
 *
 *   • `'pr'`   → `gh pr merge <pr> --squash --match-head-commit <reviewed OID>`
 *               (#545 — pinned to the commit the review judged), then remove the
 *               worktree + delete the local branch.
 *   • `'local'`→ merge the branch into the base locally, then remove the
 *               worktree + delete the branch.
 *
 * The interface (and the merge_mode switch) is locked here so PR-3 only
 * implements the two host-command sequences.
 */
export interface MergeCleanupDeps {
  /** PR-3: `gh pr merge` + teardown. */
  mergePr?(run: TridentRun): Promise<void>
  /** PR-3: local branch merge + teardown. */
  mergeLocal?(run: TridentRun): Promise<void>
}

export interface MergeCleanupResult {
  mode: MergeMode
  /** False while PR-3's bodies are unimplemented (the stub path). */
  performed: boolean
  note: string
}

export async function cleanupAfterMerge(
  run: TridentRun,
  deps: MergeCleanupDeps = {},
): Promise<MergeCleanupResult> {
  if (run.merge_mode === 'pr') {
    if (deps.mergePr) {
      await deps.mergePr(run)
      return { mode: 'pr', performed: true, note: `merged PR #${run.pr ?? '?'} + cleaned up` }
    }
    return { mode: 'pr', performed: false, note: 'pr-mode merge/cleanup not yet implemented (PR-3)' }
  }
  if (deps.mergeLocal) {
    await deps.mergeLocal(run)
    return { mode: 'local', performed: true, note: `merged branch ${run.branch ?? '?'} locally + cleaned up` }
  }
  return { mode: 'local', performed: false, note: 'local-mode merge/cleanup not yet implemented (PR-3)' }
}
