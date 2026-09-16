---
title: An abandoned dispatch cannot actuate later
group: platform
status: done
priority: P1
cutover: false
legacy_ref: "GitHub issue #1062"
---

The project acting turn can stop waiting while the herdr transport is still
waiting for an acknowledgement. That abandonment must fence the operation's
submission-bearing Enter: a later acknowledgement may not resume the orphaned
operation and actuate a stopped run.

## Acceptance

- [x] When the acting turn's host budget expires while `pane.send_text` is pending,
      releasing that request does not issue `pane.send_keys`.
      Verify: `bun test runtime/workers/claude-acting-turn.test.ts`
