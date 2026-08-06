/**
 * THE COMPOSITION-FIELD BASELINE — which non-route-slot `CompositionInput`
 * fields the product actually sets today, and for the ones it does not, WHY.
 *
 * Read `composition-field-coverage.test.ts` first: it reads the declared field
 * set out of the TypeScript source, boots the real Open composition, and checks
 * which of those fields the composed object carries against the two lists here.
 * This file is data only — it imports NOTHING, deliberately, so
 * `scripts/ci/composition-field-ratchet-guard.sh` can write main's copy of it to
 * a scratch path and import that too.
 *
 * SCOPE, AND WHY IT IS THE COMPLEMENT OF THE ROUTE SLOTS. `CompositionInput` has
 * 76 fields: 8 required (the compiler already refuses to omit those) and 68
 * optional. 39 of the 68 are route-slot `composition` fields and are ALREADY
 * ratcheted, with richer per-rung detail, by `route-slot-coverage-inventory.ts`.
 * Listing them again here would be a second baseline for one fact, and two
 * baselines drift. So this file owns the remaining 29 — the fields that are
 * neither a boolean switch (`scripts/ci/composition-wiring-gate.sh` has those)
 * nor an HTTP surface, and which consequently NO existing gate can see.
 *
 * `push_dispatcher` is the field that proved the hole was real: declared at
 * `gateway/composition/input/misc-input.ts:30`, consumed at
 * `gateway/composition/build-core-modules.ts:396`, set by no composer, so the
 * app registered push tokens and delivered to none of them. It is not a route
 * slot and it is not a boolean, so both existing gates were blind to it, and
 * `tests/integration/reminders-tab-and-push.open.test.ts:28` says so in as many
 * words. It is now the first entry in WIRED_FIELDS and cannot silently regress.
 *
 * HOW TO CHANGE IT.
 *   - Wired a field? Move its entry from UNWIRED_FIELDS to WIRED_FIELDS. The
 *     coverage test fails until you do — a stale "not wired" line is an
 *     allowlist entry that has stopped being true.
 *   - Added a field to CompositionInput? Classify it here (or give it a route
 *     slot). An unclassified field fails the build.
 *   - Tempted to move an entry the OTHER way to get green? That is the one edit
 *     the ratchet guard exists to stop. Wire the field, or DELETE it and its
 *     dead consumer.
 *
 * EVERY UNWIRED ENTRY CARRIES ITS REASON, and the reason is the point. A bare
 * list of names rots into permission: the next reader sees an established
 * allowlist and adds one more. A written reason is a claim someone can check,
 * and `costs` says out loud what the owner is currently missing.
 *
 * As of 2026-08-03 all four unwired fields are DECISIONS rather than gaps. The
 * last one carrying a "GAP" label was `onboarding_telemetry`, and it was
 * relabelled only after reading what the omitted cron actually sends — a
 * product-market-fit survey, which is the wrong thing to put in front of a
 * self-hoster. That relabelling is the behaviour this list wants: a reason is a
 * CLAIM, and the way it stops being a gap is that someone checks the claim, not
 * that someone gets tired of seeing it. If a future entry says GAP, it should
 * stay saying GAP until the code changes or the claim is disproved.
 *
 * VERIFIED 2026-08-02 against the composed production graph, on a credentialed
 * boot: 29 fields in scope, 25 set, 4 not. (`onboarding_overnight_cron` moved
 * unwired → wired the same day — ISSUES #443, the overnight morning brief: the
 * engine ran the work and the report reached nobody.)
 */

/** A field the composed product sets today. This list may only grow. */
export interface CompositionFieldWiredEntry {
  readonly field: string
  /** What the owner gets because it is set — i.e. what breaks if it regresses. */
  readonly provides: string
}

/** A field the composed product does NOT set, and the reason that is so. */
export interface CompositionFieldUnwiredEntry {
  readonly field: string
  /** Why it is unset. A decision, or an admitted gap — never blank. */
  readonly why: string
  /** What the owner is missing because of that, in plain terms. */
  readonly costs: string
}

/**
 * Floor for the "is the probe alive at all" assertion. Not the exact count —
 * that would be a second baseline to keep in sync. It only has to be high
 * enough that a probe which composed nothing fails instead of reporting a clean
 * sweep of absences (or, worse, passing vacuously over an empty set).
 */
export const MIN_EXPECTED_WIRED_FIELDS = 18

/**
 * SET by the production Open composition. This list may only grow.
 */
