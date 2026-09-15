## 2026-09-15 — Bounded driver and REPL contract fixes

### Scope and decisions

Implements the three owner rulings for WIRE12. The present-tense contract and
immutable decision entry are updated at `SPEC.md:64` and `SPEC.md:307`.
This shard uses the lane's explicitly required staging location.

### Granted roots

`ClaudeActingSession.grants.roots` is required host-owned launch evidence at
`runtime/workers/claude-acting-turn.ts:15`. The binding snapshots and normalizes
the session cwd plus additional roots at `runtime/workers/claude-acting-turn.ts:23`.
Every dispatch checks the resolved relative path's first segment before acquiring
a turn or submitting text (`runtime/workers/claude-acting-turn.ts:31`,
`runtime/workers/claude-acting-turn.ts:48`). A sibling prefix such as `/a/bc`
does not inherit `/a/b` access; the refusal names granted roots at
`runtime/workers/claude-acting-turn.ts:34`.

The host maintains this check on every invocation; it does not require the child
to acknowledge a refusal. Bindings must be replaced when sessions are replaced
(`runtime/workers/claude-acting-turn.ts:8`). This is lexical path resolution,
matching the requested contract, not a new filesystem sandbox or symlink policy.
The positive worktree, normalized path, segment escape, parent escape and frozen
binding cases are at `runtime/workers/claude-acting-turn.test.ts:187` and
`runtime/workers/claude-acting-turn.test.ts:205`.

### Trailer result and nullable telemetry

The completed vocabulary now permits null usage and reported model at
`runtime/bounded-work.ts:104`; thread already permits null there. Decoder identity,
schema, kind and payload checks precede telemetry (`runtime/workers/project-runners.ts:46`).
Missing or throwing host metadata supplies three nulls only after validation
(`runtime/workers/project-runners.ts:59`). This also ignores forged telemetry
fields in the trailer: only host metadata is spread at `runtime/workers/project-runners.ts:62`.
The former test requiring metadata was changed because it contradicted the owner
ruling; validator refusal remains asserted at `runtime/workers/project-runners.test.ts:149`.
Malformed payload, wrong step and unreadable JSON remain unknown in the new
combined regression at `runtime/workers/project-runners.test.ts:184`.

The driver records partial usage with unknown counters and keeps cumulative
unknown counters unknown across later measured attempts (`trident/build-run.ts:303`,
`trident/build-run.ts:306`). Unknown model provenance uses `unknown-model` in the
existing string source vocabulary (`trident/build-run.ts:313`, `trident/phase-usage.ts:13`).
The completion path still proceeds to independent measurement at `trident/build-run.ts:319`.
Regression: `trident/build-run.test.ts:1346`.

The panel previously used configured families, independent of reported model.
That configured calculation remains at `trident/gates/review-panel.ts:76`, but the
source now records explicit null family for null model telemetry at
`trident/project-review-source.ts:98`. The panel carries it into
`panel-unknown-family`, suppressing a same-family conclusion
(`trident/gates/review-panel.ts:85`, `trident/gates/review-panel.ts:91`).
This joins the existing advisory `panel-single-family` diagnostic vocabulary;
unknown family does not invalidate a validated review. Run, revision, round,
provider and configured model provenance still gate results at
`trident/gates/review-panel.ts:84`. The source binding and panel comparison are
both exercised at `trident/project-review-source.test.ts:152`.

### Effort consumer enumeration

Enumerated production TypeScript with
`rg -n '\bEffort\b|req\.effort|request\.effort|effort: route.effort|JSON.stringify\(req\)' --glob '*.ts' --glob '!*.test.ts'`.
Positive controls are the contract definition (`runtime/bounded-work.ts:56`) and
its request field (`runtime/bounded-work.ts:71`). Followed whole-request forwarding
and the headless wrapper beyond those direct hits. The consumer inventory is:

