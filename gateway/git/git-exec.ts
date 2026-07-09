/**
 * @neutronai/gateway/git — shared low-level `git` process helpers.
 *
 * Extracted VERBATIM from `project-backup-store.ts` (refactor plan
 * 2026-07-02 § D4): the `execFile` wrapper (timeout + maxBuffer +
 * allowNonZero exit handling), the child-process error introspection
 * helpers, and the staged-changes probe that both git-backed stores
 * run before committing.
 *
 * Relationship to `doc-version-store.ts` (P7.4 Phase 1): that store
 * carries byte-identical PRIVATE copies of `gitExec`,
 * `hasStagedChanges`, `isExecChildError`, `errMessage` and `errStderr`.
 * Per the plan those copies are candidates to adopt THIS module in a
 * later unit; D4 deliberately does not touch them (behavior-preserving
 * split of the backup store only). Keep the two in sync if either
 * changes.
 *
 * Layering: this module is a downward-only leaf under `gateway/git/`.
 * It must never import from the stores (or anything else in the
 * gateway) — only node builtins.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Hard timeout per `git` invocation for non-push ops. Push gets a
 * longer ceiling — see `PUSH_TIMEOUT_MS` in `project-backup-store.ts`.
 * A healthy commit on a small repo runs in <100 ms; a runaway is most
 * likely a wedge.
 */
export const GIT_EXEC_TIMEOUT_MS = 30_000

export interface GitExecResult {
  stdout: string
  stderr: string
}

export interface GitExecOptions {
  allowNonZero?: boolean
  cwd?: string
}

/** Bound `git` runner — the binary is fixed at creation time. */
export type GitExecFn = (
  args: string[],
  opts?: GitExecOptions,
) => Promise<GitExecResult>

/**
 * The per-project repo surface the extracted snapshot-reader / restore
 * modules operate against. The facade (`ProjectBackupStore`) owns path
 * resolution and the cached git-availability probe; sub-modules receive
 * this narrow view so they can never reach the facade's concurrency
 * state (the five maps stay in the facade — plan § D4).
 */
export interface GitRepoContext {
  gitExec: GitExecFn
  /** Probe + cache `git --version`. False = degraded (no backup). */
  isGitAvailable(): Promise<boolean>
  /** Resolved git dir (e.g. `<project>/.project-backup`). */
  gitDir(project_id: string): string
  /** Resolved working tree (the project root). */
  workTree(project_id: string): string
  /** `--git-dir=<...>` argv prefix. */
  gitDirArgs(project_id: string): string[]
  /** `--git-dir=<...> --work-tree=<...>` argv prefix. */
  workArgs(project_id: string): string[]
}

/** Build a `GitExecFn` bound to `gitBinary`. */
export function createGitExec(gitBinary: string): GitExecFn {
  return async function gitExec(
    args: string[],
    opts: GitExecOptions = {},
  ): Promise<GitExecResult> {
    try {
      const execOpts: Parameters<typeof execFileAsync>[2] = {
        timeout: GIT_EXEC_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      }
      if (opts.cwd !== undefined) execOpts.cwd = opts.cwd
      const { stdout, stderr } = await execFileAsync(gitBinary, args, execOpts)
      // `encoding: 'utf8'` makes execFile return strings, but the
      // overload resolution via Parameters<...> still widens the
      // result type to `string | Buffer`. Coerce to string defensively.
      return {
        stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf8'),
        stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf8'),
      }
    } catch (err) {
      if (opts.allowNonZero === true && isExecChildError(err)) {
        return {
          stdout: typeof err.stdout === 'string' ? err.stdout : '',
          stderr: typeof err.stderr === 'string' ? err.stderr : '',
        }
      }
      throw err
    }
  }
}

/**
 * `git diff --cached --quiet` exits 1 when there ARE staged changes,
 * 0 when there are none. We use the exit code to drive the boolean.
 * `workArgs` is the `--git-dir/--work-tree` argv prefix; `workTree`
 * is the cwd the probe runs in.
 */
export async function hasStagedChanges(
  gitExec: GitExecFn,
  workArgs: string[],
  workTree: string,
): Promise<boolean> {
  const args = workArgs.concat(['diff', '--cached', '--quiet'])
  try {
    await gitExec(args, { cwd: workTree })
    return false
  } catch (err) {
    if (isExecChildError(err) && (err.code === 1 || err.code === '1')) {
      return true
    }
    throw err
  }
}

export interface ExecChildError extends Error {
  code?: string | number
  stdout?: string | Buffer
  stderr?: string | Buffer
}

export function isExecChildError(err: unknown): err is ExecChildError {
  return err instanceof Error
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function errStderr(err: unknown): string {
  if (err instanceof Error) {
    const raw = (err as ExecChildError).stderr
    if (typeof raw === 'string') return raw
    if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  }
  return ''
}

export function errStdout(err: unknown): string {
  if (err instanceof Error) {
    const raw = (err as ExecChildError).stdout
    if (typeof raw === 'string') return raw
    if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  }
  return ''
}

/** Extract the FIRST `fatal: ...` line from git stderr if present. */
export function extractGitFatal(stderr: string): string | null {
  if (stderr.length === 0) return null
  for (const line of stderr.split('\n')) {
    if (line.toLowerCase().startsWith('fatal:')) return line.trim()
  }
  return null
}
