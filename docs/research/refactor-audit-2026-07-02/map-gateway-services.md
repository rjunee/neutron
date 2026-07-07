# Subsystem map: gateway-services (gateway/ excluding http/ and realmode-composer/)

Audit date: 2026-07-02. Repo: /Users/ryan/repos/neutron-open (branch main, d30280c).
All paths below are relative to the repo root unless absolute.

---

## 1. Purpose & responsibilities

This slice of `gateway/` is nominally "the composition root + boot shell of the single Bun
gateway process": open the SQLite DB, run migrations, compose the module graph, bind the HTTP
listener, integrate with systemd (sd_notify watchdog), and shut everything down in the right
order. That part is real and well built (`gateway/index.ts`, `gateway/module-graph.ts`,
`gateway/composition.ts`, `gateway/composition/*`).

But the directory has also become the **default landing zone for every gateway-process-hosted
domain service** that never got its own workspace: per-project git versioning and backup
(`git/`), inline doc comments + agent comment watcher (`comments/`), content-addressed binary
storage (`storage/`), resumable uploads (`upload/`), Expo push (`push/`), proactive
nudges/morning brief (`proactive/`), the P6 daily nudge LLM engine (`tasks/p6/`), project
settings (`projects/`), Cores install/OAuth/integrations glue (`cores/`), and dormant
Connect-federation stores (`connect/`). ~71.5k LOC total in scope (all TS, incl. tests).

**Verdict on the focus question ("coherent layer or grab-bag?"):** it is two coherent things
plus a grab-bag. (a) boot/composition machinery — coherent, keep in gateway. (b) Cores
wiring — coherent, but belongs beside `cores/runtime`. (c) Eight domain-service directories
that are product features, not gateway concerns — each is exactly the shape of the repo's
existing ~40 workspaces (`reminders/`, `tasks/`, `watchdog/`…) and should be one.

## 2. Module inventory

Non-test line counts (`wc -l`):

### Boot / composition core (the real "gateway")
| file | LOC | role |
|---|---|---|
| `gateway/index.ts` | 603 | boot shell: DB open, migrations, composer injection seam (`NEUTRON_GRAPH_COMPOSER_MODULE`), Bun.serve bind, sd_notify watchdog, ordered shutdown |
| `gateway/boot-helpers.ts` | **1,695** | god-file: see §6.1 |
| `gateway/composition.ts` | 435 | `composeProductionGraph` + `buildComposedHttpFromComposition` (CompositionInput → http/compose.ts chain mapping) |
| `gateway/module-graph.ts` | 184 | minimal topo-sorted module loader (register/compose/get/shutdown) |
| `gateway/composition/build-core-modules.ts` | 999 | constructs the 14 `GatewayModule` objects (tools, mcp, channels, reminders, trident, cron, tasks, watchdog, telemetry, platform, cores…) |
| `gateway/composition/wire-cores-surfaces.ts` | 206 | post-compose auto-build of `/api/cores*` surfaces (mutates input in place) |
| `gateway/composition/wire-connect-overlay.ts` | 50 | post-compose `connect_api.on_inbound_message` overlay |
| `gateway/composition/message-search-wiring.ts` | 114 | button-store message-search runtime |
| `gateway/composition/input/*.ts` (12 files) | ~1,340 | `CompositionInput` split into 11 per-concern interfaces re-composed via `extends` (`composition/input/composition-input.ts:31-42`) |
| `gateway/sd-notify.ts` | 205 | systemd NOTIFY_SOCKET datagrams |
| `gateway/deployment-mode.ts` | 139 | `NEUTRON_ROLE` managed/open/connect resolution (consumed only by realmode-composer) |

