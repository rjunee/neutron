# AS_BUILT

Running log of what shipped, newest first. One entry per merged change.

## 2026-07-02 — Fable-orchestrator model routing in trident's inner workflow

**Why.** Ryan-locked doctrine (SPEC § Fable-orchestrator, Decisions Log
2026-07-02): Fable 5 (max reasoning) is the ORCHESTRATOR — it does the high-value
thinking (planning, decomposition, verdict synthesis); Opus/Sonnet are
SUBORDINATE EXECUTORS carrying out Fable's specs. There is NO "escalate to Opus".
Before this change every `agent()` in `trident/inner-workflow.mjs` inherited the
launcher-default `opus` and the Ralph planner was FUSED into `forge:build`. No
feature flags — this is the default.

**What shipped.**

- **`FABLE_MODEL = 'claude-fable-5'`** added to `runtime/models.ts` (the single
  source of truth; env override `NEUTRON_FABLE_MODEL`). Verified routable
  2026-07-02 (P-F0 smoke: a workflow `agent({model:'claude-fable-5',
  effort:'max'})` returns cleanly; `workflowProgress.model === 'claude-fable-5'`).

- **Split the fused planner out** (`inner-workflow.mjs`). A dedicated
  `plan:fable` orchestrator `agent()` (Fable, effort `max`) now runs once per
  Ralph iteration: it diffs SPEC.md vs the code, regenerates the
  IMPLEMENTATION_PLAN.md body, picks the single top task, and emits a structured
  EXECUTION SPEC (target files + acceptance criterion + test plan) plus a
  `[mechanical]|[reasoning]` complexity tag (`PLAN_SCHEMA`). `forge:build` is now
  a pure EXECUTOR that implements that one task from the spec and persists the
  plan into its worktree (the planner is read-only — a workflow's agents have
  separate cwds, so a base-branch write would never reach the PR).

- **Per-role `label → {model, effort}` map** (`ROLE_MODEL` + `modelForTag` +
  `routeModel` + `withModel`) threaded into every `agent()` opts: `plan:fable` +
  `argus:synthesis` → Fable; `forge:build`/`forge:fix-round-N` → Sonnet for
  `[mechanical]` / Opus for `[reasoning]` (bias to Opus when the tag is
  missing/ambiguous — the unknown-label default is an Opus executor, never
  Fable); `argus:claude`/`argus:adversarial` → Opus; `argus:codex` → unchanged
  (codex runtime); `checkpoint:*`/`terminal-result`/`cleanup:worktree` → fast
  (Haiku). The model IDS are resolved from `runtime/models.ts` in the launcher
  (`buildWorkflowArgs`) and threaded via `args.models` — the CC Dynamic Workflow
  script has no module resolution, so it can't import the registry and must NOT
  hard-pin an id literal.

- **Observability.** Every spawn logs `trident.agent label=<x> model=<y>
  effort=<z>` (incl. `model=codex-runtime` for the codex peer) so a run is
  tally-able: "N agents, M on Fable, K on Opus, J on Sonnet, C on Codex".

- **Test guards rewritten** (`vajra-fixes.test.ts` FIX 8 + `inner-workflow.test.ts`
  ralph-note): the 2026-06-13 export-control guard (`src` must never contain
  "fable") is REVERSED — replaced by positive assertions of the intended routing
  (plan:fable + argus:synthesis → `MODELS.fable`; forge:* by tag; argus reviewers
  → `MODELS.opus`; unknown → Opus default) + a no-hard-pinned-literal guard
  (`claude-fable-5`/`claude-opus-4-8`/`claude-sonnet-4-6` absent from the .mjs).

**Verification.** P-F0 smoke (fable routes end-to-end) + a real-substrate routing
probe exercising the byte-identical routing map across all 9 roles; the
authoritative harness dispatch record (`workflowProgress[].model`) confirmed:
plan:fable→claude-fable-5, forge[mechanical]→claude-sonnet-4-6,
forge[reasoning]→claude-opus-4-8, argus:claude/adversarial→claude-opus-4-8,
argus:synthesis→claude-fable-5, checkpoint/terminal/cleanup→claude-haiku-4-5.
Tally: Fable×2, Opus×3, Sonnet×1, Haiku×3. tsc clean; 336 trident tests green.
A full end-to-end Forge/Argus build was NOT run from the fleet session (the
`Workflow` tool inherits the session cwd, so `isolation:'worktree'` would branch
neutron, not an external scratch repo); the outer loop exercises it on deploy.

**Note.** `docs/SYSTEM-OVERVIEW.md` in the Managed repo needs a model-routing
update for the trident section — cannot be edited from here; the orchestrator
syncs it on deploy. Auto-mode (#104) is OUT OF SCOPE (separate).

## 2026-07-01 — Documents tab renders `.html` docs as static styled HTML/CSS pages

**Why.** Ryan's M1 live test: saving/opening an `.html` doc errored with
`invalid_extension: path must end with .md or .markdown (got 'timer.html')`, and
even once accepted the Documents tab had no way to render it. Ryan's revised
(deliberately small) scope: render HTML/CSS statically; complex interactive JS
apps belong in a separate app launcher, NOT the doc viewer. No feature flags —
shipped as the default.

**What shipped.**

- **Docs store/API accepts `.html`/`.htm` end-to-end.** `gateway/http/doc-store.ts`
  gains `HTML_EXTENSIONS` + `DOC_EXTENSIONS` (= markdown ∪ html) + `isDocLeaf`, the
  single allowlist behind the `invalid_extension` gate. Both the tree walker
  (surfaces `.html` leaves) and `validateRelativePath({ requireMd })` (read/list/
  open/write) now use `isDocLeaf`; the error message is derived from the allowlist.
  The duplicate history/comments/diff gate in `gateway/http/app-docs-surface.ts`
  (`assertHistoryPath`) shares `isDocLeaf` so an opened `.html` doc can also load
  its history/comments. `MARKDOWN_EXTENSIONS`/`isMarkdownLeaf` are retained
  (markdown-specific callers unaffected); `doc-search/walk.ts` keeps its own
  markdown-only constant (HTML is not FTS-indexed as markdown — out of scope).
- **Documents renderer renders `.html` as a static styled page.** New
  `landing/chat-react/HtmlDoc.tsx`: `isHtmlDoc(path)` selects the branch and
  `sanitizeHtmlDoc(raw)` parses the doc via `DOMParser` and strips every
  script-execution vector — `<script>` (incl. SVG script),
  `<iframe>`/`<object>`/`<embed>`/`<base>`/`<meta>`/`<link>`/`<frame*>`/`<applet>`,
  all `on*` handler attributes, and `javascript:`/`vbscript:`/`data:text/html`
  URLs — while PRESERVING HTML structure, `<style>` blocks (head + body), and
  inline `style`. The sanitized document's **live `<documentElement>` nodes are
  adopted** into a **Shadow-DOM island** (not an `innerHTML` string — fragment
  parsing strips `<html>`/`<body>`, which would drop `body{…}`/`html{…}` CSS +
  body attributes; Codex P2), so document-level CSS renders correctly and the
  doc's styles stay scoped to their subtree. `importNode`/`appendChild` never
  run the (already-removed) scripts. `DocumentsTab`
  Rendered view branches on `isHtmlDoc(file.path)`; `.md` renders via the existing
  Markdown path unchanged, and Source/Edit still show/edit raw text of either.
  **Design note:** chose a `DOMParser` DOM-walk sanitizer over DOMPurify because
  DOMPurify's document-reconstruction path does not run faithfully under the
  happy-dom test env (verified: it kept `<script>` and dropped `<style>`), which
  would leave the security path untested; the DOM-walk is faithful in both the
  browser and CI. Threat model is trusted single-owner content.

**Tests.** `landing/chat-react/__tests__/html-doc.test.tsx` (sanitize keeps
structure+CSS, strips scripts/handlers/js-URLs incl. an obfuscated `java\tscript:`;
component mounts into a shadow root and no doc script executes) + `.html`/`.htm`
read/list/write round-trip and `.txt`-still-rejected in
`gateway/__tests__/app-docs-surface.test.ts`. tsc (root + gateway +
`landing/chat-react`) clean; leak-gate silent; fresh `NEUTRON_HOME=/tmp/wfi`
boot on :7874 serves the bundle with the `HtmlDoc` renderer and the docs routes
wired.
## 2026-07-02 — Chat typing dots persist for the WHOLE processing window (incl. background builds)

**Why.** Ryan live-test 2026-07-01: he asked the agent to build a meditation-timer
app. Chat showed the cold-start ack ("⏳ Waking up, one moment…") then NOTHING,
while the Plan tab flashed its active-work dot — so he had no signal the agent was
still working. The typing indicator vanished the instant the ack turn settled even
though the real (long/background) build kept running. No feature flags.

**Root cause.** The chat `TypingIndicator` (`landing/chat-react/ChatApp.tsx`) rendered
ONLY on `vm.awaitingFirstToken` (`= awaitingReply && no live stream`). `awaitingReply`
clears on the first token / `agent_message` / `agent_typing end` — i.e. when the ack
turn settles — so the dots disappeared while a dispatched build continued. The
build's progress WAS surfaced to the client (the `work_board_changed` frame that
drives the Plan-tab flashing dot) but that frame was handled out-of-band of the chat
view model, so the chat never reacted to it.

**What shipped.** The typing indicator now uses the standard animated dots (unchanged
appearance) and stays visible for the full processing window: `awaitingFirstToken`
**OR** `hasActiveWork`.

- **New `ChatViewModel.hasActiveWork`** (`landing/chat-react/controller.ts`) — true
  while the active project's Work Board has an `in_progress` item. Derived from a
  dedicated `activeWorkBoardItems` cache that ONLY frames pertaining to the active
  project update (matching `project_id`, or absent → "this project"); a sibling
  project's board on the per-user app-ws topic is ignored so it can't stop the active
  dots (Codex P2). `lastWorkBoard` stays the raw last-frame cache for `WorkBoardTab`
  replay; the active cache clears on project switch.
- **`work_board_changed` now also `publish()`es the chat vm** (was board-tab-only), so
  a build starting/finishing flips the dots on/off. Everything else about the board
  stays out-of-band of chat state.
- **The gate** (`ChatApp.tsx`) is now `vm.awaitingFirstToken || vm.hasActiveWork`.
- **No false-positive at load:** the server pushes `work_board_changed` only on a
  mutation, never on connect, so `lastWorkBoard` is null until work actually happens
  this session — a lingering item from a prior session can't spin the dots on open. A
  trivial quick turn (no board mutation) behaves exactly as before. Dots stop the
  moment the item flips to `done`.

**Tests.** `controller.test.ts` — `hasActiveWork` true on `in_progress`, clears on
`done`, ignores a foreign-project board (updated the "does NOT touch chat vm" test:
board frames now republish so `hasActiveWork` can update; chat MESSAGES stay
untouched). `component.test.tsx` — full render E2E: dots stay through a background
build after the ack `agent_message`, then stop when the board item completes.

**SYSTEM-OVERVIEW.md:** none (behavior fix reusing the existing `work_board_changed`
frame — no new surface or client subscription).

## 2026-07-02 — Connect Codex is a GLOBAL admin credential (was per-project) + project override

**Why.** #167 (Part B) put the Connect-Codex UI only in the per-PROJECT Settings
tab, calling `.connect(projectId, …)`, which made it read as a project-level
setting. But Codex is the **trident cross-model reviewer credential, and trident
runs across ANY project** — so it must be a **GLOBAL** setting in the General
admin UI, not per-project (Ryan, 2026-07-02: "this is not a project-level
setting… it should be a global setting, in the general admin UI. There can be a
project-level override if necessary"). No feature flags.

**What shipped.**

- **Global connect is now the PRIMARY surface.** A new account-wide route
  `GET/POST/DELETE /api/app/codex-auth` (`gateway/http/codex-credential-surface.ts`)
  connects Codex at `scope='global'`. The **General → Admin** tab
  (`landing/chat-react/IntegrationsTab.tsx`) renders a "Codex cross-model review"
  section — paste `~/.codex/auth.json`, connection status, disconnect — alongside
  the other global integrations. `codex-credential-client.ts` gained
  `statusGlobal()` / `connectGlobal()` / `disconnectGlobal()`.
- **Store defaults to GLOBAL.** `CodexCredentialService.connect()` now defaults to
  `scope='global'` (materializes to the owner CODEX_HOME `<owner_home>/.codex`);
  validation unchanged (subscription-only, metered `OPENAI_API_KEY` rejected).
- **Per-project OVERRIDE kept, for the edge case.** The per-project Settings
  section stays but is relabelled "Codex review — project override" (clearly
  optional; the primary connect lives in General → Admin). It POSTs the existing
  `/api/app/projects/<id>/codex-auth` route, which now stores `scope='project'`
  under the REAL project id and materializes to a nested
  `codexProjectHome()` = `<owner_home>/.codex/projects/<id>` dir.
- **Resolution honors project → global → unset.** New
  `CodexCredentialService.resolveActiveCodexHome(owner, project_id)` resolves the
  effective CODEX_HOME via the #149 store resolver (project override wins, else
  global, else `null`) with self-healing re-materialization. `status()` reports the
  resolving `scope`. The trident loop threads the GLOBAL CODEX_HOME (the
  trident-wide default); the `codex_connect`/`codex_status` agent tools stay
  global-scoped (the tool context carries only the owner boundary).

**Spec-conformance (5-line diff).** SPEC§ codex-review global cred / CURRENT #167
per-project only / GAP: not global, wrong default / THIS PR: global connect in
General admin + project-override + resolver project→global / OUT-OF-SCOPE: none.

**Files.** `trident/codex-auth.ts` (`codexProjectHome` helper),
`trident/codex-credential.ts` (scope-aware connect/status/disconnect +
`resolveActiveCodexHome`), `gateway/http/codex-credential-surface.ts` (global
route + project override), `gateway/http/compose.ts` (comment),
`open/composer.ts` (comment), `landing/chat-react/IntegrationsTab.tsx` (global
UI), `landing/chat-react/SettingsTab.tsx` (override relabel),
`landing/chat-react/codex-credential-client.ts` (global methods + `scope`). Tests:
service override/resolver, surface global+override routes, client global methods,
IntegrationsTab global-connect render. tsc clean (trident/root/chat-react),
leak-gate SILENT; live boot confirms both routes mounted + auth-gated.

