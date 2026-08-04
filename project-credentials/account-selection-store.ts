/**
 * @neutronai/project-credentials — the per-project CONNECTED-ACCOUNT SELECTION
 * store (ISSUES #500).
 *
 * Sibling of `store.ts`, and deliberately NOT part of it: that store holds
 * encrypted credential MATERIAL, this one holds a preference about material
 * that lives elsewhere (the Google OAuth grants). Connecting stays global — one
 * consent, one refresh token, one thing to rotate — and only SELECTION is
 * per-project.
 *
 * ── UNSET MEANS ENABLED ─────────────────────────────────────────────────────
 * Rows are DISABLES. A row `(owner, project, service, account)` means "this
 * project does not read that account"; the absence of a row means it does. That
 * is not a storage detail, it is the whole contract:
 *
 *   * a project that has never been configured has no rows → sees EVERY
 *     account, which is exactly today's behaviour, so shipping this changes
 *     nothing until the owner narrows something;
 *   * a NEWLY connected account has an `account_id` no existing row can name →
 *     visible in every project, including projects that already narrowed. That
 *     keeps "connect once, works everywhere" true, with narrowing as the
 *     opt-in.
 *
 * An enable-list would need a second "configured yet?" bit to say the first,
 * and would silently hide the second until every project was re-visited.
 *
 * ── Keying ──────────────────────────────────────────────────────────────────
 * `owner_slug` is the SERVER-derived instance handle (branded `OwnerHandle`),
 * bound from the bearer by the HTTP surface and never client-supplied, so a
 * selection can only ever scope WITHIN one owner. `project_id` is the REAL
 * project id; '' (the General topic / cron / system frame) is rejected by the
 * store AND by a CHECK in `migrations/0115_project_account_selection.sql`, so
 * the no-project frame can never inherit a narrowing.
 *
 * No secret material passes through this module.
 */

import type { ProjectDb, OwnerHandle } from '@neutronai/persistence/index.ts'

/** Mirrors `store.ts` — defensive caps on the free-text key columns. */
const MAX_SERVICE_LEN = 128
const MAX_PROJECT_ID_LEN = 128
const MAX_ACCOUNT_ID_LEN = 256

/** One disabled account, as the Settings surface reads it back. */
export interface DisabledAccountRecord {
  project_id: string
  service: string
  account_id: string
  disabled_at: string
}

/** Store validation error → HTTP 400 at the surface (mirrors the credential store). */
export class AccountSelectionValidationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AccountSelectionValidationError'
    this.code = code
  }
}

export interface ProjectAccountSelectionStoreOptions {
  now?: () => string
}

interface SelectionRow {
  project_id: string
  service: string
  account_id: string
  disabled_at: string
}

interface AccountIdRow {
  account_id: string
}

function requireNonEmpty(code: string, field: string, raw: unknown, max: number): string {
  if (typeof raw !== 'string') {
    throw new AccountSelectionValidationError(code, `${field} must be a string`)
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new AccountSelectionValidationError(code, `${field} must be 1-${max} chars`)
  }
  return trimmed
}

export class ProjectAccountSelectionStore {
  private readonly db: ProjectDb
  private readonly now: () => string

  constructor(db: ProjectDb, opts: ProjectAccountSelectionStoreOptions = {}) {
    this.db = db
    this.now = opts.now ?? ((): string => new Date().toISOString())
  }

  /**
   * The account ids this project has turned OFF for `service`. The resolver's
   * hot path: a set-membership filter, no re-derivation, no per-account query.
   *
   * A blank `project_id` (the General topic / a cron or system dispatch) is not
   * a project and therefore has no selection — it returns an empty set, which
   * filters nothing. That is the same "no frame → global, no regression"
   * posture the active-project context already has.
   */
  disabledAccountIds(
    owner_slug: OwnerHandle,
    project_id: string | undefined,
    service: string,
  ): Set<string> {
    const pid = (project_id ?? '').trim()
    const svc = (service ?? '').trim().toLowerCase()
    if (pid.length === 0 || svc.length === 0) return new Set<string>()
    const rows = this.db
      .prepare<AccountIdRow, [string, string, string]>(
        `SELECT account_id FROM project_account_selection
          WHERE owner_slug = ? AND project_id = ? AND service = ?`,
      )
      .all(owner_slug, pid, svc)
    return new Set(rows.map((r) => r.account_id))
  }

  /** Every disable this project has recorded, for the Settings surface. */
  listForProject(owner_slug: OwnerHandle, project_id: string): DisabledAccountRecord[] {
    const pid = (project_id ?? '').trim()
    if (pid.length === 0) return []
    return this.db
      .prepare<SelectionRow, [string, string]>(
        `SELECT project_id, service, account_id, disabled_at
           FROM project_account_selection
          WHERE owner_slug = ? AND project_id = ?
          ORDER BY service ASC, account_id ASC`,
      )
      .all(owner_slug, pid)
      .map((r) => ({
        project_id: r.project_id,
        service: r.service,
        account_id: r.account_id,
        disabled_at: r.disabled_at,
      }))
  }

  /**
   * Turn one account on or off for one project. `enabled: true` DELETES the
   * disable row (back to the default), `enabled: false` writes one. Idempotent
   * in both directions — the write upserts, the delete tolerates a miss — so a
   * double-tapped toggle can't error or double-count.
   */
  async setEnabled(
    owner_slug: OwnerHandle,
    input: { project_id: string; service: string; account_id: string; enabled: boolean },
  ): Promise<void> {
    const pid = requireNonEmpty(
      'invalid_project_id',
      'project_id',
      input.project_id,
      MAX_PROJECT_ID_LEN,
    )
    const svc = requireNonEmpty('invalid_service', 'service', input.service, MAX_SERVICE_LEN).toLowerCase()
    const account_id = requireNonEmpty(
      'invalid_account_id',
      'account_id',
      input.account_id,
      MAX_ACCOUNT_ID_LEN,
    )
    if (input.enabled) {
      await this.db.run(
        `DELETE FROM project_account_selection
          WHERE owner_slug = ? AND project_id = ? AND service = ? AND account_id = ?`,
        [owner_slug, pid, svc, account_id],
      )
      return
    }
    await this.db.run(
      `INSERT INTO project_account_selection
         (owner_slug, project_id, service, account_id, disabled_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (owner_slug, project_id, service, account_id) DO NOTHING`,
      [owner_slug, pid, svc, account_id, this.now()],
    )
  }
}
