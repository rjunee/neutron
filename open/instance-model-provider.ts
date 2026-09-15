/** Provision or update one instance without restarting its server.
 * Usage: bun open/instance-model-provider.ts <database> <instance> <provider|inherit>
 */
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { writeInstanceModelProvider } from '@neutronai/gateway/storage/owner-metadata.ts'
import { normalizeProvider } from '@neutronai/runtime/adapters/select-substrate.ts'
import { createLogger } from '@neutronai/logger'
if (import.meta.main) {
  const [database, instance, value] = process.argv.slice(2)
  if (!database || !instance || !value) throw new Error('Expected database, instance, provider (or inherit)')
  const provider = value === 'inherit' ? null : normalizeProvider(value)
  const db = ProjectDb.open(database)
  try {
    createLogger('instance-model-provider').info('configured', { outcome: await writeInstanceModelProvider(db, instance, provider) })
  } finally {
    db.close()
  }
}
