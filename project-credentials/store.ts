/**
 * @neutronai/project-credentials — the per-project credential STORE + RESOLVER.
 *
 * A credential is a static, long-lived service token (Meta Ads, Google Ads, an
 * Apify key, …) the owner pastes into a project's Settings. It can be set at:
 *
 *   - PER-PROJECT scope  — applies only inside one project (the default).
 *   - GLOBAL scope       — applies instance-wide as the fallback default.
 *
 * Resolution is **per-project → global → unset** (`resolve`): a project's own
 * token wins; else the global token; else the service is uncredentialed. A
 * single-owner install that only sets global tokens keeps working unchanged.
 *
 * ── Keying (the owner + per-project axes) ──────────────────────────────────
 * Every row carries `owner_slug` (the SERVER-derived instance handle — the
 * bearer's `project_slug`, the owner boundary) AND `project_id` (the REAL
 * per-project id, '' for global). `owner_slug` is ALWAYS bound from the auth
 * token by the HTTP surface, never client-supplied — so the per-project
 * dimension can only ever scope WITHIN one owner, and no caller can read
 * another owner's credentials. This is the deliberate difference from the Work
 * Board (which keys purely on the instance slug and ignores the URL project id):
 * credentials are genuinely per-project, so the real project id is part of the
 * key, gated underneath the server-derived owner boundary.
 *
 * ── Crypto ──────────────────────────────────────────────────────────────────
 * Ciphertext is the SAME AES-256-GCM envelope the `secrets` store uses; the
 * store takes a `SecretCrypto` (satisfied structurally by `SecretsStore` via
 * its `encryptPlaintext` / `decryptEnvelope` methods), so both stores share the
 * one `.neutron-aes-key` keyfile. Plaintext tokens never touch the DB; `list`
 * returns METADATA ONLY (never ciphertext or plaintext).
 *
 * ── RESERVED NAMESPACES: THIS TABLE HOSTS ANOTHER MODULE'S SECRETS ───────────
 * One namespace in the `service` column is not a credential the owner authors
 * here. `gateway/mcp-servers/store.ts` keeps each installed MCP server's env
 * VALUES as a JSON blob under `mcp_env.<server>`, because that store wanted this
 * table's AES envelope rather than a fourth one — see
 * {@link RESERVED_SERVICE_PREFIXES}.
 *
 * That made the generic CRUD a SECOND WRITER on a security-critical fact. The
 * charset `sanitizeService` accepts includes `.`, so `mcp_env.example-server`
 * was a perfectly legal service name, and `POST /api/app/credentials` +
 * `DELETE /api/app/credentials/mcp_env.<name>` reached it. Both skipped every
 * invariant the MCP store enforces around that row: its own validation of what
 * a value may be, and — the one that matters — the `onRevoked` announcement that
 * retires the warm `claude` child still holding the OLD secret in its
 * environment. A generic overwrite therefore rotated a secret while leaving the
 * process that holds the previous one alive and unreaped, which is the exact
 * hazard `evictWarmReplsForMcpSurfaceChange` exists to close.
 *
 * So the namespace is RESERVED: `set`, `delete` and `resolve` refuse it, and the
 * owning module reaches its rows through the explicit `*Reserved` methods below.
 * The enumerations (`listGlobal`, `listForProject`, `listAvailableServices`) omit
 * reserved rows too — a row the Admin tab can neither overwrite nor delete has no
 * business being rendered there, and the agent's available-services block should
 * not advertise an MCP server's secret blob as an external service it can use.
 */

import type { ProjectDb, OwnerHandle } from '@neutronai/persistence/index.ts'

/** '' is the global-scope sentinel — a real project id is always 1..128 chars. */
export const GLOBAL_PROJECT_ID = ''

/** Max lengths, mirroring the Work Board store's defensive caps. */
const MAX_SERVICE_LEN = 128
const MAX_LABEL_LEN = 256
/**
 * Longest stored plaintext. EXPORTED because a caller that composes a token out of
 * several owner-supplied pieces has to refuse an oversized payload at ITS boundary,
 * where the owner is present and can be told which value to shorten — reaching this
 * cap instead produces a thrown error from an encrypted write, with nothing useful to
 * say. `runtime/mcp-servers.ts` declares its own lower limit and a test pins the
 * ordering against this one.
 */
export const MAX_TOKEN_LEN = 8192

