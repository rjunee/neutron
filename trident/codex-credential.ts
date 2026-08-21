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

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import type { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import type { CredentialScope } from '@neutronai/project-credentials/store.ts'
import type { OwnerHandle } from '@neutronai/persistence/index.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import {
  codexProbeSubject,
  codexProjectHome,
  deriveCodexStatus,
  materializeCodexAuth,
  readAccountId,
  readMaterializedAuth,
  removeCodexAuth,
  validateCodexSubscriptionAuth,
  type CodexProbeVerdict,
  type CodexStatusDetail,
} from './codex-auth.ts'
import { probeCodexSeat, type CodexProbeDeps, type CodexProbeOutcome } from './codex-probe.ts'
import {
  DEFAULT_SLOT,
  isCooling,
  normalizeSlot,
  selectNextSlot,
  shouldHarvestBack,
  signalToCooldown,
} from './codex-rotation.ts'
import { harvestNewestRollout } from './codex-rotation-io.ts'
import type { CodexRotationStore, SlotRecord } from './codex-rotation-store.ts'

/** The reserved `project_credentials.service` name for the Codex OAuth bundle. */
export const CODEX_CREDENTIAL_SERVICE = 'codex'

/**
 * Service-name prefix for the SECOND and subsequent seats.
 *
 * The first seat deliberately keeps the bare `codex` service name and the bare
 * `<owner_home>/.codex` directory. That is what makes a one-account install
 * byte-identical after this change and is why no migration and no feature flag
 * are needed: rotation always runs, and with a single slot it trivially selects
 * the same credential in the same place it has always been.
 *
 * Dashes are legal here — the store's service grammar is `[a-z0-9_.-]`.
 */
export const CODEX_ACCOUNT_SERVICE_PREFIX = 'codex-acct-'

/** The `project_credentials.service` name backing a slot. */
export function codexSlotService(slot: string): string {
  return slot === DEFAULT_SLOT ? CODEX_CREDENTIAL_SERVICE : `${CODEX_ACCOUNT_SERVICE_PREFIX}${slot}`
}

/**
 * The liveness-cache key for a PER-PROJECT override.
 *
 * Prefixed so it can never collide with a slot id: slot ids are slugs
 * (`[a-z0-9][a-z0-9-]*`) and cannot contain `:`, so no project can be mistaken
 * for a seat in the rotation pool — which matters because an override is
 * deliberately out of rotation and must never be cooled by seat bookkeeping.
 */
export function projectSeatKey(project_id: string): string {
  return `project:${project_id}`
}

/** The slot a service name belongs to, or null when it is not a codex seat. */
export function codexServiceSlot(service: string): string | null {
  if (service === CODEX_CREDENTIAL_SERVICE) return DEFAULT_SLOT
  if (!service.startsWith(CODEX_ACCOUNT_SERVICE_PREFIX)) return null
  return normalizeSlot(service.slice(CODEX_ACCOUNT_SERVICE_PREFIX.length))
}

/**
 * Is `name` an executable on PATH?
 *
 * PATH IS SCANNED IN-PROCESS rather than shelled out to. The callers ask per request
 * (the settings pane must un-grey without a restart), and `command -v` per request is
 * a subprocess per request for a question a directory read answers.
 *
 * `env` is passed rather than read from `process.env` so the caller decides which
 * environment the answer is about — the same one the build will be launched with.
 */
export function executableOnPath(
  env: Record<string, string | undefined>,
  name: string,
): boolean {
  const path = env['PATH']
  if (typeof path !== 'string' || path === '') return false
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue
    try {
      const candidate = join(dir, name)
      // X_OK, not merely "the name exists": a non-executable file called `codex` is
      // not a CLI, and `execvp` would skip it exactly the way this does.
      accessSync(candidate, constants.X_OK)
      // …AND A REGULAR FILE. `X_OK` on a DIRECTORY means "searchable", which every
      // normal directory is — so a PATH entry containing a subdirectory named `codex`
      // (a checkout, a cache) passed the check above and un-greyed every codex tier on
      // a box with no CLI at all. `execvp` returns EACCES on a directory; `statSync`
      // follows symlinks, so a symlink to the real binary still counts.
      if (statSync(candidate).isFile()) return true
    } catch {
      // Not here, not executable, or not stat-able. Keep looking — an unreadable
      // directory on PATH must not decide the answer for the ones after it.
    }
  }
  return false
}

/**
 * Is the `codex` CLI on PATH — the SECOND of the three things a codex build needs.
 *
 * A CREDENTIAL IS NOT ENOUGH. `trident/codex-build.sh` exits 10 with no credential
 * and 11 with no CLI, and the two failures are indistinguishable downstream: a build
 * that never happened. A settings pane that greyed on the credential alone would
 * offer a codex tier on a box where `codex` was never installed, and the owner would
 * discover it as a build that stopped rather than as a disabled option with a reason.
 */
export function codexCliOnPath(env: Record<string, string | undefined>): boolean {
  return executableOnPath(env, 'codex')
}

/**
 * Is `perl` on PATH — the THIRD, and the one an availability check keeps forgetting.
 *
 * `trident/codex-build.sh` bounds EVERY network call with `perl -e 'alarm N; exec …'`
 * and recomputes the brief's checksum with it, so it refuses up front (exit 3,
 * `CODEX_BUILD_NO_PERL`) on a host that has none. Alpine and the `-slim` Debian images
 * are exactly that host. Gating the pane on credential + CLI alone advertised a codex
 * tier that deterministically dies at dispatch on those boxes — the same
 * "selectable but unwired" shape the CLI check was added to close, one precondition
 * further along.
 */
export function codexBuildPerlOnPath(env: Record<string, string | undefined>): boolean {
  return executableOnPath(env, 'perl')
}

/**
 * Whether the codex executor can run on this install — and WHEN IT CANNOT, WHY, in
 * the words the owner is shown.
 *
 * NOT A BOOLEAN, and the reason is a bug this shape makes unrepresentable. The check
 * grew from one condition to three while the owner-facing string stayed "needs a Codex
 * connection", so a box with a healthy login and no CLI sent the owner to a
 * `codex login` that would change nothing. Carrying the reason WITH the answer means
 * the only way to report unavailable is to name the missing piece.
 *
 * ONE FUNCTION rather than a condition in the composer, so the decision is testable
 * against a real PATH instead of only assertable as a source substring — this is the
 * gate that decides whether a tier is offered, and offering one that dies at dispatch
 * is worse than greying it.
 *
 * THE ORDER IS WHAT THE OWNER FIXES FIRST. A box missing all three is told about the
 * credential, because connecting is the step they came to do; the next load names the
 * next missing piece.
 */
