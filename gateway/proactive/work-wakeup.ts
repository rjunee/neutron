/**
 * @neutronai/gateway/proactive — the work-continuation wakeup loop.
 *
 * The owner's ask, verbatim: "I need my sessions to keep working all night, so
 * they need to wake up and check every 5min … and actually take actions to get
 * this moving." The thing that makes that real in the reference system is NOT a
 * session-side scheduler — it is a SERVER-SIDE tick that re-enters the session
 * with a fresh turn. This module is that tick for Neutron, built deliberately on
 * the two mechanisms that already work in production:
 *
 *   • `trident/tick.ts` made this exact migration once before: it replaced the
 *     legacy harness's session-bound ScheduleWakeup driver with an in-process
 *     `SupervisedLoop` sweep, precisely because a session-bound wakeup dies with
 *     its session and a gateway-driven warm REPL has nothing pumping it for a
 *     scheduled re-entry to land in. A wakeup the session schedules for itself
 *     is a scheduler that silently never fires after the next eviction — the
 *     worst failure shape this codebase knows. The server-side tick survives
 *     evictions, deploys, and restarts for free, because the loop is re-armed at
 *     every composition and its state lives in durable rows.
 *
 *   • The fired-reminder dispatcher already proves a server-initiated turn can
 *     land ON the owner's warm project chat session: `liveAgentSubstrate` has no
 *     `projectIdResolver`, so `metering_context.project_id` reaches the warm-pool
 *     key (`build-llm-call-substrate.ts` fallback → `pool.ts poolKeyFor`), and a
 *     turn keyed `(cc-agent-<handle>, owner, <project>)` IS the owner's chat
 *     session for that project. This loop composes exactly the same way.
 *
 * WHAT COUNTS AS "A SESSION WITH WORK OUTSTANDING" — the Work Board, nothing
 * new: an item with `status='in_progress'` whose `linked_run_id` is absent or no
 * longer live. An item a trident/agent-dispatch run is actively driving is NOT
 * woken (the trident tick is already its wakeup driver — waking it here would
 * double-drive one work item from two schedulers). Arming and disarming are
 * therefore board mutations the owner and the agent can both already perform,
 * durable across restarts, with no second queue to drift.
 *
 * "ACTIVELY DRIVING" IS A MEASUREMENT, NOT A PHASE. The first cut of that rule
 * asked only whether the linked run was non-terminal, and a stalled run is
 * non-terminal forever — so on the owner's instance three parked runs suppressed
 * every subsequent tick and the loop went quiet after one firing. The selector
 * (`work-wakeup-selection.ts`) now defers only to a run that has ADVANCED
 * recently, and hands back the deferrals it made so this sweep can log them:
 * going quiet is the one forbidden outcome, and a silent skip is going quiet.
 *
 * THE OWNER-ACTIVITY GATE: a project whose chat has seen a GENUINE owner turn
 * inside `owner_grace_ms` (default 30 min) is skipped — while he is driving, the
 * session does not need a robot poking it, and a wakeup turn would queue ahead
 * of his next message on the same warm REPL. The watermark is
 * `last_user_activity_at` (only a real person moves it — the same field the
 * idle-nudge sweep relies on for exactly the same reason).
 *
 * AND THE AGENT-ACTIVITY GATE, which the owner gate is not a substitute for. The
 * owner gate answers "is the human driving?"; nothing answered "is a MACHINE
 * already driving this session?". Three schedulers compose on ONE background
 * `cc-nudge-*` warm child per project — this sweep, the fired-reminder dispatcher
 * and the terminal-build wake — because all three key the pool on
 * `metering_context.project_id`. A tick firing while one of the others holds that
 * child does not run: it QUEUES, spends its whole `turn_timeout_ms` waiting,
 * aborts (`cc-llm-call: aborted`), and this sweep announces a mechanism failure —
 * loudly, every five minutes, about the very work it was interrupting. Attempts
 * 1, 6 and 12 of exactly that reached the owner's phone on 2026-08-22. So
 * `agentBusy` is asked, LIVE, before composing, and a busy scope is SKIPPED. A
 * skip is not a failure: the streak is untouched and nothing is posted.
 *
 * LOUD ON FAILURE, QUIET ON PROGRESS: every wakeup report is posted as a durable
 * inert chat row (visible in history + live push), but with the native device
 * buzz SUPPRESSED — twelve buzzes an hour all night is a product bug, not a
 * feature. The two cases that DO buzz are the two the owner must see: a turn
 * that answers `BLOCKED:` and a wakeup mechanism failure (posted on the first
 * failure and every `WAKEUP_FAILURE_POST_CADENCE`th thereafter, so a dead
 * substrate is loud without being a siren). Going quiet is the one forbidden
 * outcome.
 */