**Verify.** Real-component integration tests exercise connect(global) →
materialize → `codex-review.sh` exit-0 CONNECTED; override stored under the
project home; `resolveActiveCodexHome` project→global→unset; override wins;
removing an override falls back to global; `ensureMaterialized` ignores overrides.
Live server (`NEUTRON_HOME=/tmp/wfcx PORT=7871 bun run open/server.ts`) boots
clean and both `/api/app/codex-auth` + `/api/app/projects/<id>/codex-auth` return
401 (mounted + auth-gated), not 404.

**Codex cross-model review — addressed.**
- **[P1] review resolves through the store resolver (not a static path).** The
  trident orchestrator gained `resolve_codex_home?: (run) => string | null`
  (preferred over the static `codex_home`); the composer wires it to
  `CodexCredentialService.resolveActiveCodexHome(run.project_slug)` so the inner
  review's CODEX_HOME is resolved per-run through the #149 resolver (project
  override → global → unset, self-healing) rather than a raw dir. **Known
  constraint:** trident runs are instance-scoped by `project_slug` (no per-project
  id on a run — see `trident/store.ts` `TridentRun`), so a run resolves the GLOBAL
  default; a per-project override cannot select a different cred *per trident run*
  until runs carry a project id (a larger, separate change). The override
  mechanism itself (store/resolver/status/UI) is fully implemented + tested.
- **[P2] a stale/expired project override is always removable.** `status()` now
  returns `override_present` (a project-scope row exists, even expired — the
  resolver skips expired rows so `scope` would report the global fallback). The
  Settings override section shows "Remove override" whenever `override_present`,
  so an expired override that masks itself behind the global default can still be
  cleaned up.
- **[P2] Settings reflects the EFFECTIVE status after save/remove.** Both
  `connectCodex` and `disconnectCodex` now re-fetch the per-project status after
  their write (the POST/DELETE replies omit `override_present` / the global
  fallback), so the "Remove override" affordance appears right after saving and a
  removed override immediately shows the global fallback (not a hard
  "not connected").

**DECISION FOR RYAN — per-project override does NOT reach a trident RUN (by
design of trident, not this PR).** Trident runs are **instance-scoped by
`project_slug`** (the owner boundary) and carry **no per-project credential id**
(`trident/store.ts` `TridentRun`; runs are created with `project_slug` = owner,
`slug` = task slug). So `resolveActiveCodexHome(run.project_slug)` resolves the
GLOBAL default, and a per-project codex override — whose only consumer is the
instance-scoped trident reviewer — cannot change which credential a given trident
run uses. The override is fully built + tested at the store/resolver/status/UI
layer (it honors project → global → unset wherever a real project id is supplied),
the Settings copy is explicit that the trident review currently uses the global
credential, and the override takes effect for trident once builds are
project-scoped (a separate change: thread the originating project id onto the run
+ resolve with it). Ryan asked for a project override "if necessary" — flagging
that for trident specifically it is a stored preference, not yet a per-run switch.
Codex cross-model review re-raised this as the remaining item; it is an
acknowledged trident-architecture constraint, not a defect in this diff.
## 2026-07-02 — SEV1 chat project-switch: fresh per-conversation assistant-ui runtime (seamless switch, no error card, no flicker)

**Why.** M1 top-priority (Ryan, frustrated): switching projects (or cold-loading
one) frequently tripped the #162 error boundary ("This conversation hit a snag /
Try again"), and "Try again" fixed it — a transient render race, not a real
failure. Ryan: "an annoying useless error message is just as bad as a black
screen. fix the underlying problem. This should be seamless." Same root also
caused the tab-bar / input-box flicker on switch. No feature flags. The #162
keyed error boundary was NOT the fix — it only *caught* the throw; the goal was
to eliminate the underlying race so it essentially never fires.

**Root cause (verified).** The assistant-ui message primitives resolve a part by
INDEX into the runtime's live message list (`@assistant-ui/react`
`useExternalStoreRuntime`; `useClientLookup` throws `Index N out of bounds
(length: 0)`). The runtime was a SINGLE stable instance created once at the root
(`main.tsx` `useNeutronChat` → `AssistantRuntimeProvider`). On a project switch,
`controller.setProject` (`landing/chat-react/controller.ts:439`) sets `this.msgs
= []` and publishes an EMPTY list; the ExternalStore adapter handed that emptied
list to the SAME retained runtime while a stale `MessagePart` from the outgoing
project still indexed a position into it → throw mid-render → #162 boundary
trips. #162's keyed *render subtree* remount reduced but did not eliminate the
one-frame race because the RUNTIME itself was never reset per conversation — the
shared runtime shrank in place with old subscribers still attached.

**What shipped.**

- **Per-conversation runtime (root-cause fix).** Split
  `landing/chat-react/useNeutronChat.ts` into `useNeutronChatVm` (vm mirror +
  controller lifecycle — stable across the session, keyed on the controller) and
  `useChatRuntime` (builds the `ExternalStoreRuntime` from the current vm). A new
  `ConversationRuntimeHost` in `ChatApp.tsx` calls `useChatRuntime` and is mounted
  with `key={convId}` (`conversationIdOf(projectId)`), so every conversation gets
  its OWN runtime. On a switch the outgoing runtime is discarded WHOLE — never
  shrunk in place — and the incoming one starts from the already-scoped (empty →
  hydrating) list, so no part ever indexes a stale position. The provider moved
  OFF the root (`main.tsx` now renders `ProjectShell` directly with a
  `useNeutronChatVm` vm) and DOWN to wrap only the chat surface (thread +
  composer), so the TabBar + project rail above it stay mounted.
- **Atomic transition.** A genuinely empty project renders assistant-ui's
  `ThreadPrimitive.Empty` ("Send a message to begin."), never an index into `[]`.
- **Tab-bar flicker fix.** `ProjectShell.tsx` tab-resolution effect no longer
  collapses `tabs` to `[CHAT_TAB]` on every switch before re-fetching (a visible
  two-step flicker). It reconciles IN PLACE: keep the current descriptors mounted
  until the new set resolves, mark the scope in-flight (`tabsScope = null`, which
  the doc-link resolver keys off), and swap in one step — the always-present Chat
  tab (stable key) never remounts. While the fetch is in flight the still-mounted
  descriptors belong to the OUTGOING scope, so every non-Chat tab is DISABLED and
  the active tab is clamped to Chat (Codex P2): a stale button can't be clicked to
  mount a wrong-scope `TabContent` (e.g. the old project's Core iframe) mid-switch.
- **Safety net kept.** The #162 `ChatErrorBoundary` stays as a last-resort catch
  (not removed), but now essentially never fires on a normal switch/load.

**Tests.** `landing/chat-react/__tests__/chat-rail-stability.test.tsx` extended:
the laden-General → empty-project switch now also asserts the boundary card
("This conversation hit a snag") is ABSENT — proving the RUNTIME RESET prevented
the throw, not the boundary catching it. Added a rapid-switch stress test
(General → alpha → beta → empty → General → … 8 hops) asserting no index throw,
no boundary, clean empty state, and no stale-content bleed. Harnesses mirror
production wiring (no external `AssistantRuntimeProvider`; `ChatApp` self-owns the
runtime). Full `landing/chat-react` suite: 231 pass / 0 fail; `tsc -p
landing/chat-react/tsconfig.json` clean; browser bundle + live iso server
(`/chat`, lazy `/chat-react.js`) build and serve cleanly.

## 2026-07-01 — trident-parity Part B: Connect Codex (subscription auth) + agent auto-invokes trident

**Why.** Part A (#165) wired the trident cross-model reviewer (`codex-review.sh`
reads a per-owner `CODEX_HOME/auth.json`) but nothing let the owner CONNECT that
credential, and the live agent still built everything inline (no `/code`
self-routing). SPEC.md Decisions Log 2026-07-01 "Codex cross-model review
REQUIRED". No feature flags.

**What shipped.**

- **M-2 — Connect Codex (subscription auth via the admin panel).**
  `trident/codex-auth.ts` validates a pasted `~/.codex/auth.json`: SUBSCRIPTION
  auth (`tokens.access_token` + `tokens.refresh_token`) is accepted + normalized;
  a metered `OPENAI_API_KEY` (auth_mode=apikey) or a bare `sk-…` paste is REJECTED
  (never the metered path). `trident/codex-credential.ts:CodexCredentialService`
  stores it encrypted in the #149 `project_credentials` store (service `codex`,
  global scope) and MATERIALIZES it to the per-owner CODEX_HOME
  (`resolveCodexHome({ owner_home })` = `<owner_home>/.codex/auth.json`, 0600) —
  the SAME path the trident loop threads into the inner workflow
  (`build-core-modules.ts` now reads `trident.codex_home` from the composer, so
  the loop + the store can never disagree; falls back to `NEUTRON_CODEX_HOME`).
  Status = connected / expired (access-token JWT `exp` past) / not_connected.
  Surfaces: admin-panel HTTP `gateway/http/codex-credential-surface.ts`
  (`/api/app/projects/<id>/codex-auth`), the SettingsTab "Codex cross-model
  review" section (`landing/chat-react/SettingsTab.tsx` +
  `codex-credential-client.ts`), and agent-native `codex_connect` / `codex_status`
  tools (`trident/codex-credential-tool.ts`). A boot-time `ensureMaterialized`
  self-heals the on-disk file from the stored credential.
- **M-K — the agent auto-invokes trident for complex builds.** A build-routing
  complexity heuristic in the operating-doctrine fragment
  (`gateway/realmode-composer/operating-doctrine.ts:BUILD_ROUTING_DOCTRINE`,
  spliced every turn) + the `work_board_dispatch_build` tool description tell the
  live agent to self-route: SIMPLE → inline (Write/Edit); COMPLEX/multi-file/
  needs-review → `work_board_add` + `work_board_dispatch_build`, telling the owner
  why. The tool was already registered on the live agent's surface (verified by
  the prod-boot wiring test); no `/code` command, no feature flag.

**Tests.** `trident/codex-auth.test.ts`, `trident/codex-credential.test.ts` (incl.
connect → `codex-review.sh` sees exit-0 CONNECTED with a mock codex),
`trident/codex-credential-tool.test.ts`, `gateway/http/codex-credential-surface.test.ts`,
`landing/chat-react/__tests__/codex-credential-client.test.ts`, doctrine +
prod-boot-wiring assertions. tsc (root+trident+landing) clean, leak-gate silent.

## 2026-07-01 — SEV1 M1: gate projects on import completion + honest no-context projects + doc frontmatter strip

**Why.** Ryan's M1 live test hit four related onboarding defects (SPEC.md
Decisions Log 2026-07-01 "STOP M2" blockers a+b): (a) onboarding created projects
from thin chat answers WHILE the ChatGPT/Claude history import was still uploading
(e.g. at 31%), so projects were born from the wrong signal; (b) a no-context
project opened with a fabricated "here's where X stands ... active, P2" summary;
(c) its seeded `STATUS.md` even scheduled phantom "Deepen + analyze from imported
context" OVERNIGHT work (`autonomous_overnight_enabled:true`) for a project with
zero data; (d) the Documents tab rendered a doc's YAML frontmatter as a raw bold
blob. Single path, no feature flags (Ryan approved).

**What shipped.**

- **Import-gate on project creation (fix 1).** `probeInFlightImport`
  (`open/composer.ts`) now also detects an in-progress **chunked upload**
  (`upload_sessions.status='uploading'`, non-expired), not just a live
  `import_jobs` row — closing the window where a turn that settled the last
  required field mid-upload finalized BEFORE the import job existed. The post-turn
  extractor (`onboarding/interview/post-turn-extractor.ts`) drops the
  project-discovery fields (`primary_projects`, `non_work_interests`,
  `dropped_projects`) from its `phase_state` write while an import is in flight
  (import-independent `user_first_name`/`agent_personality` still land). A new
  per-turn `<import_in_flight>` preamble fragment
  (`onboarding/interview/onboarding-preamble.ts` `buildImportInFlightSteerFragment`)
  steers the live agent to skip project questions during the upload.
  `finalizeImportOnboardingIfReady` also blocks `import_upload_pending`.
