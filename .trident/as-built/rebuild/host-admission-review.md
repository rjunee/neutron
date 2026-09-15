## 2026-09-15 — Host admission and recorded review policies

### Scope and wiring

The host calls project admission after brief verification and calls recorded review with the run identity from its mutation context (`trident/build-host.ts:63`, `trident/build-host.ts:72`, `trident/build-host.ts:76`). Optional typed observation sources are the composition hole (`trident/build-host.ts:27`); omission returns unknown (`trident/gates/project-admission.ts:22`, `trident/gates/review-panel.ts:63`). The later composer lane must supply authoritative project records, configured seats, review records and retry effects through these inputs, never construct them from worker trailers (`trident/gates/project-admission.ts:12`, `trident/gates/review-panel.ts:22`).

### Re-homed policies and decisions

| Gate IDs and inventory fate | Source read this session | Delivered behavior |
| --- | --- | --- |
| G016, keep-in-place (`docs/trident-gates-inventory.md:80`) | `trident/orchestrator.ts:4405`, `trident/orchestrator.ts:4428`, `trident/orchestrator.ts:4479` | Refresh configured remote base; resolve local branch; require containment or prior-run descent and readable recorded-head ownership (`trident/gates/project-admission.ts:30`, `trident/gates/project-admission.ts:55`). |
| G017, keep-in-place (`docs/trident-gates-inventory.md:81`) | `trident/orchestrator.ts:4268`, `trident/orchestrator.ts:4306` | Re-run negative ancestry between two complete-depth observations. Shallow, timed-out and unreadable probes remain unknown (`trident/gates/project-admission.ts:42`). |
| G057–G058, re-home-to-TS (`docs/trident-gates-inventory.md:131`) | `trident/inner-workflow.mjs:4864`, `trident/inner-workflow.mjs:5339`, `trident/inner-workflow.mjs:2498` | Enabled core and configured peer seats require usable observed results, matching run/head/round/provider/model. Deferred, unavailable and rate-limited seats block by configured name (`trident/gates/review-panel.ts:65`, `trident/gates/review-panel.ts:71`). |
| G059, re-home-to-TS (`docs/trident-gates-inventory.md:133`) | `trident/inner-workflow.mjs:2516`, `trident/inner-workflow.mjs:2538` | At most one immediate retry per missing/deferred seat, then re-read authoritative state. Completed, unavailable and rate-limited seats are not retried (`trident/gates/review-panel.ts:48`). |
| G060, re-home-to-TS (`docs/trident-gates-inventory.md:134`) | `trident/inner-workflow.mjs:5420` | Missing, malformed or thrown synthesis observation returns unknown, preserving infrastructure uncertainty (`trident/gates/review-panel.ts:77`, `trident/gates/review-panel.ts:97`). |
| G061, re-home-to-TS (`docs/trident-gates-inventory.md:135`) | `trident/inner-workflow.mjs:2427`, `trident/inner-workflow.mjs:5351` | Nonempty all-minor/nit rejection can approve only after panel and checkpoint checks; empty rejection cannot. Every seat's major/blocker findings survive synthesis as stable fix identities (`trident/gates/review-panel.ts:88`, `trident/gates/review-panel.ts:94`). |
| G062, re-home-to-TS (`docs/trident-gates-inventory.md:136`) | `trident/inner-workflow.mjs:2348` | Strip model advisory and reserved lane/suite markers before schema validation and severity arithmetic (`trident/gates/review-panel.ts:36`, `trident/gates/review-panel.ts:61`). |
| G104, keep-in-place (`docs/trident-gates-inventory.md:193`) | `trident/orchestrator.ts:5228` | Worker result must match recorded synthesis; approval additionally requires the recorded approval checkpoint for this run, head and round (`trident/gates/review-panel.ts:78`, `trident/gates/review-panel.ts:83`, `trident/gates/review-panel.ts:95`). |

Keep-in-place sources remain intact; this change wires their policy into the rebuilt host. Deliberately disabled seats retain the existing project configuration meaning; this is not a new feature switch (`trident/gates/review-panel.ts:65`; original disabled-seat reporting: `trident/inner-workflow.mjs:5370`). Per the lane brief, an enabled seat with unavailable provider refuses by name, instead of using the old unconnected-peer grace path (`trident/gates/review-panel.ts:72`; old grace wording: `trident/inner-workflow.mjs:5376`).

Preserved the explicit prior-head unreadable-object exception: prior-base descent remains sufficient when the recorded commit cannot be read, as in the old implementation (`trident/orchestrator.ts:4464`, `trident/gates/project-admission.ts:64`). This is not proof of recorded-head ownership; when that object is readable, its ancestry must pass (`trident/gates/project-admission.ts:66`).