import type { RunDrivingReason } from '@neutronai/trident/run-driving.ts'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { ToolDef } from '@neutronai/cores-sdk/manifest'
import { SupervisedLoop, type LoopDescriptor } from '@neutronai/loop'
import { createLogger } from '@neutronai/logger'

const log = createLogger('work-wakeup')

/** The owner's stated cadence: wake and act every ~5 minutes. */
export const WORK_WAKEUP_INTERVAL_MS = 5 * 60_000

/**
 * Skip a project whose chat saw a genuine owner turn this recently — he is
 * driving; the session is not asleep.
 */
export const WORK_WAKEUP_OWNER_GRACE_MS = 30 * 60_000

/**
 * Per-turn wall-clock budget. Below the 5-min cadence so a hung turn cannot
 * make the single-flight loop skip forever; above the reminder default because
 * a wakeup turn does real tool work, not one-line composition.
 */
export const WORK_WAKEUP_TURN_TIMEOUT_MS = 4 * 60_000

/** Reply budget — the report is 1–3 sentences; the WORK happens in the turn. */
export const WORK_WAKEUP_MAX_TOKENS = 4096

/** Upper bound on a posted report; the overflow is truncated, never dropped. */
export const MAX_WAKEUP_REPORT_CHARS = 2_000

/** Cap on titles folded into one prompt (the rest are counted, not listed). */
export const MAX_WAKEUP_PROMPT_ITEMS = 6

/**
 * A failing project posts its failure on streak 1 and every Nth failure after
 * — loud, but not one buzz per 5-minute tick for the same dead substrate.
 */
export const WAKEUP_FAILURE_POST_CADENCE = 6

/** A reply starting with this is a blocked declaration and posts LOUD. */
export const WAKEUP_BLOCKED_PREFIX = 'BLOCKED:'

/**
 * Re-log a STANDING deferral at most this often, PER ITEM. A deferral is a
 * per-tick decision, so logging every one of them would write 288 lines a day per
 * item for as long as the build runs — a volume that stops being a signal. The
 * window is edge-friendly rather than edge-triggered: a newly deferred item has no
 * window and logs on the first sweep that defers it, so the interesting transition
 * is never delayed, while a standing deferral repeats every half hour instead of
 * every five minutes. Half an hour is chosen against the reader, not the writer:
 * short enough that "is anything progressing?" is answerable from a glance at the
 * tail, long enough that the answer is not buried in itself.
 *
 * PER ITEM, NOT PER RUN, and the distinction is the whole point of the line. One
 * trident run can drive several board items; keying the window on the run made the
 * SECOND and third items on that run silent — the sweep would report three
 * deferrals in its counters and name one of them, which is the same partial
 * invisibility this logging exists to remove. The item is the thing the owner is
 * asking about, so the item is the key.
 */
export const WAKEUP_DEFERRAL_LOG_WINDOW_MS = 30 * 60_000

/** One in-progress, un-driven Work Board item. */
export interface WakeupWorkItem {
  title: string
  /**
   * Set when this item was RELEASED to the wakeup even though it still carries a
   * `linked_run_id`: the bound run exists, is NOT terminal, and simply stopped
   * reading as its driver (`no-advance`, or `unknown-advance` for an unusable
   * stamp).
   *
   * IT IS CARRIED BECAUSE THE PROMPT WOULD OTHERWISE LIE. The wakeup turn used to
   * state flatly that these items had "no live background run", which is true of an
   * unbound item and false of this one — the row is still there, the binding is
   * still there, and only the JUDGEMENT that it is driving has lapsed. An agent
   * told the run does not exist will reasonably dispatch a new build, which is the
   * double-drive this module's whole selection policy exists to prevent, and which
   * `migrations/0120_trident_slug_unique_only_live.sql:42-44` would in any case
   * refuse: that unique index is scoped to `phase NOT IN (done, failed, stopped)`,
   * so a second run of the same slug collides with the parked one that is still
   * non-terminal. Naming the parked run in the prompt is what lets the agent reap
   * it instead of racing it.
   */
  stalled_run?: {
    /** The `code_trident_runs.id` still bound to the item. */
    run_id: string
    /** That run's phase, verbatim (`forge-init`, `argus`, …). */
    phase: string
    /** Which release rule fired — the verdict's own greppable token. */
    reason: RunDrivingReason
    /** ms since the run's `last_advanced_at`; 0 when there was no usable reading. */
    since_advance_ms: number
  }
}

