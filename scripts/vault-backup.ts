/** Local administration. Keys are read from protected files and never printed. */
import { generateBackupKey, readOwnerBackupConfig, pushEncryptedProjectBackup,
  restoreEncryptedProjectBackup, EncryptedBackupError } from '@neutronai/gateway/git/project-backup-remote.ts'

async function main(args: string[]) {
  const [operation, ownerHome, projectId, path] = args
  if (operation === 'keygen' && args.length === 2 && ownerHome) {
    await generateBackupKey(ownerHome)
    console.log('Recovery key created. Secure an off-host copy before confirming configuration.')
    return
  }
  if (!ownerHome || !projectId || !path || args.length !== 4 || !['push', 'restore'].includes(operation ?? '')) {
    throw new EncryptedBackupError('usage: keygen ABSOLUTE_KEY_FILE | push OWNER_HOME PROJECT_ID PROJECT_DIR | restore OWNER_HOME PROJECT_ID NEW_DESTINATION')
  }
  const config = await readOwnerBackupConfig(ownerHome)
  if (!config) throw new EncryptedBackupError('owner_config_missing')
  const result = operation === 'push'
    ? await pushEncryptedProjectBackup({ config, projectId, projectDir: path })
    : await restoreEncryptedProjectBackup({ config, projectId, destination: path })
  console.log(JSON.stringify(result))
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => {
    // Unexpected filesystem errors may contain private paths; never echo them.
    console.error(error instanceof EncryptedBackupError ? error.message : 'Encrypted vault backup failed')
    process.exitCode = 1
  })
}
