# Neutron Open — World-Class Refactor Plan

**Date:** 2026-07-02 · **Author:** Fable 5 (full-codebase audit: 17 subsystem maps + 12 cross-cutting critics + adversarial verification) · **Status:** APPROVED-PENDING-KICKOFF

> **Verification status:** all 24 merged audit findings ran through independent
> adversarial verification — **24/24 CONFIRMED, 0 refuted** — folded in as "Verifier
> amendment" notes.
>
> **Decision-queue investigation (2026-07-02, workflow wf_0e3ece3b-db6):** 5 read-only
> investigators against BOTH repos resolved every open question. Headline correction:
> **the feared "invisible Managed composer" does not exist** — neutron-managed runs each
> tenant as a stock vendored `open/server.ts` (submodule), coupling to Open through just
> 2 source imports + an 8-surface process contract in `open-contract.ts` (§0 rule 3).
> This flipped several dispositions: slug-picker and import-pipeline are DELETE (not
> relocate); `internal_handle` rename is Open-internal (no compat window); the onboarding
> "loser" is already dead code so K11 is de-risked; C2's dead boot-helpers exports are
> deletable. Added: a Managed **M-phase** (§14.5, M0 CI first), the **W0=Option D** UX
> decision (web-canonical + Expo shell), and the **K10 Ralph-governed-mode** sequencing
> caveat. Reports: `docs/research/refactor-audit-2026-07-02/{managed-abi-grep,map-managed,onboarding-active-path,ux-architecture-options,spec-shape}.md`.

Evidence base: `docs/research/refactor-audit-2026-07-02/` (untracked working docs — see
§1.4 before tracking them). Every unit below also carries its own `file:line` anchors
into the code so an agent can execute it **without** reading the audit.

---

## 0. Mission & ground rules (locked by Ryan, 2026-07-02)

1. **No functionality changes.** The refactor preserves product behavior. Units that
   *do* change observable behavior (durability fixes, security hardening, silent-404
   fixes) are tagged `[BEHAVIOR]` and are deliberate, individually-reviewable changes —
   never smuggled inside a structural PR.
2. **Dedicated refactor window.** Feature work is paused; this plan is the backlog.
3. **Nothing is frozen — and the real Managed ABI is tiny (investigation-corrected).**
   Workspace names/layout, HTTP/WS wire contracts, DB schema (via migrations), and
   package APIs may all change. No external users yet. Ryan owns and directs the
   refactor of **neutron-managed** (`~/repos/neutron-managed`, ~10.6k src LOC) alongside
   this repo. **Crucially, the "private Managed composer consuming gateway internals via
   `NEUTRON_GRAPH_COMPOSER_MODULE`" is STALE (old-monorepo) — it does not exist.** The
   ABI grep proved Managed runs each tenant as a **stock vendored `open/server.ts`
   process** (git submodule at `vendor/neutron`, systemd unit per tenant) and injects no
   code. The entire real coupling is:
   - **2 source imports:** `buildDiverseAgentNameFallback`
     (`onboarding/interview/agent-name-suggester.ts`, `{picks:[{name,tagline}]}` shape)
     and a test-only `ambientClaudeAuthDisabled`.
   - **A process contract** pinned in `neutron-managed/src/ops/open-contract.ts` (8
     surfaces): `open/server.ts` path + `startOpenServer`; `gateway/index.ts` healthz
     literals (`defaultHealthzHandler`, `/healthz`, `project_slug`, `status:'ok'`);
     `open/composer.ts` contains `'/chat'`; the agent-name-suggester path+export; and 7
     `buildTenantEnv` env-var names (`NEUTRON_HOME`, `NEUTRON_DB_PATH`,
     `NEUTRON_INSTANCE_SLUG`, `NEUTRON_PORT`, `NEUTRON_HOST`,
     `NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET`, `NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH`),
     each of which must stay **read under `open/` or `gateway/`** (the gate's
     `ENV_READ_DIRS` heuristic).
   - The gate is **path+substring** matched, NOT symbol-matched — so *moving* the
     healthz handler out of `gateway/index.ts` or splitting `open/composer.ts` breaks
     the Managed deploy gate even if every name survives. Any file-relocation unit that
     touches these 8 surfaces ships a paired `open-contract.ts` update in the same wave.
   - `NEUTRON_GRAPH_COMPOSER_MODULE` and `NEUTRON_POST_ONBOARDING_CLAIM_URL` are
     zero-consumer forward seams (M-phase decides: thread or delete).
   - **`neutron-managed-contract` is not a repo** — it's a stale git *worktree* of
     neutron-managed frozen at the gate-introduction commit; treat Managed HEAD's
     `open-contract.ts` as the single authority (delete the worktree in M-phase).
   The C2 barrel still lands (right seam), but drops its "Managed boots against the
   barrel" acceptance — there's no such consumer.
4. **Trident keeps the Workflow-tool inner loop.** The Option-A rearchitecture
   (gateway-orchestrated dispatches) is REJECTED and its design doc deleted. Trident
   units here are cleanup-only and preserve the Workflow orchestration model.
5. **Full test coverage is maintained** per the policy in §2.
6. **One path per feature, zero feature flags** (Ryan, Q4): no duplicate code paths
   anywhere; exploratory-era alternates get resolved to a single implementation (K11
   owns the census + purge; C5, W3, and the K-phase deletions are instances of it).

### 0.1 What the audit established (headline)

- One ~3,220-line async closure (`open/composer.ts:396-3615`) is the composition root,
  an HTTP middleware, and an HTML templater at once; wiring one HTTP surface costs
  8–10 edits across 4+ files and omissions 404 silently (already-drifted bookkeeping:
  `gateway/composition.ts:264-295` misses 4 mapped surfaces).
- The module graph has **no layering**: 28 of ~44 modules form one strongly-connected
  component; 87% of cross-module imports are relative-path escapes; package manifests
  are decorative. Cutting **11 specific edges (~15 files)** yields a clean DAG.
- Real durability holes: the live import pipeline holds completed results only in a RAM
  Map; the dispatched-agent registry is memory-only; both general watchdog systems are
  decorative (no-op notifier / never scheduled).
- Ceremonial contracts: capability gate + HITL approvals inert at the only dispatch
  chokepoint; channel-adapter architecture has zero registered adapters; substrate
  errors are classified by regexing message prose (three past P0s trace to this); the
  chat transcript is dual-persisted at different fidelity.
- Security is below the stated public-launch bar: the owner surface is unlocked by the
  literal string `dev:owner`; `/api/app/*` + the WS upgrade sit outside the cookie gate;
  no Origin check on WS; backups bundle the AES key with its ciphertext.
- ~15 verified-dead modules (~6k source LOC + ~10k test LOC) including the whole
  per-chunk import pipeline; three overlapping changelogs written inconsistently by
  agent prompts with two colliding filename conventions.

---

## 1. Execution model

### 1.1 One unit = one trident run = one PR

Every unit below is scoped to be executed **by an agent in isolation** (fresh worktree,
`bun install`, no shared context with other units). The standard pipeline per unit:

| Stage | Who | What |
|---|---|---|
| **Plan** | **Fable 5** | Reads the unit spec (+ optionally the referenced audit file), expands it into a concrete build brief (file-level steps, test list, invariant checklist), confirms the unit's serialization lane is free, dispatches the run. |
| **Build → review loop** | **Workhorse per the unit's `model` column** (Forge builder + Argus reviewer) | Build in an isolated worktree; run leaf `tsc` for every touched workspace + the affected suites each iteration; full `bash scripts/run-tests.sh` in the clean worktree before requesting merge; loop until Argus APPROVE. |
| **Cross-model review** | **Codex** | Mandatory on every unit, including mechanical ones. P1+ findings are fixed or explicitly declined with written rationale in the PR. |
| **Synthesis** | **Fable 5** | Verifies the diff against the unit's acceptance criteria, runs the Phase-0 guardrail suites (route-matrix, parity tests, depcruise), checks the invariant list, writes the `docs/AS_BUILT.md` entry, ticks the unit checkbox in this plan, merges. |

### 1.2 Model routing

| `model` column | Meaning | Used for |
|---|---|---|
| `opus` | Claude Opus 4.8 builds AND reviews | Default for anything requiring judgment: decompositions, seam design, behavior-sensitive moves, deletions with test porting, anything touching a load-bearing invariant. |
| `sonnet` | Claude Sonnet 5 builds; Argus review on Opus 4.8 | Mechanical-but-multi-file work following an explicit recipe: verbatim type/code moves with re-export shims, boilerplate dedup with byte-identical output assertions, doc consolidation, config authoring from a provided sketch. |
| `haiku` | Claude Haiku 4.5 builds; Argus review on Sonnet 5 | Pure sweeps with zero judgment: lint autofixes, identifier renames from a supplied map, file moves with no code edits, constant relocation. |

Rules of thumb: Argus is never weaker than Sonnet; Codex reviews everything; if a
`haiku`/`sonnet` unit's builder hits ANY ambiguity not covered by the recipe, it stops
and the unit is re-dispatched at the next tier — never improvise on a mechanical unit.

### 1.3 Serialization lanes (parallelism control)

Units in the **same lane** touch the same files and must run serially. Units in
different lanes may run as parallel trident runs (each in its own worktree).

| Lane | Files |
|---|---|
| `composer` | `open/composer.ts`, `open/server.ts`, `gateway/composition*`, `gateway/http/compose.ts`, `gateway/boot-helpers.ts`, `gateway/realmode-composer/` |
| `engine` | `onboarding/interview/*` |
| `bridge` | `gateway/http/chat-bridge.ts` + chat surfaces |
| `substrate` | `runtime/adapters/claude-code/persistent/*` |
| `data` | `persistence/*`, `migrations/*`, per-feature stores being moved |
| `clients` | `app/lib/*`, `app/app/*`, `landing/chat-react/*` |
| `cores` | `core-sdk/`, `cores/*` |
| `transport` | `channels/*`, `chat-core/*`, `landing/server.ts` |
| `trident` | `trident/*`, `agent-dispatch/*`, `work-board/*` |
| `docs` | changelogs, prompts, README/SYSTEM-OVERVIEW |
| `ci` | `.github/`, `scripts/`, tsconfigs, leak-gate |
| `none` | additive-only (new leaf packages, new tests) — freely parallel |

### 1.4 Leak-gate hazards (read before touching docs/vocabulary)

- The audit reports in `docs/research/refactor-audit-2026-07-02/` contain retired
  multi-instance vocabulary that the CI leak-gate bans with zero tolerance
  (`scripts/ci/leak-gate.sh:145-152`). **Do not `git add` them** without adding
  allowlist entries in the same commit (decision D-11).
- `docs/AS_BUILT.md`'s exemptions are keyed to its **literal path**
  (`scripts/ci/leak-gate-allowlist.txt:69-80`) — renames must move allowlist entries in
  the same PR.
- `tasks/history-import-seeder.ts:63` embeds a raw NUL byte that makes grep treat the
  file as binary, hiding one banned token from the gate — and that token is a **hash
  seed** for idempotent task IDs. Handled explicitly by unit G7; nobody else touches it.

### 1.5 Orchestration (how the window actually runs — decided 2026-07-03)

**Driver = a durable orchestrator loop (this session): Opus 4.8, `/effort high`, ultracode
OFF.** The orchestrator holds the ready-set, dispatches units, verifies+merges, and advances
via scheduled wake-ups until the checklist (§17) is complete. Model rationale: the
orchestrator's work is high-stakes JUDGMENT at LOW token volume (adjudicate diffs vs
acceptance, reconcile line-drift, decide the rare stop-for-owner) — the voluminous building is
delegated to per-unit agents on their routed models, so optimize the loop for decision quality.
Ultracode OFF: the Workflow tool is used only for read-only reconciliation sweeps, never to
build.

**NOT SPEC.md / Ralph governed mode.** Ralph is a monolithic "work the spec" drive; it cannot
honor this plan's dependency DAG + serialization lanes + wave schedule, and D-4 flags that a
root `SPEC.md` auto-flips neutron-open into governed mode with no force-OFF (K10 must be last).
So the tracked plan doc IS the driver; `SPEC.md` is authored as a deliverable in K10, not used
as the orchestration mechanism.

**Per-unit pipeline = one Workflow per item, role-routed for token efficiency** (the §1.1/§1.2
model, self-driven, no Vajra fleet-chat dependency — build prerequisites verified 2026-07-03:
`gh` authed, `origin/main` clean, `codex-review.sh` present, bun 1.3.9). Each dispatched unit is
a small Workflow with **role→model routing**, NOT one flat agent: **Plan = Fable 5** (spec →
concrete build brief); **Build→review loop = the unit's `model` column** (Forge) **+ Argus**
(never weaker than Sonnet — Opus for opus/sonnet units, Sonnet for haiku), worktree off
`origin/main`, leaf `tsc` + affected suites each iteration, loop to APPROVE; **Cross-review =
Codex** (`codex-review.sh origin/main`, every unit, P1+ fixed or declined-with-rationale);
**Synthesis = Fable 5** (verify diff vs acceptance + guardrail suites, recommend merge). So
**Opus builds only the ~56 judgment units**; the ~46 mechanical units build on Sonnet/Haiku, and
**Fable — never Opus — does plan+synth on all ~107** (the efficiency lever). Full
`scripts/run-tests.sh` runs in a clean worktree before merge; the orchestrator (Opus, low-volume)
takes the Workflow result, does a final sanity check + ticks §17 + appends `AS_BUILT.md`, and
merges. Fleet gotchas from [[forge-fleet-neutron-open-delivery]] apply (branch off `origin/main`;
`bun install` after any main-merge before trusting tsc). **Exception:** the F9 pilot runs as a
single Opus worktree agent (deliberate — validate the infra chain before layering the routed
harness); every subsequent unit uses the routed Workflow.

**Ready-set + concurrency.** A unit is dispatchable when every dep unit is **merged** AND its
serialization lane (§1.3) is free. Concurrency cap starts at **3** parallel worktree builds
(distinct lanes), raised once stable. Order: **Step 0 live fixes → Phase-0 guardrails
(G1–G10) → waves 1–9 per §16**; K10 strictly last (Ralph landmine).

**Failure handling (autonomous).** Argus+Codex loop until clean. If a unit fails
build/tests after 2 build-agent attempts, or a Codex P1 can't be auto-resolved, re-dispatch
once at the next model tier (mechanical→up). Still failing → **park** the unit, continue every
independent unit, log it, revisit at wave end. A parked unit never blocks units that don't
depend on it.

**Stop-for-owner conditions (the ONLY halts — everything else is autonomous).** (1) a decision
the plan did NOT resolve that would change scope or user-visible behavior; (2) an action
irreversible beyond a single unit's PR (force-push `main`, data deletion, anything touching the
Managed cross-repo contract without a paired decision); (3) a SYSTEMIC failure — ≥3 units
blocked on the same root cause (signals a plan defect, not a unit bug). Live-dogfood safety:
builds/tests run only in isolated/clean worktrees; never touch the running server
([[neutron-iso-server-pkill-trap]]); mind the shared-port/PGLite suite pathologies (§2.7, G9).

---

## 2. Test-coverage policy (applies to every unit)

1. **Green gate:** every PR runs leaf `tsc` for all touched workspaces (root tsc is NOT
   sufficient — see G5) and `bash scripts/run-tests.sh` to completion in a clean
   worktree. No merge on red, no skipped chunks.
2. **Tests travel with code, same PR.** Barrel re-exports keep import specifiers stable
   until a dedicated import-rewrite unit; test files move to sit with their module.
3. **Deletion units delete their tests** in the same PR, after porting any assertions
   that cover still-live behavior (each K-unit lists what to port).
4. **Characterization tests are a ratchet.** The Phase-0 suites (route matrix,
   hydration parity, mirror parity, error-string conformance, depcruise baseline) may
   only be changed with an explicit PR-body note; Fable synthesis signs off on every
   such change.
5. **New seams get new tests.** Every extracted module/primitive (RouteSlot generator,
   BootConfig schema, SupervisedLoop, PoolRuntime, surface-kit…) ships unit tests at
   the new seam in the same PR.
6. **Coverage may not silently shrink.** The run-tests.sh discovery audit already makes
   file-count drift fatal; in addition, each unit's acceptance criteria enumerate the
   test artifacts it must add/move/delete — the Fable synthesis pass checks the list,
   not a raw count.
7. **Known suite pathologies** (don't fight them, don't worsen them): PGLite tests are
   content-quarantined by the literal substring `pglite` (run-tests.sh:156) — keep the
   word in any moved PGLite test; the `bunfig.toml` preload scrubs
   `CLAUDE_CODE_OAUTH_TOKEN` and ~48 onboarding tests depend on it; ~53 onboarding tests
   fail on shared DB/port state in a long-lived tree but pass in a clean worktree —
   G9 addresses the fixture, until then judge suites in clean worktrees.
8. **Do NOT mock past the seam under test.** A recurring, expensive failure class in this
   repo: an integration test stubs the exact thing that breaks in production, so the test
   is green while prod is broken. Confirmed instances: the persona-gen wiring gap; the
   trident shared-checkout gap; #175 fire-substrate toolless; and #361 — the #193
   real-git test stubbed `resolve_conflict`→`{resolved:true}`, so the toolless production
   resolver was never exercised (F9). **Rule:** for any unit touching a CC substrate's
   TOOL grants, the ephemeral-substrate boundary, or git merge/conflict resolution, the
   acceptance test must run the REAL substrate / REAL git — never a stub of the seam it
   claims to cover. Tool-grant assertions check what the subprocess actually receives
   (`--tools`/allowedTools), not just the `AgentSpec`. (See [[neutron-trident-fire-tools-inheritance]].)

---

## 3. Phase 0 — Guardrails & safety nets

> Everything here is additive (lane `none`/`ci` unless noted). Nothing else merges
> until G1–G7 are in.

### G1 — Route-matrix characterization tests · `opus` · M · lane none
Boot the real Open composer (pattern: existing `gateway/__tests__/*-production-composer.test.ts`)
and snapshot (a) the exact set of mounted routes (method+path → status class), (b) the
ladder ORDER: authGate first w/ Set-Cookie stitch (`gateway/http/compose.ts:894-948`),
chunked-upload before legacy upload (`:1047-1072`), per-project children before
appProjects, landing path-set match before connect API, SPA catch-all last.
**Tests:** new `gateway/__tests__/open-route-matrix.test.ts` (+ a Managed-contract
variant that pins the CompositionInput fields the Managed composer relies on).
**Accept:** snapshot covers every surface the Open composer wires today, incl. the
currently-unwired negative space (assert reminders/focus/admin/persona/devices/backups/
launcher/connect-auth surfaces are absent — so C-phase can't silently change either
direction).

