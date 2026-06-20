/**
 * @neutronai/cores-runtime — `core_installations` CRUD.
 *
 * Single source of truth for which Cores are installed in a project, what
 * version, what data layout, and the lifecycle timestamps. Schema lives
 * in `migrations/0021_p3_cores_runtime.sql`.
 *
 * The lifecycle module composes this store with the loader, namespace
 * allocator, and audit log to drive install / uninstall / upgrade.
 */

import { randomUUID } from 'node:crypto'
import type { ProjectDb } from '../../persistence/index.ts'

export type CoreDataLayout = 'tables' | 'sidecar'

export interface CoreInstallationRecord {
  project_slug: string
  core_slug: string
  package_name: string
  package_version: string
  /** JSON-decoded array of capability strings. */
  capabilities: string[]
  data_layout: CoreDataLayout
  /** Absolute path; populated only when data_layout='sidecar'. */
  sidecar_db_path: string | null
  installed_at: number
  configured_at: number | null
  started_at: number | null
  stopped_at: number | null
  uninstalled_at: number | null
}

export interface RecordInstallInput {
  project_slug: string
  core_slug: string
  package_name: string
  package_version: string
  capabilities: string[]
  data_layout: CoreDataLayout
  sidecar_db_path?: string
}

export interface UpdateVersionInput {
  project_slug: string
  core_slug: string
  package_version: string
  capabilities: string[]
}

interface CoreInstallationRow {
  project_slug: string
  core_slug: string
  package_name: string
  package_version: string
  manifest_capabilities_json: string
  data_layout: string
  sidecar_db_path: string | null
  installed_at: number
  configured_at: number | null
  started_at: number | null
  stopped_at: number | null
  uninstalled_at: number | null
}

export interface InstallationsStoreOptions {
  db: ProjectDb
  now?: () => number
}

export class CoreInstallationsStore {
  private readonly db: ProjectDb
  private readonly now: () => number

  constructor(options: InstallationsStoreOptions) {
    this.db = options.db
    this.now = options.now ?? ((): number => Date.now())
  }

  async record(input: RecordInstallInput): Promise<CoreInstallationRecord> {
    if (input.data_layout === 'sidecar' && (input.sidecar_db_path === undefined || input.sidecar_db_path === null)) {
      throw new Error(
        `core_installations.record: data_layout='sidecar' requires sidecar_db_path (project=${input.project_slug} core=${input.core_slug})`,
      )
    }
    if (input.data_layout === 'tables' && input.sidecar_db_path !== undefined) {
      throw new Error(
        `core_installations.record: data_layout='tables' must NOT supply sidecar_db_path (project=${input.project_slug} core=${input.core_slug})`,
      )
    }
    const ts = this.now()
    const capabilities_json = JSON.stringify(input.capabilities)
    // Upsert: re-installing after an uninstall reuses the (project,core) PK.
    // We write the new install timestamp and clear lifecycle markers.
    await this.db.run(
      `INSERT INTO core_installations
         (project_slug, core_slug, package_name, package_version,
          manifest_capabilities_json, data_layout, sidecar_db_path,
          installed_at, configured_at, started_at, stopped_at, uninstalled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
       ON CONFLICT(project_slug, core_slug) DO UPDATE SET
         package_name = excluded.package_name,
         package_version = excluded.package_version,
         manifest_capabilities_json = excluded.manifest_capabilities_json,
         data_layout = excluded.data_layout,
         sidecar_db_path = excluded.sidecar_db_path,
         installed_at = excluded.installed_at,
         configured_at = NULL,
         started_at = NULL,
         stopped_at = NULL,
         uninstalled_at = NULL`,
      [
        input.project_slug,
        input.core_slug,
        input.package_name,
        input.package_version,
        capabilities_json,
        input.data_layout,
        input.sidecar_db_path ?? null,
        ts,
      ],
    )
    const got = await this.get(input.project_slug, input.core_slug)
    if (got === null) {
      // Defensive — the row we just inserted should always read back.
      throw new Error(
        `core_installations.record: post-insert read returned null for project=${input.project_slug} core=${input.core_slug}`,
      )
    }
    return got
  }

