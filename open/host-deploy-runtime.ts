/**
 * @neutronai/open — the two I/O halves of the host-deploy request path.
 *
 * `open/host-deploy.ts` holds the policy (resolve → approve → execute) behind
 * two narrow seams so every guard in it is testable without a repo or a network.
 * This module supplies the production implementations of those seams:
 *
 *   - {@link createHostDeployGit} — a view of the checkout the host runs, over
 *     the shared, bounded `execFile` git wrapper (`gateway/git/git-exec.ts`). A
 *     remote target is fetched so its objects can be rendered in the approval;
 *     no operation changes the working tree, HEAD, or deployed state.
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

import { createGitExec, errStdout, type GitExecFn } from '@neutronai/gateway/git/git-exec.ts'

import {
  HOST_DEPLOY_CALL_TIMEOUT_MS,
  HOST_DEPLOY_DETAIL_CAP,
  HOST_DEPLOY_REMOTE_TIMEOUT_MS,
  scrubHostDeploySecrets,
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
  remote_timeout_ms?: number
}): HostDeployGit {
  const { repo_dir } = opts
  const remote_timeout_ms = opts.remote_timeout_ms ?? HOST_DEPLOY_REMOTE_TIMEOUT_MS
  const gitExec = opts.exec ?? createGitExec(opts.git_binary ?? 'git')

  async function revParse(ref: string): Promise<string | null> {
    // `--verify --quiet` exits 1 with empty stdout for an unknown ref;
    // `^{commit}` makes an annotated tag resolve to the commit it points at,
    // so the sha the approval binds to is the sha that would be deployed.
    //
    // NOT `allowNonZero` — that flag routes through `isExecChildError`, which
    // is `err instanceof Error` (`gateway/git/git-exec.ts:135`) and therefore
    // swallows a MISSING git binary, a timeout and a maxBuffer overrun into
    // the same empty stdout an unknown ref produces. Under it a broken
    // checkout was indistinguishable from "this ref does not exist" (Argus r1
    // major). Only the one exit status `--quiet` documents becomes null; every
    // other failure propagates and the service refuses.
    let stdout: string
    try {
      ;({ stdout } = await gitExec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        cwd: repo_dir,
      }))
    } catch (err) {
      if (isUnknownRefExit(err)) return null
      throw err
    }
    const sha = stdout.trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null
  }

  return {
    revParse,

    async resolveTarget(ref: string): Promise<string | null> {
      const remotes = (await gitExec(['remote'], { cwd: repo_dir })).stdout
        .split('\n')
        .map((remote) => remote.trim())
        .filter((remote) => remote.length > 0)
      const parts = ref.split('/')
      const explicit = parts[0] === 'refs' && parts[1] === 'remotes'
      const remote = explicit ? parts[2] : parts[0]
      const branch = explicit ? parts.slice(3).join('/') : parts.slice(1).join('/')
      if (remote !== undefined && branch.length > 0 && remotes.includes(remote)) {
        // Fetch, rather than ls-remote, because the approval must render the
        // actual commits. `--force` keeps a rewritten remote branch truthful;
        // the destination is metadata only and cannot move HEAD or the tree.
        await gitExec(
          ['fetch', '--no-tags', '--force', remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
          { cwd: repo_dir, timeout_ms: remote_timeout_ms },
        )
        return revParse(`refs/remotes/${remote}/${branch}`)
      }
      return revParse(ref)
    },

    async commitsBetween(from: string, to: string, limit: number): Promise<HostDeployCommitRange> {
      // TWO calls on purpose: the render is capped, the COUNT is not. "40
      // commits would land" when 300 would is a lie the owner cannot detect.
      //
      // Neither call passes `allowNonZero`. THE COMMIT LIST IS THE APPROVAL: if
      // git cannot produce it, the only correct answer is the refusal
      // `open/host-deploy.ts` already writes — not an empty list rendered under
      // the "SIDEWAYS or BACKWARD" warning, which is what swallowing the failure
      // showed the owner instead (Argus r1 major).
      const counted = await gitExec(['rev-list', '--count', `${from}..${to}`], {
        cwd: repo_dir,
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
        { cwd: repo_dir },
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
 * True only for the ONE failure `git rev-parse --verify --quiet` uses to say
 * "this checkout does not know that ref": exit status 1 with no stdout. A
 * missing binary (`ENOENT`), a timeout (`SIGTERM`), a maxBuffer overrun and
 * git's own `fatal:` exits (128) all fail this test and stay thrown, so a broken
 * checkout can never be reported to the owner as a merely unknown ref.
 */
function isUnknownRefExit(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const { code } = err as { code?: unknown }
  if (code !== 1 && code !== '1') return false
  return errStdout(err).trim().length === 0
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
