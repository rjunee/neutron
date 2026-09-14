## Issue #656 — lazy browser build owns a fresh resolver process

### What changed

The landing server's development fallback now runs the browser build through a fresh Bun child process and consumes its stdout, stderr, and exit status (`landing/server.ts:648`, `landing/server.ts:662`, `landing/server.ts:676`). The lazy request and its existing cache remain in place (`landing/server.ts:853`, `landing/server.ts:877`).

The regression test deliberately imports a transitive module from the browser graph before requesting the lazy bundle (`landing/__tests__/chat-react-serving.test.ts:14`, `landing/__tests__/chat-react-serving.test.ts:83`). This makes the previous failure deterministic without depending on file-count or shard position.

The browser-bundle quarantine and its opt-out were deleted. Landing-server tests now return to the ordinary general partition, whose direct child-process launch and log redirection remain unchanged (`scripts/run-tests.sh:574`, `scripts/run-tests.sh:581`). The plan audit still enumerates every general, PGLite, and device file (`scripts/run-tests.sh:544`, `scripts/run-tests.sh:551`).

### Established cause and decision

The filed theory was an earlier test explicitly closing a descriptor it did not own. Descriptor-table measurements did not support it: the landing test alone held 342 descriptors and passed; 83 predecessors held 979 and passed; a larger shared process held 4,724 and failed. More decisively, importing only `landing/chat-react/activity-client.ts` reproduced the failed build with 51 descriptors. The failure therefore follows Bun test-loader resolver state shared with an already-imported browser graph, not descriptor count or an explicit close in application test code.

The fix is at the lazy build boundary because that is the party asking a second Bun subsystem to reread the graph. A child build has a descriptor table and resolver independent of the caller (`landing/server.ts:648-685`); the invariant is maintained continuously by process ownership and does not require the polluted caller to repair itself.

Build failure remains in the existing `bundle_build_failed` system-event vocabulary (`landing/server.ts:866`, `landing/server.ts:884`). Its default behavior is unchanged: the event is edge-latched and the asset request returns 404 (`landing/server.ts:853-890`).

### Mutation table

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Fresh child build at `landing/server.ts:662` | Replaced it with the former in-process `Bun.build`; mutation printed at line 662 | `bun test landing/__tests__/chat-react-serving.test.ts`: expected 200, received 404 at test line 87 | Same command: 7 pass, 0 fail |

Additional checks: the two touched test files completed with 21 pass and 0 fail; `bash scripts/ci/typecheck-all.sh` checked 51 configurations; `bash scripts/ci/lint.sh` passed every lint guard.

### Deliberately not done

The lazy build was not made eager, and the committed production bundle path was not changed. Bun was not upgraded: CI remains on its repository-pinned version. Historical as-built evidence was not rewritten; it correctly records what was observed when the earlier quarantine shipped.
