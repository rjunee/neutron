/**
 * @neutronai/gateway/wiring — substrate SECURITY PROFILES.
 *
 * Step 0 of the tool-security redesign
 * (`docs/plans/tool-security-redesign-2026-07-20.md`, correction #6). Collapses
 * the 8 hand-copied `buildLlmCallSubstrate({ ..., skip_permissions: true })`
 * option bags into named, single-source profiles so the later permission
 * migration (Phases B+C+E) is N constant edits instead of 8 risky per-site
 * edits — and so the no-feature-flags rule and a staged permission migration
 * stop being mutually exclusive (a mode-gated scanner would be a dual code path).
 *
 * A profile carries ONLY the SECURITY-relevant knobs of a substrate spawn — the
 * ones the migration will diverge per caller-trust-class. PER-CALL fields
 * (`substrate_instance_id`, `cwd`, `pool` / `resolvePool`, callbacks,
 * `project_slug`, `delivery_topic_id`, `ephemeral`, `enableToolBridge`, …) are
 * NOT part of a profile — they stay call args on `BuildLlmCallSubstrateInput`.
 *
 * BEHAVIOUR-PRESERVING (this file is Step 0 — ZERO runtime change): every
 * constant below encodes TODAY's EXACT values byte-for-byte. Today every one of
 * the 8 production sites passes `skip_permissions: true` and NOTHING else
 * security-related, so every profile is exactly `{ skip_permissions: true }`.
 * The reserved fields (`permission_mode` / `claude_config_dir` / `extra_env` /
 * `sandbox`) are SHAPE-ONLY placeholders for the migration: they are `undefined`
 * today and `buildLlmCallSubstrate` applies today's-behaviour defaults when a
 * field is absent. Do NOT add `permission_mode` / `sandbox` RUNTIME behaviour
 * here — those have no `ClaudeCodeSubstrateOptions` field yet and wiring them is
 * a later phase (B / D). Reserving the shape is the whole job at Step 0.
 *
 * WHY DISTINCT CONSTANTS THAT ARE IDENTICAL TODAY: `PROFILE_UNTRUSTED_IMPORT`
 * (history import — prompt-injection surface) and `PROFILE_WARM_CHAT` (the
 * owner's trusted live chat) resolve to the same bytes now but MUST diverge in
 * the redesign (the untrusted-import caller loses its skip-permissions grant
 * first). Keeping them as separate named constants means that divergence is a
 * one-line edit to one constant, and the equivalence test in
 * `__tests__/substrate-profiles.test.ts` freezes today's byte-identity so any
 * accidental drift is caught before it ships.
 */

/**
 * RESERVED (Phase B) — Claude Code permission mode. NOT applied by the factory
 * at Step 0 (no `ClaudeCodeSubstrateOptions.permission_mode` field exists yet).
 * The migration sets this to `'dontAsk'` (fail-closed, headless-safe) as it
 * drops `skip_permissions`. Shape reserved here so Phase B is a constant edit.
 */
export type SubstratePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions'

/**
 * RESERVED (Phase D) — native-OS-sandbox (Seatbelt / bubblewrap) config shape.
 * NOT applied at Step 0 (no `ClaudeCodeSubstrateOptions.sandbox` field yet).
 * Fields mirror the CC `sandbox.*` settings the redesign will use to confine a
 * granted-Bash ritual's filesystem writes / reads and network egress. Reserved
 * as a shape only; every field is optional and unset today.
 */
export interface SubstrateSandboxConfig {
  /** OS-enforced write allow-list for the spawned child (default: cwd + temp). */
  readonly filesystem_allow_write?: ReadonlyArray<string>
  /** OS-enforced read allow-list. */
  readonly filesystem_allow_read?: ReadonlyArray<string>
  /** OS-enforced read deny-list (wins over allow). */
  readonly filesystem_deny_read?: ReadonlyArray<string>
  /** Network domain allow-list (empty ⇒ no egress). */
  readonly network_allow?: ReadonlyArray<string>
}

