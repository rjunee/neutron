/**
 * @neutronai/gateway/diagnostics — build `DiagnosticsSources` from live/on-disk
 * per-instance state (unit O5). READ-ONLY: every getter is an existing read.
 *
 * Two callers share this builder:
 *   - the admin endpoint (in-process), which also passes the live credential
 *     pool (`credentialPool`) — in-memory state only reachable inside the
 *     running gateway, and
 *   - the `neutron doctor` CLI (off-process), which opens `project.db`
 *     read-only and omits the pool → the credential section renders
 *     `{ available: false }`.
 *
 * Getters are LAZY (evaluated at request time) and may throw; the pure
 * `composeDiagnostics` wraps each in its own guard so a broken source degrades
 * only its own section.
 */

import { join } from 'node:path'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { CronStateStore } from '@neutronai/cron/state.ts'
import { OnboardingTelemetry } from '@neutronai/onboarding/telemetry/event-emitter.ts'
import { loadRegistry } from '@neutronai/runtime/adapters/claude-code/persistent/repl-registry.ts'
import {
  hasUsableCredential,
  soonestCooldownUntil,
  type CredentialPool,
} from '@neutronai/runtime/credential-pool.ts'
import { readGbrainSyncState } from '../realmode-composer/gbrain-sync-state-store.ts'
import type { DiagnosticsSources, ImportRowish } from './diagnostics-report.ts'

/** REPL supervision registry file, relative to the owner home. Mirrors
 *  `runtime/adapters/claude-code/index.ts` (`join(stateDir, 'repl-registry.json')`). */
export const REPL_REGISTRY_RELPATH = '.neutron/repl-registry.json'

/** Cap on the most-recent events returned — the tail of the ASC journal. */
export const DEFAULT_MAX_RECENT_EVENTS = 50

export interface InstanceDiagnosticsSourceInput {
  db: ProjectDb
  project_slug: string
  owner_home: string
  /** Live credential pool (in-process only). Omit / null off-process → the
   *  credentials section renders `{ available: false }`. */
  credentialPool?: CredentialPool | null
  now?: () => number
  maxRecentEvents?: number
}

/**
 * Assemble the `DiagnosticsSources` getters over one instance's DB + home.
 * Every getter is a plain read; nothing runs until `composeDiagnostics` calls
 * it. Constructs the small store wrappers once so repeated calls are cheap.
 */
export function buildInstanceDiagnosticsSources(
  input: InstanceDiagnosticsSourceInput,
): DiagnosticsSources {
  const { db, project_slug, owner_home } = input
  const maxEvents = input.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS
  const cronStore = new CronStateStore(db)
  const telemetry = new OnboardingTelemetry({ db })
  const registryPath = join(owner_home, REPL_REGISTRY_RELPATH)

  const sources: DiagnosticsSources = {
    project_slug,
    gbrain: () => readGbrainSyncState({ db, scope: project_slug }),
    // Filter to THIS instance's slug — `list()` returns every project's rows
    // (cron_state is keyed by (job, project)); the sibling import/event sources
    // filter the same way, and the owner-gated endpoint is instance-scoped.
    cronJobs: () => cronStore.list().filter((r) => r.project_slug === project_slug),
    importJobs: () =>
      db.all<ImportRowish>(
        `SELECT job_id, source, status, started_at, completed_at, error_code, error_message
           FROM import_jobs
          WHERE project_slug = ?
          ORDER BY started_at DESC`,
        [project_slug],
      ),
    recentEvents: () => {
      const all = telemetry.list(project_slug)
      // `list()` is ts ASC + unbounded — take the newest `maxEvents`, newest first.
      const tail = all.slice(Math.max(0, all.length - maxEvents))
      return tail.reverse()
    },
    replRegistry: () => ({
      path: registryPath,
      // Propagate corruption/read errors as a throw → the section renders
      // `available: false` (an unreadable registry IS a chat-supervision fault,
      // exactly what this feature diagnoses). An ABSENT file is the steady-state
      // cold-boot case — `loadRegistry` returns `{}` without invoking the
      // callback, so it stays `available: true` with zero sessions.
      records: loadRegistry(registryPath, (reason) => {
        throw new Error(`repl-registry unreadable/corrupt: ${reason}`)
      }),
    }),
  }

  if (input.now !== undefined) sources.now = input.now

  const pool = input.credentialPool
  if (pool !== undefined && pool !== null) {
    sources.credentials = () => ({
      hasUsable: hasUsableCredential(pool),
      soonestCooldownUntil: soonestCooldownUntil(pool),
    })
  }

  return sources
}
