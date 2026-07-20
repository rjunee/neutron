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
  readonly extra_env?: Record<string, string | undefined>
  /**
   * RESERVED (Phase D) — native OS sandbox config. `undefined` today; NOT
   * applied by the factory yet (see file header). Shape only.
   */
  readonly sandbox?: SubstrateSandboxConfig
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
}

/**
 * The owner's WARM conversational REPL (`cc-agent-*`) — TRUSTED, tool-bridge-on
 * live chat. TODAY: `skip_permissions: true`. Kept DISTINCT from
 * `PROFILE_UNTRUSTED_IMPORT` even though identical now: the redesign keeps the
 * owner's chat grant while tightening the untrusted-import one.
 *
 * Site: `open/wiring/substrates.ts` (`cc-agent-*` liveAgentSubstrate).
 */
export const PROFILE_WARM_CHAT: SubstrateProfile = {
  skip_permissions: true,
}

/**
 * The phase-spec resolver substrate (`cc-llm-*`) — onboarding/utility LLM calls
 * that rephrase phase prompts. TODAY: `skip_permissions: true`.
 *
 * Site: `open/wiring/substrates.ts` (`cc-llm-*` llmCallSubstrate).
 */
export const PROFILE_PHASE_SPEC: SubstrateProfile = {
  skip_permissions: true,
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
}

/**
 * The Trident v2 FIRE seam substrate (`cc-trident-fire-*`) — a WARM (non-
 * ephemeral) per-repo REPL that invokes the native `Workflow` tool and survives
 * the launching turn's settle so the detached background workflow keeps running.
 * TODAY: `skip_permissions: true`.
 *
 * Site: `open/wiring/substrates.ts` (`makeWarmFireSubstrate`).
 */
export const PROFILE_WARM_FIRE: SubstrateProfile = {
  skip_permissions: true,
}