/**
 * The SECURITY knobs of a `buildLlmCallSubstrate` spawn, factored out of the
 * per-site inline literals. `buildLlmCallSubstrate` accepts a `profile` and
 * applies these where the individual fields were consumed before.
 */
export interface SubstrateProfile {
  /**
   * Whether to append `--dangerously-skip-permissions` to the spawned REPL
   * argv (threaded to `ClaudeCodeSubstrateOptions.skip_permissions`). TODAY:
   * `true` at all 8 production sites — the headless REPL must not block on
   * interactive prompts. The migration flips this to `false` (paired with
   * `permission_mode: 'dontAsk'`) so an unmatched tool call fails closed
   * instead of being auto-approved. REQUIRED (no default) so every profile is
   * explicit about its grant.
   */
  readonly skip_permissions: boolean
  /**
   * Whether a spawn on this profile carries the instance's GitHub credential —
   * `GH_TOKEN` plus the matching git credential helper (`github/credential.ts`
   * `githubProcessEnv`). It is what makes `gh` and a raw `git push` work inside
   * the spawned REPL's Bash.
   *
   * REQUIRED, WITH NO DEFAULT, AND THAT IS THE POINT. Handing this to a call
   * site instead put the decision in nine places nobody rereads: an agent asked
   * "what PRs are open" and answered out of documentation because ITS site was
   * never updated (`ISSUES.md` #576), and trident builds against a private repo
   * died at `fatal: could not read Username` because THEIRS wasn't either. A
   * required field means a new profile cannot be authored without stating the
   * grant, and a new substrate inherits whatever its profile already decided.
   *
   * ⚠️ IT IS A TRUST DECISION, NOT A CONVENIENCE. `true` gives that spawn push
   * access to every repo the owner's token reaches, so a profile whose input is
   * attacker-influenced (imported history, project docs, onboarding text) must
   * be `false` — the same boundary `enableToolBridge` already draws.
   *
   * Resolution is PER SPAWN, from {@link githubSpawnEnvRef}, so a credential
   * connected after boot works and a rotated one is never stale.
   */
  readonly github_credential: boolean
  /**
   * Whether a spawn on this profile is OWNER-FACING CONVERSATIONAL, and so must
   * never come up on a model below the frontier tier — threaded to
   * `ClaudeCodeSubstrateOptions.frontier_model_floor` and enforced at the
   * persistent substrate's single spawn chokepoint
   * (`runtime/adapters/claude-code/persistent/model-floor.ts`).
   *
   * WHY IT IS ON THE PROFILE. A spawn's model is resolved as
   * `record.model ?? getBestModel()`, so a REPL registry row OVERRIDES the best
   * model, and `spawn.ts` writes the row back with whatever it spawned on — one
   * bad value is permanent. The owner's project chat ran a full day on Haiku
   * twice; a hand-edit of the row held for a few hours and it came back. We never
   * found the writer, so the fix is a floor rather than a patch at one writer.
   *
   * ⚠️ IT IS A TRUST-CLASS DECISION, NOT A QUALITY PREFERENCE, and that is why
   * it is REQUIRED with no default — the same reasoning as `github_credential`
   * directly above. Several profiles run on `FAST_MODEL` DELIBERATELY (scribe
   * extraction, reflection/correction judging, phase-prompt rephrasing): they are
   * latency- and quota-shaped work where Haiku-class quality is the right call,
   * and a floor there would be a regression, not a fix. Deciding per profile
   * means the answer is stated once, next to the trust class it belongs to,
   * instead of being inferred from an instance-id prefix at a spawn site.
   */
  readonly frontier_model_floor: boolean
  /**
   * RESERVED (Phase B) — CC permission mode. `undefined` today; NOT applied by
   * the factory yet (see file header). Reserving it here means Phase B flips a
   * constant, not the factory + 8 sites.
   */
  readonly permission_mode?: SubstratePermissionMode
  /**
   * RESERVED (Phase A) — per-profile scoped `CLAUDE_CONFIG_DIR`. `undefined`
   * today. When a profile sets this, the factory threads it to
   * `ClaudeCodeSubstrateOptions.claude_config_dir` (falling back to the legacy
   * per-call `claude_config_dir` input when the profile leaves it unset), so
   * the redesign can jail a caller's config without a global-config mutation.
   */
  readonly claude_config_dir?: string
  /**
   * RESERVED (Phase A / §8) — env allow-list overlay layered onto the spawn
   * AFTER the auth scrub. `undefined` today. Follows the same
   * `string | undefined` (undefined-deletes) contract as
   * `BuildLlmCallSubstrateInput.extra_env`; when a profile sets this the factory
   * uses it in place of the legacy per-call `extra_env` input.
   */
  readonly extra_env?: () => Promise<Record<string, string | undefined>>
  /**
   * RESERVED (Phase D) — native OS sandbox config. `undefined` today; NOT
   * applied by the factory yet (see file header). Shape only.
   */
  readonly sandbox?: SubstrateSandboxConfig
  /**
   * Per-profile INACTIVITY window (ms), threaded to
   * `ClaudeCodeSubstrateOptions.turnTimeoutMs`. Absent ⇒ the pool's
   * `DEFAULT_TURN_INACTIVITY_MS` (90s).
   *
   * APPLIED, not reserved — unlike the fields above. It exists because the
   * default measures liveness as PTY BYTES, and one profile hosts work that is
   * legitimately silent for minutes (see `PROFILE_WARM_FIRE`). The absolute
   * ceiling (`turn_absolute_ceiling_ms`, 45min default) remains the real backstop,
   * so raising this window cannot make a wedged turn immortal.
   */
  readonly turn_inactivity_ms?: number
}

