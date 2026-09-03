# Codename glossary

Neutron Open was carved from a lineage of earlier assistant codebases. Much of
its algorithmic shape — SQLite state, MCP tool surfaces, cron isolation, prompt
libraries, the trident build loop — was **lifted** (ported and re-parameterized)
from those predecessors rather than written from scratch. To keep that
provenance decodable, module docs (`*/AGENTS.md`) and code comments still cite
the upstream system and the exact source file a pattern came from, e.g.:

> Algorithmic shape ports from Hermes `hermes_state.py:115-130`.
> …ports Nova's `rediscoverLiveTopicPanes`…
> Isolated-agent-per-job pattern lifted from Legacy-agent `src/cron/isolated-agent/`.

Those citations are **intentional traceability** — they are not scrubbed. This
file is the decoder ring for the codenames they use.

> Note: the codenames below are lineage/provenance names only. They do **not**
> name any live module, package, or API in this repo — every shipped surface is
> under the `neutron` / `@neutronai/*` namespace. The final section is the one
> exception, and it is here because this file is where a reader already comes to
> find out what a name really means.

> Second decoder, added 2026-08-31: ["Names whose plain reading is
> false"](#names-whose-plain-reading-is-false) at the foot of this file covers the opposite
> problem — **live** names whose plain English reading asserts something the system does not
> mean. Read it before trusting any status column or terminal token.

---

## Nova

The immediately-prior generation of the Telegram-native assistant. Neutron's
**prompt library** and several engine behaviors were lifted from Nova:

- `prompts/` — the Atlas / Argus / Sentinel / Forge / Scribe / reminder-agent
  prompt set is a lifted-and-parameterized copy of Nova's prompt library
  (hardcoded home paths swapped for `{{OWNER_HOME}}` template variables).
- `runtime/adapters/claude-code/persistent/repl-agent-base.md` — lifted
  independently from Nova's base rules.
- `gateway/` — the orphan-adoption logic ports Nova's `rediscoverLiveTopicPanes`.
- `tasks/focus-score.ts` — a deterministic Nova-equivalent focus score.
- `mcp/` — Neutron deliberately runs **one** MCP server per instance
  (multiplexed across topics) instead of Nova's per-topic shape (a ~10×
  resource saving); comments that say "that was Nova's shape; replaced" mark
  the intentional divergence.

A "lift, not a rewrite" from Nova is expected to preserve observable behavior
(gated by the behavioral-spec suite at the M1 cutover).

## the legacy harness

The predecessor personal-assistant product (Telegram-based: reminders, tasks,
scribe, and the autonomous **trident** build loop). Neutron ports the legacy harness's
battle-tested fixes and some markdown-first surfaces:

