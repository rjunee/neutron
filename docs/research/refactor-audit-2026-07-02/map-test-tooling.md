# Subsystem map: test-tooling (build / test / CI / install tooling)

Audit date: 2026-07-02. Repo: /Users/ryan/repos/neutron-open (branch main, d30280c).
Scope: `tests/`, `scripts/`, `.github/`, `bin/`, `bunfig.toml`, root + per-workspace tsconfigs, `package.json` workspace layout, `install.sh`, `uninstall.sh`, `neutron-service.sh`, `neutron-backup.sh`, `prompts/`.

---

## 1. Purpose & responsibilities

This subsystem is everything that decides whether the repo is *green* and gets it *running on a machine*:

1. **Test execution** — the bounded-memory partitioned runner (`scripts/run-tests.sh`) that replaces bare `bun test` for the full suite, plus the PGLite-WASM quarantine lane, plus the shared discovery helper (`scripts/lib/discover-test-files.sh`) and the hermeticity preload (`bunfig.toml` → `tests/support/scrub-substrate-env.ts`).
2. **CI gate chain** — one GitHub workflow (`.github/workflows/ci.yml`): `bun install --frozen-lockfile` → `bunx tsc --noEmit` (root config) → `bash scripts/run-tests.sh` → `bash scripts/ci/leak-gate.sh --tree .`.
3. **Purity enforcement** — `scripts/ci/leak-gate.sh` (the public subset of the private carve gate: tenant vocabulary, Managed-module structure, hosted-domain, secret files, license) with a committed allowlist and an awk prose extractor.
4. **Typecheck topology** — root `tsconfig.json` (the deploy-gate config) + `tsconfig.base.json` + ~24 per-workspace leaf tsconfigs.
5. **Install/lifecycle tooling** — `install.sh` (1,499 lines), `uninstall.sh` (615), `neutron-service.sh` (567, launchd/systemd supervisor), `neutron-backup.sh` (337, git data backup timer), `bin/neutron` (118, control CLI).
6. **Cross-package test assets** — `tests/integration/` (58 files, ~17k lines), `tests/fixtures/m2/` (synthetic ChatGPT-export zip builder), `tests/support/` (preload + router-metrics core), `tests/e2e-browser/` (manual Playwright-python walkthrough).
7. **`prompts/`** — the `@neutronai/prompts` workspace: 8 top-level lifted agent prompt `.md` files + `prompts/onboarding/*.md` + the strict `{{KEY}}` template resolver (`template.ts`, `loadPrompt`, `KNOWN_PROMPTS`).

## 2. Module inventory (wc -l)

