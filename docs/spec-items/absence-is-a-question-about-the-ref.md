---
title: An absence claim about a tracked file is a question about the ref
group: trident
status: done
priority: P1
cutover: false
legacy_ref: "#644"
---

## The condition

The repository-wide evidence rule currently pairs every absence claim with a
same-shaped positive control. That is sufficient for a content search, but it
does not identify the authority for a tracked-file existence claim. A working
tree can be sparse, dirty, or checked out at a different commit from the ref the
claim concerns. A control read from that same working tree therefore cannot
detect the mismatch.

The tracked-file predicate must accept the ref explicitly and fail closed when
git cannot inspect it. A caller asking about files on disk uses a separately
named working-tree predicate. The repository guidance must state both the
authority rule and the requirement that a control can fail for the same reason
as the claim.

## Acceptance

- A file absent from the working tree but present in the named ref is reported
  present by the ref predicate.
- A file present in the working tree but absent from the named ref is reported
  absent by the ref predicate and present by the separately named working-tree
  predicate.
- Failure to inspect the named ref throws; it is not represented as an empty
  successful result.
- The same distinction holds one level down, where the tracked file is READ: a
  path established as present at the ref whose bytes cannot then be produced is a
  failure, not an absence. Its control is a repo where the path is genuinely
  absent, which must still answer quietly.
- The root agent guidance gives a ref-based worked example with a known-present
  control and explains why a working-tree-only control cannot validate the
  tracked-file claim.
- Each executable guard above is mutation-checked: the landed mutation line and
  diff are printed, the targeted test fails, and the restored implementation
  passes.