No new outcome vocabulary: admission uses GateResult allow/blocked/unknown (`trident/build-run.ts:21`, consumed at `trident/build-run.ts:86`). Review uses ReviewDecision approve/fix/blocked/unknown (`trident/build-run.ts:22`); blocked goes to the orchestrator, unknown stops, approve exits review, and fix enters the bounded repair/arbitration loop (`trident/build-run.ts:152`). Explicit design-gap/missing-dependency requests block for orchestrator arbitration (`trident/gates/review-panel.ts:86`). Stable identities reuse the existing file/symbol/rule function (`trident/gates/escalation.ts:25`, `trident/gates/review-panel.ts:90`).

The maintaining mechanism is fresh host reads at each gate call, plus deterministic refusal before the driver advances (`trident/gates/project-admission.ts:24`, `trident/gates/review-panel.ts:69`, `trident/gates/review-panel.ts:77`, `trident/build-run.ts:103`, `trident/build-run.ts:152`). It does not rely on a failed review worker to report its own failure: absent records and exhausted retries refuse (`trident/gates/review-panel.ts:48`, `trident/gates/review-panel.ts:70`). Ancestry bracketing is a measurement, not a repository lock; the old discussion already limits its guarantee against two opposing depth changes within the bracket (`trident/orchestrator.ts:4298`).

### Validation

- Targeted command: `bun test trident/build-host.test.ts trident/gates/project-admission.test.ts trident/gates/review-panel.test.ts` — 31 passed, 190 assertions.
- Real Git control: shallow clone yields unknown; the same repository after unshallowing yields allow (`trident/gates/project-admission.test.ts:98`).
- Host integration admits a legitimate run and approves its authoritative recorded panel (`trident/build-host.test.ts:284`).
- `bun run typecheck` reports missing script. Used `bunx tsc -p trident/tsconfig.json --noEmit` — passed.
- `bash scripts/ci/lint.sh` — passed. No full test suite was run.
- Full local leak gate exited 3 (incomplete): the private PII denylist is not installed in this environment. No network or credential workaround was attempted; the orchestrator must run that gate with its configured denylist before publication.

The former major-finding assertion used only an unobserved worker payload and expected blocked. It now expects unknown for the missing source (`trident/build-host.test.ts:126`), because a worker claim cannot establish the recorded panel. This is an intentional outcome correction, not removal of the severity check: observed major/blocker findings must return exact stable fix identities in `trident/gates/review-panel.test.ts:72`.

### Mutation evidence

Enumerated each explicit refusal return in the two new policy files, then added depth/ancestry, readable-ownership, retry, disabled-seat, marker-stripping and severity mutations. For each row: wrote and printed the actual changed source line, compiled with `bun build <file> --target=bun --packages=external`, ran that file's test suite, required an assertion failure (not a compiler failure), restored the original, and reran the same suite green. All 44 mutations compiled, gave a wrong answer, and reddened; all 44 restorations passed. Review's permissive value is `approve`, not `allow`, in its existing vocabulary (`trident/build-run.ts:22`).

Each test reference below identifies the first failing test in that mutation run. Table entries are the complete mutation inventory, generated from those 44 recorded executions.