/**
 * Service-name prefixes this table hosts on ANOTHER module's behalf, which the
 * generic owner-facing CRUD must not reach. See § RESERVED NAMESPACES in the
 * module header for the hole this closes.
 *
 * A PREFIX, not an exact name, because the owning module mints one row per
 * installed server (`mcp_env.<server>`) and the set is therefore open-ended. The
 * trailing dot is load-bearing: it keeps the reservation to the namespace and
 * leaves a plain service literally called `mcp_envelope` writable.
 */
export const RESERVED_SERVICE_PREFIXES: ReadonlyArray<string> = ['mcp_env.']

/**
 * Whether `service` belongs to a reserved namespace. Compares the SANITIZED form
 * (trimmed + lowercased) so `MCP_ENV.foo` from a URL path segment cannot walk in
 * past a case-sensitive check — every caller here lowercases first, and this
 * function does it again rather than trusting that it happened.
 */
export function isReservedService(service: string): boolean {
  const svc = service.trim().toLowerCase()
  return RESERVED_SERVICE_PREFIXES.some((prefix) => svc.startsWith(prefix))
}

export type CredentialScope = 'project' | 'global'

/**
 * The AES crypto surface the store needs. `SecretsStore` satisfies this
 * structurally (`encryptPlaintext` / `decryptEnvelope`), so production shares
 * the one keyfile; tests can pass a trivial fake.
 */
export interface SecretCrypto {
  encryptPlaintext(plaintext: string): string
  decryptEnvelope(envelope: string): string
}

/** A credential's METADATA — never carries ciphertext or plaintext. */
export interface ProjectCredentialRecord {
  id: string
  owner_slug: string
  /** '' for a global-scope credential. */
  project_id: string
  scope: CredentialScope
  service: string
  label: string | null
  created_at: string
  updated_at: string
  expires_at: string | null
}

/** Input to `set` — the owner_slug is passed separately (server-derived). */
export interface SetCredentialInput {
  service: string
  plaintext: string
  scope: CredentialScope
  /** The real project id for scope='project'; ignored for scope='global'. */
  project_id?: string
  label?: string | null
  expires_at?: string | null
}

/** A resolved credential — the decrypted token plus which scope supplied it. */
export interface ResolvedCredential {
  plaintext: string
  scope: CredentialScope
  service: string
}

/** One entry in the per-project available-services view (no secret material). */
export interface AvailableService {
  service: string
  /** Whether the resolved token came from the project or the global default. */
  scope: CredentialScope
}

/** Store validation error → HTTP 400 at the surface (mirrors WorkBoardValidationError). */
export class ProjectCredentialValidationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProjectCredentialValidationError'
    this.code = code
  }
}

export interface ProjectCredentialStoreOptions {
  crypto: SecretCrypto
  now?: () => string
  ulid?: () => string
}

interface CredentialDbRow {
  id: string
  owner_slug: string
  project_id: string
  scope: CredentialScope
  service: string
  ciphertext: string
  label: string | null
  created_at: string
  updated_at: string
  expires_at: string | null
}

/** The metadata columns (everything EXCEPT ciphertext). */
const META_COLS =
  'id, owner_slug, project_id, scope, service, label, created_at, updated_at, expires_at'

/**
 * 48-bit timestamp + 80 random bits, Crockford base32 (sortable). Mirrors the
 * work_board / notes / comments stores; there is no `ulid` package in the repo.
 */
function defaultUlid(): string {
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let id = ''
  let ts = Date.now()
  for (let i = 9; i >= 0; i--) {
    id = ENCODING[ts % 32] + id
    ts = Math.floor(ts / 32)
  }
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  let bits = 0n
  for (const b of bytes) bits = (bits << 8n) | BigInt(b)
  let rand = ''
  for (let i = 0; i < 16; i++) {
    rand = ENCODING[Number(bits & 31n)] + rand
    bits >>= 5n
  }
  return id + rand
}

/** Normalize + validate a service key: lowercased slug, `[a-z0-9_.-]`. */
function sanitizeService(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ProjectCredentialValidationError('invalid_service', 'service must be a string')
  }
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > MAX_SERVICE_LEN) {
    throw new ProjectCredentialValidationError(
      'invalid_service',
      `service must be 1-${MAX_SERVICE_LEN} chars`,
    )
  }
  if (!/^[a-z0-9_.-]+$/.test(trimmed)) {
    throw new ProjectCredentialValidationError(
      'invalid_service',
      'service must be lowercase [a-z0-9_.-]',
    )
  }
  return trimmed
}

