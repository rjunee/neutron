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
 * UNINSTALLING IS DIFFERENT, and it took a review to see why. Editing leaves a
 * server the owner is still curating; uninstalling ENDS it. Left alone, the approved
 * row survived the uninstall and a later reinstall of the identical command
 * re-matched it — so a server the owner had removed came back WIRED, with no prompt,
 * having never been shown to him a second time. `remove()` therefore revokes the
 * approved grants (`ApprovalManager.revokeApproved`) as well as cancelling the
 * pending ones. The rows stay, recording what was approved and by whom; only the
 * grant lapses.
 *
 * ── WHY DENY DOES NOT UNINSTALL, BUT DOES REVOKE ────────────────────────────
 * A denied server stays in the list, unapproved. Deleting the owner's typed-in
 * command because he answered "not now" would make him retype it, and the list is
 * the only record of what he was setting up. `remove()` is the uninstall.
 *
 * Deny DOES revoke, though, and that took a review to see. `approvalStateFor` tests
 * `approved` before `denied` — the safe precedence for a read — so recording a denial
 * ALONGSIDE a live approval left the server wired while the list said "denied" and the
 * HTTP surface answered 200. Two clients make that ordinary rather than exotic: the
 * phone approves, the tab still shows the pending prompt, and the tab's Deny stops
 * nothing. Deny is the only stop button the owner has, so it revokes first and records
 * second — see {@link OwnerMcpServerStore.decide}.
 *
 * ── ONE WRITER AT A TIME ────────────────────────────────────────────────────
 * `install` and `remove` both READ the whole installed list, do async work, then
 * REWRITE the whole list. Two of them interleaved (the web tab and the phone, or one
 * owner double-tapping) meant the second write was computed from a list that no
 * longer existed, and the first install silently vanished. Both now run inside
 * {@link OwnerMcpServerStore.serialize} — an in-process promise chain — and re-read
 * the list INSIDE it. One gateway process owns this database, so a chain is the whole
 * fix; it is not a substitute for a transaction across the two stores, which is why
 * the write ORDER below is also fail-closed.
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
  /**
   * The digest of the spec THIS row describes — what a client must echo back on a
   * decision, so an approve can only ever land on the spec that was on screen. See
   * {@link OwnerMcpServerStore.decide}.
   *
   * Not a secret and not a capability: it is derived from the name, command, args and
   * env-var NAMES, every one of which is already in this same payload.
   */
  grant_hash: string
  /** Whether every declared env var has a stored value. False ⇒ never wired. */
  secrets_present: boolean
  /**
   * True when this exact spec is approved AND usable — i.e. the next spawn of the
   * owner's conversational session will attach it.
   *
   * NOT "a process is running". `mcpServers` is read once by `claude` at startup, so
   * nothing is running between turns, and the wiring reaches the CLAUDE-backed session
   * only (`gateway/wiring/build-llm-call-substrate.ts` returns on its non-Anthropic
   * branch before any of it). Both clients' labels say that rather than "running";
   * a `serverSummary` that overstated it was the review finding that renamed this.
   */
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

  /**
   * Called after a revocation has landed, so whatever is already RUNNING under the old
   * answer can be retired.
   *
   * Revoking the grant is immediate and correct, but a warm REPL was spawned with the
   * old `mcpServers` config and `claude` reads that once at startup. The spawn path's
   * freshness guard evicts a stale child — on its NEXT DISPATCH, which for an idle
   * session may be hours away. Until then the revoked server's stdio subprocess is
   * still alive, still holding the environment it was handed, including any secret the
   * owner configured for it.
   *
   * A CALLBACK RATHER THAN AN IMPORT. This store must not reach into the REPL pool: it
   * is a persistence-layer object and the pool is a runtime adapter, and the layering
   * gate is right to refuse that edge. The composer owns both and wires them.
   *
   * Optional, and its failure is swallowed at the call site — an eviction that cannot
   * happen must never turn a successful revocation into a failed one.
   */
  onRevoked?: () => Promise<void>
}

/** The outcome of an install/edit attempt. */
export interface McpServerWriteResult {
  ok: boolean
  errors: ReadonlyArray<string>
  servers: ReadonlyArray<McpServerStatus>
}

