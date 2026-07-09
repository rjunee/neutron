/**
 * @neutronai/trident — Codex subscription credential SERVICE (Part B).
 *
 * Layers persistence + materialization on top of the pure `codex-auth.ts`
 * validators. It stores the connected subscription bundle in the #149
 * `ProjectCredentialStore` (encrypted AES-256-GCM, same keyfile as every other
 * credential) under the reserved service name `codex`, GLOBAL scope — a ChatGPT
 * subscription is account-wide, not per-project — and MATERIALIZES it to the
 * per-project `CODEX_HOME/auth.json` that `trident/codex-review.sh` reads.
 *
 * One service, three entry points, all reachable from BOTH the admin-panel HTTP
 * surface AND the `codex_connect` / `codex_status` agent tools (agent-native
 * parity):
 *   - `connect(owner_slug, pasted)` — validate → reject metered → store → materialize
 *   - `status(owner_slug)`          — connected / expired / not_connected (read-only)
 *   - `disconnect(owner_slug)`      — delete the credential + remove the auth.json
 *
 * `ensureMaterialized(owner_slug)` is the boot/self-heal hook: if the credential
 * is stored but the file is missing (fresh process, new worktree, wiped tmp),
 * re-write it so the loop's CODEX_HOME is always populated.
 */

import type { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import type { CredentialScope } from '@neutronai/project-credentials/store.ts'
import {
  codexProjectHome,
  deriveCodexStatus,
  materializeCodexAuth,
  readMaterializedAuth,
  removeCodexAuth,
  validateCodexSubscriptionAuth,
  type CodexStatusDetail,
} from './codex-auth.ts'

/** The reserved `project_credentials.service` name for the Codex OAuth bundle. */
export const CODEX_CREDENTIAL_SERVICE = 'codex'

/**
 * Where to store/read the Codex credential. `global` (the DEFAULT) is the
 * instance-wide, trident-wide subscription — the primary place codex is
 * connected (the General admin UI). `project` is an optional per-project
 * OVERRIDE for the edge case where one project needs a different subscription;
 * it wins over the global default for that project (store resolver:
 * project → global → unset).
 */
export interface CodexTarget {
  scope?: CredentialScope
  /** The REAL project id (required for scope='project'; ignored for global). */
  project_id?: string
}

export interface CodexConnectResult {
  ok: boolean
  status?: CodexStatusDetail['status']
  mode?: 'subscription' | 'apikey' | 'unknown'
  /** Which scope the credential was stored at. */
  scope?: CredentialScope
  /** Materialized auth.json path (only on success). */
  path?: string
  code?: string
  error?: string
}

/** Status + which scope supplied the resolved credential (project vs global). */
export interface CodexStatusResult extends CodexStatusDetail {
  /** The scope that supplied the resolved credential, or null when unset. */
  scope: CredentialScope | null
  /** Whether a project-scoped OVERRIDE row exists for the queried project —
   *  INCLUDING an expired one (which the resolver skips, so `scope` would report
   *  the global fallback). Lets the UI always offer to remove a stale override.
   *  Only meaningful when a `project_id` was supplied. */
  override_present?: boolean
}

export interface CodexCredentialServiceDeps {
  store: ProjectCredentialStore
  /** The GLOBAL CODEX_HOME dir (`resolveCodexHome`). Per-project overrides
   *  materialize to `codexProjectHome(codexHome, project_id)` beneath it. */
  codexHome: string
  now?: () => number
}

export class CodexCredentialService {
  private readonly store: ProjectCredentialStore
  private readonly codexHome: string
  private readonly now: () => number

  constructor(deps: CodexCredentialServiceDeps) {
    this.store = deps.store
    this.codexHome = deps.codexHome
    this.now = deps.now ?? Date.now
  }

  /** The CODEX_HOME dir for a given scope/project (global default or override). */
  private homeFor(scope: CredentialScope, project_id: string): string {
    return scope === 'project' ? codexProjectHome(this.codexHome, project_id) : this.codexHome
  }

  private normalizeTarget(target?: CodexTarget): { scope: CredentialScope; project_id: string } {
    const scope: CredentialScope = target?.scope === 'project' ? 'project' : 'global'
    const project_id = scope === 'project' ? (target?.project_id ?? '').trim() : ''
    return { scope, project_id }
  }

  /**
   * Validate + persist + materialize a pasted Codex subscription auth.json.
   * Metered `OPENAI_API_KEY` pastes are rejected here (never stored). Defaults to
   * GLOBAL scope (the trident-wide subscription); pass `{ scope: 'project',
   * project_id }` to store a per-project OVERRIDE. On success the credential is in
   * the store AND written to the scope's `CODEX_HOME/auth.json`, so
   * `codex-review.sh` sees it connected.
   */
  async connect(owner_slug: string, pasted: unknown, target?: CodexTarget): Promise<CodexConnectResult> {
    const { scope, project_id } = this.normalizeTarget(target)
    const v = validateCodexSubscriptionAuth(pasted, this.now)
    if (!v.ok || v.normalized === undefined) {
      return { ok: false, mode: v.mode, ...(v.code !== undefined ? { code: v.code } : {}), ...(v.error !== undefined ? { error: v.error } : {}) }
    }
    await this.store.set(owner_slug, {
      service: CODEX_CREDENTIAL_SERVICE,
      plaintext: v.normalized,
      scope,
      project_id,
      label:
        scope === 'project'
          ? 'ChatGPT subscription (codex review — project override)'
          : 'ChatGPT subscription (codex cross-model review)',
      expires_at: null,
    })
    const { path } = materializeCodexAuth({ codexHome: this.homeFor(scope, project_id), authJson: v.normalized })
    const status = deriveCodexStatus(v.normalized, { materialized: true, now: this.now })
    return { ok: true, mode: 'subscription', status: status.status, scope, path }
  }

  /**
   * Read-only connection status for the admin panel / `codex_status` tool.
   * Resolves project → global → unset (the store resolver): when `project_id` is
   * supplied and that project has an override it reports the override; otherwise
   * the global default. `scope` names which supplied it.
   */
  status(owner_slug: string, target?: CodexTarget): CodexStatusResult {
    const project_id = (target?.project_id ?? '').trim()
    const resolved = this.store.resolve(owner_slug, project_id, CODEX_CREDENTIAL_SERVICE)
    const stored = resolved?.plaintext ?? null
    const scope = resolved?.scope ?? null
    const home = scope === 'project' ? codexProjectHome(this.codexHome, project_id) : this.codexHome
    const materialized = readMaterializedAuth(home) !== null
    // A project-override ROW (expired or not) — so the UI can always remove a
    // stale override even when the resolver has fallen back to the global default.
    const override_present =
      project_id.length > 0 &&
      this.store.getMeta(owner_slug, project_id, CODEX_CREDENTIAL_SERVICE) !== null
    return {
      ...deriveCodexStatus(stored, { materialized, now: this.now }),
      scope,
      ...(project_id.length > 0 ? { override_present } : {}),
    }
  }

  /**
   * Delete the stored credential + remove the materialized auth.json. Defaults to
   * GLOBAL; pass `{ scope: 'project', project_id }` to remove just that project's
   * override (the global default stays). Removing the global default leaves any
   * project overrides intact.
   */
  async disconnect(owner_slug: string, target?: CodexTarget): Promise<{ ok: boolean }> {
    const { scope, project_id } = this.normalizeTarget(target)
    const removed = await this.store.delete(owner_slug, project_id, CODEX_CREDENTIAL_SERVICE)
    removeCodexAuth(this.homeFor(scope, project_id))
    return { ok: removed }
  }

  /**
   * The trident-review CODEX_HOME resolver: which materialized dir a run in
   * `project_id` must use — the store resolver's project → global → unset, with
   * self-healing materialization (re-write the auth.json if a credential is
   * stored but the on-disk file is missing). Returns the CODEX_HOME dir, or null
   * when neither an override nor a global default is set (→ codex "not
   * connected" → Claude-only review, never a blocker).
   */
  resolveActiveCodexHome(owner_slug: string, project_id?: string): string | null {
    const resolved = this.store.resolve(owner_slug, project_id, CODEX_CREDENTIAL_SERVICE)
    if (resolved === null) return null
    const home =
      resolved.scope === 'project' ? codexProjectHome(this.codexHome, project_id) : this.codexHome
    if (readMaterializedAuth(home) === null) {
      materializeCodexAuth({ codexHome: home, authJson: resolved.plaintext })
    }
    return home
  }

  /**
   * Boot/self-heal for the GLOBAL default: if a global credential is stored but
   * the global CODEX_HOME file is missing (fresh process / new worktree / wiped
   * tmp), re-materialize it. Returns true when a file is present afterwards. Safe
   * to call unconditionally at wiring. (Per-project overrides self-heal lazily in
   * `resolveActiveCodexHome`.)
   */
  ensureMaterialized(owner_slug: string): boolean {
    if (readMaterializedAuth(this.codexHome) !== null) return true
    // Global-only lookup (project_id undefined → the resolver consults only the
    // global default), so a stray project override never materializes here.
    const resolved = this.store.resolve(owner_slug, undefined, CODEX_CREDENTIAL_SERVICE)
    if (resolved === null) return false
    materializeCodexAuth({ codexHome: this.codexHome, authJson: resolved.plaintext })
    return true
  }
}