### Domain services (grab-bag candidates for extraction)
| dir | LOC (src) | role |
|---|---|---|
| `gateway/git/` | 3,585 | `project-backup-store.ts` (**2,246**) 6-hourly whole-project git snapshots + push + snapshot browse/diff/restore API; `doc-version-store.ts` (1,112) per-doc-edit git commits; `project-backup-scheduler.ts` (227) one-ticker-per-gateway with jitter |
| `gateway/comments/` | 3,649 | per-project comments SQLite sidecar (`comment-store.ts` 1,193), agent LLM watcher with escalation sniffing (`agent-watcher.ts` 1,060), re-anchor walker (`anchor-walker.ts` 705), materialiser (459), `lev.ts` Levenshtein (232) |
| `gateway/upload/` | 2,327 | chunked resumable upload protocol (858), single-shot import upload (552), import resume (346), session store (231), CSRF origin guard (177), sweeper (163) |
| `gateway/cores/` | 4,404 | bundled-Cores install orchestration (`install-bundled.ts` **1,044**), Google OAuth token manager (559), integrations aggregation (485), Open-mode mount helper (`mount-open-cores.ts` 352), tasks chat router (318), calendar/email wiring (313/201), oauth pending store + sweep cron, composer-state, credential resolver, scribe fan-out seam |
| `gateway/storage/` | 1,495 | content-addressed blob store `.docs-blobs/` (1,058) + types (381) + `owner-metadata.ts` timezone reader (56) |
| `gateway/proactive/` | 1,255 | morning brief (368), idle-nudge sweep (383), cron registration (153), state store (112), button-store sink (105), timezone (90), `sink.ts` structural `OutboundSink` seam (44) |
| `gateway/push/` | ~630 | device-token store (201), Expo push client (202), dispatcher (225) |
| `gateway/projects/` | 1,069 | SQLite project-settings store (524), Managed shared-projects resolver (265, dormant in Open), default emoji (231), `enumerate.ts` (49) |
| `gateway/tasks/p6/` | 1,039 | daily nudge LLM engine (643) + prompt (176) + staleness engine (220) — note: distinct from top-level `tasks/` workspace |
| `gateway/connect/` | 405 (src) | `federated-token-store.ts` (270, live via `gateway/http/app-connect-auth.ts:49`), `syndication-relay.ts` (57, **no non-test consumer**), `open-instance-source-resolver.ts` (78, **no non-test consumer**) |
| `gateway/wow-push-emitter.ts` | 331 | wow-moment push (root-level orphan file; consumed by `onboarding/interview/engine-internals.ts:642` and `gateway/realmode-composer/build-landing-stack.ts`) |

Tests: 82 files in `gateway/__tests__/`, plus per-subdir `__tests__/` (comments, upload,
projects, proactive, composition, tasks/p6), plus 7 root-level `*.test.ts`
(boot, module-graph, sd-notify, deployment-mode, listener, deterministic-bind,
composition-landing-and-telegram), plus inline `*.test.ts` in `connect/` and `push/`.

Note: the audit brief named `spawn-fleet-agent.ts` — **no such file exists anywhere in the
repo** (verified by `find`/`grep` for `spawn-fleet`, `fleetAgent`). Closest analogue is the
trident warm-pool dispatch in `trident/` (out of scope).

## 3. Public seams / contracts other subsystems consume

1. **`boot()` / `BootHandle` / `loadGraphComposerFromEnv` / `resolveOwnerSlug`**
   (`gateway/index.ts:177,540,147`) — consumed by `open/server.ts:29-30`. The process
   lifecycle contract.
2. **`GraphComposer` env seam** (`gateway/index.ts:540-587`): `NEUTRON_GRAPH_COMPOSER_MODULE`
   dynamic-imports an arbitrary module exporting `buildGraphComposer()`. This is a
   **cross-repo deploy-config contract** — the private Managed repo's composer is loaded
   through it and imports `gateway/boot-helpers.ts` directly (per header comment
   `boot-helpers.ts:1-24`). The Open-repo composer is `open/composer.ts` (imports
   `boot-helpers`, `composition.ts`, `cores/mount-open-cores.ts`, `proactive/*`,
   `projects/*` — see `open/composer.ts:106-186`).
