/**
 * Layering ratchet for neutron-open — G4 (world-class-refactor plan §G4).
 *
 * Source of truth for the five bands + the target DAG this encodes:
 * docs/research/refactor-audit-2026-07-02/critic-layering.md §2.2 / §9.1.
 * That audit measured 175 distinct production module→module edges forming a
 * single 28-module strongly-connected component (no layering at all, today).
 * This config is the ratchet that (a) freezes the current mess as a
 * grandfathered baseline (`.dependency-cruiser-known-violations.json`, see
 * `scripts/ci/depcruise-baseline.sh`) so CI does not go red on day one, and
 * (b) fails the build on any *new* cross-band edge from here on, so the
 * baseline can only shrink as the §2.1 cut-list PRs land.
 *
 * A module may import its own band or any band strictly below it, per this
 * order (low → high): contracts < platform < services < product < composition.
 *
 * Band assignment follows the audit's §2.2 five-band model verbatim, with one
 * documented completion: the audit's own topo-sort (§2.2, "L1") places
 * `project-credentials` alongside `runtime`/`cron`/`tools`/`app` — one layer
 * above the true leaves — but the `L` band-map sketch in §9.1 omitted it
 * entirely (an oversight, not a call to leave it unbanded: its only outgoing
 * edge is `project-credentials → persistence`, a leaf, and it is consumed only
 * by `gateway`/`open`, i.e. composition). It is placed in `platform` here,
 * matching its measured position. No new band was invented — this assigns an
 * existing module into the plan's existing bands.
 */

/** Layer bands; a module may import its own band or lower. */
const L = {
  contracts: [
    '^persistence',
    '^migrations',
    '^chat-core',
    '^core-sdk',
    '^cores/sdk',
    '^jwt-validator',
    '^prompts',
    '^tabs',
  ],
  platform: ['^runtime', '^cron', '^tools', '^channels', '^auth', '^project-credentials'],
  services: [
    '^scribe',
    '^gbrain-memory',
    '^reflection',
    '^doc-search',
    '^message-search',
    '^reminders',
    '^tasks',
    '^work-board',
    '^trident',
    '^agent-dispatch',
    '^skill-forge',
    '^watchdog',
    '^landing',
    '^connect',
    '^cores/runtime',
    '^mcp',
  ],
  product: ['^onboarding', '^cores/free', '^app'],
  composition: ['^gateway', '^open'],
};

module.exports = {
  options: {
    doNotFollow: { path: 'node_modules' },
    // Everything the audit's scanner walked (top-level workspaces + the
    // no-package.json floating dirs: open/, tabs/, work-board/,
    // project-credentials/). Anything not matched here (docs/, scripts/,
    // tests/, bin/, skills/) is out of scope for the layering ratchet.
    includeOnly:
      '^(gateway|runtime|scribe|reflection|gbrain-memory|reminders|trident|agent-dispatch|tasks|skill-forge|cron|doc-search|message-search|cores|prompts|mcp|tools|migrations|persistence|core-sdk|jwt-validator|channels|chat-core|connect|watchdog|auth|onboarding|landing|app|open|tabs|work-board|project-credentials)/',
    // Test-file policy (verifier amendment, plan §G4): the measured 28-module
    // SCC is WITH test files; production-only it's 19. Exempting __tests__/
    // *.test.* edges from the band rules is what lets the baseline burn down
    // as production cuts land, instead of being permanently pinned by test
    // helpers that legitimately reach across bands to set up fixtures.
    // `no-cycles` below still runs over the *whole* graph (tests included),
    // so a NEW test-introduced production cycle still fails the build — this
    // only exempts test edges from the one-directional band-ordering rules.
    exclude: { path: '(__tests__|\\.test\\.|(^|/)tests/)' },
    tsConfig: { fileName: 'tsconfig.base.json' },
  },
  forbidden: [
    {
      name: 'no-cycles',
      comment:
        'No import cycles anywhere in the graph (production or test). This is the ' +
        "audit's headline finding (28-module SCC) inverted into a gate: today every " +
        'edge that forms a cycle is grandfathered by the baseline file; new cycles ' +
        'are never grandfathered.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'contracts-are-leaves',
      comment: 'Contracts & leaves (persistence, migrations, chat-core, core-sdk, ' +
        'cores/sdk, jwt-validator, prompts, tabs) must not import anything above them.',
      severity: 'error',
      from: { path: L.contracts },
      to: { path: [...L.platform, ...L.services, ...L.product, ...L.composition] },
    },
    {
      name: 'platform-stays-low',
      comment: 'Platform (runtime, cron, tools, channels, auth, project-credentials) ' +
        'must not import services/product/composition.',
      severity: 'error',
      from: { path: L.platform },
      to: { path: [...L.services, ...L.product, ...L.composition] },
    },
    {
      name: 'services-below-product',
      comment: 'Services & memory must not import product surfaces or composition.',
      severity: 'error',
      from: { path: L.services },
      to: { path: [...L.product, ...L.composition] },
    },
    {
      name: 'only-composition-imports-product-surfaces',
      comment: 'Only gateway/open may import onboarding (the flagship product ' +
        'surface); other product surfaces (cores/free/*, app) must not reach into it.',
      severity: 'error',
      from: { path: L.product, pathNot: '^onboarding' },
      to: { path: '^onboarding' },
    },
    {
      name: 'nobody-imports-composition',
      comment: 'Composition (gateway, open) is the top of the stack; nothing else ' +
        'may import it (open<->gateway is the one mutual exception, both being ' +
        'composition, which this rule already allows).',
      severity: 'error',
      from: { pathNot: ['^open', '^gateway'] },
      to: { path: ['^gateway', '^open'] },
    },
    {
      name: 'cores-use-sdk-only',
      comment: "Cores platform boundary (audit §8): a bundled Core's only " +
        'legitimate cross-module deps are cores/sdk + cores/runtime + npm deps. ' +
        'Reaching into gateway/open/onboarding/connect/runtime/migrations/auth/' +
        'landing is the "third-party fiction" violation the audit documents.',
      severity: 'error',
      from: { path: '^cores/free' },
      to: { path: '^(gateway|open|onboarding|connect|runtime|migrations|auth|landing)/' },
    },
    {
      name: 'connect-is-dynamic-only',
      comment: 'connect/api/* is the federation surface that must stay behind a ' +
        'dynamic import (runtime/platform-adapter-local.ts sets composition.connect_api ' +
        ':false for Open) — a static edge here would make every Open boot load ' +
        'federation code (audit §10.1). gateway/composition is the one place allowed ' +
        'to reference it statically (the composition wiring that decides whether to ' +
        'dynamic-import it at all).',
      severity: 'error',
      from: { pathNot: '^(connect|gateway/composition)' },
      to: { path: '^connect/api/' },
    },
    {
      name: 'app-bundle-purity',
      comment: 'The Expo/RN bundle (app/) must never transitively import server-only ' +
        'workspaces — node:sqlite etc. bricks the bundle (audit §10.2). This is why ' +
        'app/lib/ws-envelope.ts, doc-links.ts, tabs-client.ts exist as hand mirrors ' +
        'today instead of imports.',
      severity: 'error',
      from: { path: '^app/' },
      to: { path: '^(gateway|runtime|persistence|migrations|onboarding|channels|auth|connect)/' },
    },
  ],
};