/**
 * Memory lane — `cc-scribe-*`, `cc-reflection-*`, `cc-reflect-*`. These
 * substrates dispatch `tools: []` (scribe/reflection/reflect-pass) and persist
 * via IN-PROCESS functions, not agent tools; they are ephemeral one-shots. The
 * redesign's memory build ships these FIRST because they are already toolless,
 * so the permission flip is a no-op for them. TODAY: `skip_permissions: true`.
 *
 * Sites: `open/wiring/memory.ts` (cc-scribe / cc-reflection / cc-reflect).
 */
export const PROFILE_TOOLLESS_UTILITY: SubstrateProfile = {
  skip_permissions: true,
  // scribe / reflection do no git work at all — a credential here would be reach without a use.
  github_credential: false,
  // FAST_MODEL here is the DESIGN, not a degradation: extraction and judging are
  // high-frequency, latency-shaped, schema-constrained work. A floor would be a
  // quota and latency regression on the memory lane for no quality the owner reads.
  frontier_model_floor: false,
}

/**
 * The owner's WARM conversational REPL (`cc-agent-*`) — TRUSTED, tool-bridge-on
 * live chat. TODAY: `skip_permissions: true`. Kept DISTINCT from
 * `PROFILE_UNTRUSTED_IMPORT` even though identical now: the redesign keeps the
 * owner's chat grant while tightening the untrusted-import one.
 *
 * Sites: `open/wiring/substrates.ts` — `cc-agent-*` (liveAgentSubstrate) and
 * `cc-nudge-*` (reminderComposeSubstrate, the background proactive-compose lane).
 * The second site is a SESSION split, not a trust split: a fired ritual composes
 * there and ISSUES #504 settled that it must have "access to everything general
 * has access to", so it shares this profile deliberately. What it does NOT share
 * is the pool key — see that file for the outage that forced the split.
 */
export const PROFILE_WARM_CHAT: SubstrateProfile = {
  skip_permissions: true,
  // the owner's own chat. `gh pr list` and `git` in its Bash are the point.
  github_credential: true,
  // THE ONE PROFILE THAT SETS THIS, and now the two substrates that share it. It
  // is the surface the owner builds on, it is the surface the Haiku regression
  // landed on twice in one day, and it is the only one where a lower tier is never
  // a legitimate choice.
  frontier_model_floor: true,
}

