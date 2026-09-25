## 2026-09-25 — Auxiliary constructors do not imply unknown project children

The owner-wide durable child query correctly refused unknown owner conversation
scope, but also refused unscoped setup and FIRE helpers. Real profile-driven
construction with an empty ProjectAdmission database reproduced both refused
retirement and refused warm refresh. These constructors cannot host the project
owner's bounded native child; their missing scope is not an unknown owner turn.

The substrate builder now identifies only the exact internal phase-spec and
warm-FIRE profile objects, excluding owner-conversation construction. It carries
that provenance through the Claude adapter into persistent options. The existing
durable query exempts only those known auxiliary roles with neither project nor
conversation scope. Explicit named, General and literal-general scope still uses
ProjectAdmission, and absent provenance remains fail-closed. Labels and structural
profile copies confer no exemption. No second lease authority is introduced.

Real consuming controls cover both profiles' retirement and abandoned-session
refresh, adapter forwarding, scope collisions and unresolved exact-scope children.
The model-control fixture unregisters its query instead of leaving a false-returning
callback behind; combined boot/adoption, model-control and respawn tests pass.
Focused scope/profile/adapter tests pass 48 tests, combined consumers pass 23,
and five Open project-build E2Es pass. Root and Trident typechecks pass. Removing
the auxiliary exemption fails two tests; allowing its marker to override explicit
owner scope fails three. Full canonical and live-provider suites were not run.
The separate queue-budget work remains outside this lease-safety repair.
