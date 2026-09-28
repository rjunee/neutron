## 2026-09-28 — Check reminder warning content without matching the checkout path

The compose-failure test asserted that the warning line lacked the substring
`rent`, taken from the stored reminder message. The warning's reason includes
the error stack, so a checkout directory containing `current` supplied that
substring even when no reminder content was logged. On the same source commit,
the targeted test failed from such a directory and passed from one without it.

The test now compares the warning with the complete stored intent, `pay the
rent`. It still checks the route and the underlying error. A deliberate mutation
that put the intent into the structured warning field made the corrected test
fail; restoring the warning made it pass.

The reminders dispatcher tests and root and reminders TypeScript checks passed.
