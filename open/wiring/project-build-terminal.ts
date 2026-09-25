/**
 * project-build-terminal.ts — where a dispatched build's CROSS-PROVIDER bounded
 * workers, and every owner CONVERSATION (#1226), get their visible tab.
 *
 * Two questions, answered once per composition and once per dispatch:
 *
 *  - WHICH HOST. One strict `createProjectWorkspaceHost` over one private journal,
 *    shared by every dispatch, so its `ProjectWorkspaceManager` serializes placements
 *    per scope. Only when the operator's configured terminal host IS Herdr: a test
 *    runner (`configuredPtyHost` is the bun pty under `NODE_ENV=test`) and a bun-host
 *    service get `null`, and every worker then runs unplaced with that reason recorded.
 *
 *  - WHICH SCOPE. The run's own work-board scope key, never a name or a cwd. The
 *    owner's slug is General (`workBoardProjectIdForKey` → undefined) and becomes the
 *    manager's `null` — `Neutron General` — while a project whose id happens to be
 *    the word `general` keeps that id and its own workspace.
 *
 *  - WHICH CHAT. The owner conversation (Claude REPL or Codex native owner) is the
 *    scope's `Chat` tab, placed through the SAME host and manager, for the
 *    dispatch's exact conversation scope (`conversationPlacementFor`).
 */
import { join } from 'node:path'
import { configuredPtyHost } from '@neutronai/runtime/adapters/claude-code/persistent/configured-pty-host.ts'
import { herdrHost, type HerdrHostDeps } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { createHerdrRpc } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-client.ts'
import { createProjectWorkspaceHost, isProjectChatInspector, type ConversationTerminal } from '@neutronai/runtime/adapters/claude-code/persistent/project-workspace-host.ts'
import type { ProjectPanePlacement } from '@neutronai/runtime/adapters/claude-code/persistent/project-workspaces.ts'
import type { PtyHost } from '@neutronai/runtime/adapters/claude-code/persistent/pty-host.ts'
import type { WorkerPlacementHost, WorkerPlacementScope } from '@neutronai/runtime/workers/worker-placement.ts'
import { workBoardProjectIdForKey } from '@neutronai/work-board/store.ts'

/** Private directory (under the build state root) holding the workspace journal. The
 * state reaper only removes directories named for a terminal run, so it keeps this. */
export const WORKER_TERMINAL_DIR = 'herdr-workspaces'

/** The shared host's journal, also handed (as a path, never a live object) to the
 * durable Codex owner helper so its native TUI is placed by the same ledger. */
export function projectWorkspaceJournalPath(stateRoot: string): string {
  return join(stateRoot, WORKER_TERMINAL_DIR, 'project-workspaces.json')
}

/** The shared worker terminal host, or null when this process does not run on Herdr. */
export function createWorkerTerminalHost(stateRoot: string, options: {
  env?: NodeJS.ProcessEnv
  /** The operator-selected terminal host. Defaults to the process-wide choice. */
  selected?: PtyHost
  /** Test seam: the Herdr RPC. Production dials the configured socket. */
  connect?: HerdrHostDeps['connect']
} = {}): WorkerPlacementHost | null {
  if ((options.selected ?? configuredPtyHost) !== herdrHost) return null
  const socketPath = options.env?.['HERDR_SOCKET_PATH']
  const connect = options.connect ?? (socketPath ? async () => createHerdrRpc({ socketPath }) : undefined)
  return createProjectWorkspaceHost(projectWorkspaceJournalPath(stateRoot), connect ? { connect } : {})
}

/** The dispatch's placement scope, from its run's work-board scope key. */
export function workerPlacementScope(input: {
  /** The instance identity (the owner handle that keys this instance's sessions). */
  instanceId: string
  /** The owner's slug: the scope key General runs carry. */
  ownerSlug: string
  /** `run.project_slug` — the run's scope key. */
  runScopeKey: string
  /** Display name for a project id, when the project store has one. */
  projectName?: (projectId: string) => string | null | undefined
}): WorkerPlacementScope {
  const projectId = workBoardProjectIdForKey(input.ownerSlug, input.runScopeKey) ?? null
  if (projectId === null) return { instanceId: input.instanceId, projectId: null, projectLabel: 'Neutron General' }
  return { instanceId: input.instanceId, projectId, projectLabel: projectLabel(projectId, input.projectName) }
}

/** Display name for a project's workspace: its stored name, else its id. Never General. */
function projectLabel(projectId: string, projectName?: (projectId: string) => string | null | undefined): string {
  let name: string | null | undefined
  try { name = projectName?.(projectId) } catch { /* A label is cosmetic; the id still scopes. */ }
  return name?.trim() || projectId
}

/**
 * The owner conversation's Chat placement for ONE dispatch's exact conversation
 * scope. `null` is General (`Neutron General`, the manager's null scope); any string,
 * including the literal `general`, is that project's own id and workspace. This is
 * derived from the conversation scope, never from the pool's `'general'` key
 * sentinel, so General can never become a project named `general`.
 */
export function conversationPlacementFor(input: {
  instanceId: string
  conversationProjectId: string | null
  projectName?: (projectId: string) => string | null | undefined
}): ProjectPanePlacement {
  const { instanceId, conversationProjectId } = input
  if (conversationProjectId === null) return { instanceId, projectId: null, projectLabel: 'Neutron General', role: 'chat' }
  return { instanceId, projectId: conversationProjectId, projectLabel: projectLabel(conversationProjectId, input.projectName), role: 'chat' }
}

/**
 * The owner conversation terminal for this composition, or undefined off Herdr (a
 * test runner or a bun-host service spawns conversations exactly as before).
 *
 * On Herdr every conversation spawn carries explicit placement. With the shared
 * strict host it is routed through `ProjectWorkspaceManager`; without one, the
 * placement still travels and the configured manager-less Herdr host refuses the
 * spawn (`explicit project placement requires a workspace manager`) — never a
 * fallback to the gateway's inherited `HERDR_WORKSPACE_ID`.
 */
export function createConversationTerminal(input: {
  host: PtyHost | null
  instanceId: string
  projectName?: (projectId: string) => string | null | undefined
  /** The operator-selected terminal host. Defaults to the process-wide choice. */
  selected?: PtyHost
}): ConversationTerminal | undefined {
  if ((input.selected ?? configuredPtyHost) !== herdrHost) return undefined
  const placementFor = (conversationProjectId: string | null): ProjectPanePlacement => conversationPlacementFor({
    instanceId: input.instanceId, conversationProjectId,
    ...(input.projectName === undefined ? {} : { projectName: input.projectName }),
  })
  if (input.host === null) return { placementFor }
  const host = input.host
  // #1226 sleep: the strict host's read-only Chat sample, for the exact scope.
  return isProjectChatInspector(host)
    ? { host, placementFor, inspectChat: scope => host.inspectChat(placementFor(scope)) }
    : { host, placementFor }
}
