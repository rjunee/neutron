## 2026-08-15 — the doc rule that nine branches broke had been written 18 days earlier

Measured with `git merge-tree --write-tree` against the base — git's own three-way
merge, not an inference — nine of nine stalled branches conflicted on the shared
scratch plan, and only three of them touched a source file at all. Three conflicted on
that one document and on nothing else: their code merged clean and they sat unmergeable
for two days over a file whose correct resolution was unconditionally "take the
branch's own". Separately, three builds finishing at 2026-08-15T23:20Z all failed at
publish on `docs/AS_BUILT.md` and on nothing else.

**The surprise was that the fix already existed.** `docs/as-built/` and its README have
been here since 2026-07-28, with 47 entries in it and the rule in bold at the top: *"Do
not append to ../AS_BUILT.md."* The closed file then took a new entry on essentially
every day since — 2026-08-15 alone added ten. The rule was correct, written down,
argued from a measured incident, and had no teeth: no build's prompt read the README
and no gate checked it. **A convention that is only prose holds until the first agent
that did not read it**, and every agent since 2026-07-28 was that agent.

**So this change is the wiring, not the layout.** Three parts, because instruction
alone is what already failed:

- The build contract says it. `AS_BUILT_ENTRY_RULE` in `trident/inner-workflow.mjs` now
  tells every Forge build that an entry is a NEW FILE under `docs/as-built/`, and the
  planner's read step (`inner-workflow.mjs:1675`) names that directory instead of the
  closed file it was sending planners to.
- CI enforces it. `scripts/ci/as-built-closed-log-guard.sh` fails a PR that adds a `##`
  entry heading to `docs/AS_BUILT.md`, comparing against the MERGE BASE so a base that
  moved cannot make someone else's entry look like this branch's. It is a closure, not
  a freeze — a typo fix or a header edit there still passes.
- The split log can be read as one document again. `bun scripts/render-as-built.ts`
  concatenates the entries newest-first (date descending, slug ascending within a day)
  followed by `docs/AS_BUILT.md`. It never edits inside an entry, so it cannot splice
  two together; the corpus mixes `#`-titled and `##`-titled entries (28 and 19) and both
  are emitted byte for byte.

**The plan half was landed in #302** — `.trident/plans/<branch>.md`, one file per build
(`inner-workflow.mjs:1709`, `:1733`, `:1754`) — but two live references had not followed
it: the crash-resume note telling the planner where to read a reused branch's committed
plan, and the reason string the plan probe reports when it finds none. Both named the
old shared path, so a resume was reading a file no build writes any more
(`inner-workflow.mjs:1671`, `:4371`).

**A union merge driver was the cheap alternative and it is worse than the bug.**
`scripts/as-built-concurrent-realgit.test.ts` replays the same two builds over a
`merge=union` log: git reports SUCCESS, and because both entries ended with the same
`**Tests.** green.` block the union kept one copy — the first entry lost its tail and
the second's heading landed directly on the first's last prose line with no blank line
between them. No conflict, no signal, two half-entries under one heading. Union merges
line-wise; entries are not lines.

**Tests.** `scripts/as-built-concurrent-realgit.test.ts` builds a real repo, cuts two
branches from one base, MOVES the base with an intervening source commit, and merges
both — reading the conflicting paths back from git's index rather than inferring them
from an exit code. Every clean-merge assertion is paired with a control that replays the
identical fixture over the old layout and proves the conflict is real and is exactly
`['IMPLEMENTATION_PLAN.md', 'docs/AS_BUILT.md']` — nothing else, which is what makes it
a document-format failure rather than bad luck. `scripts/ci/as-built-closed-log-guard.test.ts`
runs the real gate against real repos and includes the mutation that must fail it.
`scripts/as-built-log.test.ts` covers the order (date descending beats the alphabet) and
the entry boundary (a body with no heading throws instead of being glued to its
neighbour).

**Not covered.** Nothing is migrated out of `docs/AS_BUILT.md`: re-chunking 12k lines of
existing prose adds risk and removes no conflict, since the conflict stops the moment
the file stops being written. The guard sees entry headings, not intent — a build that
adds prose to the closed file without a `##` still passes, which is deliberate.
