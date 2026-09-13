---
title: "SPEC.md — Neutron Open (master spec)"
last_updated: 2026-09-13 (a gateway restart reconciles project REPLs per substrate, not per registry file — the narrowing and why enumeration would be worse, Decisions Log 2026-09-13; previous: 2026-09-12 (a gateway restart keeps its project REPLs — the shutdown kill is gated on the pane being re-findable, Decisions Log 2026-09-12; previous: 2026-09-12 (the Fable arbiter is wired with its cost capped at one arbitration per rebase, and the REPL substrate becomes selectable — herdr is the default container, the in-process PTY host is retained — Decisions Log 2026-09-12; previous: 2026-09-12 (recurring cross-model work is one-shot headless per call))))
---
<!-- CURRENT: harness-orchestrator-pivot/herdr-host (cutover gated on: trident works on the new shape · herdr is the DEFAULT REPL container, with the in-process PTY host retained as a selectable backend and no chooser yet — Decisions Log 2026-09-12 · migration re-run) -->

# SPEC.md — Neutron Open

**Governance preamble.** This file is the present-tense CURRENT TARGET for
neutron-open — what the product IS and is being built toward. It carries no
abandoned branches and no "we used to do X" narrative: when a decision changes
the plan, the body is edited in place to reflect the new plan and a dated entry
is added to the TOP of the Decisions Log (newest-first). The Decisions Log is
the single home for the DATED RECORD of each locked decision (when + why); the
body (System Overview · Architecture · Open Questions)
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
code. **Ownership is split, and the split is the rule:** the owner owns the
Decisions Log and the architecture body — agents never rewrite those. Agents
MAINTAIN the work queue at `docs/spec-items/` (add, correct, reprioritise, close),
which is why it is no longer inside this file (Decisions Log 2026-09-12). An
owner-directed change to the body, like that split, is recorded in the log by the
agent that made it.

## Canonical doc set

| Concern | Doc |
|---|---|
| Decisions + architecture + roadmap (this file) | `/SPEC.md` |
| Current build queue (agent-regenerated on demand, disposable; may be absent when idle) | `/IMPLEMENTATION_PLAN.md` |
| **The work queue — one file per specified, buildable item** | **`docs/spec-items/`** (index: `docs/spec-items/README.md`) |
| How work is captured, specified, built and recorded | `docs/process/work-tracking.md` (the binding standard) |
| Chronological build log (frozen 2026-09-12; one file per change after it) | `docs/AS_BUILT.md`, then `docs/as-built/` |
| How it works NOW (living architecture detail, under this spec) | `docs/SYSTEM-OVERVIEW.md` |
| Load-bearing invariants (per-merge checklist) | `docs/INVARIANTS.md` |
| Public-facing positioning + self-host quickstart | `README.md` |
| Bugs / defects / backlog | GitHub Issues on the public repo |

A root `ISSUES.md` is intentionally absent — the purity gate reserves that path
(see the Decisions Log). Open's defect tracker is GitHub Issues — the inbox for
unspecified thoughts; the *planned* backlog is `docs/spec-items/`, and there is
exactly one such queue (`docs/process/work-tracking.md` §3.4).

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