- **`per the legacy harness FIX N`** → one of the numbered, battle-tested fixes from the legacy harness's
  `/trident` SKILL + its Forge/Argus prompts. Each fix is pinned to an
  Open-substrate equivalent, with a regression test, in
  **`trident/legacy-fixes.test.ts`** — the live parity anchor. For example,
  **FIX 9** is the fleet *premature-completion* reconciliation fix (the legacy harness
  PRs #164 + #160); FIX 8 is the Fable-orchestrator model routing. To decode
  any `FIX N` reference, read the matching `describe('FIX N — …')` block in that
  file.
- `tasks/` — the markdown-first task surface is modelled on the legacy harness
  (`~/legacy/tasks.md`, `task-scanner.py`), but here the SQLite `TaskStore` is
  the source of truth and the markdown is a pure projection.

`trident/legacy-fixes.test.ts` and other test parity anchors keep the the legacy harness names
on purpose — scrubbing them would break the fix-by-fix traceability.

## Topline

The first-party direct-to-consumer (DTC) **analytics** initiative that drives
the Cores SDK's requirements. Its reference Core is **`dtc-analytics`** — a
Shopify / Google-Ads / Meta-Ads connector Core that materializes CM/MER
dashboard metrics into derived tables (and ships an isolated DuckDB analytical
store). It is the concrete "how to write a first-party Core" example throughout
`cores/sdk/`.

The published `cores/sdk/` contract now names the reference Core directly
(`dtc-analytics`) rather than the bare "Topline" codename. The name still
appears as a sample project slug (`'topline'`) in the `cores/sdk/__tests__/`
fixtures — those are parity fixtures and are left untouched.

## Hermes

An earlier **Python** implementation of the assistant. Neutron's storage and
tooling layers port Hermes' algorithmic shapes:

- `migrations/0001_initial_schema.sql` — the sessions + messages + FTS5 + WAL
  schema is lifted from Hermes `hermes_state.py:30-110` (Neutron columns added
  inline).
- `persistence/` — the busy-retry / concurrency shape ports from Hermes
  `hermes_state.py:115-130`, with the tuning constants tightened from Hermes'
  Python defaults.
- `mcp/` — the tool surface mirrors Hermes `mcp_serve.py`'s 9-tool shape.
- `tools/` — the zero-config auto-discovery registry is lifted from Hermes
  `tools/registry.py`.

## Legacy-agent

A substantial **TypeScript** predecessor — a Claude-Code-based agent harness.
Neutron lifts several of its runtime patterns:

- `cron/` — the isolated-agent-per-job pattern is lifted from Legacy-agent
  `src/cron/isolated-agent/`.
- `tools/` — the per-instance exec-approval gates port Legacy-agent's
  `bash-tools.exec-approval-{request,followup}.ts` (the 4-runtime-seam shape).
- `mcp/` — the channel bridge is lifted from Legacy-agent `src/mcp/channel-bridge.ts`;
  Neutron's three-surface tool factoring (`neutron-tools / core-tools /
  channel-tools`) mirrors Legacy-agent's (`legacy-agent-tools / plugin-tools /
  channel-tools`).
- `reminders/` — the JSONL session-write-lock pattern follows Legacy-agent's.

---

## What is scrubbed vs kept

- **Kept** — codenames in test parity anchors (e.g. `trident/legacy-fixes.test.ts`)
  and in `*/AGENTS.md` / code comments where the name cites a real upstream
  source file (`lifted from Hermes hermes_state.py:…`). These carry live
  traceability; removing them would destroy it. Decode them here.
- **Scrubbed** — bare codenames in the **published** `cores/sdk/` contract
  (doc comments + `SDK-CONTRACT.md`), where "Topline" was confusing residue with
  no in-repo pointer to follow; the concrete reference Core (`dtc-analytics`) is
  named directly instead.

---

## Names whose plain reading is false

Everything above decodes **lineage** codenames — names from predecessor systems that no longer
name anything live. This section decodes the opposite hazard: **live** names, in this repo, whose
plain English reading asserts something the system does not mean. They are collected here because
an agent driving this system reads a status column or a token and acts on what it says; a name
that lies is an incident with a delay fuse.

Each entry gives the name, what a competent reader assumes, and what it actually means. Where a
fix exists it is named; otherwise assume the false reading is still load-bearing. The contract
these entries are being moved toward is `docs/INVARIANTS.md` §12 (the honesty contract) and §13
(the action contract); a name below that survives is a line in §12 that is not yet closed.

- **`last_advanced_at`** (`code_trident_runs`) — reads as "when this run last showed life".
  Means "when this run last crossed a checkpoint boundary". Mechanically it is stamped on EVERY
  store write (`trident/store.ts:999`), but a long build round performs none, so in practice it
  moves only between phases: it is "stale by construction during a long Forge step, so a reaper
  keyed on it asks 'has a phase ended recently', not 'is anything alive'"
  (`trident/store.ts:562-567`; same reasoning at `trident/liveness.ts:24`). Mid-phase stage events
  are the positive liveness evidence this column is not.
- **`inner_verdict = 'REQUEST_CHANGES'`** (`trident/store.ts:49`) — reads as "a reviewer read this
  work and rejected it". On historical rows it is also written when the run never reached a
  reviewer at all. New writes with an empty findings list are now refused at the store
  (`TridentEmptyFindingsRejectionError`, `trident/store.ts:58`); rows written before that guard
  are deliberately not rewritten, because they are the measurement evidence
  (`migrations/0138_code_trident_runs_review_not_run.sql:4-8`). The guard binds in-process writers
  only — `checkpoint.sh` updates the same column with raw out-of-band SQL (`trident/checkpoint.sh:182`)
  and bypasses it by construction, pinned as a known bypass by `trident/store.test.ts:1053`.
- **`REVIEW_NOT_RUN`** (`trident/store.ts:49`) — reads as "the run failed before it built
  anything". Means only "no reviewer produced a verdict on this row": per `trident/store.ts:147-152`
  it covers crash, infrastructure stop, provenance reject or a lost round, and "it is never a
  judgement about the code". It appears on runs that built and published successfully.
- **empty `inner_checkpoint_findings`** (`trident/store.ts:146`) — reads as "the review found
  nothing wrong". Means "no findings were recorded", which is most often "the run never reached
  review". An empty finding set is an approval or an infrastructure outcome, never a rejection —
  that sentence is the refusal message itself at `trident/store.ts:60`.
- **`finished`** (`SubagentStatus`, `runtime/subagent/registry.ts:18`) — reads as "the dispatched
  agent did the job". Means "the process ended without crashing or being cancelled":
  `agent-dispatch/service.ts:538-547` maps a completed turn to `finished` with no reference to any
  artefact, and `:654` supplies the summary "Dispatch finished (no summary text returned)". A
  dispatch that produced nothing at all is recorded `finished`.
- **`connected`** (`gateway/cores/integrations.ts:155`) — reads as "this credential works right
  now". For API-key slots it is a presence check against the stored rows, not a probe — see the
  docblock at `:409-413`. A revoked key reads `connected: true` until something exercises it.
  (OAuth slots do a live read, so the same field carries two different grades.)
- **`mergeable` / `MERGEABLE`** (GitHub PR field; read via `trident/gh-authed.ts:46-52`, probed at
  `trident/inner-workflow.mjs:4708-4712`, consumed at `:4061-4065`) — reads as "safe to merge".
  Means "no textual conflict, when GitHub last computed it". It says nothing about whether the
  checks attached to the PR still describe the current head, and GitHub does not expose WHEN it
  computed the value — so a consumer cannot even state an age bound on it.
- **`phase = 'done'`** (`code_trident_runs`) — reads as "this run's work shipped". Means "this run
  reached its own terminal success phase". The two diverge in both directions: work lands in
  `main` from runs recorded failed, because the merged PR was squashed and ancestry no longer
  finds the run's head. Shipping is membership of the run's head in the commit list of a merged
  PR the run claims, not `git merge-base --is-ancestor` (`docs/INVARIANTS.md` #127).
- **`isolation: 'worktree'`** (`trident/inner-workflow.mjs:6199`, `:6520`) — reads as "the build
  runs in isolation". Means "the build runs in a separate working tree inside the same
  repository": `trident/merge.ts:906` places it at `<repo>/.trident-worktrees/<slug>-<id8>`, so it
  shares the git object store, the ref namespace, `node_modules`, the process environment and the
  temp directory with the checkout it was cut from. It is a directory boundary, not a sandbox.
- **`CODEX_BUILD_BRANCH_UNBOUND`** (`trident/codex-build.sh`, eight emission sites) — reads as an
  executor fault ("the build could not bind its branch"). Is one token over at least three
  unrelated causes: the branch is held by the SHARED main checkout (`:1165`), or by another
  worktree — either with a live process observed (`:1183`) or with no way to prove one absent
  (`:1187`) — or an ordinary `ls-remote`/checkout/create failed with no worktree involved
  (`:1205`–`:1232`). Each message names its own cause and the refusal is cheap ("DEFERRED before
  any tokens were spent"); the token a reader greps for names the executor for all eight and sends
  them to the wrong subsystem. A stale worktree that no longer exists is pruned silently and emits
  nothing.
- **`capability_gate`** (`mcp/server.ts:78`) — reads as a gate. Is not one: the default is
  `?? (() => true)` and the sole production construction site passes no gate
  (`gateway/composition/build-core-modules.ts:360-364`). The source says so — "LOG-ONLY … it does
  NOT gate dispatch" (`:125-128`), "Allow-all in production today" (`:169`). The throw at `:138-141`
  is unreachable in production. Do not read a tool call as authorised because this exists.
- **`declared_surfaces`** (`work-board/store.ts:70-71`) — reads as "the paths this card declares it
  will write". Its own comment says "Null means undeclared (and later gates fail safe)", and it is
  null on the live cards. An optional declaration field is an empty declaration field.
- **a bare `{ ok: true }`** (`work-board/agent-tool.ts:153-155`) — reads as "the change was
  applied". Means "no error was thrown". The same value is returned when a write landed and when
  it did not, and at `:456-457` the reorder path discards the store's result entirely. See
  `docs/INVARIANTS.md` #129.
- **`outer-published:<head>:<remaining>:<round>`** (`trident/orchestrator.ts:3659`) — reads as a
  checkpoint name. Is four facts packed into one colon-delimited string in a TEXT column, in a
  database with a schema; a fifth (`:deviated`) is an optional suffix. Anything parsing it is
  re-deriving state that should have been read.
