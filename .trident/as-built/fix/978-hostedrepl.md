## 2026-09-17 — Frame hosted Codex submissions once at the terminal boundary

### Scope and evidence

The filed issue's two fixes were already in the build base: `git log --oneline -- runtime/adapters/codex-cli/persistent/project-session.ts` identifies d1c3cc3f (submission framing) and 69fffe97 (resolved adoption identity). Current identity resolution is at `runtime/adapters/codex-cli/persistent/project-session.ts:65` and adoption comparison at :229. The issue's basename and empty-screen-observer citations are superseded; the observer now detects prompts at :216.

This change fixes a remaining composition defect. The session now passes plain text to the acknowledged host method at `runtime/adapters/codex-cli/persistent/project-session.ts:165`. The host owns framing: `runtime/adapters/claude-code/persistent/bun-terminal-host.ts:520` and `runtime/adapters/claude-code/persistent/herdr-host.ts:676` call the unconditional wrapper at `runtime/adapters/claude-code/persistent/pty-host.ts:71`. Previously the composed path produced two opening markers and two closing markers, reproduced by both new tests before the fix. The host's Enter remains outside the paste (:522 and :681 respectively).

The terminal-boundary invariant is maintained by those host submission methods on every nonempty submission; it does not depend on Codex reporting correct input. Session serialization and input refusal remain at `runtime/adapters/codex-cli/persistent/project-session.ts:144` and :157. The change uses the existing acknowledged Promise method (:138); it adds no outcome value or refusal taxonomy.

### Tests and decisions

`runtime/adapters/codex-cli/persistent/project-session.test.ts:419` enumerates both supported backends explicitly. It composes the real session with each real host implementation, recording Bun terminal writes or fake-server RPCs. Assertions at :445 and :448 require exactly one frame; :446 requires Enter. These are transport-boundary tests, not real Codex turns.

The earlier fake-child expectations were wrong for this boundary after framing moved into both hosts: they required the session to add an extra frame. Updated exact payload assertions at `runtime/adapters/codex-cli/persistent/project-session.test.ts:280`, :303, :322, :416 and `runtime/workers/codex-acting-turn.test.ts:193`; serialization, refusal, and result assertions remain. This corrects the expected representation rather than relaxing comparisons.

The exemplar read before constructing the fixture was `runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts:28`, whose terminal seam captures bytes and whose :119 asserts framed text followed by Enter.

### Mutation evidence and reproduction

| Boundary | Mutation printed in this session | Command | Red | Restored green |
|---|---|---|---|---|
| Exactly one frame | `runtime/adapters/codex-cli/persistent/project-session.ts:165: await submit.call(this.child, \`\x1b[200~${line}\x1b[201~\`)` | `bun test runtime/adapters/codex-cli/persistent/project-session.test.ts -t 'frames exactly once'` | 2 failures, exit 1; both received nested markers | 2 pass, 3 assertions, exit 0 |

To reproduce, replace the single `await submit.call(this.child, line)` at the cited line with the expression printed in the table, print that line, and run the command. Restore the plain-line call and rerun. This is the exact compiling mutation run locally, not a simulated failure. The two new tests also failed against the original production file before editing it.

### Validation

- `bun test runtime/adapters/codex-cli/persistent/project-session.test.ts runtime/workers/codex-acting-turn.test.ts`: 67 pass, 0 fail, 153 assertions.
- `bun run typecheck`: unavailable (`Script not found "typecheck"`). Used `bunx --no-install tsc -p runtime/tsconfig.json --noEmit`: exit 0.
- `bash scripts/ci/lint.sh`: exit 0; all reported gates passed.
- `git diff --check`: exit 0.

### Deliberately outside this change

No real Codex/model turn, live host probe, gateway restart, or server restart was performed. The lane prohibits network access. This record does not establish the issue's live acceptance bar and does not claim issue #978 complete. Identity and prompt detection already exist and are not reimplemented. No product decision changed.

A tree search for `completed bracketed paste|wraps the text in|Framed as a bracketed paste|Framing it as a completed` found the session test comments and `.trident/as-built/fix/978-auto202716.md:20`. The current comments were corrected; the old as-built remains immutable historical evidence. The new record supersedes its session-level framing description for current behavior.
