## 2026-09-26 — Preserve terminal Work Board attempt evidence

Retry and shelving previously replaced or cleared the card's current run link.
The new card-owned terminal-attempt table preserves observed run identity,
outcome, PR provenance and first-observed time independently of that binding.
The terminal reconciliation transaction upserts one observation per card/run;
foreign-board and stale callbacks cannot select a currently bound card
(`work-board/store.ts:1402`). Deleting a card cascades to its observations
(`migrations/0160_work_board_terminal_attempts.sql:11`). The additive backfill
uses only currently linked terminal cards; it cannot recover cleared links.

Expanded Shelved sections render past attempts on web and phone, with unresolved
PRs as plain text. Both client parsers accept missing history and refuse unsafe
PR URLs. Existing retry continuity continues to use the current run binding.

Focused validation on the candidate based on `a1145a499`:

- Store and new persistence/migration tests: 82 passed. Coverage includes repeat
  observation, PR-less retry, blocked and done outcomes, restart, shelving,
  unshelving, deletion, board isolation, stale callback and live-shelving refusal
  (`work-board/terminal-attempts.test.ts:18`).
- Client parser contract (`gateway/__tests__/work-board-attempt-client-contract.test.ts`):
  2 passed; mobile rendering: 9 passed. Web rendering
  includes initially collapsed history and resolved-link/plain-text controls.
- Consuming `open/__tests__/project-build-e2e.test.ts` handoff retry cases: both
  local and PR modes passed, 115 assertions. They now use the real board store,
  preserve the failed observation and continue to assert inherited checkpoint,
  task spend and committed-ledger planning (`:4477`).
- App and web leaf TypeScript checks passed.
- Bidirectional mutation controls: hiding stored observations failed the
  lifecycle assertion; omitting blocked migration rows failed the backfill
  assertion; inventing failed observations for active rows failed the same
  exact-row backfill assertion. All mutations were reverted.

Independent review of `cc69793df` returned GO with no blocking findings. This
work is assigned to Cutover so failed cards can be shelved without losing their
attempt evidence. The shared-host full suite, PR CI and publication remain
pending. No live Work Board rows were changed by this work.

Before publication, the unserved migration was renumbered from 0159 to 0160 to
avoid another change's ordinal. Its stable name and SQL bytes are unchanged.
Real-runner database tests cover fresh 0160 backfill, pending application below
an already recorded higher ordinal, and a database that recorded this same name
at 0159: the latter preserves its exact ledger row and observations without
rerunning the renamed SQL. No applied ledger ordinal is rewritten.

The parser parity test lives in the gateway consumer package, which already
declares the phone and web dependencies. Its assertions exercise both real
parsers through workspace imports; the database tests likewise import the real
migration runner through its declared workspace package.

Phone rendering now proves that the real Shelved section starts collapsed,
reveals the attempt only after expansion, and hides it on collapse. The row
distinguishes a resolved PR link from unresolved PR plain text. Making every PR
plain text, making every PR a link, or starting the shelf expanded each fails
the focused behavioral assertion; restoring the production code passes all
9 mobile rendering tests (33 assertions).
