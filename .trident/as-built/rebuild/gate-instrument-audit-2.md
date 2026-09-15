## Gate instrument audit — six remaining subjects

### Scope and method

The inventory rows were enumerated by matching each subject's exported predicates and G-number comments to the complete `| GNNN |` table in `docs/trident-gates-inventory.md`; this examined G007-G009, G012, G030, G033, G061-G074, G083, G085-G086, G100, and G107-G108. The inventory defines the historical baseline and labels old anchors explicitly (`docs/trident-gates-inventory.md:55-58`). For each subject below, “predicate” quotes the decisive expression rather than surrounding implementation. “Worker influence” distinguishes authored payloads from host commands and host-read files.

Verdicts use **pass**, **finding**, and **note**. A finding has an executable counterexample and provenance. A note records a concern without claiming a defect.

### `brief-integrity` — pass

Property (G030): “Branch-log and branch-brief data are delimiter-neutralized and byte-capped before being used as untrusted prompt material” (`docs/trident-gates-inventory.md:99`). Predicate: the receipt increments once per encoded byte, applies FNV-1a, and returns byte count plus padded hash (`trident/gates/brief-integrity.ts:3-8`, `trident/gates/brief-integrity.ts:22-38`). This helper measures byte identity, while delimiter neutralization and caps remain outside its subject; persisted segments are independently read back and compared before a receipt is emitted (`trident/brief-parts.ts:67-81`).

1. Too permissive — pass: the live admission gate recomputes the receipt from the file instead of accepting a worker's assertion (`trident/build-host.ts:142-149`).
2. Too strict — pass: the string and byte implementations explicitly agree even for malformed surrogate input (`trident/brief-parts.ts:13-21`).
3. Environment — pass: the predicate is pure arithmetic and requires no external tool (`trident/gates/brief-integrity.ts:2-38`).
4. Prose contradiction — pass: “byte-count and FNV-1a receipt” matches the returned byte count and FNV update (`trident/gates/brief-integrity.ts:1-8`, `trident/gates/brief-integrity.ts:38`).
5. Can see — pass: admission reads the actual brief path and hashes those bytes (`trident/build-host.ts:142-149`).
6. Can be lied to — pass: a worker can influence file contents, but the expected receipt is in the host request and the host recomputes the actual receipt (`trident/build-host.ts:143-149`).
7. Subject width — pass: this helper claims only receipt computation; the broader G030 prompt controls remain owned elsewhere (`trident/gates/brief-integrity.ts:1-2`, `docs/trident-gates-inventory.md:99`).

### `build-claim` — pass

Property (G100): “A real builder-claim/head disagreement refuses PR creation and review after preserving the branch on origin; an unresolvable claim is absent” (`docs/trident-gates-inventory.md:184`). Predicate: exit 1 from quiet `rev-parse` allows; equal resolved and measured OIDs allow; a different resolved OID is refused only after a remote receipt matches the measured head (`trident/gates/build-claim.ts:15-19`, `trident/gates/build-claim.ts:20-36`).

1. Too permissive — pass: different real commits reach the preservation-and-block path (`trident/gates/build-claim.ts:19-36`).
2. Too strict — pass: an unresolvable claim and an equal resolved claim both allow (`trident/gates/build-claim.ts:17-19`).
3. Environment — pass: git and the remote are explicit host dependencies, and every unreadable result becomes unknown rather than permission (`trident/gates/build-claim.ts:13-18`, `trident/gates/build-claim.ts:20-34`).
4. Prose contradiction — pass: the comment's “independently resolve” and “preserve before refusing” are the actual order (`trident/gates/build-claim.ts:7-8`, `trident/gates/build-claim.ts:15-36`).
5. Can see — pass: the measured head arrives in `BuildSnapshot`, while the claim is independently resolved by git (`trident/gates/build-claim.ts:8-15`).
6. Can be lied to — pass: the worker supplies the claim, but cannot supply either git resolution or the post-push remote receipt (`trident/build-run.ts:344-354`, `trident/gates/build-claim.ts:15-20`, `trident/gates/build-claim.ts:31-34`).
7. Subject width — pass: preservation, receipt, and refusal are all present (`trident/gates/build-claim.ts:20-36`).

