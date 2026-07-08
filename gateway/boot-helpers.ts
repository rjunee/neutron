/**
 * gateway/boot-helpers.ts — BACK-COMPAT SHIM (C2 refactor).
 *
 * The former monolithic boot-helpers module was split along its
 * factory-cluster structure into cohesive ≤~400-line modules, aggregated
 * behind the documented composer seam `gateway/composer-contract.ts`:
 *
 *   - boot-listener-registry.ts    (port / registry / owner / listener)
 *   - boot-composition-types.ts    (GraphComposer / HttpHandler / ListProjectsResolver)
 *   - boot-chat-command-filters.ts (Tier-1 Core `/`-command filters + pattern loader)
 *   - boot-cores-factories.ts      (per-slug Cores backend factory map)
 *   - boot-research-wiring.ts      (Research Core substrate LLM call)
 *
 * This file is retained ONLY so existing importers of `./boot-helpers.ts`
 * (the gateway entry barrel, `open/composer.ts`, `gateway/cores/*`, and
 * the gateway test suite) keep resolving unchanged. New code should import
 * from `./composer-contract.ts` (the seam) or the specific cluster module.
 *
 * DEAD-CODE REMOVAL (C2): the 8 export symbols
 * `createTasksCoreOwnerRegistry`, `defaultListProjects`,
 * `loadAnthropicOAuthConfigFromEnv`, `resolveIdentityPublicBaseUrl`,
 * `resolveBaseDomain`, `buildMaxOAuthGateHandler`, `buildMaxOauthHandoffUrl`,
 * and `buildGateLandingServer` had ZERO consumers in either repo and were
 * deleted (co-deleted with their `gateway/index.ts` re-export block). The
 * `TasksCoreOwnerRegistry` interface + `ListProjectsResolver` type survive
 * (live contract types) and are re-exported below.
 *
 * boot-helpers MUST NEVER import `gateway/index.ts` (the entry↔composer TLA
 * cycle ban — a HARD depcruise error). The shim only re-exports the seam.
 */

export * from './composer-contract.ts'