/**
 * One in-progress item this sweep did NOT wake because a live trident run is
 * still driving it. Carried so the decision is LOGGED rather than silent — the
 * failure this cured was three items disappearing from the only autonomy
 * mechanism with nothing written anywhere to say so.
 */
export interface WakeupDeferredItem {
  title: string
  /** The `work_board_items.id` — the deferral log's rate-limit key. */
  item_id: string
  /** The `code_trident_runs.id` the item is bound to. */
  run_id: string
  /** That run's phase, verbatim (`forge-init`, `argus`, …). */
  phase: string
  /** ms since the run's `last_advanced_at` — how fresh the deferral's basis is. */
  since_advance_ms: number
}

/** Everything the sweep needs to wake ONE project. */
export interface WakeupProjectWork {
  /** Work Board storage key (bare owner slug for General, project id otherwise). */
  project_key: string
  /**
   * The chat/session scope for the compose turn's `metering_context.project_id`
   * — `'general'` for General, the project id verbatim otherwise. This is the
   * live-chat convention (`build-live-agent-turn.ts` `turn.project_id ?? 'general'`),
   * and matching it is what lands the turn ON the owner's warm session instead
   * of a parallel one.
   */
  chat_scope: string
  /** Human label for the prompt + failure notices. */
  label: string
  items: WakeupWorkItem[]
  /**
   * In-progress items withheld from `items` because a live run is driving them.
   * Reported, never acted on. A project may legitimately arrive with `items`
   * EMPTY and this non-empty — that is the "everything is being built" state, and
   * the sweep still logs it rather than looking like it found no work at all.
   */
  deferred: WakeupDeferredItem[]
}

/**
 * The composition seam — structurally identical to `ReminderLlm`, so the
 * composer passes the SAME `buildSubstrateReminderLlm(reminderComposeSubstrate)`
 * wrapper the fired-reminder path uses. One substrate entry, two callers — and
 * that substrate is the BACKGROUND `cc-nudge-*` REPL, never the owner's chat one.
 */
export interface WakeupLlm {
  compose(spec: AgentSpec, opts?: { timeout_ms?: number }): Promise<string>
}

export interface WorkWakeupDeps {
  /** Projects with outstanding, un-driven in-progress work. Empty ⇒ no-op tick. */
  listOutstanding(): WakeupProjectWork[] | Promise<WakeupProjectWork[]>
  /**
   * Epoch-ms of the most recent GENUINE owner turn in the project's chat
   * (`last_user_activity_at` semantics), or null when he has never spoken there.
   */
  ownerActivityMs(project_key: string): number | null | Promise<number | null>
  /**
   * Is a background compose ALREADY RUNNING on the warm child this sweep would
   * compose on? Called with `chat_scope` — the same value that goes into
   * `metering_context.project_id` below, and therefore the same warm-pool
   * discriminator the substrate keys on. Absent ⇒ never busy (tests and any
   * caller with no pool to ask).
   *
   * THE OWNER GATE WAS NEVER THE WHOLE GATE. `ownerActivityMs` answers "is the
   * human driving this project?" and nothing answered "is a MACHINE already
   * driving this session?". Three schedulers compose on one `cc-nudge-*` child
   * per project (this sweep, the fired-reminder dispatcher, the terminal-build
   * wake), so a tick that fires while one of the others holds the child does not
   * run: it queues, spends its whole `turn_timeout_ms` waiting, aborts, and this
   * sweep then reports a MECHANISM FAILURE to the owner — loud, on a five-minute
   * cadence, describing as broken the very work it was interrupting.
   */
  agentBusy?(chat_scope: string): boolean | Promise<boolean>
  llm: WakeupLlm
  /**
   * Post one report/notice to the project's chat topic. `loud: false` ⇒ durable
   * + live-pushed with the device buzz suppressed; `loud: true` ⇒ a normal
   * notifying post. Returns whether the durable row was written.
   */
  post(input: { project_key: string; body: string; loud: boolean }): boolean | Promise<boolean>
  /**
   * ⚠️ MUST match what the fired-reminder dispatcher passes — both compose on the
   * ONE background `cc-nudge-*` REPL, and the warm-pool reuse guard evicts a child
   * whose requested `--tools` surface differs from the one it was spawned with. So
   * a differing list here would thrash that child between the two callers. Today
   * both pass `LIVE_AGENT_TOOL_NAMES` (`reminders/dispatcher.ts` carries the same
   * note for the same reason).
   */
  tool_names: ReadonlyArray<string>
  /** Live best-model thunk (`getBestModel`) — overnight work gets the real model. */
  resolveModel(): string
  now?: () => number
  interval_ms?: number
  owner_grace_ms?: number
  turn_timeout_ms?: number
}

