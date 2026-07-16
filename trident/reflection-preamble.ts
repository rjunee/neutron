/**
 * @neutronai/trident — RB2 (b) reflection-preamble derivation.
 *
 * The owner's recent reflection corrections/diary reach the FORGE BUILDER agents by
 * being prepended to the Forge build + fix-round prompts in the inner workflow (NOT
 * the independent review gate — see the trust boundary in `build-agent-prompt.ts`).
 * The DERIVATION of that preamble — null/whitespace/non-string context is a clean
 * no-op (''), a real block becomes the block + a blank-line separator — is extracted
 * HERE as a pure, importable unit so it is verified BEHAVIORALLY.
 *
 * Why not inline it in `trident/inner-workflow.mjs`? That script is NOT runnable
 * under plain bun/node (its `agent`/`parallel`/`phase` globals are injected by the
 * CC Workflow runtime and its top-level `return` is the runtime's result API — see
 * `inner-workflow.test.ts`), so any logic inlined there can only be asserted by
 * source-string match, never executed. The launcher computes the preamble here (in
 * `buildWorkflowArgs`) and threads the READY string through the workflow args, so
 * the `.mjs` merely prepends a pre-derived, already-tested value.
 */

/**
 * Derive the owner-corrections preamble from a reflection context block.
 *
 * Returns `''` (a clean no-op — the agent prompt stays byte-identical to pre-RB2)
 * for anything that is not a non-empty, non-whitespace string: `null`, `undefined`,
 * an empty/whitespace-only string, or a non-string value. For a real block, returns
 * the TRIMMED block followed by a blank-line separator so it sits cleanly ABOVE the
 * agent's own contract.
 */
export function buildReflectionPreamble(reflectionContext: unknown): string {
  return typeof reflectionContext === 'string' && reflectionContext.trim().length > 0
    ? `${reflectionContext.trim()}\n\n`
    : ''
}
