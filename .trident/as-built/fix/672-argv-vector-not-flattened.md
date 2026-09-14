## 2026-09-14 — Recorded-pid identity consumes the argv vector (#672)

### Change and evidence

Linux reads `/proc/<pid>/cmdline` and splits only NUL separators, preserving empty
arguments and whitespace inside paths (`runtime/adapters/claude-code/persistent/orphan-adoption.ts:370`).
The dependency now requires a vector (`runtime/adapters/claude-code/persistent/orphan-adoption.ts:228`)
and the pid identity gate consumes it directly (`runtime/adapters/claude-code/persistent/orphan-adoption.ts:595`).
Both production force-kill rechecks use the vector reader:
`runtime/adapters/claude-code/persistent/boot-adoption.ts:976` and
`runtime/adapters/claude-code/persistent/supervision.ts:140`.
These sites were enumerated with `rg -n 'readCmdline|defaultReadCmdline|cmdlineMatchesSession|argvMatchesSession'`.

The regression constructs inert native children, including a binary under a spaced
path. It reads the same child's actual proc vector and flattened ps listing:
`runtime/adapters/claude-code/persistent/__tests__/orphan-adoption.test.ts:457`.
The spoof's flattened string matches, but the real vector is refused; the genuine
launch shape is accepted, with empty arguments and a newline-containing path
preserved (:468–482). The fixture compiles with `cc`; it does not run an authenticated
Claude session. The native proc case runs on Linux; platform/failure tests run everywhere.

### Decisions, vocabulary and continuous enforcement

Followed the build task's stronger requirement over the filed brief's Darwin
fallback proposal. Without a structured reader, return the existing `unreadable`
verdict (:375), not a string-derived identity. The existing outcome vocabulary is
`OrphanAdoptionVerdict` (:47): this result leaves the process untouched (:545), and
the boot fallback explicitly returns `undecided`
(`runtime/adapters/claude-code/persistent/boot-adoption.ts:1073`).
No new outcome inherits an implicit default.

The invariant is maintained at each identity read (:585), with another read in
both force-kill callbacks above; it does not depend on the candidate process
cooperating. The signal recheck is consumed at
`runtime/adapters/claude-code/persistent/repl-session.ts:533`. This does not remove
the existing read-to-signal race or authenticate an executable against a process
that deliberately copies the entire expected vector; the header states that
limit (`runtime/adapters/claude-code/persistent/orphan-adoption.ts:32`).

The flattened matcher remains only for conservative transcript scan refusal
(:478); it cannot supply `OrphanAdoptionDeps.readArgv`. Before writing this record, searched the whole tree,
including hidden files, for `correct on macOS and Linux|reads the cmdline via|defaultReadCmdline|readCmdline:|export function defaultReadArgv`.
The only hit was the positive control, the new reader at :370. Removed the stale
platform and string-identity claims; historical explanation of the earlier loss
remains as rationale. The strict element matcher was not widened.

Acceptance is recorded in
`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md:507`; SPEC.md carries
the corresponding dated decision and present-tense platform limitation.

### Mutation evidence

Each mutation was applied separately to orphan-adoption.ts, its exact landing
line printed and its diff shown before running the four `structured pid argv`
tests. Every restoration passed all four tests.

| Guard or property | Mutation and landing line | Mutated | Restored |
| --- | --- | --- | --- |
| Vector identity | :595 use string matcher on joined argv | RED, 1 failure | GREEN |
| Genuine child accepted | :595 unconditional refusal | RED, 1 failure | GREEN |
| Unsupported platform unknown | :375 remove platform refusal | RED, 1 failure | GREEN |
| Complete NUL framing | :378 remove framing refusal | RED, 1 failure | GREEN |
| Failed read unknown | :381 return empty vector in catch | RED, 1 failure | GREEN |
| Exact proc vector | :379 join and whitespace-split vector | RED, 2 failures | GREEN |

Command: `bun test runtime/adapters/claude-code/persistent/__tests__/orphan-adoption.test.ts -t 'structured pid argv'`.

### Validation and deliberate limits

- Orphan-adoption and pane-adoption-verdict tests: 52 passed, 0 failed.
- Typecheck matrix: all 51 configurations passed (`bash scripts/ci/typecheck-all.sh`).
- Leak gate: INCOMPLETE, zero findings from rules that ran; private PII denylist
  unavailable, so file and commit-message PII rules could not run.
- Repository lint: passed (`bash scripts/ci/lint.sh`).
- Boot-adoption test file: setup failed at
  `runtime/adapters/claude-code/persistent/__tests__/boot-adoption.test.ts:153`
  because the reply sink could not bind. A standalone loopback bind on port 0
  also failed in this environment. Supervision tests encounter the same bind
  restriction; the combined three-file run had 57 passes and 27 failures.
  No assertions were relaxed and no failing cases were disabled.
- Full suite deliberately not run. No push, PR creation or merge performed.
- Did not implement a native Darwin argv reader, widen the matcher, add a second
  identity path, change transcript scan behavior, or claim executable authenticity.

This record uses the lane-mandated staging location rather than docs/as-built.
