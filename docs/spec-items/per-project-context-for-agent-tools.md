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
> 2. **It is DECIDED that the current terminal state is intended.** The gap is not
>    accidental and the code already argues it is safe: where no frame is bound (the
>    General topic, a system/cron dispatch, or the in-process chat-command Core
>    filters that call their Core client directly and never cross
>    `McpServer.dispatch`), the active project id resolves to `''` → GLOBAL scope,
>    *"which is exactly the pre-D2 per-instance behavior: safe, no regression"*
>    (`gateway/cores/active-project-context.ts:25-29`). If those `''`-binds-global
>    paths ARE the intended terminal state, this item closes as won't-do rather than
>    staying open forever.
>
> Until one of those is written down, `needs_spec` stays on.

Per-project context for agent tools — X6 follow-ons (scope tool state to the active project everywhere).
