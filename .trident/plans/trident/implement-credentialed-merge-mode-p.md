# IMPLEMENTATION_PLAN — Credentialed merge-mode probe in board-dispatch (dispatch-time git/gh probes carry the GitHub credential)

Regenerated 2026-08-16 against main (4eb3adc). Card: load the GitHub token from the SecretsStore and thread it via `githubProcessEnv` into the merge-mode probe's host runner, per-command via `makeLazyCredentialedHostRunner`, so `gh auth status` at dispatch time sees the token; tests for both the authenticated and unauthenticated cases.

- [x] Credentialed branch in `dispatchBoardBoundBuild` uses the secrets store when no explicit merge-mode resolver is injected.
- [x] Per-command resolution re-reads the credential for every host command.
- [x] `gh auth status` receives `GH_TOKEN` and the scoped git credential helper environment.
- [x] An explicit `resolveMergeMode` wins; production wiring remains unchanged.
- [x] Tests + hygiene cover unauthenticated, authenticated, per-command, precedence, and store-failure behavior, type the secrets seam, dedupe probe composition, and document the result.

Guard rails: keep the `catch { return {} }` around `readGitHubToken` in the probe's `loadEnv` — deliberately different from the publisher runner's loud-throw contract, because a throwing `loadEnv` here would surface inside `hasGithubOrigin`, which `detectMergeMode` maps to silent 'local' — i.e. a broken secrets store would silently remove the PR gate; the degrade keeps a GitHub-origin repo on the path to `detectMergeMode`'s loud "publisher cannot authenticate" refusal. Do not weaken `detectMergeMode`'s throw. Do not rewire the composer surfaces — their injected resolver is already credentialed.