/**
 * The phase-spec resolver substrate (`cc-llm-*`) — onboarding/utility LLM calls
 * that rephrase phase prompts. TODAY: `skip_permissions: true`.
 *
 * Site: `open/wiring/substrates.ts` (`cc-llm-*` llmCallSubstrate).
 */
export const PROFILE_PHASE_SPEC: SubstrateProfile = {
  skip_permissions: true,
  // its input is user-controlled onboarding text — a prompt-injection surface.
  github_credential: false,
  // rephrasing a phase prompt that already has a static fallback, under a 3s
  // conversational tier. Fast is the requirement; a floor would spend the budget.
  frontier_model_floor: false,
}

/**
 * The per-project ISOLATED-COMPOSE substrate (`cc-compose-*`) — composes each
 * project's onboarding docs (README / transcript-summary / starting-plan) and
 * its opening message in a per-project-keyed session (#377/#378, Approach A).
 * A DISTINCT trust class kept separate from `PROFILE_PHASE_SPEC` even though
 * identical today: its input is UNTRUSTED project-doc-derived content (imported
 * README/STATUS/transcript slices are a prompt-injection surface), it is TOOLLESS
 * (never `enableToolBridge`), and it carries NO owner-chat delivery sinks — so
 * the redesign can tighten its grant independently. TODAY: `skip_permissions: true`.
 *
 * Site: `open/wiring/substrates.ts` (`makeComposeSubstrate` → `cc-compose-*`).
 */
export const PROFILE_ISOLATED_COMPOSE: SubstrateProfile = {
  skip_permissions: true,
  // composes from imported project docs, which are attacker-influenced content.
  github_credential: false,
  // its callers pass their own model explicitly per composition; this profile does
  // not host the owner's live conversation, so it keeps per-call model choice.
  frontier_model_floor: false,
}

/**
 * The history-import synthesis substrate (`cc-synthesis-*`) — the UNTRUSTED-input
 * caller (imported chat history is a prompt-injection surface). TODAY:
 * `skip_permissions: true`. Kept DISTINCT from `PROFILE_WARM_CHAT`: this is the
 * FIRST grant the redesign tightens (drop skip-permissions → `dontAsk`).
 *
 * Site: `open/composer.ts` (`cc-synthesis-*` importSubstrate).
 */
export const PROFILE_UNTRUSTED_IMPORT: SubstrateProfile = {
  skip_permissions: true,
  // imported chat history is the prompt-injection surface this profile is named for.
  github_credential: false,
  // bulk synthesis over imported history — the callers pick the tier per pass
  // (BEST with a SONNET Pass-2 fallback, P2-v2 S21). A floor would break that.
  frontier_model_floor: false,
}

/**
 * The disposable per-worktree agent-dispatch / Trident-build substrate
 * (`makeEphemeralSubstrate`: `cc-trident-*`, agent-dispatch family). A FRESH
 * ephemeral REPL rooted at the run's worktree, terminated after its turn.
 * TODAY: `skip_permissions: true`.
 *
 * Site: `open/wiring/substrates.ts` (`makeEphemeralSubstrate`).
 */
export const PROFILE_EPHEMERAL: SubstrateProfile = {
  skip_permissions: true,
  // disposable Trident / agent-dispatch builds: they commit and push.
  github_credential: true,
  // agent dispatch is explicitly model-parameterised (a brief names its model);
  // clamping it would silently overrule a caller's deliberate choice.
  frontier_model_floor: false,
}

