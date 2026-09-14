---
title: Reap child processes left by dead build lanes
group: trident
status: done
priority: P1
cutover: false
issue: 623
---

A build may leave detached descendants or socket-created processes behind. A
process being absent from a registry, or displaying a shared pane label, does
not establish ownership or death.

### Ownership and lifecycle

Codex build invocations acquire a random claim before executing build code.
Nested commands inherit it, including Codex's filtered shell environment and
Herdr's explicit socket spawn environment. Ordinary wrapper completion reaps
only that claim. The gateway independently sweeps at startup and every fifteen
minutes; it does not depend on a dead build executing its own cleanup.

The owner PID, kernel start time and boot ID supply liveness evidence. The
random claim supplies ownership identity. Missing owner processes, exited
owners and mismatched process incarnations establish death; unreadable evidence
preserves children. Signals address opened pidfds, never a PID pattern or a
previously recorded numeric PID.

For older unclaimed processes, the fallback is restricted to a kernel-unlinked
cwd beneath an absent `.claude/worktrees/wf_*` root in a configured repository.
An existing root, a live run's recorded root, an unreadable root, and an unrelated
repository all refuse cleanup. A deleted subdirectory alone is insufficient.

### Acceptance

- [x] Kill a lane during a build that spawned a TERM-resistant grandchild; the
  independent sweep terminates both its remaining launcher and grandchild.
  Verify: `bun test trident/lane-processes.test.ts`.
- [x] A broker-created child outside the owner's process tree is reaped after
  owner death, while another live lane's child survives the same sweep.
- [x] Normal teardown cannot revoke another claim; unknown liveness refuses.
- [x] PID reuse cannot redirect a signal to a successor; TERM precedes KILL.
- [x] Removed-root cleanup preserves live roots, recreated roots, unrelated
  repositories, live store claims, and directories literally ending in the
  kernel's deletion suffix.
- [x] The gateway invokes the process sweep independently, and the real Codex
  wrapper and Herdr request carry the claim. Verify the specific
  `worktree-reaper.test.ts`, `codex-build.test.ts`, and
  `herdr-snapshot-ring.test.ts` suites alongside the process proof.
- [x] Disabling cleanup, ownership checks, liveness checks or the production
  wiring makes the corresponding test fail; restoration passes.

### Explicit limits

The historical report of 38 panes provides labels and registry absence, not
per-process cwd and owner evidence. Of those processes, this change reaps the
ones satisfying the removed-root proof; it preserves unclaimed processes in
surviving directories. Their count cannot be inferred from the report. Newly
claimed build children are covered regardless of parent or registry membership.
This change terminates processes; it does not issue Herdr pane/tab deletion RPCs.

Commands deliberately replacing their entire environment can discard a claim;
the removed-root fallback still applies. Other builders without the Codex wrapper
receive the removed-root backstop, not the claim-based normal-exit cleanup.
Unsupported process-handle platforms defer Codex builds rather than substituting
unsafe numeric-PID signals. This is a Linux/Python 3.9+ implementation.
