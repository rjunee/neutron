## 2026-08-31 — Trident: the 90-min hang watchdog kills on positive quiet, not stale bookkeeping

Measured over the 30 days to 2026-08-31, seventeen runs were terminated with
`no progress for 90 min — suspected agent hang (inner workflow stopped
advancing)` — the second-largest identified failure bucket after `inner-error`.
It was not detecting hangs. In one night it reaped four of the six open PRs
(#479, #480, #481, #484), every one of which was 17/17 green on GitHub at the
moment it died; #480 was a one-line build-config fix already verified by hand.
Earlier, three lanes were reported 57-85 minutes "stale" while writing log
output that same second.

The root cause is that the watchdog read exactly one thing: `last_advanced_at`.
That column is stamped on PHASE transitions, so a Forge round that runs for two
hours doing real work never re-stamps it and a healthy long build is
indistinguishable from a dead one. The check measured bookkeeping, not liveness.

A hang is now declared only on POSITIVE quiet. `trident/run-evidence.ts` holds
the pure decision model: three-valued observations (`activity` / `nothing` /
`unknown`) over three run-scoped probes, and `decideHang` — any in-window
activity stands the run down, otherwise any `unknown` DEFERS, and only
all-quiet-and-fully-observed reaps. `unknown` may never authorise a kill, so an
unreadable artifact directory or an unqueryable process table postpones the
decision instead of manufacturing evidence of death; a gatherer that throws is
recorded as three unknowns rather than as silence. `trident/run-evidence-probes.ts`
supplies the production probes, strongest first: a process-table scan for the run
id in argv with a pid-file fallback that uses a signal-0 existence check and never
delivers a signal; scratch-file and worktree mtimes, where a capped walk is
`unknown`; and branch reflog movement with a tip-committer-date fallback. The
probes are observation-only — nothing anywhere kills by name or by pattern. Every
outcome DISCLOSES what was checked and what each probe answered, on the reap
`reason` and on the stand-down note alike, because a bare "suspected agent hang"
is unfalsifiable and is precisely why seventeen kills went unchallenged. The
gatherer is wired unconditionally at the composition root
(`gateway/composition/build-core-modules.ts`), and the composed suite proves
consultation rather than construction.

The advancement clock is now re-stamped, but only from RUN-SCOPED evidence. A
stand-down authorised by a dead-probe override, a fresh stage row, or a
run-evidence stand-down returns `changed: true`; the tick's `saveIfActive` then
stamps `last_advanced_at` as a matter of course, so the orchestrator returns the
run snapshot unmodified and never touches the column (callers cannot pass it).
Display consumers — the `STALLED_WARN_MS` badge computed in `progressSignature`,
and run-driving — stop reporting phantom staleness with no changes of their own,
the probes fire once per hang window per run instead of once per tick, and a
healthy multi-hour Forge round stops being false-killed at the 2 h ceiling. Two
spares deliberately do NOT re-stamp: a live LAUNCHER, because that probe answers
about a shared generation and not about this run, and a DEFER, because an unknown
check must not manufacture progress. The watchdog still never READS the column as
evidence — each window's reprieve is re-earned from live evidence at decision
time, which moves expiry from next-tick to next-window and no further.

What still reaps, asserted in both directions: a positively quiet run (no
process, no artifacts, no ref movement) dies with all three probe clauses named
in its terminal record; a run that defers and then goes quiet dies; and the 2 h
inflight ceiling, checked before every reprieve, still bounds any run whose only
reprieve is a shared launcher or a deferral — a forever-alive launcher generation
cannot make a lane immortal.
