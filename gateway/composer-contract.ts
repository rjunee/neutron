/**
 * gateway/composer-contract.ts — the DOCUMENTED composer seam.
 *
 * This barrel is the single, stable surface a graph composer (the Open
 * single-owner composer in `open/composer.ts`, or an external Managed
 * production composer dynamic-imported via the
 * `NEUTRON_GRAPH_COMPOSER_MODULE` env seam while the entrypoint is
 * suspended at its top-level `await loadGraphComposerFromEnv()`) builds
 * against. It re-exports every boot-time helper + composition-seam type
 * the composer needs, sourced from the cohesive cluster modules the C2
 * refactor split the former monolithic `gateway/boot-helpers.ts` into:
 *
 *   - `boot-listener-registry.ts`   — port / registry / owner-home /
 *                                     repo-root resolvers + deterministic
 *                                     HTTP-listener bind
 *   - `boot-composition-types.ts`   — the GraphComposer / HttpHandler /
 *                                     ListProjectsResolver seam types
 *   - `boot-chat-command-filters.ts`— the Tier-1 Core `/`-command filters
 *                                     + the reminder-pattern loader
 *   - `boot-cores-factories.ts`     — the per-slug Cores backend factory map
 *   - `boot-research-wiring.ts`     — the Research Core substrate LLM call
 *
 * Why a seam module (and not just deep imports): the composer graph must
 * NOT contain the entry module (`gateway/index.ts`) at all — importing
 * helpers back from the entry created a top-level-await entry↔composer
 * cycle that completes under Bun's current loader but can deadlock under
 * a strict reading of the ESM TLA spec, and prod bun is PATH-pinned, not
 * version-pinned. Every module re-exported here is import-clean of both
 * `gateway/index.ts` and the Managed tier, so a composer that builds
 * only against this contract can never re-introduce that cycle. The
 * no-cycles depcruise rule is a HARD error, so this boundary is enforced.
 *
 * NOTE (Managed contract): `gateway/index.ts` re-exports this same surface
 * for existing importers; the Managed gate pins `startOpenServer` / healthz
 * / `/chat` / agent-name-suggester on the entry module, none of which live
 * here. Changing the set re-exported below is a composer-contract change —
 * coordinate with `open-contract.ts` / the M3 rider before touching it.
 */

export {
  resolveRegistryDbPath,
  resolveOwnerRegistryRow,
  resolveListenPort,
  resolveOwnerHome,
  resolveRepoRoot,
  bindHttpListener,
} from './boot-listener-registry.ts'
export type {
  BootOwnerRow,
  BootOwnersRegistry,
  OwnerRegistryLookupResult,
  BoundHttpServer,
} from './boot-listener-registry.ts'

export type {
  GraphComposer,
  HttpHandler,
  ListProjectsResolver,
} from './boot-composition-types.ts'

export {
  buildChainedChatCommandFilter,
  buildRemindersChatCommandFilter,
  buildTridentCodeChatCommandFilter,
  buildCalendarChatCommandFilter,
  buildStatusChatCommandFilter,
  formatStatusSnapshot,
  buildResetChatCommandFilter,
  formatResetOutcome,
  readPatternFromPrompts,
} from './boot-chat-command-filters.ts'
export type { StatusSnapshot, ResetChatOutcome } from './boot-chat-command-filters.ts'

export {
  buildCoresBackendFactories,
  wrapResearchBackendWithDefaultProjectId,
} from './boot-cores-factories.ts'
export type { TasksCoreOwnerRegistry } from './boot-cores-factories.ts'

export { buildResearchLlmCallForOwner } from './boot-research-wiring.ts'
