## 2026-09-30 — Attribute native test commands through exact task ownership

An explicitly registered native task could appear as building or review while
its nested local test commands remained unassigned. The importer considered
checkout intervals for test ownership but did not consume the same task's exact
session/turn PR binding at that construction site.

`scripts/build-timeline-codex-import.ts:255` now uses that exact binding for nested
test operations. Conflicting or ambiguous checkout evidence refuses attribution;
foreign sessions and follow-up turns cannot borrow ownership. Each command keeps
its recorded timestamps and invoking model, with unknown usage. Native task usage
remains attached only to the completed task envelope. Shared PR links remain one
observation, and overlapping task/command intervals retain their own clocks.

The authenticated API regression at
`scripts/build-timeline-codex-import.test.ts:35` consumes both the task and its
nested test without any checkout binding, checking clocks, model and disjoint
usage. Refusal and valid/shared controls begin at line 55. Removing the new
ownership path makes the positive test fail; accepting conflicting checkout
evidence makes the refusal test fail. Both mutations were restored.

Validation: 58 importer, projection, discovery and registration tests passed;
root and Trident TypeScript checks and focused lint passed. The operational
registration seam still requires explicit ownership for every new turn. This
change does not infer historical ownership, automatically intercept native
dispatch, or claim complete phase coverage. The timeline spec and operator guide
were updated together; earlier as-built records remain immutable.
