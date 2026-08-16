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
 *   • `credential_rejected`     — a credential WAS supplied and `gh` refused
 *     it: expired, revoked, or missing a scope.
 *   • `could_not_reach_github`  — `gh` ran but never got an answer: DNS,
 *     offline, a proxy, a GitHub outage, or our own 60s watchdog killing the
 *     call. NOTHING was learned about the credential, and telling the owner to
 *     rotate it would be wrong.
 *   • `publisher_cli_unavailable` — `gh` itself could not be executed, so the
 *     credential could not be verified either way.
 *   • `probe_failed`            — the capability probe threw (e.g. the secrets
 *     store could not be opened). Nothing was learned about the credential.
 *
 * The SIXTH cause — "the probe was never handed a credential and so asked a
 * bare `gh` about ambient state" — is deliberately absent from this list. It
 * is now unrepresentable: `defaultGitModeProbe` REQUIRES a
 * {@link PublisherCredentialSource}, so no probe can be built that has no
 * opinion about the publisher's own credential.
 *
 * Note which of these are the owner's to act on: only `no_credential_available`
 * ("connect GitHub") and `credential_rejected` ("reconnect it"). The other three
 * are host conditions, and a taxonomy that folded them into `credential_rejected`
 * — as this one did in round 1 — spends the owner's time on the wrong repair.
 */
export type PublisherAuthFailureCause =
  | 'no_credential_available'
  | 'credential_rejected'
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
 * It never reads ambient `gh` login state, so it cannot reproduce the bug.
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
   * Who the publisher credential is looked up for. Named in EVERY refusal: a
   * refusal that does not say which handle was consulted sends the reader
   * hunting through the secrets store by hand.
   */
  readonly publisher: PublisherIdentity
  /** Whether `repoPath` has an `origin` remote pointing at GitHub. */
  hasGithubOrigin(repoPath: string): Promise<boolean>
  /** Whether the outer publisher can authenticate to GitHub, and if not, why. */
  publisherAvailable(): Promise<PublisherAuthResult>
}

/** The refusal text, with the cause and the owner handle spelled out. */
export function describePublisherAuthFailure(
  publisher: PublisherIdentity,
  result: { cause: PublisherAuthFailureCause; detail?: string },
): string {
  const who = `owner handle "${publisher.owner_handle}" (${publisher.source})`
  const detail =
    result.detail !== undefined && result.detail.length > 0
      ? `: ${result.detail.split('\n')[0]}`
      : ''
  switch (result.cause) {
    case 'no_credential_available':
      return (
        `no GitHub credential is stored for ${who}, and this host's ambient \`gh\` ` +
        `is not logged in either — connect GitHub. ` +
        `The credential source was read and was empty; this is not an expired token${detail}`
      )
    case 'credential_rejected':
      return (
        `the stored GitHub credential for ${who} was REJECTED by \`gh auth status\` ` +
        `— expired, revoked, or missing a scope${detail}`
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
      return `the publisher capability probe itself failed for ${who}${detail}`
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
        describePublisherAuthFailure(probe.publisher, result),
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
 * MEASURED SCOPE, so this docblock does not overclaim the way its first draft
 * did: two call sites took that default — `onboarding/overnight/register.ts` and
 * `board-dispatch.ts`'s own `??` fallback. The board path did NOT reach the
 * fallback in production, because `open/composer.ts` passed a credentialed
 * resolver into `trident_build_dispatch`. What the board path DID hit is the
 * other half of the same defect, which the taxonomy above fixes: when the token
 * lookup came back empty, `githubProcessEnv(null)` returned `{}`, `spawnCapture`
 * omitted `env` entirely, and the credentialed runner degraded silently into the
 * SAME bare `gh auth status` — reported as an unexplained "cannot authenticate".
 */
export function defaultGitModeProbe(
  credential: PublisherCredentialSource,
  run: EnvCapableHostRunner = spawnCapture,
): GitModeProbe {
  return {
    publisher: { owner_handle: credential.owner_handle, source: credential.source },
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
      const res = await run(['gh', 'auth', 'status'], undefined, env)
      if (res.ok) return { authenticated: true }
      // ORDER IS THE POINT BELOW: every branch above `credential_rejected` is a
      // condition in which NOTHING was learned about the credential, and the
      // only reading that must never be emitted on those is "rotate your token".
      //
      // `spawnCapture` reports a spawn failure (no `gh` on PATH) as -1, which is
      // a different fact from `gh` running and rejecting the token.
      if (res.exit_code === -1) {
        return { authenticated: false, cause: 'publisher_cli_unavailable', detail: res.stderr }
      }
      // Our own 60s watchdog killed it: a hung call, not a verdict. The kill
      // surfaces as an ordinary non-zero exit, so only this flag can tell them
      // apart.
      if (res.timed_out === true) {
        return {
          authenticated: false,
          cause: 'could_not_reach_github',
          detail: res.stderr.length > 0 ? res.stderr : 'timed out after 60s',
        }
      }
      // `gh auth status` does a live API round-trip, so DNS failure, an offline
      // host, a blocking proxy and a GitHub outage all exit non-zero with a
      // perfectly good token.
      if (looksLikeGithubUnreachable(res.stderr) || looksLikeGithubUnreachable(res.stdout)) {
        return { authenticated: false, cause: 'could_not_reach_github', detail: res.stderr }
      }
      // Nothing stored AND ambient `gh` could not authenticate → the honest
      // report is "connect GitHub", not "your token was rejected"; there is no
      // token to reject.
      if (token.length === 0) {
        return { authenticated: false, cause: 'no_credential_available', detail: res.stderr }
      }
      return { authenticated: false, cause: 'credential_rejected', detail: res.stderr }
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
export async function spawnCapture(
  cmd: string[],
  cwd?: string,
  /**
   * Extra environment MERGED over the inherited one. Optional so every existing
   * caller is untouched; `makeCredentialedHostRunner` below is what production
   * uses to carry the GitHub credential into `git push` / `gh pr create`.
   */
  extraEnv?: Record<string, string>,
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
    }, 60_000)
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
