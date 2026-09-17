import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProductionHostOptions } from './production-host-effects.ts'
import { isTerminalPhase } from './state-machine.ts'
import { withProjectPolicyDirectory } from './project-policy-resources.ts'

type Identity = Pick<ProductionHostOptions, 'store' | 'runId' | 'projectSlug' | 'repo' | 'branch' | 'worktree'>
export type PolicySourceResult<T> = { kind: 'known'; value: T } | { kind: 'unknown'; detail: string }

/** The callback must await publication before returning. The body contains the
 * owner's persisted request and host pins, never a worker's completion claim. */
export async function withProjectPublication<T>(identity: Identity, root: string,
  publish: (publication: Awaited<ReturnType<ProductionHostOptions['publication']>>) => Promise<T>,
): Promise<PolicySourceResult<T>> {
  try {
    return await withProjectPolicyDirectory(root, async directory => {
      const row = identity.store.get(identity.runId)
      if (!row || row.id !== identity.runId || row.project_slug !== identity.projectSlug || row.repo_path !== identity.repo
        || row.branch !== identity.branch || row.worktree !== identity.worktree || isTerminalPhase(row.phase)) {
        throw new Error('Publication run identity is missing, changed or terminal')
      }
      if (!row.task.trim() || !row.slug.trim() || !row.base_sha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(row.base_sha)) {
        throw new Error('Publication task, slug or launch base is missing')
      }
      const title = row.task.trim().split(/\r?\n/)[0]!.slice(0, 100)
      const bodyFile = join(directory, 'publication.md')
      const body = `## Requested change\n\n${row.task}\n\n## Host context\n\nRun: ${row.id}\nLaunch base: ${row.base_sha}\n`
      await writeFile(bodyFile, body, { flag: 'wx', mode: 0o600 })
      return { kind: 'known' as const, value: await publish({ title, bodyFile }) }
    })
  } catch (error) { return { kind: 'unknown', detail: `Publication source: ${String(error)}` } }
}
