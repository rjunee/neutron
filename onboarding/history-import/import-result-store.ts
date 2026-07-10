/**
 * @neutronai/onboarding/history-import — `import_results` write-back +
 * read-on-miss helpers.
 *
 * (K3, 2026-07-03) — extracted verbatim from the deleted per-chunk
 * `job-runner.ts` (`persistResult` at :1959 + `loadResult` at :734) BEFORE
 * the file was removed, because P6 reuses this durable write-back / read-on-
 * miss pattern for the synthesis result store. The SQL + JSON round-trip is
 * byte-identical to the pre-deletion methods (upsert on `job_id`; tolerant
 * JSON.parse of the legacy interest/confidence columns). Golden-tested in
 * `__tests__/import-result-store.test.ts`.
 *
 * The LIVE synthesis import path (`build-synthesis-import-runner.ts`) does
 * NOT use this store — it holds the completed `ImportResult` in-process. This
 * module has no current runtime caller; it is the extracted seam P6 wires.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { parseJsonColumn } from '@neutronai/persistence/index.ts'
import type { ImportResult, ImportSource } from './types.ts'

interface ImportResultRow {
  job_id: string
  project_slug: string
  source: string
  projects_json: string
  tasks_json: string
  topics_json: string
  reminders_json: string
  entities_json: string
  voice_signals_json: string
  facts_json: string
  finalized_at: number
  partial: number
  inferred_interests_json: string
  confidence_by_inference_json: string
  conversation_count: number | null
  synthesizer_model: string | null
}

export interface PersistImportResultInput {
  job_id: string
  project_slug: string
  source: ImportSource
  result: ImportResult
  partial: boolean
  /** Wall-clock epoch-ms stamped into `finalized_at`. */
  now: number
}

/**
 * Write-back an `ImportResult` to the `import_results` table, upserting on
 * `job_id` (a partial → full re-persist overwrites the same row). Mirrors the
 * deleted `ImportJobRunner.persistResult` exactly.
 */
export async function persistImportResult(
  db: ProjectDb,
  input: PersistImportResultInput,
): Promise<void> {
  const { job_id, project_slug, source, result, partial, now } = input
  const conv_count_raw = (result as ImportResult & { conversation_count?: number })
    .conversation_count
  const conversation_count =
    typeof conv_count_raw === 'number' && Number.isFinite(conv_count_raw) && conv_count_raw > 0
      ? conv_count_raw
      : null
  const synthesizer_model =
    typeof result.synthesizer_model === 'string' && result.synthesizer_model.length > 0
      ? result.synthesizer_model
      : null
  await db.run(
    `INSERT INTO import_results
      (job_id, project_slug, source, projects_json, tasks_json, topics_json,
       reminders_json, entities_json, voice_signals_json, facts_json,
       finalized_at, partial,
       inferred_interests_json, confidence_by_inference_json, conversation_count,
       synthesizer_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (job_id) DO UPDATE SET
       projects_json = excluded.projects_json,
       tasks_json = excluded.tasks_json,
       topics_json = excluded.topics_json,
       reminders_json = excluded.reminders_json,
       entities_json = excluded.entities_json,
       voice_signals_json = excluded.voice_signals_json,
       facts_json = excluded.facts_json,
       finalized_at = excluded.finalized_at,
       partial = excluded.partial,
       inferred_interests_json = excluded.inferred_interests_json,
       confidence_by_inference_json = excluded.confidence_by_inference_json,
       conversation_count = excluded.conversation_count,
       synthesizer_model = excluded.synthesizer_model`,
    [
      job_id,
      project_slug,
      source,
      JSON.stringify(result.proposed_projects),
      JSON.stringify(result.proposed_tasks),
      JSON.stringify(result.topics),
      JSON.stringify(result.proposed_reminders),
      JSON.stringify(result.entities),
      JSON.stringify(result.voice_signals),
      JSON.stringify(result.facts),
      now,
      partial ? 1 : 0,
      JSON.stringify(result.inferred_interests ?? []),
      JSON.stringify(result.confidence_by_inference ?? []),
      conversation_count,
      synthesizer_model,
    ],
  )
}

/**
 * Read-on-miss: load a persisted `ImportResult` by `job_id`, or `null` when
 * no row exists. Mirrors the deleted `ImportJobRunner.loadResult` exactly,
 * including the tolerant JSON.parse of the legacy interest/confidence
 * columns (a malformed legacy row degrades to the base result, never throws).
 */
export function loadImportResult(
  db: ProjectDb,
  job_id: string,
): { result: ImportResult; partial: boolean } | null {
  const row = db
    .get<ImportResultRow, [string]>(
      `SELECT job_id, project_slug, source, projects_json, tasks_json, topics_json,
              reminders_json, entities_json, voice_signals_json, facts_json,
              finalized_at, partial,
              inferred_interests_json, confidence_by_inference_json,
              conversation_count, synthesizer_model
         FROM import_results WHERE job_id = ?`,
      [job_id],
    )
  if (row === null) return null
  // Corrupt-policy (core fields): throw propagates — a malformed core column
  // is a hard data-integrity failure, not something to silently paper over.
  const result: ImportResult = {
    entities: parseJsonColumn(row.entities_json, { onCorrupt: 'throw' }) as ImportResult['entities'],
    topics: parseJsonColumn(row.topics_json, { onCorrupt: 'throw' }) as ImportResult['topics'],
    proposed_projects: parseJsonColumn(row.projects_json, {
      onCorrupt: 'throw',
    }) as ImportResult['proposed_projects'],
    proposed_tasks: parseJsonColumn(row.tasks_json, {
      onCorrupt: 'throw',
    }) as ImportResult['proposed_tasks'],
    proposed_reminders: parseJsonColumn(row.reminders_json, {
      onCorrupt: 'throw',
    }) as ImportResult['proposed_reminders'],
    voice_signals: parseJsonColumn(row.voice_signals_json, {
      onCorrupt: 'throw',
    }) as ImportResult['voice_signals'],
    facts: parseJsonColumn(row.facts_json, { onCorrupt: 'throw' }) as ImportResult['facts'],
  }
  // Corrupt-policy (legacy inference fields): silent skip — a malformed
  // column on a legacy row leaves the optional field unset (fallback → null
  // fails the Array.isArray guard, exactly as the old catch did).
  const interests = parseJsonColumn(row.inferred_interests_json, {
    onCorrupt: 'fallback',
    fallback: null,
  })
  if (Array.isArray(interests) && interests.length > 0) {
    result.inferred_interests = interests as NonNullable<ImportResult['inferred_interests']>
  }
  const confidence = parseJsonColumn(row.confidence_by_inference_json, {
    onCorrupt: 'fallback',
    fallback: null,
  })
  if (Array.isArray(confidence) && confidence.length > 0) {
    result.confidence_by_inference =
      confidence as NonNullable<ImportResult['confidence_by_inference']>
  }
  if (typeof row.conversation_count === 'number' && row.conversation_count > 0) {
    ;(result as ImportResult & { conversation_count?: number }).conversation_count =
      row.conversation_count
  }
  if (typeof row.synthesizer_model === 'string' && row.synthesizer_model.length > 0) {
    result.synthesizer_model = row.synthesizer_model
  }
  return { result, partial: row.partial === 1 }
}
