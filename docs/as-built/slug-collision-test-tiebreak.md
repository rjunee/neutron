## 2026-09-13 — a precondition that was asserted and then left to a coin flip

`retry-resumes-checkpoint.test.ts`'s `a colliding NEWER run from another card does
not cost this card its budget` failed on CI shard 1/8, on a branch that does not
touch it.

**The mechanism, established rather than guessed.** `latestTerminalBySlug` orders
`started_at DESC, id DESC` (`store.ts:1103`). The test creates both prior runs in
the same tick, so `started_at` ties and the `id` tiebreak decides — and ids are
random UUIDs. Measured directly: with identical `started_at`, the row the test
needs is selected **491 times in 1000** (49.1%). The precondition at the heart of
the case was a coin flip.

The product is not at fault and the tiebreak is not a bug. `store.ts:1087`
already says why it exists — "two rows can share a timestamp on a fast clock" —
which is the sentence this test needed to read and did not.

**What made it invisible.** The test *asserts* its precondition rather than
assuming it, which is why this surfaced as a clear failure instead of a confusing
one. But asserting a precondition does not establish it: the line above said
"Card B's prior lands LATER" as a statement of intent, and nothing made it true.
An asserted precondition fails honestly half the time; an established one does
not fail.

**The fix** stamps `priorB.started_at` one second past `priorA`'s before the
assertion, so "later" is a fact. Nothing about the case's subject changed.

**Mutations.** Stamping the losing side (`- 1_000`) reds exactly this case, so
the assertion does depend on the ordering now being controlled. Removing the
stamp entirely — main's behaviour — passed 6/6 locally, which is reported rather
than hidden: the flake is CI-timing dependent and was NOT reproduced on this box.
The mechanism above is the evidence, not a local red.

**The third wall-clock race in test code found in one night**, after the
park-ceiling case (#660) and the unserialised-region case (#661). All three share
a shape worth naming: a test that reads a clock, or an ordering derived from one,
and then depends on the result without controlling it.
