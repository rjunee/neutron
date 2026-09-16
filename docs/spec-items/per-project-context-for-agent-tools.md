---
title: Scope agent tool state to the active project everywhere
group: platform
status: open
priority: P2
cutover: false
needs_spec: true
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

> **OPEN QUESTION — this item is `needs_spec` and must not be built from as it
> stands.** The "X6 follow-ons" were **never enumerated**. There is no list anywhere
> in the tree of what remains, so "scope tool state to the active project
> everywhere" has no definition of done and any branch cut from it would be building
> from an invented specification (work-tracking standard §3.1, §3.2).
>
> **One of two answers closes it, and only the owner-facing half needs asking:**
>
> 1. **An acceptance list is written** — enumerate the specific tool-state surfaces
>    that still resolve globally, each with the file and the call path, so "done" is
>    countable; or
> 2. **It is DECIDED that the remaining tool-state behavior is intended.**
>    Credential reads are now governed separately by the 2026-09-16 API scoping
>    decision in `SPEC.md`: unknown project context refuses, rather than inheriting
>    global credentials (`gateway/cores/core-credential-resolver.ts:287`). The old
>    claim that a missing frame safely implies global access is superseded. This
>    does not specify or close the unenumerated non-credential tool-state work.
>
> Until one of those is written down, `needs_spec` stays on.

Per-project context for agent tools — X6 follow-ons (scope tool state to the active project everywhere).