export type CodexAvailability = { usable: true } | { usable: false; reason: string }

export function codexExecutorAvailability(opts: {
  /** The resolved `CODEX_HOME` for this owner, or null when codex was never connected. */
  codexHome: string | null
  /** The environment the BUILD will be launched with — its PATH is the one that counts. */
  env: Record<string, string | undefined>
  /**
   * Whether EVERY connected seat has been probed and refused server-side
   * (`CodexCredentialService.everySeatRevoked`). Optional and defaulting to
   * false, so a caller that cannot answer the question behaves exactly as before.
   *
   * A FOURTH CONDITION, not a rewrite of the first: `codexHome` being non-null
   * says a credential EXISTS, which is a different fact from the credential
   * WORKING — and the gap between those two is measured at ~15 minutes of a
   * lane's life, spent assembling a brief for a build that cannot start.
   *
   * ONLY EVER SET FROM A POSITIVE PROBE VERDICT. An unreachable endpoint, a 5xx
   * and a 429 all leave it false, because greying every codex tier on a box that
   * briefly lost its network would be a worse outage than the one this fixes.
   */
  seatsRevoked?: boolean
}): CodexAvailability {
  if (opts.codexHome === null) return { usable: false, reason: 'needs a Codex connection' }
  if (!codexCliOnPath(opts.env)) {
    return { usable: false, reason: 'needs the Codex CLI installed on this machine' }
  }
  if (!codexBuildPerlOnPath(opts.env)) {
    return { usable: false, reason: 'needs perl installed on this machine' }
  }
  if (opts.seatsRevoked === true) {
    return {
      usable: false,
      reason:
        'the connected Codex seat was REVOKED server-side — reconnect it (re-run `codex login` ' +
        'and paste the fresh auth.json); waiting will not fix it',
    }
  }
  return { usable: true }
}

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
  /** Rotation bookkeeping for multi-seat installs. Required, not optional: an
   *  optional rotation store would mean two selection paths, and the one with no
   *  rotation is the one that silently stops rotating. */
  rotation: CodexRotationStore
  now?: () => number
  /** Structured log sink. Used to SURFACE exhaustion — a pool where every seat is
   *  capped must be loud, because the alternative is a review that quietly runs
   *  without its cross-model seat. Values are scalars only, matching the logger's
   *  own field type, so nothing here can ever serialize a credential object. */
  log?: (event: string, fields: Record<string, string | number | boolean | null | undefined>) => void
  /**
   * The LIVE seat probe. Injected in tests; production uses `probeCodexSeat`.
   *
   * Injected as a whole function rather than as a `fetch` so a test can assert on
   * CALL COUNT (the TTL cache is only real if two status reads make one request)
   * without standing up an HTTP server for every case.
   */
  probe?: (input: { accessToken: string; expInFuture: boolean }, deps?: CodexProbeDeps) => Promise<CodexProbeOutcome>
}

/**
 * Shortest gap between two usage scans of the same seat.
 *
 * The harvest is filesystem work on a synchronous path that a read-only status
 * request reaches as well as a run launch. Runs are minutes apart and a rollout
 * is only written while a run is in flight, so a scan more often than this can
 * only re-read the same bytes.
 */
export const HARVEST_MIN_INTERVAL_MS = 60_000

/**
 * Shortest gap between two LIVE probes of the same seat.
 *
 * Same reasoning as {@link HARVEST_MIN_INTERVAL_MS} and the same number, but the
 * cost being throttled is a NETWORK round-trip rather than a directory walk. The
 * settings pane polls codex status; without this, every poll would put one
 * request per seat on chatgpt.com — which is both rude and a way to earn the 429
 * the probe is supposed to be able to distinguish.
 */
export const SEAT_LIVENESS_TTL_MS = 60_000

/** A cached probe verdict and when it was taken. */
interface LivenessEntry {
  verdict: CodexProbeVerdict
  at: number
}

/** One seat as the owner sees it. Never carries token material. */
export interface CodexAccountSummary {
  slot: string
  label: string | null
  status: CodexStatusDetail['status']
  materialized: boolean
  cooling: boolean
  cooling_until: number | null
  cooling_reason: string | null
  used_percent: number | null
  window_minutes: number | null
  resets_at: number | null
  plan_type: string | null
  last_run_at: number | null
  /** Whether this is the seat the next run will use. */
  active: boolean
}

export class CodexCredentialService {
  /**
   * One in-flight `connectAccount` per owner, serialized.
   *
   * The duplicate-account guard reads the existing seats and THEN writes the new
   * one. Two connects for the same ChatGPT account under different seat names can
   * both pass the read before either reaches `store.set`, so both succeed and
   * create exactly the mutually-revoking pair the guard exists to prevent — a
   * check-then-act race, and the damage is unrecoverable without a fresh
   * `codex login` on both machines.
   *
   * A double-click on "Add seat" is enough to hit it, so this is not theoretical
   * even on a single-owner instance. An in-process chain is sufficient because a
   * Neutron instance is one process per owner; it is NOT a distributed lock and
   * does not pretend to be.
   */
  private readonly connectChain = new Map<string, Promise<unknown>>()
  private readonly store: ProjectCredentialStore
  private readonly codexHome: string
  private readonly rotation: CodexRotationStore
  private readonly now: () => number
  private readonly log: (
    event: string,
    fields: Record<string, string | number | boolean | null | undefined>,
  ) => void

  private readonly probe: (
    input: { accessToken: string; expInFuture: boolean },
    deps?: CodexProbeDeps,
  ) => Promise<CodexProbeOutcome>
  /**
   * The last probe verdict per seat, keyed `<owner>|<seat key>`.
   *
   * IN-PROCESS AND DELIBERATELY NOT PERSISTED. The durable half of a `revoked`
   * verdict is the `unauthorized` cooldown this writes into the rotation store —
   * a state that already exists, already survives a restart, and is already
   * cleared only by a reconnect. Persisting the cache too would be a second
   * source of truth for the same fact, and the two would disagree the first time
   * one was written without the other.
   */
  private readonly liveness = new Map<string, LivenessEntry>()
  /**
   * One in-flight probe per seat. Two concurrent readers (the polled pane and an
   * agent's `codex_status`) must not both put a request on the wire for the same
   * token — the TTL check alone cannot stop that, because neither has written a
   * verdict yet when the second one checks.
   */
  private readonly livenessInflight = new Map<string, Promise<void>>()

