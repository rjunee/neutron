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

import type { ProjectCredentialStore } from '../project-credentials/store.ts'
import {
  deriveCodexStatus,
  materializeCodexAuth,
  readMaterializedAuth,
  removeCodexAuth,
  validateCodexSubscriptionAuth,
  type CodexStatusDetail,
} from './codex-auth.ts'

/** The reserved `project_credentials.service` name for the Codex OAuth bundle. */
export const CODEX_CREDENTIAL_SERVICE = 'codex'

export interface CodexConnectResult {
  ok: boolean
  status?: CodexStatusDetail['status']
  mode?: 'subscription' | 'apikey' | 'unknown'
  /** Materialized auth.json path (only on success). */
  path?: string
  code?: string
  error?: string
}

export interface CodexCredentialServiceDeps {
  store: ProjectCredentialStore
  /** The per-project CODEX_HOME dir (`resolveCodexHome`). */
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

  /**
   * Validate + persist + materialize a pasted Codex subscription auth.json.
   * Metered `OPENAI_API_KEY` pastes are rejected here (never stored). On success
   * the credential is in the store (global scope, service `codex`) AND written to
   * `CODEX_HOME/auth.json`, so `codex-review.sh` sees it connected.
   */
  async connect(owner_slug: string, pasted: unknown): Promise<CodexConnectResult> {
    const v = validateCodexSubscriptionAuth(pasted, this.now)
    if (!v.ok || v.normalized === undefined) {
      return { ok: false, mode: v.mode, ...(v.code !== undefined ? { code: v.code } : {}), ...(v.error !== undefined ? { error: v.error } : {}) }
    }
    await this.store.set(owner_slug, {
      service: CODEX_CREDENTIAL_SERVICE,
      plaintext: v.normalized,
      scope: 'global',
      project_id: '',
      label: 'ChatGPT subscription (codex cross-model review)',
      expires_at: null,
    })
    const { path } = materializeCodexAuth({ codexHome: this.codexHome, authJson: v.normalized })
    const status = deriveCodexStatus(v.normalized, { materialized: true, now: this.now })
    return { ok: true, mode: 'subscription', status: status.status, path }
  }

  /** Read-only connection status for the admin panel / `codex_status` tool. */
  status(owner_slug: string): CodexStatusDetail {
    const resolved = this.store.resolve(owner_slug, undefined, CODEX_CREDENTIAL_SERVICE)
    const stored = resolved?.plaintext ?? null
    const materialized = readMaterializedAuth(this.codexHome) !== null
    return deriveCodexStatus(stored, { materialized, now: this.now })
  }

  /** Delete the stored credential + remove the materialized auth.json. */
  async disconnect(owner_slug: string): Promise<{ ok: boolean }> {
    const removed = await this.store.delete(owner_slug, '', CODEX_CREDENTIAL_SERVICE)
    removeCodexAuth(this.codexHome)
    return { ok: removed }
  }

  /**
   * Boot/self-heal: if a credential is stored but the CODEX_HOME file is missing
   * (fresh process / new worktree / wiped tmp), re-materialize it. Returns true
   * when a file is present afterwards. Safe to call unconditionally at wiring.
   */
  ensureMaterialized(owner_slug: string): boolean {
    if (readMaterializedAuth(this.codexHome) !== null) return true
    const resolved = this.store.resolve(owner_slug, undefined, CODEX_CREDENTIAL_SERVICE)
    if (resolved === null) return false
    materializeCodexAuth({ codexHome: this.codexHome, authJson: resolved.plaintext })
    return true
  }
}
