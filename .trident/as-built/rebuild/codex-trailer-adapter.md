## 2026-09-15 — Codex trailer claim adapter

### Defect measurement

Before changing the runner, ran the original six worker tests plus a regression
through the actual driver: 7 passed. The pinned flat claim
`{ HEAD: 'measured-head', STATUS: 'ok' }` failed against
`{ head: 'measured-head', diff: '+built\n', pr: null }` with
`built-head-unverified`. A structured claim containing those same compared
values advanced to review. The retained reproduction and positive control are
at runtime/workers/codex-headless.test.ts:125-134; the driver predicate reads
lowercase head, full diff text, and PR equality at trident/build-run.ts:72-76.
The helper invokes buildRun itself, not a copied predicate
(runtime/workers/codex-headless.test.ts:96-122).

### Implementation and decisions

The adapter replaces the flat map with a structured claim, returning it only
after mapping succeeds (runtime/workers/codex-headless.ts:155-159). Its complete
required-key set is enumerated by the loop at
runtime/workers/codex-headless.ts:57: HEAD, DIFF, PR.

The actual writer emits prefixed keys, a diff-file path, and an explicitly empty
PR value (trident/codex-build.sh:795,858-860). The adapter resolves the
trailer-named artifact against the worker cwd and reads its exact text
(runtime/workers/codex-headless.ts:71). This is dereferencing the claim's
artifact, not obtaining independent evidence. A missing or unreadable artifact
is unknown; a readable artifact's contents still have to agree with the host.

An explicit empty PR maps to null. A nonempty PR cannot map because this wrapper
does not provide its head and state; return unknown naming both missing fields
(runtime/workers/codex-headless.ts:64-74). No protocol extension or guessed PR
state was introduced. Missing keys, empty head/path, duplicate keys, and malformed
lines retain distinct explanatory details (runtime/workers/codex-headless.ts:52-69).
The referenced diff may contain newlines and equals signs; the fixture uses both
(runtime/workers/codex-headless.test.ts:10,24).

The existing outcome vocabulary is BoundedWorkOutcome, including unknown
(runtime/bounded-work.ts:97-103). The driver's explicit unknown case preserves it
before measurement; completed claims receive independent measurement and exact
comparison, with disagreement becoming built-head-unverified
(trident/build-run.ts:124-134). There is no new public outcome or permissive
default. Agreement is demonstrated by advancing to the deliberately unscripted
review step; that step's unknown is distinct from a build-step unknown
(runtime/workers/codex-headless.test.ts:120,143-159).

Continuous enforcement is the mapping check on every successful wrapper return
(runtime/workers/codex-headless.ts:155-156), followed by the independent driver
check (trident/build-run.ts:131-134). It does not require the worker to keep
running or to validate its own claim.

### Mutation evidence

Each mutation below was applied individually, compiled with
`bun build runtime/workers/codex-headless.ts --target=bun --external '*'`,
and run against the named test selection. Each produced a runtime assertion
failure, then passed with the original source restored. The mutation runner
printed the actual changed line before evaluating each result.

| Guard / behavior | Actual mutation location and replacement | Catching test | Mutated / restored |
| --- | --- | --- | --- |
| Malformed line | runtime/workers/codex-headless.ts:52: condition becomes false | malformed line is unknown (:185) | RED / GREEN |
| Duplicate key | runtime/workers/codex-headless.ts:54: condition becomes false | duplicate fields are ambiguous (:180) | RED / GREEN |
| Required keys | runtime/workers/codex-headless.ts:58: condition becomes false | missing HEAD/DIFF/PR stays unknown (:155) | RED / GREEN |
| Empty head | runtime/workers/codex-headless.ts:65: condition becomes false | empty HEAD is unknown (:163) | RED / GREEN |
| Empty diff path | runtime/workers/codex-headless.ts:66: condition becomes false | empty DIFF is unknown (:163) | RED / GREEN |
| Incomplete PR | runtime/workers/codex-headless.ts:69: condition becomes false | PR number alone lacks the compared PR head and state (:170) | RED / GREEN |
| Unreadable artifact | runtime/workers/codex-headless.ts:74: return mapped with empty diff | unreadable diff artifact is unknown (:175) | RED / GREEN |
| Missing claim must not borrow evidence | runtime/workers/codex-headless.ts:156: on unknown, return completed with JSON.parse(await readFile(req.brief.path, 'utf8')).snapshot | missing HEAD/DIFF/PR stays unknown despite matching measured snapshot in brief (:155) | RED / GREEN |
| Missing head must not borrow evidence | runtime/workers/codex-headless.ts:155: append missing HEAD from JSON.parse(await readFile(req.brief.path, 'utf8')).snapshot.head before mapping | missing HEAD stays unknown despite matching measured snapshot in brief (:155) | RED / GREEN |
| Structured output | runtime/workers/codex-headless.ts:159: return uppercase HEAD/STATUS map | mapped claim agrees with independent host measurement (:143) | RED / GREEN |

Test line references in the table are in runtime/workers/codex-headless.test.ts.
The laundering fixture deliberately contains the complete measured snapshot in
the brief (runtime/workers/codex-headless.test.ts:27). The mutation runs after
mapping returns unknown, so earlier mapping guards cannot hide it. It returns
completed with the host's values: a wrong answer, not a parser or type error.
All three missing-key tests catch this reachable substitution. A second laundering
mutation filled only the absent HEAD from that snapshot before mapping; the HEAD
test failed with completed instead of unknown, then passed after restoration.

### Validation and limits

- Worker test files enumerated with `rg --files runtime/workers`; ran
  `bun test runtime/workers/codex-headless.test.ts runtime/workers/claude-in-repl.test.ts`:
  45 passed, 0 failed.
- Targeted ESLint over both changed TypeScript files: passed.
- `git diff --check`: passed.
- `bun run typecheck` reports missing script; the scripts object is
  package.json:57-63. Ran the root equivalent `bunx --no-install tsc --noEmit`.
  It reports errors in untouched fixtures: typed array equality at
  gateway/transcription/__tests__/whisper-install.test.ts:186, process listener
  overload at logger/__tests__/fire-and-forget.test.ts:301, and crc32 import at
  onboarding/history-import/__tests__/zip-writer.ts:10. These are outside lane
  scope and recorded as pre-existing; no assertions were loosened.
- Diagnostic search `rg -n 'runtime/workers|error TS' /tmp/adpt-typecheck.log`
  returned those three errors and no worker diagnostics. The error alternative
  is the positive control.
- Whole-tree phrase search for the old test wording plus its replacement
  returned the replacement at runtime/workers/codex-headless.test.ts:41.
  Command: `rg -n 'returns the measured trailer rather than stdout|maps the wrapper claim and referenced diff rather than stdout' . --glob '!node_modules/**'`.

Deliberately did not change driver comparison, wrapper launch arguments, publication,
host measurement, transport modules, or product decisions. This is a bounded
adapter repair, not a claim that the complete production launch pipeline is
validated. Did not run the full suite, push, open a PR, or merge. This record uses
the lane-requested .trident location; the general process document was reread
before writing it.
