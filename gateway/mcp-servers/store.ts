/**
 * @neutronai/gateway/mcp-servers — the owner's installed MCP servers, end to end.
 *
 * Three stores answer three different questions, and this class is the only place
 * that joins them:
 *
 *   - WHAT IS INSTALLED — `instance_metadata.mcp_servers` (migration 0120), read and
 *     written by `gateway/storage/owner-metadata.ts`. Names, commands, args, and the
 *     NAMES of the environment variables. No secrets.
 *   - WHAT ITS SECRETS ARE — the AES-256-GCM `ProjectCredentialStore` (migration
 *     0092) at global scope, one row per server under `mcp_env.<name>`, holding a
 *     JSON object of NAME → value. Never returned to a client, never logged.
 *   - WHAT THE OWNER PERMITTED — `tool_approvals` (migration 0004) under
 *     `mcp-server:<name>`, bound to the grant hash. The SAME durable-grant mechanism
 *     the scheduled rituals use (`reminders/ritual-approval.ts`), because a second
 *     approval concept would mean two answers to "did he say yes".
 *
 * ── THE INTERSECTION IS WHAT RUNS ───────────────────────────────────────────
 * {@link OwnerMcpServerStore.resolveApproved} is what the spawn path calls, and it
 * returns a server only when ALL of these hold:
 *
 *   1. it is in the installed list, and still valid,
 *   2. an `approved` `tool_approvals` row exists whose `args_json.grant_hash`
 *      equals the hash recomputed from the LIVE spec, and
 *   3. every env-var name the spec declares has a stored value.
 *
 * (2) is what makes an edit require re-approval without deleting anything: change
 * the command and the hash changes, so the old row stops matching and the server
 * stops being wired. It is recomputed on every resolve, never cached — a scheduled
 * actor's risk is in spawn #500, not spawn #1, which is the lesson
 * `createRitualApprovalCheck` already encodes.
 *
 * (3) is fail-closed on a state that should be impossible: a spec promising
 * `EXAMPLE_API_KEY` whose credential row is missing would start the program with
 * that variable unset, which is not what the owner approved. Skipping it and saying
 * so beats silently launching a differently-configured process.
 *
 * ── RE-APPROVING AN EXACT REVERT IS NOT A HOLE ──────────────────────────────
 * Because the check is a hash MATCH and not a "latest row wins", editing a server
 * and then changing it back byte-for-byte restores the original approval without a
 * second prompt. That is the intended behaviour and matches the ritual grants: the
 * owner already approved that exact program with those exact variables, and the
 * grant he gave is still an accurate description of what would run.
 *
 * ── WHY DENY DOES NOT UNINSTALL ─────────────────────────────────────────────
 * A denied server stays in the list, unapproved. Deleting the owner's typed-in
 * command because he answered "not now" would make him retype it, and the list is
 * the only record of what he was setting up. `remove()` is the uninstall.
 */

