---
title: Preserve terminal Work Board attempts across retry and shelving
group: trident
status: open
priority: P1
cutover: false
---

The card owns its terminal attempt provenance independently of its current run
binding. Retry replaces that binding; shelving clears current progress without
erasing the record of what happened. Shelving remains parked work, never shipped.

## Contract

Store one terminal observation per board, card and run: run identity, terminal
outcome (`done`, `failed`, or `blocked`), PR number and resolved URL when known,
and the time the terminal outcome was first recorded. Repeated reconciliation
updates that run's evidence without duplicating it. The history is read-only to
card patch/create callers and is scoped to the card's board. Deleting the card
deletes its history. A missing PR URL renders plain text, never a guessed link.

The additive migration backfills only currently linked terminal cards, using
their stored status, PR and update timestamp. This is an observation timestamp,
not a claim to know the run's exact completion time. Previously cleared links
cannot be recovered and must not be fabricated. Older clients may ignore the
added field; newer clients accept an absent field as empty history.

History does not select a retry source or restore a cleared link. The current
binding continues to govern continuity under
[`a-retry-must-resume-from-the-checkpoint`](a-retry-must-resume-from-the-checkpoint.md).
No budget, checkpoint, active ordering, completion, or archive-live-run guard
changes are authorized by this item.

The existing collapsed Shelved section on web and phone shows these records
when expanded, including the run identity, outcome and optional PR link. These
are past attempts, not the shelved card's current status or proof of shipment.

## Acceptance

- [ ] Failed, blocked and done attempts survive retry, shelving, unshelving and
      process restart; two runs remain distinct and repeated reconciliation does
      not duplicate either. A PR-less attempt cannot borrow another run's PR.
- [ ] An older database gains only recoverable linked terminal history; active
      and unlinked cards do not gain invented terminal attempts.
- [ ] A stale terminal callback cannot write history against a different card or
      replace the current binding. Foreign-board reads cannot see the history.
- [ ] Shelving still refuses live runs and never marks a card done; retry still
      replaces the binding and clears the current PR while preserving its past
      attempt. Consuming Work Board/Trident tests retain checkpoint inheritance.
- [ ] Web and phone render attempt identity/outcome/PR in the expanded shelf,
      remain collapsed initially, and handle missing history or PR URLs honestly.
- [ ] Over- and under-preservation mutations fail the acceptance tests.
