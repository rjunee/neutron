import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { resolveProviderSelection } from '@neutronai/runtime/adapters/select-substrate.ts'
import { readInstanceModelProvider } from '../storage/owner-metadata.ts'
import type { SqliteProjectSettingsStore } from '../projects/sqlite-store.ts'

/** Read both mutable levels for every dispatch and settings inspection. */
export function createModelProviderResolver(
  db: ProjectDb,
  instance: string,
  projects: Pick<SqliteProjectSettingsStore, 'modelProviderOverride'>,
) {
  return (projectId?: string) => resolveProviderSelection({
    instance: readInstanceModelProvider(db, instance),
    project: projects.modelProviderOverride(projectId),
  })
}
