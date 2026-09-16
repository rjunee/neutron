## 2026-09-16 — Executable coverage for refused tool calls

### Change and rationale

The review finding was reproduced before editing: replacing the handler return
at `runtime/adapters/claude-code/persistent/tools-bridge-impl.ts:126` with text
`null`, retaining the searched delegation in a comment, left the original suite
18/18 green. Its two source-string tests were a test defect, not evidence of an
executable connection.

Extracted the existing handler and HTTP helper into
`runtime/adapters/claude-code/persistent/tools-bridge-handler.ts:11`.
The stdio entry directly registers that factory's handler at
`runtime/adapters/claude-code/persistent/tools-bridge-impl.ts:111`.
The factory defaults to real fetch; tests inject an HTTP transport returning
real Response objects. The status/body extraction is at
`runtime/adapters/claude-code/persistent/tools-bridge-handler.ts:37`, and the
mapper invocation is at that file's line 53. This replaces the inline handler.

Replaced the two source-string tests with four executable cases, enumerated
by the fixture array at
`runtime/adapters/claude-code/persistent/__tests__/tools-bridge-response.test.ts:124`:
401 refusal, 500 with a misleading success body, successful text, and successful
empty result. Each asserts the POST envelope and exactly one request at line 148,
and the error flag and rendered content at lines 159-163. Existing pure mapper
assertions remain. These tests continuously check the extracted handler without
requiring the application sink or an agent process to work.

Used the review's explicitly permitted handler-factory option after an attempted
stdio/HTTP test failed binding port zero with EADDRINUSE. No new product outcome
or invariant was introduced. The existing vocabulary is BridgeToolResult
(`runtime/adapters/claude-code/persistent/tools-bridge-response.ts:49`): refusal
uses isError at lines 63-64 and 105-109, while unknown dispatch has its distinct
message at lines 113-118. This extraction preserves those defaults.

### Mutation evidence

The null mutation printed the retained comment at handler line 53 and the
replacement return at line 54. The status mutation targets handler line 37.
Both mutations must compile and execute before their test failures count.

| Guard | Compiling mutation | Red | Restored green |
| --- | --- | --- | --- |
| Handler delegates to mapper, handler:53 | Return text null at :54; keep delegation comment at :53 | 17 pass / 3 fail (401, 500, successful text) | 20 pass / 0 fail |
| HTTP status reaches mapper, handler:37 | Replace resp.status with 200 | 19 pass / 1 fail (500 with success-shaped body) | 20 pass / 0 fail |

Here `handler` means `runtime/adapters/claude-code/persistent/tools-bridge-handler.ts`.
For each mutation, `bunx tsc --noEmit --pretty false` exited 0, the changed line
was printed, and the targeted test exited 1 for a wrong answer. The second case
specifically bypasses the mapper's earlier missing-success guard: its body has
ok:true, so dropping the HTTP status exposes the incorrect successful result.

### Citation corrections and search

The filed issue file contains only a sentence directing the reader back to the
task brief. The supplied review's original handler line 126 and sink test lines
246-285 were accurate at the starting commit. Extraction moves the delegation to
`runtime/adapters/claude-code/persistent/tools-bridge-handler.ts:53` and registration
to `runtime/adapters/claude-code/persistent/tools-bridge-impl.ts:111`.
The original source tests at response-test lines 131-141 are replaced by the
executable cases at lines 124-165. The sink test citations did not move.

Searched the working tree with
`rg -n 'no test can import it|therefore asserted on the source|createToolCallHandler' --glob '*.ts' --glob '*.md' .`.
The first two obsolete phrases had no hits; the positive control found the factory,
production import/registration and test import/invocation. Before editing,
`git grep` against HEAD found both the CallTool registration at line 111 and
mapper delegation at line 126; this was an existing-branch finding, not a claim
about current main.

### Validation and limits

- `bun test runtime/adapters/claude-code/persistent/__tests__/tools-bridge-response.test.ts`: 20 pass, 0 fail after restoration.
- `bunx tsc --noEmit --pretty false`: exit 0 after restoration.
- `bash scripts/ci/lint.sh`: exit 0.
- `git diff --check`: clean.
- Record heading check: exactly one top-level `## ` heading.

The leak gate and leaf-project typechecks were not run in this lane.

The separately attempted `tool-bridge.test.ts` returned 1 pass / 13 fail because
the configured sink port could not bind. Even port zero failed in the attempted
HTTP fixture. Socket-backed integration remains unverified here. No full suite,
real agent session, live stdio roundtrip, remote CI, or refreshed main comparison
was performed. No spec decision changed. No other lane's files were edited.
The as-built location follows the explicit lane instruction, overriding the
repository's default docs/as-built location for this delivery.
