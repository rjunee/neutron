# AGENTS.md — migrations

This module owns the SQLite schema migration layer. Raw `*.sql` files named `<NNNN>_<name>.sql` are applied lexicographically (4-digit prefix is a version), forward-only, idempotent (`CREATE TABLE IF NOT EXISTS` everywhere), tracked in the `_migrations` table. The runner lives in `runner.ts` (~80 LOC, `bun:sqlite`); first migration is `0001_initial_schema.sql`, lifted from Hermes `hermes_state.py:30-110` (sessions + messages + FTS5 + WAL pragma) with Neutron columns added inline (`core_id`, `project_id`, `substrate_instance_id`, `channel_binding_kind`, `channel_binding_address`, `privacy_mode`).

It must NOT include `down` migrations (forward-only is the locked direction per `docs/engineering-plan.md § B.P0` + § E), pull in third-party migration tooling (the runner is small enough to own; cross-validate against `bun-sqlite-migrate` shape but do not depend on it), or ship per-Core data shapes (per-Core tables land in P3 migration files following the same pattern).

Run via `bun run migrations/runner.ts <db-path>` or `bun run migrate <db-path>`. Tested via `bun test migrations/runner.test.ts`.

Cross-refs: `docs/engineering-plan.md § B.P0`, `docs/plans/P0-system-user-data-separation.md § 1.4 + § 1.5`, internal design notes.