| File | Lines | Role |
|---|---|---|
| `install.sh` | 1,499 | full installer: UI theming/spinner, clone, bun install, migrate, gbrain/codex install, Claude-auth HARD gate, service+backup wiring |
| `uninstall.sh` | 615 | teardown with running-checkout guard |
| `neutron-service.sh` | 567 | launchd/systemd supervisor (install/start/stop/status/logs/print) |
| `neutron-backup.sh` | 337 | deterministic git backup of NEUTRON_HOME + timer |
| `scripts/run-tests.sh` | 293 | partitioned bounded-memory runner + PGLite lane + coverage audit |
| `scripts/ci/leak-gate.sh` | 245 | public purity gate (Tier 2/3 + env-injected Tier 1) |
| `bin/neutron` | 118 | POSIX control CLI wrapping service/backup/doctor |
| `scripts/ci/extract-comment-prose.awk` | 81 | comment/prose extractor for Tier-2 prose rules |
| `scripts/ci/leak-gate-allowlist.txt` | 79 (27 active entries) | `<glob>:<rule-id>` exceptions |
| `scripts/ci/ci-workflow.test.ts` | 43 | text-level guard of ci.yml trigger/concurrency (#321) |
| `scripts/lib/discover-test-files.sh` | 34 | `neutron_discover_test_files` — single source of "what is the suite" |
| `tests/integration/*` | ~17,006 total | 58 cross-package integration tests (largest: `personality-name-slug-projects-flow.open.test.ts` 856) |
| `.github/workflows/ci.yml` | ~80 | the only committed workflow |
| `prompts/template.ts` + `index.ts` | ~250 | strict prompt loader (`TemplateError` on unresolved `{{KEY}}`) |

Suite size **today**: 886 discovered test files (measured by running `neutron_discover_test_files`), of which 10 match the PGLite lane. Repo-wide `*.test.ts`: 873 (gateway 206, onboarding 150, cores 81, runtime 78, app 57, tests/ 55, …).

## 3. Public seams / contracts other subsystems consume

- **`bash scripts/run-tests.sh`** — the canonical suite command; `package.json:44` maps `"test"` to it. Env contract: `NEUTRON_TEST_CHUNK_SIZE/CONCURRENCY/TIMEOUT/JOBS`, `NEUTRON_BUN_BIN`, `NEUTRON_TEST_PGLITE_*`, `NEUTRON_TEST_NO_PGLITE_LANE`, `NEUTRON_TEST_ROOT` (run-tests.sh:62-79).
- **`neutron_discover_test_files`** (`scripts/lib/discover-test-files.sh:20`) — the definition of the real test suite; injection seam `NEUTRON_TEST_DISCOVER_OVERRIDE` (:21-24).
- **`scripts/ci/leak-gate.sh [--tree <dir>]`** — exit 0 silent / 1 findings / 2 usage; exceptions ONLY via `scripts/ci/leak-gate-allowlist.txt`; Tier-1 PII injected via `LEAK_GATE_PII_DENYLIST_B64` (leak-gate.sh:186-200).
- **`bunfig.toml [test].preload`** → `tests/support/scrub-substrate-env.ts` — deletes `CLAUDE_CODE_OAUTH_TOKEN` for every `bun test` run (hermeticity contract ~48 onboarding tests rely on).
- **`tsconfig.base.json`** — strict shared compiler options (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`); root `tsconfig.json` is the CI deploy-gate config with an explicit `include` list.
- **`@neutronai/prompts`** (`prompts/index.ts`) — `loadPrompt(name, vars)` / `buildPromptVars` / `KNOWN_PROMPTS` (template.ts:139-148). Live consumers: `trident/prompts.ts:42` (forge.md/argus.md contract bodies), `trident/agent-prompts.ts:41` + `agent-dispatch/persona.ts:16` (atlas/sentinel), `scribe/extract.ts` (scribe.md), `reminders/{tick,prompt,message-shape}.ts` + `cores/free/reminders/src/smart-wrap.ts` (reminder-agent-base/patterns), `gateway/boot-helpers.ts:499` (reminder-patterns.md).
- **`bin/neutron`** → `neutron-service.sh` / `neutron-backup.sh` / `gbrain-memory/gbrain-doctor.ts`; all resolve config from `<code>/.env` via a shared minimal dotenv reader pattern (neutron-service.sh:52-63, duplicated per script).
- **install.sh test seams** — `NEUTRON_INSTALL_PRINT_AUTH`, `NEUTRON_ASSUME_NO_TTY`, `NEUTRON_GBRAIN_INSTALL_CMD`, `NEUTRON_SERVICE_OS/LAUNCHCTL/SYSTEMCTL` — consumed by `tests/integration/install-*.test.ts` and `service-gbrain-path.test.ts`.

## 4. Workspace dependencies

**In (who depends on this subsystem):** everything, operationally — CI and `bun run test` route through it. `@neutronai/prompts` is imported (code-level) by trident, agent-dispatch, scribe, reminders, gateway, cores/free/reminders, cores/free/code-gen tests.

**Out (what this subsystem imports):** the shell layer imports nothing (POSIX sh/bash, deliberately dependency-free). `tests/integration/*` imports broadly: `@neutronai/onboarding` (interview engine, history-import), gateway realmode composer, runtime substrate fakes, persistence/migrations, channels ButtonPrompt. `tests/fixtures/m2/build.ts:25` imports `@neutronai/onboarding/history-import/__tests__/zip-writer.ts` (a *test-internal* module of another workspace — an underscored seam crossing). `prompts/` imports only node:fs/path.

**Declared-but-unused:** `dependency-cruiser@17.4.3` (`package.json:57`) — no config file (`.dependency-cruiser.*` absent anywhere), no `depcruise` invocation in any script, workflow, or package.json script. Confirmed by repo-wide grep: the only hits are the devDependency line and prose in AS-BUILT docs.

## 5. Internal layering

```
.github/workflows/ci.yml            (gate chain: install → tsc → run-tests → leak-gate)
  └─ scripts/run-tests.sh           (partition + lanes + coverage audit)
       └─ scripts/lib/discover-test-files.sh   (suite definition)
       └─ bunfig.toml preload       (per-bun-test-process env scrub)
  └─ scripts/ci/leak-gate.sh        (+ allowlist + awk prose extractor)
tsconfig.json (deploy gate) ── extends ── tsconfig.base.json
  leaf tsconfigs: {gateway,runtime,cores,trident,agent-dispatch} extend ../tsconfig.json;
                  {onboarding,landing,chat-core,jwt-validator} extend ../tsconfig.base.json;
                  app extends expo/tsconfig.base; landing/chat-react is an isolated JSX leaf
install.sh ─→ neutron-service.sh / neutron-backup.sh / bin/neutron  (env-pinned .env contract)
prompts/  (data + loader; consumed upward by product packages)
```

## 6. Architectural debt (evidence + severity)

### D1 — P1: CI typechecks only what the root include list (plus transitive imports) happens to reach
`ci.yml:56` runs `bunx tsc --noEmit` against root `tsconfig.json`, whose `include` (tsconfig.json:12-41) omits these top-level TS dirs entirely: **`trident/` (53 files), `agent-dispatch/` (12), `app/` (116), `jwt-validator/` (6), `project-credentials/`, `work-board/` (8)**, plus most of `landing/` (only `server.ts`, `chat.ts`, `__tests__` — but 12 other landing/*.ts exist), `landing/chat-react/`, `tests/support`, `tests/fixtures`. Some of these are pulled in *transitively* (gateway imports work-board: `gateway/http/work-board-surface.ts`; open/composer imports trident), but that coverage is accidental: any file not on an import path from an included file — notably every `*.test.ts` in those dirs (`trident/vajra-fixes.test.ts`, `work-board/store.test.ts`, `agent-dispatch/*.test.ts`, all of `app/__tests__`) — is **never typechecked in CI**. This is the known "root tsc misses trident errors" failure mode generalized (per-leaf configs like `trident/tsconfig.json`, `landing/chat-react/tsconfig.json` exist and are clean today — I ran both, rc=0 — but nothing runs them in CI). The include list is also stale-shaped: it lists `tabs/` (not a workspace) but not `project-credentials/`.
**Sketch:** replace the hand-maintained include list with either (a) project references / a script that runs `tsc -p` for every dir owning a tsconfig, or (b) a single `include: ["**/*.ts"]` root config with explicit excludes for the two genuinely incompatible leaves (app/Expo, chat-react/JSX), each of which gets its own CI step.

### D2 — P1: no dependency-rule enforcement despite dependency-cruiser being installed
`package.json:57` carries `dependency-cruiser: 17.4.3` as a devDependency; there is **no** `.dependency-cruiser.{js,cjs,json}` and no invocation anywhere. The declared layering (edge → substrate → memory → cores → product) is enforced only by two ad-hoc mechanisms: a grep-walk test (`tests/integration/no-direct-anthropic-api.test.ts:44-70` — forbids `api.anthropic.com` in gateway/runtime/onboarding) and the shell leak-gate (vocabulary, not imports). Nothing stops `channels/` importing `onboarding/`, or a core importing gateway internals, or the documented Connect↔gateway entanglement from deepening. For the no-functionality-change refactor this is the *most valuable cheap gate to add first*: codify current-state layer rules (with a grandfather list) so refactor PRs can't silently invert layers.

### D3 — P2: the gate scripts themselves are untested, and the coverage audit has a silent-skip branch
Zero tests execute `run-tests.sh` or `leak-gate.sh` (repo grep: no `*.test.ts` references either). The discovery helper advertises an injection seam "so unit tests can drive a deterministic file list" (`discover-test-files.sh:16-18`) — **no test uses `NEUTRON_TEST_DISCOVER_OVERRIDE`**. Its header also says it is "used by both … and the deploy gate (`scripts/install/lib/flake-tolerant-test-gate.sh`)" (:5-6) — **that path does not exist in this repo** (`scripts/install/` absent; carve residue), so the "two can never drift" contract has one consumer. Inside `run-tests.sh`, the no-silent-truncation guarantee is soft on one edge: if the bun-discovery probe's count parse comes back empty, the cross-check is skipped rather than fatal (`[ -n "$BUN_DISC" ] && [ "$BUN_DISC" != "$TOTAL" ]`, run-tests.sh:135), and the PGLite lane's `ran` count falls back to `NPGLITE` when bun's count line is eaten by log noise (:186-188) — both deliberate fail-opens in an "audited, never silent" design. Also, the probe itself (`bun test -t '__neutron_runtests_no_match__'`, :133) *loads all 886 files in one process* — a bounded version of the exact single-process RSS spike the runner exists to avoid; on the contended box the audit step is the peak.
**Sketch:** add a bats/bun-spawned test suite for run-tests.sh using the OVERRIDE seam (chunking math, lane split, audit failure paths) and for leak-gate.sh (fixture tree with planted findings); make an unparseable BUN_DISC fatal or at least loudly warned; delete or re-point the flake-tolerant-gate reference.

### D4 — P2: root deploy-gate config grants `DOM` lib to all server code
`tsconfig.json:4-11` sets `"lib": ["ESNext", "DOM"]` for the entire gate (justified by one browser file, `landing/chat.ts`). Consequence: `document`, `window`, `alert`, DOM `fetch` typings etc. typecheck fine inside `gateway/`, `runtime/`, `persistence/` — a whole class of wrong-runtime errors the strict base config would otherwise catch. Leaf configs then re-fragment inconsistently: gateway/runtime/cores/trident/agent-dispatch extend the root (inheriting DOM); onboarding/landing/jwt-validator/chat-core extend base (chat-core re-adds DOM deliberately, chat-core/tsconfig.json:3-9). Two extends-roots means editor behavior differs by package and options drift is unaudited.
**Sketch:** root gate extends base with NO DOM; browser-facing leaves (landing, chat-core, chat-react, app) own their DOM/JSX libs; CI runs the leaf configs (merges with D1 fix).

### D5 — P2: three test-placement conventions, and tests/integration is a grab-bag
Tests live (a) in per-package `__tests__/`, (b) as sibling `*.test.ts` next to source (work-board/, trident/, scripts/ci/), and (c) in `tests/integration/` — 58 files, ~17k lines, mixing onboarding persona flows, import-pipeline fixtures, migration roundtrips (`migration-0025-…`, `migration-0075-…` — these belong with `migrations/`), install-script gate tests (`install-auth-gate.test.ts` — belongs with the installer), and architecture greps (`no-direct-anthropic-api.test.ts`, `router-metrics-audit.test.ts`). Discovery treats them identically (everything runs), so the cost is navigational: ownership of a behavior's tests is not predictable from its package. P2 because the refactor will move code and must decide where its tests go; codify one rule now.

### D6 — P2: install.sh is a 1,499-line multi-responsibility monolith
Function census (install.sh:152-933+) shows at least five clusters in one POSIX file: TTY theming/spinner UI (`ui_init_theme`, `_spin_frame`, `ui_reclaim_after_auth`), env/.env persistence (`dotenv_get`, `persist_env_var`, `persist_cookie_secret`), dependency installers (`ensure_bun:589`, `ensure_gbrain:640`, `ensure_codex:739`), the Claude-auth hard gate (`apply_auth_gate:883`, `ensure_claude_auth:933`), and layout migration (`migrate_flat_layout:455`). Mitigations already present: POSIX-clean, well-commented, real test seams exercised by `tests/integration/install-*.test.ts`. The dotenv reader is duplicated across install.sh, neutron-service.sh (:52-63), and neutron-backup.sh ("mirrors install.sh's dotenv_get") — three copies of parsing logic that must agree on quoting/expansion semantics. P2: split UI helpers and installers into `scripts/install/lib/*.sh` sourced files (which would also make the discover-test-files.sh comment true again).

### D7 — P3: doc/comment drift around the suite and the workflow
- `run-tests.sh:12-13` says "~859 files / ~8180 tests"; `docs/testing-runner.md:16` says "~775 files"; actual today: **886**. Hardcoded counts in three places guarantee perpetual staleness.
- `CONTRIBUTING.md:47` tells contributors `bun test # the whole suite` and `:62` "run `bunx tsc --noEmit` and `bun test` before pushing" — the exact single-process invocation the runner's 100-line header explains is the architectural flaw, and no mention of `scripts/run-tests.sh` or the leak-gate. A contributor following CONTRIBUTING will not reproduce CI.
- `prompts/AGENTS.md` still says "The lift happens in Sprint 2 — P0 ships only the empty dir" (the dir has been populated for months).
- `tests/integration/no-direct-anthropic-api.test.ts:25-27` allowlist *rationale prose* references `identity/oauth/install-token-handoff.ts` — `identity/` is a Managed path that doesn't exist in Open (the real file is `open/install-token-handoff.ts`); carve residue in comments.

### D8 — P3: repo hygiene / missing world-class basics
- Committed Python bytecode: `tests/e2e-browser/__pycache__/onboarding_walkthrough.cpython-311.pyc` is tracked in git (`git ls-files` confirms). The walkthrough itself is manual-only (nothing in ci.yml invokes it) and its docstring hardcodes a local interpreter path (`/usr/local/opt/python@3.9/...`, onboarding_walkthrough.py:27).
- No repo-wide lint/format config (no eslint/biome/prettier at root; only `app/eslint.config.js`). For 500k LOC with heavy agent-generated churn, formatting consistency is enforced by nothing.
- No bun version pin outside CI: ci.yml:47 pins `bun-version: 1.3.9` ("run-tests.sh discovery semantics"), but there is no `engines`/`packageManager` field or `.bun-version` file, so local devs can run a bun whose test discovery diverges (the fatal cross-check will catch it loudly, but as a confusing failure).
- `.github/` contains exactly one workflow; no macOS lane (launchd branches of install/service/backup scripts are only unit-tested through the `NEUTRON_SERVICE_OS` seam), no dependabot config, CodeQL evidently via GitHub default setup (referenced in ci.yml comments but not committed).

### D9 — P3: workspace layout has floating non-workspace source dirs
`package.json:5-42` lists 41 workspaces but `open/`, `tabs/`, `work-board/`, `project-credentials/` are top-level TS dirs with **no package.json**, consumed via cross-directory relative imports (e.g. `gateway/http/work-board-surface.ts` → `../../work-board/...`). They are invisible to the workspace dependency graph, to `@neutronai/*` naming, and (work-board, project-credentials) to the root tsc include (D1). Either promote them to workspaces or fold them into their owning package.

## 7. Test posture

- **Volume:** 886 discovered files / ~8k+ tests; broad and dense for the product code (gateway 206, onboarding 150 files).
- **The tooling's own coverage is inverted:** the *shell* installer/service layer is well-tested through deliberate seams (`tests/integration/install-auth-gate.test.ts` — spawns real `sh` against `NEUTRON_INSTALL_PRINT_AUTH`; `install-gbrain/-codex`, `service-gbrain-path`), and `ci.yml` has a text-level regression guard (`scripts/ci/ci-workflow.test.ts`, #321). But the two most load-bearing scripts — `run-tests.sh` and `leak-gate.sh` — have **zero** tests (D3).
- **Flake management is structural, not suppressive:** PGLite-WASM files (10 today) are content-quarantined (`grep -lEi 'pglite'`, run-tests.sh:156) into a serial lane with 2 whole-lane retries; the underlying boot mutex+retry lives in `boot-pglite-brain.ts`. Known flake root causes are documented inline with issue numbers (#78/#79/#327).
- **Untested surfaces:** the e2e browser walkthrough is manual-only; no macOS CI; `uninstall.sh` has no test references found; the leak-gate's Tier-1 PII rule always skips in public CI (env unset by design — the warning branch at leak-gate.sh:196-199 is the only signal).

## 8. Load-bearing subtleties a refactor must NOT break

1. **`grep -a` + `LC_ALL=C` in run-tests.sh (:132-133, 175-179, 186)** — chunk logs contain NUL/control bytes (gateway boot, sd_notify); without `-a` grep declares the log binary, the "across N files" count parses empty, and the coverage audit throws a FALSE fatal on a green run. Any rewrite of log parsing must preserve this.
2. **Ordering: PGLite lane runs AFTER all general chunks, serially (`--max-concurrency=1`)** (run-tests.sh:246-249) — two concurrent WASM compiles reproduce the #79 boot race. Lane membership is the literal substring `pglite` — renaming that dependency or the mention in a test file silently changes lane membership.
3. **Lane retry re-runs the WHOLE lane; general chunks have NO retry** — asymmetric by design (transient WASM flake vs. real failures). Adding generic retries would mask real regressions.
4. **`bunfig.toml [test].preload` deletes `CLAUDE_CODE_OAUTH_TOKEN`** — ~48 onboarding tests assert not-yet-attached routing and pass only because the preload runs before every `bun test` process (including every chunk the runner spawns). Moving the runner off `bun test`, or moving the preload file, breaks hermeticity silently on dev boxes with a live `.env` (scrub-substrate-env.ts rationale block).
5. **CI step order: `bun install` BEFORE `tsc`** (ci.yml:50-56) — the `@neutronai/*` workspace symlinks must exist or tsc reports phantom TS2307s.
6. **CI concurrency keyed on `github.event.pull_request.number || github.ref`** (ci.yml:33) — the old `ci-${{ github.ref }}` form let slashed branch names supersede the test job so a PR merged with only CodeQL signal (#321). `scripts/ci/ci-workflow.test.ts` pins this textually; workflow edits must keep both.
7. **bun pinned to 1.3.9 in CI because discovery semantics are mirrored** — `discover-test-files.sh` re-implements bun's node_modules + dot-dir exclusion (which keeps ~6,810 `.claude/worktrees/` clone test files out). A bun upgrade that changes discovery makes the cross-check fatal (loud, by design) — treat that failure as "update the mirror", not "loosen the check".
8. **leak-gate has NO skip flag and no env bypass** (leak-gate.sh:37-38, 55) — the only exception mechanism is the committed allowlist; it also *refuses to pass an empty scan* (:71-74). Preserve both properties in any port.
9. **`prompts/*.md` are LIVE contract bodies with fail-soft fallbacks** — `trident/prompts.ts:80-98,268-284` reads forge.md/argus.md at module load and silently degrades to a terse inline contract if the file is missing; same pattern for atlas/sentinel via `trident/agent-prompts.ts:70-93`. Moving/renaming `prompts/` would not crash anything — trident would quietly run on the degraded contract. Guards: `trident/prompts-disk-source.test.ts` asserts a verbatim on-disk line appears in the rendered prompt; `loadPrompt` resolves relative to `template.ts`'s `import.meta.url`, never cwd (template.ts:160-168), and `TemplateError` is strict on any unresolved `{{KEY}}`.
10. **`neutron` CLI resolves the checkout through its own symlink** (bin/neutron:29-44 `resolve_self`) — relocating bin/ or replacing the symlink install breaks `CODE_DIR` resolution.
11. **Parallel-mode chunk results are appended concurrently to one file** (run-tests.sh:181 `echo … >> "$WORK/results"`) — safe only because each line is a short O_APPEND write; buffered chunk logs are re-emitted in chunk order afterwards (:230-238) because downstream tooling parses that combined log.
12. **`bun test` vs the runner are BOTH supported entries** — `test:bun` script and per-file `bun test <file>` are documented workflows; the preload and discovery must keep working for bare bun invocations too.

## 9. What the refactor should do here

Priority order:
1. **Make typecheck coverage declared, not accidental (D1+D4):** every TS dir typechecked in CI via leaf configs or a full-include root; strip DOM from server code; delete the stale include list. This is the cheapest way to keep a 500k-LOC no-functionality-change refactor honest.
2. **Stand up dependency-cruiser with the declared layer rules (D2)** — or delete the dependency. An import-rule gate is the single highest-leverage guard for the whole refactor program (tenant-rename moves, Connect disentanglement, giant-file splits all change import graphs).
3. **Test the test infrastructure (D3):** spawn-tests for run-tests.sh (using the existing OVERRIDE seam) and leak-gate.sh; make the BUN_DISC empty-parse branch loud.
4. **One test-placement convention (D5)** and disperse tests/integration's package-owned tests to their packages; keep only genuinely cross-package flows there.
5. **Mechanical hygiene (D6-D9):** extract shared sh lib (dotenv reader ×3), un-commit the .pyc + add .gitignore rule, fix CONTRIBUTING to name `scripts/run-tests.sh` and the leak-gate, drop hardcoded suite counts, pin bun for devs, decide workspace status of open/tabs/work-board/project-credentials.
6. **Correct the audit's own prior:** `prompts/` is NOT dead legacy — it is the live, disk-sourced prompt library for trident/agent-dispatch/scribe/reminders/gateway with strict templating and deliberate fail-soft. The genuinely legacy piece is its provenance prose (AGENTS.md) and nothing should "wire prompts/*.md directly as system prompts" — the assembly layer (trident/prompts.ts etc.) is the contract.