A warm REPL runs in a **herdr pane** (Decisions Log 2026-09-12, "the REPL
substrate becomes selectable"), which makes it a child of the herdr server
rather than of the gateway: a **gateway** restart leaves it running and the next
gateway re-adopts it with its conversation intact **when that gateway constructs
the substrate it belongs to** (Decisions Log 2026-09-13), while a **herdr
server** restart does end it and recovery there is `--resume` onto the transcript
(Decisions Log 2026-09-12, "a gateway restart keeps its project REPLs"). A
surviving REPL is only ever left alive when a persisted registry row names its
pane and its child generation; anything that cannot be found again is still
killed at shutdown, and so is a spawn still settling when the shutdown reaches
the pool, whatever row it goes on to write (#674). Until its substrate is constructed, such a pane is neither
reconciled nor reaped by anything — the supervision tick skips a key it has no
options for (`unregistered-skip`) rather than actuating it under another
substrate's identity.

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

## Phases → Steps — SPLIT OUT 2026-09-12

**This section is gone. The queue it held now lives in
[`docs/spec-items/`](docs/spec-items/), one file per work item, indexed at
[`docs/spec-items/README.md`](docs/spec-items/README.md).**

It was 817 lines — 63% of this file — and it was doing two jobs badly at once: an
architecture record of what shipped, and a task queue of what had not. Those have
different lifetimes and different readers, which is the failure the Neutron
work-tracking standard exists to stop (`docs/process/work-tracking.md` §1, "one
owner per fact"; the split is its §5 step 1).

**Where its contents went:**

| What it held | Where it lives now |
|---|---|
| The open backlog (31 `[ ]` entries) | `docs/spec-items/` — 22 items, one file each |
| Ten entries that had already shipped but still read `[ ]` | deleted here; they are in git history and `docs/as-built/` |
| The onboarding phase set | `contracts/onboarding-phase.ts` is canonical; `onboarding/interview/phase.ts` holds the legal-transition table |
| The completed P5/P6/P7 surfaces and the Tier-1 Core inventory | `docs/SYSTEM-OVERVIEW.md` and `docs/as-built/` |
| The world-class refactor window ledger | `docs/plans/2026-07-02-world-class-refactor-plan.md` |

**The ten stale checkboxes are the reason this could not just be moved.** Each was
verified against the tree before removal, and every one was already built —
including one that carried "✅ RESOLVED" text *inside its own unchecked box*. A
queue that reports shipped work as outstanding is not a queue; four of the
surviving items also carried claims that the code had since falsified, and those
corrections ride at the top of the items they belong to.

Nothing in the codebase cites `SPEC.md § Phases → Steps` — checked at the split
with `rg "Phases → Steps"` across the tree; the only hits are this file and
historical records. The phase vocabulary it described is therefore not reproduced
here: the code is its own canonical source, per the table above.

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
| [`docs/plans/harness-orchestrator-pivot-2026-09-11.md`](docs/plans/harness-orchestrator-pivot-2026-09-11.md) | **The harness-orchestrator pivot** — the cutover definition, the eight locked design points, why trident never merged autonomously (measured), the dependency-ordered steps, and the owner-interview record. Decision home: Decisions Log 2026-09-11. |
| `docs/SYSTEM-OVERVIEW.md` | Living architecture truth — the boot path, module graph, substrate, memory, Cores mechanics |
| `docs/INVARIANTS.md` | The per-merge load-bearing invariant checklist |
| `docs/AS_BUILT.md` | Chronological build log (agent-appended provenance) |
| `docs/plans/2026-07-02-world-class-refactor-plan.md` | The world-class refactor unit backlog |
| `docs/plans/wave3-tabbed-interface-build-plan.md` | The P5 tabbed project interface build |
| `docs/plans/*` | Per-sprint mechanics briefs (referenced from `docs/spec-items/`) |

## Decisions Log (immutable audit trail — NOT the build spec)

Newest-first: new entries go at the TOP. Format: `date — decision — [detail
pointer]`. Immutable — entries are never removed or rewritten; a superseded
decision stays with a "superseded" note. This log is the single home for the
dated record of each locked decision; the body describes the resulting
architecture and points here.

### 2026-09-13 — "EVERY PROJECT REPL" IS RECONCILED PER SUBSTRATE, NOT PER REGISTRY FILE, and the narrowing is a correctness requirement rather than a shortcut. A boot pass reconciles the row for the pool key whose substrate has been constructed, with that substrate's options. **Narrows the 2026-09-12 entry below** — which says "a boot pass reconciles that row" without saying WHICH rows get one — and does not supersede it: everything that entry claims about a reconciled row still holds. Spec item: [`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md`](docs/spec-items/a-gateway-restart-keeps-the-project-repls.md). GitHub issue #539.

- **Why enumeration would be the worse defect.** One registry file holds a row per pool key, and a pool key folds the substrate instance, the user, the PROJECT and the credential identity. A pass runs with the options of the substrate that started it, so rebuilding another row's session from those options would put a REPL in the pool scoped to the wrong project — every tool call attributed there, and its child authorised on a credential belonging to another key. Reconciling a row under the wrong identity is worse than reconciling it later, and it is worse in exactly the direction this feature exists to protect.
- **The criterion, restated so it stays checkable.** *Every project REPL whose substrate this gateway constructs is reconciled before that substrate's first turn, and no row is ever reconciled under another row's options.* The owner's verbatim criterion — *"a gateway restart brings every project REPL back with its conversation intact"* — is what the item answers and is unchanged; this is the form a test can be held to.
- **What happens to a row nothing constructs.** Its pane keeps running, its row stays, and the next construction of that substrate reconciles it. The pane is labelled and visible in herdr rather than reparented and invisible, and the row that names it is durable — but **nothing reconciles it and nothing reaps it in the meantime**: the supervision tick answers `unregistered-skip` for a key it holds no options for, which is the same condition as a substrate this process never constructed. It is a gap, not a covered case, and the spec item names it as one.
- **The boundary is enforced, not described.** It had been asserted only in a source comment. A pass now provably inspects one pane, attaches one pane, authorises one session id and leaves every other row byte-intact, with the fixture ordered so that a pass reconciling "whichever row it finds" fails rather than passes.

### 2026-09-12 — A GATEWAY RESTART KEEPS ITS PROJECT REPLS. The shutdown kill that has terminated the whole warm pool since ISSUES #217 is now GATED: a herdr-hosted child is left running ONLY when a persisted registry row names its exact pane and its exact generation, and the next construction of that substrate re-adopts it or closes it (a boot reconciles the keys whose substrates it constructs, not every row in the file). The converse does not hold and the entry does not claim it: a spawn still settling when shutdown reaches the pool is killed when it resolves, whatever row it went on to write (#674) — the conservative direction, costing one `--resume`. **Narrows, and does not supersede, the ISSUES #217 rule recorded against the 2026-06-11 orphan incident**, which stays in force for every other child. Spec item: [`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md`](docs/spec-items/a-gateway-restart-keeps-the-project-repls.md). GitHub issue #539 (herdr step 2c).

- **What changes for the product.** The owner's acceptance criterion is *a gateway restart brings every project REPL back with its conversation intact*, and before this a restart killed them all; continuity was a fresh `claude --resume` on the next turn. It now keeps the SAME process: its conversation stays in memory, its dev-channel keeps serving, and the owner's `herdr session attach` view of it is uninterrupted. A killed-and-resumed REPL and a surviving one look identical from the outside and differ in everything that matters.
- **Which process restarted is part of the claim, always.** A REPL is a pane of the herdr SERVER. A GATEWAY restart does not end it — that is what this recovers. A HERDR restart DOES, because panes are its children, and nothing here changes that; what survives one of those is the transcript, through the pre-existing `--resume`.
- **The kill is narrowed rather than removed, because the incident it prevents is real.** 632 reparented processes and ~19 GB on 2026-06-11 is why it exists, and a herdr pane is in neither the gateway's process tree nor its cgroup — so `KillMode=control-group` never covered these children and the polite kill was the only thing ending them. What replaces it is a chain that can be checked: a child may survive only if a durable row names it; the next CONSTRUCTION OF THAT SUBSTRATE visits the row and adopts or closes; of the rows a construction reaches there is no branch that leaves a verified pane running. **Two residuals, named rather than hidden, because they have different causes and different remedies.** (1) A row whose substrate this process never constructs is visited by nothing — a boot reconciles the keys it constructs, not every row in the file — so its pane keeps running and its row stays until the next construction of that substrate reaches it. (2) A registry lost between shutdown and boot strands one pane per session key, visible and labelled in herdr rather than invisible, and nothing reaps it automatically.
- **Adoption is a claim about a live process, so it is never derived from the row.** Three probes, two authorities, each able to say no: herdr reports a live pane; that pane's foreground argv is a `claude` on the row's session id AND carrying the row's own dev-channel; and the dev-channel at the recorded port answers `/health` with that session id. `child_generation` comes back from the row (the child's sink credential is `HMAC(root, generation)`, so a survivor is refused 401 without it) while the incarnation is minted fresh, so a pre-restart straggler cannot complete a post-restart turn.
- **herdr's own agent resume is OFF (`[session] resume_agents_on_restore = false`), and the config is not the mechanism.** herdr's restore re-execs `claude --resume <id>` with none of our flags, so a pane it resumed could never answer a turn — and it would be a second owner of a live transcript. The setting makes that rare; what makes it SAFE is a verdict: a `claude` on our transcript that is not our child is CLOSED before anything resumes it. A rule that lives only in a config file is advice.
- **The one defect here that ACTS rather than fails is the adopted pane's first screen.** Every detector latch is in-memory, so a stale tool-approval prompt still on the pane would read as a rising edge and be answered `1`+Enter — on the owner's session. The first screen is a baseline, not a stimulus: latches are primed against it, so those signatures can fire only after falling and rising again.

### 2026-09-12 — THE FABLE ARBITER IS WIRED, WITH NO FILESYSTEM TOOLS AND ONE ARBITRATION PER REBASE. The build-escalation arbiter had zero production call sites; it now has one. **Supersedes the 2026-09-11 entry below in one respect only** — that entry lists the arbiter rule among the gates that are "ahead of every shipped system and stay", which was true of the rule and not of the code: `buildFableArbiter` was built, unit-tested, exported and constructed nowhere. Everything else in that entry stands. Detail: [`.trident/as-built/wire-fable-arbiter.md`](.trident/as-built/wire-fable-arbiter.md).

- **What it decides, and where.** One call site: a rebase conflict in `rebaseBranchOntoBase` that the bounded Forge resolver escalated. The arbiter gets one read-only turn and returns ONE BIT — grant another resolver round, or let the escalation reach the owner. It is the only merge hold whose whole evidence sits inside the tree it may read; the base-drift holds and the dirty-worktree refusal go straight to the owner as before, because the only alternative to holding at those is waiving a review gate or destroying uncommitted work, and an arbiter may do neither. Unavailable is not a verdict: a missing, capped, timed-out or malformed arbiter falls through to today's owner path, never to a guess and never to a block.
- **It ships with NO filesystem tools, and that is the confinement.** The turn is granted nothing — not Bash, and not `Read`/`Glob`/`Grep` either. Removing write tools does not prevent DISCLOSURE: `Read` alone lets repository-authored input (a commit message, a filename, another agent's prose) aim a read at a credential file or a sibling checkout while the verdict channel carries the answer out, and one bit per arbitration is still a channel whose question the attacker chooses. Confinement by permission flags is unavailable — the substrate profile shape freezes `permission_mode` and `sandbox` until phase B/D — so the choice was unconfined or toolless. Toolless is also the better design: the caller assembles and folds every piece of evidence, so **the caller controls exactly what the judge can see**, which is the confinement property obtained structurally. The evidence therefore carries the CONFLICT ITSELF — both sides of each conflicting region via `git diff <stage-2 oid> <stage-3 oid>`, shown COMPLETE or not at all, every untrusted line quote-prefixed so none can begin a line of the prompt — alongside the filenames, both commit histories and the resolver's question. Removing the tools without sending the hunks (which is how this shipped for one round) left the judge deciding on metadata alone; if it ever cannot decide, add a field to the folded evidence, never restore a tool.
- **Capped at one arbitration per rebase, and the reason is consistency with this repo's own ruling.** `MAX_ARBITRATIONS_PER_REBASE` is 1, bounding the addition to one arbiter turn plus one resolver round — roughly 16 minutes worst case, against 56 at three. `orchestrator.ts:1828-1833` quantifies ~96 minutes for the sibling replay loop and concludes "zero progress once is the answer"; shipping the larger figure here would have applied two standards to the same cost in one codebase. The arbiter's own per-run cap of three remains the outer bound across a run, and the ceiling is frozen by a test that pins both its value and the behaviour, because a relation to a constant cannot detect the constant moving.
- **The guidance channel is deliberately absent, and this is the trap.** Passing the arbiter's reasoning into the next resolver prompt was a privilege-escalation path: the resolver holds Edit/Write/Bash and a GitHub credential, so an untrusted judge's prose could steer a more privileged agent, and no filter removes intent from well-formed prose. Removing it is what makes the win thin — the bit carries NO new information into the round it buys. Do not "improve" the arbiter by reinstating the channel.
- **The kill criterion, stated as a criterion — and it changed shape when the truncation machinery was deleted.** `merge_conflict_arbiter_retry_outcome` records whether the retry the arbiter granted actually resolved or escalated anyway; `merge_conflict_arbitration` records every arbitration and its classified decision, so the ratio has a denominator; `merge_conflict_arbiter_not_asked` records every conflict that could not be shown completely and therefore went to the owner without an arbiter turn, carrying a `why` that distinguishes the four ways that happens — `over-budget`, `evidence-unreadable`, `evidence-binary`, `evidence-truncated`. **The question is no longer "did the judge see the whole conflict" — it always does — but "how often is a conflict small enough to arbitrate at all".** That is the not-asked:arbitration ratio. **This entry named the event by a size-flavoured name until #541 round 34, while the code emitted the name above** — a kill criterion naming a metric that is not emitted cannot be evaluated, and it is this branch's own defect class once more: a claim separated from the thing it describes. The CODE's name is the correct one and the entry is corrected to it, because three of the four whys are not sizes at all — an unreadable or binary conflict is not an oversized one, and a size-flavoured name would have mislabelled them. The retired spelling is recorded in the as-built rather than here, so that **every `merge_conflict_*` name this section prints is one the code emits, and a test asserts exactly that** — which is what makes the drift unrepresentable instead of merely fixed. `prompt_bytes` is the byte length of the exact prompt string the arbiter received — exact because a partial payload no longer exists, and **reported only when a prompt demonstrably reached the model**. The arbiter returns for an owner-only question, an unusable option set, or a spent invocation cap *before any prompt is built*, so on those paths the field is **omitted entirely rather than zeroed**: zero bytes and no prompt are different facts, and a metric that spells them the same way is the same overclaim in one field. **It was named `evidence_bytes` and measured only the caller's own assembly while this sentence already described it as the prompt** — the field's documentation named one string and its value measured a substring of it. Both the budget and the measurement now live in `arbiter-prompt.ts`, the single place the prompt exists in final form. **If not-asked dominates, the tier is nearly inert, and that is the next decision to make** — it is recorded this way so it can be made on numbers rather than taste. If retries are granted but rarely resolve, the answer is the one already written: **stop offering the retry, do not raise the bound and do not re-open the channel.**
- **THE TRUNCATION MACHINERY WAS BUILT, PRODUCED FIVE DEFECTS IN FIVE ROUNDS, AND WAS REMOVED ON THAT EVIDENCE.** Rounds 7-12 built a judge that could be shown PART of an oversized conflict and told so: a per-file byte budget, per-file truncation notices, an omitted-files marker, a whole-evidence backstop notice, and a single "withholding" owner whose explicit purpose was to make the judge's notices and the telemetry structurally incapable of disagreeing. Every round found a new instance of ONE defect: **the bytes accounted for were never the bytes emitted.** The marker appended outside its own budget (7); the per-file budget counting the diff but not the label (9); the backstop silently cutting the notice that said the payload was a fragment (11); `raw_bytes` naming a total it had stopped counting (12); and finally, AFTER the structural refactor, a record budget that ignored the quote prefixes its own caller adds, plus a "shown bytes" figure that counted diff bodies only while both its field comment and this entry called it what the judge was sent (13). Framing — labels, prefixes, separators, the notices themselves — rode free every time, because the accounting happened where content was chosen and the emission happened somewhere else. **The refactor unified the two AUDIENCES for a withholding event and did not save this, because it did not unify the MEASUREMENT with the EMISSION.** That is not a defect that comes good on the sixth attempt; it is a property of any design that shows part of a thing and separately describes the part. So the machinery is gone: the arbiter is invoked only when the whole prompt fits inside `ARBITER_PROMPT_BYTES_MAX`, the measurement is taken on the exact string handed to the judge, and a conflict that does not fit escalates to the owner down the path that already existed. The remaining bound is `--max-count` on each side's history, which drops WHOLE commit records at a granularity git enforces and whose limit is interpolated into the prompt heading from the same constant that sets it — so the judge is always told what it holds, and the sentence cannot drift from the argv.
- **THE PRE-COMMITMENT FIRED, AND IT IS RECORDED BECAUSE IT WAS HONOURED RATHER THAN ARGUED WITH.** The previous revision of this entry pre-committed, before any data existed, to exactly the deletion above: *"if resolutions cluster on `truncated: false`, that does not mean raise the bound — it means `truncated` was the feature's PRECONDITION, and the right shape is to invoke the arbiter only when the payload is complete and delete the truncation machinery entirely."* It named production data as the trigger and added that a further disclosure defect arriving first "reaches the same conclusion by a different route, and is to be taken the same way". Two more defects arrived first, so the pre-commitment was honoured on the stronger evidence rather than held back for the weaker: five defects in five rounds is a better argument than a resolution ratio, and the value of writing the response down in advance is that the inconvenient moment had no room to re-litigate it. **A pre-commitment that gets honoured is worth more than one that gets argued with, and this one is kept visible for the next person tempted to bound a payload instead of declining to send it.**
- **AND THE DELETION WAS INCOMPLETE, BECAUSE IT WAS ENUMERATED FROM ONE FILE.** The round-13 removal named the machinery item by item — the per-file budget, the notices, the omission accounting, the withholding owner, the metrics — and every name was in `merge.ts`. A second, independent cap lived one module downstream: `arbiter.ts` folded every evidence line to 4,096 **characters** while building the prompt, against a caller budget of 8,192 **bytes**. A 5,000-character diff line therefore passed the all-or-nothing check and lost ~904 characters on the way to the model — the judge handed a fragment beneath a sentence saying nothing had been shortened, which is the exact failure the deletion existed to make unreachable. **Removing a feature leaves mechanisms behind exactly as adding one leaves claims**, and an enumeration written from inside one file can only ever find that file's. The root is one sentence: the measurement and the enforcement were in `merge.ts` while the prompt was assembled in `arbiter.ts`, so every claim of the form "we measured what the judge got" was about a string that was not the one the judge got — this lane's recurring defect (*a measurement is only about what it measured*) crossing a module boundary, where it is far harder to see because each file is locally consistent and neither is wrong on its own terms. **The rule, now structural: there is exactly one place the prompt exists in final form, and that is the only place it may be measured or bounded; anything upstream is an estimate, and an estimate must not be reported as the thing.** `arbiter-prompt.ts` is that place — a module both `merge.ts` and `arbiter.ts` depend on and which depends on neither. Its budget covers the WHOLE prompt including the fixed instruction template, because a budget that excluded the template would be framing riding free one level up; a test pins that the budget minus the real template still leaves the evidence allowance, so instruction text cannot silently narrow the tier. The per-line cap is gone, and the fold that remains is bounded BY the budget, so any line long enough for it to shorten forces an escalation instead.
- **AND A FAILED READ WAS BEING REPORTED AS COMPLETE EVIDENCE — the same sentence one layer lower.** `conflictEvidence` mapped a `git diff` that FAILED and one that succeeded with empty output to a single sentence — *"no two-sided diff — the path exists on only one side, or git could not read it"* — and returned `complete`. That sentence is an **OR of a definite fact and a missing one**, which is the tell: a failed read therefore invoked the arbiter, told it the evidence was complete, and let it grant a retry having seen neither side of an ordinary conflict. The rule it broke is already written down — **false and unknown must not share a branch** — and `ok:false`, a thrown host error, and an index this code cannot parse are all *unknown*. **The test written to demonstrate the seam held was pinning the violation as correct**, which is the worst place for a leak to be, because from then on the test defends it. **And the distinction could not come from the diff's exit code, which had to be measured rather than reasoned about:** against real git, a two-sided conflict's `diff :2: :3:` exits 0 while a genuinely one-sided (modify/delete) conflict exits 128 — *the same observable as a broken read*. So the separation now comes from positive evidence, `git ls-files --unmerged`, which names which stages exist and exits 0; both stages present means the diff must succeed, and a missing stage 2 or 3 is a complete fact the evidence states precisely — including **which** side exists, which the old sentence could not say because it did not know. Every failure is a refusal to arbitrate (`unreadable`), never a thinner prompt, and the refusal names itself so "too big to show" and "could not be read" never blur into one count. The general form, pinned by a property over every failure shape I could build: **nothing reaches the judge that the system could not establish** — if the arbiter was asked, the evidence layer said `complete`.

- **A BRANCH NAME COULD SILENTLY DISABLE THE WHOLE TIER, and the test I wrote pinned it as correct.** `buildFableArbiter` screens the entire `question` with `isOwnerOnlyQuestion` and returns `owner-only` **without starting a substrate**; the seam interpolated the branch name into that question; so a branch called `feat-budget-flush` matched the money pattern and turned the arbiter off before any model call, on ordinary repository-local work. I found that route while building a fixture for a different finding, described it as "a real route, not a contrived question", and **asserted zero substrate starts as the expected behaviour** — pinning the thing that reproduces #541's own premise, an arbiter with no production reach, in the form nobody notices: *the arbiter quietly not running*. A denylist tweak is not a fix, because the next ref name spelling `deploy … prod` or containing `$1` does the same, and the screen cannot tell a word the caller wrote from a word that arrived inside a value. **The boundary is structural: nothing caller-controlled enters the screened string.** The ref names, the paths, the resolver's own text and both histories all live in `evidence`, which is not screened and is already framed as quoted data; the judge loses nothing and learns which branches these are one block lower. The invocation counter also moved below the screen — the cap exists to bound MODEL TURNS, and a question that never reaches a model must not spend one.
- **And a one-sided conflict now SHOWS the side that survives.** The modify/delete branch named the surviving side and stopped there, which was `complete` in the type and incomplete in fact: the judge could grant a retry on a modify/delete conflict without ever seeing the change, under a prompt that says nothing has been left out. **A one-sided conflict has less content than a two-sided one; it does not have none.** The surviving stage's blob is read by object id (so an untrusted path never becomes a pathspec) and quoted in full, and a blob the index promised but git will not return is `unreadable` rather than an empty side. The test that protected the old behaviour asserted the descriptive sentence — which is true whether or not the content is shown — and now asserts a distinctive token from the surviving version.
- **A BINARY CONFLICT WAS PASSED OFF AS SHOWN EVIDENCE — the third variant of one sentence.** `git diff` **exits 0** for two differing binary blobs and prints only `Binary files … differ`, verified against this repository's own PNGs. `ok && stdout.length > 0` had been standing in for *"the diff is readable"*, so the judge would receive a one-line notice under a prompt promising the conflict was shown complete. **An exit code is not the evidence** — first a failed read was mapped to complete, then a one-sided conflict was described rather than shown, now a successful-but-contentless diff was passed through as content. Binary is now its own arm (`{kind:'binary'}` → `not-asked why=evidence-binary`), counted apart from *too big* and *could not read*, because a repo whose conflicts are images says something different about this tier's reach than a repo whose git reads are failing — and nothing there could be fixed by reading harder. **Detection asks git rather than parsing its prose**: `--numstat` writes `-` in both numeric columns for binary, so a text file whose own contents include the line `Binary files a and b differ` is still shown — pinned by a real-git control, since matching the sentence would be the identical mistake one layer up. The one-sided path uses git's other heuristic, a NUL byte in the surviving blob, because `--numstat` needs a pair; without it a deleted-or-modified PNG went through `defang` and arrived as a wall of spaces that *looked* like evidence.
- **THE FOURTH VARIANT, AND THEN THE STRUCTURAL FIX: one owner decides whether evidence is present, and the completeness sentence is COMPUTED FROM IT.** `sideHistory` turned a thrown call and a non-zero `git log` into the string `(history unavailable)` and arbitration continued — a placeholder that reads as data, sitting beside real commits, under a prompt saying nothing had been left out. A read failure is not evidence that no history exists. Four components had now each been passed off as evidence they were not: the conflict diff (a **failed** read → `complete`), a one-sided conflict (a **description** instead of the surviving content), a binary conflict (a **successful but contentless** diff), and the history (a **failed** read → a placeholder). Every one was `ok && stdout` standing in for *"the evidence is readable"*, and every one ended at a prompt asserting completeness — **a property of the module, not four slips**. So the fix is not a fifth patch: every component is now an `EvidencePart` that is either `present` or `missing`, **`assembleEvidence` is the single place that decides, and it returns nothing at all when any part is missing** — so the completeness claim cannot be emitted beside an absence. The claim itself moved out of the generic prompt template, which had been asserting as a CONSTANT something it has no way to check (it is generic over callers and receives the evidence already rendered), into the one function that reads the parts. That is the round-12 invariant — *recording is emitting* — applied to completeness instead of withholding, and it is what stops a fifth component arriving with a fifth placeholder. An **established emptiness is still evidence**: git answering "this side adds nothing" is a fact and is shown; only a question we could not ask is missing.
- **PRESENCE, FIDELITY, FRAMING — the seam gave the first for free and neither of the others.** Two findings inside what the completeness sentence already claimed. **Fidelity:** evidence lines went through `defang` (which rewrites every run of `\u0000-\u001f` — **tab included** — to one space, and maps `"` to `'`) and then `.trim()`, which also removed git's own unified-diff **context marker**. A whitespace-only conflict therefore reached the judge as two identical-looking lines with the disputed content deleted, under a sentence promising nothing had been shortened — and Makefile, Python and YAML conflicts are frequently *about* whitespace. "Nothing has been shortened" is a claim about the **bytes**, not only about which parts exist. The rule is now narrowed to what the quote boundary actually needs: remove only the codepoints that can **end or reorder a line**, each becoming one space so columns survive; tabs, indentation, trailing spaces and quotes are preserved exactly. The command-rewriting is deliberately absent on this path — it exists because that evidence is rendered into **chat**, where a reader may copy a command; this text goes to a judge with no tools whose whole output is one option id. **Framing:** `run.task` — card text, the most caller-influenced field in the prompt — was interpolated bare under an authoritative heading, outside the `|` boundary. Character folding does nothing against **prose**, and prose is the attack on a judge. It is now folded to one line, quote-prefixed and framed as data. No test can prove a model ignores a sentence — this entry already records that filtering prose for intent is not a thing that can be done, which is why the guidance channel was deleted rather than sanitised — so the enforceable guarantee is structural, and the residual is bounded by what the arbiter can do at all. **One residual is disclosed rather than claimed away:** the shared host runner trims each command's stdout (`git-mode.ts:1223`), so trailing whitespace on the **last line** of a diff is gone before this code sees it; removing that trim would touch every `spawnCapture` caller in trident and is not a change this seam can make safely. **CLOSED IN ROUND 32 by making the claim true rather than qualifying it** — a residual honest in this log and absent from the prompt is still an overclaim to the party acting on it. Measuring first widened the finding and narrowed it: the trim was also taking the **leading** whitespace of a one-sided conflict's raw blob (a file opening with an indented line arrived with the indentation gone), while the commit history turned out safe because its records end in NUL. So the one-sided path is now shown as a **diff against the merge base** — the `diff --git` header puts repository-authored text at the start of stdout, and it is better evidence besides, since the judge is weighing a change against a deletion — and **one rule covers both paths**: a diff whose FINAL line is an added or removed line may have lost disputed content, and is refused through the same truncation channel as every other incompleteness. A final **context** line is exempt, and that is the point rather than a concession: it is identical on both sides, so the loss is symmetric and cannot change which side wins. The judge-facing sentence now says what holds — *nothing that differs between the two sides has been shortened*.
- **INSTANCES SIX AND SEVEN, AND THEN THE FIX THAT ENDS THE SERIES: truncation is made OBSERVABLE rather than audited.** Six: `listConflictedFiles` turned a non-zero `git diff --diff-filter=U` into `[]`, which became "no conflicted paths reported" and was handed to the judge as COMPLETE evidence about a conflict git had just refused to describe — **an empty list and an unreadable list are different facts**, the `?? {}` defect once more. Seven: the completeness sentence was unconditional while filenames passed through a 300-character cap and a count-bounded summary, and the resolver's question through the same cap — and a test **codified** it, expecting a 60,000-character filename to be bounded *and* still yield evidence. **The pattern across all seven is one sentence: some function quietly returns less than it was given, and a CONSTANT elsewhere says nothing was lost.** Auditing call sites is what produced instances two through seven, because the caller list is never finished and a cap added later is invisible to every audit already done. So the fold PRIMITIVE now returns whether it truncated — **both ways it can shorten, including the 64,000-character scan window that carries no marker of its own** — a per-arbitration collector carries those flags, and `assembleEvidence` derives the claim from the disjunction, taking the same exit as a missing part. The only thing that can produce the completeness sentence is the thing that knows, so **a cap added anywhere later feeds the same channel and the claim simply stops being reachable**. Two truncating fields were removed outright rather than flagged: the path summary states a COUNT and points at the sections (every path already appears below in full, so it omits nothing because it never claims to be the list), and every fold now uses the prompt budget. That leaves the truncation exit **unreachable from production today** — no cap is smaller than the budget, so the size bound fires first — which is stated plainly and unit-tested directly, because a guard with no detector is a comment.
- **AND THE ROUND-13 RULE, APPLIED TO CONTENT: the final assembler was re-folding the evidence and undoing every fidelity guarantee upstream.** `merge.ts` assembled the conflict byte-faithfully; `arbiterPrompt` then ran every line through `foldEvidenceTo` → `defang`, which collapses control runs — **tab included** — and rewrites double quotes to single. So `| -<tab>command "x"` reached the model as `| - command 'x'`, and a whitespace- or quote-sensitive conflict arrived with the disputed bytes altered under a claim that says they are preserved exactly. **There is exactly one place the prompt exists in final form, and that is the only place it may be measured OR SANITISED** — the same sentence that made `prompt_bytes` honest for SIZE, now applied to BYTES. `defang`'s two jobs are separated: removing what can END or REORDER a line is security and stays; collapsing tabs, rewriting quotes and rewriting commands is **chat-rendering hygiene**, right where a reader may copy a command and wrong for a diff going to a judge with no tools whose entire output is one option id. **And the fidelity tests measured the wrong stage** — they stopped at `conflictEvidence`, the layer before the transformation that damaged it, which is how a round whose whole subject was fidelity shipped with the damage intact. The assertion now runs end-to-end against the captured `AgentSpec.prompt`, the same instrument the `prompt_bytes` identity test uses, pointed at content. **The standing rule: assert at the boundary the guarantee is about.** Presence was fixed by a type, loss by a reporting channel, fidelity by moving the assertion to the final form — three remedies for one class, because the class is *a claim separated from the thing it describes*.
- **THE SANITISER'S CLASS OMITTED THE WHOLE C1 BLOCK, AND SAMPLING COULD NOT SEE IT.** `FORGERY_CODEPOINTS` covered C0-except-tab, `U+007F` and the bidi/invisible set — but not `U+0080-U+009F`, so `U+0085` NEL survived and repository-controlled evidence could introduce a line break into a prompt whose framing assumes a line cannot be forged. **The tell was internal inconsistency, not taste:** the class already stripped `U+2028` and `U+2029`, and NEL is the third member of that same "not LF but treated as a line break" set; `foldRefName`, in the same file, has covered `U+007F-U+009F` all along. `defang` carried the identical gap and is fixed with it. **A sanitiser tested by sampling is tested against the characters someone thought of** — the old test named six representatives and passed while 32 codepoints leaked. The intended ranges are now DATA (`FORGERY_RANGES`) exported beside the class, a test WALKS every codepoint in every range, and one assertion drives every one of them through the whole seam and against the captured `AgentSpec.prompt`. **Tab stays out of the class deliberately** — it cannot forge a line and it IS the disputed content in a Makefile conflict — and a mutation putting it back is red in three tests.
- **INSTANCES EIGHT AND NINE, AND THE AUDIT THAT ENDS THE SEQUENCE.** Eight: a **successful but empty** conflict listing was still `complete`. This code is only reached after the resolver ESCALATED, which establishes a conflict occurred — so "no unmerged paths" is a failure to FIND it, not a description of it, and the judge was being asked to rule on a conflict with no conflict in it. Nine: commit history was shortened by an ad-hoc `.replace(/\s+$/, '')`, deleting repository-authored trailing whitespace under the completeness claim — **and that one matters more than its size, because it shows the channel's boundary**: the reporting fold covers the transformations routed through it and is blind to an inline string operation anywhere else. Fixed by parsing git's own `%x00` framing rather than discarding whatever looks blank. **The terminating audit is in the change record**: every transformation applied to evidence text between the git call and `assembleEvidence` is enumerated — thirteen of them — and each is either routed through the reporting channel or proven lossless, with one expected mutation survivor labelled with its reasoning. **The audit found a tenth instance the review had not named**: the final assembler was folding evidence through the CAPPED fold and discarding the truncation flag, which could never have reached the channel because the caller consults it before the prompt is built. Evidence now goes through a substitution with no length behaviour at all — lossless by construction rather than by an argument about another module's budget.
- **A CAP YOU CHOSE IS STILL AN OMISSION THE CLAIM DENIES (eleven), plus two more.** `--max-count` asks for the 20 most recent commits, so for a branch with 21 the sentence "nothing has been left out" was false — **disclosing the limit in the heading is good and is not the same as the claim being true**. Narrowed rather than refused, because the conflict is what the judge RULES on and stays all-or-nothing while the histories are corroboration: treating a 21-commit branch as incomplete would refuse ordinary work while removing nothing the judge needs. The sentence is **computed from which parts are bounded**, and whether the cap bit is **established** by asking git for N+1 and showing N. **Twelve:** the 12 KiB budget was enforced *after* reading unbounded output, so a multi-gigabyte blob was materialised before `over-budget` came back — **a limit on how much you keep is not a limit on how much you do**. Both sides are now sized with `cat-file -s` before any content is fetched, against a collection ceiling (8 MiB) deliberately distinct from the display budget. **Thirteen:** a retry rejected by the integrity gate emitted no outcome at all, so rejections vanished from the resolved-versus-escalated ratio this entry uses as the kill criterion — **a measurement that drops its own failures reports better than reality**. Now `outcome=refused-integrity`. **The audit gained a third clause**: it must cover the collection commands and the deliberate caps, not only the string transformations, because **a cap is not a transformation — it is a request**; for each site the question is "can this produce less than everything".
- **A LIMIT ON HOW MANY IS NOT A LIMIT ON HOW MUCH.** The collection ceiling covered the diffs and blobs and missed the commit history, because `--max-count` looked like a bound and is one — **of the wrong quantity**. It limits the NUMBER of commits while the format captures every message in full, so one enormous body was still materialised before the refusal applied. Fixed with the blobs' strategy applied to commit objects: fetch the SHAs, weigh each with `cat-file -s` (which reads no message), and refuse on the RUNNING TOTAL before the message-bearing `git log` is issued. **The boundary test asserts the read never happens**, not merely that the refusal occurs — asserting the refusal alone passes against code that refuses *after* reading. **And the audit row was corrected, which matters more than the code change**: that table is the terminating condition's evidence, and a row claiming a bound that bounds a different quantity is the one error it cannot afford.
- **A CEILING ON EACH PART IS NOT A CEILING ON THE WHOLE** — the fourth variant, and the first to appear INSIDE a fix. The collection ceiling weighed each stage blob separately, so two 5 MiB sides passed a stated 8 MiB bound; and because the check sat inside the per-path loop, ten such files would have read 100 MiB. The previous round had bounded the history *cumulatively* and left the blobs *per-item*, so one fix carried both shapes at once. There is now **one `CollectionBudget` per arbitration**, threaded through every reader the way the truncation log is threaded through every fold, with boundary cases for two stages of one file, two files, and the conflict plus the history — plus a non-vacuity case, since "refuse everything" passes the rest. **The audit rows now name the quantity each bound bounds**, because four defects here were a real bound on the wrong quantity and a row saying only "bounded" is exactly as useful as the bound was. **And the prohibited guidance channel was still asserted in the test file's header and a test title** — the same clause corrected in the change record two rounds earlier, surviving where it asserts rather than where it describes: **tests are documents, and they are the ones that assert.** The sweep found it once more in a plan instructing a future lane to rebuild that channel on the publish path; corrected there too.
- **THE DECIDING READ AND THE ACTING READ MUST BE ONE READ.** `sideHistory` resolved a **mutable ref range** to commit ids and weighed them, then re-ran `git log` **against that same range** for the messages — so if either endpoint advanced in between, the second call materialised objects never charged to the budget and supplied evidence that **is not what was sized**. *A budget computed from one resolution and spent against another is a consent check computed before the write.* The range is now resolved once and `--no-walk=unsorted` reads exactly the weighed object ids. **A different axis from the three bound-defects before it**: those measured the wrong quantity; this measured the right quantity **of the wrong things**. My tests could not see it because every stub answered both calls from canned output and never moved the range — **a host that cannot change between two reads cannot test that two reads agree**, the same shape as "a host that cannot fail cannot test a failure path". Two further survivors closed, one a real defect: a non-object-id line in the resolution output was silently **filtered**, turning "I could not parse git's answer" into "there are fewer commits". **And the rule was written here while the conflict path still broke it** — `conflictEvidence` weighed the stage-2/stage-3 shas from `ls-files --unmerged` and then diffed `:2:<path>`/`:3:<path>`, pathspecs that re-resolve the index at read time. Fixed the same way in round 34, by diffing the weighed object ids: **eliminated rather than detected**, because re-reading the index afterwards to check for movement is the check-after-the-fact shape this entry exists to reject. The disclosed cost is that a blob-to-blob diff header names object ids instead of the path, so the section heading says so — once, not per file, which had cost enough bytes to refuse a forty-file conflict. **AND THE SAME PAIR CAN DISAGREE IN THE OTHER DIRECTION**, which round 36 closed: the resolution found N commits and the render returned none, and the code reported `(no commits in range)` — a sentence git never said. That string is legitimate only where the RESOLUTION came back empty, before anything is weighed; after the render it could only ever mean the two reads disagreed, so one sentence stood for both "git says none" and "git was asked for twenty and showed none". The render must now produce **one record per weighed oid** — equality, not "non-empty", because a partial render is a silent omission under a completeness claim and an inequality would admit commits that were never weighed at all. The one-record-per-oid relation is pinned against real git, since git writes a newline BETWEEN entries and it is `spawnCapture`'s trim that makes the framing come out even.
- **THE KILL CRITERION COUNTED A BET BEFORE GIT HAD PAID IT.** The retry outcome fired the moment the RESOLVER returned — before `git rebase --continue` agreed — so a resolver that declared success whose continue then failed was already recorded `resolved`; and because the flag was cleared there, a retry whose continue surfaced the NEXT conflicting commit could never have the eventual escalation attributed to it. **The second is the common shape rather than the edge case**, because the arbiter is consulted precisely on multi-commit rebases. This entry names that ratio as the kill criterion, which makes a biased numerator the instrument deciding whether the feature lives. The bet is now closed by one owner at the REBASE's terminal states with three distinct outcomes: `resolved` only on a completed rebase, `escalated` at every escalation exit, and **`rebase-failed`** named apart, because "the resolver was wrong" and "the conflict needs the owner" are different facts. **And the removed guidance channel appeared a fourth time — inside the text sent TO the arbiter**, promising a "better-directed" round the design ensures it will not get: a misdescription on the judge's own input. Swept on the phrase rather than the file list, stated positively in the prompt (a judge told nothing may still assume a channel exists), and given a detector against the captured `AgentSpec.prompt` — **a sweep finds today's copies; only a test refuses tomorrow's.**
- **AND A CONTRACT THAT INSTRUCTED ITS READER TO REINTRODUCE THE DEFECT.** `sideHistory`'s docblock said an unreadable history "makes the arbitration thinner" and drew an asymmetry — *"unreadable history is a complete answer ('there is none to show')"*. Both halves were false: every read failure returns `missing`, and `over-budget` takes the identical refusal path. **What makes it more than drift is where it points** — thirty lines below, the comment removing the round-19 placeholder says *a read failure is not evidence that no history exists*, so the contract asserted **exactly the equation that comment names as the defect**, and a maintainer reading it would have relaxed the `missing` returns with the code agreeing until they reached that comment. The rewrite says why the two exits are the SAME (neither is evidence about what the history contains) and names the asymmetry that is real: they are indistinguishable to the judge and entirely distinct to the operator, because `over-budget` says this tier's RANGE is narrow while `evidence-unreadable` says something is BROKEN — collapsing them would make a repo of large conflicts and a repo with failing git reads produce the same number, and those call for opposite responses. **A docblock is the instruction a future author follows**, and this one was instructing them to undo the PR.
- **AND THE PROMPT CLAIMED A QUOTE BOUNDARY THAT ONE OF ITS OWN VALUES CROSSED.** The resolver's escalation message was interpolated into the evidence PREAMBLE — inside quote MARKS, which are punctuation and not a boundary — on an unprefixed line immediately after `EVIDENCE:`, while the prompt tells the judge every `|` line is content the repository did not author and duly prefixes `run.task`. **The framing rule was applied to one untrusted scalar and not the other, and this was the more attacker-controlled of the two**: model-authored prose from a credentialed, write-capable agent, against card text. Folding does nothing to intent — the conclusion that deleted the guidance channel rather than sanitising it. The message now has its own quoted section under a heading naming the party. The test asserts the STRUCTURAL property — every untrusted scalar driven at once, no marker-carrying line unprefixed — so the next scalar added here cannot repeat it. **One deliberate exception with its basis proven rather than asserted**: ref names may sit in repository-authored headings because `foldRefName` reduces them to a single whitespace-free token that cannot forge prose or a line, and the fixture now carries whitespace so it can actually tell that fold from one that preserves it.
- **AND THE BOUND'S OWN INPUT TURNED AN UNPARSEABLE ANSWER INTO A MEASUREMENT.** `objectSize` refused correctly on a throw and on a non-zero exit, then read `git cat-file -s` output with `Number(...)`: `Number('')` is `0`, and zero passes an `isInteger && >= 0` check. A size query that exited 0 with EMPTY output therefore became a measurement of nothing — the budget weighed nothing, the pre-read guard passed, and the content-bearing read proceeded **unbounded**, which is the resource-exhaustion class closed two rounds earlier, reached through the one input that establishes the bound. `Number` is lax the other way too (`1e9`, `0x10`, `007`). **The rule was already written eight lines below for the adjacent function** — every route to `null` is a route the caller must refuse on, a parse failure as much as any other — so this is round 30's shape again: the branch's own rule present in the file and not applied to the code beside it. Now a strict decimal. **The test asserts the content read never happens**, not merely that the result is `missing`, because an implementation that reads and discards satisfies the weaker assertion while leaving the bound defeated — with a control that an ordinary size still permits the read. **And the fix showed thirty-five stub hosts had never answered the size query**, falling through to `ok('')` and reading as zero: every one had been exercising the defect and passing, which is the `ls-files` lesson again — a stub that omits a query supplies whatever the default branch returns, and here the default was the bug.

### 2026-09-12 — THE REPL SUBSTRATE BECOMES SELECTABLE: herdr is the default container and the in-process PTY host is RETAINED as an alternative. Owner-directed, and a deliberate exception to this tree's no-dual-code-paths rule. **Supersedes the clause "Herdr is the REPL container; the opaque PTY host goes" in the 2026-09-11 pivot entry below**, which stays verbatim as this log requires — herdr remains the container and the default; what is withdrawn is the deletion. Spec item: [`docs/spec-items/herdr-host-implements-ptyhost-over-the-socket-api.md`](docs/spec-items/herdr-host-implements-ptyhost-over-the-socket-api.md). Issue #540 is rewritten from "delete the in-process PTY host" to "make the REPL substrate selectable".

- **The owner's words, verbatim:** *"how hard would it be to make the underlying substrate (herdr or existing pty system) user configurable? If hard I dont want to worry about it, but if relatively easy I would like to keep the old PTY system around as a config option that a user can choose"*. The measurement that answered it: the selection seam already existed (`spawn.ts` resolves `options.ptyHost ?? herdrHost`), the interface delta was three adaptations, and the coupling outside the three herdr modules was ~21 references. Relatively easy, so the option stays.
- **What is NOT decided here, and is sequenced deliberately: there is no config surface yet.** The PTY host is reachable only by injecting it at the existing seam. A chooser between a proven path and an unproven one hides which is which, so the user-facing selector waits until the herdr path is verified working on the instance. The option is preserved at near-zero cost; it is not exercised.
- **The ongoing cost is that the shared contract must stay honest about BOTH backends, and it did not.** `PtyChild.write` had been tightened to say "DOES NOT SUBMIT" while herdr was the only implementation — herdr's semantics written into a shared type, and false under a pty where `\r` genuinely submits. Nine clauses in `pty-host.ts` plus two collaborators stated a herdr fact as a universal. A shared interface that describes one backend IS the diverging-code-paths outcome this exception was supposed to avoid, so keeping both means paying that sweep, not just keeping a file.
- **Three differences are permanent and are stated at the selection seam rather than discovered per caller.** Exit codes exist under the PTY host and NOWHERE in herdr (where `exited` always resolves `null` and crash-versus-recycle rests entirely on `wasKilledByUs`); exit is a push under the PTY host and a POLL under herdr; and `onScreen` is a rendered pane under herdr but an accumulation of the byte stream under the PTY host — so an Ink repaint collapses under herdr and cannot under a pty. The third is a real defect on the PTY path, named rather than papered over: it is no worse than before herdr step 2b, but it does not get that fix.
- **This entry exists because the decision had no governing record.** The reversal was recorded only in a spec item and an as-built, while `AGENTS.md`'s "no feature flags and no dual code paths" and the 2026-09-11 clause above both still read as absolutes — an owner decision recorded only in a work item cannot override the authorities. `AGENTS.md` is amended in the same change to scope that rule to "unless a Decisions Log entry records a deliberate alternative", which is the false-absolute class rather than a wording nicety: a standing rule the tree contradicts teaches the next reader to ignore it.

### 2026-09-12 — RECURRING CROSS-MODEL WORK IS ONE-SHOT HEADLESS PER CALL, ON A REUSED THREAD ID. Settles the spike the 2026-09-11 pivot entry left open (§3.3, criterion verbatim there), and **SUPERSEDES that entry's outcome rule** — *"All three, no fragility → persistent; else headless per call"* — which read top-down would point the opposite way from this decision. It is superseded rather than satisfied: **its `→ persistent` branch existed to capture a cost saving that was measured not to exist**, so the rule's own condition never arbitrated. All three tests did pass. The rule was correct given what was believed in it; a measurement retired it, not a change of mind. The 2026-09-11 entry stays verbatim, as this log requires. Spec item: [`docs/spec-items/codex-work-runs-headless-per-call-on-a-reused-thread.md`](docs/spec-items/codex-work-runs-headless-per-call-on-a-reused-thread.md). Measurements: `docs/as-built/` for this change.

- **All three tests passed, and the decision is still headless — because the premise they were weighed against is false.** The spike's bar was (a) follow-up turns, (b) survive a gateway restart and resume, (c) an approval round-trip, "all three with no fragility → persistent REPL". A persistent `codex app-server` on the ChatGPT subscription did all three. But the reason to want it was cost, and there is no cost to save: **OpenAI's prompt cache for a codex thread is server-side and keyed on the thread prefix, so it survives process exit.** Paired A/B on adjacent turns of one thread, same trivial prompt: the live persistent session spent **1,240 uncached input tokens** (21,336 in, 20,096 cached); the one-shot `codex exec resume` process spent **1,141** (22,261 in, 21,120 cached). The one-shot was marginally cheaper. Early in a thread both sit at 97–99% cached (persistent 16,384 of 16,522; one-shot 15,744 of 16,181). Persistence buys process startup — ~3.2–3.8 s per turn live against ~4.6–6.1 s one-shot, so **1.3–2.5 s** — and nothing else. The `claude -p` figure that motivated the question (23,799 / 23,799 / 27,603 cache-read tokens per headless job) has its codex analogue only in the **first turn of a new thread** (15,935 in, 11,264 cached); the fix for that is reusing the thread, not holding the process.
- **Persistence is not free, it is a robustness regression.** A live `app-server` takes an **exclusive writer lock on the thread**: with it running, `codex exec resume <id>` on that thread fails `thread-store conflict: … already has an active writer (code -32600)`, verified by positive control — the identical command succeeded the moment the server was killed. So a wedged persistent process locks its conversation out entirely and no one-shot fallback can reach it. **What headless removes is the wedged long-lived owner, not the lock** — the lock still holds for the duration of every active one-shot call and is per-`CODEX_HOME`, so two overlapping resumed calls on one thread id conflict in this shape too, across processes. That is why the spec item carries a positive concurrency contract rather than a caution — one owner per thread id, fan-out as one thread per lane, **in-process** overlap waiting on a bounded per-thread queue, and **cross-process** overlap returning a distinct typed conflict immediately rather than waiting, because two processes on one thread id is a design violation and there is no shared primitive to wait on. Given trident's own history of supervised long-lived processes, adopting one to save 2 seconds is the trade the owner's criterion exists to refuse.
- **The only *supervised* persistence is unavailable to this install.** `codex app-server daemon start` refuses without a managed standalone install at `$CODEX_HOME/packages/standalone/current/codex`; codex here is the npm distribution and that directory does not exist under the live credential dir. Adopting the daemon would mean a second, self-updating codex distribution per `CODEX_HOME`. Its control socket is also `$CODEX_HOME/app-server-control/app-server-control.sock`, which at the per-project `CODEX_HOME` shape (`<owner_home>/.codex/projects/<project_id>`, `trident/codex-auth.ts:191-194`) is **114 bytes against a 108-byte `SUN_LEN` limit** — `path must be shorter than SUN_LEN`, reported with **exit status 0**. Per-project codex seats could not run a daemon even with the standalone install.
- **Unmanaged persistence works but its transport had to be found by elimination.** Three shapes closed the connection or swallowed the request with **no diagnostic on either side**: raw JSONL to a `--listen unix://PATH` socket (EOF; the socket wants a WebSocket upgrade, `failed to upgrade control socket websocket connection` in the binary's strings), `codex app-server proxy --sock <path>`, and `codex app-server proxy` against the default control socket — both stayed connected and never answered a valid `initialize`. `--listen ws://127.0.0.1:<port>` worked first try, announces `readyz`/`healthz`, and is directly speakable from the gateway's own runtime. That is the shape a persistent adapter would have used; finding it cost most of the spike.
- **Criterion (c) is satisfied on the adopted shape too, by a different mechanism, and the difference matters.** On persistent it is a true round-trip to *us*: `item/commandExecution/requestApproval` arrives on the connection and Neutron answers it (`accept` ran the escalated command, `decline` left the file absent). Headless has **no channel for Neutron to be the decider** — `codex exec` with `-c approval_policy=on-request` emits no approval event at all and refuses the escalation outright ("this session's approval policy forbids requesting escalated permissions", exit 0). What headless has is `--approve-for-me`, which routes the request to **codex's own automatic-review subagent**: measured, the escalated write it had just refused went through and the file appeared. That works on a **resumed** call as well — the flag is absent from `codex exec resume` but reachable as `-c approvals_reviewer=auto_review` + `-c approval_policy=on-request`, verified on a resumed thread. So (c) holds on every turn of the adopted shape — as a **measurement**, not as a route the adapter ships: the spec item requires every argv to carry no approval routing at all, because certifying a path on which codex authorizes its own privileged actions would be certifying a reviewer never observed denying, and nothing in scope needs one. **Two honest limits.** The approver is codex, not Neutron; an approval that must reach the owner cannot be served by headless codex at all, and by the 2026-09-11 entry above it would not be codex's to ask — owner questions flow from the orchestrator. And it was **not established that `auto_review` ever denies**: the one refusal observed came from the model declining to print a credential-shaped file before any escalation was attempted, so the reviewer was never consulted. It must not be treated as a safety control. **None of our codex work needs it today**, which is why this is a capability note and not a blocker: `trident/codex-build.sh:1402` already runs `codex exec … --sandbox danger-full-access`, deliberately and with the narrower policies rejected on record (`trident/codex-build.sh:181-200`), so a build never requests an escalation; and cross-model review reads a diff.
- **What the persistent path did prove, kept here because it is reusable.** Two `turn/start` calls on one connection carried conversation state. A **new client process** against the same live server resumed by `threadId` and recalled it. The server **killed and restarted** resumed the same thread from disk and recalled it. A client killed **mid-turn** did not orphan the turn: it completed server-side and a reconnecting client read the finished result. An approval round-trip completed bidirectionally — `item/commandExecution/requestApproval` → `{"decision":"accept"}` wrote the file, `{"decision":"decline"}` left it absent. The approval path needed one correction first: with `sandbox: read-only` the escalation is refused server-side and never reaches the client, and there are two decision vocabularies (`accept`/`decline` for `item/*`, `approved`/`denied` for the legacy `execCommandApproval`) — a client must speak both.
- **No account contention, and the one real sharing hazard is already documented.** The spike ran ~15 turns on a copied `CODEX_HOME` while the cross-model review gates ran `codex exec` against the live one throughout; no auth failure, no 429, no session conflict. The thread writer lock is per-thread within one `CODEX_HOME` and never crossed. `usedPercent` on the subscription's 7-day `codex` window (plan `pro`) did not move off 5 across the whole spike, so the token difference between the two shapes is **below the meter's resolution** — a second reason the cost case cannot carry the decision. The hazard that does exist is the one `trident/codex-credential.ts:396-399` already names: codex rotates the refresh token on refresh, so two independent `auth.json` copies of one account revoke each other. The spike shared the file by reference for exactly that reason, and the spec item makes it a rule.
- **Not established.** Whether `codex app-server proxy` and the unix control socket work at all — 20 minutes produced silence, not a proof of breakage. And no rate limit was ever approached, so "the limit is per-account rather than per-`CODEX_HOME`" is untested; it was never reached, not shown to be shared.

### 2026-09-12 — A ROOT `AGENTS.md` IS INTENDED AND NO LONGER BANNED, and the owner's slug is ruled NOT SENSITIVE. Two structural rulings, both narrowing the leak gate's Tier-3 path list. **Supersedes the K10 clause below** ("STATUS.md/ISSUES.md/CLAUDE.md/AGENTS.md stay banned") for `AGENTS.md` only; the other three stay banned and all Tier-1/Tier-2 content rules are unchanged.

- **A root `AGENTS.md` is now permitted, because the entry was guarding an empty set.** `FORBIDDEN_EXACT` reserved four root paths as carve tripwires against a private sibling repository's root docs re-entering this public tree. Three earn it — `STATUS.md`, `ISSUES.md` and `CLAUDE.md` all exist at that root today, one of them 1.48 MB of issue tracker. A root `AGENTS.md` has **never** existed there: `git log --all -- AGENTS.md` in that repository returns zero commits. So the entry protected against a file that has never been written, while blocking the one this tree needs — `AGENTS.md` is what a non-Claude harness reads, and with Codex as a project REPL in pre-cutover scope, a self-hoster cloning this tree had no repo-wide instruction file at all. The 32 `AGENTS.md` files already here are per-directory and apply only once you are inside those directories, which is exactly when you no longer need orientation. Precedent is the K10 clause itself: a root `SPEC.md` was banned by this list until K10 introduced one deliberately, at which point the entry was removed and the comment rewritten to say why. The condition for restoring it is recorded in the gate: if that repository ever grows a root `AGENTS.md`, put it back.
- **The owner's slug is not sensitive.** It appears in 17 tracked files on this public tree — 9 tests, 5 production sources, plus this file, the frozen as-built log and one plan doc — and it reaches CI logs, which are public on a public repo. Filed 2026-08-17 as a public-exposure question rather than a defect and deliberately left open rather than guessed; put to the owner 2026-09-12 and ruled **not sensitive**. No files are rewritten, no gate rule is added, and the CI-log exposure is accepted rather than mitigated. The related open question is also settled, and in the unflattering direction: the slug does not appear in `scripts/ci/leak-gate-allowlist.txt` and the gate carries no rule matching a bare slug, so `purity` was green because nothing looked for it — not because something waved it through.
- **Found by the cross-model gate, which is the part worth recording.** The un-ban shipped with two documents left asserting the ban — this file's K10 clause (correct as history, misleading as current state) and the work-tracking standard's own parenthetical (simply false). A Codex cross-model review of the merged diff surfaced both, plus a stale count in the selftest's timeout rationale. That is the failure mode `docs/agent-legible-architecture.md` § 1 names — a guard delivered in prose that the code does not implement — committed by the change that was documenting it. The lesson taken: a change that narrows a gate must grep for every document asserting the old rule, in the same PR.

### 2026-09-12 — THE WORK QUEUE LEAVES THIS FILE. `Phases → Steps` is split into `docs/spec-items/`, one file per item, indexed at `docs/spec-items/README.md`. Owner-directed. Standard: [`docs/process/work-tracking.md`](docs/process/work-tracking.md) §5 step 1.

- **Why.** The section was 817 lines — 63% of this file — holding an architecture record of what shipped and a task queue of what had not. Different lifetimes, different readers: the standard's §1 rule is one owner per fact, and a single document doing both jobs does both worse. The queue is now `docs/spec-items/`; this file keeps architecture, constraints and this log.
- **The queue was lying, which is what forced the split rather than a move.** All 31 open entries were verified against the tree. **Ten had already shipped and still read `[ ]`** — the outer publisher's rebased-branch push (#259/#275), publish-failure evidence (#259), gateway-restart recovery (#267), infra auto-retry (#367), pre-provisioning credential scope (#266), Work Board item removal (46f18bb1), the deploy-ref resolution (#245 — which carried "✅ RESOLVED" text *inside its own unchecked box*), the stranded preserved worktree, the build heartbeat (#534), and the Email P1 pipeline (176e789c/#214). They are removed here; git history and `docs/as-built/` are their record.
- **Four surviving items carried claims the code had since falsified**, corrected at the top of each item rather than softened: the credential item's "ONLY THING BLOCKING BUILDS" (PR #248 removed the push from the agent contract entirely, `trident/inner-workflow.mjs:1337-1343`); the Email cutover's return-to-inbox learning loop, cited as "live and closed" at a line that is a page-budget constant and with no such loop anywhere in the Core; the card-pulse item's block on a heartbeat that had already shipped; and the backup scheduler's blocker, whose store is wired (`open/composer.ts:3975`) leaving only the loop.
- **22 items, not 31.** 20 still-wanted, plus one marked `needs_spec` (its follow-ons were never enumerated, so it is not buildable as it stands), plus one new item split off an otherwise-done entry whose owner-visibility acceptance was never wired.
- **The index is generated, never hand-maintained** (`scripts/spec-items-index.ts`), and a test fails the build when the committed rollup drifts from it — the standard's §6 trap is explicit that a split without a live index is all of the cost and none of the benefit.
- **Ownership of this file is now split explicitly** (governance preamble, amended above): the owner owns the Decisions Log and the architecture body; agents maintain the spec-items queue. The previous blanket "agents NEVER rewrite it" described a file that also held the queue, and no longer matched what agents are required to do.

### 2026-09-11 — THE HARNESS-ORCHESTRATOR PIVOT. Owner-locked in the Neutron Coding strategy session; this repo's `SPEC.md` is now the single home for it (the Managed repo keeps one-line pointers only, Decisions Log 2026-09-11 there). Detail: [`docs/plans/harness-orchestrator-pivot-2026-09-11.md`](docs/plans/harness-orchestrator-pivot-2026-09-11.md).

- **What Neutron is: a harness orchestrator.** The owner: *"a layer that sits above [Claude Code, Codex, opencode, pi …], providing memory, crumbs, document grouping, projects, application-specific cores … a way of interacting with harnesses more efficiently, or more beautifully, than SSHing in."* Not a harness. Not a web/mobile front-end on someone else's daemon. **No not-invented-here:** where the community already does a thing better, adopt it; where it doesn't (measured 2026-09-11: herdr's plugin ecosystem is 1,112 repos, 78% under 5★, centred on *looking at* agents — 291 UI/status repos vs 17 memory, the one real memory plugin ships with its recall hook disabled), Neutron owns it.
- **The project REPL is the orchestrator.** One per project, long-lived, model-switchable in place. It holds the conversation, runs the build, and is the **only** thing that ever asks the owner a question — in the chat, as part of the conversation. Supersedes the shared-launcher-REPL model (one process hosting every run's workflows), whose poison-eviction chain was 33% of trident deaths (#501, merged 2026-09-11).
- **Bounded work splits on MODEL, not on kind.** Same model as the REPL → a subagent inside it (warm cache, shared MCP; the alternative measured at ~24k cache-read tokens per headless job just to warm up). Different model → a headless worker of the other harness: input in, result back to the orchestrator, **never to the owner**; if blocked it returns "blocked on X" and the orchestrator decides. Both harnesses have first-class subagents (Claude Code `Agent`; Codex multi-agent v2 — TOML agents, `spawn_agent`, `send_message`/`followup_task`).
- **Persistent-per-harness vs one-shot headless for recurring cross-model work is decided by a SPIKE**, the owner's criterion verbatim: *"If it's going to be riddled with bugs and all fucked up like our trident workflow so far, then we should just one-shot headless each time. If it can be built EASILY and will be robust, then the shared repl is better for cost reasons."* Test: a persistent codex session on the ChatGPT subscription that (a) takes follow-up turns reliably, (b) survives a gateway restart and resumes, (c) completes an approval round-trip. All three, no fragility → persistent; else headless per call.
- **Owner questions flow from exactly one place: the orchestrator, in chat.** A proposed emit/checkpoint/resume protocol between headless stages and the owner's surface is **withdrawn** as over-engineering — it solved a problem created by making every stage headless.
- **Planning is a conversation that writes a spec. Nothing more.** *"We don't need to invent shit like 'planning mode'."* "Go" is the same REPL starting to orchestrate against that document.
- **Harness capability abstraction is NARROW and via PASS-THROUGH, not a lowest-common-denominator seam.** Do not abstract goals/loops/heartbeats/compaction — two of fifteen harnesses have a `/goal` and they mean different things. Neutron owns the loop; the harness owns the turn; harness-native features reach the owner by pass-through when available. **First concrete pass-through: in-place model switch**, with a web/mobile affordance (current model · available models · switch) and per-harness code behind it. Verified 2026-09-11: Claude Code `/model` mid-conversation, context preserved (caches are model-scoped — write the spec to disk and `/compact` before switching down); Codex `/model` mid-session, context preserved since v0.117.0, effort/fast/tier independently switchable; **Astra = `gpt-6-astra`**, `/model`-selectable since codex 0.153.1, but **Trusted-Access-gated and API-metered as of 2026-09-10** — owner checks his own access. Today nothing in the Claude Code adapter or live-turn path handles a leading `/`; chat text is injected as a message via the dev-channel MCP. Green field.
- **Herdr is the REPL container; the opaque PTY host goes.** Owner's hard cutover gate: *"i dont want to cutover until we've pivoted to using herdr as the underlying REPL container instead of this opaque PTY thing."* Neutron is the layer above (herdr is a substrate Neutron hosts sessions under, not the reverse); the owner must always be able to `herdr session attach` and move seamlessly between herdr and Neutron — a capability he had with the legacy system's tmux and lost (`activity-inspector.ts:4-7`: "no equivalent at all"). Herdr's durability, verified from source at `herdrdev/herdr` `master` 2026-09-11: background server keeps terminals alive across client close / SSH loss; on session restore, agent panes are re-launched into their native sessions (`src/agent_resume.rs` `plan()` `:136`; `resume_agents_on_restore` **defaults true**, `src/config/model.rs:270`, applied `src/persist/restore.rs:788`). herdr 0.8.2 is installed for the owner's service user with its server running.
- **The billing premise behind the PTY was measured false.** Headless `claude -p` on the owner's Max OAuth draws from the subscription's 5h/7d windows: three bounded jobs, ~51k output tokens, 5h window 0.82→0.86, 7d 0.64→0.65, rises aligned on job boundaries, no API key present anywhere on the box, extra-usage off. The announced June-15 metering that justified interactive-only was paused and never took effect. Full record: Managed Decisions Log 2026-09-11.
- **Trident is rebuilt on this shape — keep the gates, replace the loop.** Measured 2026-09-11: 291 runs → 208 failed / 74 stopped / 9 done; the 9 all merged **by hand** (GitHub `mergedBy` = owner on every one), all within 2026-08-15→18, none since. Owner's definition of flowing (`docs/getting-to-flow.md`): *a card is dispatched and reaches merged with no human touching it.* That number has always been 0. Failure taxonomy: 38 hang-reaps, 26 "fire turn did not settle in 3 min", 74 cancelled, 21 round-1 rollbacks, 13 rebase conflicts — control flow living inside an LLM turn on a shared REPL. The gates (leak preflight, pinned merge, cross-model gate, seat rotation, mutation prover, arbiter rule) are ahead of every shipped system and stay.
- **Scope before the cutover:** Claude Code and Codex working as the project REPL/orchestrator; trident working on the new shape; the migration (private one-time tooling, last pushed 2026-08-07) re-run against current Open. **Post-cutover increments:** pi and further harnesses; the full per-harness switching surface; web/mobile rough edges *as long as trident works*. The cutover definition, owner's words: *"live means I'm using Neutron instead of the legacy system every day for everything."*
- **Build home:** a herdr session on the VPS against this checkout. The Telegram strategy topic no longer dispatches builds. The old trident is not used to build its own replacement.

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
