import { ProjectBackupStore } from '../../git/project-backup-store.ts'
import type { PlatformAdapter } from '@neutronai/runtime/platform-adapter.ts'

/** Real local Git history, with no configured remote or provisioning service. */
export function localVaultBackup(owner_home: string, project_slug: string): ProjectBackupStore {
  return new ProjectBackupStore({
    owner_home,
    project_slug,
    platform: {
      capabilities: { project_backup: true },
      getProjectBackupRemoteConfig: async () => null,
    } as unknown as PlatformAdapter,
  })
}
