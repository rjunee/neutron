---
title: Attribute explicit send rejections to the originating message
group: app
status: done
priority: P1
cutover: false
---

Issue #778; retain `SendStatus.failed` and make it reachable through an explicit
`message_rejected` frame with `client_msg_id`, a reason code and readable text.
Only refusal before ingestion establishes rejection. A transport exception,
missing acknowledgement or downstream dispatch error does not.

## Acceptance

- [x] The server correlates a validation refusal with a valid message ID; invalid
      IDs and other frame kinds retain generic errors. A valid retry is accepted;
      a downstream dispatch error stays a generic error.
      Verify: `gateway/__tests__/app-ws-rejection.test.ts`.
- [x] Both sessions mark only the matching unacknowledged row failed; malformed,
      unknown and stale rejection frames produce distinct visible diagnostics.
      A late echo remains authoritative.
      Verify: `chat-core/__tests__/send-queue.test.ts`,
      `landing/chat-react/__tests__/controller.test.ts`,
      `app/__tests__/imessage-chat-ux.test.tsx`.
- [x] Web and mobile expose failed retry affordances. A mobile tap sends only
      the selected ID. Merely unacknowledged sends retain pending rendering.
      Verify: the client tests above, `landing/chat-react/__tests__/delivery-indicator.test.tsx`,
      `chat-core/__tests__/resilience.test.ts`,
      `app/__tests__/chat-core-mobile-session.test.ts`.
