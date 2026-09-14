## Issue 593 — usage-limit auto-stop recognises what Claude Code renders

### What changed

Claude Code 2.1.270 was measured in an interactive PTY by submitting `/rate-limit-options` to the installed binary. The rendered frame did not include the command name: it showed `What do you want to do?`, option 1 `Stop and wait for limit to reset`, option 2 `Switch to usage credits`, option 3 `Upgrade your plan`, and the Enter/Esc footer. The old production matcher required the absent command text and sent option 3, so the auto-stop was dead.

The replacement detector identifies the measured picker family and accepts only the exact option-1 stop row (`runtime/adapters/claude-code/persistent/rate-limit-options-detector.ts:8-25`). Its recognised outcome sends `1` then Enter, while its mutually exclusive unrecognised outcome carries no keys (`runtime/adapters/claude-code/persistent/rate-limit-options-detector.ts:28-43`). Every REPL registers both outcomes (`runtime/adapters/claude-code/persistent/repl-detectors.ts:99-122`).

The new outcome joins the existing runtime notice vocabulary: `runOutputScan` classifies its detector id (`runtime/adapters/claude-code/persistent/signatures.ts:490-493`), and the notice defaults to active-turn status plus structured stderr, with an injected callback for richer delivery (`runtime/adapters/claude-code/persistent/types.ts:36-57`, `runtime/adapters/claude-code/persistent/types.ts:284-289`). The scanner's existing latch and debounce continuously maintain fire-once behavior independently of the failing CLI surface (`runtime/adapters/claude-code/persistent/output-scan.ts:245-267`).

### Decisions

The family signature uses the picker question, Enter/Esc footer, and a usage-specific choice. The stop action additionally requires the exact numbered row. This separates “known safe selection” from “this is the relevant picker but its actionable surface changed”; the latter refuses to guess and reports the drift.

The test imports the production detector factory instead of copying its regexes, so a production-only drift cannot leave a duplicate test green (`runtime/adapters/claude-code/persistent/__tests__/output-scan.test.ts:228-261`). A second test exercises the dispatch vocabulary and proves that the unrecognised outcome surfaces status and a callback without writing a key (`runtime/adapters/claude-code/persistent/__tests__/output-scan.test.ts:264-299`).

### Mutation evidence

| Guard | Mutation and printed landing line | RED | Restored GREEN |
|---|---|---|---|
| Exact safe stop row | Changed option `1` to `3`; printed `rate-limit-options-detector.ts:14` | measured-frame assertion received `rate-limit-options-unrecognized` instead of `rate-limit-options-stop` | focused tests: 32 pass, 0 fail |
| Unknown-vs-recognised split | Removed the negation; printed `rate-limit-options-detector.ts:42` | measured frame emitted both stop and unrecognised ids | focused tests: 32 pass, 0 fail |
| Unrecognised dispatch classification | Compared against the stop id; printed `signatures.ts:490` | surfaced-status assertion received an empty list | focused tests: 32 pass, 0 fail |

`bunx tsc -p runtime/tsconfig.json --noEmit`, focused ESLint, `git diff --check`, and the two touched test files pass. The full 51-config typecheck matrix was also run: runtime passed; the matrix remains red on unrelated pre-existing errors in app, gateway/onboarding, logger, and the root aggregate.

### Deliberately not done

No feature flag or fallback path was added. The old command-name/option-3 matcher was deleted. No spec decision changed: this repairs the existing auto-stop behavior and makes its unknown state visible.
