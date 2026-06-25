# AS-BUILT

Running log of notable build-time changes, what shipped, and why. Newest first.

## 2026-06-25 — Wedged-interactive-prompt detect + recover (P0 flagship)

**What shipped.** `runtime/adapters/claude-code/persistent/wedged-prompt-detector.ts`
— the first content detector built on the just-merged F1/F2/F3 PTY substrate
(#54). When `claude` renders an `AskUserQuestion` / arrow-menu mid-turn the REPL
deadlocks (no keystroke path from chat); rather than let the 5-min inactivity
watchdog KILL the agent, this recognises the wedge and clears it with a bounded
escape→escape→ctrl-c ladder (Ryan 2026-06-25 SPEC Decisions Log: detect+RECOVER,
not kill). Ports Vajra's `pane-scan-watchdog.ts isWedgedInteractivePrompt /
runWedgedRecovery`.

- **Detect — all gates ported verbatim** over a bottom-54 ring window:
  **(0)** reject the normal live/working chrome (`⏵⏵` / `bypass permissions` /
  `esc to interrupt` / `? for shortcuts`); **(a)** a footer with `enter to
  select` + `to navigate` + `esc to cancel` inside the bottom-24; **(b)** a live
  cursor `/^❯\s*\d+\./` in the ~30 lines above the footer; **(c)** a `seenLastTick`
  2-tick stability gate. The F3 doc-quote guard + the `^❯` line anchor reject a
  fenced / `>`-quoted / backtick-wrapped menu.
- **Recover — bounded ladder with verify between each step.**
  `writeKey('escape')` → re-read ring → verify cleared → `escape` → verify →
  `ctrl-c` → verify. A failed re-capture (`null`) counts as NOT-cleared so it
  escalates. **NEVER auto-picks** (only escape/ctrl-c, never a digit/Enter). On a
  persistent block: surface the question to the active turn's chat channel +
  ONE operator alert (`postWedgeAlert`).
- **Wiring.** Registered on the session `OutputScanner` (no `keys` — recovery is
  the verify ladder). `runOutputScan` (shared helper) drives it from BOTH the
  `onData` callback AND the per-turn liveness keepalive — a STATIC wedge emits no
  further output, so the keepalive cadence is what satisfies the 2-tick stability
  gate. `session.wedgeRecovering` guards the async ladder against concurrent
  relaunch. Refactor: `pty-text.ts` now exports `stripAnsi` (ANSI gone, line
  structure kept) for the `^❯` anchor; `output-scan.ts` exports
  `buildDetectorContext` for the ladder's verify re-read.
- **Tests.** `__tests__/wedged-prompt-detector.test.ts` (19): all-gates fire,
  each gate's negative, doc-quoted menu does NOT fire, 2-tick stability,
  ladder escalates escape→escape→ctrl-c with verify, null-recapture keeps
  escalating, persistent-block surfaces+alerts, NEVER auto-picks. `tsc` clean;
  affected persistent suites green (substrate+supervision 34, F1/F2/F3 siblings 48).

## 2026-06-25 — GBrain memory auto-upgrade + doctor (the cc-update-doctor analogue)

**What shipped.** `gbrain-memory/gbrain-doctor.ts` — a deterministic, NO-LLM
engine that keeps the GBrain memory binary CURRENT and VERIFIED, modeled on
Vajra's `cc-update-doctor` (which keeps Claude Code current). Closes the
follow-on gap from PR #51: `ensure_gbrain` pinned a point-in-time snapshot of an
UNPINNED default branch with no upgrade path and no health check — "the binary
exists" was all it ever proved.

- **DOCTOR — `neutron doctor`.** Verifies gbrain actually WORKS via three
  ordered, short-circuiting checks: (1) `gbrain` on PATH (`Bun.which`), (2) the
  binary responds (`gbrain --version` exits 0), and (3) a real **memory
  round-trip** — connect → `put_page` → empty-query `list_pages` read-back of a
  sentinel slug, through the PRODUCTION transport (`GBrainStdioMcpClient` →
  `GBrainMemoryStore`) against an EPHEMERAL throwaway brain (a temp
  `GBRAIN_HOME`), so it exercises the live code path without touching the
  owner's brain and needs no embedder (keyword/page store only). Catches the
  present-but-broken case "binary exists" misses. Downstream checks are recorded
  `skipped` when a prerequisite fails.
- **AUTO-UPGRADE — `neutron doctor --upgrade`.** Resolves the latest upstream
  commit (`git ls-remote https://github.com/garrytan/gbrain HEAD`) and
  re-installs ONLY when it advanced past the recorded ref — IDEMPOTENT. Pins to
  the resolved commit (`bun install -g github:garrytan/gbrain#<sha>`) for
  reproducibility (gbrain ships no semver release tags, only an
  `eval-run-*-baseline`). Re-runs the doctor to VERIFY; an upgrade that breaks
  the round-trip ROLLS BACK to the previously-recorded ref (the cc-doctor
  contract). State (`installed_ref`, `verified_ok`, `last_check_iso`) persists
  at `<NEUTRON_HOME>/gbrain-doctor.json`. Honors the `NEUTRON_GBRAIN_INSTALL_CMD`
  test seam (same one `ensure_gbrain` uses).
- **Host-level scheduling, never in-process.** Neutron runs GBrain in **notify**
  mode inside a running instance and NEVER silently auto-upgrades there — a
  memory-substrate schema change mid-session is volatile state the owner must
  gate (`gbrain-memory/version-notice.ts`). So the cadence runs OUT of the
  instance: `install.sh` (after a successful `ensure_gbrain`, opt-out aware)
  calls `neutron-service.sh install-doctor`, which writes a launchd
  `StartInterval` agent (macOS) / systemd oneshot + `.timer` (Linux) running
  `neutron doctor --upgrade` daily — the same boundary `cc-update-doctor` runs
  at. Best-effort + non-fatal: a scheduling failure never aborts the install
  (the doctor stays runnable by hand). `uninstall.sh` tears the schedule down.
- **CLI.** `bin/neutron doctor [--upgrade] [--json] [--force]` (added to the
  usage banner); `neutron-service.sh` gains `doctor`, `install-doctor`,
  `uninstall-doctor`, `print-doctor`.

**Testability.** Pure decision logic (`runDoctor`, `decideUpgrade`, `runUpgrade`,
`resolveLatestUpstreamRef`, state I/O) is separated from the real probes/runner
and exhaustively unit-tested with injected doubles —
`gbrain-memory/__tests__/gbrain-doctor.test.ts` (24 tests): working-vs-broken
doctor detection + short-circuit, idempotent upgrade decision, install-failure
preserves the old ref, broken-upgrade rollback, first-install-broken-no-rollback.
`tsc` clean (root + `gbrain-memory`); full `gbrain-memory` suite green (88).
## 2026-06-25 — PTY terminal-detection FOUNDATIONS (F1+F2+F3)

**What shipped.** The substrate the entire Vajra→Neutron terminal-detection +
keystroke port depends on, as ONE coherent layer in
`runtime/adapters/claude-code/persistent/`. Detectors themselves (P0 prompt-wedge,
P1 auto-approve / compact-resume / rate-limit-stop) are explicitly OUT of scope —
they register on this substrate in follow-on PRs. Source of truth:
`docs/research/vajra-terminal-detection-keystroke-port-2026-06-25.md`.

- **F1 — public ring-read accessor (`pty-ring.ts`, NEW).** `PtyRing` +
  `bottomNLines`. Promotes the debug-gated 16 KB closure ring (`debugRing()`,
  `NEUTRON_REPL_DEBUG`-only) to a real, always-on `getRecentOutput({ bottomN?,
  normalize? })` on `ReplSession`. Widened 16 KB → 64 KB so bottom-N positional
  guards can see content rendered below the footer (Robobuddha 2026-06-16).
  Line-addressable bottom-N slice + optional `normalizePtyText` collapse.
- **F2 — structured keystroke API (`keystrokes.ts`, NEW + `PtyChild`).**
  `encodeKey`/`encodeKeys` map named keys (enter/escape/ctrl-c/tab/up/down/left/
  right/digit) to exact terminal bytes; `PtyChild.writeKey`/`writeKeys` (optional,
  backward-compatible extension) wired in `bun-terminal-host.ts`. Lets recovery
  detectors navigate Ink arrow-pickers + send Escape/Ctrl-C, which raw
  `write('\r')` couldn't. Substrate `sendKeys` degrades to `write(encodeKeys(…))`
  for fakes lacking the methods.
- **F3 — output-scan tick (`output-scan.ts`, NEW).** `OutputScanner` +
  `stripDocQuotes`. Generalizes the inline `onData` disclaimer check into a
  detector-registration framework (`{ id, present, keys, bottomN?, debounceMs? }`)
  — NOT a competing scan loop; it runs from the same `onData` hook. The four
  Vajra invariants are baked in: edge-triggered LATCHED firing, doc-quote guards
  (fenced/diff/bullet/inline-backtick), bottom-N positional guards (default 24),
  and per-detector debounce STAMPED BEFORE the caller's keystroke write
  (fire-once on transport failure — no double-Enter on an approval prompt).
- **Wiring (`persistent-repl-substrate.ts`).** `normalizePtyText` extracted to a
  shared `pty-text.ts` (single source of truth, imported by substrate + ring +
  scanner). The ring closure + inline disclaimer check are replaced by
  `session.ring` + `session.scanner` with the disclaimer registered as detector
  `dev-channel-disclaimer` (bottom-200, `keys:['enter']`). The timeout-tail debug
  log now reads `session.getRecentOutput()` (always available, no longer
  `NEUTRON_REPL_DEBUG`-gated). Behavior of the disclaimer dismiss is preserved.

**Spec conformance (5-line diff).** F1 = `getRecentOutput` on `ReplSession`,
`{bottomN}` ✓ widened to 64 KB ✓ reuses `normalizePtyText` ✓. F2 =
`writeKey('enter'|'escape'|'ctrl-c'|'up'|'down'|<digit>)` + multi-key ✓ correct
escape bytes ✓. F3 = onData-extended scan ✓ edge-latch ✓ doc-quote ✓ bottom-24 ✓
debounce-before-await ✓ clean detector-registration API ✓.

**Audit flag (live Ink-prompt signatures).** A real `claude` PTY spawn was not
available in this build env, so NO new signature strings were invented. The ONE
signature carried (`DEV_CHANNEL_DISCLAIMER_RE`) is the already-production-proven
disclaimer matcher, unchanged. F3 is structured so each detector's `present`
predicate + signature is a one-line edit — the P0/P1 PRs MUST validate their
ported signature strings against a live Neutron PTY frame before wiring (Vajra's
tmux-capture bytes may differ from Neutron's Bun-PTY render).

**Tests.** NEW `__tests__/pty-ring.test.ts` (bottom-N read, normalize, widened
bound, trailing-newline), `__tests__/keystrokes.test.ts` (every byte encoding +
multi-key + unknown-throws), `__tests__/output-scan.test.ts` (edge-latch,
fire-once-on-retry, debounce floor, doc-quote inline/fenced/diff, bottom-N,
disclaimer-style detector, duplicate-id throw). 38 new tests pass. The full
persistent `__tests__/` dir = 287 pass / 0 fail on the real source (the lone
`dev-channel-exit-on-close` red is a nested-`.worktrees/` `@modelcontextprotocol/
sdk` resolution artifact — passes on the main checkout, `dev-channel.ts`
untouched).

**Verify.** `bunx tsc --noEmit` — no new errors in any touched file (the
dev-channel MCP-SDK + `@neutronai/*` dual-worktree resolution noise is the same
pre-existing aliasing artifact prior entries document).

## 2026-06-25 — Installer self-installs the GBrain memory binary (parity gap #1, P0)

**What shipped.** `install.sh#ensure_gbrain` — the installer now provisions
Neutron's real memory substrate so a fresh self-host has knowledge-graph +
semantic recall out of the box. The runtime (`gbrain-memory/`) spawns
`gbrain serve` over stdio MCP; before this change `install.sh` had ZERO gbrain
references, so the `gbrain` binary was never on PATH and memory degraded SILENTLY
to on-disk entity pages (latched after the first `Executable not found in $PATH:
gbrain` — `gbrain-memory/memory-store.ts#isGbrainBinaryMissingError`). Closes
gap #1 of the 2026-06-25 Vajra→Neutron parity audit.

- **Default install.** In the Dependencies phase (right after `bun install`),
  `ensure_gbrain` runs `bun install -g github:garrytan/gbrain` (the canonical
  path from GBrain's README; binary lands in `$BUN_INSTALL/bin`, which the step
  ensures is on PATH). Source ref overridable via `NEUTRON_GBRAIN_REF`.
- **Idempotent.** An already-present `gbrain` (re-install / hand-install) is
  detected and the install command is skipped.
- **Non-fatal + LOUD on failure (the audit's core requirement: never silently
  degrade).** If the install fails or the binary can't be resolved on PATH, the
  installer reports the gap — a `Memory: DEGRADED` line in the final banner plus
  the exact `bun install -g …` recovery command — and CONTINUES; the runtime's
  graceful-degradation path (entity pages on disk) stays intact.
- **Opt-out.** `--no-gbrain` / `NEUTRON_SKIP_GBRAIN=1` skips the install and
  reports the degraded state the same way.
- **Banner.** Both the fancy and plain "Ready" panels now carry a `Memory` line
  (GBrain installed vs DEGRADED) so the memory state is never invisible.

**Why no runtime change.** The graceful-degradation logic
(`build-gbrain-memory.ts` boot probe + `gbrain-stdio-client.ts` latched
`GBrainUnavailableError`) already existed and is correct; the only missing piece
was the installer never putting the binary on PATH. Pure installer + docs + test
change; the memory runtime is untouched.

**Tests.** `tests/integration/install-gbrain.test.ts` — 7 cases over the new
`NEUTRON_INSTALL_PRINT_GBRAIN` seam (install-ok, idempotent, install-failed,
binary-not-on-PATH, `--no-gbrain`, `NEUTRON_SKIP_GBRAIN`, `NEUTRON_GBRAIN_REF`
override), all via an injected `NEUTRON_GBRAIN_INSTALL_CMD` so no network. 7 pass
/ 0 fail; existing `install-auth-gate.test.ts` still 8/8; `sh -n install.sh`
clean.

## 2026-06-24 — Trident: fleet premature-completion / cross-model-review wedge reconciliation

**What shipped.** The first high-value Vajra→Neutron fix-reconciliation pass
(SPEC.md WAVE 2 step 22 checkpoint), porting Vajra's fleet premature-completion /
cross-model-review-wedge fixes (Vajra PR #164 + #160) onto Neutron's in-process
Trident substrate. Two changes:
- **`trident/substrate-dispatch.ts` — false-completion race.** A Forge/Argus turn
  whose substrate event stream ends WITHOUT a terminal `completion`/`error` event
  now maps to `failed` (was `completed`). The persistent-REPL substrate always
  settles a real turn with a terminal event before closing its channel, so a
  terminal-less close is a paused/abnormally-closed turn — NOT a confirmed finish.
  Classifying it `completed` silently advanced the build as if it succeeded (the
  subagent-wait → Stop-hook false-completion race). The session manager treats any
  non-`completed` status as a crashed sub-agent, so the run is now recovered/failed
  loudly. Open analog of Vajra #160 "paused ≠ finished".
- **`trident/prompts.ts` — `FORGE_SYSTEM_PROMPT` cross-model-review hard rule.**
  OPEN THE PR FIRST then review; review is BEST-EFFORT and never gates the PR or
  blocks the turn; NEVER end the turn to await an async/background review (run it
  synchronously inline or skip — nothing resumes a yielded headless turn). Open
  analog of Vajra #164's `prompts/forge.md` rewrite.

**Why no codex stop-gate pin.** Vajra #164 also pinned the openai-codex plugin's
`stopReviewGate:false` at spawn. That plugin is **not part of Neutron-open's repo
surface** (the only in-repo "codex" is the unrelated GPT-5.5 Codex CLI *model
adapter*), so the durable Open defense is the prompt + the dispatch-level
false-completion guard, not a per-worktree gate pin. Full per-change port/skip
audit: `docs/research/vajra-neutron-fix-reconciliation-2026-06-24.md`.

**Tests.** `trident/substrate-dispatch.test.ts` +1 (stream-ends-without-terminal
→ failed); `trident/vajra-fixes.test.ts` +1 `FIX 9` block (3 cases: PR-first
ordering, best-effort marking, ban on yielding the turn). 63 pass / 0 fail across
the three touched trident suites; `tsc -p trident/tsconfig.json` clean.
## 2026-06-24 — Credential management: onboarding OPTIONAL-key offers (WAVE 1)

**What shipped.** `onboarding/optional-keys.ts` — the single source of truth
for the up-front OPTIONAL credential questions onboarding asks: an OpenAI key
(`openai_api_key`) and Codex auth (`codex_auth`). Each is strictly optional;
the system runs fully on Claude Max OAuth (or a BYO Anthropic key) alone, and
skipping any offer leaves the system fully working. A provided key is
validated and persisted through the **existing** `auth/api-key-store.ts:
ApiKeyStore` (the same store the admin add/rotate UI and the runtime
credential resolver already use — one key path, not two), and each stored key
ADDITIVELY activates its capability.

**Why reuse, not rebuild.** The admin add/rotate path (`app/app/admin.tsx`)
and `ApiKeyStore` already existed; the missing piece was the front-door offer
during onboarding. `storeOptionalKey()` is the shared seam both onboarding and
a future admin endpoint call.

**Activation.**
- `openai_api_key` → `ApiKeyStore(provider='openai')` → resolvable by
  `gateway/realmode-composer/resolve-llm-credentials.ts` (→
  `auth/byo-api-key-fallback.ts:buildBYOApiKeyPool`), activating the OpenAI /
  GPT-5 API adapter (cross-model trident reviews). The same key backs cloud
  embeddings (`gbrain-memory/embedder-config.ts`), which still require the
  explicit `NEUTRON_EMBEDDINGS=openai|auto` opt-in — the deliberate cost guard,
  unchanged. (Ties to the WAVE-2 conditional embedding-store, PR #31.)
- `codex_auth` → the Codex CLI subscription OAuth (`codex login`) is a
  HOST-level credential under `CODEX_HOME`, not a per-instance paste secret
  (the `ApiKeyProvider` enum has no `codex`), so the offer surfaces it as
  guidance; a platform key via the OpenAI offer drives the same reviews.

**Boundary + decoupling.** `@neutronai/onboarding` stays decoupled from
`@neutronai/auth`: the module depends on a narrow `OptionalKeyApiKeyStore`
interface (the real `ApiKeyStore` satisfies it structurally), mirroring the
engine's `MaxOauthSecretsStore` pattern. No new package dependency, no phase
enum / `LEGAL_TRANSITIONS` change (the optional keys are additive to the
substrate choice, not a new gate, so the phase-walk matrix is untouched).

**Phase wiring.** The credential step (`max_oauth_offered`) knowledge pack in
`phase-spec-resolver.ts` gains `optional_openai_key` / `optional_codex_auth`
FAQs + answer-tangents derived from the canonical offer registry, so the
onboarding agent answers in lockstep with what `storeOptionalKey` persists.

**Scope boundary (Codex review P2).** This slice ships the offer registry, the
storage primitive, and the conversational surfacing — NOT yet an interactive
paste collector that fires in every run. Deliberate, because the *activating
sink* differs by deployment tier and a complete wire is a larger,
security-sensitive change: managed reads `ApiKeyStore` (what the integration
test proves), but **open self-host** resolves credentials from **env**
(`open/composer.ts:resolveOpenLlmPool` is Anthropic-env-only; the GPT adapter +
gbrain embedder read `OPENAI_API_KEY` / `NEUTRON_EMBEDDINGS_*` from the owner
`.env`), so open-mode activation means writing the owner env file + restart,
not an `ApiKeyStore` row. The primitive is landed + proven first; the
interactive collector + the per-tier intake closure (managed: `ApiKeyStore`
hook; open: env-file writer) are the explicit next slice. The byte-pinned
onboarding engine credential branch is intentionally left untouched here.

**Tests.** `onboarding/__tests__/optional-keys.test.ts` (pure unit, in-memory
fake store: offers exposed + optional; valid key stored; invalid rejected
without write; idempotent re-paste; codex guidance-only; skip = no write) and
`tests/integration/onboarding-optional-keys-activate.open.test.ts` (real
`ApiKeyStore` + `SecretsStore` + `resolveLlmCredentials`: provided OpenAI key
→ stored → resolver returns a BYO pool [ACTIVATED]; skipped → no OpenAI surface
while Claude/Anthropic still resolves). tsc clean; phase-knowledge invariants
green.

## 2026-06-24 — Skill Forge runtime: auto-skillify completed workflows (WAVE 4)

**What shipped.** A new `@neutronai/skill-forge` package (top-level `skill-forge/`)
that audits a *completed multi-step workflow* and, gated by an explicit
propose-then-approve step, distills it into a saved, re-invokable skill — so a
workflow Ryan develops once becomes a registered, agent-discoverable skill
without hand-authoring. It NEVER auto-creates a skill silently: a skill file
only ever lands on disk via an explicit `approve`.

**Why the conventions dir is the registration target.** The realmode composer's
skills-loader (`gateway/realmode-composer/skills-loader.ts`, wired in
`build-phase-spec-resolver.ts:resolveSkillsDir`) already reads
`<owner_data_dir>/skills/conventions/*.md` on every LLM turn and splices them
into the system prompt. So "register a skill" = write that markdown file: it is
immediately agent-discoverable AND — being on disk — survives a fresh session
with ZERO new wiring. (The alternative `<available_skills>` SkillRef list in
`runtime/system-prompt.ts` is fed `active_skills: []` by the live composer, so
the conventions loader is the real, working skill surface — that is what Skill
Forge plugs into.)

**The pieces (`skill-forge/`).**
- `detector.ts` — `auditWorkflow()`, the first gate: a workflow is skill-worthy
  only if it succeeded and is a genuine multi-step procedure (≥2 *distinct*
  normalized actions — a single tool run N times is not a procedure).
- `signature.ts` — `workflowSignature()`, a stable hash of the workflow's
  normalized step *shape* (not its per-run args). The dedupe key.
- `distiller.ts` — deterministic distillation (no LLM/network) of a workflow
  (+ optional user edits) into a `SkillDraft` and the convention markdown
  (`renderSkillMarkdown`): title, an "ALWAYS use when…" trigger block, a
  what-it-does paragraph, the numbered procedure, and the artifacts.
- `proposals-store.ts` — `SkillForgeProposalsStore` over `skill_forge_proposals`
  (migration `0086`): pending → approved | declined, with dedupe by signature
  and the registered `skill_path` recorded on approve.
- `registrar.ts` — writes the skill into `skills/conventions/<name>.md`, never
  clobbering an existing convention (collision-suffixes `-2`, `-3`, …).
- `forge.ts` — the `SkillForge` orchestrator: `onWorkflowCompleted()` audits →
  dedupes → persists a PENDING proposal → notifies via an injected
  `ProposalNotifier` (no skill written); `approve(id, edits?)` distills +
  registers + marks approved; `decline(id)` marks declined and creates nothing.
- `proposal-message.ts` — the user-facing proposal text (name + triggers +
  what it does + artifacts + the approve/decline affordance).
- `trident-adapter.ts` — `completedWorkflowFromTridentRun()` maps a terminal
  (`done`) Trident run — the runtime's canonical multi-step workflow — into the
  generic `CompletedWorkflow`.

**Wiring posture.** The runtime + the Trident adapter ship fully tested. The
live trigger seam is the Trident tick loop's `onTerminal(run)` hook
(`trident/tick.ts`): composing Skill Forge there is one call —
`if (run.phase === 'done') await skillForge.onWorkflowCompleted(completedWorkflowFromTridentRun(run))`.
That composition (resolving the owner's `skillsDir`, bridging the notifier to
the live channel) is intentionally left as the documented next step rather than
folded into this PR, to keep the change focused and reviewable.

**Tests (`skill-forge/__tests__/`).** Acceptance is proven end-to-end against the
REAL skills-loader: a completed workflow fires a proposal carrying
name/triggers/what/artifacts while writing nothing; approve distills + registers
a skill that `loadSkills()` then discovers and that survives a loader cache reset
(fresh session); decline creates nothing; proposals persist across a DB reopen;
dedupe suppresses re-nags while pending. The migration snapshot
(`migrations/expected-schema.txt`) and runner number-list were refreshed for
`0086`.
## 2026-06-24 — `/code` foundational runner: per-worktree cwd + isolation; Code-Gen Core gateway wrapper retired

Close-out of the WAVE 2 Code-Gen acceptance: `/code <task>` runs on the
**foundational Trident runtime over the CC-subprocess substrate** (NOT direct
`@anthropic-ai/sdk`), behind NO Core gate, and the Code-Gen Core gateway wrapper
is retired.

**Audit finding (diagnostic-before-delete).** On `origin/main` PR #33 already
flipped the Open tick loop from `stubAdvanceDeps` to the real
`buildTridentOrchestrator` by threading `composition.trident.dispatch`
(`buildSubstrateTridentDispatch`) — so `/code` was already off the
`CodegenNotConfiguredError` no-op. Two gaps remained: (a)
`trident/substrate-dispatch.ts` EXPLICITLY deferred per-worktree cwd + per-build
isolation (its SCOPE NOTE), so every Forge/Argus turn ran in `owner_home`, not
the run's worktree; (b) the Code-Gen Core gateway WRAPPER — including a
direct-`@anthropic-ai/sdk` runner — was still present (dead in Open prod: nothing
under `open/` calls it).

**1. Per-worktree cwd + per-build isolation (the substantive correctness fix).**
`buildSubstrateTridentDispatch` gains `build_substrate(cwd)` — a factory invoked
ONCE PER DISPATCH with the run's worktree (`input.repo_path`) as cwd, building a
FRESH ephemeral CC-subprocess REPL per turn. So each Forge/Argus turn runs IN its
own worktree on a disposable session: one build never inherits another's working
context, and build turns never bleed into the owner's warm conversational
(`cc-agent-*`) pool. `AgentSpec` carries no per-call cwd, so per-worktree
dispatch HAS to re-root the substrate per turn. The legacy single-`substrate`
shape is retained for the adapter-mechanics tests; exactly one of the two is
required (throws otherwise). `open/composer.ts` threads the per-worktree
ephemeral factory (was one `owner_home`-pinned `cc-trident-*` substrate). No
credential → dispatch null → `composition.trident` unset (unchanged restart-safe
stub no-op). The boot-wiring test now asserts the substrate is re-rooted at each
dispatch's `repo_path`.

**2. Code-Gen Core gateway wrapper RETIRED.** Deleted
`gateway/cores/code-gen-factory.ts` (the `CodegenLlmCall` built over a DIRECT
`@anthropic-ai/sdk` Messages-API call — the exact transport the CC-subprocess
substrate rule forbids), `gateway/cores/build-production-codegen-wiring.ts` (the
credential→orchestrator→`/code`-filter assembly), and `buildCodegenChatCommandFilter`
(the SUPERSEDED legacy `/code` Core filter) + its `gateway/index.ts` re-export +
the 3 wrapper-only gateway tests. `/code` is now EXCLUSIVELY foundational Trident.
The Core's useful parts (multi-turn dispatch loop, Forge/Argus prompts, output
parsers) were already folded into `trident/` across PR-1..PR-5.

**KEPT (out of scope — separate Core-removal).** The `cores/free/code-gen/` Core
ENGINE + its four `codegen_*` MCP tools + manifest / install-lifecycle / sidecar
(121 self-contained tests, all green) remain a Tier-2 MCP surface. Physical
deletion of the Core is the one documented remaining cleanup — it is still
referenced by those MCP tools, the install lifecycle/manifest, and the Managed
graph composer, so deleting it inline would red those suites and is a dedicated
change (consistent with the PR-5 Decisions Log boundary).

**Verify.** `bunx tsc --noEmit` clean (root + `trident/tsconfig.json`).
`bun test trident/` → 217 pass. `bun test gateway/__tests__/` → 921 pass.
`bun test cores/free/code-gen/` → 121 pass. Architectural fence
(`tests/integration/no-direct-anthropic-api.test.ts`) → pass (one fewer
direct-SDK file). Zero regressions.

### Spec-conformance diff (5 lines)
- WAVE 2 Code-Gen: `/code` produces a real artifact on the CC-subprocess
  substrate via foundational Trident — MET (runner live + now per-worktree).
- "production runner on the CC-subprocess substrate (NOT direct
  `@anthropic-ai/sdk`)" — MET (substrate-dispatch over `buildLlmCallSubstrate`).
- "no capability gate" — MET (no Core gate in the Open `/code` path).
- "retire the code-gen Core wrapper" — MET for the gateway wrapper; Core engine
  retirement documented as the remaining step.
- "fold useful parts into foundational Trident" — already done PR-1..PR-5.

## 2026-06-24 — WAVE 3 Cores: Calendar Core `/cal` composer-reachability parity

Close-out of the WAVE 3 **Calendar Core** acceptance (installs + reads/writes
the owner's primary calendar via per-Core Google OAuth; agent-native CRUD
parity; graceful degradation when not connected).

**Audit finding — the Core was already substantially complete.** On `origin/main`
the Calendar Core ships at **v0.2.0**: the production `buildGoogleCalendarClient`
(Calendar v3 REST, no SDK dep) is wired in `gateway/boot-helpers.ts` through the
shared `OAuthTokenManager` (label `google_calendar`, the SAME per-Core OAuth
plumbing Email + Google Workspace use — NOT a global token), with an
in-memory fallback (`buildInMemoryCalendarClient`) when the Cores-OAuth surface
is unmounted. Nine MCP tools (`calendar_list/create/update/cancel/brief/…`)
give the agent CRUD; the `/cal` chat commands give the user the same. tsc
clean; 131 Core tests + the gateway production-composer test (12) pass. The
manifest already declares the `oauth_token` secret the shared integrations
connect/disconnect surface (`gateway/cores/integrations.ts`) derives from.

**The one genuine gap — and the fix.** The `/cal` `ChatCommandFilter`
(`buildCalendarChatCommandDispatcher`, `gateway/cores/calendar-wiring.ts`) was
reachable ONLY from `calendar-wiring.ts`, while its sibling Cores'
filters (`buildRemindersChatCommandFilter`, `buildTridentCodeChatCommandFilter`,
`buildCodegenChatCommandFilter`) live in `gateway/boot-helpers.ts` and are
re-exported from the `gateway` entry barrel — the import site the production
composer assembles `buildChainedChatCommandFilter([...])` from. So `/cal` could
not be chained uniformly with `/remind` and `/code`, despite the dispatcher's
own doc comment saying it "composes ... via `buildChainedChatCommandFilter`".

**Added** `buildCalendarChatCommandFilter` to `gateway/boot-helpers.ts` (memoized
lazy delegation to the canonical `buildCalendarChatCommandDispatcher` — single
source of truth, no duplicated dispatch logic, no eager `scribe`/calendar-wiring
module-load, no entry-module import cycle) and re-exported it from
`gateway/index.ts` alongside the sibling builders. New regression test
`gateway/__tests__/calendar-command-wiring.test.ts` (6 tests) locks: barrel
reachability (parity with `/remind`,`/code`), `/cal show` + `/cal create`
claim-and-dispatch against the `CalendarClient`, non-`/cal` + unrecognized
`/cal` fall through to the LLM, and composition inside
`buildChainedChatCommandFilter`. Gateway tsc clean; 157 calendar+sibling tests
pass. No feature flag (standing rule) — additive wiring only.

## 2026-06-23 — WAVE 3 PR-9: retire the legacy markdown task port (`tasks/inbox/`)

Closes the WAVE 3 **Tasks** track
(`docs/plans/wave3-tabbed-interface-build-plan.md` § 3.4 #3 / § 4 PR-9,
conformance row C7). The Tasks Core is fully realized: the canonical SQLite
`tasks` table is the source of truth (migration `0032`), prioritization is
LLM-primary with deterministic fallback (PR-7), and the web Tasks tab gives
agent+user-parity CRUD (PR-8). The interim WAVE-2 PR #15 **markdown task port**
— a `task-inbox.jsonl` append-queue scanned (CLAIM→PARSE→APPLY→ARCHIVE→RENDER)
into read-only `tasks.md` / `DASHBOARD.md` projections — is therefore retired.
Per the standing rule: **no feature flags** — the dead port is removed outright,
not gated.

**§5 scanner-wiring verification (the load-bearing finding).** The plan flagged
"[needs verification]: is the task-inbox scanner boot-wired or cron/CLI-only?".
Verified: **neither.** `runTaskScan()` and `appendInboxRow()` have **zero
production callers** — the only references repo-wide were the `tasks/index.ts`
barrel re-export, the module's own internals, and its two test files. No cron
registers it (`build-core-modules.ts` wires focus-score / nudge / proactive
crons, never a task-scan), no boot shell calls it, no CLI/agent path appends to
`task-inbox.jsonl`. The AS-BUILT entry for PR #15 itself recorded the wiring as
"Deferred". So the **whole port is dead**, not "scanner-with-a-real-job" — it is
removed cleanly rather than stripped-to-ingestion.

**Removed** (all self-contained, no external importers):
- `tasks/inbox/` directory entirely — `types.ts` (JSONL row schema + parser),
  `apply.ts` (row→`TaskStore` mutation), `render.ts` (`tasks.md` /
  `DASHBOARD.md` renderers), `scanner.ts` (`appendInboxRow` + `runTaskScan`
  claim/drain loop), `index.ts` (barrel).
- `tasks/__tests__/inbox.test.ts` + `tasks/__tests__/inbox-scanner.test.ts`.
- The inbox value + type re-export blocks from `tasks/index.ts`
  (`parseInbox`, `applyInboxRows`, `renderTasksMarkdown`,
  `renderDashboardMarkdown`, `appendInboxRow`, `runTaskScan`, `TASK_SOURCE_INBOX`,
  the `Inbox*` / `TaskScan*` types, …).

**Kept untouched** (NOT the markdown port — independent, production-wired):
- The canonical `TaskStore` (`tasks/store.ts`, migration `0032`), the Tasks Core
  substrate adapter (`buildSubstrateTaskStoreBackend`), the
  `/api/app/projects/<id>/tasks` HTTP surface, focus-score + LLM prioritization,
  and all task crons.
- The **`tasks/projection/`** writer (STATUS.md / ACTIONS.md). This is a separate
  surface that subscribes to `TaskStore` mutations and is wired live in
  `build-core-modules.ts`; it does not depend on `tasks/inbox/` and is not part
  of the retired port. Its `projection.test.ts` and the gateway
  `*-tasks-projection-wiring.test.ts` regression guards stay green.

**Touch-ups:** a stale "task-scan" example in a `build-core-modules.ts` cron
comment and a `tasks/projection/format.ts` doc-comment that named the removed
`tasks.md` / `DASHBOARD.md` surface were corrected.

**Verification:** `bunx tsc --noEmit` clean; `bun test tasks/__tests__/` (165
pass / 0 fail) + the three gateway tasks/projection wiring suites (21 pass / 0
fail) green. Repo-wide grep for every inbox symbol confirms no lingering
reference outside the removed files.

## 2026-06-23 — WAVE 3 PR-6: Documents parity (web edit) + Obsidian retire close-out

Closes the WAVE 3 **Documents** track
(`docs/plans/wave3-tabbed-interface-build-plan.md` § 3.3 / § 4 PR-6, conformance
rows C5 + C6). PR-5 shipped the web Documents tab as **read + comment**; mobile
already had **edit + comment**. This PR brings the web tab to full **web↔mobile
parity** (browse · open · read · **edit** · comment) and closes out the Obsidian
retirement. Per the standing rule: **no feature flags** — edit renders directly.

**Spec-conformance diff (5 lines):**
- C5 (Documents list/view/**comment**, every project): web had read+comment
  (PR-5), mobile had edit+comment → web now **edits** too ⇒ parity reached.
- C5 **§5 "does MOBILE docs already render comments?" → VERIFIED YES.** The
  mobile docs tab (`app/app/projects/[id]/docs.tsx`) already mounts a full
  comment UI: `CommentsSidePane` + `CommentsProvider` with reply / **Resolve** /
  **Escalate to chat** and an editor/preview/comments tri-pane. **No mobile
  comment-parity work was needed** — the plan's "needs-verification" item is
  resolved in code, not built.
- C5 gap was therefore **web edit only** (the one capability mobile had and web
  lacked) — shipped here.
- C6 (Obsidian RETIRED): **VERIFIED no daily-driver doc flow depends on
  Obsidian.** Doc bodies are filesystem-backed; the agent reads via
  `doc_search`/`doc_read`; the app reads/edits/comments over
  `gateway/http/app-docs-surface.ts`. The Documents tab is now the primary +
  only per-project doc surface on web AND mobile.
- Residual `obsidian` mentions are accurate "Obsidian-replacement" labels on this
  surface or the operator platform's *separate* `vault.example.test` deeplink
  convention for the owner's own vault (legacy Nova prompts, not load-bearing) —
  neither is a project document flow, so nothing to repoint.

**What changed (web client only — no gateway/backend changes; the
`PUT /docs/file` handler with OCC already existed and is what mobile uses).**
- **`chat-react/docs-client.ts`** — added `WriteResult` type, `WriteResponse`,
  and `WebDocsClient.writeFile(project_id, { path, content, expected_modified_at })`
  → `PUT /docs/file`. `expected_modified_at` is the OCC baseline; a stale write
  gets a `409 doc_modified_conflict` (`DocConflictError`) rethrown as a typed
  `DocsClientError` carrying `current_modified_at`. Mirrors `app/lib/docs-client.ts`.
- **`chat-react/DocumentsTab.tsx`** — added **edit mode**: an **Edit** button in
  the viewer header swaps the read-only `<pre>` for a raw-markdown `<textarea>`
  seeded from the open file; **Save** (disabled until the draft differs) writes
  via `writeFile` with `expected_modified_at = file.modified_at`. On success it
  adopts the server's post-write `modified_at` as the next baseline, exits edit
  mode, and reloads comments (anchors re-anchor server-side). On a `409`
  (`doc_modified_conflict`) it stays in edit mode with the draft preserved and a
  "changed since you opened it" prompt; `doc_too_large` (5 MB) is surfaced too. A
  `saveSeq` guard drops a stale save continuation if the user opens another doc /
  switches project before the PUT resolves (same pattern as the read/comment
  paths); those navigations also clear `saving` so the bailed continuation can't
  leave the controls stuck-disabled. Edit state resets on doc open and project
  switch.
- **`chat-react.html`** — `cdoc-editor` / `cdoc-edit-btn` / `cdoc-edit-actions`
  CSS for the editor + header buttons.

**Tests.** `docs-client.test.ts` +3 (writeFile PUT body + OCC, force-write omits
the baseline, 409 → typed error with `current_modified_at`).
`documents-tab.test.tsx` +3 happy-dom (Edit→change→Save PUTs the new content with
the OCC baseline and returns to the read view with comments reloaded; a 409
`doc_modified_conflict` keeps edit mode with the draft + conflict message;
navigating away mid-save doesn't leave Save stuck-disabled). Full
`landing/chat-react/` suite green (**77 pass**, was 71), `tsc -p
chat-react/tsconfig.json` clean, browser bundle builds.
## 2026-06-23 — WAVE 3 PR-8: web Tasks tab (LLM-prioritized, agent+user-parity CRUD)

Tasks-track PR of the WAVE 3 build
(`docs/plans/wave3-tabbed-interface-build-plan.md` § 3.4 item 2, PR-8). Fills the
builtin **Tasks** tab in the web `ProjectShell` (PR-4) with its real view: a
dynamic React/AJAX list of the project's tasks rendered in the **LLM-primary
prioritized order** shipped in PR-7 (`tasks/prioritize-llm.ts`), with
agent+user-parity CRUD (add / complete / reprioritize / cancel / delete). Per the
SPEC Decisions Log (2026-06-23) **no feature flags** — the tab renders directly.
This is the per-project Tasks tab; the global cross-project roll-up stays
v2-deferred (plan C11).

**Order is the engine's, not the client's.** The list fetches with
`order=focus_score`, the PR-7 prioritized ordering: ranked rows first by
`llm_rank`, fresh rows interleaved by `focus_score`. The tab NEVER re-sorts — the
store (`tasks/store.ts`) is the single source of truth — so what the agent ranked
is what the user sees. Each row surfaces its `llm_rank` (`#N`) and the LLM's
one-line `llm_reason`.

**Agent + user parity.** Every action hits the SAME canonical `TaskStore` the
agent's `cores/free/tasks` backend writes (`buildSubstrateTaskStoreBackend`), over
the existing `gateway/http/app-tasks-surface.ts` surface — **no gateway/backend
changes**. Reprioritize is a PATCH of the 0-3 `priority` field (the column the
focus-score reads), so a user nudge feeds the next prioritize pass. The server
returns the canonical row and the list re-fetches after every mutation, so the
order reflects the store immediately.

**What changed (web client only).**
- **`chat-react/tasks-client.ts`** (new) — `WebTasksClient`, the web twin of
  `app/lib/tasks-client.ts`: bearer-auth (`config.token`) fetch wrapper, base URL
  `config.origin`, wire types re-declared client-side (bundle stays gateway-free,
  same convention as `docs-client.ts` / `tabs-client.ts`). Methods: `list`
  (defaults to `order=focus_score`), `create`, `update`, `complete`, `cancel`,
  `delete`. Pure helpers: `priorityLabel` (0-3 → P0..P3), `clampPriority`,
  `formatDue`. Typed `TasksClientError`.
- **`chat-react/TasksTab.tsx`** (new) — the tab view: a status filter
  (Open / All), an add-task composer, and a prioritized task list. Each row shows
  rank + reason + priority/due chips and Raise/Lower/Done/Cancel(or Delete)
  actions. Monotonic `listSeq` guard (slow fetch can't land after a newer one),
  per-row `busyId` in-flight guard, and a project-change reset effect so a stale
  list from project A never lingers under project B.
- **`chat-react/ProjectShell.tsx`** — `TabContent` now renders `<TasksTab>` for
  the builtin `tasks` mount target (was the PR-4 "coming soon" placeholder); the
  placeholder remains the fallback for any not-yet-built builtin tab.
- **`chat-react.html`** — `.ctask-*` styles mirroring the `.cdoc-*` block.

**Tests.** `chat-react/__tests__/tasks-client.test.ts` (client + helpers, pure
injected fetch) and `chat-react/__tests__/tasks-tab.test.tsx` (happy-dom: list
renders prioritized server order with rank+reason; complete → POST /complete +
re-fetch; reprioritize → PATCH priority; add → POST title + re-fetch).
`bun test landing/chat-react/__tests__/` → 86 pass. Leaf tsc clean
(`bunx tsc -p landing/chat-react/tsconfig.json`).

## 2026-06-23 — WAVE 3 PR-5: web Documents tab (list · view · comment)

First PR of the WAVE 3 **Documents** track
(`docs/plans/wave3-tabbed-interface-build-plan.md` § 3.3, PR-5). Fills the
builtin **Documents** tab in the web `ProjectShell` (PR-4) with its real view —
the Obsidian-replacement read+comment surface. Per the SPEC Decisions Log
(2026-06-23) **no feature flags**: the tab renders directly, no toggle.

**Source of truth stays the FILESYSTEM.** No `documents` table is added; the tab
reads + comments over the EXISTING gateway handlers
(`gateway/http/app-docs-surface.ts`: `/docs/tree`, `/docs/file`,
`/docs/comments*`). Read + comment first — editing is deferred to PR-6.

**What changed (web client only — no gateway/backend changes).**
- **`chat-react/docs-client.ts`** (new) — `WebDocsClient`, the web twin of
  `app/lib/docs-client.ts`: bearer-auth (`config.token`) fetch wrapper, base URL
  `config.origin`, wire types re-declared client-side (bundle stays gateway-free,
  same convention as `tabs-client.ts`). Methods: `tree`, `readFile`,
  `listComments`, `getThread`, `postComment`, `replyToComment`, `resolveComment`,
  `escalateToChat`. Pure helpers: `flattenDocFiles` (tree → markdown leaves),
  `buildAnchor` (raw-offset selection → clamped anchor), `clampUtf8` /
  `byteLength` (respect the gateway's 1024-byte excerpt / 256-byte context caps).
- **`chat-react/DocumentsTab.tsx`** (new) — three-pane view: doc **list** (left,
  `flattenDocFiles` over `/docs/tree`) · markdown **viewer** (centre, RAW
  selectable markdown so comment anchors map 1:1 to file offsets) · **comments**
  side-pane (right). Select text → **Comment** (root, anchored via `buildAnchor`);
  expand a thread → reply / **Resolve** / **Escalate to chat**. Active threads vs
  a muted **Resolved** group. Per-fetch monotonic seq guards so a slow file /
  comments response can't land after a newer one; full reset on project switch.
- **`chat-react/ProjectShell.tsx`** — the `docs` builtin tab now renders
  `<DocumentsTab>` (was the "coming soon" placeholder); Tasks keeps the
  placeholder until PR-8. `TabContent` now receives `projectId` + `config`
  (+ test `fetchImpl`).
- **`chat-react.html`** — `cdoc-*` CSS for the three-pane Documents layout.

**`comments_unavailable` gate (plan §5 VERIFY — handled).** The comments
substrate is optional on the gateway; when absent the four `/docs/comments…`
routes return `503 comments_unavailable` (`app-docs-surface.ts:193`).
`WebDocsClient.listComments` treats that ONE code as a first-class non-error —
resolves to `{ unavailable: true, threads: [] }` — while every other non-2xx
still throws. The Documents tab then **still lists + views docs**, hides the
comment composer, and shows a one-line "comments aren't available" note instead
of an error toast. Verified by a unit test (503 → degrade, 400 → still throws)
and a happy-dom component test.

**Spec-conformance diff (plan §5, ≤5 lines).**
1. SPEC C5 "Documents tab — list/view/**comment**, web none" → web Documents tab
   now lists (`/docs/tree`), views (`/docs/file`), comments (`/docs/comments*`).
2. Plan §3.3 "keep filesystem as source of truth, no `documents` table" → honoured
   (zero gateway/schema changes; reuses existing handlers).
3. Plan §3.3 "Editing can ship read+comment first" → this PR is read+comment; edit
   is PR-6.
4. Plan §5 VERIFY "`comments_unavailable` gate — degrade gracefully" → handled +
   tested (list/view survive; composer hidden).
5. No feature flag (SPEC Decisions Log 2026-06-23) → tab renders directly.

**Tests** — `chat-react/__tests__/docs-client.test.ts` (19 pure: routes, the 503
gate, `buildAnchor`/`clampUtf8`/`flattenDocFiles`) + `documents-tab.test.tsx`
(3 happy-dom: list renders, doc opens + comments list, selection→comment post
round-trip, the unavailable gate). Updated `project-shell.test.tsx` (Documents
switch now asserts the real `DocumentsTab` mounts, not the placeholder). Full
`landing/chat-react/` suite green (71 pass) + `tsc -p
landing/chat-react/tsconfig.json` clean + browser bundle builds.
## 2026-06-23 — WAVE 3 PR-7: LLM-primary task prioritization

Tasks-track PR of the WAVE 3 build (`docs/plans/wave3-tabbed-interface-build-plan.md`
§ 3.4, PR-7). Flips task **prioritization** from deterministic-only to
**LLM-primary, deterministic-fallback**. The canonical `tasks` store already
carried a deterministic `focus_score` (`tasks/focus-score.ts`, formula = priority
+ due-date + staleness). That formula has no notion of *what the work is*, so
equally-urgent tasks tie and sort by recency. WAVE 3 hands the open backlog to an
LLM that returns an explicit ordering + a one-line rationale per task. Per the
SPEC Decisions Log **no feature flags** — the plan's `NEUTRON_TASKS_LLM_PRIORITY`
gate is disregarded; LLM-primary is the default and deterministic is a genuine
fallback path (no LLM credential / call errors / times out / returns garbage),
not a dual flag-path.

**What changed.**
- **Migration `0085_tasks_llm_priority.sql`** — 4 columns on `tasks`: `llm_rank
  INTEGER` (1-based rank from the last pass; 1 = do first), `llm_reason TEXT`
  (LLM rationale; NULL in the deterministic fallback), `prioritized_by TEXT
  CHECK(prioritized_by IN ('llm','deterministic'))` (which mechanism produced the
  rank), `prioritized_at TEXT` (ISO-8601). Plus a partial index
  `idx_tasks_project_llm_rank ON tasks(project_slug, llm_rank) WHERE
  status='open'` mirroring the focus-score index. `focus_score` is RETAINED — it
  is the fallback ranking AND a prior shown to the LLM. Forward-only ADD COLUMN,
  defaults NULL. `migrations/expected-schema.txt` regenerated; runner snapshot
  test green.
- **`tasks/prioritize-llm.ts`** (new) — the prioritizer. `prioritizeTasksForProject`
  ranks the FULL open set each pass (clearing every open row's rank first, so a
  row outside the prompt cap can't keep a stale rank); only the top-N by
  `focus_score` (cap 50) go to the LLM, the tail is ranked deterministically. If
  no `llm` / the call throws / times out / returns an unparseable / empty /
  out-of-domain ranking → ranks by recomputed `focus_score DESC` and stamps
  `prioritized_by='deterministic'` (reason NULL); on a valid LLM ranking → stamps
  `llm_rank` from the LLM order + `llm_reason` per task + `prioritized_by='llm'`.
  Ids the LLM omits (and the beyond-cap tail) are appended in deterministic order
  so EVERY open row gets a fresh rank (no NULL gaps, no stale ranks). All writes
  land in one `db.transaction`. Ships a cron
  (`buildTaskPrioritizeHandler` / `buildTaskPrioritizeJob` /
  `registerTaskPrioritizeCron`, handler name `tasks.prioritize_llm`, 6h default
  cadence) mirroring `tasks/focus-score-cron.ts`, plus `parseRanking` (tolerates
  ```json fences + trailing prose, drops invalid/dupe ids) and a locked v1
  prompt. Uses the same `LlmCallFn` shape + `callWithTimeout` pattern as the nudge
  engine.
- **`tasks/store.ts`** — `Task` / `TaskDbRow` / `COLS` / `rowToTask` gain the 4
  columns (create() stamps them NULL). The **`'focus_score'` order is now the
  prioritized order**: a row's sort position is its *effective rank* — a ranked
  row uses its `llm_rank`; a row created since the last pass (`llm_rank` NULL) is
  **interleaved by `focus_score`** (a correlated subquery slots it right after the
  ranked rows it outranks on `focus_score`), so a freshly-captured urgent task
  competes with the ranked set instead of being buried until the next pass. Ties
  fall to `focus_score DESC, due_date ASC NULLS LAST, created_at DESC`. Because
  every existing surface (HTTP, pick-next, projection, Tasks Core) already
  requests `order:'focus_score'`, the ranking flows everywhere with **no
  per-caller change**; with no rows ranked yet it degrades to pure focus-score
  ordering, so the change is back-compatible (all existing focus-score tests stay
  green). That is the "wire into the Tasks Core" seam.
- **`gateway/composition/`** — `tasks-input.ts` gains `enable_task_prioritize_cron`
  / `task_prioritize_interval_ms` / `task_prioritizer:{llm,model,timeout_ms,limit}`;
  `build-core-modules.ts` registers the prioritize cron (mirrors the focus-score /
  nudge-engine gates). Safe to register with a null llm — the handler runs the
  deterministic fallback until a credential is wired. "Cron switches to LLM-primary."
- **`gateway/http/app-focus-current-surface.ts`** — its hand-built `Task` literal
  + `SELECT` extended with the 4 columns so the focus-pick hero card carries its
  real ranking.

**Verify.** `bunx tsc --noEmit` clean (0 errors). `bun test tasks/__tests__/
cores/free/tasks/__tests__/ migrations/snapshot.test.ts` → 206 pass; gateway
surface/composer tests (`app-focus-current-surface`, `app-tasks-surface`,
`composition-tasks-projection-wiring`, `tasks-production-composer`) → 55 pass. New
`tasks/__tests__/prioritize-llm.test.ts` covers the LLM-ranks path, the rendered
order following the LLM ranking, omitted-id backfill, and all four fallback
triggers (no-llm / throw / timeout / unparseable / out-of-domain) plus
`parseRanking` + the cron wiring. Composition test asserts the prioritize job +
handler register when enabled.

## 2026-06-23 — WAVE 3 PR-4: web project tab SHELL (registry-driven)

Fourth and final foundation PR of the WAVE 3 tabbed-project-interface build
(`docs/plans/wave3-tabbed-interface-build-plan.md` § 3.1, PR-4). Brings the
**web** React client (`landing/chat-react/`) to tabs — it was chat-only. Per the
SPEC Decisions Log (2026-06-23) **no feature flags** — the plan's
`NEUTRON_WEB_TABS` gate is disregarded; the shell renders the resolved tabs
directly, with no dual chat-only path.

**What changed.** A new `ProjectShell` wraps the existing `ChatApp` as the Chat
tab and renders the project's tab bar from the engine resolver, so the web
project view shows tabs (Chat ∪ Documents ∪ Tasks ∪ installed Core tabs) instead
of chat-only. Mirrors the mobile shell from PR-3.

- **`chat-react/tabs-client.ts`** (new) — `WebTabsClient`, the web twin of
  `app/lib/tabs-client.ts`: a bearer-auth (`config.token`) fetch wrapper for
  `listProjectTabs(id)` against `GET /api/app/projects/<id>/tabs`, base URL
  `config.origin`. `TabDescriptor` wire shapes mirror `tabs/registry.ts`
  (re-declared client-side, same convention as mobile — keeps the browser bundle
  free of a gateway dep). Throws `TabsClientError` on 4xx/5xx/network. Exports
  `CHAT_TAB` (the pre-fetch / fallback builtin Chat descriptor) +
  `sanitizeCoreTabUrl` (http(s)-only scheme guard, ported from mobile).
- **`chat-react/ProjectShell.tsx`** (new) — the tab shell. Fetches the active
  project's tabs (none for the General/no-project view → chat-only). Chat tab =
  the existing `ChatApp`, kept MOUNTED (hidden via `hidden`) across switches so
  the chat-core session/stream/scroll survive; Documents/Tasks builtins = a
  "coming soon" placeholder (real views land in PR-5..9 — unbuilt content, NOT a
  flag); Core (`mount.kind:'webview'`) tabs = a sandboxed `<iframe>` at the
  scheme-validated URL. Switching projects re-fetches + resets to Chat; a
  vanished active tab falls back to Chat.
- **`chat-react/main.tsx`** — mounts `ProjectShell` (was `ChatApp`) inside the
  `AssistantRuntimeProvider`, so the runtime/session lives above the tabs and
  survives switching. `ChatApp` itself is unchanged.
- **`chat-react.html`** — `car-projectshell` / `car-tabs` / `car-tab` /
  `car-tab-frame` / `car-tab-placeholder` CSS; `.car-shell` height changed
  `100dvh → 100%` so the chat fills its tab panel rather than the viewport.
- **Tests** — `__tests__/tabs-client.test.ts` (pure: URL build/encode, bearer
  header, error mapping, `sanitizeCoreTabUrl`) + `__tests__/project-shell.test.tsx`
  (happy-dom over a real `WebChatSession` + injected resolver fetch: the bar
  renders the resolved set Chat/Documents/Tasks/Core — not a hardcoded list — the
  Chat tab shows `ChatApp`, switching to Documents reveals the placeholder + hides
  Chat, switching to the Core tab renders the iframe at the resolved URL).

**Verify.** `bunx tsc -p landing/chat-react/tsconfig.json` clean;
`bun test landing/chat-react/__tests__/` → 48 pass. The Documents/Tasks tab
CONTENT is intentionally placeholder; PR-5..9 fill it. The General view stays
chat-only by design (no project ⇒ no project tabs).

## 2026-06-23 — WAVE 3 PR-3: mobile project tab bar is REGISTRY-DRIVEN

Third PR of the WAVE 3 tabbed-project-interface build
(`docs/plans/wave3-tabbed-interface-build-plan.md` § 3.1, PR-3). Wires the
**mobile** (`app/`) project shell to the tab-resolver endpoints PR-1/PR-2
shipped. Per the SPEC Decisions Log (2026-06-23) **no feature flags** — the
plan's flag-gating is disregarded; the bar renders the resolved set directly.

**What changed.** The project shell (`app/app/projects/[id]/_layout.tsx`) no
longer renders the hardcoded `PROJECT_TABS`. On mount it fetches
`GET /api/app/projects/<id>/tabs` (the always-on engine resolver) and feeds the
resolved descriptors into `ProjectTabBar`'s existing `tabs` prop, so the bar
shows exactly what the engine resolves: builtin **Chat / Documents / Tasks** ∪
the `project_tab` surfaces of Cores installed in that project. No flag, no dual
path.

- **`lib/tabs-client.ts`** (new) — thin bearer-auth fetch wrapper for
  `listProjectTabs(id)`; wire shapes mirror `tabs/registry.ts` `TabDescriptor`
  (re-declared app-side, the same convention every other `app/lib/*-client.ts`
  follows — keeps the Expo app free of a gateway dep). Throws `TabsClientError`
  on 4xx/5xx/network so the shell can fall back.
- **`lib/project-tabs.ts`** (new, RN-free) — descriptor→route + active-tab
  resolution, unit-testable under `bun test`. Builtin descriptors route to the
  client's native expo-router leaf (`mount.target` = `chat`/`docs`/`tasks`);
  Core descriptors (`mount.kind:'webview'`) route to the generic
  `cores/[slug]` webview with the URL + label as query params.
  `activeTabKeyFromSegments` is route-driven so it tracks whatever set is live
  (loading default or fetched registry). Now ALSO the home of `PROJECT_TABS` +
  `ProjectTabSpec` (moved off the RN component so the logic stays pure;
  `ProjectTabBar` re-exports both for back-compat).
- **`app/projects/[id]/cores/[slug].tsx`** (new) — generic Core webview tab.
  WEB renders an inline `<iframe>`; NATIVE opens the Core URL in the system
  browser via `expo-web-browser` (the app has no `react-native-webview`
  dependency — an inline-native webview is a documented follow-up). URLs are
  scheme-validated (`sanitizeCoreTabUrl`, http(s) only) before any load.
- **`components/ProjectTabBar.tsx`** — `key`/`active`/`onSelect` widened from
  the locked 5-tab union to `string` so the bar renders registry + Core keys.
  Pure presentation, unchanged otherwise.
- **Pre-fetch default.** `PROJECT_TABS` (the legacy chat/Apps/tasks/reminders/
  docs set) survives ONLY as the loading default shown before the fetch returns
  (or if it errors — a graceful fallback, not a flag-gated alt path).
- **Removed** `lib/active-tab.ts` + its test — superseded by the route-driven
  resolver in `lib/project-tabs.ts` (the PR #11 chat-sync no-shadow regression
  is ported into `__tests__/project-tabs.test.ts`).

**Spec-conformance note (5-line).** SPEC/plan §3.1 builtins are Chat/Documents/
Tasks; the pre-WAVE-3 mobile bar also had **Apps (launcher)** + **Reminders**.
Rendering the registry faithfully (the SSOT) means those two are no longer
top-level tabs once the fetch resolves — their routes still exist and are
reachable by deep-link. Re-adding them, if desired, is a one-line
`BUILTIN_TABS` change in `tabs/registry.ts` (engine), out of scope for this
mobile-wiring PR.

**Tests.** `__tests__/project-tabs.test.ts` (descriptor→route incl. Core
webview; pre-fetch default; active-tab incl. Core route + non-tab regression;
URL guard) + `__tests__/tabs-client.test.ts` (GET/bearer/unwrap/error
mapping). `app/` `tsc --noEmit` clean; 30 targeted tests pass. Full suite NOT
run (memory-constrained box, per the run brief).

## 2026-06-23 — WAVE 3 PR-2: strip the tabs flag + Cores install-SCOPE (global) + Core-tab union

Second PR of the WAVE 3 tabbed-project-interface build
(`docs/plans/wave3-tabbed-interface-build-plan.md` § 3.1-3.2). Two things, and
per Ryan's SPEC Decisions Log (2026-06-23) **no feature flags** — the plan's
flag-gating is disregarded.

**(A) Strip `NEUTRON_TABS_REGISTRY`.** PR-1 gated the tab-resolver surface on an
`enabled` boolean (the `NEUTRON_TABS_REGISTRY` flag) and disclaimed its routes
when off. That gate is **removed**: `createAppTabsSurface` no longer takes
`enabled`, the flag-off `return null` path is gone, and the routes
(`GET /api/app/projects/<id>/tabs`, `GET /api/app/tabs`) are **always on**. The
surface still returns `null` for non-owned paths (compose-chain dispatch, not a
flag). The flag was never wired into production boot (PR-1 left
`app_tabs_surface` as an unpopulated composition slot), so there is no boot path
to change — only the surface, its doc comments (`compose.ts`,
`app-surfaces-input.ts`), and the test. The flag-OFF test branch is deleted.

**(B) Cores install-SCOPE — the GLOBAL scope (no flag).** A Core can now install
**per-project** (the existing `core_installations`, keyed `(project_slug,
core_slug)`) OR **globally** (its tabs surface in the global shell + every
project):
- **Migration `0084_core_global_installations.sql`** — a sibling table keyed on
  `core_slug` (PK), with `package_name/version`, `manifest_capabilities_json`,
  `install_state` (mirrors 0036), and install/uninstall timestamps. A dedicated
  table (not a `scope` column + sentinel `project_slug='*'`) keeps every
  per-project read path byte-identical and makes "installed globally" a clean
  UNION in the resolver. `expected-schema.txt` regenerated;
  `migrations/runner.test.ts` applied-list extended to `84`.
- **Global CRUD on `CoreInstallationsStore`** — `recordGlobal` / `getGlobal` /
  `listGlobal` / `listGlobalLive` / `markGlobalUninstalled`, mirroring the
  per-project methods (uninstall is a tombstone; re-install revives via UPSERT).
- **Manifest `install_scopes: ('project'|'global')[]`** — OPTIONAL (omitted ⇒
  project-only, so every pre-WAVE-3 Core is unchanged). Added to the runtime Zod
  schema (`cores/sdk/manifest.ts`, the loader's source of truth) and, for
  parity, the hand-written `core-sdk` (type + permissive validator +
  `manifest.schema.json`).
- **Global lifecycle** — `installCoreGlobally` / `uninstallCoreGlobally` +
  `manifestSupportsScope` (`cores/runtime/lifecycle.ts`). A global install loads
  + validates the manifest, **gates on `install_scopes` including `'global'`**
  (new `CoreInstallError` code `scope_not_supported`), refuses a duplicate live
  global install, and records the global row. Deliberately project-agnostic — no
  per-project data namespace or secrets prompt (those still flow through the
  unchanged per-project `installCore`), so the heavily-tested per-project path is
  byte-identical.
- **Resolver union** — `resolveTabs(scope, cores)` now unions builtin tabs with a
  `CoreTabContribution[]` (Core tabs sort after builtins at `order ≥ 100`,
  `source:'core'`, `key:'core:<slug>'`, `mount:{kind:'webview'}`). The registry
  stays **pure**; the HTTP surface gathers contributions — per-project from
  `installations.listLive(project_slug)` (with `<project_id>` substituted into
  the Core's `project_tab` entry), global from `installations.listGlobalLive()`
  (placeholder kept) — reading each Core's manifest from `CoresModuleState.registry`.
  Core union is opt-in: `createAppTabsSurface({ auth, cores?, installations? })`
  serves builtins-only when those are omitted.

**Tests (tsc clean; targeted suites green):** registry union (project/global
scope stamping, order, webview mount); store global CRUD (round-trip,
project/global separation, tombstone + revive); lifecycle global install/uninstall
+ scope gate (`scope_not_supported`, duplicate refusal, default project-only);
surface end-to-end (always-on builtins, per-project Core fold-in with substitution,
global Core fold-in, no per-project leak into global, tombstoned skip). 57
focused tests across the four touched suites + 256 across `core-sdk`/`cores/sdk`/
`cores/runtime`.

**Out of scope (later PRs):** mobile/web tab UI (PR-3/PR-4); Documents/Tasks
tabs; wiring `app_tabs_surface` into production boot.

## 2026-06-23 — WAVE 3 PR-1: tab descriptor + resolver endpoints (engine, builtin-only, flag-gated)

First PR of the WAVE 3 tabbed-project-interface build
(`docs/plans/wave3-tabbed-interface-build-plan.md` § 3.1 + § 4). Establishes
the **engine-side tab resolver both clients will consume** so tabs are never
hardcoded in the mobile/web clients.

**New module `tabs/registry.ts`.** A `TabDescriptor` type
(`key`, `label`, `scope: 'project'|'global'`, `source: 'builtin'|'core'`,
optional `core_slug`, `order`, `mount: { kind: 'builtin'|'webview', target }`)
+ `resolveTabs(scope)` / `resolveProjectTabs()` / `resolveGlobalTabs()`. **v1
emits BUILTIN descriptors only** — Chat/Documents/Tasks per-project (targets
`chat`/`docs`/`tasks` matching the existing client routes), Admin global. The
resolver returns fresh clones of a frozen builtin set every call (callers
can't mutate shared state), and builtin `order` values are spaced by 10 so
PR-2 can interleave Core-contributed tabs without renumbering. No reading of
`core_installations` — that union is PR-2.

**New HTTP surface `gateway/http/app-tabs-surface.ts`.** Two read-only routes,
`GET /api/app/projects/<id>/tabs` + `GET /api/app/tabs`, Bearer-auth via the
shared `AppWsAuthResolver` (same contract as the sibling app surfaces), per-
project route validates `project_id`, non-GET → 405, non-owned paths → `null`.

**Flag gate `NEUTRON_TABS_REGISTRY` (default OFF).** Resolved to a boolean at
composition time and passed to the surface as `enabled`. Flag OFF → the
surface disclaims its routes (returns `null`) BEFORE auth, so they 404 through
the default chain exactly as if unmounted and clients keep their hardcoded
tabs (no regression). Flag ON → serves descriptors.

**Plumbing.** `app_tabs_surface` added to `AppSurfacesCompositionInput`,
forwarded in `composition.ts` (+ `hasAnyChainedSurface`), and dispatched in
`gateway/http/compose.ts` as `appTabs` — mounted ahead of `appProjects` so the
per-project `/tabs` path is unambiguously owned (mirrors the
launcher/tasks/reminders precedence). Like the other app surfaces this is a
plumbed seam tested in isolation (no production boot constructs it yet, same
status as `app_docs_surface`). `tabs/**/*.ts` added to the root tsconfig
`include`.

**Spec-conformance diff (plan PR-1 / current code / gap / this-PR / out-of-scope):**
- *plan PR-1:* `tabs/registry.ts` + `GET /api/app/projects/<id>/tabs` +
  `GET /api/app/tabs`, builtin descriptors only (Chat, Documents, Tasks; global
  Admin), flag `NEUTRON_TABS_REGISTRY`, pure additive.
- *current code:* no tab resolver; mobile tabs hardcoded
  (`app/components/ProjectTabBar.tsx`), web chat-only; `project_tab` core
  surface declared-but-unrendered.
- *gap:* no engine source-of-truth for the tab set.
- *this-PR:* the descriptor type + resolver + both endpoints + flag + tests +
  composition plumbing. Reconciled two `[estimate]` shape points the plan
  invited confirming in-PR: `mount.kind` = `'builtin'|'webview'` (an engine
  descriptor can't know mobile-vs-web; builtin tabs carry a `target` key each
  client maps to its native view), and `source` is the builtin/core
  discriminant (v2 adds `'custom'`). Included **Tasks** as a builtin project
  tab per the plan's PR-1 list (the dispatch brief's shorthand said
  "Chat + Documents"; the plan § 4 says "Chat, Documents, Tasks").
- *out-of-scope (NOT built here):* Core-contributed tabs, install-scope union,
  any client change, the global cross-project roll-up (all PR-2+).

**Tests (19, green).** `tabs/__tests__/registry.test.ts` (shape, scope
filtering, ordering + PR-2 gaps, immutability, no v2 source leak) +
`gateway/__tests__/app-tabs-surface.test.ts` (flag-ON project + global 200s,
auth 401, malformed project_id 400, non-GET 405, **flag-OFF 404 disclaim**
before auth, non-owned-path disclaim). `bunx tsc --noEmit` clean.

## 2026-06-22 — Test-suite RUN-efficiency: PGLite quarantine lane + handler-direct surface tests

Pure speed/reliability sprint per `docs/research/test-suite-audit-2026-06-22.md`
(P1 + P2 + P4 of that plan). **Zero tests deleted, zero assertions changed** —
this only changes *how* tests run, never *what* they assert.

**P1 — PGLite-WASM quarantine lane (`scripts/run-tests.sh`).** The handful of
test files that boot a real Postgres-in-WASM (`@electric-sql/pglite`) were the
suite's single most expensive + flakiest step (ISSUES #79 boot race / #327
WASM-init OOM). They now run in their **own dedicated lane after** the general
chunks: serial intra-lane (`--max-concurrency=1`, so two brains never compile
WASM at the same instant) with a **bounded retry budget** (a transient lane
failure re-runs the whole lane up to `NEUTRON_TEST_PGLITE_RETRIES`=2 extra times
before the run fails). Membership is **content-derived** (any test file
mentioning `pglite`), so new PGLite tests are quarantined automatically — no
allowlist. Coverage is unchanged: lane files still count in the audit
(`RAN_TOTAL == TOTAL`). New env: `NEUTRON_TEST_PGLITE_{RETRIES,CONCURRENCY,
TIMEOUT}` + `NEUTRON_TEST_NO_PGLITE_LANE=1` escape hatch. Lane logic validated
with a stub-bun harness (green / retry-recovery / exhausted-retry-FAIL / disabled
paths all behave).

**P2 — server-boot → handler-direct (18 gateway `app-*-surface` tests).** These
bound a real `Bun.serve({port:0})` socket only to `fetch()` one route over
loopback. They now dispatch through the composed handler **in-process**: a
module-scoped shim shadows `fetch`, each harness registers its composed handler
(or surface dispatch fn) under a unique in-process base host, and `fetch()` to a
registered base calls `composed.fetch(new Request(...))` directly — no listener
or socket buffers held in the chunk's RSS until teardown. Identical assertions
(verified: zero net change in `expect`/`describe`/`it` lines). **Kept on a real
socket** (genuinely need the wire): `app-ws-surface` (real WebSocket client) and
`app-upload-surface` + `app-docs-surface-binary` (multipart/binary uploads assert
`content-length` 411/413 + boundary serialization that only exist over the wire).

**P4 — tuning recipes.** Chunk-size / `NEUTRON_TEST_JOBS` recipes (contended/CI
box vs quiet dev box) in the runner header, a new `docs/testing-runner.md`, and a
Testing & CI section in `docs/SYSTEM-OVERVIEW.md`.

**Out of scope (needs Ryan sign-off, per the audit):** P0 make-runner-default,
P3 redundancy/bookkeeping deletion scan.

**Verification.** `bunx tsc --noEmit` clean; all 18 converted surface files green
(306 pass / 0 fail) in one bun process; PGLite lane logic exercised via stub-bun.
Full suite NOT run locally (the dev box OOMs on it — CI runs it).

## 2026-06-22 — Overnight-dispatcher disentangle: remove the orphaned `wow_overnight_handler` stub

Completes the overnight-dispatcher disentangle/registration (the registration
half — the real `overnight_handler` engine + `overnight-<slug>` job — already
landed in the 2026-06-19 overnight-engine work). The leftover entanglement was
the **preview-only morning check-in stub** `wow_overnight_handler`
(`onboarding/wow-moment/overnight-cron.ts`): once `build-core-modules.ts`
registered the real engine unconditionally and action 07 emitted
`overnight-<slug>` jobs bound to `overnight_handler`, nothing in the production
boot path ever registered the stub again — it was dead code still exported
through the wow-moment barrel, with a stale config field pointing at its type.

**What shipped:**
- **Deleted** `onboarding/wow-moment/overnight-cron.ts` (the stub:
  `buildWowOvernightHandler`, `registerWowOvernightHandler`,
  `composeMorningCheckin`, `WOW_OVERNIGHT_HANDLER_NAME`) and its test
  `onboarding/wow-moment/__tests__/overnight-cron.test.ts`.
- **Removed** the stub's re-exports from `onboarding/wow-moment/index.ts`.
- **Renamed** the composition config field `onboarding_wow_overnight_cron` →
  `onboarding_overnight_cron` and repointed its `deliver` seam from the stub's
  `WowOvernightDeliverInput` at the real engine's `MorningBriefDeliverInput`
  (identical `{ topic_id, body }` shape — no behavioral change). Updated the
  sole consumer (`gateway/composition/build-core-modules.ts`). No caller sets
  the field today, so the rename is internal-only.
- **Docs:** refreshed the overnight section of `docs/SYSTEM-OVERVIEW.md`.

**Verification:** `bunx tsc --noEmit` clean; targeted `bun test` of
`onboarding/overnight/`, action 07, the wow-moment suite, and
`gateway/composition-onboarding-telemetry.test.ts` (which asserts
`overnight_handler` is registered) → 171 pass / 0 fail. Full suite deferred to
CI (memory-constrained box).

**Out of scope / not needed here:** the Vajra-gateway "completed-bullet
re-validation" + "no auto-archival" defects do **not** exist in this port — the
neutron-open dispatcher already skips completed/failed bullets before the
context gate (`onboarding/overnight/dispatcher.ts`). Wiring an actual
`deliver` surface in production (the field is currently never set, so the
reporter records `skipped`) is a separate, pre-existing gap.
## 2026-06-22 — Foundational Trident production runner wired into Open prod boot

Makes the `/code <task>` build runner real in the Open self-host gateway. The
trident runtime (state machine + tick loop + real Forge→Argus→merge `step`) was
complete and the `input.trident.dispatch` seam existed, but the Open composer
never set it — so the tick loop fell back to `stubAdvanceDeps()` (advances
nothing) and a build could never dispatch. This is the `CodegenNotConfiguredError`
"production runner not wired into prod boot" class.

**What shipped:**
- `trident/substrate-dispatch.ts` (new) — `buildSubstrateTridentDispatch({ substrate })`:
  a thin production adapter turning a runtime `Substrate` (the CC-subprocess
  persistent-REPL adapter, never api.anthropic.com) into a `TridentDispatch`.
  Runs ONE Forge/Argus turn → coalesced terminal text + terminal status
  (completion→completed, error→failed, timeout→timed_out, throw→failed). Declares
  NO tools and holds no conversation state — prompt rendering + verdict parsing
  stay above it in the orchestrator + `TridentSessionManager`.
- `open/composer.ts` — builds a dedicated `cc-trident-*` substrate (kept off the
  conversational `cc-agent-*` warm pool) and threads
  `composition.trident = { dispatch }`. When no credential resolves, `trident`
  stays unset → unchanged LLM-less behaviour (loop live + restart-safe, advances
  nothing).
- Tests: `trident/substrate-dispatch.test.ts` (adapter mechanics + an end-to-end
  `/code`→real-run proof through the REAL orchestrator with a mocked substrate);
  `open/__tests__/open-trident-prod-boot-wiring.test.ts` (boots the REAL Open
  composer with a synthetic credential + mocked substrate; asserts
  `composition.trident.dispatch` is a working runner and the no-credential boot
  degrades cleanly).
- Docs: `docs/SYSTEM-OVERVIEW.md` Trident/`/code` + boot sections corrected to
  reflect what's live vs. the next PRs.

**Spec-conformance (Trident-port, FIRST scoped PR of the multi-PR port):**
- Spec/intent says: wire the production runner into prod boot so `/code` runs on
  the CC-subprocess substrate instead of throwing `CodegenNotConfiguredError`.
- Pre-PR wiring: `build-core-modules.ts` reads `input.trident.dispatch` (PR-5),
  but the Open composer never populated it → `stubAdvanceDeps()` no-op.
- Gap: no production `TridentDispatch`; no composer wiring.
- This PR closes it: adapter + composer wiring + a test proving `/code`
  dispatches a real run on a mocked substrate.
- OUT OF SCOPE (next PRs, noted in PR body + SYSTEM-OVERVIEW): (a) routing the
  literal `/code` keystroke from the Open landing chat into
  `buildTridentCodeChatCommandFilter` (the landing chat path has no
  `ChatCommandFilter` seam yet); (b) per-build context isolation + per-worktree
  cwd; (c) physical retirement of the `cores/free/code-gen` wrapper (still
  referenced by the `codegen_*` MCP tools + Managed composer + ~106 tests).

## 2026-06-22 — Conditional embedding-store init wired into provisioning (ISSUES #215)

Embeddings become a real, **opt-in** capability of the per-instance GBrain
memory without touching the keyword-+-graph default. Closes the #215 gap: the
provisioning path could not turn on a semantic store even when the operator had
an embedder available.

**What shipped:**
- `gbrain-memory/embedder-config.ts` (new) — pure `resolveEmbedderConfig(env)`.
  Opt-in via `NEUTRON_EMBEDDINGS`: `openai` → cloud `text-embedding-3-large`
  (3072d, key from `NEUTRON_EMBEDDINGS_OPENAI_API_KEY` ?? `OPENAI_API_KEY`);
  `ollama` → local/free `nomic-embed-text` (768d) over `OLLAMA_BASE_URL`;
  `auto` → OpenAI-if-keyed else Ollama-if-`OLLAMA_BASE_URL`; `off`/unset →
  `null`. Returns the `gbrain serve` child env (`GBRAIN_EMBEDDING_MODEL`
  `provider:model`, `GBRAIN_EMBEDDING_DIMENSIONS`, provider auth/base-url).
- `gateway/realmode-composer/build-gbrain-memory.ts` — `resolveGbrainClientOptions`
  now merges a non-null embedder config into the child env. `null` (the default)
  leaves the child env byte-for-byte today's keyword-+-graph wiring.
- Tests: `gbrain-memory/__tests__/embedder-config.test.ts` (resolver, both
  paths + edge cases) and the conditional-store cases added to
  `gateway/realmode-composer/__tests__/build-gbrain-memory.test.ts`.
- Docs: new GBrain memory/provisioning section in `docs/SYSTEM-OVERVIEW.md`;
  opt-in env vars documented in `.env.example`.

**Spec-conformance (#215):**
- SPEC says: init an embedding store ONLY when an embedder is configured
  (OpenAI key → cloud; Ollama → local); neither → no store, search as today.
- Current wiring (pre-PR): `gbrain serve` was always launched WITHOUT any
  `GBRAIN_EMBEDDING_*` env, so no store could ever initialize.
- Gap: no detection of a configured embedder, no conditional child-env wiring.
- This PR closes it: `resolveEmbedderConfig` detects the opt-in + provider and
  `resolveGbrainClientOptions` conditionally forwards the embedding env.
- Judgment call (noted in PR): the trigger is an explicit `NEUTRON_EMBEDDINGS`
  opt-in, NOT bare `OPENAI_API_KEY` presence — that key already feeds the GPT
  LLM adapter, so triggering on it would silently bill every GPT-BYO user and
  change the default, violating the opt-in contract.

## 2026-06-21 — Dead-code sweep (batch 1): remove 8 orphaned files

Evidence-based leanness pass (Ryan mandate, SPEC Decisions Log): delete only
provably-unused code, never load-bearing code. Method: `knip --include files`
to surface orphan candidates, then per-file `grep` across the repo to confirm
zero real importers before each deletion.

**Removed (539 lines, 8 files, all zero-importer):**
1. `gateway/instance-context.ts` — orphaned `AsyncLocalStorage` frame. All four
   exports (`withInstanceContext`, `currentInstanceContext`,
   `requireInstanceContext`, `InstanceContext`) had zero importers anywhere. Its
   own doc-comment claimed it was "read by the logger, MCP server tool calls,
   scribe pipeline" — that wiring never landed; the frame was aspirational.
2. `app/lib/placeholder-tab.tsx`, `app/lib/ws-connection-provider.tsx` — RN
   helpers in `app/lib/` with zero symbol references (not route files).
3. `landing/connect-accept-server.ts` — zero refs. Distinct from the LIVE
   `landing/connect-accept.ts` (the `-server` suffix file was the orphan;
   `buildConnectAcceptHandler`/`ConnectAcceptHandler` are imported nowhere).
4. `gateway/proactive/index.ts`, `gateway/push/index.ts`,
   `gateway/tasks/p6/index.ts`, `onboarding/overnight/index.ts` — orphaned pure
   re-export barrels. Every consumer imports the concrete files directly
   (`../proactive/cron.ts`, `../tasks/p6/nudge-engine.ts`, …); no barrel,
   package-subpath (`@neutronai/gateway/proactive`), or root-barrel re-export
   importer exists. The concrete modules they re-exported are untouched.

**Phantom FIRST TARGET (ISSUES #73).** The spec named a "dead
slugRegistry / slugHistoryStore / reservedSlugs triple branch in `engine.ts`."
Confirmed it does NOT exist in `onboarding/interview/engine.ts` on `origin/main`
(0 occurrences; never in that file's git history). The `slugHistoryStore` /
`reservedSlugs` symbols that DO exist elsewhere (`landing/auth-gate.ts`,
`runtime/slug-grammar.ts`, `gateway/http/chat-bridge.ts`) are LIVE with real
callers — left untouched. No action: the target was already gone (likely folded
into the #27 engine consolidation).

**Deferred to a follow-up PR (NOT deleted — robustness over leanness):**
- `connect/remote-shared-projects-store.ts` — zero importers, but a coherent
  connect/PH5 feature surface listed as live in the
  `ph5-persists-nothing.test.ts` guard; plausibly pending wiring.
- `runtime/adapters/claude-code/persistent/dev-channel.ts` — guarded by
  `stateless-correlation.test.ts` and part of the runtime-critical persistent
  REPL substrate (loads `@modelcontextprotocol/sdk`); not high-confidence dead.
- The repo-wide unused-EXPORT pass (ts-prune flags ~3,600 candidates) — too
  noisy (re-exports, dynamic imports, entry points) for a focused PR; needs
  per-symbol verification in a dedicated follow-up.
- NOT dead (verified, kept): `landing/chat-react/main.tsx` (lazy `Bun.build`
  bundler entry at `landing/server.ts:1033`),
  `runtime/.../hooks/enforce-reply.ts` (Stop hook invoked by path),
  `migrations/regen-snapshot.ts` + the two fixture `build.ts` files (manual
  regeneration scripts run via `bun run`).

**Verify.** `bunx tsc --noEmit -p tsconfig.json` → 0 errors (clean before and
after). Targeted suites for every touched area: `bun test gateway/proactive
gateway/push gateway/tasks/p6 onboarding/overnight` → 155 pass / 0 fail;
`bun test landing connect` → 754 pass / 0 fail. Full suite deferred to CI
(local box is memory-constrained).
## 2026-06-22 — React web chat: attachment compose UI + authed image render (Track B Phase 3 parity)

**Problem.** The flag-gated React/assistant-ui web client (Phase 3, PR #19)
reached parity with the vanilla client on everything EXCEPT three documented
gaps: attachment *compose* UI, "load earlier" history paging, and the production
app-ws web token mint. This sprint closes the attachment gap end-to-end. (The
render path's prior "done" status was only true for `data:`/external URLs — the
real `/api/app/upload` GET is bearer-authed, so a plain `<img src>` 401s; this
sprint makes uploaded attachments actually render too.)

**What shipped (client-only — NO backend changes; the upload surface already
existed for the Expo client at `gateway/http/app-upload-surface.ts`).**

- **`landing/chat-react/uploads.ts`.** `uploadAttachment(file)` POSTs multipart
  to the bearer-authed `POST /api/app/upload` and returns the content-addressed
  URL; `fetchAttachmentObjectUrl(url)` GETs WITH the bearer and yields a `blob:`
  object URL for rendering (the GET is bearer-authed — a plain `<img src>` would
  401). `isAuthedAttachmentUrl` gates which URLs need the authed path. Pure given
  an injected `fetchImpl`.
- **`landing/chat-react/useAttachmentDraft.ts`.** Stages picked/dropped images,
  uploads each eagerly (so the network overlaps with the user typing a caption),
  and exposes `readUrls()` (ready URLs, read through a ref to dodge stale-closure
  sends) + `clear()`. The ready URLs ride out on the next send via
  `WebChatSession.send({ attachments })` — the data path that already existed.
- **`ChatApp.tsx`.** A 📎 file-picker + drag-drop composer, removable staged
  chips with per-item upload/error state, an attachment-only send path
  (assistant-ui won't send an empty composer, so the controller is handed the
  URLs directly), and a custom assistant-ui `Image` content-part that renders
  uploaded images through the authed fetch→object-URL renderer (external/`data:`
  URLs still render directly).
- **`config.ts`.** Surfaces the app-ws bearer token (`BootstrapConfig.token`) for
  the upload + render auth.

**Scope decision (deliberate).** Of the three Phase-3 parity gaps, ONLY
attachments was safely closable in one autonomous PR. "Load earlier" is NOT
client-only: chat-core + the app-ws surface are forward-only (one
`{type:'resume', after_seq}` replay; `replayAfter` ASC capped at 500), so no
backfill primitive exists. Closing it is an additive cross-layer change
(`replayBefore`/`{type:'history', before_seq}` on the app-ws surface + a
`WebChatSession.loadEarlier()` request/response correlation + a controller cursor
+ a "Load earlier" button) entangled with the Phase-1 forward-only resume
contract — deferred to its own reviewed sprint rather than risk the foundation.
The production app-ws web token mint remains the separate identity sub-sprint.

**Tests.** `uploads.test.ts` (upload client: bearer multipart, oversize +
unsupported pre-flight, server error code+status, abort, malformed body, authed
GET→object URL); `attachments.test.tsx` (happy-dom stage→upload→send→authed-
render); `config.test.ts` token assertion. Root deploy-gate `tsc` + the React
leaf `tsc -p landing/chat-react/tsconfig.json` both clean; `bun test
landing/chat-react` green (38 pass). The full suite runs in CI. Vanilla stays the
default behind the flag.

## 2026-06-21 — Track B Phase 4 (slice 3): message reactions over `@neutron/chat-core`

**What shipped.** Per-message emoji reactions across the web + mobile chat stack,
built ON the existing chat-core engine (NO fork of the sync engine), MIRRORING
the receipts slice (#24): per-message metadata, synced multi-device over
chat-core, device-attributed by the socket (no forging), durable + resume-
replayable. Scope is reactions ONLY (edit/delete is the next slice, out of scope).

**The one structural difference from receipts: reactions are REMOVABLE.** Receipts
only ever advance, so the client could merge them by monotonic set-union.
Reactions can be added AND removed, so a union can't model a removal. The model
is therefore **server-authoritative full-aggregate + last-writer-wins by a
monotonic per-message `rev`**:
- A client sends `{type:'reaction', message_id, emoji, action:'add'|'remove'}`.
  The gateway attributes it to the SOCKET's `device_id` (never the frame — a
  client can't forge another device's reaction), persists it, bumps the
  message's `rev`, and fans the FULL current aggregate as a `reaction_update`
  (`{rev, reactions:[{emoji,device_id}]}`).
- The client REPLACES its reaction set with whichever `reaction_update` carries
  the highest `rev` and drops a stale lower one — idempotent + order-independent,
  and a higher-`rev` EMPTY set is what actually clears a reaction. Resume replays
  one `reaction_update` per message-with-reactions after the cursor.

**chat-core (engine untouched).**
- `types.ts`: `ChatMessage` gains optional `reactions`/`reactions_rev`;
  `MessageReaction`, `ReactionAction`, `InboundReactionUpdate`, `OutboundReaction`,
  `normalizeReactionUpdate`, `parseReactions`.
- `store.ts`: `pickReactionState` (rev-LWW, NOT a union) folded into
  `mergeMessage`; `normalizeReactions`; framework-free `groupReactions` →
  per-emoji chips shared by both clients.
- `sync-engine.ts`: additive `applyReactionUpdate(topic, update)` — rev-LWW over
  the existing UPSERT path; no-op when the message isn't local yet or the update
  is stale.
- RN op-sqlite (`app/lib/chat-core/sqlite-store.ts`): `reactions` (JSON TEXT) +
  `reactions_rev` (INTEGER) columns + idempotent `ADD COLUMN` migration for
  pre-reactions DBs. Web in-mem/OPFS serialize for free.

**Server (`channels/adapters/app-ws/` + `gateway/http/app-ws-surface.ts`).**
- Durable reaction log `persistence/app-chat-reactions.ts`
  (`AppChatReactionStore`) + migration `0083_app_chat_reactions.sql` — one row
  per `(topic, message, device, emoji)`; a remove flips `active = 0` (a
  TOMBSTONE, not a DELETE) so `MAX(rev)` stays monotonic across removes; seq
  resolved from the message log for resume ordering.
- Envelope: `AppWsInboundReaction` + `decodeAppWsReaction` +
  `sanitizeReactionEmoji` (one grapheme, no whitespace/control, ≤64 chars, no
  fixed allowlist); `AppWsOutboundReactionUpdate`.
- Adapter: `reaction_log` option; `recordReaction` (persist + fan
  `reaction_update`); `replayReactionsAfter`; `hasReactions`.
- Surface: a `reaction` inbound branch (device from the socket); reaction replay
  after a resume (after messages + receipts so the target is already applied).

**Clients.**
- chat-core sessions (`web-session.ts` / `mobile-session.ts`): `react(id, emoji,
  action)`, `reaction_update` handling.
- Mobile (`ChatSyncSurface.tsx`): per-bubble reaction chips (count + self-
  highlight, tap a self-chip to remove) + a long-press quick-emoji tray;
  `groupReactions` via `chat-render-model`; `useMobileChat` exposes `react`.
- React/assistant-ui (`landing/chat-react/`): controller computes per-message
  `reactions` chips + a `react()` passthrough; `ChatApp` renders chips +
  an add-reaction palette per bubble via a `ReactionsContext` + assistant-ui's
  `useMessage()` (CSS `car-reaction*` in `chat-react.html`).

**Wiring posture (honest scope).** Like `chat_log`/`receipt_log`, the
`reaction_log` is an ADDITIVE adapter option — exercised by the test composers +
a real-SQLite gateway integration test, NOT yet wired into the live gateway
composition (the production app-ws surface itself isn't composed in
`gateway/composition.ts` in neutron-open). When productionised, pass `chat_log`
+ `receipt_log` + `reaction_log` together.

**Tests (real, not mocks).** `chat-core/__tests__/reactions.test.ts` (decode,
parse, rev-LWW merge incl. removal-clears, engine apply/stale/clear,
groupReactions), `persistence/app-chat-reactions.test.ts` (add/remove tombstone,
rev monotonicity, aggregate, resume replay over real SQLite),
`channels/adapters/app-ws/__tests__/reactions.test.ts` (decode + emoji
validation, fan-out, removal, multi-device, replay, legacy no-log),
`gateway/__tests__/app-ws-reactions.test.ts` (end-to-end WS over a live
Bun.serve: add/remove fan-out, socket-attributed device — forged frame id
ignored, resume replay), plus render-model, mobile-session, sqlite-store (incl.
reaction persistence + cold-reopen), and a happy-dom `component.test.tsx` that
asserts a chip reaches the real assistant-ui DOM. Root + all leaf tsc clean;
full `bun test` green.

## 2026-06-21 — Track B Phase 4 (slice 2): delivery + read receipts over `@neutron/chat-core`

**What shipped.** A per-message delivery ladder — `pending → sent → delivered →
read` — across the web + mobile chat stack, built ON the existing chat-core
engine (NO fork of the sync engine). Scope is receipts ONLY (reactions +
edit/delete are later slices, out of scope).

**Receipt model.**
- **Delivered is server-tracked.** When the gateway fans a message out, it
  records a `delivered` receipt for every device connected at that moment and
  stamps the set inline on the outbound envelope (`delivered_by`). No client
  cooperation needed.
- **Read is explicit + agent-driven.** A client sends `{type:'receipt',
  state:'read', message_id}` when a message is viewed; the gateway attributes it
  to the SOCKET's device id (never a client-supplied one — no forging). The
  agent loop ALSO marks an inbound user message `read` (synthetic `agent`
  device) the instant it picks it up, so a single-device sender sees the blue
  read tick with no second device.
- **Fan-out as `receipt_update`.** Each read records + re-fans a `receipt_update`
  carrying the FULL current aggregate (`delivered_by[]`/`read_by[]`, not a
  delta). The client merge is set-union → idempotent + order-independent, the
  same contract message apply uses. Resume replays one `receipt_update` per
  message-with-receipts after the cursor.

**Stored in the chat-core Store contract (both backends), engine untouched.**
- `chat-core/types.ts`: `ChatMessage` gains optional `delivered_to`/`read_by`;
  `normalizeReceiptUpdate` + `OutboundReceipt` + `AGENT_DEVICE_ID`.
- `chat-core/store.ts`: `mergeMessage` set-unions the receipt arrays
  (`unionDeviceIds`) — monotonic, so a device can never un-deliver/un-read.
- `chat-core/sync-engine.ts`: additive `applyReceiptUpdate(topic, update)` —
  looks the message up by `message_id`, merges via the existing UPSERT path;
  no-op when the message isn't local yet (a receipt never precedes its message).
- RN op-sqlite (`app/lib/chat-core/sqlite-store.ts`): two new JSON columns +
  an idempotent `ADD COLUMN` migration for pre-receipts DBs. Web in-mem/OPFS
  serialize the fields for free.

**Server (`channels/adapters/app-ws/` + `gateway/http/app-ws-surface.ts`).**
- Durable receipt log `persistence/app-chat-receipts.ts` (`AppChatReceiptStore`)
  + migration `0082_app_chat_receipts.sql` — one row per `(topic, message,
  device)`, `read` implies `delivered`, monotonic timestamps, seq resolved from
  the message log for resume ordering.
- Adapter: `receipt_log` option; `delivered`-at-fan-out stamping;
  `recordReceipt` (read → persist + fan `receipt_update`); `replayReceiptsAfter`.
- Session registry: per-session `device_id` + `devices(topic)`.
- Surface: parses/mints a `device_id` at upgrade; a `receipt` inbound branch;
  agent auto-read on the WS + HTTP send paths; receipt replay after a resume.

**Clients.**
- chat-core sessions (`web-session.ts` / `mobile-session.ts`): `device_id`
  option, `receipt_update` handling, `markRead(ids)` (de-duped, best-effort).
- Mobile (`ChatSyncSurface.tsx` + `chat-render-model.ts`): ladder extended with
  `read` (blue ✓✓); `onViewableItemsChanged` reports agent messages read;
  `deliveryState(msg, selfDeviceId)` excludes the sender's own device.
- React/assistant-ui (`landing/chat-react/`): controller computes per-message
  `delivery` + `latestUserDelivery`, auto-reads agent messages, and renders a
  Telegram-style status line (🕓/✓/✓✓/✓✓ blue).

**Wiring posture (honest scope).** Like the Phase-1 `chat_log`, the `receipt_log`
is an ADDITIVE adapter option — exercised by the test composers + a real-SQLite
gateway integration test, NOT yet wired into the live gateway composition (the
production app-ws surface itself isn't composed in `gateway/composition.ts`
yet). When the app-ws surface is productionised, pass `chat_log` + `receipt_log`
together.

**Tests (real, not mocks).** `chat-core/__tests__/receipts.test.ts` (union,
decode, engine apply + applyReceiptUpdate), `persistence/app-chat-receipts.test.ts`
(record/aggregate/replay over real SQLite), `channels/adapters/app-ws/__tests__/
receipts.test.ts` (delivered fan-out, read fan-out, multi-device, replay),
`gateway/__tests__/app-ws-receipts.test.ts` (end-to-end WS: agent auto-read,
multi-device read fan-out, resume replay over a live Bun.serve), plus
render-model + sqlite-store (incl. pre-receipts migration) cases. Root + all
leaf tsc clean; full `bun test` green (8023 pass / 0 fail).
## 2026-06-21 — SOUL/dharma as LIVED per-turn doctrine (WAVE 2 P1 tail, gap-audit item 10)

**Problem.** Onboarding's persona-gen writes the owner's SOUL/USER/priority-map
and `build-live-agent-turn.ts` splices them into each (instance, topic) warm
session's first turn — but the generated persona is mostly STATIC IDENTITY text
("who you are": archetypal blend, voice register, a few facts). The "how you act
on every turn" doctrine — truth-first, essence-over-excess, calibrated
confidence, the explicit anti-sycophancy / pushback discipline, and the
grounding-reframe ("dharma") move — was present only if the *generated* SOUL text
happened to include it, and the reframe layer only when the owner's interview
captured contemplative phrases. Gap-audit item 10: "Vajra's SOUL.md is active
doctrine consulted every turn; Neutron's is onboarding-only, not lived."

**What shipped.**
- **New `gateway/realmode-composer/operating-doctrine.ts`** — a pure,
  deterministic `buildOperatingDoctrineFragment({ scope, project_id? })` that
  emits an `<operating_doctrine>` block carrying the owner-AGNOSTIC operating
  principles (exported as `DOCTRINE_PRINCIPLES`). Owner-agnostic by design: NO
  owner name, NO archetypes, NO owner-private reframes — a self-hoster gets a
  sensible doctrine floor out of the box, and their own generated SOUL (spliced
  ABOVE this) supplies the personal voice. The fragment says so explicitly
  ("your SOUL defines who you are; this defines how you act; where your SOUL
  states a sharper rule, follow it") so it's a floor, not a ceiling.
- **Per-context weighting.** Identical principle BODY on every surface
  (consistency); only the closing weighting tail differs — General favours
  cross-project breadth + whole-picture judgment; a project topic favours that
  project's craft and keeps reframes especially light (the user is in flow).
- **Wired into `composeFirstTurnPrompt`** (`build-live-agent-turn.ts`): the
  doctrine fragment is spliced as the FIRST `instance_fragment` (right after the
  SOUL `base_persona`, before the project-voice refinement and the this-turn
  scope block), and ALSO into the degraded hand-assembled fallback — the floor
  cannot depend on `assembleSystemPrompt` succeeding. Because the first turn
  anchors the topic's warm CC session, the doctrine governs every subsequent
  turn on that session (the warm-REPL analogue of Vajra re-reading SOUL.md each
  turn).

**Spec-conformance note (persona composition: now vs should).**
1. SHOULD: the agent's per-turn system prompt carries lived operating doctrine,
   not just identity. NOW: it does — `<operating_doctrine>` is composed into
   every topic's first-turn prompt, guaranteed independent of generated-SOUL
   contents.
2. SHOULD: doctrine present on EVERY turn. NOW: present on the session-anchoring
   first turn that governs the warm session; warm follow-up turns still send only
   user text by design (the REPL transcript carries it) — a true per-message
   re-splice would defeat the warm-session contract and is explicitly NOT done.
3. SHOULD: per-context rules (General vs project). NOW: scope-weighted tail,
   same core principles.
4. SHOULD: owner-derived / general, not Ryan-specific. NOW: owner-agnostic
   constant; the owner's generated SOUL remains the personal layer above it.
5. SHOULD: anti-sycophancy + dharma reframe as live constraints. NOW: both are
   explicit numbered principles, the reframe kept general and "only when it
   genuinely fits."

**Tests.** `__tests__/operating-doctrine.test.ts` (principle set, consistency
across surfaces, no owner-specific leakage, per-context weighting) +
`__tests__/build-live-agent-turn.test.ts` new `operating-doctrine layer`
describe (doctrine present in the ACTUAL composed per-turn prompt for both
General and a project topic, and first-turn-only). tsc clean; full `bun test`
green.
## 2026-06-21 — #327: CI `test` PGLite-WASM-init flake — extend the boot helper's retry to the WASM-init shape

**Symptom.** The CI `test` job failed on ≈every PR in the WAVE2-tail wave (#19,
#21, #20) with `PGLite failed to initialize its WASM runtime` (gbrain #223) and
PASSED on `gh run rerun --failed`. DISTINCT from the #79 boot-*probe* race that
PR #13 root-fixed — this is the WASM-init step itself, not the post-create
bootstrap probe.

**Root cause.** `engine.connect()` → `@electric-sql/pglite`'s `PGlite.create()`
`readFile`s `pglite.data` and `WebAssembly.instantiate()`s the ~Postgres-in-WASM
module. PR #13's shared boot helper (`gbrain-memory/__tests__/boot-pglite-brain.ts`)
already **serialises** boots behind a process-global mutex (so the first compile
warms PGLite's module cache and later boots reuse it — the deterministic half is
in place), but the FIRST large WASM compile still runs while the chunk's ~100
sibling files saturate CI's small 2-vCPU/7-GB ubuntu runner, and the instantiate
intermittently aborts. gbrain wraps every `PGlite.create()` throw with the header
`PGLite failed to initialize its WASM runtime.` (`pglite-engine.ts:249`
`buildPgliteInitErrorMessage`; classifier at `pglite-engine.ts:157`). The helper's
bounded retry was scoped ONLY to the probe shape (`/evaluating 'probe\./`), so the
WASM-init failure fell through to an immediate throw — no self-heal → CI red.

**Why not the deterministic options (a/b).** PGLite reads `pglite.data`
read-only from the package dir and instantiates the WASM in-memory — there is no
writable-extraction-dir knob that changes this on Linux (the `$$bunfs`/read-only
hint is the macOS *compiled-binary* case, not ubuntu `bun test` from source). And
each `bun test` chunk is a FRESH process, so a `ci.yml` pre-warm step can't
persist PGLite's per-process module cache. The correct minimal fix is to let the
existing serialise+retry infrastructure recognise this shape too.

**Fix** (no assertion weakened). In `boot-pglite-brain.ts`:
- Generalised the transient classifier `isTransientBootProbe` → exported
  `isTransientBoot`, a TIGHT allow-list that now matches BOTH the #79 probe race
  AND the #327 WASM-init header (plus the raw PGLite `Invalid FS bundle size`
  byteLength guard and WASM compile/abort `RuntimeError` shapes). A deterministic
  error (SQL/migration/config) still returns `false` → never retried.
- Extracted the retry loop into an exported, injectable
  `withTransientBootRetry(boot, {maxAttempts, baseDelayMs, sleep, onRetry})`:
  retries ONLY a transient shape, BOUNDED (default 4 attempts), and rethrows the
  ORIGINAL error when exhausted — a genuinely broken runtime still fails loudly.
  The retry runs inside the boot mutex (no sibling competes during backoff) and
  boots a FRESH engine per attempt (disconnecting the half-booted one first).
- New unit test `boot-pglite-brain.test.ts` (9 tests) pins the contract: #327
  WASM-init + #79 probe + raw fs-bundle classified transient; schema/SQL/config
  errors NOT retried (surface on first throw); self-heal after 2 transient
  failures; bounded-exhaust rethrows the original; healthy boot never retries.

**Verification.** `bunx tsc --noEmit` clean; new unit suite 9/9; the 5 real-PGLite
suites run together at `--max-concurrency=4` 53/53 green; full
`scripts/run-tests.sh` 762/762 files, 8/8 chunks, coverage audit PASS;
`leak-gate.sh` SILENT. No production code touched — test-harness only.

## 2026-06-21 — #323 fix round 2: extract from `freeform_text`, not `state_delta` (Argus r1 BLOCKERs 1 & 2)

**Why a second pass.** Argus REQUEST-CHANGES on PR #20: the round-1 fix was
*inert on the real prod path* and the new test was a *false green* — the same
failure class (a passing test masking a broken live path) that shipped #323.

- **BLOCKER 1 — read the wrong field.** `extractGapFillFieldsViaRouterBestEffort`
  read ONLY `decision.state_delta`. But the router contract reserves a non-null
  `state_delta` on an `advance` for REVIEW/CORRECTION phases ONLY (llm-router.ts
  § "the one case where an advance carries a non-null state_delta");
  `work_interview_gap_fill` is an OPEN ask, and the gap-fill pack teaches a
  project-list reply as a state_delta-FREE free-text advance
  (phase-spec-resolver.ts `advance_examples`). So the prompt-faithful envelope a
  real Haiku/Sonnet emits is `action:'advance'` + `freeform_text:<verbatim
  reply>` + `state_delta:null` → the round-1 read extracted nothing → projects
  still dropped.
- **BLOCKER 2 — false-green fixture.** The new test fabricated an
  `advance` + populated `state_delta` envelope the prompt FORBIDS for this phase
  (matched only on the token "Amascence"), so it stayed green while prod stayed
  broken.

**What shipped (round 2).**

- **`extractGapFillFieldsViaRouterBestEffort` now parses `freeform_text`.** It
  still reads a `state_delta` first (for the genuine hybrid/review envelope), but
  when that yields nothing AND the decision is an `advance` carrying
  `freeform_text`, it parses the answer into the field the gap-fill is currently
  collecting (`auditRequiredFields(...).next_to_collect` —
  `primary_projects` / `non_work_interests`). Gated on `action === 'advance'` so a
  tangent (classified `answer`) is never mis-captured. Mirrors the established
  `projects_proposed` share-freeform `splitFreeformProjectList` fallback.
- **`parseGapFillFreeformList` (NEW, CONSERVATIVE).** Splits a gap-fill list
  answer on every comma / semicolon / newline / sentence boundary / "and",
  strips list lead-ins ("running three companies:", "side project", "I'm working
  on", …) + parenthetical asides + bullet markers. To AVOID garbage extraction
  from prose, it only emits a result when the answer is genuinely LIST-SHAPED — a
  MAJORITY of segments must be "name-like" (≤ 6 words, not opening with a
  pronoun/article/aux like "I"/"a"/"the"). Prose ("I run Caldera, a fragrance
  brand, and I am building out its ops and automation") fails the bar → returns
  `[]` → the caller falls back to the unchanged advance-with-empty-patch path
  (parks at `projects_proposed`, where the share-work flow still catches it). A
  tidy comma list AND the proper-noun-rich shape Ryan actually typed both recover
  cleanly to the six items. KNOWN LIMITATION: the whole answer maps to the single
  field being collected, so a volunteered non-work mention ("meditation") rides
  along in `primary_projects` rather than splitting into `non_work_interests`;
  fine-grained project-vs-interest separation needs real LLM extraction (follow-up).

- **Synthesised-fallback guard (Codex r2 P2).** A synthesised `advance`
  (`synthesised: 'timeout' | 'unparseable'`) is the router's failure fallback —
  its `freeform_text` is just echoed/truncated user input, which
  `dispatchRouterDecision` treats as a re-prompt, not a classification. The
  extractor now returns `null` for `decision.synthesised` before parsing, so a
  router failure can't persist projects from an unclassified fallback.

**Tests.** Regenerated the real-path fixture to the PROMPT-FAITHFUL envelope
(`advance` + `freeform_text` + `state_delta:null`). Verified RED→GREEN: with the
engine fix stashed the test fails (`primary_projects` `[]`); with it applied all
five stated projects + "meditation" land in `primary_projects` and the flow
advances past gap-fill with no "I didn't pin down concrete projects" re-ask. The
`open-single-owner-walkthrough` E2E stays green because its prose gap-fill answer
("I run Caldera, …") fails the list-shape bar → unchanged park-at-projects_proposed
behaviour (no garbage). `bunx tsc --noEmit` clean; full partitioned `run-tests.sh`
green (756 files / 8 chunks); leak-gate silent. Merged `origin/main` (AS-BUILT
conflict only).

## 2026-06-21 — Onboarding no longer DROPS an explicitly-stated project list (ISSUES #323, P1 first-run showstopper)

**Problem.** On a real fresh onboarding (no import) the user answered the
work-interview question with an explicit list — *"Running three companies: Tabs,
Pristine and Amascence. Side project Neutron (open source agent harness), side
project Robobuddha, and meditation."* — yet the flow re-asked at the end with
the zero-state prompt *"I didn't pin down concrete projects from what we talked
about."* (`buildProjectsProposedPromptSpec` empty branch, surfaced by
`autoConfirmProjectsProposedAndAdvance`'s zero-state guard). A perfectly explicit
6-item answer was silently discarded — duplication + data loss.

**Root cause (`onboarding/interview/engine.ts`).** `work_interview_gap_fill` is an
LLM-extraction phase, but it has only TWO extraction seams and BOTH miss in a
default Open install:

- `promptDriver` is the only dep that populates `extracted_fields` — and
  production **never wires it** (it wires `phaseSpecResolver` + `llmRouter`). So
  `driverDidFireForOwner` is never set and the `drainPendingExtractedFieldsRaw`
  result is always null in prod.
- the `llmRouter` (the real prod extraction engine) is gated behind
  `shouldConsultRouter`, i.e. `NEUTRON_ONBOARDING_CONVERSATIONAL` — which
  `resolveOnboardingConversational` defaults **OFF**, and `install.sh` never sets.

With both off, `consumeWorkInterviewGapFillChoice` hit its driver-unwired branch
→ `fallbackGapFillToStaticAdvance(input, observed_at, {})`, advancing with an
**empty patch** that drops the user's answer → `primary_projects` empty →
zero-state prompt. (The existing `v2-phase-walk` test masked this exact class by
wiring a `promptDriver` stub that production doesn't have.)

**What shipped.**

- **`extractGapFillFieldsViaRouterBestEffort` (NEW private method).** In the
  driver-unwired gap-fill branch, consult the `llmRouter` DIRECTLY to pull
  `primary_projects` / `non_work_interests` out of the freeform answer,
  independent of the conversational flag — gap-fill is fundamentally an
  extraction phase. **Best-effort by contract:** a missing router, a router
  throw, an unparseable model reply, or a no-`state_delta` classification yields
  `null` → the caller advances with `{}` exactly as before. It does NOT route
  through `dispatchRouterDecision`'s synthesised-advance re-prompt path, so an
  unparseable/garbage reply can never trap the user in a gap-fill loop (the
  deterministic LLM-less / E2E-mock walk is unchanged).
- **Double-call guard.** The extraction runs ONLY when `shouldConsultRouter` is
  false (the router was NOT already consulted upstream in `advance`). When the
  conversational flag IS on, `consumeChoice` already merged the router's
  `state_delta` into `phase_state` before this handler ran, so re-calling would
  double-bill the LLM and break the call-count contract.
- **`normalizeNonWorkInterestsForExtraction` (NEW module helper).** Maps a
  router `state_delta.non_work_interests` (a real model emits plain strings OR
  `{name}` objects) into the `ExtractedFields` `{name, cadence_hint?}[]` shape
  `mergeGapFillExtractedFields` expects. The merge stays additive + deduped.

**Tests.** `onboarding/interview/__tests__/work-interview-projects-extraction-real-path.test.ts`
(NEW) reproduces on the REAL prod path — the real `buildLlmRouter` over a
`FixtureAnthropicClient` returning a realistic raw-model envelope (the router's
own `parseRouterDecision` runs), `platform: stubPlatform([])` (conversational
OFF = the fresh-Open-install default), and **no `promptDriver`**. One test
asserts the freeform answer populates `primary_projects` with all five stated
projects + the non-work interest and advances; the other walks the full no-import
flow (signup → … → skip-slug) and asserts it reaches the project-shell collapse
with `primary_projects_confirmed` = the five projects and that NO emitted prompt
used the "I didn't pin down concrete projects" copy. RED before the fix (projects
`[]`), GREEN after. `bunx tsc --noEmit` clean; full `onboarding/interview/__tests__`
suite green (920 pass); the `open-single-owner-walkthrough` E2E (which a broader
first cut had regressed into a 120s loop) stays green.
## 2026-06-21 — Track B Phase 4 (slice 1): full-text MESSAGE search (FTS5 over chat history) + `message_search` agent tool

**What shipped.** Full-text search over CHAT MESSAGE history — the complement to
the just-merged doc search (#18, over project markdown). The user and the live
agent can now search their conversations. The index lives in the `@neutron/chat-core`
**Store** (the seam the sync engine + send-queue already depend on), so search
rides BOTH durable backends without forking the engine.

- **`chat-core/search.ts` (NEW).** The shared search layer: `MessageSearchHit` /
  `MessageSearchOptions` types; `sanitizeFtsQuery` (free text → safe FTS5 MATCH,
  hyphenated terms phrase-quoted — lifted from `doc-search/query.ts`); and
  `searchMessagesInMemory` — the pure-JS AND-of-terms scan with TF/length
  relevance blended with recency and `[`…`]` highlighting, shared by the
  in-memory path. ~`RELEVANCE_WEIGHT = 0.7`.
- **`chat-core/store.ts`.** `Store` gains `searchMessages(query, opts)`.
  `InMemoryStore` implements it (scope by topic/project/global, then delegate to
  `searchMessagesInMemory`) — which automatically gives the OPFS web store
  (`stores/opfs-store.ts`, delegates to its in-memory index) search too.
- **`app/lib/chat-core/sqlite-store.ts` — real FTS5.** Adds a `chat_fts`
  **external-content FTS5** virtual table over the message `body`, kept in
  lock-step with `chat_messages` by AFTER INSERT/DELETE/UPDATE triggers (the
  store's only write is still `INSERT OR REPLACE` on the message table; the
  reconcile DELETE + the trigger pair keep the mirror exact). `searchMessages`
  ranks by **BM25** (normalised to [0,1]), orders relevance-then-recency, and
  highlights via SQLite `snippet()`. `open()` one-shot `'rebuild'`s the index
  when the FTS table did not pre-exist but the message table holds rows (the
  cold-open path for a DB written before message search). This is the op-sqlite
  (RN) backend, verified on real SQL via the bun:sqlite adapter; wasm-SQLite
  (web) drops in behind the same class.
- **`message-search/` (NEW workspace package, `@neutronai/message-search`).** The
  runtime + agent-tool surface (twin of `doc-search/`). `StoreMessageSearchRuntime`
  wraps any chat-core Store (supports global cross-topic search).
  `HistorySourceMessageSearchRuntime` is the server shape — hydrates an ephemeral
  in-memory FTS index from one topic's history, so the gateway needs no persistent
  message index. `registerMessageSearchToolSurface` registers the read-only
  `read:project_data` **`message_search`** `{query, limit?, global?}` tool, scoped
  to the CURRENT conversation by default (the call's `topic_id`), `global=true` to
  widen.
- **Gateway wiring.** `MiscCompositionInput.message_search?.runtime` (optional seam,
  mirrors `doc_search`); `build-core-modules.ts` registers the tool when present.
  `gateway/composition/message-search-wiring.ts` (NEW) adapts ButtonStore turn
  history (agent prompt body + user resolution reply → chat messages, cursor-paged)
  into the runtime's `MessageHistorySource`; `open/composer.ts` supplies it from
  `landing.buttonStore`. Failure-isolated (a history read error degrades to no
  results).
- **Scope boundary.** chat-core search supports topic/project/**global**; the server
  ButtonStore bridge is **per-topic** ("search THIS conversation" — the dominant
  agent need). Cross-topic global search is the client store's job (web
  wasm-sqlite / RN op-sqlite). Receipts / reactions / edit-delete are later Phase 4
  slices, out of scope here.

**Tests.** `chat-core/__tests__/search.test.ts` (sanitiser, snippet, JS rank/scope/
edit/clear), `app/__tests__/chat-core-sqlite-search.test.ts` (real FTS5: rank +
highlight, topic/project/global scope, edit/reconcile/clear keep the mirror
consistent, hyphen-token recall, cold-open backfill), `message-search/{runtime,tool}.test.ts`
(both runtimes + the registered tool end-to-end), and
`gateway/composition/__tests__/message-search-wiring.test.ts` (ButtonStore bridge incl.
pagination + failure degradation). `tsc --noEmit` clean; full `run-tests.sh` green
(760 files / 8 chunks).

## 2026-06-21 — WAVE 2 non-blocking follow-ups: trident channel-kind, reminders crash dedup, proactive minors, CI gate, persona escape (#317/#319/#320/#321/#322)

**Problem.** Five non-blocking follow-ups opened during the WAVE 2 overnight wave
(tracked in the managed repo's `ISSUES.md`):

- **#317 (P2)** — trident terminal result-delivery hard-coded the delivery
  `channel_kind` to `'telegram'` for every run, so a `/code` build originating on
  the app-WebSocket surface would misroute its result post.
- **#319 (P2)** — the reminders dispatcher could double-send across a crash/restart
  window: the row was marked fired only AFTER the post, so a crash between a
  successful post and `markFired` left a still-due `pending` row that re-fired on
  restart.
- **#320 (P3)** — proactive-messaging minors: the quiet-day brief over-claimed
  "Nothing on the calendar" even when the calendar source was unwired/threw; a
  morning-brief delivery outage returned `too_early` so the cron mapped it to
  `skipped` (outages invisible in telemetry); a `state-store.ts` docstring cited
  the wrong migration number (0079 → 0080).
- **#321 (P2)** — `ci.yml`'s `test` job did not fire for PR #10 (a slashed `feat/…`
  head): the `concurrency: ci-${{ github.ref }}` group keyed on a ref whose shape
  varies by branch name, letting the `test` run be superseded/skipped so a PR
  could merge with only CodeQL signal.
- **#322 (P3)** — the per-project `<project_persona>` block was spliced RAW (no XML
  escaping), unlike the skills/escalation blocks; a persona containing
  `</project_persona>` could close the tag early (matters once `projects.persona`
  becomes non-owner-writable in M2/M6).

**What shipped.**

- **#317 — derive the delivery channel from the run record.** New migration
  `0081_code_trident_runs_channel_kind.sql` adds a `channel_kind` column
  (`CHECK IN ('telegram','app_socket','webhook','cli')`, default `'telegram'`) to
  `code_trident_runs`. `trident/store.ts` threads `channel_kind` through
  `TridentRun`/`CreateTridentRunInput`/the DB row/COLS/`create`/`rowToRun`;
  `trident/code-command.ts` accepts an originating `channel_kind` on
  `TridentCodeContext` and persists it on dispatch; `trident/delivery.ts`'s
  `onTerminal` now derives the topic's channel from `run.channel_kind` (the
  build-time `opts.channel_kind` is demoted to a defensive fallback for pre-0081
  rows). Existing rows + Telegram-origin `/code` default to `'telegram'`, so the
  change is backward-compatible.

- **#319 — claim-before-dispatch crash-window dedup.** `reminders/tick.ts` now
  CLAIMS each due row (one-shot → `markFired`; recurring → `advanceRecurrence`)
  BEFORE the post, then dispatches. A crash anywhere during the send leaves an
  already-claimed (fired/advanced-past-due) row that a post-restart `listDue`
  won't return — closing the double-send window. A caught dispatch throw (which
  always means the post did NOT succeed, since the dispatcher only throws BEFORE a
  delivered post) reverts the claim so the row stays pending and retries next tick
  — preserving the existing deliver-or-retry contract. New `ReminderStore.reopen()`
  reverts a just-claimed one-shot row (guarded on `status='fired'` so it can never
  resurrect a cancelled row); recurring revert reuses `reschedule()`.

- **#320 — proactive minors.** `morning-brief.ts` `BriefContext` gains
  `calendar_checked` (set true only when a wired `calendarToday` source resolves
  without throwing); the quiet-day copy now says "Nothing on the calendar" ONLY
  when the calendar was actually checked, else an honest "(I couldn't check your
  calendar.)". `MorningBriefResult.status` gains `'deliver_failed'`, returned on a
  delivery outage instead of `'too_early'`; `cron.ts` maps `deliver_failed` →
  `error` (and `posted` → ok, everything else → skipped). `state-store.ts`
  docstring corrected 0079 → 0080.

- **#321 — CI test-gate always fires on PRs to main.** `ci.yml` concurrency group
  is now `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}`
  — PR runs key on the slash-free PR number, namespaced by workflow, so a head
  branch's name shape can no longer supersede/skip the `test` job. The
  `pull_request` trigger stays filter-free (every PR to any base gets `test`).

- **#322 — XML-escape the project persona.** `build-live-agent-turn.ts` escapes the
  persona body (`&`/`<`/`>`) via a local `escapeProjectPersonaText` before splicing
  it inside `<project_persona>`, mirroring the escalation envelope's text escaping
  rationale (anti-injection for an LLM-consumed envelope).

**Tests (no bookkeeping-only).** `trident/store.test.ts` (channel_kind round-trip
+ default + CHECK rejection), `trident/delivery.test.ts` (per-run channel
derivation, run wins over fallback), `trident/code-command.test.ts` (threading +
default); `reminders/tick.test.ts` (claim-before-post for one-shot + recurring,
restart no-double-send, throw-reverts-claim retry); `morning-brief.test.ts` +
`cron.test.ts` (calendar_checked, quiet-day copy, `deliver_failed`→error);
`build-live-agent-turn.test.ts` (persona injection neutralised, single closing
boundary); `scripts/ci/ci-workflow.test.ts` (trigger + concurrency invariants).
`migrations/runner.test.ts` updated for migration 81; schema snapshot regenerated.
Full suite green; `tsc --noEmit` clean (root + `trident/tsconfig.json`).

NOTE: closing the managed-repo `ISSUES.md` entries is out of scope (different
repo) — the PR notes which issues are fixed.

## 2026-06-21 — QMD-equivalent local doc search + `doc_search` / `doc_read` agent tools (gap-audit §(a) P1 #9 / §(b) cat 13)

**Problem.** The daily-driver gap audit flagged that Neutron agents could read a
KNOWN doc path (`runtime/doc-links.ts`) but had **no corpus search** over the
owner's project folders. Vajra agents hit QMD across ~1700 docs BEFORE asking
the user anything (Design Principle #4 — "research before asking"); without an
equivalent that discipline can't function in Neutron. There was full-text search
INSIDE individual Cores (`cores/free/research`, `cores/free/notes` — both
project-scoped FTS5 over DB rows) but nothing that indexed the markdown files on
disk under `<owner_home>/Projects/<id>/` (README / STATUS / CLAUDE / docs /
research / notes / archive).

**What shipped.** A new OSS-friendly workspace package `@neutronai/doc-search`
(`doc-search/`) — a local BM25 markdown corpus index + query, exposed to the
live agent as two tools. No SaaS / external-embedding dependency for the
baseline (pure `bun:sqlite` FTS5).

- **`doc-search/store.ts` — `DocSearchIndex` (NEW).** A `bun:sqlite` FTS5 index.
  `doc_chunks` is the content table (one row per heading-scoped chunk);
  `doc_fts` is an external-content FTS5 mirror over `(title, heading, body)` kept
  in sync by AFTER INSERT/UPDATE/DELETE triggers (the canonical FTS5
  contentless-sync pattern). Ranking is **BM25 with column weights** (title 10 ≫
  heading 4 ≫ body 1) via SQLite's `bm25()`; scores are min-max normalised to a
  [0,1] relevance. Results are **collapsed to the best chunk per file** so a
  query returns ranked DOCUMENTS (with the matching section's heading + a
  `snippet()` excerpt), not a flood of chunks. The FTS query is sanitised
  (`doc-search/query.ts`, lifted from `cores/free/research`) so raw agent text
  can't trip FTS5's `NEAR`/`NOT`/paren grammar. **Semantic search is OPTIONAL and
  behind the `embedder` seam** — off by default (pure lexical); when an `Embedder`
  is supplied, chunk embeddings are stored and the top lexical candidates are
  cosine-reranked and blended (0.6 lex / 0.4 vec). The baseline never pulls an
  external provider.

- **`doc-search/chunk.ts` (NEW).** Deterministic markdown chunker: title = first
  `# ` heading (else de-slugged filename); one chunk per ATX heading (`#`..
  `######`) plus a preamble chunk; long sections split at paragraph boundaries to
  a char budget; heading-looking lines inside ``` / ~~~ code fences are NOT
  treated as headings.

- **`doc-search/walk.ts` (NEW).** `walkProjectMarkdown(projectRoot)` enumerates
  `.md`/`.markdown` files under a project, skipping hidden segments (`.git`,
  dotfiles), `node_modules`, oversized files (>5 MB), and symlink escapes.
  `readProjectDoc(ownerHome, project, relpath)` is the path-safe single-doc read
  backing `doc_read` (project_id grammar + traversal/realpath-containment +
  extension + size checks), scoped to `<owner_home>/Projects/<id>/`.

- **`doc-search/indexer.ts` (NEW).** `refreshIndex({ownerHome, index})` walks
  every project (`doc-search/projects.ts`, mirrors `gateway/projects/enumerate.ts`),
  chunks each file, and upserts it. **Incremental:** unchanged files (by mtime)
  are skipped, deleted files are dropped, removed projects are purged — a no-op
  second run when nothing changed.

- **`doc-search/runtime.ts` — `DocSearchRuntime` (NEW).** Binds the index to an
  `owner_home`; exposes `search` / `read` / `ensureFresh`. `ensureFresh` is
  throttled (default 5 s, shared in-flight) so calling it before every search
  costs at most one incremental disk-diff per interval. Constructs synchronously
  (so it slots into the gateway's synchronous `tools` module init); the first
  refresh is lazy on the first tool call.

- **`doc-search/tool.ts` (NEW).** `registerDocSearchToolSurface(registry, runtime)`
  registers two read-only agent tools (capability `read:docs`, `approval: auto`)
  into the shared `ToolRegistry`:
  - **`doc_search`** `{query, project?, limit?}` -> ranked `{project, path, title,
    heading, score, snippet}[]`.
  - **`doc_read`** `{project, path}` -> `{found, project?, path?, content?}`.

- **Wiring (agent-native).** `gateway/composition/build-core-modules.ts` — the
  `tools` module registers the doc-search surface alongside
  `registerNeutronToolsSurface` when the composer supplies
  `input.doc_search.runtime` (new optional `MiscCompositionInput.doc_search`
  field). `open/composer.ts` builds the index at
  `<owner_home>/cache/doc-search/index.db` + the runtime, threads it into the
  composition, and closes the handle on shutdown. Failure-isolated: a doc-search
  open failure logs and disables the tools without sinking boot.

**Verification (REAL).** New co-located tests, all green:
`doc-search/chunk.test.ts`, `doc-search/store.test.ts` (BM25 ranking, per-file
collapse, project scoping, incremental reindex, stats, optional semantic hybrid
with a deterministic dependency-free embedder, cosine), `doc-search/indexer.test.ts`
(indexes a **real on-disk fixture project tree**, asserts the right doc ranks
first, incremental edit/add/delete/project-purge, path-safe read traversal
rejection), `doc-search/tool.test.ts` (registration + handlers + ensureFresh
throttle) — 38 doc-search tests pass. Full repo: `bunx tsc --noEmit` clean;
`scripts/run-tests.sh` PASS — 746 files across 8 chunks green (gateway+open
composition suites: 958 pass, confirming the wiring is intact).

**Cross-model review (Codex).** Two correctness bugs Codex flagged were fixed in
this PR: (1) hyphenated query terms (`daily-driver`, `gap-audit`) were passed to
FTS5 unquoted where `-` is query syntax → the MATCH threw and the term became
unsearchable; the sanitiser now only leaves `[A-Za-z0-9_]+` bare and phrase-quotes
everything else (`doc-search/query.ts`). (2) the document `limit` was applied at
the chunk level before the per-file collapse, so one large file with many matching
sections could crowd out other documents; `search()` now pulls BM25-ordered
candidates to a high safety cap (`CANDIDATE_CAP = 5000`), collapses to the best
chunk per file, and applies the limit at the FILE level (`doc-search/store.ts`).
Both have regression tests in `doc-search/store.test.ts`.

**Known boundary (reachability).** Codex also flagged (P1) that the registered
tools are not yet reachable by the *completed-phase live Claude Code chat agent*:
that path builds its `--tools` allow-list from `DEFAULT_TOOL_NAMES` (`Read` /
`Glob` / `Grep`) and the dev-channel MCP only exposes `reply` / `send_typing` —
the `ToolRegistry` / `McpServer` is built in the module graph but is NOT bridged
into the live CC substrate. This is a **pre-existing platform-wide gap that
affects every registry tool** (the `registerNeutronToolsSurface` stubs and all
Cores tools share it), not something this PR introduces; bridging the registry/MCP
surface into the live CC REPL is substantial separate platform work. doc_search /
doc_read register through the canonical `ToolRegistry` (reachable today via the
MCP-server surface + programmatic callers); the live CC agent meanwhile can
already `Grep`/`Read` the project tree (cwd = owner_home) — doc-search adds the
BM25 ranking + structured surface the bridge will expose. Tracked as a follow-up.

**Not in scope.** Indexing the entities wiki / non-project docs; a production
local embedder (the semantic seam ships but no provider is wired); surfacing
doc-search through the web UI; the live-CC-agent tool bridge (see Known boundary);
the Obsidian `obs.*` redirector confirmation (the other half of gap-audit cat 13).

## 2026-06-21 — React + assistant-ui web chat client, behind a flag (Track B Phase 3)

**Problem.** The parity-research doc (`web-chat-telegram-parity-architecture-
2026-06-20`) ranks the web chat as "nowhere near Telegram." Phase 1 shipped the
hard part — `@neutron/chat-core` (WS client + send-queue + append-only sync
engine + local Store) on the app-ws surface with a monotonic `seq` + resume.
Phase 3 is the largest/riskiest chunk: replace the 4.5k-line bespoke vanilla-TS
web client with the locked stack (**React + `@assistant-ui/react`, MIT, bring-
your-own-transport**) — but ship it BEHIND A FLAG with the vanilla client intact
as the default fallback, no cutover.

**What shipped.**

- **`chat-core/web-session.ts` — additive `onFrame` observer.** The sync layer
  persists only final `user_message`/`agent_message`s; the UI also needs the
  ephemeral `agent_message_partial` token stream + typing hints. `onFrame(frame)`
  surfaces every raw inbound frame BEFORE the persist decision, as a pure
  observer (errors swallowed) — so Phase-1 wiring is byte-for-byte unchanged.
  Covered by a new web-session test.

- **`landing/chat-react/` (NEW) — the React client.** Layered for testability:
  `config.ts` (pure bootstrap: start-token `sub` → `app:<user_id>` topic +
  app-ws URL; dev-bypass token default, `window.__neutron_app_ws_token`
  override), `controller.ts` (`NeutronChatController` — framework-agnostic data
  layer: streaming-partial accumulation into a live agent bubble the final
  persisted message supersedes, `isRunning` typing derivation, connection +
  offline-queue state, synchronous `ChatViewModel`; session injected via a
  factory so it integration-tests against a real `WebChatSession` + fake socket),
  `message-adapter.ts` (pure `RenderMessage → ThreadMessageLike`),
  `useNeutronChat.ts` (thin React seam → assistant-ui `ExternalStoreRuntime`),
  `ChatApp.tsx` (UI from assistant-ui PRIMITIVES — the styled `Thread` left the
  core package in 0.14.x — styled to the existing dark theme: topic rail,
  connection banner, offline-pending badge, streaming dots), `main.tsx` (entry,
  bundled to `/chat-react.js`).

- **`landing/web-chat-flag.ts` + `landing/server.ts` — the flag.**
  `resolveWebChatClient({ envDefault, queryClient })`: env
  `NEUTRON_WEB_CHAT_CLIENT` (deploy default) with a `?client=react|vanilla`
  per-request override; default/garbage → vanilla. `GET /chat` serves the React
  shell (`chat-react.html`) only when the flag resolves to `react` AND the assets
  shipped (`existsSync`-guarded — else vanilla); `/chat-react.js` is lazily
  bundled from `chat-react/main.tsx` via `Bun.build` (minified, ~0.6 MB),
  mirroring the existing `chat.ts` → `/chat.js` path. Vanilla is otherwise
  untouched.

**Tests.** chat-core onFrame test; controller integration over a real
`WebChatSession`+fake socket (optimistic send, streaming→final supersede,
offline queue, status transitions, project tagging); pure adapter + config
tests; happy-dom component smoke (full assistant-ui render: optimistic send +
streamed-then-finalized agent reply reach the DOM); flag + flag-gated serving
tests. `bunx tsc -p tsconfig.json` (root gate) + `bunx tsc -p
landing/chat-react/tsconfig.json` (React leaf, isolated from the gate) both
clean; `bun test chat-core landing` green (577 pass).

**Parity gaps (documented, vanilla stays default until closed):** attachment
compose-UI (rendering + data path done; upload affordance pending), "load
earlier" paging beyond the resume window, and the production app-ws web token
mint (the deferred identity sub-sprint the app-ws auth resolver itself notes).

## 2026-06-21 — Agent-aware watchdog + double-spawn guard for the dispatch layer (WAVE 2 P1, gap-audit §(b) #8)

**Problem.** The daily-driver gap audit (§(b) #8) flagged two reliability holes
in the agent-dispatch layer (`runtime/subagent/`):

1. **Double-spawn.** `spawnSubagent` minted a fresh `run_id` on every call, so
   two dispatches for the SAME logical task each started their own process —
   the Vajra incident class (registry-only pid never killed → two processes on
   one session). Nothing keyed spawns to the task.
2. **No agent-aware liveness surfacing.** The generic `lifecycle.ts` reaper
   silently `cancel`s stale `running` records and marks pid-gone ones
   `crashed`, but it never SURFACES the failure. A crashed/stuck dispatched
   agent just dropped out of `live()`; a caller awaiting it (`waitForCompletion`)
   hung forever with no signal, no failure reason, no notification.

**What shipped** (scoped to the dispatch layer — `runtime/subagent/` only):

- **Double-spawn GUARD (`spawn.ts` + `registry.ts`).** `SpawnInput` gains an
  optional logical `spawn_key` (callers namespace it, e.g.
  `${instance_key}:${task_id}:${agent_kind}`) and `on_duplicate: 'coalesce' |
  'refuse'` (default `coalesce`). Step **0** of `spawnSubagent` — run BEFORE the
  concurrency/depth checks — consults the new `registry.liveByKey(spawn_key)`:
  if a LIVE (`pending`|`running`) record already holds the key it either returns
  that in-flight record (coalesce — no second process, no wasted `run_id`, no
  concurrency slot consumed) or throws (refuse). A TERMINAL record with the same
  key does NOT match, so once the prior run finishes — or the watchdog reaps it
  — a fresh spawn is allowed through. `spawn_key` persists on the record. With
  no `spawn_key` the guard is inert (full back-compat).

- **Agent-aware WATCHDOG (`watchdog.ts`, NEW).** `runAgentWatchdog(deps)` walks
  the dispatched-agent registry and, for each LIVE record, detects + SURFACES
  one of two terminal conditions:
  - **`process_dead`** — the record has a `pid` whose OS process is gone yet it
    never reached terminal. (Takes precedence over `stuck`.)
  - **`stuck`** — `last_event_at` is older than the per-agent-kind inactivity
    threshold (`StuckThresholdConfig`: a flat number or a per-`AgentKind` map;
    default `DEFAULT_STUCK_THRESHOLD_MS` = 5 min). A wedged process may still be
    alive, so it is killed via the registered canceller before surfacing.
  Surfacing = mark the run **failed** (new `failRun` control verb → terminal
  `status='crashed'` + `failure_reason`, distinct from a deliberate
  `cancelRun`) **AND** emit a structured `AgentWatchdogEvent` (`run_id`,
  `agent_kind`, `instance_key`, `reason`, `delivery_target`, `age_ms`, `pid`)
  through an injected `notify` sink (Telegram / the `watchdog/` AlertStore / a
  log). It does NOT auto-respawn (out of scope) but the event carries enough
  context for a caller to retry/notify. Pure + injectable (`now` / `pid_alive` /
  `notify`); idempotent.

- **`lifecycle.ts` now COMPOSES the watchdog** instead of duplicating liveness
  reaping. It previously reaped stale-`running` records SILENTLY (`cancelRun`)
  and marked pid-gone ones `crashed` with no notification; running that beside
  the new surfacing watchdog at the same 5-min threshold raced — if the silent
  pass won the tick it swallowed the very failure the watchdog was meant to
  surface (a record gone from `live()` is never seen by the watchdog).
  `runLifecycleTick` is now one ordered tick: **(1)** when `watchdog` deps are
  supplied it runs `runAgentWatchdog` first (the SOLE owner of live→terminal
  transitions — surfaces stale/dead agents), **(2)** then prunes already-terminal
  records past `cleanup_after`. One reaper, defined order, no race — and the
  established tick entry point keeps reaping liveness (now via the surfacing
  path) rather than silently losing it. Omit the `watchdog` deps for a
  prune-only tick. (`STALE_THRESHOLD_MS` kept as a deprecated alias;
  `LifecycleDeps` = `{ registry, now?, watchdog? }`.)

  Guard + watchdog are complementary: the watchdog reaps a registry-live-but-
  process-dead record so a legitimate re-spawn can proceed, while the guard
  blocks a concurrent duplicate while the first is genuinely in flight.

**Tests** (real, both surfaces): `runtime/subagent/spawn-guard.test.ts` (7) —
duplicate coalesced/refused, coalesce holds while running, terminal key
recycles, distinct keys don't collide, back-compat without a key, coalesce
bypasses the concurrency cap. `runtime/subagent/watchdog.test.ts` (10) — dead
detected→crashed+notified, `process_dead` precedence, stuck killed+surfaced,
healthy-not-surfaced, per-kind + flat thresholds, `delivery_target` rides along,
throwing notifier doesn't abort the tick, idempotent across ticks. Full suite:
`bun test runtime/ trident/ cores/free/code-gen/` → 1164 pass / 0 fail; `tsc
--noEmit` clean.

**Not in scope (follow-ups).** No production *caller* sets `spawn_key` or runs
`runAgentWatchdog` on a tick yet — the gateway wires the registry's `notify`
sink + a periodic tick when the dispatch layer leaves S3 (in-process only) for
S4 (SQLite-backed, restart-surviving). Per-agent retry/auto-respawn (audit #8's
"scribe auto-respawn") is deliberately deferred. This change supplies the guard
+ surfacing capability; the wiring is a one-liner at the dispatch call site.

## 2026-06-21 — Wire Atlas/Sentinel dispatch + load persona `prompts/*.md` (WAVE 2 P1, gap-audit §(a) #7 / §(b) cat 3)

**Problem.** The daily-driver gap audit flagged that the typed agent dispatch
layer was Forge/Argus-only. The trident state machine spawns only `forge` and
`argus` (`orchestrator.ts`). Atlas (research/analysis/ops/strategy/writing) and
Sentinel (review of NON-code work) had no path into the dispatcher at all, even
though `runtime/subagent/registry.ts` already types them in `AgentKind`, and the
`prompts/{atlas,sentinel}.md` persona files were dead code with no loader.

**What shipped.**

- **`trident/agent-prompts.ts` (NEW).** `loadAgentSystemPrompt(kind)` loads
  `prompts/<kind>.md` through `@neutronai/prompts`'s canonical, path-traversal-safe
  `loadPrompt` (which substitutes the platform `{{OWNER_HOME}}` / `{{TELEGRAM_CHAT_ID}}`
  tokens) and returns it as the agent's SYSTEM prompt with `source: 'file'`. On any
  failure (missing/empty/unreadable file) it returns a terse inline
  `AGENT_PROMPT_FALLBACK[kind]` with `source: 'fallback'` — loading a prompt never
  throws into the dispatch path, and a bare checkout still dispatches a functional
  agent. **Disk-prompt loading is SCOPED to the persona agents** via
  `PersonaAgentKind = Exclude<DispatchAgentKind, 'forge' | 'argus'>` (= `'atlas' |
  'sentinel'`): a compile-time guarantee that the build-loop agents can never be
  handed a `prompts/<kind>.md` file as their system prompt. (`DispatchAgentKind =
  Exclude<AgentKind, 'core'>` remains the broader substrate-dispatch `kind` union
  the session input uses.)

- **`trident/agent-dispatch.ts` (NEW).** `dispatchAgent({kind, task, ...}, {dispatch})`
  is the phase-less, one-shot dispatch path that makes Atlas + Sentinel
  dispatchable. It REUSES the existing one-turn `TridentDispatch` substrate
  closure (no trident rebuild): loads `prompts/<kind>.md` as `system`, hands the
  task as the user turn, returns the result plus `kind` + `prompt_source` so
  callers/tests can assert the loaded persona reached the agent config. `kind` is
  typed to `PersonaAgentKind`, so forge/argus are not dispatchable through this
  path (they run through the orchestrator with their native contract).

- **`trident/orchestrator.ts`.** UNCHANGED from before this work — the Forge→Argus
  spawn path keeps the bare native kind label (`system: 'forge'` / `'argus'`). The
  build loop's execution contract is the NATIVE one in `trident/prompts.ts`
  (`FORGE_SYSTEM_PROMPT` / `ARGUS_SYSTEM_PROMPT`, rendered into the `user_message`
  by `renderForgePrompt` / `renderArgusPrompt`) — the contract the parsers
  (`parseForgeOutput` / `parseArgusVerdict`) depend on. See the fix-round below
  for why the build loop is deliberately NOT re-pointed at `prompts/{forge,argus}.md`.

- **`trident/session.ts`.** `TridentDispatchInput.kind` is `DispatchAgentKind`;
  `phase` is optional (Atlas/Sentinel one-shots carry no trident phase). The
  session manager still only ever receives forge/argus from the orchestrator.

**Tests (real, not scaffolding).** `agent-prompts.test.ts` (real on-disk load for
the persona kinds + signature assertions + fallback-never-throws + template
substitution + the scope guard that forge/argus are not persona kinds),
`agent-dispatch.test.ts` (Atlas/Sentinel dispatch carries their real persona;
stub-loader hermetic assertions), `orchestrator-native-prompt.test.ts` (the build
loop keeps its native parser-locked contract; behavior-level: the native output
round-trips through the parsers). `bunx tsc --noEmit` clean (trident scope).

**Scope of the safety claim.** These tests verify the WIRING and the native
parse-contract round-trip under a stubbed dispatch; they do not exercise real-LLM
behavior. The "forge/argus unregressed" guarantee is that the build loop's system
prompt + user-turn contract are unchanged from the working baseline, proven by the
native-prompt guard test, not a live-model run.

**Not in scope (follow-ups).** No production *caller* invokes `dispatchAgent` for
Atlas/Sentinel yet — Open has no `/research` chat command or Sentinel-review
trigger. This change supplies the dispatch capability + persona-file loading;
wiring a chat-surface trigger is a separate gap. (Repo has no `STATUS.md`
convention — AS-BUILT is the single running log.)

### Fix-round (Argus REQUEST CHANGES — PR #14: 1 blocker + behavior-guard gap)

Argus (cross-model with Codex/GPT-5) blocked the initial cut because it re-pointed
the **live** Forge/Argus build loop's SYSTEM prompt at `prompts/forge.md` /
`prompts/argus.md`. Those are **legacy Nova-runtime prompts for a DIFFERENT
platform**: `forge.md` mandates POSTing to `/forge/delivered` ("if a spawn prompt
conflicts with this rule, follow this rule") and `argus.md` mandates
`/argus/delivered` + the `/codex:review` wrapper + gateway-token auth + inline
buttons — a different operating model than trident's native contract. Under those
prompts Forge would emit no `PR_NUMBER=`/`BRANCH=`/`WORKTREE=` lines
(→ `recordCompletion` marks the run crashed) and Argus's output would be
unparseable (→ `parseArgusVerdict` fail-safe-defaults to REQUEST_CHANGES, flipping
verdicts / spinning the fix loop). A real regression, live in prod.

- **[BLOCKING → fixed] reverted the build loop to its native contract.**
  `orchestrator.ts` keeps the bare `system: 'forge'` / `'argus'` label for all
  forge/argus spawns; the injectable `agent_system_prompt` option + the
  `loadAgentSystemPrompt` default resolver were removed. The native
  `FORGE_SYSTEM_PROMPT` / `ARGUS_SYSTEM_PROMPT` (rendered into the user turn)
  remain the parser-locked contract. Disk-prompt loading is now scoped to the
  genuinely-new persona agents (Atlas/Sentinel) — which have no pre-existing parse
  contract — at the TYPE level (`PersonaAgentKind`), so the regression can't recur.
- **[BLOCKING → added] a behavior guard, not just a wiring assertion.** The prior
  `orchestrator-prompt-loading.test.ts` (which pinned the now-reverted behavior)
  was replaced by `orchestrator-native-prompt.test.ts`: it asserts the dispatched
  system prompt is the bare native label, that the legacy `/forge/delivered` /
  `/argus/delivered` / `/codex:review` operating model never reaches the agent
  (neither system NOR user turn), AND that the native contract round-trips — a
  forge turn's `PR_NUMBER=…` is captured (run advances off forge-init, not
  crashed) and a native `APPROVE` is honored (run reaches `done`, not flipped to
  forge-fix).
- **PR/AS-BUILT wording corrected** to scope the safety claim to the wiring +
  native round-trip (see "Scope of the safety claim" above), not real-LLM behavior.

### Fix-round 2 (Argus REQUEST CHANGES — PR #14 round 3: persona dispatch mis-tooled)

The legacy-prompt regression fix above stayed good. Round-3 Argus + Codex/GPT-5
surfaced a **new blocker**: persona dispatch was wired to the persona PROMPTS but
not the persona TOOLS. `buildRuntimeSubagentDispatch` (the only real substrate
dispatcher, `cores/free/code-gen/src/substrate-runtime.ts`) picked its toolset with
`input.kind === 'forge' ? forge_tool_defs : argus_tool_defs`. Every non-`forge`
kind — including the new `atlas`/`sentinel` — fell to `ARGUS_TOOL_DEFS` (`[read,
bash]`, bash allowlist-gated to read-only). So Atlas (research / analysis / ops /
strategy / **writing**) would load its persona correctly but be physically unable
to write its deliverable. The PR's `agent-dispatch.test.ts` masked this: it stubbed
the dispatch and asserted only that the persona reached `system`, never the TOOLS.
Codex rated it P2 (dormant — no production caller yet); Argus elevated to BLOCKING
because the headline capability ("Atlas/Sentinel dispatch works") was wrong-by-
construction against the single real implementation.

- **[BLOCKING → fixed] per-kind toolset routing on the real substrate.**
  `buildRuntimeSubagentDispatch` now resolves BOTH tool defs and handlers from
  per-kind maps (`tool_defs_by_kind` / `tool_handlers_by_kind`, keyed by the new
  `CodegenSubagentKind = 'forge'|'argus'|'atlas'|'sentinel'`) instead of a
  forge/else branch + a single merged handler map. There is **no silent fallback**:
  a kind dispatched with no configured surface THROWS rather than inheriting
  another role's tools. New role toolsets in `tool-handlers.ts`:
  - `ATLAS_TOOL_DEFS` + `buildAtlasToolHandlers()` — full read/write/edit/grep/glob
    plus UNRESTRICTED bash (Atlas writes deliverables and runs ops).
  - `SENTINEL_TOOL_DEFS` + `buildSentinelToolHandlers()` — read + grep/glob only
    (a non-code reviewer inspects the artifact; no shell, no write).
  Keying handlers by kind (not one merged map) also lets the shared tool name
  `bash` carry different gating per role — Forge/Atlas unrestricted, Argus
  allowlist-gated read-only, Sentinel none — instead of Argus's gated bash silently
  clobbering Forge's in the merged map.
- **[BLOCKING → de-stubbed] real toolset assertions on the substrate seam.**
  `substrate-runtime.test.ts` adds a `per-kind toolset routing` suite that runs the
  REAL `buildRuntimeSubagentDispatch` against the REAL production tool defs and
  asserts the toolset that actually reaches `llm_call` for each kind (forge/atlas
  write-capable, argus/sentinel read-only — and no persona kind collapses onto
  Argus's set), that Atlas's `write` tool_use is dispatched to a real handler, that
  Sentinel's `write` tool_use is rejected (`not available`), and that an
  unconfigured kind throws (no silent fallback). `wiring-production.ts` supplies all
  four kinds' defs+handlers; the gateway prod-wiring tests stay green.

  Still out of scope (unchanged): no production *caller* invokes `dispatchAgent`
  for Atlas/Sentinel yet — this round makes the substrate correctly SERVE the
  persona kinds; wiring a chat-surface trigger remains a follow-up.

### Fix-round 3 (Argus REQUEST CHANGES — PR #14 round 4: persona ↔ toolset still mis-reconciled)

Round-3's per-kind toolset routing stayed good (Atlas write-capable on the real
substrate, forge/argus native, legacy-prompt regression fixed). Round-4 Argus +
Codex/GPT-5 found the toolset was only HALF the contract: the **personas loaded
as the agents' system prompts still carried the legacy Vajra/Nova SELF-DELIVERY
operating model** — `bash {{OWNER_HOME}}/scripts/tg-post.sh <CHAT_ID> <THREAD_ID>`
+ a "verify exit code 0 before exiting; do NOT exit with a failed post" mandate.
The substrate `dispatchAgent` is a one-shot path: it returns terminal text via
`DispatchAgentOutcome.result` for the CALLER to deliver — there is no gateway and
no `<CHAT_ID>`/`<THREAD_ID>` in this path. So:

- **[BLOCKING] Sentinel was wrong-by-construction** (same class as round-3 Atlas).
  Sentinel's loaded `prompts/sentinel.md` HARD-MANDATED a `bash` self-POST, but
  `SENTINEL_TOOL_DEFS = [read, grep, glob]` has no bash — a Sentinel that followed
  its loaded contract would emit `not available` tool errors on its mandated final
  delivery step and could not complete as instructed.
- **[IMPORTANT] Atlas carried the same self-delivery leak.** Atlas HAS bash so it
  wouldn't hit "tool not available", but it would try to POST to a gateway that
  isn't there and treat the failed post as "not done".

**Fix (option (a), the architecturally-correct one per the verdict): adapt the
loaded personas for the substrate one-shot path — strip the self-delivery
mandate; the caller delivers the returned `result`.**

- **`prompts/sentinel.md`.** Replaced the `tg-post`/`<CHAT_ID>`/`<THREAD_ID>` +
  exit-code-0 "Post verdict" step with **"Return your verdict as your final
  message"** — explicitly READ-ONLY (read/grep/glob; no shell, no write, no
  chat/thread context), the caller delivers it. With the self-delivery mandate
  gone, the read-only toolset is now CORRECTLY reconciled with the persona (a
  non-code reviewer inspects the artifact and returns a verdict; it never produces
  or self-delivers). The "write detail to a file" fallback was removed (Sentinel
  has no write tool — that would itself order a tool the toolset lacks).
- **`prompts/atlas.md`.** Replaced the `tg-post` "Post results" step with **"Return
  your result as your final message"** — Atlas still WRITES its full deliverable to
  a file (it has write/edit/bash) and returns a concise summary + the output path,
  but no longer shells out to self-POST. Fixed the "Message Sam directly — post to
  the Telegram topic and exit" line to "return your result as your terminal output
  and exit; the caller delivers it". Atlas's write-capable toolset is unchanged and
  correct (it produces deliverables).
- **`substrate-runtime.test.ts` — reconciliation pinned on the real seam.** Added a
  `persona prompt ↔ toolset reconciliation (no self-delivery leak)` suite that
  loads the REAL `prompts/{atlas,sentinel}.md` (via the leaf `@neutronai/prompts`
  reader) and asserts, per persona: (1) a persona whose dispatched toolset lacks
  `bash` DEMONSTRATES no ```bash fence (Sentinel orders no tool it cannot run);
  (2) no runnable fence invokes `tg-post` and no fence references `<CHAT_ID>` /
  `<THREAD_ID>` (the cross-runtime self-delivery model the substrate never
  supplies). This closes the round-3 caveat (the routing suite asserted Sentinel
  read-only "as if correct" without reconciling the loaded prompt).

**Verify (REAL).** `bunx tsc -p trident/tsconfig.json` 0 errors; root `bunx tsc
--noEmit` 0 errors; `bun test cores/free/code-gen/__tests__/substrate-runtime.test.ts`
→ 21 pass (was 16; +5 reconciliation tests); `bun test trident/` → 201 pass;
`bun test cores/free/code-gen/` → 119 pass. No production caller invokes the
persona dispatch yet — unchanged follow-up.

## 2026-06-21 — PR #15 Argus fix-pass #2: abort the scan on an infra store exception (apply-path data loss)

Argus (Codex/GPT-5 cross-model + Claude correctness trace) found the SAME
silent-data-loss-on-infra-failure class as fix-pass #1, but on the
store-WRITE path rather than the requeue path:

**Blocker — a transient store failure permanently dropped the inbox row
(`tasks/inbox/apply.ts` + `drainClaimed`/`finalizeProcessing`).**
`applyInboxRow`'s outer `catch` converted ANY store throw into an `errored`
outcome. The per-action helpers already handle the EXPECTED per-row cases
(unique→`duplicate`, `TaskNotFoundError`→`not_found`), so what reached the
outer catch was an UNEXPECTED store/infra error — most importantly
`BusyRetryExhaustedError` after the 15-retry `withBusyRetry` budget under
sustained contention, or a disk/IO error. Because `drainClaimed` advances
the baseline BEFORE applying, that `errored` row sat behind `finalBaseline`;
`runTaskScan` archived it, `finalizeProcessing` found no residual past the
baseline, and the sidecar was unlinked → the valid row was lost, never
retried.

**Fix — distinguish TRANSIENT infra exceptions from deterministic per-row
rejections.** New `isTransientStoreError()` (`apply.ts`) classifies an
exception as transient iff it is a `BusyRetryExhaustedError`, carries a
transient Node IO `code` (ENOSPC/EIO/EACCES/EAGAIN/EBUSY/EMFILE/ENFILE/
EROFS/EDQUOT/…), or matches a transient SQLite message (disk I/O error /
disk full / database is locked / SQLITE_BUSY / unable to open database).
`applyInboxRow` now RE-THROWS a transient error (so the scan aborts) but
still captures everything else as an `errored` outcome. `drainClaimed`
wraps a transient throw in the new `TaskScanAbortedError` and aborts the
scan WITHOUT advancing the baseline; `runTaskScan` therefore never archives,
renders, or finalizes — the claimed rows stay in the `.processing` sidecar
and the next scan recovers + retries them idempotently (stable ids /
skip-on-missing). The baseline now advances ONLY after a clean apply.

**Why classify instead of "any throw aborts":** a deterministic per-row
rejection (an unexpected constraint/validation error, a programming bug)
would re-fail identically every scan; aborting on it would LIVELOCK the whole
queue, because `claimInbox` always drains the sidecar before the live inbox.
Deterministic failures keep the prior non-blocking behavior (archived as
`errored`, baseline advanced, sidecar dropped), so one poison row can never
wedge the queue.

**Minor (deferred per the verdict):** the residual-unlink TOCTOU in
`finalizeProcessing` (a pre-rename fd appending between the length re-check
and `unlinkSync`) is documented as unreachable under the blessed atomic
`appendInboxRow` API. Closing it by renaming the sidecar to a unique
`.processed-<id>` would need a new orphan-cleanup pass (those files are never
re-claimed) — non-trivial, so left as a follow-up.

**Tests (real):** `inbox-scanner.test.ts` gains: a `BusyRetryExhaustedError`
on `create` ABORTS the scan (throws `TaskScanAbortedError`), LEAVES the
sidecar intact, never reaches the store, archives nothing, and the next scan
applies the row; a transient disk/IO error (`code:'ENOSPC'`) aborts the same
way; and a DETERMINISTIC store error is archived as `errored` + skipped (NOT
aborted) with the queue advanced and a later row unblocked (no livelock).
`bunx tsc --noEmit` clean; full `bash scripts/run-tests.sh` green (739 files,
0 failed chunks).

## 2026-06-21 — PR #15 Argus fix-pass: close the scanner finalize data-loss windows + resolve main conflicts

Argus (Codex/GPT-5 cross-model + Claude correctness reviewer, independently
converged) flagged two IMPORTANT correctness holes in
`tasks/inbox/scanner.ts`'s drain/finalize path. Both fixed:

1. **Unlink-after-failed-requeue lost residual rows — `finalizeProcessing`.**
   If the residual `appendFileSync(inboxPath, tail)` requeue threw (disk full,
   EACCES on the live inbox), control fell to the catch and then
   UNCONDITIONALLY `unlinkSync`'d the sidecar → residual neither applied nor
   left for recovery (silent loss). Now the sidecar is dropped ONLY when the
   requeue actually succeeded (or there was no complete residual); a failed
   requeue LEAVES the sidecar so the next scan recovers it (reprocessing is
   idempotent via stable ids / skip-on-missing).

2. **Byte-boundary line split + unlink TOCTOU — `drainClaimed` + `finalizeProcessing`.**
   The drain/finalize tail was sliced purely by byte count
   (`subarray(baseline)`), so a reader observing a sidecar mid-append could
   split a JSON line at a non-newline boundary — the committed row recorded as
   two parse errors and lost. The drain/finalize now read the sidecar from
   disk through a single `readConsumable()` reader. Complete (newline-
   terminated) lines are always safe. A trailing line WITHOUT a newline is
   resolved without relying on timing alone: (1) if it is a complete JSONL row
   (valid JSON — and since no proper byte-prefix of a complete JSON object is
   itself valid JSON, a fragment never masquerades as one) it is consumed, so
   a hand-edited final row with no trailing newline drains instead of
   livelocking the sidecar; (2) a malformed tail uses GROWTH as the tiebreaker
   — still growing ⇒ an active writer is mid-line, so only whole lines are
   consumed and the partial is left (`partial`); stable ⇒ a settled bad
   hand-edit, consumed and archived as a parse error so it can never block the
   queue. (The lone unhandled case — an out-of-band fd that pauses mid-line
   exactly across the two reads — is unreachable under the blessed atomic-
   append API and accepted.) `finalizeProcessing` also re-reads the sidecar
   immediately before `unlinkSync` and removes it only when the length is
   unchanged since the read — closing the read→unlink TOCTOU window (on BOTH
   the residual and no-residual paths); an unreadable sidecar is left, never
   blind-unlinked.

Note (minor, documented): DASHBOARD.md task lines are rendered inline (richer
human "today" view) and intentionally bypass `renderTaskLine`, so the "locked
Nova tag format lives in exactly one place" claim covers tasks.md/STATUS.md but
not DASHBOARD.md.

**Tests (real):** `inbox-scanner.test.ts` gains: a FAILED requeue write LEAVES
the sidecar intact (no data loss) AND the next scan recovers both rows; a
hand-edited final row without a trailing newline is applied, not stranded; a
stable malformed final line without a newline is archived as a parse error and
never blocks later rows (no livelock); a newline-less residual is requeued
newline-terminated so it can't livelock; plus `completeLineTail` newline-snap
unit tests. `bunx tsc --noEmit` clean; full `bash scripts/run-tests.sh` green
(two passes). Hardened across several Codex cross-model review rounds.

Also resolved the PR #15 vs `main` conflict (only `AS-BUILT.md`; both the
markdown-task-surface entry and main's per-topic-session-isolation entry kept).

## 2026-06-21 — Markdown task surface: task-inbox append-queue + tasks.md / DASHBOARD.md scanner (gap-audit P1 #11)

Closes gap-audit §(a) #11 / §(b) cat 11: the focus-score formula
(`tasks/focus-score.ts`) was ported and runs on a 4h cron, but tasks lived
only in SQLite + the web app — there was **no markdown surface**. Ryan's
workflow is markdown-first (modelled on Vajra's `tasks.md` /
`gateway/task-inbox.jsonl` / `scripts/task-scanner.py`). This adds the
markdown-first surface **on top of** the canonical `TaskStore` — the store
stays the source of truth and the markdown is a pure projection.

New module `tasks/inbox/` (no changes to `composer.ts`; scoring NOT rebuilt):

- **`types.ts`** — the JSONL append-queue row schema + a total, pure parser.
  Rows: `add` / `complete` / `update` / `cancel` / `delete`. Human forms
  (`P0..P3`, `YYYY-MM-DD`) are normalized to the store's scales (priority
  0..3, ISO due). Malformed lines surface as `ParseError`s (1-based line
  numbers) instead of throwing — one bad row never blocks the queue. A
  PRESENT-but-invalid `priority`/`due` (e.g. `"P9"`, `"not-a-date"`) is a hard
  parse error, not a silent drop, so a typo can't quietly create an
  unprioritized/undated task.
- **`apply.ts`** — maps a parsed row to the matching `TaskStore` mutation,
  returning a structured `ApplyOutcome`. `add` with a stable `id` is
  idempotent (PK collision → `skipped:'duplicate'`); edit-ops locate by `id`
  or exact open-title match; missing targets → `skipped:'not_found'`. Both
  resolution paths are scoped to the scanner's `project_slug` — an explicit
  `id` is verified to belong to this slug before any mutation, since the
  store's by-id methods are global (no cross-slug task can be touched). Inbox
  writes stamp `source='inbox'`. `listAllTasks` pages through the store so the
  rendered markdown never drops tasks past a fixed cap.
- **`render.ts`** — pure renderers. `tasks.md` = flat focus-ordered active
  list (cross-project) + recent-Done tail. `DASHBOARD.md` = open tasks grouped
  into **auto-promoted P0/P1/P2/P3 sections**: `effectiveBucket` is the
  more-urgent of raw priority and due-date urgency, with bands (overdue /
  ≤2d / ≤7d) matching `focus-score.ts` exactly. Ordering **reuses**
  `computeFocusScore` (recomputed against render-time `now`).
- **`scanner.ts`** — `appendInboxRow` (atomic per-line `O_APPEND`) +
  `runTaskScan`: **claim** the queue (atomic `rename` to a `.processing`
  sidecar) → apply → archive every row+outcome to `task-inbox.archive.jsonl`
  → re-render `tasks.md` + `DASHBOARD.md` (atomic writes via
  `runtime/atomic-write.ts`) → requeue any late writes to the rotated inode,
  then drop the sidecar. Concurrent-append safety: a racing append targets
  the live `task-inbox.jsonl`, which the rename moved aside, so it survives
  in a freshly-recreated inbox the next scan drains; a pre-rename-opened fd
  that writes DURING the apply window is drained IN ORDER within the same
  scan (bounded passes), so a dependent `add`→`update` pair across the rotate
  boundary stays ordered — only a vanishing residual past the drain bound
  requeues, acceptable for the single-scanner, human/agent-cadence usage. At most one sidecar exists at a time: a leftover
  from a crashed scan is drained first and the live inbox waits one cycle, so
  un-committed rows are never clobbered. Crash recovery is idempotent because
  `appendInboxRow` stamps a stable UUID on every id-less `add` AT APPEND
  TIME, so replay collides on the PK and skips instead of double-inserting.
  (Boundary, documented: the blessed `appendInboxRow` API is exactly-once;
  a row HAND-WRITTEN directly to the JSONL with no `id` is at-least-once —
  no content-derivable id can both dedupe a replay and still allow a future
  identical re-add, and we prefer a rare duplicate over losing rows. Hand
  editors include an `"id"` for exactly-once.)
  A re-scan of a drained queue is a no-op. Path resolution is injected so
  composition wires the real `<NEUTRON_HOME>` project-folder paths and the
  scanner stays testable. (Two rounds of Codex cross-model review hardened
  this drain path: the original byte-prefix truncate had a TOCTOU window, and
  id-less `add` replay could duplicate — both fixed here.)

Refactor: `tasks/projection/format.ts` now exports `renderTaskLine` /
`renderDoneLine` (was a private `renderActiveLine`) so the STATUS.md
projection and the new tasks.md surface emit byte-identical task lines — the
locked Nova tag format lives in exactly one place.

**Tests (real, not scaffolding):** `tasks/__tests__/inbox.test.ts` (parse +
priority/due normalization, focus ordering, section promotion, apply against a
real migrated store) and `tasks/__tests__/inbox-scanner.test.ts` (end-to-end:
an inbox append mutates the store AND is reflected in the rendered
tasks.md/DASHBOARD content; idempotent re-scan; concurrent-append survival;
parse errors archived + non-blocking; focus ordering in the rendered file).
23 new tests. `bunx tsc --noEmit` clean; full `bun test` green (7727 pass /
90 skip / 0 fail).

Deferred: composition wiring of the scanner to a cron tick + real
`<NEUTRON_HOME>` paths (a small build-core-modules follow-up; the seam is the
injected `TaskScanPaths`).

## 2026-06-21 — PR #13 post-merge CI red — root-caused & fixed (real-PGLite boot flake)

After `origin/main` was merged into `feat-integrations-admin-ui-wave2-clean` to
resolve conflicts, CI `test` went red on one chunk per run — a **different test
each run**, always an `(unnamed)` failure in a real-GBrain round-trip suite
(`scribe → GBrain real PGLite round-trip` in chunk 7; `B2 memory mirror — real
GBrain round-trip` in chunk 2). Not the integrations feature — those tests pass
23/23 — and not a merge regression: every one of these suites is green standalone
and byte-identical to `main`.

**Root cause** (from the CI stack, run #27900992736):

```
TypeError: undefined is not an object (evaluating 'probe.pages_exists')
  at applyForwardReferenceBootstrap (node_modules/gbrain/.../pglite-engine.ts:475)
  at async initSchema (gbrain/.../pglite-engine.ts:299)
  at async bootBrain (connect/__tests__/shared-project-memory-mirror.test.ts:82)
```

PGLite is a single-threaded in-process WASM Postgres. `scripts/run-tests.sh`
runs each chunk at `--max-concurrency=4` and bun loads a whole chunk into ONE
process, so multiple real-PGLite test files boot their engines concurrently — or
one boots while sibling files starve the CPU. gbrain's pre-schema bootstrap
probe (`const probe = rows[0]`) then intermittently sees a 0-row result, leaving
`probe` undefined → the throw above, surfacing as an `(unnamed)` `beforeAll`
failure. The merge added ~6 test files, shifting chunk boundaries so two
real-PGLite files (scribe-cores-source idx 659 + scribe-gbrain idx 661) now share
chunk 7, tipping a **pre-existing latent flake** (it affects `main` too).

**Fix** (no assertion weakened): extracted the duplicated real-PGLite boot from
all five GBrain round-trip suites into a shared
`gbrain-memory/__tests__/boot-pglite-brain.ts` that (1) serialises engine boots
behind a process-global async mutex so two heavy PGLite inits never overlap
within a chunk, and (2) bounded-retries a fresh engine ONLY on the known
transient bootstrap-probe error (`/evaluating 'probe\./`) — any other boot error
rethrows, so a genuine schema regression still fails. Files: new helper +
`gbrain-memory/__tests__/{sync-hook,memory-store}.test.ts`,
`scribe/__tests__/{scribe-cores-source,scribe-gbrain-roundtrip}.test.ts`,
`connect/__tests__/shared-project-memory-mirror.test.ts`.

**Verification:** `bunx tsc --noEmit` clean; full `scripts/run-tests.sh` GREEN
(8/8 chunks, 0 fail, 737 files, coverage audit PASS); the 5 PGLite files green
5×5 in one process at `--max-concurrency=5` (all boots forced to compete — a
harder stress than CI); integrations feature tests 23/23.

## 2026-06-21 — Integrations PR #13 fix-pass (Argus: 1 blocker + 2 important)

Addresses the Argus review of PR #13 (`feat-integrations-admin-ui-wave2-clean`).

**[BLOCKING] Session-hydration redirect bounced authenticated users to /login.**
`app/app/integrations.tsx`'s redirect effect fired whenever `user === null`
without guarding on the hydration state — so a direct load / refresh / deep-link
of `/integrations` bounced an already-signed-in user to `/login` while the token
was still being read from storage (`user` is transiently null during
`status === 'hydrating'`). FIX: extracted the decision into a pure, unit-tested
helper `shouldRedirectToLogin({status, user})` (`app/lib/auth-helpers.ts`) that
redirects ONLY on `status === 'ready' && user === null`, and routed BOTH
`integrations.tsx` and `settings.tsx` through it (DRY — settings already had the
correct guard inline). Tests: `app/__tests__/auth-helpers.test.ts` — hydrated+authed
user NOT redirected, mid-hydration user NOT redirected, resolved-unauthenticated
IS redirected.

**[IMPORTANT] Standalone API-key surface was gated on the Google-OAuth client.**
The `/api/cores/integrations` + `/api/cores/api-keys/*` routes AND the
`integrations_*` chat tools were mounted only inside the `input.cores.oauth !==
undefined` branch of `wire-cores-surfaces.ts`, so a Cores + bearer-auth
deployment with NO Google OAuth client 404'd on ALL standalone API-key
management (e.g. Tavily) — even though API keys never need Google OAuth. FIX:
extracted a dedicated **`gateway/http/cores-integrations-surface.ts`** owning
those routes, mounted under the AUTH gate (new `cores_integrations_surface`
composition slot, chained ahead of `/api/cores` in `compose.ts`), INDEPENDENT of
the OAuth-client gate. The OAuth token manager is now built under the auth gate
too (empty client creds when no Google client — `getStatus`/`disconnect` only
read/delete SecretsStore rows). `integrations_connect` on an OAuth slot returns a
clear `oauth_not_configured` error when no client is wired; API-key connect works
regardless. Tests: `cores-integrations-surface.test.ts` now constructs the
surface with NO Google client (empty creds) and proves list/set/delete all work.

**[IMPORTANT] OAuth-disconnect parity (chat ≠ UI).** The UI/HTTP disconnect
revoked tokens AND flagged every affected Core `install_failed_dependency_missing`;
the chat `integrations_disconnect` tool revoked tokens ONLY (its deps didn't even
carry `projectDb`), so after a chat disconnect `/api/cores` still reported the
Core `installed` with a silently-broken dependency. FIX: extracted a shared
**`disconnectOAuth({tokens, registry, projectDb, project_slug, label})`** brain in
`gateway/cores/integrations.ts` that BOTH the HTTP `handleDisconnect` and the chat
tool now call (mirrors how `runOAuthStart`/`startOAuth` unifies connect); threaded
`input.db` into `buildIntegrationsTools`. Tests: `integrations-tools.test.ts` —
chat disconnect flips the affected Core's `install_state` to
`install_failed_dependency_missing` (real DB mutation) + returns `affected_cores`.

**Verification:** `bunx tsc --noEmit` clean (root + `app/`); FULL
`scripts/run-tests.sh` GREEN — 731 files / 8 bounded-memory chunks, 0 failed,
coverage audit PASS. `composer.ts` untouched.

## 2026-06-21 — Integrations admin UI + agent-native parity (WAVE 2 Track A, gap-audit §(b) cat 9)

One surface that SHOWS everything a project has connected — per-Core Google
OAuth accounts (Calendar `google_calendar`, Email `gmail_compose`, Google
Workspace `google_workspace`) AND standalone API keys (Research Core's
`tavily`) — each with connect / disconnect / status, plus the SAME actions
available in chat. Named **Integrations** (NOT "Connections" — avoids collision
with the existing Connect collaboration feature). Scope: settings UI + chat
tools + reading/writing per-Core connection state. NO `composer.ts`, no new
global connection registry — the integration set is DERIVED from the bundled
Cores' own `manifest.secrets[]`, so per-Core ownership stays intact.

**The gap this closed.** Per-Core Google OAuth already had a full path
(`/api/cores/oauth/google/*` + `OAuthTokenManager` + the per-Core `[slug].tsx`
setup screen). What was missing: (1) there was NO surface at all to set/list/
clear standalone `byo_api_key` slots (Tavily etc. could only be set by hand in
the DB), (2) no unified view of everything connected, and (3) no agent-native
path — the agent couldn't connect/disconnect anything.

**NEW: `gateway/cores/integrations.ts`** — the shared brain behind BOTH the HTTP
surface and the chat tools (one code path, no drift):
- `buildIntegrationsStatus()` — unified status. OAuth status reads through the
  existing `OAuthTokenManager.getStatus()`; API-key `connected` is a presence
  check over the `byo_api_key` rows. NO plaintext ever leaves the function.
- `setApiKey()` / `deleteApiKey()` — store/rotate (via `SecretsStore.replaceAtomic`,
  so set-or-rotate is one transaction) and clear a key under the manifest-declared
  label, exactly where the owning Core reads it via its `SecretsAccessor`.
  Rejects labels no bundled Core declares + empty values.
- `collectOAuthSlots()` / `collectApiKeySlots()` — derive the slot set from the
  bundled registry's manifests.

**NEW: agent-native chat tools (`gateway/cores/integrations-tools.ts`).** Three
tools registered against the per-process `ToolRegistry` in
`wire-cores-surfaces.ts` (sharing the same `tokens` + `secretsStore` + registry
the HTTP surface holds):
- `integrations_list` — every OAuth account + API-key slot with status (no secrets).
- `integrations_connect` — OAuth label → runs the SAME in-process OAuth start
  the UI runs (`CoresOAuthSurface.startOAuth`, shared with `GET /start`) and
  hands back the PUBLIC Google `authorize_url` (`accounts.google.com/…`) the user
  opens — NOT a bearer-gated gateway `/start` link (which 401s in a browser —
  Codex round-1 P2); API-key label + `value` → stores the key.
- `integrations_disconnect` — OAuth → `tokens.disconnect()` (revoke + delete);
  API-key → clears the stored key.

**HTTP surface (folded into `cores-oauth-surface.ts`).** Three routes, bearer-gated:
- `GET    /api/cores/integrations`     → unified OAuth + API-key status
- `POST   /api/cores/api-keys/<label>` → set/rotate a key (body `{value}`)
- `DELETE /api/cores/api-keys/<label>` → clear a key

Folded into the existing OAuth surface (not a new mounted surface) because that
surface already receives the registry + `tokens` + `secretsStore` + `auth` +
`project_slug` — zero new composition wiring, no `compose.ts`/`composer.ts`
edits. The handler's owned-prefix check broadened from the single OAuth base to
also own `/api/cores/integrations` + `/api/cores/api-keys/*`. Unknown label →
400; empty/invalid value → 422.

**App.** `app/lib/cores-client.ts` gains `integrations()` / `setApiKey()` /
`deleteApiKey()`. New screen `app/app/integrations.tsx` (linked from Settings)
lists both sections with connect/disconnect/paste-key/clear. The list+status
logic is the pure, unit-tested `app/lib/integrations-view.ts`.

### Tests (all real, no mocked SQL — `installBundledCores` walks the repo so the
slots are the genuine manifest declarations)
- `gateway/cores/__tests__/integrations.test.ts` — slot derivation; status
  reflects a connected OAuth account + a stored key; `setApiKey` store→rotate
  keeps a single row; `deleteApiKey` clears + is idempotent; unknown/empty reject.
- `gateway/cores/__tests__/integrations-tools.test.ts` — the AGENT TOOL PATH
  mutates stored state: chat-connect of `tavily` writes the secret; chat-connect
  of an OAuth label returns the start URL; chat-disconnect deletes OAuth tokens
  and clears API keys; unknown-label + missing-value reject.
- `gateway/__tests__/cores-integrations-surface.test.ts` — `GET /integrations`
  lists both with correct status (and never leaks plaintext); `POST` then
  `DELETE /api-keys/tavily` mutates the store; unknown label 400; no bearer 401.
- `app/__tests__/integrations-view.test.ts` — view-model status/labels/counts.

## 2026-06-21 — Per-topic session isolation + per-project persona injection (WAVE 2 Track A, gap-audit P0-4 / §(b) cat 2)

**Problem.** The daily-driver gap audit flagged that Open collapses multi-project
chat into one shared agent identity: every Telegram/web topic spoke with the
same instance-wide persona. Two sub-problems, one VERIFIED, one new:

1. **Per-topic session isolation** — already *mostly* wired but never asserted at
   the key level. `build-live-agent-turn.ts` stamps
   `spec.metering_context.project_id = scope` (`'general'` or the project id) and
   `build-llm-call-substrate.ts` folds that into
   `ClaudeCodeSubstrateOptions.project_id`, which `poolKeyFor()` keys the
   module-level warm-REPL pool on `(substrate_instance_id, user_id, project_id,
   credential_identity)`. So distinct topics already resolve to distinct warm CC
   sessions — but the existing test only asserted `metering_context` was *set*,
   not that distinct **session keys** result. The audit's "ONE shared substrate"
   read of composer.ts:207 predates this keying (the `cc-agent-*` live substrate
   produces a *keyed pool*, not one session).

2. **Per-project persona** — the real gap. `projects.persona` (a free-form label
   like "Forge — pragmatic build agent", written by the settings drawer +
   onboarding) was NEVER read into a chat turn. `composeFirstTurnPrompt` only
   loaded the owner-wide `PersonaPromptLoader` (`<owner_home>/persona/*.md`).

**What shipped.**

- **`open/project-persona-resolver.ts` (NEW).** `buildProjectPersonaResolver(db)`
  → `(project_id) => string | null`, reading the canonical
  `projects.persona` column (`WHERE id = ? AND deleted_at IS NULL`). A closure
  over the live `ProjectDb` (re-run per cold turn, NOT a captured value), so a
  persona edited mid-session lands on the next cold topic. Best-effort: a
  transient SQLite error logs + returns null (degrade to owner-wide persona,
  never hard-fail — mirrors the persona-loader's rule).

- **`build-live-agent-turn.ts`.** New optional `projectPersonaResolver` on
  `BuildLiveAgentTurnInput`. `composeFirstTurnPrompt` now splices a
  `<project_persona>` fragment ABOVE the scope fragment for project topics, so
  the project topic's dedicated warm session adopts ITS persona on top of — not
  in place of — the owner-wide SOUL/USER `base_persona`. NEVER consulted for
  General (`turn.project_id === undefined`). A null/empty/throwing resolver
  degrades silently. First-turn-only (the warm REPL carries it forward); the
  degraded system-prompt-assembly fallback path also carries the fragment.

- **`open/composer.ts`.** Builds the resolver via `buildProjectPersonaResolver(db)`
  and threads it into the `liveAgentTurnFactory`. Surgical: one import + one
  call + one passthrough field. LLM-less boot is unaffected (the factory only
  exists when `liveAgentSubstrate !== null`).

**Why reuse, not rebuild.** Per the scope guard, the warm-session lifecycle
(spawn/warm/resume/respawn) and the keyed pool already exist in
`persistent-repl-substrate.ts`; the metering→`project_id`→`poolKeyFor` fold
already gives per-topic sessions. This change does NOT touch that machinery — it
adds the per-project persona seam and PROVES the isolation at the key level.

**Verify (REAL).**
- `gateway/realmode-composer/__tests__/build-live-agent-turn-session-isolation.test.ts`
  (NEW) — wires the REAL `buildLlmCallSubstrate` (production seam) under the
  live-agent runner with a capturing `substrateFactory`, dispatches General +
  two project topics, and asserts the computed `poolKeyFor` yields THREE
  DISTINCT keys (not one shared), a STABLE key across turns on the same topic,
  and that the single-topic path still replies. This is the "assert distinct
  session keys, not just that a session exists" the spec demands.
- `build-live-agent-turn.test.ts` (+6 tests) — project topic injects its persona
  into the first-turn prompt; General never consults the resolver; null/empty →
  no block; a throwing resolver degrades; two topics each get their OWN persona;
  persona is a first-turn-only splice.
- `open/__tests__/project-persona-resolver.test.ts` (NEW) — REAL migrated
  project.db: trimmed persona for a live project, null for unknown/NULL/empty,
  soft-deleted ignored, closed-db → null (never throws).
- `bunx tsc --noEmit` clean. Full `bun test` → 7684 pass / 90 skip / 0 fail.

## 2026-06-21 — PR #9 Argus round-2 fixes: working gated recovery command + honest false-negative + tty-binding coverage (ISSUES #318)

Argus round 2 (Codex/GPT-5 cross-model + Claude shell/test cross-check) cleared
the feature and CI-fix as GOOD but found **1 blocker + 2 minor**. All addressed.

**[BLOCKING] Gated-banner recovery command died (`install.sh`).** The gate
intentionally SKIPS installing the launchd/systemd unit, yet the no-token banner
told the user to run `neutron start` → `neutron-service.sh do_start` →
`launchctl kickstart/bootstrap $PLIST_PATH` (a unit never written) →
`die "could not start — is it installed?"`. So the primary recovery command
died on the exact no-token path this PR fixes; the FANCY banner offered no
fallback at all. Fix: both the FANCY (≈1139) and plain (≈1171) pending banners
now lead with **`neutron install`** — which writes the unit AND starts the
server (passing the app gate with the freshly-added token) — and explicitly
offer the foreground `cd <src> && bun run start` fallback if launchd is unhappy.

**[MINOR] False-negative gate messaging + ANSI-robust capture (`install.sh`).**
A `claude setup-token` run that authenticates claude to its *own* store but
prints no `sk-ant-oat…` token used to hard-stop with a "cancelled sign-in?"
message — implying the user failed to auth. Neutron reads the credential from
`.env` (`open/composer.ts resolveOpenLlmPool` keys on `CLAUDE_CODE_OAUTH_TOKEN`
/ `ANTHROPIC_API_KEY`, *not* claude's ambient store), so the gate is the right
call either way — but the message was wrong. The empty-capture branch now stays
gated and explains honestly: *no token was captured for Neutron to store; even
if claude is signed in, Neutron reads the token from `.env` — so add one of …*.
Separately, `run_setup_token_capture` now strips ANSI escape codes before the
token grep, so a token printed with color/formatting is still captured (a real
source of false-negatives).

**[MINOR] Real `claude setup-token <tty` binding now has coverage.** Every prior
test routed through the `NEUTRON_CLAUDE_SETUP_CMD` stub, never exercising the
production `</dev/tty` redirect the headline `curl | sh` flow depends on. Added a
`NEUTRON_CLAUDE_SETUP_TTY` seam that overrides only the device path (default
`/dev/tty`), plus a test that drives the *real* `claude setup-token <device`
branch with a fake `claude` echoing its bound stdin — proving the `<` binding
actually fed the device (a broken redirect would capture nothing).

Tests (`tests/integration/install-auth-gate.test.ts`, +4): a stateful fake
`launchctl` proves bare `neutron start` DIES pre-install while `neutron install`
writes the unit and leaves Neutron startable; the false-negative message is
honest yet still gated; the tty-binding captures the bound token; a banner-string
guard locks `neutron install` (no regression to bare `neutron start`).
Verification: `bunx tsc --noEmit` clean; full `bun test` suite GREEN
(7620 pass / 0 fail / 90 pre-existing skips, 724 files).

## 2026-06-21 — PR #9 CI fix-round: merge `origin/main` to clear flaky-segfault chunk crash (ISSUES #318)

PR #9 (the auth-gate change below) reported a RED `test` check while `main` was
green. Root cause was NOT the auth-gate logic: CI's bounded-memory partitioned
runner crashed **chunk#2** with a Bun 1.3.9 `panic(main thread): Segmentation
fault` during file *load* (on `connect/__tests__/*`, 0 tests run, a 100-file
coverage hole) — the known flaky #79. The dispatcher mis-read the log: every
"1 fail"/"2 fail" and the "FATAL, NOT a cooldown: no reportFailure" string it
grepped are **passing** test *names*, not failures.

Why it surfaced on #9 and not `main`: the branch was 2 commits behind
`origin/main`, which had concurrently advanced `gateway/realmode-composer/
build-landing-stack.ts` and `open/composer.ts` — the *same* files this PR
touches — and this PR's 2 new test files shifted the runner's chunk
composition, tripping the latent Bun segfault. Fix: merge `origin/main` into the
branch so the working tree matches CI's tested merge commit. Code auto-merged
cleanly (the auth-gate `chatAuthGate` wiring and main's proactive/reminders
additions are orthogonal); only this `AS-BUILT.md` conflicted (two newest-first
entries) and was resolved keeping both.

Verification: `bunx tsc --noEmit` clean; the FULL partitioned suite
(`scripts/run-tests.sh`, 724 files / 8 chunks) ran GREEN **twice** with full
coverage and no segfault; the re-triggered GitHub `test` check is now PASS.



Owner hit this on a fresh `curl …/install.sh | sh -s -- --yes`: the
non-interactive `--yes` install **SKIPPED** the Claude-auth step (printed a
"Claude not authenticated — run `claude setup-token`" warning) and then
**PROCEEDED to start the server and open the chat window** — which is unusable
with no `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`. Owner: *"it shouldnt just
proceed and open chat window. its unusable without claude."* Two-part fix:
make Claude auth a **gate, not a warning**.

**Part 1 — installer hard gate (`install.sh`).** Claude auth is now mandatory
before the app is usable.
- `_terminal_available()` (new) — true when *any* interactive terminal is
  reachable: stdin-tty **OR** `/dev/tty` openable behind a pipe. The headline
  install is `curl … | sh` where stdin is the PIPE, not a keyboard, yet the user
  is at a real terminal. `ensure_claude_auth` now runs the `claude setup-token`
  OAuth handoff whenever a terminal is reachable — **even under `--yes`** — by
  binding setup-token's stdin to `/dev/tty` (`run_setup_token_capture`). So the
  owner's `--yes` install now actually *runs* auth instead of skipping it.
- `apply_auth_gate()` (new) — when auth never completed (`CLAUDE_AUTH_PENDING=1`,
  i.e. truly no terminal / CI / cancelled sign-in), flips `APP_GATED_ON_AUTH=1`
  and forces `DO_START=0`/`DO_OPEN=0`. The service install, background start, and
  browser-open phases all skip; the run **hard-stops at a clear "authenticate
  first" banner** with the `claude setup-token` + `ANTHROPIC_API_KEY`
  instructions. It never lands in a started-app/open-chat state without a
  credential. Final banner reworked for the gated state (no more "Running —
  LLM-less" line; now "not started — authenticate Claude first").
- Test seams: `NEUTRON_ASSUME_NO_TTY=1` forces the no-terminal branch
  deterministically (independent of the test runner's `/dev/tty`); the existing
  `NEUTRON_INSTALL_PRINT_AUTH` seam now also prints
  `CLAUDE_AUTH_PENDING`/`APP_GATED_ON_AUTH`/`DO_START`/`DO_OPEN`.

**Part 2 — app-level auth gate, defense in depth (`landing/server.ts` +
`gateway/realmode-composer/build-landing-stack.ts` + `open/composer.ts`).** When
the Open server boots with no working substrate credential
(`resolveOpenLlmPool(env) === null`), `GET /chat` now renders a clear
**"Authenticate Claude to continue"** page (HTTP 503, `no-store`) **instead of**
the interactive chat shell that silently produces nothing.
- `LandingServerOptions.chatAuthGate?: { isUnauthenticated: () => boolean }`
  (new, optional) — evaluated **per request** so a restart-with-token clears the
  gate without rebuilding the server. `renderChatAuthGateHtml()` is a
  self-contained, CSP-safe page (one inline `<style>`, NO script, NO external
  asset) whose copy mirrors the installer's setup-token guidance.
- Threaded through `BuildLandingStackInput.chatAuthGate` (pass-through) and wired
  ONLY from the Open composer (`isUnauthenticated: () => resolveOpenLlmPool(env)
  === null`). **Managed leaves it unset** — its substrate is per-user Max OAuth /
  BYO key resolved elsewhere — so the gate is inert there and `GET /chat` serves
  the shell exactly as before. `composer.ts` edits kept minimal (one wired
  option); the gate logic lives in the render layer.

**Contract change (intentional, per owner).** A no-credential Open box used to
boot LLM-less and serve a static onboarding walk at `/chat`. The owner deemed
that "unusable without claude", so the page now gates regardless of session
(credential-, not session-, scoped). The onboarding *engine* mechanics are
unaffected (the `/ws/chat` layer still serves the static signup prompt + accepts
a turn) — the flow works the moment a credential is added. The two headline
`open-boot-shell` tests that asserted the old "serves chat.html LLM-less"
behavior were updated to assert the gate (kept LLM-less + fast; no real `claude`
spawn).

**Tests (real, RED→GREEN):**
- NEW `tests/integration/install-auth-gate.test.ts` (4) — shells out to the real
  `install.sh` via the auth seam: `--yes` + no token + no terminal HARD-STOPS
  (gated, `DO_START=0`/`DO_OPEN=0`, setup-token instructions printed); a present
  `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` is NOT gated; `--yes` with a
  reachable terminal RUNS auth, CAPTURES + persists the token to `.env`.
- NEW `landing/__tests__/chat-auth-gate.test.ts` (5) — `GET /chat` with no
  credential → 503 gate page (not the shell); credential present / gate unset →
  200 shell; per-request evaluation clears the gate on a flip; the gate page has
  no inline script / external asset.
- UPDATED `open/__tests__/open-boot-shell.test.ts` — the two GET-/chat tests now
  assert the gate; WS onboarding/resume mechanics retained.

Files: `install.sh`, `landing/server.ts`,
`gateway/realmode-composer/build-landing-stack.ts`, `open/composer.ts`,
`tests/integration/install-auth-gate.test.ts`,
`landing/__tests__/chat-auth-gate.test.ts`,
`open/__tests__/open-boot-shell.test.ts`.

## 2026-06-21 — External-tool floor: Google Workspace Core (Drive/Sheets/Docs) + Gmail send (gap-audit P0-6)

Closes the gap-audit external-tool floor (P0-6 / §(b) cat 9,
`~/repos/neutron-managed/docs/research/vajra-neutron-daily-driver-gap-audit-2026-06-20.md`):
Drive/Sheets/Docs were MISSING entirely, and the Email Core was draft-only
(no send). Both are daily Ryan workflows. Scope: `cores/` + the tool layer only
— no `composer.ts`, no admin UI.

**NEW: `@neutronai/google-workspace-core` (`cores/free/google-workspace/`, slug
`google_workspace_core`).** A Tier 1 free Core surfacing nine MCP tools across
three Google APIs, all capability-guarded + audit-logged:

- Drive v3 — `drive_list` / `drive_read` / `drive_upload`
- Sheets v4 — `sheets_read` / `sheets_append` / `sheets_update`
- Docs v1 — `docs_read` / `docs_create` / `docs_update`

Per-service `read:/write:google_workspace_core.{drive,sheets,docs}` capabilities.
ONE Google OAuth grant under the DISTINCT label `google_workspace`
(scopes: `drive` + `spreadsheets` + `documents`) — reuses the SAME per-Core OAuth
plumbing Calendar (`google_calendar`) + Email (`gmail_compose`) already depend on
(runtime composer drives the install-time prompt + resolves a live access token
via the per-Core SecretsAccessor through the shared `OAuthTokenManager`). NOT a
global token registry; the grant connects/disconnects independently. The Core
declares `required: true`, so under the Noop install prompter it lands in the
`manifest_invalid` install-failure bucket exactly like Calendar/Email until the
owner connects Google — surfaced in `/api/cores` as `install_state: failed`.

- `src/backend.ts` — a narrow `GoogleWorkspaceClient` interface with TWO
  implementations: `buildInMemoryGoogleWorkspaceClient()` (in-process store, backs
  the tools test) and `buildGoogleWorkspaceClient()` (hand-rolled `fetch`-based
  Drive/Sheets/Docs REST wrapper, no `googleapis` dep — accepts a lazy
  `accessToken()` accessor + a `fetchImpl` override). Drive read exports
  Google-native files to text (Docs→text/plain, Sheets→text/csv) and downloads
  others via `alt=media`; upload is multipart text. Sheets append/update use
  `valueInputOption=USER_ENTERED`. Docs read flattens the structured document to
  text; create = `documents.create` + a `batchUpdate` insertText; update inserts
  at an explicit index or appends at the resolved end index.
- `__tests__/backend.test.ts` asserts each production op against a mocked Google
  API (HTTP method/path/payload) + the in-memory adapter round-trips.
  `__tests__/tools.test.ts` exercises the capability-gated tool layer + audit
  rows. `__tests__/manifest.test.ts` pins the manifest contract.

**Email Core: Gmail SEND shipped (`email_send`).** HISTORY: send was originally
carved OUT of this Tier 1 Core (drafts-only, three intentional regression guards
asserting "no send tool / no `gmail.send` scope", reserved for a Tier 2 paid
Core). The gap-audit (P0) explicitly reversed that product decision — Gmail-send
is a daily-driver need — so this PR ships it here and FLIPS those guards.

- New `email_send` tool + `GmailClient.sendMessage(...)` on all three backends
  (two in-memory + the production Gmail REST client → `messages.send`). Sends a
  new message or a reply (In-Reply-To/References + `threadId` populated
  server-side). Header-injection is blocked at the shared `buildRawMessage` MIME
  layer (CR/LF/NUL rejected).
- Send gets its OWN capability `write:email_managed_core.send` (distinct from the
  drafts write capability) for clean audit attribution; the OAuth grant now adds
  `gmail.send` (FOUR scopes).
- The 4-point DRAFT rule (DRAFT + INBOX + IMPORTANT + UNREAD) is UNCHANGED. Send
  applies the same INBOX + IMPORTANT + UNREAD visibility labels to the sent thread
  via `threads.modify` (the DRAFT label is N/A for a sent message) so the
  conversation surfaces in the owner's inbox — the send-path counterpart to the
  draft rule. `DraftLabelingError` carries the sent message id for idempotent
  retry on a partial completion.
- KNOWN CAVEAT (Codex review P2): adding `gmail.send` to the existing
  `gmail_compose` grant means any user who connected Gmail BEFORE this change
  holds a stored token with only the old three scopes — `email_send` will 403
  until they disconnect/reconnect Gmail in the connectors UI (the
  `OAuthTokenManager` refreshes by label, not by re-comparing granted scopes).
  Accepted for this pre-release: the Cores OAuth surface is itself new (no
  established connected users to migrate) and reconnect is a one-click path;
  a scope-diff/forced-re-consent migration is deferred to the OAuth layer
  (out of this cores/tool-layer scope).

**Registration plumbing (the thing the prior attempt broke).** The earlier run
failed with `tool_registration_failed` for `calendar_core` + `email_managed_core`
and never opened a PR — a module-resolution break (`Cannot find module
'@neutronai/cores-runtime'`). Root cause avoided here by following the EXACT
existing pattern: new Core added to root `workspaces` + `gateway/package.json`
deps, `bun install` re-run so the `node_modules/@neutronai/*` symlinks
(cores-runtime/cores-sdk/runtime + the gateway→core link) are created identically
to Calendar/Email. New Core's backend factory wired in `gateway/boot-helpers.ts`
(dual-mode: Google REST client when the OAuth accessor is present, in-memory
fallback otherwise) + `google_workspace_core: 'client'` in
`install-bundled.ts:BACKEND_KEY_BY_SLUG`. Gateway inventory tests updated
(`cores-composition` + `cores-surface`: discovered set + the OAuth-gated failure
list, now Calendar + Email + Google Workspace).

**Verify.** `bunx tsc --noEmit` clean. Full `bun test`: 7624 pass / 90 skip /
0 fail across 722 files — INCLUDING every cores registration test
(`cores-composition`, `cores-surface`, `cores-oauth-surface`, install-lifecycle).


## 2026-06-20 — Mobile chat Phase 2: Telegram-grade RN chat over @neutron/chat-core (WAVE 2 Track B)

Builds on Phase 1 (#6 — server `seq`/resume/multi-device + the `@neutron/chat-core`
engine). Phase 2 gives the Expo/RN app durable local persistence, offline send,
gap-free reconnect, instant cold-open, foreground push catch-up, and a Telegram-grade
FlashList v2 UI — all by REUSING the existing chat-core engine, not re-implementing
sync. The surface lives under `app/`; the only chat-core change is the additive
`Store.getByMessageId` point lookup from the fix-round below (it bounds resume
replay) — sync/ordering/merge stay the engine's. See the "fix-round" subsection
at the end of this entry for the Argus-driven corrections.

**1. RN local store — op-sqlite behind the chat-core `Store` seam.**
- `app/lib/chat-core/sqlite-store.ts` — `SqliteChatStore implements Store` (the
  `@neutron/chat-core` interface). Driver-agnostic: it talks to a minimal async
  `SqliteExecutor`, not to op-sqlite directly, so the SAME class is verified on a
  REAL SQLite engine (`bun:sqlite`) in the unit suite and runs on op-sqlite on
  device. It is the op-sqlite analog of chat-core's OPFS web store.
- Contract parity can't drift: identity (`messageIdentity`), the optimistic↔echo
  merge (`mergeMessage`), and display ordering (`compareForDisplay`) are imported
  from chat-core, not re-derived. SQLite is pure storage; the semantics stay the
  engine's. Schema: one `chat_messages` table keyed on the message identity, with
  `(topic_id, seq)`, `(topic_id, client_msg_id)` + `(topic_id, message_id)` indexes
  (the last one backs `getByMessageId` — the bounded resume-replay lookup).
- `app/lib/chat-core/op-sqlite-store.ts` — the op-sqlite adapter + `createMobileStore()`
  factory. op-sqlite is dynamically imported and the factory falls back to chat-core's
  `InMemoryStore` when the native module is absent (RN-for-Web, Expo Go, the unit
  suite) — the surface NEVER fails to construct a Store (mirrors `createWebStore`).

**2. MobileChatSession — the RN composition over the chat-core engine.**
- `app/lib/chat-core/mobile-session.ts` — the RN analog of chat-core's
  `WebChatSession`: composes `ChatWsClient` + `SendQueue` + `SyncEngine` + `Store`.
  No sync logic re-implemented. Adds two mobile seams: an `onFrame` raw-frame tap
  (so the UI can render `agent_message_partial` streaming + typing, which chat-core
  doesn't persist) and `catchUp()` (foreground push / reconnect → `resume after_seq`).
  RN-free (no `react-native` import) so the send-queue + resume integration is
  unit-tested under bun with a fake socket.
- Local topic = `app:<user_id>` (matches the server's per-user topic; seq is per
  that topic). Project scoping is a render-time filter on `project_id`.

**3. Telegram-grade FlashList v2 UI.**
- `app/components/ChatSyncSurface.tsx` — message list on FlashList v2 (Shopify, MIT).
  v2 deprecated the buggy `inverted` prop (issue #1844); we keep data chronological
  and pin to the bottom with `maintainVisibleContentPosition.startRenderingFromBottom`,
  the v2 chat primitive. Optimistic offline-safe send, per-message delivery ladder
  (🕓 pending → ✓ sent → ✓✓ delivered), a live streaming/typing bubble, and a
  connection/offline-queue status strip.
- `app/lib/chat-core/use-mobile-chat.ts` — the React hook: builds the store + session
  per (user, project), re-reads the transcript on `onChange`, bridges RN `AppState`
  → `session.setActive` + `catchUp` (the §6 foreground reconnect — fills the gap
  after any backgrounded period), and bridges a notification that arrives WHILE
  FOREGROUNDED (`expo-notifications`) → `catchUp` (an immediate resume without
  waiting for an AppState change). Catch-up is FOREGROUND-ONLY:
  `addNotificationReceivedListener` runs JS only while foregrounded, so a push
  that lands in the background is not synced in the background — that gap is
  filled on the next foreground (see fix-round below).
- `app/lib/chat-core/chat-render-model.ts` — pure (no-React) render helpers:
  the streaming-fold state machine, the durable↔streaming merge, the delivery ladder.
- `app/app/projects/[id]/chat-sync.tsx` — a new route hosting the surface, landed
  ALONGSIDE the legacy `chat.tsx` tab (not wired into the locked 5-tab bar) so it
  can be exercised before the cutover. Not a tab swap.

**4. Build plumbing.**
- `app/metro.config.js` — monorepo Metro config (watch the repo root + resolve from
  both node_modules) so the app bundles the workspace `@neutron/chat-core` source.
- `app/package.json` — adds `@neutron/chat-core` (workspace), `@op-engineering/op-sqlite@17.0.0`,
  `@shopify/flash-list@2.3.2`. `app/tsconfig.json` — `allowImportingTsExtensions`
  (chat-core is consumed as raw TS with `.ts` import specifiers; noEmit already set).
- op-sqlite + FlashList v2 both require the New Architecture, already on
  (`newArchEnabled: true`). EAS / `expo prebuild` (op-sqlite native link) is the
  operator step, as planned in the research doc.

### Tests (REAL — bun:sqlite + fake socket, no mocked SQL/sync)
- `app/__tests__/chat-core-sqlite-store.test.ts` (7) — the full `Store` contract on
  real SQLite: seq ordering, idempotent dedup, optimistic↔echo reconcile, pending-
  queue isolation, resume cursor, attachment round-trip, cold-open hydration over a
  reopened DB, topic isolation.
- `app/__tests__/chat-core-mobile-session.test.ts` (7) — offline optimistic send,
  flush-on-connect + echo→acked reconcile, gap-free reconnect resuming from the LOCAL
  seq cursor (+ dedup of a re-delivered seq), cold-open + re-drive of a stranded send
  across a simulated restart, `catchUp()` gap-fill, `catchUp()` no-op-when-not-open
  (deferred resume rides next session_ready), and the `onFrame` streaming seam.
- `app/__tests__/chat-core-render-model.test.ts` (13) — streaming fold state machine,
  durable↔streaming merge + stable keys, delivery ladder, and the fix-round
  `frameMatchesProject` filter (own/sibling/untagged streams per view).
- `app/__tests__/active-tab.test.ts` (5, fix-round) — `activeTabFromSegments` mapping:
  legal tab leaves, bare-route default, and the chat-sync/notes/cores/backups → null
  (no Chat-tab shadow/lock) regression.
- Verify: `bunx tsc --noEmit` clean (app + root gate + chat-core); FULL `bun test`
  green; `eslint` clean on new files.

### Fix-round (Argus REQUEST CHANGES — PR #11: 1 blocker + 2 important)

Argus (cross-model with Codex/GPT-5) requested changes on three points; all
resolved here. Core was rated EXCELLENT — these are targeted fixes.

- **[BLOCKING → resolved by honest downgrade] push catch-up is FOREGROUND-only,
  not background gap-fill.** The hook wired catch-up via
  `Notifications.addNotificationReceivedListener`, which runs JS only while the
  app is foregrounded — so a backgrounded data-push never ran `catchUp()`, yet
  this entry + the PR body claimed "background gap-fill". A real background-wake
  needs a headless `expo-task-manager` task that reconstructs the session
  OUTSIDE React (no live `MobileChatSession` exists in a headless context) and
  depends on native push/background-mode config that cannot be verified in this
  Expo setup — shipping a no-op background task would itself be a false claim.
  Decision (the brief's authorized fallback): downgrade the claim to the honest,
  verified behavior. The foreground listener stays (it gives an immediate resume
  when a push lands mid-session, where no AppState 'active' transition fires);
  the post-background gap is filled by the existing AppState→active `catchUp` on
  next foreground. Comments in `use-mobile-chat.ts` + `mobile-session.ts`, this
  AS-BUILT, and the PR body are corrected to "foreground catch-up". Test:
  `catchUp()`-not-open no-op + deferred-resume-on-session_ready
  (`chat-core-mobile-session.test.ts`).
- **[IMPORTANT → fixed] chat-sync route shadowed + locked the Chat tab.**
  `activeTabFromSegments` returned the `'chat'` fallback for the unknown
  `chat-sync` leaf, so the route highlighted Chat AND — because the tab bar
  treats `key === activeTab` as a no-op — made tapping Chat dead, stranding the
  user. The mapping moved to a pure, RN-free `app/lib/active-tab.ts` that returns
  `null` for the known non-tab sub-routes (`chat-sync`/`notes`/`cores`/`backups`)
  so no tab is highlighted and every tab tap navigates; only the bare project
  route defaults to `chat`. `_layout.tsx` consumes it (nullable `activeTab`, with
  the slot-fade now keyed off the real route leaf and the last-tab write skipped
  on a null tab); `ProjectTabBar.active` widened to `ProjectTabKey | null`. Test:
  `app/__tests__/active-tab.test.ts`.
- **[IMPORTANT → fixed, incl. chat-core root cause] O(N²) resume replay.**
  `SyncEngine.findExisting` fell back to `store.list(topic_id)` (a full read +
  sort) for every agent message with no `client_msg_id`, so replaying N messages
  on resume was O(N²) — a real cliff at thousands. Added an additive
  `Store.getByMessageId(topic_id, message_id)` point lookup
  (`chat-core/store.ts` interface + `InMemoryStore`; delegated by `OpfsChatStore`;
  served from a new `(topic_id, message_id)` SQLite index in `SqliteChatStore`)
  and pointed `findExisting` at it. Replay is now linear. This is the small, safe
  chat-core root-cause fix the brief authorized; the engine's sync/ordering/merge
  semantics are unchanged. Tests: `getByMessageId` in both Store contracts +
  a `SyncEngine` bounded-replay test asserting the apply path hits the index and
  never `list()` (`chat-core/__tests__/{store,sync-engine}.test.ts`,
  `app/__tests__/chat-core-sqlite-store.test.ts`).
- **[MINOR] redundant empty-string guard** removed from
  `SqliteChatStore.getByClientMsgId` (the private `rowByClientMsgId` already
  guards identically).
- **[Codex P2 — fixed] streaming partials weren't project-filtered.** The app
  WS topic is per-user, so `agent_message_partial` streams for OTHER projects
  arrive on the same socket; `useMobileChat`'s `onFrame` folded them
  unconditionally, so a sibling project's stream could render in the current
  project's chat until its final message landed and was filtered out. The
  partial envelope carries an optional `project_id` (P5.2 parity), so a new pure
  `frameMatchesProject(frame, projectId)` helper in `chat-render-model.ts`
  applies the SAME filter as the durable `matchesProject` before folding;
  `onFrame` drops a non-matching frame. (Server-side partials aren't emitted yet
  — P5.1 ships the client primitive only — so this is forward-correct with zero
  current-behavior regression.) Tests: 3 in `chat-core-render-model.test.ts`.

## 2026-06-20 — Proactive messaging: real morning brief + idle-topic nudge sweep (gap-audit P0-5)

Closes gap-audit P0-5 (WAVE 2 Track A) — "Neutron only speaks when spoken to."
Two proactive paths now POST to chat, both reusing the existing cron registry +
the P6 nudge ranker, both posting through the channel-agnostic `OutboundSink`
(the production `ChannelRouter`, exactly like trident async-delivery P0-1).

**1. Real morning brief** (`gateway/proactive/morning-brief.ts`). The prior
"morning brief" (`onboarding/overnight/morning-brief.ts`) reports ONLY overnight
Trident completions and ONLY fires if something ran overnight. The new brief
composes a real daily brief from whatever live context is available — today's
calendar, the focus/task queue, recent entity/memory deltas, project STATUS —
and posts it EVERY owner-local day regardless of overnight activity.
- Context sources are INDEPENDENT, OPTIONAL async providers
  (`ProactiveContextSources`), each gathered behind its own try/catch
  (`gatherBriefContext`): a missing/throwing source degrades to "section
  omitted", never a failed brief. The focus-queue source defaults to the
  canonical `TaskStore` (top open tasks by focus score) so the brief is useful
  out of the box; calendar/entities/STATUS layer in when the host supplies them.
- `composeMorningBrief` is PURE (sections → body); an empty section is dropped
  and a fully-quiet day yields an honest "clear day" line — never a fabricated
  section.
- Same-day idempotency lives in the new `proactive_brief_log` table (migration
  0080): the handler ticks every 30 min but posts at most one brief per
  owner-local day, at/after a configurable local hour (default 07:00), so a
  gateway restart mid-morning cannot double-post. A deliver failure does NOT
  record the day, so the next tick retries.

**2. Idle-topic nudge sweep** (`gateway/proactive/idle-nudge-sweep.ts`). The P6
ranker already picks the single highest-leverage open task per project per day
and persists it to `current_focus_pick` — but never posted it. This sweep adds
the post path behind a strict quality gate. Per hourly tick, for each active
project-bound topic it:
- SKIPS active topics (activity inside the 4h idle threshold — a live
  conversation needs no nudge);
- SKIPS empty topics (no `current_focus_pick` for today, or the picked task is
  no longer open — `readTodayPick` joins the pick to its task and returns null
  unless the task is still `open`);
- DEDUPES via the new `proactive_topic_state` ledger — never re-nudges the same
  idle topic about the same task until the user has returned (activity advanced
  past the watermark stored at the last nudge).
The gate (`evaluateNudgeGate`) is PURE so all branches are unit-tested without a
DB or sink. The ranker stays the single source of "what to do next"; this module
is purely the gate + the post path.

**Wiring.** Both register on the shared cron registries via
`gateway/proactive/cron.ts` (`registerMorningBriefCron` /
`registerIdleNudgeSweepCron`, mirroring the nudge engine's register shape — no
new scheduler). The composition layer wires them in `tasksModule`
(`build-core-modules.ts`, now `deps: ['cron','reminders','channels']`) gated on a
new optional `tasks.proactive` config block (`tasks-input.ts`): the morning brief
registers only when `resolveGeneralTopic` returns a topic; the sweep registers
only when `listIdleTopics` is supplied (Neutron has no generic last-activity
index yet, so the host enumerates idle topics). Absent → neither cron registers
(unchanged Open default).

**Tests (REAL, per CLAUDE.md).** `gateway/proactive/__tests__/` (28 tests):
- `morning-brief.test.ts` — pure composer (sections / drop-empty / quiet-day);
  graceful degradation (a throwing source is omitted, the brief still composes);
  `runMorningBrief` against a REAL in-memory DB + recording sink asserts the
  outbound post carries the composed brief body, the once-per-local-day guard
  (no second post), the too-early gate, and the deliver-failure retry path.
- `idle-nudge-sweep.test.ts` — real `current_focus_pick ⋈ tasks` read; pure
  gate (active / no_pick / dedupe / re-nudge-after-return / null-activity);
  `runIdleNudgeSweep` posts a nudge for an idle topic, SKIPS an active topic +
  an empty topic in one sweep, dedupes across sweeps, and survives a per-topic
  deliver failure without writing the ledger.
- `cron.test.ts` — registration on the shared registries (job names, interval
  schedules, idempotent handler registration) + the wrapped handlers run and
  report structured status.

Files: `migrations/0080_proactive_messaging.sql` (+ regenerated
`expected-schema.txt`), `gateway/proactive/{sink,state-store,morning-brief,idle-nudge-sweep,cron,index}.ts`,
`gateway/proactive/__tests__/*`, `gateway/composition/input/tasks-input.ts`,
`gateway/composition/build-core-modules.ts`.

## 2026-06-21 — Chat-sync foundation fix-round (Argus REQUEST CHANGES): double-dispatch guard + wiring split

Argus (cross-model with Codex/GPT-5) requested changes on PR #6 with two
BLOCKING findings. This round resolves both.

**BLOCKING #1 — double-dispatch (the headline).** `AppWsAdapter.ingestUserMessage`
de-duped the persisted row on `client_msg_id` (the `AppChatStore.append`
idempotency: a re-sent id returns the existing row with `was_new:false`), but it
**discarded `was_new`** and returned only `{ message_id, seq }`. The app-ws
surface therefore had no idea a send was a duplicate and *unconditionally* ran
the **side-effecting** chat-command filter (`chat_command_filter.match`, which
executes the command, e.g. captures a note) **and** `dispatchInbound` (the agent
loop). So a re-sent `client_msg_id` — an offline-queue flush retry, a double-tap,
or the HTTP fallback racing the WS echo of the same send — fired the agent / a
command **twice**. Storage was idempotent; *behaviour* wasn't, defeating the
spec's idempotency guarantee. Confirmed at `app-ws-surface.ts:322-355` (Codex P1
independently).

*Fix:* `ingestUserMessage` now returns `was_new` (true when no durable log is
wired — legacy mode never de-dupes, so every send dispatches, unchanged; true on
a persist failure — we couldn't prove it a duplicate, so dispatch rather than
silently drop). Both surface paths (WS `message` handler + HTTP `handleSend`)
**gate the chat-command filter + `dispatchInbound` on `was_new`**. The echo is
still re-emitted on a duplicate (the client de-dupes it on `client_msg_id`, so a
reconnecting device still reconciles its bubble) — only the side-effecting
agent/command work is now exactly-once. Files: `channels/adapters/app-ws/adapter.ts`,
`gateway/http/app-ws-surface.ts`.

*Test (real, RED→GREEN):* NEW `gateway/__tests__/app-ws-no-double-dispatch.test.ts`
(4 tests) stands up the REAL surface over `Bun.serve` against a REAL `AppChatStore`
(SQLite temp file) with a counting receiver + counting command filter, and asserts
that re-sending the same `client_msg_id` over WS — and over HTTP, and HTTP-racing-
WS — dispatches the agent + command **exactly once** while re-emitting the echo
both times with the same canonical `seq`/`message_id`. A fourth test wires the
real server append/replay into the real client `SyncEngine` and asserts a single
message yields **exactly one row per device** even with optimistic-insert +
server-echo + a duplicate ingest + a reconnect replay overlapping (the spec's
exactly-once-per-device convergence). Verified RED on the pre-fix tree (3/4 fail
without the gate).

**BLOCKING #2 — "feature inert" (wiring) — cross-repo, clarified.** Argus noted
every `new AppWsAdapter`/`new AppChatStore` lives in `__tests__` and no
production boot in this PUBLIC repo wires `chat_log`. On investigation (Argus
agreed in its own notes) the production boot that constructs the adapter/registry
and calls `createAppWsSurface` lives in the **private `neutron-managed` repo**
(the managed/private split) — it opts into the durable log by passing `chat_log`,
exactly as documented in §2 of the entry below. That boot is **out of scope for
this public PR** (brief: OPEN-repo only, never touch managed). The open-repo half
of the wiring — the adapter's optional `chat_log` seam, graceful degrade when
absent, and the `createWebStore()` OPFS-or-in-memory web store — is complete and
tested here. The one open-repo loose end (a speculative unused `@neutron/chat-core`
dep on `landing/package.json`) is removed (see the web-wiring note below).

**Cross-model review (Codex/GPT-5) — one fix taken, three follow-ups logged.**
The fix-round Codex pass surfaced four correctness gaps in the *original*
Phase-1 design (none in the double-dispatch fix itself; all pre-existing, not in
Argus's blocking set). Triaged:

- **TAKEN — sent-but-unacked sends are now retried on reconnect (Codex P1).**
  `SendQueue` marked a row `sent` the instant `WebSocket.send()` accepted the
  frame; if the socket dropped before the server persisted + echoed it, the row
  was stranded `sent` and a plain `flush` (which only drains `queued`) never
  retried it — a silently lost send. NEW `SendQueue.flushUnacked` re-drives every
  not-`acked` row (queued + sent) oldest-first; `WebChatSession.resumeAndFlush`
  now calls it on every (re)connect. This is SAFE precisely because of this PR's
  guarantees: every send carries a `client_msg_id`, so the server de-dupes the
  retry, and the new `was_new` guard means the re-delivery never re-fires the
  agent. `acked` rows are never re-sent. Tests: 3 in `send-queue.test.ts` +
  1 reconnect-retry in `web-session.test.ts` (RED→GREEN).
- **FOLLOW-UP (Codex P1) — rich agent envelopes are flattened on replay.**
  `AppChatStore.append` persists only `body/project/created_at`, so
  `replayAfter` reconstructs a bare `agent_message` — a device that reconnects
  loses `options`/`image_urls`/`citations`/`doc_refs`/`deep_link`/
  `upload_affordance` that live devices saw. Proper fix needs a schema change
  (store the full envelope JSON) + a migration; deferred to a dedicated PR rather
  than widen this fix-round into the persistence schema.
- **FOLLOW-UP (Codex P1) — resume does not page past the first 500 rows.**
  The server caps each replay at `DEFAULT_REPLAY_LIMIT` (500); a cold/long-
  offline client sends one `resume` and stops, so topics with >500 persisted
  messages never pull the tail. Robust paging needs a server "resume
  complete / has-more" marker (a protocol addition) so the client knows to
  re-resume from the new high-water mark; deferred.
- **FOLLOW-UP (Codex P2) — mixed web+native fan-out uses one platform.**
  `getPlatform` returns only the most-recently-registered platform, used to pick
  the doc-link scheme for the whole fan-out, so a simultaneously-connected
  web+native account gets one device's links in the wrong scheme. Needs
  per-device envelope encoding in the registry fan-out; deferred (P2).

## 2026-06-21 — Chat-sync foundation (Phase 1): server `seq`/`resume`/multi-device + `@neutron/chat-core`

The first phase of web↔mobile Telegram-parity (research:
`web-chat-telegram-parity-architecture-2026-06-20`). Delivers the defining
"Telegram feel" — offline send, gap-free reconnect, instant cold-open,
multi-device consistency — with **zero UI-framework change**. Append-only
chat → a hand-rolled sync engine (server monotonic `seq` + per-client cursor +
idempotent send-queue), not a CRDT/RxDB.

**1. Durable per-topic message log + monotonic `seq` (server).** Until now the
app-ws surface (`/ws/app/chat`) emitted user/agent messages in-memory only —
nothing persisted, so a message sent while a socket was down was lost and there
was no ordering key for multi-device. New migration `0079_app_chat_messages.sql`
+ `persistence/app-chat-store.ts` (`AppChatStore`) append every message with a
monotonic, per-topic `seq` (`PRIMARY KEY (topic_id, seq)`), de-duplicated on
`(topic_id, client_msg_id)`. `replayAfter(topic, after_seq)` is the resume
query (`WHERE seq > ? ORDER BY seq`). The store is wired through an
`AppChatMessageLog` interface so the adapter stays DB-agnostic + unit-testable.

**2. `resume` replay + `seq` on the wire (app-ws).** New inbound control frame
`{ v:1, type:'resume', after_seq:N }` (decoded by the new `decodeAppWsResume`,
kept separate from the message decoder so the `user_message` path keeps its
narrow type). The surface replays the gap to the *requesting* socket only.
`seq` now rides on every outbound `user_message`/`agent_message`; `session_ready`
carries `last_seen_seq` so a client can skip an unneeded resume. The
`AppWsAdapter` gained an optional `chat_log` — when wired it persists +
stamps `seq` (back-compat: absent → legacy in-memory behaviour, all existing
tests unchanged). Production boot (managed) opts in by passing `chat_log`.

**3. Multi-device session registry.** `InMemoryAppWsSessionRegistry` changed
from `Map<topic, sender>` (last-wins, silently dropped a second device) to
`Map<topic, Set<sender>>` with fan-out to every live device on the account,
identity-aware per-device unregister, and a dead-socket sweep that never aborts
the fan-out. Combined with per-client `seq` cursors, web + phone converge on
one transcript.

**4. `@neutron/chat-core` — transport-agnostic client lib (new workspace).**
The shared logic the web (and, Phase 2, mobile) clients consume:
- `Store` interface + `InMemoryStore` (ordering: by `seq`, never clock;
  optimistic tail last) and an OPFS-backed `OpfsChatStore` with
  `createWebStore()` that **degrades gracefully** to in-memory when OPFS /
  `createWritable` is unavailable (scope-guard requirement);
- `SendQueue` — idempotent on `client_msg_id`, offline-buffering, flush-on-
  reconnect, never double-sends;
- `SyncEngine` — append-only apply (UPSERT dedup + optimistic reconcile),
  `last_seen_seq` cursor, `resume` request builder;
- `ChatWsClient` — reconnect with exponential backoff + jitter, AppState-aware
  (pause/resume), injectable socket + timers;
- `WebChatSession` — the high-level composition a web client instantiates to
  get optimistic send + offline queue + gap-free reconnect + instant cold-open
  against the seq-aware app-ws protocol.

**Web wiring decision (noted per autonomy mandate):** the only existing
vanilla-TS web client, `landing/chat.ts`, talks to the *onboarding* `/ws/chat`
bridge (a different protocol with no `seq`), not `/ws/app/chat`. Rather than
risk destabilising that 4,476-line client by retrofitting it onto a different
surface, the chat-core integration is delivered as the fully-tested
`WebChatSession` composition (consumed by the seq-aware app web client).
Repointing `landing/chat.ts` itself — and adopting `createWebStore()` there — is
deferred to the Phase-3 web UI uplift, where the client is migrated anyway.
(Fix-round: the speculative `@neutron/chat-core` dep that had been added to
`landing/package.json` was removed — `landing/` imports nothing from chat-core,
so the declaration was a decoupled artifact that bundled nothing; it'll be added
back when the client is actually migrated. Argus BLOCKING #2.)

**Out of scope (later phases):** React/assistant-ui migration (P3), mobile
op-sqlite wiring (P2), FTS5 search / read receipts (P4). The `Store` interface
is the seam a Phase-2 wasm-SQLite engine drops into.

**Tests:** 73 new tests — chat-core (`sync-engine`, `send-queue`, `ws-client`,
`store`, `web-session`), `AppChatStore` seq/idempotency/resume, multi-device
registry, adapter seq/resume end-to-end, `resume` decode. `bunx tsc --noEmit`
clean; schema snapshot + migration-list regenerated.

## 2026-06-20 — CI green on the public runner: grep falls back to POSIX grep + least-privilege workflow token

Post-public-flip hardening on rjunee/neutron. Two CI/security fixes; PR-A.

**1. `grepScoped` CI failure — ripgrep is not on the GitHub runner.** The
`grep` codegen tool (`cores/free/code-gen/src/tool-handlers.ts:grepScoped`)
shelled out unconditionally to `rg` (ripgrep). It passes locally (rg installed)
but the stock `ubuntu-latest` runner has no ripgrep, so `Bun.spawn(['rg', …])`
fails and the two `grepScoped` tests error in CI. Fix (the more robust option in
the brief): the tool now prefers ripgrep but **falls back to POSIX `grep`** when
`Bun.which('rg')` returns null — robust for any self-hoster's CI too, not just
GitHub's. Both binaries emit `path:line:text` with `-n` and exit 1 on no-match,
so the caller sees an identical shape either way; the fallback adds `-r` plus
`--exclude-dir=.git --exclude-dir=node_modules` (the ignores rg applies
implicitly) and maps `--glob` → `--include=`. Tool description + the stale
"using ripgrep" wording updated to match.

**2. `actions/missing-workflow-permissions` (1 CodeQL alert).** Added an
explicit least-privilege top-level `permissions: { contents: read }` block to
`.github/workflows/ci.yml` (the only workflow; CodeQL runs via GitHub default
setup, no committed codeql.yml). CI only reads the checkout + runs
typecheck/tests, so no write scopes are granted.

**3. Midnight-boundary flake in `restore-ui.test.ts` (the actual red on the
first CI run).** With the ripgrep cause fixed, CI still failed on a SEPARATE,
date-dependent test: `groupSnapshotsByDay > labels today / yesterday correctly`.
The run executed at `00:00:30 UTC` (the runner's tz is UTC), and the test built
a "today" snapshot at a fixed `60_000 ms` ago — which at 30 s past local midnight
lands at `23:59:30` YESTERDAY, so "Today" had 1 snapshot instead of 2. The
`groupSnapshotsByDay` implementation is correct; the test was fragile. Fixed by
anchoring the today snapshots to instants guaranteed within the local calendar
day (`[startOfToday, now]`: midnight-today + the midpoint to now), mirroring the
existing noon-yesterday anchor. Hardened the sibling "preserves order within a
day" test the same way (it had the same latent ~3 s post-midnight flake). Proven
against the exact failure instant (`now = 2026-06-21T00:00:30Z`, tz UTC):
Today=2 / Yesterday=1.

**Verify.** `bun test cores/free/code-gen/__tests__/tool-handlers.test.ts` →
16/16 pass with ripgrep present AND with `rg` removed from PATH (grep-fallback
path exercised on BSD grep; GNU grep on the Linux runner supports the same
flags). `bun test app/__tests__/restore-ui.test.ts` → 19/19. `bunx tsc --noEmit`
clean. First CI run confirmed both `grepScoped` tests PASS on the stock runner
(grep fallback works) — only the unrelated date flake was red, now fixed.

## 2026-06-20 — chat client: scheme/host allow-list on navigation + image sinks (CodeQL js/xss + open-redirect)

Post-public-flip security hardening on rjunee/neutron; PR-B. CodeQL flagged 8
alerts in `landing/chat.ts` (3 js/xss + 5 js/client-side-unvalidated-url-
redirection), all on three DOM sinks that consume values arriving over the
gateway WebSocket. VERIFIED each, then fixed at the sink.

**The three sinks.**
- `handleRedirect` (redirect envelope) → `window.location.replace/href = target`
  built from `msg.new_url` + `msg.new_start_token`.
- `handleSlugRenamed` (slug-rename CTA click) → `window.location.assign/href =
  target` built from `buildSlugRenamedTarget(msg.new_host, …)`.
- image-gallery option render → `img.src = opt.image_url`.

**Why it's a real sink class.** Even though these envelopes come from the
authenticated gateway, a value that flows into `window.location` is an
execution sink: a `javascript:` (or `data:`/`vbscript:`) URL there is DOM-XSS,
and an unconstrained host is an open redirect. The chat agent/LLM can influence
some of these fields, so they are treated as untrusted at the boundary.

**The fix — allow-list at the sink (escape-the-scheme, validate-the-target).**
Two exported, unit-tested helpers in `landing/chat.ts`:
- `safeNavUrl(raw)`: parses the target (relative resolves against the current
  document), returns it only when it normalizes to an `http:`/`https:` URL with
  a non-empty host, else null. Both location handlers now navigate to the
  RETURNED value (so the check is on the exact string that reaches the sink) and
  refuse to navigate (status "redirect/open blocked: unsafe target") when null.
- `safeImageSrc(raw)`: accepts only `http`/`https` (incl. relative paths that
  resolve to the app origin) and inline `data:image/*`; any other scheme →
  null, and the gallery option falls back to its plain-text label.

**Tests.** NEW `landing/__tests__/chat-url-sanitizers.test.ts` (12) pins
http(s) pass-through + rejection of `javascript:`/`data:`/`vbscript:`/`file:`/
empty/garbage for `safeNavUrl`, and http(s)/`data:image` accept + `javascript:`/
non-image-`data:` reject for `safeImageSrc`. Existing
`chat-slug-renamed-target.test.ts` (13), `chat-slug-renamed-cta.test.ts`,
`option-grid-layout.test.ts`, `chat-rendering.test.ts` (39 combined) stay green
— behaviour for legitimate http(s) targets is unchanged. `bunx tsc --noEmit`
clean.
## 2026-06-20 — onboarding: prompt body↔options desync + double name-ask (first-run showstopper)

Owner-confirmed P0 launch defect on a fresh public install. First-run onboarding
asked the name TWICE and emitted a prompt whose BODY was the "what's your first
name?" question but whose BUTTONS were the import offer (Yes ChatGPT / Yes Claude
/ Neither) — body and options came from DIFFERENT phases. Server-log proof
(`~/neutron/data/logs/server.log`): after the required-fields audit confirmed the
name was collected and the engine had advanced to `ai_substrate_offered`, the
emitted prompt `5dcdf824` had `body_len=40` (a name re-ask) with `options=3`
(the import buttons).

**Why the prior #308/#310 fixes didn't close it.** They were verified against
mocked phase-spec resolvers that returned clean per-phase specs, so they never
exercised the REAL resolver's parse → materialize → engine-emit seam where the
defect actually lives. The bug only reproduces on the production LLM path.

**Root cause (two interacting parts).**
1. *Lagged body.* On Open, the phase-spec LLM ("rephrase this phase's prompt")
   runs on ONE warm, ACCUMULATING `cc-llm` REPL session (`open/composer.ts` —
   intentionally not `ephemeral`, no `/clear`). On a cold-start / accumulated-
   context turn the model can return the PREVIOUS phase's body — a name re-ask
   emitted while the engine has already advanced to the import offer. The
   resolver's `withTimeout` also deliberately does not cancel a slow turn, so the
   warm session keeps drifting. (`onboarding/interview/phase-spec-resolver.ts`,
   `runtime/.../persistent-repl-substrate.ts`, `open/composer.ts:185`.)
2. *The graft that made it user-visible.* The #7264779 "BUG-2" hardening in
   `materializeSpec` grafted the CURRENT phase's static options onto an LLM spec
   whenever the LLM returned an empty options array. So a lagged NAME body (which
   the model emits option-less, thinking it's the free-text signup step) got the
   `ai_substrate_offered` import buttons stapled on — manufacturing the exact
   "name body + import buttons" desync and the phantom second name-ask.

**The fix — body and options must always come from the SAME phase.**
`onboarding/interview/phase-spec-resolver.ts`:
- `resolve()` now discards the whole LLM spec when an *option-bearing* phase
  (`intent.allowed_option_values.length > 0`) comes back *option-less*. The engine
  then falls back to the FULL static spec for that phase (body AND options both
  in-phase). This subsumes the BUG-2 phantom-buttons fix more robustly: an
  option-bearing phase can no longer emit a body without its buttons. A NON-empty
  option *subset* from the LLM is still a legitimate narrowing and is preserved.
- `materializeSpec` no longer grafts static options onto an LLM body — body and
  options are used exactly as the LLM produced them on that one in-phase call.
- The resolver system prompt now instructs the warm accumulating model that each
  call is a STANDALONE rephrase of the CURRENT phase — ignore prior turns'
  questions — reducing cross-phase body drift on free-text phases too.

Net effect: the name is asked exactly once, and every prompt's body matches its
buttons. With the lagged name-body discarded, the import step renders the proper
static import prompt instead of a second name-ask.

**Tests (RED→GREEN on the REAL path).**
- `onboarding/interview/__tests__/engine-llm-resolver.test.ts` — NEW block drives
  the PRODUCTION `buildLlmPhaseSpecResolver` (real `parseLlmSpec` +
  `materializeSpec`) through a real `InterviewEngine.emitPhasePrompt`, feeding the
  `LlmCallFn` the exact lagged JSON the warm session produced live (name body,
  empty options) and asserting the emitted prompt's body↔options are in-phase.
- `onboarding/interview/__tests__/phase-spec-resolver.test.ts` — NEW block locks
  the invariant at the resolver + materializer (no graft; option-less option-
  bearing phase → static fallback; subset preserved; free-text unaffected).
- Both fail on the pre-fix tree and pass after. `bunx tsc --noEmit` clean;
  `bun test` 7438 pass / 0 fail; leak-gate silent.

## 2026-06-20 — #314: deterministic port bind on restart (no silent random-port fallback)

Owner-confirmed P1 self-host defect (#314), fixed on
`fix-deterministic-port-bind-314-20260620` and merged into `open-converge`. Hit
live twice on the owner's instance: after a restart (crash, reboot, `neutron
restart`), when the configured port (default 7800 via `NEUTRON_PORT`) was not
instantly free, the new server did not end up on its configured port — so the
owner's bookmarked `http://127.0.0.1:7800` broke, and one episode left two
servers running (old squatting 7800, new elsewhere).

**Root cause.** `boot()` (`gateway/index.ts`) opened the listener with a bare
`Bun.serve({ port })` and no EADDRINUSE handling. The transient cause of a busy
port on restart is the *prior* process still releasing the socket during its
graceful drain — but there was no bounded retry to ride that window out. A
configured port that should be honored-or-fail was instead left to crash/race
with no deterministic outcome. (For the record: Bun.serve THROWS EADDRINUSE
rather than literally binding a random port; the user-visible "wrong port"
traced to the restart overlap + the missing deterministic rebind, not to Bun
silently randomizing.)

**The fix (deterministic-or-loud).** New `bindHttpListener()` helper in
`gateway/boot-helpers.ts`, wired into `boot()`:
- **`port !== 0` (explicitly resolved: `NEUTRON_PORT` / `--port`, or the fixed
  7800 default):** bind it and ONLY it. On EADDRINUSE, retry on a short backoff
  through a bounded window (default ~8s) to ride out the prior process releasing
  the socket; if still held, **FAIL LOUD** — throw a clear, actionable error
  (`port <N> is already in use … stop it (neutron stop) or set NEUTRON_PORT …
  Refusing to silently bind a different port (#314)`) and exit non-zero. Never
  moves to a random port.
- **`port === 0` (the genuine "pick anything" case — dev/tests pass
  `--port=0` / `BootOptions.port=0`):** single attempt, OS auto-selects a free
  port, exactly as before.
- Non-EADDRINUSE errors rethrow immediately (no retry masking real boot faults).

**Restart helper.** `neutron-service.sh do_restart` now VERIFIES (best-effort,
via `_wait_http_up` curling `/healthz`) that the new process came back up on the
**configured** port and warns loudly otherwise. Both supervisor primitives
already serialize old-exit-before-new-start (launchd `kickstart -k` kills the
running instance before respawning; systemd `restart` does ExecStop → wait →
ExecStart), so the residual socket-release overlap is the part the server-side
retry now covers.

**Tests (REAL, RED→GREEN).** `gateway/deterministic-bind.test.ts` stands up an
actual `Bun.serve` squatter on a fixed port and exercises `bindHttpListener`
against it: (1) a persistently-occupied configured port FAILS LOUD with a clear
message and never binds a different port; (2) a squatter that releases mid-boot
→ the helper retries and binds the SAME configured port; (3) control: `port 0`
auto-selects a free port in a single attempt; (4) non-EADDRINUSE errors rethrow
fast. Also verified live end-to-end on a non-7800 port (7811 clean boot; 7812
squatter → 8s retry → loud exit, no random bind). `bunx tsc --noEmit` clean,
`gateway/` suite 1894 pass / 0 fail, leak-gate silent. #314 closed.

## 2026-06-20 — OSS community-health files for the public flip

Added the standard public-OSS community files ahead of the rjunee/neutron public
flip: CONTRIBUTING.md (dev setup via Bun + install.sh, test discipline, PR
process), SECURITY.md (private vuln reporting via GitHub advisories / ryan@junee.org,
self-host trust model, no key commits), CODE_OF_CONDUCT.md (Contributor Covenant
2.1). LICENSE (Apache-2.0) + README already present. Docs-only; no code change.

## 2026-06-20 — GO-LIVE: make the wow first-week brief TRUTHFUL (no fabricated overnight/reminder claims)

Owner-confirmed defect on the converged Open install, fixed on
`fix-brief-truthful-20260620` and merged into `open-converge`. Owner decision:
**option A — make the brief truthful now**; option B (actually wiring real
overnight work at onboarding) is a logged post-launch follow-up, OUT OF SCOPE
here.

**The defect.** The end-of-onboarding wow first-week brief (action 01,
`onboarding/wow-moment/actions/01-first-week-brief.ts`) ASSERTED scheduled
overnight work and reminders that were never created. The owner's real DB had
`overnight_queue = 0 rows` and `reminders = 0 rows`, yet the brief said "I've
queued these to work on overnight while you sleep: …" and "I'll run that
overnight pass at 7am tomorrow …". Root cause: `appendOvernightPreview` +
`overnightItems` SYNTHESIZED that list from speculative dispatch-context inputs
(`ctx.stalled_threads`, `ctx.import_result.proposed_tasks`, "import not null")
and presented the speculation as a committed schedule. Action 07 only registers
the per-project `overnight-<slug>` cron that ticks the engine; it does not
enqueue any `overnight_queue` rows at onboarding. So the queue is genuinely
empty and every "queued/scheduled" claim was fabricated.

**The fix (honest-by-construction).** `appendOvernightPreview` now reads the
REAL `overnight_queue` for the project at render time (new
`readQueuedOvernight` helper → `OvernightQueueStore(ctx.db).listByProject(slug)`
filtered to `queued`/`in-flight` rows; any read failure returns `[]` so the
brief OFFERS rather than ever fabricating). Two branches:
- **rows present (control):** reflect the real rows by `description` (capped),
  "I'll work through that queue overnight …".
- **empty queue (the onboarding reality):** emit an OFFER, never a schedule —
  "Nothing is scheduled overnight yet. I can run autonomous overnight work or
  set reminders whenever you want, just ask (for example "schedule overnight
  research on <real project>" or "remind me Monday 9am")."

The deleted `overnightItems` synthesizer is gone entirely. The per-project
pointer ("each project on the left has its own topic") is kept because it is
true (the engine seeds a topic per kept project). Real projects are still
stated from the canonical kept set via `mergeProjects` (unchanged). The brief
never claims reminders are set; the reminders section remains labelled
"suggested" (proposals from import, not active reminders). Reading the live
table is self-correcting: once real work is queued, a later brief reflects it.
No em dashes in the user-facing copy (house style).

**Post-launch follow-up (option B).** Actually wiring real autonomous overnight
work at onboarding (enqueuing `overnight_queue` rows the engine then executes)
is deferred. Until then the brief OFFERS overnight work rather than asserting
it; the moment rows exist, the control branch surfaces them automatically.

**Tests (RED→GREEN, real produced-string assertions, not bookkeeping flags).**
- `onboarding/interview/__tests__/wow-fired-overnight-preview.test.ts` rewritten:
  empty-queue case (stalled threads + proposed tasks present, the exact inputs
  the old code fabricated from) asserts the brief does NOT claim queued/
  scheduled/7am work, DOES reference the real project, DOES contain the offer,
  and has no em dashes; a CONTROL case inserts real `overnight_queue` rows
  (queued + in-flight) via `OvernightQueueStore` and asserts the brief reflects
  them while excluding terminal + other-project rows.
- `onboarding/wow-moment/actions/__tests__/01-first-week-brief.test.ts` gains a
  co-located empty-queue truthful test + a control test.

**Verify.** `bunx tsc --noEmit` clean (ignoring the sibling `../neutron-open`
aliasing artifact). `bun test` green. `scripts/ci/leak-gate.sh --tree .`
silent. STAYED OUT of `gateway/realmode-composer/build-live-agent-turn.ts` and
`open/composer.ts` (a concurrent Forge owns those).

## 2026-06-20 — GO-LIVE live-agent chat: serialize overlapping turns per (instance, topic)

Owner dogfood found the General live-agent chat unreliable: two questions typed
in quick succession ("are any reminders currently set?" then "and what overnight
work is currently scheduled?") produced the "Waking up your workspace for the
first time…" ack MULTIPLE times, rendered the reminders answer TWICE, and NEVER
answered the overnight question. Server log showed two `live_agent_turn` events
both COLD-started → two parallel cold sessions racing for the same (instance,
topic). Fixed on `fix-live-agent-turn-race-20260620` and merged into
`open-converge`. Reproduce-first (RED→GREEN); tsc clean; full suite green; leak
gate silent.

**Root cause — overlapping turns each cold-spawn a separate session.**
`gateway/realmode-composer/build-live-agent-turn.ts`'s `runLiveAgentTurn` had NO
per-(instance, topic) serialization. The cold/warm decision reads an in-process
`contextSent` set, but `contextSent.add(topicKey)` only runs AFTER a turn's
dispatch settles (and the warm CC session it establishes is pooled just as
late). So when a 2nd turn on the SAME (instance, topic) arrives BEFORE the 1st
settles, BOTH turns see `isColdFirstTurn` → BOTH arm the cold-start "waking up"
ack → BOTH compose the heavy first-turn persona/context prompt and cold-spawn a
parallel session for the same key. The persistent REPL's own `acquireTurn()`
mutex serializes turns ON one warm session, but it cannot stop two turns from
cold-spawning two sessions before either is pooled — that pre-pool gap is the
race.

**Fix — a per-(instance, topic) turn chain at the composer seam.**
`buildLiveAgentTurn` now keeps a `turnChains: Map<topicKey, Promise<void>>`
holding the tail of each topic's in-flight turn chain. The returned
`runLiveAgentTurn` is a thin serializer: it chains the turn's body onto the
prior turn's tail, so turns for one (instance, topic) run strictly
one-at-a-time and in arrival order — the 1st turn establishes the warm session
and pays the single cold-start ack; the 2nd runs ONLY after it settles, sees
`contextSent`, skips the ack, reuses the warm session, and answers its own
question in order. The chain tail swallows the prior turn's outcome on BOTH
settle paths (`() => undefined`) so one turn's failure never wedges the chain,
and the map self-prunes once a topic's chain drains (the tail deletes its own
entry iff it is still the current tail). Distinct topics keep distinct chains,
so cross-topic turns still run concurrently. The existing turn body
(`runTurnBody`) — persistence, cold-start ack, dispatch, persist-before-send,
per-turn timeout + abandon handling — is unchanged; only its invocation is now
gated through the chain. This mirrors the monorepo's one-turn-at-a-time-per-
session discipline.

**Reproduce.** **NEW** `gateway/realmode-composer/__tests__/build-live-agent-turn-overlap.test.ts`
fires TWO turns on the SAME (instance, topic) nearly simultaneously (2nd before
the 1st settles, via a recording substrate that answers after a 60ms cold
window) and asserts: exactly ONE "Waking up" ack, exactly ONE cold first-turn
dispatch (single warm session — the 2nd dispatch carries only the bare user
text), and TWO distinct in-order replies (Q1 → Q2, no duplicate, no dropped
turn). RED on pre-fix code (two acks, two cold dispatches); GREEN with the
chain.

**Verify.** `bunx tsc --noEmit` clean (sibling `../neutron-open` aliasing
filtered). `bun test gateway/realmode-composer/` → 331 pass / 3 skip / 0 fail
(incl. the new overlap test + 17 existing live-agent tests). Full `bun test` →
7424 pass / 90 skip / 1 fail — the lone failure is
`gateway/__tests__/app-docs-client.test.ts > deleteFolder() removes an empty
folder`, a git-backed test that timed out at 5s under 701-file parallel load and
passes in 177ms in isolation (pre-existing flake, unrelated to this single-file
change). `bash scripts/ci/leak-gate.sh --tree .` → SILENT.

## 2026-06-20 — GO-LIVE chat polish: persist the wow brief to history + remove the fake unread badge

Two owner-reported polish defects on the converged Open install, fixed on
`fix-chat-polish-20260620` and merged into `open-converge`. Reproduce-first;
real-boot regression tests (DB / composed-server observable, not mock-only);
tsc clean; full suite green; leak gate silent.

**A — the wow first-week brief vanished on reload.** The end-of-onboarding
projects + overnight summary (action 01) showed live during onboarding but was
GONE on General reload; only the "Everything's ready" turn after it survived.
Root cause: the wow channel adapter's `sendText`
(`gateway/realmode-composer/build-wow-dispatcher.ts`) only did a live
`webRegistry.send({type:'agent_message'})` and threw on undelivered — it NEVER
wrote to `button_prompts`, the chat-history store `GET /api/v1/chat/history`
reads. `emitPrompt` persists via `buttonStore.emit`; `sendText` did not, so the
brief was ephemeral (the owner's DB held 10 General turns, none the brief). Fix:
after a CONFIRMED delivery, `sendText` now persists the text to `button_prompts`
as an inert, already-resolved agent-bubble turn (emit a zero-option /
allow_freeform prompt carrying the body, then `resolve` it with an empty
resolution → satisfies the history filter and renders agent-only via
`renderHistoricalTurn`). Strictly best-effort: it runs ONLY on the success path,
wrapped in try/catch so a DB hiccup logs + continues and NEVER turns a delivered
message into a dispatch failure — the load-bearing throw-on-undelivered
semantics (the action-runner's per-action `outcome.failed[]` routing) are
untouched. No idempotency key (matches action 01's "re-running re-emits the
brief" contract); no double-render (the live envelope carries no `prompt_id`, so
the client's `prompt_id`-keyed dedup never collides). Refactor: the channel
adapter was extracted into an exported `buildWowChannelAdapter(deps)` so its
persistence behaviour is unit-testable directly with a real `ButtonStore` + a
stub `webRegistry` (production wiring unchanged).

**B — every project sidebar showed a perpetual "1" unread badge.** Owner: "why
does every project have a little '1' indicator? It seems to always reset to 1."
Root cause: the Open topics surface (`open/chat-topics-surface.ts`) sourced
`unread_count` from `ButtonStore.listTopicsByUser`, which derives it as the count
of UNRESOLVED + unexpired `button_prompts` — and every materialized project
carries exactly ONE unresolved opening seed prompt, so the badge sat at 1
forever. There is NO per-topic last-read / last-seen marker persisted anywhere,
so "unread" cannot be computed honestly — it was a fake indicator. Decision
(per the owner's standing no-fake-indicators rule): REMOVE rather than build a
last-read subsystem for go-live. The surface now reports `unread_count: 0` for
every topic, so the client badge (which hides at 0) never paints a fake "1". The
client badge mechanism and wire field are left intact (the Managed surface and a
future real last-read seam can still use them).

Tests: NEW `open/__tests__/wow-brief-history-persist.test.ts` (3) drives the REAL
`buildWowChannelAdapter` over a real `ButtonStore`, asserts the brief lands in
`button_prompts` AND that a real Open boot's `GET /api/v1/chat/history` returns
it as a resolved agent turn, AND that no-active-WS still throws + persists
nothing. NEW `open/__tests__/chat-topics-no-fake-unread.test.ts` (1) boots the
real Open composition with a project whose only row is its unresolved opening
seed and asserts `GET /api/v1/chat/topics` returns `unread_count: 0` (was 1).
`bunx tsc --noEmit` clean; full `bun test` 7424 pass / 0 fail / 90 skip; leak
gate silent. (Also reworded a pre-existing leak-gate-flagged phrase in
`docs/SYSTEM-OVERVIEW.md` describing the warm CC session to the Open
`per-(project,topic)` framing so the leak gate is silent on the tree.)

## 2026-06-20 — GO-LIVE: chat history 404 — wire `chat_history_surface` into the Open composer

Owner retest after the 5-fix pass: General reloaded EMPTY and project-switch
still showed only the single live re-emit. Real forensics (owner instance DB +
browser console) nailed it: `button_prompts` held all 10 General turns and the
exact server history query returned all 10, but the browser logged
`GET /api/v1/chat/history?limit=20 → 404` / `[chat] event=history-hydrate-failed
status=404 — falling back to live-WS-only`. **Root cause: the Open composer
(`open/composer.ts`) mounted `chat_topics_surface` (the sidebar rail) but NEVER
mounted `chat_history_surface` (the message hydration), so `/api/v1/chat/history`
404'd in the composed server — the handler + its unit tests existed; only the
wiring was missing (the OSS carve dropped it).** The earlier "#2/#3" pass cleared
the loading spinner and added render-path tests but never exercised the real
route, so the 404 survived. Fix: construct `createChatHistorySurface({ store:
landing.buttonStore, resolveUserClaim: cookieToUserClaim, project_slug })` and add
`chat_history_surface` to the Open composition output, mirroring the topics
surface exactly. Regression lock — NEW `open/__tests__/open-chat-history-wiring.test.ts`
boots the REAL Open composition over `Bun.serve`, seeds a General `button_prompts`
turn, and asserts `GET /api/v1/chat/history` is MOUNTED (200 + returns the turn
WITH the owner cookie / 401 without) — was 404. `bunx tsc --noEmit` clean; new
test 2 pass / 0 fail. This is the missing reachability test that let the bug slip.

## 2026-06-20 — GO-LIVE chat-surface fixes: 5 post-onboarding defects (public-flip gate)

Owner live-dogfood of the converged Open install surfaced 5 defects on the
daily-driver chat surface. All fixed on `fix-chat-surface-20260620` and merged
into `open-converge`. Reproduce-first; real regression tests; tsc clean; leak
gate silent.

1. **[P0 — General topic was DEAD] completed-phase General typed messages got
   zero response.** Root cause: the General `user_message` live-agent gate
   (`isLiveAgentEligible`, `gateway/http/chat-bridge.ts`) was the ONLY caller
   that passed `respect_final_handoff: true` — project topics passed `false`.
   An owner who finishes onboarding and never taps the wow final-handoff "Done"
   leaves `phase_state.final_handoff_active` stuck `true` forever, so EVERY
   typed General message returned `eligible=false`, fell through to the engine's
   `handleFinalHandoffOnCompleted` → `noop_terminal`, and the topic went silent
   — while project topics (which ignore the flag) worked. Fix: removed the
   `respect_final_handoff` gate entirely; General now mirrors project topics
   (`phase==completed` ⇒ live agent). The wow buttons still work — a
   `button_choice` TAP bypasses the `user_message` gate and routes to the engine
   handoff handler unchanged; only TYPED replies now reach the live agent.
   Tests: `chat-bridge-live-agent-turn.test.ts` (typed-with-pending-handoff →
   live agent; tap → engine).
2. **[client] Reload hung on "Setting things up…" forever.** The loader cleared
   only on first rendered content; a completed-instance reload emits no fresh
   first agent message and General history can be empty, so it hung until a
   topic switch. Fix: the server stamps `resumed: true` on a returning session's
   `session_ready` (cookie-only resume + spent-jti fallback in `landing/server.ts`);
   the client clears the loader on that signal (`handleSessionReady`, `chat.ts`).
   Fresh onboarding arrives WITHOUT `resumed`, so its loader still covers the
   bring-up window. Tests: `chat-setup-indicator.test.ts`.
3. **[client] Topic switch dropped history to the last message.** Verified
   ALREADY RESOLVED at `open-converge@6a82c57` by the 2026-06-19 BUG #310 fix
   (render unresolved historical rows inert instead of `if (!turn.resolved)
   return`). Added regression coverage that locks full-history rendering across
   a switch, including the in-flight-initial-hydrate abort race
   (`topic-switch-history-go-live.test.ts`).
4. **[client] Topic switch killed the typing indicator.** Re-attach on a fresh
   turn works (test); hardened `switchTopic` to also
   `clearOpenTypingTimeout()` — the one-shot on-open dangling-dots timeout was
   never torn down on switch and could fire on the new topic, force-clearing a
   live indicator.
5. **[onboarding] "ignore <project>" acknowledged but the project was created.**
   The `projects_proposed` removal seam exists (`removed_projects` union-minus-
   removals merge, tested) but the LLM router prompt only enumerated
   "drop/cut/skip", so "ignore real estate investing" was acknowledged
   conversationally yet never populated `removed_projects` → re-added by the
   additive union → materialized. Fix: "ignore"/"exclude"/"leave out"/"don't set
   up"/"remove" are now first-class removal verbs in `llm-router.ts`; honest
   copy in the `projects_proposed` prompt + FAQ ("just say 'ignore X'… you can
   also rename or delete any project later"). Test: `projects-proposed-ignore-removal.test.ts`
   pins that an ignore is excluded from the materialized set.

Verification: `bunx tsc --noEmit` clean; `bun test` gateway/http (221), landing
(437), onboarding interview+synthesis (941/35 skip) all 0 fail + the new suites;
`scripts/ci/leak-gate.sh --tree .` SILENT.

## 2026-06-20 — onboarding import copy: drop "One moment", set large-import expectation

Owner-dogfood feedback during the converged-Open install test: the import-scan
status copy said "One moment" while the synthesis read of a large ChatGPT
export legitimately runs for minutes. Changed both the dynamic import-running
status (`buildImportRunningPromptSpec`, `phase-prompts.ts:~2150`) and the static
`import_running` fallback body (`~194`) from "One moment." → "This may take a
while if you have a large import." Copy-only; no logic change. `onboarding/interview`
987 pass / 0 fail, tsc clean.

## 2026-06-19 — Open public-flip convergence (Trident + overnight + fixes assembled)

Final assembly of the `open-converge` branch ahead of the Open public flip.
**Assembly + green-up only — no new feature work.**

### Merges
- `trident-port` (PR-1→5: foundational Trident engine, `code_trident_runs`
  state machine + tick driver, Forge→Argus review/fix/merge loop, Ralph
  spec-driven build mode, `/code` → Trident, restart-resume) merged.
- `overnight-engine` (the real Autonomous Overnight-Work engine that runs ON
  Trident: `onboarding/overnight/` queue-store + dispatcher + morning-brief +
  STATUS.md sync, migration `0078_overnight_queue`) merged.
- Only conflict was `AS-BUILT.md` (append-conflict on both merges) — resolved
  by KEEPING BOTH sides' entries. Code merged cleanly (Trident in `trident/`,
  overnight in `onboarding/overnight/`, prepublic-scrub fixes in
  onboarding/chat/landing — disjoint trees).

### Type-clean (`bunx tsc --noEmit` → 0 errors)
- `onboarding/overnight/dispatcher.ts` — omit `context_text` when undefined
  (exactOptionalPropertyTypes); guard malformed `shiftLocalDate` parse.
- `onboarding/overnight/status-md-sync.ts` — guard regex capture groups +
  array index access under noUncheckedIndexedAccess.
- `onboarding/wow-moment/project-materializer.ts` — pass the woven related-
  signal STRING (`weaveRelatedSignal`) into `renderSeedContext`, not the raw
  `RelatedImportSignal` object.
- overnight `*.test.ts` — non-null assertions on already-length-checked array
  indices (assertions not weakened).
- The Trident `git-mode.ts` `cwd` error noted in the brief was already fixed by
  PR-5. Zero cross-worktree (`../`) sibling-artifact errors this run.

### Test + leak-gate green
- `bun test` — full suite **7406 pass / 90 skip / 0 fail** on a clean run.
  Two fixes: `migrations/runner.test.ts` now includes migration `0078`; the
  `m2-mira-v3-tangent-coverage` signup tangent assertion now expects an
  amend/answer carrying a NAME to auto-advance signup (the BUG1
  onboarding-opening-fix behavior — the prior "pass" was a FALSE read from a
  cross-worktree symlink in a sibling checkout that ran the OLD `main` engine).
  A small set of gateway HTTP-surface tests (`app-docs-surface`,
  `app-reminders-surface`) are a PRE-EXISTING concurrency flake — they pass in
  isolation, pass on clean reruns, and are untouched by this merge (last
  modified at the base import commit `23c4351`).
- `scripts/ci/leak-gate.sh --tree .` — **SILENT ✅ (0 findings)**. Tier-1 PII
  rule skips because `LEAK_GATE_PII_DENYLIST_B64` is unset (expected for the
  public tree). Proof: `git grep '1003775096851'` → 0; `git grep -i 'managed
  customer'` → 0; no committed base64 PII blob.

### Framing sweep (harness, not "personal AI agent")
- README already reframed to "an agent harness for Claude Code" (0 stale
  "personal AI agent"/"platform" hits).
- `agent-name-suggester.ts` + `personality-character-suggester.ts` system
  prompts: dropped "personal AI agent" → "their agent" (these describe the
  user's named assistant, not the product).
- `build-project-doc-composer.ts` "personal AI workspace" reviewed and KEPT —
  it accurately names the user's local workspace, not the product framing.

## 2026-06-19 — Per-project chat: preserved history (#310) + STATUS.md opening (#308)

Two live-dogfood bugs that share the per-project-topic / `button_prompts`
code path, fixed together.

### BUG #310 (P1) — project chat history not preserved (only the latest message showed)

All per-project history derives from the `button_prompts` table via
`ButtonStore.listHistoryByTopic`. Two compounding causes:

**Cause 1 (rendering) — `landing/chat.ts`.** `renderHistoricalTurn` did
`if (!turn.resolved) return`, dropping EVERY unresolved historical row and
relying on the server's live re-emit (`reEmitActiveSeedPromptIfAny`) to
repaint. But the re-emit ships only the SINGLE most-recent unresolved row, so
any earlier unresolved turn vanished on a topic switch (a project whose only
row was its unresolved opening seed showed exactly one message).

**Fix.** Render unresolved rows as inert agent bubbles (no button keyboard,
no paired user reply). The ONE exception is the topic's single most-recent
unresolved row — the "active prompt" the server re-emits live WITH its
clickable keyboard — which is left for the live re-emit so the dedup
(`renderedPromptIds`) can't strip its buttons. `prependHistoryBatch` computes
that `activePromptId` from `turns[0]` of the newest batch only (older "Load
earlier" pages never contain it) and threads it into `renderHistoricalTurn`.

**Cause 2 (persistence) — `gateway/http/chat-bridge.ts`.** On a project topic,
a `user_message` only persisted when `liveAgentEligible`; otherwise the stub
reply was a live-only `send({type:'agent_message'})` never written to
`button_prompts`, so the turn was lost on switch/refresh.

**Fix.** New `persistProjectStubTurn` helper in `handleProjectTopicInbound`
persists the stub turn regardless of `liveAgentEligible`, reusing the
live-agent pattern: stamp the typed text as the `__freeform__` resolution of
the prior unresolved row, then emit the stub reply as a new unresolved row
(10-year TTL). The live envelope now carries `topic_id` + the persisted
`prompt_id` so the client dedups it against the history re-emit.

### BUG #308 — generic "want me to dig into…" opening instead of a STATUS.md summary

`buildDeterministicProjectOpening` emitted a hardcoded
`` `Want me to dig into ${firstTopic}?` `` and sourced only the README first
paragraph / import rationale. STATUS.md (written by the materializer at
`<owner_home>/Projects/<slug>/STATUS.md`) was never read.

**Fix (`gateway/realmode-composer/`).** Added `status_md` to
`ProjectOpeningDocs`; read STATUS.md at the doc-load seam. New `parseStatusMd`
parses the frontmatter (one-liner / status / priority) + body summary + an
"Open threads" list. The deterministic opening now leads with a status
summary, an ask-for-corrections line, and a per-project next-action hook
(prefers an open thread, then a suggested topic, then an open question). The
LLM composer (`build-project-opening-message.ts`) gets STATUS.md fed first in
its prompt + a system instruction to summarize it and invite corrections. No
em dashes in the new copy.

### Tests

- `landing/__tests__/chat-history-hydrate.test.ts` — new case: older
  unresolved turns render inert while the newest unresolved (active) is left
  for the live re-emit (with buttons).
- `landing/__tests__/project-chat-status-opening.integration.test.ts` — ONE
  integration test covering BOTH bugs end to end (handoff hook -> ButtonStore
  -> chat-bridge -> store reads -> ChatClient DOM): the opening summarizes
  STATUS.md, stub turns persist, and the full transcript renders on
  switch-back.
- `bunx tsc --noEmit` clean. Existing `ProjectOpeningDocs` fixtures updated
  with `status_md`.
## 2026-06-19 — Onboarding COMPLETION flow fix (#309) + timezone auto-skip (#306)

Live owner-dogfood bugs in the end-of-onboarding handoff. Branch
`onboarding-handoff-tz` off `prepublic-scrub`.

### #309 — the two final-handoff messages were too long / confusing / wrong

The completion flow emits two General-topic messages in sequence: the wow
first-week brief (`onboarding/wow-moment/actions/01-first-week-brief.ts`,
fires LAST in the dispatcher) and the final-handoff guide
(`onboarding/interview/final-handoff-prompts.ts:buildFinalHandoffPromptSpec`,
emitted by `engine.ts:emitFinalHandoffPrompt` after the `completed` upsert).
Per-project detail already routes to each project's own topic via
`gateway/realmode-composer/build-onboarding-handoff.ts:emitProjectSeeds`
(`web:<user_id>:<slug>`). Four fixes, all in the MESSAGE content (the
overnight-WORK engine was untouched):

1. **Respect the user's project trim.** `01-first-week-brief.ts:mergeProjects`
   re-added the full `import_result.proposed_projects` on top of
   `captured_projects`, resurrecting every project the user trimmed away (the
   owner trimmed to 4 and the brief still rendered `Projects on deck (9)`).
   `captured_projects` is already the kept set when the engine observed a
   `projects_proposed` confirmation (`ctx.projects_confirmed === true`,
   plumbed from `primary_projects_confirmed`). Fix: gate the import merge on
   `!projects_confirmed`, mirroring `03-project-shells.mergedProjects`.
   Unconfirmed/legacy callers keep the dedupe-merge.

2. **Killed the hardcoded "AC install" example.** The overnight footer
   hardcoded `"drop the AC install"` — a fabricated project the user never
   had. Replaced with a non-fabricated example drawn from the user's ACTUAL
   kept projects (`"drop <FirstKeptProject>"`), else a generic
   `"drop an item"`.

3. **Consolidated the close; no premature "You're all set."** The brief used
   to end with a dangling question (`"Want to change what's queued?"`) that
   the final-handoff's `"You're all set"` immediately barreled past. The brief
   no longer poses a hard closing question (the final-handoff carries the one
   closing invite), and the guide greeting changed from `"You're all set"` to
   `"Everything's ready"` — a calm hand-off into action, not a triumphant
   terminal receipt. The owner-liked `"What's something I can help you with
   right now?"` invite stays.

4. **High-level in General, detail per-project.** The per-project overnight
   breakdown (`"Per-project background analysis for <X>"`) was enumerated in
   General. Removed it from `overnightItems` (General now carries only the
   cross-cutting overnight work — stalled-thread drafts, queue re-rank, graph
   refresh) and added a high-level pointer: *"Each project on the left has its
   own topic — open one to see what I've lined up for it."* Each project's
   specifics already land in its own topic via `emitProjectSeeds`.

### #306 — interview asked for the timezone even when auto-detected

The web client auto-detects the IANA timezone
(`landing/chat.ts:detectBrowserTimezone`) and sends it as the `?tz=`
WS-upgrade param, but the server never persisted it: `phase_state.timezone`
was only ever READ (by persona-gen, `engine-internals.ts`), never WRITTEN, so
it stayed empty and the agent had nothing to treat as "already known". Worse,
the "never ask for timezone" instruction lived in `prompts/onboarding/
interview-base.md`, which is DEAD (not wired to any live driver — the live
system prompt is `onboarding/interview/skills/_envelope.md`). Fixes:

- **Persist `?tz=` end-to-end.** `landing/server.ts` parses `tz` on the token
  WS upgrade → `SocketState.browser_timezone` → `ChatBridge.startSession` →
  `gateway/http/chat-bridge.ts` forwards it to `engine.start` → new
  `StartInput.timezone` → stamped onto `phase_state.timezone` on the first
  start. New `engine-internals.ts:sanitizeBrowserTimezone` is the server-side
  trust boundary (IANA shape, ≤64 chars); an invalid/oversize/wrong-shape
  value is dropped (key stays absent → ask-nothing fallback). Shallow-merge
  upsert means a later reconnect that omits `?tz=` never clobbers connect-1's
  value.
- **Live never-ask rule.** Ported the never-ask-timezone instruction into the
  live `_envelope.md`, and the gap-fill user prompt now surfaces a stamped
  timezone as `known_timezone=<zone>` (`llm-prompt-driver.ts`,
  `PhaseContextBundle.known_timezone`) so the model treats it as captured and
  never asks.

### Tests

New: `onboarding/interview/__tests__/timezone-autoskip.test.ts`
(`sanitizeBrowserTimezone` cases + `engine.start` stamps/drops timezone +
envelope carries the rule); two new cases in `01-first-week-brief.test.ts`
(trim respected when confirmed; legacy merge preserved when not). Updated:
`wow-fired-overnight-preview.test.ts` (no per-project enumeration / no "AC
install" / new pointer + project-derived drop example) and the
`llm-prompt-driver-envelope.test.ts` byte-for-byte pin (new envelope
paragraph). Test seam: `projects_confirmed` added to
`wow-moment/__tests__/test-helpers.ts:buildContext`.

## 2026-06-19 — Trident-port PR-5 (FINAL): remaining Vajra fixes + restart-resume + `/code` → foundational Trident

Last of the ~5 sequential PRs — completes the foundational Trident port. PR-2
landed the state-machine + tick + store; PR-3 the real Forge/Argus substrate
sessions; PR-4 the Ralph plan↔task loop. PR-5 ports the remaining
battle-tested Vajra fixes with explicit regression tests, hardens
restart-resume, and rewires `/code` to be a THIN entry into foundational
Trident (creates a `code_trident_runs` row; the tick drives it) instead of the
Code-Gen Core wrapper's separate orchestration path.

**1. Remaining Vajra fixes — mapped + explicitly tested.** NEW
`trident/vajra-fixes.test.ts` (23 tests) is the one-file map from each Vajra
`/trident` SKILL.md / forge-argus fix to its Open analog, each with a narrow
assertion so none can silently regress:
- **Spawn validation / no phantom in-flight** — `TridentSessionManager.spawn`
  records the `running` entry SYNCHRONOUSLY before returning (the Open analog
  of Vajra's poll-up-to-60s spawn confirm); a blank minted id throws. So a
  `classify`/`isTracked` immediately after spawn can never miss the session.
- **Reap / "session never became ready" → bounded re-dispatch** — see (2).
- **Oversized-diff guard** — `chooseArgusScope` + `computeDiffLineCount` +
  `ARGUS_DIFF_LINE_LIMIT` (3000): over-ceiling steers Argus to meaty commits +
  "could not verify"; an unmeasurable diff is conservatively treated as OVER.
- **max_rounds / max_ralph_rounds caps** — `computeTransition` fails loudly
  with a named reason past either cap; the single ralph-round counter lives in
  the plan transition (no double-count).
- **Phantom-ID / async-registry race** — a `classify` before completion
  reports `running` (never a phantom crash); an unknown id defaults to the
  SAFE `running` (non-null id blocks a re-spawn); `unknown_session:'crashed'`
  opts into loud orphan failure.
- **No silent exit / no silent merge** — a forge-init with no PR contract →
  `crashed`; an unparseable Argus verdict → `REQUEST_CHANGES` (never
  auto-merge).
- **Missing REMAINING_TASKS fails loud** — a Ralph bootstrap/planner with no
  valid count → `failed`, never a partial-build review.
- **Model routing defaults** — Forge/Argus models default + ride on every
  dispatch (never empty); overrides route through; nothing defaults to the
  export-control-disabled Fable id.

**2. Restart-resume + reap, hardened.** NEW `session.isTracked(id)` exposes
whether a persisted `subagent_run_id` is still tracked in-memory (false after a
control-plane restart — the Open analog of Vajra's "is the tmux window / PID
alive?" reap). NEW orchestrator option `on_orphaned_session`
(`'redispatch'` default / `'wait'` / `'fail'`): on a tick, a non-null
persisted sub-agent the manager no longer tracks is recovered BEFORE
poll/spawn — `redispatch` resumes the run by re-launching that phase, BOUNDED
to one re-dispatch per run per process (the re-spawned session registers
synchronously, so steady state never re-enters; a per-process guard stops a
crash-restart storm). This is NOT a double-spawn — the prior in-process agent
is already gone, so exactly one agent is ever live. NEW
`trident/restart-resume.test.ts` (5 tests) simulates a restart (fresh
orchestrator + empty session map over the same store row) mid-`argus` and
mid-`ralph-task` and asserts: the lost phase re-dispatches exactly once, the
stale id is replaced by a fresh TRACKED session, `runningCount() === 1` (no
second agent), and the run drives to `done`; plus `wait`/`fail` policy
coverage.

**3. `/code` → foundational Trident (Code-Gen wrapper retired for `/code`).**
NEW `trident/code-command.ts` — the Trident-native `/code` parser + dispatcher
(`parseCodeCommand` / `parseAndExecuteCodeCommand` / `slugifyTask`). `/code
<task>` no longer drives the Code-Gen Core's `CodegenOrchestrator` + in-memory
tracker + sidecar; it CREATES a `code_trident_runs` row (git-mode + Ralph
auto-detected) and returns — the foundational tick loop picks it up and drives
forge-init → argus → fix loop → merge → done. State in SQLite ⇒ a `/code`
build survives a restart and resumes from its phase. The command grammar
(`/code <task>` / `/code stop [id]` / `/code help`) matches the Core's S2 shape
so the UX is unchanged. NEW `trident/code-command.test.ts` (12 tests) incl. an
END-TO-END path: `/code` text → row → tick loop (mocked substrate) → APPROVE →
`gh pr merge` → `done`.

**4. Boot wiring + the production `/code` filter.**
- `gateway/composition/build-core-modules.ts` — the `trident` module now wires
  the REAL orchestrator `step` (`buildTridentOrchestrator` over a
  `TridentSessionManager`) when the composer threads `input.trident.dispatch`;
  else it falls back to `stubAdvanceDeps` (unchanged Open default). The
  dispatch is one Forge/Argus turn → terminal text, built from the
  per-instance Anthropic substrate (the same credential closure the Code-Gen
  Core's sub-agent dispatch consumed before Trident superseded the wrapper).
- NEW optional `input.trident` seam in `composition/input/misc-input.ts`
  (`dispatch` / `run_host` / models / timeout / `on_orphaned_session`).
- NEW `buildTridentCodeChatCommandFilter` in `gateway/boot-helpers.ts` (+
  re-exported from `gateway/index.ts`) — the production `/code` filter that
  creates Trident runs, superseding `buildCodegenChatCommandFilter` (now marked
  SUPERSEDED, retained for the Core's legacy MCP-tool path + tests). NEW
  `gateway/__tests__/trident-code-command-wiring.test.ts` (5 tests).
- NEW exported `spawnCapture` (default `Bun.spawn` host runner) from
  `trident/git-mode.ts` for the orchestrator's `run_host` default.

**Verify.** `bunx tsc --noEmit` clean (0). `bun test trident/` → 161 pass / 0
fail (was 121; +40 new across vajra-fixes, restart-resume, code-command).
Full suite `bun test` → 7354 pass / 90 skip / 2 fail; both failures are
PRE-EXISTING and unrelated (`notes-production-composer` passes 7/0 in isolation
= load flake; `m2-mira-v3-tangent-coverage` fails identically with this PR's
tracked changes stashed = pre-existing onboarding-LLM flake). Zero regressions.

### Decisions Log (PR-5)
- **Resume = bounded re-dispatch, not just reap.** Vajra reaped a dead agent
  and re-dispatched. Open's substrate is in-process, so a restart definitively
  kills the agent — re-dispatch is recovery, not double-spawn. Default policy
  is `redispatch`; bounded one-per-run-per-process. `wait`/`fail` are opt-in.
- **`/code` rewired to Trident at the wiring layer; the Code-Gen Core
  orchestration is NOT physically deleted in this PR.** A grep-verified
  analysis (the brief's "KEEP anything still uniquely used") shows the Core's
  `CodegenOrchestrator`/runner/`chat-commands`/sidecar are still referenced by
  the Core's four `codegen_*` MCP tools, its install-lifecycle + manifest, the
  Managed graph composer, and ~106 self-contained passing tests. Deleting them
  inline would red those suites and is a separate Core-removal change. `/code`
  is fully retired-to-Trident (the production filter creates Trident runs); the
  physical file deletion + substrate relocation is the documented remaining
  step. See STATUS.md.
- **No `git worktree remove` on merge (carried from PR-3).** Open uses plain
  branches; deleting an operator's checked-out worktree is the data-loss
  footgun the spec forbids.

## 2026-06-19 — Real Autonomous Overnight-Work engine (runs ON Trident)

Replaces the preview-only morning check-in stub
(`onboarding/wow-moment/overnight-cron.ts`, `wow_overnight_handler`, which
delivered a "here's what's on deck" message but never ran any work) with a real
engine that, while the user sleeps, dispatches each project's highest-priority
queued items — **each as its own Trident run** (Forge→Argus→merge) — and a
morning brief reports the REAL result of every run. Neutron-Open (SQLite) port
of Vajra's `gateway/overnight-dispatcher.ts`, with the Ryan-locked correction
that each item is a Trident run, NOT a single throwaway substrate turn.

**Why:** Ryan rejected the earlier fake-copy fix — the overnight work must
ACTUALLY run, on the ported Trident, and the brief must report real results
(never invented).

- **NEW `migrations/0078_overnight_queue.sql`** — `overnight_queue` (owk-id PK,
  project scope, agent_role, priority, status, the `[context:]` hard-gate
  column, `result`, the `trident_run_id`/`trident_slug` link, `ralph`,
  lifecycle stamps) + `overnight_budget` (per-window dispatch counter). SQLite
  is the runtime source of truth; STATUS.md is the agent's rendering of it.
- **NEW `onboarding/overnight/queue-store.ts`** — typed `ProjectDb` CRUD +
  owk-id allocation (`owk-YYYYMMDD-NNN`) + the atomic per-window budget counter.
- **NEW `onboarding/overnight/status-md-sync.ts`** — the agent-maintained
  STATUS.md `## Autonomous Overnight Work` block: render-from-queue + parse
  (round-trip / hand-seed migration), the opt-in frontmatter flag, and the
  `[context:<path>]` HARD GATE (Vajra grammar, re-pointed to the per-project
  repo root: 64 KB cap, no abs paths, no `..`, symlink-escape rejected).
- **NEW `onboarding/overnight/dispatcher.ts`** — window (23:00–07:00 local) /
  budget (2 concurrent / 8 per window, env-overridable) / scan / advance /
  reporter. SCAN reconciles + gates + dispatches by creating a
  `code_trident_runs` row per item; ADVANCE polls those runs and records each
  REAL terminal result + writes `docs/overnight/<owk-id>.md` + re-renders
  STATUS.md.
- **NEW `onboarding/overnight/morning-brief.ts`** — real-results-only reporter:
  General high-level summary (counts + one line per project) + per-project
  detail (each completed item's result + each failure's reason), routed to
  bound topics with a General fallback; quiet-night = one honest line. Never
  invents.
- **NEW `onboarding/overnight/register.ts`** — `overnight_handler` (the engine)
  + production seams (real-fs STATUS.md IO + result-doc writer, the
  `TridentRunStore`-backed Trident seam with merge-mode auto-detect + context
  threading, opted-in project enumeration over `<owner_home>/Projects/`).
- **CHANGED `onboarding/wow-moment/actions/07-overnight-pass.ts`** — renamed the
  cron job `wow-overnight-<slug>` → **`overnight-<slug>`**, repointed it at
  `overnight_handler`, and changed the cadence 24h → **~30-min** (the engine
  gates window/budget/reporter internally).
- **CHANGED `gateway/composition/build-core-modules.ts`** — registers the real
  `overnight_handler` engine unconditionally, replacing the check-in stub.
- **CHANGED `onboarding/wow-moment/project-materializer.ts`** — makes the
  onboarding promise TRUE: writes `autonomous_overnight_enabled: true`
  frontmatter into every materialized project's STATUS.md AND seeds one grounded
  overnight bullet pointing at a real `docs/overnight/seed-context.md` (written
  from the synthesized project context). The engine's scan reconcile adopts it
  into a real queue row → the hard gate passes → it runs as a Trident run on the
  first overnight window.

**Tests (REAL — no bookkeeping-only):** `onboarding/overnight/*.test.ts` walk
the real dispatcher with a scripted Trident seam AND the real `TridentRunStore`:
a queued item creates a Trident run + the morning brief reports its REAL result
(asserted via the doc-on-disk at `docs/overnight/<owk-id>.md`, the queue row's
recorded `result=PR#42`, and the re-rendered STATUS.md — NOT "phase advanced");
the context-gate rejects a no-`[context:]` item; budget/concurrency caps hold;
window gating; morning-brief General-summary + per-project routing + General
fallback + never-invent-on-empty; a hand-seeded STATUS.md bullet becomes a real
queue row. `tsc` clean (only the pre-existing global `bun`-types contamination);
overnight suite 42 pass + trident suite 121 pass; onboarding 1538 pass / 0 fail.

**Known gap (Trident PR-5):** the engine creates + polls REAL `code_trident_runs`
rows, but those rows only ADVANCE end-to-end once the Trident tick loop boots on
a live `TridentDispatch` instead of `stubAdvanceDeps`. Until then a production
overnight run is created + tracked but sits at `forge-init`; the full path is
proven by the test suite driving the run to terminal through the same store the
engine polls.

## 2026-06-19 — Trident-port PR-4: Ralph spec-driven build mode (plan ⇄ task loop)

Fourth of ~5 sequential PRs. PR-2 wired the Ralph transition GRAPH into the
state machine (the `forge-init → ralph-plan ⇄ ralph-task` cycle + the
`max_ralph_rounds` cap, fully unit-tested); PR-3 wired the real Forge/Argus
substrate sessions but left the Ralph phases as a typed seam
(`TridentPhaseNotWiredError`). PR-4 wires the REAL one-task-per-fresh-context
loop into those phases — ported from Vajra's `~/.claude/skills/trident/SKILL.md`
§ "Ralph build mode (v3)" onto Open's substrate. Lineage: Geoffrey Huntley's
"ralph" loop + Spec-Kit's specify→plan→tasks→implement.

**Why Ralph:** a large, spec-driven build done in ONE Forge context drifts as
its window fills/compacts ("agent forgets what we agreed"). Ralph decomposes
the build into FRESH single-task spawns whose progress lives in FILES + git
history (`IMPLEMENTATION_PLAN.md`, `AS-BUILT.md`, commits), never a context
window — so it cannot drift. An active planning pass each iteration diffs
`SPEC.md` against the actual code, so a regressed/half-built task re-opens as a
`- [ ]` and the loop self-corrects.

- **CHANGED `trident/git-mode.ts`** — added Ralph mode DETECTION (mirrors the
  skill): `detectRalphMode(repoPath, probe, {explicit})` → a run is Ralph when
  explicitly requested OR the repo's git root contains a `SPEC.md` ("governed"
  repo). `defaultRalphModeProbe` resolves the git root via
  `git rev-parse --show-toplevel` then checks `<root>/SPEC.md` (file-existence
  injectable for tests). A throwing probe degrades to legacy (never errors run
  creation). The run-creation call site is PR-5 (the seam is exported + tested
  now).
- **CHANGED `trident/prompts.ts`** — three Ralph renderers + a planner parser:
  `RALPH_BOOTSTRAP_NOTE` (appended to `renderForgePrompt` when `run.ralph`: the
  first iteration writes `IMPLEMENTATION_PLAN.md`, builds ONLY the top task,
  reports `REMAINING_TASKS`); `renderRalphPlanPrompt` (a docs-only planning
  pass — diff SPEC vs code, rewrite the plan, emit `REMAINING_TASKS` +
  `NEXT_TASK`, NEVER rewrite SPEC); `renderRalphTaskPrompt` (a fresh Forge that
  implements ONLY the surfaced task + checks it off). New `parseRalphPlan`
  parses a planner's `REMAINING_TASKS`/`NEXT_TASK` WITHOUT requiring the PR
  contract lines (a planner does a docs-only commit). The **fail-loud guard**
  is now strict `^[0-9]+$` (new `parseStrictCount`): a garbled count → `null`,
  never coerced to 0.
- **CHANGED `trident/session.ts`** — `recordCompletion` now special-cases the
  `ralph-plan` phase: parse via `parseRalphPlan`, thread the `NEXT_TASK` to the
  following ralph-task via a new `nextTaskFor(run_id)` map (mirrors the
  argus→forge-fix `findingsFor` handoff). A planner that omits a valid count →
  `remaining: null`, which the state machine fails loudly on. (This fixed a
  latent PR-3 gap: a VALID planner output, having no PR lines, would have been
  mis-failed by `parseForgeOutput`.)
- **CHANGED `trident/orchestrator.ts`** — `spawnForPhase` now wires
  `ralph-plan` (renders the planning prompt) and `ralph-task` (renders the
  one-task prompt with the threaded `NEXT_TASK`). Every LIVE phase is wired;
  `TridentPhaseNotWiredError` is now a never-should-happen backstop (terminal
  phases are short-circuited before spawn).
- **Hand-off to review.** The state machine (PR-2) already routes
  `ralph-plan` with `REMAINING_TASKS=0` → `argus` → the PR-3 fix/merge loop.
  With the spawns wired, a governed run now actually walks plan ⇄ task until
  convergence, then reviews + merges the accumulated branch per git-mode.

### Tests (`trident/ralph.test.ts` + additions to `prompts.test.ts`)

23 new tests (121 total in `trident/`, up from PR-3's 98). `ralph.test.ts`
drives the REAL orchestrator loop with a scripted substrate that performs the
ACTUAL file side-effects a live session would (writes `IMPLEMENTATION_PLAN.md`,
checks one task off per ralph-task, appends `AS-BUILT.md`) — so the loop
converges through genuine file state and assertions hit real artifacts:
- a governed 3-task run walks forge-init → plan ⇄ task → (0 remaining) → argus
  → merge → done; final plan has every task `- [x]`, `AS-BUILT.md` records each
  built task, and exactly ONE ralph-task ran per remaining task (one task per
  fresh context) with a planning pass between each (active drift-catch).
- a bootstrap reporting 0 remaining short-circuits straight to review.
- fail-loud: a bootstrap that omits OR garbles `REMAINING_TASKS` → `failed`,
  never merged; a planner pass that omits it → `failed`, never merged.
- `max_ralph_rounds` bounds a never-converging planner → `failed` (no merge).
- `detectRalphMode`: explicit flag, governed-repo SPEC.md detection,
  ungoverned → legacy, throwing-probe degradation, and a real temp-dir probe.
`prompts.test.ts` adds strict-count rejection + `parseRalphPlan` cases + the
three render-prompt assertions.

**Verify.** `bunx tsc --noEmit` clean (0 errors). `bun test trident/` → 121
pass / 0 fail. Out of scope (PR-5): the production run-creation call site +
retire the code-gen Core wrapper. Seams left intact.

## 2026-06-19 — Trident-port PR-3: the Forge → Argus review → fix → merge loop (substrate sessions)

Third of ~5 sequential PRs. PR-2 landed the state-machine SKELETON (phase
enum, transition graph, round/ralph-round caps) with `deps.classify`
always reporting "running". PR-3 wires the REAL agentic loop into those
phases: it spawns Forge/Argus as substrate sessions, parses the verdict,
loops fix↔review to `max_rounds`, then merges per the git mode — the heart
of Trident, ported from Vajra's `/trident` SKILL.md onto Open's substrate
(no tmux, no `spawn-agent.sh`, no ScheduleWakeup — one in-process tick
loop drives every run).

- **NEW `trident/prompts.ts`** — trident-OWNED port of Vajra's
  `forge.md` + `argus.md`, adapted to Open's substrate. `renderForgePrompt`
  / `renderForgeFixPrompt` / `renderArgusPrompt`, plus the locked-contract
  parsers: `parseForgeOutput` (PR_NUMBER / BRANCH / WORKTREE + optional
  Ralph `REMAINING_TASKS`, back-walked so trailing preamble can't shadow),
  `parseArgusVerdict` (fail-safe `REQUEST_CHANGES` on unparseable output —
  never auto-merge a verdict it can't read), `parseArgusFindings`. The
  **oversized-diff guard** lives in `chooseArgusScope`: round-1 reads the
  full `<base>..HEAD` diff only under the 3000-line ceiling, else it steers
  Argus to the meaty commits + "state what you could not verify"; round 2+
  always reviews the single fix commit via `git show HEAD`. The Argus
  prompt carries the no-silent-exit invariant verbatim.
- **NEW `trident/session.ts`** — `TridentSessionManager` bridges the
  BLOCKING `TridentDispatch` (a Forge/Argus turn → terminal text, same
  shape code-gen's `buildRuntimeSubagentDispatch` produces) onto the tick's
  poll-every-tick model: `spawn(input)` records `running` SYNCHRONOUSLY and
  fires the dispatch in the background; `classify(run)` polls by
  `subagent_run_id`. Ported Vajra fixes: **no phantom-id poll** (the
  running entry is written before `spawn` returns; an empty mint throws);
  **no silent exit** (a forge-init with no contract lines surfaces as
  `crashed`, never silent success; a Ralph planner that omits
  `REMAINING_TASKS` yields `remaining: null` → the state machine fails it
  loudly). Forge PR/branch/worktree are captured in-memory and folded onto
  the row by the single-writer tick step (NOT written from the background
  dispatch — that races the tick's own `save`; this was a real bug caught
  + fixed in test).
- **NEW `trident/merge.ts`** — fills the PR-2 `cleanupAfterMerge` seam.
  `'pr'` → `gh pr merge <pr> --squash` then delete the remote + local
  branch; `'local'` → `git checkout <base>` + `git merge --no-ff <branch>`
  then delete the local branch. Ryan-locked: **NO `git worktree remove`**
  (Open uses plain branches). `detectBaseBranch` resolves `origin/HEAD`,
  defaulting to `main`.
- **NEW `trident/orchestrator.ts`** — `buildTridentOrchestrator` →
  the tick `step`: (1) spawn-if-needed (the single, `subagent_run_id ===
  null`-guarded spawn site — so a re-entrant tick never double-spawns),
  (2) poll + transition via the pure `advanceTridentRun`, (3) merge on the
  `done` transition (a merge failure routes to `failed`, recoverable).
  `computeDiffLineCount` (numstat-based, conservative-on-failure) feeds the
  oversized-diff guard. Ralph phases throw `TridentPhaseNotWiredError`
  (typed seam → PR-4) and fail the run bounded rather than spin.
- **CHANGED `trident/tick.ts`** — `TridentTickOptions` now accepts a
  `step` (PR-3's spawn+poll+merge) as an alternative to `deps` (the PR-2
  classify-only default). Boot still passes `stubAdvanceDeps`; the comment
  in `build-core-modules.ts` documents the exact `buildTridentOrchestrator`
  wiring that flips production onto the live loop once the gateway
  credential closure is threaded into a `TridentDispatch` (PR-5).
- **FIXED `migrations/runner.test.ts`** — PR-2 added migration `0077` but
  left the expected-versions list at `…76`; added `77`.

### Tests (`trident/{prompts,session,merge,orchestrator}.test.ts` — all real)

48 new tests (98 total in `trident/`, up from PR-2's 50). The orchestrator
suite drives the loop end-to-end through the real tick + store + a scripted
fake dispatch + fake git/gh seam, asserting real state transitions AND the
git/merge calls (not just "phase advanced"):
- forge-init → argus(APPROVE) → merge → done — pr mode runs
  `gh pr merge 42 --squash`; local mode does `git checkout main` +
  `git merge --no-ff` + `branch -D` and never calls `gh`.
- REQUEST CHANGES → forge-fix → argus → APPROVE → merge (round increments,
  2 forge + 2 argus turns).
- max-rounds exhaustion → failed, never merges.
- a forge-init with no contract lines → failed (crashed).
- resume safety: a re-entrant tick while the sub-agent is in flight polls,
  does NOT spawn again (dispatch called exactly once).
- oversized-diff guard: a 5000-line numstat steers the Argus prompt to the
  meaty-commits scope; a small diff lets it read the full diff.

**Verify.** `bunx tsc --noEmit` clean (0 errors). `bun test trident/` →
98 pass / 0 fail. Broader suite: the only failing test
(`tests/integration/m2-mira-v3-tangent-coverage.test.ts`, an onboarding LLM
fixture) fails identically on the base commit — pre-existing, untouched by
this PR.

## 2026-06-19 — Trident-port PR-2: state machine + tick driver + git-mode auto-detect

Second of ~5 sequential PRs porting Vajra's full Trident into Neutron Open
as **foundational runtime** (not a Core). PR-1 wired the existing code-gen
engine into the prod `/code` boot path; PR-2 lands the runtime the eventual
autonomous loop runs on: a durable state machine, an in-process tick driver
that advances it, and per-run git-mode detection. The actual Forge/Argus
sub-agent spawning is PR-3 and the Ralph one-task-per-fresh-context loop is
PR-4 — both build on the typed seams left here.

### What shipped

- **NEW migration `migrations/0077_code_trident_runs.sql`** — the SQLite
  translation of Vajra's `/trident` skill state file
  (`~/vajra/gateway/trident-<slug>.state.json`). One row per pipeline.
  Columns: `id` (uuid PK) + `slug` (the skill's per-run key, UNIQUE per
  `project_slug`); `phase` (CHECK enum: `forge-init | ralph-plan |
  ralph-task | argus | forge-fix | done | failed | stopped` — the skill's
  seven phases + `stopped` for `/trident stop`); `round`/`max_rounds`
  (Argus loop cap, default 8); `ralph`/`ralph_round`/`max_ralph_rounds`
  (Ralph flags, default cap 20); `branch`/`pr`; `merge_mode` (CHECK
  `local | pr`, default `local`); `subagent_run_id`/`subagent_status`
  (the in-flight sub-agent persisted ON the row — restart-resume — NOT in
  the disconnected generic `runtime/subagent/` registry); `repo_path`/
  `worktree`/`task`; `chat_id`/`thread_id` (delivery routing);
  `failure_reason`; `started_at`/`last_advanced_at` (ISO-8601). Indexes:
  UNIQUE `(project_slug, slug)` + a PARTIAL index on `phase` excluding the
  terminal set (the tick driver's "load non-terminal runs" query stays
  flat-cost as finished runs accumulate). `expected-schema.txt` snapshot
  regenerated.

- **NEW `trident/` workspace package `@neutronai/trident`** (registered in
  root `package.json` workspaces + deps):
  - `store.ts` — `TridentRunStore`, the CRUD wrapper over the table,
    shaped like `reminders/store.ts` (async writes via `ProjectDb.run`,
    sync reads, injectable clock). `create` / `get` / `getBySlug` /
    `listNonTerminal` / `update` (partial patch) / `save` (full snapshot,
    the shape the state machine returns) / `delete`.
  - `state-machine.ts` — `advanceTridentRun(run, deps)` + the pure
    `computeTransition`. The phase graph is ported verbatim from the
    skill: legacy one-shot `forge-init → argus`; Ralph
    `forge-init → ralph-plan → ralph-task → ralph-plan …`; `argus`
    APPROVE → `done`, REQUEST CHANGES → `forge-fix` (round++ until
    `max_rounds` → `failed`); `forge-fix → argus`. The Ralph round
    increment + `max_ralph_rounds` cap live in a single `enterRalphPlan`
    (mirrors the skill's "Spawn a Ralph planner" shared block) so a
    non-converging plan↔task loop fails loudly. The skill's "missing
    `REMAINING_TASKS` fails loudly, never silently" rule is enforced: a
    Ralph bootstrap/planner with no remaining count → `failed`, never a
    silent partial-build review. `deps.classify` is the PR-3/PR-4 seam
    (reads sub-agent outcome + spawns next phase); `stubAdvanceDeps`
    (always "running") is the PR-2 production stub.
  - `tick.ts` — `TridentTickLoop`, modelled on `reminders/tick.ts`:
    single-flight `setInterval` (default 90 s = the skill's ScheduleWakeup
    cadence), loads `listNonTerminal` each tick, advances each via
    `advanceTridentRun`, persists only on a real transition (idempotent),
    per-run try/catch so one failure can't abort the tick.
  - `git-mode.ts` — `detectMergeMode(repoPath, probe)`: `'pr'` iff a
    GitHub `origin` remote AND `gh` are both present, else `'local'` (a
    throwing probe degrades to `local`, never errors a run).
    `defaultGitModeProbe` shells `git remote get-url origin` + `gh
    --version` via `Bun.spawn` (injectable runner for tests).
    `cleanupAfterMerge` is the PR-3 merge/teardown seam — typed stub for
    both `pr` + `local` modes now.

- **Production wiring** — `gateway/composition/build-core-modules.ts`
  gains a `tridentModule` (constructs `TridentRunStore` over `input.db`,
  starts a `TridentTickLoop` with `stubAdvanceDeps`, stops it on
  shutdown), registered in `gateway/composition.ts` right after the
  reminders module — exactly the way the reminders tick is registered. The
  stub deps mean the loop is live + restart-safe but advances nothing
  until PR-3 wires the real sub-agent classifier.

### Tests (`trident/*.test.ts`, all real — DB round-trips, no mocked SQL)

- `store.test.ts` — migration applies (table exists); create/get
  round-trips every column + defaults + overrides; `getBySlug`
  project-scoping + UNIQUE-constraint rejection; partial `update`
  re-stamps `last_advanced_at`; `save` snapshot; `listNonTerminal`
  excludes done/failed/stopped, oldest-advanced first; `delete`; CHECK
  rejects an invalid phase.
- `state-machine.test.ts` — `isTerminalPhase`/`TERMINAL_PHASES`; the full
  legacy loop walk; every Ralph transition + both round caps; the
  loud-fail on missing `REMAINING_TASKS`; `advanceTridentRun`
  terminal/running/crashed/completed paths incl. sub-agent-slot clearing +
  clock stamping; `stubAdvanceDeps` never advances.
- `tick.test.ts` — advances every non-terminal run whose sub-agent
  completed; never touches terminal runs; idempotent under "running";
  `per_tick_limit` cap; one run's error doesn't abort the tick; `start`
  idempotent + `stop` safe twice.
- `git-mode.test.ts` — `isGithubRemoteUrl` https/ssh accept + non-GitHub
  reject; `detectMergeMode` truth table incl. throwing-probe → local;
  `defaultGitModeProbe` with an injected runner (pr/local discrimination);
  `cleanupAfterMerge` stub-vs-injected for both modes.

**Verify.** `bunx tsc --noEmit` clean (0 errors). `bun test trident/` →
50 pass / 0 fail. Full `bun test` green (see PR description for counts).

## 2026-06-19 — Trident-port PR-1: wire the code-gen engine into the production boot path (the foundation)

First of ~5 sequential PRs porting Vajra's full Trident into Neutron Open
as **foundational runtime**. PR-1 scope is ONLY the foundation — NOT the
Trident state machine / Ralph / multi-round Argus loop (PR-2→5).

### Investigation — what the production `/code` boot path actually wires (file:line)

**Open has no in-repo production graph composer.** The boot shell
(`gateway/index.ts:174 boot()`) composes the module graph from a composer
loaded via the `NEUTRON_GRAPH_COMPOSER_MODULE` env seam
(`gateway/index.ts:517 loadGraphComposerFromEnv`). That env points at the
**Managed** `provisioning/realmode-composer.ts`, which is NOT in this
public repo (no `provisioning/` dir; nothing exports `buildGraphComposer`
here). Open self-hosts with the env unset boot a `/healthz`-only shell
with no chat surface and no Cores.

**The Open-side seam the (absent) composer calls is
`buildCoresBackendFactories` (`gateway/boot-helpers.ts:568`).** Its
`codegen_core` factory (`gateway/boot-helpers.ts:898-911`, pre-PR-1)
returns the threaded `codegenOrchestratorFromOpts` **when present**, but
**silently falls to `buildSkeletonCodegenRunner()` when omitted**. The
skeleton runner (`cores/free/code-gen/src/backend.ts:425`) throws
`CodegenNotConfiguredError` ("install the Tier 2 Coding Core") on every
`run(...)` — so a composer that forgets to thread the orchestrator
degrades `/code` to a Tier-2 wall **even on a credentialed instance where
the real Forge → Argus → merge loop could run**.

**This is asymmetric with the Research Core**, which HARD-REQUIRES its
backend — `buildCoresBackendFactories` throws if `researchProjectBackend`
is omitted (`gateway/boot-helpers.ts:887-895`), closing the same
silent-no-op class (research Argus r1 BLOCKER #4). Codegen never got that
treatment.

**The full codegen production chain exists but is three hand-wired
pieces** (none invoked by any in-repo production code — only the absent
Managed composer + tests call them):
1. `buildCodeGenLlmCall` (`gateway/cores/code-gen-factory.ts:146`) —
   resolves the Anthropic credential (Max OAuth → BYO `NEUTRON_ANTHROPIC_API_KEY`
   → no-credential sentinel) and builds the `CodegenLlmCall` closure. SOLE
   `@anthropic-ai/sdk` importer for codegen.
2. `buildCodegenWiring` (`cores/free/code-gen/src/wiring-production.ts:105`)
   — sidecar resolver + `buildRuntimeSubagentDispatch` + `buildRuntimeCodegenRunner`
   + `CodegenOrchestrator` + `build_chat_command_context` factory.
3. `buildCodegenChatCommandFilter` (`gateway/boot-helpers.ts:511`) — the
   `/code` chat filter wrapping `parseAndExecuteCodeCommand`.
Drop any link (most easily: omit `codegenOrchestrator` from step (2)→the
backend factory) and `/code` silently degrades to the skeleton.

**Conclusion: the production `/code` path CAN run the real engine when the
composer wires all three pieces (proven by
`gateway/__tests__/code-gen-core-credential-resolution.test.ts`), but the
seam allows a silent skeleton fall-through that the diagnostic flagged.**

### Code-Gen Core inventory (for the PR-5 fold/retire decision)

Tier-1 free Core at `cores/free/code-gen/` — productizes the owner's
`/trident` skill as `/code` for chat-driven users. Public barrel:
`cores/free/code-gen/index.ts`. Modules:
- `src/manifest.ts` — Core slug + 3 SDK capabilities (`host:gh`,
  `network:github`, `agent:dispatch_subagent`) + 4 tool names.
- `src/backend.ts` — `CodegenOrchestrator` (in-memory FIFO task tracker;
  `dispatch`/`status`/`fetch`/`cancel`), the typed-error hierarchy, the
  in-memory + **skeleton** runners (`buildSkeletonCodegenRunner` →
  `CodegenNotConfiguredError`).
- `src/runtime-runner.ts` — production `RuntimeCodegenRunner`: composes
  Forge → Argus → (auto-)merge in-process via a `SubagentDispatch`
  closure + host `gh`/`git`/`bun test` runners + per-project worktree +
  sidecar. Auto-merge default-ON in S2 (`gh pr merge` on Argus APPROVE,
  audit `who_confirmed='autonomous'`). `max_argus_rounds` cap.
- `src/substrate-runtime.ts` — substrate-agnostic `CodegenLlmCall`
  closure interface + `buildRuntimeSubagentDispatch` (the multi-turn
  tool loop: Forge/Argus tool defs → handlers → LLM call). **This is the
  `dispatch_subagent` closure loop.**
- `src/tool-handlers.ts` — scoped Forge (read/write/edit/glob/grep/bash)
  + Argus (read-only + scoped bash) tool defs + handlers.
- `src/chat-commands.ts` — `/code <task>` + `/code stop|cancel` parser +
  dispatcher (`parseAndExecuteCodeCommand`); `CodeCommandContext` +
  `CodegenChatNotifier` (terminal-notification seam, declared but not yet
  called in S2).
- `src/prompts/forge-system.ts` + `argus-system.ts` — IN-TREE Forge/Argus
  system prompts + output parsers (zero host-app imports).
- `src/sidecar/store.ts` — per-project SQLite sidecar
  (`<OWNER_HOME>/Projects/<id>/code-gen/code-gen.db`): `tasks` + `audit`
  + `settings` + `transcripts`. Resolver + migrations.
- `src/worktree-resolver.ts` — per-project git worktree at
  `<OWNER_HOME>/Projects/<id>/code/`.
- `src/host-runners.ts` — `HostGh/Git/BunTest` runner interfaces +
  `buildStubHostRunners`.
- `src/wiring-production.ts` — `buildCodegenWiring` (the assembly factory).
- `src/ui/launcher-icon.ts` + `app-tab-surface.ts` — P5.3 launcher tile +
  app-tab metadata.
- `src/tools.ts` — the 4 MCP tools (`codegen_dispatch`/`_status`/`_fetch`/
  `_cancel`) over the orchestrator.

`/code` flow: chat `/code <task>` → `parseAndExecuteCodeCommand` →
`CodegenOrchestrator.dispatch` (mints task, schedules via `setImmediate`)
→ `RuntimeCodegenRunner.run` → resolve worktree → Forge sub-agent (via
`dispatch_subagent` closure loop) → write sidecar task row → Argus
sub-agent (≤ `max_argus_rounds`) → on APPROVE `gh pr merge` + audit row.
**For PR-5: fold the runtime runner + dispatch loop + prompts + sidecar +
worktree resolver into foundational Trident; retire the Core wrapper
(manifest + 4 MCP tools + launcher/app-tab) once `/code` routes through
the foundation directly.**

### PR-1 fix — consolidate the chain so the composer can't forget

NEW `gateway/cores/build-production-codegen-wiring.ts` →
`buildProductionCodegenCoreWiring(opts)`: ONE call that chains
credential-resolution → `buildCodegenWiring` → `buildCodegenChatCommandFilter`
and returns `{ codegen_orchestrator, chat_command_filter, sidecar_resolver,
runner, credential_source }`. Mirrors the Research Core's
`buildProductionResearchCoreWiring` (gateway-side, not in-Core, because
codegen's credential factory is gateway-side). REUSES the existing
`wiring-production` factory — no duplication. The composer threads
`codegen_orchestrator` into `buildCoresBackendFactories({ codegenOrchestrator })`
and `chat_command_filter` into the app-WS surface in a single step,
eliminating the drop-a-link drift.

Also hardened the flagged fall-through: `gateway/boot-helpers.ts:898-911`
now `console.warn`s LOUDLY when `codegenOrchestrator` is omitted
(mirroring the Tasks-composer guardrail, Argus r2 BLOCKING #2), pointing
at the new entrypoint. The skeleton STAYS (it is the legitimate Tier-1
safe-install shape for Open self-hosts that never wire codegen —
`install_ok` must stay TRUE); we only made the silent degrade observable.

### Tests

- **NEW** `gateway/__tests__/code-gen-core-prod-wiring-real-runner.test.ts`
  (3 tests): boots `composeProductionGraph` through
  `buildProductionCodegenCoreWiring` and asserts `/code <task>` dispatches
  through the REAL runtime runner — Argus APPROVEs, `gh pr merge` fires
  once for PR #42, durable sidecar task + audit rows written. A SKELETON
  CONTROL wires the same graph to a skeleton orchestrator and asserts ZERO
  merges + ZERO sidecar rows — proving the real-path assertions
  discriminate (the guard FAILS against the pre-fix skeleton path). A
  no-credential test proves the entrypoint still returns a REAL
  orchestrator whose `/code` short-circuits with the friendly install hint
  (`no_credential`), NOT the skeleton Tier-2 wall.

**Verify.** `bunx tsc --noEmit` clean (0 errors). `bun test cores/free/code-gen/`
→ 106 pass. `bun test gateway/__tests__/code-gen-core-*` + `cores-composition`
+ `code-gen-factory` → 33 pass (incl. the 3 new). Full `bun test gateway/`
green except pre-existing flake (see STATUS).

## 2026-06-19 — Onboarding OPENING flow fix (signup double-ask + phantom buttons)

Two live-reproduced go-live blockers in the onboarding opening (the prod
LLM-router path: `phaseSpecResolver` + `llmRouter`, NOT the prod-dead
`promptDriver`).

### BUG 1 — signup double-asked the name (wouldn't advance on a bare "Ryan")

**Root cause.** Signup advancement on the prod path depended on the LLM
router classifying the typed name as `advance`, but `PACK_SIGNUP.advance_examples`
was empty `[]`, so the router classified a bare name as `amend` (it volunteers
a fact) or a low-confidence `answer`. Those fell to the generic amend/answer
tails in `dispatchRouterDecision`, which persisted `user_first_name` but
re-emitted + STAYED on signup → the second name-ask. The deterministic
name-guard (`extractAgentNameFromFreeform` → `sanitizeUserFirstName`) only ran
on the non-router `consumeChoice` path (tests), never in prod.

**Fix (primary).** `onboarding/interview/engine.ts` — new
`tryAdvanceSignupFromRouter` helper invoked at the top of
`dispatchRouterDecision` for `state.phase === 'signup'` on `amend`/`answer`.
When a valid `user_first_name` is present (from the whitelisted `state_delta`,
already persisted on `phase_state`, or extractable from the freeform via the
existing name helpers), it builds the synthetic `__freeform__` choice and routes
through `consumeChoice` — the same path the working `advance` branch and the
unit test use — so signup → `instance_provisioned` → `ai_substrate_offered`
fires. Returns `null` (falls through to normal handling) when there is no name
signal, so genuine tangents ("why do you need my name?") still get their FAQ
answer and unparseable replies still hit the clarify-reprompt guard. The
amend-key whitelist (`whitelistRouterStateDelta`) runs on this path too, so the
bookkeeping-key security gate is preserved.

**Fix (defense-in-depth).** `onboarding/interview/phase-spec-resolver.ts` —
populated `PACK_SIGNUP.advance_examples` with bare-name exemplars ("Ryan",
"Sam Doe", "call me Jane", "I'm Alex" → advance) so the router itself classifies
a name as `advance`.

### BUG 2 — "Tap one of the buttons above" with NO buttons rendered

**Root cause.** `emitButtonsOnlyNudge` always sent `BUTTONS_ONLY_NUDGE_TEXT`
("tap one of the buttons above…") even when the resolved spec came back
option-stripped — a text bubble promising buttons that don't exist.

**Fix.**
1. `onboarding/interview/interaction-mode.ts` — new
   `NO_BUTTONS_FALLBACK_NUDGE_TEXT = "Just reply here to continue."`.
2. `onboarding/interview/engine.ts` — `emitButtonsOnlyNudge` now resolves the
   live spec FIRST and sends the button-free fallback copy when the spec has no
   options (a `message_override` validator reason still wins), so the nudge copy
   always matches the rendered button state.
3. `onboarding/interview/phase-spec-resolver.ts` — `materializeSpec` hardening:
   an option-bearing phase never resolves option-less. If the LLM resolver drops
   the options a phase structurally needs, the static fallback's options are
   restored (a non-empty subset from the LLM is preserved — only a full drop is
   repaired).

### Tests — closed the test-path gap that let this ship green

- **NEW** `onboarding/interview/__tests__/signup-router-prod-path.test.ts` —
  wires the PROD path (a REAL `LlmRouter` via `buildLlmRouter` backed by an
  in-memory `FixtureAnthropicClient`, plus the real `PACK_SIGNUP`) and drives
  `advance("Ryan")` through the REAL router classification (not a stubbed
  decision). Asserts signup ADVANCES (name captured, not re-asked) on `amend`
  and `answer` classifications, that a genuine tangent does NOT over-advance,
  and that `PACK_SIGNUP.advance_examples` is now non-empty. These advance
  assertions FAIL on pre-fix code and PASS with the fix.
- **UPDATED** `interaction-mode-routing.test.ts` — the buttons-only enforcement
  test now asserts the nudge copy MATCHES the resolved button state
  (`BUTTONS_ONLY_NUDGE_TEXT` when options render; `NO_BUTTONS_FALLBACK_NUDGE_TEXT`
  when option-less — e.g. `persona_reviewed` without a wired `personaComposer`).
- **UPDATED** `engine-router-integration.test.ts` — the two amend-whitelist
  security tests reflect the new signup behavior: a name-bearing amend now
  auto-advances (bookkeeping keys still rejected, attacker `active_prompt_id`
  never lands); the all-rejected test uses a non-name freeform so it stays on
  signup (preserving the stay-path whitelist coverage).
- Existing `signup-asks-name.test.ts` stays green.

**Verify.** `bunx tsc --noEmit` introduces no new genuine errors (the
pre-existing 66 are a dual-worktree `@neutronai/*` → sibling-clone aliasing
artifact; the one added line in the new test is the identical `stubPlatform`
PlatformAdapter aliasing the two sibling router-test files already exhibit).
`bun test onboarding/interview/` → 981 pass / 35 skip / 0 fail. Full `bun test`
→ 7187 pass / 90 skip / 0 fail.