- **Honest no-context opening (fix 2).** The materializer computes `has_context`
  (matched slices OR `hasRealProjectContext`); `emitProjectOpenings`
  (`gateway/realmode-composer/build-onboarding-finalize.ts`) routes a no-context
  WORK project to `buildNoContextProjectOpening` ("I don't have any context on X
  yet - tell me a bit about it, and what do you want to work on first?") instead
  of the fabricated status. Projects WITH context (and thin hobbies, via the
  kickoff's engaging questions) are unchanged.
- **Minimal no-context STATUS.md (fix 3).** `renderMinimalStatusMd`
  (`onboarding/wow-moment/project-materializer.ts`) writes clean frontmatter
  (`one_liner:""`) + one line "Created during onboarding - no context yet." with
  NO overnight opt-in, NO `## Autonomous Overnight Work` section, NO seeded task,
  and NO `docs/overnight/seed-context.md`. Context-bearing projects keep the full
  STATUS + overnight machinery.
- **Documents frontmatter strip (fix 4).** `Markdown.tsx` gains
  `stripLeadingFrontmatter` + a `stripFrontmatter` prop the Documents viewer
  (`DocumentsTab.tsx`, rendered view) passes; the leading `---\n…\n---` fence is
  hidden from the rendered body. Chat + the Source view are untouched; a bare
  `---` rule is never stripped.

**Tests.** Extractor import-gate (suppress project fields while import in flight,
persist personality; gate off with no import); minimal-vs-full STATUS.md +
`has_context`; honest-vs-real opening routing in finalize; `buildNoContext
ProjectOpening` copy; `stripLeadingFrontmatter` (fence removed, body kept, bare
rule + no-frontmatter untouched, CRLF). tsc clean, leak-gate silent, server boots
clean on a fresh QUIET install (port 7869).
## 2026-07-01 — Chat turn timeout is ACTIVITY-BASED; freezes auto-retry + get a Retry button

**Why.** Ryan live-test 2026-07-01 (frustrated): a chat turn running a long-but-active
build hard-failed at a FIXED 180s wall clock **while the agent was still working**
(`turn_failed elapsed_ms=180009 err=persistent-repl: turn timeout`), then showed a
dead-end "your AI connection may need attention in settings" message — misdiagnosing
a slow turn as a credential problem. "If the agent is still working why arbitrarily
timeout at 180s? Be smarter — look for activity, if it's not frozen keep waiting."

**What shipped (no feature flags).**
- **Inactivity watchdog replaces the fixed per-turn wall clock.**
  `runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts` no longer
  arms `setTimeout(perTurnTimeoutMs)`; it runs an interval watchdog that abandons a
  turn ONLY after `turn_timeout_ms` with NO PTY activity. `session.lastDataAt`
  advances on every byte the `claude` child writes (spinner ticks, streamed tokens,
  tool output — the `onData` handler), so an actively-working turn keeps resetting
  the idle clock and runs as long as it needs; only a genuinely frozen turn trips.
  New `DEFAULT_TURN_INACTIVITY_MS` (90s) + `DEFAULT_TURN_ABSOLUTE_CEILING_MS` (45min
  hard backstop). The liveness keepalive pushes `status` but does NOT touch
  `lastDataAt`, so an alive-but-frozen child is still detected as frozen.
- **`AgentSpec.turn_timeout_ms` repurposed** from "wall-clock budget" to "inactivity
  window"; new additive `AgentSpec.turn_absolute_ceiling_ms` (`runtime/substrate.ts`).
  The composer (`gateway/realmode-composer/build-live-agent-turn.ts`) sends a snappy
  90s idle window for warm turns and a larger 180s window for cold/onboarding turns;
  its own AbortController is now a pure 45min absolute-ceiling backstop that covers
  the cold-SPAWN phase (which runs before the substrate watchdog starts) — the cold
  path's generous window folded into the same scheme, `COLD_TURN_TIMEOUT_MS` deleted.
- **Auto-retry once + honest message + one-click Retry.** On a genuine freeze the
  composer auto-retries the turn once, silently (the substrate poisons+respawns the
  warm REPL, so the retry lands clean). If the retry also freezes, the user gets
  `TIMEOUT_BODY` ("took too long … tap Retry, or just send it again") + a persisted
  Retry button (`RETRY_TURN_VALUE`), `allow_freeform` open — NEVER the misleading
  credential text. A Retry tap re-runs on the last real user message for the topic
  (`lastUserText` in-process map; VALUE_BYTE_CAP is 37 bytes so the message can't
  ride the button value). `isFreezeTimeout` distinguishes a freeze from a real
  credential/connection fault, which keeps its own actionable `FAILURE_BODY`.

**Tests.** `persistent-repl-substrate.test.ts` — activity resets keep an active turn
alive past the idle window; a frozen turn trips at the idle window; the absolute
ceiling bounds a livelocked-but-active turn. `build-live-agent-turn-timeout-retry.test.ts`
— freeze → auto-retry (success → no bubble); retry-also-freezes → TIMEOUT_BODY + Retry
button, not the connection text; non-freeze fault → FAILURE_BODY, no retry; Retry tap
recovers + re-runs the last message; seed freeze stays silent.
`build-live-agent-turn-onboarding-scope-timeout.test.ts` — updated to the new
inactivity/ceiling spec fields.

**Files.** `runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts`,
`runtime/substrate.ts`, `gateway/realmode-composer/build-live-agent-turn.ts`,
`docs/SYSTEM-OVERVIEW.md`, + the three test files above.

## 2026-07-01 — Notes / second-brain core: REMOVED entirely

**Why.** The `notes` core (`cores/free/notes`, `@neutronai/notes`) was a
second-brain port — a per-project `notes.db` sidecar + eight `notes_*` MCP tools +
the `/note` chat command. It is made redundant by the second-brain→GBrain
rip-replace: **GBrain is now the SOLE per-owner memory store.** The notes core
was silently broken until #158 wired its tools; Ryan directed "rip it out. we
dont need notes core" (SPEC.md Decisions Log 2026-07-01). No dual path, no flag,
no leftover.

**What shipped (clean deletion).**

- **Deleted the whole `cores/free/notes/` package** (source, tests, manifest,
  UI surfaces, the per-Core migration `0001_drawers_notes_kg.sql`) and the
  notes-only test `gateway/__tests__/notes-production-composer.test.ts`. Reverts
  the effect of #158.
- **Unwired from `gateway/cores/mount-open-cores.ts`:** the `@neutronai/notes`
  import (was `:75`), the `NotesStoreResolver` construction (was `:248-250`), the
  `notesResolver`/`notesDefaultProjectId` args into `buildCoresBackendFactories`
  (was `:289-290`), and `createNotesChatCommandFilter` from the
  `buildChainedChatCommandFilter([...])` chain (was `:332`). The `/note` chat
  command no longer exists.
- **`gateway/boot-helpers.ts`:** dropped the `notesResolver` + `notesDefaultProjectId`
  interface params + destructuring and the entire `notes:` backend factory from
  `buildCoresBackendFactories`.
- **Notes drawer-browser HTTP surface** (dead plumbing only the deleted test ever
  supplied): removed `NotesDrawerBrowserHandler` + `notesDrawerBrowser` from
  `gateway/http/compose.ts`, `notes_drawer_browser_surface` from
  `gateway/composition/input/cores-input.ts` + `gateway/composition.ts`.
- **Launcher seed:** dropped the 🧠 "Notes" tile from `DEFAULT_LAUNCHER_SEED` +
  `SLUG_DISPLAY_DEFAULTS` in `gateway/http/project-launcher-store.ts`; deleted the
  orphan placeholder route `app/app/projects/[id]/notes.tsx`.
- **Dependency:** removed `cores/free/notes` from root `package.json` workspaces
  and `@neutronai/notes` from `gateway/package.json`; regenerated `bun.lock`.
- **Tests:** decremented the discovered/installed core-count sets by 1 in
  `cores-composition.test.ts` (10→9 discovered / 8→7 installed incl. paid-staging;
  the neutron-open carve boots discovered=9 installed=6) and `cores-surface.test.ts`;
  swapped the notes fixtures in `cores-tool-dispatch.test.ts`,
  `launcher-production-composer.test.ts`, `app-tabs-surface.test.ts`,
  `app-launcher-surface.test.ts`, `project-launcher-seed.test.ts`,
  `tabs/__tests__/registry.test.ts`, and the `mount-open-cores` `/note` assertion
  to surviving cores (`reminders_core` / `calendar_core` / `tasks_core`).

**Migrations (safe).** The notes core's sole migration was a **per-Core** bundled
migration inside the package (applied to a per-Core namespace DB at install), NOT
a central `migrations/` entry — the central runner ledger (0001–0096) never
referenced it, so its snapshot/runner tests stay green. It is removed with the
package. On any already-deployed DB the old `notes.*` tables are harmless orphans
(nothing in the runtime reads them). No forward drop migration was added (cheapest,
safe — the task defaulted to leaving orphan tables).

**Verify.** `tsc --noEmit` clean; the four core/launcher composition suites pass
(29/29), the four surface/tab suites pass (55/55). Fresh QUIET install boot
(`NEUTRON_HOME=/tmp/wfnotesrm bun run open/server.ts`) logs **no `core=notes` line
at all** (gone from discovery, not install_ok/failed) and `project=dev
discovered=9 installed=6 failed=3` — discovered dropped by exactly 1; no `/note`
command registered; the GBrain memory path is unaffected.

## 2026-07-01 — Chat: fix one-line message bubble rendering ~2x tall

**Why.** Ryan flagged (twice) that a single-line chat message bubble — e.g. the
one-word user message "Ryan" — rendered at roughly double the height its text
needs, top/bottom heavy. #141 reduced `.car-bubble` vertical padding (8px→5px)
and `.car-md p` line-height (1.5→1.4) but did NOT fix it, proving padding was not
the (only) cause.

**Root cause.** The USER bubble renders its body as a bare `<p class="car-text">`
(`landing/chat-react/ChatApp.tsx` `TextPart`, role=user), but **no `.car-text`
CSS rule existed** anywhere in `landing/chat-react.html` — the only global reset
is `* { box-sizing: border-box }`. So that `<p>` inherited the UA default
`margin-block: 1em` (~16px top + 16px bottom), stacking on the 5px bubble padding
→ a one-line user bubble ~2x its text height. #141 only touched `.car-bubble` and
`.car-md p` (the AGENT path, whose paragraph margins are already zeroed by
`.car-md > :first-child/:last-child`), so it never reached the user `<p>` — which
is exactly why it missed Ryan's user-message evidence.

**What shipped.**

- **`landing/chat-react.html`.** New `.car-text { margin: 0; line-height: 1.4; }`
  rule — zeroes the inherited UA `<p>` margin and matches the agent paragraph
  line-height so a single-line user message hugs its text (bubble height = 5px +
  one line + 5px).
- **`landing/chat-react/message-adapter.ts`.** New `normalizeBody()` strips the
  stray leading newlines + all trailing whitespace from a message body in
  `toThreadMessage` (the single display seam for both bubble types). Both paths
  preserve newlines (`white-space: pre-line` on the user `<p>`, `pre-wrap` on
  `.car-bubble`), so a stray trailing `\n` on a one-line message would otherwise
  render as an extra empty line. Deliberately narrow (Codex P2): leading
  horizontal whitespace is PRESERVED so a Markdown agent message opening with an
  indented code block (`"    npm test"`) still renders as code; INTERNAL blank
  lines (real multi-line messages) are untouched.

**Tests.** `landing/chat-react/__tests__/message-adapter.test.ts` — trailing/
leading-newline strip on user + agent bodies, whitespace-only → empty, and a
`normalizeBody` unit block asserting internal blank lines survive. tsc (leaf
`landing/chat-react/tsconfig.json`) clean; leak-gate silent. Verified on a fresh
quiet boot: the served `/chat` HTML carries the new `.car-text` rule and the
lazily-bundled `chat-react.js` compiles the normalization in.

## 2026-07-01 — Notes Core: wire the four S1 tools (drawer/search/traverse) — ISSUE #330

**Why.** The `notes` manifest declares eight MCP tools, but the install pipeline
only ever invoked `buildTools` (the legacy four: `notes_write/recall/list/link`).
The four Notes-Core-S1 tools (`notes_create_drawer`, `notes_drawer_list`,
`notes_search`, `notes_traverse`) were fully implemented in `buildNotesMcpTools`
against a real per-project `NotesStore` backend — but the barrel never exported a
`buildExtraTools`, so on EVERY owner install those four fell through to
`not_implemented` stubs and boot logged `tool_registration_failed core=notes
code=manifest_tool_unimplemented` four times. NOT vestigial: the store, FTS
search, and KG traverse all exist and are tested; only the install-time wiring
was missing.

**What shipped.**

- **`cores/free/notes/src/mcp-tools.ts`.** New `buildExtraTools(deps)` — a thin
  factory over the existing `buildNotesMcpTools`, mirroring the Research/Calendar
  Core split. `NotesExtraToolDeps` = `{ manifest, project_slug, audit, resolver }`.
- **`cores/free/notes/index.ts`.** Barrel now exports `buildExtraTools` +
  `NotesExtraToolDeps` so `registerCoreTools` discovers the second factory.
- **`gateway/boot-helpers.ts`.** The `notes` backend factory now returns
  `{ backend, resolver }` (was `{ backend }` only). `normalizeBackend` returns the
  object verbatim because `backend` is present, so BOTH the legacy backend
  (consumed by `buildTools`) and the resolver (consumed by `buildExtraTools`) land
  in the one `deps` bundle both factories receive. The four S1 tools take an
  explicit `project_id` per call, so cross-project scope is impossible by
  construction.
- **`cores/free/notes/__tests__/mcp-tools.test.ts`** (new). Asserts
  `buildExtraTools` returns all four handlers, and exercises create_drawer →
  drawer_list, FTS search, KG traverse over a user tunnel, and per-project
  isolation.

**Verified.** Fresh QUIET owner boot (`NEUTRON_HOME=/tmp/wfnotes`): the four
`tool_registration_failed core=notes` lines are GONE; `install_ok core=notes`
stands with all eight tools dispatchable. `discovered=10 installed=7 failed=3` is
unchanged — notes was always `install_ok` (its legacy four registered fine); the
fix eliminates the four per-tool registration failures WITHIN that install. The
remaining `failed=3` are the expected OAuth-not-connected calendar/email/workspace
Cores. The benign `tasks_core tasks_pick_next extra_tool_name_collision` warning
is untouched (buildTools wins; harmless — Tasks intentionally registers that tool
in both factories). tsc clean (notes + gateway), notes suite 66→72 tests green.

## 2026-07-01 — Archived projects: reversible archive via Settings/chat + global Admin restore

**Why.** Projects had soft-delete only (`deleted_at`, migration 0053) — hidden
from every surface with no user-facing way back. The M2 cutover needs a
reversible "put this away for now": Ryan's 22 archived projects migrate as an
archive state that stays visible + restorable. This adds a first-class ARCHIVE
lifecycle distinct from delete (Ryan Q3, M2 Decisions Log).

**What shipped.**

- **Migration 0095 (`archived_at`).** A nullable ISO-8601 column on the STRICT
  `projects` table (plain `ALTER TABLE ADD COLUMN`, mirroring 0093/0094).
  `NULL` = active (in the rail); set = archived. Orthogonal to `deleted_at` —
  the rail + the archived list both additionally require `deleted_at IS NULL`, so
  a soft-delete always wins. `migrations/expected-schema.txt` regenerated;
  `runner.test.ts` asserts the column lands.
- **Store (`gateway/projects/sqlite-store.ts`).** `list()` (the rail) and
  `readRow()` (settings GET/PATCH) now filter `archived_at IS NULL` alongside
  `deleted_at`. New methods `archive` / `restore` (idempotent; a probe restricted
  to `deleted_at IS NULL` so a deleted project is never archived/restored) +
  `listArchived` (the Admin restorable list, newest-archived-first, emoji
  resolved). Mirrored on `InMemoryProjectSettingsStore`.
- **HTTP (`gateway/http/app-projects-surface.ts`).** `POST
  /api/app/projects/<id>/archive`, `POST .../restore`, and `GET
  /api/app/projects/archived` — all app-ws-bearer-gated. Archive/restore fan a
  `projects_changed` (via the existing `onRailFieldChanged`) so connected rails
  update live; unknown/deleted id → 404. The `/archived` route is an exact path,
  so it can never collide with a project whose id is literally "archived".
- **Settings tab (`landing/chat-react/SettingsTab.tsx`).** An "Archive project"
  action in the Project section with a two-step confirm; on success the project
  leaves the rail and the section shows the archived notice.
- **Admin tab (`landing/chat-react/IntegrationsTab.tsx`).** A new "Archived
  projects" section listing archived projects with a per-row **Restore** button
  (POSTs `/restore`, drops the row, rail picks it back up live).
- **Chat / agent-native (`cores/free/agent-settings`).** New `archive_project` /
  `restore_project` tools (capability-gated, Telegram-confirmed, topic closed on
  archive) so "archive this project" / "restore the Foo project" work in chat.
  `findLiveByName` + `list_projects` now exclude archived rows; a new
  `findArchivedByName` resolves the restore target. System-prompt fragment +
  manifest + TOOL_NAMES updated (nine → eleven tools).

**Tests.** Store archive/restore/listArchived + idempotency + soft-delete guard;
HTTP archive→hide→list-archived→restore round-trip + 404 + method guards; agent
tool archive/restore + list exclusion + honest-failure; React Settings archive
flow + Admin restore/empty-state; migration snapshot + column assertion.

## 2026-07-01 — Project rail redesign: per-project emoji, activity-reorder, unread badge

**Why.** The left project rail (`landing/chat-react` + the mobile `app/` project
list) was a flat list of plain text buttons in a fixed order with no signal of
which project had new activity. Ryan asked for a materially upgraded rail:
per-project emoji, most-recent-activity-first ordering (an active project pops to
the top), and a Telegram-style unread count badge — in BOTH the light + dark
themes from the #153 toggle, with NO feature flag.

**Framing.** ONE code path, theme-var-driven (no hardcoded colours), no flag.
Emoji + activity are real columns on the canonical `projects` table; unread is
computed HONESTLY from the existing chat-log read cursor (never a fabricated
badge).

**Schema (migrations 0093 + 0094).** Two nullable `TEXT` columns added to the
STRICT `projects` table via plain `ALTER TABLE ... ADD COLUMN` (mirrors 0088):
- `emoji` — the per-project rail glyph. NULL on legacy rows; the serve-time path
  resolves NULL to a deterministic default from the name, so the rail always
  shows a glyph. New rows persist a concrete default at create/materialize time.
- `last_activity_at` — ISO activity sort key; stamped at create (= created_at)
  and bumped to now on each message fan to the project's topic.
`migrations/runner.test.ts` applied-versions array + `expected-schema.txt`
snapshot regenerated.

**Default emoji (`gateway/projects/default-emoji.ts`, NEW).** Pure, deterministic
picker: a keyword table maps common project themes to a glyph (fitness→🏋️,
read→📚, code→💻, budget→💰, …); an un-keyworded name falls back to a stable
FNV-1a hash over a neutral palette. `resolveProjectEmoji(stored, name)` prefers an
explicit emoji, else the default. `normaliseEmojiInput` bounds + validates a
user-supplied emoji (short, non-ASCII). `GENERAL_EMOJI` (💬) for the General scope.

**Server.**
- `gateway/http/app-projects-surface.ts` — `ProjectSettings` gains `emoji`; the
  list rows gain `last_activity_at` + `unread_count` (new `ProjectListEntry`
  type); PATCH whitelist adds `emoji` with validation (`invalid_emoji`);
  `buildDefaultSettings` + the shared-item projection carry a default emoji.
- `gateway/projects/sqlite-store.ts` — `list()` orders by
  `COALESCE(last_activity_at, updated_at) DESC`, resolves emoji, and computes
  per-project `unread_count` = agent messages on the project topic
  (`app:<user>:<project>`) beyond the owner's highest READ receipt seq
  (`app_chat_messages` ⋈ `app_chat_receipts`; best-effort → 0). New
  `touchActivity(project_id)` stamps the activity key; emoji is written only when
  explicitly patched (so a name edit never freezes a resolved default).
- `open/composer.ts` — `readProjectRows()` (page bootstrap + `projects_changed`
  frame) now serializes `emoji` + `unread` + `last_activity_at`, ordered by
  activity; an agent reply on a PROJECT topic stamps `last_activity_at` and
  re-fans `projects_changed` so connected rails reorder + re-badge live.
- `channels/adapters/app-ws/envelope.ts` — `AppWsOutboundProjectsChanged` per-item
  shape extended with `emoji` / `unread` / `last_activity_at`.
- A settings PATCH that changes a RAIL-VISIBLE field (name or emoji) fans a fresh
  `projects_changed` via the surface's new `onRailFieldChanged` hook (bound to the
  composer's `emitProjectsChangedNow`), so the rail re-renders the glyph/label live
  with no reload — this also fixes the pre-existing "rename doesn't refresh the
  rail" staleness (Codex r1 P2).
- Materialize + create-project INSERTs (`onboarding/wow-moment/actions/
  03-project-shells.ts`, `gateway/realmode-composer/project-create.ts`) stamp a
  default emoji + `last_activity_at`.

**Web client.** `config.ts` `ProjectTab` gains optional `emoji`/`unread`/
`last_activity_at`; `controller.ts` parses them off the frame (unread clamped ≥0).
`ChatApp.tsx` `TopicRail` redesigned: a shared `RailItem` (emoji "avatar" chip ·
label · unread pill); the ACTIVE project's badge is locally zeroed (you're viewing
it). `chat-react.html` rail CSS reworked — emoji chip, accent-lit active row,
bolder unread rows, count pill — entirely `var(--…)`-driven so it reskins with the
light/dark toggle. `SettingsTab.tsx` — the disabled emoji SEAM is now a real
editable control (PATCH `{ emoji }`, like the name rename).

**Mobile (`app/`).** Project list wired for parity: `ProjectListItem`/`Project`
carry `emoji` + `unread_count` + real `last_activity_ms` (parsed from
`last_activity_at`, replacing the fake now-stamp); `ProjectCard` renders the emoji
+ an unread badge; the list sorts most-recent-activity-first; the settings emoji
SEAM becomes an editable field (PATCH `{ emoji }`).

**Unread semantics.** Honest + best-effort. Unread only counts agent messages
beyond the read cursor; a caught-up project reads 0. The active project shows no
badge (viewing = read). No fake counts (the existing `chat-topics-surface`
no-fake-unread contract is untouched — this feature computes real values for the
rail only).

**Follow-up (noted, out of sprint scope).** Agent-native emoji edit — the
`agent-settings` Core exposes `rename_project` but not yet a `set_project_emoji`
tool. The HTTP PATCH surface + mobile client already accept `emoji`; adding a 10th
tool to that Core's manifest/capability-guard/test contract is deferred to a
follow-up so this sprint stays focused on the rail. Per-project unread on the
General scope is also not badged (onboarding lives there; low value).
## 2026-07-01 — Reminders: faithful cron cadence (Vajra parity)

**Why.** Neutron's reminder store only understood COARSE recurrence
(`weekly` / `monthly` / `occasional`, fixed +7d/+30d/+14d deltas). The M2
cutover must migrate ~66 real cron reminders (`0 9 * * *`, `0 9 7 2 *`,
`0 */6 * * *`, `0 14 1 1,4,7,10 *`, …) FAITHFULLY, which those coarse labels
cannot represent. This brings the store + tick loop to full 5-field cron
parity. The SMART / context-aware side (literal / smart-wrap / pattern-template
composition at fire time) was ALREADY at parity in `reminders/message-shape.ts`
+ `dispatcher.ts` — cron rows flow through that unchanged, so a migrated smart
reminder still composes a fresh context-aware message at fire.

**Framing — extend the ONE path, no flags, no dual system.** A reminder recurs
when EITHER cadence column is set; the tick loop's single `computeNextFire`
resolves the next instant from whichever is populated. No parallel scheduler,
no feature flag.

**What changed.**
- `cron/cron-standard.ts` (NEW) — standard 5-field crontab evaluator
  (`parseCron` / `isValidCron` / `nextCronFire`). Full grammar: `*`, single
  values, ranges, comma lists, and steps; month + weekday names; `0`/`7`
  both Sunday; Vixie day-of-month/day-of-week OR semantics. Wall-clock math is
  DST-correct and reuses `calendar.ts`'s `wallClockToEpoch` / `zonedParts`; a
  spring-forward gap time is skipped to the next valid instant. No `Date.now()`
  inside — the caller passes the reference instant (deterministic + testable).
  Kept SEPARATE from the systemd-`OnCalendar` parser (`calendar.ts`) because the
  two grammars differ in field order, wildcard spelling, and dom/dow combination
  (systemd ANDs; crontab ORs).
- `migrations/0093_reminders_recurrence_spec.sql` (NEW) — `ALTER TABLE reminders
  ADD COLUMN recurrence_spec TEXT` (nullable; forward-only; no CHECK — the
  write-side `isValidCron` gate is authoritative). Snapshot regenerated.
- `reminders/store.ts` — `Reminder.recurrence_spec`; `createRecurring` accepts a
  coarse `recurrence` label OR a `recurrence_spec` cron (exactly-one invariant
  enforced). New exported `isRecurring()` predicate; the claim/advance guards
  (`advanceRecurrence` / `revertRecurrenceAdvance`) now recognise a row as
  recurring when EITHER column is set.
- `reminders/tick.ts` — the two next-fire branches collapse into one
  `computeNextFire(reminder, now, tz)`: cron spec → DST-correct wall-clock
  instant strictly after now (via `@neutronai/cron`); coarse label → the
  existing fixed-delta (unchanged). New `time_zone` option (default host zone).
  A corrupt cron that can never compute fires once then retires so it can't
  wedge the tick loop.
- `cores/free/reminders/src/backend.ts` + `package.json` manifest —
  `reminders_create` accepts an optional `recurrence_spec` (validated via
  `isValidCron`; mutually exclusive with `recurrence`). `snooze` / `update`
  preserve a cron reminder's cadence (no silent degrade to one-shot). Existing
  coarse-label + one-shot callers unchanged (back-compat).

**Tests.** `cron/cron-standard.test.ts` (grammar, next-fire across daily /
hourly / weekday / monthly / annual / quarterly, Vixie OR, DST spring-forward +
fall-back + gap-skip); `reminders/tick.test.ts` (cron advances to the next
wall-clock occurrence, rolls to tomorrow when past, poison-cron retires);
`reminders/store.test.ts` (column round-trip + exactly-one invariant);
`cores/free/reminders/__tests__/tools.test.ts` (cron create, invalid-cron
reject, both-cadences reject, snooze/update cadence preservation). Full suite +
root `tsc` + leak-gate green.

## 2026-07-01 — Light/dark theme toggle for the web chat UI

**Why.** The web chat (`landing/chat-react`) shipped dark-only. Ryan asked for a
light/dark toggle: default to the OS setting, allow an explicit override, persist
the choice, and make LIGHT mode an iMessage-on-iPhone look.

**Framing — a user preference, NOT a feature flag.** ONE stylesheet, themed via
CSS variables. No `NEUTRON_*` env, no `?client=`-style branch, no dual code path.
The whole UI reskins by flipping a single `data-theme` attribute on the document
root.

**What changed.**
- `landing/chat-react/theme.ts` (NEW) — the pure, DOM-free source of truth for
  resolution + persistence. `ThemePreference = 'light' | 'dark' | 'system'`;
  `resolveTheme(pref, systemPrefersLight)` (explicit override wins; `system` /
  unrecognized follows `prefers-color-scheme`); `read/writeStoredPreference`
  (localStorage key `neutron-theme`, safe when storage throws);
  `cyclePreference` (system → light → dark); `applyResolvedTheme` (writes
  `data-theme`). Default preference is `system`.
- `landing/chat-react/useTheme.ts` (NEW) — the React binding: initializes from
  storage, resolves against the live system signal, writes `data-theme` on the
  root, persists on change, and subscribes to `prefers-color-scheme` ONLY while
  the preference is `system`.
- `landing/chat-react/ThemeToggle.tsx` (NEW) — the top-right control. A single
  pill button that cycles the preference; the glyph shows the RESOLVED theme
  (☀/☾) with an "Auto" marker while following the OS.
- `landing/chat-react/ProjectShell.tsx` — wraps the tab bar + toggle in a new
  `.car-topbar` flex row so the toggle is pinned top-right of the content pane
  (owns the whole UI's theme, so it lives at the shell root).
- `landing/chat-react.html` — (1) the `<style>` block is now FULLY
  variable-driven: the dark `:root` set gained semantic vars for every
  previously-hardcoded color (hover/active tints, code bg, banners, import
  status, overlays, on-accent text, error/warn/info/success), and a new
  `:root[data-theme="light"]` set overrides them with the iMessage light palette
  (`#ffffff` surface, `#007aff` user bubble, `#e9e9eb` agent bubble, `#1c1c1e`
  text, iOS separators) — audited so there are NO dark-only leftovers; (2) a
  pre-paint inline `<script>` reads `neutron-theme` + `prefers-color-scheme` and
  sets `data-theme` (+ the `theme-color` meta) BEFORE the stylesheet paints, so
  a light user never sees a dark flash; (3) `.car-topbar` + `.car-theme-toggle`
  styles.
- `landing/chat-react/__tests__/theme.test.ts` (NEW) — the theme-resolution unit
  test (system vs. explicit override vs. persisted; storage fallbacks; cycle
  order). `theme-toggle.test.tsx` (NEW) — happy-dom wiring test: the toggle
  mounts, reflects the initial preference, and clicking it flips `data-theme` +
  persists to localStorage; a persisted override wins over the OS on mount.

**Verification.** `bunx tsc -p landing/chat-react/tsconfig.json` clean; full
`landing/chat-react/__tests__` suite green (193 + 16 new); the browser bundle
(`bun build landing/chat-react/main.tsx`) builds with the theme code wired in;
`scripts/ci/leak-gate.sh` SILENT; visual check of both themes off the real
stylesheet (light = iMessage, dark unchanged, toggle top-right, no leftovers).

## 2026-07-01 — Auto-navigate to the personal-URL claim page at onboarding-end (Managed overlay)

**Why.** The Managed personal-URL claim flow (control-plane `GET/POST /claim` →
rename → 302 to the owner's personal chat URL; neutron-managed personal-URL claim
flow, merged + deployed) serves the claim page but nothing sent the owner there
when onboarding finished. This is the paired Open-side trigger: when onboarding
completes, send the browser to the configured claim URL.

**Framing — Managed-overlay CONFIG, not a feature flag.** ONE code path
(redirect-if-URL-present). On a Managed install the env
`NEUTRON_POST_ONBOARDING_CLAIM_URL` points at the control-plane `/claim`, so the
client redirects there; on Open self-host the env is absent, the client sees
`undefined`, and the redirect no-ops (onboarding completes normally). No on/off
boolean, no dual path.

**What changed (NO flags, NO dual paths).**
- `channels/adapters/app-ws/envelope.ts` — new outbound frame
  `AppWsOutboundOnboardingCompleted` (`type: 'onboarding_completed'`, payload-free
  signal) added to the `AppWsOutbound` union. The redirect *target* is NOT on the
  frame — it lives in the client bootstrap config (a Managed-overlay concern).
- `gateway/realmode-composer/build-onboarding-finalize.ts` — new optional dep
  `emitOnboardingCompleted?(user_id)`, called at the terminal `completed`
  transition (step 5b, right after `emitProjectsChanged`, before the closing
  message so a slow opening compose can't delay the redirect). The finalizer's
  idempotency gate guarantees it fires **exactly once** per owner.
- `open/composer.ts` — (1) `fanOnboardingCompleted(user_id)` fans the frame to the
  base topic AND every live per-project topic (same topology as
  `fanProjectsChanged`) and is wired into `buildOnboardingFinalize`; (2)
  `claimBootstrapScript()` injects `window.__neutron_post_onboarding_claim_url`
  into the served `/chat` React shell **only when** the env is set (`<`-escaped),
  alongside the existing projects/onboarding bootstrap scripts; (3) **reconnect
  recovery** — `on_session_open`'s steady-state branch replays the
  `onboarding_completed` frame to the connecting topic for an already-completed
  owner when the claim URL is configured. Without this, a finalize that fires
  with no live socket (e.g. a background import-completion watcher finalizes
  while the tab is closed) would drop the only signal and the reconnect — seeing
  an already-`completed` row — would never re-emit it, losing the redirect
  (Codex P2). Gated on the env so it is a strict no-op on Open self-host; the
  client latch keeps it at-most-once and it stops once the owner claims (they
  move to a host without the env).
- `landing/chat-react/config.ts` — `BootstrapConfig.postOnboardingClaimUrl` +
  `WindowLike.__neutron_post_onboarding_claim_url`; `resolveBootstrapConfig` reads
  the injected global (non-empty string only; empty ⇒ treated as absent).
- `landing/chat-react/controller.ts` — new options `postOnboardingClaimUrl` +
  injectable `navigate` (defaults to `window.location.assign`). On the
  `onboarding_completed` frame, IF a claim URL is configured it navigates there
  (once — a `claimRedirected` latch guards a re-sent frame); else no-op.
- `landing/chat-react/main.tsx` — passes `config.postOnboardingClaimUrl` through
  (spread-only when present, so Open self-host stays undefined).

**Tests / evidence.**
- `landing/chat-react/__tests__/controller.test.ts` — redirect fires to the
  configured URL on `onboarding_completed` (Managed); no-op + session stays open
  when unset (Open self-host); at-most-once on a re-sent frame.
- `landing/chat-react/__tests__/config.test.ts` — `postOnboardingClaimUrl`
  undefined by default, read when injected, empty treated as absent.
- `gateway/realmode-composer/__tests__/build-onboarding-finalize.test.ts` —
  `emitOnboardingCompleted` fires once at the terminal transition and is NOT
  re-emitted on an idempotent re-finalize.
- `open/__tests__/open-claim-redirect-bootstrap.test.ts` — the served `/chat`
  shell injects the claim script when the env is set and injects NOTHING when
  unset (no-regression), driven through the composed graph `fetch`.
- `open/__tests__/open-claim-redirect-reconnect.test.ts` — a live `/ws/app/chat`
  connect for a completed owner replays `onboarding_completed` when the claim URL
  is configured, and emits NOTHING when unset (Codex-P2 recovery).
- `tsc` clean (root + `landing/chat-react`); leak-gate SILENT.

## 2026-07-01 — DROP the agent-NAME step in onboarding (personality-only → SOUL.md)

**Why.** Neutron Open is an agent ORCHESTRATOR, not a named personal agent. Ryan:
*"we can remove the idea of selecting a name … in neutron open lets drop the name
entirely, just ask about personality to setup SOUL.md."* Onboarding used to force
a "name your assistant" step (step-5 preamble ask + a hard-required `agent_name`
field + a name-suggestion button block) that gated finalize.

**What changed (Path-1 live-session; NO flags, NO dual paths).**
- `onboarding/interview/required-fields-audit.ts` — `agent_name` removed from
  `RequiredField` / `PRIORITY` / `isFilled`. Now **4** required fields
  (`user_first_name`, `primary_projects` ≥3, `non_work_interests` ≥1,
  `agent_personality`); `next_to_collect` goes null — and finalize fires — once
  personality settles. `agent_name` is KEPT on the `RequiredFieldsState` shape
  (the legacy engine + its `llm-router` still amend it) but is never audited.
- `onboarding/interview/onboarding-preamble.ts` — deleted the step-5 "a name for
  you" ask + custom-name-acceptance copy; added an explicit "Do NOT ask them to
  name you" instruction. `buildOnboardingStepGuardFragment` lost its `needsName`
  half: personality is the ONLY button-driven required step; the guard returns
  null once it settles.
- `onboarding/interview/button-backed-answer.ts` — the deterministic capture now
  settles only `agent_personality` (name branch + name-only helpers removed).
- `onboarding/interview/post-turn-extractor.ts` — no longer solicits (LLM prompt)
  or persists `agent_name`.
- `open/composer.ts` — stopped building + wiring the `agentNameSuggester` into
  onboarding. **`agent-name-suggester.ts` MODULE stays in the tree** (Managed
  repurposes it later); the legacy engine's `agent_name_chosen` phase is untouched.

**Personality → SOUL.md verified intact.** `onboarding/persona-gen/soul.ts`
already renders SOUL.md from personality alone — `composeOpenerSentence` falls
back to "You are a personal agent." when no `agent_name` is present — so dropping
the name does not affect SOUL.md generation.

**Tests / evidence.** Updated `required-fields-audit.test.ts` (4-field contract +
explicit "missing agent_name never gates finalize"), `button-backed-answer.test.ts`
(personality-only; a name-suggestion block settles nothing), `onboarding-preamble.test.ts`
(guard never emits a NAME step; preamble never asks a name), `post-turn-extractor.test.ts`
(extractor never persists `agent_name`). Full `onboarding/` suite green
(1602 pass / 0 fail), `open/` suite green (125 pass / 0 fail), root `tsc --noEmit`
clean, leak-gate SILENT.

## 2026-06-30 — Create Project rail refresh reaches a project-scoped socket (not just General)

**Bug.** #132's "Create Project" fan emitted its `projects_changed` app-ws frame
only to the user-scoped General topic `app:<user>`. The served web client opens
ONE socket scoped to the project it is viewing (`app:<user>:<project>`), so
creating a project **from inside a project** never refreshed the left rail until
a page reload. Onboarding was unaffected because it runs on the General topic.

**Fix.** `open/composer.ts` adds `fanProjectsChanged(user_id, frame)` — fans the
rail-refresh frame to the base topic AND every live per-project topic for the
user (enumerated via `appWsRegistry.topics()` with the `app:<user>:` prefix).
Both `emitProjectsChangedNow` (the create-project HTTP endpoint + the
`create_project` agent tool, via the shared `createProjectAndRefresh`) and
`emitProjectsChangedIfChanged` (onboarding) route through it. Each web socket is
on exactly one topic so there is no double-delivery; the frame carries the full
`readProjectRows()` list (`deleted_at IS NULL`) so it always includes the new
project. No flags.

**Tests.** `open/__tests__/open-projects-changed-wiring.test.ts` adds an e2e test
that opens both a project-scoped socket and a General socket, drives the real
`POST /api/app/projects`, and asserts the new project reaches both live.
Confirmed red before the fix, green after; leak-gate silent; `tsc` clean.
## 2026-06-30 — Onboarding live-path: deterministic name/personality capture (no double-ask) + single closing

**P1 — two live-path bugs from Ryan's deployed-onboarding test.** Both fixed inside
Path-1 (no flags, live-session locked, honoring #129; no regression of the passing
gates — archetype buttons #139, custom-name accept #136, per-project openings
#136/#138/#139, bubble/tab/markdown #137/#141).

**BUG 1 — agent name (and personality) asked TWICE on a TAP.** Root cause:
`agent_name`/`agent_personality` were persisted ONLY by the fire-and-forget
post-turn LLM extractor (`post-turn-extractor.ts` — literally "agent_name — LLM
only"). So a TAPPED (or typed) choice left `phase_state` unset until that slow,
sometimes-timing-out extractor caught up, while the per-turn required-step guard
(`onboarding-preamble.ts:buildOnboardingStepGuardFragment` via
`required-fields-audit.ts`) re-injected the "STILL OPEN - NAME/PERSONALITY"
hard-require from the STALE pre-turn `phase_state` every turn — so the live agent
dutifully re-asked. **Fix:** a new PURE decider `button-backed-answer.ts:`
`captureButtonBackedRequiredField` (prior-question + phase_state + answer →
which field to settle), driven by a new `LiveAgentOnboardingSeam.captureRequiredAnswer`
seam that the live runner (`build-live-agent-turn.ts`) calls + AWAITS at
turn-START — BEFORE the step-guard grounding reads `phase_state`. It persists
`agent_name`/`agent_personality` deterministically at choice-time, so the audit
recomputes with the answer already settled and the step is never re-asked. It is
conservative: only fires off the prior agent question's DURABLE persisted options
(`ButtonStore.latestPromptByTopic` — live replies strip the `[[OPTIONS]]` block
out of `body` into `options_json`, so the body alone would never match; Codex r1
P1), anchors the personality step on the DEFINED archetype names actually
rendered (so an early import yes/no can't be mis-captured), declines escape hatches
("Something else"/"I'll choose my own"), and lets the LLM extractor stay the
fallback for free-text answers it declines. Typed custom names still settle.

**BUG 2 — duplicate closing message.** The live agent emitted its own wrap-up
("We're set, what first?") AND finalize emitted the deterministic
`ONBOARDING_CLOSING_MESSAGE` (`build-onboarding-finalize.ts`). **Fix:** when
`captureRequiredAnswer` settles the LAST required field it fires finalize
(idempotent, `finalizeImportOnboardingIfReady`) and returns `finalized: true`, and
the runner SUPPRESSES its own wrap-up turn (returns early, no substrate dispatch,
no `agent_message`) — so the single deterministic finalize closing (which already
names the LEFT RAIL) is the ONE closing. Defense-in-depth: the preamble now tells
the agent NOT to write its own closing (the system sends it) and forbids the exact
duplicate phrases. Nice-to-have: preamble asks the agent to avoid em dashes.

**Tests.** New `onboarding/interview/__tests__/button-backed-answer.test.ts` (15:
tap/typed name + personality settle without the extractor; escape hatch / bare
confirm / no-options-block / early yes/no / both-settled all decline); new
`gateway/realmode-composer/__tests__/build-live-agent-turn-capture.test.ts` (5:
capture runs BEFORE the guard grounding; `finalized:true` suppresses dispatch +
`agent_message`; `finalized:false` runs normally; seed turn never captures;
settling answer still persisted as the user bubble); `onboarding-preamble.test.ts`
updated (agent told not to self-close + em-dash guidance). Full
`onboarding/interview` + `gateway/realmode-composer` + chat-bridge live-agent
suites green (1373 pass / 0 fail). tsc clean; leak-gate SILENT.

**Touched:** `onboarding/interview/button-backed-answer.ts` (new pure decider),
`onboarding/interview/onboarding-preamble.ts` (export archetype names + no-self-
close/em-dash guidance), `gateway/realmode-composer/build-live-agent-turn.ts`
(`captureRequiredAnswer` seam + turn-start call + wrap-up suppression),
`open/composer.ts` (seam impl: deterministic persist + finalize-on-complete).

## 2026-06-30 — Onboarding reliability: per-project opening recovery + empty-project loader + deterministic archetype step + larger cold budget

**P0 — four reliability gaps from a full fresh-install verify of #136+#138.** All
fixed inside Path-1 (no flags, live-session locked, honoring #129; no regression
of #136 custom-name/closing, #137 per-project-chat/Plan/markdown/tabs, #138
General-only onboarding + raised-timeout + welcome-reload-recovery).

**Issue 1 — per-project OPENING never landed (DB-confirmed 0 rows).** Finalize's
`emitProjectOpenings` logic was correct and unit-tested, yet the live box showed 6
projects with ZERO `app:<user>:<project>` `button_prompts` rows: the opening was a
fire-once side effect of finalize that can race the project-tab socket, be
swallowed, or be delayed under cold-turn load, and nothing regenerated it on entry
(reload recovered only the General welcome). **Fix:** made the opening a property
of ENTERING a materialized project. `open/composer.ts` `on_session_open` now, on
every steady-state connect to a materialized PROJECT topic with no message yet,
regenerates + persists the SAME deterministic opening
(`build-onboarding-handoff.ts:buildDeterministicProjectOpening` over the
materialized `STATUS.md`/`README.md`) via the idempotent `onboardingMsgHolder.emit`
(`dedupe_key: onboarding_opening:<project_id>`) — collapses onto finalize's row if
that already landed, never double-posts. Doubles as reload recovery for a
stuck/missing project opening (Issue 4b).

**Issue 2 — empty project chat showed a PERMANENT "Setting things up…" loader.**
`chat-react/ChatApp.tsx` gated the loader on the page-global
`config.onboardingActive` ALONE, so opening an empty project tab while onboarding
(or just after) painted the infinite onboarding loader forever. **Fix:** gate on
`config.onboardingActive && vm.projectId === null` — onboarding is General-only, so
a project topic resolves to the usable "Send a message to begin." empty state,
never the loader.

**Issue 3 — personality/archetype step was non-deterministic (skipped).** The
archetype + name steps lived only as soft preamble prose, and the preamble also
says "you do NOT need to collect these in order" — a fresh-install run showed ZERO
option buttons. **Fix:** new `onboarding-preamble.ts:buildOnboardingStepGuardFragment`
audits the durable `phase_state` and, while `agent_personality`/`agent_name` are
unset, HARD-REQUIRES the named-archetype / name `[[OPTIONS]]` block (never settle by
free text alone, never finalize without it). Injected EVERY onboarding turn via the
`LiveAgentOnboardingSeam.onboardingContext` seam (joined with the import-analysis
grounding), so the agent cannot drift past the personality step without rendering
the buttons — reliable, not LLM-whim, still inside Path-1.

**Issue 4 — cold turn still hard-erred + reload didn't recover project openings.**
(a) `COLD_TURN_TIMEOUT_MS` raised 360s → 600s (`build-live-agent-turn.ts`): #138's
360s still hard-failed a real onboarding turn at ~5.5min under load; 10 min leaves
comfortable headroom. (b) Reload recovery for project openings is the Issue-1
`on_session_open` regeneration above.

**Tests.** `onboarding-preamble.test.ts` (+4: step guard fires while unset, name
step after personality, null once both settled, both-missing); `chat-react`
`component.test.tsx` (+2: empty project topic shows no loader / General still does);
new `open/__tests__/open-project-opening-recovery.test.ts` (+2 integration: a
project-topic connect seeds the STATUS.md opening; no seed when the topic already
has a message); existing cold-turn budget test updated 360s → 600s. tsc clean
(root + chat-react leaf); leak-gate SILENT.

**Touched:** `open/composer.ts` (opening-recovery helper + `on_session_open`
steady-state branch + `onboardingContext` step-guard wiring),
`onboarding/interview/onboarding-preamble.ts` (step-guard fragment),
`landing/chat-react/ChatApp.tsx` (loader gate),
`gateway/realmode-composer/build-live-agent-turn.ts` (600s budget).

## 2026-06-30 — REPL/live-agent model is ALWAYS the latest (never a hardcoded stale id)

**P0 onboarding hang fix.** A fresh Open box spawned the live-agent / onboarding
REPL with `--model claude-opus-4-7` (the hardcoded `BEST_MODEL` default in
`runtime/models.ts`). Once `opus-4-7` stopped serving, the model call hung → the
turn produced ZERO tokens → the persistent-REPL 180s per-turn timeout fired →
the user got the failure bubble / an indefinite "Setting things up…" loader.
Repro: a clean instance on the default hung 180s + failed; pinned to
`claude-opus-4-8` it delivered the welcome in ~32s.

**Root cause.** `runtime/models.ts` already exposes a dynamic accessor
`getBestModel()` (the model-update watchdog flips its override via
`setBestModelOverride` when a newer top-tier model ships), but the gateway-level
spawn/dispatch sites read the **frozen `BEST_MODEL` constant** instead — so the
watchdog's adopted id never reached new/cold spawns, and the stale literal rotted
into a hang the moment the pinned model was retired.

**Fix (no flags, no dual paths).**
- **Seed bump:** `BEST_MODEL` default `claude-opus-4-7` → `claude-opus-4-8` (the
  fresh-install, pre-first-watchdog-tick seed) + a doc note that this is a SEED,
  not the live value. Added the matching `claude-opus-4-8` row to
  `runtime/model-pricing.ts` (same Opus $5/$25 rates) so
  `resolvePricingFor(getBestModel())` doesn't throw at import-build.
- **Dynamic resolution at every live spawn/dispatch site**, resolved as late as
  feasible (per-turn / per-call, never captured when a runner is built once at
  boot): `open/composer.ts` `prewarmSubstrate` (the warm-pool spawn that heats
  the onboarding REPL — THE confirmed-bug site), `build-live-agent-turn.ts`
  (resolved inside the per-turn body), `build-llm-router.ts`,
  `build-project-opening-message.ts`, `build-project-doc-composer.ts`,
  `build-phase-spec-resolver.ts` (`buildAnthropicLlmCall` model now optional →
  `getBestModel()` per-call), `build-agent-watcher-llm-call.ts`,
  `gateway/cores/mount-open-cores.ts` (one-shot Core LLM + email model), the
  onboarding suggesters (`agent-name-suggester.ts`,
  `personality-character-suggester.ts`) + `post-turn-extractor.ts`,
  `onboarding/synthesis/synthesis-session.ts`,
  `onboarding/history-import/substrate-callers.ts` + `job-runner.ts`,
  `scribe/extract.ts`, `reflection/detector.ts`. `agent-dispatch/service.ts`
  `default_model` now accepts a `string | (() => string)` thunk, and the Open
  composer passes the `getBestModel` accessor so each dispatch resolves live.
  Trident keeps the dynamic `--model opus` CLI alias (already always-latest);
  reminders/research keep their intentional `FAST_MODEL`/`SONNET_MODEL` picks.
- After this change there are **no remaining runtime references to the frozen
  `BEST_MODEL` constant** outside `runtime/models.ts` (the seed) and
  `runtime/model-pricing.ts` (doc text) — verified by grep.

**Tests.** New `build-live-agent-turn-model-resolution.test.ts`: a runner built
WITHOUT an explicit model spawns `getBestModel()`; a `setBestModelOverride` flip
AFTER the runner is built reaches the NEXT turn on the SAME runner (proves
per-turn, not per-build, resolution); an explicit `input.model` still wins. New
`prewarmSubstrate` model-resolution test (in `onboarding-warm-conversational`):
the pre-warm spawn uses `getBestModel()` and tracks a watchdog flip. Updated the
`models.ts` default assertion (4.7→4.8), the watchdog-wiring oldModel/no-downgrade
assertions (assert against `BEST_MODEL` not a literal), and the import
substrate-caller default assertions. tsc clean (root + trident); leak-gate
SILENT; models/substrate/onboarding/cores/realmode-composer suites green.

**Codex cross-model review follow-up.** Making the import default dynamic meant
that, after the watchdog adopts a brand-new top-tier id with no pricing row yet,
`resolvePricingFor(getBestModel())` (eager, at `buildPass{1,2}SubstrateCaller`
construction) would throw and break onboarding/imports. Fixed by splitting the
resolver: an EXPLICIT operator `model_preference`/`fallback_model_preference`
keeps the strict loud-fail (typo protection), while the DYNAMIC always-latest
default degrades to a $0 estimate (`dollars_billed` is telemetry-only) with a
one-time warn — the import runs on the latest model regardless. Regression test
added (`buildPass1/Pass2SubstrateCaller` construct + run on an unpriced
watchdog-adopted model, billing $0).

**Codex review round 2 — per-call resolution.** The import callers + onboarding
suggesters + post-turn-extractor are constructed ONCE at gateway/composer boot,
so a builder-scope `getBestModel()` capture would pin the boot model and miss a
later watchdog flip. Moved the dynamic-default model (+ its pricing, for the
import callers) resolution INSIDE each returned closure (per-call), so a
post-boot adoption reaches the next import / suggestion / extraction. Explicit
operator model picks still resolve + price ONCE at build (loud-fail on typo).
Test added: a `setBestModelOverride` flip between two calls on the SAME import
caller reaches the second dispatch.

**Codex review round 3 — env-pin keeps strict pricing.** `getBestModel()` returns
`runtimeBestModel ?? BEST_MODEL`, so an operator's `NEUTRON_BEST_MODEL` pin
(surfaced as `BEST_MODEL`) was being silently billed at $0 when unpriced —
regressing the typo loud-fail. Now ONLY a watchdog-adopted override (model !==
`BEST_MODEL`) degrades; the env/default base keeps the strict `resolvePricingFor`
loud-fail.

**Codex review round 4 — model attribution / metadata (P3).** Two
non-dispatch sites that should NOT track the live accessor: (a)
`onboarding/history-import/job-runner.ts` stamps `synthesizer_model` for a
legacy/pre-S21 row that ALREADY completed — reverted to the stable `BEST_MODEL`
(attribution, not selection; a watchdog flip mustn't mislabel old results). (b)
The free-email `/email` chat-command filter's reported `model` was captured at
mount while `emailLlm` dispatches `getBestModel()` per call — the filter's
`model` option now accepts a thunk resolved per-call in `match`, so the reported
model stays aligned with the dispatch.

**Codex review round 5 — Email Core backend metadata (P3).** Same boot-capture
in the Email-Managed Core MCP-tool path: `buildTools` stamped a boot-time model
onto `email_triage` / `email_summarize` brief metadata while `llm` dispatched
`getBestModel()` per call. Threaded a `string | (() => string)` thunk through
`emailModel` (`mount-open-cores` → `boot-helpers` factory → `buildTools`),
resolved PER-CALL inside each tool handler, so the stamped model tracks a
watchdog flip. (Email Core is OAuth-gated / inert in default Open, but kept
consistent with the dispatch.)

NOTE: `open/__tests__/open-projects-changed-wiring.test.ts` (one live-refresh
timing test) fails on unmodified `origin/main` too — a pre-existing flake, not a
regression from this change.
## 2026-06-30 — Web-client rework: per-project chat + rail/tab layout + Plan rename + remove Tasks + markdown (P0)

The linchpin fix for the onboarding→project UX. Five linked changes, all in the
web client + tabs registry + the app-ws topic-binding seam. No feature flags.

**(1) Real per-project chat.** The `/ws/app/chat` surface previously bound EVERY
connection to the per-user topic `app:<user>` and treated `project_id` as a
cosmetic tag, so all projects shared one transcript and clicking a project showed
the same chat. Now a `platform=web` socket carrying a `project_id` binds the
PER-PROJECT topic `app:<user>:<project>` (`appWsProjectTopicId`,
`channels/adapters/app-ws/envelope.ts`); General omits `project_id` → bare
`app:<user>`. Persistence + seq + resume + fan-out key on the topic string
(independent transcripts, verified safe — the agent loop scopes off the
`project_id` field, not the topic), so each project has its own history. The
client `controller.setProject` RE-SCOPES: tears the socket down and stands up a
fresh one bound to the new topic, hydrating that topic's transcript from the
shared OPFS store (`main.tsx` `topicForProject`/`wsUrlFor`; `config.ts`). The
`turnTopicId` warm-session key was de-duped so the already-project-scoped web bind
isn't double-suffixed (`open/composer.ts`). **Gated on `platform === 'web'`** —
mobile keeps its single `app:<user>` socket + `project_id`-field model, unchanged.
Topic string is `app:<user>:<project>` (user-scoped, NOT `wow-shell-<id>`) so two
users opening the same project can never share a transcript — mirrors the proven
`landing/server.ts` `web:<user>:<project>` model. The 0→N `projects_changed`
auto-select was DROPPED: a mid-onboarding project appears in the rail but does NOT
yank the chat off General (which would drop still-arriving onboarding messages);
the user enters a project by tapping it. **Known behavior:** reminders/briefs still
fan to the bare `app:<user>` (General inbox) topic, so they surface in General, not
the per-project chats (durable rows always under `app:<user>`).

**(2) Persistent rail + tab layout.** `TopicRail` was nested INSIDE the Chat tab
body, so it vanished on other tabs, and the `TabBar` floated above everything only
in project views. Now `ProjectShell` is the app shell: a persistent `TopicRail`
left column + a content pane with the `TabBar` in BOTH General and project views.
**General** = Chat + Admin (global tabs); **project** = Chat / Plan / Documents
(NO Admin fold-in — the prior bug). `ChatApp` is now just the Chat-tab body
(`ChatSurface` + its bubble contexts); the create-project flow moved to the shell.

**(3) "Work Board" → "Plan"** user-facing label (`tabs/registry.ts`); internal
`work_board_*` tools / `cwb-` CSS / `work_board_changed` frame / DB table keep
their identifiers (no churny rename).

**(4) Tasks tab removed** from the engine (Ryan directive). The `tasks`
`BUILTIN_TABS` entry + `TasksTab.tsx` + `tasks-client.ts` + the `ProjectShell`
`target==='tasks'` branch + their tests were deleted; Tasks returns in WAVE 3 as a
Core-contributed webview tab via the existing `CoreTabContribution` path.

**(5) Markdown rendering.** Agent chat bodies (`ChatApp` `TextPart`, via
`useMessagePartText`) and the Documents viewer render sanitized GitHub-flavored
markdown through a shared `Markdown.tsx` (`react-markdown` + `remark-gfm` +
`rehype-sanitize`; links open `target=_blank rel=noopener`). User chat messages
stay plain. The Documents tab gains a Rendered↔Source toggle — Rendered is the
default; Source exposes the raw `<pre>` so comment anchors still map to RAW
character offsets. Deps added to `landing/package.json`; the lazy `Bun.build`
bundle stays ~0.91 MB.

Verification: root + chat-react-leaf + mobile `tsc` clean; chat-react 143 tests,
registry/app-tabs/app-ws-surface 46, app-ws adapter 107, composer/realmode 502 all
green; leak-gate SILENT. Files: `gateway/http/app-ws-surface.ts`,
`channels/adapters/app-ws/{envelope,adapter}.ts`, `open/composer.ts`,
`tabs/registry.ts`, `landing/chat-react/{ProjectShell,ChatApp,DocumentsTab,
controller,config,main,Markdown}.tsx?`, `landing/chat-react.html`,
`landing/package.json`.
## 2026-06-30 — Onboarding live-path: archetypes + option buttons + custom-name + closing + per-project openings

Five Path-1 onboarding content/flow regressions Ryan hit live-testing, all wired
INTO the live CC session (no phase-machine revival, no feature flags, one path).

**(1) Defined personality archetypes instead of improvised "flavors."**
`onboarding/interview/onboarding-preamble.ts` told the model to "offer a couple of
concrete flavors" at the personality step → it improvised a different trio every
run. It now injects the DEFINED named-character set
(`STATIC_PERSONALITY_CHARACTER_FALLBACK` from `personality-character-suggester.ts`
— Sherlock Holmes / Marcus Aurelius / Mr. Miyagi / Yoda / Atticus Finch) and tells
the agent to offer THOSE, presented as buttons (item 2).

**(2) Quick-select OPTION BUTTONS on choice steps.** The live onboarding turn
always emitted `options: []`, so the React client — which already renders an
`agent_message`'s `options[]` as tappable buttons and routes a tap back through
`on_button_choice` (`open/composer.ts`) as the next turn's `user_text = option.value`
— never received any. The preamble now instructs the agent to append a
`[[OPTIONS]] … [[/OPTIONS]]` block AFTER its prose question on genuine choice
steps; `build-live-agent-turn.ts:extractAgentOptions` parses the block out of the
collected reply ON ONBOARDING TURNS ONLY, strips it from the rendered body, and
emits the lines as buttons (letter-legend label + display body + a routing `value`
that is the line text itself, deduped + byte-capped to the 37-byte wire budget).
`allow_freeform` stays true (typing always works). Server-side structured-choice
detection — NOT a `--tools` surface change (the warm REPL's allow-list must stay
constant per the reuse guard).

**(3) Reliable custom-name capture.** The preamble now mandates accepting ANY name
the owner gives — typed OR tapped — verbatim, confirming and moving on, and NEVER
re-asking a name already given (the "Ferin got re-asked" regression). Name
suggestions are offered as `[[OPTIONS]]` per #2.

**(6) Closing handoff message.** `build-onboarding-finalize.ts` emitted NO closing
— the interview went silent after the last answer. It now takes an `emitChatMessage`
dep (wired in `open/composer.ts` to the SAME durable-history + live-fan path a
live-agent reply uses: a `button_prompts` row on `app:<user>[:<project>]` that the
topic `chat_history_surface` hydrates + a `buildAppWsSendReply` socket push) and,
AFTER `emitProjectsChanged`, emits a deterministic General closing pointing at the
populated left rail ("open one to find its Plan, Documents, and Chat" — uses "Plan",
not "Work Board"). Emitted from finalize (not just the preamble) so the projects
are guaranteed in the rail when it lands. The closing + each opening carry a stable
per-(topic, kind) `dedupe_key`; the composer keys the durable `button_prompts` row
on it AND suppresses the live re-send when the row already existed, so a
re-finalize from an overlapping recovery path never double-posts (Codex P2).

**(7) Per-project opening message.** Path-1 finalize materialized projects with
rich docs but seeded no opening chat message. `materializeProjects` now returns the
landed projects, and finalize composes each one's opening (summary + ONE next move)
via the SAME deterministic composer the legacy phase-machine handoff used
(`build-onboarding-handoff.ts:buildDeterministicProjectOpening`, reading the
materialized `STATUS.md`/`README.md` with the import signal as fallback), delivering
it into the project's app-ws topic `app:<user>:<project>` — the key the live-agent
reply path and the client's per-project chat read from. SIBLING-PR COORDINATION:
the concurrent web-client PR is making the client read per-project topics; the
opening lands on the project's canonical app-ws topic, reconciled at merge.

Tests: `extractAgentOptions` parsing + onboarding-vs-steady-state emission
(`build-live-agent-turn-options.test.ts`); finalize closing + per-project openings
+ no-seam-still-completes (`build-onboarding-finalize.test.ts`); preamble archetypes
/ options protocol / custom-name / rail+Plan wrap-up (`onboarding-preamble.test.ts`).
`tsc` clean; existing live-agent-turn / handoff / chat-bridge / production-composer
suites still green.

## 2026-06-30 — M1 onboarding/UI cleanup batch (3 minor verify-pass fixes)

Three minor, non-architectural polish fixes surfaced during the M1
browser-verification passes. No feature flags, no migration, no new endpoint.

**(a) Import "Reading through…" status bubble floated to the chat bottom.** The
`import_running` `status` prompt ("Reading through your export now: entities,
topics, recurring threads…") was fanned ephemerally via `emitOnboardingPrompt`,
so it carried no chat_log `seq` and `compareForDisplay` (seq-less sorts to the
tail) pinned it BELOW every later real-seq message — it stayed at the bottom even
after the import completed and the analysis + later turns arrived. This is the
same ordering seam #130 fixed for the analysis body. **Fix** (`open/composer.ts`):
new pure, unit-tested `resolveImportRunningStatusDelivery` — the FIRST plain
buttonless status bubble is persisted through the durable adapter (chat_log
`seq` → chronological order), and the engine cron's RE-EMITS
(`import_running_attempt_count > 1`) are suppressed so they don't stack duplicate
durable bubbles (the live `import_progress` banner already shows ongoing
progress). Failure / rate-limit / resume prompts (real buttons) stay ephemeral.

**(b) Locked-in project set could include a project never shown to the user.**
The presentation caps the proposal at `MAX_ANALYSIS_PROJECTS` (7), but Pass-2 /
synthesis only caps via a prompt instruction (NOT enforced in code). A >7
synthesis therefore stamped the FULL list into `phase_state.import_result` AND
merged all N names into `primary_projects`, so the per-turn `onboardingContext`
seam, persona-gen, and finalize all locked in projects 8+ the user never saw and
could not drop. **Fix**: `capProposedProjects` (single source of truth in
`phase-prompts.ts`, used by the presentation too) is applied at the engine STAMP
chokepoint (`advanceFromImportRunningOnComplete` caps both `import_result` and
the `primary_projects` merge), so everything downstream agrees with the displayed
slice. `build-onboarding-finalize.resolveProjects` caps the IMPORT contribution to
the displayed set as a finalize-layer guard but TRUSTS `primary_projects` verbatim
(only displayed names + explicit adds, since the engine merge is capped) — it does
not filter primary against the overflow, which would wrongly drop an explicit add
whose name collides with an unshown overflow proposal (fixed per Codex review).
The GAP1 "no-narrowing" invariant is preserved (finalize = displayed − dropped +
adds).

**(c) Create Project used the native `window.prompt()`.** Replaced the blocking,
unstyleable native dialog (which also blocks E2E/CDP automation) at
`landing/chat-react/ChatApp.tsx` with an INLINE name input in the rail
(`.car-rail-input`), mirroring the mobile `app/app/projects` pattern: Enter
submits, Esc cancels, an empty name shows an inline error, and a failed POST
renders inline (no `window.alert`). Same `POST /api/app/projects` + bearer +
`controller.setProject(newId)` navigate-in flow; CSS in `landing/chat-react.html`.

**Tests.** New unit tests for `resolveImportRunningStatusDelivery`
(`open/__tests__/open-import-analysis-delivery.test.ts`), `capProposedProjects` +
the finalize >7 reconciliation (`gap1-project-no-narrowing.test.ts` +
`build-onboarding-finalize.test.ts`), and the inline create-project flow incl.
Enter/Esc/empty-name (`landing/chat-react/__tests__/component.test.tsx`). tsc
clean; leak-gate SILENT.

## 2026-06-29 — M1 CRITICAL: open-mode history import wouldn't START (#130 regression) — upload right after the name now seeds the row + starts the job

**Symptom.** On a fresh Open install, the reworked onboarding (#130) offers
history import right after the name. The owner uploads their ChatGPT/Claude
export and the server returns `job_id: null`; the client shows "Couldn't start
the import — no import job started." The import never runs (`import_jobs` empty,
`in_flight_imports=0` forever) behind a false success.

**Root cause.** `InterviewEngine.notifyImportUpload`
(`onboarding/interview/engine.ts`) reads the onboarding_state row and short-
circuits with `noop_no_state` when it's absent — **before** the open-mode
import-start gate. The open-mode live-agent onboarding never calls
`engine.start()` (managed mode's row-seeding entry); the row is created
**lazily + asynchronously** by the fire-and-forget post-turn extractor
(`post-turn-extractor.ts`), a multi-second background LLM call that only upserts
once it extracts a field. #130 moved the import offer to right after the name —
**earlier than the background extractor can create the row** — so the upload
races ahead of the row and lands at `state === null`.

**Fix (no flags, tenant-silent).** In `notifyImportUpload`'s `state === null`
branch, when the upload is a SOLICITED open-mode Path-1 upload (the SAME signal
the non-null gate uses: `deploymentMode === 'open'` AND `importAffordanceOffered`,
the exact condition the live-agent seam renders the 📎 affordance under), seed
the onboarding_state row at the `work_interview_gap_fill` conversational marker —
stamping `signup_via` so the import-running cron's channel-context invariant holds
on disk — then start the import via the existing
`startImportAndAdvanceToRunning`. A STRAY upload (affordance not offered, e.g. no
synthesis substrate) and managed mode both still `noop_no_state`. The #130
offer-first / live-progress / ordering / curation-context handoff are untouched.

**Concurrency guard (Codex r1 P2).** Two layers. (1) `notifyImportUpload` is now
serialized per `(project_slug, user_id)` via an in-process promise-chain tail
(mirrors the post-turn extractor's `chains` map). Single-owner Open is one
process, so this fully eliminates the upload-vs-upload race: two truly-
simultaneous fresh-install uploads run one-at-a-time, so the second observes the
first's `import_running` row and takes the `alreadyHasImportJob` guard — no
duplicate job, no downgrade. (2) Before seeding, the no-state branch also re-reads
the row and, if it now exists (e.g. the post-turn extractor — which is NOT under
this tail — created it), re-enters the locked body so all non-null guards apply.
Covered by added tests: sequential double-submit; a get-hooked store simulating
the concurrent window; and two truly-simultaneous `Promise.all` uploads → exactly
one job.

**Test (forbidden-pattern fixed).** The passing acceptance test
`tests/integration/nd2-real-export-path1-import-runs.test.ts` SQL-SEEDED an
onboarding_state row before uploading — manufacturing the precondition the live
flow never creates, so it could never catch this. It now seeds NO row and drives
the real no-state upload (verified end-to-end with Ryan's real 3.6MB / 184-convo
Claude export → job started). Added two engine-level repros in
`onboarding/interview/__tests__/path1-solicited-upload-starts-job.test.ts`
(no-state solicited → seeds row + starts; no-state affordance-off / managed →
no-op, no row manufactured). Negative control: reverting the engine fix fails
exactly these no-state tests.
## 2026-06-29 — Create Project affordance (project rail + create-project capability + agent tool)

A skip-import owner had no user-initiated way to create a project (projects only
materialized at onboarding finalize; reaching one otherwise needed the ≥3-project
gap-fill quota). Added a Create Project affordance across all surfaces, all
reusing ONE project-creation code path.

- **Shared primitives (`gateway/realmode-composer/project-create.ts`).** Extracted
  `ensureProjectRow` + `resolveBindTarget` (the `projects` row + cli wow-shell
  `topics` binding — idempotent, duplicate-safe, soft-delete-respecting) out of
  `build-onboarding-finalize.ts` into a shared module, plus `createProjectRow`
  (fast row-only half), `buildScaffoldMaterializer` + `materializeProjectScaffold`
  (on-disk docs + git + GBrain page). The finalizer now IMPORTS these — no second
  path. (Onboarding finalize tests unchanged + green.)
- **HTTP `POST /api/app/projects`** (`gateway/http/app-projects-surface.ts`,
  bearer-gated). `{ name }` → `{ project: { id, label }, created }` (201/200);
  optional `createProject` binding → `501 create_not_configured` where unwired.
- **Open wiring (`open/composer.ts`).** Mounts the whole app-projects surface
  (also gives mobile `fetchProjects` a real backend — previously unmounted in
  Open) + the `create_project` tool, both bound to one `createProjectAndRefresh`
  (row → fire-and-forget materialize → `emitProjectsChangedNow`, an unconditional
  `projects_changed` fan so a skip-import owner's first action refreshes the rail).
- **`create_project` agent tool** (`create-project-tool.ts`, registered in
  `build-core-modules.ts`; `auto` approval, `write:project_data`, non-hidden) —
  agent-native parity; `project_slug`/`speaker_user_id` server-injected.
- **Web rail** (`landing/chat-react/ChatApp.tsx` `TopicRail` + `chat-react.html`):
  `+ Create Project` pinned at the rail bottom (`margin-top:auto`), always visible;
  the rail now always mounts. Click → prompt → POST → `setProject` navigates in.
- **Mobile rail** (`app/app/projects/index.tsx` + `lib/projects.ts` `createProject`
  / `lib/projects-client.ts` `create`): bottom-pinned bar → inline name input →
  POST → `router.push('/projects/<id>')`.
- No migration (the `projects` table already exists, `0038`); Work Board tab is
  automatic per-project. tsc clean (root + chat-react + app); leak-gate SILENT.
  Tests: surface POST (`gateway/__tests__/app-projects-surface.test.ts`), shared
  primitives + tool (`gateway/realmode-composer/__tests__/project-create.test.ts`),
  web rail click (`landing/chat-react/__tests__/component.test.tsx`), mobile client
  (`app/__tests__/projects-client.test.ts`).

## 2026-06-29 — M1: onboarding import flow rework — offered FIRST + live progress + curation handoff + ordering

This is one coherent import-onboarding rework (PR #130). Two further bugs were
folded in after the initial offer-first + progress pass:

**Bug 3 — analysis → curation handoff was BROKEN (the killer).** The import-
analysis result (proposed-projects list) reached the client but was NOT in the
live-agent's conversation context. So when the owner replied to curate ("drop
the Family Home project, keep the rest"), the agent had no record of proposing
anything and answered "this is our first conversation, I haven't proposed any
projects" — the import was visible but un-actionable.

- Root cause: the analysis "wow moment" is delivered OUT OF BAND (ephemeral
  app-ws `agent_message`, never in the warm REPL transcript), and the onboarding
  `systemPreamble` is a static string spliced ONLY on the cold first turn — so a
  warm session post-import had no grounding on what it proposed.
- Fix (1) — context threading: new optional seam method
  `LiveAgentOnboardingSeam.onboardingContext(user_id)` (`build-live-agent-turn.ts`)
  re-injected on EVERY onboarding turn (warm AND cold), mirroring the Work Board
  block. `open/composer.ts` implements it: reads durable `phase_state.import_result`
  + `primary_projects` and calls the new `buildImportAnalysisContextFragment`
  (`onboarding-preamble.ts`) → an `<import_analysis>` block listing the proposed
  projects (with rationale + which were dropped) and telling the agent it already
  presented them + how to handle keep/drop/edit/add.
- Fix (2) — drop propagation: the Path-1 post-turn extractor never implemented the
  `removed_projects` channel that `ExtractedFields` has documented since GAP1
  (2026-06-09) and the legacy engine honors. Ported it: `parseExtractedFields`
  parses `removed_projects`; the extraction prompt asks for explicit drops;
  `buildPhaseStatePatch` subtracts them from the merged `primary_projects` AND
  accumulates them under `phase_state.dropped_projects`. `build-onboarding-finalize.ts`
  `resolveProjects` excludes `dropped_projects` from BOTH union sources (the import
  side re-pulls `proposed_projects`, so the `primary_projects` subtraction alone
  wasn't enough). Mirrors the legacy engine's `(prior ∪ adds) MINUS removals`. So
  a dropped project is never materialized; persona-gen (reads `primary_projects`)
  agrees. The additive no-narrowing rule is intact for non-removal turns.

**Bug 4 — import-delivered messages mis-ordered.** New user messages rendered
ABOVE the import-delivered analysis instead of newest-at-bottom. The successful
`import_analysis_presented` body was fanned via the ephemeral `emitOnboardingPrompt`
(no chat_log `seq`), and chat-core's `compareForDisplay` pins seq-less messages to
the tail — so a later real-seq user message sorted above it (and it vanished on
resume). Fix: that specific buttonless "wow moment" now persists through the
durable app-ws adapter (`open/composer.ts` button-prompt router → `adapter.send`
→ chat_log → monotonic `seq`, replayable). Every OTHER onboarding prompt (failure
/ rate-limit / resume — real buttons) stays ephemeral. Safe from double-render:
`on_session_open` never re-sends the body and the watcher resolves the phase so
the reconnect re-emit won't re-fire it.

Tests added: `onboarding-preamble.test.ts` (context fragment — lists proposed,
marks dropped, case-insensitive); `post-turn-extractor-removed-projects.test.ts`
(parse + subtract + accumulate `dropped_projects`, additive when no removals);
`build-onboarding-finalize.test.ts` (a dropped project is not materialized even
from the import union). tsc clean; leak-gate SILENT; onboarding-interview (957),
realmode-composer (379), app-ws (107), Open import/boot suites all green.

---

## 2026-06-29 — M1: onboarding import offered FIRST + real live import progress

**Problem (two live-test bugs).** Ryan hit two issues on a fresh M1 install:
1. The ChatGPT/Claude history import was **not offered early/explicitly**. After
   the #126 fix removed a premature always-on hint, the offer swung too far the
   other way — the agent only mentioned import after probing the user's work, so
   it felt buried. The intent (and the onboarding-experience spec) is: offer the
   import as the EXPLICIT first step right after the name, so the rest of the
   interview is informed by the analysis.
2. There was **no real import-progress indicator**. A large import (~8 min for
   173 conversations) showed only a one-shot "Export received — reading through
   your history now." line and then looked dead for minutes.

**Root cause.**
- Bug 1: Path-1 (Open) onboarding is prompt-driven — the engine runs only the
  import subsystem, so onboarding ordering lives entirely in the `<onboarding>`
  preamble (`onboarding/interview/onboarding-preamble.ts`). The import block sat
  after all five learning goals + was gated "after you have their name AND a
  sense of their work", biasing the model to defer it past the work-interview.
- Bug 2: the engine's `import-running-cron` already emits an `import_progress`
  event every ~5s and `buildRoutedSendImportProgress` already routes `app:<user>`
  topics to a composer holder — but that holder's `.send` was a documented NO-OP
  (`open/composer.ts`), so every progress frame was dropped. The React client
  (`controller.ts`) already consumed `import_progress` and rendered a spinner +
  per-pass line (`ChatApp.tsx` `ImportStatus`); only the server-side app-ws emit
  was missing.

**Fix (no flags, Option A in-chat for Bug 1).**
- `onboarding/interview/onboarding-preamble.ts` — moved the import-offer block to
  between goal #1 (name) and goal #2 (work) and reworded it to an EXPLICIT,
  prominent ask made RIGHT AFTER the name and BEFORE the work questions (mentions
  the drag-and-drop/📎 affordance + that it runs in the background with live
  progress; "only ask this once"). No new phase/modal — a pure preamble
  reposition. The managed-mode phase machine already routes import right after
  name, so it was untouched.
- `channels/adapters/app-ws/envelope.ts` — new `AppWsOutboundImportProgress`
  envelope (`{v,type:'import_progress',job_id,status,pass,pct,chunks_total_known,
  body?,ts}`) added to the `AppWsOutbound` union; mirrors `agent_typing` /
  `work_board_changed` (ephemeral, UI-only, not persisted, never replayed).
- `open/composer.ts` — filled the no-op `appWsImportProgressRouter.send` to fan
  the new frame via `appWsRegistry.send(app:<user>, env)` (best-effort; terminal
  frames clear the client spinner defensively, the analysis body still lands via
  the button-prompt path). Engine, cron, routing, and client render were already
  built.
- Tests: `onboarding/interview/__tests__/onboarding-preamble.test.ts` (pins the
  import offer present + positioned name→import→work, absent when not offered,
  asked once); `channels/adapters/app-ws/__tests__/import-progress.test.ts`
  (envelope is a union member, body optional, fans through `registry.send`).
- Docs: `docs/SYSTEM-OVERVIEW.md` updated (onboarding import-offer-first note +
  app-ws frame `#7 live import progress`).

**Why it's safe.** Additive: a server-only union member (the Expo subset union +
parity test are untouched and still green). The #126 fixes (import RESULT renders,
centered column, no reactions) are unaffected — the analysis body still lands via
the existing path; this only un-drops the intermediate progress frames. tsc clean
(root + chat-react leaf); app-ws (107) + onboarding-interview (912) suites green.

## 2026-06-29 — M1: stale-client-store auto-reset on server reinstall

**Problem.** A fresh Neutron Open server reinstall showed a STALE chat: the web
client's offline local store (`@neutron/chat-core` OPFS snapshot, origin-scoped
`neutron-chat-core.json`) — and the mobile op-sqlite store (`neutron-chat.db`) —
survive a server uninstall+reinstall behind the same origin/device. The server's
per-topic `seq` counter restarts at 1 on a fresh install, but the client resumed
forward from its OLD high local cursor (`resume after_seq=<high>`), so the
server's `replayAfter` returned nothing and the dead server's transcript
rendered forever. `session_ready.last_seen_seq` already carried the server's
high-water seq but NO client code read it.

**Fix (seq-regression reset detection, no flags).**
- `chat-core/types.ts` — new `parseSessionReadyMaxSeq(frame)`: extracts
  `last_seen_seq` from a `session_ready` frame, `null` when absent/malformed.
- `chat-core/sync-engine.ts` — new `SyncEngine.reconcileServerReset(topic, serverMaxSeq)`:
  when the server's reported seq is a known number **strictly lower** than a
  **non-zero** local cursor, the server regressed (was wiped/reinstalled) →
  `store.clear(topic)` so the following `resume` re-syncs from `after_seq=0`.
  Conservative: no-op when seq is absent (`null`), when server seq ≥ local
  cursor (normal reconnect/cold-open/first-connect), or when the local cursor
  is 0 (nothing cached).
- `chat-core/web-session.ts` + `app/lib/chat-core/mobile-session.ts` — both
  `session_ready` handlers call `reconcileServerReset(frame)` BEFORE
  `resumeAndFlush()`, and emit a UI change on a real reset so the stale messages
  drop immediately (before the replay lands). The detection lives in the SHARED
  `SyncEngine`, so web (OPFS) and mobile (op-sqlite) both benefit.
- `app/lib/ws-envelope.ts` — added `last_seen_seq?` to `AppWsOutboundSessionReady`
  for type parity with the server envelope (`channels/adapters/app-ws/envelope.ts`).

**Server change (Codex P1a).** `gateway/http/app-ws-surface.ts` now ALWAYS sends
`session_ready.last_seen_seq` when a durable log is wired, **including 0**.
Previously it omitted the field on 0, so a freshly reinstalled server whose log
was still empty at connect time (the welcome messages persist AFTER
`session_ready`) sent no signal → the stale client never reset on its first
post-reinstall load. A present `0` is now an affirmative "this server has nothing
for the topic" signal; the field stays ABSENT only when there is no durable log
at all (where `null` → never clear, protecting the only copy). `open/composer.ts`
wires the durable `AppChatStore` chat_log, so Open always reports the real value.

**No-data-loss on reset (Codex P1b + P2).** Added a `Store.clearAckedTranscript(topic)`
primitive (InMemory + OPFS + Sqlite) that drops only the ACKED (server-sequenced)
transcript in a SINGLE atomic store operation, preserving un-acked local sends
(status `queued`/`sent`, no server seq). `reconcileServerReset` calls it instead
of a read-clear-reinsert cycle, so a send that races the reset can't be lost in a
snapshot→clear window (it's either an already-kept non-acked row or arrives
after). The preserved sends are re-driven against the fresh server by the
following resume/flush (idempotent on `client_msg_id`).

**Not changed.** No new local-store namespace keyed on a server instance id (the
frame exposes no per-install id today; the seq-regression heuristic is the
pragmatic detector per the bug note).

**Tests.** `chat-core/__tests__/session-ready.test.ts` (parser edge cases),
`chat-core/__tests__/sync-engine.test.ts` (reconcile: clears on regression;
no-op on ≥, null, cursor-0, un-sequenced optimistic sends),
`chat-core/__tests__/web-session.test.ts` + `app/__tests__/chat-core-mobile-session.test.ts`
(end-to-end: stale transcript cleared + `resume after_seq=0` + fresh replay
renders clean; normal reconnect preserves; absent `last_seen_seq` never wipes).

---

## Hobby projects + one-time agentic per-project kickoff (2026-07-01)

**Problem.** Two gaps in what onboarding produces on a fresh install: (1) the
interview asks about outside-work interests/hobbies but those answers materialized
NOTHING (only work/primary projects became real projects); (2) each materialized
project's opening was a static one-liner ("want me to X?") with no real agentic
work — no drafted doc, no deadline offer.

**PART A — hobbies materialize as projects.** Hobby answers land in
`phase_state.non_work_interests` (`{name, cadence_hint?}`, written by the
post-turn extractor) and `import_result.inferred_interests` (`{name, basis?}`) —
fields `resolveProjects` in `build-onboarding-finalize.ts` never read, so hobbies
reached persona-gen (USER/SOUL.md) but never a `projects` row / on-disk
`Projects/<id>/` repo. Added `collectInterestProjects` as a THIRD union source
(after import-proposed + interview-named work projects), mapping each interest to
`CapturedProject{name, rationale?, is_interest:true}` (rationale carried from an
import interest's `basis`). The existing `seen`/`dropped` dedup makes the superset
safe: a work project of the same name wins the slug dedup; a curation-dropped
hobby is excluded. The materializer is source-agnostic (identical repo + doc set
for hobby and work); `is_interest` only steers the kickoff. Added `is_interest?`
to `CapturedProject` (`onboarding/wow-moment/action-types.ts`).

**PART B — one-time agentic kickoff.** `emitProjectOpenings` now first asks a
`ProjectKickoff` (`gateway/realmode-composer/build-project-kickoff.ts`) for a
richer opening, behind a HARD data-sufficiency gate ("better nothing than a bad
job"). Best-fit action per project:
- `draft-doc` (rich work): compose a real starting plan via the new
  `build-project-kickoff-composer.ts` (same CC-substrate discipline as
  `build-project-doc-composer.ts` — `getBestModel`, AbortController budget,
  throw-on-empty), write it create-if-missing under `Projects/<id>/docs/starting-plan.md`,
  present a tappable `[Starting plan](docs:/<id>/starting-plan.md)` marker, and
  re-index the project page to GBrain recall via `buildProjectPageIndexer`.
- `deadline-offer` (work with a real upcoming `import_result.proposed_tasks`
  deadline related to the project by name/topic, within a 60-day window): name the
  deadline(s) and OFFER a reminder — never auto-created; the live agent's
  `reminders_create` handles an accept.
- `interest-research` (rich hobby): light starting-notes doc, same write+link+index.
- `interest-questions` (thin hobby): deterministic engaging questions (a hobby's
  meaty opening, never a bad artifact).
- `null` (thin work): fall back to the deterministic `buildDeterministicProjectOpening`.

**One-time, no recurring machinery.** The kickoff runs inside finalize's single
per-project opening pass and emits under the SAME `onboarding_opening:<project_id>`
durable dedupe key as the deterministic opening, so it fills the ONE opening slot
and the on-connect recovery (`open/composer.ts:ensureProjectOpeningOnEntry`)
collapses onto it — no double-post. NO cadence / cooldown / on-enter refresh /
setting. Any doc-compose failure degrades to `null` (work) or engaging questions
(hobby), never a half-baked doc. The full wow `ActionRunner`/dispatcher is NOT
reused (it is a batch button-prompt path with a channel adapter + cron the
one-time plain-emit finalize has no surface for); the kickoff reuses its
trigger/gate CONTRACT plus `ProjectDocComposer`, `runtime/doc-links.ts`, and the
project-page indexer. `MaterializedProject` now threads `is_interest` + the
materializer's `MaterializeOutcome` (previously discarded) so the gate can read
`slice_chunk_count`/`summary_written`.

**Wiring.** `open/composer.ts` builds `projectKickoff` from the onboarding
Anthropic client (kickoff composer) + `buildProjectPageIndexer` (GBrain syncHook)
and passes it into `buildOnboardingFinalize` (optional dep; omitted on the LLM-less
path).

**Tests.** `gateway/realmode-composer/__tests__/build-project-kickoff.test.ts`
(gate picks meaty-vs-prompt; draft-doc writes + presents a valid `docs:/` marker +
indexes; create-if-missing never clobbers; deadline offer names only related
upcoming deadlines and is offer-only; overdue/far-future excluded; thin hobby →
questions; rich hobby → research doc; compose failure degrades correctly).
`build-onboarding-finalize.test.ts` (hobby materialization from
`non_work_interests` + `inferred_interests`; hobby/work same-name dedup; dropped
hobby excluded; kickoff body emitted under the single opening dedupe slot with the
deterministic fallback for declined projects).
