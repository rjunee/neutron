# AGENTS.md — scribe

This module owns the per-project scribe budget + entity-extraction pipeline. The prompt itself is lifted from Nova's `prompts/scribe.md` (parameterized for the instance home in Sprint 2). Writes to `<instance-home>/entities/`; per-project budget tracked in the `scribe_budget` table of the project database. Implementation lands in P1.

It must NOT cross instance boundaries or share budget state across instances. Budget reset is per-day, per-instance.

**Compiled-truth is append-only BY DEFAULT — with one flag-gated exception (RB4).** The base rule stands: a sparse chat turn never overwrites or retracts a richer existing page; new facts land in the append-only timeline, and only genuinely-new relationship sentences are appended to compiled-truth (see the `write-to-gbrain.ts` module header). The SOLE exception is RB4 temporal invalidation (belief evolution), gated behind the shared `NEUTRON_PERFECT_RECALL` flag: when a relation carries an explicit `supersedes` marker AND the flag is on, the superseded `(predicate, prior-object)` SENTENCE is removed from compiled-truth so the current truth (and the gbrain edge) reflect the change — while the append-only **timeline keeps the full dated history** (the original assertion at its original date + a dated supersession note), so no history is ever lost. Flag OFF → pure accretion, exactly as before. No other path may rewrite existing entity prose.

Cross-refs: Nova's `prompts/scribe.md` (lift target), `docs/engineering-plan.md § B.P1`.
