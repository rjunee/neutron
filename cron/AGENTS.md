# AGENTS.md — cron

This module owns the cron scheduler — systemd `.timer` / `.service` pairs emitted from `cron/jobs.yaml` (Zone A: declarative job definitions) plus a per-project enabled-set in the project DB's `cron_jobs_enabled` table (Zone B). Isolated-agent-per-job pattern lifted from OpenClaw `src/cron/isolated-agent/`. Implementation in P1.

It must NOT use launchd (Linux-only deployment per locked `docs/engineering-plan.md § B.P1`), run jobs as root (per-instance Unix user owns its jobs), or hand-edit systemd units (the `.timer`/`.service` pairs are emitted from `jobs.yaml`).

Cross-refs: `docs/engineering-plan.md § B.P1` (Zone A + Zone B split for `jobs.yaml`).
