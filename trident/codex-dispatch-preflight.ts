/**
 * @neutronai/trident — REFUSE A DOOMED LANE BEFORE IT SPAWNS.
 *
 * A build dispatched onto a revoked Codex seat does not fail fast. It spawns a
 * lane, resolves a workspace, assembles a brief, and only then hands the brief to
 * `codex exec`, which dies on `refresh_token_invalidated` — measured at ~15
 * minutes, and reported with a cause that names the CLI rather than the
 * credential. Nothing between the status read and that model call was capable of
 * noticing, because every check in the chain (`codex_status`,
 * `codex login status`) reads local files.
 *
 * ── WHY THIS IS NARROW ON PURPOSE ────────────────────────────────────────────
 * THE SCOUT'S PLAN SAID "refuse the dispatch when the seat is revoked". Taken
 * literally that is an OUTAGE, not a fix: the `build` phase defaults to `opus`
 * and most installs never move it, so a revoked codex seat — which for them only
 * degrades the cross-model REVIEW panel, something the codebase deliberately
 * treats as never-a-blocker — would have stopped every build on the box.
 *
 * So the refusal is conditioned on the build ACTUALLY DISPATCHING TO CODEX: the
 * owner's `build` phase override (or its default) resolving to a tier in the
 * `codex` executor group. A Claude build with a dead codex seat proceeds exactly
 * as it does today.
 *
 * ── AND WHY IT ONLY EVER REFUSES ON A POSITIVE VERDICT ──────────────────────
 * The only fact that blocks is `everySeatRevoked` — every connected seat cooled
 * `unauthorized`, a state written ONLY from an HTTP 401/403 on a token that has
 * not expired. An unreachable endpoint, a 5xx, a 429 and a moved endpoint all
 * leave it false. A box with no egress to chatgpt.com dispatches builds forever,
 * unchanged.
 */

import { modelTier } from './model-tiers.ts'
import { phaseByKey, type ModelTier } from './phase-models.ts'

/** The phase key whose executor decides whether a BUILD needs the codex seat. */
export const BUILD_PHASE_KEY = 'build'

export type CodexDispatchPreflight = { ok: true } | { ok: false; reason: string }

/**
 * Does this owner's configured BUILD phase dispatch to the codex executor?
 *
 * Derived from the SAME registry the pane and the workflow read (`modelTier`), so
 * a tier added to the codex group is covered here for free — and a tier moved out
 * of it can never leave this function asserting a stale membership.
 */
export function buildPhaseRunsOnCodex(
  config: Readonly<Record<string, { model?: string; effort?: string }>>,
): boolean {
  const phase = phaseByKey(BUILD_PHASE_KEY)
  if (phase === null) return false
  const chosen = config[BUILD_PHASE_KEY]?.model
  const tier = (typeof chosen === 'string' && chosen.length > 0 ? chosen : phase.default.tier) as ModelTier
  return modelTier(tier)?.group === 'codex'
}

export interface CodexDispatchPreflightDeps {
  /** The owner's per-phase model overrides, read PER DISPATCH (it is a live control). */
  phaseModels: () => Readonly<Record<string, { model?: string; effort?: string }>>
  /** Probe every seat (TTL-cached). Must never throw. */
  refreshLiveness: () => Promise<void>
  /** Whether EVERY connected seat is cooled `unauthorized` after that refresh. */
  everySeatRevoked: () => boolean
  /** The owner-facing refusal text, so the pane and the tool cannot word it differently. */
  reason: () => string
}

/**
 * Run the preflight. Returns `{ok:true}` for every case that is not a positively
 * measured revocation of a seat this build needs — including every error path.
 */
export async function codexDispatchPreflight(
  deps: CodexDispatchPreflightDeps,
): Promise<CodexDispatchPreflight> {
  let onCodex: boolean
  try {
    onCodex = buildPhaseRunsOnCodex(deps.phaseModels())
  } catch {
    // A settings read must never block a build launch — the same rule the phase
    // config's own reader follows.
    return { ok: true }
  }
  if (!onCodex) return { ok: true }
  try {
    await deps.refreshLiveness()
    if (!deps.everySeatRevoked()) return { ok: true }
    return { ok: false, reason: deps.reason() }
  } catch {
    return { ok: true }
  }
}
