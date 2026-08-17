/**
 * Discriminating dirty-checkout guard for host deploys.
 *
 * The managed control plane imports this module from its `vendor/neutron`
 * checkout, and later plan tasks in this repository consume the same API. Keep
 * it dependency-free and do not wire it into the Open host-deploy path here.
 */

import { execFile } from 'node:child_process'

export type DeployDirtKind = 'untracked' | 'divergent' | 'redundant'

export interface DeployDirtEntry {
  /** Repo-relative path, exactly as git reports it. */
  path: string
  /** The two-char porcelain XY status for the entry (e.g. ' M', '??', 'R '). */
  status: string
  kind: DeployDirtKind
}

export interface DeployPreconditionVerdict {
  /** True when nothing blocks — every dirty path (if any) is redundant with the target. */
  ok: boolean
  /** EVERY dirty path, classified — redundant entries included. */
  entries: DeployDirtEntry[]
  /** The subset that blocks: kind 'untracked' | 'divergent'. */
  blockers: DeployDirtEntry[]
  /** The owner/agent-facing refusal sentence(s). Null exactly when ok. */
  refusal: string | null
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  error: Error | null
}

const TARGET_REF = /^(?!-)[A-Za-z0-9._\/-]{1,200}$/

function git(checkout: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', checkout, ...args],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          stdout: String(stdout),
          stderr: String(stderr),
          error,
        })
      },
    )
  })
}

function gitFailure(result: GitResult): string {
  const stderr = result.stderr.trim()
  return stderr.length > 0 ? stderr : (result.error?.message ?? 'git exited unsuccessfully without stderr')
}

async function targetBlob(checkout: string, target_ref: string, path: string): Promise<string | null> {
  const result = await git(checkout, ['rev-parse', '--verify', `${target_ref}:${path}`])
  return result.ok ? result.stdout.trim() : null
}

async function classifyTrackedPath(opts: {
  checkout: string
  target_ref: string
  path: string
  status: string
  deleted: boolean
}): Promise<DeployDirtEntry> {
  const target = await targetBlob(opts.checkout, opts.target_ref, opts.path)
  if (opts.deleted) {
    return {
      path: opts.path,
      status: opts.status,
      kind: target === null ? 'redundant' : 'divergent',
    }
  }

  const worktree = await git(opts.checkout, ['hash-object', '--', opts.path])
  if (!worktree.ok) {
    throw new Error(
      `Cannot evaluate deploy preconditions for checkout ${JSON.stringify(opts.checkout)} against target ref ${JSON.stringify(opts.target_ref)}: hashing ${JSON.stringify(opts.path)} failed; git stderr: ${gitFailure(worktree)}`,
    )
  }

  return {
    path: opts.path,
    status: opts.status,
    kind: target !== null && worktree.stdout.trim() === target ? 'redundant' : 'divergent',
  }
}

function parseStatus(output: string): Array<{ path: string; status: string; original_path: string | null }> {
  const fields = output.split('\0')
  if (fields.at(-1) === '') fields.pop()

  const parsed: Array<{ path: string; status: string; original_path: string | null }> = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!
    if (field.length < 4 || field[2] !== ' ') {
      throw new Error(`git status returned malformed porcelain entry ${JSON.stringify(field)}`)
    }

    const status = field.slice(0, 2)
    const path = field.slice(3)
    const renamedOrCopied = /[RC]/.test(status)
    let original_path: string | null = null
    if (renamedOrCopied) {
      original_path = fields[index + 1] ?? null
      if (original_path === null || original_path.length === 0) {
        throw new Error(`git status omitted the original path for ${JSON.stringify(path)}`)
      }
      index += 1
    }
    parsed.push({ path, status, original_path })
  }
  return parsed
}

/**
 * Classify every dirty path against the ref that an in-place deploy will check
 * out. Only untracked content and content absent or different in that ref block.
 */
