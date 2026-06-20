/**
 * Open-resident INTERVIEW test kit (ISSUES #223, 2026-06-13).
 *
 * The Open subset of the former `tests/integration/m2-walkthrough-test-helpers.ts`:
 * `stubRouter`, `stubPlatform`, and the `RouterCall` shape. These three
 * depend ONLY on `@neutronai/*` Open packages, so they belong in the
 * kept Open tree (the #219 `start-token-testkit.ts` precedent).
 *
 * WHY THIS LIVES HERE
 * ───────────────────
 * `tests/` is NOT in `scripts/sprint-c/open-paths.txt`, so the Sprint-C
 * carve (`scripts/sprint-c/carve-open-tree.sh`) strips the whole `tests/`
 * subtree, then runs `bun test` INSIDE the carved tree as a hard gate.
 * The 7 Open-co-located `onboarding/interview/__tests__/` tests that
 * imported the old `m2-walkthrough-test-helpers.ts` would `import`-fail
 * there and abort the carve (ISSUES #223). The Managed-only remainder of
 * that helper (`bootEngineAtPhase`, `buildFixtureFedRouter`, `stateAfter`,
 * `lastAgentBubble`) pulls a type from `scripts/e2e/m2-walkthrough.ts`
 * (`scripts/` is Managed, never carved), so it CANNOT move here — it
 * stays in `tests/integration/m2-walkthrough-test-helpers.ts` and now
 * re-exports this Open subset rather than redefining it.
 */

import type {
  LlmRouter,
  RouterDecision,
  RouterInput,
} from '@neutronai/onboarding/interview/llm-router.ts'
import type { OnboardingPhase } from '@neutronai/onboarding/interview/phase.ts'
import type {
  PlatformAdapter,
  PlatformInstanceInfo,
} from '@neutronai/runtime/platform-adapter.ts'

// ---------------------------------------------------------------------------
// stubRouter — scripted decision feed
// ---------------------------------------------------------------------------

export interface RouterCall {
  input: RouterInput
}

/** Build a stub `LlmRouter` that yields `answers` in order on each
 *  `route()` call. Throws when the queue is empty. The `calls` array is
 *  appended to so tests can assert on the inputs the engine handed in. */
export function stubRouter(answers: Iterable<RouterDecision>): {
  router: LlmRouter
  calls: RouterCall[]
} {
  const queue = [...answers]
  const calls: RouterCall[] = []
  const router: LlmRouter = {
    async route(input) {
      calls.push({ input })
      const decision = queue.shift()
      if (decision === undefined) {
        throw new Error('stubRouter: queue empty')
      }
      return decision
    },
  }
  return { router, calls }
}

// ---------------------------------------------------------------------------
// stubPlatform — minimal PlatformAdapter that flips on the conversational
// router for the listed phases (or all when `'all'`).
// ---------------------------------------------------------------------------

export const DEFAULT_HELPER_OWNER_INFO: PlatformInstanceInfo = {
  internal_handle: 'h1',
  url_slug: 't1',
  owner_home: '/tmp/x',
  agent_name: null,
  tier: 'open',
  kind: 'user',
}

export function stubPlatform(
  conversational: 'all' | ReadonlyArray<OnboardingPhase>,
  self: PlatformInstanceInfo = DEFAULT_HELPER_OWNER_INFO,
): PlatformAdapter {
  const phases =
    conversational === 'all' ? 'all' : new Set<OnboardingPhase>(conversational)
  return {
    capabilities: {
      slug_rename: false,
      install_token_mint: false,
      connect_fanout: false,
      manager_bot_provisioning: false,
      caddy_reload: false,
      sudoers_regenerate: false,
      tier_two_cores: false,
      project_backup: false,
      signup_recover: false,
      start_token_verify: false,
      internal_signature: false,
      connect_api: false,
    },
    slugAvailability: {
      check: () => ({ slug: '', available: true, reason: null }),
      sanitize: (s) => s,
    },
    resolveOwnerBySlug: (s) => (s === self.url_slug ? self : null),
    resolveOwnerByInternalHandle: (h) =>
      h === self.internal_handle ? self : null,
    renameSlug: async () => ({ status: 'rejected', reason: 'invalid_format' }),
    mintInstallToken: async () => {
      throw new Error('not supported')
    },
    oauthHandoff: async () => {
      throw new Error('not supported')
    },
    connectCall: async () => ({ status: 0, body: null }),
    provisionManagerBot: async () => {
      throw new Error('not supported')
    },
    reloadCaddy: async () => undefined,
    regenerateSudoers: async () => undefined,
    getBundledCoreRoots: () => [process.cwd()] as const,
    getOnboardingConversational: () =>
      phases === 'all' ? true : phases.size > 0,
    getOnboardingConversationalPhases: () => phases,
    getProjectBackupRemoteConfig: async () => null,
    setProjectBackupRemoteConfig: async () => {
      throw new Error('not supported')
    },
    clearProjectBackupRemoteConfig: async () => {
      throw new Error('not supported')
    },
    generateProjectBackupKeypair: async () => {
      throw new Error('not supported')
    },
  }
}