| Consumer | Behavior for xhigh and max | Evidence |
| --- | --- | --- |
| Contract / fake runner | Both values are typed; scripted requests are retained unchanged | `runtime/bounded-work.ts:56`, `runtime/bounded-work.ts:169` |
| Phase-model vocabulary, defaults, overrides, validator | Both are existing values; membership is checked; accepted values and defaults are copied. Existing CLI/non-model phase configuration rejection remains a separate transport policy. | `trident/phase-models.ts:104`, `trident/phase-models.ts:441`, `trident/phase-models.ts:629`, `trident/phase-models.ts:638`, `trident/phase-models.ts:673`, `trident/phase-models.ts:702` |
| Review request producer | Removes the obsolete three-value refusal and copies the chosen effort | `trident/project-review-source.ts:44`, `trident/project-review-source.ts:83` |
| Driver / project routing | Spread or forward the complete request, without reducing effort | `trident/build-run.ts:276`, `runtime/workers/project-runners.ts:114`, `runtime/workers/project-runners.ts:132` |
| Claude acting turn and subagent prompt | Both travel unchanged in JSON dispatch/request data | `runtime/workers/claude-acting-turn.ts:53`, `runtime/workers/claude-in-repl.ts:59` |
| Codex in-REPL | Both travel unchanged as reasoning_effort and in request data | `runtime/workers/codex-in-repl.ts:59`, `runtime/workers/codex-in-repl.ts:62` |
| Pi in-REPL | Both travel unchanged in request data and explicit host binding; that host must enforce or refuse unavailable capabilities | `runtime/workers/pi-in-repl.ts:18`, `runtime/workers/pi-in-repl.ts:72`, `runtime/workers/pi-in-repl.ts:88` |
| Codex headless | Exhaustive typed map forwards both values exactly to the wrapper | `runtime/workers/codex-headless.ts:24`, `runtime/workers/codex-headless.ts:126`, `runtime/workers/codex-headless.ts:137` |
| Codex exec wrapper | Forwards CODEX_BUILD_EFFORT to model_reasoning_effort; its recorded measured upper value is xhigh | `trident/codex-build.sh:1410`, `trident/codex-build.sh:1418` |

Codex exec's wrapper forwards an effort string at `trident/codex-build.sh:1420`;
its earlier xhigh probe at `trident/codex-build.sh:1410` is not an exhaustive
transport vocabulary. Therefore both extended values are forwarded unchanged.
An initial new test expecting a max refusal was wrong: the in-tree transport can
express max. It was replaced with successful-dispatch plus exact-value assertions
at `runtime/workers/codex-headless.test.ts:204`, with both downgrade mutations red.
Provider acceptance on a live model is not established by these offline tests.
The previous plan's instruction to map max to another tier was superseded at
`docs/plans/2026-08-09-multi-substrate-build-agent.md:223`.

The existing `capability-unsupported` refusal vocabulary still covers unavailable
grants (`runtime/workers/claude-acting-turn.ts:27`, `runtime/bounded-work.ts:113`);
the driver classifies refusals as blocked, unknown results as unknown, and valid
completed results proceed (`trident/build-run.ts:294`). No new outcome kind or
transport refusal is added. The exhaustive Record and typed forwarding tests keep
new effort values from acquiring an implicit default.

A whole-tree phrase search combined the obsolete cwd/telemetry/three-effort refusal
sentences with `export type Effort` as a positive control. It returned the two
Effort definitions at `runtime/bounded-work.ts:56` and `trident/phase-models.ts:105`,
with no old sentence hit. Historical decision entries were preserved.

### Deliberate limits

No launcher composition, durable outcome handoff, provider credential work, new
backend, feature flag, or live transport probing is included. The fake transports
verify dispatch contracts and refusal boundaries, not provider acceptance on a
live authenticated session. No whole-suite run, push, PR creation or merge was
performed. The lane task explicitly requires a local commit for orchestrator review.

### Mutation evidence

Each row below was run separately, after printing the actual changed source line.
Each mutant passed `bunx tsc -p <owning-project>/tsconfig.json --noEmit` (exit 0),
then gave a wrong runtime answer under `bun test <test-file> -t <test-name>`.
The source was restored in a finally block and that same selected test passed.
The listed table covers the 23 retained mutation scenarios for this final change.
The type-only union extension is checked by typed xhigh/max fixtures and both
project typechecks; the old runtime effort admission is a compiling behavioral
reversion, not an intentionally untypeable test.

Test keys (all read in this session):

- A: `runtime/workers/claude-acting-turn.test.ts:188` — granted root accepts.
- B: `runtime/workers/claude-acting-turn.test.ts:197` — granted root refuses segment escape.
- C: `runtime/workers/claude-acting-turn.test.ts:205` — session descendants and frozen binding.
- D: `runtime/workers/project-runners.test.ts:184` — missing/throwing telemetry and invalid trailers.
- E: `trident/build-run.test.ts:1346` — null usage and cumulative counters after a fix.
- F: `trident/project-review-source.test.ts:152` — null model and unknown panel family.
- G: `trident/project-review-source.test.ts:145` — selected extended review effort.
- H: `runtime/workers/codex-headless.test.ts:205` — extended headless effort unchanged.
- I: `runtime/workers/claude-acting-turn.test.ts:217` — acting turn extended effort.
- J: `runtime/workers/codex-in-repl.test.ts:303` — extended in-REPL effort unchanged.
- K: `runtime/workers/claude-in-repl.test.ts:249` — extended in-REPL effort unchanged.
- L: `runtime/workers/pi-in-repl.test.ts:316` — extended in-REPL effort unchanged.

