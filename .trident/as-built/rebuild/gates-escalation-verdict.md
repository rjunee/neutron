## L4a gate extraction: escalation and verdict

### What changed

The escalation arithmetic and decision gates now have importable TypeScript homes at `trident/gates/escalation.ts:20-153`. Their finding-eligibility and redaction dependencies live at `trident/gates/verdict.ts:13-46`. The focused test imports those modules at `trident/__tests__/escalation-gate.test.ts:26-35`, while its two assertions about the still-shipped workflow schema continue to read that source at `trident/__tests__/escalation-gate.test.ts:37`.

The obsolete text loader was deleted. A whole-tree enumeration with `rg -n "load-escalation-gate\\.ts" trident/__tests__ trident/testing` used the known pre-change import path as its positive control and, after the change, returns no hits; `rg -n "from '../gates/(escalation|verdict)\\.ts'" trident/__tests__/escalation-gate.test.ts` finds the replacement imports.

### Decisions

The executable function bodies were copied without behavior changes. A body comparator strips only `export` and TypeScript annotations, brace-matches the twelve moved functions in both locations, and reports `EMPTY` for every comparison. The existing escalation outcome vocabulary remains `continue | re-plan | stop` at `trident/gates/escalation.ts:3`; this extraction adds no outcome, so there is no new default classification cost. The tests continuously maintain fidelity by importing the extracted modules at `trident/__tests__/escalation-gate.test.ts:26-35`; they do not depend on the old brace matcher remaining functional.

The shared eligibility predicate stayed in `verdict.ts` because `eligibleFixFindings` delegates to it at `trident/gates/verdict.ts:37-40`, while the escalation module consumes only the redactor at `trident/gates/escalation.ts:1`. This preserves the original dependency direction without inventing another abstraction.

### Mutation proof

| Guard | Compiling mutation and printed landing line | Red | Restored green |
| --- | --- | --- | --- |
| A nonempty intersection is a repeat | `trident/gates/escalation.ts:53`, `repeated.length > 0` → `repeated.length === 0` | `bun test trident/__tests__/escalation-gate.test.ts`: 17 failed, 26 passed | Same command: 43 passed, 0 failed |

### Verification

- `bun test trident/__tests__/escalation-gate.test.ts`: 43 passed, 0 failed.
- `bunx tsc --noEmit -p trident/tsconfig.json`: passed.
- `bash scripts/ci/lint.sh`: passed.
- `bash scripts/ci/typecheck-all.sh`: checked 51 configurations and failed only in unchanged files: `gateway/transcription/__tests__/whisper-install.test.ts:186`, `onboarding/history-import/__tests__/zip-writer.ts:10`, and `logger/__tests__/fire-and-forget.test.ts:301`. The lane-owned Trident configuration was then run directly and passed.

### Deliberately not changed

The shipped functions in `trident/inner-workflow.mjs` were not edited because that file is outside this lane's territory and the locked rebuild retains it during extraction. No gate behavior, assertion, spec decision, or outcome vocabulary changed. The remaining source-text assertions in the focused test concern workflow schema and wiring rather than moved gate implementations, so they remain source reads at `trident/__tests__/escalation-gate.test.ts:718-735`.
