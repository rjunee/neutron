import { isAbsolute } from 'node:path'
import { createProjectWorkspaceHost, type ProjectWorkspaceLaunch } from '../../claude-code/persistent/project-workspace-host.ts'
import type { HerdrHostDeps } from '../../claude-code/persistent/herdr-host.ts'

/** The private launch file carries scope across the helper process boundary.
 * The helper must not reinterpret missing scope as its inherited workspace. */
export function codexOwnerWorkspace(workspace: ProjectWorkspaceLaunch | undefined,
  projectId: string | null): ProjectWorkspaceLaunch {
  const placement = workspace?.placement
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && !/[\x00-\x1f\x7f]/.test(value)
  if (!workspace || !text(workspace.journalPath) || !isAbsolute(workspace.journalPath) || !placement
    || !text(placement.instanceId) || !text(placement.projectLabel)
    || placement.projectId !== projectId || placement.role !== 'chat'
    || projectId !== null && (typeof projectId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(projectId))) {
    throw new Error('Codex owner requires an explicit matching project workspace')
  }
  return { journalPath: workspace.journalPath, placement: { ...placement } }
}

/** Consumed by the durable helper for the one native TUI it already launches. */
export function codexOwnerTerminal(workspace: ProjectWorkspaceLaunch | undefined,
  projectId: string | null, connect: NonNullable<HerdrHostDeps['connect']>) {
  const launch = codexOwnerWorkspace(workspace, projectId)
  return { terminalHost: createProjectWorkspaceHost(launch.journalPath, { connect }),
    projectPlacement: launch.placement }
}