/** Per-tick outcome summary (returned for tests + logged). */
export interface WakeupSweepResult {
  woke: number
  skipped_active: number
  failed: number
  /** Items left to a live run this tick (one `wakeup_deferred_to_live_run` each). */
  deferred_to_run: number
  /**
   * Items TAKEN this tick despite still being bound to a non-terminal run that
   * stopped advancing (one `wakeup_released_stalled_run` each). Unconditional, so
   * the per-run log's rate limit costs volume and never the fact.
   */
  released_stalled_run: number
  /**
   * Projects skipped because another background compose already held their warm
   * child. COUNTED SEPARATELY FROM `skipped_active` on purpose: that one means
   * "the owner is driving", this one means "a machine is", and folding them
   * together would hide the arrival of a new background scheduler behind a number
   * that reads as ordinary owner activity.
   */
  skipped_agent_busy: number
}

/**
 * The deferral log's rate-limit key: project + item + THE RUN CURRENTLY DRIVING IT.
 *
 * The run belongs in the key even though the item alone bounds the map. An item's
 * `linked_run_id` can be superseded — `attachRun` re-binds an item to a later run
 * (`WorkBoardStore.attachRun`, `work-board/store.ts`) — and a re-bind is exactly the transition an operator
 * needs to see. Keyed on the item alone, a hand-off from R1 to R2 inside the
 * half-hour window would be suppressed as a "standing" deferral and the last line
 * on record would still name R1: stale attribution, which is the specific kind of
 * wrong that is worse than silence. Including the run gives the new driver its own
 * window, and the prune still drops the old key on the same sweep.
 *
 * THE KEY IS LENGTH-PREFIXED, AND THAT IS WHAT MAKES IT INJECTIVE. An earlier cut
 * joined the parts on a NUL and argued the delimiter could not occur inside any of
 * them. Nothing enforces that: `CreateWorkBoardItemInput.id` is caller-supplied
 * (`work-board/store.ts`) and run ids are likewise unrestricted strings, so a
 * separator-only scheme is injective by ASSUMPTION rather than by construction.
 * With a bare separator, ("p", "a<NUL>b", "c") and ("p", "a", "b<NUL>c") encode
 * identically, and two different items then share one deferral window — one of
 * them silently stops being logged, which is the going-quiet this module exists to
 * prevent. Prefixing each part with its length removes the question entirely: the
 * decode is unambiguous whatever the parts contain.
 *
 * THE SEPARATOR IS STILL WRITTEN AS AN ESCAPE WHEREVER ONE IS USED, AND MUST STAY
 * THAT WAY. Typing a NUL LITERALLY puts a real NUL in the source, and a tracked file
 * containing one is BINARY to grep: `scripts/ci/leak-gate.sh` flags it
 * `binary-hidden` and fails the `purity` job, precisely because every PII and
 * vocabulary rule it runs would silently match nothing in such a file. This file
 * shipped a literal NUL here and the gate was right to refuse it. The escape is
 * byte-identical at runtime and leaves the source pure ASCII.
 */
