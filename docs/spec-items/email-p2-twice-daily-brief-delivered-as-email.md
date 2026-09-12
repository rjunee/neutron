---
title: Deliver the twice-daily brief as email, with an on/off setting
group: email-core
status: open
priority: P3
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**P2 — the twice-daily brief, DELIVERED AS EMAIL, + the digest on/off
setting.** **The brief is an EMAIL; chat and push carry escalations ONLY and a
digest is never posted to chat.** The on/off is a user-facing PRODUCT SETTING
(`instance_metadata.email_digest_enabled`), not a feature flag — do not strip
it citing the no-flags rule. _Acceptance: two real briefs land in the owner's
inbox on his own schedule in his own timezone (never hardcoded UTC — DST), and
toggling the setting off stops them. **Plus the pre-cutover rehearsal: with
label-mutation and archive HELD BACK, the poller runs against the real mailbox
alongside the existing service and emails its brief, so the two can be compared
side by side for days before any switch.** Reads do not conflict; only the
writes collide, which is why a rehearsal is possible at all._

## Acceptance

- [ ] Two real briefs land in the owner's INBOX on his own schedule in **his own timezone**
      — never hardcoded UTC. Assert across a DST boundary; a test in a fixed-offset zone
      passes with the defect present.
- [ ] The brief is an EMAIL. Chat and push carry escalations ONLY; assert a digest is never
      posted to chat.
- [ ] Toggling `instance_metadata.email_digest_enabled` off STOPS them. It is a user-facing
      product setting, not a feature flag — a change that strips it citing the no-flags rule
      fails this criterion.
- [ ] **The pre-cutover rehearsal runs:** with label-mutation and archive HELD BACK, the
      poller runs against the real mailbox alongside the existing service and emails its
      brief, so the two can be compared side by side for days before any switch. Assert no
      write reaches the mailbox during rehearsal.