  constructor(deps: CodexCredentialServiceDeps) {
    this.store = deps.store
    this.codexHome = deps.codexHome
    this.rotation = deps.rotation
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
    this.probe = deps.probe ?? probeCodexSeat
  }

  /** The CODEX_HOME dir for a given scope/project (global default or override). */
  private homeFor(scope: CredentialScope, project_id: string): string {
    return scope === 'project' ? codexProjectHome(this.codexHome, project_id) : this.codexHome
  }

  /**
   * The directory a seat's bundle lives in, for its whole life.
   *
   * The first seat keeps `<owner_home>/.codex` unchanged; the others get
   * `<owner_home>/.codex/accounts/<slot>`. `accounts/` cannot collide with the
   * per-project override tree, which is `projects/<project_id>`.
   *
   * A SEAT IS NEVER MOVED OR COPIED BETWEEN DIRECTORIES. The codex CLI rotates
   * the refresh token when it refreshes, so two live directories holding one
   * account revoke each other. Selection is a pointer at one of these dirs and
   * nothing more.
   */
  slotHome(slot: string): string {
    return slot === DEFAULT_SLOT ? this.codexHome : join(this.codexHome, 'accounts', slot)
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
  async connect(owner_slug: OwnerHandle, pasted: unknown, target?: CodexTarget): Promise<CodexConnectResult> {
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
  status(owner_slug: OwnerHandle, target?: CodexTarget): CodexStatusResult {
    const project_id = (target?.project_id ?? '').trim()
    const resolved = this.store.resolve(owner_slug, project_id, CODEX_CREDENTIAL_SERVICE)
    const stored = resolved?.plaintext ?? null
    const scope = resolved?.scope ?? null
    const home = scope === 'project' ? codexProjectHome(this.codexHome, project_id) : this.codexHome
    const materialized = readMaterializedAuth(home) !== null
    // WHICH SEAT THIS READING IS ABOUT. A project override is its own seat and is
    // out of rotation entirely; the global default IS the `default` slot's row
    // (`codexSlotService(DEFAULT_SLOT) === CODEX_CREDENTIAL_SERVICE`), so the two
    // paths share one cache entry rather than probing the same token twice.
    const seat = scope === 'project' ? projectSeatKey(project_id) : DEFAULT_SLOT
    // The in-process cache OR the durable cooldown. The cooldown is what survives
    // a gateway restart, so a seat probed dead an hour ago still reads `revoked`
    // instead of quietly reverting to `connected` the moment the TTL lapses.
    const cooledUnauthorized =
      scope !== 'project' &&
      this.rotation.listSlots(owner_slug).some((s) => s.slot === seat && s.cooling_reason === 'unauthorized')
    const cached = this.cachedVerdict(owner_slug, seat)
    const probe: CodexProbeVerdict = cooledUnauthorized ? 'revoked' : cached
    // A project-override ROW (expired or not) — so the UI can always remove a
    // stale override even when the resolver has fallen back to the global default.
    const override_present =
      project_id.length > 0 &&
      this.store.getMeta(owner_slug, project_id, CODEX_CREDENTIAL_SERVICE) !== null
    return {
      ...deriveCodexStatus(stored, { materialized, now: this.now, probe }),
      scope,
      ...(project_id.length > 0 ? { override_present } : {}),
    }
  }

  /**
   * ASK THE SERVER whether each connected seat's token still works, and remember
   * the answer for {@link SEAT_LIVENESS_TTL_MS}.
   *
   * ── WHY THIS IS ASYNC AND EVERYTHING THAT READS IT IS NOT ───────────────────
   * `resolveActiveCodexHome` is SYNCHRONOUS BY CONTRACT — the orchestrator calls
   * it at fire time and `buildRunCodexHomeResolver` returns `string | null`, not a
   * promise. Awaiting a network call there would ripple into
   * `trident/orchestrator.ts` and is the one change in this area that could take
   * down every build. So the probe is a SIDE CHANNEL: it runs async, and the fact
   * it discovers is written into the `unauthorized` cooldown — an EXISTING state
   * that never expires on a TIMER and which every synchronous path can already
   * read. It is withdrawn by evidence, not by the clock: a reconnect clears it,
   * and so does a later `ok` from this same probe (see `retractRevocation`).
   *
   * NEVER THROWS and never rejects: it is awaited on a read-only status path and
   * fired-and-forgotten elsewhere.
   */
  async refreshSeatLiveness(owner_slug: OwnerHandle, target?: CodexTarget): Promise<void> {
    const jobs: Array<Promise<void>> = []
    const project_id = (target?.project_id ?? '').trim()
    if (project_id.length > 0) {
      const resolved = this.store.resolve(owner_slug, project_id, CODEX_CREDENTIAL_SERVICE)
      // Only a REAL override is a separate seat; a fallback to the global default
      // is the `default` slot, probed by the loop below.
      if (resolved !== null && resolved.scope === 'project') {
        const home = codexProjectHome(this.codexHome, project_id)
        jobs.push(
          this.probeSeat(owner_slug, projectSeatKey(project_id), this.liveAuthFor(home, resolved.plaintext), null),
        )
      }
    }
    for (const seat of this.syncSlots(owner_slug)) {
      const stored = this.store.resolve(owner_slug, undefined, codexSlotService(seat.slot))
      if (stored === null) continue
      jobs.push(
        this.probeSeat(
          owner_slug,
          seat.slot,
          this.liveAuthFor(this.slotHome(seat.slot), stored.plaintext),
          seat.slot,
        ),
      )
    }
    await Promise.all(jobs)
  }

  /**
   * WHICH COPY OF THE BUNDLE TO PROBE: the MATERIALIZED one, the file the CLI
   * actually execs against — never the encrypted store copy, when both exist.
   *
   * The two diverge, by design and for days at a time. The CLI rewrites
   * `CODEX_HOME/auth.json` every time it refreshes, and harvest-back into the
   * store is fire-and-forget from inside `resolveActiveCodexHome` (this file's own
   * docblock: the store copy "drifts staler every time the CLI refreshes"). So a
   * seat that is perfectly healthy on disk can hold a SUPERSEDED access token in
   * the store — and a superseded token is exactly the input that yields `revoked`:
   * its `exp` is still in the future, so the clock cannot explain the 401.
   * Probing the store copy would therefore manufacture the one verdict this
   * module must never manufacture.
   *
   * Falls back to the store copy when nothing is materialized (a fresh box that
   * has connected but not yet resolved a CODEX_HOME), which is the only case where
   * the store copy IS the live copy.
   */
  private liveAuthFor(home: string, storedPlaintext: string): string {
    try {
      return readMaterializedAuth(home) ?? storedPlaintext
    } catch {
      return storedPlaintext
    }
  }

  /**
   * The same refresh, for a SYNCHRONOUS caller (the settings pane's availability
   * closure). Starts the probe, returns immediately, and can never surface as an
   * unhandled rejection.
   */
  kickSeatLiveness(owner_slug: OwnerHandle, target?: CodexTarget): void {
    fireAndForget('codex_seat_liveness', this.refreshSeatLiveness(owner_slug, target))
  }

  /**
   * One seat's probe, TTL-throttled and in-flight-deduplicated.
   *
   * EVERY NON-VERDICT IS STAMPED TOO ('unknown'), which is what stops a wedged or
   * unreachable endpoint from earning one request per poll forever.
   */
  private async probeSeat(
    owner_slug: OwnerHandle,
    seat: string,
    plaintext: string,
    coolSlot: string | null,
  ): Promise<void> {
    const key = `${owner_slug}|${seat}`
    const cached = this.liveness.get(key)
    if (cached !== undefined && this.now() - cached.at < SEAT_LIVENESS_TTL_MS) return
    const running = this.livenessInflight.get(key)
    if (running !== undefined) return running
    // NEVER PROBE A SEAT WITH NOTHING TO PROBE. An unreadable bundle or a missing
    // access token is already `not_connected` from the stored bytes, and a request
    // with no credential could only ever come back 401 — which is exactly the
    // answer that must not be manufactured.
    const subject = codexProbeSubject(plaintext, this.now)
    if (subject === null) return
    const job = (async (): Promise<void> => {
      const outcome = await this.probe(subject)
      const at = this.now()
      if (outcome.kind === 'ok') {
        this.liveness.set(key, { verdict: 'ok', at })
        // THE RETRACTION. Without this line the verdict below is a BRICK: the
        // `unauthorized` cooldown ignores `cooling_until` forever and, before
        // this, was cleared only by a human pasting a fresh auth.json. That was
        // survivable while `unauthorized` could only be written by a code path
        // that already required a human; it is not survivable now that a PASSIVE
        // SETTINGS POLL can write it. A single anomalous 401 — an edge rule, a
        // half-rolled deploy, a token superseded in a race — would otherwise
        // refuse every build on a seat the server is answering 200 for.
        //
        // A verdict that only a human can withdraw is not a safety property, it
        // is an outage with a good excuse. The server just said yes; that is
        // strictly better evidence than a 401 we recorded a minute ago.
        this.retractRevocation(owner_slug, coolSlot, at)
        return
      }
      if (outcome.kind === 'revoked') {
        this.liveness.set(key, { verdict: 'revoked', at })
        if (coolSlot !== null) {
          // THE DURABLE HALF. `unauthorized` is the one cooling reason that
          // ignores `cooling_until` forever — precisely the semantics of a
          // revoked refresh token, already implemented, reused rather than
          // rebuilt. It is cleared by a reconnect (`markConnected`) OR by the
          // `ok` branch above, which is what keeps this a verdict rather than a
          // brick.
          this.rotation.setCooldown(owner_slug, coolSlot, {
            cooling_until: at,
            cooling_reason: 'unauthorized',
          })
        }
        this.log('codex_seat_revoked', {
          slot: coolSlot ?? seat,
          http_status: outcome.httpStatus,
          detail: 'ChatGPT refused this seat’s token though it is not expired; reconnect it',
        })
        return
      }
      // 'unreachable' | 'rate_limited' | 'rejected' | 'expired' — NOT VERDICTS.
      // A dropped packet, a 5xx, a capped seat or a moved endpoint must never
      // disconnect a live subscription, so the stored-bytes reading stays in
      // charge and NOTHING is cooled.
      this.liveness.set(key, { verdict: 'unknown', at })
      if (outcome.kind !== 'expired') {
        this.log('codex_seat_probe_inconclusive', {
          slot: coolSlot ?? seat,
          outcome: outcome.kind,
          ...(outcome.kind === 'unreachable'
            ? { detail: outcome.message }
            : { http_status: outcome.httpStatus }),
        })
      }
    })().catch(() => {
      // The probe is documented never to throw; this is the belt on the braces,
      // because a status read that rejects reports nothing at all.
      this.liveness.set(key, { verdict: 'unknown', at: this.now() })
    })
    this.livenessInflight.set(key, job)
    try {
      await job
    } finally {
      this.livenessInflight.delete(key)
    }
  }

  /**
   * WITHDRAW a probe-written revocation after the server has answered `ok`.
   *
   * ── ONLY THE STATE THIS MODULE WROTE ────────────────────────────────────────
   * Clears the cooldown ONLY when the current reason is `unauthorized`. A
   * `usage`/`error` cooldown is a rotation decision with its own timer and its own
   * evidence, and a liveness probe knows nothing about quota — clearing those
   * would rotate a capped seat straight back into service. This is deliberately
   * the narrowest possible retraction: same state, same seat, better evidence.
   *
   * `cooling_until` is set to `null` rather than a past timestamp because
   * `isCooling` short-circuits on the REASON: an `unauthorized` row with an
   * ancient `cooling_until` still cools forever, so the reason itself is what has
   * to go.
   */
  private retractRevocation(owner_slug: OwnerHandle, coolSlot: string | null, at: number): void {
    if (coolSlot === null) return
    const slot = this.rotation.listSlots(owner_slug).find((s) => s.slot === coolSlot)
    if (slot === undefined || slot.cooling_reason !== 'unauthorized') return
    this.rotation.setCooldown(owner_slug, coolSlot, null)
    this.log('codex_seat_unrevoked', {
      slot: coolSlot,
      at,
      detail: 'ChatGPT accepted this seat’s token again; the unauthorized cooldown was withdrawn',
    })
  }

  /** The cached probe verdict for a seat, or `unknown` when the cache is cold/stale. */
  private cachedVerdict(owner_slug: OwnerHandle, seat: string): CodexProbeVerdict {
    const cached = this.liveness.get(`${owner_slug}|${seat}`)
    if (cached === undefined) return 'unknown'
    // A verdict is only as good as its TTL — past it, fall back to the stored
    // bytes rather than reporting a fact that may be hours old.
    if (this.now() - cached.at >= SEAT_LIVENESS_TTL_MS) return 'unknown'
    return cached.verdict
  }

  /**
   * Is this owner's ACTIVE codex seat known-dead? Synchronous, and the whole
   * point of writing the probe verdict into the cooldown.
   *
   * Reads the DURABLE state (the `unauthorized` cooldown), not the in-process
   * cache, so a gateway that restarted still refuses to spawn a doomed lane.
   * Returns true only when EVERY connected seat is cooled `unauthorized`: one
   * healthy seat in a pool means rotation has somewhere to go.
   */
  everySeatRevoked(owner_slug: OwnerHandle): boolean {
    const slots = this.syncSlots(owner_slug)
    if (slots.length === 0) return false
    return slots.every((s) => s.cooling_reason === 'unauthorized')
  }

  /**
   * Delete the stored credential + remove the materialized auth.json. Defaults to
   * GLOBAL; pass `{ scope: 'project', project_id }` to remove just that project's
   * override (the global default stays). Removing the global default leaves any
   * project overrides intact.
   */
  async disconnect(owner_slug: OwnerHandle, target?: CodexTarget): Promise<{ ok: boolean }> {
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
  resolveActiveCodexHome(owner_slug: OwnerHandle, project_id?: string): string | null {
    // A per-project override wins and is OUT of rotation entirely — it exists
    // precisely to pin one project to one subscription, so rotating it would
    // defeat the feature. This branch runs BEFORE any rotation bookkeeping so
    // nothing about the override can be perturbed by pool state.
    const override = this.store.resolve(owner_slug, project_id, CODEX_CREDENTIAL_SERVICE)
    if (override !== null && override.scope === 'project') {
      const home = codexProjectHome(this.codexHome, project_id)
      this.selfHealAndHarvestBack(owner_slug, CODEX_CREDENTIAL_SERVICE, home, override.plaintext, {
        scope: 'project',
        project_id: project_id ?? '',
      })
      return home
    }

    const slots = this.syncSlots(owner_slug)
    if (slots.length === 0) return null

    const previousActive = this.rotation.getActiveSlot(owner_slug) ?? slots[0]?.slot ?? null
    if (previousActive === null) return null

    // Harvest BEFORE selecting, so a seat that ran itself into its cap during the
    // last run is already cooling by the time this run picks a seat.
    this.harvestSlot(owner_slug, previousActive, slots.find((s) => s.slot === previousActive))

    // SYNC THE SEAT THAT JUST RAN, NOT ONLY THE ONE ABOUT TO RUN. The CLI
    // refreshes `auth.json` during a run, so the bundle that just went stale in
    // the store belongs to the PREVIOUS seat. Harvesting back only the selected
    // seat would leave a rotated-away seat's stored copy frozen at a refresh
    // token the server has already replaced — and since that seat is cooling, it
    // may not be resolved again for a week, leaving the self-heal path holding a
    // dead bundle for exactly as long as it is unable to notice.
    if (previousActive !== null) this.harvestBackOnly(owner_slug, previousActive)

    // Walking rather than taking one shot: the selected seat's credential row can
    // be gone or expired, and returning null then would drop codex from the
    // review while a healthy seat sat next in the ring — failing in the one
    // direction the policy explicitly forbids.
    let candidates = this.rotation.listSlots(owner_slug)
    let from = previousActive
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const selection = selectNextSlot(candidates, from, this.now())
      if (selection === null) return null

      const stored = this.store.resolve(owner_slug, undefined, codexSlotService(selection.slot))
      if (stored === null) {
        // No usable bundle behind this slot. Cool it as `unauthorized` — the one
        // state that does not expire on a timer — so it stops winning selections
        // and the owner is told to reconnect it, then try the next seat.
        this.rotation.setCooldown(owner_slug, selection.slot, {
          cooling_until: this.now(),
          cooling_reason: 'unauthorized',
        })
        this.log('codex_rotation_unusable_seat', {
          slot: selection.slot,
          detail: 'seat has no usable stored credential; reconnect it',
        })
        candidates = this.rotation.listSlots(owner_slug)
        from = selection.slot
        continue
      }

      if (selection.rotated) {
        this.rotation.setActiveSlot(owner_slug, selection.slot, this.now())
        this.log('codex_rotation_rotated', { from: previousActive, to: selection.slot })
      }
      if (selection.exhausted) {
        // Keeping a capped seat beats returning null: a capped seat fails with a
        // legible, retryable error, whereas no seat drops codex out of the review
        // with nothing to point at.
        this.log('codex_rotation_exhausted', {
          slot: selection.slot,
          slot_count: slots.length,
          detail: 'every connected Codex seat is cooling; keeping the current seat',
        })
      }

      const home = this.slotHome(selection.slot)
      this.selfHealAndHarvestBack(owner_slug, codexSlotService(selection.slot), home, stored.plaintext, {
        scope: 'global',
        project_id: '',
      })
      return home
    }
    return null
  }

  /**
   * Push a seat's CLI-refreshed bundle back into the store, WITHOUT materializing.
   *
   * The materialize half of `selfHealAndHarvestBack` is deliberately absent: this
   * runs for a seat that is not being handed to this run, and writing an
   * `auth.json` into a directory nothing is about to use is how a stale bundle
   * gets installed over a live login. Only the disk→store direction is safe for a
   * seat we are walking away from.
   */
  private harvestBackOnly(owner_slug: OwnerHandle, slot: string): void {
    const service = codexSlotService(slot)
    const stored = this.store.resolve(owner_slug, undefined, service)
    if (stored === null) return
    const home = this.slotHome(slot)
    if (readMaterializedAuth(home) === null) return
    this.selfHealAndHarvestBack(owner_slug, service, home, stored.plaintext, {
      scope: 'global',
      project_id: '',
    })
  }

  /**
   * Make the rotation table agree with the credentials that actually exist.
   *
   * This is what removes the need for a migration. An install that has only ever
   * had one seat has a `codex` credential row and no rotation row at all; the
   * first resolve registers it as slot `default` and everything proceeds as
   * before. A slot whose credential was deleted out from under it is dropped, so
   * a stale row can never win a selection and hand back a directory with no
   * bundle in it.
   */
  private syncSlots(owner_slug: OwnerHandle): SlotRecord[] {
    const present = new Set<string>()
    for (const record of this.store.listGlobal(owner_slug)) {
      const slot = codexServiceSlot(record.service)
      if (slot === null) continue
      present.add(slot)
      this.rotation.upsertSlot(owner_slug, slot, record.label ?? null)
    }
    for (const known of this.rotation.listSlots(owner_slug)) {
      if (!present.has(known.slot)) this.rotation.removeSlot(owner_slug, known.slot)
    }
    return this.rotation.listSlots(owner_slug)
  }

  /**
   * Read a seat's own usage off its rollout files and cool it if it is spent.
   *
   * Deliberately silent about failures. `harvestNewestRollout` reports `absent`
   * for a seat that has never run and `error` for a read that failed, and
   * `signalToCooldown` returns null for both — a transient failure must never
   * retire a healthy seat, because cooling one shrinks a pool the owner is paying
   * for and the mistake is invisible.
   */
  private harvestSlot(owner_slug: OwnerHandle, slot: string, record?: SlotRecord): void {
    const now = this.now()
    // THROTTLE. This runs on `resolveActiveCodexHome`, which a read-only HTTP
    // handler reaches as well as a run launch, and the scan touches the
    // filesystem. Runs are minutes apart, so re-scanning more than once a minute
    // can only re-read the same file; skipping cheaply is what keeps a status GET
    // from paying for a directory walk on every poll.
    const last = record?.last_harvest_at ?? null
    if (last !== null && now - last < HARVEST_MIN_INTERVAL_MS) return
    this.rotation.markHarvested(owner_slug, slot, now)

    const home = this.slotHome(slot)
    // Rollouts predating this seat's connect stamp belong to whatever account
    // previously occupied the directory; reading them would cool a brand-new
    // subscription on its predecessor's exhaustion.
    const outcome = harvestNewestRollout(home, now, record?.connected_at ?? 0)
    if (outcome.kind !== 'snapshot') return
    // The window closest to its limit is the one worth showing the owner.
    const worst = [...outcome.snapshot.windows].sort((a, b) => b.used_percent - a.used_percent)[0]
    this.rotation.recordUsage(
      owner_slug,
      slot,
      {
        used_percent: worst?.used_percent ?? null,
        window_minutes: worst?.window_minutes ?? null,
        resets_at: worst?.resets_at_ms ?? null,
        plan_type: outcome.snapshot.plan_type,
      },
      now,
    )
    const cooldown = signalToCooldown(outcome, now)
    if (cooldown !== null) {
      this.rotation.setCooldown(owner_slug, slot, cooldown)
      this.log('codex_rotation_cooled', {
        slot,
        reason: cooldown.cooling_reason,
        cooling_until: cooldown.cooling_until,
        used_percent: worst?.used_percent ?? null,
        window_minutes: worst?.window_minutes ?? null,
      })
    }
  }

  /**
   * Ensure the seat's `auth.json` exists, and push a CLI-refreshed bundle back
   * into the store.
   *
   * Two halves, and the second is why this exists. The write is still
   * only-if-missing: overwriting a file the CLI has refreshed would install an
   * older refresh token, which the server has already rotated away, and kill the
   * seat. The harvest-back is the other direction — when the on-disk bundle is
   * NEWER than the stored one, the store is re-encrypted from disk, so the
   * self-heal path can never one day restore a dead token over a live login.
   * Without it, the store drifts staler every time the CLI refreshes and the
   * self-heal becomes a delayed-action failure.
   */
  private selfHealAndHarvestBack(
    owner_slug: OwnerHandle,
    service: string,
    home: string,
    storedPlaintext: string,
    target: { scope: CredentialScope; project_id: string },
  ): void {
    const onDisk = readMaterializedAuth(home)
    if (onDisk === null) {
      materializeCodexAuth({ codexHome: home, authJson: storedPlaintext })
      return
    }
    let diskRefresh: unknown
    let storedRefresh: unknown
    try {
      diskRefresh = (JSON.parse(onDisk) as { last_refresh?: unknown }).last_refresh
      storedRefresh = (JSON.parse(storedPlaintext) as { last_refresh?: unknown }).last_refresh
    } catch {
      return
    }
    if (!shouldHarvestBack(diskRefresh, storedRefresh)) return
    const validated = validateCodexSubscriptionAuth(onDisk, this.now)
    if (!validated.ok || validated.normalized === undefined) return
    // Fire-and-forget: the resolver is synchronous by contract (the orchestrator
    // calls it at fire time) and a failed re-encrypt must not fail a run — the
    // stored copy simply stays stale until the next resolve tries again.
    // Carry the EXISTING label through. The store's upsert overwrites `label` on
    // conflict, so passing null here would erase the name the owner connected the
    // seat under and leave it anonymous in every generic credential view — a
    // silent cosmetic regression on a path that runs on its own schedule.
    const existingLabel =
      this.store.getMeta(owner_slug, target.project_id, service)?.label ?? null
    fireAndForget(
      'codex_credential_harvest_back',
      this.store
        .set(owner_slug, {
          service,
          plaintext: validated.normalized,
          scope: target.scope,
          project_id: target.project_id,
          label: existingLabel,
          expires_at: null,
        })
        .then(() => {
          // Length only — never the bundle, and never any field of it.
          this.log('codex_credential_harvested_back', {
            service,
            bytes: validated.normalized?.length ?? 0,
          })
        }),
      (err: unknown) => {
        this.log('codex_credential_harvest_back_failed', {
          service,
          error: err instanceof Error ? err.message : String(err),
        })
      },
    )
  }

  /**
   * Connect a seat. With no slot, or slot `default`, this IS the legacy
   * `connect` path — same service name, same directory, same stored bytes — which
   * is what keeps a single-account install unchanged.
   */
  /**
   * The seat already holding the SAME ChatGPT account as `pasted`, or null.
   *
   * Compares `tokens.account_id`, which the normalizer preserves. A bundle with no
   * `account_id` cannot be compared, so it is allowed through rather than refused:
   * blocking every unidentifiable bundle would make a legitimate second seat
   * impossible on any CLI version that omits the field, which is a worse failure
   * than the one being prevented. The seat being (re)connected is excluded — a
   * reconnect of the same account into its OWN seat is the normal repair path.
   */
  private async findSeatWithSameAccount(
    owner_slug: OwnerHandle,
    pasted: unknown,
    requested: string,
  ): Promise<string | null> {
    const v = validateCodexSubscriptionAuth(pasted, this.now)
    if (!v.ok || v.normalized === undefined) return null
    const incoming = readAccountId(v.normalized)
    if (incoming === null) return null
    // SYNC FIRST — a rotation row is not proof a seat exists, and its ABSENCE is
    // not proof one does not. `syncSlots` re-derives the seat list from the
    // persisted `project_credentials` rows, which is where a seat actually lives.
    // On an upgraded install the legacy `codex` credential predates rotation
    // entirely, so `listSlots` answers EMPTY while the credential is real and in
    // use — and this guard, scanning nothing, would happily let the same ChatGPT
    // account in under a named seat and create the mutually-revoking pair it
    // exists to prevent. Asking the wrong store for existence is the whole defect.
    for (const seat of this.syncSlots(owner_slug)) {
      if (seat.slot === requested) continue
      const stored = this.store.resolve(owner_slug, undefined, codexSlotService(seat.slot))
      if (stored === null) continue
      if (readAccountId(stored.plaintext) === incoming) return seat.slot
    }
    return null
  }

  async connectAccount(
    owner_slug: OwnerHandle,
    pasted: unknown,
    opts?: { slot?: string; label?: string | null },
  ): Promise<CodexConnectResult & { slot?: string }> {
    // Serialize per owner so the duplicate check and the write that follows it
    // cannot interleave with another connect. Chained rather than locked: the
    // previous call's REJECTION must not poison the queue, hence the catch.
    const key = String(owner_slug)
    const prior = this.connectChain.get(key) ?? Promise.resolve()
    // `.catch` before chaining: a PREVIOUS call's rejection must not poison the
    // queue for everyone behind it.
    const run = prior
      .catch(() => undefined)
      .then(() => this.connectAccountSerialized(owner_slug, pasted, opts))
    const tail = run.catch(() => undefined)
    this.connectChain.set(key, tail)
    try {
      return await run
    } finally {
      // Only the LAST caller clears the entry, so the map cannot grow for the life
      // of the process and a queued caller cannot lose its predecessor.
      if (this.connectChain.get(key) === tail) this.connectChain.delete(key)
    }
  }

  private async connectAccountSerialized(
    owner_slug: OwnerHandle,
    pasted: unknown,
    opts?: { slot?: string; label?: string | null },
  ): Promise<CodexConnectResult & { slot?: string }> {
    const requested = opts?.slot === undefined || opts.slot === null ? DEFAULT_SLOT : normalizeSlot(opts.slot)
    if (requested === null) {
      return {
        ok: false,
        mode: 'unknown',
        code: 'invalid_account',
        error: `account must be 1-32 chars of lowercase letters, digits and dashes, starting with a letter or digit`,
      }
    }
    // ONE CHATGPT ACCOUNT MUST NOT OCCUPY TWO SEATS. The dir-per-account design
    // prevents a bundle being COPIED by the code, and its docblock says so — but
    // the copy that matters is made by the OWNER, not by us. Both clients tell him
    // to "run `codex login` on any machine and paste that account's auth.json", so
    // pasting his laptop's file and then his desktop's is the documented happy path
    // and lands ONE account in two seats. The CLI rotates refresh tokens on every
    // refresh, so the first refresh in each seat revokes the other: both die,
    // `resolveActiveCodexHome` cools each of them `unauthorized` (the one state
    // that never expires on a timer), and cross-model review is silently gone until
    // he notices. That is ISSUES #573 re-created through the UI.
    //
    // The discriminator was already on hand and unused: `validateCodexSubscriptionAuth`
    // carries `tokens.account_id` into the normalized bundle. Refusing here is the
    // only place it can be refused — once both bundles are on disk the damage is
    // already done, and neither seat can tell which of them was the interloper.
    const dup = await this.findSeatWithSameAccount(owner_slug, pasted, requested)
    if (dup !== null) {
      return {
        ok: false,
        mode: 'subscription',
        code: 'duplicate_account',
        error:
          `that ChatGPT account is already connected as seat '${dup}'. Connecting one account ` +
          `twice makes each copy revoke the other's refresh token, so BOTH seats stop working. ` +
          `Use a different ChatGPT account for this seat, or remove '${dup}' first.`,
        slot: requested,
      }
    }
    if (requested === DEFAULT_SLOT) {
      const result = await this.connect(owner_slug, pasted)
      if (result.ok) {
        this.rotation.upsertSlot(owner_slug, DEFAULT_SLOT, opts?.label ?? null)
        // THE FIRST SEAT RECONNECTS LIKE EVERY OTHER SEAT. This branch delegates
        // to the legacy `connect` for byte-identical storage, and that is exactly
        // why the rotation bookkeeping has to be repeated here — `connect` knows
        // nothing about cooldowns. Without this, pasting a fresh bundle into the
        // first seat left its old cooldown standing, so the seat the owner had
        // just fixed went on being skipped until a timer he could not see expired.
        this.rotation.markConnected(owner_slug, DEFAULT_SLOT, this.now())
      }
      return { ...result, slot: DEFAULT_SLOT }
    }
    const v = validateCodexSubscriptionAuth(pasted, this.now)
    if (!v.ok || v.normalized === undefined) {
      return {
        ok: false,
        mode: v.mode,
        ...(v.code !== undefined ? { code: v.code } : {}),
        ...(v.error !== undefined ? { error: v.error } : {}),
        slot: requested,
      }
    }
    await this.store.set(owner_slug, {
      service: codexSlotService(requested),
      plaintext: v.normalized,
      scope: 'global',
      project_id: '',
      label: opts?.label ?? `ChatGPT subscription (codex seat '${requested}')`,
      expires_at: null,
    })
    const { path } = materializeCodexAuth({ codexHome: this.slotHome(requested), authJson: v.normalized })
    this.rotation.upsertSlot(owner_slug, requested, opts?.label ?? null)
    // A reconnect is the ONLY thing that clears an `unauthorized` cooldown, since
    // a revoked refresh token does not heal by waiting. It also stamps the seat
    // so the harvest ignores the previous occupant's rollouts.
    this.rotation.markConnected(owner_slug, requested, this.now())
    const status = deriveCodexStatus(v.normalized, { materialized: true, now: this.now })
    return { ok: true, mode: 'subscription', status: status.status, scope: 'global', path, slot: requested }
  }

  /** Every connected seat, with cooldowns and last-known usage. No secrets. */
  listAccounts(owner_slug: OwnerHandle): CodexAccountSummary[] {
    const slots = this.syncSlots(owner_slug)
    const now = this.now()
    const selection = selectNextSlot(slots, this.rotation.getActiveSlot(owner_slug), now)
    return slots.map((s) => {
      const home = this.slotHome(s.slot)
      const stored = this.store.resolve(owner_slug, undefined, codexSlotService(s.slot))
      const materialized = readMaterializedAuth(home) !== null
      const derived = deriveCodexStatus(stored?.plaintext ?? null, {
        materialized,
        now: this.now,
        // A seat cooled `unauthorized` is reported REVOKED even after the
        // in-process cache has aged out: the cooldown is the durable record of
        // the probe, and it outlives both the TTL and the process.
        probe:
          this.cachedVerdict(owner_slug, s.slot) === 'revoked' || s.cooling_reason === 'unauthorized'
            ? 'revoked'
            : this.cachedVerdict(owner_slug, s.slot),
      })
      return {
        slot: s.slot,
        label: s.label,
        status: derived.status,
        materialized,
        cooling: isCooling(s, now),
        cooling_until: s.cooling_until,
        cooling_reason: s.cooling_reason,
        used_percent: s.usage.used_percent,
        window_minutes: s.usage.window_minutes,
        resets_at: s.usage.resets_at,
        plan_type: s.usage.plan_type,
        last_run_at: s.last_run_at,
        active: selection !== null && selection.slot === s.slot,
      }
    })
  }

  /** Which seat the next run will use, or null when none is connected. */
  nextSlot(owner_slug: OwnerHandle): { slot: string; exhausted: boolean } | null {
    const slots = this.syncSlots(owner_slug)
    const selection = selectNextSlot(slots, this.rotation.getActiveSlot(owner_slug), this.now())
    if (selection === null) return null
    return { slot: selection.slot, exhausted: selection.exhausted }
  }

  /**
   * Disconnect EVERY seat. This is what an unqualified "Disconnect Codex" means.
   *
   * The shipped web and mobile clients send a DELETE with no account from a
   * single button labelled "Disconnect Codex". Removing only the first seat there
   * would leave every named seat stored, materialized and still selectable by
   * trident — the owner told the instance to stop using Codex and it would keep
   * using Codex, from a credential the UI no longer showed him. Disconnecting all
   * of them is the only reading of that button that matches what it says.
   *
   * Per-project overrides are NOT touched: they are addressed by their own scope
   * and are not part of the global seat pool.
   */
  async disconnectAllAccounts(owner_slug: OwnerHandle): Promise<{ ok: boolean; removed: string[] }> {
    const removed: string[] = []
    for (const slot of this.connectedSlots(owner_slug)) {
      const { ok } = await this.removeAccount(owner_slug, slot)
      if (ok) removed.push(slot)
    }
    return { ok: removed.length > 0, removed }
  }

  /** Slot ids that currently have a global credential row, first seat included. */
  private connectedSlots(owner_slug: OwnerHandle): string[] {
    const slots = new Set<string>()
    for (const record of this.store.listGlobal(owner_slug)) {
      const slot = codexServiceSlot(record.service)
      if (slot !== null) slots.add(slot)
    }
    for (const known of this.rotation.listSlots(owner_slug)) slots.add(known.slot)
    return [...slots]
  }

  /** Disconnect one seat: delete its credential and remove its `auth.json`. */
  async removeAccount(owner_slug: OwnerHandle, slot: string): Promise<{ ok: boolean }> {
    const normalized = normalizeSlot(slot)
    if (normalized === null) return { ok: false }
    const removed = await this.store.delete(owner_slug, '', codexSlotService(normalized))
    removeCodexAuth(this.slotHome(normalized))
    this.rotation.removeSlot(owner_slug, normalized)
    return { ok: removed }
  }

  /**
   * Boot/self-heal for the GLOBAL default: if a global credential is stored but
   * the global CODEX_HOME file is missing (fresh process / new worktree / wiped
   * tmp), re-materialize it. Returns true when a file is present afterwards. Safe
   * to call unconditionally at wiring. (Per-project overrides self-heal lazily in
   * `resolveActiveCodexHome`.)
   */
  ensureMaterialized(owner_slug: OwnerHandle): boolean {
    if (readMaterializedAuth(this.codexHome) !== null) return true
    // Global-only lookup (project_id undefined → the resolver consults only the
    // global default), so a stray project override never materializes here.
    const resolved = this.store.resolve(owner_slug, undefined, CODEX_CREDENTIAL_SERVICE)
    if (resolved === null) return false
    materializeCodexAuth({ codexHome: this.codexHome, authJson: resolved.plaintext })
    return true
  }
}

/**
 * THE PRODUCTION `resolve_codex_home` CLOSURE, named and exported so it can be
 * TESTED — which is the whole reason it is not written inline at the wiring site
 * any more.
 *
 * On 2026-08-13 the inline version read:
 *
 *     resolve_codex_home: (run) =>
 *       svc.resolveActiveCodexHome(asOwnerHandle(run.project_slug))
 *
 * and it took every build on the instance down. The credential is stored against
 * the INSTANCE OWNER (`project_credentials.owner_slug`); a `TridentRun`'s
 * `project_slug` is the PROJECT the run belongs to. Passing the run's slug as the
 * owner handle LOOKED right — the property name matches the parameter name — and
 * matched no row, so a connected, materialized credential resolved to null and
 * `trident/codex-build.sh` exited 10 NOT_CONNECTED before a line was written.
 *
 * The two identifiers are separated here by TYPE and by POSITION: the owner
 * handle is a branded `OwnerHandle` bound ONCE at composition, and the run only
 * ever supplies a project. There is no argument at this call site for a caller to
 * get in the wrong order.
 *
 * HONEST LIMIT: this does not make the original mistake unrepresentable — a
 * future edit could still inline `asOwnerHandle(run.project_slug)` at the wiring
 * site and every test here would keep passing. What it does is make that edit
 * VISIBLE: it deletes a call to a named, tested factory and re-introduces an
 * `asOwnerHandle(...)` cast over run-scoped data, which is a reviewable diff
 * rather than a silent argument swap.
 */
export function buildRunCodexHomeResolver(
  service: Pick<CodexCredentialService, 'resolveActiveCodexHome'>,
  owner_handle: OwnerHandle,
): (run: { project_slug: string }) => string | null {
  return (run) => service.resolveActiveCodexHome(owner_handle, run.project_slug)
}
