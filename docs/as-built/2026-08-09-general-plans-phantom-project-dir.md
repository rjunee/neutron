# General's plan docs were being written to a phantom project directory

**Landed:** 2026-08-09 · **Reported:** owner, "there is an item in the work board, but clicking the link to its plan document doesn't work. There are no documents in general"

## What was happening

The doc existed. It was at `Projects/<owner-slug>/docs/plans/…`, while General's
Documents tab reads `Projects/general/docs` — a directory that **did not exist at
all**. Two plan docs were sitting in a folder nothing displays.

`Projects/<owner-slug>/` is not a design; it is a **phantom project directory**.
The control that proves it: two REAL project directories carry the same
`.nexus`, `calendar`, `docs` subdirectories, so those subsystems are per-project
rather than owner-level — and the phantom is missing everything a real project has
(`STATUS.md`, `README.md`, `.git`, `notes/`). It contains only what got written
into it. A second phantom sits beside it named after the internal instance id, from
the same mistake.

## The mistake, in one argument

```ts
await this.docs.writeDoc({ project_id: project_slug, … })
```

`project_slug` is *which instance*. `project_id` is *which project*. Worse, the
value actually arriving there was neither: the HTTP surface passes the **board
scope key** in a parameter named `project_slug`, and for General that key collapses
to the owner slug. **Three concepts, one name, one argument.**

## The fix

`createCardWithOptionalSpec(scope, docs_project_id, input)` — the board keeps its
scope key (its legacy rows genuinely live there, and that collapse is deliberate),
and the filesystem gets a real project id. In the General scope `ctx.project_id` is
`null` — that is what General *is* — so it resolves to
`GENERAL_WORK_BOARD_PROJECT_ID`, the **same constant** the board's own collapse
tests against, so the two can never drift apart again.

Chosen over teaching the docs store "if General, substitute the owner slug", which
would have put a conditional in the storage layer and spread to every subsystem
that stores per project. The owner's criterion was explicit: no multiple code paths
and no special cases. `general` is a valid project id under the store's own
alphabet, so this adds **zero** conditionals.

## Coverage

The regression guard landed exactly on the defect and was found by the test rather
than designed: `agent-tool.test.ts`'s context has `project_id: null`, so the docs id
must be `general` while the board row stays owner-scoped. **Mutant: collapsing the
argument back to the scope — literally the original bug — reds it.**

## Not included

Existing docs are NOT moved by this change; the two on the box need a one-time
migration. The mobile work-board doc link is still unwired and web's is still
disabled for General — both tracked separately, and both are pointless to fix
before the root is right, since a working link would have opened a 404.
