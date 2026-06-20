# AGENTS.md — persistence

This module owns the per-project SQLite layer: `ProjectDb.open(path)` opens a `bun:sqlite` connection with the locked PRAGMA set (WAL + FK + synchronous=NORMAL + temp_store=MEMORY + cache_size=-64000 + busy_timeout=100), exposes prepared-statement / `transaction()` / `pragma()` wrappers, routes writes through the jittered busy-retry helper in `retry.ts` (15 retries, 20–100 ms jitter, async via `await Bun.sleep` so the gateway watchdog tick keeps firing during contention), and serialises all `run` / `exec` / `transaction` calls on a per-instance async mutex so a concurrent caller cannot leak into an open BEGIN/COMMIT window. Algorithmic shape ports from Hermes `hermes_state.py:115-130` (internal design notes § 2 lift target); concurrency tuning constants tightened from Hermes' Python defaults — rationale in `retry.ts` head comment.

It must NOT contain schema definitions (those live in `migrations/`), instance routing (gateway), or any per-table query helpers. Higher-level callers (gateway, runtime, scribe, gbrain-memory adapter, reminders) compose this module's primitives — they don't bypass it to touch `bun:sqlite` directly.

Cross-refs: `docs/engineering-plan.md § B.P1`, `docs/plans/instance-boundary-spec.md`, internal design notes.