Provenance: the old implementation normalized a plausible claim and resolved it through quiet `rev-parse`, treating anything unresolved as absent (`pre-#845 trident/orchestrator.ts:2322-2335`); it deferred conflict refusal until after publication was witnessed (`pre-#845 trident/orchestrator.ts:2538-2546`, `pre-#845 trident/orchestrator.ts:2719-2738`). The rebuilt predicate preserves that deliberate design.

### `escalation` — finding: nonblocking findings can trigger the repeat stop

Properties: G070 says “A repeated actionable finding across fix rounds triggers a stop” (`docs/trident-gates-inventory.md:149`); G071 counts blocker/major findings (`docs/trident-gates-inventory.md:150`); G072 keeps unreadable identity/count evidence undecidable (`docs/trident-gates-inventory.md:151`); G068-G069 and G073-G074 constrain self-declarations and bounded re-plans (`docs/trident-gates-inventory.md:147-153`). Predicates: repeat is set intersection over supplied identities (`trident/gates/escalation.ts:46-62`), progress compares the last two finite counts (`trident/gates/escalation.ts:72-77`), and declarations admit only two named kinds with nonempty text (`trident/gates/escalation.ts:80-96`).

1. Too permissive — pass for declarations: unknown kinds, empty text, and APPROVE-plus-declaration are refused (`trident/gates/escalation.ts:80-96`).
2. Too strict — **finding** for G070: a repeated `minor` finding is treated as a repeat even though the verdict vocabulary names `minor` nonblocking (`trident/gates/verdict.ts:13-14`, `trident/gates/verdict.ts:27-34`).
3. Environment — pass: all escalation predicates are pure over recorded values (`trident/gates/escalation.ts:25-77`, `trident/gates/escalation.ts:99-152`).
4. Prose contradiction — pass inside `escalation.ts`; the mismatch is at its supplier, which calls its list “actionable” while excluding only `nit` (`trident/gates/review-panel.ts:104-106`).
5. Can see — **finding**: the predicate can express unreadable lists and identities (`trident/gates/escalation.ts:33-62`), but its live supplier records a wider set than G070 names (`trident/gates/review-panel.ts:104-106`).
6. Can be lied to — pass for stop arithmetic: reviewer findings originate in worker payloads, but synthesis is compared with the independently recorded payload (`trident/gates/review-panel.ts:96-103`) and the repeat decision itself is host arithmetic (`trident/gates/escalation.ts:46-53`). Self-declared causes remain assertions and are restricted to the two explicit kinds (`trident/gates/escalation.ts:80-96`).
7. Subject width — **finding**: “actionable” is narrower than “not nit”; the live predicate includes `minor` (`docs/trident-gates-inventory.md:149`, `trident/gates/review-panel.ts:104-106`).

Demonstrating case: a direct call with the same valid `minor` finding in both rounds returns `{ outcome: 'repeat', repeated: ['x.ts:x:r'] }`; this follows directly from identity extraction and intersection (`trident/gates/escalation.ts:25-30`, `trident/gates/escalation.ts:46-53`). The live supplier also retains that `minor` identity because it filters only `nit` (`trident/gates/review-panel.ts:105-106`). That input should not stop under G070 because the shared verdict taxonomy classifies `minor` as nonblocking (`trident/gates/verdict.ts:13-14`, `trident/gates/verdict.ts:27-34`).

Provenance: the pre-rebuild repeat predicate also intersected every supplied identity (`pre-#845 trident/inner-workflow.mjs:3614-3621`), but its surrounding verdict taxonomy explicitly classified minor and nit as nonblocking (`pre-#845 trident/inner-workflow.mjs:3064-3087`). The re-home introduced the demonstrated live wiring at `trident/gates/review-panel.ts:105-106`; this is an **introduced-by-re-home lost narrowing**, not a deliberate old behavior evidenced by the original rationale.

### `release-readiness` — pass, with one documented non-atomic limit

