/**
 * project-build-terminal.ts — where a dispatched build's CROSS-PROVIDER bounded
 * workers get their visible tab.
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
 */
import { join } from 'node:path'
import { configuredPtyHost } from '@neutronai/runtime/adapters/claude-code/persistent/configured-pty-host.ts'
import { herdrHost, type HerdrHostDeps } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { createHerdrRpc } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-client.ts'
import { createProjectWorkspaceHost } from '@neutronai/runtime/adapters/claude-code/persistent/project-workspace-host.ts'
import type { PtyHost } from '@neutronai/runtime/adapters/claude-code/persistent/pty-host.ts'
import type { WorkerPlacementHost, WorkerPlacementScope } from '@neutronai/runtime/workers/worker-placement.ts'
import { workBoardProjectIdForKey } from '@neutronai/work-board/store.ts'

/** Private directory (under the build state root) holding the workspace journal. The
 * state reaper only removes directories named for a terminal run, so it keeps this. */
export const WORKER_TERMINAL_DIR = 'herdr-workspaces'

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
  return createProjectWorkspaceHost(join(stateRoot, WORKER_TERMINAL_DIR, 'project-workspaces.json'),
    connect ? { connect } : {})
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
  let name: string | null | undefined
  try { name = input.projectName?.(projectId) } catch { /* A label is cosmetic; the id still scopes. */ }
  return { instanceId: input.instanceId, projectId, projectLabel: name?.trim() || projectId }
}
