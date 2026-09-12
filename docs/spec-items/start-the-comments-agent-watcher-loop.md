---
title: Start the dormant comments AgentWatcher loop
group: platform
status: open
priority: P2
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

Wire the comments `AgentWatcher` (dormant loop today) — a new comment wakes the agent. (D-7)

## Acceptance

- [ ] A new comment wakes the agent in a real composition. `AgentWatcher` is constructed
      outside its own test file, and deleting that construction turns a test red.
      verify: `rg -n "new AgentWatcher" --glob '!**/*.test.ts'` names a composition file
- [ ] `loop/registry.ts` no longer lists the comments `AgentWatcher` among the loops that
      never start in ANY composition.
