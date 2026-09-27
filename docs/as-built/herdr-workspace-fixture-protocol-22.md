## 2026-09-26 — Align the shared workspace fixture with protocol 22

The shared workspace fake still answered ping with server 0.8.2/protocol 20,
while the client requires protocol 22 (`herdr-protocol.ts:31`) and checks exact
equality (`herdr-client.ts:624–629`). Consequently consuming placement tests
failed before reaching their workspace, tab and worker assertions. The fixture
now independently pins server 0.9.1/protocol 22
(`runtime/adapters/claude-code/persistent/__tests__/herdr-workspace-fake-server.ts:74–76`).
It deliberately does not derive its reply from the client's expected value.
Production protocol checks and malformed-reply injection remain unchanged.

The consumed workspace, tab, layout and pane structures need no additional
fixture correction: their protocol-22 compatibility evidence is recorded in
`docs/as-built/herdr-protocol-22-compatibility.md:18–34`; the consuming strict
placement tests exercise these replies through actual host and manager code
(`herdr-project-placement.test.ts:46–66`).

Focused receipts on base `e2dcc952e14f906e4dbf9ca8b7732b4814289dcb` plus this
fixture change, with Bun 1.3.13: `bun test` over herdr-project-placement,
project-build-terminal and worker-placement first reproduced 14 pass, 23 fail
and three errors. Adding herdr-protocol-gate after correction yielded 102 pass,
zero fail, 364 assertions. Mutating the fixture to protocol 21 and then 23 made
the selected strict worker-role spawn test fail in each direction (exit 1,
one failure naming the incompatible protocol); restoring 22 restores success.

Physical fixtures ran through `python3 -B trident/process-test-isolation.py --`
with the repository test preloads. The selected Open project-build E2E placement
cases (`every cross-provider Claude worker|General-scoped Codex review seat|a refused placement|no terminal host: cross-provider`)
passed five cases with 51 assertions. Focused codex-headless, codex-review,
claude-headless and project-runners cases
(`plac|screen-independence|restart adopts|stalled view|stale-pane`) yielded
34 pass and two failures. At the documented 15-second test timeout both failures
were bounded polling exhaustion waiting for cancelled grandchildren to disappear
(`claude-headless.test.ts:549`, `codex-headless.test.ts:618`), rather than protocol
rejections. Those physical fixture failures remain outside this correction's
scope; this is not a whole-suite pass.

Both `bunx tsc -p tsconfig.json` and `bunx tsc -p trident/tsconfig.json` passed
with exit 0. Fixture SHA-256 at validation:
`2243b4b9c507a0c3eaf95e8f0e721f330ae98a2960da50146f6b258d3bffd418`.
Full-suite and exact publication-head CI validation remain with the integrating
change; no publication or live daemon operation was performed here.
