## 2026-08-31 — bun test scrubs the per-instance env: the local red suite (10 of 16 lanes / 50 files) was the live box's environment, not the code

`bun test` inherits the invoking shell's environment. On a box running a live
Neutron instance that environment carries the instance's own config —
`NEUTRON_DB_PATH` (an absolute host filesystem path to the live `project.db`,
and it wins VERBATIM over `NEUTRON_HOME` in `resolveOpenDbPath`), `OWNER_HOME`,
`NEUTRON_IDENTITY_*`, `NEUTRON_CORES_GOOGLE_*`, onboarding flags. Boot-path
tests therefore resolved the LIVE data home and the migration ownership guard
refused the non-owner runner checkout. That guard was **right**, and is
untouched: the bug was tests reaching `<data-home>/project.db` at all. Measured
2026-08-31: 10 of 16 lanes / 50 files red locally on main while CI — same
runner, none of those vars — was green on the same commit.

Shipped: a second `[test].preload` in `bunfig.toml`,
`tests/support/scrub-instance-env.ts`, which deletes `OWNER_HOME` and every
`NEUTRON_*` var except `NEUTRON_TEST_*` (the runner's own knobs — CI sets
`NEUTRON_TEST_SHARD`, so scrubbing them would create a local/CI divergence) and
points `NEUTRON_HOME` at a fresh per-process scratch dir. Its self-test pins the
behaviour with a poisoned-env child probe and documents the boundary a preload
cannot cross: a default-env spawn hands the child the environ the process
STARTED with, so no `process.env` set or delete propagates. Also fixed:
`persona-loader.test.ts` now pins whole-second mtime stamps (local bun 1.3.13
`mtimeMs` carries sub-ms precision; CI's 1.3.9 does not), and the depcruise seam
test calls the workspace-local `node_modules/.bin/depcruise` instead of a `bunx`
that a bare `bun install` never places.

Measured effect: 10 → 5 red lanes, 50 → 14 files, with the whole live-env
cluster green. The coverage audit stayed intact and ROSE, 1399 → 1405 executed —
never down. Positive control inside the real declared set: one character in a
declared-set file flips `SUITE_EXIT` 0 → 1 over an identical 24-file shard, so
the runner can still go red. The 14 survivors are four named, measured,
non-branch families — real deployment binaries present on the box's filesystem;
two bun 1.3.13-vs-CI-1.3.9 skews (a `Bun.build` race, and
`Requested module is already fetched`); and the owner's `GH_TOKEN` in the
environ spawned children inherit. Each is left loud and recorded as a follow-up:
none was skipped, deleted, or hidden.
