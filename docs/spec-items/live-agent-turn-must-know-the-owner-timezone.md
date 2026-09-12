---
title: Give the live agent turn the owner's timezone and local time
group: platform
status: open
priority: P1
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**The live agent turn does not know the owner's timezone, so the agent narrates the HOST's clock as
if it were the owner's** (owner-reported 2026-08-14: *"you need to figure out how to set my timezone
properly"*). The zone IS captured — onboarding takes the browser's IANA zone from the `?tz=`
WS-upgrade param (#306) and stores it on `instance_metadata.timezone`; the onboarding preamble even
FORBIDS asking for it, on the grounds that it is already known. `reminders/tick.ts` then resolves it
correctly for cron-cadence wall-clock work (#40) — so a daily 9am reminder does fire at the owner's
9am. **The live turn is the one path that never reads it.** `gateway/wiring/build-live-agent-turn.ts`
contains no reference to a timezone and nothing in the live-turn path touches `instance_metadata`.
The host runs UTC, so every `Date.now()`, every shell `date`, and the injected current-date line are
all UTC — and the agent, having nothing to convert with, repeats them as the owner's wall clock.
OBSERVED: on 2026-08-14 the agent was told "today" was a date the owner had not reached yet, and
narrated a whole evening's work in host time — *"since midnight"*, *"at 4am"* — for an owner whose
clock read mid-evening the PREVIOUS day. Not an error message; a confident, wrong frame that also
shifts every relative deadline the agent offers. Note the second-order cost: the agent is told to
never ask for the timezone BECAUSE it is already known, so the one recovery it could improvise is
also closed off.
SECOND, SMALLER GAP, same root: the captured zone is supposed to be stamped into `USER.md` by
persona-gen precisely so the agent has it without asking. On this instance it was NOT there and had
to be written by hand — so whatever writes it either never ran for this owner or does not run for an
owner who predates the feature. Acceptance: the live agent turn receives the owner's IANA zone AND
the current time in it — not a bare date; a time or date stated to the owner is in the owner's zone
unless explicitly labelled otherwise; the `USER.md` stamp is verified for EXISTING owners, not only
new ones; and a test pins the case that actually bites, an owner whose local DATE differs from the
host's at the moment of the turn.

## Acceptance

- [ ] The live agent turn receives the owner's IANA zone AND the current time in it — not
      a bare date. `gateway/wiring/build-live-agent-turn.ts` reads `instance_metadata`;
      today it contains no timezone reference at all.
- [ ] A time or date stated to the owner is in the OWNER's zone unless explicitly labelled
      otherwise.
- [ ] A test pins the case that actually bites: **an owner whose local DATE differs from
      the host's at the moment of the turn.** A test run with host and owner in the same
      zone passes with the defect present and does not satisfy this.
- [ ] The `USER.md` timezone stamp is verified for EXISTING owners, not only newly
      onboarded ones — assert against an owner row that predates the feature.
