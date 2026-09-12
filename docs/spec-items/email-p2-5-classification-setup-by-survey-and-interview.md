---
title: Set up classification by inbox survey and owner interview
group: email-core
status: open
priority: P3
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**P2.5 — classification setup by inbox SURVEY + owner INTERVIEW.** The Core
ships the mechanism and **ZERO rules**; installing it samples the real inbox,
clusters what is there, then asks the owner about each class it found and
writes the answers as per-owner instance data. Owner sender data in this tree
is a defect, never config. _Acceptance: a fresh instance with a connected
mailbox and no hand-authored rules reaches working classification through setup
alone, and the proposed classes are DERIVED from the sampled inbox — a
hardcoded taxonomy fails the test._

## Acceptance

- [ ] A fresh instance with a connected mailbox and NO hand-authored rules reaches working
      classification through setup alone.
- [ ] The proposed classes are DERIVED from the sampled inbox. **A hardcoded taxonomy fails
      the test** — assert that two different sampled inboxes produce different proposed
      classes, since a fixed list satisfies any single-inbox test.
- [ ] The Core ships ZERO rules. Owner sender data in this tree is a defect, never config —
      assert the shipped tree contains no owner sender.
- [ ] The owner's answers are written as per-owner instance data, not into the repo.