  async get(project_slug: string, core_slug: string): Promise<CoreInstallationRecord | null> {
    const row = this.db
      .raw()
      .query<CoreInstallationRow, [string, string]>(
        `SELECT project_slug, core_slug, package_name, package_version,
                manifest_capabilities_json, data_layout, sidecar_db_path,
                installed_at, configured_at, started_at, stopped_at, uninstalled_at
           FROM core_installations
          WHERE project_slug = ? AND core_slug = ?`,
      )
      .get(project_slug, core_slug)
    return row === null ? null : rowToRecord(row)
  }

  async listForProject(project_slug: string): Promise<CoreInstallationRecord[]> {
    const rows = this.db
      .raw()
      .query<CoreInstallationRow, [string]>(
        `SELECT project_slug, core_slug, package_name, package_version,
                manifest_capabilities_json, data_layout, sidecar_db_path,
                installed_at, configured_at, started_at, stopped_at, uninstalled_at
           FROM core_installations
          WHERE project_slug = ? ORDER BY installed_at`,
      )
      .all(project_slug)
    return rows.map(rowToRecord)
  }

  async listLive(project_slug: string): Promise<CoreInstallationRecord[]> {
    const all = await this.listForProject(project_slug)
    return all.filter((r) => r.uninstalled_at === null)
  }

  async markConfigured(project_slug: string, core_slug: string): Promise<void> {
    await this.db.run(
      `UPDATE core_installations SET configured_at = ?
        WHERE project_slug = ? AND core_slug = ? AND uninstalled_at IS NULL`,
      [this.now(), project_slug, core_slug],
    )
  }

  async markStarted(project_slug: string, core_slug: string): Promise<void> {
    await this.db.run(
      `UPDATE core_installations SET started_at = ?, stopped_at = NULL
        WHERE project_slug = ? AND core_slug = ? AND uninstalled_at IS NULL`,
      [this.now(), project_slug, core_slug],
    )
  }

  async markStopped(project_slug: string, core_slug: string): Promise<void> {
    await this.db.run(
      `UPDATE core_installations SET stopped_at = ?
        WHERE project_slug = ? AND core_slug = ? AND uninstalled_at IS NULL`,
      [this.now(), project_slug, core_slug],
    )
  }

  async markUninstalled(project_slug: string, core_slug: string): Promise<void> {
    await this.db.run(
      `UPDATE core_installations SET uninstalled_at = ?, stopped_at = COALESCE(stopped_at, ?)
        WHERE project_slug = ? AND core_slug = ?`,
      [this.now(), this.now(), project_slug, core_slug],
    )
  }

  async updateVersion(input: UpdateVersionInput): Promise<void> {
    await this.db.run(
      `UPDATE core_installations
          SET package_version = ?,
              manifest_capabilities_json = ?
        WHERE project_slug = ? AND core_slug = ? AND uninstalled_at IS NULL`,
      [
        input.package_version,
        JSON.stringify(input.capabilities),
        input.project_slug,
        input.core_slug,
      ],
    )
  }
}

function rowToRecord(row: CoreInstallationRow): CoreInstallationRecord {
  let capabilities: string[]
  try {
    const parsed: unknown = JSON.parse(row.manifest_capabilities_json)
    if (!Array.isArray(parsed)) {
      capabilities = []
    } else {
      capabilities = parsed.filter((v): v is string => typeof v === 'string')
    }
  } catch {
    capabilities = []
  }
  if (row.data_layout !== 'tables' && row.data_layout !== 'sidecar') {
    throw new Error(
      `core_installations row has invalid data_layout=${row.data_layout} (project=${row.project_slug} core=${row.core_slug})`,
    )
  }
  return {
    project_slug: row.project_slug,
    core_slug: row.core_slug,
    package_name: row.package_name,
    package_version: row.package_version,
    capabilities,
    data_layout: row.data_layout,
    sidecar_db_path: row.sidecar_db_path,
    installed_at: row.installed_at,
    configured_at: row.configured_at,
    started_at: row.started_at,
    stopped_at: row.stopped_at,
    uninstalled_at: row.uninstalled_at,
  }
}

/** Mint an installation id for callers that need an opaque per-install token (e.g.
 *  audit-log correlation). The store itself is keyed on (project, core); this is
 *  for downstream emitters. */
export function mintInstallEventId(): string {
  return randomUUID()
}