/** Validate a non-empty token within the length cap. */
function sanitizeToken(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ProjectCredentialValidationError('invalid_token', 'token must be a non-empty string')
  }
  if (raw.length > MAX_TOKEN_LEN) {
    throw new ProjectCredentialValidationError(
      'invalid_token',
      `token must be <= ${MAX_TOKEN_LEN} chars`,
    )
  }
  return raw
}

/** Optional label → trimmed string or null. */
function sanitizeLabel(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') {
    throw new ProjectCredentialValidationError('invalid_label', 'label must be a string')
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > MAX_LABEL_LEN) {
    throw new ProjectCredentialValidationError(
      'invalid_label',
      `label must be <= ${MAX_LABEL_LEN} chars`,
    )
  }
  return trimmed
}

/** Optional ISO-8601 expiry → the string or null. */
function sanitizeExpiresAt(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
    throw new ProjectCredentialValidationError(
      'invalid_expires_at',
      'expires_at must be an ISO-8601 timestamp',
    )
  }
  return raw
}

/** For scope='project' the caller MUST supply a real (non-empty) project id. */
function resolveScopeProjectId(scope: CredentialScope, project_id: string | undefined): string {
  if (scope === 'global') return GLOBAL_PROJECT_ID
  const pid = (project_id ?? '').trim()
  if (pid.length === 0) {
    throw new ProjectCredentialValidationError(
      'invalid_project_id',
      "a project-scoped credential requires a non-empty project_id",
    )
  }
  return pid
}

export class ProjectCredentialStore {
  private readonly db: ProjectDb
  private readonly crypto: SecretCrypto
  private readonly now: () => string
  private readonly ulid: () => string

  constructor(db: ProjectDb, opts: ProjectCredentialStoreOptions) {
    this.db = db
    this.crypto = opts.crypto
    this.now = opts.now ?? ((): string => new Date().toISOString())
    this.ulid = opts.ulid ?? defaultUlid
  }

  /**
   * Set (create or overwrite) a credential. Upserts on the
   * (owner_slug, project_id, service) unique key so a re-set replaces the token
   * in place and preserves `created_at`. Returns metadata only.
   *
   * REFUSES A RESERVED NAMESPACE — see § RESERVED NAMESPACES in the module header.
   * A `mcp_env.*` row is an installed MCP server's secret, and writing one from
   * here rotates it without retiring the child that holds the old value.
   */
  async set(owner_slug: OwnerHandle, input: SetCredentialInput): Promise<ProjectCredentialRecord> {
    if (isReservedService(typeof input.service === 'string' ? input.service : '')) {
      throw new ProjectCredentialValidationError(
        'reserved_service',
        `service '${RESERVED_SERVICE_PREFIXES[0]}*' is managed by its own settings surface and cannot be set here`,
      )
    }
    return this.setUnchecked(owner_slug, input)
  }

  /**
   * {@link set} for the module that OWNS a reserved namespace.
   *
   * A separate method rather than an options flag, so the privileged path is
   * greppable: every write into `mcp_env.*` is one call site in
   * `gateway/mcp-servers/store.ts`, and a new caller has to name this method to
   * become a second writer — which is the review that the flag version would not
   * have prompted.
   */
  async setReserved(
    owner_slug: OwnerHandle,
    input: SetCredentialInput,
  ): Promise<ProjectCredentialRecord> {
    return this.setUnchecked(owner_slug, input)
  }