### G2 — Hydration-parity characterization (three-transcript) · `opus` · M · lane none
One test drives the same conversation through (a) HTTP history (`button_prompts` via
`gateway/http/chat-history-surface.ts:182`), (b) WS resume replay (`app_chat_messages`
via `channels/adapters/app-ws/adapter.ts:806-841`), (c) the live push envelope, and
records the field-by-field fidelity matrix (options/prompt_id/citations/doc_refs
present-or-dropped per path). Today's divergence is **pinned as a known-divergence
snapshot**, not "fixed" — this is the contract W3 later flips to full parity.
**Accept:** failing-parity fields are asserted AS divergent (test green today); W3 may
only flip assertions with the parity test as its gate.

### G3 — Mirror parity tests + entity-format golden round-trip · `sonnet` · S · lane none
(a) Parity tests (pattern: `app/__tests__/ws-envelope-parity.test.ts`) for the two
comment-only mirrors: `TabDescriptor` (`app/lib/tabs-client.ts:40-52` +
`landing/chat-react/tabs-client.ts:42-58` vs `tabs/registry.ts:67`) and
`AgentEngagementMode` (`app/lib/projects-client.ts:24-29` vs `connect/agent-engagement.ts`).
(b) Golden round-trip test for the entity page codec: render → parse → byte-equal
across `runtime/entity-writer.ts` (renderYamlFrontmatter/extractCompiledTruth) and the
hand mirrors in `scribe/write-to-gbrain.ts:331-338,440-484` +
`gbrain-memory/GBrainSyncHook.ts:47-54`.
**Accept:** all mirrors pinned; P8 later deletes the mirrors against these tests.

### G4 — dependency-cruiser config + baseline + CI step · `sonnet` · S · lane ci
Author `.dependency-cruiser.cjs` from the sketch in
`docs/research/refactor-audit-2026-07-02/critic-layering.md` §9.1 (five bands:
contracts/platform/services/product/composition; rules: no-cycles, band ordering,
cores-use-sdk-only, connect-is-dynamic-only, app-bundle-purity). Generate the
known-violations baseline (grandfathers all 175 current edges), add CI step after the
leak-gate: new violations fail, baseline burns down as L-units land.
**Verifier amendment:** the 28-module SCC is measured WITH test files; production-only
it is 19 modules (still the finding). The ruleset needs an explicit test-file policy —
exempt `__tests__` edges from layer bands (while still forbidding NEW production
cycles) or the baseline never burns down.
**Accept:** CI red on any NEW cross-band import; baseline committed; `depcruise` runs
in <60s.

### G5 — Typecheck completeness (CI) · `opus` · M · lane ci
Today `ci.yml:56` runs root `tsc` whose include list (tsconfig.json:12-41) never
typechecks `trident/` (53 files), `agent-dispatch/`, `app/` (116 files incl. all .tsx),
`jwt-validator/`, `project-credentials/`, `work-board/`, most of `landing/`, and every
test file in those dirs. Fix: CI runs `tsc -p` for every dir owning a tsconfig +
introduce leaf tsconfigs where missing; strip `"DOM"` from the root/server configs
(tsconfig.json:4-11) — browser leaves (landing, chat-core, chat-react, app) own their
own libs.
**Tests:** a CI-config test extending `scripts/ci/ci-workflow.test.ts` asserting the
tsc matrix covers every tsconfig on disk.
**Accept:** every `.ts/.tsx` in the repo is typechecked by some CI step; `document`
no longer typechecks inside `gateway/`; expect and fix the wrong-runtime errors this
surfaces (report count in PR).

### G6 — Substrate error-string conformance tests · `opus` · S · lane none
The credential-pool health classifiers regex adapter message prose:
`gateway/realmode-composer/build-llm-call-substrate.ts:611-744`
(parseHttpStatusFromMessage / detectBinaryNotFound / detectChannelWedged /
detectTurnTimeout), duplicated at `build-import-substrate.ts:409-416`; plus
`isFreezeTimeout` (`build-live-agent-turn.ts:1445-1447`) and the 429 family
(`onboarding/history-import/substrate-callers.ts:402-406`). Write conformance tests
that generate each error at its adapter throw-site wording and assert the classifier
verdict — so any future rewording fails loudly instead of silently reclassifying.
**Accept:** every regex classifier has a test pinning it to the exact producer string;
O3 later migrates classifiers to typed codes against these tests.

### G7 — Leak-gate NUL tripwire + retired-token cleanup · `opus` · S · lane ci
Verification found THREE live retired-vocabulary tokens defeating the zero-tolerance
gate, not one: (a) `tasks/history-import-seeder.ts:63-64` — raw 0x00 bytes → grep-binary
→ gate skips the file; the token is a hash seed. Replace raw NULs with `\x00` escapes
(**byte-identical hash input** — prove with a before/after hash test), keep the token
as a LOCKED hash-seed constant + allowlist entry (changing it changes every
`hi_<sha256>` task id). (b) `cores/free/research/migrations/0001_research_claims.sql:38`
— immutable migration history; allowlist by exact file. (c) `wedge-detector.test.ts`
fixture NULs (escape to `\x00`, runtime-identical) + its retired-path fixture string
(rename to a neutral path — test fixture, behavior-safe). Then add the leak-gate
tripwire failing on any tracked source file grep classifies as binary.
**Accept:** hash test proves id stability; gate sees all three files; tripwire covers
the class; leak-gate SILENT.

### G8 — Test-infrastructure self-tests · `sonnet` · M · lane ci
`scripts/run-tests.sh` and `scripts/ci/leak-gate.sh` have zero tests. Add spawn-tests:
run-tests.sh via the existing `NEUTRON_TEST_DISCOVER_OVERRIDE` seam
(`scripts/lib/discover-test-files.sh:21-24`) covering chunk math, PGLite lane split,
audit-failure paths; leak-gate.sh against a fixture tree with planted findings. Make
the empty `BUN_DISC` parse loud (run-tests.sh:135). Preserve verbatim: `grep -a` +
`LC_ALL=C` (NUL-laden chunk logs), lane-after-chunks ordering, lane-only retry
asymmetry.
**Accept:** both scripts tested; silent-skip branch is loud; delete the dangling
`flake-tolerant-test-gate.sh` reference (discover-test-files.sh:5-6).

### G9 — Test isolation fixture (shared testkit) · `opus` · M · lane none
~53 onboarding tests fail on shared DB/port state in the long-lived tree. Build one
shared testkit helper: fresh `NEUTRON_HOME` tmpdir + random free port + teardown, adopt
it in the worst-offending suites (identify by running the suite twice in one tree).
**Accept:** the previously-polluting suites pass twice consecutively in the same tree.

### G10 — Invariants inventory · `sonnet` · S · lane docs
Compile `docs/INVARIANTS.md` from the "load-bearing subtleties" sections of all 12
critic reports — one line each, with file:line + which unit/test protects it. This is
the checklist Fable synthesis runs per merge.
**Accept:** every invariant named in the audit appears once, with an owner test or an
explicit "unprotected — covered by review only" tag.

---

## 4. Phase 1 — Dead code & docs consolidation (K = kill)

> Deletions shrink every later phase (the identity-vocabulary sweep alone loses ~1.6k
> lines of engine slug flow + ~2.6k of dead import pipeline). Verify "zero non-test
> importers" claims fresh at build time — the audit's evidence is cited per unit.

### K1 — Dead landing/connect files · `sonnet` · S · lane transport
**⚠️ AS-BUILT CORRECTION (Codex near-live-break catch, #217):** the original deletion list
below was WRONG — `landing/connect-accept.ts` (239) + `connect-accept.html` +
`landing/connect-disclosure.ts` (163) are **LIVE** (the by-link Connect collaborator-accept
page served at `connect.<domain>/connect/accept`; the app still mints + shows that URL via
`gateway/http/app-connect-invite.ts` `buildGuestAcceptUrl` + `ProjectSettingsDrawer` testID
`connect-accept-url`). `AS-BUILT.md:3920-3922` marks `connect-accept.ts` LIVE — the audit
confused it with the removed orphan `connect-accept-server.ts`. **As shipped, K1 deleted only
the truly-dead files and RESTORED the live connect-accept trio.** Lesson: served-by-path files
have zero code importers but are URL-reachable → see memory `refactor-deletion-served-by-path-trap`.

Delete (corrected): `landing/connect-relay.ts` (351), `landing/start-token-topic-id.ts` (124),
`gateway/connect/syndication-relay.ts`, `gateway/connect/open-instance-source-resolver.ts`.
Split the one live function out of `landing/markdown.ts` (`escapeHtml`, imported at
`landing/mobile-install-config.ts:18`) then delete the renderer. **Tests:** delete each dead
module's own tests; add a discriminating boundary test on the retained shared-projects resolver.
**Accept:** grep-zero references for the truly-dead files; connect-accept surface intact; suite green.

### K2 — chat-bridge dead slug-picker: DELETE · `opus` · S · lane bridge
(D-1 resolved by grep: Managed has its OWN slug picker at `/v1/slug/check` and zero
references to `buildSlugPickerEngineHook` — plain deletion, no relocation.) Delete
`gateway/http/chat-bridge.ts:2027-2511` (`buildSlugPickerEngineHook`,
`ProcessSlugPickerReplyFn`) + `renderSlugRenameConfirmationForWeb` (:498) — ~510 lines,
zero non-test importers anywhere. **Tests:** delete the slug-picker tests, port none.
**Accept:** chat-bridge shrinks ~510 lines; grep-zero references in both repos.
**Tests:** delete the slug-picker tests; port none.
**Accept:** chat-bridge shrinks ~510 lines; Managed check documented in PR.

### K3 — Per-chunk import pipeline evacuation + deletion · `opus` · M · lane engine
`open/composer.ts:1288` hardcodes `importUseSynthesis: true` at the sole
`buildLandingStack` call site → the per-chunk runner is unreachable. (1) Extract the
shared leaves the LIVE path uses: the `history-import/types.ts` hub survives;
`extractJsonObject` (imported by `onboarding/synthesis/synthesis-session.ts:30` from
the dead module) and the 429 matcher move to a live util. (2) Persist the
`ImportJobRunnerHook` contract out of `engine-internals.ts:696` (goes to the L2
contracts leaf — coordinate). (3) Delete: `history-import/job-runner.ts` (2,103),
`pass1-triage.ts`, `pass2-synthesis.ts`, `substrate-callers.ts`, `entity-populator.ts`,
`gateway/realmode-composer/build-import-job-runner.ts` (710),
`prompts/onboarding/import-analyzer-pass{1,2}.md` (+ `KNOWN_PROMPTS` entry +
parity-test update, `prompts/template.ts:147`, `template.test.ts:159`), ~10k test LOC.
**D-2 RESOLVED by grep — DELETE, not relocate:** Managed runs the vendored Open
synthesis path (it never injects code into tenants), so the earlier "Managed stays on
`buildImportJobRunnerHook`" reading described the old monorepo. The pipeline is dead in
single-owner boot (which is what every tenant runs) → delete outright. **Still extract
first:** the `persistResult` write-back / read-on-miss pattern
(`job-runner.ts:1977-1998`, `:745`) that P6 reuses, BEFORE deleting the file.
**Tests:** golden-test the extracted helpers; delete the pipeline's ~10k test LOC.
**Accept:** synthesis import path untouched (suites green); net −5k+ source LOC.

### K4 — Engine dead surface: acceptChoice + slug flow · `opus` · M · lane engine
**K4a (unconditional):** delete `acceptChoice` (`onboarding/interview/engine.ts:1721-1988`,
zero production callers — chat-bridge drives `engine.advance` at
chat-bridge.ts:1942/1996); port its still-meaningful assertions onto `advance` first.
**K4b (gated on D-5):** the slug flow — `engine-slug.ts` (1,086) +
`consumeSlugChosenChoice`/`advanceFromSlugChosen`/`reEmitSlugChosen`
(engine.ts:8728-8843) + EngineInternals entries + delegators — is Managed-mode-reachable
per the verifier; delete ONLY if the D-5 written decision also rules Managed onboarding
out of scope for this repo. **Also (verifier):** the shared `phase_state` JSON contract
is pinned by NO test despite ~113 test files touching it — add a contract-pinning test
for the whitelist/merge semantics (engine.ts:372-392) before D9 splits begin.
**Accept:** K4a merged; K4b decision recorded; phase_state contract test green.

### K5 — Misc kill-list sweep · `sonnet` · S · lane none
Delete (each verified zero non-test importers in the audit; re-verify): 
`runtime/adapters/claude-code/api-key-helper.ts` (self-declared deletable),
`cores/free/reminders/manifest.json` (drifted duplicate of the package.json block),
`prompts/topic-agent-base.md` (+ KNOWN_PROMPTS + parity test),
`tests/e2e-browser/__pycache__/*.pyc` (+ .gitignore rule), `cores/free/notes/`
node_modules ghost, `persistence/retry.ts:38` `CHECKPOINT_EVERY_N_WRITES`, barrel-only
zombies (`runLongPoll`, forum-topics helpers, `tool-loop-detection.ts`) **after** X5
decides the router.
**Verifier amendment — do NOT delete** the `dtc_analytics` backend key
(`gateway/cores/install-bundled.ts:1033`) or `app/app/projects/[id]/cores/dtc-analytics.tsx`:
the key fronts an out-of-repo Tier-2 paid-staging core that
`gateway/__tests__/cores-surface.test.ts` conditionally installs when
`cores/paid-staging/` is present. The real smell (gateway hardcoding per-core backend
keys) is X2's job (keys move into manifests, dtc entry preserved).
**Accept:** each deletion lists its grep evidence in the PR.

### K6 — Changelog consolidation (agent-API ordering) · `sonnet` · M · lane docs
Order matters: (1) update ALL writer prompts to one target — `trident/prompts.ts:113,116,163,199`,
`trident/inner-workflow.mjs:361` (root `AS-BUILT.md`, hyphen) and
`cores/free/code-gen/src/prompts/forge-system.ts:7` (`AS_BUILT.md`) → all write
`docs/AS_BUILT.md`; also fix the root-`SPEC.md` references (no such file) per D-4.
(2) Move leak-gate allowlist entries with any path change (same commit). (3) Archive
root `AS-BUILT.md` (7,441 lines — the only anchored record of several behavioral
invariants; archive under `docs/research/`, never delete) and delete abandoned
`docs/AS-BUILT.md` (1,469). **Accept:** exactly one changelog; a trident dry-run
writes to it; leak-gate SILENT.

### K7 — Docs truth pass · `sonnet` · M · lane docs
Fix verified-stale content: `docs/SYSTEM-OVERVIEW.md` boot-path section (claims a
healthz-only shell) and web-chat section (claims `NEUTRON_WEB_CHAT_CLIENT` flag still
gates the React client — the flag is gone from code); README stale Core table (lists
removed notes core; omits google-workspace + scraping) and the GBrain "fail-soft"
claim (install now aborts); CONTRIBUTING (`bun test` whole-suite advice OOMs — point
to `scripts/run-tests.sh` + leak-gate + leaf tsc); remove hardcoded suite counts
(run-tests.sh:12-13, docs/testing-runner.md:16); `git add` the currently-untracked
plans/specs/research docs that are referenced by work (D-11 for the audit dir).
**Accept:** a new contributor following the docs reproduces CI locally.

### K10 — Public in-repo SPEC.md + repoint agent prompts · `sonnet` · M · lane docs
(D-4.) Bring a public SPEC.md into neutron-open root, consistent with
`neutron-managed`'s SPEC.md section conventions (the in-flight spec-shape investigation
delivers the skeleton). Seed from: the README architecture claims, the post-K7-truth
SYSTEM-OVERVIEW, the G10 invariants inventory, and Ryan's locked decisions quoted in
`docs/plans/*`. Repoint the trident/Ralph prompts that expect a root SPEC.md
(trident/prompts.ts, inner-workflow.mjs) at the real file (pairs with K6's changelog
prompt fixes). **Seed the SPEC's roadmap section with the post-window feature backlog:**
the two dormant loops from D-7 (wire ProjectBackupScheduler; wire comments AgentWatcher),
the D-9 HITL-enforcement review item, and X6's per-project-context follow-ons.
**Investigation confirmed:** root `SPEC.md` + `IMPLEMENTATION_PLAN.md` ARE leak-gate-legal
(FORBIDDEN_EXACT bans only STATUS/ISSUES/CLAUDE/AGENTS at root, leak-gate.sh:200); port
Managed's SPEC.md section conventions (governance preamble → doc-set table → System
Overview → Architecture 2.x + naming-registry → Roadmap Phases→Steps → Open Questions →
Detail-specs index → append-only Decisions Log) but **author content FRESH** — Managed's
SPEC is saturated with banned tenant/domain/PII tokens, do not copy. Open issue tracking
= **GitHub Issues** (CONTRIBUTING.md:72 already assumes it); root ISSUES.md stays banned;
SPEC Roadmap holds planned backlog.
**⚠️ Governed-mode side effect (sequencing-critical):** adding root SPEC.md makes
neutron-open a trident *Ralph-governed* repo — `detectRalphMode` triggers on SPEC.md
existence (git-mode.ts:100-142) and `/code` defaults to Ralph mode with force-ON but
**no force-OFF**. So EITHER land K10 as the very last trident-executed window unit, OR
inject `resolveRalph:()=>false` at the dispatch point (code-command.ts:159) for all
window unit runs. The orchestrator loop MUST know which. Update the prompt-pinning tests
(trident/prompts.test.ts, ralph.test.ts, code-command.test.ts) with the repoints. Order
K7 (docs truth pass + git-add referenced plans) and G10 (INVARIANTS.md) before/with K10.
Run the leak-gate accept on a CLEAN checkout (the dev tree's gitignored root STATUS.md
trips a local find-based gate run). **Accept:** trident reads the real SPEC.md; roadmap
backlog captured (D-7 loops, D-9 HITL review, X6 follow-ons); no prompt references a
nonexistent file; governed-mode sequencing decided + documented for the loop.

