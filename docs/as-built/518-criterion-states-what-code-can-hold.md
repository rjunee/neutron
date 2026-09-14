## 2026-09-14 — a criterion no implementation can satisfy is a defect in the criterion

`a-deploy-must-not-kill-builds-in-flight` had one box left, and it could never be
ticked by anyone. It demanded, unconditionally, that a deploy-caused death is
**never** reported as a bare crash.

No mechanism inside the gateway can hold that. Both channels carrying the
attribution — the durable registry record and the live sink — are stores this
process does not control. If both fail in the same shutdown for the same
generation, the next boot has nothing that says "deploy" and honestly reports a
dead pid. The spec item said so itself, in prose, underneath the unticked box.

So the item sat unclosable while the work it describes was finished and merged
(#694), and with it the second milestone.

### What changed, and what deliberately did not

The CRITERION. Not the code, not a test, not a threshold. The rewrite states three
clauses, each of which the code can actually hold and a test can actually falsify:

1. never a bare crash **when either channel survives** — they fail independently,
   and the durable record carries the process identity rather than the pid alone;
2. where attribution cannot be established, the death is reported as **cause not
   established** — never as a crash the system did not observe, nor as a deploy it
   did not perform;
3. the residual, named exactly: registry row lost or unwritable AND sink failed or
   timed out, same generation, same shutdown.

Nothing achievable was dropped. Clauses 1 and 2 are the whole of what the old
wording promised in the cases where it could promise anything; clause 3 is the case
where it could not, which the old text already recorded — as prose, under a box
that stayed unticked.

### Why this is not weakening a test to get green

The distinction is between a criterion that a correct implementation fails and one
that an incorrect implementation passes. The old wording was the first: it is
unsatisfiable by construction, so it graded nothing. Weakening would be moving the
bar the code could not clear; this moves a bar no code can clear, to the place the
code is actually held.

The test sequence is untouched and still pins the behaviour as a SEQUENCE rather
than as wording: durable-write-lost → live-report-lost → next boot asserts the
bare-crash outcome, with the complement that a surviving durable record names the
deploy with no live report at all. 59 cases, 0 fail.

### The general lesson, since this is the second time

An acceptance criterion is an instrument. "Too strict" is a way for an instrument
to be wrong, exactly as "too permissive" is — a criterion that cannot be satisfied
reports nothing about the code and blocks the work it was meant to describe.
Absolute words — never, always, every — earn their place only when the mechanism
beneath them is wholly inside the boundary the criterion is written for.
