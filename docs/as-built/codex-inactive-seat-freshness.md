## 2026-09-27 — Refresh inactive Codex seats before pool selection

Issue #1361; normative acceptance:
`docs/spec-items/codex-inactive-seat-freshness.md`.

Both credential pool entry points harvested only the incumbent. An inactive
seat's own current rollout could show recovered quota while its persisted
cooldown kept it out of selection. `trident/codex-credential.ts:884` and
`:1488` now harvest every connected global seat before selecting, using the
existing per-seat throttle and connect-time attribution cutoff. Status still
does not persist a selection. Explicit project credentials bypass this pool.

The broadened harvest also requires preserving authentication refusals before
applying quota decisions: `trident/codex-credential.ts:1045` prevents a capped
snapshot from replacing `unauthorized` with a finite usage timer. Gauge readings
can still update; authentication recovery retains its separate existing paths.

Verification: rotation suite 77 pass; root and trident TypeScript checks pass.
The combined credential suite and consuming
`open/__tests__/project-build-e2e.test.ts` completed with 415 pass, zero failures
and 5,001 assertions. Spec-index checks passed 38 tests.
Sixteen new entry-point cases exercise inactive recovery, absent/stale/pre-connect
evidence, newly capped seats, unauthorized healthy and capped readings, throttling
and status pointer preservation. Restoring incumbent-only harvesting failed both
recovery cases (2 failures). Removing freshness and authorization guards failed
all four over-applied recovery controls. Restoring the old late authorization
guard failed both unauthorized-capped controls. All mutations were reverted and
the restored checks passed.

The local full-tree leak scan failed on existing repository denylist matches and
the worktree metadata pointer; it is not represented as a clean purity result.
Publication still requires the normal CI gate.