3. **`CompositionInput`** (`gateway/composition/input/composition-input.ts:31`) — the ~90-field
   wiring bag every composer fills; re-exported from `composition.ts:42`.
4. **`composeProductionGraph`** (`gateway/composition.ts:306`) — consumed by `open/composer.ts`
   path and directly by many `open/__tests__/*` and `gateway/__tests__/*-production-composer`
   tests.
5. **`boot-helpers.ts` export surface** (~25 exports incl. `buildCoresBackendFactories`,
   `buildChainedChatCommandFilter`, `buildMaxOAuthGateHandler`, `buildGateLandingServer`,
   `resolveRegistryDbPath`, `bindHttpListener`) — consumed by `open/composer.ts:111,130`,
   `gateway/cores/mount-open-cores.ts:44`, and (via the env seam) the private Managed
   composer. `gateway/index.ts:32-63` re-exports the whole surface for back-compat.
6. **Domain-service stores consumed by `gateway/http/` surfaces and `open/composer.ts`**:
   `DocVersionStore`, `ProjectBackupStore` (admin/backups surfaces), `CommentStore` +
   `AnchorWalker` (app-docs surface), `BinaryStore` (docs-binary), `SqliteProjectSettingsStore`
   + `resolveProjectEmoji` (`open/composer.ts:161-162`, `onboarding/wow-moment/actions/03-project-shells.ts:55`),
   upload handlers (mounted via composition fields), `FederatedTokenStore`
   (`gateway/http/app-connect-auth.ts:49`).
7. **`OutboundSink`** (`gateway/proactive/sink.ts:21`) — deliberate structural seam matching
   `trident/delivery.ts`; ChannelRouter satisfies it.
8. **`ScribeFanOut`** (`gateway/cores/scribe-fan-out.ts`) — type-only seam keeping Cores wiring
   decoupled from scribe internals.
9. **`emitWowPush`** (`gateway/wow-push-emitter.ts`) — consumed from *above* by
   `onboarding/interview/engine-internals.ts:642`.

## 4. Workspace dependencies

`gateway/package.json` declares: `@neutronai/{calendar,codegen,email-managed,google-workspace,
reminders,research,scraping,tasks}-core`, `cores-runtime`, `cores-sdk`, `gbrain-memory`,
`agent-settings`, `jose`. These are loaded almost entirely via **dynamic `import()` inside
`buildCoresBackendFactories`** (`boot-helpers.ts:916-1181`) so unused Cores stay cold.

Actual relative-import edges out of the in-scope files (deduped counts): persistence (18),
channels (15), cron (14), cores/{sdk,runtime,free} (13), trident (11), tasks (11),
gateway/http (11), **onboarding (10)**, **gateway/realmode-composer (9)**, auth (9), tools (7),
runtime (7), migrations (5), reminders (4), watchdog (3), scribe (3), mcp (2), jwt-validator
(2), connect (2), message-search (2), **open (1)**, landing (1), gbrain-memory (1),
doc-search (1), work-board (1), skill-forge (1), agent-dispatch (1), chat-core (1), core-sdk (1).

Notable individual edges:
- **Upward inversion**: `gateway/cores/mount-open-cores.ts:48` →
  `open/agent-profile-backend.ts`. The gateway layer imports the product-surface workspace
  that sits above it.
- **Sideways into the composer dir**: `gateway/tasks/p6/nudge-engine.ts:33-34`,
  `gateway/comments/agent-watcher.ts:84` (type), `gateway/composition/input/tasks-input.ts:3`
  (type), `gateway/composition/build-core-modules.ts:28`,
  `gateway/cores/mount-open-cores.ts:58` — all reach into `gateway/realmode-composer/`
  (persona/prompt/escalation/create-project/LLM-substrate helpers). Domain services depending
  on composer internals means `realmode-composer` is not just a composer; it hosts shared
  libraries (`composeSystemPrompt`, `PersonaPromptLoader`, `collectTokensToString`).
