# AGENTS.md — scribe

This module owns the per-project scribe budget + entity-extraction pipeline. The prompt itself is lifted from Nova's `prompts/scribe.md` (parameterized for the instance home in Sprint 2). Append-only writes to `<instance-home>/entities/`; per-project budget tracked in the `scribe_budget` table of the project database. Implementation lands in P1.

It must NOT cross instance boundaries, rewrite existing entity files (append-only is a hard rule), or share budget state across instances. Budget reset is per-day, per-instance.

Cross-refs: Nova's `prompts/scribe.md` (lift target), `docs/engineering-plan.md § B.P1`.
