/**
 * @neutronai/cores-runtime — secret audit log + capability-audited store
 * wrapper.
 *
 * Per § D.10.5: every Core-attributed secret operation writes a row to
 * `secret_audit_log`. Direct platform callers (max OAuth, paste tokens,
 * channel metadata, etc.) keep their non-audited path — the audit-write
 * happens at the Cores-runtime composition seam, NOT inside
 * `auth/secrets-store.ts:SecretsStore`.
 *
 * The wrapper is duck-typed against `PlatformSecretsStore` from
 * `@neutronai/cores-sdk`, so the SDK's own `buildSecretsAccessor(...)`
 * (which already capability-gates on the manifest's `secrets[]`) layers
 * cleanly on top: the SDK gates, the runtime audits, the platform
 * decrypts.
 *
 * The audit log ALSO records tool-call capability checks via
 * `recordToolCall(...)` — `op='tool_call'`, `kind='tool'`, `label=<tool_name>`.
 * That single table is enough to power the Argus tail-of-denials UX and
 * the admin "what did this Core ever access?" view.
 */

import { randomUUID } from 'node:crypto'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type {
  PlatformSecretsStore,
  PlatformSecretsStoreListItem,
} from '@neutronai/cores-sdk'

export type SecretAuditOp =
  | 'get'
  | 'put'
  | 'rotate'
  | 'list'
  | 'delete'
  | 'tool_call'

export type SecretAuditOutcome =
  | 'ok'
  | 'capability_denied'
  | 'not_found'
  | 'error'

export interface SecretAuditEntry {
  id: string
  ts: number
  project_slug: string
  core_slug: string
  op: SecretAuditOp
  kind: string
  label: string
  outcome: SecretAuditOutcome
  error: string | null
  /**
   * Multi-author attribution (connect-spec §4.3 layer 3). The uniform author
   * id of the turn that TRIGGERED this Core action — owner = 'owner', each
   * collaborator a stable local_slug. Null for unattributed / pre-B1 rows.
   */
  author_id: string | null
}

export interface SecretAuditLogOptions {
  db: ProjectDb
  now?: () => number
  /**
   * Default triggering author for every row written through this log
   * (connect-spec §4.3 layer 3). In Open every Core action is the owner-native
   * turn, so the gateway constructs the log with `author_id: 'owner'`. A
   * per-call `author_id` (e.g. Connect's per-turn collaborator) overrides it.
   * Absent → unattributed (NULL) unless a per-call author is supplied.
   */
  author_id?: string
}

interface AuditRow {
  id: string
  ts: number
  project_slug: string
  core_slug: string
  op: string
  kind: string
  label: string
  outcome: string
  error: string | null
  author_id: string | null
}

export class SecretAuditLog {
  private readonly db: ProjectDb
  private readonly now: () => number
  private readonly defaultAuthorId: string | null

  constructor(options: SecretAuditLogOptions) {
    this.db = options.db
    this.now = options.now ?? ((): number => Date.now())
    this.defaultAuthorId = options.author_id ?? null
  }

