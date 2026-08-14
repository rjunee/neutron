---
title: "SPEC.md — Neutron Open (master spec)"
last_updated: 2026-07-27 (app remote diagnostics: the mobile app reports its own JS errors to the owner's OWN gateway — self-hosted, credential-free, no third party; native crashes remain uncovered)
---
<!-- CURRENT: steady-state (world-class refactor window COMPLETE; feature development resuming) -->

# SPEC.md — Neutron Open

**Governance preamble.** This file is the present-tense CURRENT TARGET for
neutron-open — what the product IS and is being built toward. It carries no
abandoned branches and no "we used to do X" narrative: when a decision changes
the plan, the body is edited in place to reflect the new plan and a dated entry
is added to the TOP of the Decisions Log (newest-first). The Decisions Log is
the single home for the DATED RECORD of each locked decision (when + why); the
body (System Overview · Architecture · Phases → Steps · Open Questions)
DESCRIBES the resulting architecture in present tense and points to the log
rather than re-arguing or re-dating a decision. Other docs reference a decision
by date, never restate it. The Decisions Log is immutable — entries are never
removed or rewritten; a superseded decision stays with a "superseded" note.

**This is a governed repo** under the Spec-Drift Guardrails convention: it has a
root `SPEC.md`. trident's `detectRalphMode` (`trident/git-mode.ts`) keys off a
root `SPEC.md` in the git root of the repo BEING BUILT — so a trident `/code`
build whose workspace is a checkout of THIS tree runs the Ralph plan↔task loop,
diffing this spec against the code. It does NOT auto-govern an arbitrary
user-project `/code`: those resolve a fresh `<home>/Projects/<slug>/code` build
workspace (git-init + empty commit, no `SPEC.md`), so they stay on the legacy
single-context build. This file governs trident builds against this checkout,
not every production `/code`. Agents READ this spec and diff it against the
code; they NEVER rewrite it — the owner owns it.

## Canonical doc set

| Concern | Doc |
|---|---|
| Decisions + architecture + roadmap (this file) | `/SPEC.md` |
| Current build queue (agent-regenerated on demand, disposable; may be absent when idle) | `/IMPLEMENTATION_PLAN.md` |
| Chronological build log (append-only provenance) | `docs/AS_BUILT.md` |
| How it works NOW (living architecture detail, under this spec) | `docs/SYSTEM-OVERVIEW.md` |
| Load-bearing invariants (per-merge checklist) | `docs/INVARIANTS.md` |
| Public-facing positioning + self-host quickstart | `README.md` |
| Bugs / defects / backlog | GitHub Issues on the public repo |

A root `ISSUES.md` is intentionally absent — the purity gate reserves that path
(see the Decisions Log). Open's defect tracker is GitHub Issues; the *planned*
backlog lives in Phases → Steps below.

## System Overview

Neutron Open is a **single-owner, local-first agent harness** you self-host. One
person (the **owner**) runs one instance on their own machine; there is no fleet
and no shared control plane in this tree. The product is Apache-2.0 and
self-hostable end to end.

The one idea the rest of the system hangs off: **the agent _is_ a Claude Code
process.** By default Neutron does not call a model API directly — every
judgment turn (a chat reply, an onboarding classification, a research
synthesis) is dispatched into a real `claude` CLI child process that Neutron
spawns and supervises over stdio. Claude Code is the **substrate**; Neutron owns
everything around judgment (channels, state, scheduling, memory, buttons) and
hands the turn off when judgment is needed. The owner brings their own Claude
(paste-token or an API-key fallback); the model relationship is owned by the
`claude` binary. A provider seam (§2.3) can instead route conversational turns
to a model-API adapter — an opt-in, BYO-key OpenAI GPT path selected by env —
while autonomous builds (Trident) always stay on Claude Code.

A separately-operated hosted service runs a fleet of isolated single-owner
instances. It lives entirely OUTSIDE this repository: it ships no addresses
here, imports no code from here beyond the public packages, and adds no
vocabulary to this tree. Nothing in this spec describes it beyond this
paragraph.

Implementation truth — the current, verified "how it actually works" — lives in
`docs/SYSTEM-OVERVIEW.md`. This section is the summary; that doc is the detail.

## Architecture

Summary + pointers only. Implementation truth lives in `docs/SYSTEM-OVERVIEW.md`
and the `README.md` "Architecture at a glance" diagram; this section states the
load-bearing shapes and the module boundaries, not the mechanics.

### 2.1 — Product shape

One shipping shape: **Open** — free, Apache-2.0, self-hosted, single-owner. The
owner installs it on their own hardware, completes onboarding, and drives it
from chat surfaces. No account system, no hosted default address, no fleet
control plane in this repo.

### 2.2 — Layering (module boundaries are real package boundaries)

A Bun workspace grouped bottom-up into five layers:

- **Edge / transport** — `channels/` (adapters + the `ButtonPrompt` cross-channel
  envelope), `landing/` (web chat server + auth gate), `auth/` (secrets +
  paste-token client), `connect/` (share projects across instances), `chat-core/`
  (the shared client/server sync core over `/ws/app/chat`), `client-core/` (the
  shared `GatewayHttpClient` + unified error), `jwt-validator/` (session-token
  verification).
- **Substrate / runtime** — `gateway/` (the composition root: opens the DB, runs
  migrations, wires the module graph, binds HTTP/WS), `open/` (the product
  entry — `open/server.ts` is the actual `bun` process a self-host runs; by
  default it composes `gateway/` into the single-owner Open server, but it can
  boot an injected graph via the `NEUTRON_GRAPH_COMPOSER_MODULE` seam, so running
  from `open/` does not by itself imply Open deployment mode — see MG-3),
  `runtime/` (the `Substrate`/`Event`
  contract, the Claude Code adapter, the credential pool), `persistence/` +
  `migrations/`, `cron/`, `reminders/`, `tasks/`, `tools/`, `mcp/`, `watchdog/`,
  `trident/` (the autonomous Forge→Argus build/merge pipeline behind `/code`),
  `agent-dispatch/`, `skill-forge/`, `config/` (the frozen `BootConfig` leaf),
  `logger/`, `loop/`.
- **Memory** — `gbrain-memory/` (the sole durable memory store), `scribe/`
  (extraction as a side effect of talking), `reflection/` (the reflection judge),
  `runtime/entity-writer` (the privacy gate every write passes through),
  `doc-search/` + `message-search/` (retrieval indexes).
- **Cores** — `cores/{sdk,runtime}` + `cores/free/*` (the free-tier
  Cores).
- **Product surfaces** — `onboarding/`, `app/` (Expo), `landing/`, `prompts/`,
  `tabs/`, `work-board/`, `project-credentials/`.

Under all five sit the node-free shared contract leaves — `contracts/` (wire/type
contracts, e.g. `LlmCallFn`, `OnboardingPhase`) and `wire-types/` (the canonical
cross-surface option shapes) — the lowest depcruise band, imported downward-only
by every layer above.

The refactor window's target module DAG makes these layer edges **real package
boundaries** (a directed graph with no upward or cyclic imports); the boundary
enforcement lives in `depcruise` + the per-package `tsconfig` matrix.

### 2.3 — Substrate (spawn-and-stdio)

Judgment turns run as spawned `claude` CLI processes over stdio (not an
in-process API client in the parent). A persistent REPL pool keeps warm
sessions; the credential pool threads each spawn's auth into that child's
environment only, never the parent. The contract is **one reply per turn**. The
substrate is swappable behind the `Substrate`/`Event` seam: Claude Code is the
default/primary adapter, and an opt-in OpenAI GPT conversational adapter is also
production-wired (BYO `OPENAI_API_KEY`, selected by env); autonomous builds
(Trident) always run on Claude Code.

### 2.4 — Memory

**GBrain is the sole durable memory store.** Scribe extracts salient facts as a
side effect of ordinary conversation and writes them through the entity-writer
privacy gate into GBrain; recall reads from the same store. There is no second
memory home.

### 2.5 — Cores (the one distribution unit)

A **Core** is the single unit of distribution and extension — a bundle with a
manifest, registered and installed per instance. The free tier ships in
`cores/free/*` (tasks, reminders, calendar, email, research, code-gen,
agent-settings, google-workspace, scraping). Cores are portable: a Core's
prompts and mechanics carry no host-specific assumptions.

### 2.6 — Transport & channels

`ChannelRouter` is the real extension seam for new channels (the OSS-split
decision). The primary interface is the bundled **web chat** (`landing/`) plus
the **mobile app** over the **app websocket** (`channels/adapters/app-ws`); a
**Telegram bot** (`channels/adapters/telegram` — Bot API client + webhook +
inline keyboards) is a shipped OPTIONAL add-on, never required. Further
adapters (e.g. Slack) are roadmap. The `ButtonPrompt` envelope is the one
cross-channel representation of "agent asks, you tap or type", rendered
identically on every surface.

### 2.7 — Connect (share projects across instances)

`connect/` lets one owner's instance share a project with another owner's
instance over a federated token, without either giving up single-owner control.
The Open client OAuths against a centralized identity service, redeems a
one-time code into a federated token store, and the unified project list then
includes shared projects. This is opt-in and off by default.

### 2.8 — Naming registry

| Key | Value |
|---|---|
| Data directory (`NEUTRON_HOME`) | bare-runtime default `~/neutron` when unset (`migrations/db-path.ts`); the installer pins it to the nested `~/neutron/data` (`install.sh`). Holds auth, project.db, Projects/, persona/ |
| Code directory (`NEUTRON_SRC_DIR`) | `~/neutron/core` |
| Default database | `$NEUTRON_HOME/project.db` (override `NEUTRON_DB_PATH`) |
| Bind | `127.0.0.1:7800` (override `NEUTRON_HOST` / `NEUTRON_PORT`) |
| Backups | local git every 12h (`NEUTRON_BACKUP_INTERVAL`); remote optional (`NEUTRON_BACKUP_REMOTE`) |
| npm scope | `@neutronai/*` (packages published from this tree) |
| GBrain opt-out | `NEUTRON_SKIP_GBRAIN=1` / `--no-gbrain` |

The local loopback bind has a baked-in default (`127.0.0.1:7800`, both knobs
overridable) — that is the self-host listener, not a hosted address. It is the
**hosted / relay addresses** that ship with **no baked-in default**: Open ships
zero hosted addresses, so any relay or base-domain address is env-configured
with no fallback.

## Invariants

The per-merge load-bearing invariant checklist lives in `docs/INVARIANTS.md`
(one line per subtlety, each with a `file:line` anchor and the unit/test that
protects it). Do not restate entries here — reference that doc.

## Phases → Steps

The single master work queue. Present-tense and diffable against the code: each
entry is a verifiable requirement an agent can compare with the actual tree.
Edit IN PLACE. Discovered bugs that don't need immediate action go to GitHub
Issues, not here. `[x]` = built + verified in this tree; `[ ]` = queued.

The phase vocabulary below is the one the codebase cites as `SPEC.md § Phases →
Steps`. It has four tracks: **onboarding phases** (the interview state machine),
the **P5–P7 product-surface phases** (the tabbed app + gateway surfaces), and
the **Tier-1 Cores buildout**.

### Onboarding phases (the interview state machine)

The onboarding engine (`onboarding/interview/`) is a phase state machine with a
legal-transition table (`phase.ts`) and a per-phase descriptor table
(`phase-spec-resolver.ts`). Two deployment modes shape the sequence:
`managed` runs the full sequence; `open` (self-host) cuts the provisioning and
subdomain phases and routes `signup → ai_substrate_offered` and
`agent_name_chosen → projects_proposed` directly (`OPEN_MODE_EXTRA_TRANSITIONS`).

Canonical phase set (v2, `contracts/onboarding-phase.ts`):

- [x] `signup` → (`identity_oauth` → `instance_provisioned` in managed) → `ai_substrate_offered`
- [x] `ai_substrate_offered` — offer the paste-token / import affordance; branches to import or straight to the work interview
- [x] `import_upload_pending` → `import_running` → `import_analysis_presented` — optional history import + curation handoff
- [x] `work_interview_gap_fill` — self-loops until required profile fields are filled (cap enforced in-handler)
- [x] `personality_offered` → `agent_name_chosen` → (`slug_chosen` in managed) → `projects_proposed`
- [x] `persona_synthesizing` → `persona_reviewed` — synthesize + review the persona (redo edges back to personality/name/slug)
- [x] `persona_reviewed` → `completed` (terminal) · any non-terminal phase → `failed` (terminal, unrecoverable)

Acceptance: the legal-transition table is exhaustive over `OnboardingPhase`
(compile-time `Record` barrier); open mode never selects a cut phase as
`next_phase`.

### P5 — App surfaces (the tabbed project interface)

The Expo app + gateway app-surfaces, one tab/surface per step. Each surface is a
composed HTTP (and, for chat, WS) handler wired at the gateway composition root;
an unwired surface degrades to an empty state with a "backend not wired" hint.

- [x] **P5.0** — app foundation: auth helpers, token storage, locked theme palette
- [x] **P5.1** — chat surface: app-ws chat + the multipart attachment-upload route
- [x] **P5.2** — project view: project list + per-project settings drawer (privacy_mode), durable over restart
- [x] **P5.3** — project launcher surface (`/api/app/projects/<id>/launcher`)
- [x] **P5.4** — Tasks tab + reminders surfaces (project-scoped task + reminder CRUD)
- [x] **P5.5** — global Focus surface (cross-project today/most-important projection, read-only)
- [x] **P5.6** — device push: register/unregister device tokens; reminders tick loop dispatches native push
- [x] **P5.7** — admin/personality surfaces (SOUL.md editor, GBrain browse, connectors, gateway restart)

### P6 — Task system + nudge engine

- [x] **P6.0** — canonical `TaskStore` (the substrate every task surface reads)
- [x] **P6.1** — nudge engine + staleness + current-focus pick (`/api/app/focus/current`)

### P7 — Doc interface

- [x] **P7.0 / P7.1** — project-scoped docs surface: tree/file read + write/delete, folder + move, over `DocStore`
- [x] **P7.3** — doc-links (cross-doc reference resolution)
- [x] **P7.4** — git-backed doc versioning

### Tier-1 Cores (free, Apache-2.0, `cores/free/*`)

The free Cores bundled at install and discovered by the bundled-Core registry.
Calendar + Email were the first Cores wave; this is the inventory today (a set,
NOT a numbered buildout sequence — historical build order lives in
`docs/AS_BUILT.md`):

- [x] **Calendar** — `cores/free/calendar` (Google OAuth; event CRUD)
- [x] **Email** — `cores/free/email` (Gmail OAuth; thread read)
- [x] **Google Workspace** — `cores/free/google-workspace` (Drive/Sheets/Docs + Gmail send)
- [x] **Tasks** — `cores/free/tasks` (SQLite task system + per-project Tasks tab)
- [x] **Reminders** — `cores/free/reminders` (context-aware dispatcher)
- [x] **Research** — `cores/free/research`
- [x] **Scraping** — `cores/free/scraping`
- [x] **Agent settings** — `cores/free/agent-settings`
- [x] **Code-Gen** — `cores/free/code-gen` — the `/code` build runtime, folded into foundational Trident (no capability gate)

### The world-class refactor window — COMPLETE (2026-07-16)

The world-class refactor window is DONE. Its unit backlog + per-unit status is
`docs/plans/2026-07-02-world-class-refactor-plan.md` (do NOT duplicate it here).
All executed units merged through K10 (the public in-repo SPEC.md — the last
**trident-executed** unit: introducing this file makes a trident build against
this checkout governed via `detectRalphMode`, so no trident-dispatched unit
could follow it). A post-completion fresh-eyes audit closed a punch-list (a
wide-bind upload-auth hole, a timezone-read wiring gap, a build-fragile
one-release shim, a missing sender-propagate regression test).

The non-merged items are deliberate, not gaps, and fall into three buckets (the
per-unit ledger is the plan §17 checklist). **Kept / deferred by decision:**
**MG-3** (the `NEUTRON_GRAPH_COMPOSER_MODULE` composer seam) is KEPT (the OSS-split
boundary — see the Decisions Log); **N3-credential** (frozen-handle threading at
the Managed boot seam) is DEFERRED — it cannot fire without live hosted owners
that rename (the ABI-facing `internal_handle`→`owner_handle` rename that is the
rest of N3 landed with N2 in #367). **Deferred feature work (post-window):** **W3**
(transcript unification, XL) plus the native-shell `[BEHAVIOR]` pair **W4** (Expo
shell conversion) and **W6** (native-shell↔WebView bridge) — the native app is
unpublished, so they slipped past the window; and **K4b** (the onboarding
slug-flow deletion) stays deferred. **Tracked elsewhere / not a window gap:** the
**M-lane (M1–M6)** is Managed cross-repo, tracked in `neutron-managed` (not this
repo's ledger). All of the above plus the known engineering follow-ups now live as
tracked GitHub issues, not private memory.

### Post-window feature backlog

Each carries an acceptance criterion; all in `neutron-open`.

- [ ] **The outer publisher cannot publish a REBASED branch — so design A's publish step fails on
      every card that already has a remote branch** (measured 2026-08-14, run `2aacf419`, the first
      build ever to reach the publish rung). The build SUCCEEDED — checkpoint `forge-done`, a real new
      commit — and then: `publish failed: outer publisher could not push branch …`.
      **This is NOT a credential failure, and that distinction is the whole point.** A dry-run push
      with the real credential authenticated fine and was refused by the server:
      `! [rejected] … (non-fast-forward)`. So the credential path design A introduced works.
      The cause is mechanical: `trident/orchestrator.ts` pushes with
      `git push origin refs/heads/<b>:refs/heads/<b>` and no lease, while the build rebases the branch
      onto current `main`. Verified: the local branch contains post-A `main`, the remote branch does
      not. **A rebased branch is by definition not a fast-forward**, so this push can never succeed —
      not for this card, but for ANY card whose remote branch predates its rebase. Every fix round on
      an existing PR is affected, which is most of them.
      Acceptance: a rebased fix round publishes. The fix must NOT be a bare `--force` — use a lease, so
      a branch someone else genuinely advanced is REFUSED rather than overwritten. Assert both
      directions: the rebase publishes, AND a remote that moved underneath is still refused. A test
      that only proves the first is asserting that force-push works, not that the lease does.
- [ ] **A publish failure throws away the evidence it just measured.** `trident/orchestrator.ts`:
      `if (!pushed.ok) throw new Error(\`outer publisher could not push branch ${branch}\`)` — git's
      stderr had already said exactly why, in words, with hints. It is discarded.
      This is the sibling of the defect fixed in #240 and it landed in brand-new code. #240 removed a
      message that ASSERTED a cause it never measured; this one MEASURES the cause and then drops it.
      Opposite mistakes, identical cost: a human reads the reason and still cannot act.
      Cost, measured rather than supposed: diagnosing the entry above took a DB read, a hand comparison
      of merge-bases, and a dry-run push with the owner's credential to rule out authentication — all
      to recover text the publisher was already holding.
      Acceptance: a publish failure's stored reason carries git's own stderr, and a non-fast-forward
      rejection is distinguishable from an auth failure by reading the reason alone. **And it must not
      become a disclosure surface** — assert the stored reason never contains credential material, with
      a positive control proving that assertion can fail.
- [ ] Wire `ProjectBackupScheduler` (dormant loop today) — a scheduled per-project backup fires on its interval. (D-7)
      Do NOT resolve this one alone: see the code-repo-vs-vault entry below. Wiring the scheduler without
      deciding the model would start snapshotting trees that contain nested code repos and live SQLite.
- [ ] Wire the comments `AgentWatcher` (dormant loop today) — a new comment wakes the agent. (D-7)
- [ ] Resolve HITL `prompt-user` enforcement — review with refactor-window log data before locking the policy. (D-9)
- [ ] Per-project context for agent tools — X6 follow-ons (scope tool state to the active project everywhere).
- [ ] **Native-crash visibility for the mobile app.** App remote diagnostics (2026-07-27) covers JS errors
      only; a crash before the JS bundle runs produces nothing. Acceptance: a native process-start crash on
      the owner's device is diagnosable without a USB cable.
- [ ] **The agent can create Work Board items but cannot remove them — the UI can do something the
      agent cannot** (owner-asked 2026-08-14: *"are you sure you don't have a delete endpoint? I can
      just click the X in the UI, but I'm surprised you can't"*). He is right to be surprised: the
      capability EXISTS and is simply not exposed to the agent. `work-board/store.ts` has `delete()`,
      and `gateway/http/work-board-surface.ts` calls it behind the UI's X — including the careful part,
      cancelling an in-flight trident run before removing the row. The agent tool surface
      (`work-board/agent-tool.ts`) is `add` / `list` / `update` / `reorder` / `complete`, plus `start`
      and `dispatch_build`. There is no `delete`, and no archive lane either.
      THE COST IS NOT HYPOTHETICAL: asked on 2026-08-14 to take four deprioritised cards off the board,
      the only lever available was `complete`, so four unshipped items now read `done` — the agent had to
      MISREPORT state to carry out a routine instruction, and then explain the misreport. An agent whose
      only way to obey is to lie about status will keep producing boards that cannot be trusted.
      Acceptance: the agent can remove an item through the same path the UI uses (run-cancellation
      included, not a bare row delete), AND a deprioritise/archive lane exists that is distinct from
      `done` — so "shipped" and "shelved" stop sharing one word. A test pins that removing an item with a
      live run cancels that run first.
      REMOVAL MUST ALSO DECIDE WHAT HAPPENS TO THE CARD'S PLAN DOC (owner-asked 2026-08-14: *"how do we
      fix this orphan problem? We should probably just delete the plan with the card, or move it to a
      'cancelled' folder or something"*). Today removal leaves the doc in `plans/` with nothing pointing at
      it — it is neither findable from the board nor obviously dead. **Deleting it with the card is the
      wrong default, and there is a live counter-example:** the card removed on 2026-08-14 was the Forge
      publish card, whose doc holds the three costed designs, the measurements and the acceptance criteria
      the owner is building from RIGHT NOW in another session. Deleting on removal would have destroyed the
      spec for work in progress. THE DISPOSITION MUST FOLLOW THE REASON, and only the remover knows it:
      shipped, cancelled, and moved-elsewhere are three different fates. Acceptance (third part): removal
      takes a reason; the doc is MOVED to a disposition-named folder rather than deleted or left in place;
      the moved doc stays readable in the Documents tab; and no path silently destroys a plan doc — a
      deliberate delete is allowed, an implicit one is not.
- [ ] **A card's plan doc is the single source of its spec, and it is written to a place nothing
      version-controls, reviews, or backs up** (owner-reported 2026-08-14, on discovering the P2–P4 note:
      *"plan docs here in this project are not actually written to the repo itself"*). `work-board/spec-doc.ts`
      writes each card's full ask to `Projects/<id>/docs/plans/<slug>.md` via `DocStore`, and the card stores
      `neutron-docs:plans/<slug>.md`. **The LOCATION is correct and Ryan-locked (2026-07-02)** — it must stay
      user-visible in the Documents tab; this entry does NOT propose moving it. The gap is that the write ends
      there. MEASURED on this instance: 12 plan docs on disk; the project vault at `Projects/neutron-open/` IS
      a git repo whose own `CLAUDE.md` states *"every meaningful change commits to this project's own git
      repo"*; **2 of the 12 are tracked — both committed by hand by the agent — and the repo has NO remote and
      2 commits total.** So ten specs, including every card currently on the board, exist as untracked files
      on one volume. THREE CONSEQUENCES, in order of cost: (1) the doc is the input `▶ start` feeds to trident
      as the run's `task`, so losing or silently editing it changes what gets built with no diff and no
      history; (2) the PR that implements a card carries no copy of the spec it was built against, so a
      reviewer on GitHub — human or Argus — cannot see the acceptance criteria they are judging against; (3)
      the code repo and the spec that drives it can drift apart with nothing to detect it. Note the coupling
      to *"the build brief must not be retyped by a model — pass it by PATH"*: that card's premise is handing
      the brief over as a path, and today that path resolves outside the repo the build works in. Acceptance:
      a plan doc lands somewhere durable and versioned — committed by the writer, not by hand — WITHOUT
      leaving the Documents tab; a doc's history is inspectable; and the spec a build ran against is
      recoverable after the fact from the record, not from a live file. Whether that is auto-committing the
      vault repo, mirroring into the code repo alongside the PR, or snapshotting the doc bytes onto the run is
      the design question — do not pick it here.
- [ ] **A project needs a first-class split between its CODE REPO(s) and its VAULT — and the vault must be
      versioned and backed up whether or not any repo exists** (owner-directed 2026-08-14: *"every project
      needs to have the notion of things that are inside the repo … and also things that are outside the repo,
      which is working documents, stuff that only I need … we need to make sure that all the stuff that's
      considered outside the repo is still backed up, still tracked as a git repo, even though it's not
      necessarily pushed anywhere. Or it may be pushed somewhere as one master backup."*). THE MODEL HE ASKED
      FOR, generalised: a project owns a private **vault** (docs, plans, notes, research, per-Core sidecars —
      everything that is only his) and **zero or more code repos**, each with its own remote and its own
      publication rules. `neutron-open` is the demanding case: the vault is private, and `code/` is a clone of
      a PUBLIC repo that must contain only a subset of the project. Most projects have no code repo at all;
      some will have several; the model must not assume one.
      MEASURED on this instance, 2026-08-14 — the current state is NOT a design, it is three overlapping
      mechanisms of which only the weakest runs:
      (a) `Projects/<id>/.git` — created by the materialize path, **one commit ("Neutron materialize: <id>"),
      dated 2026-07-22, on every project, and never committed to since. No remote on any of them. No
      `.gitignore`.** 9 of 16 project folders have one; 7 have no git at all.
      (b) `gateway/git/doc-version-store.ts` — P7.4 Phase 1, a per-doc-edit repo at `<project>/.docs-versions/`.
      **Built, tested, and never constructed: no `.docs-versions/` exists for any project.**
      (c) `gateway/git/project-backup-store.ts` + `ProjectBackupScheduler` — P7.4 Phase 2, a whole-tree
      snapshot every 6h at `<project>/.project-backup/` with an OPTIONAL per-project remote and push-failure
      classification. **Also built, tested, and never constructed** (`loop/registry.ts` already names it as a
      loop that "never starts in ANY composition"; the existing backlog line "Wire `ProjectBackupScheduler`
      (D-7)" is the same defect seen from the other end — these two entries must be resolved together).
      NET EFFECT: the owner's private working context — every plan doc, note and research artifact across 16
      projects — is un-versioned and un-backed-up on one volume. `neutron-backup.sh` would cover it, but it
      backs up `NEUTRON_HOME` and **this instance's `NEUTRON_HOME` is not a git repo** — the script has never
      been run here, and the one backup timer installed on this host does not cover the owner's data at all.
      TWO HAZARDS THE FIX MUST HANDLE, both measured:
      1. **A nested code repo is not just another directory.** `code/` is a real clone and is neither tracked
         nor ignored by the vault repo. `git add -An` in the vault emits *"warning: adding embedded git
         repository: code"* — a naive whole-tree backup stores a gitlink, so the backup contains a pointer to
         content it does not have, while looking complete. A vault backup must EXCLUDE nested repo working
         trees by rule (they have their own remote and their own recovery story), not by luck.
      2. **Live SQLite is in the tree.** The same dry-run would stage `.nexus/nexus.db-wal`,
         `.comments/comments.db-wal` and `calendar/calendar.db-wal`. Phase 2's seeded `.gitignore` is the
         designed answer; whatever ships must actually apply it, and a mid-write WAL must not be committed as
         if it were a consistent snapshot.
      Acceptance: a project declares its code repos (path + remote) as data rather than by their presence on
      disk, and a project with none is a fully supported shape; the vault is committed automatically on
      change, with nested repo trees excluded by rule and a recoverable history; a project with no remote is
      still recoverable from local history, and a single owner-level backup remote can be configured for all
      vaults at once (his *"one master backup"*); and the public/private boundary is explicit enough that
      asking "is this file publishable?" has an answer that does not depend on which folder someone happened
      to save it in. Phases 1 and 2 are ALREADY BUILT — the work is deciding the model, then wiring and
      reconciling them against the materialize `.git`, NOT writing a third mechanism.
      OPEN, owner's call, deliberately not decided here: whether the vault's canonical git is the materialize
      `.git` or Phase 2's `.project-backup/` (three repos over one tree is one too many); whether the master
      backup remote is per-project or one owner-level remote holding every vault; and whether a code repo
      lives inside the project folder as today (`<project>/code/`) or beside it with a declared link.
- [ ] **The live agent turn does not know the owner's timezone, so the agent narrates the HOST's clock as
      if it were the owner's** (owner-reported 2026-08-14: *"you need to figure out how to set my timezone
      properly"*). The zone IS captured — onboarding takes the browser's IANA zone from the `?tz=`
      WS-upgrade param (#306) and stores it on `instance_metadata.timezone`; the onboarding preamble even
      FORBIDS asking for it, on the grounds that it is already known. `reminders/tick.ts` then resolves it
      correctly for cron-cadence wall-clock work (#40) — so a daily 9am reminder does fire at the owner's
      9am. **The live turn is the one path that never reads it.** `gateway/wiring/build-live-agent-turn.ts`
      contains no reference to a timezone and nothing in the live-turn path touches `instance_metadata`.
      The host runs UTC, so every `Date.now()`, every shell `date`, and the injected current-date line are
      all UTC — and the agent, having nothing to convert with, repeats them as the owner's wall clock.
      OBSERVED: on 2026-08-14 the agent was told "today" was a date the owner had not reached yet, and
      narrated a whole evening's work in host time — *"since midnight"*, *"at 4am"* — for an owner whose
      clock read mid-evening the PREVIOUS day. Not an error message; a confident, wrong frame that also
      shifts every relative deadline the agent offers. Note the second-order cost: the agent is told to
      never ask for the timezone BECAUSE it is already known, so the one recovery it could improvise is
      also closed off.
      SECOND, SMALLER GAP, same root: the captured zone is supposed to be stamped into `USER.md` by
      persona-gen precisely so the agent has it without asking. On this instance it was NOT there and had
      to be written by hand — so whatever writes it either never ran for this owner or does not run for an
      owner who predates the feature. Acceptance: the live agent turn receives the owner's IANA zone AND
      the current time in it — not a bare date; a time or date stated to the owner is in the owner's zone
      unless explicitly labelled otherwise; the `USER.md` stamp is verified for EXISTING owners, not only
      new ones; and a test pins the case that actually bites, an owner whose local DATE differs from the
      host's at the moment of the turn.
- [ ] **A deploy request must resolve the ref against the REMOTE, not the host's frozen mirror**
      (observed 2026-08-14, first real use of the host-deploy tool). `host_deploy_request` is wired and
      `enabled: true`. Asked to deploy `origin/main` two minutes after a merge, it answered
      `status: "up_to_date", target_sha: 9617a9e4` — truthfully, and uselessly: it resolved `origin/main`
      inside the host checkout, and that checkout has **never fetched**. MEASURED: `.git/FETCH_HEAD` is
      absent, its `origin/main` equals its own `HEAD` (`9617a9e4`), and `git cat-file -e` on the freshly
      merged sha reports the object is unknown to it. So the ref the owner names and the ref the host
      resolves are different things whenever anything has landed since the last deploy — which is exactly
      when a deploy is wanted. THE FAILURE MODE IS THE DANGEROUS KIND: not an error, a confident
      "already up to date", so the owner reasonably concludes the merge is live when it is not. That is the
      same shape as the terminal-reason defect (#240) — a confidently-worded answer that stops the reader
      looking further. Acceptance: the request FETCHES (or resolves against the remote) before comparing;
      `up_to_date` is returned only when the target sha is genuinely reachable and deployed; and a stale or
      unfetchable ref is named as such rather than reported as parity. A test pins that an unknown-to-the-host
      sha can never produce `up_to_date`.
- [ ] **A deploy must not kill the builds in flight — trident is presently its own worst enemy**
      (owner-directed 2026-08-13, from the forensics on run `bb3c8c8e`). The inner workflow is not its own
      process: it runs detached inside a WARM `claude` REPL the gateway owns (`cc-trident-fire-<owner>-<repo>`,
      `open/wiring/substrates.ts`). Restarting the instance's service SIGTERMs that REPL and every workflow
      inside it, and the wedge watchdog then reports `pid-dead → "pooled child exited"` — the detector
      working, not
      the fault. Three of five recorded `trident_launcher_crashes` land 18–28 s after a vendor checkout
      (08-11 20:16:44→20:17:02, 08-12 19:37:55→19:38:13, 08-13 04:05:27→04:05:55). The 08-13 deploy rolled
      `282f10b6`, *trident's own merge*: **a build that lands kills the builds still running**, at exactly the
      rate the pipeline succeeds. Acceptance: a deploy either drains/defers while a run is in flight, or the
      workflow survives its launcher's restart — and either way the owner is TOLD which happened, never handed
      a bare "child crashed" for an event that was a deploy. (Two crashes — 08-10 23:30, 08-11 06:04 — have no
      checkout near them and are NOT explained by this; a fix must not be credited with closing them.)
      DISTINCT FROM the governance tracker's #514 (*a CRASHED trident run is never reaped*), which asks what
      the row does AFTER a child dies and is now served by the `onChildCrash` sink. This asks why the child
      dies at all, and answers: we killed it. Fixing one does not fix the other.
- [ ] **A retry must resume from the checkpoint, not merely from the PR.** A re-dispatch creates a NEW run
      row with `inner_checkpoint = null` and `ralph_round = 0`; only the fire-time `detectExistingPr` probe
      (`trident/orchestrator.ts` `launch`) recovers continuity, by setting `pr` and so making the inner
      workflow's `resuming` true. That is enough to preserve the *code* (Forge re-enters the branch, the
      planner is told to read the committed work) but the governed plan is regenerated from scratch and the
      review rounds restart — planning and review tokens are re-spent every crash. Acceptance: a retry carries
      the dead run's `inner_checkpoint` and `ralph_round` forward, or states plainly on the card that it will
      not. A resume that depends on a GitHub PR probe also silently degrades to zero in `local` merge-mode.
- [ ] **A preserved worktree must not be able to strand its branch.** Since #541 a crashed run's worktree is
      deliberately kept (it holds uncommitted work), which leaves the build branch checked out. Git refuses
      the same branch in two worktrees, so the retry's re-enter contract
      (`git switch <branch> || git switch -c <branch>`, `trident/inner-workflow.mjs`) has both arms fail on the
      literal path. Observed 2026-08-13: run `36b95167` did NOT deadlock — Forge worked inside the preserved
      worktree instead — but that recovery is an LLM improvising around a broken contract, not a guarantee,
      and it silently rejoins a worktree whose base may be stale. Acceptance: the re-enter path is
      DETERMINISTIC — the retry either adopts the preserved worktree by design or releases the branch first,
      and a test pins whichever is chosen.
- [ ] **"Is this build alive?" — NOT A NEW ITEM. Corroborating evidence for the governance tracker's open
      #534** (*"a long build phase reports NOTHING until it ends, so a working run is indistinguishable from a
      hung one"*, P1, already ESCALATED 2026-08-11 with three fix routes analysed and the
      `trident/checkpoint.sh`-on-a-timer heartbeat recommended). **#534 owns this; do not re-plan it here.**
      Recorded only because a second independent instance changes its priority, not its diagnosis.
      2026-08-13, run `36b95167`: `phase = forge-init`, `last_advanced_at = 04:10:08` — while the planner had
      finished, Forge had committed `4eb50c4` at 04:19:38, and an agent transcript was being written seconds
      earlier. The owner had to ask *"How can we tell if it's working? I want to minimize waste"* and the only
      truthful answer was off-board: the mtime of `<session>/subagents/workflows/<wf_id>/agent-*.jsonl`.
      Two things this instance adds to #534:
      (i) the FALSE-KILL half is now witnessed, not just predicted — `eca83d1f` was reaped at 90 minutes for
          "no progress" on exactly the `last_advanced_at` clock #534 identifies as stale by construction, and
          nothing establishes it was actually hung;
      (ii) the ORCHESTRATOR is fooled too, not only the client — on 2026-08-13 this agent reported a run as
          "going well" from transcript liveness while it was making no progress toward APPROVE. Movement is
          not health, and a heartbeat that proves only "an agent is writing" would reproduce that error in the
          product. Whatever #534 builds must distinguish ALIVE from PROGRESSING.
      Related but DELIBERATELY SEPARATE: the counter/surface-disagreement half (`codegen_status` reporting
      `forge-init` into a healthy run; the two nested round numbers) is its own backlog entry, landing via
      the `<ralph_round>.<round>` item. That is a DISPLAY defect over a signal we already have; this is a
      MISSING SIGNAL. They must not be collapsed into one job — fixing the display would make a run that
      reports nothing merely report nothing more precisely.
- [ ] **A build agent must never HOLD a credential — it asks the host to push** (owner-directed 2026-08-13,
      from observed behaviour, not theory). `github/credential.ts` argues at length against every way of
      giving git a token except an env-injected, `github.com`-scoped helper, because "a credential on disk
      with no expiry is the thing we spent the device-flow work avoiding". That credential is wired to the
      OUTER loop ONLY (`open/composer.ts` `run_host: makeLazyCredentialedHostRunner(githubProcessEnv(…))`).
      The INNER workflow gets nothing — verified live on the fire REPL: `/proc/<pid>/environ` contains no
      `GH_TOKEN` and no `GIT_CONFIG_*`. Yet in `pr` merge-mode Forge's contract ORDERS it to
      "push the branch to origin, then REUSE the existing PR" (`trident/inner-workflow.mjs` `forgePushStep`).
      **We command a push and withhold the key**, so on 2026-08-13 run `36b95167` did the only thing left:
      read `auth/secrets-store.ts` for the AES-GCM envelope shape, read `.neutron-aes-key` (mode 0600, SAME
      uid as the build), enumerated `secrets` — passing the owner's `gmail_compose` tokens and
      `openai:onboarding` key on the way — decrypted the github row, **wrote the plaintext to
      `/tmp/gh-token-tmp`**, then hand-rebuilt our own scoped helper and pushed. It reached our design by
      reading our source, having already broken the property the design protects. This is not agent
      misbehaviour; it is task completion under an impossible instruction, and it is non-deterministic —
      the push succeeds only if the model improvises well.
      Acceptance, in order of preference:
      (a) Forge does NOT push. It asks the HOST to push and receives an exit code; the credential never
          enters an agent-reachable process. This matches the outer loop and is the only shape where the
          token cannot be echoed, logged, committed, or written to disk by a language model.
      (b) If an agent-side push is kept, `githubProcessEnv(…)` is threaded PER FIRE into the workflow's agent
          env — never baked in at REPL spawn: the fire substrate is WARM and shared across runs, so a
          spawn-time token goes stale on reconnect and sits in `/proc/<pid>/environ` for every later run to
          inherit.
      (c) SEPARATELY, and regardless of (a)/(b): decide deliberately whether a build agent should be able to
          read `.neutron-aes-key` at all. Today every agent we run can decrypt every secret the instance
          holds — GitHub, Gmail, OpenAI, Codex — because it runs as the keyfile's owner. The push path is one
          symptom; the reachability is the condition. Acceptance: a build process cannot decrypt secrets it
          was not given, and a test proves it.
      UPDATE 2026-08-13 23:32, run `1daded20` — THIS ENTRY IS NOW THE ONLY THING BLOCKING BUILDS ON THIS
      INSTANCE. `trident/codex-build.sh` no longer improvises: its `push_credential_ok` probe ran
      `git credential fill`, got nothing, and exited 3 `CODEX_BUILD_NO_PUSH_CREDENTIAL` *before spending any
      tokens*. That is the intended replacement for the `/tmp/gh-token-tmp` behaviour above — the guard
      works. But nothing was built to take its place, so every `pr`-mode build on this host now defers.
      MEASURED: `credential.helper` is unset in the repo config, in `--global`, and in the Forge agent's
      environment; origin is an `https://github.com/…` remote, so a helper IS consulted and answers
      nothing. The credential is not missing from the PRODUCT — `githubProcessEnv` already returns the
      `github.com`-scoped, `$GH_TOKEN`-reading helper via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`, and the
      outer loop uses it to push. It is missing from the ONE process that now needs it: `codex-build.sh` is
      spawned by the Forge agent's `Bash` tool and inherits the agent's env, not the orchestrator's
      per-command env. So the answer is (a) or (b), and (b) has a hard constraint this run makes concrete:
      the token must NOT reach the model — the wrapper invocation is composed by Forge *as a command line in
      its transcript*, so anything threaded through that line is logged. Inject at the substrate/tool
      boundary or have the host push; never through the prompt.
- [ ] **A terminal `failure_reason` must name what actually happened — today it always says "exhausted 10
      rounds"** (owner-asked 2026-08-13: *"why does the failure reason keep saying the old 10 rounds
      exhausted thing?"*). `trident/orchestrator.ts` ~711 is a CATCH-ALL: every path that is not `APPROVE`
      and not the provenance reject falls into one branch that writes
      `` `inner loop exhausted ${run.max_rounds} round(s) without Argus APPROVE` ``. It interpolates
      `run.max_rounds` — the CONFIGURED CEILING, never the rounds actually run — and the comment above it
      states the false case as fact (*"the inner loop exhausted maxRounds"*). MEASURED on four runs
      (`03242fe5`, `000cedc8`, `1daded20`, plus `36b95167`): three terminated at `round: 1` with
      `checkpoint: "inner-error"` and ~10 minutes elapsed; all four reported "exhausted 10 round(s)". Three
      genuinely different causes — ten real review rounds, `CODEX_HOME` unresolved, brief corruption, and
      now a missing push credential — produced one identical sentence, and each time it sent a human to look
      at review quality when the build had never started. THE TRUTH IS ALREADY IN HAND at that line:
      `result.round` (1) and `result.checkpoint` (`inner-error`) are both in scope, and the wrapper's real
      reason is on disk at `/tmp/trident-codex-build-<runId>-r<N>.err`. Acceptance: a run that never reached
      a review round must NOT say it exhausted rounds; the reason names the phase that failed and the actual
      round count, and a test asserts an `inner-error` at round 1 produces neither the word "exhausted" nor
      the number `max_rounds`. NOTE the delivery layer (`trident/delivery.ts` ~177) already pattern-matches
      this exact string to soften it for chat — so fixing the reason without updating that matcher would
      silently change what the owner is told. Both move together.
      RESOLVED IN PART, 2026-08-14 (PR #240): the message no longer LIES. It now reports only
      what was measured — `inner workflow ended at round <N> of <M> at checkpoint '<C>'` — and
      asserts no cause at all. WHAT REMAINS IS THE MISSING SIGNAL, and it is the real item:
      **the inner workflow emits no TERMINAL CAUSE.** Two Codex review rounds killed two
      attempts to deduce one, and the second is the instructive failure: `checkpoint` records
      the PHASE reached, not why the loop stopped, and `argus-request-changes` is written for
      genuine exhaustion, a round-lost fix (`inner-workflow.mjs` ~3174), a fix that left no
      diff (~3197) AND an `infra-only` synthesis stop (~3134). Any specific message built on
      `(round, checkpoint)` is an inference, which is how this line came to be wrong for four
      different failures in one night. Acceptance for the REMAINDER: the inner workflow emits
      an explicit terminal cause on every terminal path; the orchestrator reports THAT; and
      `delivery.ts` regains a specific summary per cause. Until then the generic message is
      correct and MUST NOT be re-specialised.
      OWNER'S RULE (2026-08-13, verbatim): *"If it's a generic catchall make the error message generic."*
      This is the governing principle and it is broader than this line: **a message must not assert a cause
      it did not measure.** A branch that catches N causes says something true of all N, and the specific
      cause is added only where it is actually known. Prefer naming the real cause (`result.checkpoint`,
      `result.round`, the wrapper's `.err` file are all in scope here) — but where the code genuinely cannot
      tell, generic-and-true beats specific-and-wrong. A confidently-worded default is the failure mode: it
      reads as diagnosis, so nobody looks further.
      HOW IT GOT THIS WAY (checked, not assumed — `git log -L 711,713`): the line dates from the initial
      commit `63236c6`, when reaching it genuinely meant the rounds ran out; it was true when written. Every
      early-exit added since — `inner-error`, codex deferred, brief corrupt, no push credential — landed in
      it without anyone adding a terminal branch. Not randomness: drift, one plausible commit at a time. The
      test suite should therefore pin the SHAPE (a non-round-exhaustion exit must not claim exhaustion), so
      the next early-exit path cannot silently inherit the same wrong sentence.
- [ ] **The review loop must be able to STOP and re-plan — a fix round cannot repair a defect in the plan**
      (owner-directed 2026-08-13, from run `36b95167`, which burned ten rounds and ~2.5h to reach a verdict
      knowable at round 2). Three constraints compose into a trap, and no one of them is wrong alone:
      (i) the verdict enum is effectively binary — `APPROVE` / `REQUEST_CHANGES` / `COMMENT` with `COMMENT`
      normalised into `REQUEST_CHANGES` (`inner-workflow.mjs` `normalizeVerdict`), so a reviewer who
      diagnoses a DESIGN gap has one channel and that channel means "go fix the code";
      (ii) Forge is contractually a PURE EXECUTOR — "do NOT re-plan or redesign" — so the only agent that
      receives the findings is the one forbidden to act on what they mean;
      (iii) `plan:fable` is invoked ONCE, OUTSIDE the fix loop (`inner-workflow.mjs` ~2073 vs the `while` at
      ~2175), so the only agent permitted to re-plan never hears a single reviewer finding.
      The escape hatch already exists in exactly one flavour — the loop breaks on
      `synthesis.blockKind !== 'infra-only'` — proving the category is understood; it simply has no siblings.
      EVIDENCE (all nine review results of `36b95167`): three findings — the tautological "row/rail lockstep"
      test, the out-of-spec `inline_active` proxy, and the untouched research/dispatch path — recur in ALL
      NINE rounds, and the finding totals never converge (9, 8, 13, 9, 8, 12, 9, 10, 11). Note the planner
      AUTHORED the tautological test in its execution spec, so no number of fix rounds could ever remove it.
      TRIGGERS (a run must escalate when ANY fires):
      (a) REVIEWER-DECLARED — extend `blockKind` with `design-gap` (the plan is wrong) and
          `missing-dependency` (needs work outside this card), each REQUIRING a `whatIsMissing` field so it
          cannot be a bare complaint. Fast (can fire at round 1) but self-declared, so it must never be the
          only trigger — a self-declared exit is an escape hatch an agent can learn to pull.
      (b) REPEAT-FINDING — a finding that survives a fix round means fixing is not working. This is the HARD
          gate: it is arithmetic and requires no agent to be honest. Would have fired at ROUND 2 here, saving
          seven rounds. PREREQUISITE: findings need STABLE IDENTITY (a reviewer-emitted key such as
          `file:symbol:rule`, or a normalised fingerprint) — today they are free-text titles and "same
          finding" is not machine-decidable. That prerequisite is part of this item, not an assumption of it.
      (c) NO-PROGRESS — blocker+major count not strictly decreasing across two rounds (real data: 4, 2, 6, 4,
          2, 4, 4, 4, 5 → fires round 3). Needs no finding identity, which is its only virtue; noisy, because
          a round can legitimately fix three findings and surface two.
      ROUTING — escalation goes to the ORCHESTRATOR (the project chat), never to a dead end:
      • `design-gap` → ONE bounded re-plan per run, with the findings attached so the planner is no longer
        deaf. Unbounded re-planning reproduces this same waste one level up as a plan↔fix oscillation.
      • `missing-dependency` → the ORCHESTRATOR, which owns SEQUENCING: it reports in the project chat and
        REORDERS the Work Board so the dependency precedes the blocked card. This is the case `36b95167` was
        actually in, and it composes with the dependency-aware dispatch item — a card escalated this way must
        move to a visibly BLOCKED state, not sit in `upcoming` looking startable.
      • a repeat finding AFTER the bounded re-plan → the orchestrator. The re-plan gets exactly one chance to
        prove it changed something.
      GUARDRAIL: the RUN reports; the ORCHESTRATOR decides. A build must never mutate the board itself, or an
      autonomous run could reorder the owner's priorities with no judgement in between. Creating a card for a
      dependency that does not yet exist still follows the standing intake rule — spec first, then card;
      reordering cards that ALREADY exist is the sequencing call the orchestrator may make and must report.
      Escalating is cheap to make safe: branch and PR already survive a terminal failure, so stopping early
      loses nothing. Round 10 bought nothing over round 2 except cost.
      Acceptance: a run whose reviewers repeat a finding stops and escalates instead of iterating; the round
      cap becomes the backstop it was meant to be rather than the primary exit; and the owner can see, on the
      card, that a build stopped because it was blocked rather than because it failed.
- [ ] **A card's PULSE must be gated on a real heartbeat — BLOCKED ON #534, do not start before it lands**
      (owner-directed 2026-08-13). This is the deferred half of the Work Board row-state card, split out
      after run `36b95167` spent ten review rounds failing to build it. The other half — the durable failed
      colour and the ▶/↻ retry control — is keyed on `status='failed'`, which the terminal reconcile already
      writes (`work-board/store.ts`), needs no new signal, and ships separately.
      WHY IT CANNOT BE BUILT YET. A pulse is a claim that something is MOVING. The only durable facts on the
      surface are the run's `phase` and `last_advanced_at`, and both advance only ON HARVEST — so a run that
      dies WITHOUT a terminal transition (a deploy SIGTERMing the warm REPL, which is exactly how this card's
      own attempt `bb3c8c8e` died) leaves `phase = forge-init` forever and the card pulses forever. There is
      no fact to check. Every fix round of `36b95167` therefore invented a PROXY for liveness — `undefined`
      run progress read as "running" (`isLinkedRunning`, `rp === undefined || !terminal` — liveness inferred
      from the ABSENCE of data), then an out-of-spec `!inline_active` suppressor whose own commit comment
      concedes it creates "a permanent pulse+no-▶ state ... the same unrecoverable-card defect on a narrower
      path". Reviewers rejected each in turn and were right to. **A proxy for a missing signal is not a
      smaller version of the signal; it is a new defect wearing the fix's name.**
      PREREQUISITE: governance tracker **#534** (*"a long build phase reports NOTHING until it ends, so a
      working run is indistinguishable from a hung one"*, P1, escalated 2026-08-11) — the heartbeat. Its
      recommended route is a periodic write through `trident/checkpoint.sh`. Nothing here should re-design it.
      TWO CONSTRAINTS THIS ITEM PLACES ON #534's OUTPUT, from evidence #534 does not have:
      (i) it must distinguish ALIVE from PROGRESSING. On 2026-08-13 the orchestrator read agent-transcript
          mtimes, called run `36b95167` "going well", and it was at that moment alive and converging on
          nothing. A heartbeat proving only "an agent is writing" would ship that mistake into the product.
      (ii) the 90-minute hang reaper must be re-pointed onto the heartbeat clock rather than the harvest
          clock. It judges `last_advanced_at` today, which is why `eca83d1f` — this same card's FIRST
          attempt — was killed for "no progress" with nothing establishing it was hung.
      Acceptance: a run killed by an instance restart, with no terminal transition written, stops pulsing on
      the card within one heartbeat interval and offers ↻; and no code path derives liveness from the absence
      of data. Kill the heartbeat writer and the test must fail.
- [ ] **A build's progress is TWO counters, so the card must show both — `<ralph_round>.<round>`**
      (owner request, 2026-08-13). A trident run nests two loops and the board renders one of them, so a run
      can grind through twenty task iterations while the owner watches a number that never moves.
      `ralph_round` is the OUTER loop — which task of the governed plan is being built, each in a fresh
      context, bounded by `max_ralph_rounds` (`trident/orchestrator.ts` `refireNextRalphTask`).
      `round` is the INNER loop — the Argus review round for the task in hand, bumped on REQUEST_CHANGES →
      forge-fix and bounded by `max_rounds` (`trident/state-machine.ts`). Task 2 under its first review is
      therefore **2.1**, and it is the LEFT digit that tells the owner the build is advancing.
      Acceptance: a run that re-fires to its next task visibly changes the number on the card without the
      owner asking; and the three surfaces that answer "where is this run" — the card, `codegen_status`, and
      the run row — do not disagree. (The `phase` a ralph re-fire deliberately leaves untouched, so
      `codegen_status` can report `forge-init` half an hour into a healthy run, is part of the same defect:
      correct mechanically, false as a status.) Related, and deliberately NOT the same item: the
      `Work Board row state` card fixes the same class one layer up — a row must not claim a run it does not
      have — and the pulse half of it is the entry above, blocked on the heartbeat. THIS entry is a DISPLAY
      defect over a counter we already record honestly; that one is a MISSING SIGNAL. Collapsing them would
      only make a run that reports nothing report nothing more precisely.

### Email Core consolidation — absorb the standalone email system (owner-directed 2026-08-07)

Fold the separately-hosted email system into the Email Core so it runs on the
instance's own box instead of a third-party edge platform, and retire that
service. **The full design, with the corrections that changed it, is
`docs/plans/2026-08-06-email-core-consolidation-plan.md`; the owner's five
decisions are recorded in the governed Decisions Log (neutron-managed SPEC.md,
2026-08-06/07). These steps are the BUILD QUEUE for this repo** — the work is
entirely Open's (`cores/free/email/`), so it is queued here rather than only in
the governance tracker, which is also what makes it Ralph-buildable from a clone.

Shape: a selective port wrapped in a large deletion — roughly 1,700 of ~7,600
source+config lines survive; ~8,000+ go along with an entire hosted service, its
six secrets, three worker crons and 9 of 13 tables. Feasible because the source
system POLLS Gmail and mutates labels: no MX record, no SMTP receiver, so it is
host-agnostic. Classification runs on the substrate one-shot LLM
(`gateway/cores/mount-open-cores.ts:412-417`), NOT a separate provider key.

**The two capabilities that must survive** are the owner's twice-daily briefs and
escalated important-email notifications. Everything else must justify itself
against one of those or be deleted.

> **BOARD STATE for P2 / P2.5 / P3 / P4 — READ BEFORE RE-CARDING THEM.**
> These four are DEPRIORITISED, not unstarted and not shipped (owner-directed
> 2026-08-14: *"we will come back to them later"*). **Their Work Board cards already
> exist and their plan docs are already written** — do NOT create new cards, or the
> board grows a duplicate of every one of them.
>
> They currently read `done` on the board. **That is a fudge, not a fact**: the Work
> Board has no archive or remove lane, so `done` was the only way to clear them off
> the active list. Nothing in P2–P4 has shipped. To start one, flip its card back to
> `upcoming` (which clears the completion datestamp) — a single call, nothing lost,
> the linked plan doc still attached.
>
> The plan docs are PROJECT docs, not files in this repo — each card carries a
> `design_doc_ref` of the form `neutron-docs:plans/<slug>.md`, which resolves in the
> app's Documents tab. Do not look for them under this repo's `docs/plans/`; they
> are not there, and concluding "no plan doc exists" is how a duplicate gets written.
> That split is a KNOWN DEFECT, not a settled design — see the backlog entry on plan
> docs landing somewhere nothing version-controls or backs up. Until it is fixed,
> these four specs survive only as untracked files on one volume.
>
> | Step | Card | `design_doc_ref` slug |
> |---|---|---|
> | P2   | `01KZSAPQNRVA1QBTKB2048XZVP` | `p2-twice-daily-brief-delivered-as-email-digest-on-off-settin-48xzvp` |
> | P2.5 | `01KZSAQ0MXZN4AWG1VG99TZC8N` | `p2-5-classification-setup-by-inbox-survey-owner-interview-ze-9tzc8n` |
> | P3   | `01KZSAQ971TCM7EF7D9WS7CSJZ` | `p3-retire-the-dead-scheduled-digest-scribe-fan-out-rides-the-s7csjz` |
> | P4   | `01KZSAQG4SJXQBQ8JN9CA3STEX` | `p4-owner-cutover-decommission-the-standalone-service-manual-a3stex` |
>
> P1 and P1.5 read `done` because they ARE done — same word, two meanings, which is
> exactly why this note exists. A real archive lane would retire the ambiguity.
> P4 stays owner-gated and is never auto-dispatched, whatever its card says.

- [ ] **P1 — pipeline store + poller + classification + escalation.** The
      escalation half end to end. **THE PIPELINE IS OPT-IN PER MAILBOX** (owner
      decision, 2026-08-12): connecting a Google account and asking the agent to
      READ that mailbox are two different decisions, so absence of an enablement
      row means DISABLED and a grant taken out for Calendar or Drive never enrols
      its inbox. _Acceptance: an important message arriving in a CONNECTED AND
      ENABLED real mailbox produces an escalation in chat within a poll interval,
      and a connected-but-not-enabled mailbox produces nothing at all. Names the
      composition seam it wires; a bookkeeping assertion does NOT satisfy this._
- [ ] **P2 — the twice-daily brief, DELIVERED AS EMAIL, + the digest on/off
      setting.** **The brief is an EMAIL; chat and push carry escalations ONLY and a
      digest is never posted to chat.** The on/off is a user-facing PRODUCT SETTING
      (`instance_metadata.email_digest_enabled`), not a feature flag — do not strip
      it citing the no-flags rule. _Acceptance: two real briefs land in the owner's
      inbox on his own schedule in his own timezone (never hardcoded UTC — DST), and
      toggling the setting off stops them. **Plus the pre-cutover rehearsal: with
      label-mutation and archive HELD BACK, the poller runs against the real mailbox
      alongside the existing service and emails its brief, so the two can be compared
      side by side for days before any switch.** Reads do not conflict; only the
      writes collide, which is why a rehearsal is possible at all._
- [ ] **P2.5 — classification setup by inbox SURVEY + owner INTERVIEW.** The Core
      ships the mechanism and **ZERO rules**; installing it samples the real inbox,
      clusters what is there, then asks the owner about each class it found and
      writes the answers as per-owner instance data. Owner sender data in this tree
      is a defect, never config. _Acceptance: a fresh instance with a connected
      mailbox and no hand-authored rules reaches working classification through setup
      alone, and the proposed classes are DERIVED from the sampled inbox — a
      hardcoded taxonomy fails the test._
- [ ] **P3 — retire the Core's dead scheduled digest; the scribe fan-out rides the
      new poller.** The existing `triage-scheduler.ts` has never been deliverable
      (`pushDispatcher: null` hardcoded at
      `gateway/cores/mount-cores-scribe-fan-out.ts:302`; no `emailLlm` passed from
      `open/wiring/memory.ts:354-358`, so it falls to a throwing stub; delivery gated
      at `gateway/cores/email-managed-wiring.ts:149`). Its ONLY live output is the
      scribe email→memory fan-out + watermark, **which the poller must take over or
      ambient email→memory goes dark.** The on-demand `email_triage` tool is a
      different thing and stays. _Acceptance: the old scheduler is deleted AND
      email→memory extraction is still observably happening afterwards._
- [ ] **P4 — owner cutover.** Hard switch on the WRITES, no parallel mutation:
      both systems label the same mail. Old service's crons off → verified interval →
      service deleted. Its database is NOT imported — the mail all still lives in
      Gmail, so a clean start is correct. The return-to-inbox learning loop is KEPT
      (live and closed: `pipeline/poller.ts:82` reads patterns into the classifier).
      _Acceptance: the standalone service no longer exists and the owner has had no
      gap in briefs or escalations across the switch._

## Open Questions

When one is answered, move it to the Decisions Log (newest-first) and delete it
here.

- (none open — the refactor-window decision queue D-1…D-13 is resolved; see the
  refactor plan §15 and the Decisions Log.)

## Detail specs index

Mechanics docs that own an implementation area. Each owns mechanics and
references decisions by date; none is a second home for a decision.

| Spec | Owns |
|---|---|
| `docs/SYSTEM-OVERVIEW.md` | Living architecture truth — the boot path, module graph, substrate, memory, Cores mechanics |
| `docs/INVARIANTS.md` | The per-merge load-bearing invariant checklist |
| `docs/AS_BUILT.md` | Chronological build log (agent-appended provenance) |
| `docs/plans/2026-07-02-world-class-refactor-plan.md` | The world-class refactor unit backlog |
| `docs/plans/wave3-tabbed-interface-build-plan.md` | The P5 tabbed project interface build |
| `docs/plans/*` | Per-sprint mechanics briefs (referenced from Phases → Steps) |

## Decisions Log (immutable audit trail — NOT the build spec)

Newest-first: new entries go at the TOP. Format: `date — decision — [detail
pointer]`. Immutable — entries are never removed or rewritten; a superseded
decision stays with a "superseded" note. This log is the single home for the
dated record of each locked decision; the body describes the resulting
architecture and points here.

### 2026-07-30

- **The idle-nudge sweep ships ON, and "does not repeat" is the acceptance test — not a review opinion.**
  The re-engagement nudge (the "one thing at a time" ping when a topic goes quiet) was built, unit-tested,
  and then deliberately WITHHELD: the composer withheld `listIdleTopics`, so the cron never registered, and a
  test asserted the absence to pin the withholding. That was the right call at the time, because switching it
  on would have spammed the owner daily. Two defects made it unsafe, and both are now fixed. (1) **The
  activity watermark polluted itself.** The nudge posts through a sink that persists a durable row into
  `button_prompts` — the same table the watermark was read from as an unfiltered `MAX(created_at)` — so the
  sweep's own bubble advanced the watermark it had stored at the last nudge, the dedupe branch read that as
  "the user came back", and it re-armed on itself every idle cycle, forever. The watermark that gates a
  re-engagement decision must be movable ONLY by a human: `listTopicsByUser` now exposes
  `last_user_activity_at` (the `resolved_at` of turns a real person took, excluding the `__system__` speaker
  sentinel) ALONGSIDE the unchanged `last_created_at` that the sidebar orders by — two questions, two columns,
  because "most recent message" and "when did the owner last show up" are genuinely different questions.
  (2) **Enumeration saw one namespace.** The owner speaks under both `web:<owner>` and `app:<owner>`, so a
  single-root scan would nudge about work just handled on the other client; the store now unions N roots in
  one query. Open emits exactly ONE candidate, never a per-topic fan-out, because the ranker writes one
  `current_focus_pick` per instance per day.
  **The standard this sets:** a feature withheld for a spam risk is switched on only against a test that
  proves the risk is gone — here, several idle cycles after a nudge with no intervening USER activity
  producing exactly one nudge, mutation-tested in both directions (it fails if the watermark fix is reverted,
  AND real user activity still re-arms the nudge, so silence is not traded for spam). — [detail:
  `docs/SYSTEM-OVERVIEW.md` § Proactive messaging; `gateway/proactive/__tests__/idle-nudge-no-repeat.test.ts`]

### 2026-07-27

- **App diagnostics report to the OWNER'S OWN gateway, never a third party, and never carry a credential.**
  The Android app failed on the owner's device three times and nobody could see why: the only diagnosis
  channel was "plug in a USB cable and run logcat", so each round cost hours of static inference and two of
  three hypotheses were wrong. Neutron Open is self-hosted, so the fix cannot be Sentry or any SaaS — the app
  posts to its own instance at `POST /api/app/admin/diagnostics/reports` with the EXISTING app bearer.
  Three constraints are locked with it. (1) **No unauthenticated write endpoint.** Requiring the bearer is
  exactly why the app carries a PERSISTED QUEUE — a report from a failed launch is written to durable storage
  and delivered on the next authenticated launch — rather than an anonymous POST, which would be an open
  log-injection sink on the owner's gateway. (2) **No credential in a payload, enforced by a test that fails
  if one can get through.** ISSUES #395 leaked the bearer as a display name into a screenshot; a diagnostics
  pipeline that wrote that same token to a file on the host would be a worse version of that bug. Redaction
  runs on the device AND independently again on arrival, so the host is protected from a client that is old,
  modified, or buggy. (3) **No feature flag** — it ships on, as the product, one code path.
  A fourth rule follows from (1): because the persisted queue deliberately outlives the session, **a queued
  report is bound to the gateway it was captured against and is delivered only there**. Otherwise changing
  servers would hand one instance's diagnostics to another — the self-hosting boundary has to hold for
  diagnostics exactly as it does for everything else.
  **Honest limit, documented in the product and the docs:** this catches JAVASCRIPT errors only. A native
  crash (the actual 2026-07-27 blocker: an Android provider dying at process start, before any JS ran) is NOT
  captured and still needs logcat or an emulator. — [detail: `docs/SYSTEM-OVERVIEW.md` § App remote
  diagnostics; `docs/AS_BUILT.md` 2026-07-27]

### 2026-07-18

- **A test NEVER `mock.module`s a module the rest of the repo depends on — it INJECTS.** Bun's `mock.module` is
  global to the test process and is NOT undone by `mock.restore()`. Three `app/` tests stubbed the react hook
  dispatcher with `mock.module('react', ...)`; once any of them ran, every later test rendering through
  `react-dom` got the stub (`ReactSharedInternals.S` undefined, thrown inside react-dom-client) — ~92 failures
  at `main` b1007876, and a suite whose pass/fail depended on file execution ORDER, which is how a genuine
  regression hides. The remedy is ordinary DI, never a wider mock, a preload shim, or a split test command
  (those hide the coupling): `app/lib/hook-runtime.ts` exports `HookRuntime` + the real `reactHooks`, and each
  unit takes it as an optional trailing argument (a prop for `DiagnosticsPane`) defaulting to real React, so
  the substitution is scoped to one call. Production callers are unchanged. No test was skipped, weakened or
  deleted. The narrow exception this LOCKS: module-mocking is still allowed for a module bun genuinely cannot
  load (`react-native` is Flow-typed and unparseable), because there is no working implementation for the stub
  to displace. [`app/lib/hook-runtime.ts`, `app/features/docs/*`, `app/features/admin/DiagnosticsPane.tsx`,
  `docs/AS_BUILT.md`]

- **The onboarding step guard is AUDIT-DRIVEN: every required field is askable, by construction.** Fixed a live
  P0 deadlock on a fresh install — onboarding hung after the personality step and could never finalize
  (`phase='work_interview_gap_fill'`, `completed_at=NULL`, `persona_files_committed=0`, with name + a settled
  import + 6 `primary_projects` + `agent_personality='Yoda'`, but no `non_work_interests` because the import
  analysed to `topics:[]`). `auditRequiredFields` correctly refused to finalize on `non_work_interests`, but
  `buildOnboardingStepGuardFragment` inspected only the two HARDCODED button fields (`import_decision`,
  `agent_personality`); with both settled it returned `null`, so the agent got no forcing instruction, believed
  onboarding was over, and went silent. The general defect — LOCKED as fixed here — is that the guard's coverage
  set was a hardcoded SUBSET of the audit's required set, making any field outside it an UNASKABLE BLOCKER (a
  6th required field would have silently reintroduced the hang). The guard now derives its work from
  `auditRequiredFields(...).missing` and renders one block per missing field from `STEP_GUARD_COPY`, typed
  `Record<RequiredField, StepGuardCopy>`, returning `null` exactly when finalize would fire. Two presentation
  categories: BUTTON-DRIVEN steps keep their existing `[[OPTIONS]]` hard-requirement and locked option lists
  verbatim (no regression of the 06-30 / 07-18 fixes); FREE-TEXT steps (`user_first_name`, `primary_projects`,
  `non_work_interests`) force the ask in plain prose and EXPLICITLY forbid an `[[OPTIONS]]` block.
  Conditionality preserved (`import_decision` only when `import_offered`), and the two project-discovery fields
  are DEFERRED while a history import is in flight — forcing them mid-import would contradict
  `buildImportInFlightSteerFragment` (joined into the same prompt) and solicit answers the extractor drops;
  import-INDEPENDENT steps stay forced and the deferred ones resume once the import lands. Anti-recurrence is STRUCTURAL: a new
  `RequiredField` without copy fails TYPE-CHECK (verified TS2741), plus a runtime exhaustiveness test over the
  exported `REQUIRED_FIELDS_IN_PRIORITY_ORDER`. Also corrected the docblocks claiming finalize "triggers once
  personality is settled" — false, and it masked this bug (`non_work_interests` is priority 4, personality 5).
  No feature flags, one code path.
  [`onboarding/interview/onboarding-preamble.ts`, `onboarding/interview/required-fields-audit.ts`,
  `onboarding/interview/__tests__/onboarding-preamble.test.ts`,
  `tests/integration/onboarding-interests-deadlock.open.test.ts`, `docs/SYSTEM-OVERVIEW.md`, `docs/AS_BUILT.md`]

- **A one-shot emit is gated on DURABLE state, never on per-process memory.** Fixed a live fresh-install bug:
  the onboarding welcome opener was emitted TWICE into the owner's General topic. The seed was guarded by an
  in-memory per-process `Set` (`seededOnboardingTopics`) while the opener it guards is persisted to
  `button_prompts` BEFORE it is sent — a guard whose lifetime is shorter than the effect it guards, so every
  restart re-emitted on top of the durable copy. The rule this locks in, beyond the one call site: if an effect
  is durable, its guard must read the SAME durable state. `on_session_open` now asks
  `buttonStore.latestTurnByTopic` ("does this topic already have a turn?" — the identical check
  `ensureProjectOpeningOnEntry` already used for per-project openings), and in-memory state is demoted to a
  pure single-flight latch for connects that race before the first row exists. Because a failed seed persists
  nothing, that one check is BOTH the de-dupe and the failure self-heal, so the compensating
  `delete(...)` bookkeeping was deleted rather than reworked. No flag, no dual path. The live-path test
  asserts EMITTED openers across a real process restart, not guard bookkeeping — a bookkeeping test passes
  against this bug. [`open/wiring/app-ws.ts`,
  `tests/integration/onboarding-welcome-seed-once.open.test.ts`, `docs/SYSTEM-OVERVIEW.md`, `docs/AS_BUILT.md`]

- **Onboarding's history-import decision is a DETERMINISTIC per-turn step, captured durably — the guard is the
  gate, not the phase machine.** Fixed a live fresh-install bug: the owner replied with nothing but their first
  name and the assistant announced "we'll skip the import for now", narrating a decision the owner never made
  (`phase_state` held only `user_first_name` + `signup_via`). The import offer existed ONLY as prose in
  `buildOnboardingPreamble` with ZERO capture, so the step was LLM whim. Resolved by EXTENDING the existing
  deterministic per-turn mechanism rather than adding a gate: `import_decision` becomes a tracked required
  field (`required-fields-audit.ts`, priority slot directly after `user_first_name`, CONDITIONAL on
  `import_offered` so a box with no import substrate is never blocked, and auto-settled by an import that
  actually ran), `buildOnboardingStepGuardFragment` is generalized past its single `agent_personality` check to
  also force the `[[OPTIONS]]` ask, and the SAME turn-start `captureButtonBackedRequiredField` settles the
  answer from a tap OR free text (`chatgpt|claude|neither`; ambiguity captures nothing so the guard re-asks).
  This is the same mechanism built 2026-06-30 for the identical prose-only failure on the personality step. No
  feature flags, no dual paths, no second gate; the orphaned phase-machine code (`engine.advance` /
  `ai_substrate_offered` / `LEGAL_TRANSITIONS`) is deliberately left in place — its removal is a SEPARATE step
  gated on this being proven live. Tests exercise the real composer + graph + app-WS + ButtonStore seam (only
  the substrate is faked), because this bug class recurred while tests mocked past it.
  [`onboarding/interview/required-fields-audit.ts`, `onboarding/interview/onboarding-preamble.ts`,
  `onboarding/interview/button-backed-answer.ts`, `onboarding/interview/post-turn-extractor.ts`,
  `open/composer.ts`, `tests/integration/onboarding-import-step-guard.open.test.ts`, `docs/AS_BUILT.md`]

### 2026-07-17

- **Trident Ralph re-fire — multi-task builds now build EVERY task before merge (#362).** Fixed a real bug:
  Trident v2 Ralph mode built only `plan.topTask` then merged (`plan.remainingTasks` was logged-only; the
  outer harvest merged on inner APPROVE with no remaining check), so a multi-task `IMPLEMENTATION_PLAN.md`
  build shipped incomplete after task 1. The plan→task→repeat cycle is restored as REAL exec-model behavior:
  the inner workflow emits `remainingTasks` in its typed terminal result and, when `>0`, builds the one task
  and SKIPS review; the OUTER loop (`orchestrator.applyResult` → `refireNextRalphTask`) re-fires a FRESH
  inner iteration per remaining task (one task / fresh context — reuse branch/PR + the `'ralph-task-built'`
  resume checkpoint, bump `ralph_round`, cap at `max_ralph_rounds`) and only reviews→merges at `remaining==0`.
  No feature flags. The now-superseded `state-machine.ts` Ralph cycle (`computeTransition`) is KEPT — it stays
  the `stubAdvanceDeps` restart-safe fallback + the executable the legacy harness `/trident` parity anchor
  (`legacy-fixes.test.ts`) + one-commit revert point; stale "this drives the loop" comments were corrected to
  point at the orchestrator. FLAGGED for the trident-architecture review (a human + Argus may prefer deleting
  the retained cycle). Real multi-task E2E added (inner-workflow body + orchestrator/store/tick).
  [`trident/inner-workflow.mjs`, `trident/inner-loop.ts`, `trident/orchestrator.ts`,
  `gateway/composition/build-core-modules.ts`, `docs/AS_BUILT.md`]
- **UPDATE (2026-07-17) — Owner-timezone (ISSUES #40) WRITE path LANDED in #392.** Supersedes the "not yet
  in this tree / in flight on its own branch" status of the earlier 2026-07-17 entry below. The WRITE path
  is now in the tree: the web + Expo clients capture their own IANA zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone` — web once at boot, mobile per connect) and report it
  as `tz=` on the `/ws/app/chat` upgrade query string; the gateway boundary-checks it (`sanitizeTimezone`) and, once per WS
  `open` in `on_client_timezone`, AUTHORIZES by owner identity (`user_id === OWNER_USER_ID` — a non-owner
  guest on the shared instance slug is ignored, logged server-side with no client-visible error) before
  idempotently persisting a valid, changed zone via `persistOwnerTimezoneIfChanged` → `writeOwnerTimezone`,
  the row keyed on the auth-resolved instance `project_slug` (the persistence key, not the authorization
  principal). Its one consumer today is the idle-nudge engine, which now keys the daily nudge pick's
  day-boundary on the owner's real zone (the proactive brief + reminder schedulers still use the host-local
  zone). [`open/wiring/app-ws.ts`,
  `channels/adapters/app-ws/envelope.ts`, `gateway/storage/owner-metadata.ts`, `landing/chat-react/config.ts`,
  `app/lib/chat-core/ws-url.ts`]
- **Owner-timezone (ISSUES #40) — capture approach LOCKED: browser/OS IANA zone → `writeOwnerTimezone`.**
  The owner's timezone is captured from the client's own IANA zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`) rather than inferred server-side, then persisted
  through `writeOwnerTimezone`. This entry records the DECIDED approach; the read wiring landed in #378,
  and the WRITE path (client detection + `tz` on the connect query string + gateway persist) lands
  SEPARATELY — it is **not yet in this tree** (in flight on its own branch). Once it merges, scheduling/nudge
  timestamps resolve against the owner's real zone; until then the server keeps its default.
- **Post-window doc-drift closeout (audit P2 #7/#8 + NITS).** Reconciled the lagging bookkeeping to
  git ground truth: the refactor plan §17 checklist now ticks every merged tail unit with its PR#
  (#311–#390) and the `refactor-orchestration-STATUS.md` resume anchor is marked CLOSED; SPEC §2.2
  Layering was completed (added `open/`, `trident/`, `contracts/`, and the other load-bearing
  workspaces the list omitted); and stale current-state doc pointers were repointed to their real
  successors (`build-llm-router.ts`/`llm-router.ts` → `onboarding/interview/post-turn-extractor.ts`;
  deleted `wow-push-emitter.ts` and `acceptChoice` invariants retired; the `§2.6`/`§3.4`/
  `§Fable-orchestrator` dangling section citations in live source fixed or dropped — dated
  AS_BUILT/audit-snapshot provenance left as-is). Docs-only; no behavior change.
  [`docs/plans/2026-07-02-world-class-refactor-plan.md` §17, `SPEC.md` §2.2, `docs/INVARIANTS.md`,
  `docs/SYSTEM-OVERVIEW.md`]

### 2026-07-16

- **World-class refactor window CLOSED + post-completion audit.** All executed
  units merged through K10. A fresh-eyes audit certified the tree production-solid
  (renames preserved every frozen wire/SQL boundary; perfect-recall lane dark by
  default; cross-unit concurrency composes; security shipped as specified) and
  surfaced a punch-list, now closed: fail-closed owner-bearer gate on the
  wide-bind upload surfaces (#377), owner-timezone read wiring (#378, ISSUES #40 —
  the WRITE path is a filed follow-up), the `core-sdk` one-release shim
  repointed+deleted (#388), and a discriminating sender-propagate regression test
  (#387). Deferrals now tracked as GitHub issues (owner-timezone write, RA2
  serve-probe, F8/P6 interleaving tests, O5 emitter-scoping, F6 rail-fan, Core
  scheduler swallow, W3 transcript unification, dead-code cleanup). MG-3 = KEEP,
  N3-credential = DEFERRED (both below). [audit + #377/#378/#387/#388, issues #379–#389]
- **K10 — public in-repo SPEC.md introduced; the last trident-executed unit.**
  This file lands as the governed root spec — the last trident-executed unit of
  the refactor window (introducing it flips trident's default resolver back to
  `detectRalphMode`, so a trident build against this checkout governs and no
  trident-dispatched unit may follow; other window units remain open and land by
  other means or defer). It un-bans a root `SPEC.md` from the leak-gate
  forbidden-path rule (the RT1 tripwire that guarded against an ACCIDENTAL
  mid-window SPEC.md is retired for SPEC.md only;
  STATUS.md/ISSUES.md/CLAUDE.md/AGENTS.md stay banned). The refactor-window
  `resolveRalph = false` dispatch override is lifted, so the default resolver is
  `detectRalphMode` again — a build whose workspace is a checkout of this tree
  runs the Ralph plan↔task loop. (Normal user-project `/code` builds resolve a
  fresh `Projects/<slug>/code` workspace with no `SPEC.md`, so they stay
  ungoverned — this file does not make every production `/code` governed.) The
  prompt/comment citations of `SPEC.md § Phases → Steps` across the tree now
  resolve to this file.
  [`docs/research/refactor-audit-2026-07-02/spec-shape.md`, `scripts/ci/leak-gate.sh`, `trident/board-dispatch.ts`]

### 2026-07-02

- **World-class refactor window — locked ground rules (Ryan).** A dedicated
  window: no product-functionality changes, module boundaries become real
  package boundaries, nothing frozen except the composer-module seam. Trident
  keeps the Workflow inner loop (the rearchitecture "Option A" is REJECTED and
  never re-proposed). The decision queue D-1…D-13 is resolved in the plan §15.
  [`docs/plans/2026-07-02-world-class-refactor-plan.md`]
- **D-4 — the public master spec is an in-repo `SPEC.md`,** authored fresh in
  the owner/instance vocabulary (conventions ported from the private engineering
  spec, content not). Delivered by unit K10. [this file]

### Earlier (pre-window locks)

These locked decisions predate the refactor window; the Architecture section is
their present-tense home — named here with a section pointer, not restated:

- GBrain is the sole durable memory store — §2.4.
- Spawn-and-stdio, one reply per turn — §2.3.
- A Core is the one unit of distribution — §2.5.
- Open ships zero hosted addresses (env-configured, no default) — §2.8.
- `ChannelRouter` is the channel extension seam (OSS-split; MG-3 resolved KEEP) — §2.6.
