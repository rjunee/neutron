## 2026-09-14 — Orchestrator dependency sequencing (#545 continuation)

### Change and decision boundary

The terminal-wake prompt now asks the orchestrator to independently inspect the board
and linked specs and call `work_board_reorder` with `precedes`, then include the actual
report (`gateway/proactive/terminal-build-wake.ts:84`). This uses the existing background
orchestrator composition (`open/composer.ts:4335`); moving orchestration into the project
conversation is broader work and is deliberately not attempted here.

The same reorder transaction now accepts this precedence decision. It validates distinct
cards, exclusive targets, an active dependency, and a blocked destination within the
project scope (`work-board/store.ts:1101`). Precedes means earlier in the active ascending
order, not necessarily adjacent. Already earlier returns unchanged without writes or
change notifications (`work-board/store.ts:1116`, `work-board/store.ts:1141`); otherwise
the existing renumber writer moves the dependency immediately before the blocked card
(`work-board/store.ts:1123`). This is not an alternative reorder engine.

The tool returns changed/unchanged with the named sequencing report and posts it through
the existing chat ack (`work-board/agent-tool.ts:480`). Production threads this poster
through `gateway/composition/build-core-modules.ts:247` and `open/composer.ts:6731`.
The new `dependency_sequenced` outcome joins `WorkBoardChatAckKind`; its exhaustive
`textFor` switch explicitly renders it (`work-board/chat-ack.ts:44`, `work-board/chat-ack.ts:132`).
Both changed and unchanged reports name the dependency and blocked card
(`work-board/chat-ack.ts:58`). Their dedup identities differ (`work-board/chat-ack.ts:194`).

The new `invalid_sequence` refusal joins `WorkBoardValidationError`; the existing tool
mapper returns `{ ok: false, error }` for that class and rethrows other errors
(`work-board/agent-tool.ts:156`). It cannot silently become success or a queued dispatch.
The honest alternative is an existing active dependency and distinct blocked card; missing
cards still require spec intake first (`work-board/store.ts:1110`).

### Continuously enforced properties and limits

Each precedence call validates and writes under the database transaction, including
concurrent calls (`work-board/store.ts:1091`). It does not continuously override subsequent
owner priority changes. The blocked card's status is not part of the ordering UPDATE
(`work-board/store.ts:1134`); the independent dispatch chokepoint refuses blocked cards
before further execution (`trident/board-dispatch.ts:623`). This protection does not rely
on the failed run or the deciding model remaining alive.

The run reconciliation interface remains the single `detachRun` verb
(`trident/board-reconcile.ts:49`), and its writer remains at `trident/board-reconcile.ts:116`.
The hostile-run tests at `trident/escalation-block.test.ts:537` and `:579` still detect an
actual injected reorder, not just a changed interface declaration. No escalation payload
is parsed into a sequencing command by this change.

The integration fixture uses a deterministic orchestrator stand-in selecting independently
from linked board references; it tests the real wake observer, tool, SQLite store and chat
poster (`work-board/dependency-sequencing.test.ts:46`). It does not evaluate a live model's
judgement of arbitrary dependency prose. The existing ack remains best effort on transport
failure (`work-board/chat-ack.ts:208`); the tool also returns the report for the wake reply.

### Mutation evidence

Every mutation was applied alone, its unified diff and actual landing line printed before
running the test, then restored and rerun green. The table enumerates all 15 experiments
from the three local mutation logs. D = `work-board/dependency-sequencing.test.ts` (14 tests),
E = `trident/escalation-block.test.ts` (29 tests), B = `trident/board-dispatch.test.ts`,
W = `gateway/proactive/__tests__/terminal-build-wake.test.ts` (16 tests).

| Guard / landing | Mutation | Red | Restored |
|---|---|---|---|
| work-board/store.ts:1107 exclusive targets | condition → false | D: 3 fail | 14 green |
| work-board/store.ts:1110 eligible cards | condition → false | D: 8 fail | 14 green |
| work-board/store.ts:1110 blocked lane | remove status condition | D: 1 fail | 14 green |
| work-board/store.ts:1110 active dependency | remove active membership condition | D: 2 fail | 14 green |
| work-board/store.ts:1116 precedence no-op | condition → false | D: 3 fail | 14 green |
| work-board/store.ts:1141 no-op notification | emit unconditionally | D: 2 fail | 14 green |
| work-board/store.ts:1124 apply precedence | ignore precedes target | D: 2 fail | 14 green |
| work-board/agent-tool.ts:483 chat report | suppress post | D: 2 fail | 14 green |
| work-board/chat-ack.ts:195 report identity | remove target/outcome key fields | D: 1 fail | 14 green |
| trident/board-reconcile.ts:116 run isolation | obey hostile payload reorder | E: 2 fail | 29 green |
| trident/board-dispatch.ts:623 blocked refusal | condition → false | B: 2 fail | green |
| work-board/store.ts:1101 precedence mode | condition → false | D: 14 fail | 14 green |
| work-board/agent-tool.ts:475 tool routing | condition → false | D: 14 fail | 14 green |
| gateway/proactive/terminal-build-wake.ts:84 | precedes → before | W: 1 fail | 16 green |
| work-board/chat-ack.ts:133 vocabulary rendering | return empty text | chat-ack.test.ts: 1 fail | 27 green |

### Validation and scope

The focused seven-file run passed 274 tests: D, E, B, W, `work-board/store.test.ts`,
`work-board/agent-tool.test.ts`, and `work-board/chat-ack.test.ts`. Repository lint passed.
The 51-config typecheck matrix initially passed 50 configs and caught the old three-kind
fixture in the work-board config. That fixture now supplies the fourth event's required
fields and asserts its rendered report (`work-board/chat-ack.test.ts:266`); the work-board
config then passed `bunx tsc -p work-board/tsconfig.json --noEmit`. No assertion was relaxed.
The optional full-composition socket test could not boot: `Bun.serve` failed to listen on
port 0 with EADDRINUSE at `open/__tests__/open-terminal-build-wake-wiring.test.ts:132`;
its static composition test passed. No assertion was weakened or skipped.
The leak gate reported zero findings from executed rules but INCOMPLETE because the private
denylist was unavailable. This is not reported as a clean leak check.

The last sequencing box is checked in the existing spec item, pinned by D, E and B.
A tree-wide search for `UNMET: the reporting half` and `orchestrator that makes and reports
the reorder` found the two old sentences only in that item (positive controls); both were
replaced. No product decision changed: this implements the existing sequencing permission.
No dependency card creation, automatic unblocking, dispatch, or project-REPL migration was
added. The task's explicit staging path overrides the general as-built location rule.