Properties: G083 requires PR mode and a locally resolved full head (`docs/trident-gates-inventory.md:167`); G085 requires readable remote state and G086 first-push ancestry (`docs/trident-gates-inventory.md:169-170`); G107 requires a PR number/full reviewed pin and remote head pin, while G108 requires actual PR refs, same-repository head, and assessable drift (`docs/trident-gates-inventory.md:196-197`). Predicates are local-head equality plus remote-state/first-push ancestry (`trident/gates/release-readiness.ts:17-38`) and live PR identity, fetched refs, file-sized diff, fetched-head equality, and drift (`trident/gates/release-readiness.ts:46-88`).

1. Too permissive — pass: mismatched local/remote heads, foreign PRs, excessive diffs, and overlap block (`trident/gates/release-readiness.ts:23-35`, `trident/gates/release-readiness.ts:60-61`, `trident/gates/release-readiness.ts:82-86`).
2. Too strict — pass: ancestry is required only when the remote branch is absent, exactly G086's first-publication scope (`trident/gates/release-readiness.ts:25-37`).
3. Environment — pass: git and `gh` failures become unknown; the diff is measured through a file because command output may be capped (`trident/gates/release-readiness.ts:54-80`, `trident/gates/release-readiness.ts:88`).
4. Prose contradiction — pass: comments name G083/G085/G086 and G107/G108 and state the remaining effect-level head pin (`trident/gates/release-readiness.ts:14-16`, `trident/gates/release-readiness.ts:43-45`).
5. Can see — pass: actual PR refs are queried then fetched before diff/drift measurement (`trident/gates/release-readiness.ts:54-69`, `trident/gates/release-readiness.ts:75-86`).
6. Can be lied to — pass: snapshot values are host observations and are rechecked against local git and the remote service (`trident/production-host-effects.ts:325-328`, `trident/gates/release-readiness.ts:21-25`, `trident/gates/release-readiness.ts:54-69`).
7. Subject width — pass: the readiness predicate deliberately excludes atomic merge enforcement, and the effect records that the base may move between observation and merge (`trident/gates/release-readiness.ts:43-45`, `trident/production-host-effects.ts:368-372`).

Provenance: first-push ancestry was deliberately limited to a missing observed remote ref in the prior publisher (`pre-#845 trident/orchestrator.ts:2583-2607`), and claim/head refusal deliberately followed the remote witness (`pre-#845 trident/orchestrator.ts:2719-2738`). No demonstrated re-home regression.

### `result-contract` — finding: numeric domains were lost

Properties: G007 says a PR number “must be a positive integer” (`docs/trident-gates-inventory.md:71`); G008 says reported rounds must be safe integers (`docs/trident-gates-inventory.md:72`); G009 requires exact booleans and a full commit for built output (`docs/trident-gates-inventory.md:73`); G012 bounds and closes terminal causes (`docs/trident-gates-inventory.md:76`). Predicate: the rebuilt Forge schema types `prNumber` as number-or-null, and the Plan schema types `remainingTasks` as number (`trident/gates/result-contract.ts:136-162`); primitive number validation checks only JavaScript type (`trident/gates/result-contract.ts:198-201`).

1. Too permissive — **finding**: negative, fractional, non-finite PR numbers and remaining-task counts validate successfully (`trident/gates/result-contract.ts:145-150`, `trident/gates/result-contract.ts:158-163`, `trident/gates/result-contract.ts:198-201`).
2. Too strict — pass: optional fields are checked only when present and the schema explicitly permits the documented nulls (`trident/gates/result-contract.ts:141-150`, `trident/gates/result-contract.ts:207-210`).
3. Environment — pass: validation is pure and does not assume external facilities (`trident/gates/result-contract.ts:176-220`).
4. Prose contradiction — **finding** against the inventory: `number` does not encode “positive integer” or “safe integer” (`docs/trident-gates-inventory.md:71-72`, `trident/gates/result-contract.ts:145-162`).
5. Can see — pass: the type can carry the bad values; the predicate simply does not reject them (`trident/gates/result-contract.ts:81-85`, `trident/gates/result-contract.ts:198-201`).
6. Can be lied to — **finding**: these are worker trailer fields, and successful validation returns the same object without normalization (`trident/gates/result-contract.ts:216-220`).
7. Subject width — **finding**: the inventory's numeric qualifications are absent from the schema predicates (`docs/trident-gates-inventory.md:71-72`, `trident/gates/result-contract.ts:145-162`).

