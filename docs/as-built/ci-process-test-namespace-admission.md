## 2026-09-26 — Admit isolated process tests on ephemeral CI runners

The CI setup failure reported for PR #1343 occurred after installing bubblewrap:
`bwrap: setting up uid map: Permission denied`, followed by the existing isolation
refusal. Installing the executable alone did not establish permission to create
the required namespace boundary. Ubuntu Noble documents this restriction and
its executable-scoped `userns` profile mechanism in the
[official release notes](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890).

`scripts/ci/prepare-process-test-isolation.sh` now provisions the distribution
tools and loads `scripts/ci/process-test-bwrap.apparmor` into the ephemeral
runner's policy. The profile attaches only to `/usr/bin/bwrap`; global kernel
restrictions remain intact. The helper refuses outside GitHub-hosted Linux
runners before invoking privileged commands. It writes no persistent policy
configuration. The unchanged authenticated isolation launcher still runs its
probe as the invoking user, and any install, policy-load or probe failure stops
the shard before tests. The four-shard matrix and required `test` aggregator
remain intact. This repairs a prerequisite for the existing acceptance in
`docs/spec-items/cancel-stops-host-review-suite.md`; it does not establish the
cancellation or publication evidence required there.

Validation at the repair worktree based on `1c28baa69`: the two focused files
`scripts/ci/prepare-process-test-isolation.test.ts` and
`scripts/ci/ci-workflow.test.ts` passed **93 tests, 212 assertions**. Mocked
provisioning checks successful install/reuse, exact profile admission, every
failure phase, local/self-hosted refusal, and a removed-admission mutation that
fails until restored. Workflow controls reject missing, late, conditional and
failure-swallowing setup. The mocks execute no privileged commands or physical
process fixtures. AppArmor parser 4.0.1 compiled the profile with
`--skip-kernel-load --skip-cache`; Bash syntax and focused ESLint also passed.
No live host policy was changed. Actual hosted-runner admission and the canonical
full checks remain to be measured on the final integrated publication head.
