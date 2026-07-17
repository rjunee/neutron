---
title: "SPEC.md — Neutron Open (master spec)"
last_updated: 2026-07-16 (world-class refactor window CLOSED — all tail units merged through K10; post-audit punch-list closed; deferrals tracked as GitHub issues)
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
  paste-token client), `connect/` (share projects across instances).
- **Substrate / runtime** — `gateway/` (the composition root: opens the DB, runs
  migrations, wires the module graph, binds HTTP/WS), `runtime/` (the
  `Substrate`/`Event` contract, the Claude Code adapter, the credential pool),
  `persistence/` + `migrations/`, `cron/`, `reminders/`, `tasks/`, `tools/`,
  `mcp/`, `watchdog/`.
- **Memory** — `gbrain-memory/` (the sole durable memory store), `scribe/`
  (extraction as a side effect of talking), `runtime/entity-writer` (the privacy
  gate every write passes through).
- **Cores** — `cores/{sdk,runtime}` + `cores/free/*` (the free-tier
  Cores).
- **Product surfaces** — `onboarding/`, `app/` (Expo), `landing/`, `prompts/`.

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

The few non-merged items are deliberate, not gaps: **MG-3** (the
`NEUTRON_GRAPH_COMPOSER_MODULE` composer seam) is KEPT by decision (the OSS-split
boundary — see the Decisions Log); **N3-credential** (frozen-handle threading at
the Managed boot seam) is DEFERRED — it cannot fire without live hosted owners
that rename; **W3** (transcript unification, XL) is DEFERRED as scoped feature
work. These plus the known engineering follow-ups now live as tracked GitHub
issues, not private memory.

### Post-window feature backlog

Each carries an acceptance criterion; all in `neutron-open`.

- [ ] Wire `ProjectBackupScheduler` (dormant loop today) — a scheduled per-project backup fires on its interval. (D-7)
- [ ] Wire the comments `AgentWatcher` (dormant loop today) — a new comment wakes the agent. (D-7)
- [ ] Resolve HITL `prompt-user` enforcement — review with refactor-window log data before locking the policy. (D-9)
- [ ] Per-project context for agent tools — X6 follow-ons (scope tool state to the active project everywhere).

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
