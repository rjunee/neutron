import { isAbsolute } from 'node:path'
import { HerdrHost, type HerdrHostDeps } from './herdr-host.ts'
import { ProjectWorkspaceManager, type ProjectPanePlacement } from './project-workspaces.ts'
import type { PtySpawnOpts } from './pty-host.ts'

/** Serializable across the durable Codex helper boundary. Null alone is General. */
export interface ProjectWorkspaceLaunch {
  journalPath: string
  placement: ProjectPanePlacement
}

/** A production project host requires scope on every new process. Inherited
 * terminal environment is never authority. Existing panes still use Herdr's
 * ordinary identity-checked adoption path. */
export function createProjectWorkspaceHost(journalPath: string,
  deps: Omit<HerdrHostDeps, 'workspaceId' | 'projectWorkspaces'> = {}): HerdrHost {
  if (!isAbsolute(journalPath)) throw new Error('Project workspace journal requires an absolute path')
  class ScopedHost extends HerdrHost {
    override async spawn(argv: string[], options: PtySpawnOpts) {
      if (options.projectPlacement === undefined) throw new Error('Project workspace host requires explicit placement')
      return super.spawn(argv, options)
    }
  }
  return new ScopedHost({ ...deps, projectWorkspaces: new ProjectWorkspaceManager(journalPath) })
}
