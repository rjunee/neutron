/**
 * @neutronai/trident — the one live Forge/Argus prompt constant.
 *
 * HISTORY: this module used to render the Forge/Argus/Ralph prompts and
 * parse their locked terminal contract for the v1 exec-model outer loop
 * (`session.ts` + `substrate-dispatch.ts`, both deleted). That loop is gone.
 *
 * The LIVE Forge→Argus→fix build loop is a single native CC Dynamic Workflow,
 * `trident/inner-workflow.mjs`, fired per run by `trident/inner-loop.ts`. The
 * Forge/Argus execution contracts are INLINED there (they are heavily
 * parameterized — isPr/local-mode branching, crash-resume re-entry, the
 * FORGE_SCHEMA structured report, the codex cross-model panelist) in a way a
 * flat render template cannot express. `inner-workflow.mjs` is therefore the
 * SINGLE live source of the Forge/Argus contract. The `prompts/forge.md` /
 * `prompts/argus.md` files are kept only as NON-LIVE human reference (see the
 * header comment in each) — nothing loads them at runtime anymore.
 *
 * Only `ARGUS_DIFF_LINE_LIMIT` survived the v1 deletion: `orchestrator.ts` (the
 * live harvester step) reads it to size the pre-spawn diff probe.
 */

/**
 * Diff-size ceiling (in changed lines) above which Argus must NOT read
 * the diff in one shot. Verbatim from Vajra's SKILL.md oversized-diff
 * rule ("only if that diff is under 3000 lines"). The live enforcement is
 * `inner-workflow.mjs`'s ARGUS_RUBRIC ("never read a >~3000-line diff in one
 * shot"); `orchestrator.ts` uses this constant to size its diff probe.
 */
export const ARGUS_DIFF_LINE_LIMIT = 3000
