import { isAbsolute } from 'node:path'
import { createHerdrRpc } from './herdr-client.ts'
import { HerdrHost, type HerdrHostDeps } from './herdr-host.ts'
import { ProjectWorkspaceManager, type ChatInspection, type ProjectPanePlacement } from './project-workspaces.ts'
import type { PtyHost, PtySpawnOpts } from './pty-host.ts'

/** Serializable across the durable Codex helper boundary. Null alone is General. */
export interface ProjectWorkspaceLaunch {
  journalPath: string
  placement: ProjectPanePlacement
}

/** The owner conversation's terminal, resolved PER DISPATCH from the exact
 * conversation scope (null is General; a literal `general` id is a project).
 * `host` is the shared strict project-workspace host. It is absent only when the
 * operator runs Herdr but composition could not build one: the placement is then
 * still supplied, so the configured manager-less Herdr host refuses the spawn
 * instead of falling back to an inherited workspace. Off Herdr there is no
 * terminal at all and conversations spawn exactly as before. */
export interface ConversationTerminal {
  host?: PtyHost
  placementFor(conversationProjectId: string | null): ProjectPanePlacement
  /** #1226 sleep: a READ-ONLY sample of the scope's Chat slot through the shared
   * manager. Present only with the strict host; it never closes anything. */
  inspectChat?(conversationProjectId: string | null): Promise<ChatInspection>
}

/** The strict host's read-only Chat inspection (#1226 sleep). */
export interface ProjectChatInspector {
  inspectChat(placement: ProjectPanePlacement): Promise<ChatInspection>
}

export function isProjectChatInspector(host: unknown): host is ProjectChatInspector {
  return typeof (host as Partial<ProjectChatInspector> | null)?.inspectChat === 'function'
}

/** A production project host requires scope on every new process. Inherited
 * terminal environment is never authority. Existing panes still use Herdr's
 * ordinary identity-checked adoption path. */
export function createProjectWorkspaceHost(journalPath: string,
  deps: Omit<HerdrHostDeps, 'workspaceId' | 'projectWorkspaces'> = {}): HerdrHost & ProjectChatInspector {
  if (!isAbsolute(journalPath)) throw new Error('Project workspace journal requires an absolute path')
  const manager = new ProjectWorkspaceManager(journalPath)
  class ScopedHost extends HerdrHost implements ProjectChatInspector {
    override async spawn(argv: string[], options: PtySpawnOpts) {
      if (options.projectPlacement === undefined) throw new Error('Project workspace host requires explicit placement')
      return super.spawn(argv, options)
    }
    async inspectChat(placement: ProjectPanePlacement): Promise<ChatInspection> {
      let client
      try { client = await (deps.connect ?? (async () => createHerdrRpc()))() } catch (error) {
        return { status: 'refused', reason: `herdr unreachable: ${error instanceof Error ? error.message : String(error)}` }
      }
      return manager.inspectChat(client, placement)
    }
  }
  return new ScopedHost({ ...deps, projectWorkspaces: manager })
}