export const WIRED_FIELDS: readonly CompositionFieldWiredEntry[] = [
  {
    field: 'push_dispatcher',
    provides:
      'reminder fan-out to registered mobile devices — unset, the app records push tokens and no reminder is ever delivered to one',
  },
  {
    field: 'agent_dispatch',
    provides:
      'the `dispatch_agent` agent tool — unset, chat cannot spawn a supervised background research/review agent',
  },
  {
    field: 'auth_gate',
    provides:
      'the single-owner session gate — unset, the gate is unmounted and the pre-sprint UNAUTHENTICATED surface is what an owner gets',
  },
  {
    field: 'channel_router',
    provides:
      'inbound channel routing to the per-topic agent — unset, the legacy P1 single-topic path is all that runs',
  },
  {
    field: 'codex_credential',
    provides: 'the Codex connect/status agent tools',
  },
  {
    field: 'cores',
    provides:
      'the Cores runtime — unset, NO core boots and the `cores` module is inert (reminders, tasks, research, scraping all gone)',
  },
  {
    field: 'create_project',
    provides: 'the create-project agent tool',
  },
  {
    field: 'cron_jobs',
    provides:
      'the SHARED cron job registry — unset, wow-moment action 07 registers the overnight job into a dead local registry, `cron_state` says "scheduled", and the timer never fires',
  },
  {
    field: 'doc_search',
    provides: 'the doc-search agent tool over project files',
  },
  {
    field: 'loop_registry',
    provides:
      'the single loop inventory shared across the composition — unset, the boot inventory line reports only the graph half of the running loops',
  },
  {
    field: 'memory_health',
    provides:
      "the gbrain backend probe folded into /healthz — unset, a missing memory backend reports status:'ok' instead of 'degraded'",
  },
  {
    field: 'memory_search',
    provides: 'the memory-search agent tool (distinct corpus from doc/message search)',
  },
  {
    field: 'message_search',
    provides: 'the message-search agent tool over chat history',
  },
  {
    field: 'on_cores_ready',
    provides: 'the launcher seed built from the cores that actually mounted',
  },
  {
    field: 'on_gateway_tick',
    provides:
      'the real heartbeat pulse driven by the tick loop — unset, the supervision heartbeat is never stale and a dead scheduler goes unnoticed',
  },
  {
    field: 'onboarding_import_running_cron',
    provides:
      'the 15s sweep that advances a finished history import — unset, onboarding stalls at import_running until the owner sends another message',
  },
  {
    field: 'onboarding_overnight_cron',
    provides:
      "the overnight-work morning brief's delivery surface — unset, the engine still runs the work and the reporter posts to nobody, so the owner's overnight results are silently discarded (ISSUES #443)",
  },
  {
    field: 'realmode_cleanups',
    provides: 'wiring teardown callbacks the boot shell runs on shutdown',
  },
  {
    field: 'init_ritual_planner',
    provides:
      'the ritual surface — unset, a ritual row composes as an ordinary nudge and its approved prompt is never read',
  },
  {
    field: 'skill_forge',
    provides: 'the skill-forge agent tool + its `/skill` command backend',
  },
  {
    field: 'tasks',
    provides: 'the P6 task system',
  },
  {
    field: 'trident',
    provides:
      'the billing-exempt detached build workflow behind `/code` — unset, no Trident run can be fired',
  },
  {
    field: 'trident_build_dispatch',
    provides: 'agent-native parity for `/code --item` (dispatch a build from a plan item)',
  },
  {
    field: 'watchdog_credential_pool',
    provides: 'the substrate_cooldown_saturation detector its credential pool to inspect',
  },
  {
    field: 'work_board',
    provides:
      'the shared WorkBoardStore behind the agent tool + HTTP surface + per-turn injection, on one code path with one live-push',
  },
]

/**
 * NOT set by the production Open composition, each with the reason.
 *
 * Three of these five are DECISIONS (the seam is meant to stay open) and two are
 * GAPS the owner is currently paying for. They are deliberately in one list so
 * the gaps cannot hide among the decisions — read `costs` before adding a sixth.
 */
export const UNWIRED_FIELDS: readonly CompositionFieldUnwiredEntry[] = [
  {
    field: 'default_handler',
    why:
      'DECISION — set by the BOOT SHELL, not the composer. Only `boot()` knows the per-instance `bootedAt` + slug the healthz stub needs, so it assigns the field itself at `gateway/index.ts:381`; `open/composer.ts:31` states the split out loud. The probe below stops at `composeProductionGraph` and never runs `boot()`, so it cannot observe that assignment.',
    costs:
      'nothing in production. The cost is to this gate: `default_handler` is checked by `gateway/index.ts` boot tests instead of here.',
  },
  {
    field: 'http_handler',
    why:
      'DECISION — an OVERRIDE seam that production must leave open. When it is omitted, `composeProductionGraph` builds the precedence-chain handler from the mounted surfaces (`gateway/composition/input/http-surfaces-input.ts:11-17`); when it is set, `gateway/index.ts:390` uses it INSTEAD and the whole route ladder is bypassed. Only tests and custom paths set it.',
    costs:
      'nothing. Wiring this one would be the defect — it would silently replace every mounted HTTP surface with a single handler.',
  },
  {
    field: 'pid_probe',
    why:
      'DECISION — a test seam with a correct production default. `watchdog/detectors.ts:227` falls back to `DefaultPidLivenessProbe` when the field is absent, which is the real probe; only tests inject a fake. Consumed at `gateway/composition/build-core-modules.ts:635`.',
    costs: 'nothing. Setting it in production would replace a real liveness check with an injected one.',
  },
  {
    field: 'onboarding_telemetry',
    why:
      "DECISION, not a gap — reclassified 2026-08-03 after reading what the cron actually sends. Every sub-field is optional and `gateway/composition/build-core-modules.ts:710-721` reads them all with `?.`, so telemetry itself still builds with its default stdout logger; the only thing the omission drops is the `sean_ellis` cron, which registers ONLY when the config supplies a channel + topic resolver. Leaving that unsupplied in Open is CORRECT. The message is a product-market-fit survey — `onboarding/telemetry/sean-ellis-trigger.ts:53` asks 'How would you feel if you could no longer use Neutron?' four weeks in — and a self-hoster INSTALLED this thing and may well be building on it. Surveying them about losing access to software they run themselves is a category error, and the answer would land in `sean_ellis_responses` in their OWN database where nobody reads it. So this is per-deployment config in the same family as the Google OAuth client: absent by default, supplied by a deployment that actually wants the signal. A hosted deployment that wants PMF data supplies channel + topic like any other config; it does not require changing Open.",
    costs:
      'nothing on a self-hosted install — an unread survey not being sent is the correct outcome. A deployment that wants the signal opts in via config.',
  },
]