| Guard / source line printed | Compiling mutation at that line | Test / red failures | Restored |
| --- | --- | --- | --- |
| `runtime/workers/claude-acting-turn.ts:31` | `if (resolve(request.cwd) !== resolve(session.cwd))` | A / 3 | GREEN |
| `runtime/workers/claude-acting-turn.ts:33` | `return resolve(request.cwd).startsWith(root)` | B, `/a/bc` / 1 | GREEN |
| `runtime/workers/claude-acting-turn.ts:33` | `return true` | B, sibling, normalized escape, parent / 3 | GREEN |
| `runtime/workers/claude-acting-turn.ts:31` | Read `[session.cwd, ...binding.grants.roots]` on each call | C / 1 | GREEN |
| `runtime/workers/project-runners.ts:61` | `if (!metadata) return unknown('Host observation missing.')` | D / 1 | GREEN |
| `runtime/workers/project-runners.ts:60` | `metadata = host.metadata(request)` without the telemetry catch | D / 1 | GREEN |
| `runtime/workers/project-runners.ts:58` | Replace payload validation condition with `false` | D, bad payload becomes completed / 1 | GREEN |
| `runtime/workers/project-runners.ts:49` | Replace step identity condition with `false` | D, wrong step becomes completed / 1 | GREEN |
| `runtime/workers/project-runners.ts:64` | Catch returns `{ kind: 'completed', result: {}, usage: null, model_reported: null, thread_id: null }` | D, malformed JSON becomes completed / 1 | GREEN |
| `trident/build-run.ts:306` | Input total uses `(priorUsage?.input_tokens ?? 0) + (outcome.usage?.input_tokens ?? 0)` | E / 1 | GREEN |
| `trident/build-run.ts:307` | Output total uses `(priorUsage?.output_tokens ?? 0) + (outcome.usage?.output_tokens ?? 0)` | E / 1 | GREEN |
| `trident/build-run.ts:306` | Remove `priorUsage?.input_tokens === null` from the unknown condition | E, later fix incorrectly resets unknown / 1 | GREEN |
| `trident/build-run.ts:307` | Remove `priorUsage?.output_tokens === null` from the unknown condition | E, later fix incorrectly resets unknown / 1 | GREEN |
| `trident/build-run.ts:313` | Remove `priorUsage?.source === 'unknown-model'` from the unknown condition | E / 1 | GREEN |
| `trident/project-review-source.ts:98` | `family: seat.family` | F / 1 | GREEN |
| `trident/gates/review-panel.ts:85` | `if (observed.family === null) unknownFamily = false` | F, incorrectly emits panel-single-family / 1 | GREEN |
| `trident/project-review-source.ts:45` (inserted line) | `if (effort !== 'low' && effort !== 'medium' && effort !== 'high') throw Error(...)` | G / 2 | GREEN |
| `runtime/workers/codex-headless.ts:24` | `max: 'high'` | H, max / 1 | GREEN |
| `runtime/workers/codex-headless.ts:24` | `xhigh: 'high'` | H, xhigh / 1 | GREEN |
| `runtime/workers/claude-acting-turn.ts:53` | Dispatch JSON uses `effort: request.effort === 'max' ? 'high' : request.effort` | I, max / 1 | GREEN |
| `runtime/workers/codex-in-repl.ts:59` | `reasoning_effort: req.effort === 'max' ? 'high' : req.effort` | J, max / 1 | GREEN |
| `runtime/workers/claude-in-repl.ts:59` | Prompt request JSON uses `effort: req.effort === 'max' ? 'high' : req.effort` | K, max / 1 | GREEN |
| `runtime/workers/pi-in-repl.ts:88` | Host request uses `effort: req.effort === 'max' ? 'high' : req.effort` | L, max / 1 | GREEN |

Reachability controls matter here: the malformed cases keep a registered validator
and otherwise valid nonempty payload; the family fixture has two enabled same-family
seats; the cumulative fixture runs a later fix; the headless downgrade fixtures reach
the wrapper and check the exact observed environment field. These controls are in
D, F, E and H respectively, at the cited test lines.

### Final local validation

- `bun test runtime/workers/ runtime/__tests__/bounded-work.test.ts trident/__tests__/phase-model-coverage.test.ts trident/project-review-source.test.ts trident/build-run.test.ts trident/gates/review-panel.test.ts`: **419 passed, 0 failed**, 11 files.
- `bunx tsc -p runtime/tsconfig.json --noEmit`: exit 0.
- `bunx tsc -p trident/tsconfig.json --noEmit`: exit 0.
- `bunx eslint` on the 15 changed TypeScript files: exit 0.
- `git diff --check`: exit 0; this shard has exactly one level-two heading.

Test locations were enumerated with `rg --files runtime trident`, matching both
the brief's spellings and the actual `__tests__` paths, with
`trident/project-review-source.test.ts` as a known-present control. The command
above uses the discovered files rather than silently leaving the contract or
phase-model coverage out of the run. The TypeScript checks initially caught two
readonly test-configuration assignments; fixtures now replace the configuration
object (`trident/project-review-source.test.ts:147`,
`trident/project-review-source.test.ts:154`). Assertions were not loosened.
