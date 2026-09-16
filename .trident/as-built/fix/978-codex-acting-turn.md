## 2026-09-15 — Dispatch bounded Codex work through the hosted project session

### Built

Added `createCodexActingTurn` at `runtime/workers/codex-acting-turn.ts:22`. It admits only the `openai-codex` provider at :29, the bound project conversation at :30, its host-supplied Codex thread at :31, and a cwd contained in the session cwd or granted roots at :32-35. It refuses a request whose tools, writable access, or network access exceed the snapshot grant at :36-38. It also refuses a missing session, a session for another project, or a no-longer-live session at :39-41.

The turn submits one JSON dispatch line through `CodexProjectSession.submitLine` at `runtime/workers/codex-acting-turn.ts:52`. That session retains its promise-tail serialization at `runtime/adapters/codex-cli/persistent/project-session.ts:94-105`; concurrent acting turns therefore cannot overlap terminal submission. The turn then observes only a file at `request.result.path` at `runtime/workers/codex-acting-turn.ts:54-64`; an acknowledged prompt alone remains `unknown` after the bounded wait at :66-75.

Added `CodexProjectSession.isLive` at `runtime/adapters/codex-cli/persistent/project-session.ts:109-111`, a pre-dispatch observation that does not turn a later submit failure into a claimed result. This joins the existing `BoundedWorkOutcome` vocabulary in `runtime/bounded-work.ts:99-106`: verified mismatches return its existing `refused` / `capability-unsupported` outcome, while an unobserved trailer returns its existing distinct `unknown` outcome. `createProjectRunners` preserves those alternatives at `runtime/workers/project-runners.ts:133-146`.

### Decisions

The binding carries a host-owned Codex thread identifier rather than treating the persistent pane handle as a Codex thread identifier. The session host exposes the pane handle at `runtime/adapters/codex-cli/persistent/project-session.ts:69-80`; its code does not establish that it is a Codex thread id. This avoids inventing continuity evidence.

The turn delegates submission serialization to the session rather than adding another lock. The session-owned queue is continuous across every caller at `runtime/adapters/codex-cli/persistent/project-session.ts:71,94-105`, so its enforcement does not depend on a caller voluntarily cooperating.

### Verification

`bun test runtime/workers/codex-acting-turn.test.ts runtime/adapters/codex-cli/persistent/project-session.test.ts` passed 37 tests and 79 assertions. `bunx tsc -p runtime/tsconfig.json --noEmit` and `git diff --check` passed.

| Guard | Compiling mutation and landed line | Observed red | Restored green |
|---|---|---|---|
| provider | inverted provider comparison, `codex-acting-turn.ts:29` | positive control and provider refusals failed | focused suites passed |
| conversation | disabled bound conversation comparison, :30 | project and topic refusal tests failed | focused suites passed |
| thread | disabled thread comparison, :31 | thread refusal test failed | focused suites passed |
| cwd | disabled root containment, :32 | three segment-escape refusal tests failed | focused suites passed |
| tools | disabled rank comparison, :36 | tools refusal test failed | focused suites passed |
| writable | disabled writable comparison, :37 | writable refusal test failed | focused suites passed |
| network | disabled network comparison, :38 | network refusal test failed | focused suites passed |
| session presence | disabled missing-session comparison, :39 | fixture threw while dereferencing the absent session | focused suites passed |
| session project | disabled session-project comparison, :40 | session-project refusal test failed | focused suites passed |
| session liveness | disabled liveness comparison, :41 | live-session refusal test failed | focused suites passed |
| liveness observation | inverted `isLive`, `project-session.ts:110` | live observation test failed | focused suites passed |
| submission serialization | removed `await previous`, `project-session.ts:99` | two acting turns reached two active submissions | focused suites passed |

### Not verified

The live probe found `codex-cli 0.154.0` and `herdr 0.8.2`, then the real host connection returned `Failed to connect`. No real Codex pane was started, no real terminal submission acknowledgement was observed, and no real Codex worker wrote a trailer. The focused tests prove the contract through the existing fake host and a real `CodexProjectSession` queue; they do not prove a live Codex or herdr integration in this sandbox.

No Claude adapter or Claude acting turn changed. No fallback to Claude was added. No wiring layer, project-runner selection, provider vocabulary, or bounded-work contract changed.
