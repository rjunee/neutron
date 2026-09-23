## 2026-09-23 — Stabilize the Codex result-transport positive control

The fresh-output half of the exclusive-dispatch transport test now uses the
fixture's existing one-second budget and deliberately waits longer than the
missing-output control's deadline before writing a valid result. The paired
missing-output case retains and asserts its 80 ms expiry budget. This keeps the
test focused on stale-stage clearing and result publication without allowing a
scheduler delay to turn its positive control into a false timeout.

No runtime timeout or result-transport behavior changed. Verification covers the
focused result-transport test repeatedly, the consuming project-build surface,
both TypeScript projects, and the repository's documentation, leak, and commit
message guards.
