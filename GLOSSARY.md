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

> Note: these are lineage/provenance names only. They do **not** name any live
> module, package, or API in this repo — every shipped surface is under the
> `neutron` / `@neutronai/*` namespace.

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

Everything above decodes lineage codenames. This section decodes LIVE names — columns, fields
and markers in this repo whose plain English reading asserts something the system does not
mean. Each entry: the name, what a reader assumes, what it actually means. Added 2026-08-31
with the provenance-spine encoding (`docs/INVARIANTS.md` §12–§13); where a fix exists it is
named — otherwise assume the false reading is still load-bearing.

- **`last_advanced_at`** (`code_trident_runs`; `trident/store.ts:523-527`) — reads as "when
  this run last showed life". Actually stamped at checkpoint boundaries only; a long build
  round never re-stamps it, so a live build looks dead for the whole round. Mid-phase stage
  events (`latestStageEventAt`) are the liveness evidence this column is not.
- **`inner_verdict = 'REQUEST_CHANGES'`** (`trident/store.ts`) — reads as "a reviewer
  rejected this work". Historical rows carry it on runs that never reached review. The store
  now refuses that write (`TridentEmptyFindingsRejectionError`); old rows still lie.
- **`REVIEW_NOT_RUN`** (`trident/store.ts:49`) — reads as "this run failed before review".
  Actually "no reviewer verdict was recorded on this row" — it appears on runs that built
  and published successfully; it marks missing review evidence, not a failed build.
- **`connected`** (`gateway/cores/integrations.ts:155`) — reads as "this credential works
  right now". For API-key slots it is a stored presence check, not a probe: a revoked token
  reads `connected: true` until something exercises it. (OAuth slots do a live read; see the
  note at `:412`.)
- **`mergeable` / `MERGEABLE`** (GitHub PR field, consumed via `trident/gh-authed.ts`) —
  reads as "safe to merge". Actually "no textual conflict when GitHub last computed it": it
  says nothing about whether checks are still valid, so it reads true while the run's own
  tests predate the change that invalidated them.
- **empty `inner_checkpoint_findings`** (`trident/store.ts`) — reads as "the review found
  nothing wrong". Actually "the run never reached review": an empty findings list is an
  infrastructure outcome, never a clean bill of health.
- **`finished`** (`runtime/subagent/registry.ts:18`; agent dispatch) — reads as "the
  dispatched run did its job". Actually "the process ended": runs have been recorded
  `finished` having produced no artefact at all. Evidence of output is not part of this
  status today.
- **`CODEX_BUILD_BRANCH_UNBOUND`** (`trident/codex-build.sh:1165`) — reads as an executor
  fault ("the build could not bind its branch"). Actually a refusal because a leaked
  worktree still holds the branch: the message now names the holding worktree, but the token
  still points a reader at the wrong layer.