Demonstrating cases: direct validation accepted Forge trailers with `prNumber` equal to `-1`, `1.5`, `NaN`, and `Infinity`, and Plan trailers with the same four `remainingTasks` values. The accepting path is the number type check (`trident/gates/result-contract.ts:198-201`) followed by returning the original value (`trident/gates/result-contract.ts:216-220`).

Provenance: the old decoder admitted a PR number only when it was an integer greater than zero, otherwise producing null (`pre-#845 trident/inner-loop.ts:859-869`); it admitted remaining work only when finite, then clamped and truncated it (`pre-#845 trident/inner-loop.ts:956-960`). This is **introduced by the re-home**: the replacement schema lost both domain predicates.

### `verdict` — pass for the live gate; note on an unwired exported helper

Properties: G061 permits an upgrade only for a nonempty set entirely composed of nonblocking findings (`docs/trident-gates-inventory.md:135`), and G062 prevents model-supplied reserved markers from weakening the gate (`docs/trident-gates-inventory.md:136`). Predicate: nonblocking means exact own `advisory: true` or severity minor/nit, while lane-marked and nonblocking findings are excluded from fix work (`trident/gates/verdict.ts:13-39`).

1. Too permissive — pass in the live panel: its closed result schema rejects worker-supplied `advisory` and `kind` fields as unexpected (`trident/gates/result-contract.ts:88-101`, `trident/gates/result-contract.ts:204-210`), and only blocker/major findings buy fixes (`trident/gates/review-panel.ts:104-118`).
2. Too strict — pass in the live panel: minor/nit findings do not enter the blocker set and can approve only with the host-recorded approval checkpoint (`trident/gates/review-panel.ts:104-121`).
3. Environment — pass: predicates are pure (`trident/gates/verdict.ts:17-39`).
4. Prose contradiction — pass: the own-property explanation matches `Object.hasOwn` (`trident/gates/verdict.ts:19-28`).
5. Can see — note: `eligibleFixFindings` can express unknown input by returning null (`trident/gates/verdict.ts:37-39`), but production review uses its own blocker filter (`trident/gates/review-panel.ts:104-118`).
6. Can be lied to — pass in the live path: reserved model fields fail the closed schema before severity arithmetic (`trident/gates/result-contract.ts:90-100`, `trident/gates/result-contract.ts:204-210`, `trident/gates/review-panel.ts:98-105`).
7. Subject width — pass for G061-G062 in the live panel; the unused helper is not itself the live instrument (`trident/gates/review-panel.ts:98-121`).

Positive-control absence proof: the same `rg -n "eligibleFixFindings" trident --glob '*.ts'` invocation found the known export at `trident/gates/verdict.ts:37` and test imports/calls at `trident/__tests__/escalation-gate.test.ts:35,47,84,659-689`, but no production call. Thus the helper is presently unwired; this is a note, not a finding, because the live closed-schema and blocker predicates enforce G061-G062 (`trident/gates/result-contract.ts:88-101`, `trident/gates/review-panel.ts:104-121`).

Provenance: the prior implementation stripped worker-supplied advisory and reserved kind markers before gating (`pre-#845 trident/inner-workflow.mjs:3090-3144`) and upgraded only a nonempty all-nonblocking rejection (`pre-#845 trident/inner-workflow.mjs:3218-3223`). The rebuilt closed schema rejects those marker shapes instead of stripping them (`trident/gates/result-contract.ts:88-101`, `trident/gates/result-contract.ts:204-210`); the enforced trust boundary remains intact.

### Deliberately not changed

No production code or tests were changed, as required. The two introduced defects are reported rather than repaired. No full test suite or harness-child script was run; demonstrating cases used direct Bun imports of the pure predicates. No spec decision was changed.