### K11 — One onboarding flow + dual-path/flag purge · `opus` · L · lane engine
(D-5 RESOLVED by trace — Ryan: "no two onboarding flows… no duplicate code paths… no
feature flags.") The trace proved the winner is **conversational Path-1, unconditional**
(the `NEUTRON_ONBOARDING_CONVERSATIONAL` flag is already collapsed — nothing reads the
env; `platform-adapter-local.ts:253-264` hard-pins it). The loser — the InterviewEngine's
conversational *drive* — is **already dead code on every live path in BOTH repos**
(`chat-bridge.ts` startSession/handleInbound → engine.start/advance have no caller;
`landing/server.ts:714-721` says "nothing reads it anymore"; the `llm-router` fires only
inside dead `engine.advance`). So this is code-removal + test migration, effectively
no-behavior-change for Open (dropped the `[BEHAVIOR]` tag; the only live tail is the
Managed vendor-bump gate).
**Deletion list (from the trace):** `llm-router.ts` (1,428) + its 1,766-line test +
`build-llm-router.ts`; `interaction-mode.ts` (621); `resume-cron.ts` (389); the flag
file + adapter accessors + `shouldConsultRouter`; engine.ts conversational clusters
(~5-6k of 10,078 lines: start 688-1460, acceptChoice 1721-1988, advance/normalAdvance,
dispatchRouterDecision 3306-3792, consumeChoice 4085-4971, resume/gap-fill/personality);
`personality-character-suggester`; router timeout envs; `router_decision` telemetry; the
conversational test suites. **PARTIAL:** `phase-spec-resolver.ts` stays live for import
prompt copy (packs at :201/:209) — collapse it to one copy path and delete its
`NEUTRON_LLM_ONBOARDING_PHASES`/`_DEFAULT` flag pair.
**Broader dual-path/flag census (from the trace):** also purge the `NEUTRON_ROLE` vs
`NEUTRON_DEPLOYMENT_MODE` alias (deployment-mode.ts:23-40), the managed-mode phase
tables + `engine-slug.ts` (1,086, dead in both repos — merges with K4b), the legacy
`web:` topic registry with no registering client (composer:1928-1942), the dead OAuth
import sources. (C5 owns openFetch-vs-auth-gate; W3 the transcript double-write; the
dev-auth bypasses go to S0/S2.)
**Care:** split `chat-bridge.ts` before deleting — the inbound conversational half is
dead but the same module hosts the LIVE `WebChatSenderRegistry` emission path +
LiveAgentTurnRunner types used by import prompts and reminders (do K11 after/with D3's
chat-bridge split, or extract the sender-registry first). Before deleting
`engine.start()`, add a restart-recovery integration test pinning the composer-side
replacements (on_session_open import-watcher re-arm + finalizeImportOnboardingIfReady)
that superseded start()'s crash-resume watermarks. Fix the stale comments claiming
engine.start runs (composer:1450/:1456, app-ws-surface.ts:158-165) in the same PR.
Keep `buildDiverseAgentNameFallback` (agent-name-suggester.ts) — it's a Managed
open-contract surface. **This precedes and shrinks D9** to a ~2-3k-line import subsystem.
**Accept:** one onboarding path; zero feature-flag branches selecting implementations;
fresh install + a Managed vendored-tenant boot both green; engine down to the import
subsystem.

### K8 — Trident v1 remnants decision + cleanup · `opus` · M · lane trident
**Constraint: the Workflow inner loop stays (§0.4).** Investigate and delete the
production-dead v1 stack: `trident/substrate-dispatch.ts` (dead per data-layer audit),
`trident/session.ts`, the render/parse half of `trident/prompts.ts` (490 — only
`ARGUS_DIFF_LINE_LIMIT` live), code-gen's retired pipeline forks
(`cores/free/code-gen/src/prompts/{forge,argus}-system.ts`), and the duplicated `/code`
grammar (`trident/code-command.ts:57-70` vs `cores/free/code-gen/src/chat-commands.ts:109`
— keep one, import it). **Care:** `trident/vajra-fixes.test.ts` anchors ported wedge
fixes (FIX 9 parity) — port those assertions onto the live exec-model path before
deleting anything they pin. **Verifier amendment (prompt copies):** do NOT redirect the
live fire path to read `forge.md`/`argus.md` from disk — the live inline contracts in
`inner-workflow.mjs` are heavily parameterized (isPr/local-mode branching, resume
notes, FORGE_SCHEMA structured reporting) and the disk files cannot express that.
Instead mark the disk files as non-live reference (or delete them) and make
`inner-workflow.mjs` the single documented source of the live contract.
**Accept:** trident/ contains only the live exec-model
loop + store + tick + prompts actually loaded; vajra-fix parity preserved; exactly one
live Forge/Argus contract source.

### K9 — router-thinking-budget: restore or delete · `opus` · S · lane substrate
`runtime/adapters/claude-code/router-thinking-budget.ts` has zero production callers;
comments at `build-llm-call-substrate.ts:333-335,451` claim the protection exists.
Investigate the original router-hang incident; either re-wire (with a wiring test) or
delete module + comments together. A comment claiming absent protection is the worst
state. **Accept:** code and comments agree; decision documented in AS_BUILT.

---

## 5. Phase 2 — Contract leaves & the layering DAG (L)

### L1 — Chat-protocol leaf module · `sonnet` · M · lane transport
**Verifier staging:** extract as an in-package leaf MODULE first
(`landing/chat-protocol.ts`) — zero build-system churn; promote to a workspace package
only later if L6 needs it. Move `landing/server.ts:170-699` **verbatim, JSDoc included**
(ChatInbound, ChatOutbound + frame interfaces, PendingChatClaim, ChatBridge — the JSDoc
is the only written spec of jti-claim atomicity / identity-unregister / seed-reemit).
Re-export from `landing/server.ts` during transition (note :41 also value re-exports
`MOBILE_APP_URL` — L2 owns that). Flip consumers:
`gateway/http/chat-bridge.ts:45`, `recovered-reply-store.ts:51`,
`build-live-agent-turn.ts:67`, `proactive/button-store-sink.ts:36`,
`reminders/outbound.ts:24`, `open/composer.ts:214`.
**Accept:** landing loses its worst inbound edges (reminders/gateway importing an edge
package); zero behavior change; JSDoc byte-identical.

### L2 — Contracts leaf · `sonnet` · M · lane none
(Same verifier staging as L1: leaf modules in-place first, one workspace package later
if needed.) Node-free home for stranded contract types/constants (each with `export … from` shim at
the old site for one transition PR): `OnboardingPhase`/`ALL_PHASES`
(`onboarding/interview/phase.ts` ← consumed by `runtime/onboarding-conversational-flag.ts:24`),
`AgentEngagementMode` + defaults (`connect/agent-engagement.ts` ← chat-bridge:2749,
projects store, agent-settings core), `LlmCallFn`
(`onboarding/interview/phase-spec-resolver.ts` ← `tasks/prioritize-llm.ts:43`),
`ImportJobRunnerHook` (`engine-internals.ts:696`), `ChatCommandFilter`
(`gateway/http/app-ws-surface.ts` ← chat-bridge sideways + 3 in-core clones),
`WebChatSenderRegistry` type (chat-bridge.ts:162), `McpToolResolver`
(`runtime/adapters/gpt-5-5-api/mcp-shim.ts` ← `mcp/server.ts:15`), `MOBILE_APP_URL` +
`TELEGRAM_BIND_TOKEN_TTL_MS` (`onboarding/interview/final-handoff-config.ts`),
`OutboundSink` (declared twice: `trident/delivery.ts:46`, `gateway/proactive/sink.ts`).
**Accept:** DAG cuts #1,4,7,9,10,11 (audit critic-layering §2.1) land; must be
node-free (metro constraint).

### L3 — Remaining DAG edge cuts (injection-shaped) · `opus` · M · lanes composer+data
The value-import cuts needing injection, not relocation: (a) `gateway → open`:
`gateway/cores/mount-open-cores.ts:48` imports `buildOpenAgentProfileBackend` — inject
as a parameter from `open/composer.ts:110`; (b) `reminders → gateway/landing`: move
`reminders/outbound.ts` delivery up into gateway composition (dispatcher already
defines `ReminderOutbound` seam) + relocate `collectTokensToString` to the runtime leaf
(pairs with O8); (c) `migrations → open`: move `resolveOpenDbPath` out of
`open/owner-identity.ts` (preserve EXACT resolution order for both entrypoints — the
process.env-mutation contract at `open/server.ts:58-73`); (d) `connect → onboarding`:
move `issueInviteToken` into connect; (e) `onboarding → gateway`: move
`defaultProjectEmoji` to a leaf; (f) agent-settings' onboarding/connect value imports →
inject via ToolDeps. **Accept:** `depcruise` no-cycles rule flips from baselined to
hard-error; SCC = ∅.

### L4 — Manifest honesty + workspace promotion · `sonnet` · M · lane ci
Add package.json (+ leaf tsconfig where missing) for `open/`, `tabs/`, `work-board/`,
`project-credentials/`; add to root `workspaces`; declare REAL deps in every workspace
manifest (audit found gateway declaring 12 but importing 39; runtime declaring 1;
inverse rot in calendar/google-workspace); fix root package deps.
**Accept:** `depgraph` declared-vs-actual delta = 0; every module visible to tooling.

### L5 — Relative-import autofix sweeps · `haiku` · M (batched per package) · lane none
After L4: eslint flat config at root with `import/no-relative-packages`, autofix
`../<workspace>/…` → `@neutronai/<workspace>/…` package-by-package (795 escapes).
Pure-rename diffs, one PR per package batch, suite green each.
**Care:** relocation must not reorder module-load side effects — modules reading env at
load (`runtime/models.ts`, research constants) keep their import positions.
**Accept:** relative cross-workspace imports = 0; rule enforced in CI.

### L6 — `@neutronai/wire-types` leaf + option-shape unification · `opus` · L · lane transport+clients
One node-free leaf owning: the app-ws envelope union
(`channels/adapters/app-ws/envelope.ts`, 931 lines — becomes re-export), the ONE
canonical option shape (collapsing 5 near-identical shapes: `ButtonOption`
button-primitive.ts:59, `AppWsOutboundAgentMessageOption` envelope.ts:181, the app
mirror ws-envelope.ts:98, `ChatMessageOption` chat-core/types.ts:22, `InlineChoice`
channels/types.ts:131 — keep explicit render projections where semantics differ),
topic-id derivation (`landing/chat-react/config.ts:120-136` mirror), doc-link
build/parse (`runtime/doc-links.ts` 918 ↔ `app/lib/doc-links.ts` 493 byte-twin),
TabDescriptor, AgentEngagementMode (from L2). Delete the hand mirrors
(`app/lib/ws-envelope.ts`, `app/lib/doc-links.ts`, tabs/engagement mirrors) once the
G3 parity tests pass against the shared package.
**Care:** "label must carry display text" contract on InlineChoice mappings
(`adapter.ts:865-872`); lossy mappings preserved explicitly.
**Accept:** ~1,300 mirrored lines deleted; G3 parity tests now import one source;
metro/Expo bundle still builds (`app/` purity).

### L7 — chat-core scope rename · `sonnet` · S · lane clients
`@neutron/chat-core` → `@neutronai/chat-core` (the one scope outlier among 41):
~22 files + `app/metro.config.js:3-5` watch paths.
**Accept:** one scope repo-wide; Expo + web bundles build.

---

## 6. Phase 3 — Config & composition rebuild (C)

> The flagship. All in lane `composer`, strictly serial, in this order. G1's route
> matrix is the lock for every step.

### C1 — Typed BootConfig · `opus` · L
One `config/` leaf: resolve + validate env ONCE per process into a frozen typed
`BootConfig` (Zod; already a dep). 64 runtime env vars read across 71 files today;
every inline default copied VERBATIM into the schema. `boot()` (`gateway/index.ts:118-157,272,308`)
and the composer take BootConfig; `open/server.ts:47-73`'s process.env mutation becomes
a shim that writes FROM BootConfig (out-of-tree readers keep working) and dies later.
Numeric knobs coerce + range-check loud (today a bad value silently NaNs).
Dual-entrypoint trap fixed: `bun start:gateway` on an Open box must not silently boot a
healthz-only shell against the wrong DB (`gateway/index.ts:121`).
**Care:** `boot()` re-reads env independently of the composer's env option — change
both sides in lockstep (self-documented hazard at open/server.ts:38-46);
`.url_slug`-file > env precedence (`gateway/index.ts:147-157`) preserved.
**Tests:** schema unit tests (defaults table = today's values); both-entrypoints boot
test. **Accept:** zero `process.env` reads below the entrypoints (lint), G1 matrix
unchanged.

### C2 — boot-helpers split (+ DELETE the dead exports) · `opus` · M
**Corrected by the ABI grep:** there is NO external composer consuming these — the 8
"invisible ABI" exports (`createTasksCoreOwnerRegistry:63`, `defaultListProjects:420`,
`loadAnthropicOAuthConfigFromEnv:1259`, `resolveIdentityPublicBaseUrl:1350`,
`resolveBaseDomain:1358`, `buildMaxOAuthGateHandler:1389`, `buildGateLandingServer:1642`,
`buildMaxOauthHandoffUrl:1461`) and `loadInstanceEnvOverlay` have **zero consumers in
either repo** (Managed's Max-OAuth is its own port; it runs stock vendored Open). So
they're **dead code — delete them** (merge into K5's kill-list), not preserve behind a
barrel. Split the remaining `boot-helpers.ts` (1,695) along its factory clusters. A thin
`gateway/composer-contract.ts` barrel is still worth creating as the *documented* seam
for any future external composer, but with no "boots against the barrel" acceptance.
**Care:** boot-helpers must never import gateway/index.ts (TLA cycle ban,
boot-helpers.ts:6-20); do NOT touch the `startOpenServer` / healthz / `/chat` /
agent-name-suggester surfaces the Managed gate pins (§0 rule 3) without a paired
`open-contract.ts` update. **Accept:** dead exports gone; boot-helpers ≤ ~400 lines per
split file; Managed's `open-contract.ts` gate still green against the new vendor pin.

### C3a–C3d — Carve `open/composer.ts` into wiring modules · `opus` · L each
Decompose the 3,220-line closure along its existing comment narrative into
`open/wiring/*.ts`, each `wireX(ctx: OpenWiringContext): Partial<CompositionInput>
(+cleanups)` where ctx is a NARROW typed slice (db, config, log, graph.get):
- **C3a** substrates + prewarm + memory: the 5 substrate constructions (:440-637),
  scribe/gbrain/reflection (:780-978). **Care:** prewarm promise never rejects, never
  awaited at boot (:3661-3684); `prewarmSettled` elevates cold-window timeouts
  (:508-521) — flag/promise pair stays together. Trident fire substrate stays WARM
  per-repo-cwd (:590-633); only `cc-agent-` gets enableToolBridge (:535-541) —
  instance-id prefixes are pool keys.
- **C3b** uploads + landing-stack + onboarding seams: chunked upload + sweeper
  (:1338-1443), `buildLandingStack` call (:1237-1330), Path-1 trio + import watcher
  (:2470-2528), `importUseSynthesis:true` preserved.
- **C3c** http-shell: cookie/start-token gate + React bootstrap HTML injection
  (:1444-1653) + `openFetch` (:1655-1755) extracted into a NAMED, unit-tested
  `OpenOwnerGate` module (logic verbatim — hardening is S1/S2, not here). **Care:**
  single-use `?start=` JTI claim (:1638-1653); cookie minted only on first claim
  (:1737-1748); stale-cookie-over-wiped-DB cold-start (:1686-1690); bootstrap injected
  by exact-string replace on the `/chat-react.js` tag (:1616-1626); the TWO verbatim
  copies of the claim-token block (:1713-1726, :1738-1749) converge on ONE.
- **C3d** app surfaces + app-ws receiver (:3082-3425) + return assembly: the four
  late-bound holders (`dispatchBoardHolder:654`, `importWatchHolder:1329`,
  `onboardingMsgHolder:2321`, `appWsHolder:2689`) become explicit two-phase
  `late<T>(name)` seams. **Verifier amendment:** deref-before-bind must
  **log-loudly-and-no-op** (system_events counter), NOT throw — the holders sit inside
  fire-and-forget runtime paths (e.g. `onboardingMsgHolder.emit?.()` from the
  import-completion watcher) and throwing is a behavior change; escalate to throw only
  under `NODE_ENV=test`. The return
  literal gets a per-profile required type
  (`OpenComposition = CompositionInput & Required<Pick<…, openSurfaces>>`) so a dropped
  slice fails compile instead of 404ing.
**Tests:** per-module wiring tests + a characterization snapshot of exactly which
CompositionInput fields Open sets, taken BEFORE C3a and asserted unchanged after C3d.
**Accept:** composer ≤ ~200-line orchestrator; G1 matrix byte-identical; 30
`open/__tests__` wiring tests green.

### C4 — Data-driven surface registry (RouteSlot) · `opus` · L
Replace the 4-list copy-machine (interface field → composition.ts:137-259 mapping →
`hasAnyChainedSurface` :264-295 → compose.ts ladder :950-1320 + 21 clone handler
interfaces) with one `RouteSlot {key, match|pathSet, handler, precedence, gated?, ws?}`
declaration per surface; generate the mapping, the gate, and the ladder from an
explicit ordered array. Transition test: generated ladder === today's literal ladder.
Fix the already-diverged gate (`chat_history_surface`, `chat_topics_surface`,
`import_resume_handler`, `auth_gate` mapped but missing) as an EXPLICIT tested commit.
**Accept:** adding a surface = 1 file + 1 registration entry; G1 matrix unchanged
except the documented divergence fix.

### C5 — One auth-gate seam + landing route manifest · `opus` · M
`landing/server.ts` exports its route predicate/set; compose.ts consumes it;
`LANDING_PATHS` (compose.ts:722-752 — a 3-incident 404 factory) becomes generated with
a transition test. The tested-but-dormant `landing/auth-gate.ts` vs live-anonymous
`openFetch` duality resolves: Open supplies the named OpenOwnerGate (C3c) through the
`composition.auth_gate` seam; cookie-stitch semantics preserved (append, never replace,
both `authenticated` and `allow` — compose.ts:934-948).
**Accept:** one gate seam, both modes; LANDING_PATHS deleted.

### C6 — Credential-resolver unification · `opus` · M
`resolveOpenLlmPool` (open/composer.ts:287-316) mirrors
`gateway/realmode-composer/resolve-llm-credentials.ts` (309 LOC) by comment. One
precedence-table resolver with explicit `allowAmbient` (Open-only) /
`allowSharedEnvTier` flags. **Care:** precedence env-OAuth > API-key > ambient;
'ambient' threads NO token (child uses Keychain).
**Tests:** table-driven precedence tests covering both modes. **Accept:** one resolver;
comment-sync retired.

### C7 — `gateway/realmode-composer/` → `gateway/wiring/` rename · `sonnet` · S
After C2 (ABI barrel + Managed coordination): rename the Managed-era-named shared
library (~13k LOC, 125 "realmode" refs, ~20 importers outside gateway); path re-export
shims for one release. **Accept:** no "realmode" outside historical docs.

### C8 — Evict product orchestration from the composition layer · `opus` · L
Four parallel opening orchestrators live in the wiring package: `WowDispatcher`
(onboarding/wow-moment/dispatcher.ts, wired via build-wow-dispatcher.ts),
`emitProjectSeeds` (build-onboarding-handoff.ts:253-390), PR #151's kickoff
(build-project-kickoff.ts, 459 + composer 139 — which forked the action model), plus
the queued project-opening dispatcher. Move orchestration into a product package
(`onboarding/openings/` or new `project-openings/`) with narrow injected seams
(ButtonStore-emit, doc-composer, stores, clock); unify kickoff + handoff on the
`WowActionModule`/`ActionRunner` contract; `gateway/wiring` keeps construction only.
**Care:** the shared dedupe key ``onboarding_opening:${project_id}``
(build-onboarding-finalize.ts:416-424) semantics preserved; ActionRunner 60s
hang-timeout + never-throws contract.
**Accept:** zero product logic in wiring build-modules; the queued wow-moments plan
would touch ≤ ½ its previously-traced file count (extensibility audit §2.1).

---

## 7. Phase 4 — God-file decompositions (D)

### D1 — PoolRuntime reification (REPL substrate) · `opus` · M · lane substrate
`persistent-repl-substrate.ts` (4,009) has 13 module-global mutable singletons
(`replToolBridge:934`, `sink:1094`, `pool:1384`, `childByKey:1391`,
`ephemeralSessions:1398`, `pendingChildKills:1404`, `activeWatchdogs:3053`,
`activeModelWatchdogs:3058`, `supervisedBySessionKey:3115`, `respawnGates:3151`,
`wedgeAlertState:3153`, `cwdDriftRespawnState:3157`, `cwdDriftAlertState:3160`) that
are semantically ONE per-process pool runtime. **Verifier amendment (simpler, safer
mechanism):** do NOT thread an `rt` parameter through every function — extract the 13
globals **verbatim** into one `pool-state.ts` module that the D2 split modules import.
Identical object identities and lifetimes by construction; no import cycles (the state
module imports nothing); tests get a reset helper. Much of the runtime is ALREADY
extracted into ~40 sibling modules — this unit only unlocks splitting the remainder.
**Accept:** zero behavior change; 48 substrate test files green.

### D2 — Substrate banner split · `opus` · L · lane substrate (after D1)
Mechanical split along existing section banners into ~8 modules: `signatures.ts`
(164-322), `types.ts` (565-913), `repl-sink.ts` (927-1101), `repl-session.ts`
(1106-1575), `spawn.ts` (1576-2314), `pending-respawn.ts` (2315-2594), `pool.ts` +
turn driver (2595-3102), `supervision.ts` + watchdogs (3103-3959).
persistent-repl-substrate.ts stays as barrel.
**Care (invariants travel verbatim):** `sink.register` BEFORE `ptyHost.spawn`
(1678-1694); identity-guarded eviction everywhere (respawn re-attaches the SAME
sessionId — blind deletes reintroduce the resume race); pendingChildKills consumption
in spawnResume; ephemeral gate + NEVER-enqueue-ephemerals-to-pending-respawns
(:2861-2877 — replayed internal prompts would land in the user's chat); watchdog ticks
scope the pool by owning replRegistryPath (3553-3556); the sink stays a process
singleton (fake-PtyHost suites drive the REAL sink/dev-channel seam).
**Accept:** barrel public names unchanged; all 48 suites green.

### D3 — chat-bridge cluster split · `opus` · M · lane bridge (after K2, L1, L2)
Split along the partitions the 10 existing test files already use:
`sender-registry.ts` (162-301), `render-outbound.ts` (421-497), `routed-senders.ts`
(521-748), `slug-history-shim.ts` (749-838), `bridge.ts` (buildWebChatBridge closure
KEPT WHOLE — its four entry points share session state deliberately),
`project-topic-inbound.ts` (2511-3043), `seed-reemit.ts` (3044+). Also dedupe the 4×
pasted scribe fire-and-forget block (handleInbound :1748,:1811,:1896,:1949).
**Care:** registry send PROPAGATES throws (202-219 — delivered_at stays NULL for
reconnect re-emit); engine.start BEFORE jti claim (1229/1261); duplicate jti → false
not error (1392-1400); recordInboundReceived BEFORE advance (1919-1929); typing bracket
start-before-dispatch / end-in-finally; live-agent gate is phase==completed ONLY.
**Accept:** chat-bridge.ts ≤ ~1,200 lines; 10 test files relocated with their modules.

### D4 — project-backup-store split behind facade · `opus` · M · lane none
Extract from the 2,246-line class: `git-exec.ts` (exec wrapper + gitDir/workTree arg
builders + error classification, 1772-2050 — SHARED with `doc-version-store.ts` which
duplicates it), `snapshot-reader.ts` (988-1336), `restore.ts` (1337-1701). backupNow +
ensureInit + ALL FIVE concurrency maps (419-441) stay in the facade — the
backup/restore mutex interlock (Argus r1/r2 blocker history at :425-435,606-635, incl.
the deliberate double-await at 624-630) is the crown jewel and must not distribute.
Adopt the generic `gateway/http/keyed-mutex.ts` where the hand-rolled copies exist.
**Care:** `last_attempted` written BEFORE snapshot fires; typed error classes keep
their export specifier (HTTP surface maps them to status codes).
**Accept:** facade API unchanged; 1,312 test LOC green.

### D5 — email backend split · `sonnet` · S · lane cores
Mechanical split of `cores/free/email/src/backend.ts` (2,003) along its six clean
sections: `contract.ts`, `errors.ts`, `in-memory.ts` (both fakes), `google-client.ts`,
`mime.ts` (1170-1513 — security-relevant parsing incl. EmailHeaderInjectionError; give
it its own test file), `summarizer.ts`; backend.ts stays as barrel.
**Care:** draft-only design (gmail.send excluded from surface AND scopes, :29-37);
newest-first ordering (:24-27). **Accept:** 13 test files re-pointed; byte-identical
behavior.

### D6 — admin.tsx pane split (template PR) · `haiku` · S · lane clients
Pure file moves: six already-independent pane components (PersonalityPane 279-807,
GatewayPane, MemoryPane, CoresPane, BackupPane + modal, MaxAccountPane) →
`app/features/admin/<pane>.tsx`; shared `format.ts` (formatError/formatBytes dupes);
per-pane style split (verify no cross-pane style keys). testIDs unchanged.
**Accept:** zero logic diff; establishes the screen=shell+features convention for D7.

### D7 — docs.tsx hook extraction · `opus` · L · lane clients (after D6)
`DocsTab` (113-1522, 32 useState, 4 RequestGates): extract per-cluster hooks owning
their state + gate — `useDocTree`, `useDocFile` (409 draft-preserve), `useDocHistory`,
`useDocMutations` (ONE gate for all mutations — the invariant fixed 4× in review
history), `useDeepLinkAnchor`; build the structural `useProjectScopedAsync(project_id)`
primitive (acquire-before-first-await, isLatest-before-setState, reset-on-switch).
Leaf components (1523-2060) move for free.
**Care:** reset ordering at 305-341 is positional (gates → per-file state → tree BEFORE
fetchTree); effect dependency arrays unchanged; hook orchestration has NO direct tests —
**each PR gated on the agent-browser smoke pass**.
**Accept:** DocsTab ≤ ~400 lines of composition + JSX; smoke green.

### D8 — landing/server.ts residual cleanup · `sonnet` · S · lane transport (after L1)
Delete dead: `validateActiveTopicId:77`, `resolveRequestHost:111`, `emitSessionReady:124`,
SocketState (846-934), the unread `bridge` option (websocket path removed — the handler
is a defensive stub at 1497-1514). File lands ~700 lines of pure HTTP routing + CSP.
**Accept:** landing tests green; CSP hash helpers (136-168, live) untouched.

### D9a–D9d — Interview-engine decomposition · `opus` · L/L/XL/L · lane engine
**Blocked on decision D-5 (the Path-1 fork).** The prior extraction pass created a
300-line `EngineInternals` friend interface with 165 `self.` references — line count
moved, coupling didn't. Done-criteria for EVERY sub-unit (the anti-EngineInternals
rule): extracted modules take 2–4 narrow capability interfaces (`StateAccess` — the
phase_state whitelist at engine.ts:372-392 + crash-resume watermark; `PromptEmitter`;
`TranscriptSink`; `Clock/Uuid`), NEVER `self:EngineInternals`; delegators + interface
entries are DELETED in the same PR (EngineInternals shrinks monotonically to zero);
invariant comments travel verbatim.
- **D9a**: phase-0 type moves (remaining engine-homed contracts → L2 leaf) +
  `SpecResolutionFlow` (7789-8727 incl. the 615-line `resolvePhasePromptSpecUncached` +
  suggestion caches; cache invariant: `clearResolvedSpecCache()` at top of start).
- **D9b**: `MaxOauthFlow` (8844-9444), `FinalHandoffFlow` (5600-6093 —
  choice-membership check BEFORE buttonStore.resolve moves verbatim), `WowFlow`
  (4972-5599 — watermark upsert shares the phase-advance write).
- **D9c**: `GapFillFlow`, `ResumeFlow`, `ProjectsProposedFlow`, then the
  advance/router/consumeChoice core.
- **D9d**: collapse the SIX parallel per-phase tables (consumeChoice dispatcher,
  dispatchRouterDecision, PHASE_INTENTS, PHASE_KNOWLEDGE, STATIC_PHASE_SPECS,
  interaction-mode) into one per-phase descriptor with an exhaustiveness check — the
  step that makes the split durable.
**Care:** buttonStore.resolve `was_new` idempotency barrier gating router state_delta
merge (4111-4136 — re-merging replays corrections); `PENDING_INBOUND_WINDOW_MS` (:537)
ordering with chat-bridge; `last_advanced_at` dual semantics (3950-3987); `walkAutoSkip`
+ resolver AUTO_SKIP null-return matched pair (7813-7820). 83 test files pin this.
**Accept:** engine.ts ≤ ~2,000 lines; EngineInternals deleted; all onboarding suites +
router-integration suites green.

---

## 8. Phase 5 — Data layer & durability (P)

### P1 — ProjectDb API widening · `opus` · M · lane data
`persistence/db.ts` exposes only unserialized `prepare()` and `raw()` escape hatch —
the mutex invariant is unenforceable and the API drives its own bypass (~70 raw()
sites; async tx callbacks leave open BEGINs across event-loop yields). Add: typed
`get/all` reads (named, greppable, today's semantics), `runSync(sql, params) →
{changes, lastInsertRowid}` (the missing return values that caused `tx.raw()` culture),
tx-open assertion. Regression test: a raw() write landing inside another caller's open
async transaction.
**Care (verbatim):** ALS re-entry (db.ts:217); swallowing mutex-chain rebuild
(:221-224); `isBusyError` rejects BusyRetryExhaustedError (retry.ts:54); ASYNC
busy-retry sleeps (sync sleeps starve the systemd watchdog).
**Accept:** API covers every legitimate raw() use; docs in-module.

### P2 — raw() migration sweep · `sonnet` · M · lane data (after P1)
Mechanically migrate the ~70 `.raw()` sites (30 files) to the new API — most become
`get/all` one-liners; the two unserialized WRITES
(`build-synthesis-import-runner.ts:163-174` sync progress UPDATE — stays sync via
runSync; `onboarding/wow-moment/telemetry.ts:178-191` RETURNING) get runSync. Then
restrict raw() to `migrations/runner.ts` by lint.
**Accept:** raw() callers = 1 (migration runner); suite green.

### P3 — openSidecar() + shared store helpers · `sonnet` · M · lane data
10 raw `bun:sqlite` sidecars each open with a different pragma cocktail (audit table:
comments store has NO pragmas at all; most lack WAL/busy_timeout/retry). One
`openSidecar(path, opts)` in persistence/ applying the ProjectDb STARTUP_PRAGMAS +
optional busy-retry; adopt everywhere. Extract the 3-4 genuinely repeated helpers
(JSON codec with EXPLICIT corrupt-policy — three divergent policies exist today; row
mapper; now-seam). NOT an ORM. `[BEHAVIOR]`-lite: added pragmas are strictly more
tolerant; note per adoption.
**Accept:** every sidecar uses the helper; corrupt-JSON policy is explicit per column.

### P4 — Table ownership moves + conformance test · `sonnet` · L · lane data
"One owning module per table": `projects` is written by 12 files (incl. a SECOND
project-creation writer at `onboarding/wow-moment/actions/03-project-shells.ts:304-463`),
`onboarding_state` by 8 (incl. resume-cron's SQL `json_remove` at :266-276 vs the
store's JS shallow-merge at sqlite-state-store.ts:98-102 — two write dialects for one
JSON column). Move stray SQL verbatim into owning-store methods; converge the two
projects-writers on `gateway/projects/sqlite-store.ts` + `project-create.ts`. Enforce
with a conformance test keyed off `expected-schema.txt`: files-mentioning-table ⊆
committed ownership map.
**Care:** resume-cron's rollback marker stays best-effort non-throwing (:277-283); SQL
strings byte-identical while moving.
**Accept:** ownership map committed; CI-enforced.

### P5 — app-chat store fold · `opus` · M · lane data
`persistence/app-chat-{store,receipts,reactions,edits}.ts` = 932 lines of one repeated
shape (append-idempotent by (topic_id,key) → per-topic MAX(seq)+1 → replay-after-seq →
aggregate). Fold onto one generic per-topic event-log core BEHIND the existing four
interfaces (the app-ws adapter consumes interfaces already).
**Care:** per-store replay-limit defaults + idempotency keys exactly preserved; the
four small suites pin them. **Accept:** 4 interfaces unchanged; one core.

### P6 — `[BEHAVIOR]` Import durability P0 · `opus` · M · lane data+engine
The live synthesis import holds completed `ImportResult`s ONLY in a RAM Map
(`build-synthesis-import-runner.ts:128-132,240-248,305-333`); `runJob` is
fire-and-forget (:267-274); no boot sweep for orphaned `pass1-running` rows — a restart
silently discards a paid synthesis. Fix: (a) persist the result to the existing
`import_results` table in the same write that flips status='completed'; status()/
synthesizeOnDemand fall back to the row; (b) boot sweep for orphaned non-terminal
`import_jobs` rows (model: `onboarding/profile-pic/restart-resume.ts` windows);
(c) re-arm the Path-1 completion watcher from durable state at composition (today
armed only on upload + socket reconnect, `open/composer.ts:3248-3272`); also fix the
per-tick cleanup-closure leak (:2521-2524).
**Care:** honest-failure gate (:203-220) and cancel semantics untouched; boot sweep
must not double-fire against the engine's 15-min hard timeout (both converge on
`failed`, idempotent); `ImportJobRunnerHook` contract byte-identical.
**Tests:** restart-resume test per path (fails pre-fix). **Accept:** restart mid- or
post-import loses nothing.

### P7 — `[BEHAVIOR]` Subagent-registry persistence (or renounce) · `opus` · M · lane trident
`runtime/subagent/registry.ts:5-7` promises "S4 wires it to a SQLite-backed table" —
never landed; a gateway restart orphans every dispatched agent silently. **Decision
D-6**: default = land minimal persistence (schema mirrors trident's run rows) + boot
sweep marking prior-process rows crashed + firing the report sink. Alternative:
renounce and delete the S4 comments.
**Care:** do NOT persist trident's `fired`/`redispatched` sets — losing them on restart
IS the orphan-detection mechanism (orchestrator.ts:198-206).
**Accept:** restart surfaces (not vanishes) in-flight dispatches; or comments honest.

### P8 — entity-format leaf + delete mirrors · `sonnet` · S · lane data (after G3)
Export the page codec (render + parse + KIND_TO_DIR + extractCompiledTruth) from
`runtime/entity-format.ts`; delete the hand mirrors in scribe/write-to-gbrain and
GBrainSyncHook against the G3 golden test.
**Accept:** one codec; G3 round-trip green.

### P9 — GBrain sync observability · `opus` · S · lane data
The deferred-edge retry queue is RAM-only (GBrainSyncHook.ts:130-139 — restart drops
edges silently); no latch/last-success state persisted. Add a `gbrain_sync_state` row
(latch reason, last success ts, deferred count) + optionally journal deferred edges to
a table drained at boot. **Fail-soft semantics byte-identical** (once-only latch,
remove-before-add ordering, :199-256) — this unit adds visibility, not behavior.
**Accept:** O5's diagnostics can answer "is my memory being written?".

### P10 — Trident checkpoint hardening · `sonnet` · S · lane trident
(Workflow loop preserved.) The inner workflow's Bash checkpoint steps run `sqlite3`
with default busy_timeout=0 (`trident/inner-workflow.mjs:403-407,443-447`) — a lost
terminal write means no harvest until the 25m reaper. Prepend
`PRAGMA busy_timeout=5000;` to both; replace LLM-transcribed inline SQL with a
checked-in `trident/checkpoint.sh <db> <run> <field>…` the agent invokes.
**Accept:** checkpoint writes retry under lock; idempotent-UPDATE semantics unchanged.

### P11 — JSON codec layer for contract columns · `sonnet` · M · lane data (after P4)
61 `*_json` columns; 16 stores hand-parse with three corrupt-data policies (e.g.
sqlite-state-store.ts:293-303 silently resets onboarding sub-state to `{}`). Give each
contract-bearing column a typed codec module (parse + validate + explicit
corrupt-policy) routed through the owning store.
**Accept:** zero inline JSON.parse on contract columns.

---

## 9. Phase 6 — Lifecycle, supervision & delivery (F)

### F1 — SupervisedLoop primitive + adoption · `opus` · M · lane none→adopters
All five hand-rolled tick loops fire `void this.runOnce()` with store-level throws
escaping to (nonexistent) unhandledRejection handling, and `stop()` never awaits the
in-flight tick before `db.close()`. One primitive: single-flight, per-tick catch-all +
consecutive-failure counter + escalation hook, stats, `stop(): Promise<void>` that
quiesces. Adopt in trident/tick.ts, reminders/tick.ts, backup scheduler, upload
sweeper (cron keeps its calendar logic, delegates its fire path). Wire trident's
never-called `drain()` (orchestrator.ts:188, dropped at build-core-modules.ts:415)
into module shutdown.
**Care:** exactly-once terminal delivery = `listNonTerminal`-only sweeps +
save-before-hook (trident/tick.ts:154-186); reminders claim-before-dispatch +
compare-and-swap revert (#319, tick.ts:130-177) must not move.
**Accept:** loop tests ported wholesale; shutdown quiesces.

### F2 — LoopRegistry + boot inventory · `sonnet` · S · lane none
Generalize cron's "started — N job(s) ticking" boot alarm: every long-lived loop
registers (name, cadence, started_at, last_tick, last_error); one boot log line; a
production-composer test pins the expected loop inventory for Open (the ISSUE-#32
pattern applied to loops — the audit found two fully-built loops that silently never
run in ANY composition: `ProjectBackupScheduler`, comments `AgentWatcher` → decision
D-7 wires or relocates them).
**Accept:** the set of running loops is asserted, not archaeology.

### F3 — fireAndForget + unhandledRejection logger · `sonnet` · S · lane none
28 bare `void fn(...)` sites, no process-level rejection handler anywhere. Add
`fireAndForget(name, p)` (log + counter) required by lint for voided promises; one
unhandledRejection/uncaughtException logger installed in boot().
**Care:** principled voids keep their semantics (prewarm never rejects; scribe hot-path
isolation) — the wrapper only makes them visible.
**Accept:** zero bare `void <promise>` outside the wrapper.

### F4 — `[BEHAVIOR]` Wire the watchdog for real (D-8 = wire) · `opus` · L · lane trident
**Ryan's decision: finish the S5/S6 wiring, don't delete.** Both supervision systems
are decorative today: the `watchdog/` package runs with a no-op notifier
(`open/composer.ts:3436`) + a heartbeat that can never be stale (:3440) + detectors
watching a ProcessRegistry with zero production writers + 3 of 6 detectors never
registered (build-core-modules.ts:488-494); the subagent watchdog
(`runtime/subagent/lifecycle.ts:52`, watchdog.ts:148) is NEVER scheduled. Scope:
(1) real heartbeat source (gateway tick), (2) ProcessRegistry writers at every spawn
site (REPL children, dispatched agents — coordinate with P7's persisted registry),
(3) register all six detectors, (4) notifier routed to app-ws delivery + system_events
(needs O4), (5) schedule `runLifecycleTick` via cron with
`buildDispatchWatchdogNotifier`. **Notify-only first**; enforcement (killing stuck
dispatches after threshold) is a second flagged PR — verify the 5-min default
(watchdog.ts:60) against real dispatch durations before enabling.
**Accept:** a wedged/crashed dispatch or REPL is DETECTED and REPORTED to the owner;
watchdog tables are no longer write-only; the 916-line test suite exercises live paths.

### F5 — Delivery consolidation (deliver() + one registry) · `opus` · L · lane transport
Two live registries for two topic grammars (`WebChatSenderRegistry` chat-bridge.ts:162;
`InMemoryAppWsSessionRegistry` session-registry.ts — header admits it exists "so a
future consolidation can fold both"); the PR #105 deliver-to-nobody class was patched
per-producer (reminders, then the proactive brief, open/composer.ts:1904-1911).
Build `deliver(topic, envelope)` over `parseAnyTopicId` owning durable-row-first +
push-best-effort + eviction policy; migrate every timer/cron producer; fold registries
LAST behind a policy parameter.
**Care (semantics DIFFER by design):** chat-bridge send must PROPAGATE throws
(delivered_at stays NULL → reconnect re-emit); app-ws fan-out must EVICT throwing
senders and continue. Persist-first seq assignment; identity-guarded unregister.
**Accept:** no producer names a registry; G2 parity suite green.

### F6 — Cancellation chokepoint · `opus` · M · lane trident
Board-item X-cancel writes `phase:'stopped'` directly through the store
(work-board-surface.ts:286-305), bypassing the terminal-observer chain; the detached
inner workflow keeps building. (a) Store-level `terminate(run, phase, reason)` used by
stop/X-cancel/delete/reap that runs (or records why not) the observer chain — behavior
identical, single chokepoint. (b) `[BEHAVIOR]` best-effort kill seam threaded to the
detached Workflow (runId is known) + an AbortSignal between synthesis read passes —
separate PR, flagged (today they burn to completion; after, they die mid-build —
worktree cleanup finally{} must still run).
**Accept:** one terminal-write path; kill seam behind explicit flag.

### F7 — Liveness constants module · `haiku` · S · lane trident
Five trident liveness constants across four files with a stale comment (run-progress
warn comment says 15m; real reap is 25m at orchestrator.ts:184). One
`trident/liveness.ts` + unit test asserting warn < reap < ceiling; fix the comment.
**Accept:** constants single-sourced.

### F8 — Re-arm-from-durable-state sweep · `opus` · S · lane composer (after P6)
`on_session_open` has become the de-facto recovery dumping ground (import watcher,
finalize recovery, seeded-welcome self-heal — open/composer.ts:3236-3309; wow re-fire
only in engine.start:739-755). One idempotent `rearmFromDurableState()` at composition
time: scan durable state → arm watchers/re-fire (same guards). Event arming stays the
fast path.
**Care:** `importWatchActive` guard (:2483) makes double-arming safe; add the
boots-with-pending-row single-consumption test.
**Accept:** recovery is boot-derived, not user-activity-derived.

### F9 — `[BEHAVIOR]` trident conflict-resolver tools + humanized delivery + REAL tests · `sonnet` · S · lane trident (independently shippable — can pull EARLY)
Folds in the live trident bug Ryan handed off (neutron-managed
`docs/research/trident-conflict-resolver-toolless-2026-07-03.md`, ISSUES #361). **Root:**
`trident/conflict-resolver.ts:123` declares `tools: []` on the resolver's `AgentSpec` (comment
wrongly assumes "the CC subprocess drives its own Read/Edit/Bash"), but the ephemeral substrate
`makeEphemeralSubstrate('cc-trident-resolve')` (`open/composer.ts:3705-3706`) launches the
subprocess WITHOUT file/shell tools → on a real rebase conflict the resolver can't open/edit/
stage any conflicted file and the build FAILS. **Exact same class as #175** (fire-substrate
toolless, see [[neutron-trident-fire-tools-inheritance]]). Fixes: (1) `tools: []` →
`['Read','Glob','Grep','Edit','Write','Bash']` AND confirm the substrate passes them through to
the CC subprocess (`--tools`/allowedTools), not just the AgentSpec; (2) a **REAL, non-stubbed**
resolver test against a temp git repo with an actual conflict (the #193 `merge-realgit.test.ts`
passed while stubbing `resolve_conflict`→`{resolved:true}`, so it never ran the toolless
production path — see §2's no-mock-past-the-seam rule); (3) `interpretFailure`
(`trident/delivery.ts:131`) must classify "tools not enabled" as an INTERNAL error (auto-retry
once with tools) — never leak the raw "re-run with file/shell tools enabled" stderr to the user.
**Also (chat-UX report #6/#357):** humanize the completion/failure text at `delivery.ts:246-256`
— name the work by its `work_board_items.title`, say "merged and deployed" plainly, drop the raw
run-slug / branch-backtick / round-count jargon. **Accept:** a 3rd concurrent same-project build
that hits a conflict RESOLVES and lands (real-git test proves it); completion messages read
human; no toolless stderr ever reaches chat.

---

## 10. Phase 7 — Errors & observability (O)

### O1 — Logger package · `opus` · S · lane none
`createLogger(subsystem)` → leveled key=value lines (the best existing convention:
`LOG_TAG event=… k=v`), `NEUTRON_LOG_LEVEL`, built-in `once(key)` and
`rateLimited(key, ms)` (generalizing the GBrain latch / rate-limit-banner edge-latch /
wedgeAlertState cooldown patterns).
**Accept:** package + tests; no call-site changes yet.

### O2 — Logger adoption sweeps · `sonnet`→`haiku` · M · lane none (batched)
(1) Satisfy the 34 existing `log?:` DI seams with logger-backed defaults — zero
call-site churn (sonnet). (2) Mechanical sweep of 468 `console.*` + 36 stderr sites,
preserving message text where tests pin it (haiku, per-package batches). **Verifier
note:** ≥5 test files `spyOn(console.*)` directly (e.g.
`gateway/__tests__/resolve-registry-db-path.test.ts`,
`gbrain-memory/__tests__/embedder-config.test.ts`) — migrate those tests with their
modules. (3) Lint ban on new bare console.* outside the package.
**Accept:** four logging conventions → one; spam paths (cron per-tick, per-message
persist failures) latched.

### O3 — Error taxonomy + typed substrate error codes · `opus` · M · lane substrate
(after G6.) Additive `code?: SubstrateErrorClass` on the error Event
(`binary_not_found | channel_wedged | turn_timeout | http_status | rate_limited |
aborted | no_credentials | all_cooldown | oauth_refresh`), stamped at adapter throw
sites; `collectTokensToString` throws `SubstrateCallError{code,retryable,retry_after_ms}`
**with today's exact message text preserved**; classifiers
(build-llm-call-substrate.ts:611-744, build-import-substrate.ts:409-416,
isFreezeTimeout, the 429 family) read code first, regex fallback for one release. One
`errors.ts` leaf: `NeutronError{code,retryable,cause}` + registered code table for the
54 ad-hoc HTTP codes.
**Care:** binary-ENOENT stays non-retryable (must not launder into 429 cooldown,
:515-523); all_cooldown stays retryable:true (:437-442). G6 conformance tests are the
lock. **Accept:** message prose stops being API; G6 suite green throughout.

### O4 — system_events degradation journal · `opus` · M · lane none
Generalize the onboarding `gateway_events` journal (the best primitive in the repo:
ts/level/module/event_name/payload_json) into product-wide `system_events`. Emit on
every latch/degrade decision: gbrain_unavailable, core_install_failed,
credential_all_cooldown, repl_session_capped, cron_job_error (rising edge),
import_orphaned, bundle_build_failed (the web client can 404 today with ZERO log —
landing/server.ts:1243-1262 discards Bun.build errors), prewarm_failed
(open/composer.ts:3661-3684 is fully silent).
**Care:** §8 of the errors audit lists 14 DELIBERATE fail-soft/fail-open invariants —
this unit adds visibility only, never changes the degrade decision.
**Accept:** every row in the audit's silent-degradation catalog emits an event.

### O5 — Diagnostics surface · `opus` · M · lane none
`GET /api/app/admin/diagnostics` composing EXISTING state read-only: gbrain latch +
last sync + deferred count (P9), core install failures, credential pool probes
(`hasUsableCredential`/`soonestCooldownUntil`), REPL registry sessions (key, age,
lastDataAt, respawn count, capped_at — from repl-registry.json; today diagnosable only
by hand-reading the file), cron last-fire per job (cron_state is currently write-only),
import job statuses, recent system_events. Surface in the admin tab; extend
`bin/neutron doctor`; optional `/healthz?deep=1` (default healthz byte-identical).
**Accept:** "why is memory/chat/import broken?" answerable without journalctl.

### O6 — `[BEHAVIOR]` Wire the dead notice sinks · `opus` · S · lane composer
`onDeadTurnNotice`/`onSizeAlert`/`onRateLimitBanner`/`onRecoveredReply`
(runtime/adapters/claude-code/index.ts:133-135,226-231) are unwired in Open, and the
in-band `{kind:'status'}` fallback is dropped by every consumer. Wire them to
system_events + an owner-topic system bubble; wire onRecoveredReply to the existing
RecoveredReplyStore drain. Flagged: users start SEEING previously-invisible states.
**Accept:** a usage-capped session tells the owner instead of stderr.

### O7 — Gateway surface-kit · `sonnet` · M · lane none
`resolveBearer` ×19 verbatim copies, `jsonError` ×15, `readJsonBody` ×12, 21 identical
handler interfaces (compose.ts:37-261), + fold in the half-adopted
`ownerIdentityMismatch` (auth-helpers.ts:96). One `gateway/http/surface-kit.ts`.
**Byte-identical wire output** — `{ok:false,code,message}` bytes + stable code strings
are parsed by the Expo client. Route the Bun.serve catch-all 500
(gateway/index.ts:324-330, currently text/plain) through the same JSON shape —
small `[BEHAVIOR]` note (500 body bytes change; grep clients first).
**Accept:** a bearer-parsing fix is one edit; 19 copies deleted.

### O8 — drainToText consolidation · `opus` · M · lane none
~8 independent copies of the `for await (ev of handle.events)` drain+classify loop
(scribe/extract.ts:141-153, reflection/detector.ts:166-178,
agent-dispatch/substrate-turn.ts:93-105, email substrate-llm, code-gen tool-handlers,
both gateway substrate builders…). One `runtime/substrate-text.ts` `drainToText` with
policy hooks (onAbort, treatErrorAs, keepAliveExempt) + the single 429/exhaustion
classifier (from O3).
**Care:** consumers must drain to exhaustion — the CC adapter's EventChannel has no
finally/cancel hookup, and `cancel()` on an unsettled turn POISONS the warm session
(persistent-repl-substrate.ts:3021-3041); email's stub-throws-by-design and
scribe/reflection watchdog-abort divergences preserved via flags. Document the
`isAlive()` superset as an optional contract member (substrate.ts) while here, and
re-home the AgentSpec lock header (it cites a doc that doesn't exist,
substrate.ts:4-6).
**Accept:** one drain; adapter-dialect table documented in substrate.ts; the
three-adapter equivalence suite pins iterator semantics.

---

## 11. Phase 8 — Cores platform contracts (X)

### X1 — Real capability gate at dispatch (log-only) · `opus` · M · lane cores
`McpServer.dispatch` (mcp/server.ts:67-84) is the ONLY tool chokepoint and defaults to
allow-all (`:42`); production passes no gate (build-core-modules.ts:253);
`approval_policy` is never read; ApprovalManager has zero dispatch-path callers.
**Verifier amendments:** severity is P1 not P0 (all four gaps are documented deferrals,
e.g. mcp/server.ts:20-25), and dispatch **cannot consult installation records today** —
`ToolRegistration` (tools/registry.ts:52-69) has no core-slug provenance, and platform
tools (work_board, dispatch_agent, doc_search, skill_forge) have no installation record
at all. So: (1) add provenance to ToolRegistration + an explicit platform-tool policy
class first; (2) then make dispatch the chokepoint — capability check + approval-policy
consult in **log-only mode** (system_events). Enabling 'prompt-user' enforcement =
decision D-9, separate flagged PR.
**Accept:** every dispatch logs its capability verdict; secret_audit_log rows unchanged.

### X2 — Typed Core module contract · `opus` · M · lane cores
The real install contract is duck-typing of undeclared barrel exports
(install-bundled.ts:751-800) + a hardcoded `BACKEND_KEY_BY_SLUG` (:1024-1035) +
manifest-tools-without-handlers becoming silent throw-stubs (:886-905 — the ISSUE #330
class). Add `defineCore()` in cores/sdk (one typed factory + declared backend key);
install-bundled typed against it; manifest⊄handlers becomes a hard install failure OR
a surfaced degraded state in /api/cores (never a log line); conformance test over all
9 bundled barrels. Stop `wrapHandler` discarding context (:957-964) — pass ToolCallContext
into Core ToolDeps (enabler for X6).
**Accept:** a Core that under-implements its manifest cannot install silently-broken.

### X3 — One manifest contract · `opus` · M · lane cores
Two validators exist: `core-sdk/validator.ts` (650-line hand validator, zero production
callers, and core-sdk is `private:true` — NOT on npm as docs claim) vs the production
Zod `cores/sdk/manifest.ts` (open capability regex, deliberately wider than core-sdk's
closed union, bridged by casts at install-bundled.ts:935,974). Collapse to the Zod
source; retype `capability_required` as validated-open-string + known-platform set
consulted by X1's gate; delete or generate the hand validator; resolve the
`core-sdk`/`cores/sdk` near-duplicate name pair (merge direction: keep `cores/sdk`,
fold core-sdk's pure types in).
**Accept:** one schema; no casts defeating the union; done BEFORE third-party authors.

### X4 — cores/runtime shared helpers · `opus` · M · lane cores
`loadManifestFromPackageDir` (the ×9 copy-paste), `ProjectSidecarResolver<H>` (the ×4
copy with **security divergence**: only research has the `../`/NUL/absolute traversal
guard, safeResolveProjectRoot:128-159 — email/code-gen/calendar do a bare join on
tool-supplied project_id; adopting the guard everywhere is a `[BEHAVIOR]` security fix,
flagged not silent), exported CoreChatCommandFilter type (from L2), one error module
(CapabilityDeniedError ×2 today), one shared install-lifecycle test harness (×6 copies).
**Accept:** a new Core needs zero boilerplate copy-paste; traversal guard universal.

### X5 — `[BEHAVIOR]` Make the ChannelRouter real · `opus` · L · lane transport
(D-10 resolved: **make it real** — Ryan: multi-channel capability (Telegram/Slack
later) is required product direction, even though only web-chat exists today.)
Current state: `channels/types.ts:1-12` documents an adapter-registration architecture
with ZERO production registrations; the module graph wires the router as trident's
delivery sink (build-core-modules.ts:341-342) where `router.send` would THROW with no
adapters — masked only because no Open path sets run.chat_id. (Grep-confirmed: Managed
does NOT thread `composition.channel_router` — it POSTs to `/webhook/telegram`; so this
is Open-internal, though M1 pins the telegram webhook coupling.) Scope: (1) register the
**AppWs adapter** on the graph router in the Open composition (today it's constructed
directly and driven by a bespoke receiver, open/composer.ts:3206); (2) make the
`TelegramAdapter` class the real Telegram path (today `buildWebhookHandler` is mounted
directly and the class is never instantiated); (3) route trident terminal delivery +
proactive sends through `router.send`
(activates a dormant send path — under test, `[BEHAVIOR]`); (4) fix the types.ts
fiction header so it describes what now IS true; (5) composition test: every
`ChannelKind` a run can carry has a registered adapter (fail at boot, not at send);
(6) drop the adapterless `'cli'` enum member or stub it explicitly. This is the seam a
future Slack channel plugs into with one adapter + one registration — keep that the
documented recipe. Coordinates with F5 (the deliver() helper should sit ON the router,
not beside it) and N6 (ChannelKind persisted-vocabulary unification follows).
**Accept:** one delivery seam with ≥1 real adapter registered in Open; adding a channel
= one adapter file + one registration; boot fails loud on adapterless kinds.

### X6 — `[BEHAVIOR]` Project context to the tool boundary · `opus` · M · lane cores+substrate
The flagship product direction ("agentic per-project") is structurally blocked: the
warm sink dispatches tools "BEFORE the session lookup, topic_id:null"
(persistent-repl-substrate.ts:1019-1036) though the POST body carries session_id and
the pool key contains the project (:1039-1063); `ToolCallContext.project_slug` is the
OWNER slug with no product-project field (mcp/server.ts:112-135). Stamp project_id from
the session lookup into dispatch; add the product-project field; keep the
AsyncLocalStorage frame (active-project-context.ts:37-44) as fallback + SERVICE_SCOPE
policy. This is a deliberate capability ADDITION (tools gain context) — decision D-12
schedules it (recommended: last unit of the window, or first post-window feature).
**Accept:** per-project credential scoping works on the agent's native tool path.

---

## 12. Phase 9 — Client unification (W)

### W0 — UX architecture: RECORD the decision (Option D) · `opus` (design; Fable synthesizes) · S · lane clients (WAVE 0)
(D-13 resolved — Fable's delegated call.) **Decision: Option D — `landing/chat-react`
is the single canonical product UI** (desktop web, mobile web, AND inside the app via a
WebView / Expo-DOM shell); the Expo app becomes a thin native shell (auth token handoff,
`expo-notifications` push, deep-link → SPA route mapping). Retires ~25-30k LOC of twin
RN screens. **Why it wins on THIS codebase:** the native app is unpublished (today's
mobile UX is literally the web app added to home screen —
final-handoff-config.ts:49-53); `react-native-web` is already a dep + web export already
configured; transport/state is already unified on `@neutron/chat-core` over one
`/ws/app/chat`; and every UI feature currently ships twice (M1 PRs #178/#179/#181 each
touched both `app/` and `landing/chat-react`). Rejected: Expo-universal via RN-web
(would rebuild the just-shipped M1 CSS/DOM redesign in RN primitives, replace the
Bun.build serve loop with a metro artifact pipeline in both repos — 4-8 weeks, XL risk).
**This unit only WRITES the decision** (into this plan + SPEC.md) and enumerates W1/W4/W5/W6.
It also **schedules the WebView spike** — expanded per the offline/online investigation
to test the two things that actually decide native-vs-webview: (i) chat feel (keyboard
insets, scroll at 1k msgs, paste/file-picker), AND (ii) **the Telegram-bar edge cases** —
airplane-mode toggle mid-conversation, wifi↔cellular handoff, and a **cold WebView kill
while a message sits queued offline** (does the OPFS transcript + the un-sent message
survive an iOS WKWebView suspend/reload?). **Accept:** decision recorded; spike scoped to
chat-feel AND offline durability; W1/W2/W4/W5/W6 scoped below.

### W1 — client-core shared package (web-canonical) · `opus` · L · lane clients (after L6)
One package: `GatewayHttpClient` base (auth header, status→code map, ONE
GatewayClientError — replacing 16+8 per-client error classes, injectable fetch) +
per-surface modules + **the platform-free view-model layer** (`chat-react/controller.ts`
is already DOM-free) extracted to the shared package. **Under Option D, collapse each
twin pair toward the WEB module as canonical** (docs-client 867↔532, work-board 207↔311,
tabs 115↔180, project-credentials 150↔178). Locks: existing suites + G3 parity tests.
chat-core proves the pattern under metro. **Accept:** one client per surface, web-shaped;
~2,600 twin lines deleted; the RN twins that survive the shell period import the shared
core.

### W2 — Markdown: converge on react-markdown · `opus` · S · lane clients
(D-13 resolved: react-markdown.) **Freeze `app/lib/markdown-render.tsx` immediately**
(no new grammar — it's a 908-line hand parser with an explicit no-remark guard). The web
pipeline (react-markdown + rehype-sanitize, 118 lines) is canonical. The hand-rolled RN
renderer's fate follows the W4 spike: if the native chat surface is retired, it dies with
it; if ChatSyncSurface is carved out, replace it with a shared remark-AST parse (mdast is
platform-free) + a ~300-400 line RN renderer over that parse — NOT a second grammar.
**Accept:** one markdown grammar in the tree; RN renderer frozen pending W4.

### W5 — `[BEHAVIOR]` chat-core connection resilience (Telegram-bar hardening) · `opus` · M · lane transport (EARLY — independent of the shell)
The offline/online investigation confirmed the sync CORE is already Telegram-grade and
shared by every surface (persistent send-queue with idempotent `client_msg_id`; seq-cursor
gap-fill resume `after_seq`; local store as source of truth; exponential-backoff reconnect
`chat-core/ws-client.ts:203-207`). But four gaps sit BELOW the sync layer, in the socket
lifecycle — and because they're in shared `@neutron/chat-core`, one fix repairs web,
mobile-web, AND the future WebView shell at once. **This unit is scheduled early — it fixes
live bugs today and is NOT gated on the shell decision.** Close, all in chat-core:
- **GAP-1 (CRITICAL) — no heartbeat/half-open detection.** A phone's wifi↔cellular handoff
  leaves a half-open socket that `onclose` never fires for; the client believes it is
  connected and silently misses messages until the next user send. Add an app-level
  ping/pong (or missed-pong→force-close) so a dead socket is detected and
  `scheduleReconnect` (`ws-client.ts:180-187`) actually fires.
- **GAP-2 — no network-reachability reconnect trigger.** Reconnect only fires on socket
  `onclose`; on regained connectivity the client waits out the backoff (up to 15s dead
  air). Expose a `notifyReachable()` that resets backoff and reconnects now; surfaces wire
  it to their platform signal (browser `online` event; NetInfo via the W6 bridge on native).
- **GAP-4 — no ack-timeout / `failed` state.** A `sent` message whose ack never arrives
  stays 🕓 forever (`SendStatus`, `types.ts:123`). Add a per-message ack deadline that flips
  `sent`→`failed` and re-queues on reconnect, so the UI can show a retry affordance instead
  of a permanently-pending clock.
- **GAP-5 — resume not wired on every re-open.** Ensure `onOpen` always drives
  `resumeAndFlush` (`web-session.ts:326-334`) from the persisted MAX seq cursor
  (`store.ts:414-422`), and flush the outbound queue on the SAME open, so a reconnect both
  catches up AND drains queued sends. Add a `flush-before-suspend` hook surfaces can call
  on backgrounding.
**Care:** heartbeat cadence must not fight the one-reply-per-turn substrate; ack-timeout
must be generous enough not to double-send a slow-but-live turn (idempotent `client_msg_id`
makes a double-send safe, but avoid the churn). **Accept:** kill a socket at the OS layer
(airplane toggle) and the client detects it, reconnects on regain, catches up via seq
cursor, drains the queue, and never shows a permanently-stuck clock — verified in a
chat-core test that simulates half-open + flap; no sync-engine merge-law change.

### W4 — `[BEHAVIOR]` Expo shell conversion · `opus` · XL · lane clients (LATE / post-window)
(Option D execution; gated on W0's WebView spike.) (a) Shell PR: host `/chat` in an
Expo WebView / Expo-DOM component; auth token handoff into the WebView; push-tap →
SPA `/projects/...` route mapping (spa-routes.ts:28-31 already client-routes these);
native store chrome. (b) Retire the ~21 twin RN screens slice-by-slice (−25-30k LOC),
each slice behind the shell. (c) **Reversible carve-out:** the native `ChatSyncSurface`
(885 LOC, Telegram-grade delivery ladder + receipts + reactions + FlashList) is kept as
a native surface IF the spike shows WebView chat feel is inadequate — record that as a
new decision row when the spike resolves. **Precondition:** L6 wire-types landed (the
shell period needs one wire-type source even as `app/lib/ws-envelope.ts` +
`doc-links.ts` mirrors die with the retired screens). Pairs with a small **mobile-web
polish** unit on chat-react (visualViewport keyboard pinning, safe-area insets) that the
shell's chat feel needs anyway. **Accept:** app is a thin shell over the canonical web
UI; twin screens gone; chat feel verified on device.

### W6 — `[BEHAVIOR]` native-shell ↔ WebView resilience bridge · `opus` · M · lane clients (pairs with W4; needs W5)
The reason a plain WebView is NOT enough for the Telegram bar: a WKWebView cannot reliably
see the phone's real lifecycle. Its `visibilitychange`/`online` events are unreliable under
iOS suspension, and it has no NetInfo, no push, and its OPFS can be evicted on a cold kill.
Today ALL of this phone-flapping logic lives ONLY in the native `ChatSyncSurface`
(`app/lib/chat-core/use-mobile-chat.ts:183-212` — AppState→catchUp, foreground-push→catchUp;
`mobile-session.ts:159-168` catchUp; durable SQLite store `op-sqlite-store.ts:68-82`). Under
Option D the canonical web surface has none of it. So the shell must inject the native
signals the WebView can't see, over a tiny `postMessage` bridge, feeding the W5 hooks:
- **native → web:** `appState` (active/background → drives W5 flush-before-suspend + resume
  on foreground), `reachability` (NetInfo → W5 `notifyReachable()`), `push` (a delivered
  `expo-notifications` payload → trigger catch-up), `authToken` (handoff), and a stable
  **`device_id` OWNED BY THE SHELL** (persisted in native secure storage, not the WebView's
  evictable OPFS — `config.ts:206-207,234` / `web-session.ts:349-357` currently mint it
  web-side; the shell must supply it so identity survives an OPFS wipe).
- **web → native:** `queueDepth`/`unread` (badge), `wantsFlush` (ask the shell to keep the
  socket alive briefly on background), `haptic`/nav intents.
This is **Architecture B** from the UX investigation — a single native-owned chat-core
feeding the web view through the existing `chat-react/controller.ts` `ControllerSession`
injection seam (`controller.ts:189-241,413-428`), so NO second sync engine and no
merge-law fork. If the W0 spike PASSES on chat feel, the bridge just injects signals into
the web-owned chat-core; if it FAILS and `ChatSyncSurface` is carved out (W4c), the SAME
bridge feeds the native-owned chat-core instead — either way one sync core, one socket.
**Care:** the bridge is the ONLY new seam; keep it to serializable messages (no live
objects across the boundary); cold-kill durability is the acceptance landmine.
**Accept:** on a physical device — background the app with a message queued, hard-kill it,
relaunch: the message is still queued and sends on reconnect; a wifi↔cellular flap
mid-conversation catches up with no missed frames; `device_id` is unchanged across an OPFS
wipe. This is the on-device counterpart to W5's simulated test.

### W3a — `[BEHAVIOR]` Resume-fidelity stage-0 fix · `opus` · S · lane transport
Verifier-identified cheap slice of W3, executable early: add ONE nullable meta JSON
column to `app_chat_messages`, stamp it in `adapter.send` (the envelope already carries
options/prompt_id/citations/doc_refs at that point), extend `appChatRowToEnvelope`
(adapter.ts:806-841). Closes the only user-visible fidelity gap (buttons rendering as
plain text on WS resume) without the full transcript unification. G2's parity test
flips those specific fields from pinned-divergent to parity.
**Accept:** reconnecting client replays buttons; migration + snapshot regen; W3 scope
shrinks accordingly.

### W3 — `[BEHAVIOR]` Transcript unification · `opus` · XL · lane transport+data (LAST; after G2, F5, P5, W3a)
Make `app_chat_messages` the single durable transcript: widen schema (nullable
options/prompt_id/citations/doc_refs columns), point HTTP history + sidebar rail +
staging at it, shrink `button_prompts` back to prompt LIFECYCLE
(emit/resolve/expire/idempotency — today it moonlights as a message log via
empty-body pre-resolved prompts, button-store.ts:289-368, forcing COALESCE hacks).
Kill the double-write (build-live-agent-turn.ts:975-996 + adapter.ts:174-199).
G2's parity test flips from pinned-divergence to full-parity — that flip IS the
acceptance gate.
**Care:** ordering tiebreaks are landmines (history pagination inclusive-first-page vs
strict tuple; latestPromptByTopic rowid-DESC — button-store.ts:697-815); `__timeout__`/
`__cancel__` render as UNRESOLVED never user bubbles; EmitResult.was_delivered
re-render rule; persist-first seq assignment.
**Accept:** one transcript, full-fidelity resume; G2 green in parity mode.

### W7 — `[BEHAVIOR]` chat-react stable-mount rebuild · `opus` · XL · lane clients (Option D canonical UI — do BEFORE/with W1)
Folds in the live chat-UX jank cluster Ryan handed off (neutron-managed
`docs/research/chat-ux-jank-report-2026-07-03.md`, ISSUES #343/#354/#355/#356). **Root
cause:** the chat-react client has a mount/remount model that conflates "which project's
data is shown" with the React component INSTANCES — switching a project tears down and
rebuilds the whole chat surface. Four batches of patches (redesign PR-1..6 + live-review
#333–350) accreted on top of it; the batch-3 "fix" (#343, removed one `key={convId}`) was
net-negative — still flickers AND introduced a `useSyncExternalStore` snapshot bug that
now **crashes to a blank screen** (#354, LIVE P0). This is squarely in-scope because Option
D makes chat-react THE canonical UI — you cannot canonicalize a broken-mount client.
**The rebuild (architectural, not another patch):** one always-mounted `ChatShell` holding
thread-list + composer + work-pane as PERSISTENT instances; selecting a project swaps the
active project id into a store/context and components re-render with new DATA — **no
unmount/remount, no `key={convId}`/scope `key=` on these subtrees** (kill the survivors at
`ChatApp.tsx:1585,1773` + the `ConversationRuntimeHost` key at `useNeutronChat.ts:85`).
Sub-fixes: (a) audit EVERY `useSyncExternalStore` for cached-snapshot correctness (prime
suspect `work-activity.tsx:87` `useWorkActivity` — new ref only on real change) → kills the
getSnapshot infinite-loop + the "unmount an already-unmounted fiber" race (#354); (b) drive
the work-pane open/close from PERSISTENT state, not a per-scope remount (`ChatApp.tsx:1554`)
→ no re-slide on plain switch (#355), and auto-open on ANY active work (trident OR inline
card) within ~1s / auto-close when done (#4); (c) typing indicator turn-scoped +
reconnect-durable so a 162s cold-start turn still shows "typing" across app-ws
open/close/open churn (`controller.ts:130,142`, #356). **Acceptance gate is BROWSER-VERIFIED**
(the flicker was falsely declared fixed once because this was skipped): switch projects
back-and-forth, assert thread/composer DOM instances SURVIVE (identity check) and zero
console errors. **Care:** pairs with W1 (client-core) — the stable shell is the vessel the
extracted view-model plugs into; sequence W7 with or just before W1, not after.

### W8 — chat client cheap wins (pull cache-busting EARLY) · `sonnet` · S · lane clients
The low-risk, high-value slice of the jank report — do these ahead of the W7 rebuild so
dogfooding improves immediately. **(a) `[BEHAVIOR]` bundle cache-busting — PULL EARLY (it
bites EVERY client deploy during the refactor itself):** `landing/server.ts:1407` serves
`/chat-react.js` with `cache-control: public, max-age=86400` and NO content-hash, so
browsers run stale code after a deploy until a manual hard-refresh (this masqueraded as a
"work pane empty" bug for a while, #353). Fix = content-hashed filename or `?v=<build-id>`
or short-max-age+ETag. (b) desktop light/dark toggle (batch-4 #350 over-removed it on ALL
viewports; restore on desktop, mobile keeps the Appearance control — #360); (c) markdown
list spacing too loose (`.car-md ul/li`, #358); (d) Telegram-style copy button on code
blocks (`.car-md pre`, #359). **Accept:** a redeploy never serves a stale bundle; desktop
theme toggle back; tighter lists; one-tap code copy.

---

## 13. Phase 10 — Naming, vocabulary & hygiene (N)

> Sequenced LAST among code phases: deletions (K) and splits (C/D) shrink the sweep.
> The retired-word purge is DONE (leak-gate enforced); the real debt is the identity
> vocabulary below.

### N1 — Identity glossary + branded handle type · `sonnet` · S · lane data
`project_slug` (6,587 refs/732 files) means the OWNER/INSTANCE slug — not a project —
colliding with real `project_id`; `internal_handle` (858 refs) is its frozen twin; one
value flows under FOUR names at one call site (mount-open-cores.ts:183/215/250/264).
Write the glossary (owner_handle vs owner_slug vs url_slug vs project_id) into
persistence/AGENTS.md; add branded `OwnerHandle` type at the SecretsStore /
ApiKeyStore / ProjectCredentialStore boundaries (the documented 2026-05-12
credential-loss incident: passing the mutable url_slug where the frozen handle is
required silently loses every credential — auth/secrets-store.ts:10-27).
**Accept:** wrong-slug-passed is a compile error at the credential boundaries.

### N2 — internal_handle → owner_handle (non-ABI sweep) · `haiku` · M (staged per package) · lane none
Pure identifier rename (verified: zero persisted 'internal_handle' string keys):
onboarding (152 refs), cores (67), open (24), landing (14), gateway internals.
Supplied rename map; per-package PRs; ABI-facing files EXCLUDED (N3's list).
**Accept:** suite green per package; no ABI file touched.

### N3 — internal_handle → owner_handle (ABI-facing files) · `opus` · S · lane composer
**Corrected by the ABI grep:** `internal_handle` has **zero Managed consumers** (Managed
references it in comments only; it explicitly dropped the split). So this is NOT a
cross-repo rename — it's the rest of the Open-internal sweep from N2, covering the files
N2 excluded (the realmode-composer builders, platform-adapter, BootOwnerRow). No alias
window. **Care:** if any of these files also touch a `buildTenantEnv` env name read
under open/gateway (they don't today, but verify), coordinate a paired `open-contract.ts`
bump. **Accept:** zero `internal_handle` identifiers in Open code; contract gate green.

### N4 — project_slug → owner_slug (instance sense) · `sonnet` · L (staged per package) · lane none
The 6,587-ref bulk. TS identifiers only; **SQL column names stay frozen** with the
secrets-store-style header comment (the schema snapshot test pins them; never
renumber/rename migrations). Per-package review required — a minority of
`project_slug` uses sit next to `project_id` in the same row types.
**Accept:** instance-sense TS identifiers say owner_slug; schema snapshot unchanged.

### N5 — Directory/name hygiene · `sonnet` · S · lanes various
Adapter dirs `gpt-5-5-api/`→`openai-responses/`, `gpt-5-5-codex-cli/`→`codex-cli/`;
the three unrelated "wedge" modules get distinct names; `disk-recovery` ×2
disambiguated; document the `open/` overload (product / mode enum / dir / federation
sense) and the gateway-subdir↔workspace collisions (gateway/cores vs cores/…).
**Accept:** rename map executed; import shims where externally referenced.

### N6 — `[BEHAVIOR]` ChannelKind persisted-value unification · `opus` · M · lane transport (after X5)
`ChannelKind` ('app_socket', underscore) vs `ChannelKindForButton` ('app-socket',
hyphen) are PERSISTED row values in button_prompts — unification is a data migration +
dual-read window, not a type edit; drop the adapterless 'cli'/'webhook' enum members
per X5's outcome. **Accept:** one vocabulary; migration + dual-read tested.

### N7 — Ghost references + reminder-prompt fix · `opus` · S · lane docs
18 references to nonexistent `scripts/**` paths, three load-bearing: the
operator-facing error at gateway/boot-helpers.ts:205 (points self-hosters at a script
that doesn't exist); `prompts/reminder-agent-base.md` + `reminder-patterns.md` instruct
the fire-time agent to use `tg-post.sh`/`weather.sh` (Vajra machinery Open doesn't
ship) and address a stranded persona ("Sam"); `smart-wrap.ts:71` bakes the weather.sh
reference into stored reminder instructions. Fix prompts to Open-real capabilities.
**Care:** prompt edits change agent behavior at fire time — A/B the reminder
composition on a test instance; the literal fallback (dispatcher) is the safety net.
**Accept:** no prompt/error references machinery absent from the repo.

### N8 — Codename glossary + selective scrub · `haiku` · S · lane docs
Nova(106 files)/Vajra(92)/Topline(88)/Hermes(21)/OpenClaw(11) provenance residue: keep
provenance in test anchors (vajra-fixes.test.ts is a live parity anchor), scrub from
published-contract doc comments (core-sdk/types.ts), add GLOSSARY.md.
**Accept:** contributors can decode "per Vajra FIX 9".

---

## 14. Phase 11 — `[BEHAVIOR]` Security hardening to the public-launch bar (S)

> All flagged behavior changes; Ryan pre-approved the direction ("fail-closed gate
> tracked for public launch"). S0 lands EARLY (verifier recommendation — small,
> standalone, needs nothing from the C-phase); S1–S3 ride on C3c/C5's named gate.

### S0 — `[BEHAVIOR]` Early security quick-patch · `opus` · S · lane transport (wave 1)
Verifier-recommended standalone patch, independent of the composition rebuild:
(a) Origin/Host allowlist on the `/ws/app/chat` upgrade
(`gateway/http/app-ws-surface.ts:204-266` — accept missing Origin for native clients;
today any web page the owner visits can open
`ws://127.0.0.1:7800/ws/app/chat?token=dev:owner`); (b) replace the guessable
`dev:owner` bearer with a per-boot random app-ws token injected into the served client
bootstrap (the injection point already exists — the React bootstrap HTML splice,
open/composer.ts:1616-1626). Precision note from verification: the resolver already
rejects any user_id ≠ 'owner' (open/composer.ts:1977-1993) — the hole is that 'owner'
is a public constant, not that auth is absent.
**Accept:** cross-origin WS rejected; a fresh boot mints a fresh token; Expo + web
clients still connect.

### S1 — Per-install owner credential · `opus` · L · lane composer
Today the owner surface is unlocked by the literal string `dev:owner`: bypass is
hardcoded `true` (open/composer.ts:1977-1993; channels/adapters/app-ws/auth.ts:102-124;
web client default `appWsToken = \`dev:${userId}\``, chat-react/config.ts:217), and
`/api/app/*` + `/ws/app/chat` sit OUTSIDE the cookie gate (openFetch covers only
/, /chat, SPA routes; composition.auth_gate never set in Open). Generate a per-install
owner bearer at install (alongside the cookie secret), inject via the served client
bootstrap, require it on the app-ws resolver + every /api/app/* surface via the C5
gate seam.
**Accept:** `NEUTRON_HOST=0.0.0.0` no longer means "anyone on the network is the
owner"; all clients still work via the injected credential.

### S2 — WS origin + fail-closed guards · `opus` · M · lane composer
(a) Validate Origin/Host on the WS upgrade (app-ws-surface.ts:204-266 has none — a
malicious page the owner merely visits can open
`ws://127.0.0.1:7800/ws/app/chat?token=dev:owner` today). (b) BootConfig guard (rides
C1): refuse non-loopback bind without a real owner credential; refuse boot if any dev
bypass (`NEUTRON_DEV_AUTH`, `NEUTRON_APP_WS_BYPASS`, `NEUTRON_APP_WS_DEV_SECRET`,
`NEUTRON_E2E_DEV_SECRET`) is set on a wide bind. (c) Cookie/start-token secret fails
LOUD when unset — delete the predictable `open-ephemeral-${…}` fallback
(open/composer.ts:1164-1165).
**Accept:** cross-origin WS rejected; weak-secret branch unreachable.

### S3 — Secrets-at-rest hygiene · `sonnet` · S · lane ci
(a) `neutron-backup.sh` currently bundles `.neutron-aes-key` WITH `project.db` (the
ciphertext) and pushes both to the remote (:126-135,150-179) — exclude the key or move
it outside NEUTRON_HOME. (b) install.sh never chmods `.env` (0 chmod calls; the runtime
writer force-0600s, install-token-env.ts:37-47 — make the installer match). (c)
`.env.example`: document the dev-bypass vars with a "never in production" banner.
**Accept:** backup remote cannot decrypt secrets; .env is 0600 from install.

---

## 14.5 Phase 12 — neutron-managed (M)

> Scope added by Q1. Managed is a clean ~10.6k-LOC hosted-multi-instance overlay (no god
> files, strict tsconfig, strong test ratio) that runs each tenant as a stock vendored
> `open/server.ts`. Its debts are narrow. All M-units run in `~/repos/neutron-managed`;
> the lane is `managed` (independent of every Open lane except where an Open unit touches
> the 8 `open-contract.ts` surfaces — those pair with a Managed bump in the same wave).

### M0 — Managed CI · `sonnet` · S · lane managed (WAVE 0)
Managed has **zero CI** — the ~6-vendor-bumps/day contract gate + tenant tests run only
by hand on Ryan's Mac. Add GitHub Actions: `bun test` (incl. `tests/open-contract.test.ts`
against the pinned `vendor/neutron`) + `tsc`. **This lands in wave 0** — before any Open
C-wave can break the gate, Managed must fail loud in CI, not silently at deploy.
**Accept:** red contract or red tenant tests block a Managed merge automatically.

### M1 — Contract-gate hardening + route-manifest adoption · `opus` · M · lane managed
The gate is path+substring matched, so Open file *moves* break it even when names
survive. (a) Widen `open-contract.ts` to cover the two unpinned runtime couplings the
grep found: `POST /webhook/telegram` (bots/routing.ts:84 → served at Open
compose.ts:1269) and the bare-`gbrain`-on-PATH spawn. (b) Once Open ships G1's
machine-readable route manifest, repoint the `'/chat'` substring surface at it (plan
§3 G1 already sketches the Managed-contract variant). (c) Extend `ENV_READ_DIRS` if any
Open env read moves outside `open/`+`gateway/`.
**Accept:** the gate catches file relocations, not just renames; telegram + gbrain
couplings pinned.

### M2 — Thread the two forward seams (or delete) · `opus` · S · lane managed
`NEUTRON_POST_ONBOARDING_CLAIM_URL` is read by Open (composer:1710-1721,3526, PR #152)
but `buildTenantEnv` never sets it → hosted tenants never auto-redirect to `/claim`
today (a real gap). Thread it through `buildTenantEnv`. `NEUTRON_GRAPH_COMPOSER_MODULE`
has zero consumers in either repo — **delete it from Open** (gateway/index.ts:500-587,
the loader + the stale old-monorepo comment) as part of this or C-phase.
**Accept:** hosted claim redirect works; the dead composer-module seam is gone.

### M3 — Coordinated ABI bumps (rider on Open units) · `opus` · S each · lane managed
Not a standalone unit — a **rider**: every Open unit touching the 8 gated surfaces
(C1 env resolution, C2/boot-helpers, C3a-d + C4 `/chat`, G5 if it moves healthz, N4 if
it renames `NEUTRON_INSTANCE_SLUG` or the healthz `project_slug` field, the
agent-name-suggester path) ships a paired Managed PR updating `open-contract.ts` +
`buildTenantEnv` in the same wave. **Identity renames touching `NEUTRON_INSTANCE_SLUG`
require per-tenant systemd unit REGENERATION** (persisted `Environment=` lines;
ISSUES #302 TENANT_HOME→OWNER_HOME precedent) — sequence those EARLY while prod has
exactly 1 live tenant. **Accept:** no vendor bump ever lands with a red contract gate.

### M4 — Wire the gated deploy pipeline · `sonnet` · M · lane managed
`deployOpenBump` + `rollingRestart` (src/ops/deploy.ts:235) are built + tested but never
invoked — deploys are a manual ssh runbook. Script the gated bump over the existing
programmatic path. **Accept:** a vendor bump is one gated command, not a runbook.

### M5 — Dormant-module decision · `opus` · M · lane managed
~1.5k LOC built-but-dormant: `bots/*` (623, per-tenant Telegram token wiring never
finished), `billing/stripe.ts` (242, webhook never mounted), `fleet/supervisor.ts` (203,
never started), `lifecycle.ts` (171), `edge/tls`+`ionos-dns`+`dns-automation` (476).
Per-module: wire or delete (mirrors Open's F2/F4 dormant-loop discipline). **Accept:**
no dormant subsystem reads as live.

### M6 — Managed docs hygiene + kill the stale worktree · `sonnet` · S · lane managed
The docs corpus was seeded from neutron-old (2026-06-18) so deploy-runbook + many ISSUES
describe the dead monorepo pipeline. Fix. Delete the `neutron-managed-contract` **git
worktree** (frozen debris; Managed HEAD's `open-contract.ts` is the single authority).
**Accept:** Managed docs describe the real vendored-tenant architecture; worktree gone.

> **In flight, not a refactor unit:** Managed ISSUES #332 (P0, named-project work-board
> write-path) has a Forge fix already dispatched — let it land on its own; the M-phase
> starts from a green Managed main.

---

## 14.6 Phase 13 — Memory: perfect recall & agent coordination (R)

> **Goal (Ryan, 2026-07-03):** make neutron's memory best-in-class — "perfect recall +
> perfect agent coordination" — matching the reference 4-layer architecture (@MatthewGunnin;
> built on Garry Tan's **gbrain** + Vectorize **Hindsight**), but **fully autonomous** (no
> human-review save gate — the property neutron's Scribe already has). Grounded + pressure-
> tested against a "don't over-build for a single owner" skeptic in workflow wf_0fbecd64-ae9;
> the audit map is in [[neutron-memory-perfect-recall-gap]].
>
> **Framing correction the audit produced:** neutron's WRITE side is already autonomous +
> live (Scribe, per-turn, no gate). The gap is the READ side. Recall is **pull-only** — the
> agent must *remember* to call `gbrain_search`; nothing is pushed pre-turn beyond a one-line
> static hint (`build-live-agent-turn.ts:1205` "read from entities/ when recall helps"). And
> there is **no cross-agent decision log** — no place for one agent to record "I decided X
> because Y" that a *different* agent type reads back (trident's `inner_result` handoff is a
> mutable single-value column; reflection is chat-only and read only on the FIRST turn of a
> session; the work-board holds one-line task STATE, never rationale).
>
> **Ryan's split:** A (hardening) + C (coordination substrate) fold into the refactor;
> B (behavior) is Phase R, sequenced LAST in-window. Behavior units (RB1/RB2/RC2/RC3/RB3/RB4)
> sit behind ONE shared flag so the whole recall/coordination uplift enables/rolls back
> atomically. Codex reviews all per standing routing.
>
> **NON-GOALS (skeptic-locked — do not re-add):** no claim/lease/assignee on the work-board
> (single gateway process + one write-mutex + subprocess-clients-at-human-cadence = zero real
> contention; `linked_run_id` already IS the claim marker, `clearRun` is race-guarded); no
> Redis/NATS/blackboard bus (Nexus is a SQLite **sidecar**, not a bus); no eager pre-turn
> semantic retrieval replacing `gbrain_search` (context-blowup trap — index-of-pointers +
> pull-for-detail instead); no reflection scope-filtering (cross-topic owner-correction bleed
> is a recall FEATURE for one owner); no hand-maintained memory file (autonomous saves rot it);
> no second semantic index while gbrain is off.

> **Portability & swappability invariants (Ryan, 2026-07-03 — MUST-PRESERVE, not features to build).**
> Ryan wants the refactor to keep two future doors open without building either now:
> **(I1) the brain persists across harnesses** (switch neutron ↔ OpenClaw ↔ Hermes and the
> knowledge survives), and **(I2) the brain backend is swappable** (replace gbrain with a
> different memory engine later). The code already supports both — the refactor's job is to
> NOT regress them, enforced mechanically:
> - **Source of truth stays harness-neutral.** `entities/<kind>/<slug>.md` (compiled-truth +
>   append-only timeline) remains THE durable knowledge substrate; gbrain stays a *derived,
>   re-buildable index*; `GBRAIN_HOME` + the `entities/` root stay injectable / external-
>   addressable (they are today). RB1's `INDEX.md` is markdown (portable ✓). The Nexus (RC1)
>   and work-board are neutron-OPERATIONAL coordination state — explicitly NOT the portable
>   brain; never let knowledge migrate into them or into neutron-only SQLite. (I1)
> - **`MemoryStore` / `McpClient` is the ONE swap seam.** Only `gbrain-memory/` may know it's
>   gbrain; the single construction point is `buildGBrainMemory()`. No new memory unit (RC1,
>   RB1, RB3, RB4) may call gbrain MCP ops (`put_page`/`add_link`/`get_links`) or import
>   gbrain internals — they go through `MemoryStore`. **Enforced by a depcruise rule (extend
>   G4):** gbrain coupling is forbidden OUTSIDE `gbrain-memory/` and the single sanctioned
>   exception `connect/` (the syndication mirror is inherently gbrain-format-shaped). (I2)
> - The existing `connect/shared-project-memory-mirror.ts` is the cross-install sharing
>   primitive (I1's mechanism) — leave it working; it proves portability is designed-for.
> These are guardrails only; the actual multi-harness / alternate-backend FEATURE stays out of
> the window (Ryan: "no need to add to the spec yet").

### RA1 — Serialize `writeEntity` per (kind,slug) — close the lost-update race · `sonnet` · S · lane data
The ONE genuine unserialized same-resource write path. `runtime/entity-writer.ts:246`
does read(existing)→mergeTimeline→render→tmp+rename: atomic (byte-equal short-circuit,
atomic rename `:334`) but **not isolated**. Two concurrent same-slug writers (chat scribe +
a Cores calendar/email scribe, or scribe + onboarding import) each merge only their own
timelineAppend and the second rename **silently drops the first's timeline row** (classic
lost update; no per-slug lock, no CAS). Fix = a `Map<`${kind}/${slug}`, Promise>` async
lock reusing the exact `withLock` chaining idiom already at `persistence/db.ts:216` (~15
lines, no new dep). Pure correctness — no runtime-visible behavior change, no flag.
**Accept:** a concurrent same-slug regression test (two `writeEntity` calls, distinct
timeline rows) shows both rows survive; today it drops one.

### RA2 — gbrain **live-or-loud** (kill "dead in prod") · `opus` · M · lane substrate
Today gbrain is fail-soft-gated on the `gbrain` binary being installed; if the deployed box
lacks it, every memory op is a **silent** no-op and recall degrades to file-grep
([[neutron-gbrain-memory-dead-in-prod]] — the `ensure-brain-init.ts` + `gbrain_search` code
fixes exist, but liveness is install-dependent). Make it live-or-loud: guarantee the binary +
`gbrain init` in the provision/boot path (Open boot + Managed launcher `buildTenantEnv`), and
convert the silent binary-missing latch into a **startup health assertion surfaced in
`/healthz`** (degraded, not hidden). Structural (makes an already-intended path actually
work), so no feature flag — but **pairs a Managed `open-contract.ts` check** if it touches a
`buildTenantEnv` env name. **Accept:** a box without the brain fails `/healthz` loudly
instead of silently grepping; with it, `gbrain_search` returns real hits.

### RA3 — Semantic embeddings on by default · `sonnet` · S · lane substrate
Recall is lexical-only until a key appears (`NEUTRON_EMBEDDINGS` default off,
`gbrain-memory/embedder-config.ts:121`). Default to `auto` with a **local embedder fallback**
(ollama `nomic-embed-text`) so recall is hybrid (vector + keyword + graph) out of the box; the
3072-d column is already pre-sized so an onboarding OpenAI key upgrades in place with the
existing `gbrain embed --stale` backfill — no rebuild. **Accept:** a fresh install does
semantic recall with no key; pasting a key upgrades in place.

### RA4 — Resolve the dead `doc-search` semantic seam · `sonnet` · S · lane docs
`doc-search/store.ts:24-40` has an optional embedder seam but the composer wires
`DocSearchRuntime` with **no embedder** (`open/composer.ts:812`) → the semantic doc path is
dead code. Per the one-path rule: **wire it** (share RA3's embedder so project-doc search is
hybrid too) **or delete** the seam. Recommend wire — doc recall benefits identically.
**Accept:** no dead embedder branch; doc-search is hybrid or the seam is gone.

### RA5 — Backend-neutral memory seam (protect swappability I2) · `sonnet` · S · lane data
Lock the swap seam so a future backend change (or shared external brain) doesn't require
touching callers or make the agent contract lie. Two parts: (a) **rename the agent tool
`gbrain_search` → `memory_search`** with backend-neutral schema/descriptions (drop "GBrain
page type" → "memory entry kind"); the tool already runs on `MemoryStore`, only the name +
prose leak the backend (`gbrain-memory/agent-tool.ts:37`). Update the system-prompt hint +
tests. (b) **Add the depcruise rule from the I2 invariant** (extend G4): forbid gbrain MCP op
names (`put_page`/`add_link`/`get_links`) and `gbrain-memory` internal imports OUTSIDE
`gbrain-memory/` and `connect/`. This makes the "one swap seam" a compile-time guarantee, not
a convention. **Care:** `scribe/write-to-gbrain.ts` + `GBrainSyncHook` reference those op
names in *comments* and go through `MemoryStore.add` — the rule targets real calls, not prose.
**Accept:** agent sees `memory_search`; a stray gbrain call from a product module fails
depcruise; swapping `GBrainMemoryStore` for another `implements MemoryStore` touches only
`buildGBrainMemory` + `gbrain-memory/`.

### RC1 — Nexus append-only decision/observation log — SUBSTRATE · `opus` · M · lane data
The missing cross-agent recall primitive, built by reusing the **existing** append-only
sidecar idiom **verbatim** from `gateway/comments/comment-store.ts` (per-project sidecar DB,
`BEGIN IMMEDIATE` + ULID + a single `appendEvent` write surface, rm-with-project lifecycle) —
NOT a bus. New `agent_nexus_events`: `id` ULID, `actor_kind`
{chat|reflection|scribe|forge|argus|orchestrator|user}, `actor_id`, `kind`
{decision|observation|learning|handoff}, `body`, `refs_json`, `created_at`; plus
`appendEvent` + `readRecent(kinds?, since?)`. Load-bearing schema/taxonomy — get the event
kinds + refs shape right up front; RC2/RC3 build on it. behavior=false (a store with no
emitter/reader is invisible until RC2/RC3), so it lands in the refactor ahead of any behavior.
**Accept:** store round-trips under concurrent append; no reader yet.

### RB1 — `[BEHAVIOR]` Dynamic memory-index manifest (Layer 1) · `opus` · M · lane transport
Closes pull-only recall's **unknown-unknowns** hole (an agent can't `gbrain_search` for an
entity it doesn't know exists). Auto-generate a **pointers-only** manifest (entity
kind→slug→title→one-line for people/companies/concepts + active work-board handles),
regenerated on the `writeEntity` post-write `syncHook` (`entity-writer.ts:356`) and written
durably to `entities/INDEX.md` (greppable/portable). Inject it **once per (instance,topic)
session** at the `instance_fragments` cold-turn seam (`build-live-agent-turn.ts:1266`) with a
one-line "use `gbrain_search` or read the file for detail." It's the **breadth** tier; the
existing pull tools stay the **depth** tier. **Hard cap + graceful degrade** (over budget →
kind-counts + most-recent-N handles, never silent truncation). Non-goals: no full bodies, do
NOT replace `gbrain_search` with eager pre-fetch, do NOT hand-maintain.
**Accept:** the agent names an entity it was never told about in-conversation because the
index advertised it; manifest stays under budget at 1k+ entities.

### RB2 — `[BEHAVIOR]` Reflection: warm-turn re-splice + broaden readers · `sonnet` · S · lane transport
Today `reflection.loadContext()` runs only on the FIRST turn of an (instance,topic)
(`build-live-agent-turn.ts:1306`), so a correction given 20 min into a session doesn't
resurface until a new session; and reflection is **chat-only** — trident/Forge/Argus never
read it. (a) Re-splice the (already-capped: 12 corrections / 3 days) block on warm turns via
the same per-turn seam the work-board uses; (b) make trident/Forge/Argus first turns also load
the reflection context so owner corrections reach build agents. Zero new storage.
**Accept:** a mid-session correction re-appears next warm turn; a trident build turn shows the
owner's recent corrections in context.

### RC2 — `[BEHAVIOR]` Nexus emitters · `sonnet` · S · lane trident+data (after RC1)
Wire the producers at existing seams: trident's inner→outer harvest (`trident/store.ts`
`inner_result` path) appends a `handoff` event; the Argus verdict appends a `decision`; the
reflection `onTurnComplete` writer ALSO emits a `learning` event so owner corrections become
visible to build agents. Additive — must capture the right `actor_kind`/`refs` without
disturbing the mutable-state stores they hang off. **Accept:** an overnight trident run leaves
decision + handoff events a later chat turn can read.

### RC3 — `[BEHAVIOR]` Nexus read + per-turn inject · `sonnet` · S · lane transport (after RC1; with RC2)
Add a compact `<agent_nexus>` fragment (recent-N decision/handoff/learning events, delimited-
data + XML-escaped exactly like `work-board/fragment.ts`'s `<work_board>` anti-injection
hardening) spliced at the cold-turn seam. This is the half that turns Nexus into coordination:
every orchestrator/chat turn re-grounds on other agents' recent decisions. Capped + pointers-
lean (long bodies link via `refs`, not inlined). Ships dark alongside RC2 (a reader over an
empty log is a no-op). **Accept:** a chat turn cites a decision a build agent made overnight.

### RB3 — `[BEHAVIOR]` Consolidation / reflect cron skill · `opus` · L · lane substrate
The autonomous "reflect" pass (gbrain's cron-skill pattern; Hindsight belief-consolidation).
A scheduled skill that re-synthesizes entity compiled-truth from timelines, dedups near-
duplicate pages (Jaccard over titles/bodies), and extends extraction to the meeting/project/
original kinds Scribe **reserves but never writes** (`write-to-gbrain.ts:137`). LLM cost
confined to this batch pass — the tiered-write discipline (deterministic on every save, LLM
only in reflect) that keeps autonomy affordable. **Accept:** stale/duplicate pages collapse;
meeting/project entities start appearing; cost stays in the batch window.

### RB4 — `[BEHAVIOR]` Temporal invalidation (belief evolution) · `opus` · M · lane data
Entity pages are compiled-truth + append-only timeline, so facts **accrete but never get
superseded** (a moved job / renamed company just piles up). Add supersede/invalidate semantics
(Hindsight belief-evolution / mempalace `kg_invalidate`): a timeline entry can mark a prior
fact stale, and compiled-truth + the gbrain edge reflect **current** truth while the timeline
keeps history. **Accept:** superseding a fact updates compiled-truth + the graph edge but
leaves the dated history intact.

---

## 15. Decision queue — RESOLVED by Ryan, 2026-07-02

| # | Decision | Resolution |
|---|---|---|
| D-1 | Managed repo: slugPicker? | **RESOLVED by grep: Managed has its OWN slug picker (`/v1/slug/check`, `src/signup/`) and zero references to `buildSlugPickerEngineHook` — Open's is DELETE, not relocate (K2).** |
| D-2 | Per-chunk import pipeline | **RESOLVED by grep: Managed runs vendored Open synthesis (never injects code), so relocation is impossible and unnecessary — verify-dead-in-single-owner-boot then DELETE in Open (K3). Import pipeline confirmed dead: `importUseSynthesis:true` hard-coded at composer:1304, the "Managed reuses it" rationale is void.** |
| D-3 | Private-repo ABI audit | **DONE (grep complete). Real ABI = 2 source imports + 8 process-contract surfaces in `open-contract.ts` (see §0 rule 3). No composer, no `internal_handle` option-bag, no `NEUTRON_GRAPH_COMPOSER_MODULE` consumer. `neutron-managed-contract` is a stale worktree, not a repo.** |
| D-4 | SPEC.md | **Public in-repo SPEC.md, conventions ported from neutron-managed/SPEC.md but content authored FRESH (Managed's is saturated with leak-gate-banned tokens). New unit K10. NOTE: adding root SPEC.md flips neutron-open into trident Ralph "governed mode" (detectRalphMode triggers on SPEC.md existence, no force-OFF) — sequence K10 AFTER the last trident-executed window unit, or inject `resolveRalph:()=>false` for window dispatches.** |
| D-5 | Onboarding architectures | **RESOLVED by trace: a fresh install runs conversational Path-1 UNCONDITIONALLY (the `NEUTRON_ONBOARDING_CONVERSATIONAL` flag is already collapsed — `platform-adapter-local.ts:253-264` hard-pins it, nothing reads the env). The "other" mode (InterviewEngine's conversational drive: start/advance/consumeChoice/llm-router) is **already dead code on every live path in BOTH repos**. So K11 is de-risked to code-removal + test migration. The engine survives only as the import pipeline → D9 re-scopes to a ~2-3k-line import subsystem.** |
| D-6 | Subagent registry | **Persist minimal + boot reap (P7 as specified).** |
| D-7 | Dormant loops (backup scheduler, agent watcher) | **Document as dormant now; add BOTH to SPEC.md as post-window feature PRs (K10 seeds them).** |
| D-8 | watchdog/ package | **(b) WIRE IT FOR REAL — finish the S5/S6 wiring (real notifier, real heartbeat source, ProcessRegistry writers, all six detectors), notify-only first. F4 rescoped.** |
| D-9 | HITL 'prompt-user' | **Log-only through the window; add a SPEC.md review item to decide enforcement with log data (K10 seeds it).** |
| D-10 | ChannelRouter | **MAKE IT REAL — Ryan wants multi-channel capability (Telegram/Slack later) even though only web-chat exists today. X5 rescoped: register the AppWs adapter on the router, keep ChannelAdapter as the documented extension seam, conformance test that every ChannelKind a run can carry has an adapter.** |
| D-11 | Audit reports tracking | **Keep untracked (plan doc is the tracked artifact).** |
| D-12 | X6 scheduling | **Last unit of the window.** |
| D-13 | Web+Expo UX architecture | **RESOLVED (Fable's call): Option D — `landing/chat-react` becomes the single canonical UI (desktop+mobile web AND inside the app via WebView/Expo-DOM shell); retire ~25-30k LOC of twin RN screens. Native app is unpublished; M1 redesign is web-side; every feature ships twice today. Gated on a WebView chat-feel spike; native ChatSyncSurface is the reversible carve-out. → W0 (decision, wave 0) + W4 (shell conversion, late); W2 resolves to react-markdown now. ⚠️ retires native code — spike-gated + reversible; flagged for your sanity-check.** <br>**Offline/online addendum (investigated 2026-07-02, wf_d202931d-304):** the sync CORE is already Telegram-grade and shared by all surfaces via `@neutron/chat-core` over one `/ws/app/chat` — so the hybrid fallback is clean. Four socket-lifecycle gaps found (no heartbeat/half-open detection, no reachability-triggered reconnect, no ack-timeout→`failed`, phone-flapping logic only in the native surface) → split into **W5** (shared chat-core hardening, pulled EARLY — fixes web+mobile-web today) + **W6** (native-shell↔WebView bridge injecting AppState/NetInfo/push/device_id the WebView can't see). Hybrid shape = **Architecture B**: one native-owned chat-core feeding the web view through the existing `ControllerSession` seam — no second sync engine either way. |

**Scope expansion (Q1) — corrected by investigation:** the feared invisible Managed ABI
**never existed** (old-monorepo artifact). New Managed runs stock vendored Open per
tenant. Consequences: (a) MOST Open units need zero Managed coordination; only units
touching the 8 `open-contract.ts` surfaces (§0 rule 3) ship a paired Managed PR same
wave; (b) a Managed **M-phase** is appended (§14.5); (c) N3's compat window collapses —
`internal_handle` has no Managed consumer, the rename is Open-internal.

---

## 16. Wave schedule (parallel lanes)

Within a wave, units run as PARALLEL trident runs (different lanes). A unit starts
when its deps are merged and its lane is free.

| Wave | Units | Notes |
|---|---|---|
| **−1 (Step 0 — FIRST)** | **F9 · W8 · W7-crash** | Live-bug fixes Ryan hit dogfooding, done first (they're P0/P1 in prod and independently shippable). **F9** = trident conflict-resolver toolless (builds fail on conflict). **W8** = chat bundle cache-busting (#353, bites every deploy) + cheap wins. **W7-crash** = the #354 blank-screen crash slice of W7 (the stable-mount snapshot-cache + fiber-unmount fix), pulled out of the full W7 rebuild so the live crash stops now; the rest of W7 stays in wave 7 with W1. F9 is the orchestration **pilot** (smallest, verified anchor). |
| **0** | G1 G2 G3 G4 G5 G6 G7 G8 G9 G10 · **W0** · **M0** | All additive; fully parallel. W0 = record Option D + schedule the WebView spike. M0 = Managed CI (must precede any Open C-wave that could break the gate). |
| **1** | K1 K2 K3 K4 K5 K6 K7 K8 K9 **K11** · **S0** · **W3a** | Parallel across lanes (K3/K4/K11 serial in `engine`; K2/K11 order in `bridge`). K10 moved to wave 9 (Ralph-governed-mode side effect). K11 de-risked (loser is already dead). |
| **2** | L1 L2 L3 L4 L7 · C1 · **W5** · **W8 F9** · **M1 M2** | L-units mostly parallel; C1 starts the composer lane. W5 = chat-core resilience (early). **W8 + F9 are LIVE-BUG slices pulled early** (independently shippable, could even land pre-window): W8 = chat cache-busting (bites every deploy) + cheap wins; F9 = trident conflict-resolver toolless P1 (builds fail on conflict). |
| **3** | L5 (batches) L6 · C2 → C3a → C3b → C3c → C3d · **M3 (riders)** | Composer lane strictly serial; every ABI-surface-touching C-unit carries its M3 rider. |
| **4** | C4 C5 C6 C7 C8 · D1 → D2 · D4 D5 D6 · P1 → P2 P3 · **M4** | Composer serial; substrate serial; data starts. |
| **5** | D3 D7 D8 · D9a → D9b → D9c → D9d · P4 P5 P6 P7 P8 P9 P10 P11 · **M5** · **RA1 RA2 RA3** | Engine lane serial (D9 now smaller post-K11); data parallel-ish. RA1 (data, correctness) + RA2/RA3 (substrate, gbrain live-or-loud + embeddings-on) — memory hardening, independent. RA2 carries a Managed `open-contract.ts` check if it touches `buildTenantEnv`. |
| **6** | F1–F8 · O1 → O2 O3 O4 O5 O7 O8 · **RC1** | Lifecycle + observability (F4 = wire the watchdog; depends on P7+O4). RC1 = Nexus substrate (data lane, no reader — lands ahead of its behavior). |
| **7** | X1 X2 X3 X4 **X5** · **W7** W1 W2 · O6 · **RA4 RA5** | Cores + clients (X5 = make ChannelRouter real). **W7 = chat-react stable-mount rebuild — sequence WITH/BEFORE W1** (the stable shell is the vessel W1's extracted view-model plugs into); its #354 blank-screen crash is a live P0 whose fix can pull earlier. RA4 = dead doc-search seam; RA5 = backend-neutral memory seam + depcruise guard. |
| **8** | N1 N2 N3 N4 N5 N7 N8 · **M6** | Vocabulary sweeps (post-deletion, post-split); N3 now Open-internal. |
| **9** | W3 · W4 · **W6** · N6 · S1 S2 S3 · X6 · **K10** · **RB1 RB2 RC2 RC3 RB3 RB4** | Behavior-flagged finale; K10 LAST (flips Ralph governed-mode); W4 (shell) + W6 (native bridge) may slip post-window. The R-behavior block (memory index + reflection re-splice + Nexus emitters/read + consolidation + temporal invalidation) sits behind ONE shared flag; RC2→needs RC1, RC3 ships dark with RC2; RB1/RB2 independent. |

Rough shape: **~107 units** — ~56 `opus`, ~37 `sonnet`, ~9 `haiku`, plus ~7 Managed (M)
units.

> **07-03 reconciliation (live-dogfood handoff).** Three units fold in bugs Ryan hit
> dogfooding the deployed build and decided to fix in the window rather than patch again:
> **W7** (chat-react broken mount → flicker/blank-crash/re-slide, jank report), **W8** (chat
> cheap wins incl. cache-busting), **F9** (trident conflict-resolver toolless P1 + humanized
> delivery). W8/F9 (and W7's #354 crash slice) are LIVE and independently shippable — pull
> early, or land pre-window. **Also:** the 16 PRs merged 07-02→07-03 (#178–#193) churned
> `trident/*`, `work-board/*` (new `spec-doc-service.ts`, `conflict-resolver.ts`, rewritten
> `merge.ts`), and `landing/chat-react/*` heavily (+15k LOC) — so the pre-wave-0 gate
> (re-grep every cited anchor vs `d30280c..HEAD`) matters most for the F/K/P trident units,
> the work-board coordination picture behind RC1, and the whole W-phase. Phase-0 guardrails + the kill phase are the cheapest risk-reduction per token;
the composer and (now-smaller) engine lanes are the long poles; W4 (shell) + W6 (native
bridge) are the biggest discretionary chunk (spike-gated, may defer). W5 is the one
W-unit worth pulling early — it repairs the live socket-resilience gaps for every surface
at once. The R-phase (memory/recall) hardening (RA1–RA4, RC1) folds into the refactor;
the R-behavior block (RB*/RC2/RC3) is the perfect-recall uplift, sequenced last in-window.

---

## 17. Unit checklist (tick on merge)

- [x] G1 ✅ #203 · [x] G2 ✅ #211 · [x] G3 ✅ #205 · [x] G4 ✅ #210 · [x] G5 ✅ #204 · [x] G6 ✅ #206 · [x] G7 ✅ #208 · [x] G8 ✅ #213 · [x] G9 ✅ #209 · [x] G10 ✅ #202
- [x] K1 · [x] K2 · [x] K3 · [x] K4a (K4b deferred) · [x] K5 · [ ] K6 · [ ] K7 · [x] K8 · [x] K9 · [ ] K10 · [ ] K11
- [ ] L1 · [ ] L2 · [ ] L3 · [ ] L4 · [ ] L5 · [ ] L6 · [ ] L7
- [ ] C1 · [ ] C2 · [ ] C3a · [ ] C3b · [ ] C3c · [ ] C3d · [ ] C4 · [ ] C5 · [ ] C6 · [ ] C7 · [ ] C8
- [ ] D1 · [ ] D2 · [ ] D3 · [ ] D4 · [ ] D5 · [ ] D6 · [ ] D7 · [ ] D8 · [ ] D9a · [ ] D9b · [ ] D9c · [ ] D9d
- [ ] P1 · [ ] P2 · [ ] P3 · [ ] P4 · [ ] P5 · [ ] P6 · [ ] P7 · [ ] P8 · [ ] P9 · [ ] P10 · [ ] P11
- [ ] F1 · [ ] F2 · [ ] F3 · [ ] F4 · [ ] F5 · [ ] F6 · [ ] F7 · [ ] F8 · [x] F9 ✅ #194 (pilot)
- [ ] O1 · [ ] O2 · [ ] O3 · [ ] O4 · [ ] O5 · [ ] O6 · [ ] O7 · [ ] O8
- [ ] X1 · [ ] X2 · [ ] X3 · [ ] X4 · [ ] X5 · [ ] X6
- [x] W0 ✅ (docs/specs/ux-architecture-option-d-2026-07-03.md) · [ ] W1 · [ ] W2 · [ ] W3a · [ ] W3 · [ ] W4 · [ ] W5 · [ ] W6 · [ ] W7 · [x] W8 ✅ #197
- [ ] M0 · [ ] M1 · [ ] M2 · [ ] M3 (riders) · [ ] M4 · [ ] M5 · [ ] M6
- [ ] N1 · [ ] N2 · [ ] N3 · [ ] N4 · [ ] N5 · [ ] N6 · [ ] N7 · [ ] N8
- [ ] S0 · [ ] S1 · [ ] S2 · [ ] S3
- [ ] RA1 · [ ] RA2 · [ ] RA3 · [ ] RA4 · [ ] RA5 · [ ] RC1 · [ ] RB1 · [ ] RB2 · [ ] RC2 · [ ] RC3 · [ ] RB3 · [ ] RB4
