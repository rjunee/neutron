---
title: Preserve parent descriptors after native child finalization
group: platform
status: open
priority: P0
cutover: true
sections: 1
criteria: 6
contract_items: 0
---

# Preserve parent descriptors after native child finalization

Work state: GitHub issue #1457.

The Codex account-writer transport passes an already-open reservation descriptor
to its child and closes the parent's copy after spawning. That numerical
descriptor belongs to the parent. After it closes, the kernel may reuse the
number for another account reservation, file, socket or process handle. Neither
child exit nor garbage collection of its wrapper may close the reused descriptor.

Bun 1.3.13 violates this boundary when an inherited extra-stdio descriptor is
retained until finalization. Bun 1.4.2 passes the isolated reproduction. Use the
verified runtime in CI and deployment; preserve native account exclusion and
explicit parent lease closure. Do not suppress EBADF or weaken the process,
account-lock or host-suite gates to accommodate the defective runtime.

## Acceptance

- [ ] A real account-writer transport transfers its reservation into the native
  fixture, and a separate open file reuses the parent's exact descriptor number.
  The fixture runs only inside the authenticated process-test boundary.
  Verify: `runtime/adapters/codex-cli/account-writer-lock.test.ts`.
- [ ] After native exit and proven collection of the retired transport wrapper,
  the reused descriptor still names the same device/inode and accepts a write.
  The regression must fail on the defective runtime; merely calling GC while
  retaining the wrapper does not satisfy this criterion.
  Verify: the same consuming regression under the old and corrected runtimes.
- [ ] CI uses the verified Bun release with matching cache keys. Its cache-version
  mutation control must continue rejecting a runtime/cache mismatch after the
  pin changes. Document the development runtime requirement.
  Verify: `scripts/ci/ci-workflow.test.ts`, `.github/workflows/ci.yml`, and
  `CONTRIBUTING.md`.
- [ ] Activation verifies the running executable independently from the source
  pin and preserves active native parents and retained workflow evidence. A
  successful isolated reproduction or CI run alone is not deployed acceptance.
  Verify: the deployment's runtime-identity and preservation receipts, followed
  by the actual Trident host gate and unattended workflow outcome under #545.

- [ ] Stored TEXT findings use strict UTF-8 decoding before parsing. Other storage
  classes remain empty evidence. Malformed bytes
  remain empty evidence; valid replacement characters, emoji and noncharacters
  survive, leading BOM remains rejected, and reads do not alter persisted bytes.
  The store guards and isolated panel reader share this boundary.
  Verify: `trident/store.test.ts`, `trident/review-run.test.ts`, and the unchanged
  historical SQL executed by `trident/as-built-disposition-sql.test.ts`.
- [ ] A completed review stops and reaps its heartbeat timer, so the timer cannot
  retain the review's output pipes until the next heartbeat. Signal exits retain
  their non-success verdict and the ticker emits only during a live review.
  Verify: `trident/codex-review.test.ts`.
