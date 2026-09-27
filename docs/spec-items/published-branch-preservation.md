---
title: Preserve previously published work across fresh dispatch and replay
group: trident
status: open
priority: P0
cutover: true
---

# Published branch preservation

Work state: GitHub issue #1316. An exact push lease protects against concurrent
ref movement; it does not establish that the replacement preserves earlier work.

## Governing requirements

Retain G084–G087 in `docs/trident-gates-inventory.md`: reviewed-head descent,
readable remote state, pinned first-publication launch ancestry, and replay from
a provable fork point. Supplement these gates for fresh dispatch on an existing
branch. `trident-build-efficiency.md` requires changed heads to receive their own
approval, mutation proof and suite evidence. Preservation never transfers them.
G100 preserves the measured candidate on origin before refusing PR/review; G166
observes and names scan failures on that preservation path without vetoing it.
Neither requires replacing the original branch. Stop-is-discard is unchanged.

## Acceptance

- [ ] Both publication writers refuse a candidate that omits existing published
  work, including a fresh sibling already based on current main. Observe the
  exact remote head, prove preservation against it, and use that same OID as the
  push lease. Missing, malformed or ambiguous evidence cannot authorize a push.
  Verify real Git with unchanged remote/tree on refusal and with a stale lease
  that refuses a concurrent remote advance.
- [ ] Descendants remain admissible. A legitimate content-preserving rebase or
  replay also remains admissible even though its commit IDs differ: a clean
  raw-graph three-way merge of the published head into the candidate must produce
  exactly the candidate tree. An unavailable or ambiguous fork, conflict, or
  different merged tree refuses. Replacement refs, grafts, shallow views and
  checkout-configured merge drivers cannot fabricate preservation.
- [ ] G100 creates the deterministic `refs/heads/trident-preserved/<candidate-OID>`
  with an expected-absence lease. An existing exact match is an observed no-op;
  a foreign or unreadable value refuses. Witness the exact origin ref and OID
  before claiming preservation and name its location in the refusal. Never
  overwrite the original branch or create/review a PR on this path. Clean,
  carrier, unavailable and throwing G166 scans retain their advisory semantics.
- [ ] Test both publishers, the consuming `open/__tests__/project-build-e2e.test.ts`
  path, and real Git positive/negative siblings. Semantic mutants removing the
  loss guard and replacing content equivalence with ancestry-only refusal must
  fail. Run both `tsc -p tsconfig.json` and `tsc -p trident/tsconfig.json`.
