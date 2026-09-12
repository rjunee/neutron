## 2026-09-12 — the work queue leaves SPEC.md: `Phases → Steps` split into `docs/spec-items/`

`SPEC.md`'s `Phases → Steps` section was 817 lines, 63% of the file, and it held
two things with different lifetimes and different readers: an architecture record
of what had shipped, and a task queue of what had not. This is step 1 of the
work-tracking standard that landed the same day
(`docs/process/work-tracking.md` §5) — one file per work item under
`docs/spec-items/`, with the rollup index built in the same change because §6 is
explicit that a split without a live index is all of the cost and none of the
benefit.

### What was actually wrong — the queue was reporting shipped work as outstanding

All 31 open (`- [ ]`) entries were verified against the tree before anything was
moved. **Ten had already shipped and still read unchecked.** Not a near-miss
collection: the outer publisher's rebased-branch push (#259/#275), publish-failure
evidence (#259), gateway-restart recovery (#267), infra auto-retry (#367),
pre-provisioning credential scope (#266), Work Board item removal (46f18bb1), the
deploy-ref resolution (#245), the stranded preserved worktree, the build heartbeat
(#534), and the Email P1 pipeline (176e789c/#214).

The deploy-ref entry is the one worth keeping: it carried a "✅ RESOLVED" block,
with its full post-mortem and the lesson it taught, **inside its own unchecked
box**. The queue contained its own refutation and still read as open. That is what
a document doing two jobs looks like from the inside, and it is why this was a
split with corrections rather than a file move.

### Four surviving items carried claims the code had since falsified

Each was measured this session and corrected at the top of the item it belongs to,
in the item's own terms, rather than softened:

- **The credential item's "THIS ENTRY IS NOW THE ONLY THING BLOCKING BUILDS ON
  THIS INSTANCE"** is false. PR #248 removed the push from the agent contract
  entirely — Forge is now told *"Commit on `<branch>` and stop. Do NOT push and do
  NOT run `gh`"* (`trident/inner-workflow.mjs:1337-1343`), and the codex coda
  repeats it (`:1494-1495`). Acceptance (a) shipped and (b) is moot, so the item
  narrows to (c), which is untouched: the run is still handed the data dir holding
  the owner's encryption keyfile (`trident/inner-loop.ts:116`,
  `trident/orchestrator.ts:215`) and no test proves a build cannot decrypt secrets
  it was not given.
- **The Email cutover's return-to-inbox learning loop, cited as "live and closed:
  `pipeline/poller.ts:82`"**, is not there. That line is
  `export const DEFAULT_MAX_POLL_PAGES = 20`, and no learning loop exists anywhere
  under `cores/free/email/src/`. What the poller actually does is re-read the
  existing sender rules each tick (`poller.ts:791-792` → `classify.ts:171-172`) —
  a rules READ, with nothing writing a rule back. The claim is struck and the item
  now says the loop must be decided, not assumed kept.
- **The card-pulse item's "BLOCKED ON #534, do not start before it lands"** — that
  heartbeat shipped, and the code says so in as many words at
  `trident/run-driving.ts:82-88`, with the cadence pinned at
  `trident/liveness.ts:81-88`. The block is struck. The proxy the item condemns is
  still in the tree verbatim at `landing/chat-react/work-activity.tsx:43-46`.
- **The backup scheduler's blocker** ("needs a wired `ProjectBackupStore`") is
  stale: the store is constructed in the production composition at
  `open/composer.ts:3975`. Only the scheduler loop is missing — it appears outside
  its own test solely in `loop/registry.ts:9`, which still lists it among the loops
  that never start in any composition.

Two further narrowings, same method. The publish-resume item keeps only (b)/(c),
because its classifier landed but `PUBLISH_CREDENTIAL_CLASS`
(`trident/orchestrator.ts:856`) has **zero production consumers** — a whole-tree
search returns exactly one hit, its own export. And the terminal-cause item is now
exactly located: `terminalCause` is emitted on two paths only
(`trident/inner-workflow.mjs:7470`, `:7524`), the three review-verdict paths emit
nothing, and `trident/delivery.ts` has zero reads of it.

### 22 items, not 31

Twenty still-wanted, plus two the audit produced rather than inherited:

- **One marked `needs_spec`** — per-project context for agent tools. Its "X6
  follow-ons" were never enumerated anywhere in the tree, so it has no definition
  of done and a branch cut from it would be building from an invented
  specification (standard §3.1/§3.2). The open question sits at the top of the
  body: either an acceptance list is written, or it is decided that the
  `''`-binds-global paths at `gateway/cores/active-project-context.ts:25-29` are
  the intended terminal state and the item closes as won't-do.
- **One new item split off an entry that is otherwise done.** The infra auto-retry
  shipped, but its acceptance (d) — visibility — never did: `on_infra_retry`
  (`trident/orchestrator.ts:387`) is declared, read at `:2197`, and passed in
  exactly one place, a test (`trident/infra-retry.test.ts:217`); and
  `infra_retries` exists in the schema (`migrations/expected-schema.txt:631`) but
  is absent from `RunProgress` (`trident/run-progress.ts:60-100`), so the wire type
  the card renders cannot express "retrying, attempt 2". Retrying silently replaces
  one invisible state with another, which is the opposite of what the retry was
  for. Marking the parent done and losing this would have been the eleventh stale
  fact, arriving fresh.

Item bodies are preserved verbatim — they are detailed and evidence-carrying and
that is their value. `## Acceptance` sections of falsifiable checkboxes were added
to 20 of the 22 where the item's own text grounds them, per §3.3 (a criterion a
broken implementation would also satisfy is not a criterion). The two without are
the `needs_spec` item and the HITL policy line, whose text supports none — writing
criteria there would have been fabrication.

### The index is generated, and a test keeps it that way

`scripts/spec-items-index.ts` renders `docs/spec-items/README.md` from the
frontmatter, grouped and priority-ordered, with the cutover-blocking and
not-yet-buildable items called out at the top.
`scripts/__tests__/spec-items-index.test.ts` fails the build when the committed
index drifts from what the script produces — including a positive control that
proves the renderer actually renders, since the drift assertion would otherwise
pass trivially if `buildIndex` were ever reduced to reading the file back. It also
validates every item's frontmatter against closed sets, which caught two
over-length titles of my own during this change.

A hand-maintained list was the alternative and it is the thing the standard names
as the failure: it becomes a second queue that disagrees with the first, usually
within a week.

### `SPEC.md` after the split

509 lines from 1,292. The section is replaced by a short pointer naming where each
part of its contents went — the queue to `docs/spec-items/`, the onboarding phase
set to `contracts/onboarding-phase.ts`, the shipped P5/P6/P7 and Core inventory to
`docs/SYSTEM-OVERVIEW.md` and `docs/as-built/`, the refactor ledger to its own
plan. The phase vocabulary is not reproduced: `rg "Phases → Steps"` across the tree
finds **no code citation at all**, only this file and historical records, so
keeping a vocabulary paragraph for citations that do not exist would have been
preserving a fiction.

The governance preamble said agents "NEVER rewrite it — the owner owns it." That
described a file that also held the queue. It now states the split it actually
needs: the owner owns the Decisions Log and the architecture body; agents maintain
the spec-items queue. A Decisions Log entry dated 2026-09-12 records the split at
the top of the log, and the `Canonical doc set` table names `docs/spec-items/` and
the standard.
