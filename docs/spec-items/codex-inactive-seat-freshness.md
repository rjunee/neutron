---
title: Refresh inactive Codex seat usage before pool selection
group: trident
status: open
priority: P1
cutover: true
---

Issue: #1361. Existing global pool selection can retain a cooled incumbent when
an inactive seat's own current rollout already refutes its stored cooldown.
Refresh all connected global seats through the existing throttled harvest before
the account view or run resolver selects a seat. This adds no polling cadence.

The locked project ownership rule remains SPEC.md:39–41; explicit project
credentials remain outside global rotation. The operator custody contract in
`codex-operator-custody.md` remains unchanged, including the non-harvesting
rotation metadata endpoint and General retained-home admission.

## Acceptance

- [ ] Both account view and run resolver observe a healthy inactive seat and
      withdraw its stale usage cooldown before selecting; the account view does
      not persist a new active pointer. Verify: codex-rotation.test.ts.
- [ ] Inactive absent, stale, pre-connect, capped and unauthorized evidence does
      not release a seat. A newly capped inactive seat is cooled before selection.
      Per-seat throttling remains effective. Verify: codex-rotation.test.ts.
- [ ] Existing project ownership, credential identity and explicit override
      admission remain intact. Verify: credential and rotation suites, consuming
      open/__tests__/project-build-e2e.test.ts and root/trident TypeScript checks.
- [ ] Restoring incumbent-only harvest fails recovery checks; unconditional
      cooldown release fails refusal controls. Record actual mutation outcomes
      in this change's as-built record.