- **Downward into onboarding**: `gateway/upload/*.ts:44-50` import `InterviewEngine` (type) and
  `zip-reader` (value); `build-core-modules.ts:34-53` imports telemetry/resume-cron/
  import-running-cron/overnight. For the composition root this is expected; for the upload
  handlers it couples a transport feature to the onboarding engine's concrete type.

Inbound (who imports this scope from outside `gateway/`): `open/server.ts`, `open/composer.ts`
(~40 imports), `open/chat-topics-surface.ts`, `onboarding` (default-emoji + wow-push-emitter +
tests), `reminders/dispatcher.ts:28` (→ realmode-composer, out of scope but adjacent),
`connect/trusted-accept-handler.ts` (comment reference only), `tests/integration/*`.

## 5. Internal layering (as-built)

```
index.ts (boot shell, entry)                    ← must never be imported by the composer (TLA cycle)
  └─ composition.ts (composeProductionGraph)
       ├─ module-graph.ts (loader)
       ├─ composition/build-core-modules.ts     ← constructs modules; imports half the repo
       ├─ composition/wire-cores-surfaces.ts    ← ordered post-compose mutation #1
       ├─ composition/wire-connect-overlay.ts   ← ordered post-compose mutation #2
       └─ buildComposedHttpFromComposition      ← ordered step #3 (http/compose.ts chain)
boot-helpers.ts                                  ← shared by Open boot + Open composer + PRIVATE Managed composer
domain services (git/, comments/, storage/, upload/, push/, proactive/, tasks/p6/, projects/, cores/, connect/)
                                                 ← constructed by composers/surfaces, not by the graph
```

Only ~14 things are actual graph modules; the domain services are wired ad-hoc by whichever
composer or HTTP surface needs them. There is no rule for what becomes a module vs. a plain
store, which is why e.g. reminders/trident/tasks are modules but project-backup/comments/push
are not.

## 6. Architectural debt (ranked)

### P1-a — `boot-helpers.ts` is a god-file AND an undeclared cross-repo ABI
`gateway/boot-helpers.ts` (1,695 LOC) mixes at least 8 unrelated responsibility clusters:
1. Tasks-Core per-process deps registry (`:57-76`)
2. Registry-DB path + owner-row resolution incl. legacy `_RW` env fallback (`:108-223`)
3. Listen-port resolution + `bindHttpListener` EADDRINUSE retry (`:224-360`)
4. Core boot types (`GraphComposer`, `HttpHandler`, `ListProjectsResolver`) (`:362-455`)
5. Chat-command-filter builders for reminders/trident/calendar + chaining (`:519-717`)
6. `readPatternFromPrompts` (`:718`)
7. **`buildCoresBackendFactories`** — a ~480-line DI mega-factory dynamic-importing 9 Core
   packages (`:745-1225`), plus research-LLM substrate wrapper (`:1284-1349`)
8. Max-OAuth gate: URL resolvers + **two full inline HTML/CSS pages** + a landing-server
   wrapper (`:1350-1695`)

Severity compounded by the seam: the private Managed composer imports these helpers directly
(header `:1-24`), so **every export here is a cross-repo contract with no manifest, no version,
and no in-repo consumer to break at CI time**. In-repo grep shows `buildMaxOAuthGateHandler` /
`buildGateLandingServer` / `buildMaxOauthHandoffUrl` have zero non-test consumers — they look
dead but are (presumably) load-bearing for the Managed repo; nothing marks which exports are in
that category. A refactor that renames or relocates them passes all local tests and bricks
Managed boots.
**Sketch**: split into `gateway/boot/{ports,registry,types}.ts`, `gateway/cores/backend-factories.ts`,
`gateway/chat-filters.ts`, and move the OAuth gate pages next to `landing/`; keep
`boot-helpers.ts` as a re-export barrel annotated as the frozen Managed ABI (or better: give the
Managed seam an explicit `gateway/managed-abi.ts` with a comment-pinned export list + a test
that snapshots its export names).

