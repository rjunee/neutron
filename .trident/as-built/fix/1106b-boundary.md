## 2026-09-17 — Bound dispatch consumption to the current submission (#1106)

### Change and evidence

A persistent transcript can already contain the exact dispatch from an earlier attempt.
Capture its byte size and file identity under the acquired turn slot before submission
(`runtime/workers/claude-acting-turn.ts:76`, `runtime/workers/claude-acting-turn.ts:142`,
`runtime/workers/claude-acting-turn.ts:153`). After capture, recheck expiry before actuation
(`runtime/workers/claude-acting-turn.ts:154`). The host maintains this boundary for every
invocation; it does not require the REPL to cooperate with the observation mechanism.

At dispatch expiry, classify only bytes after that boundary as `consumed`, `not-consumed`
or `unreadable`. Exact user string or text-block matches establish consumption; failures
to establish/read the boundary stay unreadable (`runtime/workers/claude-acting-turn.ts:71`,
`runtime/workers/claude-acting-turn.ts:87`, `runtime/workers/claude-acting-turn.ts:102`).
File replacement and observed size shrink invalidate the baseline
(`runtime/workers/claude-acting-turn.ts:94`). There is one transcript read at expiry,
not in the polling loop (`runtime/workers/claude-acting-turn.ts:169`).

All three states join the existing `unknown` outcome vocabulary
(`runtime/workers/claude-acting-turn.ts:181`, `runtime/workers/project-runners.ts:31`).
The caller preserves that detail in its explicit non-ended branch and returns unknown,
without a new outcome falling through a default (`runtime/workers/project-runners.ts:138`,
`runtime/workers/project-runners.ts:146`). The existing three-state subagent observation
is retained (`runtime/workers/claude-acting-turn.ts:48`); `grep -c observeSubagents
runtime/workers/claude-acting-turn.ts` returned **2**.

### Acceptance and decisions

The table-driven fixture at `runtime/workers/claude-acting-turn.test.ts:439` enumerates
11 scenarios. It pre-seeds identical production-form dispatch text and multibyte history
at :445–450. Current string/block consumption, historical-only non-consumption, decoys,
missing/unreadable transcripts, failed baseline capture, replacement and truncation are
asserted at :490–495. Every case stays unknown. Transcript access occurs only at the
logical deadline (:496), and expiry during baseline capture prevents dispatch (:504).

Use bytes rather than timestamps to avoid timestamp precision and transcript clock
assumptions. Treat initial ENOENT as offset zero so a newly created transcript can prove
consumption (:81); inability to read at expiry remains unreadable (:98). Say no worker
was *observed*, because even consumed text does not prove the worker did not run (:172).
The mechanism assumes an append-only transcript between observations; it detects visible
shrink/replacement, not an in-place rewrite that regrows on the same inode. The file is
read once in full, then sliced (:96); this adds an expiry-only size cost, not per-poll I/O.

No spec/product decision changed. Did not change terminal acknowledgement, retry behavior,
worker creation evidence, host timeout semantics, or add a flag/alternate execution path.
The staged issue's transcript-path citation moved from :49–50 to pre-change :77, now :118;
its backend citation remains `runtime/adapters/claude-code/persistent/pty-host.ts:194`.
The prior implementation was inspected with `git show dee42d86`; only its matching idea
was reused. The current directory observer was retained rather than reverting #1105.

Updated the adjacent obsolete observation comment in the test (:368). A phrase search
for `REPL did not accept|cannot reach: the REPL|No worker was observed` across runtime,
docs and hidden records returned the positive-control current message at worker :181
and test assertion at :370. Frozen historical records were not edited.

### Mutation proof

Every row ran `bun test runtime/workers/claude-acting-turn.test.ts -t '<filter>'`.
The mutated source line was printed before running. Each mutation exited **1** with the
named test failing; restoring the source made the same command exit **0**. These are
classification/control-flow mutations, not message edits. Lines below refer to
`runtime/workers/claude-acting-turn.ts`; the ordering mutation adds a line after :155.

| Guard / line | Mutation actually applied | Filter | Observed |
|---|---|---|---|
| String :104 | return not-consumed on exact match | dispatch consumption: string | RED → GREEN |
| Blocks :106 | return not-consumed on exact block | dispatch consumption: blocks | RED → GREEN |
| Negative :109 | return consumed after unmatched scan | dispatch consumption: historical only | RED → GREEN |
| Read error :98 | catch returns not-consumed | dispatch consumption: read failure | RED → GREEN |
| Boundary :96 | subarray(0) | dispatch consumption: historical only | RED → GREEN |
| Ordering :153/:156 | mutable boundary, recaptured after submitLine | dispatch consumption: string | RED → GREEN |
| User type :102 | if (false) continue | dispatch consumption: decoys | RED → GREEN |
| Text type :106 | replace block type condition with true | dispatch consumption: decoys | RED → GREEN |
| Exact match :104 | use string includes(dispatch) | dispatch consumption: decoys | RED → GREEN |
| Initial ENOENT :81 | return undefined for missing file | dispatch consumption: created after boundary | RED → GREEN |
| Initial EIO :81 | return offset zero for other errors | dispatch consumption: stat failure | RED → GREEN |
| Regular file :79 | replace isFile() with true | dispatch consumption: bad boundary | RED → GREEN (unexpected open) |
| Unknown baseline :88 | return not-consumed | dispatch consumption: bad boundary | RED → GREEN |
| Shrink :94 | replace size comparison with false | dispatch consumption: truncated | RED → GREEN |
| Identity :95 | replace identity comparison with false | dispatch consumption: replaced | RED → GREEN |
| Expiry :154 | remove post-stat expiry check | expiry during boundary capture | RED → GREEN (submitted) |
| Poll cost :167 | insert await dispatchConsumption before each observation | dispatch consumption: string | RED → GREEN (extra opens) |
| #1105 :58 | unreadable directory returns absent | an UNREADABLE subagent path | RED → GREEN (lost ENOTDIR detail) |
| Outcome :181 | unknown becomes turn-ended | dispatch consumption: | 11 RED → 11 GREEN |

### Final verification

- `bun test runtime/workers/claude-acting-turn.test.ts`: **53 pass, 0 fail**, 190 assertions.
- `bunx tsc --noEmit`: exit **0** (root server configuration).
- `bash scripts/ci/lint.sh`: every listed gate green.
- `git diff --check`: exit **0**.

No whole-suite run or network operation. The task explicitly requests this staging path
instead of the normal docs/as-built location. Commit locally for orchestrator review;
do not push, open a PR, or merge from this lane.
