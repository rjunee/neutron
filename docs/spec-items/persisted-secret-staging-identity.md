---
title: Persist secrets despite staging remnants after PID reuse
group: security
status: done
priority: P1
cutover: false
---

Issue #634. Each secret installation attempt must choose a staging name with
fresh random identity. A PID is diagnostic and cannot supply identity across
process restarts. Existing foreign staging files must be left alone; the current
attempt may publish or discard only the staging file it exclusively created.

The filed defect is a collision during exclusive creation, not adoption of a
remnant by reading its PID. Apply the random staging-name fix without changing
the persisted/ephemeral result contract for actual filesystem failures.

## Acceptance

- [x] A fresh subprocess with the old first-attempt PID/counter remnant still
      persists a secret, leaves the remnant bytes intact, and emits no fallback
      warning. Reverting to the old name must fail this test.
- [x] Our successful staging file is consumed by publication; failed writes
      discard our staging file while retaining foreign remnants and recording
      the existing fallback warning. Removing publication or cleanup must fail.
- [x] Repeated name-builder calls in one process yield distinct random suffixes;
      a constant random-looking suffix must fail the direct contract test.

Verify all criteria: `bun test open/__tests__/persisted-secret.test.ts`.
