/**
 * @neutronai/open — the two I/O halves of the host-deploy request path.
 *
 * `open/host-deploy.ts` holds the policy (resolve → approve → execute) behind
 * two narrow seams so every guard in it is testable without a repo or a network.
 * This module supplies the production implementations of those seams:
 *
 *   - {@link createHostDeployGit} — a READ-ONLY view of the checkout the host
 *     runs, over the shared `execFile` git wrapper (`gateway/git/git-exec.ts`).
 *     There is no fetch, no checkout, no write: the instance describes what
 *     would deploy, it does not deploy.
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
 */

import { createGitExec, type GitExecFn } from '@neutronai/gateway/git/git-exec.ts'

import {
  HOST_DEPLOY_CALL_TIMEOUT_MS,
  HOST_DEPLOY_DETAIL_CAP,
  type HostDeployCommit,
  type HostDeployCommitRange,
  type HostDeployDispatch,
  type HostDeployGit,
} from './host-deploy.ts'

/**
 * A read-only {@link HostDeployGit} over `repo_dir` — the checkout the host
 * runs (`NEUTRON_REPO_ROOT`, the same root `open/composer.ts:1890` resolves the
 * public doc root from). `HEAD` is the CURRENT PIN: the sha this box is on.
 */
export function createHostDeployGit(opts: {
  repo_dir: string
  git_binary?: string
  exec?: GitExecFn
}): HostDeployGit {
  const { repo_dir } = opts
  const gitExec = opts.exec ?? createGitExec(opts.git_binary ?? 'git')

  return {
    async revParse(ref: string): Promise<string | null> {
      // `--verify --quiet` exits non-zero with empty stdout for an unknown ref;
      // `^{commit}` makes an annotated tag resolve to the commit it points at,
      // so the sha the approval binds to is the sha that would be deployed.
      const { stdout } = await gitExec(
        ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
        { cwd: repo_dir, allowNonZero: true },
      )
      const sha = stdout.trim()
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null
    },

    async commitsBetween(from: string, to: string, limit: number): Promise<HostDeployCommitRange> {
      // TWO calls on purpose: the render is capped, the COUNT is not. "40
      // commits would land" when 300 would is a lie the owner cannot detect.
      const counted = await gitExec(['rev-list', '--count', `${from}..${to}`], {
        cwd: repo_dir,
        allowNonZero: true,
      })
      const parsedTotal = Number.parseInt(counted.stdout.trim(), 10)
      const total = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : 0

      const logged = await gitExec(
        [
          'log',
          '--no-color',
          `--max-count=${Math.max(1, Math.trunc(limit))}`,
          '--format=%H %s',
          `${from}..${to}`,
        ],
        { cwd: repo_dir, allowNonZero: true },
      )
      const commits: HostDeployCommit[] = []
      for (const line of logged.stdout.split('\n')) {
        const trimmed = line.trimEnd()
        if (trimmed.length === 0) continue
        const space = trimmed.indexOf(' ')
        const sha = space === -1 ? trimmed : trimmed.slice(0, space)
        if (!/^[0-9a-f]{40}$/.test(sha)) continue
        commits.push({ sha, subject: space === -1 ? '' : trimmed.slice(space + 1) })
      }
      // `rev-list --count` and `log` are two invocations, so a ref that moved
      // between them could make the count SMALLER than the rendered list. Never
      // report fewer commits than are shown.
      return { commits, total: Math.max(total, commits.length) }
    },
  }
}

/**
 * The narrow slice of `fetch` this module calls — declared as its own type
 * rather than `typeof fetch` so a test double is a plain function, not an
 * object that also has to carry the runtime's `fetch.preconnect`.
 */
export type HostDeployFetch = (input: string, init: RequestInit) => Promise<Response>

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
      text = (await res.text()).trim().slice(0, HOST_DEPLOY_DETAIL_CAP)
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
