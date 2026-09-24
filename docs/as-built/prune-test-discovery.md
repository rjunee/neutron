## 2026-09-24 — Prune excluded trees during test discovery

The test runner's shared discovery function filtered paths after `find` had
already descended into dependency and dot directories. On a checkout containing
those trees, the walk spent seconds visiting files that could never join the
suite. It now prunes those directories before matching files. The twelve
test/spec suffix patterns, sorted output, and test-only discovery override stay
unchanged.

A direct fixture test checks every suffix at the root and in a nested source
directory, both excluded directory types at both depths, ordinary non-test files,
and legitimate dot-named test files. The runner selftests and shard partition
tests passed: 27 tests total. On the same populated checkout, three original
discovery calls took 10.08, 9.68, and 9.17 seconds; two pruned calls took 0.04
and 0.03 seconds. A paired full-list comparison returned no difference, and
the matching output hash was observed before and after the change. This measures
discovery alone, not the full suite or planner.

The root TypeScript check and all 51 project TypeScript configs passed. The
local purity scan reported 455 findings on this branch and the same 455 findings
on a clean checkout of its base revision. It therefore did not give this change
a clean gate verdict; the PR's CI purity job remains authoritative.
