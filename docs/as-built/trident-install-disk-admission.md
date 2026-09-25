## 2026-09-24 — Measure disk headroom before Trident dependency installation

The host dependency preparation path previously launched its installer without
measuring available disk space. It now measures available blocks on the
worktree's destination filesystem immediately before a new installation.
Unknown or negative measurements and capacity below 5 GiB refuse installation;
the existing retry path can proceed after capacity recovers. Existing verified
dependency receipts still avoid installation and run readiness verification.

Scope is the host's Bun workspace installer. This does not establish scratch
ownership, intercept arbitrary shell installs, reserve the install's eventual
size, or evict active work. The admission snapshot cannot prevent concurrent
processes from consuming disk after the measurement.

Validation exercises the actual `prepareProjectBuild` consumer in
`open/__tests__/project-build-e2e.test.ts`: unavailable and low capacity prevents
installer commands and worker dispatch; exact and above-threshold recovery
installs a dependency which the fixture executes; valid receipt reuse under low
space still verifies without measuring installation capacity. The real
filesystem measurement has existing-path and missing-path controls. Relaxing
the threshold makes the refusal test fail, and rejecting the exact boundary
makes the recovery test fail. Both TypeScript projects and ESLint pass.

The full consuming file ran 311 cases: 302 passed, while nine socket fixtures
were refused by the restricted execution environment. Those same nine cases
passed in a permitted environment (125 assertions, 14.98 seconds), covering all
311 cases without rerunning the successful cases. The final focused run passed
all three installation cases with 53 assertions. Admitting unknown capacity
also made the refusal test fail. The spec-index checks passed all 38 cases.

The local full-tree leak scan failed with the same 455 findings on the unchanged
base and this candidate. This is recorded as an unresolved publication check,
not a successful gate; the PR records its final publication-gate results.
