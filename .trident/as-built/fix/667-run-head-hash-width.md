## 2026-09-14 — Full run-head and checkpoint hash widths (#667)

### Change and evidence

Run-head recognition accepts exactly 40 or 64 lowercase hexadecimal digits after
existing normalization (`trident/merge.ts:1389`, `trident/inner-workflow.mjs:4206`).
Abbreviations still cannot nominate reviewed heads (`trident/merge.ts:1410`).
The published checkpoint keeps its field order and optional deviation suffix;
its producer still interpolates the Git-witnessed head (`trident/orchestrator.ts:5074`).
Readers now accept either width (`trident/inner-workflow.mjs:4350`,
`trident/inner-workflow.mjs:7751`, `trident/orchestrator.ts:2152`,
`trident/orchestrator.ts:3919`, `trident/checkpoint-round.ts:32`).

The Bash alternation captures the OID, moving its round to group 2. The fix-round
branch still reads group 1; both save the digits before restoring locale
(`trident/checkpoint.sh:531`, `trident/checkpoint.sh:535`). Existing numeric bounds
are preserved (`trident/checkpoint-round.ts:32`).

Following the value uncovered adjacent blockers: authority probe output, publisher
head/pin, launch base/ownership, workflow base arguments, and persisted seed pins.
The mutation table below enumerates every changed recognizer by its final source
line. Store insertion maintains valid seed pins even when the prior workflow has
died (`trident/store.ts:674`). Its predicate and the seed reader agree
(`trident/run-disposition.ts:375`, `trident/run-disposition.ts:384`).

No new outcome joins the taxonomy. Valid published names remain review resumes
(`trident/inner-workflow.mjs:4351`), built-never-reviewed dispositions
(`trident/run-disposition.ts:198`), and published evidence with zero remaining tasks
(`trident/fire-evidence.ts:218`). Malformed publish pins still throw and reach the
existing failed-run catch (`trident/orchestrator.ts:2588`,
`trident/orchestrator.ts:5097`); their text is still unrecognized by the publish
classifier, whose default is `publish-unknown` (`trident/orchestrator.ts:970`).
Invalid seed pins retain `TridentIncompleteSeedError` (`trident/store.ts:675`).

### Persisted compatibility decision

Decision: widen the existing format and leave the producer emitting the full
repository head. See `docs/spec-items/run-head-hash-width.md` and the 2026-09-14
Decisions Log entry in `SPEC.md`. No migration, prefix, truncation or second format.

New readers accept old checkpoints. **Old readers are not forward-compatible.**
I extracted and executed the old normalization and resume functions directly from
base `eb38883d`, then exercised the following table:

| Old reader input | Observed result |
|---|---|
| 40-digit checkpoint and matching 40-digit companion/live head | review |
| 64-digit checkpoint and matching 64-digit companion/live head | rebuild / no-recorded-head |
| 64-digit checkpoint and matching 40-digit companion/live head | rebuild / unknown-checkpoint |
| Version-prefixed checkpoint and matching 40-digit companion/live head | rebuild / unknown-checkpoint |

The old anchored parser rejects the string rather than truncating its OID; the
fallback silently discards its meaning (`trident/inner-workflow.mjs:4311`,
`trident/inner-workflow.mjs:4373`, on the base). The old round parser answers null,
and the old evidence classifier can answer none, not published
(`trident/checkpoint-round.ts:105`, `trident/fire-evidence.ts:233`). That can cost
completed work. A version prefix cannot change already-running code, so it does
not provide the proposed loud refusal. Keeping checkpoints restricted to 40 digits
would instead deny the requested capability. We choose widening with an explicit
operational limit: drain old readers before sharing SHA-256 checkpoint state, and
drain such runs before rollback. No automatic deployment interlock is claimed.

### Verification and mutation results

Read the supplied #638 diff before editing. Its exact-width alternatives are the
convention used here; its shell ref classifier additionally asks Git for the actual
repository format. I verified our adopted exact-width property with real SHA-1 and
SHA-256 Git repositories (`trident/run-head-width.test.ts:60`), including real local
and remote reads and abbreviated-output refusal. I did not rerun #638's complete
sentinel/ref-name proof and do not claim independent verification of that part of
the exemplar. This change does not touch a refusing sentinel.

The source-domain test selects each executable recognizer by a surrounding statement,
asserts exactly one match, and tests both valid widths and invalid neighbors
(`trident/run-head-width.test.ts:11`, `trident/run-head-width.test.ts:37`). These are
regex-domain proofs, not claims that every enclosing branch was reached. Behavioral
coverage supplements them: full existing resume, round and disposition scenarios run
under both widths (`trident/inner-workflow-resume.test.ts:36`,
`trident/checkpoint-round.test.ts:13`, `trident/run-disposition.test.ts:27`), plus
publisher/refire, launch, argument and database fixtures
(`trident/orchestrator.test.ts:441`, `trident/orchestrator.test.ts:7626`,
`trident/orchestrator.test.ts:7640`, `trident/inner-loop.test.ts:462`,
`trident/store.test.ts:735`). The old resume harness supplied its own 40-only regex;
it now extracts the shipped declaration (`trident/inner-workflow-resume.test.ts:782`).

