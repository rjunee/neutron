## 2026-09-27 — Bound planning probes and retain useful preparation

Implements a narrow instruction-delivery slice of
`docs/spec-items/trident-build-efficiency.md:154–166,180–201` while preserving
the initial planner and host authorities in
`docs/spec-items/planner-selected-execution-strategy.md:15–39`.

The measured run `3d30acde-7e95-4e52-8d74-1ed2f0bab3e1` refreshed an existing
candidate onto base `71f4aa84`. Its `plan.result:16–19` records a trial cherry-pick,
validation, and reset to the base before instructing the builder to repeat that
work. The retained planner transcript `agent-a425cac3dffeb9421.jsonl:53–64`
records 178 focused tests passing in 23.35 seconds and six consuming tests passing
in 10.84 seconds. Those invocations overlapped: their roughly 34 seconds of
summed test durations are not elapsed planning time. The builder transcript
`agent-a1541602919796cc4.jsonl:25–37` records the repeated cherry-pick and the same
178/six tests passing in 19.32/10.28 seconds. Planning also executed four leak
scans: three against the same trial candidate and one clean-base control
(`agent-a425cac3dffeb9421.jsonl:63,73,81,91`). The later candidate scans recovered
output discarded by earlier filtering. The base comparison had a distinct
diagnostic purpose; neither all planning time nor every repeated validation is
classified as unnecessary. Changed base inputs required fresh builder and host
proof. These observations establish repeated work, not token cost or savings.

`open/wiring/project-build.ts` now delivers a planning boundary with every fresh
planner brief: identify the uncertainty before a targeted probe, leave complete
candidate validation to the builder, retain useful preparatory changes, report
the measured resulting revision, and capture complete probe output once for
later inspection. Planning keeps its writable tools. The driver already accepts
the honestly measured planner head (`trident/build-run.ts:755–760`); returning to
the original head was not a host requirement. The change does not turn planning
evidence into approval or remove affected builder validation and host proof.

Fresh planner bytes use `plan.strategy-v4.brief`. Historical v2 rendering remains
byte-exact; an existing v3 planner brief is reused only when its bytes match the
historical rendering of current inputs. Changed task or unrecognized planner
instructions refuse reconstruction without rewriting stored bytes. Existing
builder/reviewer/fixer brief identities, provider routing, strategy selection,
budgets, and gates remain under their existing owners.

Validation on the candidate based on `71f4aa84`:

- `bun test open/__tests__/project-build-e2e.test.ts -t 'planner work boundary|every dispatched brief states|v2 pending builder reconstruction|legacy v2|initial planner chooses'`:
  15 passed, zero failed, 352 filtered out, 291 assertions, 19.62 seconds.
  The real child receives the instruction and writable grant; a useful planner
  commit reaches the builder as its starting snapshot and survives publication
  and merge. Existing v2 recovery, v3 lost-ack recovery, changed-input refusal,
  and all four initial strategy/repository combinations are included.
- Semantic mutations, restored afterward: omitting the new paragraph fails the
  observed-child-brief assertion; making planning read-only fails the observed
  writable-grant assertion. In both cases the separate envelope control passes
  (one failed/one passed). Bypassing the v3 byte comparison admits changed planner
  instructions and fails the expected refusal; unchanged v3 recovery still
  passes (one failed/one passed). The restored 15-case run above is green.
- Both `tsc --noEmit -p tsconfig.json` and
  `tsc --noEmit -p trident/tsconfig.json` passed using the installed TypeScript
  binary. ESLint passed for both changed TypeScript files. Dependencies were
  installed locally with the frozen lockfile and copyfile backend; no lockfile
  change was required.

Integration CI on `d1b4da4ed1d47fb2ea9df7343fb9c7b33ffc7701` subsequently exposed
coverage missing from that selected run: the wiring test's exact prompt oracle,
two continuation fixtures reading a hard-coded v3 filename, and historical
planner/builder recovery. The last group was a production omission:
`trident/project-build-host.ts` recognized only live v2/v3 brief paths while
validating original historical reservations. Fresh v4 planner paths therefore
prevented otherwise eligible recovery before the authority comparison ran.

The corrected host recognizes v4 only for the planner. Other roles still accept
only v2/v3; the original historical filename, observed byte integrity, provider,
model, effort, grants, budget, workspace and result path remain exact checks.
Historical fixtures now record the actual pre-boundary prompt bytes and their
integrity before dispatch. Continuation evidence is read through the persisted
planner reservation rather than an invented filename. The independent wiring
oracle includes the new paragraph. A host matrix exercises plan v2/v3/v4 success,
plan v5 refusal and v4 refusal for build/review/fix.
The complete consuming Open E2E and wiring files passed together (418 cases,
5,143 assertions), as did the complete host file (55 cases, 201 assertions).
Two restored semantic mutations of the role/version guard failed by assertion:
removing planner v4 made its legitimate recovery case red (six controls still
passed); admitting v4 for build/review/fix made all three forbidden-role cases
red (four controls still passed). Restoring the exact guard made all seven
role/version cases pass. Both root and Trident TypeScript checks and the actual
repository lint passed after the correction.

The tests prove delivered instructions and preserved host behavior with scripted
workers. They do not prove that a model follows the instructions or establish
deployed time/token savings. No active run artifact was changed. Complete
partitioned-suite validation, independent review, CI, deployment and fresh live
measurement remain separate integration work; this slice does not close #1196.
