## 2026-09-29 — Remeasure adopted project parents for later native dispatch

A project parent surviving a gateway restart now receives a fresh host launch
observation after successful adoption. Without it, a child newly dispatched from
that survivor had no launch evidence to include in its original signed receipt,
so later quota continuation remained unknown even on an explicitly granted
parent. This supports automatic exact-scope restart and workflow continuity in
`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md`.

The host compares structured kernel argv with the terminal host's live PID and
argv, requires the exact session/channel and one explicit tool grant containing
`Agent` and `SendMessage`, and measures the kernel executable file's digest and CLI version.
PID start time, kernel boot identity, argv and executable identity must remain
unchanged through measurement and final publication. Registry tool labels do
not supply this observation. The existing continuation consumer still requires
its independently pinned compatible executable digest/version.

Publication follows existing credential, health, ownership-claim and baseline
checks. General, ambiguous grants, unavailable process evidence and Agent-only
survivors acquire no continuation authority. Unavailable launch observation
does not itself prevent ordinary adoption. No live input or credential changes
are performed. Executable observation is about the kernel file and launch
arguments, not mutable process memory, a served catalog, or account consumption;
unreadable, deleted, and unsupported executable/version observations stay unknown.

Focused controls exercise fresh launches, adopted launch measurement, successful
and refused adoption publication, existing adoption behavior, and the native
continuation consumer. Root and Trident TypeScript checks passed. Semantic
mutations accepting changed process identity and suppressing valid publication
each failed their controls. The separate continuation integration owns the
additional post-adoption child-dispatch/quota end-to-end case. Real account A/B
and unattended-merge proof remain outstanding.