| Guard | Mutation | RED test | Restored |
| --- | --- | --- | --- |
| `trident/gates/project-admission.ts:22` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:34` — RED | GREEN |
| `trident/gates/project-admission.ts:25` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:34` — RED | GREEN |
| `trident/gates/project-admission.ts:28` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:34` — RED | GREEN |
| `trident/gates/project-admission.ts:31` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:34` — RED | GREEN |
| `trident/gates/project-admission.ts:33` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:34` — RED | GREEN |
| `trident/gates/project-admission.ts:38` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:34` — RED | GREEN |
| `trident/gates/project-admission.ts:41` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:34` — RED | GREEN |
| `trident/gates/project-admission.ts:56` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:51` — RED | GREEN |
| `trident/gates/project-admission.ts:58` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:51` — RED | GREEN |
| `trident/gates/project-admission.ts:59` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:70` — RED | GREEN |
| `trident/gates/project-admission.ts:61` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:70` — RED | GREEN |
| `trident/gates/project-admission.ts:62` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:70` — RED | GREEN |
| `trident/gates/project-admission.ts:68` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:70` — RED | GREEN |
| `trident/gates/project-admission.ts:69` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:70` — RED | GREEN |
| `trident/gates/project-admission.ts:73` | refusal → { kind: 'allow' } | `trident/gates/project-admission.test.ts:34` — RED | GREEN |
| `trident/gates/project-admission.ts:44` | return depth.ok && depth.stdout.trim() === 'false' → return true | `trident/gates/project-admission.test.ts:51` — RED | GREEN |
| `trident/gates/project-admission.ts:48` | if (probe.ok) return 'yes' → if (probe.ok) return 'no' | `trident/gates/project-admission.test.ts:26` — RED | GREEN |
| `trident/gates/project-admission.ts:51` | if (confirm.ok) return 'yes' → if (confirm.ok) return 'no' | `trident/gates/project-admission.test.ts:51` — RED | GREEN |
| `trident/gates/project-admission.ts:49` | return 'unknown' → return 'yes' | `trident/gates/project-admission.test.ts:51` — RED | GREEN |
| `trident/gates/project-admission.ts:52` | return 'unknown' → return 'yes' | `trident/gates/project-admission.test.ts:51` — RED | GREEN |
| `trident/gates/project-admission.ts:66` | if (present.ok) { → if (false) { | `trident/gates/project-admission.test.ts:70` — RED | GREEN |
| `trident/gates/project-admission.ts:57` | if (contained === 'yes') return { kind: 'allow' } → if (contained === 'yes') return { kind: 'blocked', on: 'mutation' } | `trident/gates/project-admission.test.ts:26` — RED | GREEN |
| `trident/gates/review-panel.ts:62` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:26` — RED | GREEN |
| `trident/gates/review-panel.ts:63` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:26` — RED | GREEN |
| `trident/gates/review-panel.ts:66` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:26` — RED | GREEN |
| `trident/gates/review-panel.ts:70` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:26` — RED | GREEN |
| `trident/gates/review-panel.ts:71` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:26` — RED | GREEN |
| `trident/gates/review-panel.ts:72` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:51` — RED | GREEN |
| `trident/gates/review-panel.ts:74` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:26` — RED | GREEN |
| `trident/gates/review-panel.ts:78` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:26` — RED | GREEN |
| `trident/gates/review-panel.ts:80` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:26` — RED | GREEN |
| `trident/gates/review-panel.ts:83` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:67` — RED | GREEN |
| `trident/gates/review-panel.ts:86` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:72` — RED | GREEN |
| `trident/gates/review-panel.ts:91` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:72` — RED | GREEN |
| `trident/gates/review-panel.ts:94` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:72` — RED | GREEN |
| `trident/gates/review-panel.ts:95` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:26` — RED | GREEN |
| `trident/gates/review-panel.ts:97` | refusal → { kind: 'approve' } | `trident/gates/review-panel.test.ts:26` — RED | GREEN |
| `trident/gates/review-panel.ts:41` | delete clean.advisory → // mutation: keep advisory | `trident/gates/review-panel.test.ts:90` — RED | GREEN |
| `trident/gates/review-panel.ts:42` | if (clean.kind === 'lane' \|\| clean.kind === 'suite') delete clean.kind → // mutation: keep reserved kind | `trident/gates/review-panel.test.ts:90` — RED | GREEN |
| `trident/gates/review-panel.ts:50` | if (observed === null \|\| observed.status === 'deferred') { → if (false) { | `trident/gates/review-panel.test.ts:51` — RED | GREEN |
| `trident/gates/review-panel.ts:50` | if (observed === null \|\| observed.status === 'deferred') { → if (true) { | `trident/gates/review-panel.test.ts:19` — RED | GREEN |
| `trident/gates/review-panel.ts:65` | source.seats.filter(seat => seat.enabled) → source.seats.filter(() => true) | `trident/gates/review-panel.test.ts:19` — RED | GREEN |
| `trident/gates/review-panel.ts:88` | f.severity !== 'minor' && f.severity !== 'nit' → false | `trident/gates/review-panel.test.ts:72` — RED | GREEN |
| `trident/gates/review-panel.ts:88` | f.severity !== 'minor' && f.severity !== 'nit' → true | `trident/gates/review-panel.test.ts:72` — RED | GREEN |

### Deliberate boundaries and content sweep

Did not modify the launcher, driver, gateway or open composer; did not add a second execution path, delete source files, change the spec decisions, push or open a PR. The delivered code scope is the two host files and the four new gate/test files, enumerated using `git diff --name-only` plus `git ls-files --others --exclude-standard`; the requested record is staged here under the explicit lane override of the general as-built location.

Searched working-tree TypeScript and Markdown, including hidden directories, with `rg --hidden -n 'Complete project admission policy is not wired|Review panel provenance, cross-model seats and arbitration are not wired|Project admission observation source is missing' . --glob '*.ts' --glob '*.md' --glob '!.git/**' --glob '!node_modules/**'`. Positive control found `trident/gates/project-admission.ts:22` and `trident/build-host.test.ts:120`. The only old wording hit was the previous lane's historical search record at `.trident/as-built/rebuild/host-policies.md:76`, which stays immutable. This is a working-tree content search, not a claim about a fetched remote tree.
