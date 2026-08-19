# IMPLEMENTATION_PLAN — Credentialed merge-mode probe in board-dispatch (dispatch-time git/gh probes carry the GitHub credential)

Regenerated 2026-08-16 against main (4eb3adc). Card: load the GitHub token from the SecretsStore and thread it via `githubProcessEnv` into the merge-mode probe's host runner, per-command via `makeLazyCredentialedHostRunner`, so `gh auth status` at dispatch time sees the token; tests for both the authenticated and unauthenticated cases.

- [x] Add the credentialed direct-caller fallback in `dispatchBoardBoundBuild`.
- [x] Resolve the GitHub credential once per host command.
- [x] Pass `GH_TOKEN` to `gh auth status`.
- [x] Preserve injected `resolveMergeMode` precedence.
- [x] Add authenticated, unauthenticated, per-command, precedence, and store-failure tests; type the secrets seam and document the result.
