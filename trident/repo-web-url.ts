/**
 * @neutronai/trident — resolve a repo's GitHub WEB url from its own remote.
 *
 * The Work Board wants to render a run's PR as a clickable `#265`, which needs
 * `https://github.com/<owner>/<repo>/pull/265`. The owner/repo must come from the
 * RUN'S OWN repo — `TridentRun.repo_path` — and never from a hardcoded
 * `rjunee/neutron`: an instance builds whatever repo it was pointed at, and a
 * wrong link is worse than no link.
 *
 * Two pieces, deliberately split:
 *
 *  - {@link githubWebUrlFromRemote} — PURE. Same remote grammar
 *    `isGithubRemoteUrl` (`git-mode.ts`) recognises, but it PARSES rather than
 *    predicates: https / scp-style ssh / ssh:// → `https://github.com/<o>/<r>`.
 *    Anything else (a GitLab remote, a bare path, garbage) → null, and the caller
 *    renders plain text.
 *  - {@link makeRepoWebUrlResolver} — the shell. One `git remote get-url origin`
 *    per repo per process (the in-flight PROMISE is memoized, so N concurrent
 *    reconciles of the same repo still shell once), never throws, and resolves
 *    null on any failure. A resolver failure must never block the reconcile that
 *    calls it.
 */

import { spawnCapture, type HostCommandResult } from './git-mode.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

/**
 * Parse a git remote URL into its GitHub WEB url (`https://github.com/<o>/<r>`),
 * or null when it is not a GitHub remote.
 *
 * Accepts the three forms git writes:
 *   `https://github.com/acme/widget.git`   (with or without `.git` / trailing `/`)
 *   `git@github.com:acme/widget.git`       (scp-style ssh)
 *   `ssh://git@github.com/acme/widget.git`
 * Credentials in the authority (`https://x-token@github.com/...`) are tolerated
 * and dropped — the returned URL is always the canonical public one.
 */
export function githubWebUrlFromRemote(remote: string): string | null {
  const raw = remote.trim()
  if (raw.length === 0) return null
  // Strip an scheme + optional userinfo, then require the github.com host and an
  // `<owner>/<repo>` path. `:` after the host is the scp-style separator.
  const m =
    /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/\s]+@)?github\.com[:/]+([^/\s:]+)\/([^/\s:]+?)(?:\.git)?\/?$/i.exec(
      raw,
    )
  if (m === null) return null
  const owner = m[1]
  const repo = m[2]
  if (owner === undefined || repo === undefined) return null
  if (owner.length === 0 || repo.length === 0) return null
  return `https://github.com/${owner}/${repo}`
}

/**
 * Build a cached resolver: `repo_path` → its GitHub web url (or null).
 *
 * Memoizes the PROMISE per `repo_path` for the life of the process — a board
 * fan-out or a burst of terminal reconciles over the same repo shells `git` once.
 * `spawnCapture` never throws, and a non-zero exit / non-GitHub / unparseable
 * remote all resolve to null.
 */
export function makeRepoWebUrlResolver(
  run_host: (cmd: string[], cwd?: string) => Promise<HostCommandResult> = spawnCapture,
): (repo_path: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>()
  return (repo_path: string): Promise<string | null> => {
    const hit = cache.get(repo_path)
    if (hit !== undefined) return hit
    const pending = (async (): Promise<string | null> => {
      const res = await run_host(['git', '-C', repo_path, 'remote', 'get-url', 'origin'], repo_path)
      if (!res.ok) return null
      return githubWebUrlFromRemote(res.stdout)
    })()
    cache.set(repo_path, pending)
    return pending
  }
}

/**
 * A SYNC view over {@link makeRepoWebUrlResolver} — the shape the board's
 * `run_progress` attachment sites need.
 */
export interface RepoWebUrlCache {
  /**
   * The repo's GitHub web url if it has already SETTLED, else null (and a
   * background warm is kicked on the first miss). Never throws, never awaits.
   */
  peek(repo_path: string): string | null
}

/**
 * Build a process-wide sync-peek cache over the promise-memoized resolver.
 *
 * Both places that attach `run_progress` to a board item — `withRunProgress`
 * (the HTTP GET in `gateway/http/work-board-surface.ts`) and the composer's
 * `fanWorkBoardChanged` ws literal — are SYNCHRONOUS, and the resolver has to
 * shell `git remote get-url`. So `peek` returns what has already SETTLED and
 * warms everything else in the background.
 *
 * CONSEQUENCE, accepted by the plan: the FIRST peek for a repo after boot
 * returns null, so that one snapshot renders the `#NNN` tag as plain text. The
 * warm lands within a shell-out, and the next push (a checkpoint) or poll (15s)
 * carries the url. Nothing blocks, and a resolver failure settles to null rather
 * than re-shelling on every frame.
 */
export function makeRepoWebUrlCache(
  run_host: (cmd: string[], cwd?: string) => Promise<HostCommandResult> = spawnCapture,
): RepoWebUrlCache {
  const resolve = makeRepoWebUrlResolver(run_host)
  const settled = new Map<string, string | null>()
  // Guards the `.then` attachment, NOT the shell — the resolver already memoizes
  // the in-flight promise; this keeps N peeks from stacking N continuations.
  const warming = new Set<string>()
  return {
    peek(repo_path: string): string | null {
      const hit = settled.get(repo_path)
      if (hit !== undefined) return hit
      if (!warming.has(repo_path)) {
        warming.add(repo_path)
        try {
          // NOT `void`, and NOT `.catch` — the void-promise gate wants the rejection to
          // reach a named wrapper, and the pre-swallow gate bans catching it before that.
          // So the failure path caches NOTHING: `settled` stays unset and `warming` is
          // released in `.finally`, which makes a transient git failure retry on the next
          // peek instead of being negatively cached for the life of the process. The
          // rejection itself is logged by `fireAndForget`.
          fireAndForget(
            'repo-web-url-warm',
            resolve(repo_path)
              .then((v) => {
                settled.set(repo_path, v)
              })
              .finally(() => {
                warming.delete(repo_path)
              }),
          )
        } catch {
          // A synchronously-throwing run_host must not take down a board render.
          settled.set(repo_path, null)
        }
      }
      return null
    },
  }
}
