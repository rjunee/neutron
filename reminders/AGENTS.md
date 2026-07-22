# AGENTS.md — reminders

The instance-scoped reminder engine (`@neutronai/reminders`) AND the
approval-gated ritual executor built on top of it. Backed by the per-project
`reminders` table + the `code_ritual_runs` history table (migration 0106). All
fire-time text is composed at fire time, never pre-rendered.

## What this module owns

**Reminder engine:**
- `store.ts` — CRUD over the `reminders` table + the cadence model: a row is
  one-shot, or recurring via ONE of a COARSE `recurrence` label XOR a
  `recurrence_spec` 5-field cron (mutually exclusive; `isRecurring()` is the
  single predicate). Optional `ritual_id` write/read path (charset-guarded).
- `tick.ts` — a single-flight `setInterval` that CLAIMS each due row before
  dispatch (crash-safe at-most-once), advances it via `computeNextFire`, and
  routes a `ritual_id` row to `ritual_executor.fire()` (awaited inside the tick
  quiescence boundary).
- `dispatcher.ts` + `message-shape.ts` — the three fire-time message shapes
  (literal / smart-wrap `[smart]` / pattern-template `PATTERN:`), composed on a
  Haiku-class turn with live context, degrading to a literal fallback so a
  reminder ALWAYS delivers.
- `context.ts`, `prompt.ts`, `prompt-path.ts`, `reminder-agent-base.md` — the
  fire-time agent's context sources + base prompt.

**Ritual executor:**
- `rituals.ts` — `RitualDef`, `createRitualRegistry`, the fail-closed async
  `validateRitualFire`, and `GATED_WRITE_TOOLS` (Bash/Write/Edit/MultiEdit/
  NotebookEdit stay fire-time-gated).
- `ritual-approval.ts` — `computeRitualContentHash` + `createRitualApprovalCheck`
  (re-verifies the hash from LIVE file bytes on every fire; an owner edit or a
  surface/cadence widening drops approval by design).
- `ritual-executor.ts` — claim → validate → durable `code_ritual_runs` row →
  ritual-lane spawn (detached turn) → terminal bookkeeping. Never throws once a
  durable row exists.
- `ritual-delivery.ts` — completion delivery, one-line failure notices,
  3-consecutive-failure escalation, boot-reap of orphaned `running` rows, 30d
  prune.
- `ritual-runs.ts` — the `code_ritual_runs` writer.
- `ritual-registration.ts` — the agent-callable propose/enable/approve/capture
  service. `propose` creates a BRAND-NEW ritual; `enable(id, schedule)` gives an
  ALREADY-REGISTERED ritual (a bundled example or a persisted def) a schedule +
  approval by reading its seeded/owner `<id>.md` and writing ONLY the
  `<id>.def.json` (`propose` refuses a bundled id — its `.md` already exists). Both
  share one `requestApprovalAndEmit` tail: `renderRitualApprovalBody` (the
  security-carrying rendering), content-hash-bound grant, full rollback on any
  emit failure. `handleOwnerButtonAnswer` is the turn-start capture +
  schedule-on-approve. Surfaced as the reminders-Core `rituals_propose` /
  `rituals_enable` / `rituals_status` MCP tools.
- `bundled-rituals.ts` + `rituals/*.md` (`morning-brief`, `evening-wrap`,
  `daily-delta`) — seeded copy-if-absent into `<owner_home>/rituals/`, registered
  UNAPPROVED on boot with NO `.def.json` (no schedule). They become usable ONLY
  via `rituals_enable` (the sole approval + scheduling path for a bundled id).
  `ritual-agent-base.md` — the ritual substrate base prompt.
- `index.ts` — the barrel export.

## What this module must NOT do

- NOT emit cron timers / launchd / systemd units — `cron/` owns timer + service
  emission. This module only reads a cron spec to compute the next fire instant.
- NOT call a channel directly — all delivery goes through the gateway `deliver()`
  seam.
- NOT hold approval state of its own — approval lives in `tools/approval.ts`
  `ApprovalManager`; this module reads/records grants through it.
- NEVER auto-approve a ritual or widen a surface/cadence without re-approval. The
  content hash enforces this; do not add a bypass.
- Writing/Bash ritual surfaces (`GATED_WRITE_TOOLS`) stay fire-time-gated until
  the OS-level sandbox sprint ships (T5 spike verdict UNPROVABLE, 2026-07-21).
  Read-only rituals ship under Layer 1 (`--tools` default-deny).
- NO feature flags — the reminder engine and the ritual executor are the single
  live default path.

## Cross-refs

- `docs/SYSTEM-OVERVIEW.md` — the "Reminders" and "Ritual executor" sections.
- `docs/plans/executor-mode-reminders-2026-07-20.md` — the design spec + the T5
  write-containment spike verdict (lines 254-278).