import type { OwnerHandle, ProjectDb } from '@neutronai/persistence/index.ts'
import type { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import type { ApprovalManager, ApprovalRow } from '@neutronai/tools/approval.ts'
import {
  MCP_SERVERS_MAX,
  computeMcpServerGrantHash,
  parseOwnerMcpServerInput,
  renderMcpServerGrant,
  type OwnerMcpServerSpec,
  type ResolvedOwnerMcpServer,
} from '@neutronai/runtime/mcp-servers.ts'
import { createLogger } from '@neutronai/logger'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import {
  readOwnerMcpServers,
  writeOwnerMcpServers,
} from '@neutronai/gateway/storage/owner-metadata.ts'

const log = createLogger('mcp-servers')

/** `tool_approvals.tool_name` for an installed server's grant. */
export function mcpServerApprovalToolName(name: string): string {
  return `mcp-server:${name}`
}

/**
 * `project_credentials.service` holding one server's env values.
 *
 * A dot-separated namespace, matching the store's `[a-z0-9_.-]` charset, and the
 * server name is already constrained to `[a-z0-9-]` — so no name can escape the
 * namespace or collide with `openai_transcription` and the other reserved services.
 */
export function mcpServerEnvService(name: string): string {
  return `mcp_env.${name}`
}

/** Where a server stands with the owner. */
export type McpServerApprovalState = 'approved' | 'pending' | 'denied' | 'unapproved'

/** One installed server as reported to a client. Never carries an env VALUE. */
export interface McpServerStatus extends OwnerMcpServerSpec {
  approval: McpServerApprovalState
  /** The verbatim prompt for THIS spec — see `renderMcpServerGrant`. */
  grant_prompt: string
  /** Whether every declared env var has a stored value. False ⇒ never wired. */
  secrets_present: boolean
  /** True when this exact spec is approved AND usable, i.e. it is wired right now. */
  active: boolean
}

export interface OwnerMcpServerStoreDeps {
  db: ProjectDb
  /** The owner/instance slug — the `instance_metadata` and approvals scope key. */
  project_slug: string
  credentials: ProjectCredentialStore
  owner_slug: OwnerHandle
  /**
   * The graph's ApprovalManager. A GETTER, not a value: the manager is a module in
   * the composed graph while this store is constructed before `graph.compose()`
   * runs, exactly like the late-bound Cores registry the tabs surface reads. Reading
   * it eagerly would latch `null` for the life of the process, which is the
   * `coresState` bug (`open/composer.ts`) in a place where the symptom would be
   * "approval silently does nothing".
   *
   * Returning `null` is FAIL-CLOSED at every call site here: nothing can be
   * approved, and therefore nothing can be wired.
   */
  approvals: () => ApprovalManager | null
}

/** The outcome of an install/edit attempt. */
export interface McpServerWriteResult {
  ok: boolean
  errors: ReadonlyArray<string>
  servers: ReadonlyArray<McpServerStatus>
}

export class OwnerMcpServerStore {
  constructor(private readonly deps: OwnerMcpServerStoreDeps) {}

  /** The installed specs, straight from `instance_metadata`. */
  specs(): ReadonlyArray<OwnerMcpServerSpec> {
    return readOwnerMcpServers(this.deps.db, this.deps.project_slug)
  }

  /**
   * Every installed server with its approval state — the ONE payload every route
   * answers with, so a client never has to guess what a mutation did.
   */
  async list(): Promise<ReadonlyArray<McpServerStatus>> {
    const out: McpServerStatus[] = []
    for (const spec of this.specs()) {
      const approval = this.approvalStateFor(spec)
      const secrets_present = this.secretsPresent(spec)
      out.push({
        ...spec,
        approval,
        grant_prompt: renderMcpServerGrant(spec),
        secrets_present,
        active: approval === 'approved' && secrets_present,
      })
    }
    return out
  }

  /**
   * Install a new server, or replace an existing one of the same name.
   *
   * FAILS WHOLE on any validation error, storing nothing and naming every problem —
   * the settings-boundary asymmetry `writeTridentPhaseModels` documents: the owner is
   * present and can be told, so a silent partial write is the worst outcome
   * available.
   *
   * Order matters. The SECRET is written first, then the spec, then the pending
   * grant is minted. If the process dies between those steps the visible result is a
   * server the owner has to approve (or an orphan credential row that the next write
   * to the same name overwrites) — never an APPROVED server whose command was only
   * half-updated.
   *
   * A replace does not touch the old approval row at all. It does not need to: the
   * new spec hashes differently, so the old grant stops matching and the server
   * drops out of `resolveApproved` on the very next spawn. Deleting the old row
   * would also destroy the record that the owner once approved that command.
   */
  async install(raw: unknown): Promise<McpServerWriteResult> {
    const { spec, env, errors } = parseOwnerMcpServerInput(raw)
    if (spec === null) return { ok: false, errors, servers: await this.list() }

    const existing = this.specs()
    const isNew = !existing.some((s) => s.name === spec.name)
    if (isNew && existing.length >= MCP_SERVERS_MAX) {
      return {
        ok: false,
        errors: [`this instance already has the maximum of ${MCP_SERVERS_MAX} MCP servers`],
        servers: await this.list(),
      }
    }

    if (spec.env_names.length > 0) {
      await this.deps.credentials.set(this.deps.owner_slug, {
        service: mcpServerEnvService(spec.name),
        plaintext: JSON.stringify(env),
        scope: 'global',
      })
    } else {
      // An edit that REMOVES every variable must not leave the old secrets behind:
      // they would be dead weight in the credential store and, worse, would come
      // back if the owner later re-added a variable of the same name.
      await this.forgetSecrets(spec.name)
    }

    const next = isNew ? [...existing, spec] : existing.map((s) => (s.name === spec.name ? spec : s))
    await writeOwnerMcpServers(this.deps.db, this.deps.project_slug, next)
    await this.requestApproval(spec)
    return { ok: true, errors: [], servers: await this.list() }
  }

  /**
   * Uninstall a server: drop the spec, forget its secrets, and cancel any grant that
   * is still pending.
   *
   * The APPROVED rows are deliberately left in place — `tool_approvals` is a durable
   * record of decisions, and an approved-then-uninstalled server is not wired
   * anyway (it is no longer in the installed list, which `resolveApproved` reads
   * first). Rewriting history to make the current state tidier is how an audit trail
   * stops being one.
   */
  async remove(name: unknown): Promise<{ removed: boolean; servers: ReadonlyArray<McpServerStatus> }> {
    const wanted = typeof name === 'string' ? name.trim().toLowerCase() : ''
    const existing = this.specs()
    const target = existing.find((s) => s.name === wanted)
    if (target === undefined) return { removed: false, servers: await this.list() }
    await writeOwnerMcpServers(
      this.deps.db,
      this.deps.project_slug,
      existing.filter((s) => s.name !== wanted),
    )
    await this.forgetSecrets(wanted)
    const manager = this.deps.approvals()
    if (manager !== null) {
      for (const row of manager.listPending(this.deps.project_slug)) {
        if (row.tool_name === mcpServerApprovalToolName(wanted)) await manager.cancelPending(row.id)
      }
    }
    return { removed: true, servers: await this.list() }
  }

  /**
   * Record the owner's decision on a server's CURRENT spec.
   *
   * Resolves the pending row whose `grant_hash` matches the live spec — never merely
   * "the newest pending row for this name". If the spec changed after the prompt was
   * rendered, no row matches and the decision is refused: approving is an act about
   * a SPECIFIC command, and applying it to a different one is the precise failure
   * the hash exists to prevent.
   *
   * There is no `policy: 'auto'` path here and no pre-approved server, so approval
   * can never be inferred from silence, from an unrelated action, or from the mere
   * fact that the owner typed a command into a form.
   */
  async decide(
    name: unknown,
    decision: 'approve' | 'deny',
  ): Promise<{ ok: boolean; error: string | null; servers: ReadonlyArray<McpServerStatus> }> {
    const wanted = typeof name === 'string' ? name.trim().toLowerCase() : ''
    const spec = this.specs().find((s) => s.name === wanted)
    if (spec === undefined) {
      return { ok: false, error: `no MCP server named '${wanted}' is installed`, servers: await this.list() }
    }
    const manager = this.deps.approvals()
    if (manager === null) {
      return { ok: false, error: 'the approval service is not available yet', servers: await this.list() }
    }
    const hash = computeMcpServerGrantHash(spec)
    const rows = manager.findByToolName(this.deps.project_slug, mcpServerApprovalToolName(wanted))
    // Already decided for THIS exact spec: report success rather than an error. A
    // double-tap, or two clients open on the same row, must not read as a failure —
    // the state the owner asked for is the state he has.
    if (decision === 'approve' && rows.some((r) => r.status === 'approved' && grantHashOf(r) === hash)) {
      return { ok: true, error: null, servers: await this.list() }
    }
    const pending = rows.find((row) => row.status === 'pending' && grantHashOf(row) === hash)
    if (pending === undefined) {
      // Either it was already decided, or the spec moved. Mint a fresh prompt rather
      // than leaving the owner with a button that does nothing.
      await this.requestApproval(spec)
      return {
        ok: false,
        error: 'that request no longer matches the installed server — review the new prompt and decide again',
        servers: await this.list(),
      }
    }
    await manager.respondApproval(
      pending.id,
      decision === 'approve' ? 'approved' : 'denied',
      this.deps.project_slug,
    )
    return { ok: true, error: null, servers: await this.list() }
  }

  /**
   * The servers the spawn path may wire — installed, approved for THIS exact spec,
   * and with every declared secret present. See § THE INTERSECTION in the header.
   *
   * Called once per spawn and once per warm-reuse check, so it does a little work
   * per turn: one indexed row read plus one AES decrypt per server with secrets.
   * That is the same order of cost as the transcription-backend probe the upload
   * path already pays per request, against an operation about to spawn a process.
   */
  async resolveApproved(): Promise<ReadonlyArray<ResolvedOwnerMcpServer>> {
    const out: ResolvedOwnerMcpServer[] = []
    for (const spec of this.specs()) {
      if (this.approvalStateFor(spec) !== 'approved') continue
      const env = this.readSecrets(spec.name)
      const missing = spec.env_names.filter((n) => env[n] === undefined || env[n] === '')
      if (missing.length > 0) {
        // NOT silent: a server the owner approved and can see in Settings, which is
        // nevertheless not being started, is otherwise indistinguishable from one
        // that is running badly.
        log.warn('mcp_server_secret_missing', { server: spec.name, missing: missing.join(',') })
        continue
      }
      const scoped: Record<string, string> = {}
      // Only the DECLARED names are forwarded. A stale key left in the stored blob
      // by an earlier edit is not in the spec, so it was never in the grant, so it
      // must not reach the subprocess.
      for (const n of spec.env_names) scoped[n] = env[n]!
      out.push({ ...spec, env: scoped })
    }
    return out
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Mint a fresh `prompt-user` grant bound to this spec's hash. */
  private async requestApproval(spec: OwnerMcpServerSpec): Promise<void> {
    const manager = this.deps.approvals()
    if (manager === null) return
    const hash = computeMcpServerGrantHash(spec)
    const tool_name = mcpServerApprovalToolName(spec.name)
    const rows = manager.findByToolName(this.deps.project_slug, tool_name)
    // Already decided for this exact spec, or already waiting on it — do not stack a
    // second prompt. Two live rows for one grant would make "which one did he
    // answer" a real question.
    if (rows.some((r) => grantHashOf(r) === hash && (r.status === 'pending' || r.status === 'approved'))) {
      return
    }
    // Any pending row for a DIFFERENT spec of this server is stale the moment the
    // spec changes — cancel it, or the owner could approve a command that is no
    // longer installed.
    for (const row of rows) {
      if (row.status === 'pending' && grantHashOf(row) !== hash) await manager.cancelPending(row.id)
    }
    // NOT AWAITED. The returned promise resolves when the OWNER answers (or on the
    // TTL sweep) — minutes to never — so awaiting it would hang the HTTP request that
    // installed the server. The row it inserts before returning is the state that
    // matters, and `resolveApproved` reads that, not this promise.
    fireAndForget('mcp-servers.requestApproval', manager.requestApproval({
      project_slug: this.deps.project_slug,
      topic_id: null,
      tool_name,
      policy: 'prompt-user',
      args: {
        server: spec.name,
        grant_hash: hash,
        command: spec.command,
        args: [...spec.args],
        env_names: [...spec.env_names],
      },
    }))
  }

  /** The state of the grant for THIS exact spec (hash-matched, newest first). */
  private approvalStateFor(spec: OwnerMcpServerSpec): McpServerApprovalState {
    const manager = this.deps.approvals()
    if (manager === null) return 'unapproved'
    const hash = computeMcpServerGrantHash(spec)
    const rows = manager
      .findByToolName(this.deps.project_slug, mcpServerApprovalToolName(spec.name))
      .filter((row) => grantHashOf(row) === hash)
    if (rows.some((r) => r.status === 'approved')) return 'approved'
    if (rows.some((r) => r.status === 'pending')) return 'pending'
    if (rows.some((r) => r.status === 'denied')) return 'denied'
    return 'unapproved'
  }

  /** Synchronous, like `ProjectCredentialStore.resolve` itself (prepare/get + decrypt). */
  private readSecrets(name: string): Record<string, string> {
    const resolved = this.deps.credentials.resolve(
      this.deps.owner_slug,
      '',
      mcpServerEnvService(name),
    )
    if (resolved === null) return {}
    try {
      const parsed = JSON.parse(resolved.plaintext) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
      }
      return out
    } catch {
      // A corrupt blob is "no secrets", which fails the server closed. The message
      // names the server and never the payload.
      log.warn('mcp_server_secret_unreadable', { server: name })
      return {}
    }
  }

  private secretsPresent(spec: OwnerMcpServerSpec): boolean {
    if (spec.env_names.length === 0) return true
    const env = this.readSecrets(spec.name)
    return spec.env_names.every((n) => typeof env[n] === 'string' && env[n]!.length > 0)
  }

  private async forgetSecrets(name: string): Promise<void> {
    await this.deps.credentials.delete(this.deps.owner_slug, '', mcpServerEnvService(name))
  }
}

/** The `grant_hash` on an approval row, or `null` when the row is unreadable. */
function grantHashOf(row: ApprovalRow): string | null {
  try {
    const parsed = JSON.parse(row.args_json) as { grant_hash?: unknown }
    return typeof parsed.grant_hash === 'string' ? parsed.grant_hash : null
  } catch {
    // A malformed row is never a match — and never a throw that could take down a
    // spawn (the `createRitualApprovalCheck` discipline).
    return null
  }
}