/**
 * The Trident v2 FIRE seam substrate (`cc-trident-fire-*`) — a WARM (non-
 * ephemeral) per-repo REPL that invokes the native `Workflow` tool and survives
 * the launching turn's settle so the detached background workflow keeps running.
 * TODAY: `skip_permissions: true`.
 *
 * THE INACTIVITY WINDOW IS THE LOAD-BEARING FIELD HERE, and it is why this
 * profile can no longer be a copy of the others.
 *
 * The pool's default turn watchdog is an INACTIVITY window of 90s that advances
 * on every PTY byte the `claude` child emits. That default is right for a chat
 * turn and WRONG for this profile, because the workflow's agents run as
 * SIDECHAINS OF THIS SESSION — so the launching turn stays open for the whole
 * build, and a reasoning-heavy step emits nothing to the terminal while it
 * thinks. On a trip the substrate does not merely fail the turn: it POISONS AND
 * RESPAWNS the warm session, which kills the detached build the session is
 * hosting.
 *
 * That is not hypothetical. Both owner attempts at the Email Core P1 build died
 * this way (2026-08-07 and 2026-08-10). The Aug 7 run: `plan:fable` — Fable at
 * MAX reasoning effort, reading SPEC.md plus a governed plan doc and surveying
 * the code — went quiet, the window tripped, the planner's transcript ends with
 * `[Request interrupted by user]` at 23:19:21, and `repl-respawn ...
 * cc-trident-fire-juno ... session=77fa6d70` is logged 8 seconds later. No
 * checkpoint reached, no PR opened, no parseable result — surfacing to the owner
 * as "terminal result missing/garbled". Ralph mode's FIRST step is the most
 * expensive one in the pipeline, so the bigger the plan the more certainly it
 * died: the build could essentially never succeed.
 *
 * The irony worth recording: this watchdog REPLACED a fixed 180s wall-clock cap
 * that was removed on 2026-07-01 precisely because it killed one of the owner's
 * working builds mid-turn. The replacement kills a working build too — same
 * outcome, new mechanism — because "actively working" is measured as terminal
 * chatter, which a thinking model does not produce. The constant's own docblock
 * still claims an actively-working turn "runs as long as it needs".
 *
 * So this profile opts out of the chatter heuristic and relies on the ABSOLUTE
 * CEILING (45min default) as its backstop. A launcher that is genuinely wedged
 * still dies; one whose planner is thinking does not.
 *
 * Site: `open/wiring/substrates.ts` (`makeWarmFireSubstrate`).
 */
export const PROFILE_WARM_FIRE: SubstrateProfile = {
  skip_permissions: true,
  // Trident v2's build loop. Without it a run against a PRIVATE repo dies at
  // `fatal: could not read Username for 'https://github.com'` — measured on the
  // owner's instance 2026-08-15, where every enterprise dispatch built, committed
  // and then failed, burning a full Forge round each time.
  github_credential: true,
  // the workflow routes its own steps per model (`plan:fable` and friends resolve
  // from `runtime/models.ts`); the launcher must not overrule them.
  frontier_model_floor: false,
  // 30min of silence. Deliberately BELOW the 45min absolute ceiling so the
  // ceiling stays the terminal authority and this window can never make a turn
  // immortal, and far above any plausible silent-thinking stretch.
  turn_inactivity_ms: 30 * 60_000,
}

/**
 * The instance's GitHub spawn-env resolver, registered ONCE at composition.
 *
 * A module-level holder rather than a factory input for the same reason
 * `replToolBridgeRef` is one: the value is a property of the single running
 * instance, and threading it through nine construction sites is exactly the
 * per-site decision this file exists to remove. Open is single-owner — one
 * instance, one GitHub credential.
 *
 * Unset ⇒ every spawn behaves exactly as it does today, so a build that never
 * registers one (tests, an instance with no GitHub connected) is unaffected.
 */
export const githubSpawnEnvRef: {
  resolve: (() => Promise<Record<string, string | undefined>>) | undefined
} = { resolve: undefined }

/** Register the instance's resolver. Called once, by the composer. */
export function setGithubSpawnEnvResolver(
  resolve: () => Promise<Record<string, string | undefined>>,
): void {
  githubSpawnEnvRef.resolve = resolve
}
