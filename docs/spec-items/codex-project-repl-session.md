---
title: Host a Codex project REPL with submission and restart adoption
group: platform
status: open
priority: P1
cutover: true
---

Issue #978, increment 1. Codex is a project REPL in the pre-cutover scope of
`docs/plans/harness-orchestrator-pivot-2026-09-11.md` §2. Increment 2 (the acting
turn) depends on a real session serving a turn and surviving a gateway restart.
This item remains open until that live evidence exists for the production path.

## Acceptance

- A host owns a long-lived Codex process bound to a project. Concurrent submissions
  deliver each complete prompt and its acknowledged Enter in order into that
  process. Removing the serialization wait must fail the concurrency test.
- Text uses bracketed paste framing before Enter so Codex does not absorb Enter
  into a paste burst. Embedded escape bytes are refused before any terminal write.
  Verify framing and refusal in
  `runtime/adapters/codex-cli/persistent/project-session.test.ts`.
- After a gateway restart, the host adopts the recorded live pane. Both a direct
  Codex executable and a recognized interpreter with Codex in the script slot are
  accepted. A different script, interpreter, launch flags or explicitly configured
  executable path is refused. Verify both directions in the same test file.
- A failed recovery inspection remains unknown; a known identity mismatch is a
  refusal; positive pane loss is reported as a replacement. Codex must never
  silently fall back to Claude.
- A real Codex session accepts a prompt, answers it, then retains conversation
  context through a gateway restart and another prompt via the production session
  API. A terminal write acknowledgement alone does not satisfy this criterion.
  Record the actual CLI version and observed evidence. A sandbox that cannot
  reach the host or inference service must report this criterion as unverified.

## Scope

The two defects measured in the issue's later spike are paste-burst submission
and interpreter-prefixed adoption identity. This increment does not implement
acting turns, approval/trust-dialog automation, or recovery of the conversation
through a herdr server restart. A gateway restart and a herdr server restart are
different events.
