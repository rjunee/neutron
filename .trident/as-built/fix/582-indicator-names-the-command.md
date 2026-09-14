## Issue 582 — typing indicator names the command

### What changed

The live substrate mapper now accepts the `args` carried by every runtime tool-call event and extracts a readable shell command when the input exposes one (`runtime/events.ts:77-80`, `open/activity-inspector.ts:446-469`). Shell rows use the command's first meaningful word after a leading directory change, environment assignments, or simple shell control wrappers; interpreter calls use the script basename (`open/activity-inspector.ts:837-864`).

The command label is capped at 24 characters, including an ellipsis. That bound belongs to the parser because its output shares a single phone row with the spinner (`open/activity-inspector.ts:661-666`, `open/activity-inspector.ts:865-868`). Arguments that are missing, malformed, empty, or ambiguous return no derived command; the existing tool label remains the fallback (`open/activity-inspector.ts:463-469`, `open/activity-inspector.ts:829-841`).

The outcome joins the existing `ActivityRowInput.label` vocabulary. The chat controller already selects a non-generic tool-start label for the typing indicator, while its default handling leaves other row kinds and readable tool labels unchanged (`landing/chat-react/controller.ts:1399-1424`). The mapper continuously maintains the invariant at the event-to-row boundary, using the event payload rather than relying on a later renderer to recover discarded input (`open/composer.ts:5552-5557`).

### Decisions

The label is one word, matching the filed mobile constraint. Multiword special cases such as `git rebase` and `bun test` were removed from the shared parser so both activity inputs obey one rule (`open/activity-inspector.ts:837-868`). The parser preserves the executable basename for direct commands and the script basename for interpreter invocations because those are the executable actions visible in the input (`open/activity-inspector.ts:855-864`).

Unknown input is represented as `undefined`, distinct from a successfully read empty string; both refuse derivation and therefore select the named-tool fallback (`open/activity-inspector.ts:829-841`, `open/activity-inspector.ts:467`).

### Verification

`bun test open/activity-inspector.test.ts` passed 59 tests. The live event, unreadable-input fallback, prefix reduction, one-word behavior, and clipping assertions are at `open/activity-inspector.test.ts:511-522` and `open/activity-inspector.test.ts:573-596`.

| Guard | Mutation | Red evidence | Restored evidence |
|---|---|---|---|
| Live shell label selection | Replaced `shellLabel ?? named.label` with `named.label` at `open/activity-inspector.ts:467` | Live-shell test failed: expected `grep`, received `shell` | Focused file: 59 pass |
| Unreadable-input fallback | Replaced the fallback with an empty string at `open/activity-inspector.ts:467` | Fallback case failed: expected `shell`, received an empty label | Focused file: 59 pass |
| Command-label bound | Returned the unbounded first word at `open/activity-inspector.ts:866-868` | Bound test failed: expected length 24, received 34 | Focused file: 59 pass |

`bash scripts/ci/lint.sh` passed. The 51-project typecheck matrix passed `open/tsconfig.json` but remained red on pre-existing errors in `app/tsconfig.json`, `gateway/tsconfig.json`, `logger/tsconfig.json`, `onboarding/tsconfig.json`, and the root `tsconfig.json`; none is in the enumerated diff (`CONTRIBUTING.md:75-83`).

### Deliberately not changed

The controller's label-over-detail precedence remains intact because tool rows already feed their meaningful label into that vocabulary (`landing/chat-react/controller.ts:1413-1424`). No alternate renderer or compatibility path was added: the shared parser now supplies both the hook mapper and live substrate mapper (`open/activity-inspector.ts:643-647`, `open/activity-inspector.ts:463-469`).