function deferralLogKey(project_key: string, d: WakeupDeferredItem): string {
  const part = (s: string): string => `${s.length} ${s}`
  return `${part(project_key)}${part(d.item_id)}${part(d.run_id)}`
}

/**
 * The RELEASE log's rate-limit key, sharing the deferral window's map.
 *
 * The leading empty field is what keeps the two key spaces disjoint, and it is
 * airtight rather than merely unlikely: a deferral key always begins with a
 * `project_key`, a project key can never contain a NUL, and so no deferral key can
 * ever begin with one. (A bare `'release'` prefix would have relied on no project
 * ever being CALLED release, which is a smaller guarantee than this costs.)
 *
 * Keyed on the run rather than the item because the run is what an operator would
 * act on — a release names a parked run to go and reap — and because the binding is
 * one-run-per-item at any instant, so it is no coarser than the item in practice.
 */
function releaseLogKey(project_key: string, run_id: string): string {
  return `\u0000release\u0000${project_key}\u0000${run_id}`
}

/** Truncate for a prompt line / a log field — bounded, marked, never thrown. */
function bound(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * The wakeup turn prompt. Exported for tests (and so the composer's prompt and
 * the tests can never drift apart). Deliberately imperative about ACTING: the
 * failure mode being cured is a session that plans instead of moving.
 *
 * IT MUST NOT CLAIM MORE THAN THE SELECTOR PROVED. The line here used to read "with
 * no live background run", which was accurate while the selector released an item
 * only when it had no binding at all. It stopped being accurate the moment the
 * selector began releasing items whose bound run is non-terminal but no longer
 * advancing: for those, a run row still exists and the binding still exists — only
 * the verdict lapsed. Telling the agent no run exists is the wording that turns a
 * released item into a SECOND dispatch, i.e. the double-drive the release was
 * carefully bounded to avoid. So an item released with a parked run says so, names
 * it, and the instructions send the agent at the parked run rather than around it.
 */
export function buildWakeupPrompt(input: {
  label: string
  items: WakeupWorkItem[]
  now_iso: string
}): string {
  const listed = input.items.slice(0, MAX_WAKEUP_PROMPT_ITEMS)
  const extra = input.items.length - listed.length
  const lines = listed.map((it) => {
    const base = `- ${bound(it.title, 140)}`
    if (it.stalled_run === undefined) return base
    // `unknown-advance` has no usable clock reading by construction
    // (`run-driving.ts:176` returns `since_advance_ms: 0`), so it must not be
    // rendered as "0m since progress" — that reads as a run which JUST moved,
    // the exact opposite of what the token means.
    const quiet =
      it.stalled_run.reason === 'unknown-advance'
        ? 'its last-progress time is unreadable'
        : `no progress for ${Math.floor(it.stalled_run.since_advance_ms / 60_000)}m`
    return `${base}\n  ↳ still bound to background run ${it.stalled_run.run_id}, parked at phase "${it.stalled_run.phase}" (${quiet}).`
  })
  if (extra > 0) lines.push(`- (+${extra} more in-progress item${extra === 1 ? '' : 's'})`)
  const anyStalled = listed.some((it) => it.stalled_run !== undefined)
  return [
    `[SCHEDULED WAKEUP — ${input.now_iso}]`,
    `You are waking on your recurring work cadence for ${input.label}. The owner is away;`,
    'you are expected to make real progress, not wait for instructions.',
    'The Work Board shows these in-progress items that no background run is advancing:',
    ...lines,
    ...(anyStalled
      ? [
          '',
          'An item marked ↳ is STILL BOUND to a background run that stopped advancing. That',
          'run row still exists, so do NOT dispatch a second build for it — a new run of the',
          'same task collides with the parked one, and you would be racing it rather than',
          'replacing it. Either do the work directly in this turn, or stop/reap the parked',
          'run first and dispatch afterwards.',
        ]
      : []),
    '',
    'In THIS turn:',
    '1. Take the single most valuable CONCRETE action toward one of these items using your',
    '   tools (read/edit files, run commands, dispatch work). Not a plan — an action.',
    '2. If an item is actually complete, update the Work Board to say so.',
    '3. Reply with 1-3 short sentences: what you just did, and the immediate next step.',
    `If you genuinely cannot act (missing access, missing decision), reply starting with`,
    `"${WAKEUP_BLOCKED_PREFIX}" and state exactly what is needed.`,
  ].join('\n')
}

/**
 * Run ONE sweep. Sequential across projects on purpose: each wakeup is a real
 * agentic turn on a warm REPL, and a parallel fan-out would spike N children at
 * once for no owner-visible benefit. `failureStreaks` is process-local state —
 * a restart resets it, which merely means the first post-restart failure is
 * loud again. That is the right direction to fail in.
 */
export async function runWorkWakeupSweep(
  deps: WorkWakeupDeps,
  failureStreaks: Map<string, number>,
  deferralLog: Map<string, number> = new Map(),
): Promise<WakeupSweepResult> {
  const now = deps.now ?? ((): number => Date.now())
  const grace = deps.owner_grace_ms ?? WORK_WAKEUP_OWNER_GRACE_MS
  const turn_timeout = deps.turn_timeout_ms ?? WORK_WAKEUP_TURN_TIMEOUT_MS
  const result: WakeupSweepResult = {
    woke: 0,
    skipped_active: 0,
    failed: 0,
    deferred_to_run: 0,
    released_stalled_run: 0,
    skipped_agent_busy: 0,
  }

  const projects = await deps.listOutstanding()
  // Drop streak entries for projects that no longer have outstanding WAKEABLE
  // work, so the map cannot grow without bound across long uptimes.
  //
  // `p.items.length > 0`, NOT merely `p.project_key`. A project whose items are
  // all deferred to live runs still yields an entry — deliberately, so the sweep
  // can report the deferral rather than look like it found nothing — and keying
  // the prune on the entry's mere existence would keep that project's streak
  // alive for as long as its builds run. A streak counts CONSECUTIVE FAILED
  // WAKEUP TURNS, and this sweep runs no turn for such a project, so the count is
  // not being continued by evidence; it is just being preserved. The visible cost
  // is a misfired cadence: `WAKEUP_FAILURE_POST_CADENCE` posts on the streak's
  // value, so a stale 2 means the first genuine failure after the builds finish
  // is judged as a third strike and posted (or swallowed) on the wrong footing.
  // Pruning on wakeable work restarts the count at 1, which is what the next
  // failure actually is.
  const liveKeys = new Set(projects.filter((p) => p.items.length > 0).map((p) => p.project_key))
  for (const key of [...failureStreaks.keys()]) {
    if (!liveKeys.has(key)) failureStreaks.delete(key)
  }
  // THE SAME PRUNE, FOR THE SAME REASON, ON THE DEFERRAL WINDOWS. This window is
  // owned by the loop rather than taken from `log.rateLimited`, whose state is a
  // module-global map pruned only by `resetLoggerStateForTests`
  // (`logger/index.ts:238-247`). Every other caller of that helper keys it on a
  // bounded vocabulary; a board item id is not one — it is fresh per item, for as
  // long as the process lives. Owning the map keeps the keyspace bounded by what
  // is CURRENTLY deferred, which is the same discipline the streak map fifteen
  // lines up already follows.
  const deferredKeys = new Set([
    ...projects.flatMap((p) => p.deferred.map((d) => deferralLogKey(p.project_key, d))),
    ...projects.flatMap((p) =>
      p.items.flatMap((it) =>
        it.stalled_run === undefined ? [] : [releaseLogKey(p.project_key, it.stalled_run.run_id)],
      ),
    ),
  ])
  for (const key of [...deferralLog.keys()]) {
    if (!deferredKeys.has(key)) deferralLog.delete(key)
  }

  for (const project of projects) {
    // SAY WHAT WAS WITHHELD, BEFORE ANY GATE. A deferral is a decision to leave a
    // work item to another driver, and the tick that made it is the only place
    // that knows. Logged at INFO (not debug, unlike the owner-active gate) because
    // this is the line that answers "is anything actually progressing?" — it names
    // the run and how long since it last moved, so a parked driver is legible as a
    // parked driver rather than as an empty board. Rate-limited PER ITEM so a long
    // build says so periodically instead of 288 times a day; the COUNT in
    // `WakeupSweepResult` is unconditional and is logged every tick by
    // `buildWorkWakeupLoop`, so the rate limit costs volume and never costs the
    // fact — an operator reading the summary sees three deferrals even on a tick
    // where all three per-item lines are inside their window.
    for (const d of project.deferred) {
      result.deferred_to_run += 1
      const logKey = deferralLogKey(project.project_key, d)
      const lastLoggedAt = deferralLog.get(logKey)
      if (lastLoggedAt !== undefined && now() - lastLoggedAt < WAKEUP_DEFERRAL_LOG_WINDOW_MS) {
        continue
      }
      deferralLog.set(logKey, now())
      log.info('wakeup_deferred_to_live_run', {
        project: project.project_key,
        item: bound(d.title, 140),
        item_id: d.item_id,
        run_id: d.run_id,
        phase: d.phase,
        since_advance_ms: d.since_advance_ms,
      })
    }
    // AND SAY WHAT WAS TAKEN OVER A LIVE BINDING, which is the other half of the
    // same legibility. A deferral and a release are the two outcomes of one
    // decision, and only the deferral was ever written down — so the whole point
    // of this change, an item being taken BACK from a parked run, was the one
    // transition invisible in the log. Worse for `unknown-advance`: a run released
    // because its `last_advanced_at` is corrupt or in the future
    // (`run-driving.ts:175-177`) looked in the log exactly like an item that never
    // had a run at all, so a broken clock and an ordinary unbound item were
    // indistinguishable. The verdict's reason token is emitted verbatim to tell
    // them apart.
    for (const it of project.items) {
      if (it.stalled_run === undefined) continue
      result.released_stalled_run += 1
      const logKey = releaseLogKey(project.project_key, it.stalled_run.run_id)
      const lastLoggedAt = deferralLog.get(logKey)
      if (lastLoggedAt !== undefined && now() - lastLoggedAt < WAKEUP_DEFERRAL_LOG_WINDOW_MS) {
        continue
      }
      deferralLog.set(logKey, now())
      log.info('wakeup_released_stalled_run', {
        project: project.project_key,
        item: bound(it.title, 140),
        run_id: it.stalled_run.run_id,
        phase: it.stalled_run.phase,
        reason: it.stalled_run.reason,
        since_advance_ms: it.stalled_run.since_advance_ms,
      })
    }
    if (project.items.length === 0) continue

    // Owner-activity gate: while he is driving this project, stay out of it.
    const last = await deps.ownerActivityMs(project.project_key)
    if (last !== null && now() - last < grace) {
      result.skipped_active += 1
      log.debug('wakeup_skipped_owner_active', {
        project: project.project_key,
        idle_ms: now() - last,
      })
      continue
    }

    // AGENT-ACTIVITY GATE — the other half of the owner gate, and the cure for a
    // loop that reported its own queueing as a mechanism failure. Asked LIVE, of
    // the warm child this tick would actually compose on: a compose that is
    // running right now would make this one queue behind it and abort at
    // `turn_timeout_ms`, which is not a failure of the wakeup mechanism and must
    // never be announced as one. Deliberately NOT cured by widening the timeout
    // (that makes the collision longer, not rarer) and NOT by suppressing the
    // failure notice (a genuinely dead substrate must still be loud). Skipping
    // costs one tick; the next comes in five minutes and the streak is untouched,
    // because nothing failed.
    const busy = deps.agentBusy === undefined ? false : await deps.agentBusy(project.chat_scope)
    if (busy) {
      result.skipped_agent_busy += 1
      log.debug('wakeup_skipped_agent_busy', {
        project: project.project_key,
        chat_scope: project.chat_scope,
      })
      continue
    }

    const tools: ToolDef[] = deps.tool_names.map((name) => ({
      name,
      description: `Built-in Claude Code tool '${name}' (work-wakeup surface)`,
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      capability_required: 'fs:project_data',
    }))
    const spec: AgentSpec = {
      prompt: buildWakeupPrompt({
        label: project.label,
        items: project.items,
        now_iso: new Date(now()).toISOString(),
      }),
      tools,
      model_preference: [deps.resolveModel()],
      max_tokens: WORK_WAKEUP_MAX_TOKENS,
      // The warm-pool key — what lands this turn ON the owner's chat session
      // for this project rather than a parallel one.
      metering_context: { project_id: project.chat_scope },
    }

    let reply: string
    try {
      reply = (await deps.llm.compose(spec, { timeout_ms: turn_timeout })).trim()
      if (reply.length === 0) throw new Error('the wakeup turn returned an empty reply')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const streak = (failureStreaks.get(project.project_key) ?? 0) + 1
      failureStreaks.set(project.project_key, streak)
      result.failed += 1
      // The journal line carries the full cause; the chat notice a bounded one.
      log.error('wakeup_turn_failed', {
        project: project.project_key,
        streak,
        reason: bound(reason, 400),
      })
      if (streak === 1 || streak % WAKEUP_FAILURE_POST_CADENCE === 0) {
        try {
          await deps.post({
            project_key: project.project_key,
            body: `Scheduled wakeup for ${project.label} failed to run (attempt ${streak}): ${bound(reason, 200)} — retrying every 5 minutes.`,
            loud: true,
          })
        } catch (postErr) {
          log.error('wakeup_failure_post_failed', {
            project: project.project_key,
            reason: bound(postErr instanceof Error ? postErr.message : String(postErr), 200),
          })
        }
      }
      continue
    }

    failureStreaks.delete(project.project_key)
    const blocked = reply.startsWith(WAKEUP_BLOCKED_PREFIX)
    try {
      const persisted = await deps.post({
        project_key: project.project_key,
        body: bound(reply, MAX_WAKEUP_REPORT_CHARS),
        // A BLOCKED declaration is exactly the "say so loudly" case; routine
        // progress stays quiet (durable + visible, no buzz).
        loud: blocked,
      })
      if (!persisted) {
        log.warn('wakeup_report_not_persisted', { project: project.project_key })
      }
    } catch (err) {
      log.error('wakeup_report_post_failed', {
        project: project.project_key,
        reason: bound(err instanceof Error ? err.message : String(err), 200),
      })
    }
    result.woke += 1
    log.info('wakeup_fired', { project: project.project_key, blocked })
  }
  return result
}

export interface WorkWakeupLoop {
  loop: SupervisedLoop
  describe(): LoopDescriptor
}

/**
 * Build (never start) the `work-wakeup` loop. The composer registers the
 * descriptor, starts the loop last (register-before-start), and awaits
 * `loop.stop()` on shutdown — the same lifecycle every other loop follows.
 */
export function buildWorkWakeupLoop(deps: WorkWakeupDeps): WorkWakeupLoop {
  const failureStreaks = new Map<string, number>()
  const deferralLog = new Map<string, number>()
  const loop = new SupervisedLoop({
    name: 'work-wakeup',
    intervalMs: deps.interval_ms ?? WORK_WAKEUP_INTERVAL_MS,
    tick: async (): Promise<void> => {
      const result = await runWorkWakeupSweep(deps, failureStreaks, deferralLog)
      // THE SWEEP'S OWN COUNTERS NEEDED A READER. `WakeupSweepResult` was returned
      // and then dropped on the floor by this — its only production caller — so
      // the claim that a rate-limited per-item line "never costs the fact" was
      // true of a number nothing printed. That is an aspirational docblock, and
      // the repo has a rule about those. One line per tick, at INFO when there is
      // anything at all to say, is what makes the fact reachable.
      //
      // A fully idle tick stays SILENT: on a box with no outstanding work this
      // loop runs 288 times a day and a summary of zeros would drown the ticks
      // that mean something.
      if (
        result.woke > 0 ||
        result.failed > 0 ||
        result.deferred_to_run > 0 ||
        result.released_stalled_run > 0 ||
        result.skipped_active > 0 ||
        result.skipped_agent_busy > 0
      ) {
        log.info('wakeup_sweep', {
          woke: result.woke,
          failed: result.failed,
          deferred_to_run: result.deferred_to_run,
          released_stalled_run: result.released_stalled_run,
          skipped_owner_active: result.skipped_active,
          skipped_agent_busy: result.skipped_agent_busy,
        })
      }
    },
  })
  return { loop, describe: (): LoopDescriptor => loop.describe() }
}
