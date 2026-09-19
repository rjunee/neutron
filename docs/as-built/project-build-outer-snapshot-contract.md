## 2026-09-19 — Describe and enforce the complete build snapshot envelope

The role briefs named `result: {head, diff, pr, payload}` and fully described
the role payload, but never explained that the outer `pr` was an observed
object rather than a PR number. A worker could return a valid forge payload
inside an unusable snapshot and receive only a generic schema refusal.

All four role briefs now embed the shared outer snapshot schema and explicitly
distinguish `result.pr` from the forge payload's `result.payload.prNumber`
(`open/wiring/project-build.ts:392`). Workers copy the measured PR object or
null from their host context; the host does not normalize an untrusted number.
The same schema supplies the headless review envelope (`:353`). Its validator
requires the complete PR identity, permits the three observed PR states and
rejects malformed numbers, arrays and incomplete objects
(`open/wiring/project-build-snapshot.ts:28`). Role payload validation and the
driver's independent snapshot corroboration remain in place (`:567`).

Outer-contract failures name only the field and expected shape. The decoder
still returns unknown, with no worker-controlled values or suite evidence
included in the diagnostic. A consuming driver regression supplies a valid
build payload with numeric outer `pr`, then asserts the specific refusal,
only plan/build dispatches, and no publication
(`open/__tests__/project-build-e2e.test.ts:1125`). Every emitted role brief is
checked for the full shared schema (`:1108`). Focused decoding controls prove
valid objects survive unchanged and null remains valid independently of the
payload's PR number (`open/__tests__/project-build-snapshot.test.ts:15`).

Validation: the explicit consuming E2E file plus focused snapshot tests passed
103 tests. Root and Trident TypeScript checks, focused ESLint and whitespace
checks passed. Three restored semantic mutations were rejected: accepting
numeric PRs failed the refusal guard; rejecting valid PR objects failed the
object control while null passed; rejecting null failed its control while
objects passed. The restored focused suite passed all 14 tests. A content
search for the removed inline PR schema found the shared validator and schema
references as its positive control. No live run artifact, PR, deployment or
publication was changed; this is offline evidence for the contract repair.
