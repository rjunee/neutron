## 2026-09-19 — Keep inherited GitHub credentials out of test processes and diagnostics

An authenticated build shell could pass its GitHub credential into the full
suite. The unconnected composer fixture then observed a credential it had never
stored, and raw-value assertions copied it into failure diagnostics. The host
runner inherits its parent's environment when no extra environment is supplied
(`trident/git-mode.ts:1193`); omitting the stored credential is not the same as
removing an inherited one.

`scripts/run-tests.sh:144` now removes GitHub CLI token variables and injected
git configuration before dependency verification, discovery, or any test lane
starts. This changes only the test runner's child environment. Publishing still
uses the credentialed host runner, and tests can explicitly install synthetic
connected credentials. Ordinary CI metadata is retained.

The credential probes in `open/__tests__/project-build-wiring.test.ts:903` and
`tests/integration/github-credential-wired.open.test.ts:99` now emit only
presence or equality outcomes. Unexpected credentials still fail the
assertions, without rendering their values. Per-test deletion alone was
insufficient: on Bun 1.3.13, an implicit child environment retained the startup
credential after deletion from `process.env`; an explicit environment did not.
The boundary therefore precedes the Bun process.

Measured validation:

- Seven focused credential checks passed, including a real local git push whose
  hook verifies the synthetic connected credential while the suite child sees
  none.
- A synthetic canary exercised discovery and all four runner lanes. A passing
  fixture returned zero; an intentionally failing fixture returned one and its
  persisted assertion log omitted the canary. CI metadata and PATH were positive
  controls.
- Both formerly leaking assertions were deliberately failed in subprocesses
  born with a synthetic credential. Their captured diagnostics contained presence
  failures and no canary value.
- Twenty-eight runner selftests passed, covering coverage accounting, shard
  partitioning, and lane isolation. Shell syntax and diff whitespace checks passed.
- Semantic controls failed as required: omitting the token scrub was detected;
  removing the publisher's credential produced a failed git-push witness. Both
  mutations were restored before the final focused pass.

G063 still requires the host-observed suite exit; no receipt, scope, gate, or
publishing authorization was changed. Direct focused Bun invocations must start
without inherited credentials; the canonical full-suite command supplies that
isolation. This is prevention for inherited GitHub credentials, not a general
log sanitizer or remediation of previously written logs. Full-repository tests
and typechecks are not claimed by this focused record.