### P1-b — gateway/ hosts eight product-domain services that belong in workspaces
Evidence: §2 table. `comments/`, `git/`, `storage/`, `upload/`, `push/`, `proactive/`,
`tasks/p6/`, `projects/` have no dependency on boot/composition internals (they import
persistence/channels/runtime seams) and are consumed by http surfaces and composers exactly
like real workspaces (`reminders/`, `watchdog/`) are. Meanwhile four of the subdirectory names
collide with top-level workspaces (`gateway/cores` vs `cores/`, `gateway/tasks` vs `tasks/`,
`gateway/connect` vs `connect/`, `gateway/push` vs the push concerns in `app/`), which makes
grep/navigation actively misleading (e.g. `../tasks/store.ts` vs `./tasks/p6/` inside the same
file, `boot-helpers.ts:44` vs `:78`).
**Sketch**: promote each service dir to a workspace (`@neutronai/doc-versioning`,
`@neutronai/comments`, `@neutronai/binary-store`, `@neutronai/uploads`, `@neutronai/push`,
`@neutronai/proactive`) with its existing tests; gateway keeps only boot, module-graph,
composition, cores-wiring, and the http chain. Pure file moves + import rewrites; zero behavior
change; kills the name collisions.

### P1-c — layering inversions through `open/` and `realmode-composer/`
- `gateway/cores/mount-open-cores.ts:48` imports `open/agent-profile-backend.ts` — the only
  gateway→open edge in the repo; it makes "gateway is below product surfaces" false and will
  frustrate any workspace-boundary enforcement.
- `gateway/tasks/p6/nudge-engine.ts:33-34` (value import `composeSystemPrompt`),
  `gateway/comments/agent-watcher.ts:84`, `gateway/composition/input/tasks-input.ts:3`,
  `gateway/composition/build-core-modules.ts:28`, `gateway/cores/mount-open-cores.ts:58` all
  import from `gateway/realmode-composer/` — i.e. shared prompt/persona/LLM utilities live in
  a directory whose stated identity is "the Managed production composer factory collection"
  (`realmode-composer/index.ts:1-14`).
**Sketch**: extract `composeSystemPrompt`, `PersonaPromptLoader`, `collectTokensToString`,
`escalation-loader` types into a neutral `@neutronai/prompt-compose` (or `prompts/`) leaf;
invert the `open/agent-profile-backend` edge by having `open/composer.ts` inject the backend
into `mountOpenCores` as a parameter.

### P2-a — `composition.ts` dual-list divergence (real, latent bug shape)
`buildComposedHttpFromComposition` maps 34 composition fields into the http chain
(`gateway/composition.ts:137-259`), then a **separately maintained** `hasAnyChainedSurface`
boolean re-enumerates them (`:264-295`). The lists have already diverged:
`chat_history_surface` (`:155`), `chat_topics_surface` (`:158`) and `import_resume_handler`
(`:173`) are mapped but **absent from the gate list**. A composition supplying only those
fields returns `null` and silently serves the healthz-404 default. Masked today because every
real composer also sets `landing_server`. This is exactly the class of bug ISSUE #32 (comment
`:45-66`) was fixed for.
**Sketch**: replace both the if-chain and the boolean with one declarative
`[compositionField, composeInputKey, wrap]` table; `hasAnyChainedSurface = table.some(...)`.
Behavior-identical, deletes ~160 lines, makes the next surface a one-line addition.

### P2-b — duplicated git plumbing and hand-rolled per-project mutexes
- `git/doc-version-store.ts` and `git/project-backup-store.ts` each own an identical exec
  wrapper: `execFileAsync` + `GIT_EXEC_TIMEOUT_MS = 30_000` + `git --version` probe + utf8
  stdout handling (`doc-version-store.ts:62-76,361,890-897` vs
  `project-backup-store.ts:76-100,465,1799-1805`).