  private async setUnchecked(
    owner_slug: OwnerHandle,
    input: SetCredentialInput,
  ): Promise<ProjectCredentialRecord> {
    if (input.scope !== 'project' && input.scope !== 'global') {
      throw new ProjectCredentialValidationError('invalid_scope', "scope must be 'project' or 'global'")
    }
    const service = sanitizeService(input.service)
    const plaintext = sanitizeToken(input.plaintext)
    const label = sanitizeLabel(input.label)
    const expires_at = sanitizeExpiresAt(input.expires_at)
    const project_id = resolveScopeProjectId(input.scope, input.project_id)
    const ciphertext = this.crypto.encryptPlaintext(plaintext)
    const now = this.now()
    const id = this.ulid()

    // Upsert: on the unique key, overwrite the ciphertext/label/expiry and bump
    // updated_at, keeping the original id + created_at.
    await this.db.run(
      `INSERT INTO project_credentials
         (id, owner_slug, project_id, scope, service, ciphertext, label, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_slug, project_id, service) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         label      = excluded.label,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
      [id, owner_slug, project_id, input.scope, service, ciphertext, label, now, now, expires_at],
    )
    const rec = this.getMeta(owner_slug, project_id, service)
    if (rec === null) {
      // Should never happen — we just wrote it.
      throw new ProjectCredentialValidationError('write_failed', 'credential write did not persist')
    }
    return rec
  }

  /**
   * List a project's OWN (scope='project') credentials — metadata only.
   *
   * OMITS RESERVED NAMESPACES, so the Settings list only ever shows rows this
   * surface can actually author. See § RESERVED NAMESPACES.
   */
  listForProject(owner_slug: OwnerHandle, project_id: string): ProjectCredentialRecord[] {
    const rows = this.db
      .prepare<CredentialDbRow, [string, string]>(
        `SELECT ${META_COLS} FROM project_credentials
          WHERE owner_slug = ? AND scope = 'project' AND project_id = ?
          ORDER BY service ASC`,
      )
      .all(owner_slug, project_id)
    return rows.filter((r) => !isReservedService(r.service)).map((r) => this.rowToRecord(r))
  }

  /**
   * List the GLOBAL (instance-wide default) credentials — metadata only.
   *
   * OMITS RESERVED NAMESPACES. This is the enumeration the Admin tab renders, and
   * `mcp_env.*` rows all live at global scope — so without the filter the owner saw
   * one row per installed MCP server next to his real credentials, with a Delete
   * button that now (correctly) refuses. See § RESERVED NAMESPACES.
   */
  listGlobal(owner_slug: OwnerHandle): ProjectCredentialRecord[] {
    const rows = this.db
      .prepare<CredentialDbRow, [string]>(
        `SELECT ${META_COLS} FROM project_credentials
          WHERE owner_slug = ? AND scope = 'global'
          ORDER BY service ASC`,
      )
      .all(owner_slug)
    return rows.filter((r) => !isReservedService(r.service)).map((r) => this.rowToRecord(r))
  }

  /** A single credential's metadata by exact key, or null. */
  getMeta(owner_slug: OwnerHandle, project_id: string, service: string): ProjectCredentialRecord | null {
    const row = this.db
      .prepare<CredentialDbRow, [string, string, string]>(
        `SELECT ${META_COLS} FROM project_credentials
          WHERE owner_slug = ? AND project_id = ? AND service = ?`,
      )
      .get(owner_slug, project_id, service)
    return row === null ? null : this.rowToRecord(row)
  }

  /**
   * THE RESOLVER — per-project → global → unset. Returns the decrypted token
   * and which scope supplied it, or null when the service is uncredentialed
   * for this project (and has no global default). Expired rows resolve as
   * unset. When `project_id` is '' / undefined (e.g. the General topic), only
   * the global default is consulted.
   *
   * A RESERVED NAMESPACE RESOLVES AS UNSET, rather than throwing. No caller in
   * this build resolves an owner-supplied service name — every one passes a
   * module constant — so this closes the READ direction against a future caller
   * that does, and it does so in the direction that cannot break a hot path: an
   * unset service is a state every consumer already handles, whereas a throw from
   * the resolver would be a new failure mode on the turn path. `resolveReserved`
   * is the owning module's read. See § RESERVED NAMESPACES.
   */
  resolve(owner_slug: OwnerHandle, project_id: string | undefined, service: string): ResolvedCredential | null {
    if (isReservedService(service)) return null
    return this.resolveUnchecked(owner_slug, project_id, service)
  }

  /** {@link resolve} for the module that owns a reserved namespace — see {@link setReserved}. */
  resolveReserved(
    owner_slug: OwnerHandle,
    project_id: string | undefined,
    service: string,
  ): ResolvedCredential | null {
    return this.resolveUnchecked(owner_slug, project_id, service)
  }

  private resolveUnchecked(
    owner_slug: OwnerHandle,
    project_id: string | undefined,
    service: string,
  ): ResolvedCredential | null {
    const svc = service.trim().toLowerCase()
    const pid = (project_id ?? '').trim()
    // 1. per-project override (only when we have a real project id)
    if (pid.length > 0) {
      const projRow = this.getRow(owner_slug, pid, svc)
      if (projRow !== null && !this.isExpired(projRow)) {
        return { plaintext: this.crypto.decryptEnvelope(projRow.ciphertext), scope: 'project', service: svc }
      }
    }
    // 2. global default
    const globalRow = this.getRow(owner_slug, GLOBAL_PROJECT_ID, svc)
    if (globalRow !== null && !this.isExpired(globalRow)) {
      return { plaintext: this.crypto.decryptEnvelope(globalRow.ciphertext), scope: 'global', service: svc }
    }
    // 3. unset
    return null
  }

  /**
   * The per-project available-services view (no secret material): every
   * service that resolves for this project, project scope winning over global.
   * Drives the agent's "services available in this project" awareness block.
   */
  listAvailableServices(owner_slug: OwnerHandle, project_id: string | undefined): AvailableService[] {
    const byService = new Map<string, CredentialScope>()
    // Global defaults first, project overrides second (so project wins).
    for (const g of this.listGlobal(owner_slug)) {
      if (!this.isExpiredRecord(g)) byService.set(g.service, 'global')
    }
    const pid = (project_id ?? '').trim()
    if (pid.length > 0) {
      for (const p of this.listForProject(owner_slug, pid)) {
        if (!this.isExpiredRecord(p)) byService.set(p.service, 'project')
      }
    }
    return [...byService.entries()]
      .map(([service, scope]) => ({ service, scope }))
      .sort((a, b) => a.service.localeCompare(b.service))
  }

  /**
   * Delete a credential by exact key. Returns true when a row was removed,
   * false when nothing matched (so the surface can 404). `project_id` is ''
   * for a global-scope delete.
   *
   * REFUSES A RESERVED NAMESPACE, and this direction is the worse of the two: a
   * generic delete of `mcp_env.<name>` leaves the server INSTALLED and APPROVED
   * with its secret gone, and leaves the warm child that still holds the value
   * running — no `onRevoked`, nothing evicted. See § RESERVED NAMESPACES.
   */
  async delete(owner_slug: OwnerHandle, project_id: string, service: string): Promise<boolean> {
    if (isReservedService(service)) {
      throw new ProjectCredentialValidationError(
        'reserved_service',
        `service '${RESERVED_SERVICE_PREFIXES[0]}*' is managed by its own settings surface and cannot be deleted here`,
      )
    }
    return this.deleteUnchecked(owner_slug, project_id, service)
  }

  /** {@link delete} for the module that owns a reserved namespace — see {@link setReserved}. */
  async deleteReserved(
    owner_slug: OwnerHandle,
    project_id: string,
    service: string,
  ): Promise<boolean> {
    return this.deleteUnchecked(owner_slug, project_id, service)
  }

  private async deleteUnchecked(
    owner_slug: OwnerHandle,
    project_id: string,
    service: string,
  ): Promise<boolean> {
    const svc = service.trim().toLowerCase()
    const existing = this.getRow(owner_slug, project_id, svc)
    if (existing === null) return false
    await this.db.run(
      `DELETE FROM project_credentials WHERE owner_slug = ? AND project_id = ? AND service = ?`,
      [owner_slug, project_id, svc],
    )
    return true
  }

  // ── internals ──────────────────────────────────────────────────────────

  private getRow(owner_slug: OwnerHandle, project_id: string, service: string): CredentialDbRow | null {
    return this.db
      .prepare<CredentialDbRow, [string, string, string]>(
        `SELECT id, owner_slug, project_id, scope, service, ciphertext, label, created_at, updated_at, expires_at
           FROM project_credentials
          WHERE owner_slug = ? AND project_id = ? AND service = ?`,
      )
      .get(owner_slug, project_id, service)
  }

  private isExpired(row: CredentialDbRow): boolean {
    return row.expires_at !== null && Date.parse(row.expires_at) <= Date.parse(this.now())
  }

  private isExpiredRecord(rec: ProjectCredentialRecord): boolean {
    return rec.expires_at !== null && Date.parse(rec.expires_at) <= Date.parse(this.now())
  }

  private rowToRecord(row: CredentialDbRow): ProjectCredentialRecord {
    return {
      id: row.id,
      owner_slug: row.owner_slug,
      project_id: row.project_id,
      scope: row.scope,
      service: row.service,
      label: row.label,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at,
    }
  }
}
