# Codename glossary

Neutron Open was carved from a lineage of earlier assistant codebases. Much of
its algorithmic shape — SQLite state, MCP tool surfaces, cron isolation, prompt
libraries, the trident build loop — was **lifted** (ported and re-parameterized)
from those predecessors rather than written from scratch. To keep that
provenance decodable, module docs (`*/AGENTS.md`) and code comments still cite
the upstream system and the exact source file a pattern came from, e.g.:

> Algorithmic shape ports from Hermes `hermes_state.py:115-130`.
> …ports Nova's `rediscoverLiveTopicPanes`…
> Isolated-agent-per-job pattern lifted from OpenClaw `src/cron/isolated-agent/`.

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

## Vajra

The predecessor personal-assistant product (Telegram-based: reminders, tasks,
scribe, and the autonomous **trident** build loop). Neutron ports Vajra's
battle-tested fixes and some markdown-first surfaces:

- **`per Vajra FIX N`** → one of the numbered, battle-tested fixes from Vajra's
  `/trident` SKILL + its Forge/Argus prompts. Each fix is pinned to an
  Open-substrate equivalent, with a regression test, in
  **`trident/vajra-fixes.test.ts`** — the live parity anchor. For example,
  **FIX 9** is the fleet *premature-completion* reconciliation fix (Vajra
  PRs #164 + #160); FIX 8 is the Fable-orchestrator model routing. To decode
  any `FIX N` reference, read the matching `describe('FIX N — …')` block in that
  file.
- `tasks/` — the markdown-first task surface is modelled on Vajra
  (`~/vajra/tasks.md`, `task-scanner.py`), but here the SQLite `TaskStore` is
  the source of truth and the markdown is a pure projection.

`trident/vajra-fixes.test.ts` and other test parity anchors keep the Vajra names
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

## OpenClaw

A substantial **TypeScript** predecessor — a Claude-Code-based agent harness.
Neutron lifts several of its runtime patterns:

- `cron/` — the isolated-agent-per-job pattern is lifted from OpenClaw
  `src/cron/isolated-agent/`.
- `tools/` — the per-instance exec-approval gates port OpenClaw's
  `bash-tools.exec-approval-{request,followup}.ts` (the 4-runtime-seam shape).
- `mcp/` — the channel bridge is lifted from OpenClaw `src/mcp/channel-bridge.ts`;
  Neutron's three-surface tool factoring (`neutron-tools / core-tools /
  channel-tools`) mirrors OpenClaw's (`openclaw-tools / plugin-tools /
  channel-tools`).
- `reminders/` — the JSONL session-write-lock pattern follows OpenClaw's.

---

## What is scrubbed vs kept

- **Kept** — codenames in test parity anchors (e.g. `trident/vajra-fixes.test.ts`)
  and in `*/AGENTS.md` / code comments where the name cites a real upstream
  source file (`lifted from Hermes hermes_state.py:…`). These carry live
  traceability; removing them would destroy it. Decode them here.
- **Scrubbed** — bare codenames in the **published** `cores/sdk/` contract
  (doc comments + `SDK-CONTRACT.md`), where "Topline" was confusing residue with
  no in-repo pointer to follow; the concrete reference Core (`dtc-analytics`) is
  named directly instead.
