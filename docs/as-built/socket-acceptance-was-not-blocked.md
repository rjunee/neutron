## 2026-09-14 — two records claimed a blocked acceptance that was never blocked

Two as-built records say their integration acceptance could not be validated because
the runner could not create loopback sockets:

- `docs/as-built/unreadable-registry-resume.md` (#676) — "the local socket restriction
  preventing [integration acceptance]"
- `.trident/as-built/fix/685-arbitration-residuals.md` (#685) — "must be rerun in a
  socket-capable runner"

**Both are green, measured on a socket-capable runner:**

| suite | result |
|---|---|
| `repl-supervision.test.ts` | 37 pass / 0 fail |
| `pane-handle-persistence.test.ts` + `spawn-failure-revokes-credential.test.ts` | 32 pass / 0 fail |

The restriction was real — the build lanes' sandbox refuses loopback binds — but it is a
property of **where those lanes ran**, not of the change. The records state it as a
property of the change, which is what makes them wrong rather than merely dated.

### Why this is a new record and not an edit

The two files are on `main`, and merged shards are immutable. That rule is not
bureaucratic: a reader may have acted on what a record said, so the record has to keep
saying it. Editing them would also be refused by `scripts/ci/as-built-write-guard.sh`,
which is the guard doing its job — an attempt to edit them directly failed `layering`
exactly as designed.

So the correction appends. A reader arriving at either original still sees what it
claimed; a reader searching for the claim finds this alongside it.

### The lesson, which is mine

The #685 record is one I wrote, and it was already stale when it merged. I *had* run
those suites against the live herdr socket and said so in the commit message — 32 pass,
0 fail — and then left the record's "must be rerun" sentence standing. The commit message
and the record disagreed with each other in the same change.

A record is not a copy of the commit message; it is the thing a later reader finds. When
a blocked claim stops being true **during** the work, the record is the first place that
has to learn it, not the last.

Same shape as the rule this repository already keeps: correct the claim, not the file you
happened to be looking at — and check whether the claim you just disproved is written down
anywhere else.

### The same record is wrong a second way, and it is the same cause

`.trident/as-built/fix/685-arbitration-residuals.md:89-90` records both guards as
**"NOT mutation proof"** — because the lane's fixture could not reach the host under the
same sandbox restriction, so its mutants failed at startup rather than on the assertion.

That was true of the lane. It is not true of the change. The mutation was run on a
socket-capable runner and is in the merge commit:

> reverting item 1's guard reds **nothing** in `pane-handle-persistence` — that fixture
> never reaches the readiness-failure arm. It reds `readiness failure revokes only its own
> registration` in the new file, **2 pass / 1 fail**, restored 3/0.

So the record understates the evidence in exactly the way the socket sentence overstated
the obstacle, and for one reason: **the record was written from the lane's vantage point
and never updated from the orchestrator's.** The commit message has the measurement; the
record says it could not be taken.

Worth stating as a rule rather than a correction. A lane reports what IT could establish,
which is the right thing for a lane to report. Whoever runs the thing the lane could not
owns updating the record — and "the lane could not do X" has to become "X was done, here"
or the record permanently understates what is known. A record that reads as weaker than
the evidence is a smaller problem than one that reads as stronger, but it still misleads:
the next reader plans a mutation run that already happened.