export async function evaluateDeployPreconditions(opts: {
  /** Absolute path of the deployed checkout (e.g. vendor/neutron). */
  checkout: string
  /** The ref being deployed, e.g. 'origin/main' or a 40-char sha. */
  target_ref: string
}): Promise<DeployPreconditionVerdict> {
  if (!TARGET_REF.test(opts.target_ref)) {
    throw new Error(
      `Invalid deploy target ref ${JSON.stringify(opts.target_ref)} for checkout ${JSON.stringify(opts.checkout)}: expected 1-200 letters, digits, '.', '_', '/', or '-' and no leading '-'`,
    )
  }

  const resolved = await git(opts.checkout, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${opts.target_ref}^{commit}`,
  ])
  if (!resolved.ok) {
    throw new Error(
      `Cannot evaluate deploy preconditions for checkout ${JSON.stringify(opts.checkout)} against target ref ${JSON.stringify(opts.target_ref)}: target ref did not resolve; git stderr: ${gitFailure(resolved)}`,
    )
  }

  const statusResult = await git(opts.checkout, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=normal',
  ])
  if (!statusResult.ok) {
    throw new Error(
      `Cannot evaluate deploy preconditions for checkout ${JSON.stringify(opts.checkout)} against target ref ${JSON.stringify(opts.target_ref)}: git status failed; git stderr: ${gitFailure(statusResult)}`,
    )
  }

  let dirty: ReturnType<typeof parseStatus>
  try {
    dirty = parseStatus(statusResult.stdout)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Cannot evaluate deploy preconditions for checkout ${JSON.stringify(opts.checkout)} against target ref ${JSON.stringify(opts.target_ref)}: ${detail}`,
    )
  }

  const entries: DeployDirtEntry[] = []
  for (const item of dirty) {
    if (item.status === '??') {
      entries.push({ path: item.path, status: item.status, kind: 'untracked' })
      continue
    }

    entries.push(
      await classifyTrackedPath({
        checkout: opts.checkout,
        target_ref: opts.target_ref,
        path: item.path,
        status: item.status,
        // A rename/copy's first path is the new worktree path even when its XY
        // status contains R or C, so it is always classified by content.
        deleted: item.original_path === null && item.status.includes('D'),
      }),
    )

    if (item.original_path !== null) {
      entries.push(
        await classifyTrackedPath({
          checkout: opts.checkout,
          target_ref: opts.target_ref,
          path: item.original_path,
          status: item.status,
          deleted: true,
        }),
      )
    }
  }

  const blockers = entries.filter((entry) => entry.kind !== 'redundant')
  const ok = blockers.length === 0
  return {
    ok,
    entries,
    blockers,
    refusal: ok ? null : renderDeployPreconditionRefusal(opts.target_ref, entries),
  }
}

function alphabetically(a: DeployDirtEntry, b: DeployDirtEntry): number {
  if (a.path < b.path) return -1
  if (a.path > b.path) return 1
  return 0
}

export function renderDeployPreconditionRefusal(
  target_ref: string,
  entries: readonly DeployDirtEntry[],
): string {
  const divergent = entries.filter((entry) => entry.kind === 'divergent').sort(alphabetically)
  const untracked = entries.filter((entry) => entry.kind === 'untracked').sort(alphabetically)
  const redundant = entries.filter((entry) => entry.kind === 'redundant').sort(alphabetically)
  const lines = ['deploy preconditions failed — nothing was touched:']

  for (const entry of divergent) {
    lines.push(
      `  • ${entry.path} — modified, and its content DIVERGES from ${target_ref}: a bump checks out the ref in place and would destroy this content. Commit or stash it first.`,
    )
  }
  for (const entry of untracked) {
    lines.push(
      `  • ${entry.path} — untracked (in no ref): a bump would strand or clobber it. Move or remove it first.`,
    )
  }
  if (redundant.length > 0) {
    lines.push('Also dirty but NOT blocking:')
    for (const entry of redundant) {
      lines.push(
        `  • ${entry.path} — modified, but its working-tree content is already in ${target_ref}; discarding it loses nothing.`,
      )
    }
  }

  return lines.join('\n')
}
