---
title: Refuse newly added prose that asserts a constant's replaced literal
group: trident
status: done
priority: P1
cutover: false
legacy_ref: "#643"
---

## The condition

Four changes corrected code while leaving their own prose stating an older rule.
The broad semantic rule remains an author responsibility, but one recurring
shape is mechanical: a diff replaces the literal assigned to a named JavaScript
or TypeScript constant and adds Markdown asserting the old literal.

The check is deliberately limited to added Markdown lines and simple literal
constant declarations. It does not judge unchanged historical prose, computed
expressions, unnamed predicates, docblocks, or contradictions between documents.
An explicit correction that carries both the old and new literal is allowed.
Those limits prevent ordinary mentions and preserved history from becoming
false refusals, while the diagnostic states exactly what was enumerated.

The guard runs through the existing governed-repository entry point in the
required `layering` CI job. An unreadable diff is a distinct refusal, never an
empty successful result.

## Acceptance

- A real-git fixture that changes a named literal constant and adds a Markdown
  assertion of its old value exits 1 and names the document and constant.
- The same constant change exits 0 when its only old-value assertion is in
  unchanged prose.
- Added prose that explicitly records both the old and new values exits 0.
- An unresolvable diff endpoint exits 2 and says that the check refused to skip.
- The executable guard is invoked by an unconditional required CI path, not only
  exposed as a script.
- The refusal condition is mutation-checked: print the changed line and diff,
  observe the targeted fixture go red, restore it, and observe green.

Verify with `bun test scripts/ci/stale-prose-guard.test.ts` and
`bun test scripts/ci/check-governed-repo-attributes.test.ts`.
