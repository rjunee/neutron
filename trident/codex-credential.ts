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
  codexProjectHome,
  deriveCodexStatus,
  materializeCodexAuth,
  readAccountId,
  readMaterializedAuth,
  removeCodexAuth,
  validateCodexSubscriptionAuth,
  type CodexStatusDetail,
} from './codex-auth.ts'
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
}): CodexAvailability {
  if (opts.codexHome === null) return { usable: false, reason: 'needs a Codex connection' }
  if (!codexCliOnPath(opts.env)) {
    return { usable: false, reason: 'needs the Codex CLI installed on this machine' }
  }
  if (!codexBuildPerlOnPath(opts.env)) {
    return { usable: false, reason: 'needs perl installed on this machine' }
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
  private readonly store: ProjectCredentialStore
  private readonly codexHome: string
  private readonly rotation: CodexRotationStore
  private readonly now: () => number
  private readonly log: (
    event: string,
    fields: Record<string, string | number | boolean | null | undefined>,
  ) => void

  constructor(deps: CodexCredentialServiceDeps) {
    this.store = deps.store
    this.codexHome = deps.codexHome
    this.rotation = deps.rotation
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
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
    for (const seat of this.rotation.listSlots(owner_slug)) {
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
      const derived = deriveCodexStatus(stored?.plaintext ?? null, { materialized, now: this.now })
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
