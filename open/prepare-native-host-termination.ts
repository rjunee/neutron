import { resolveBootConfig, resolveOwnerSlugSourceFromConfig } from '@neutronai/config/index.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import { workBoardProjectIdForKey } from '@neutronai/work-board/store.ts'
import { verifyHostTerminationPreparation } from '@neutronai/runtime/workers/native-host-termination.ts'
import { loadNativeHostRecoveryAuthority } from './native-host-recovery-authority.ts'
import { prepareNativeHostTermination } from './wiring/native-host-termination.ts'

/** Operator bridge: run as the server's effective UID with its normal install
 * environment. Reads signed evidence only from stdin, never a signing key or
 * caller-selected trust pin. It neither migrates nor creates a database. */
export async function prepareConfiguredNativeHostTermination(evidence: unknown, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const authority = loadNativeHostRecoveryAuthority()
    if (!authority || !verifyHostTerminationPreparation(evidence, authority)) return false
    const config = resolveBootConfig(env)
    const owner = resolveOwnerSlugSourceFromConfig(config).slug
    const db = ProjectDb.open(config.dbPath, { create: false })
    try {
      return await prepareNativeHostTermination({ authority,
        admission: new ProjectAdmission({ db, ownerHandle: owner, bootId: crypto.randomUUID() }),
        runs: new TridentRunStore(db), attempts: new TridentAttemptLedger(db),
        projectIdForRun: run => workBoardProjectIdForKey(owner, run.project_slug) ?? null,
        listProjectIds: () => db.all<{ id: string }>('SELECT id FROM projects WHERE deleted_at IS NULL').map(row => row.id),
      }, evidence)
    } finally { db.close() }
  } catch { return false }
}

export async function readHostTerminationPreparation(input: AsyncIterable<Uint8Array | string>): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk)
    length += bytes.length
    if (length > 65_536) throw new Error('Preparation input too large')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

if (import.meta.main) {
  let prepared = false
  try {
    if (process.argv.length === 2) prepared = await prepareConfiguredNativeHostTermination(await readHostTerminationPreparation(process.stdin))
  } catch { /* Refusal deliberately does not print signed evidence or local paths. */ }
  console.log(JSON.stringify({ status: prepared ? 'prepared' : 'refused' }))
  process.exitCode = prepared ? 0 : 1
}
