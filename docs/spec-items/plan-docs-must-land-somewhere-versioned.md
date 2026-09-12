---
title: Land a card's plan doc somewhere durable and versioned
group: work-board
status: open
priority: P1
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**A card's plan doc is the single source of its spec, and it is written to a place nothing
version-controls, reviews, or backs up** (owner-reported 2026-08-14, on discovering the P2–P4 note:
*"plan docs here in this project are not actually written to the repo itself"*). `work-board/spec-doc.ts`
writes each card's full ask to `Projects/<id>/docs/plans/<slug>.md` via `DocStore`, and the card stores
`neutron-docs:plans/<slug>.md`. **The LOCATION is correct and Ryan-locked (2026-07-02)** — it must stay
user-visible in the Documents tab; this entry does NOT propose moving it. The gap is that the write ends
there. MEASURED on this instance: 12 plan docs on disk; the project vault at `Projects/neutron-open/` IS
a git repo whose own `CLAUDE.md` states *"every meaningful change commits to this project's own git
repo"*; **2 of the 12 are tracked — both committed by hand by the agent — and the repo has NO remote and
2 commits total.** So ten specs, including every card currently on the board, exist as untracked files
on one volume. THREE CONSEQUENCES, in order of cost: (1) the doc is the input `▶ start` feeds to trident
as the run's `task`, so losing or silently editing it changes what gets built with no diff and no
history; (2) the PR that implements a card carries no copy of the spec it was built against, so a
reviewer on GitHub — human or Argus — cannot see the acceptance criteria they are judging against; (3)
the code repo and the spec that drives it can drift apart with nothing to detect it. Note the coupling
to *"the build brief must not be retyped by a model — pass it by PATH"*: that card's premise is handing
the brief over as a path, and today that path resolves outside the repo the build works in. Acceptance:
a plan doc lands somewhere durable and versioned — committed by the writer, not by hand — WITHOUT
leaving the Documents tab; a doc's history is inspectable; and the spec a build ran against is
recoverable after the fact from the record, not from a live file. Whether that is auto-committing the
vault repo, mirroring into the code repo alongside the PR, or snapshotting the doc bytes onto the run is
the design question — do not pick it here.

## Acceptance

- [ ] A plan doc lands somewhere durable and versioned, **committed by the writer, not by
      hand**. A doc created through `work-board/spec-doc.ts` is tracked without any human
      step; assert the untracked case turns a test red.
- [ ] It does NOT leave the Documents tab. The Ryan-locked location (2026-07-02) still
      resolves — a fix that versions the doc by moving it out of the owner's view fails
      this criterion.
- [ ] A doc's history is inspectable.
- [ ] The spec a build ran against is recoverable AFTER THE FACT from the record, not from
      a live file. Assert recovery still works once the live file has been edited — a test
      that reads the current file would also pass with the defect present.