For every row below, I replaced the alternative at exactly the printed source line
with `[0-9a-f]{40}`, ran the test, then with `[0-9a-f]+`, ran the test, restored the
original bytes and ran green. Parentheses and other fields were left intact.
The runner printed the actual modified line before each execution. Counts are
failing assertions/tests reported by Bun, not merely a nonzero process exit.
The shell row uses `checkpoint-round.test.ts`; other rows use `run-head-width.test.ts`.

| Recognizer | 40-only mutation | Unbounded mutation | Restored |
|---|---|---|---|
| `trident/merge.ts:1389` | RED (2) | RED (7) | GREEN |
| `trident/inner-workflow.mjs:4206` | RED (1) | RED (5) | GREEN |
| `trident/inner-workflow.mjs:4350` | RED (1) | RED (5) | GREEN |
| `trident/inner-workflow.mjs:7751` | RED (1) | RED (5) | GREEN |
| `trident/orchestrator.ts:2089` | RED (2) | RED (7) | GREEN |
| `trident/orchestrator.ts:2099` | RED (2) | RED (7) | GREEN |
| `trident/orchestrator.ts:2152` | RED (1) | RED (5) | GREEN |
| `trident/orchestrator.ts:2562` | RED (1) | RED (5) | GREEN |
| `trident/orchestrator.ts:2588` | RED (1) | RED (5) | GREEN |
| `trident/orchestrator.ts:3919` | RED (1) | RED (5) | GREEN |
| `trident/orchestrator.ts:3927` | RED (1) | RED (5) | GREEN |
| `trident/orchestrator.ts:4005` | RED (1) | RED (5) | GREEN |
| `trident/orchestrator.ts:4179` | RED (1) | RED (5) | GREEN |
| `trident/orchestrator.ts:4210` | RED (1) | RED (5) | GREEN |
| `trident/orchestrator.ts:4248` | RED (1) | RED (5) | GREEN |
| `trident/orchestrator.ts:4501` | RED (1) | RED (5) | GREEN |
| `trident/checkpoint-round.ts:32` | RED (1) | RED (5) | GREEN |
| `trident/checkpoint.sh:516` | RED (6) | RED (10) | GREEN |
| `trident/run-disposition.ts:375` | RED (1) | RED (5) | GREEN |
| `trident/run-disposition.ts:384` | RED (1) | RED (5) | GREEN |
| `trident/store.ts:599` | RED (1) | RED (5) | GREEN |
| `trident/inner-loop.ts:600` | RED (1) | RED (5) | GREEN |

Additional capture mutation: `trident/checkpoint.sh:535`, change group 2 to group 1:
RED (12 failures); restored GREEN (174 tests).

The first permissive shell mutation stayed green. Inspection confirmed it landed on
the reachable parser, but the Bash comparison corpus had no abbreviated input. The
corpus now includes invalid neighboring widths (`trident/checkpoint-round.test.ts:102`);
the rerun failed ten cases. No assertion was weakened. One existing publisher test
expected the obsolete 40-only error wording; it now asserts the full replacement
message while retaining the no-Git-call refusal assertion
(`trident/orchestrator.test.ts:1424`).

Final commands and results:

- `bun test trident/run-head-width.test.ts trident/inner-workflow-resume.test.ts trident/checkpoint-round.test.ts trident/run-disposition.test.ts trident/orchestrator.test.ts trident/store.test.ts trident/inner-loop.test.ts scripts/__tests__/spec-items-index.test.ts`: 1,097 passed, zero failures.
- `bash scripts/ci/typecheck-all.sh`: all 51 configurations passed. The repository has
  no root typecheck script, so this is its documented matrix command. Final affected
  package check: `bunx tsc --noEmit -p trident/tsconfig.json`, passed.
- `bash scripts/ci/lint.sh`: passed. `git diff --check`: passed.
- Leak gate: exit 1, one finding in the pre-existing untracked `.git` worktree pointer;
  private PII file/message rules could not run without the local denylist. This is not
  reported as a clean leak check. Private validation remains for the orchestrator.

### Scope and documentation sweep

Updated the spec item, generated index, Decisions Log, current seed invariants and
stale #638 scope paragraphs in this change. Searches for `FULL_OID`,
`outer-published`, `40-hex` and `40 hex characters` enumerated the affected prose.
Historical as-built records and the completed round narrative in
`IMPLEMENTATION_PLAN.md:32` stay historical. Current checkpoint declarations were
checked with `rg -n 'outer-published.*40' trident`: the positive controls are the
new alternatives at `trident/checkpoint-round.ts:32` and `trident/checkpoint.sh:516`.

Deliberately not a repository-wide SHA-256 certification. Other Git helpers remain
narrow, including claimed-commit resolution (`trident/orchestrator.ts:2362`), stash
capture (`trident/orchestrator.ts:3253`), and optional build-agent claim decoding
(`trident/inner-workflow.mjs:4217`). They were enumerated using the same `{40}` search
that finds the widened production alternatives, not an empty grep. No network work,
push, PR creation or merge was performed. Staging failed because the existing
worktree Git index is on a read-only filesystem. The working-tree diff and this
record are ready, but staging and the required local commit need writable Git
metadata. No commit is claimed.