  async record(input: {
    project_slug: string
    core_slug: string
    op: SecretAuditOp
    kind: string
    label: string
    outcome: SecretAuditOutcome
    error?: string
    /** Per-call triggering author; overrides the log's default (§4.3 layer 3). */
    author_id?: string
  }): Promise<void> {
    const id = randomUUID()
    await this.db.run(
      `INSERT INTO secret_audit_log
         (id, ts, project_slug, core_slug, op, kind, label, outcome, error, author_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        this.now(),
        input.project_slug,
        input.core_slug,
        input.op,
        input.kind,
        input.label,
        input.outcome,
        input.error ?? null,
        input.author_id ?? this.defaultAuthorId,
      ],
    )
  }

  async recordToolCall(input: {
    project_slug: string
    core_slug: string
    tool_name: string
    outcome: SecretAuditOutcome
    error?: string
    /** Per-call triggering author; overrides the log's default (§4.3 layer 3). */
    author_id?: string
  }): Promise<void> {
    await this.record({
      project_slug: input.project_slug,
      core_slug: input.core_slug,
      op: 'tool_call',
      kind: 'tool',
      label: input.tool_name,
      outcome: input.outcome,
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.author_id !== undefined ? { author_id: input.author_id } : {}),
    })
  }

  /** Read the recent audit tail for a project + Core. Most-recent first. */
  async list(input: {
    project_slug: string
    core_slug?: string
    limit?: number
  }): Promise<SecretAuditEntry[]> {
    const limit = input.limit ?? 100
    const rows: AuditRow[] = input.core_slug === undefined
      ? this.db
          .all<AuditRow, [string, number]>(
            `SELECT id, ts, project_slug, core_slug, op, kind, label, outcome, error, author_id
               FROM secret_audit_log WHERE project_slug = ?
               ORDER BY ts DESC LIMIT ?`,
            [input.project_slug, limit],
          )
      : this.db
          .all<AuditRow, [string, string, number]>(
            `SELECT id, ts, project_slug, core_slug, op, kind, label, outcome, error, author_id
               FROM secret_audit_log WHERE project_slug = ? AND core_slug = ?
               ORDER BY ts DESC LIMIT ?`,
            [input.project_slug, input.core_slug, limit],
          )
    return rows.map(rowToEntry)
  }

  async listDenied(input: {
    project_slug: string
    core_slug?: string
    limit?: number
  }): Promise<SecretAuditEntry[]> {
    const limit = input.limit ?? 100
    const rows: AuditRow[] = input.core_slug === undefined
      ? this.db
          .all<AuditRow, [string, number]>(
            `SELECT id, ts, project_slug, core_slug, op, kind, label, outcome, error, author_id
               FROM secret_audit_log WHERE project_slug = ? AND outcome = 'capability_denied'
               ORDER BY ts DESC LIMIT ?`,
            [input.project_slug, limit],
          )
      : this.db
          .all<AuditRow, [string, string, number]>(
            `SELECT id, ts, project_slug, core_slug, op, kind, label, outcome, error, author_id
               FROM secret_audit_log WHERE project_slug = ? AND core_slug = ? AND outcome = 'capability_denied'
               ORDER BY ts DESC LIMIT ?`,
            [input.project_slug, input.core_slug, limit],
          )
    return rows.map(rowToEntry)
  }
}

function rowToEntry(row: AuditRow): SecretAuditEntry {
  if (
    row.op !== 'get' && row.op !== 'put' && row.op !== 'rotate' &&
    row.op !== 'list' && row.op !== 'delete' && row.op !== 'tool_call'
  ) {
    throw new Error(`secret_audit_log row has invalid op=${row.op}`)
  }
  if (
    row.outcome !== 'ok' && row.outcome !== 'capability_denied' &&
    row.outcome !== 'not_found' && row.outcome !== 'error'
  ) {
    throw new Error(`secret_audit_log row has invalid outcome=${row.outcome}`)
  }
  return {
    id: row.id,
    ts: row.ts,
    project_slug: row.project_slug,
    core_slug: row.core_slug,
    op: row.op,
    kind: row.kind,
    label: row.label,
    outcome: row.outcome,
    error: row.error,
    author_id: row.author_id,
  }
}

/**
 * Wrap a `PlatformSecretsStore` so every get/put/rotate/list/delete call
 * (in the context of one project + Core) writes a `secret_audit_log` row.
 *
 * The wrapper layers UNDER the SDK's `buildSecretsAccessor(...)`:
 *
 *   gateway → SecretsAccessor (capability gate against manifest.secrets[])
 *           → buildAuditedSecretsStore (audit row writer)
 *           → platform SecretsStore (AES envelope + DB row)
 *
 * That order matters: the SDK rejects undeclared `(kind, label)` BEFORE
 * the wrapper is ever called, so the audit log only sees calls that
 * passed the manifest gate. Capability-denials at the SDK layer get
 * audited via the explicit `record(...)` call from the lifecycle module
 * (and capability-guard for tool calls).
 *
 * We forward the underlying store's return values verbatim — no shape
 * change — so the SDK + the platform see one another exactly as they
 * did before the wrapper was inserted.
 */
export function buildAuditedSecretsStore(
  store: PlatformSecretsStore,
  options: {
    audit: SecretAuditLog
    project_slug: string
    core_slug: string
  },
): PlatformSecretsStore {
  const { audit, project_slug, core_slug } = options
  const wrapper: PlatformSecretsStore = {
    async get(input: { owner_handle: string; kind: string; label: string }): Promise<string | null> {
      try {
        const got = await store.get(input)
        await audit.record({
          project_slug,
          core_slug,
          op: 'get',
          kind: input.kind,
          label: input.label,
          outcome: got === null ? 'not_found' : 'ok',
        })
        return got
      } catch (err) {
        await audit.record({
          project_slug,
          core_slug,
          op: 'get',
          kind: input.kind,
          label: input.label,
          outcome: 'error',
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
    async put(input: {
      owner_handle: string
      kind: string
      label: string
      plaintext: string
      expires_at?: number
    }): Promise<{ id: string } | void> {
      try {
        const r = await store.put(input)
        await audit.record({
          project_slug,
          core_slug,
          op: 'put',
          kind: input.kind,
          label: input.label,
          outcome: 'ok',
        })
        return r
      } catch (err) {
        await audit.record({
          project_slug,
          core_slug,
          op: 'put',
          kind: input.kind,
          label: input.label,
          outcome: 'error',
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
    async list(input: {
      owner_handle: string
      kind?: string
    }): Promise<Array<PlatformSecretsStoreListItem>> {
      try {
        const r = await store.list(input)
        await audit.record({
          project_slug,
          core_slug,
          op: 'list',
          kind: input.kind ?? '*',
          label: '*',
          outcome: 'ok',
        })
        return r
      } catch (err) {
        await audit.record({
          project_slug,
          core_slug,
          op: 'list',
          kind: input.kind ?? '*',
          label: '*',
          outcome: 'error',
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
  }
  if (typeof store.rotate === 'function') {
    const innerRotate = store.rotate.bind(store)
    wrapper.rotate = async (
      id: string,
      new_plaintext: string,
      rotateOptions?: { expires_at?: number },
    ): Promise<void> => {
      try {
        await innerRotate(id, new_plaintext, rotateOptions)
        await audit.record({
          project_slug,
          core_slug,
          op: 'rotate',
          // We don't know (kind, label) without an extra read; record the
          // opaque secret id as the label. Lifecycle / SDK callers that
          // know the (kind, label) can pre-record a more specific row.
          kind: 'rotate',
          label: id,
          outcome: 'ok',
        })
      } catch (err) {
        await audit.record({
          project_slug,
          core_slug,
          op: 'rotate',
          kind: 'rotate',
          label: id,
          outcome: 'error',
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    }
  }
  return wrapper
}