- Three hand-rolled chained-promise per-project mutexes: `doc-version-store.ts:326-329`
  (`initLocks`+`commitMutexes`), `project-backup-store.ts:423` (+`:608` in-flight
  serialization), `comments/anchor-walker.ts:301-304` (which even documents "Mirrors
  DocVersionStore's withCommitLock").
**Sketch**: one `gateway/git/exec.ts` (or the promoted workspace's `lib/`) exporting
`runGit(gitDir, workTree, args, {timeout})` and one `KeyedMutex` utility. Careful: the
anchor-walker's mutex is shared with the agent-watcher cursor writes (`anchor-walker.ts:674-676`)
— keep instance-shared semantics.

### P2-c — `project-backup-store.ts` (2,246 LOC) god-class
`ProjectBackupStore` (`:410`) contains four separable clusters: (1) init/gitignore seeding +
config, (2) the `backupNow` snapshot+push pipeline with `classifyPushFailure` (`:1888`),
(3) a read-only snapshot browse API — list/preview/file/diff with output caps (`:210-275`),
(4) restore + path/sha validation (`:2024-2074`) + fs helpers (`:2014,2240`). The admin surface
only needs (3)+(4); the scheduler only needs (2).
**Sketch**: split into `backup-writer.ts`, `snapshot-reader.ts`, `restore.ts` sharing the git
exec util; `ProjectBackupStore` remains as a facade so `gateway/http/app-admin-surface.ts` and
the scheduler are untouched.

### P2-d — dormant Connect code confirms the "entangled federation" debt inside this scope
- `gateway/connect/syndication-relay.ts` and `gateway/connect/open-instance-source-resolver.ts`
  have **zero non-test importers** (repo-wide grep).
- `gateway/projects/shared-projects-resolver.ts` (265 LOC, M2.3 Managed feature reading
  identity memberships) is consumed **only by a test**
  (`gateway/__tests__/connect-auth-open-mode-production-composer.test.ts:39`).
- `federated-token-store.ts` IS live (`gateway/http/app-connect-auth.ts:49`) — don't delete.
**Sketch**: quarantine the two unconsumed modules + shared-projects-resolver behind a clearly
labelled `connect-dormant/` (or move to the top-level `connect/` workspace with the rest of the
dormant federation), so the no-functionality-change refactor doesn't have to reason about them.

### P3-a — four test-placement conventions
Root-level `*.test.ts` (7 files, e.g. `gateway/boot.test.ts`), central `gateway/__tests__/`
(82 files), per-subdir `__tests__/` (comments/upload/projects/proactive/composition/tasks-p6),
and inline sibling `.test.ts` (`connect/`, `push/`). Pick one (per-subdir `__tests__/` is the
majority pattern).

### P3-b — stale `gateway/AGENTS.md`
Still says "Implementation lands in P1; P0 ships only the empty-but-correct skeleton" and
describes only webhook/button concerns — describing a 4-file skeleton, not today's 71k LOC.
Anyone (human or agent) using it as orientation is misled.

### P3-c — dual import paths for boot helpers
`gateway/index.ts:32-63` re-exports the full `boot-helpers.ts` surface "for back-compat";
consumers split between the two paths (`open/composer.ts:111` uses `boot-helpers`,
older tests use `index.ts`). One canonical path after the P1-a split.

### P3-d — "tenant" vocabulary residue
~50 `internal_handle`/tenant-flavored references in scope, concentrated in
`boot-helpers.ts:89-223` (registry row lookup, `t-aaaaaaaa` handles) — part of the declared
repo-wide rename; nothing scope-specific beyond confirming it reaches the boot path.

## 7. Test posture

Strong by volume and by pattern. The `*-production-composer.test.ts` family
(`gateway/__tests__/`, ~30 files) pins **reachability through the real composed graph** — they
serve `graph.fetch` rather than re-rolling `composeHttpHandler`, which was made structurally
possible by ISSUE #32 (`composition.ts:45-66`). `graph-composer-env-seam.test.ts` boots a real
subprocess to pin the TLA-cycle fix. Domain services have dedicated suites (project-backup
1,312 test LOC; anchor-walker 1,299; agent-watcher 916; chunked-upload 719).

Gaps / risks:
- The `hasAnyChainedSurface` divergence (P2-a) is untested — no test supplies only a
  chat-history/chat-topics/import-resume composition.
- Nothing tests the boot-helpers export surface as a contract (the Managed-ABI risk in P1-a).
- Suite-wide: `scripts/run-tests.sh` partitions ~859 files into fresh processes for bounded
  memory; the flaky lane is PGLite-WASM (gbrain), not gateway. Gateway tests bind port 0 and
  rely on `NODE_ENV=test` auto-force listener close (`index.ts:344-359`) — removing that
  auto-force hangs `bun test` at suite end.

## 8. Load-bearing subtleties a refactor MUST NOT break

1. **Module registration order** (`composition.ts:331-348`): `replToolBridgeModule` must
   register after `mcp` (it points the persistent-REPL substrate's late-bound tool-bridge
   singleton at the graph's McpServer — `build-core-modules.ts:18-21`). Topo-sort is
   deterministic only because names are visited alphabetically (`module-graph.ts:177-180`).
2. **`cron.scheduler.start()` must run after `graph.compose()`** and is idempotent
   (`composition.ts:351-381`); its "N job(s) ticking" log line is an operator diagnostic — a
   `0 jobs` line is the designed wiring-regression alarm.
3. **Post-compose ordering triplet**: `wireCoresSurfaces` → `wireConnectOverlay` →
   `buildComposedHttpFromComposition` (`composition.ts:386-415`). Both wire-steps *mutate the
   CompositionInput in place* and caller-supplied surfaces always win; the HTTP chain must be
   built from the fully-overlaid input.
4. **Failure-cleanup ownership**: if HTTP composition throws, `composeProductionGraph` itself
   shuts the graph down before rethrowing (`composition.ts:413-426`) because `boot()`'s catch
   can't see it yet; `boot()`'s catch closes the DB (`index.ts:236-255`).
5. **Shutdown order** (`index.ts:385-458`): listener stop → `STOPPING=1` (each in its own
   try/catch — a sd_notify throw must not skip cleanup) → clear watchdog → `graph.shutdown()`
   → `shutdownAllPersistentRepls()` (ISSUES #217, the 632-orphan/19GB incident) →
   `realmode_cleanups` → `db.close()`. `realmode_cleanups` must run after graph shutdown and
   before db.close.
6. **Deterministic port bind** (`index.ts:283-289`, `boot-helpers.ts:304`): a configured port
   gets bounded EADDRINUSE retry then fails loud — never silently rebinds to a random port
   (owner's bookmarked URL is pinned). Only `port === 0` auto-selects.
7. **`resolveOwnerSlug` precedence** (`index.ts:147-157`): `<OWNER_HOME>/.url_slug` file beats
   `NEUTRON_INSTANCE_SLUG` env — the rename-orchestrator contract; inverting it re-creates the
   41-cycle crash-loop incident (`boot-helpers.ts:146-151`).
8. **boot-helpers must never import gateway/index.ts** — re-creating the entry↔composer
   top-level-await cycle deadlocks under strict ESM TLA (`boot-helpers.ts:6-20`,
   `index.ts:525-538`).
9. **`hasAnyChainedSurface` + field mapping**: adding a surface today requires touching both
   lists (`composition.ts:137-296`) — until P2-a lands, a one-list edit silently drops routes.
10. **`emitWowPush` fail-closed** on missing `user_id` — skip + warn, never fall back to
    instance-wide `pushAll` (privacy; `wow-push-emitter.ts:105-171`). Conversely,
    calendar/email briefs *intentionally* use `pushAll` (`cores/calendar-wiring.ts:256`,
    `cores/email-managed-wiring.ts:151`).
11. **Backup scheduler writes `last_attempted_at_ms` BEFORE the snapshot fires**
    (`git/project-backup-scheduler.ts` docblock) — crash-restart must not machine-gun backups;
    per-project jitter prevents IO storms; sleep/resume re-engages on next tick.
12. **Anchor-walker optimistic concurrency**: per-project chained mutex shared with the
    agent-watcher's cursor writes (`anchor-walker.ts:301-304,674-676`), `based_on_modified_at`
    stale-event filtering, and append-only events (never mutate `comment_posted`).
13. **Chunked upload high-water mark** via SQL `MAX(...)` so a retried chunk can't regress
    `bytes_received` (`upload/chunked-upload-handler.ts` header); final-chunk ZIP-magic check
    then bridge into `engine.notifyImportUpload` — same advance path as single-shot.
14. **`Bun.serve maxRequestBodySize` = import cap + 64MB slack** (`index.ts:294-302`): shrinking
    it makes Bun 413 large imports *before* any handler/log runs.
15. **`module-graph.get()` gates on the `initialised` boolean, not `composed`**
    (`module-graph.ts:129-142`) — downstream inits may read already-initialised upstream deps
    mid-compose; a side-effect module legitimately returns `undefined`.
16. **Cores install failure isolation**: per-Core failures land in a bucket surfaced via
    `/api/cores`; only >50% failure rate hard-faults boot (`cores/install-bundled.ts` header).
    Required-secret-missing intentionally shares the `manifest_invalid` bucket.
17. **`composeSystemPrompt` byte-identical-when-empty** contract (realmode-composer header) —
    the nudge engine (`tasks/p6/nudge-engine.ts:33`) relies on it for prompt-cache stability.
18. **`NODE_ENV=test` auto-force on listener stop** (`index.ts:344-359`) — behavioral asymmetry
    between test and prod shutdown that keeps `bun test` from hanging on keep-alive sockets.
19. **Legacy env fallbacks**: `NEUTRON_REGISTRY_DB_PATH_RW` (`boot-helpers.ts:107-123`) and
    `NEUTRON_DEPLOYMENT_MODE` alias for `NEUTRON_ROLE` (`deployment-mode.ts` header) keep
    already-rendered systemd units booting; removal requires fleet unit re-render first.
20. **`installBundledCores` / `wireCoresSurfaces` mutate `input` in place** and the returned
    graph exposes the same object as `.composition` (`composition.ts:80-87,428-434`) — callers
    (tests) rely on reference identity.

## 9. What the refactor should do here

1. **Freeze the Managed ABI first** (P1-a): enumerate the boot-helpers/index exports the
   private composer consumes, move them behind an explicit annotated barrel with an
   export-name snapshot test. This unblocks every other move.
2. **Promote domain services to workspaces** (P1-b): pure moves of `git/`, `comments/`,
   `storage/`, `upload/`, `push/`, `proactive/`, `tasks/p6/`, `projects/` with their tests.
   Resolves the four name collisions with top-level workspaces.
3. **Cut the inversions** (P1-c): inject `open/agent-profile-backend` into `mountOpenCores`;
   extract prompt/persona/LLM-token utilities out of `realmode-composer/` into a leaf package.
4. **Table-drive the surface mapping** (P2-a) — also fixes the existing gate-list divergence
   (verify no behavior change: today's null-return happens only when landing/telegram/etc. are
   all absent).
5. **Deduplicate git exec + keyed mutex** (P2-b), then split `ProjectBackupStore` (P2-c)
   behind a facade.
6. **Quarantine dormant Connect modules** (P2-d) rather than refactoring around them.
7. Leave `module-graph.ts`, `sd-notify.ts`, `index.ts` boot flow essentially untouched — they
   are small, heavily commented, incident-hardened, and every ordering in them is load-bearing
   (§8.1-8.8).
