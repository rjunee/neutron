---
title: Distinguish blocked workers from slow and unclassified work
group: trident
status: open
priority: P1
cutover: false
---

# Blocked is not slow

Issue #754 requires positive prompt evidence rather than elapsed-time inference.
The implementation must preserve three observations: blocked on visible input,
still working, and unknown. Unknown output must remain inspectable and must not
be described as proof of a prompt or a hang.

## Acceptance

- A current selection menu with a live cursor, a SIBLING OPTION and the CLI's own
  key instruction reports blocked to the orchestrator; a quoted menu, byte
  history, a silent worker, and the composer's own `❯ <typed text>` line do not.
  The fixtures are transcribed from live `pane.read` captures of a tool-permission
  prompt, the trust dialog, a working pane and an idle one, because a screen read
  from a real pane is PADDED WITH BLANK ROWS below the dialog and the
  tool-permission prompt says `Esc to cancel · Tab to amend`, never "Enter to
  select". Verify `worker-observation.test.ts` under the persistent adapter.
- Working controls spare the inactivity window and the checkpoint-silence gate,
  and NOTHING ELSE: the absolute ceiling still bounds a turn and a run, because a
  visible interrupt control proves a turn is in flight, not that it is
  progressing. Removing the working guard must fail the slow-turn and slow-run
  tests; letting it cross the ceiling must fail the two ceiling tests; removing
  the blocked guard must fail the positive-menu tests.
- The observer must not be able to disable the watchdog it feeds. A capture that
  rejects degrades to unknown and the deadline still lands; verify the
  `an unclassified deadline still lands` cases.
- Evidence attaches to the reasons this observer AUTHORS. A blind or unwired
  observer leaves an unrelated failure byte-identical; verify the fire-evidence
  composition wiring test and the launcher-death e2e.
- Prompt evidence reaches the persisted run failure and survives database reopen.
  Verify `trident/worker-observation.test.ts` and the production composition test.
- Readiness failures capture the terminal before termination. Active turns use
  the existing watchdog, independently of worker replies, to observe prompts.
- A capture failure or unsupported current-screen capability reports unknown and
  preserves the last available output. Observations are timestamped and bounded.
- Historical evidence must distinguish absent rows from rows with null status.
  The supplied aggregate establishes that 73 rows exist with empty status; it
  does not establish each row's write history. Completion of the historical
  attribution requires the corresponding deployment and row/event records.

## Scope

The cwd/trust fix in #751 is separate. Do not edit `trident/inner-workflow.mjs`.
A current rendered terminal is required for positive UI classification. The
retained byte-stream backend reports unknown rather than treating historical
output as a current prompt. Workers not observable through a registered session
also report unknown; this limitation must be disclosed with their evidence.
