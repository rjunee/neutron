## 2026-10-01 — Shelved Work Board titles remain parked work

This isolated source fix contributes to #1333. Shelved web rows now use
`cwb-row-archived` instead of the
completed-row class (`landing/chat-react/WorkBoardTab.tsx:981`). The served CSS
renders their titles with the muted color and no strike-through; completed rows
retain their opacity and strike-through (`landing/chat-react.html:945–947`).
This follows the parked-work contract in
`docs/spec-items/work-board-attempt-provenance.md:9–11` without changing card
status, history, or controls.

The component regression loads the served stylesheet and checks both archived
and completed class membership and computed title styles, with a completed-row
positive control (`landing/chat-react/__tests__/work-board-tab.test.tsx:158–191`).
Existing shelf coverage now also verifies that a PR-less done attempt remains
plain history with no borrowed PR and that both delete controls remain available
(`landing/chat-react/__tests__/work-board-tab.test.tsx:260–280`).

Verification: the focused Work Board component suite passed 52 tests and 224
assertions. Both deliberate mutations failed the semantic regression: restoring
the completed class on archived rows, and removing completed title strike-through.
The root and React landing TypeScript checks passed using a fresh frozen-lockfile
dependency installation; workspace dependency verification and `git diff --check`
also passed. This record establishes focused source semantics; it does not claim
deployment, desktop or native-phone acceptance, or closure of the broader issue.
Browser acceptance and deployment remain the publishing workflow's checks.