export class OwnerMcpServerStore {
  constructor(private readonly deps: OwnerMcpServerStoreDeps) {}

  /**
   * Tail of the write chain — see § ONE WRITER AT A TIME in the header. Every
   * read-modify-write on the installed list queues behind it.
   */
  private writes: Promise<unknown> = Promise.resolve()

  /**
   * Run `body` with no other read-modify-write of the installed list interleaved.
   *
   * The chain is advanced with a promise that CANNOT reject (`.then(noop, noop)`), so
   * one failed install does not poison every later one — a rejected tail would make
   * the next `await this.writes` throw somebody else's error.
   */
  private serialize<T>(body: () => Promise<T>): Promise<T> {
    const run = this.writes.then(body, body)
    this.writes = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

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
        grant_hash: computeMcpServerGrantHash(spec),
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
   * ORDER MATTERS, and it is SPEC FIRST, then the secrets, then the pending grant.
   * The two stores cannot be written in one transaction (different tables, one of
   * them encrypted through its own API), so the ordering is chosen for what a crash
   * in the middle LEAVES BEHIND:
   *
   *   - spec written, secrets not: the new spec hashes differently from any approved
   *     grant, so it is unapproved AND `secrets_present` is false. Two independent
   *     reasons it is not wired. The owner sees a server asking to be approved.
   *   - the reverse order (secrets first) leaves the OLD, still-APPROVED spec paired
   *     with the NEW secrets — an approved command running with variables the owner
   *     set for a different command. That is the one outcome worth engineering
   *     against, so the order that cannot produce it is the one used.
   *
   * A replace does not touch the old approval ROW at all. It does not need to: the
   * new spec hashes differently, so the old grant stops matching and the server
   * drops out of `resolveApproved` on the very next spawn. Deleting the old row
   * would also destroy the record that the owner once approved that command.
   *
   * It does, however, retire the old PROCESS. Un-approving by rewriting the spec governs
   * what the next spawn wires; it says nothing about the child already running under the
   * previous grant, which keeps its command and its copied env until something evicts it.
   * So a replace whose grant hash actually changed announces the revocation, exactly as
   * {@link remove} and a deny do — see the call at the end of the critical section.
   *
   * Runs inside {@link serialize}, and re-reads the installed list in there, so two
   * concurrent installs cannot both rewrite a list they read before the other wrote.
   */
  async install(raw: unknown): Promise<McpServerWriteResult> {
    const { spec, env, errors } = parseOwnerMcpServerInput(raw)
    if (spec === null) return { ok: false, errors, servers: await this.list() }

    return await this.serialize(async () => {
      const existing = this.specs()
      const isNew = !existing.some((s) => s.name === spec.name)
      if (isNew && existing.length >= MCP_SERVERS_MAX) {
        return {
          ok: false,
          errors: [`this instance already has the maximum of ${MCP_SERVERS_MAX} MCP servers`],
          servers: await this.list(),
        }
      }

      const previous = existing.find((s) => s.name === spec.name)
      const next = isNew
        ? [...existing, spec]
        : existing.map((s) => (s.name === spec.name ? spec : s))
      await writeOwnerMcpServers(this.deps.db, this.deps.project_slug, next)

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

      await this.requestApproval(spec)
      // AN EDIT RETIRES WHAT THE OLD ANSWER STARTED, for the same reason a deny and an
      // uninstall do. Rewriting the spec silently un-approves the server — the new bytes
      // hash differently, so `resolveApproved` drops it — but that only governs what the
      // NEXT spawn wires. A warm child started under the OLD grant keeps running the old
      // command, with the old env values still resident in it, and nothing evicts it until
      // some later dispatch happens to re-check the surface. For an idle session that is
      // hours. Editing a server is the owner changing his answer about what may run, so
      // the process started under the previous answer has to go the same way the grant
      // did.
      //
      // GATED ON THE GRANT HASH, not on `isNew`: a re-install of a byte-identical spec
      // leaves the grant matching and the running child correct, so evicting there would
      // cost a cold respawn to change nothing. A hash change is exactly the condition
      // under which the old approval stops applying.
      //
      // Env VALUE-only edits are deliberately NOT covered here — the hash does not cover
      // values, and they are already the spawn path's `freshCredential` guard's job. This
      // is scoped to the case where the GRANT itself stops being in force.
      if (previous !== undefined && computeMcpServerGrantHash(previous) !== computeMcpServerGrantHash(spec)) {
        await this.announceRevocation()
      }
      return { ok: true, errors: [], servers: await this.list() }
    })
  }

  /**
   * Uninstall a server: REVOKE the grant — both the pending prompts and the approval
   * itself — forget its secrets, then drop the spec.
   *
   * Revoking the approved rows is what makes an uninstall mean something. Without it,
   * `approvalStateFor` matches on the grant hash alone, so reinstalling the identical
   * command re-matched the old approval and the server came back RUNNING with no
   * prompt — the owner having removed it, and never seen it again. See § UNINSTALLING
   * IS DIFFERENT in the header. The rows survive the revoke (status 'expired', with
   * their `args_json` and decider intact), so the audit trail still records that he
   * approved that command; only the grant lapses.
   *
   * ── THE ORDER IS REVOKE, THEN FORGET, THEN DROP ─────────────────────────────
   * Three stores, no transaction across them, so the order has to be the one whose
   * every PARTIAL outcome is safe. That is the same test {@link install} is ordered
   * by — it writes the spec first because a freshly-written spec hashes differently
   * from any grant and is therefore unapproved, whereas secrets-first would pair NEW
   * variables with the OLD still-approved command. Both orders answer one question:
   * what does a crash in the middle leave RUNNING?
   *
   * Dropping the spec FIRST was the inverse of that and it was wrong. A failure after
   * the spec write left an APPROVED `tool_approvals` row for a server that no longer
   * existed, and the owner could not heal it: a retry re-reads the list, finds
   * nothing, and answers `removed: false` — a 404 on the uninstall he already did,
   * with the live grant still sitting in the table. Reinstalling the identical command
   * would then re-match that surviving approval and come back WIRED with no prompt,
   * which is precisely the hole the revoke was added to close.
   *
   * Revoking first inverts every partial outcome into a safe one. After the revoke,
   * the server is unapproved, so `resolveApproved` will not wire it whatever happens
   * next; if the forget or the spec write then fails, the spec is STILL INSTALLED, so
   * the owner sees the row he asked to delete and pressing Uninstall again finds its
   * target and completes. The only cost is that an interrupted uninstall shows him a
   * server that has lost its approval — the fail-closed direction.
   */
  /**
   * Retire anything already running under the answer we just changed.
   *
   * Swallows its own failure by design: the revocation has ALREADY landed durably, and
   * turning a completed revoke into a reported failure would invite the owner to press
   * again on state that is already correct. See {@link OwnerMcpServerStoreDeps.onRevoked}.
   */
  private async announceRevocation(): Promise<void> {
    if (this.deps.onRevoked === undefined) return
    try {
      await this.deps.onRevoked()
    } catch (err) {
      log.warn('mcp_revocation_evict_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async remove(name: unknown): Promise<{ removed: boolean; servers: ReadonlyArray<McpServerStatus> }> {
    const wanted = typeof name === 'string' ? name.trim().toLowerCase() : ''
    return await this.serialize(async () => {
      const existing = this.specs()
      const target = existing.find((s) => s.name === wanted)
      if (target === undefined) return { removed: false, servers: await this.list() }
      const manager = this.deps.approvals()
      if (manager !== null) {
        const tool_name = mcpServerApprovalToolName(wanted)
        for (const row of manager.listPending(this.deps.project_slug)) {
          if (row.tool_name === tool_name) await manager.cancelPending(row.id)
        }
        await manager.revokeApproved(this.deps.project_slug, tool_name)
      }
      await this.forgetSecrets(wanted)
      await writeOwnerMcpServers(
        this.deps.db,
        this.deps.project_slug,
        existing.filter((s) => s.name !== wanted),
      )
      // AFTER the spec write, so a child respawned by the eviction reads the list
      // WITHOUT this server rather than racing the delete and re-wiring it.
      await this.announceRevocation()
      return { removed: true, servers: await this.list() }
    })
  }

  /**
   * Record the owner's decision on a server's CURRENT spec.
   *
   * ── THE DECISION CARRIES THE HASH OF WHAT WAS ON SCREEN ─────────────────────
   * `expect_grant_hash` is REQUIRED and must equal the hash recomputed from the live
   * spec. It comes from the same `list()` payload that carried the `grant_prompt` the
   * owner read, so it is a claim about WHICH SPEC he was looking at when he pressed
   * the button.
   *
   * Without it the decision was `{name, decision}` and nothing more, and the store
   * bound it to whatever the CURRENT spec happened to be. An install/edit from another
   * device (or another browser tab) between render and press therefore turned an
   * Approve for the command on screen into an Approve for a command he had never
   * seen — the exact substitution the grant hash exists to prevent, arriving through
   * the one door that was not checking it. A mismatch is refused, and the reply
   * carries the fresh list so the client re-renders the prompt he now has to read.
   *
   * ── ONE PRESS IS ONE DECISION ───────────────────────────────────────────────
   * Given a matching hash, the decision is applied whether or not a pending row is
   * sitting there: a matching pending row is resolved, and if there is none (he
   * denied it earlier and changed his mind, or an uninstall cancelled the prompt) a fresh
   * grant is opened and resolved in the same call. This is safe precisely BECAUSE the
   * hash matched — the affirmative act is about a spec that is provably the one that
   * was rendered — and it fixes a deny-then-approve that used to answer 409 and need
   * an unexplained second press.
   *
   * There is no `policy: 'auto'` path here and no pre-approved server, so approval
   * can never be inferred from silence, from an unrelated action, or from the mere
   * fact that the owner typed a command into a form.
   *
   * ── A DENY IS A STOP, NOT A SECOND OPINION ──────────────────────────────────
   * Deny revokes any approval in force for this server before it records the denial.
   * See the block at the revoke: `approvalStateFor` reads `approved` first, so a
   * denial recorded ALONGSIDE a live approval would have reported success while the
   * server kept being wired.
   *
   * `decided_by` is the authenticated actor from the caller's own auth check, written
   * to `tool_approvals.decided_by` — a column whose schema comment calls it the
   * user_id of the decider.
   */
  async decide(
    name: unknown,
    decision: 'approve' | 'deny',
    expect_grant_hash: unknown,
    decided_by?: string,
  ): Promise<{ ok: boolean; error: string | null; servers: ReadonlyArray<McpServerStatus> }> {
    // ON THE WRITE CHAIN — see § ONE WRITER AT A TIME. `install` and `remove` were
    // serialized and this was not, which made an ORPHANED APPROVAL ordinary rather
    // than exotic: a `decide('approve')` reads the spec and passes its hash check, a
    // `remove()` then deletes the spec AND revokes the grant, and the approve resumes
    // to open + resolve a fresh `approved` row for a server that is no longer
    // installed. The revoke is simply lost — it ran before the row it was meant to
    // kill existed. Reinstalling the identical spec then produces the same grant hash,
    // `approvalStateFor` finds the survivor, and the server comes back WIRED with no
    // approval prompt at all. That is the gate failing silently open, which is the one
    // outcome this feature must never have.
    //
    // Two clients make the interleaving normal: the phone decides while the tab still
    // shows the prompt, or an uninstall lands from one surface mid-decision on the
    // other. The body is unchanged and lives in `decideLocked` so this stays a lock,
    // not a rewrite; nothing it calls is itself serialized (`list` and
    // `requestApproval` are both already invoked from inside `install`'s critical
    // section), so there is no re-entrancy to deadlock on.
    return await this.serialize(() =>
      this.decideLocked(name, decision, expect_grant_hash, decided_by),
    )
  }

  /** {@link decide}'s body. Runs INSIDE {@link serialize} — never call it directly. */
  private async decideLocked(
    name: unknown,
    decision: 'approve' | 'deny',
    expect_grant_hash: unknown,
    decided_by?: string,
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
    if (typeof expect_grant_hash !== 'string' || expect_grant_hash !== hash) {
      // Mint a fresh prompt for the spec that IS installed, so the owner is not left
      // with a button that does nothing — then refuse, and return the new list.
      await this.requestApproval(spec)
      return {
        ok: false,
        error:
          "that request describes an older version of this server — read the request below, which is what would run now, and decide again",
        servers: await this.list(),
      }
    }
    const tool_name = mcpServerApprovalToolName(wanted)
    // A DENY REVOKES BEFORE IT RECORDS, because opening a denied row does not close an
    // approved one. `approvalStateFor` tests `approved` FIRST — the safe precedence for
    // reads — so a deny that merely added a `denied` row alongside a live `approved`
    // one left the server WIRED while this method answered 200 and the settings list
    // said "denied". Two clients make that ordinary rather than exotic: the phone
    // approves while the tab still shows the pending prompt, and the tab's Deny then
    // reports success without stopping anything.
    //
    // Revoking every approved row for this server, not just the hash-matched one, is
    // deliberate: a deny is the owner saying this server must not run, and a row
    // approving some OTHER spec of it is inert only for as long as the spec stays
    // edited. `remove()` revokes with the same breadth, and for the same reason. The
    // rows survive as 'expired' with their decider intact, so the audit trail keeps
    // saying he once approved that command.
    if (decision === 'deny') {
      await manager.revokeApproved(this.deps.project_slug, tool_name)
      // A deny is a STOP, and a stop that leaves the subprocess running is not one.
      await this.announceRevocation()
    }
    // READ AFTER THE REVOKE: the idempotency checks below must see post-revoke state,
    // or a deny arriving twice would short-circuit on its own first `denied` row while
    // an approval opened in between stayed in force.
    const rows = manager.findByToolName(this.deps.project_slug, tool_name)
    // Already decided for THIS exact spec: report success rather than an error. A
    // double-tap, or two clients open on the same row, must not read as a failure —
    // the state the owner asked for is the state he has.
    if (decision === 'approve' && rows.some((r) => r.status === 'approved' && grantHashOf(r) === hash)) {
      return { ok: true, error: null, servers: await this.list() }
    }
    if (decision === 'deny' && rows.some((r) => r.status === 'denied' && grantHashOf(r) === hash)) {
      return { ok: true, error: null, servers: await this.list() }
    }
    const pending = rows.find((row) => row.status === 'pending' && grantHashOf(row) === hash)
    // `openApproval`, not `requestApproval`: the row has to EXIST before it can be
    // resolved on the next line, and the read side is synchronous so it would not see
    // an un-awaited insert. `openApproval` is `requestApproval` without the
    // wait-for-the-owner half — the same call {@link requestApproval} makes, and for
    // the same reason.
    const id =
      pending?.id ??
      (await manager.openApproval(this.approvalRequestFor(spec))).id
    await manager.respondApproval(
      id,
      decision === 'approve' ? 'approved' : 'denied',
      // WHO decided, not WHERE. `tool_approvals.decided_by` is documented as the
      // user_id of the decider (`migrations/0004_gateway_core.sql`), and the HTTP
      // surface has already resolved the bearer — so passing the instance's project
      // slug wrote a place into a column that means a person, and every MCP decision
      // in the audit trail read as having been made by the box. The slug remains the
      // fallback for a caller with no authenticated actor (there is none in this
      // build's wiring), because an empty decider would be worse than a coarse one.
      decided_by !== undefined && decided_by.trim().length > 0
        ? decided_by.trim()
        : this.deps.project_slug,
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

  /**
   * The `prompt-user` request for one spec. ONE definition, used by the mint in
   * {@link requestApproval} and by the open-and-resolve in {@link decide}, so the two
   * cannot come to disagree about what a grant records.
   */
  private approvalRequestFor(spec: OwnerMcpServerSpec): {
    project_slug: string
    topic_id: null
    tool_name: string
    policy: 'prompt-user'
    args: Record<string, unknown>
  } {
    return {
      project_slug: this.deps.project_slug,
      topic_id: null,
      tool_name: mcpServerApprovalToolName(spec.name),
      policy: 'prompt-user',
      args: {
        server: spec.name,
        grant_hash: computeMcpServerGrantHash(spec),
        command: spec.command,
        args: [...spec.args],
        env_names: [...spec.env_names],
      },
    }
  }

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
    // `openApproval`, AWAITED — not `fireAndForget(requestApproval(...))`.
    //
    // `requestApproval` returns a promise that resolves only when the OWNER answers —
    // minutes to never — so it cannot be awaited from an HTTP request, and it was
    // therefore fired and forgotten. But the INSERT it performs is the state every
    // caller here goes on to READ: `install` and `decide` both finish with
    // `await this.list()`, and the read side (`findByToolName`) is a SYNCHRONOUS
    // `prepare().all()` that bypasses the db mutex the INSERT goes through. So the row
    // was only present by the time the reply was built when the mutex happened to be
    // idle — and it is not always idle. Reproduced: an EDIT takes the
    // `await manager.cancelPending(...)` branch above, which is a yield AFTER this
    // method's own writes and BEFORE the INSERT, and a foreign writer taking the mutex
    // at that instant put the INSERT behind itself. `install` then answered with the
    // server as `unapproved` — fail-closed, and the Approve control still renders, but
    // the label said "Not approved" for a server that had in fact just asked, and the
    // Deny button (rendered only for `pending`) was missing.
    //
    // `openApproval` is `requestApproval` MINUS the wait-for-the-owner half: it inserts
    // the row, fires the notifier, and resolves. Awaiting it is exactly the use its own
    // docblock names, and it is what `decide` already does. Nothing here ever consumed
    // the discarded waiter promise — this store reads the durable row, and the settings
    // surface is the delivery channel — so dropping it removes a never-resolving promise
    // rather than a behaviour.
    //
    // (There is no TTL sweep running in this build: `expireStale` has no production
    // caller, so a prompt nobody answers simply stays pending until it is decided,
    // replaced by an edit, or cancelled by an uninstall. That is why `decide` can open
    // and resolve a grant itself rather than relying on a sweep to clear a stale one.)
    await manager.openApproval(this.approvalRequestFor(spec))
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

  /**
   * This server's stored env values, or `{}` when they cannot be read.
   *
   * Synchronous, like `ProjectCredentialStore.resolve` itself (prepare/get + decrypt).
   *
   * ── THE DECRYPT IS INSIDE THE TRY, AND THAT IS THE WHOLE POINT ──────────────
   * `resolve` DECRYPTS INLINE (`project-credentials/store.ts` → `decryptEnvelope`),
   * and an envelope that is malformed, truncated, or written under a key this box no
   * longer holds THROWS from AES-GCM tag verification. It was outside the `try`, so
   * one unreadable `mcp_env.*` row did not fail that server closed — it threw out of
   * `readSecrets`, out of `list()` and `resolveApproved()`, and therefore out of the
   * Settings GET (500), out of `remove()` (which lists), and out of every chat turn's
   * spawn resolve. The owner could not even uninstall the offending server: the fault
   * was on the read path he needed in order to delete it. A store whose header
   * promises to "fail closed on a state that should be impossible" cannot express
   * that promise as an unhandled throw, and this class deliberately handles a
   * malformed approval row the same way (see `grantHashOf`).
   *
   * Every failure mode therefore lands on the same answer — NO SECRETS — which
   * `resolveApproved` already treats as "declared env var missing → do not start this
   * server", and which it already logs. Fail-closed, visible, and recoverable: the
   * server shows in Settings as installed with its secrets missing, and re-entering
   * them (or uninstalling) rewrites the row.
   */
  private readSecrets(name: string): Record<string, string> {
    try {
      const resolved = this.deps.credentials.resolve(
        this.deps.owner_slug,
        '',
        mcpServerEnvService(name),
      )
      if (resolved === null) return {}
      const parsed = JSON.parse(resolved.plaintext) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
      }
      return out
    } catch {
      // An undecryptable envelope or a corrupt blob is "no secrets", which fails the
      // server closed. The message names the server and never the payload — no
      // ciphertext, no plaintext, no error detail that could carry either.
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
